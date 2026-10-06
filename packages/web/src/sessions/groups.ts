// Sessions arranged by Repo, as the sidebar and the Hub-wide pages show them.

import { repoKey, type SessionSummary } from "@claude-hub/protocol"

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
 * changes, and each Repo's Sessions in `order`, oldest first unless given. Spellings of a Repo's
 * name that differ only in case are one Repo (#197), named as the first of its Sessions given spells it.
 */
export function groupByRepo(
  sessions: ReadonlyArray<SessionSummary>,
  order: Order = oldestFirst,
): ReadonlyArray<RepoGroup> {
  const byRepo = new Map<string, { repo: string; sessions: Array<SessionSummary> }>()
  for (const session of sessions) {
    const group = byRepo.get(repoKey(session.repo))
    if (group) group.sessions.push(session)
    else byRepo.set(repoKey(session.repo), { repo: session.repo, sessions: [session] })
  }
  return [...byRepo.values()]
    .toSorted((a, b) => a.repo.localeCompare(b.repo))
    .map(({ repo, sessions: group }) => ({ repo, sessions: group.toSorted(order) }))
}

/**
 * Every Repo the web knows of, from its Sessions, Archived ones included, in alphabetical order.
 * The web channel has no list of the Repos that have an Environment, so one with an Environment
 * but no Sessions isn't here. One Repo is listed once, however its Sessions spell its name.
 */
export function knownRepos(sessions: ReadonlyArray<SessionSummary>): ReadonlyArray<string> {
  return groupByRepo(sessions).map((group) => group.repo)
}
