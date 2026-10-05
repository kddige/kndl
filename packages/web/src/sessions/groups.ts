// Sessions arranged by Repo, as the sidebar and the Hub-wide pages show them.

import type { SessionSummary } from "@claude-hub/protocol"

export interface RepoGroup {
  /** `owner/name`. */
  readonly repo: string
  readonly sessions: ReadonlyArray<SessionSummary>
}

type Order = (a: SessionSummary, b: SessionSummary) => number

/** In the order they were created, the oldest first, so a Session keeps its place. */
export const oldestFirst: Order = (a, b) => a.createdAt - b.createdAt

/**
 * The given Sessions by Repo: Repos in alphabetical order, so a group stays put as activity
 * changes, and each Repo's Sessions in `order`, oldest first unless given.
 */
export function groupByRepo(
  sessions: ReadonlyArray<SessionSummary>,
  order: Order = oldestFirst,
): ReadonlyArray<RepoGroup> {
  const byRepo = new Map<string, Array<SessionSummary>>()
  for (const session of sessions) {
    const group = byRepo.get(session.repo)
    if (group) group.push(session)
    else byRepo.set(session.repo, [session])
  }
  return [...byRepo]
    .toSorted(([a], [b]) => a.localeCompare(b))
    .map(([repo, group]) => ({ repo, sessions: group.toSorted(order) }))
}

/**
 * Every Repo the web knows of, from its Sessions, Archived ones included, in alphabetical order.
 * The web channel has no list of the Repos that have an Environment, so one with an Environment
 * but no Sessions isn't here.
 */
export function knownRepos(sessions: ReadonlyArray<SessionSummary>): ReadonlyArray<string> {
  return [...new Set(sessions.map((session) => session.repo))].toSorted((a, b) =>
    a.localeCompare(b),
  )
}

/** A Session and the Child Sessions listed under it, in their order. */
export interface SessionNode {
  readonly session: SessionSummary
  readonly children: ReadonlyArray<SessionSummary>
}

/**
 * The given Sessions with each Child Session under its Parent Session, keeping their order (ADR
 * 0012). A child whose parent isn't among them, as when the parent is Archived, stands on its own.
 */
export function nestChildren(sessions: ReadonlyArray<SessionSummary>): ReadonlyArray<SessionNode> {
  const listed = new Set(sessions.map((session) => session.id))
  const children = new Map<string, Array<SessionSummary>>()
  for (const session of sessions) {
    if (session.parentId === undefined || !listed.has(session.parentId)) continue
    const siblings = children.get(session.parentId)
    if (siblings) siblings.push(session)
    else children.set(session.parentId, [session])
  }
  return sessions
    .filter((session) => session.parentId === undefined || !listed.has(session.parentId))
    .map((session) => ({ session, children: children.get(session.id) ?? [] }))
}
