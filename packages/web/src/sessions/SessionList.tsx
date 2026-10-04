import type { RunnerSummary, SessionSummary } from "@claude-hub/protocol"
import * as stylex from "@stylexjs/stylex"
import { Link } from "@tanstack/react-router"
import { useMemo } from "react"
import { environmentChanged, repoParams, statusOf, timeAgo } from "../app/format.ts"
import { useHubState } from "../app/hub.tsx"
import { isListed } from "../hub/store.ts"
import {
  Avatar,
  Badge,
  BoxIcon,
  BranchIcon,
  Button,
  EmptyState,
  InboxIcon,
  KeyIcon,
  SessionStatus,
  Spinner,
  TrashIcon,
} from "../ui/index.ts"
import { focus } from "../ui/shared.ts"
import { color, font, leading, radius, space, text, tracking, weight } from "../ui/tokens.stylex.ts"
import { CreateSessionDialog } from "./CreateSessionDialog.tsx"

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
  top: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: space.s3,
    flexWrap: "wrap",
  },
  title: {
    fontSize: text.xl,
    fontWeight: weight.semibold,
    letterSpacing: tracking.tight,
    lineHeight: leading.tight,
  },
  runners: { color: color.textMuted, fontSize: text.sm },
  list: {
    display: "flex",
    flexDirection: "column",
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
    rowGap: space.s1,
    paddingBlock: space.s3,
    paddingInline: space.s4,
    color: color.text,
    textDecoration: "none",
    backgroundColor: { default: "transparent", ":hover": color.surfaceHover },
    borderTopWidth: "1px",
    borderTopStyle: "solid",
    borderTopColor: color.border,
  },
  firstRow: { borderTopWidth: 0 },
  main: { display: "flex", flexDirection: "column", gap: space.s1, minWidth: 0 },
  repoLine: { display: "flex", alignItems: "center", gap: space.s2, minWidth: 0 },
  repo: {
    fontWeight: weight.medium,
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
    minWidth: 0,
  },
  branch: {
    display: "inline-flex",
    alignItems: "center",
    gap: space.s1,
    fontFamily: font.mono,
    fontSize: text.xs,
  },
  dot: { color: color.textSubtle },
  side: {
    display: "flex",
    alignItems: "center",
    gap: space.s3,
    color: color.textMuted,
    fontSize: text.sm,
  },
  working: {
    display: "inline-flex",
    alignItems: "center",
    gap: space.s1_5,
    color: color.textMuted,
    fontSize: text.sm,
  },
  loading: { display: "grid", placeItems: "center", paddingBlock: space.s16 },
  headerActions: { display: "flex", alignItems: "center", gap: space.s2, flexWrap: "wrap" },
  repoLinks: {
    display: "flex",
    flexWrap: "wrap",
    gap: space.s3,
    margin: 0,
    padding: 0,
    listStyle: "none",
  },
  repoLink: {
    display: "inline-flex",
    alignItems: "center",
    gap: space.s1_5,
    color: color.textMuted,
    fontSize: text.sm,
    textDecoration: { default: "none", ":hover": "underline" },
    borderRadius: radius.sm,
  },
})

/**
 * Every Session the Hub lists but the Archived ones, newest first, with its state, Runner and who
 * started it; then a way to each Repo's Environment and Archived Sessions.
 */
export function SessionList() {
  const sessions = useHubState((state) => state.sessions)
  const runners = useHubState((state) => state.runners)
  const sorted = useMemo(
    () =>
      sessions ? sessions.filter(isListed).toSorted((a, b) => b.createdAt - a.createdAt) : null,
    [sessions],
  )
  const archivedByRepo = useMemo(() => {
    const counts = new Map<string, number>()
    for (const session of sessions ?? []) {
      if (!isListed(session)) counts.set(session.repo, (counts.get(session.repo) ?? 0) + 1)
    }
    return [...counts].toSorted(([a], [b]) => a.localeCompare(b))
  }, [sessions])
  const repos = useMemo(
    () => [...new Set((sessions ?? []).map((session) => session.repo))].toSorted(),
    [sessions],
  )
  const runnersById = useMemo(
    () => new Map((runners ?? []).map((runner) => [runner.id as string, runner])),
    [runners],
  )
  const online = (runners ?? []).filter((runner) => runner.isOnline).length

  return (
    <div {...stylex.props(styles.scroll)}>
      <main {...stylex.props(styles.page)}>
        <div {...stylex.props(styles.top)}>
          <div>
            <h1 {...stylex.props(styles.title)}>Sessions</h1>
            {runners && (
              <p {...stylex.props(styles.runners)}>
                {online} of {runners.length} {runners.length === 1 ? "Runner" : "Runners"} online
              </p>
            )}
          </div>
          <div {...stylex.props(styles.headerActions)}>
            <Button nativeButton={false} render={<Link to="/variables" />} icon={<KeyIcon />}>
              Shared variables
            </Button>
            <CreateSessionDialog />
          </div>
        </div>
        {sorted === null ? (
          <div {...stylex.props(styles.loading)}>
            <Spinner size="lg" label="Loading Sessions" />
          </div>
        ) : sorted.length === 0 ? (
          <EmptyState
            size="page"
            icon={<InboxIcon />}
            title="No Sessions yet"
            description="Start one on any Repo you can access. Everyone with access can join it."
          />
        ) : (
          <nav aria-label="Sessions" {...stylex.props(styles.list)}>
            {sorted.map((session, index) => (
              <SessionRow
                key={session.id}
                session={session}
                runner={runnersById.get(session.runnerId)}
                first={index === 0}
              />
            ))}
          </nav>
        )}
        {repos.length > 0 && (
          <ul aria-label="Environments" {...stylex.props(styles.repoLinks)}>
            {repos.map((repo) => (
              <li key={repo}>
                <Link
                  to="/repos/$owner/$repo/environment"
                  params={repoParams(repo)}
                  {...stylex.props(styles.repoLink, focus.ring)}
                >
                  <BoxIcon />
                  Environment of {repo}
                </Link>
              </li>
            ))}
          </ul>
        )}
        {archivedByRepo.length > 0 && (
          <ul aria-label="Archived Sessions" {...stylex.props(styles.repoLinks)}>
            {archivedByRepo.map(([repo, n]) => (
              <li key={repo}>
                <Link
                  to="/repos/$owner/$repo/archived"
                  params={repoParams(repo)}
                  {...stylex.props(styles.repoLink, focus.ring)}
                >
                  <TrashIcon />
                  {n} archived in {repo}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </main>
    </div>
  )
}

function SessionRow({
  session,
  runner,
  first,
}: {
  session: SessionSummary
  runner: RunnerSummary | undefined
  first: boolean
}) {
  return (
    <Link
      to="/sessions/$sessionId"
      params={{ sessionId: session.id }}
      {...stylex.props(styles.row, first && styles.firstRow, focus.ringInset)}
    >
      <div {...stylex.props(styles.main)}>
        <div {...stylex.props(styles.repoLine)}>
          <span {...stylex.props(styles.repo)}>{session.repo}</span>
          <SessionStatus state={statusOf(session.state)} />
          {environmentChanged(session) && <Badge intent="warning">Environment changed</Badge>}
        </div>
        <div {...stylex.props(styles.meta)}>
          <span {...stylex.props(styles.branch)}>
            <BranchIcon />
            {session.workBranch}
          </span>
          <span aria-hidden="true" {...stylex.props(styles.dot)}>
            ·
          </span>
          <span title={`Runs on ${session.runnerLogin.account}'s Claude login`}>
            {runner?.name ?? "Unknown Runner"} ({session.runnerLogin.account})
          </span>
        </div>
      </div>
      <div {...stylex.props(styles.side)}>
        {session.restarting !== undefined || session.starting !== undefined ? (
          <span {...stylex.props(styles.working)}>
            <Spinner size="sm" />
            {session.restarting ? "Restarting" : "Starting"}
          </span>
        ) : (
          session.currentTurn !== null && (
            <span {...stylex.props(styles.working)}>
              <Spinner size="sm" />
              Working
            </span>
          )
        )}
        <span>{timeAgo(session.createdAt)}</span>
        <Avatar name={session.creator.name} src={session.creator.avatarUrl} size="sm" />
      </div>
    </Link>
  )
}
