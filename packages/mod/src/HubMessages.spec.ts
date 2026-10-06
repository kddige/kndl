import { describe, expect, test } from "bun:test"
import { MaxToolSummaryLength, ModEvents, ModHello, ProtocolVersion } from "@claude-hub/protocol"
import { Schema } from "effect"
import {
  checkEvent,
  clip,
  eventsBody,
  helloBody,
  Outbox,
  promptFromParticipant,
  readCommands,
  readHelloReply,
  resultSummary,
  sandboxEnvironment,
  sharedSessionNote,
  turnEndReason,
} from "./HubMessages.ts"
import type { ModEventEncoded } from "./HubMessages.ts"

const participant = { id: "p1", login: "ada", name: "Ada Lovelace" }

/** One of each event the mod reports, as the glue builds them. */
const events: Array<Record<string, unknown>> = [
  {
    _tag: "TurnStarted",
    turnId: "t1",
    text: "[Ada Lovelace] fix it",
    sender: { _tag: "FromParticipant", participant },
    promptId: "pr1",
  },
  { _tag: "TurnStarted", turnId: "t2", text: "hi", sender: { _tag: "FromTerminal" } },
  { _tag: "TextDelta", turnId: "t1", text: "Looking" },
  { _tag: "TextDelta", turnId: "t1", agentId: "a1", text: "sub" },
  {
    _tag: "ToolCallStarted",
    turnId: "t1",
    toolCallId: "toolu_1",
    tool: "Bash",
    input: '{"command":"ls"}',
  },
  {
    _tag: "ToolCallEnded",
    turnId: "t1",
    agentId: "a1",
    toolCallId: "toolu_1",
    tool: "Bash",
    outcome: "Succeeded",
    output: "a.txt",
  },
  {
    _tag: "ToolCallEnded",
    turnId: "t1",
    toolCallId: "toolu_2",
    tool: "WebFetch",
    outcome: "Denied",
    output: "not available",
  },
  {
    _tag: "TurnEnded",
    turnId: "t1",
    reason: "Answered",
    durationMs: 1200,
    usage: {
      model: "claude-test",
      inputTokens: 10,
      outputTokens: 20,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
    },
  },
  { _tag: "TurnEnded", turnId: "t1", agentId: "a1", reason: "Stopped", durationMs: 5 },
  { _tag: "PromptFailed", promptId: "pr1", message: "a hook dropped the prompt" },
]

describe("checkEvent", () => {
  test("accepts every event the mod reports, and the Hub's schema decodes the batch", () => {
    const checked = events.map(checkEvent)
    for (const result of checked) expect(result._tag).toBe("Valid")
    const valid = checked.flatMap((result) => (result._tag === "Valid" ? [result.event] : []))
    const decoded = Schema.decodeUnknownSync(Schema.fromJsonString(ModEvents))(eventsBody(valid))
    expect(decoded.messages.map((event) => event._tag as string)).toEqual(
      events.map((event) => String(event["_tag"])),
    )
  })

  test("rejects events the Hub would refuse", () => {
    for (const event of [
      { _tag: "TurnStarted", turnId: "", text: "x", sender: { _tag: "FromTerminal" } },
      { _tag: "TextDelta", turnId: "t1" },
      {
        _tag: "ToolCallEnded",
        turnId: "t1",
        toolCallId: "x",
        tool: "Bash",
        outcome: "Maybe",
        output: "",
      },
      {
        _tag: "ToolCallStarted",
        turnId: "t1",
        toolCallId: "x",
        tool: "Bash",
        input: "x".repeat(MaxToolSummaryLength + 1),
      },
      { _tag: "Nonsense" },
    ])
      expect(checkEvent(event)._tag).toBe("Invalid")
  })
})

test("helloBody says hello in the protocol's shape", () => {
  const body = helloBody({ sessionId: "s1", claudeSessionId: "c1", model: "claude-test" })
  expect(Schema.decodeUnknownSync(Schema.fromJsonString(ModHello))(body)).toEqual({
    _tag: "ModHello",
    protocolVersion: ProtocolVersion,
    sessionId: "s1",
    claudeSessionId: "c1",
    model: "claude-test",
  } as never)
})

describe("reading the Hub's replies", () => {
  test("a welcome and a rejection", () => {
    expect(
      readHelloReply(JSON.stringify({ _tag: "ModWelcome", protocolVersion: ProtocolVersion })),
    ).toEqual({
      _tag: "ModWelcome",
      protocolVersion: ProtocolVersion,
    })
    expect(
      readHelloReply(
        JSON.stringify({
          _tag: "HandshakeRejected",
          reason: "ProtocolVersionMismatch",
          protocolVersion: 99,
          message: "update",
        }),
      )?._tag,
    ).toBe("HandshakeRejected")
    expect(
      readHelloReply(JSON.stringify({ _tag: "ModWelcome", protocolVersion: 99 })),
    ).toBeUndefined()
    expect(readHelloReply("<html>")).toBeUndefined()
  })

  test("commands", () => {
    const commands = readCommands(
      JSON.stringify({
        messages: [
          {
            seq: 1,
            message: {
              _tag: "DeliverPrompt",
              sessionId: "s1",
              promptId: "pr1",
              text: "hi",
              sender: participant,
            },
          },
          { seq: 2, message: { _tag: "StopTurn", sessionId: "s1" } },
          {
            seq: 3,
            message: { _tag: "PresenceChanged", sessionId: "s1", participants: [participant] },
          },
        ],
      }),
    )
    expect(commands?.messages.map(({ seq, message }) => `${seq} ${message._tag}`)).toEqual([
      "1 DeliverPrompt",
      "2 StopTurn",
      "3 PresenceChanged",
    ])
    expect(
      readCommands(JSON.stringify({ messages: [{ seq: 1, message: { _tag: "Explode" } }] })),
    ).toBeUndefined()
    expect(readCommands("")).toBeUndefined()
  })
})

const delta = (text: string, agentId?: string): ModEventEncoded =>
  ({
    _tag: "TextDelta",
    turnId: "t1",
    ...(agentId === undefined ? {} : { agentId }),
    text,
  }) as ModEventEncoded

describe("Outbox", () => {
  test("merges consecutive text pieces of one loop", () => {
    const outbox = new Outbox()
    outbox.push(delta("Hel"))
    outbox.push(delta("lo"))
    outbox.push(delta("sub", "a1"))
    outbox.push(delta("!"))
    expect(outbox.take()).toEqual([delta("Hello"), delta("sub", "a1"), delta("!")])
    expect(outbox.size).toBe(0)
  })

  test("puts a failed batch back ahead of what came since", () => {
    const outbox = new Outbox()
    outbox.push(delta("a", "a1"))
    const batch = outbox.take()
    outbox.push(delta("b"))
    outbox.putBack(batch)
    expect(outbox.take()).toEqual([delta("a", "a1"), delta("b")])
  })
})

test("clip keeps text within the protocol's limit and says how much it cut", () => {
  expect(clip("short")).toBe("short")
  const clipped = clip("x".repeat(MaxToolSummaryLength * 2))
  expect(clipped.length).toBeLessThanOrEqual(MaxToolSummaryLength)
  expect(clipped).toContain("more chars")
})

test("resultSummary shows a command's output", () => {
  expect(resultSummary("Bash", { stdout: "out", stderr: "err", interrupted: false })).toBe(
    "out\nerr",
  )
  expect(resultSummary("Write", { type: "create", filePath: "/workspace/a" })).toBe(
    '{"type":"create","filePath":"/workspace/a"}',
  )
})

test("turnEndReason names every way a Turn ends", () => {
  expect(["answer", "aborted", "refusal", "error"].map((r) => turnEndReason(r as never))).toEqual([
    "Answered",
    "Stopped",
    "Refused",
    "Failed",
  ])
})

test("a prompt from a Participant is led by their name", () => {
  expect(promptFromParticipant(participant as never, "fix it")).toBe("[Ada Lovelace] fix it")
})

test("the shared Session's note says where the model runs, and leaves `!` alone (ADR 0013)", () => {
  expect(sharedSessionNote).toContain(
    "You run in a sandbox VM where the repository is checked out.",
  )
  expect(sharedSessionNote).not.toContain("!")
})

test("the Sandbox's environment names its checkout, Repo, Work branch and platform", () => {
  const text = sandboxEnvironment({
    workspace: "/workspace",
    repo: "acme/app",
    workBranch: "claude/fix-login",
  })
  expect(text).toContain(" - Primary working directory: /workspace\n")
  expect(text).toContain(" - Is a git repository: true\n")
  expect(text).toContain(" - Repository: acme/app, checked out at /workspace\n")
  expect(text).toContain(" - Work branch: claude/fix-login")
  expect(text).toContain(" - Platform: linux\n")
  expect(text).toContain(" - Shell: bash\n")
  expect(text).not.toMatch(/darwin|zsh|\/Users\//i)
})

test("the Sandbox's environment leaves out what the Runner didn't say", () => {
  const text = sandboxEnvironment({
    workspace: "/workspace",
    repo: undefined,
    workBranch: undefined,
  })
  expect(text).toContain("Primary working directory: /workspace")
  expect(text).not.toContain("Repository:")
  expect(text).not.toContain("Work branch:")
})
