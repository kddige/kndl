// Redacting Sensitive values (issue #48, ADR 0009): the Hub masks them in everything it stores
// or shows, before it is written to a Session's log or sent to anyone.
//
// - Each character of a value found is replaced with `*`, so a terminal's layout stays as it was.
//   A value's length shows; its characters don't.
// - Besides the value itself, the Hub looks for its forms most likely to be printed: trimmed of
//   whitespace, with its line breaks removed, escaped as in a JSON string, URL-encoded, and each
//   long line of a multi-line value on its own (as a key file printed in part).
// - Matching skips terminal control sequences (CSI and other ESC sequences) and line breaks, so a
//   value coloured part-way, or wrapped at the edge of the screen in a Snapshot, is still found.
// - Values shorter than MinSensitiveValueLength aren't looked for: the Hub refuses to save them
//   as Sensitive, and masking every occurrence of a shorter text would garble everything.
// - Streams (terminal Output frames, Test build logs) come in chunks that can split a value. The
//   end of a chunk that could start a value is held back until the next chunk shows whether it
//   does, or for `holdMillis` at most. Held text that is let go is shown as it is when it is
//   shorter than MinSensitiveValueLength, and masked otherwise; and if the next chunk then goes on
//   with the rest of the value, that rest is masked. So a value printed slowly, one character at a
//   time (as typed by hand), shows at most its first few characters.
// - A whole text (a transcript event's strings, a Snapshot) is a stream that ends: text at its
//   end that starts a value, as a tool output clipped part-way through one, is masked when it is
//   at least MinSensitiveValueLength long.
//
// - When the Hub can't read the values (its key changed), it masks every character instead.
//
// Not covered: a value transformed before it is printed (base64, hashed, reversed, split by the
// program printing it), and a value Claude Code's TUI wraps onto a new line itself, with
// indentation, in the terminal. The transcript is redacted either way.

import {
  MinSensitiveValueLength,
  type Attachment,
  type Question,
  type QuestionOutcome,
  type SessionEvent,
} from "@kndl/protocol"

/** The longest a stream holds text back that could start a value, in milliseconds. */
export const holdMillis = 100

/** A long line of a multi-line value is looked for on its own from this length. */
const minLineLength = 16

/** The longest CSI sequence the Hub skips; a longer one is taken as text. */
const maxCsiLength = 64

/** What to look for: the forms of a set of Sensitive values, longest first. */
export interface Needles {
  readonly list: ReadonlyArray<string>
  readonly firstChars: ReadonlySet<string>
  readonly longest: number
  /** Mask every character, as when the values can't be read. */
  readonly everything?: boolean
}

/** Masks every character: for when the values to look for can't be read. */
export const everything: Needles = { list: [], firstChars: new Set(), longest: 0, everything: true }

const isEmpty = (needles: Needles) => needles.list.length === 0 && needles.everything !== true

const lineBreaks = /[\r\n]/g

function urlEncoded(value: string): string | undefined {
  try {
    return encodeURIComponent(value)
  } catch {
    return undefined
  }
}

/** What to look for to redact these Sensitive values. */
export function needlesOf(values: Iterable<string>): Needles {
  const found = new Set<string>()
  const add = (form: string | undefined, minLength = MinSensitiveValueLength) => {
    const needle = form?.replace(lineBreaks, "")
    if (needle !== undefined && needle.length >= minLength) found.add(needle)
  }
  for (const value of values) {
    if (value.trim().length < MinSensitiveValueLength) continue
    add(value)
    add(value.trim())
    add(JSON.stringify(value).slice(1, -1))
    add(urlEncoded(value))
    const lines = value.split(/\r\n|\r|\n/)
    if (lines.length > 1) for (const line of lines) add(line.trim(), minLineLength)
  }
  const list = [...found].toSorted((a, b) => b.length - a.length)
  return {
    list,
    firstChars: new Set(list.map((needle) => needle.charAt(0))),
    longest: list[0]?.length ?? 0,
  }
}

/** A text's characters that matching looks at, and where each is in the text. */
interface Scanned {
  readonly visible: string
  readonly positions: ReadonlyArray<number>
  /** Where an unfinished control sequence starts at the end, or the text's length. */
  readonly unfinishedFrom: number
}

/** The index after the control sequence at `from` (an ESC), or -1 when it is unfinished. */
function sequenceEnd(text: string, from: number): number {
  if (from + 1 >= text.length) return -1
  const next = text.charCodeAt(from + 1)
  if (next === 0x5b) {
    // CSI: ESC [, parameter and intermediate bytes, then a final byte.
    for (let index = from + 2; index < text.length; index++) {
      const code = text.charCodeAt(index)
      if (code >= 0x40 && code <= 0x7e) return index + 1
      if (code < 0x20 || code > 0x3f || index - from > maxCsiLength) return from + 2
    }
    return -1
  }
  // ESC with an intermediate byte, as a charset designation (ESC ( B), takes one more.
  if (next >= 0x20 && next <= 0x2f) return from + 2 >= text.length ? -1 : from + 3
  return from + 2
}

function scan(text: string): Scanned {
  let visible = ""
  const positions: Array<number> = []
  let index = 0
  while (index < text.length) {
    const code = text.charCodeAt(index)
    if (code === 0x1b) {
      const end = sequenceEnd(text, index)
      if (end === -1) return { visible, positions, unfinishedFrom: index }
      index = end
    } else if (code === 0x0a || code === 0x0d) {
      index++
    } else {
      visible += text.charAt(index)
      positions.push(index)
      index++
    }
  }
  return { visible, positions, unfinishedFrom: text.length }
}

/** `text` up to `end`, with the visible characters marked in `masked` replaced by `*`. */
function masking(
  text: string,
  end: number,
  positions: ReadonlyArray<number>,
  masked: Uint8Array,
): string {
  let out = ""
  let from = 0
  for (const [index, position] of positions.entries()) {
    if (position >= end) break
    if (masked[index] === 1) {
      out += `${text.slice(from, position)}*`
      from = position + 1
    }
  }
  return out + text.slice(from, end)
}

/** Every rest of a needle that `visible`'s end (or a shorter end of it) starts. */
function restsAfter(needles: Needles, visible: string): Array<string> {
  const rests = new Set<string>()
  for (let index = 0; index < visible.length; index++) {
    const tail = visible.slice(index)
    for (const needle of needles.list) {
      if (needle.length > tail.length && needle.startsWith(tail)) {
        rests.add(needle.slice(tail.length))
      }
    }
  }
  return [...rests]
}

/**
 * Redacts a stream of text that comes in chunks, as a terminal's Output frames: text that could
 * start a value is held back until the next chunk, or until `flush`.
 */
export class StreamRedactor {
  private carry = ""
  /** The rests of values whose start was let go by `flush`, to mask if the stream goes on so. */
  private rests: ReadonlyArray<string> = []

  constructor(public needles: Needles) {}

  /** Whether text is held back, for `flush` to let go. */
  get holding(): boolean {
    return this.carry !== ""
  }

  /** The chunk, redacted, as far as it can be sent now. */
  push(chunk: string): string {
    if (isEmpty(this.needles) && this.carry === "" && this.rests.length === 0) return chunk
    const text = this.carry + chunk
    this.carry = ""
    const { visible, positions, unfinishedFrom } = scan(text)
    const masked = new Uint8Array(visible.length)
    if (this.needles.everything === true) masked.fill(1)
    let maskedTo = 0
    const mask = (from: number, to: number) => {
      masked.fill(1, from, to)
      maskedTo = Math.max(maskedTo, to)
    }

    if (visible.length > 0 && this.rests.length > 0) {
      const rests: Array<string> = []
      for (const rest of this.rests) {
        if (visible.startsWith(rest)) mask(0, rest.length)
        else if (rest.startsWith(visible)) {
          mask(0, visible.length)
          rests.push(rest.slice(visible.length))
        }
      }
      this.rests = rests
    }

    for (const needle of this.needles.list) {
      for (let at = visible.indexOf(needle); at !== -1; at = visible.indexOf(needle, at + 1)) {
        mask(at, at + needle.length)
      }
    }

    // Hold back the longest end that could start a value, past what was masked.
    let hold = visible.length
    for (
      let index = Math.max(maskedTo, visible.length - this.needles.longest + 1);
      index < visible.length;
      index++
    ) {
      if (!this.needles.firstChars.has(visible.charAt(index))) continue
      const tail = visible.slice(index)
      if (this.needles.list.some((n) => n.length > tail.length && n.startsWith(tail))) {
        hold = index
        break
      }
    }
    const cut = Math.min(positions[hold] ?? text.length, unfinishedFrom)
    this.carry = text.slice(cut)
    return masking(text, cut, positions, masked)
  }

  /**
   * Lets go of the text held back: masked if it is long enough to be a value's start, as it is
   * otherwise. If the stream then goes on with the rest of a value, that rest is masked.
   */
  flush(): string {
    const text = this.carry
    this.carry = ""
    if (text === "") return ""
    const { visible, positions } = scan(text)
    if (visible.length > 0) this.rests = restsAfter(this.needles, visible)
    const masked = new Uint8Array(visible.length)
    if (visible.length >= MinSensitiveValueLength) masked.fill(1)
    return masking(text, text.length, positions, masked)
  }

  /** Forgets what is held back, as when a Snapshot redraws the whole screen. */
  reset(): void {
    this.carry = ""
    this.rests = []
  }
}

/** A whole text, redacted. */
export function redactText(needles: Needles, text: string): string {
  if (isEmpty(needles)) return text
  const stream = new StreamRedactor(needles)
  return stream.push(text) + stream.flush()
}

/** An Open question's questions, redacted: their text, headers and options (#193). */
export function redactQuestions(
  needles: Needles,
  questions: ReadonlyArray<Question>,
): ReadonlyArray<Question> {
  if (isEmpty(needles)) return questions
  const redact = (text: string) => redactText(needles, text)
  return questions.map((question) => ({
    ...question,
    question: redact(question.question),
    header: redact(question.header),
    options: question.options.map((option) => ({
      ...option,
      label: redact(option.label),
      ...(option.description !== undefined && { description: redact(option.description) }),
    })),
  }))
}

/** Attachments with their names redacted, since each name is in its marker in a message. */
const redactAttachments = (needles: Needles, attachments: ReadonlyArray<Attachment>) =>
  attachments.map((attachment) => ({ ...attachment, name: redactText(needles, attachment.name) }))

/** How an Open question closed, redacted: the answers, keyed by their redacted questions. */
export function redactOutcome(needles: Needles, outcome: QuestionOutcome): QuestionOutcome {
  if (isEmpty(needles)) return outcome
  const redact = (text: string) => redactText(needles, text)
  switch (outcome._tag) {
    case "Answered":
      return {
        ...outcome,
        answers: Object.fromEntries(
          Object.entries(outcome.answers).map(([question, answer]) => [
            redact(question),
            redact(answer),
          ]),
        ),
      }
    case "Replied":
      return {
        ...outcome,
        text: redact(outcome.text),
        ...(outcome.attachments !== undefined && {
          attachments: redactAttachments(needles, outcome.attachments),
        }),
      }
    case "Dismissed":
    case "Cancelled":
      return outcome
  }
}

/**
 * A Session event with its free text redacted: a prompt, Claude's text, tool input and output,
 * an agent's description, the messages people send it, questions and their answers, and a prompt
 * the Hub cancelled.
 */
export function redactEvent(needles: Needles, event: SessionEvent): SessionEvent {
  if (isEmpty(needles)) return event
  const redact = (text: string) => redactText(needles, text)
  switch (event._tag) {
    // An attachment's name is in its marker in the text: both are redacted alike (#276, #278).
    case "TurnStarted":
    case "AgentMessaged":
    case "PromptSteered":
      return {
        ...event,
        text: redact(event.text),
        ...(event.attachments !== undefined && {
          attachments: redactAttachments(needles, event.attachments),
        }),
      }
    case "TextDelta":
      return { ...event, text: redact(event.text) }
    case "AgentStarted":
      return { ...event, description: redact(event.description) }
    case "ToolCallStarted":
      return { ...event, input: redact(event.input) }
    case "ToolCallEnded":
      return { ...event, output: redact(event.output) }
    case "SessionStateChanged":
      return event.message === undefined ? event : { ...event, message: redact(event.message) }
    case "SandboxNoted":
      return { ...event, message: redact(event.message) }
    case "PromptCancelled":
      return { ...event, text: redact(event.text), message: redact(event.message) }
    case "QuestionAsked":
      return { ...event, questions: redactQuestions(needles, event.questions) }
    case "QuestionClosed":
      return { ...event, outcome: redactOutcome(needles, event.outcome) }
    case "TurnEnded":
    case "TurnStopRequested":
    case "ModelSwitched":
    case "AgentStatusChanged":
    case "SteeredPromptRead":
      return event
  }
}
