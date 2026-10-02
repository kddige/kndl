import { Data, Effect, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { RunnerTokenVariable } from "./RunnerConfig.ts"

export class CommandFailed extends Data.TaggedError("CommandFailed")<{
  readonly message: string
  readonly exitCode?: number
}> {}

export interface CommandResult {
  readonly stdout: string
  readonly stderr: string
}

/**
 * The environment the Runner's child processes (tmux, git) get: the Runner's own, without its
 * token. tmux's server copies this into every Session, so the token must never be in it.
 */
export function hostEnvironment(
  env: Record<string, string | undefined> = process.env,
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && !isPrivate(key)) out[key] = value
  }
  return out
}

function isPrivate(key: string): boolean {
  // TMUX and TMUX_PANE would make tmux think it runs nested inside the Runner's own terminal.
  return key === RunnerTokenVariable || key === "TMUX" || key === "TMUX_PANE"
}

/** Runs a command to completion, failing with its stderr when it exits non-zero. */
export const runCommand = (
  command: string,
  args: ReadonlyArray<string>,
  options: { readonly cwd?: string; readonly env?: Record<string, string> } = {},
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const handle = yield* spawner.spawn(
        ChildProcess.make(command, [...args], {
          cwd: options.cwd,
          env: options.env ?? hostEnvironment(),
          extendEnv: false,
          stdin: "ignore",
        }),
      )
      const [stdout, stderr, exitCode] = yield* Effect.all(
        [text(handle.stdout), text(handle.stderr), handle.exitCode],
        { concurrency: "unbounded" },
      )
      if (exitCode !== 0) {
        const detail = stderr.trim() || stdout.trim() || "no output"
        return yield* new CommandFailed({
          message: `${command} ${args[0] ?? ""} exited with ${exitCode}: ${detail}`,
          exitCode,
        })
      }
      return { stdout, stderr } satisfies CommandResult
    }),
  ).pipe(
    Effect.catchTag("PlatformError", (error) =>
      Effect.fail(new CommandFailed({ message: `could not run ${command}: ${error.message}` })),
    ),
  )

const text = <E>(stream: Stream.Stream<Uint8Array, E>) =>
  stream.pipe(Stream.decodeText, Stream.mkString)
