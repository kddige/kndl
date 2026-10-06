// Redacting Sensitive values from text and streams (issue #48), on made-up values.

import { describe, expect, test } from "bun:test"
import { AgentId, ParticipantId, type SessionEvent, ToolCallId, TurnId } from "@kndl/protocol"
import { everything, needlesOf, redactEvent, redactText, StreamRedactor } from "./Redaction.ts"

const secret = "sk_TEST_9f3a2b"
const masked = "*".repeat(secret.length)
const needles = needlesOf([secret])

/** Pushes each chunk through a fresh stream, then flushes it, collecting what is sent. */
function streamed(chunks: ReadonlyArray<string>, values = needles) {
  const stream = new StreamRedactor(values)
  const sent = chunks.map((chunk) => stream.push(chunk))
  return { sent, end: stream.flush(), stream }
}

describe("Redacting a text", () => {
  test("masks each occurrence, keeping its length", () => {
    expect(redactText(needles, `token=${secret} again ${secret}.`)).toBe(
      `token=${masked} again ${masked}.`,
    )
    expect(redactText(needles, "nothing here")).toBe("nothing here")
  })

  test("finds its trimmed, JSON-escaped and URL-encoded forms", () => {
    const spaced = needlesOf([`  ${secret}\n`])
    expect(redactText(spaced, `x ${secret} y`)).toBe(`x ${masked} y`)

    const quoted = 'pa"ss\\word/+='
    const forms = needlesOf([quoted])
    const json = JSON.stringify({ password: quoted })
    expect(json).not.toContain(quoted)
    expect(redactText(forms, json)).not.toContain(JSON.stringify(quoted).slice(1, -1))
    expect(redactText(forms, `?p=${encodeURIComponent(quoted)}`)).toBe(
      `?p=${"*".repeat(encodeURIComponent(quoted).length)}`,
    )
  })

  test("finds a multi-line value whole, across \\r\\n, and its long lines alone", () => {
    const key = [
      "-----BEGIN TEST KEY-----",
      "MIIBVwIBADANBgkqhkiG9w0BAQEFAASCAUEwggE9AgEAAkEA",
      "-----END TEST KEY-----",
    ].join("\n")
    const forms = needlesOf([key])
    const printed = key.replaceAll("\n", "\r\n")
    expect(redactText(forms, printed).replaceAll(/[*\r\n]/g, "")).toBe("")
    expect(redactText(forms, "line: MIIBVwIBADANBgkqhkiG9w0BAQEFAASCAUEwggE9AgEAAkEA")).toBe(
      `line: ${"*".repeat(48)}`,
    )
  })

  test("skips terminal control sequences and line breaks inside a value", () => {
    const coloured = `${secret.slice(0, 5)}\x1b[1;31m${secret.slice(5)}\x1b[0m`
    expect(redactText(needles, coloured)).toBe(`*****\x1b[1;31m${"*".repeat(9)}\x1b[0m`)
    const wrapped = `${secret.slice(0, 8)}\x1b[0m\r\n${secret.slice(8)}`
    expect(redactText(needles, wrapped)).toBe(`********\x1b[0m\r\n******`)
  })

  test("masks the end of a text that starts a value, from the shortest length", () => {
    expect(redactText(needles, `clipped: ${secret.slice(0, 6)}`)).toBe("clipped: ******")
    expect(redactText(needles, "ends with sk_")).toBe("ends with sk_")
  })

  test("leaves values under the minimum alone", () => {
    expect(needlesOf(["abc", "  ab  ", ""]).list).toEqual([])
    expect(redactText(needlesOf(["abc"]), "abc abc")).toBe("abc abc")
    expect(needlesOf(["abcd"]).list).toEqual(["abcd"])
  })

  test("redacts an event's free text, and nothing else", () => {
    const turnId = TurnId.make("turn-1")
    const toolCallId = ToolCallId.make("call-1")
    const agentId = AgentId.make("agent-1")
    const sender = { id: ParticipantId.make("dev:alice"), login: "alice", name: "alice" }
    const agentStarted = {
      _tag: "AgentStarted",
      turnId,
      agentId,
      toolCallId,
      agentType: "general-purpose",
      model: "claude-haiku-4-5",
      background: true,
    } as const
    const events: ReadonlyArray<[SessionEvent, SessionEvent]> = [
      [
        {
          _tag: "ToolCallStarted",
          turnId,
          toolCallId,
          tool: "Bash",
          input: JSON.stringify({ command: `echo ${secret}` }),
        },
        {
          _tag: "ToolCallStarted",
          turnId,
          toolCallId,
          tool: "Bash",
          input: JSON.stringify({ command: `echo ${masked}` }),
        },
      ],
      [
        {
          _tag: "ToolCallEnded",
          turnId,
          toolCallId,
          tool: "Bash",
          outcome: "Succeeded",
          output: secret,
        },
        {
          _tag: "ToolCallEnded",
          turnId,
          toolCallId,
          tool: "Bash",
          outcome: "Succeeded",
          output: masked,
        },
      ],
      [
        { _tag: "TextDelta", turnId, text: `it is ${secret}` },
        { _tag: "TextDelta", turnId, text: `it is ${masked}` },
      ],
      [
        { _tag: "TurnStarted", turnId, text: secret, sender: { _tag: "FromTerminal" } },
        { _tag: "TurnStarted", turnId, text: masked, sender: { _tag: "FromTerminal" } },
      ],
      [
        { ...agentStarted, description: `use ${secret}` },
        { ...agentStarted, description: `use ${masked}` },
      ],
      [
        { _tag: "AgentMessaged", agentId, sender, text: `try ${secret}` },
        { _tag: "AgentMessaged", agentId, sender, text: `try ${masked}` },
      ],
      [
        { _tag: "SandboxNoted", message: `bad url ${secret}` },
        { _tag: "SandboxNoted", message: `bad url ${masked}` },
      ],
    ]
    for (const [event, redacted] of events) expect(redactEvent(needles, event)).toEqual(redacted)
  })

  test("masks every character when the values can't be read", () => {
    expect(redactText(everything, "a\x1b[1mbc\r\nd")).toBe("*\x1b[1m**\r\n*")
  })
})

describe("Redacting a stream", () => {
  test("masks a value split across chunks, holding back only what could start one", () => {
    const { sent, end } = streamed(["out: sk_TE", "ST_9f", "3a2b done\r\n"])
    expect(sent).toEqual(["out: ", "", `${masked} done\r\n`])
    expect(end).toBe("")
    expect(sent.join("")).not.toContain("sk_")
  })

  test("sends a chunk at once when its end can't start a value", () => {
    const { sent, stream } = streamed(["hello world\r\n", "x"])
    expect(sent).toEqual(["hello world\r\n", "x"])
    expect(stream.holding).toBe(false)
  })

  test("holds back a control sequence cut in two", () => {
    const { sent, end } = streamed(["a\x1b[3", "1mb"])
    expect(sent).toEqual(["a", "\x1b[31mb"])
    expect(end).toBe("")
  })

  test("lets held text go on flush: short as it is, long masked, and masks the rest after", () => {
    const short = new StreamRedactor(needles)
    expect(short.push("prompt s")).toBe("prompt ")
    expect(short.holding).toBe(true)
    expect(short.flush()).toBe("s")
    // Typed one key at a time, after the first: the rest of the value is masked as it comes.
    expect(["k", "_", "T", "EST_9f3a2b"].map((key) => short.push(key)).join("")).toBe(
      "*".repeat(secret.length - 1),
    )
    expect(short.push(" next")).toBe(" next")

    const long = new StreamRedactor(needles)
    expect(long.push("x sk_TES")).toBe("x ")
    expect(long.flush()).toBe("******")
    expect(long.push("T_9f3a2b!")).toBe("********!")

    // A rest that doesn't come is forgotten.
    const other = new StreamRedactor(needles)
    other.push("sk_T")
    expect(other.flush()).toBe("****")
    expect(other.push("ennui")).toBe("ennui")
  })

  test("reset forgets held text", () => {
    const stream = new StreamRedactor(needles)
    expect(stream.push("x sk_")).toBe("x ")
    stream.reset()
    expect(stream.holding).toBe(false)
    expect(stream.push("TEST_9f3a2b")).toBe("TEST_9f3a2b")
  })

  test("every split of a text redacts as the whole does", () => {
    const text = `a ${secret}\x1b[0m b ${secret.slice(0, 7)}\r\n${secret.slice(7)} c`
    const whole = redactText(needles, text)
    expect(whole).not.toMatch(/sk_|9f3a/)
    for (let at = 0; at <= text.length; at++) {
      const { sent, end } = streamed([text.slice(0, at), text.slice(at)])
      expect(sent.join("") + end).toBe(whole)
    }
  })
})
