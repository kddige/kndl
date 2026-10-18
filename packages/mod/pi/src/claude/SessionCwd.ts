// Each pi session's working directory, which Claude Code runs in: the Workspace, in a Session. A
// process serving several pi sessions (subagents) has one process cwd, so it's kept per session.
// Kept on globalThis, as an extension loaded again for a subagent's session sees only its own
// session_start.
//
// Ported from pi-claude-bridge 0.9.3 (MIT, Copyright (c) 2026 Eli Dickinson): see
// THIRD_PARTY_NOTICES.md.

const SessionCwdsKey = Symbol.for("kndl:claude-bridge:sessionCwds")
const SummarySessionsKey = Symbol.for("kndl:claude-bridge:summarySessions")

const globals = globalThis as Record<symbol, unknown>

function summarySessions(): WeakMap<AbortSignal, string> {
  return (globals[SummarySessionsKey] ??= new WeakMap<AbortSignal, string>()) as WeakMap<
    AbortSignal,
    string
  >
}

/** pi hands the compaction's signal to every summary call it makes: the session they're for. */
export function rememberSummarySession(signal: AbortSignal, sessionId: string): void {
  summarySessions().set(signal, sessionId)
}

export function summarySessionFor(signal: AbortSignal | undefined): string | undefined {
  return signal ? summarySessions().get(signal) : undefined
}

function store(): Map<string, string> {
  return (globals[SessionCwdsKey] ??= new Map<string, string>()) as Map<string, string>
}

export function rememberSessionCwd(sessionId: string, cwd: string): void {
  store().set(sessionId, cwd)
}

export function forgetSessionCwd(sessionId: string): void {
  store().delete(sessionId)
}

export function sessionCwdFor(sessionId: string | null | undefined): string {
  return (sessionId ? store().get(sessionId) : undefined) ?? process.cwd()
}
