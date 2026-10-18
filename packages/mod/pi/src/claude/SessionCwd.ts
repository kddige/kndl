// Each pi session's working directory, which Claude Code runs in: the Workspace, in a Session. A
// process serving several pi sessions (subagents) has one process cwd, so it's kept per session.
// A subagent's session loads no extension of its own: the bridge follows it through this module
// (followClaudeSession, as an extension factory), so this module's state is every session's.
//
// Ported from pi-claude-bridge 0.9.3 (MIT, Copyright (c) 2026 Eli Dickinson): see
// THIRD_PARTY_NOTICES.md.

/** pi hands the compaction's signal to every summary call it makes: the session they're for. */
const summarySessions = new WeakMap<AbortSignal, string>()

const sessionCwds = new Map<string, string>()

export function rememberSummarySession(signal: AbortSignal, sessionId: string): void {
  summarySessions.set(signal, sessionId)
}

export function summarySessionFor(signal: AbortSignal | undefined): string | undefined {
  return signal ? summarySessions.get(signal) : undefined
}

export function rememberSessionCwd(sessionId: string, cwd: string): void {
  sessionCwds.set(sessionId, cwd)
}

export function forgetSessionCwd(sessionId: string): void {
  sessionCwds.delete(sessionId)
}

export function sessionCwdFor(sessionId: string | null | undefined): string {
  return (sessionId ? sessionCwds.get(sessionId) : undefined) ?? process.cwd()
}
