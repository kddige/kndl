// A `kndl` installed from a Hub follows the Hub's commit (issue #178), as Runners do
// (ADR 0011). Each run asks the Hub it was installed from (CliConfig.ts) for its commit
// (`GET /cli/version`); when it differs from the binary's own, the CLI downloads the Hub's binary
// for its platform, checks it runs and is at that commit, puts it in its own place with a rename,
// and runs the command again with it. A Hub that doesn't answer in time leaves the CLI as it is,
// so the CLI works offline; an update that fails says why and goes on with this binary.
//
// A CLI run from a checkout, as an install's command runs it, has no build (BuildInfo.ts) and
// never updates itself: it updates with the checkout, by `kndl update`.
import { realpathSync } from "node:fs"
import { chmod, rename, rm } from "node:fs/promises"
import { dirname, join } from "node:path"
import { CliCommitHeader, CliVersion } from "@kndl/protocol"
import { Console, Effect, Option, Schema } from "effect"
import type { Build } from "./BuildInfo.ts"
import type { CliConfig } from "./CliConfig.ts"

/** Set to anything, the CLI never updates itself. */
export const NoSelfUpdateVariable = "KNDL_NO_SELF_UPDATE"

/** Set on the run of the command again after an update, to the commit updated to. */
export const UpdatedVariable = "KNDL_UPDATED_TO"

/** Whether to ask the Hub for its commit, and if not, why not. */
export type SelfUpdatePlan =
  | { readonly _tag: "Skip"; readonly reason: string }
  | { readonly _tag: "Check"; readonly hub: string; readonly build: Build }

export function planSelfUpdate(input: {
  readonly build: Build | undefined
  readonly env: Record<string, string | undefined>
  readonly config: CliConfig
}): SelfUpdatePlan {
  const { build, env, config } = input
  if (build === undefined) {
    return { _tag: "Skip", reason: "It runs from a checkout, which `kndl update` updates." }
  }
  if (env[NoSelfUpdateVariable]) {
    return { _tag: "Skip", reason: `${NoSelfUpdateVariable} is set.` }
  }
  if (env[UpdatedVariable]) {
    return { _tag: "Skip", reason: `It was updated to ${env[UpdatedVariable]} just now.` }
  }
  if (config.hub === undefined) {
    return { _tag: "Skip", reason: "No Hub is recorded to update from." }
  }
  return { _tag: "Check", hub: config.hub, build }
}

/** The commit to update to, given what the Hub serves: none when the binary is at it already. */
export function updateTo(build: Build, hubCommit: string | undefined): string | undefined {
  return hubCommit === undefined || hubCommit === build.commit ? undefined : hubCommit
}

/** How long a run waits for the Hub to say its commit before going on without. */
const CheckTimeoutMs = 2_000

/** How long it waits for the binary: the Hub builds it the first time it's asked. */
const DownloadTimeoutMs = 5 * 60_000

const decodeVersion = Schema.decodeUnknownOption(CliVersion)

/** The commit the Hub serves the CLI at; `undefined` when it doesn't say in time. */
export const hubCommit = (hub: string, timeoutMs = CheckTimeoutMs) =>
  Effect.promise(async (): Promise<string | undefined> => {
    try {
      const response = await fetch(new URL("/cli/version", hub), {
        signal: AbortSignal.timeout(timeoutMs),
      })
      if (!response.ok) return undefined
      return Option.getOrUndefined(decodeVersion(await response.json()))?.commit
    } catch {
      return undefined
    }
  })

/**
 * Replaces the binary at `exe` with the Hub's for `target` at `commit`: downloaded beside it,
 * checked, and renamed over it, so `exe` is always a whole binary. Fails with why not.
 */
export const replaceBinary = (options: {
  readonly hub: string
  readonly target: string
  readonly commit: string
  readonly exe: string
}) =>
  Effect.tryPromise({
    try: async () => {
      const exe = realpathSync(options.exe)
      const partial = join(dirname(exe), `.kndl.update-${process.pid}`)
      try {
        const url = new URL(`/cli/${options.target}`, options.hub)
        const response = await fetch(url, { signal: AbortSignal.timeout(DownloadTimeoutMs) })
        if (response.status !== 200) {
          throw new Error(`the Hub answered ${response.status}: ${(await response.text()).trim()}`)
        }
        const sent = response.headers.get(CliCommitHeader)
        if (sent !== options.commit) {
          throw new Error(`the Hub sent the CLI at ${sent ?? "no commit"}, not ${options.commit}`)
        }
        await Bun.write(partial, response)
        await chmod(partial, 0o755)
        if (options.target.startsWith("darwin-")) await adHocSign(partial)
        const version = await run([partial, "--version"])
        if (!version.includes(options.commit.slice(0, 12))) {
          throw new Error(`the new binary says it is ${version.trim() || "nothing"}`)
        }
        await rename(partial, exe)
        return exe
      } finally {
        await rm(partial, { force: true })
      }
    },
    catch: (error) => (error instanceof Error ? error.message : String(error)),
  })

/**
 * macOS kills a binary whose signature doesn't hold as it starts, and the one
 * `bun build --compile` gives doesn't once the binary is downloaded: sign it again, ad hoc.
 */
const adHocSign = async (path: string) => {
  await run(["codesign", "--force", "--sign", "-", path]).catch((error: unknown) => {
    throw new Error(`codesign couldn't sign it: ${error instanceof Error ? error.message : error}`)
  })
}

/** Runs a command to its end, with its stdout; fails unless it exits 0. */
async function run(argv: ReadonlyArray<string>): Promise<string> {
  const child = Bun.spawn([...argv], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, [NoSelfUpdateVariable]: "1" },
    timeout: 30_000,
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (exitCode !== 0) throw new Error(stderr.trim() || `${argv[0]} exited with ${exitCode}`)
  return stdout
}

/**
 * Runs the command again with the binary at `exe`, as it was given, and exits as it does. Ctrl-C
 * reaches the new run, which is in the same process group; this one waits for it.
 */
const runAgain = (exe: string, commit: string) =>
  Effect.promise(async () => {
    process.on("SIGINT", () => {})
    const child = Bun.spawn([exe, ...process.argv.slice(2)], {
      stdio: ["inherit", "inherit", "inherit"],
      env: { ...process.env, [UpdatedVariable]: commit },
    })
    process.exit(await child.exited)
  })

/**
 * main.ts's, before the command: updates a binary the Hub built to the Hub's commit, and runs the
 * command with the new one. Says what it did on stderr, so a command's output stays its own.
 */
export const selfUpdate = (input: {
  readonly build: Build | undefined
  readonly env: Record<string, string | undefined>
  readonly config: CliConfig
}) =>
  Effect.gen(function* () {
    const plan = planSelfUpdate(input)
    if (plan._tag === "Skip") return
    const commit = updateTo(plan.build, yield* hubCommit(plan.hub))
    if (commit === undefined) return
    const short = commit.slice(0, 12)
    yield* Console.error(`kndl: updating to ${short} from ${plan.hub}...`)
    yield* replaceBinary({
      hub: plan.hub,
      target: plan.build.target,
      commit,
      exe: process.execPath,
    }).pipe(
      Effect.matchEffect({
        onFailure: (reason) =>
          Console.error(
            `kndl: couldn't update to ${short} (${reason}); going on with ${plan.build.commit.slice(0, 12)}.`,
          ),
        onSuccess: (exe) =>
          Effect.andThen(Console.error(`kndl: updated to ${short}.`), runAgain(exe, commit)),
      }),
    )
  })
