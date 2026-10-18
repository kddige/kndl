// The Claude bridge's state in this process (Bridge.ts): what registration set, the queries in
// flight, and what pi's history rewrites and stopped queries leave. One process serves the
// Session's pi session and its subagents' (ADR 0029), each query in a context of its own.

import { query } from "@anthropic-ai/claude-agent-sdk"
import type { Options, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk"
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent"
import { QueryContext } from "./QueryState.ts"
import { claudeCodeEnvironment } from "./Settings.ts"
import type { ClaudeSettings } from "./Settings.ts"

/** A Claude Code query, as the bridge drives it: what the SDK's `query()` returns. */
export type ClaudeQuery = AsyncIterable<unknown> & {
  readonly interrupt: () => Promise<unknown>
  readonly close: () => void
}

export type QueryFn = (params: {
  readonly prompt: string | AsyncIterable<SDKUserMessage>
  readonly options: Options
}) => ClaudeQuery

/** The SDK's query(), as the bridge calls it. */
export const sdkQuery: QueryFn = query

export const bridge = {
  /** How a query starts: the SDK's query(), or a test's. */
  query: sdkQuery,
  /** What registration set: the pinned Claude Code, and its environment. */
  settings: undefined as ClaudeSettings | undefined,
  /** The environment Claude Code runs with, as registration found it. */
  childEnv: (): Record<string, string> => claudeCodeEnvironment(process.env),
  /** The terminal's UI, for the notices the bridge shows there. */
  piUI: null as ExtensionUIContext | null,
  /** Every query in flight, whose tool results a call may bring. */
  activeQueryContexts: new Set<QueryContext>(),
  /**
   * The pi sessions whose history pi replaced (compaction, tree navigation) under a query held at
   * a tool call: its result starts a query on the new history instead of going to the old one.
   */
  historyRewrittenBySession: new Set<string>(),
  /** Queries pi's history moved out from under: their ending touches neither mirror nor stream. */
  abandonedQueries: new WeakSet<object>(),
  /**
   * Per pi session, the stopped query whose Claude Code may still be writing to the session file:
   * settles once it has exited, or given up on. The session's next query waits for it.
   */
  stoppingQueries: new Map<string, Promise<void>>(),
  /**
   * The top-level context, reused query to query. A query that starts while it is busy (held at a
   * tool call, or waiting for a stopped Claude Code to exit), as a subagent's does while its
   * parent's waits on it, gets a context of its own.
   */
  topContext: new QueryContext(),
}
