// What the fake Hub knows and plays: two Runners, a few Sessions with some history, and the
// Turns it streams. All made up; the people are Alice (you) and Bob.

import type {
  ParticipantWire,
  RunnerSummaryWire,
  SessionEventWire,
  SessionSummaryWire,
} from "./wire.ts"

export const you: ParticipantWire = { id: "u-alice", login: "alice", name: "Alice Kim" }
export const bob: ParticipantWire = { id: "u-bob", login: "bob", name: "Bob Lee" }

export const demoSessionId = "s-demo"

/** One thing a scripted Turn does. Steps with an `agentId` are a subagent's. */
export type ReplyStep =
  | { readonly kind: "text"; readonly text: string; readonly agentId?: string }
  | {
      readonly kind: "tool"
      readonly tool: string
      readonly input: Readonly<Record<string, unknown>>
      readonly output: string
      readonly outcome?: "Succeeded" | "Failed" | "Denied"
      readonly agentId?: string
      /** How many steps the tool runs for. Default 4. */
      readonly steps?: number
      /** What a subagent does while this tool call (its Task) runs. */
      readonly during?: ReadonlyArray<ReplyStep>
    }
  | { readonly kind: "agentEnd"; readonly agentId: string }
  /** Someone else queues a prompt while the Turn runs. */
  | { readonly kind: "queue"; readonly sender: ParticipantWire; readonly text: string }
  | { readonly kind: "pause"; readonly steps: number }

export function seedRunners(): Array<RunnerSummaryWire> {
  return [
    { id: "r-studio", name: "studio", login: { account: "alice@example.com" }, isOnline: true },
    { id: "r-ci", name: "ci-box", login: { account: "ci@example.com" }, isOnline: false },
  ]
}

interface SeedSession {
  readonly summary: SessionSummaryWire
  /** When its history starts. */
  readonly at: number
  readonly events: ReadonlyArray<SessionEventWire>
}

const hour = 3_600_000

export function seedSessions(now = Date.now()): Array<SeedSession> {
  const studio = { runnerId: "r-studio", runnerLogin: { account: "alice@example.com" } }
  return [
    {
      summary: {
        id: demoSessionId,
        repo: "kddige/claude-hub",
        baseBranch: "main",
        workBranch: "claude/web-client",
        state: "Active",
        ...studio,
        creator: you,
        createdAt: now - 2 * hour,
        currentTurn: null,
      },
      at: now - 2 * hour,
      events: [
        ...turn("t-seed-1", you, "Add a test that the web client reconnects after a drop", [
          {
            _tag: "TextDelta",
            text: "I'll start by reading the client to see how it handles a closed socket.",
          },
          tool(
            "Read",
            { file_path: "packages/web/src/hub/client.ts" },
            "export class HubClient {\n  …\n}",
          ),
          tool(
            "Bash",
            { command: "bun test packages/web", description: "Run the web tests" },
            " 52 pass\n 0 fail\nRan 52 tests across 5 files. [612.00ms]",
          ),
          {
            _tag: "TextDelta",
            text: "Added `reconnects with afterSeq` to **client.test.ts**. It drops the socket mid-Turn and checks that:\n\n1. the client says hello again,\n2. it joins with the last `seq` it has, and\n3. no entry shows twice.\n\nAll tests pass.",
          },
        ]),
      ],
    },
    {
      summary: {
        id: "s-readme",
        repo: "kddige/claude-hub",
        baseBranch: "main",
        workBranch: "claude/readme-run",
        state: "Asleep",
        ...studio,
        creator: bob,
        createdAt: now - 26 * hour,
        currentTurn: null,
      },
      at: now - 26 * hour,
      events: [
        ...turn("t-seed-2", bob, "Document how to run the web UI against the fake Hub", [
          {
            _tag: "TextDelta",
            text: "Added a **Run** row to the README: `VITE_FAKE_HUB=1 bun run web`.",
          },
        ]),
        { _tag: "SessionStateChanged", state: "Asleep", message: "Idle for 15m" },
      ],
    },
    {
      summary: {
        id: "s-dotfiles",
        repo: "kddige/dotfiles",
        baseBranch: "main",
        workBranch: "claude/zsh-prompt",
        state: "Frozen",
        runnerId: "r-ci",
        runnerLogin: { account: "ci@example.com" },
        creator: you,
        createdAt: now - 50 * hour,
        currentTurn: null,
      },
      at: now - 50 * hour,
      events: [
        ...turn("t-seed-3", you, "Make the zsh prompt show the git branch", [
          { _tag: "TextDelta", text: "Done: the prompt now ends with the branch in brackets." },
        ]),
        { _tag: "SessionStateChanged", state: "Frozen", message: "ci-box went offline" },
      ],
    },
  ]
}

/** A finished Turn, for seeding history. */
function turn(
  turnId: string,
  sender: ParticipantWire,
  prompt: string,
  body: ReadonlyArray<
    | { _tag: "TextDelta"; text: string }
    | { _tag: "Tool"; tool: string; input: string; output: string }
  >,
): Array<SessionEventWire> {
  const events: Array<SessionEventWire> = [
    {
      _tag: "TurnStarted",
      turnId,
      text: `[${sender.name}] ${prompt}`,
      sender: { _tag: "FromParticipant", participant: sender },
    },
  ]
  let count = 0
  for (const part of body) {
    if (part._tag === "TextDelta") {
      events.push({ _tag: "TextDelta", turnId, text: part.text })
      continue
    }
    const toolCallId = `${turnId}-tool-${++count}`
    events.push(
      { _tag: "ToolCallStarted", turnId, toolCallId, tool: part.tool, input: part.input },
      {
        _tag: "ToolCallEnded",
        turnId,
        toolCallId,
        tool: part.tool,
        outcome: "Succeeded",
        output: part.output,
      },
    )
  }
  events.push({
    _tag: "TurnEnded",
    turnId,
    reason: "Answered",
    durationMs: 18_400,
    usage: {
      model: "claude-opus-4-1",
      inputTokens: 3_100,
      outputTokens: 420,
      cacheReadInputTokens: 22_000,
      cacheCreationInputTokens: 1_200,
    },
  })
  return events
}

function tool(
  name: string,
  input: Record<string, unknown>,
  output: string,
): { _tag: "Tool"; tool: string; input: string; output: string } {
  return { _tag: "Tool", tool: name, input: JSON.stringify(input), output }
}

/** The demo's live Turn: Bob asks, Claude streams, a subagent explores, Bob queues another. */
export const scriptedTurn: ReadonlyArray<ReplyStep> = [
  { kind: "text", text: "Sure. First I'll look at how the chat renders tool calls today." },
  {
    kind: "tool",
    tool: "Grep",
    input: { pattern: "ToolCall", path: "packages/web/src" },
    output:
      "packages/web/src/session/ToolCall.tsx\npackages/web/src/hub/transcript.ts\npackages/web/src/session/Transcript.tsx",
  },
  {
    kind: "tool",
    tool: "Task",
    input: {
      description: "Survey the UI kit",
      prompt: "List the kit components that can collapse content, and how they're styled.",
    },
    output: "The kit has Disclosure for collapsible rows; it's styled with the shared tokens.",
    steps: 3,
    during: [
      { kind: "text", agentId: "agent-kit", text: "Looking through the kit's components." },
      {
        kind: "tool",
        agentId: "agent-kit",
        tool: "Glob",
        input: { pattern: "packages/web/src/ui/*.tsx" },
        output: "Avatar.tsx\nBadge.tsx\nButton.tsx\nDialog.tsx\nDisclosure.tsx\n…",
        steps: 2,
      },
      {
        kind: "tool",
        agentId: "agent-kit",
        tool: "Read",
        input: { file_path: "packages/web/src/ui/Disclosure.tsx" },
        output: "export function Disclosure({ summary, children, defaultOpen = false }) { … }",
        steps: 2,
      },
      {
        kind: "text",
        agentId: "agent-kit",
        text: "Disclosure is the one: closed by default, with a summary row.",
      },
      { kind: "agentEnd", agentId: "agent-kit" },
    ],
  },
  { kind: "queue", sender: bob, text: "Then add a line about it to the README" },
  {
    kind: "tool",
    tool: "Edit",
    input: {
      file_path: "packages/web/src/session/ToolCall.tsx",
      old_string: "defaultOpen",
      new_string: "defaultOpen={false}",
    },
    output: "The file packages/web/src/session/ToolCall.tsx has been updated.",
  },
  {
    kind: "tool",
    tool: "Bash",
    input: { command: "git push --force", description: "Push the branch" },
    outcome: "Denied",
    output: "Denied: git remote operations run as host tools (ADR 0005).",
    steps: 1,
  },
  {
    kind: "tool",
    tool: "Bash",
    input: { command: "bun test packages/web", description: "Run the web tests" },
    output: " 58 pass\n 0 fail",
    steps: 6,
  },
  {
    kind: "text",
    text: "\n\nTool calls now start **collapsed**. Each one shows:\n\n- the tool's name,\n- a one-line summary of its input, such as the command, and\n- whether it succeeded.\n\nOpen one to see its full input and output:\n\n```ts\n<Disclosure summary={<ToolSummary call={call} />}>\n  <ToolDetails call={call} />\n</Disclosure>\n```\n\nThe tests pass.",
  },
]

/** A short reply to any prompt someone types. */
export function replyTo(text: string): ReadonlyArray<ReplyStep> {
  const quoted = text.length > 60 ? `${text.slice(0, 57)}…` : text
  return [
    { kind: "text", text: `On it: "${quoted}". Let me check the repo first.` },
    {
      kind: "tool",
      tool: "Bash",
      input: { command: "git status --short", description: "Show what's changed" },
      output: " M packages/web/src/session/Transcript.tsx",
      steps: 3,
    },
    {
      kind: "text",
      text: "\n\nThat's done. In a real Session this is where Claude's answer streams in.",
    },
  ]
}
