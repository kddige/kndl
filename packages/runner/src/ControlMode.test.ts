import { describe, expect, test } from "bun:test"
import {
  ControlModeParser,
  parseCursorState,
  renderSnapshot,
  unescapeOutput,
} from "./ControlMode.ts"

const bytes = (text: string) => new TextEncoder().encode(text)
const text = (data: Uint8Array) => new TextDecoder().decode(data)

describe("ControlModeParser", () => {
  test("reads %output, undoing its octal escapes and keeping UTF-8 bytes", () => {
    const [event] = new ControlModeParser().push(bytes("%output %0 hé\\033[1m\\134\\015\\012\n"))
    expect(event?._tag).toBe("Output")
    expect(event?._tag === "Output" && text(event.bytes)).toBe("hé\x1b[1m\\\r\n")
  })

  test("joins lines split across chunks, even mid character", () => {
    const parser = new ControlModeParser()
    const line = bytes("%output %0 é\n")
    expect(parser.push(line.subarray(0, 12))).toEqual([])
    const [event] = parser.push(line.subarray(12))
    expect(event?._tag === "Output" && text(event.bytes)).toBe("é")
  })

  test("returns the replies to this client's commands, and skips the rest", () => {
    const events = new ControlModeParser().push(
      bytes(
        [
          "%begin 1790899404 287 0",
          "%end 1790899404 287 0",
          "%session-changed $0 hub-s-1",
          "%begin 1790899405 292 1",
          "0 1 1 40 6",
          "%end 1790899404 287 1",
          "%end 1790899405 292 1",
          "%begin 1790899405 293 1",
          "can't find pane",
          "%error 1790899405 293 1",
          "",
        ].join("\n"),
      ),
    )
    expect(events).toEqual([
      { _tag: "Reply", lines: ["0 1 1 40 6", "%end 1790899404 287 1"], isError: false },
      { _tag: "Reply", lines: ["can't find pane"], isError: true },
    ])
  })

  test("reads the size from a layout change, subscriptions and the exit", () => {
    const events = new ControlModeParser().push(
      bytes(
        [
          "%layout-change @0 f6dd,50x7,0,0,0 f6dd,50x7,0,0,0 *",
          "%subscription-changed claude-hub-exit $0 - - - : 1 3",
          "%exit",
          "",
        ].join("\n"),
      ),
    )
    expect(events).toEqual([
      { _tag: "LayoutChange", size: { cols: 50, rows: 7 } },
      { _tag: "SubscriptionChanged", name: "claude-hub-exit", value: "1 3" },
      { _tag: "Exit", reason: undefined },
    ])
  })
})

test("unescapeOutput leaves a backslash that isn't an escape alone", () => {
  expect(text(unescapeOutput(bytes("a\\9b\\01")))).toBe("a\\9b\\01")
})

test("parseCursorState reads display-message's answer", () => {
  expect(parseCursorState("3 1 0 80 24")).toEqual({
    x: 3,
    y: 1,
    isVisible: false,
    size: { cols: 80, rows: 24 },
  })
  expect(parseCursorState("garbage")).toBeUndefined()
})

test("renderSnapshot redraws the screen and puts the cursor back", () => {
  const cursor = { x: 2, y: 1, isVisible: true, size: { cols: 10, rows: 2 } }
  expect(renderSnapshot(["\x1b[1mab", "cd", "extra"], cursor)).toBe(
    "\x1b[0m\x1b[H\x1b[2J\x1b[1mab\r\ncd\x1b[0m\x1b[2;3H\x1b[?25h",
  )
})

// tmux's capture of Claude Code's prompt: the second line's text is white on the grey set on the
// first, which a reset between them would leave white on the terminal's own background.
test("renderSnapshot keeps attributes running from one line into the next", () => {
  const cursor = { x: 0, y: 0, isVisible: false, size: { cols: 10, rows: 2 } }
  expect(renderSnapshot(["\x1b[48;5;237mab\x1b[39m", "  \x1b[38;5;231mcd"], cursor)).toBe(
    "\x1b[0m\x1b[H\x1b[2J\x1b[48;5;237mab\x1b[39m\r\n  \x1b[38;5;231mcd\x1b[0m\x1b[1;1H\x1b[?25l",
  )
})
