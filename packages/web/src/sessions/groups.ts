// Sessions arranged by Repo, as the sidebar and the Hub-wide pages show them, and which of the
// sidebar's Repo groups this viewer has collapsed.

import type { SessionSummary } from "@claude-hub/protocol"

export interface RepoGroup {
  /** `owner/name`. */
  readonly repo: string
  readonly sessions: ReadonlyArray<SessionSummary>
}

type Order = (a: SessionSummary, b: SessionSummary) => number

/** The most recently started first. */
export const newestFirst: Order = (a, b) => b.createdAt - a.createdAt

/**
 * The given Sessions by Repo: Repos in alphabetical order, so a group stays put as activity
 * changes, and each Repo's Sessions in `order`, newest first unless given.
 */
export function groupByRepo(
  sessions: ReadonlyArray<SessionSummary>,
  order: Order = newestFirst,
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

/** The Repo's page on GitHub. */
export function gitHubUrl(repo: string): string {
  return `https://github.com/${repo}`
}

const collapsedKey = "claude-hub:sidebar-collapsed"

/** The Repo groups this viewer collapsed in the sidebar, kept in this browser. */
export function loadCollapsed(): ReadonlySet<string> {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(collapsedKey) ?? "[]")
    return new Set(
      Array.isArray(raw) ? raw.filter((repo): repo is string => typeof repo === "string") : [],
    )
  } catch {
    return new Set()
  }
}

export function storeCollapsed(collapsed: ReadonlySet<string>): void {
  try {
    localStorage.setItem(collapsedKey, JSON.stringify([...collapsed]))
  } catch {
    // Storage is full or off: the groups stay as they are until the page is closed.
  }
}
