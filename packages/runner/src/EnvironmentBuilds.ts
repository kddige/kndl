// An Environment's builds on this Runner (ADR 0009): the bootstrap run on the Environment's image,
// without the Workspace, then the disk snapshotted. Sessions boot from the snapshot.
//
// Builds are keyed by the Environment's build version, the version that last changed the build,
// and kept in one snapshot group per Repo. Each is named `b<build version>-<libc>`, recording which
// Claude Code build its Sandboxes run the tool bridge from (spike #46). A Runner builds a version
// the first time a Session needs it, and keeps the last few per Repo.
//
// What the scripts print goes to a log the caller shows, and is never written to the Runner's
// disk: it may hold variable values.

import { createHash } from "node:crypto"
import type { EnvironmentRecipe, EnvironmentResources, SessionId } from "@claude-hub/protocol"
import { Data, Effect, Stream } from "effect"
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

/** Where a script is written in the guest while it runs. */
const scriptPath = (name: string) => `/tmp/claude-hub-${name}.sh`

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
 * Runs a script in the Sandbox, streaming its output to `log`, and fails with the end of that
 * output unless it exits 0. A script starting with `#!` runs with its own interpreter; any other
 * with `sh -e`, so it stops at its first failing command. It gets no stdin.
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
        args: [
          "-c",
          'chmod 755 "$1"; if head -c 2 "$1" | grep -q "^#!"; then exec "$1"; else exec sh -e "$1"; fi',
          "sh",
          path,
        ],
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

/**
 * Builds a recipe in a new Sandbox of its own, `sessionId`, and leaves it stopped for a
 * snapshot: Docker if toggled, then the bootstrap with the variables available at build. Returns
 * the libc the image needs. Any Sandbox already there under that id is destroyed first.
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
    yield* log("Saving the build...\n")
    yield* backend.stop(sessionId)
    return libc
  })
