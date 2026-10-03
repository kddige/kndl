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

export const runnerLogin = { account: "alice@example.com" }

export const sessionSummary = {
  id: "s-1",
  repo: "kddige/claude-hub",
  baseBranch: "main",
  workBranch: "claude/s-1",
  state: "Active",
  runnerId: "r-1",
  runnerLogin,
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
  repo: "kddige/claude-hub",
  version: 3,
  ...recipe,
  variables: [
    { _tag: "Plain", name: "NODE_ENV", value: "development" },
    { _tag: "Sensitive", name: "NPM_TOKEN", availableAtBuild: true },
    { _tag: "Sensitive", name: "API_KEY", availableAtBuild: false },
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
    tool: "WebFetch",
    outcome: "Denied",
    output: "WebFetch is not available in a claude-hub Session",
  },
  {
    _tag: "TurnEnded",
    turnId: "t-1",
    reason: "Answered",
    durationMs: 5_200,
    usage: {
      model: "claude-opus-5-5",
      inputTokens: 1_200,
      outputTokens: 300,
      cacheReadInputTokens: 40_000,
      cacheCreationInputTokens: 0,
    },
  },
  { _tag: "TurnEnded", turnId: "t-2", reason: "Stopped", durationMs: 800 },
]
