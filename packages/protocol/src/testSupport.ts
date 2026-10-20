// Helpers and sample messages for the protocol's tests. Not exported from the package.
import { expect } from "bun:test"
import { Schema } from "effect"

/**
 * Decodes each sample as it would arrive off the wire, encodes it back, and checks that what goes
 * out over JSON equals what came in.
 */
export function expectRoundTrips(
  schema: Schema.Codec<unknown, unknown>,
  samples: ReadonlyArray<unknown>,
) {
  for (const sample of samples) {
    const decoded = Schema.decodeUnknownSync(schema)(sample)
    const wire = JSON.parse(JSON.stringify(Schema.encodeSync(schema)(decoded)))
    expect(wire).toEqual(sample)
  }
}

/** Checks that the samples include one message of every kind the union has. */
export function expectEveryTag(
  union: { readonly discriminants: ReadonlyArray<PropertyKey> },
  samples: ReadonlyArray<{ readonly _tag: string }>,
) {
  expect(new Set<PropertyKey>(samples.map((sample) => sample._tag))).toEqual(
    new Set(union.discriminants),
  )
}

export function expectRejected(schema: Schema.Codec<unknown, unknown>, input: unknown) {
  expect(() => Schema.decodeUnknownSync(schema)(input)).toThrow()
}

export const alice = { id: "u-1", login: "alice", name: "Alice" }
export const bob = { id: "u-2", login: "bob", name: "Bob" }

export const sessionSummary = {
  id: "s-1",
  repo: "kddige/kndl",
  baseBranch: "main",
  workBranch: "claude/s-1",
  state: "Active",
  runnerId: "r-1",
  creator: alice,
  createdAt: 1_790_000_000_000,
  currentTurn: null,
}

const recipe = {
  image: "debian:bookworm-slim",
  bootstrapScript: "apt-get update && apt-get install -y ripgrep",
  startScript: "bun install",
  docker: true,
  dependencyFolders: [
    { pattern: "**/node_modules", nextTo: "package.json" },
    { pattern: "build/cache" },
  ],
  resources: { cpus: 4, memoryMib: 8192 },
}

/** A draft as the web UI sends it, with one of each kind of variable. */
export const environmentDraft = {
  ...recipe,
  variables: [
    { _tag: "Plain", name: "NODE_ENV", value: "development" },
    { _tag: "Sensitive", name: "NPM_TOKEN", value: "npm_secret", availableAtBuild: true },
    { _tag: "Sensitive", name: "API_KEY", availableAtBuild: false },
    { _tag: "Link", name: "GH_TOKEN", sharedVariable: "GITHUB_TOKEN", availableAtBuild: false },
  ],
}

/** The same Environment as applied, as the web UI sees it: no Sensitive values. */
export const environment = {
  repo: "kddige/kndl",
  version: 3,
  ...recipe,
  variables: [
    { _tag: "Plain", name: "NODE_ENV", value: "development" },
    { _tag: "Sensitive", name: "NPM_TOKEN", availableAtBuild: true, needsValue: false },
    { _tag: "Sensitive", name: "API_KEY", availableAtBuild: false, needsValue: true },
    { _tag: "Link", name: "GH_TOKEN", sharedVariable: "GITHUB_TOKEN", availableAtBuild: false },
  ],
}

/** What a Runner builds it from. */
export const environmentRecipe = {
  ...recipe,
  variables: [
    { name: "NODE_ENV", availableAtBuild: true },
    { name: "NPM_TOKEN", availableAtBuild: true },
    { name: "API_KEY", availableAtBuild: false },
  ],
}

export const turnEvents = [
  {
    _tag: "TurnStarted",
    turnId: "t-1",
    text: "[Alice] add a health check",
    sender: { _tag: "FromParticipant", participant: alice },
    promptId: "p-1",
  },
  { _tag: "TurnStarted", turnId: "t-2", text: "", sender: { _tag: "FromTerminal" } },
  { _tag: "TextDelta", turnId: "t-1", text: "Let me look" },
  { _tag: "TextDelta", turnId: "t-1", agentId: "a-1", text: "Searching" },
  {
    _tag: "ToolCallStarted",
    turnId: "t-1",
    toolCallId: "toolu_1",
    tool: "Bash",
    input: '{"command":"ls"}',
  },
  {
    _tag: "ToolCallEnded",
    turnId: "t-1",
    toolCallId: "toolu_1",
    tool: "Bash",
    outcome: "Succeeded",
    output: "README.md\npackages",
  },
  {
    _tag: "ToolCallEnded",
    turnId: "t-1",
    agentId: "a-1",
    toolCallId: "toolu_2",
    tool: "Bash",
    outcome: "Denied",
    output: "Blocked by a PreToolUse hook: no force pushes",
  },
  {
    _tag: "TurnEnded",
    turnId: "t-1",
    reason: "stop",
    durationMs: 5_200,
    usage: {
      model: "claude-opus-5-5",
      input: 1_200,
      output: 300,
      cacheRead: 40_000,
      cacheWrite: 0,
      cost: 0.0372,
    },
  },
  { _tag: "TurnEnded", turnId: "t-2", reason: "aborted", durationMs: 800 },
  {
    _tag: "TurnEnded",
    turnId: "t-3",
    reason: "error",
    durationMs: 300,
    errorMessage: "OpenAI API error (429): You exceeded your current quota",
  },
  {
    _tag: "TurnStarted",
    turnId: "t-3",
    text: "[Report from Child Session ...]",
    sender: { _tag: "FromSession", session: { id: "s-2", title: "claude/s-2" } },
    promptId: "p-3",
  },
  {
    _tag: "AgentStarted",
    turnId: "t-4",
    agentId: "a-1",
    toolCallId: "toolu_3",
    agentType: "general-purpose",
    description: "Survey the docs",
    model: "claude-haiku-4-5",
    background: true,
  },
  { _tag: "AgentStatusChanged", agentId: "a-1", status: "Running" },
  {
    _tag: "AgentStatusChanged",
    agentId: "a-1",
    status: "Done",
    worktree: {
      path: "/workspace/.claude/worktrees/agent-a-1",
      branch: "worktree-agent-a-1",
    },
  },
  {
    _tag: "TurnStarted",
    turnId: "t-5",
    text: "<task-notification>…</task-notification>",
    sender: { _tag: "FromAgent", agentId: "a-1" },
  },
  {
    _tag: "QuestionAsked",
    turnId: "t-5",
    toolCallId: "toolu_ask",
    questions: [
      {
        question: "Which date library?",
        header: "Library",
        options: [
          { label: "date-fns", description: "Small, tree-shakeable" },
          { label: "Temporal" },
        ],
        multiSelect: false,
      },
      { question: "What else?", header: "Notes", options: [], multiSelect: true },
    ],
  },
  {
    _tag: "QuestionClosed",
    turnId: "t-5",
    toolCallId: "toolu_ask",
    outcome: { _tag: "Answered", answers: { "Which date library?": "date-fns" } },
    by: bob,
  },
  {
    _tag: "QuestionClosed",
    turnId: "t-5",
    toolCallId: "toolu_ask",
    outcome: { _tag: "Replied", text: "neither, use the platform" },
  },
  {
    _tag: "QuestionClosed",
    turnId: "t-5",
    toolCallId: "toolu_ask",
    outcome: { _tag: "Dismissed" },
  },
  {
    _tag: "QuestionClosed",
    turnId: "t-5",
    toolCallId: "toolu_ask",
    outcome: { _tag: "Cancelled" },
  },
  {
    _tag: "PromptSteered",
    turnId: "t-1",
    promptId: "p-2",
    text: "use the README's port",
    sender: bob,
  },
  { _tag: "SteeredPromptRead", turnId: "t-1", promptId: "p-2" },
  { _tag: "TurnStarted", turnId: "t-6", text: "", sender: { _tag: "Resumed" } },
  {
    _tag: "TurnStarted",
    turnId: "t-7",
    threadId: "thr-1",
    text: "[Bob] what about Windows?",
    sender: { _tag: "FromParticipant", participant: bob },
    promptId: "p-7",
  },
  { _tag: "TextDelta", turnId: "t-7", threadId: "thr-1", text: "Windows needs" },
  {
    _tag: "ToolCallStarted",
    turnId: "t-7",
    threadId: "thr-1",
    toolCallId: "call_7",
    tool: "bash",
    input: '{"command":"ls"}',
  },
  {
    _tag: "ToolCallEnded",
    turnId: "t-7",
    threadId: "thr-1",
    toolCallId: "call_7",
    tool: "bash",
    outcome: "Succeeded",
    output: "README.md",
  },
  {
    _tag: "PromptSteered",
    turnId: "t-7",
    threadId: "thr-1",
    promptId: "p-8",
    text: "and macOS",
    sender: alice,
  },
  { _tag: "SteeredPromptRead", turnId: "t-7", threadId: "thr-1", promptId: "p-8" },
  { _tag: "TurnEnded", turnId: "t-7", threadId: "thr-1", reason: "stop", durationMs: 900 },
  { _tag: "CompactionStarted", reason: "threshold" },
  { _tag: "CompactionStarted", threadId: "thr-1", reason: "manual", by: alice },
  { _tag: "CompactionStarted", agentId: "a-1", reason: "overflow" },
  { _tag: "CompactionEnded", outcome: "compacted", summary: "We added a health check." },
  { _tag: "CompactionEnded", threadId: "thr-1", outcome: "failed", error: "429" },
  {
    _tag: "PlanChanged",
    plan: {
      steps: [
        { text: "Add the route", status: "done" },
        { text: "Test it", status: "in_progress" },
        { text: "Document it", status: "pending" },
      ],
      explanation: "The route works; testing next.",
    },
  },
  { _tag: "PlanChanged", threadId: "thr-1", plan: { steps: [] } },
  {
    _tag: "UsageChanged",
    usage: { input: 1200, output: 300, cacheRead: 40_000, cacheWrite: 0, cost: 0.04 },
  },
  {
    _tag: "UsageChanged",
    threadId: "thr-1",
    usage: { input: 10, output: 3, cacheRead: 0, cacheWrite: 0, cost: 0 },
  },
]
