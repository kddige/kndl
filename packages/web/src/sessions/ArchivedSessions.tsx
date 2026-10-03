import type { SessionId, SessionSummary } from "@claude-hub/protocol"
import * as stylex from "@stylexjs/stylex"
import { Link } from "@tanstack/react-router"
import { useMemo } from "react"
import { day, purgedIn, timeAgo } from "../app/format.ts"
import { useHub, useHubState } from "../app/hub.tsx"
import type { HubClient } from "../hub/client.ts"
import {
  ArrowLeftIcon,
  Avatar,
  BranchIcon,
  Button,
  EmptyState,
  InboxIcon,
  Spinner,
  toast,
} from "../ui/index.ts"
import { focus } from "../ui/shared.ts"
import { color, font, leading, radius, space, text, tracking, weight } from "../ui/tokens.stylex.ts"

const styles = stylex.create({
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
  top: { display: "flex", alignItems: "center", gap: space.s3 },
  title: {
    fontSize: text.xl,
    fontWeight: weight.semibold,
    letterSpacing: tracking.tight,
    lineHeight: leading.tight,
  },
  note: { color: color.textMuted, fontSize: text.sm },
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
  const hub = useHub()
  const sessions = useHubState((state) => state.sessions)
  const archived = useMemo(
    () =>
      sessions === null
        ? null
        : sessions
            .filter((session) => session.repo === repo && session.archived !== undefined)
            .toSorted((a, b) => (b.archived?.at ?? 0) - (a.archived?.at ?? 0)),
    [sessions, repo],
  )

  return (
    <div {...stylex.props(styles.scroll)}>
      <main {...stylex.props(styles.page)}>
        <div {...stylex.props(styles.top)}>
          <Button
            nativeButton={false}
            render={<Link to="/" />}
            intent="ghost"
            size="sm"
            icon={<ArrowLeftIcon />}
            aria-label="All Sessions"
          />
          <div>
            <h1 {...stylex.props(styles.title)}>Archived Sessions</h1>
            <p {...stylex.props(styles.note)}>
              {repo}: deleted Sessions can be restored until they're purged.
            </p>
          </div>
        </div>
        {archived === null ? (
          <div {...stylex.props(styles.loading)}>
            <Spinner size="lg" label="Loading Sessions" />
          </div>
        ) : archived.length === 0 ? (
          <EmptyState
            size="page"
            icon={<InboxIcon />}
            title="Nothing archived"
            description={`Sessions deleted from ${repo} show here until they're purged.`}
          />
        ) : (
          <ul aria-label="Archived Sessions" {...stylex.props(styles.list)}>
            {archived.map((session, index) => (
              <ArchivedRow key={session.id} session={session} first={index === 0} hub={hub} />
            ))}
          </ul>
        )}
      </main>
    </div>
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
          {session.workBranch}
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
        aria-label={`Restore ${session.workBranch}`}
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
