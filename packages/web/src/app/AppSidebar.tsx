import { MaxSessionNameLength, type SessionSummary, sessionTitle } from "@claude-hub/protocol"
import * as stylex from "@stylexjs/stylex"
import { Link, useParams, useRouterState } from "@tanstack/react-router"
import { useMemo, useState } from "react"
import { isListed } from "../hub/store.ts"
import { CreateSessionDialog } from "../sessions/CreateSessionDialog.tsx"
import { groupByRepo } from "../sessions/groups.ts"
import { renameSession } from "../sessions/rename.ts"
import {
  ArchiveIcon,
  Avatar,
  BoxIcon,
  CloseIcon,
  IconButton,
  InlineEdit,
  KeyIcon,
  Menu,
  MenuGroup,
  MenuItem,
  MoreIcon,
  NavItem,
  NavSection,
  NavSlot,
  PencilIcon,
  PlusIcon,
  ServerIcon,
  SessionStatus,
  Sidebar,
  Spinner,
  WarningIcon,
} from "../ui/index.ts"
import { focus } from "../ui/shared.ts"
import { color, radius, space, text, tracking, weight } from "../ui/tokens.stylex.ts"
import { environmentChanged, statusOf } from "./format.ts"
import { useHub, useHubState } from "./hub.tsx"

const styles = stylex.create({
  brand: {
    flex: 1,
    fontSize: text.md,
    fontWeight: weight.semibold,
    letterSpacing: tracking.tight,
    color: color.text,
    textDecoration: "none",
    borderRadius: radius.sm,
  },
  note: {
    paddingBlock: space.s1,
    paddingInline: space.s2,
    color: color.textSubtle,
    fontSize: text.sm,
  },
  runners: {
    paddingInline: space.s2,
    color: color.textMuted,
    fontSize: text.sm,
  },
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
      ":hover": color.surfaceHover,
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
  more: { flexShrink: 0, color: color.textSubtle },
  warning: { display: "inline-flex", color: color.warning },
  busy: { display: "inline-flex", color: color.textMuted },
})

/** The Hub-wide page the sidebar's general nav marks as current, from the path. */
function sectionOf(pathname: string): "runners" | "environments" | "variables" | "archive" | null {
  if (pathname === "/runners") return "runners"
  if (pathname === "/environments" || /^\/repos\/[^/]+\/[^/]+\/environment$/.test(pathname))
    return "environments"
  if (pathname === "/variables") return "variables"
  if (pathname === "/archive" || /^\/repos\/[^/]+\/[^/]+\/archived$/.test(pathname))
    return "archive"
  return null
}

/**
 * The app's sidebar: New Session, the Hub-wide pages, every listed Session under its Repo's name
 * in the order they were created, and the Runners and the signed-in person at the bottom.
 * `onClose` adds a close button, for a drawer.
 */
export function AppSidebar({ onClose }: { onClose?: () => void }) {
  const hub = useHub()
  const sessions = useHubState((state) => state.sessions)
  const runners = useHubState((state) => state.runners)
  const you = useHubState((state) => state.you)
  const pathname = useRouterState({ select: (state) => state.location.pathname })
  const { sessionId } = useParams({ strict: false })
  const section = sectionOf(pathname)

  const groups = useMemo(
    () => (sessions ? groupByRepo(sessions.filter(isListed)) : null),
    [sessions],
  )
  const online = (runners ?? []).filter((runner) => runner.isOnline).length

  return (
    <Sidebar
      label="Main"
      header={
        <>
          <Link to="/" {...stylex.props(styles.brand, focus.ring)}>
            Claude Hub
          </Link>
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
            <p {...stylex.props(styles.runners)}>
              {online} of {runners.length} {runners.length === 1 ? "Runner" : "Runners"} online
            </p>
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
                <MenuItem
                  onClick={() => {
                    void hub.transport.signOut().finally(() => hub.retry())
                  }}
                >
                  Sign out
                </MenuItem>
              </MenuGroup>
            </Menu>
          )}
        </>
      }
    >
      <NavSection>
        <NavItem
          render={<Link to="/runners" />}
          icon={<ServerIcon />}
          current={section === "runners"}
        >
          Runners
        </NavItem>
        <NavItem
          render={<Link to="/environments" />}
          icon={<BoxIcon />}
          current={section === "environments"}
        >
          Environments
        </NavItem>
        <NavItem
          render={<Link to="/variables" />}
          icon={<KeyIcon />}
          current={section === "variables"}
        >
          Shared variables
        </NavItem>
        <NavItem
          render={<Link to="/archive" />}
          icon={<ArchiveIcon />}
          current={section === "archive"}
        >
          Archived Sessions
        </NavItem>
      </NavSection>
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
          <NavSection key={group.repo} label={group.repo}>
            {group.sessions.map((session) => (
              <SessionRow key={session.id} session={session} current={session.id === sessionId} />
            ))}
          </NavSection>
        ))
      )}
    </Sidebar>
  )
}

/**
 * A Session in the sidebar: its state's dot, its Session name (or Work branch) and what it's busy
 * with, leading to it. Its Rename button turns the row into a field for the name.
 */
function SessionRow({ session, current }: { session: SessionSummary; current: boolean }) {
  const hub = useHub()
  const [renaming, setRenaming] = useState(false)
  const title = sessionTitle(session)
  return (
    <NavItem
      render={<Link to="/sessions/$sessionId" params={{ sessionId: session.id }} />}
      icon={<SessionStatus state={statusOf(session.state)} variant="dot" />}
      current={current}
      title={session.name === undefined ? title : `${title} · ${session.workBranch}`}
      trailing={<SessionIndicators session={session} />}
      action={
        <IconButton label={`Rename ${title}`} size="sm" onClick={() => setRenaming(true)}>
          <PencilIcon />
        </IconButton>
      }
      {...(renaming && {
        editor: (
          <InlineEdit
            label="Session name"
            defaultValue={title}
            placeholder={session.workBranch}
            maxLength={MaxSessionNameLength}
            onCommit={(typed) => {
              setRenaming(false)
              renameSession(hub, session, typed)
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

/** What a Session is busy with, and whether its Environment changed, in the row's rail. */
function SessionIndicators({ session }: { session: SessionSummary }) {
  const busy =
    session.restarting !== undefined
      ? "Restarting"
      : session.starting !== undefined
        ? "Starting"
        : session.currentTurn !== null
          ? "Working"
          : null
  const changed = environmentChanged(session)
  if (busy === null && !changed) return null
  return (
    <>
      {busy && (
        <NavSlot>
          <span role="img" aria-label={busy} title={busy} {...stylex.props(styles.busy)}>
            <Spinner size="sm" />
          </span>
        </NavSlot>
      )}
      {changed && (
        <NavSlot>
          <span
            role="img"
            aria-label="Environment changed"
            title="Environment changed: a restart picks it up"
            {...stylex.props(styles.warning)}
          >
            <WarningIcon />
          </span>
        </NavSlot>
      )}
    </>
  )
}
