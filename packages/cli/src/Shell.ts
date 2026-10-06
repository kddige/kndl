// Every command the CLI runs on the host goes through Shell. The plans (Prerequisites.ts,
// Services.ts, Update.ts) are lists of Steps, built and tested without running anything; Shell
// is the thin layer that runs them.
//
// With KNDL_DRY_RUN=1, Shell prints the Steps that change the system (package managers,
// sudo, launchctl, systemctl, loginctl) instead of running them, and runs the rest (git, bun).
import { Context, Data, Effect, Layer, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { shellQuote } from "./Layout.ts"

/** One command to run. */
export interface Step {
  readonly command: string
  readonly args: ReadonlyArray<string>
  /** Run with sudo, unless already root. */
  readonly sudo?: boolean
  /** Changes the system outside the home: skipped, and printed, in a dry run. */
  readonly system?: boolean
  /** A failure is expected sometimes (stopping what isn't running) and isn't an error. */
  readonly mayFail?: boolean
  readonly cwd?: string
  /** What the Step is for, shown when it runs. */
  readonly why?: string
}

export const step = (
  command: string,
  args: ReadonlyArray<string>,
  options: Omit<Step, "command" | "args"> = {},
): Step => ({ command, args, ...options })

/** The command line a Step runs, as a person would type it. */
export function describeStep(s: Step, root = false): string {
  const words = [...(s.sudo && !root ? ["sudo"] : []), s.command, ...s.args]
  return words.map(shellQuote).join(" ")
}

export class StepFailed extends Data.TaggedError("StepFailed")<{
  readonly message: string
  readonly exitCode?: number
}> {}

export interface StepResult {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
}

export class Shell extends Context.Service<
  Shell,
  {
    /** Whether system Steps are only printed. */
    readonly dryRun: boolean
    /**
     * Runs a Step and captures its output. Fails on a non-zero exit unless the Step `mayFail`. A
     * system Step in a dry run is printed, and answers exit code 0 with no output.
     */
    readonly capture: (s: Step) => Effect.Effect<StepResult, StepFailed>
    /** Runs a Step attached to this terminal, for sudo's password and long builds' progress. */
    readonly attached: (s: Step) => Effect.Effect<number, StepFailed>
  }
>()("@kndl/cli/Shell") {
  static readonly layer = Layer.effect(
    Shell,
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const dryRun = process.env.KNDL_DRY_RUN === "1"
      const root = process.getuid?.() === 0

      const command = (s: Step, stdio: "pipe" | "inherit") => {
        const [bin, ...args] =
          s.sudo && !root ? ["sudo", s.command, ...s.args] : [s.command, ...s.args]
        return ChildProcess.make(bin ?? s.command, args, {
          ...(s.cwd === undefined ? {} : { cwd: s.cwd }),
          stdin: stdio === "inherit" ? "inherit" : "ignore",
          stdout: stdio,
          stderr: stdio,
        })
      }
      const skipped = (s: Step) =>
        Effect.sync(() => {
          console.log(`[dry run] would run: ${describeStep(s, root)}`)
        })
      const failure = (s: Step, exitCode: number, detail: string) =>
        new StepFailed({
          message: `${describeStep(s, root)} exited with ${exitCode}${detail ? `: ${detail}` : ""}`,
          exitCode,
        })
      const capture = (s: Step) =>
        dryRun && s.system
          ? skipped(s).pipe(Effect.as({ exitCode: 0, stdout: "", stderr: "" }))
          : Effect.scoped(
              Effect.gen(function* () {
                const handle = yield* spawner.spawn(command(s, "pipe"))
                const [stdout, stderr, exitCode] = yield* Effect.all(
                  [text(handle.stdout), text(handle.stderr), handle.exitCode],
                  { concurrency: "unbounded" },
                )
                if (exitCode !== 0 && !s.mayFail) {
                  return yield* failure(s, exitCode, stderr.trim() || stdout.trim())
                }
                return { exitCode, stdout, stderr }
              }),
            ).pipe(Effect.catchTag("PlatformError", (error) => Effect.fail(notRun(s)(error))))

      const attached = (s: Step) =>
        dryRun && s.system
          ? skipped(s).pipe(Effect.as(0))
          : Effect.scoped(
              Effect.gen(function* () {
                const handle = yield* spawner.spawn(command(s, "inherit"))
                const exitCode = yield* handle.exitCode
                if (exitCode !== 0 && !s.mayFail) return yield* failure(s, exitCode, "")
                return exitCode
              }),
            ).pipe(Effect.catchTag("PlatformError", (error) => Effect.fail(notRun(s)(error))))

      return Shell.of({ dryRun, capture, attached })
    }),
  )
}

const text = <E>(stream: Stream.Stream<Uint8Array, E>) =>
  stream.pipe(Stream.decodeText, Stream.mkString)

/** A Step that couldn't be started at all, such as a command that isn't installed. */
const notRun = (s: Step) => (error: { readonly message: string }) =>
  new StepFailed({ message: `could not run ${s.command}: ${error.message}` })
