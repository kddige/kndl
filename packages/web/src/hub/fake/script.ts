// What the fake Hub knows and plays: two Runners, one behind the Hub's commit, a few Sessions with some history, and the
// Turns it streams. All made up; the people are Alice (you) and Bob. One Session is a Parent
// Session with two Child Sessions, and gets their Reports (ADR 0012).

import type {
  AppPermissionsCheckWire,
  FromSessionWire,
  ParticipantWire,
  RunnerSummaryWire,
  SessionEventWire,
  SessionSummaryWire,
} from "./wire.ts"

export const you: ParticipantWire = { id: "u-alice", login: "alice", name: "Alice Kim" }
export const bob: ParticipantWire = { id: "u-bob", login: "bob", name: "Bob Lee" }

export const demoSessionId = "s-demo"
/** The Parent Session, and its two Child Sessions. */
export const releaseSessionId = "s-release"
export const apiDocsSessionId = "s-api-docs"
export const changelogSessionId = "s-changelog"

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
  /**
   * Someone else queues a prompt while the Turn runs. With `fromSession` it's another Session's,
   * `text` with the Hub's note, and `sender` the Session's Creator.
   */
  | {
      readonly kind: "queue"
      readonly sender: ParticipantWire
      readonly text: string
      readonly fromSession?: FromSessionWire
    }
  | { readonly kind: "pause"; readonly steps: number }

/** The commit the fake Hub runs. */
export const hubVersion = { commit: "824de4a1f0c3b6e2d9a7c5b48e1f02a3c6d7e9b1", branch: "main" }

/** The Runners paired with the fake Hub; their `openSessions` is counted from the Sessions. */
export function seedRunners(): Array<RunnerSummaryWire> {
  const now = Date.now()
  return [
    {
      id: "r-studio",
      name: "studio",
      login: { account: "alice@example.com" },
      isOnline: true,
      version: hubVersion,
      versionStatus: "Current",
      lastSeenAt: now,
      openSessions: 0,
      updater: { self: true },
    },
    {
      id: "r-ci",
      name: "ci-box",
      login: { account: "ci@example.com" },
      isOnline: false,
      version: { commit: "5d2b9e07c41a8f3362e0d9b7a1c4f58e2b6d0a93", branch: "main" },
      versionStatus: "Behind",
      lastSeenAt: now - 3 * 60 * 60 * 1000,
      openSessions: 0,
      updater: { self: true },
    },
  ]
}

interface SeedSession {
  readonly summary: SessionSummaryWire
  /** When its history starts. */
  readonly at: number
  readonly events: ReadonlyArray<SessionEventWire>
}

const hour = 3_600_000
const day = 24 * hour
/** How long the Hub keeps an Archived Session restorable, by default. */
export const archiveRetentionMs = 30 * day

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
        // Started before Alice applied version 2: it shows "Environment changed".
        environment: { version: 1, latestVersion: 2 },
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
        environment: { version: 1, latestVersion: 2 },
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
    {
      summary: {
        id: "s-flaky",
        repo: "kddige/claude-hub",
        baseBranch: "main",
        workBranch: "claude/flaky-login",
        state: "Archived",
        ...studio,
        creator: you,
        createdAt: now - 5 * day,
        currentTurn: null,
        environment: { version: 1, latestVersion: 2 },
        archived: { by: bob, at: now - 3 * day, purgeAt: now + 27 * day },
      },
      at: now - 5 * day,
      events: [
        ...turn("t-seed-4", you, "Fix the flaky login test", [
          { _tag: "TextDelta", text: "It raced the cookie being set: it now waits for it." },
        ]),
        { _tag: "SessionStateChanged", state: "Archived", by: bob },
      ],
    },
    ...releaseSessions(now),
  ]
}

const release = { id: releaseSessionId, title: "Release 0.4" }
const apiDocs = { id: apiDocsSessionId, title: "API docs" }
const changelog = { id: changelogSessionId, title: "Changelog" }

/** A Report as the Hub queues it for the Parent Session: its note, then the child's message. */
export function reportText(child: { id: string; title: string }, message: string): string {
  return [
    `[Report from Child Session "${child.title}" (${child.id})]`,
    "This is a Report, not a prompt from a person: the final message of a Turn your Child Session just ended. The people in this Session don't see Reports, so relay what matters to them. More Reports may follow while it works.",
    "",
    message,
  ].join("\n")
}

/** A Child Session's message, sent mid-Turn, as the Hub queues it for the Parent Session. */
export function childMessageText(child: { id: string; title: string }, message: string): string {
  return [
    `[Message from Child Session "${child.title}" (${child.id})]`,
    "This is a message your Child Session sent while it works, not a prompt from a person and not a Report: its Report still comes when its Turn ends. The people in this Session don't see it, so relay what matters to them. To answer it, use message_child; it reads your answer once its current Turn ends.",
    "",
    message,
  ].join("\n")
}

/** What API docs asks Release 0.4 while it works. */
const apiDocsQuestion =
  "Should the reference cover the deprecated v0 messages too, or only what 0.4 speaks? I'm going on with the Mod messages meanwhile."

/** A message from the Parent Session as the Hub queues it for the child. */
function parentMessageText(text: string): string {
  return `[Message from your Parent Session "${release.title}" (${release.id})]\n\n${text}`
}

/**
 * Release 0.4 hands the docs and the changelog to two Child Sessions. API docs messages it a
 * question mid-Turn, and Changelog reports.
 */
function releaseSessions(now: number): Array<SeedSession> {
  const studio = { runnerId: "r-studio", runnerLogin: { account: "alice@example.com" } }
  const at = now - 40 * 60_000
  const environment = { version: 2, latestVersion: 2 }
  const created = (child: { id: string; title: string }, task: string) =>
    tool(
      "mcp__hub-link__create_child",
      { task, name: child.title },
      `Created Child Session "${child.title}" (id ${child.id}): Active, idle; Work branch claude/${child.id.slice(2)}, from main`,
    )
  return [
    {
      summary: {
        id: releaseSessionId,
        name: release.title,
        repo: "kddige/claude-hub",
        baseBranch: "main",
        workBranch: "claude/release-0-4",
        state: "Active",
        ...studio,
        creator: you,
        createdAt: at,
        currentTurn: null,
        environment,
      },
      at,
      events: [
        ...turn("t-release-1", you, "Get 0.4 ready: the API docs and the changelog", [
          {
            _tag: "TextDelta",
            text: "These two don't touch each other, so I'll hand each to a Child Session and keep an eye on them.",
          },
          created(apiDocs, "Document every message in packages/protocol for the 0.4 reference."),
          created(changelog, "Write the 0.4 changelog from the merged pull requests since 0.3."),
          {
            _tag: "TextDelta",
            text: "Both are working. They report back when each Turn ends; I'll tell you what they find.",
          },
        ]),
        ...sessionTurn(
          "t-release-msg",
          { _tag: "FromChildSessionMessage", session: apiDocs },
          childMessageText(apiDocs, apiDocsQuestion),
          [
            tool(
              "mcp__hub-link__message_child",
              { child_id: apiDocsSessionId, message: "Only what 0.4 speaks: leave v0 out." },
              `Queued your message for Child Session "API docs" (id ${apiDocsSessionId}): Active, working, 1 queued; Work branch claude/api-docs, from main\nIt reads it once its current Turn ends. Its answer arrives here as a Report.`,
            ),
            {
              _tag: "TextDelta",
              text: "**API docs** asked whether to document the deprecated v0 messages. I told it to cover only what 0.4 speaks; say if you want v0 in too.",
            },
          ],
        ),
        ...sessionTurn(
          "t-release-2",
          { _tag: "FromChildSession", session: changelog },
          reportText(
            changelog,
            "The changelog is in CHANGELOG.md: 14 entries, grouped by package.",
          ),
          [
            {
              _tag: "TextDelta",
              text: "**Changelog** is done: 14 entries in CHANGELOG.md, grouped by package. API docs is still working.",
            },
          ],
        ),
      ],
    },
    {
      summary: {
        id: apiDocsSessionId,
        name: apiDocs.title,
        repo: "kddige/claude-hub",
        baseBranch: "main",
        workBranch: "claude/api-docs",
        state: "Active",
        ...studio,
        creator: you,
        createdAt: at + 60_000,
        currentTurn: null,
        environment,
        parentId: releaseSessionId,
      },
      at: at + 60_000,
      events: [
        ...sessionTurn(
          "t-api-1",
          { _tag: "FromParentSession", session: release },
          parentMessageText("Document every message in packages/protocol for the 0.4 reference."),
          [
            tool(
              "Glob",
              { pattern: "packages/protocol/src/*.ts" },
              "Hub.ts\nMod.ts\nRunner.ts\nSession.ts\nTurn.ts\nWeb.ts",
            ),
            tool(
              "mcp__hub-link__message_parent",
              { message: apiDocsQuestion },
              `Queued your message for your Parent Session "${release.title}" (id ${release.id}). It reads it as soon as it is ready. Any answer reaches you as a prompt after this Turn ends, and your Report still goes to it then.`,
            ),
            {
              _tag: "TextDelta",
              text: "I've drafted the Web and Runner messages in the reference. Mod and Turn are next.",
            },
          ],
        ),
        ...sessionTurn(
          "t-api-2",
          { _tag: "FromParentSession", session: release },
          parentMessageText("Only what 0.4 speaks: leave v0 out."),
          [{ _tag: "TextDelta", text: "Understood: v0 stays out. On to Mod and Turn." }],
        ),
      ],
    },
    {
      summary: {
        id: changelogSessionId,
        name: changelog.title,
        repo: "kddige/claude-hub",
        baseBranch: "main",
        workBranch: "claude/changelog",
        state: "Asleep",
        ...studio,
        creator: you,
        createdAt: at + 2 * 60_000,
        currentTurn: null,
        environment,
        parentId: releaseSessionId,
      },
      at: at + 2 * 60_000,
      events: [
        ...sessionTurn(
          "t-changelog-1",
          { _tag: "FromParentSession", session: release },
          parentMessageText("Write the 0.4 changelog from the merged pull requests since 0.3."),
          [
            {
              _tag: "TextDelta",
              text: "The changelog is in CHANGELOG.md: 14 entries, grouped by package.",
            },
          ],
        ),
        { _tag: "SessionStateChanged", state: "Asleep", message: "Idle for 15m" },
      ],
    },
  ]
}

/** API docs' next Report, which wakes Release 0.4; Changelog's follows while it's answered. */
export const releaseReport = {
  from: apiDocs,
  text: reportText(
    apiDocs,
    "The reference covers every protocol message now, Mod and Turn included.",
  ),
}

export const releaseReply: ReadonlyArray<ReplyStep> = [
  {
    kind: "tool",
    tool: "mcp__hub-link__read_child",
    input: { child_id: apiDocsSessionId },
    output: `"API docs" (id ${apiDocsSessionId}): Active, idle; Work branch claude/api-docs, from main`,
    steps: 3,
  },
  {
    kind: "queue",
    sender: you,
    text: reportText(changelog, "I added the two fixes merged this morning to CHANGELOG.md."),
    fromSession: { _tag: "FromChildSession", session: changelog },
  },
  { kind: "pause", steps: 30 },
  {
    kind: "text",
    text: "**API docs** is done: the reference now covers every protocol message. Both Child Sessions have finished, so 0.4 is ready to review.",
  },
]

type TurnBody = ReadonlyArray<
  | { _tag: "TextDelta"; text: string }
  | { _tag: "Tool"; tool: string; input: string; output: string }
>

/** A finished Turn a person prompted, for seeding history. */
function turn(
  turnId: string,
  sender: ParticipantWire,
  prompt: string,
  body: TurnBody,
): Array<SessionEventWire> {
  return sessionTurn(
    turnId,
    { _tag: "FromParticipant", participant: sender },
    `[${sender.name}] ${prompt}`,
    body,
  )
}

/** A finished Turn, for seeding history: `text` is the prompt as the model got it. */
function sessionTurn(
  turnId: string,
  sender: Extract<SessionEventWire, { _tag: "TurnStarted" }>["sender"],
  text: string,
  body: TurnBody,
): Array<SessionEventWire> {
  const events: Array<SessionEventWire> = [{ _tag: "TurnStarted", turnId, text, sender }]
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

/**
 * A permission check that found the GitHub App short of Issues, and its installation on acme
 * behind on Pull requests too: for the banner, in tests and from the console.
 */
export function driftedAppPermissions(now = Date.now()): AppPermissionsCheckWire {
  return {
    slug: "claude-hub-alice",
    settingsUrl: "https://github.com/settings/apps/claude-hub-alice/permissions",
    installUrl: "https://github.com/apps/claude-hub-alice/installations/new",
    missing: [{ name: "issues", title: "Issues", access: "write" }],
    missingEvents: [],
    installed: 2,
    installations: [
      {
        id: 42,
        account: "acme",
        reviewUrl:
          "https://github.com/organizations/acme/settings/installations/42/permissions/update",
        missing: [
          { name: "pull_requests", title: "Pull requests", access: "write" },
          { name: "issues", title: "Issues", access: "write" },
        ],
        missingEvents: [],
      },
    ],
    checkedAt: now,
  }
}
