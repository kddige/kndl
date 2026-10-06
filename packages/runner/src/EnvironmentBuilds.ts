// An Environment's builds on this Runner (ADR 0009): tmux and bash installed for Claude Code, the
// bootstrap run on the Environment's image, without the Workspace, and the login shell's
// environment read and kept (#67, below), then the disk snapshotted. Sessions boot from the
// snapshot.
//
// Builds are keyed by the Environment's build version, the version that last changed the build,
// and kept in one snapshot group per Repo. Each is named `b<build version>-<libc>`, recording which
// Claude Code build its Sandboxes run (spike #46). A Runner builds a version
// the first time a Session needs it, and keeps the last few per Repo.
//
// What the scripts print goes to a log the caller shows, and is never written to the Runner's
// disk: it may hold variable values.

import { createHash } from "node:crypto"
import type { EnvironmentRecipe, EnvironmentResources, SessionId } from "@kndl/protocol"
import { Data, Duration, Effect, Schema, Stream } from "effect"
import type { Option } from "effect"
import type { SandboxBackendShape, SandboxError } from "./sandbox/SandboxBackend.ts"
import type { Libc } from "./sandbox/SandboxClaude.ts"
import { detectLibcScript } from "./sandbox/SandboxClaude.ts"
import { defaults } from "./sandbox/SessionLayout.ts"

/** Where a build's or Session's output goes, as it comes. */
export type BuildLog = (text: string) => Effect.Effect<void>

export class BuildFailed extends Data.TaggedError("BuildFailed")<{
  /** Why, with the end of the log. */
  readonly message: string
}> {}

/** The most of a failed script's output a failure carries. */
const tailLength = 4000

const digest = (text: string, length: number) =>
  createHash("sha256").update(text).digest("hex").slice(0, length)

/** The snapshot group holding a Repo's builds. */
export const buildGroup = (repo: string) => `env-${digest(repo, 16)}`

/** The snapshot group of one Test build's build, removed when the Test build ends. */
export const testBuildGroup = (testBuildId: string) => `test-${digest(testBuildId, 16)}`

export const buildName = (buildVersion: number, libc: Libc) => `b${buildVersion}-${libc}`

export const parseBuildName = (
  name: string,
): { readonly buildVersion: number; readonly libc: Libc } | undefined => {
  const match = /^b(\d+)-(musl|glibc)$/.exec(name)
  return match === null ? undefined : { buildVersion: Number(match[1]), libc: match[2] as Libc }
}

/** The Runner's most per Sandbox, whatever an Environment asks for. */
export interface ResourceLimits {
  readonly cpus: number
  readonly memoryMib: number
}

/** The Environment's resources capped at the Runner's limits, and a note when they were. */
export const capResources = (
  wanted: EnvironmentResources,
  limits: ResourceLimits,
): { readonly cpus: number; readonly memoryMib: number; readonly note?: string } => {
  const cpus = Math.min(wanted.cpus, limits.cpus)
  const memoryMib = Math.min(wanted.memoryMib, limits.memoryMib)
  const capped = [
    ...(cpus < wanted.cpus ? [`${cpus} CPUs instead of ${wanted.cpus}`] : []),
    ...(memoryMib < wanted.memoryMib
      ? [`${memoryMib} MiB of memory instead of ${wanted.memoryMib}`]
      : []),
  ]
  return capped.length === 0
    ? { cpus, memoryMib }
    : {
        cpus,
        memoryMib,
        note: `This Runner's limits give the Sandbox ${capped.join(" and ")}.`,
      }
}

/**
 * Installs Docker for an Environment with the toggle on, without starting it: `dockerd` starts at
 * each Session's boot, on the Session's Docker disk. Alpine has Docker in its own packages;
 * everything else gets get.docker.com, which needs curl.
 */
export const dockerInstallScript = `set -e
if command -v dockerd >/dev/null 2>&1; then dockerd --version; exit 0; fi
if command -v apk >/dev/null 2>&1; then
  apk add --no-cache docker docker-cli-compose
else
  if ! command -v curl >/dev/null 2>&1; then
    if command -v apt-get >/dev/null 2>&1; then
      export DEBIAN_FRONTEND=noninteractive
      apt-get update -qq
      apt-get install -y -qq --no-install-recommends ca-certificates curl
    elif command -v dnf >/dev/null 2>&1; then dnf install -y curl
    elif command -v yum >/dev/null 2>&1; then yum install -y curl
    else echo "No curl to fetch get.docker.com with, and no package manager to install it." >&2; exit 1
    fi
  fi
  curl -fsSL https://get.docker.com -o /tmp/get-docker.sh
  sh /tmp/get-docker.sh
  rm -f /tmp/get-docker.sh
fi
dockerd --version`

/**
 * Installs what Claude Code needs in the Sandbox (ADR 0013) and the image lacks, from the image's
 * own packages: tmux, which it runs in, and bash, which its Bash tool runs commands with (the
 * default `docker:dind` is Alpine, with neither). Fails on a tmux older than 3.2, whose control
 * mode can't report the pane's exit. Prints nothing when both are there.
 */
export const claudeNeedsScript = `set -e
missing=""
command -v tmux >/dev/null 2>&1 || missing="tmux"
command -v bash >/dev/null 2>&1 || missing="$missing bash"
if [ -n "$missing" ]; then
  echo "Installing$missing..."
  if command -v apk >/dev/null 2>&1; then apk add --no-cache -q $missing
  elif command -v apt-get >/dev/null 2>&1; then
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -qq
    apt-get install -y -qq --no-install-recommends $missing
  elif command -v dnf >/dev/null 2>&1; then dnf install -y -q $missing
  elif command -v yum >/dev/null 2>&1; then yum install -y -q $missing
  else echo "The image has no$missing, and no package manager to install it with." >&2; exit 1
  fi
fi
tmux -V | awk '{ version = $2; sub(/^[^0-9]*/, "", version); split(version, v, ".")
  if (version != "" && (v[1] < 3 || (v[1] == 3 && v[2] + 0 < 2))) {
    print "Claude Code runs in tmux 3.2 or later, and the image has " $0 > "/dev/stderr"; exit 1 } }'`

/** Where a script is written in the guest while it runs. */
const scriptPath = (name: string) => `/tmp/kndl-${name}.sh`

/** Keeps the end of what a script printed, for the failure message. */
const tail = () => {
  let text = ""
  return {
    add: (chunk: string) => {
      text = (text + chunk).slice(-tailLength)
    },
    get: () => text.trim(),
  }
}

/**
 * Runs the script at `$1`: with its own interpreter if it starts with `#!`, otherwise with
 * `bash -e` where the image has bash and `sh -e` where it doesn't, so it stops at its first
 * failing command.
 */
export const scriptRunner =
  'chmod 755 "$1"; if head -c 2 "$1" | grep -q "^#!"; then exec "$1"; ' +
  'elif command -v bash >/dev/null 2>&1; then exec bash -e "$1"; else exec sh -e "$1"; fi'

/**
 * Runs a script in the Sandbox, streaming its output to `log`, and fails with the end of that
 * output unless it exits 0. It runs as {@link scriptRunner} says, with no stdin.
 */
export const runScript = (
  backend: SandboxBackendShape,
  sessionId: SessionId,
  options: {
    /** Names the script in the log and the failure, such as "the bootstrap script". */
    readonly label: string
    /** Names its file in the guest. */
    readonly name: string
    readonly script: string
    readonly env?: Readonly<Record<string, string>>
    readonly cwd?: string
  },
  log: BuildLog,
): Effect.Effect<void, BuildFailed | SandboxError> =>
  Effect.gen(function* () {
    const path = scriptPath(options.name)
    yield* backend.writeFile(sessionId, path, options.script)
    const output = tail()
    const decoder = new TextDecoder()
    let exitCode = -1
    yield* backend
      .execStream(sessionId, {
        command: "sh",
        args: ["-c", scriptRunner, "sh", path],
        ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
        ...(options.env === undefined ? {} : { env: options.env }),
      })
      .pipe(
        Stream.runForEach((event) => {
          if (event._tag === "Exit") {
            exitCode = event.exitCode
            return Effect.void
          }
          const text = decoder.decode(event.data, { stream: true })
          output.add(text)
          return text === "" ? Effect.void : log(text)
        }),
      )
    yield* backend.exec(sessionId, { command: "rm", args: ["-f", path] }).pipe(Effect.ignore)
    if (exitCode !== 0) {
      const end = output.get()
      return yield* new BuildFailed({
        message: `${options.label} exited with ${exitCode}${end === "" ? "." : `:\n${end}`}`,
      })
    }
  })

// ── The login environment ──────────────────────────────────────────────────
//
// What a terminal on the person's own machine would have (#67): the environment a login shell
// ends with, found the way VS Code dev containers' `userEnvProbe: loginInteractiveShell` finds
// it. Installers such as mise, rustup, nvm and bun's put themselves on PATH through ~/.bashrc and
// ~/.profile, which no process the Runner starts reads on its own. So the build runs `bash -lic`
// (`sh -lc` without bash) once after the bootstrap and keeps what it ends with in the build's
// disk, each new Sandbox probes again in the Workspace after its start script, and the Runner
// passes the result to every process it starts for the Environment, under the variables.
//
// The probe runs with no variable in its environment, so it captures no value, and entries named
// as one of the Environment's variables are dropped: those always come from the Hub.

/** Where a build, and each Sandbox booted from it, keeps its login environment, as JSON. */
export const loginEnvGuestPath = "/var/lib/kndl/login-env.json"

/** How long the login shell may take before the probe gives up on it. */
export const loginEnvTimeout = Duration.seconds(60)

/** What the probe prints around the environment, so nothing else the shell prints is taken. */
export const loginEnvMarker = "__kndl_login_env_6b1f__"

/**
 * Runs `$1` in an interactive login shell: bash where the image has it, which reads
 * /etc/profile, then ~/.bash_profile or ~/.profile (Debian's sources ~/.bashrc), and `sh -l`
 * otherwise, which reads /etc/profile and ~/.profile.
 */
export const loginEnvProbeScript =
  'if command -v bash >/dev/null 2>&1; then exec bash -lic "$1"; else exec sh -lc "$1"; fi'

/** What the login shell runs: its environment, NUL-separated, between two markers. */
const loginEnvDump = `printf '%s' ${loginEnvMarker}; cat /proc/self/environ; printf '%s' ${loginEnvMarker}`

/** Set by the shell for itself: never taken from the probe. */
const shellOwn = new Set(["PWD", "OLDPWD", "SHLVL", "_", "PS1", "PS2", "PS4", "PROMPT_COMMAND"])

const variableName = /^[A-Za-z_][A-Za-z0-9_]*$/

const decodeLoginEnv = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.String)),
)

/**
 * The environment between the probe's markers, without what the shell sets for itself, exported
 * functions, and anything named in `exclude`. Undefined if the markers aren't there.
 */
export const parseLoginEnv = (
  output: string,
  exclude: ReadonlySet<string> = new Set(),
): Record<string, string> | undefined => {
  const start = output.indexOf(loginEnvMarker)
  const end = output.lastIndexOf(loginEnvMarker)
  if (start < 0 || end <= start) return undefined
  const env: Record<string, string> = {}
  for (const entry of output.slice(start + loginEnvMarker.length, end).split("\0")) {
    const equals = entry.indexOf("=")
    if (equals <= 0) continue
    const name = entry.slice(0, equals)
    if (!variableName.test(name) || shellOwn.has(name) || exclude.has(name)) continue
    env[name] = entry.slice(equals + 1)
  }
  return env
}

/**
 * Probes the Sandbox's login environment in `cwd`, with no environment of the Runner's, and
 * keeps it at {@link loginEnvGuestPath}, without the entries named in `exclude`. Fails when the
 * shell doesn't start, or doesn't finish within {@link loginEnvTimeout}.
 */
export const probeLoginEnv = (
  backend: SandboxBackendShape,
  sessionId: SessionId,
  options: { readonly cwd: string; readonly exclude: ReadonlySet<string> },
): Effect.Effect<Record<string, string>, BuildFailed | SandboxError> =>
  Effect.gen(function* () {
    const ran = yield* backend
      .exec(sessionId, {
        command: "sh",
        args: ["-c", loginEnvProbeScript, "sh", loginEnvDump],
        cwd: options.cwd,
      })
      .pipe(
        Effect.timeoutOrElse({
          duration: loginEnvTimeout,
          orElse: () =>
            Effect.fail(
              new BuildFailed({
                message: `The login shell did not finish within ${Duration.toSeconds(loginEnvTimeout)} seconds. Look in ~/.profile and ~/.bashrc for a command that waits.`,
              }),
            ),
        }),
      )
    const env = parseLoginEnv(ran.stdout, options.exclude)
    if (env === undefined) {
      const end = ran.stderr.trim().slice(-tailLength)
      return yield* new BuildFailed({
        message: `Reading the login shell's environment failed: it exited with ${ran.exitCode}${end === "" ? "." : `:\n${end}`}`,
      })
    }
    yield* backend.writeFile(sessionId, loginEnvGuestPath, `${JSON.stringify(env, null, 2)}\n`)
    return env
  })

/**
 * The Sandbox's login environment as its build or its last probe kept it, or none for a Sandbox
 * of a build made before builds kept one.
 */
export const readLoginEnv = (
  backend: SandboxBackendShape,
  sessionId: SessionId,
): Effect.Effect<Option.Option<Record<string, string>>, SandboxError> =>
  backend.readFile(sessionId, loginEnvGuestPath).pipe(
    Effect.map((data) => decodeLoginEnv(new TextDecoder().decode(data))),
    Effect.catchTag("SandboxBackendError", () => Effect.succeedNone),
  )

/** The names of a recipe's variables, which a probe never sets. */
export const variableNames = (recipe: EnvironmentRecipe): ReadonlySet<string> =>
  new Set(recipe.variables.map((variable) => variable.name))

/**
 * Builds a recipe in a new Sandbox of its own, `sessionId`, and leaves it stopped for a
 * snapshot: Docker if toggled and tmux, then the bootstrap with the variables available at build, then
 * the login environment's probe, without them. Returns the libc the image needs. Any Sandbox
 * already there under that id is destroyed first.
 */
export const buildInSandbox = (
  backend: SandboxBackendShape,
  options: {
    readonly sessionId: SessionId
    readonly recipe: EnvironmentRecipe
    readonly limits: ResourceLimits
    /** The variables the bootstrap gets: only those available at build. */
    readonly buildEnv: Readonly<Record<string, string>>
  },
  log: BuildLog,
): Effect.Effect<Libc, BuildFailed | SandboxError> =>
  Effect.gen(function* () {
    const { sessionId, recipe } = options
    yield* backend.destroy(sessionId)
    const resources = capResources(recipe.resources, options.limits)
    yield* log(`Starting ${recipe.image}...\n`)
    yield* backend.create({
      sessionId,
      image: recipe.image,
      cpus: resources.cpus,
      memoryMib: resources.memoryMib,
      rootDiskMib: defaults.rootDiskMib,
      mounts: [],
      env: {},
      workdir: "/",
    })
    const detected = yield* backend.exec(sessionId, {
      command: "sh",
      args: ["-c", detectLibcScript],
    })
    const libc: Libc = detected.stdout.trim() === "musl" ? "musl" : "glibc"
    if (recipe.docker) {
      yield* log("Installing Docker...\n")
      yield* runScript(
        backend,
        sessionId,
        { label: "Installing Docker", name: "docker", script: dockerInstallScript, cwd: "/" },
        log,
      )
    }
    yield* runScript(
      backend,
      sessionId,
      {
        label: "Installing tmux and bash",
        name: "claude-needs",
        script: claudeNeedsScript,
        cwd: "/",
      },
      log,
    )
    if (recipe.bootstrapScript.trim() !== "") {
      yield* log("Running the bootstrap script...\n")
      yield* runScript(
        backend,
        sessionId,
        {
          label: "The bootstrap script",
          name: "bootstrap",
          script: recipe.bootstrapScript,
          env: options.buildEnv,
          cwd: "/root",
        },
        log,
      )
    }
    yield* log("Reading the login shell's environment...\n")
    yield* probeLoginEnv(backend, sessionId, { cwd: "/root", exclude: variableNames(recipe) })
    yield* log("Saving the build...\n")
    yield* backend.stop(sessionId)
    return libc
  })
