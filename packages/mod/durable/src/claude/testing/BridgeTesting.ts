// A Claude bridge as its tests make one: on a fake Claude Code's query, its sessions in a test's
// directory, called with transcripts built as pi-ai builds them from a Context.

import type { Context, TranscriptContext } from "@earendil-works/pi-ai"
import { normalizeContext } from "@earendil-works/pi-ai"
import { createBridge } from "../Bridge.ts"
import type { Bridge, QueryFn } from "../Bridge.ts"
import { silentLog } from "../Log.ts"
import type { BridgeLog } from "../Log.ts"
import type { Notice } from "../QueryState.ts"
import { SessionMirrors } from "../SessionMirror.ts"

export interface TestBridge extends Bridge {
  readonly mirrors: SessionMirrors
}

/** A bridge on `query`, keeping Claude Code's sessions in `claudeDir`. */
export function makeBridge(options: {
  readonly query: QueryFn
  readonly claudeDir: string
  readonly cwd?: string
  readonly log?: BridgeLog
  readonly notice?: Notice
  readonly idleQueryMs?: number
}): TestBridge {
  const log = options.log ?? silentLog
  const mirrors = new SessionMirrors({ claudeDir: options.claudeDir, log })
  const bridge = createBridge({
    claudeCodePath: "/opt/kndl/claude-code/claude",
    childEnv: { PATH: "/usr/bin:/bin" },
    cwd: () => options.cwd ?? process.cwd(),
    mirrors,
    log,
    notice: options.notice ?? (() => {}),
    query: options.query,
    idleQueryMs: options.idleQueryMs ?? 60 * 60_000,
  })
  return { ...bridge, mirrors }
}

/** `context` as the transcript pi-ai hands a provider: its prompt and tools a system message. */
export const transcriptOf = (context: Context): TranscriptContext => normalizeContext(context)
