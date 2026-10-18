// The Claude bridge's state (BridgeState.ts) as its tests set and look at it: a fake Claude Code in
// place of the SDK's query(), and the bridge started over between tests.

import { bridge, sdkQuery } from "../src/claude/BridgeState.ts"
import type { QueryFn } from "../src/claude/BridgeState.ts"
import { QueryContext } from "../src/claude/QueryState.ts"

/** Runs the bridge's queries on `fn`, a fake Claude Code; null puts the SDK's query() back. */
export function setQuery(fn: QueryFn | null): void {
  bridge.query = fn ?? sdkQuery
}

/** Forgets every query and rewrite mark, and starts a new top-level context. */
export function resetBridge(): void {
  bridge.activeQueryContexts.clear()
  bridge.historyRewrittenBySession.clear()
  bridge.stoppingQueries.clear()
  bridge.topContext = new QueryContext()
}

/** What the bridge holds, for a test to look at. */
export const bridgeState = {
  get activeQueryContexts() {
    return bridge.activeQueryContexts
  },
  get historyRewrittenBySession() {
    return bridge.historyRewrittenBySession
  },
  isQueryAbandoned: (query: object) => bridge.abandonedQueries.has(query),
  get topContext() {
    return bridge.topContext
  },
}
