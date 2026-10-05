import { type SessionId, type SessionSummary, sessionTitle } from "@claude-hub/protocol"
import * as stylex from "@stylexjs/stylex"
import { Link } from "@tanstack/react-router"
import { useMemo } from "react"
import { day, purgedIn, repoParams, timeAgo } from "../app/format.ts"
import { useHub, useHubState } from "../app/hub.tsx"
import type { HubClient } from "../hub/client.ts"
import {
  Avatar,
  BranchIcon,
  Button,
  EmptyState,
  InboxIcon,
  PageHeader,
  Spinner,
  toast,
} from "../ui/index.ts"
import { focus } from "../ui/shared.ts"
import { color, font, leading, radius, space, text, weight } from "../ui/tokens.stylex.ts"
import { groupByRepo } from "./groups.ts"

const styles = stylex.create({
  view: { display: "flex", flexDirection: "column", flex: 1, minHeight: 0 },
  scroll: { flex: 1, overflowY: "auto" },
  page: {
    display: "flex",
    flexDirection: "column",
    gap: space.s4,
    maxWidth: "56rem",
    marginInline: "auto",
    paddingBlock: space.s6,
    paddingInline: space.s4,
  },
  group: { display: "flex", flexDirection: "column", gap: space.s2 },
  repo: { fontSize: text.md, fontWeight: weight.semibold, lineHeight: leading.tight },
  repoLink: {
    color: color.text,
    textDecoration: { default: "none", ":hover": "underline" },
    borderRadius: radius.sm,
  },
  list: {
    display: "flex",
    flexDirection: "column",
    margin: 0,
    padding: 0,
    listStyle: "none",
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: color.border,
    borderRadius: radius.lg,
    backgroundColor: color.surface,
    overflow: "hidden",
  },
  row: {
    display: "grid",
    gridTemplateColumns: "minmax(0, 1fr) auto",
    alignItems: "center",
    columnGap: space.s4,
    paddingBlock: space.s3,
    paddingInline: space.s4,
    borderTopWidth: "1px",
    borderTopStyle: "solid",
    borderTopColor: color.border,
  },
  firstRow: { borderTopWidth: 0 },
  main: { display: "flex", flexDirection: "column", gap: space.s1, minWidth: 0 },
  branch: {
    display: "inline-flex",
    alignItems: "center",
    gap: space.s1,
    fontFamily: font.mono,
    fontSize: text.sm,
    color: color.text,
    textDecoration: { default: "none", ":hover": "underline" },
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  meta: {
    display: "flex",
    alignItems: "center",
    flexWrap: "wrap",
    gap: space.s1_5,
    color: color.textMuted,
    fontSize: text.sm,
  },
  loading: { display: "grid", placeItems: "center", paddingBlock: space.s16 },
})

/**
 * A Repo's Archived Sessions: who deleted each and when, and until when it can be restored.
 * Restoring brings a Session back Asleep.
 */
export function ArchivedSessions({ repo }: { repo: string }) {
  const sessions = useHubState((state) => state.sessions)
  const archived = useMemo(
    () =>
      sessions === null
        ? null
        : newestArchived(sessions.filter((session) => session.repo === repo)),
    [sessions, repo],
  )

  return (
    <main {...stylex.props(styles.view)}>
      <PageHeader
        title="Archived Sessions"
        description={`${repo}: deleted Sessions can be restored until they're purged.`}
      />
      <div {...stylex.props(styles.scroll)}>
        <div {...stylex.props(styles.page)}>
          {archived === null ? (
            <Loading />
          ) : archived.length === 0 ? (
            <EmptyState
              size="page"
              icon={<InboxIcon />}
              title="Nothing archived"
              description={`Sessions deleted from ${repo} show here until they're purged.`}
            />
          ) : (
            <ArchivedList label="Archived Sessions" sessions={archived} />
          )}
        </div>
      </div>
    </main>
  )
}

/** Every Repo's Archived Sessions, grouped by Repo: where the sidebar's "Archived Sessions" goes. */
export function AllArchivedSessions() {
  const sessions = useHubState((state) => state.sessions)
  const groups = useMemo(
    () =>
      sessions === null
        ? null
        : groupByRepo(
            sessions.filter((session) => session.archived !== undefined),
            lastDeletedFirst,
          ),
    [sessions],
  )

  return (
    <main {...stylex.props(styles.view)}>
      <PageHeader
        title="Archived Sessions"
        description="Deleted Sessions, by Repo. They can be restored until they're purged."
      />
      <div {...stylex.props(styles.scroll)}>
        <div {...stylex.props(styles.page)}>
          {groups === null ? (
            <Loading />
          ) : groups.length === 0 ? (
            <EmptyState
              size="page"
              icon={<InboxIcon />}
              title="Nothing archived"
              description="Deleted Sessions show here until they're purged."
            />
          ) : (
            groups.map(({ repo, sessions: archived }) => (
              <section key={repo} aria-label={repo} {...stylex.props(styles.group)}>
                <h2 {...stylex.props(styles.repo)}>
                  <Link
                    to="/repos/$owner/$repo/archived"
                    params={repoParams(repo)}
                    {...stylex.props(styles.repoLink, focus.ring)}
                  >
                    {repo}
                  </Link>
                </h2>
                <ArchivedList label={`Archived Sessions of ${repo}`} sessions={archived} />
              </section>
            ))
          )}
        </div>
      </div>
    </main>
  )
}

const lastDeletedFirst = (a: SessionSummary, b: SessionSummary) =>
  (b.archived?.at ?? 0) - (a.archived?.at ?? 0)

/** The Archived ones, the most recently deleted first. */
function newestArchived(sessions: ReadonlyArray<SessionSummary>): Array<SessionSummary> {
  return sessions.filter((session) => session.archived !== undefined).toSorted(lastDeletedFirst)
}

function Loading() {
  return (
    <div {...stylex.props(styles.loading)}>
      <Spinner size="lg" label="Loading Sessions" />
    </div>
  )
}

function ArchivedList({
  label,
  sessions,
}: {
  label: string
  sessions: ReadonlyArray<SessionSummary>
}) {
  const hub = useHub()
  return (
    <ul aria-label={label} {...stylex.props(styles.list)}>
      {sessions.map((session, index) => (
        <ArchivedRow key={session.id} session={session} first={index === 0} hub={hub} />
      ))}
    </ul>
  )
}

function ArchivedRow({
  session,
  first,
  hub,
}: {
  session: SessionSummary
  first: boolean
  hub: HubClient
}) {
  const archived = session.archived
  if (archived === undefined) return null
  return (
    <li {...stylex.props(styles.row, first && styles.firstRow)}>
      <div {...stylex.props(styles.main)}>
        <Link
          to="/sessions/$sessionId"
          params={{ sessionId: session.id }}
          {...stylex.props(styles.branch, focus.ring)}
        >
          <BranchIcon />
          {sessionTitle(session)}
        </Link>
        <div {...stylex.props(styles.meta)}>
          <Avatar name={archived.by.name} src={archived.by.avatarUrl} size="sm" />
          <span>
            Deleted by {archived.by.name} {timeAgo(archived.at)}
          </span>
          <span aria-hidden="true">·</span>
          <span title={day(archived.purgeAt)}>Purged {purgedIn(archived.purgeAt)}</span>
        </div>
      </div>
      <Button
        size="sm"
        aria-label={`Restore ${sessionTitle(session)}`}
        onClick={() => restoreSession(hub, session.id)}
      >
        Restore
      </Button>
    </li>
  )
}

/** Restores an Archived Session, saying so, or that the Hub isn't connected. */
export function restoreSession(hub: HubClient, sessionId: SessionId): void {
  if (!hub.restoreSession(sessionId)) {
    toast.show({ title: "Not connected to the Hub", intent: "warning" })
    return
  }
  toast.show({ title: "Session restored", description: "It's Asleep: the next prompt wakes it." })
}
