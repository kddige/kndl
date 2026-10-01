import { Schema } from "effect"
import { SessionId } from "./Ids.ts"

// The terminal mirror: the Runner streams each Session's Claude Code terminal to the Hub, which
// relays it to web clients; keystrokes and resizes travel back the same way.

export const TerminalSize = Schema.Struct({
  cols: Schema.Int.check(Schema.isGreaterThan(0)),
  rows: Schema.Int.check(Schema.isGreaterThan(0)),
})
export type TerminalSize = typeof TerminalSize.Type

/**
 * Runner to Hub, then Hub to web: terminal output, as text with ANSI escape sequences.
 *
 * - `Snapshot`: the whole screen. Sent when a terminal is first watched, on reconnect and when
 *   asked with {@link RequestTerminalSnapshot}. A viewer resets its terminal and draws it.
 * - `Output`: what the terminal printed since the previous frame, to write after it.
 */
export const TerminalFrame = Schema.TaggedStruct("TerminalFrame", {
  sessionId: SessionId,
  kind: Schema.Literals(["Snapshot", "Output"]),
  data: Schema.String,
  size: TerminalSize,
})
export type TerminalFrame = typeof TerminalFrame.Type

/** Web to Hub, then Hub to Runner: keystrokes typed into the terminal, as the terminal sends them. */
export const TerminalInput = Schema.TaggedStruct("TerminalInput", {
  sessionId: SessionId,
  data: Schema.NonEmptyString,
})
export type TerminalInput = typeof TerminalInput.Type

/** Web to Hub, then Hub to Runner: resize the Session's terminal. */
export const TerminalResize = Schema.TaggedStruct("TerminalResize", {
  sessionId: SessionId,
  size: TerminalSize,
})
export type TerminalResize = typeof TerminalResize.Type

/** Hub to Runner: send a `Snapshot` frame of the Session's terminal, for a viewer that joined. */
export const RequestTerminalSnapshot = Schema.TaggedStruct("RequestTerminalSnapshot", {
  sessionId: SessionId,
})
export type RequestTerminalSnapshot = typeof RequestTerminalSnapshot.Type
