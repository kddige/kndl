import {
  type AgentSummary,
  describeBuild,
  MaxSessionNameLength,
  type SessionId,
  type SessionSummary,
  sessionTitle,
} from "@kndl/protocol"
import * as stylex from "@stylexjs/stylex"
import { Link, useParams, useRouterState, useSearch } from "@tanstack/react-router"
import { useEffect, useMemo, useState } from "react"
import { isListed } from "../hub/store.ts"
import { recentAgents } from "../hub/transcript.ts"
import { useDrives } from "../session/drive.ts"
import { keptAwakeText } from "../session/keepAwake.ts"
import { WaitingDot } from "../session/QuestionChip.tsx"
import { CreateSessionDialog } from "../sessions/CreateSessionDialog.tsx"
import { setFolded, useFolded } from "../sessions/folds.ts"
import { groupByRepo } from "../sessions/groups.ts"
import { renameSession } from "../sessions/rename.ts"
import { onRenameRequest } from "../sessions/renameRequests.ts"
import {
  AgentStatus,
  ArchiveIcon,
  Avatar,
  CloseIcon,
  IconButton,
  InlineEdit,
  Menu,
  MenuGroup,
  MenuItem,
  MenuSeparator,
  MoreIcon,
  NavItem,
  NavSection,
  NavSlot,
  type NestedNavItems,
  PlusIcon,
  SettingsIcon,
  SessionStatus,
  Sidebar,
  Spinner,
  SunIcon,
  WarningIcon,
} from "../ui/index.ts"
import { focus } from "../ui/shared.ts"
import { color, font, radius, space, text } from "../ui/tokens.stylex.ts"
import { useRovingRows } from "../ui/useRovingRows.ts"
import { Brand } from "./Brand.tsx"
import { SearchButton } from "./commands.tsx"
import { counted, environmentChanged, mcpServersChanged, statusOf } from "./format.ts"
import { useHub, useHubState } from "./hub.tsx"
import { isSettingsPath, lastSettingsPath, useRememberPlace } from "./lastPlaces.ts"
import { RepoMenu } from "./RepoMenu.tsx"
import { SessionRowMenuItems } from "./SessionRowMenu.tsx"
import { SettingsSidebar } from "./SettingsSidebar.tsx"

// Hover styles only where a pointer can hover: on touch, :hover sticks after a tap.
const HOVER = "@media (hover: hover)"

const styles = stylex.create({
  // The Repo groups, spaced as the nav spaces its sections.
  sessions: { display: "flex", flexDirection: "column", gap: space.s4 },
  note: {
    paddingBlock: space.s1,
    paddingInline: space.s2,
    color: color.textSecondary,
    fontSize: text.sm,
  },
  // Its count changes as Runners connect: figures of one width keep the line still.
  runners: {
    display: "flex",
    alignItems: "center",
    gap: space.s2,
    paddingInline: space.s2,
    borderRadius: radius.sm,
    color: { default: color.textSecondary, ":hover": color.text },
    fontSize: text.sm,
    fontVariantNumeric: "tabular-nums",
    textDecoration: "none",
  },
  runnersDot: (allOnline: boolean) => ({
    width: "0.375rem",
    height: "0.375rem",
    borderRadius: radius.full,
    backgroundColor: allOnline ? color.success : color.warning,
  }),
  version: { fontFamily: font.mono, userSelect: "text" },
  you: {
    display: "flex",
    alignItems: "center",
    gap: space.s2,
    width: "100%",
    minHeight: "2.25rem",
    paddingInline: space.s2,
    borderWidth: 0,
    borderRadius: radius.md,
    backgroundColor: {
      default: "transparent",
      ":hover": { default: null, [HOVER]: color.surfaceHover },
      "[data-popup-open]": color.surfaceHover,
    },
    color: color.text,
    fontSize: text.base,
    textAlign: "start",
    cursor: "pointer",
  },
  name: {
    flex: 1,
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  more: { flexShrink: 0, color: color.textTertiary },
  warning: { display: "inline-flex", color: color.warning },
  busy: { display: "inline-flex", color: color.textSecondary },
  keptAwake: { display: "inline-flex", color: color.textSecondary },
  waiting: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    width: "1rem",
  },
})

/**
 * The app's sidebar: New Session, the Hub-wide pages, every listed Session under its Repo's name
 * in the order they were created, and the Runners and the signed-in person at the bottom. A
 * Session's subagents are under its row, which folds them away (ADR 0014): the Running and
 * Interrupted ones, and for the open Session its latest finished ones too. `onClose` adds a close button,
 * for a drawer.
 */
export function AppSidebar({ onClose }: { onClose?: () => void }) {
  const hub = useHub()
  const sessions = useHubState((state) => state.sessions)
  const runners = useHubState((state) => state.runners)
  const you = useHubState((state) => state.you)
  const hubVersion = useHubState((state) => state.hubVersion)
  const pathname = useRouterState({ select: (state) => state.location.pathname })
  const { sessionId } = useParams({ strict: false })
  const { agent: agentId } = useSearch({ strict: false })
  // Archived Sessions is the one Sessions page in the pinned rows; the rest are Settings'.
  const archive = pathname === "/archive" || /^\/repos\/[^/]+\/[^/]+\/archived$/.test(pathname)
  useRememberPlace(pathname)

  const groups = useMemo(
    () => (sessions ? groupByRepo(sessions.filter(isListed)) : null),
    [sessions],
  )
  const known = useMemo(() => new Set((sessions ?? []).map((session) => session.id)), [sessions])
  const folded = useFolded()
  // The open Session's agents, finished ones too, from its transcript.
  const openAgents = useHubState((state) =>
    sessionId === undefined
      ? undefined
      : state.joined[sessionId as SessionId]?.transcript.agentList,
  )
  // When an agent's view opens, its folded Session opens, so its row isn't hidden.
  useEffect(() => {
    if (sessionId !== undefined && agentId !== undefined) setFolded(sessionId, false)
  }, [sessionId, agentId])
  const online = (runners ?? []).filter((runner) => runner.isOnline).length
  // Before the early return below: hooks run on every render.
  const [list, setList] = useState<HTMLDivElement | null>(null)
  const onListKeyDown = useRovingRows(list)

  // On a settings page, Settings takes the sidebar over (#398).
  if (isSettingsPath(pathname)) return <SettingsSidebar {...(onClose && { onClose })} />

  return (
    <Sidebar
      label="Main"
      aboveFooter={
        // Settings is a place of its own; Archived Sessions lists Sessions, so it stays here.
        <NavSection>
          <NavItem render={<Link to={lastSettingsPath()} />} icon={<SettingsIcon />}>
            Settings
          </NavItem>
          <NavItem render={<Link to="/archive" />} icon={<ArchiveIcon />} current={archive}>
            Archived Sessions
          </NavItem>
        </NavSection>
      }
      header={
        <>
          <Brand />
          <SearchButton />
          <CreateSessionDialog
            trigger={
              <IconButton label="New Session" size="sm">
                <PlusIcon />
              </IconButton>
            }
          />
          {onClose && (
            <IconButton label="Close navigation" size="sm" noTooltip onClick={onClose}>
              <CloseIcon />
            </IconButton>
          )}
        </>
      }
      footer={
        <>
          {runners && (
            // Ambient status that's also the way to the Runners.
            <Link to="/runners" {...stylex.props(styles.runners, focus.ring)}>
              <span {...stylex.props(styles.runnersDot(online === runners.length))} />
              {online} of {counted(runners.length, { one: "Runner", other: "Runners" })} online
            </Link>
          )}
          {you && (
            <Menu
              side="top"
              trigger={
                <button
                  type="button"
                  aria-label={`Signed in as ${you.name}`}
                  {...stylex.props(styles.you, focus.ringInset)}
                >
                  <Avatar name={you.name} src={you.avatarUrl} size="sm" />
                  <span {...stylex.props(styles.name)}>{you.name}</span>
                  <MoreIcon {...stylex.props(styles.more)} />
                </button>
              }
            >
              <MenuGroup label={`${you.name} (@${you.login})`}>
                <MenuItem render={<Link to="/account" />}>Account</MenuItem>
                <MenuItem
                  onClick={() => {
                    void hub.transport.signOut().finally(() => hub.retry())
                  }}
                >
                  Sign out
                </MenuItem>
              </MenuGroup>
              {hubVersion && (
                <>
                  <MenuSeparator />
                  {/* The kndl the Hub runs, whole: what to quote in a bug report. */}
                  <MenuGroup
                    label={
                      <span {...stylex.props(styles.version)}>
                        kndl {describeBuild(hubVersion)}
                      </span>
                    }
                  >
                    {null}
                  </MenuGroup>
                </>
              )}
            </Menu>
          )}
        </>
      }
    >
      {/* The Sessions are one Tab stop; arrow keys move between them (#400). */}
      <div ref={setList} onKeyDown={onListKeyDown} {...stylex.props(styles.sessions)}>
        {groups === null ? (
          <NavSection>
            <li {...stylex.props(styles.note)}>
              <Spinner size="sm" label="Loading Sessions" />
            </li>
          </NavSection>
        ) : groups.length === 0 ? (
          <NavSection>
            <li {...stylex.props(styles.note)}>No Sessions yet</li>
          </NavSection>
        ) : (
          // Each Repo is a section of its own, under its name.
          groups.map((group) => (
            <NavSection key={group.repo} label={group.repo} action={<RepoMenu repo={group.repo} />}>
              {group.sessions.map((session) => {
                const current = session.id === sessionId
                // The open Session's log, once it has come, has every agent the summary lists.
                const agents =
                  current && openAgents !== undefined && openAgents.length > 0
                    ? recentAgents(openAgents, agentId)
                    : (session.agents ?? [])
                return (
                  <SessionRow
                    key={session.id}
                    session={session}
                    current={current && agentId === undefined}
                    {...(agents.length > 0 && {
                      nested: {
                        open: !folded.has(session.id),
                        onOpenChange: (open) => setFolded(session.id, !open, known),
                        children: agents.map((agent) => (
                          <AgentRow
                            key={agent.id}
                            session={session}
                            agent={agent}
                            current={current && agent.id === agentId}
                          />
                        )),
                      },
                    })}
                  />
                )
              })}
            </NavSection>
          ))
        )}
      </div>
    </Sidebar>
  )
}

/**
 * A Session in the sidebar: its state's dot, its Session name (or Work branch) and what it's busy
 * with, leading to it. Its Rename button, its Creator's alone (ADR 0026), turns the row into a
 * field for the name. Its agents' rows are `nested` under it.
 */
function SessionRow({
  session,
  current,
  nested,
}: {
  session: SessionSummary
  current: boolean
  nested?: Omit<NestedNavItems, "label">
}) {
  const hub = useHub()
  const drives = useDrives(session)
  const [renaming, setRenaming] = useState(false)
  useEffect(() => onRenameRequest(session.id, () => setRenaming(true)), [session.id])
  const title = sessionTitle(session)
  const menu = <SessionRowMenuItems session={session} />
  return (
    <NavItem
      // Exact, so the Link doesn't mark itself current while one of its agents' views is open.
      render={
        <Link
          to="/sessions/$sessionId"
          params={{ sessionId: session.id }}
          activeOptions={{ exact: true }}
        />
      }
      icon={<SessionStatus state={statusOf(session.state)} variant="dot" />}
      current={current}
      title={session.name === undefined ? title : `${title} · ${session.workBranch}`}
      trailing={<SessionIndicators session={session} />}
      {...(nested && { nested: { ...nested, label: `Agents of ${title}` } })}
      // The same menu on a pointer's ⋯ (no Tab stop of its own: the list is one) and on a
      // right-click, Shift+F10 or the Menu key.
      action={
        <Menu
          align="end"
          trigger={
            <IconButton label={`${title} actions`} size="sm" tabIndex={-1}>
              <MoreIcon />
            </IconButton>
          }
        >
          {menu}
        </Menu>
      }
      contextMenu={menu}
      {...(drives && { onRename: () => setRenaming(true) })}
      {...(drives &&
        renaming && {
          editor: (
            <InlineEdit
              label="Session name"
              defaultValue={title}
              placeholder={session.workBranch}
              maxLength={MaxSessionNameLength}
              // A rename that isn't sent keeps the field open, with what was typed.
              onCommit={(typed) => {
                const sent = renameSession(hub, session, typed)
                if (sent) setRenaming(false)
                return sent
              }}
              onCancel={() => setRenaming(false)}
            />
          ),
        })}
    >
      {title}
    </NavItem>
  )
}

/** A subagent under its Session's row: its status's dot and description, leading to its view. */
function AgentRow({
  session,
  agent,
  current,
}: {
  session: SessionSummary
  agent: AgentSummary
  current: boolean
}) {
  return (
    <NavItem
      render={
        <Link
          to="/sessions/$sessionId"
          params={{ sessionId: session.id }}
          search={{ agent: agent.id }}
        />
      }
      icon={<AgentStatus status={agent.status} variant="dot" />}
      current={current}
      title={`${agent.description} · ${agent.status}`}
    >
      {agent.description || agent.id}
    </NavItem>
  )
}

/**
 * What a Session is busy with, and whether its Environment changed, in the row's rail. A Session
 * with a Running agent is working even between Turns.
 */
function SessionIndicators({ session }: { session: SessionSummary }) {
  const you = useHubState((state) => state.you)
  const busy =
    session.restarting !== undefined
      ? "Restarting"
      : session.starting !== undefined
        ? "Starting"
        : session.currentTurn !== null
          ? "Working"
          : session.agents?.some((agent) => agent.status === "Running") === true
            ? "Agents working"
            : null
  // The agent asked a question (#193): it waits on its Creator to answer rather than working.
  const waiting = session.openQuestion !== undefined
  const waitingOn = session.creator.id === you?.id ? "you" : session.creator.name
  // What a restart would apply: a newer Environment, or its Repo's Installations (ADR 0020).
  const changed = environmentChanged(session)
    ? "Environment changed"
    : mcpServersChanged(session)
      ? "MCP servers changed"
      : null
  const keptAwake =
    session.keepAwake === undefined ? null : keptAwakeText(session.keepAwake, you?.id)
  if (busy === null && !waiting && changed === null && keptAwake === null) return null
  return (
    <>
      {keptAwake && (
        <NavSlot>
          <span
            role="img"
            aria-label={keptAwake}
            title={keptAwake}
            {...stylex.props(styles.keptAwake)}
          >
            <SunIcon />
          </span>
        </NavSlot>
      )}
      {waiting ? (
        <NavSlot>
          <span
            role="img"
            aria-label={`Waiting on ${waitingOn}`}
            title={`Waiting on ${waitingOn}: the agent asked a question`}
            {...stylex.props(styles.waiting)}
          >
            <WaitingDot />
          </span>
        </NavSlot>
      ) : (
        busy && (
          <NavSlot>
            <span role="img" aria-label={busy} title={busy} {...stylex.props(styles.busy)}>
              <Spinner size="sm" />
            </span>
          </NavSlot>
        )
      )}
      {changed && (
        <NavSlot>
          <span
            role="img"
            aria-label={changed}
            title={`${changed}: a restart picks it up`}
            {...stylex.props(styles.warning)}
          >
            <WarningIcon />
          </span>
        </NavSlot>
      )}
    </>
  )
}
