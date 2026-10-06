// How the commands talk to the person running them: questions, step-by-step output and spinners
// for long steps. Onboard and the commands that change the machine go through Ui and never through
// a prompt library, so their flows stay Effect code and run in tests against a script of answers.
//
// Three implementations:
//   - clack (@clack/prompts), on a terminal;
//   - plain lines on stdout, without a terminal or with `onboard --non-interactive`: it never asks
//     and never loads clack, and the flows fail naming the flag a missing answer needs;
//   - scripted, for tests: answers come from a list, and everything shown is recorded.
// A type-only import: clack itself is imported on first use, below.
import type * as ClackModule from "@clack/prompts"
import { Console, Context, Data, Effect, Exit, Layer } from "effect"

/** The person cancelled a question (Esc, Ctrl-C). main.ts exits 130, with no stack trace. */
export class Cancelled extends Data.TaggedError("Cancelled")<{}> {}

/** One choice of a select. */
export interface Choice<A> {
  readonly value: A
  readonly label: string
  readonly hint?: string
}

/** How a line of output is marked: a step done, a warning, and so on. */
export type LogLevel = "info" | "step" | "success" | "warn" | "error" | "message"

export interface UiShape {
  /** Whether questions can be asked. When not, the flows never call the prompts. */
  readonly interactive: boolean
  /** Whether long steps run under a spinner, their output captured, rather than streamed. */
  readonly spins: boolean
  readonly select: <A>(options: {
    readonly message: string
    readonly choices: ReadonlyArray<Choice<A>>
    readonly initial?: A
  }) => Effect.Effect<A, Cancelled>
  readonly confirm: (options: {
    readonly message: string
    readonly initial: boolean
  }) => Effect.Effect<boolean, Cancelled>
  readonly text: (options: {
    readonly message: string
    readonly initial?: string
    /** Why the answer won't do, or `undefined` when it will. */
    readonly validate?: (value: string) => string | undefined
  }) => Effect.Effect<string, Cancelled>
  /** Like text, but the answer isn't shown. */
  readonly password: (options: {
    readonly message: string
    readonly validate?: (value: string) => string | undefined
  }) => Effect.Effect<string, Cancelled>
  readonly intro: (title: string) => Effect.Effect<void>
  readonly outro: (message: string) => Effect.Effect<void>
  readonly note: (message: string, title?: string) => Effect.Effect<void>
  readonly log: (level: LogLevel, message: string) => Effect.Effect<void>
  /**
   * Runs `run` under a spinner labelled `label`; `run` reports progress through the function it is
   * given. The spinner ends with `done` (or the label) on success, and marks a failure.
   */
  readonly spin: <A, E, R>(
    label: string,
    run: (progress: (message: string) => Effect.Effect<void>) => Effect.Effect<A, E, R>,
    done?: (result: A) => string,
  ) => Effect.Effect<A, E, R>
}

export class Ui extends Context.Service<Ui, UiShape>()("@kndl/cli/Ui") {
  /** clack on a terminal at both ends; plain lines otherwise. clack loads on first use. */
  static readonly layer = Layer.sync(Ui, () =>
    process.stdin.isTTY === true && process.stdout.isTTY === true ? clackUi : plainUi,
  )
}

const PlainMarks: Record<LogLevel, string> = {
  info: "",
  step: "- ",
  success: "",
  warn: "! ",
  error: "! ",
  message: "",
}

/** Plain lines on stdout, for no terminal and `--non-interactive`. It never asks. */
export const plainUi: UiShape = {
  interactive: false,
  spins: false,
  select: (options) => cannotAsk(options.message),
  confirm: (options) => cannotAsk(options.message),
  text: (options) => cannotAsk(options.message),
  password: (options) => cannotAsk(options.message),
  intro: (title) => Console.log(title),
  outro: (message) => Console.log(`\n${message}`),
  note: (message, title) => Console.log(title === undefined ? message : `\n${title}\n${message}`),
  log: (level, message) => Console.log(`${PlainMarks[level]}${message}`),
  spin: (label, run) =>
    Effect.andThen(
      Console.log(`${label}...`),
      run((message) => Console.log(`- ${message}`)),
    ),
}

/** The flows ask only when Ui is interactive: a question here is a bug, not a missing flag. */
const cannotAsk = (message: string) =>
  Effect.die(new Error(`Asked "${message}" without a terminal to ask on.`))

type Clack = typeof ClackModule

let clackModule: Promise<Clack> | undefined
/** clack, imported the first time the terminal Ui is used: a plain run never loads it. */
const withClack = <A, E, R>(use: (clack: Clack) => Effect.Effect<A, E, R>) =>
  Effect.promise(() => (clackModule ??= import("@clack/prompts"))).pipe(Effect.flatMap(use))

/**
 * A clack prompt's answer, or Cancelled. Interrupting it, as a race lost to something else does,
 * takes the prompt off the terminal.
 */
const ask = <A>(prompt: (clack: Clack, signal: AbortSignal) => Promise<A | symbol>) =>
  withClack((clack) =>
    Effect.promise((signal) => prompt(clack, signal)).pipe(
      Effect.flatMap((value) =>
        clack.isCancel(value) ? Effect.fail(new Cancelled()) : Effect.succeed(value as A),
      ),
    ),
  )

const validator = (validate: ((value: string) => string | undefined) | undefined) =>
  validate === undefined ? {} : { validate: (value: string | undefined) => validate(value ?? "") }

/**
 * Starts a clack spinner, ready for Ctrl-C. clack's spinner puts the terminal in raw mode and, on
 * Ctrl-C, calls `process.exit(0)` itself: no interruption, so the step's child process is left
 * running, and the exit says it succeeded. Back in cooked mode, Ctrl-C is a SIGINT again, to this
 * process and the step's alike: BunRuntime interrupts the flow, which stops the child and exits
 * 130. Should clack's exit still happen, it exits 130 rather than 0.
 */
function startSpinner(clack: Clack, label: string) {
  const spinner = clack.spinner()
  process.on("exit", exitCancelled)
  spinner.start(label)
  if (process.stdin.isTTY === true) process.stdin.setRawMode(false)
  return { spinner, release: () => process.off("exit", exitCancelled) }
}

/** On an exit while a spinner runs, which can only be clack's on Ctrl-C: 130 rather than 0. */
function exitCancelled() {
  if (!process.exitCode) process.exitCode = 130
}

/** clack (@clack/prompts), on a terminal. */
const clackUi: UiShape = {
  interactive: true,
  spins: true,
  select: <A>(options: {
    readonly message: string
    readonly choices: ReadonlyArray<Choice<A>>
    readonly initial?: A
  }) =>
    ask<A>((clack, signal) =>
      clack.select<A>({
        message: options.message,
        signal,
        options: options.choices.map((choice) => ({
          value: choice.value,
          label: choice.label,
          ...(choice.hint === undefined ? {} : { hint: choice.hint }),
        })) as Parameters<typeof clack.select<A>>[0]["options"],
        ...(options.initial === undefined ? {} : { initialValue: options.initial }),
      }),
    ),
  confirm: (options) =>
    ask<boolean>((clack, signal) =>
      clack.confirm({ message: options.message, initialValue: options.initial, signal }),
    ),
  text: (options) =>
    ask<string>((clack, signal) =>
      clack.text({
        message: options.message,
        signal,
        ...(options.initial === undefined ? {} : { initialValue: options.initial }),
        ...validator(options.validate),
      }),
    ),
  password: (options) =>
    ask<string>((clack, signal) =>
      clack.password({ message: options.message, signal, ...validator(options.validate) }),
    ),
  intro: (title) => withClack((clack) => Effect.sync(() => clack.intro(title))),
  outro: (message) => withClack((clack) => Effect.sync(() => clack.outro(message))),
  note: (message, title) => withClack((clack) => Effect.sync(() => clack.note(message, title))),
  log: (level, message) => withClack((clack) => Effect.sync(() => clack.log[level](message))),
  spin: (label, run, done) =>
    withClack((clack) =>
      Effect.acquireUseRelease(
        Effect.sync(() => startSpinner(clack, label)),
        ({ spinner }) =>
          run((message) => Effect.sync(() => spinner.message(`${label}: ${message}`))),
        ({ spinner, release }, exit) =>
          Effect.sync(() => {
            release()
            if (Exit.isSuccess(exit)) spinner.stop(done === undefined ? label : done(exit.value))
            else if (Exit.hasInterrupts(exit)) spinner.cancel(`${label}: stopped`)
            else spinner.error(`${label}: failed`)
          }),
      ),
    ),
}

/** An answer a scripted Ui gives to cancel the question. */
export const CancelAnswer: unique symbol = Symbol.for("@kndl/cli/Ui/Cancel")

/** An answer a scripted Ui never gives: for a question raced against something else, which wins. */
export const NoAnswer: unique symbol = Symbol.for("@kndl/cli/Ui/NoAnswer")

/**
 * A Ui for tests: each question takes the next answer from `answers` (CancelAnswer cancels it,
 * NoAnswer leaves it unanswered), and every question and line shown is recorded in `transcript`.
 * With `interactive: false` it stands in for the plain Ui, which the flows never ask.
 */
export function scriptedUi(
  answers: ReadonlyArray<unknown>,
  settings: { readonly interactive?: boolean } = {},
): {
  readonly ui: UiShape
  readonly transcript: ReadonlyArray<string>
} {
  const queue = [...answers]
  const transcript: Array<string> = []
  const next = <A>(
    kind: string,
    message: string,
    validate?: (value: string) => string | undefined,
  ) =>
    Effect.suspend(() => {
      transcript.push(`? ${kind}: ${message}`)
      if (settings.interactive === false) return cannotAsk(message)
      if (queue.length === 0) return Effect.die(new Error(`No scripted answer for "${message}"`))
      const answer = queue.shift()
      if (answer === CancelAnswer) return Effect.fail(new Cancelled())
      if (answer === NoAnswer) return Effect.never
      const problem =
        validate !== undefined && typeof answer === "string" ? validate(answer) : undefined
      if (problem !== undefined) {
        return Effect.die(new Error(`Scripted answer for "${message}" is invalid: ${problem}`))
      }
      return Effect.succeed(answer as A)
    })
  const record = (line: string) => Effect.sync(() => void transcript.push(line))
  return {
    transcript,
    ui: {
      interactive: settings.interactive ?? true,
      spins: false,
      select: (options) => next("select", options.message),
      confirm: (options) => next("confirm", options.message),
      text: (options) => next("text", options.message, options.validate),
      password: (options) => next("password", options.message, options.validate),
      intro: (title) => record(`intro: ${title}`),
      outro: (message) => record(`outro: ${message}`),
      note: (message, title) => record(`note: ${title ?? ""}: ${message}`),
      log: (level, message) => record(`${level}: ${message}`),
      spin: (label, run) =>
        Effect.andThen(
          record(`spin: ${label}`),
          run((message) => record(`progress: ${message}`)),
        ),
    },
  }
}
