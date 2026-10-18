// What the fake Hub knows and plays: two Runners, one behind the Hub's commit, a few Sessions with
// some history, and the Turns it streams. All made up; the people are Alice (you) and Bob. Only a
// Session's Creator drives it (ADR 0026): Alice drives hers, and watches Bob's, which has a prompt
// of hers that the Hub cancelled. The demo's Turn starts a subagent in the foreground and one in the
// background that outlives it, and Release 0.4 has subagents that finished, were stopped and were
// interrupted (ADR 0014). The demo has dev servers listening in its Sandbox: a Docker one, and one
// on `::1` only (#175). A prompt that says "ask me" gets a question to answer (#193).

import type {
  AppPermissionsCheckWire,
  BuildVersionWire,
  ClaudeCredentialInfoWire,
  CliTokenInfoWire,
  HubUpdateStateWire,
  MemberWire,
  OpenPortWire,
  ParticipantWire,
  PendingInviteWire,
  QuestionPickWire,
  QuestionWire,
  RunnerSummaryWire,
  SessionEventWire,
  SessionSummaryWire,
} from "./wire.ts"

export const you: ParticipantWire = { id: "u-alice", login: "alice", name: "Alice Kim" }
export const bob: ParticipantWire = { id: "u-bob", login: "bob", name: "Bob Lee" }

export const demoSessionId = "s-demo"
/** Bob's Session, which Alice watches (ADR 0026). */
export const bobsSessionId = "s-landing"
/** A Session whose subagents finished, were stopped and were interrupted. */
export const releaseSessionId = "s-release"

/** Alice's setup token (ADR 0026), as the Hub shows it: she added it a month ago. */
export function seedClaudeCredential(now = Date.now()): ClaudeCredentialInfoWire {
  return { kind: "OAuthToken", last4: "x7Qa", addedAt: now - 30 * 24 * 3_600_000 }
}

/** One thing a scripted Turn, or a subagent's run, does. */
export type ReplyStep =
  | { readonly kind: "text"; readonly text: string }
  | {
      readonly kind: "tool"
      readonly tool: string
      readonly input: Readonly<Record<string, unknown>>
      readonly output: string
      readonly outcome?: "Succeeded" | "Failed" | "Denied"
      /** How many steps the tool runs for. Default 4. */
      readonly steps?: number
    }
  /** The Agent tool starts a subagent, which does `steps` and answers `result`. */
  | {
      readonly kind: "agent"
      readonly agentId: string
      readonly agentType: string
      readonly description: string
      readonly prompt: string
      readonly model: string
      /**
       * It runs on its own while the Turn goes on, past its end, and when done Claude Code starts
       * a Turn from it, which says `relay`.
       */
      readonly background?: boolean
      readonly worktree?: { readonly path: string; readonly branch: string }
      readonly steps: ReadonlyArray<ReplyStep>
      readonly result: string
      readonly relay?: string
    }
  /** The Creator queues a prompt while the Turn runs, as from another tab. */
  | { readonly kind: "queue"; readonly sender: ParticipantWire; readonly text: string }
  | { readonly kind: "pause"; readonly steps: number }
  /**
   * Claude asks with AskUserQuestion on the main loop (#193), and the Turn waits for an answer.
   * `pick` is the Creator's pick from another tab, shared a few steps in.
   */
  | {
      readonly kind: "question"
      readonly questions: ReadonlyArray<QuestionWire>
      readonly pick?: QuestionPickWire
    }

/**
 * Claude Code's prompt to itself when a background agent is done, which starts a Turn from the
 * agent (ADR 0014), as Claude Code 2.1.289 writes it.
 */
export function taskNotification(agentId: string, description: string, result: string): string {
  return [
    "<task-notification>",
    `<task-id>${agentId}</task-id>`,
    `<tool-use-id>toolu_${agentId}</tool-use-id>`,
    `<output-file>/tmp/claude-0/-workspace/tasks/${agentId}.output</output-file>`,
    "<status>completed</status>",
    `<summary>Agent "${description}" finished</summary>`,
    "<note>A task-notification fires each time this agent stops with no live background children of its own. The user can send it another message and resume it, so the same task-id may notify more than once.</note>",
    `<result>${result}</result>`,
    "<usage><subagent_tokens>12388</subagent_tokens><tool_uses>3</tool_uses><duration_ms>17036</duration_ms></usage>",
    "</task-notification>",
  ].join("\n")
}

/** The CLI tokens the signed-in person has, as `kndl login` on two machines left them. */
export function seedCliTokens(): Array<CliTokenInfoWire> {
  const now = Date.now()
  return [
    {
      id: "ct-laptop",
      machine: "alices-laptop",
      createdAt: now - 3 * 86_400_000,
      lastUsedAt: now - 4 * 60_000,
    },
    { id: "ct-devbox", machine: "devbox", createdAt: now - 40 * 86_400_000 },
  ]
}

/** The kndl a Hub on the stable Channel runs: the Release on `hubVersion`'s commit. */
export const stableHubVersion: BuildVersionWire = {
  commit: "824de4a1f0c3b6e2d9a7c5b48e1f02a3c6d7e9b1",
  release: "2026.10.2",
  channel: "stable",
}

/** A Release's notes, as `scripts/release.ts` writes them: its Highlights, then its changes by area. */
const notes = (highlights: string, areas: string) =>
  `## Highlights\n\n${highlights}\n\n${areas}\n\n**Changes since the Release before**`

/**
 * What the update check of a Hub on `stableHubVersion` found an hour ago (ADR 0028): two newer
 * Releases, with notes as `scripts/release.ts` writes them, Highlights first.
 */
export function seedHubUpdate(): HubUpdateStateWire {
  const now = Date.now()
  return {
    follows: { _tag: "Channel", channel: "stable" },
    checked: {
      at: now - 3_600_000,
      found: {
        _tag: "NewerRelease",
        releases: [
          {
            version: "2026.10.4",
            notes: notes(
              "- **Archived Sessions show the disk they take.** The archive list says how much of each Runner's disk an Archived Session holds, so you know what purging frees.",
              "## hub\n\n- hub, web: the archive list shows how much Runner disk each Archived Session takes (#352)\n\n## web\n\n- web: a Runner's Monitor opens under its row (#356)",
            ),
            url: "https://github.com/kddige/kndl/releases/tag/v2026.10.4",
            publishedAt: now - 2 * 86_400_000,
          },
          {
            version: "2026.10.3",
            notes: notes(
              "- **Anyone who sees an Archived Session can purge it.** Before, only its Creator could, and a Runner low on disk waited on them.",
              "## hub\n\n- hub, web: anyone who sees an Archived Session can purge it (#351)",
            ),
            url: "https://github.com/kddige/kndl/releases/tag/v2026.10.3",
            publishedAt: now - 5 * 86_400_000,
          },
        ],
        compareUrl: "https://github.com/kddige/kndl/compare/v2026.10.2...v2026.10.4",
      },
    },
  }
}

/** The Hub's Members (#209): Alice, its Owner, and Bob, whom she invited. */
export function seedMembers(): Array<MemberWire> {
  const now = Date.now()
  return [
    { participant: you, owner: true, admittedAt: now - 60 * 86_400_000 },
    { participant: bob, owner: false, admittedAt: now - 12 * 86_400_000 },
  ]
}

/** The Invites not used yet: one Alice made for Carol two days ago. */
export function seedInvites(): Array<PendingInviteWire> {
  const now = Date.now()
  return [
    {
      id: "inv-carol",
      login: "carol-dev",
      createdBy: you,
      createdAt: now - 2 * 86_400_000,
      expiresAt: now + 5 * 86_400_000,
    },
  ]
}

/** The commit the fake Hub runs. */
export const hubVersion = { commit: "824de4a1f0c3b6e2d9a7c5b48e1f02a3c6d7e9b1", branch: "main" }

/**
 * What the fake Runners' Claude Code has (#128), as a Runner on Claude Code 2.1.289 said it in its
 * hello. Kept from that build, whose Haiku 4.5 takes no thinking level, so the UI shows a model that
 * takes none; the pinned build's are PinnedClaudeModels (packages/runner/src/ClaudeModels.ts).
 */
export const fakeModels: NonNullable<RunnerSummaryWire["models"]> = {
  default: {
    alias: "default",
    id: "claude-opus-5-5",
    label: "Opus 5.5",
    description: "Best for everyday, complex tasks",
    reasoning: true,
  },
  models: [
    {
      alias: "opus",
      id: "claude-opus-5-5",
      label: "Opus 5.5",
      description: "Best for everyday, complex tasks",
      reasoning: true,
    },
    {
      alias: "fable",
      id: "claude-fable-5-1",
      label: "Fable 5.1",
      description: "Most capable for your hardest and longest-running tasks",
      reasoning: true,
    },
    {
      alias: "sonnet",
      id: "claude-sonnet-5-5",
      label: "Sonnet 5.5",
      description: "Efficient for routine tasks",
      reasoning: true,
    },
    {
      alias: "haiku",
      id: "claude-haiku-4-5-20251001",
      label: "Haiku 4.5",
      description: "Fastest for quick answers",
      reasoning: false,
    },
    {
      alias: "opus[1m]",
      id: "claude-opus-5-5[1m]",
      label: "Opus 5.5 (1M context)",
      description: "Opus with a 1M-token context, for long sessions",
      reasoning: true,
    },
  ],
  thinkingLevels: ["low", "medium", "high", "xhigh", "max"],
}

const GiB = 1024 ** 3

/** What a Runner's host looked like at `at` (#350): `diskFreeGiB` free of `diskTotalGiB`. */
function fakeSysinfo(
  at: number,
  disk: { readonly freeGiB: number; readonly totalGiB: number },
  more: Partial<NonNullable<RunnerSummaryWire["sysinfo"]>> = {},
): NonNullable<RunnerSummaryWire["sysinfo"]> {
  return {
    diskFreeBytes: disk.freeGiB * GiB,
    diskTotalBytes: disk.totalGiB * GiB,
    memoryTotalBytes: 32 * GiB,
    memoryAvailableBytes: 19 * GiB,
    cpuCores: 10,
    loadAverage: [1.42, 1.18, 0.96],
    os: "linux",
    arch: "arm64",
    uptimeSeconds: 12 * 24 * 3600 + 5 * 3600,
    at,
    ...more,
  }
}

/** A point of a Runner's history (#356), as the Hub sends it. */
type FakeHistoryPoint = {
  at: number
  diskFreeBytes: number
  memoryAvailableBytes: number
  load1: number
}

/**
 * A Runner's history as the Hub would keep it (#350, #356): a point every 5 minutes for a week,
 * ending at its sample's. The free disk drains, with a clean-up now and then; memory and load
 * follow the working day, with a busy spell two days ago. Made up, but the same on every call.
 */
export function fakeRunnerHistory(
  sysinfo: RunnerSummaryWire["sysinfo"],
  now = Date.now(),
): Array<FakeHistoryPoint> {
  if (sysinfo === undefined) return []
  const step = 5 * 60_000
  const points: Array<FakeHistoryPoint> = []
  const end = Math.min(now, sysinfo.at)
  const start = end - 7 * day
  for (let at = start; at <= end; at += step) {
    // Six GiB lost a day, except for a clean-up of old Sandboxes four days in, which freed 38.
    const days = (at - start) / day
    const freeGiB = days < 4 ? 6 * (4 - days) - 20 : 6 * (7 - days)
    const diskFreeBytes = sysinfo.diskFreeBytes + Math.round(freeGiB * GiB)
    // Days before the sample: every wave below is zero at it, so the last point is the sample.
    const ago = (end - at) / day
    const daily = Math.sin(2 * Math.PI * ago)
    const jitter = Math.sin(9 * ago) * Math.sin(4 * ago) + 0.25 * Math.sin(29 * ago)
    const busy = Math.exp(-(((ago - 2) / 0.18) ** 2))
    const memory =
      sysinfo.memoryAvailableBytes / GiB +
      ((0.12 * sysinfo.memoryTotalBytes) / GiB) * (daily + 0.5 * jitter - 2.5 * busy)
    const load =
      sysinfo.loadAverage[0] + 0.35 * sysinfo.cpuCores * (0.25 * daily + 0.12 * jitter + 0.6 * busy)
    points.push({
      at,
      diskFreeBytes: Math.max(0, diskFreeBytes),
      memoryAvailableBytes: Math.round(
        Math.min(sysinfo.memoryTotalBytes, Math.max(0.05 * sysinfo.memoryTotalBytes, memory * GiB)),
      ),
      load1: Math.round(Math.max(0.02, load) * 100) / 100,
    })
  }
  return points
}

/** The Runners paired with the fake Hub; their `openSessions` is counted from the Sessions. */
export function seedRunners(): Array<RunnerSummaryWire> {
  const now = Date.now()
  return [
    {
      id: "r-studio",
      name: "studio",
      isOnline: true,
      version: hubVersion,
      versionStatus: "Current",
      lastSeenAt: now,
      openSessions: 0,
      updater: { self: true },
      models: fakeModels,
      sysinfo: fakeSysinfo(now - 8_000, { freeGiB: 186, totalGiB: 500 }),
    },
    {
      id: "r-ci",
      name: "ci-box",
      isOnline: false,
      version: { commit: "5d2b9e07c41a8f3362e0d9b7a1c4f58e2b6d0a93", branch: "main" },
      versionStatus: "Behind",
      lastSeenAt: now - 3 * 60 * 60 * 1000,
      openSessions: 0,
      updater: { self: true },
      models: fakeModels,
      // Nearly full when it was last heard from: the page warns.
      sysinfo: fakeSysinfo(
        now - 3 * 60 * 60 * 1000,
        { freeGiB: 8, totalGiB: 120 },
        { memoryTotalBytes: 8 * GiB, memoryAvailableBytes: 2.5 * GiB, cpuCores: 4, os: "darwin" },
      ),
    },
  ]
}

interface SeedSession {
  readonly summary: SessionSummaryWire
  /** What listens in its Sandbox while it is Active (#175). */
  readonly ports?: ReadonlyArray<OpenPortWire>
  /** When its history starts. */
  readonly at: number
  readonly events: ReadonlyArray<SessionEventWire>
}

const hour = 3_600_000
const day = 24 * hour
/** How long the Hub keeps an Archived Session restorable, by default. */
export const archiveRetentionMs = 30 * day

export function seedSessions(now = Date.now()): Array<SeedSession> {
  const studio = { runnerId: "r-studio" }
  return [
    {
      summary: {
        id: demoSessionId,
        repo: "kddige/kndl",
        baseBranch: "main",
        workBranch: "claude/web-client",
        state: "Active",
        ...studio,
        creator: you,
        createdAt: now - 2 * hour,
        currentTurn: null,
        // Started before Alice applied version 2: it shows "Environment changed".
        environment: { version: 1, latestVersion: 2 },
        // Alice switched it after the first Turn, which ran on Claude Code's default (#128).
        model: "sonnet",
        thinkingLevel: "high",
        // Alice keeps it up while Bob tries its dev server (ADR 0016).
        keepAwake: { by: you, at: now - 30 * 60_000 },
      },
      // Vite on Node 22 listens on `localhost`, which is `::1` only; Postgres runs in Docker.
      ports: [
        { port: 3000, addresses: ["0.0.0.0", "::"], process: "bun server" },
        { port: 5173, addresses: ["::1"], process: "node vite" },
        { port: 5432, addresses: ["0.0.0.0", "::"], process: "docker-proxy" },
      ],
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
        {
          _tag: "ModelSwitched",
          by: you,
          model: "sonnet",
          modelLabel: "Sonnet 5.5",
          thinkingLevel: "high",
        },
      ],
    },
    {
      summary: {
        id: "s-readme",
        repo: "kddige/kndl",
        baseBranch: "main",
        workBranch: "claude/readme-run",
        state: "Asleep",
        ...studio,
        creator: you,
        createdAt: now - 26 * hour,
        currentTurn: null,
        environment: { version: 1, latestVersion: 2 },
      },
      at: now - 26 * hour,
      events: [
        // From before subagents replaced Child Sessions (ADR 0014): its Parent Session's message.
        ...sessionTurn(
          "t-seed-2a",
          { _tag: "FromSession", session: { id: demoSessionId, title: "claude/web-client" } },
          "Find out how the web UI runs against the fake Hub.",
          [{ _tag: "TextDelta", text: "`VITE_FAKE_HUB=1 bun run web` serves it on the fake Hub." }],
        ),
        ...turn("t-seed-2", you, "Document how to run the web UI against the fake Hub", [
          {
            _tag: "TextDelta",
            text: "Added a **Run** row to the README: `VITE_FAKE_HUB=1 bun run web`.",
          },
        ]),
        { _tag: "SessionStateChanged", state: "Asleep", message: "Idle for 15m" },
      ],
    },
    {
      // Bob's: Alice watches it (ADR 0026).
      summary: {
        id: bobsSessionId,
        repo: "kddige/kndl",
        baseBranch: "main",
        workBranch: "claude/landing-copy",
        state: "Asleep",
        ...studio,
        creator: bob,
        createdAt: now - 20 * 60_000,
        currentTurn: null,
        environment: { version: 2, latestVersion: 2 },
      },
      at: now - 20 * 60_000,
      events: [
        ...turn("t-seed-5", bob, "Tighten the landing page's copy", [
          {
            _tag: "TextDelta",
            text: "Cut the hero to one line: **Claude Code, together.** The rest reads shorter too.",
          },
        ]),
        // Queued by Alice before only the Creator could prompt: the Hub cancelled it (ADR 0026).
        {
          _tag: "PromptCancelled",
          promptId: "p-seed-alice",
          sender: you,
          text: "And make the install command copyable",
          message: "Only the Session's Creator prompts it now",
        },
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
        creator: you,
        createdAt: now - 50 * hour,
        currentTurn: null,
        // Kept awake: it wakes again once ci-box is back.
        keepAwake: { by: you, at: now - 49 * hour },
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
        repo: "kddige/kndl",
        baseBranch: "main",
        workBranch: "claude/flaky-login",
        state: "Archived",
        ...studio,
        creator: you,
        createdAt: now - 5 * day,
        currentTurn: null,
        environment: { version: 1, latestVersion: 2 },
        archived: { by: you, at: now - 3 * day, purgeAt: now + 27 * day },
      },
      at: now - 5 * day,
      events: [
        ...turn("t-seed-4", you, "Fix the flaky login test", [
          { _tag: "TextDelta", text: "It raced the cookie being set: it now waits for it." },
        ]),
        { _tag: "SessionStateChanged", state: "Archived", by: you },
      ],
    },
    ...releaseSessions(now),
  ]
}

/**
 * Release 0.4 handed the changelog, the docs and the version bump to background agents. The
 * changelog's is done and told it so; Alice messaged and stopped the bump's; the docs' was
 * interrupted when she put the Session to sleep, in its worktree.
 */
function releaseSessions(now: number): Array<SeedSession> {
  const studio = { runnerId: "r-studio" }
  const at = now - 40 * 60_000
  const haiku = "claude-haiku-4-5-20251001"
  const changelog = { agentId: "a-changelog", description: "Write the 0.4 changelog" }
  const docs = { agentId: "a-docs", description: "Document the protocol" }
  const bump = { agentId: "a-bump", description: "Bump the package versions" }
  const changelogResult = "The changelog is in CHANGELOG.md: 14 entries, grouped by package."
  return [
    {
      summary: {
        id: releaseSessionId,
        name: "Release 0.4",
        repo: "kddige/kndl",
        baseBranch: "main",
        workBranch: "claude/release-0-4",
        state: "Asleep",
        ...studio,
        creator: you,
        createdAt: at,
        currentTurn: null,
        environment: { version: 2, latestVersion: 2 },
      },
      at,
      events: [
        ...turn("t-release-1", you, "Get 0.4 ready: the changelog, the docs and the versions", [
          {
            _tag: "TextDelta",
            text: "These don't touch each other, so I'll hand each to a subagent in the background.",
          },
          agentCall("t-release-1", changelog, "general-purpose", haiku),
          agentCall("t-release-1", docs, "general-purpose", "claude-sonnet-5-5"),
          agentCall("t-release-1", bump, "general-purpose", haiku),
          {
            _tag: "TextDelta",
            text: "All three are working. I'll tell you what each finds when it's done.",
          },
        ]),
        {
          _tag: "AgentStatusChanged",
          agentId: docs.agentId,
          status: "Running",
          worktree: {
            path: "/workspace/kndl/.claude/worktrees/agent-docs",
            branch: "worktree-agent-docs",
          },
        },
        ...agentRun("t-release-a1", changelog.agentId, [
          tool(
            "Bash",
            { command: "gh pr list --state merged --search 'merged:>2026-09-01'" },
            "#141 …\n#142 …\n…",
          ),
          { _tag: "TextDelta", text: changelogResult },
        ]),
        { _tag: "AgentStatusChanged", agentId: changelog.agentId, status: "Done" },
        ...agentRun("t-release-a2", bump.agentId, [
          tool("Glob", { pattern: "packages/*/package.json" }, "packages/cli/package.json\n…"),
        ]),
        {
          _tag: "AgentMessaged",
          agentId: bump.agentId,
          sender: you,
          text: "Hold off: we bump once the docs land.",
        },
        { _tag: "AgentStatusChanged", agentId: bump.agentId, status: "Stopped" },
        ...sessionTurn(
          "t-release-2",
          { _tag: "FromAgent", agentId: changelog.agentId },
          taskNotification(changelog.agentId, changelog.description, changelogResult),
          [
            {
              _tag: "TextDelta",
              text: "**The changelog** is done: 14 entries in CHANGELOG.md, grouped by package. The docs are still being written.",
            },
          ],
        ),
        ...agentRun("t-release-a3", docs.agentId, [
          tool(
            "Glob",
            { pattern: "packages/protocol/src/*.ts" },
            "Hub.ts\nMod.ts\nRunner.ts\nSession.ts\nTurn.ts\nWeb.ts",
          ),
          {
            _tag: "TextDelta",
            text: "I've drafted the Web and Runner messages in the reference. Mod and Turn are next.",
          },
        ]),
        // Its Claude Code stopped while this Read ran: it never ended.
        {
          _tag: "ToolCallStarted",
          turnId: "t-release-a3",
          agentId: docs.agentId,
          toolCallId: "t-release-a3-tool-2",
          tool: "Read",
          input: JSON.stringify({
            file_path: "/workspace/kndl/packages/protocol/src/Mod.ts",
          }),
        },
        { _tag: "AgentStatusChanged", agentId: docs.agentId, status: "Interrupted" },
        { _tag: "SessionStateChanged", state: "Asleep", message: "Put to sleep", by: you },
      ],
    },
  ]
}

/** The Agent tool starting a background agent, as its Turn's body shows it. */
function agentCall(
  turnId: string,
  agent: { agentId: string; description: string },
  agentType: string,
  model: string,
): TurnBody[number] {
  return {
    _tag: "Agent",
    tool: "Agent",
    input: JSON.stringify({
      description: agent.description,
      prompt: agent.description,
      subagent_type: agentType,
      run_in_background: true,
    }),
    output: `Async agent launched successfully. agentId: ${agent.agentId}`,
    started: {
      _tag: "AgentStarted",
      turnId,
      agentId: agent.agentId,
      toolCallId: "",
      agentType,
      description: agent.description,
      model,
      background: true,
    },
  }
}

/** A subagent's run, for seeding history: its text and tool calls, then its end. */
function agentRun(turnId: string, agentId: string, body: TurnBody): Array<SessionEventWire> {
  const events: Array<SessionEventWire> = []
  let count = 0
  for (const part of body) {
    if (part._tag === "TextDelta") {
      events.push({ _tag: "TextDelta", turnId, agentId, text: part.text })
      continue
    }
    const toolCallId = `${turnId}-tool-${++count}`
    events.push(
      { _tag: "ToolCallStarted", turnId, agentId, toolCallId, tool: part.tool, input: part.input },
      {
        _tag: "ToolCallEnded",
        turnId,
        agentId,
        toolCallId,
        tool: part.tool,
        outcome: "Succeeded",
        output: part.output,
      },
    )
  }
  events.push({ _tag: "TurnEnded", turnId, agentId, reason: "stop", durationMs: 41_000 })
  return events
}

type TurnBody = ReadonlyArray<
  | { _tag: "TextDelta"; text: string }
  | { _tag: "Tool"; tool: string; input: string; output: string }
  /** An Agent call and the subagent it started, whose toolCallId is filled in. */
  | {
      _tag: "Agent"
      tool: string
      input: string
      output: string
      started: Extract<SessionEventWire, { _tag: "AgentStarted" }>
    }
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
      ...(part._tag === "Agent" ? [{ ...part.started, toolCallId }] : []),
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
    reason: "stop",
    durationMs: 18_400,
    usage: {
      model: "claude-opus-5-5",
      input: 3_100,
      output: 420,
      cacheRead: 22_000,
      cacheWrite: 1_200,
      cost: 0.0372,
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

/**
 * The demo's live Turn: Alice asks, Claude streams, a subagent explores, and she queues another,
 * while Bob watches.
 */
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
    kind: "agent",
    agentId: "agent-kit",
    agentType: "Explore",
    description: "Survey the UI kit",
    prompt: "List the kit components that can collapse content, and how they're styled.",
    model: "claude-haiku-4-5-20251001",
    steps: [
      { kind: "text", text: "Looking through the kit's components." },
      {
        kind: "tool",
        tool: "Glob",
        input: { pattern: "packages/web/src/ui/*.tsx" },
        output: "Avatar.tsx\nBadge.tsx\nButton.tsx\nDialog.tsx\nDisclosure.tsx\n…",
        steps: 2,
      },
      {
        kind: "tool",
        tool: "Read",
        input: { file_path: "packages/web/src/ui/Disclosure.tsx" },
        output: "export function Disclosure({ summary, children, defaultOpen = false }) { … }",
        steps: 2,
      },
      { kind: "text", text: "Disclosure is the one: closed by default, with a summary row." },
    ],
    result: "The kit has Disclosure for collapsible rows; it's styled with the shared tokens.",
  },
  {
    kind: "agent",
    agentId: "agent-docs",
    agentType: "general-purpose",
    description: "Find docs that mention tool calls",
    prompt: "Find the docs pages that describe how the chat shows tool calls.",
    model: "claude-haiku-4-5-20251001",
    background: true,
    worktree: {
      path: "/workspace/kndl/.claude/worktrees/agent-docs",
      branch: "worktree-agent-docs",
    },
    steps: [
      { kind: "text", text: "Searching the docs for tool calls." },
      {
        kind: "tool",
        tool: "Grep",
        input: { pattern: "tool call", path: "packages/docs/src/content" },
        output: "packages/docs/src/content/docs/how-to/work-in-a-session.md",
        steps: 20,
      },
      { kind: "pause", steps: 30 },
      { kind: "text", text: "Only work-in-a-session.md says how tool calls show." },
    ],
    result: "Only how-to/work-in-a-session.md describes tool calls in the chat.",
    relay:
      "The docs agent found one page that describes tool calls: **work-in-a-session.md**. I'll update it with the README.",
  },
  { kind: "queue", sender: you, text: "Then add a line about it to the README" },
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

const libraryQuestion = "Which date library should the web UI use?"

/** A reply that asks first (#193): one question to pick one answer for, one to pick several. */
export const questionReply: ReadonlyArray<ReplyStep> = [
  { kind: "text", text: "Before I start, two things to settle." },
  {
    kind: "question",
    questions: [
      {
        question: libraryQuestion,
        header: "Library",
        multiSelect: false,
        options: [
          { label: "date-fns", description: "Small functions, imported one at a time." },
          { label: "Luxon", description: "An immutable DateTime, with time zones built in." },
          { label: "Temporal polyfill", description: "The coming standard; the heaviest." },
        ],
      },
      {
        question: "Which views should show relative times?",
        header: "Views",
        multiSelect: true,
        options: [
          { label: "Sessions list", description: "How long ago each Session was active." },
          { label: "Transcript", description: "When each Turn started." },
          { label: "Runners page" },
        ],
      },
    ],
    // Alice leans to Luxon in another tab: whoever watches sees it (ADR 0026).
    pick: { participant: you, question: libraryQuestion, answer: "Luxon" },
  },
  { kind: "text", text: "\n\nThanks. Going with that." },
]

/** A short reply to any prompt someone types; one that says "ask me" gets a question first. */
export function replyTo(text: string): ReadonlyArray<ReplyStep> {
  if (/\bask me\b/i.test(text)) return questionReply
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
    slug: "kndl-alice",
    settingsUrl: "https://github.com/settings/apps/kndl-alice/permissions",
    installUrl: "https://github.com/apps/kndl-alice/installations/new",
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
