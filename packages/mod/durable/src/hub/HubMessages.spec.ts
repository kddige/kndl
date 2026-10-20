import { describe, expect, test } from "bun:test"
import { MaxToolSummaryLength, ModEvents, ModHello, ProtocolVersion } from "@kndl/protocol"
import { Schema } from "effect"
import {
  askedQuestions,
  attachmentContext,
  attachmentPart,
  attachmentPartPath,
  attachmentResult,
  maxAttachmentParts,
  checkEvent,
  clip,
  deliveredPrompt,
  eventsBody,
  helloBody,
  openAttachment,
  Outbox,
  promptFromParticipant,
  readCommands,
  readHelloReply,
  steeredPrompt,
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
    reason: "stop",
    durationMs: 1200,
    usage: { model: "claude-test", input: 10, output: 20, cacheRead: 0, cacheWrite: 0 },
  },
  { _tag: "TurnEnded", turnId: "t1", agentId: "a1", reason: "aborted", durationMs: 5 },
  {
    _tag: "TurnStarted",
    turnId: "t3",
    text: "<task-notification>…</task-notification>",
    sender: { _tag: "FromAgent", agentId: "a1" },
  },
  {
    _tag: "AgentStarted",
    turnId: "t1",
    agentId: "a1",
    toolCallId: "toolu_3",
    agentType: "general-purpose",
    description: "Survey the docs",
    model: "claude-haiku-4-5",
    background: true,
  },
  {
    _tag: "AgentStatusChanged",
    agentId: "a1",
    status: "Running",
    worktree: { path: "/workspace/.claude/worktrees/agent-a1", branch: "worktree-agent-a1" },
  },
  { _tag: "AgentStatusChanged", agentId: "a1", status: "Stopped" },
  { _tag: "PromptFailed", promptId: "pr1", message: "a hook dropped the prompt" },
  {
    _tag: "PromptSteered",
    turnId: "t1",
    promptId: "pr2",
    text: "and the docs",
    sender: participant,
  },
  { _tag: "SteeredPromptRead", turnId: "t1", promptId: "pr2" },
  {
    _tag: "AgentCommandFailed",
    agentId: "a1",
    command: "MessageAgent",
    senderId: "p1",
    message: "No agent a1",
  },
  {
    _tag: "QuestionAsked",
    turnId: "t1",
    toolCallId: "toolu_4",
    questions: [
      {
        question: "Which library?",
        header: "Library",
        options: [{ label: "date-fns", description: "Small" }, { label: "Temporal" }],
        multiSelect: false,
      },
    ],
  },
  {
    _tag: "QuestionClosed",
    turnId: "t1",
    toolCallId: "toolu_4",
    outcome: { _tag: "Answered", answers: { "Which library?": "Temporal" } },
    by: participant,
  },
  { _tag: "QuestionClosed", turnId: "t1", toolCallId: "toolu_4", outcome: { _tag: "Dismissed" } },
  {
    _tag: "AnswerFailed",
    toolCallId: "toolu_4",
    senderId: "p1",
    message: "The question was answered or closed already.",
  },
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

test("helloBody says hello in the protocol's shape: this mod steers (#195), marks files (#278), and takes handoffs (ADR 0030)", () => {
  const body = helloBody({
    sessionId: "s1",
    conversationId: "0b6d6c1e-2f4a-4c3b-9d8e-7a6b5c4d3e2f",
    model: "claude-test",
  })
  expect(Schema.decodeUnknownSync(Schema.fromJsonString(ModHello))(body)).toEqual({
    _tag: "ModHello",
    protocolVersion: ProtocolVersion,
    sessionId: "s1",
    conversationId: "0b6d6c1e-2f4a-4c3b-9d8e-7a6b5c4d3e2f",
    model: "claude-test",
    steers: true,
    attaches: true,
    takesHandoffs: true,
  } as never)
})

test("helloBody says a mod that switches models so (ADR 0029): a pi Session's", () => {
  const body = helloBody({
    sessionId: "s1",
    conversationId: "0b6d6c1e-2f4a-4c3b-9d8e-7a6b5c4d3e2f",
    model: "openai/gpt-test",
    switchesModels: true,
  })
  expect(Schema.decodeUnknownSync(Schema.fromJsonString(ModHello))(body)).toEqual({
    _tag: "ModHello",
    protocolVersion: ProtocolVersion,
    sessionId: "s1",
    conversationId: "0b6d6c1e-2f4a-4c3b-9d8e-7a6b5c4d3e2f",
    model: "openai/gpt-test",
    steers: true,
    attaches: true,
    switchesModels: true,
    takesHandoffs: true,
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
          {
            seq: 4,
            message: {
              _tag: "DeliverAnswer",
              sessionId: "s1",
              toolCallId: "toolu_4",
              answer: { _tag: "Replied", text: "Neither" },
              sender: participant,
            },
          },
        ],
      }),
    )
    expect(commands?.messages.map(({ seq, message }) => `${seq} ${message._tag}`)).toEqual([
      "1 DeliverPrompt",
      "2 StopTurn",
      "3 PresenceChanged",
      "4 DeliverAnswer",
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

test("a prompt from a Participant is led by their name", () => {
  expect(promptFromParticipant(participant as never, "fix it")).toBe("[Ada Lovelace] fix it")
})

test("a steered prompt is framed as Claude Code frames one typed while it works (#195)", () => {
  expect(steeredPrompt(participant, "and the docs")).toBe(
    [
      "<system-reminder>",
      "Ada Lovelace sent a new message while you were working:",
      "[Ada Lovelace] and the docs",
      "",
      "Address the message above as you continue this turn.",
      "</system-reminder>",
    ].join("\n"),
  )
})

describe("AskUserQuestion (#193)", () => {
  const asked = [
    {
      question: "Which library?",
      header: "Library",
      options: [
        { label: "date-fns", description: "Small", preview: "import …" },
        { label: "Temporal", description: "" },
      ],
      multiSelect: false,
    },
  ]

  test("its questions as the protocol carries them", () => {
    expect(askedQuestions(asked)).toEqual([
      {
        question: "Which library?",
        header: "Library",
        options: [{ label: "date-fns", description: "Small" }, { label: "Temporal" }],
        multiSelect: false,
      },
    ])
    expect(askedQuestions([{ question: "Name?", kind: "text" }, 7])).toEqual([
      { question: "Name?", header: "", options: [], multiSelect: false },
    ])
    expect(askedQuestions(undefined)).toEqual([])
  })
})

/** A part of shot.png, as the Hub sends it. */
const shotPart = (data: string, next?: number) => {
  const read = attachmentPart(
    200,
    JSON.stringify({ id: "att-1", name: "shot.png", mediaType: "image/png", data, next }),
  )
  if ("deny" in read) throw new Error(read.deny)
  return read.part
}

/** A part of spec.pdf, as the Hub sends it. */
const specPart = (data: string, next?: number) => {
  const read = attachmentPart(
    200,
    JSON.stringify({ id: "att-3", name: "spec.pdf", mediaType: "application/pdf", data, next }),
  )
  if ("deny" in read) throw new Error(read.deny)
  return read.part
}

describe("attachments (#276)", () => {
  const shot = { id: "att-1", name: "shot.png", mediaType: "image/png" as const, size: 12 }
  const photo = { id: "att-2", name: "photo.jpg", mediaType: "image/jpeg" as const, size: 34 }

  test("a delivered prompt names its sender, then marks each file with its id", () => {
    expect(deliveredPrompt(participant, "what broke?", [shot, photo])).toBe(
      "[Ada Lovelace] what broke?\n[Image #1: shot.png (attachment att-1)]\n[Image #2: photo.jpg (attachment att-2)]",
    )
    expect(deliveredPrompt(participant, "", [shot])).toBe(
      "[Ada Lovelace] [Image #1: shot.png (attachment att-1)]",
    )
    expect(deliveredPrompt(participant, "hi", [])).toBe("[Ada Lovelace] hi")
  })

  test("Claude is told, out of sight, to open each file with the tool", () => {
    const context = attachmentContext([shot, photo], "attachment")
    expect(context).toContain("2 images")
    expect(context).toContain("by calling attachment once per file")
    expect(context).toContain("Image #1 shot.png: id att-1")
    expect(context).toContain("Image #2 photo.jpg: id att-2")
  })

  test("a steered prompt marks its files inside the frame, for Claude to open by marker alone (#278)", () => {
    expect(steeredPrompt(participant, "and this", [shot])).toBe(
      [
        "<system-reminder>",
        "Ada Lovelace sent a new message while you were working:",
        "[Ada Lovelace] and this",
        "[Image #1: shot.png (attachment att-1)]",
        "",
        "Address the message above as you continue this turn.",
        "</system-reminder>",
      ].join("\n"),
    )
  })

  test("a PDF is marked and counted as one, numbered apart from the images (#277)", () => {
    const spec = { id: "att-3", name: "spec.pdf", mediaType: "application/pdf" as const, size: 56 }
    expect(deliveredPrompt(participant, "read it", [shot, spec])).toBe(
      "[Ada Lovelace] read it\n[Image #1: shot.png (attachment att-1)]\n[PDF #1: spec.pdf (attachment att-3)]",
    )
    const context = attachmentContext([shot, spec], "attachment")
    expect(context).toContain("1 image and 1 PDF")
    expect(context).toContain("Image #1 shot.png: id att-1; PDF #1 spec.pdf: id att-3")
  })

  test("the tool hands Claude a PDF the Hub sent as a document block, titled with its name (#277)", () => {
    // A 10 MB PDF is five parts of 2.4 MB, each under the 4 MiB the runtime reads.
    expect(maxAttachmentParts).toBe(5)
    expect(attachmentResult([specPart("JVBE", 3), specPart("Ri0x")])).toEqual({
      result: [
        { type: "text", text: "spec.pdf" },
        {
          type: "document",
          title: "spec.pdf",
          source: { type: "base64", media_type: "application/pdf", data: "JVBERi0x" },
        },
      ],
    })
  })

  test("the tool hands Claude the image the Hub sent, its parts joined, as an image block", () => {
    expect(attachmentResult([shotPart("iVBO", 3), shotPart("Rw0K")])).toEqual({
      result: [
        { type: "text", text: "shot.png" },
        { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0K" } },
      ],
    })
    expect(attachmentPartPath("att 1", 2_400_000)).toBe("/mod/attachments/att%201?offset=2400000")
  })

  test("the tool says why when the Hub has no such file, answers nonsense, or stops short", () => {
    expect(attachmentPart(404, '{"error":"There is no such attachment."}')).toEqual({
      deny: "Could not open the attachment: There is no such attachment.",
    })
    expect(attachmentPart(200, "not json")).toEqual({
      deny: "Could not open the attachment: the Hub's answer was not one.",
    })
    const first = attachmentPart(
      200,
      JSON.stringify({ id: "a", name: "a.png", mediaType: "image/png", data: "iVBO", next: 3 }),
    )
    if ("deny" in first) throw new Error(first.deny)
    expect(attachmentResult([first.part])).toEqual({
      deny: "Could not open the attachment: the Hub sent only part of it.",
    })
  })

  test("the tool fetches a file's parts from the Hub in order, each from where the last says the next starts", async () => {
    const asked: Array<string> = []
    const parts: Record<string, string> = {
      "/mod/attachments/att-1?offset=0": JSON.stringify({
        id: "att-1",
        name: "shot.png",
        mediaType: "image/png",
        data: "iVBO",
        next: 3,
      }),
      "/mod/attachments/att-1?offset=3": JSON.stringify({
        id: "att-1",
        name: "shot.png",
        mediaType: "image/png",
        data: "Rw0K",
      }),
    }
    const opened = await openAttachment("att-1", async (path) => {
      asked.push(path)
      return { status: 200, text: parts[path] ?? "" }
    })
    expect(asked).toEqual(["/mod/attachments/att-1?offset=0", "/mod/attachments/att-1?offset=3"])
    expect(opened).toEqual({
      result: [
        { type: "text", text: "shot.png" },
        { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0K" } },
      ],
    })
  })

  test("the tool says why it can't fetch a file: no id, the Hub's reason, or a failed fetch", async () => {
    expect(await openAttachment("", async () => ({ status: 200, text: "" }))).toEqual({
      deny: "Give the attachment's id, from its marker.",
    })
    expect(
      await openAttachment("att-9", async () => ({
        status: 404,
        text: '{"error":"There is no such attachment."}',
      })),
    ).toEqual({ deny: "Could not open the attachment: There is no such attachment." })
    expect(
      await openAttachment("att-9", async () => {
        throw new Error("offline")
      }),
    ).toEqual({ deny: "Could not open the attachment: Error: offline" })
  })
})
