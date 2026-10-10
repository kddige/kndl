import { describe, expect, test } from "bun:test"
import { MaxToolSummaryLength, ModEvents, ModHello, ProtocolVersion } from "@kndl/protocol"
import { Schema } from "effect"
import {
  agentWorktree,
  answerResult,
  askedQuestions,
  attachmentContext,
  attachmentPart,
  attachmentPartPath,
  attachmentResult,
  attachmentToolName,
  backgroundedByStop,
  checkEvent,
  clip,
  deliveredPrompt,
  dismissedText,
  eventsBody,
  helloBody,
  Outbox,
  promptFromParticipant,
  readCommands,
  readHelloReply,
  repliedPrefix,
  resultSummary,
  sharedSessionNote,
  startsDelivered,
  steeredPrompt,
  taskNotificationAgent,
  terminalOutcome,
  toolArguments,
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

test("helloBody says hello in the protocol's shape, and that this mod steers (#195)", () => {
  const body = helloBody({
    sessionId: "s1",
    claudeSessionId: "0b6d6c1e-2f4a-4c3b-9d8e-7a6b5c4d3e2f",
    model: "claude-test",
  })
  expect(Schema.decodeUnknownSync(Schema.fromJsonString(ModHello))(body)).toEqual({
    _tag: "ModHello",
    protocolVersion: ProtocolVersion,
    sessionId: "s1",
    claudeSessionId: "0b6d6c1e-2f4a-4c3b-9d8e-7a6b5c4d3e2f",
    model: "claude-test",
    steers: true,
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

test("resultSummary shows a command's output", () => {
  expect(resultSummary("Bash", { stdout: "out", stderr: "err", interrupted: false })).toBe(
    "out\nerr",
  )
  expect(resultSummary("Write", { type: "create", filePath: "/workspace/a" })).toBe(
    '{"type":"create","filePath":"/workspace/a"}',
  )
})

test("backgroundedByStop is a command a Stop moved to the background, still running", () => {
  const result = { stdout: "", stderr: "", interrupted: false, backgroundTaskId: "b1" }
  expect(backgroundedByStop({ ...result, backgroundedByTurnAbort: true })).toBe(true)
  expect(backgroundedByStop({ ...result, backgroundedByUser: true })).toBe(false)
  expect(backgroundedByStop(result)).toBe(false)
  expect(backgroundedByStop("done")).toBe(false)
  expect(backgroundedByStop(null)).toBe(false)
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

test("the shared Session's note says where the model runs, and leaves `!` alone (ADR 0013)", () => {
  expect(sharedSessionNote).toContain(
    "You run in a sandbox VM where the repository is checked out.",
  )
  expect(sharedSessionNote).not.toContain("!")
})

const notification = [
  "<task-notification>",
  "<task-id>a1b2c3</task-id>",
  "<tool-use-id>toolu_1</tool-use-id>",
  "<status>completed</status>",
  "</task-notification>",
].join("\n")

test("taskNotificationAgent reads the agent from a task notification, and nothing else", () => {
  expect(taskNotificationAgent(notification)).toBe("a1b2c3")
  expect(taskNotificationAgent(`\n${notification}\nAlso: more`)).toBe("a1b2c3")
  expect(taskNotificationAgent("[Ada Lovelace] what is <task-id>x</task-id>?")).toBeUndefined()
  expect(taskNotificationAgent("<task-notification></task-notification>")).toBeUndefined()
})

test("a delivered prompt starts the next Turn with a prompt, but not an agent's notification", () => {
  const delivered = "[Ada Lovelace] fix it"
  expect(startsDelivered(delivered, delivered)).toBe(true)
  // Typed at the terminal while the prompt was on its way: Claude Code runs them in order.
  expect(startsDelivered("ls", delivered)).toBe(true)
  expect(startsDelivered("", delivered)).toBe(false)
  expect(startsDelivered(notification, delivered)).toBe(false)
  expect(startsDelivered(`${notification}\n${delivered}`, delivered)).toBe(true)
})

test("agentWorktree finds an agent's worktree and branch from where it starts", () => {
  expect(agentWorktree("/workspace/.claude/worktrees/agent-a1b2")).toEqual({
    path: "/workspace/.claude/worktrees/agent-a1b2",
    branch: "worktree-agent-a1b2",
  })
  expect(agentWorktree("/workspace/.claude/worktrees/agent-a1b2/")).toEqual({
    path: "/workspace/.claude/worktrees/agent-a1b2",
    branch: "worktree-agent-a1b2",
  })
  expect(agentWorktree("/workspace")).toBeUndefined()
  expect(agentWorktree("/workspace/.claude/worktrees/agent-a1b2/src")).toBeUndefined()
})

test("toolArguments drops the keys Claude Code adds beside a tool's own", () => {
  expect(
    toolArguments({
      tool: "Bash",
      tool_use_id: "toolu_1",
      agentId: "a1",
      consent: "yes",
      command: "ls",
      timeout: 5,
    }),
  ).toEqual({ command: "ls", timeout: 5 })
})

describe("AskUserQuestion (#193)", () => {
  const ada = { name: "Ada" }
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

  test("a Participant's answer, as Claude Code's dialog would give it", () => {
    expect(
      answerResult(asked, { _tag: "Answered", answers: { "Which library?": "Temporal" } }, ada),
    ).toEqual({
      result: { questions: asked, answers: { "Which library?": "Temporal" }, annotations: {} },
    })
    expect(answerResult(asked, { _tag: "Replied", text: "Neither, use Intl" }, ada)).toEqual({
      deny: `${repliedPrefix}[Ada] Neither, use Intl`,
    })
    expect(answerResult(asked, { _tag: "Dismissed" }, ada)).toEqual({ deny: dismissedText })
  })

  test("how one answered at the terminal closed", () => {
    expect(
      terminalOutcome({
        result: { questions: asked, answers: { "Which library?": "date-fns" }, annotations: {} },
      }),
    ).toEqual({ _tag: "Answered", answers: { "Which library?": "date-fns" } })
    expect(terminalOutcome({ result: { questions: asked, answers: {} } })).toEqual({
      _tag: "Answered",
      answers: {},
    })
    expect(terminalOutcome({ deny: `${repliedPrefix}Ask me later` })).toEqual({
      _tag: "Replied",
      text: "Ask me later",
    })
    expect(terminalOutcome({ deny: dismissedText })).toEqual({ _tag: "Dismissed" })
    expect(terminalOutcome({ isError: true, result: "Interrupted" })).toEqual({
      _tag: "Dismissed",
    })
  })

  test("a dialog that timed out on its own was answered by nobody (#206)", () => {
    expect(
      terminalOutcome({ result: { questions: asked, answers: {}, afkTimeoutMs: 60_000 } }),
    ).toEqual({ _tag: "Cancelled" })
    // What was chosen before it timed out is what Claude reads.
    expect(
      terminalOutcome({
        result: {
          questions: asked,
          answers: { "Which library?": "date-fns" },
          afkTimeoutMs: 60_000,
        },
      }),
    ).toEqual({ _tag: "Answered", answers: { "Which library?": "date-fns" } })
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
    const context = attachmentContext([shot, photo])
    expect(context).toContain("2 images")
    expect(context).toContain(attachmentToolName)
    expect(context).toContain("Image #1 shot.png: id att-1")
    expect(context).toContain("Image #2 photo.jpg: id att-2")
    expect(attachmentToolName).toBe("mcp__hub-link-commands__attachment")
  })

  test("a PDF is marked and counted as one, numbered apart from the images (#277)", () => {
    const spec = { id: "att-3", name: "spec.pdf", mediaType: "application/pdf" as const, size: 56 }
    expect(deliveredPrompt(participant, "read it", [shot, spec])).toBe(
      "[Ada Lovelace] read it\n[Image #1: shot.png (attachment att-1)]\n[PDF #1: spec.pdf (attachment att-3)]",
    )
    const context = attachmentContext([shot, spec])
    expect(context).toContain("1 image and 1 PDF")
    expect(context).toContain("Image #1 shot.png: id att-1; PDF #1 spec.pdf: id att-3")
  })

  test("the tool hands Claude a PDF the Hub sent as a document block, titled with its name (#277)", () => {
    const part = (data: string, next?: number) => {
      const read = attachmentPart(
        200,
        JSON.stringify({ id: "att-3", name: "spec.pdf", mediaType: "application/pdf", data, next }),
      )
      if ("deny" in read) throw new Error(read.deny)
      return read.part
    }
    expect(attachmentResult([part("JVBE", 3), part("Ri0x")])).toEqual({
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

  test("the transcript shows the tool's image as a note, not its bytes", () => {
    const blocks = [
      { type: "text", text: "shot.png" },
      {
        type: "image",
        source: { type: "base64", media_type: "image/png", data: "A".repeat(9_000) },
      },
    ]
    expect(resultSummary(attachmentToolName, blocks)).toBe("shot.png\n[image/png]")
  })

  test("the model is told what a marker is", () => {
    expect(sharedSessionNote).toContain("[Image #1: name (attachment id)]")
    expect(sharedSessionNote).toContain("[PDF #1: name (attachment id)]")
    expect(sharedSessionNote).toContain(attachmentToolName)
  })
})
