// The Session view's chrome, chat first (#397): a title strip over the conversation, the Session's
// actions in one menu, its controls at the Composer, its subagents as chips, and the terminal as a
// sheet under the conversation.

import { type AgentId, type SessionSummary, sessionTitle } from "@kndl/protocol"
import * as stylex from "@stylexjs/stylex"
import type { ReactNode } from "react"
import { statusOf } from "../app/format.ts"
import type { JoinedSession } from "../hub/store.ts"
import {
  AgentStatus,
  Badge,
  Button,
  CloseIcon,
  CompactIcon,
  IconButton,
  Menu,
  MenuItem,
  MenuSeparator,
  MoreIcon,
  PencilIcon,
  RestartIcon,
  SessionStatus,
  SunIcon,
  textRole,
  TrashIcon,
  useMediaQuery,
  usePageBar,
  WIDE,
} from "../ui/index.ts"
import { srOnly } from "../ui/shared.ts"
import { color, radius, space, text } from "../ui/tokens.stylex.ts"
import { OpenPorts } from "./OpenPorts.tsx"
import { Presence } from "./Presence.tsx"
import { WaitingDot } from "./QuestionChip.tsx"
import { SessionMcpServers } from "./SessionMcpServers.tsx"

const styles = stylex.create({
  // The strip and the chips share the transcript's column, so everything lines up on one edge.
  column: {
    width: "100%",
    maxWidth: "48rem",
    marginInline: "auto",
    paddingInline: space.s4,
  },
  strip: {
    flexShrink: 0,
    display: "flex",
    flexDirection: "column",
    gap: space.s0_5,
    paddingBlock: space.s1,
  },
  titleRow: {
    display: "flex",
    alignItems: "center",
    gap: space.s2,
    minHeight: "2rem",
  },
  crumbs: {
    display: "flex",
    alignItems: "center",
    gap: space.s1_5,
    flex: 1,
    minWidth: 0,
  },
  // Narrow, the title keeps the room: the Repo is on the meta line too.
  repo: {
    display: { default: "none", "@media (min-width: 48rem)": "inline" },
    flexShrink: 0,
    color: color.textSecondary,
    fontSize: text.base,
    whiteSpace: "nowrap",
  },
  sep: {
    display: { default: "none", "@media (min-width: 48rem)": "inline" },
    color: color.textTertiary,
  },
  title: {
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    // Focus lands here when the page opens; it isn't a control, so it shows no ring.
    outline: "none",
  },
  status: { display: "inline-flex", alignItems: "center", gap: space.s1, flexShrink: 0 },
  end: { display: "flex", alignItems: "center", gap: space.s1, flexShrink: 0 },
  meta: { color: color.textSecondary },
  // The Repo leads the meta line only where the breadcrumb hides it.
  narrowOnly: { display: { default: "inline", "@media (min-width: 48rem)": "none" } },
  chips: {
    display: "flex",
    alignItems: "center",
    gap: space.s1,
    overflowX: "auto",
    scrollbarWidth: "none",
    paddingTop: space.s2,
  },
  chip: {
    display: "inline-flex",
    alignItems: "center",
    gap: space.s1_5,
    flexShrink: 0,
    maxWidth: "16rem",
    height: "1.75rem",
    paddingInline: space.s2,
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: color.border,
    borderRadius: radius.full,
    backgroundColor: {
      default: color.surface,
      ":hover": { default: null, "@media (hover: hover)": color.surfaceHover },
    },
    color: color.text,
    fontFamily: "inherit",
    fontSize: text.sm,
    cursor: "pointer",
  },
  chipText: { minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  sheet: {
    display: { default: "flex", ":is([hidden])": "none" },
    flexDirection: "column",
    flexShrink: 0,
    height: "45%",
    minHeight: "14rem",
    borderTopWidth: "1px",
    borderTopStyle: "solid",
    borderTopColor: color.borderStrong,
    backgroundColor: color.surface,
  },
  // Narrow, the terminal takes the view, as its tab did.
  sheetFull: { flex: 1, height: "auto", borderTopWidth: 0 },
  sheetBar: {
    display: "flex",
    alignItems: "center",
    gap: space.s2,
    flexShrink: 0,
    height: "2.25rem",
    paddingInlineStart: space.s4,
    paddingInlineEnd: space.s2,
    borderBottomWidth: "1px",
    borderBottomStyle: "solid",
    borderBottomColor: color.border,
  },
  grow: { flex: 1 },
  sheetBody: { display: "flex", flexDirection: "column", flex: 1, minHeight: 0 },
})

/** What anyone in the Session can do to it, from its menu and the Composer. */
export interface SessionActions {
  rename: () => void
  /** Asks the agent to summarize the main conversation's older messages, with what to keep. */
  compact: () => void
  setKeepAwake: (on: boolean) => void
  /** Undefined while it can't be put to sleep: busy, running or with prompts queued. */
  sleep: (() => void) | undefined
  /** Undefined while it can't restart: not Active, or starting or restarting. */
  restart: (() => void) | undefined
  remove: () => void
}

/** The title strip: `Repo › title`, its state, who's here, and its menu. */
export function TitleStrip({
  summary,
  title,
  meta,
  presence,
  actions,
}: {
  summary: SessionSummary
  /** The title, or the field renaming it. */
  title: ReactNode
  /** Where it works, and whose accounts it runs on. */
  meta: ReactNode
  presence: JoinedSession["presence"]
  actions: SessionActions
}) {
  // On a phone the top bar holds the title (#402); the h1 stays for screen readers.
  const wide = useMediaQuery(WIDE)
  usePageBar(sessionTitle(summary))
  return (
    <header {...stylex.props(styles.column, styles.strip)}>
      <div {...stylex.props(styles.titleRow)}>
        <div {...stylex.props(styles.crumbs)}>
          <span {...stylex.props(styles.repo)}>{summary.repo}</span>
          <span aria-hidden="true" {...stylex.props(styles.sep)}>
            ›
          </span>
          <h1 tabIndex={-1} {...stylex.props(textRole.heading, styles.title, !wide && srOnly.root)}>
            {title}
          </h1>
          <span {...stylex.props(styles.status)}>
            <SessionStatus state={statusOf(summary.state)} />
            {summary.openQuestion && (
              <Badge intent="warning" icon={<WaitingDot />}>
                Waiting on an answer
              </Badge>
            )}
          </span>
        </div>
        <div {...stylex.props(styles.end)}>
          <OpenPorts summary={summary} />
          <SessionMcpServers summary={summary} />
          <Presence presence={presence} />
          {summary.state !== "Archived" && (
            <SessionMenu summary={summary} actions={actions} />
          )}
        </div>
      </div>
      <p {...stylex.props(textRole.meta, styles.meta)}>
        <span {...stylex.props(styles.narrowOnly)}>
          {summary.repo} <span aria-hidden="true">·</span>{" "}
        </span>
        {meta}
      </p>
    </header>
  )
}

/** Everything anyone in it can do to a Session, in one menu. */
function SessionMenu({ summary, actions }: { summary: SessionSummary; actions: SessionActions }) {
  const kept = summary.keepAwake !== undefined
  return (
    <Menu
      align="end"
      trigger={
        <IconButton label="Session actions" size="sm">
          <MoreIcon />
        </IconButton>
      }
    >
      <MenuItem icon={<PencilIcon />} onClick={actions.rename}>
        Rename
      </MenuItem>
      <MenuItem icon={<SunIcon />} onClick={() => actions.setKeepAwake(!kept)}>
        {kept ? "Stop keeping awake" : "Keep awake"}
      </MenuItem>
      <MenuItem icon={<CompactIcon />} onClick={actions.compact}>
        Compact conversation…
      </MenuItem>
      {summary.state === "Active" && (
        <MenuItem disabled={actions.sleep === undefined} onClick={() => actions.sleep?.()}>
          Sleep now
        </MenuItem>
      )}
      {summary.state === "Active" && (
        <MenuItem
          icon={<RestartIcon />}
          disabled={actions.restart === undefined}
          onClick={() => actions.restart?.()}
        >
          Restart
        </MenuItem>
      )}
      <MenuSeparator />
      <MenuItem icon={<TrashIcon />} intent="danger" onClick={actions.remove}>
        Delete Session
      </MenuItem>
    </Menu>
  )
}

/** Keep awake and the terminal, at the Composer, where everyone already is. */
export function ComposerTools({
  keptAwake,
  setKeepAwake,
  terminal,
}: {
  /** Who keeps it awake, said in words; undefined when no one does. */
  keptAwake: string | undefined
  setKeepAwake: (on: boolean) => void
  /** The terminal sheet's toggle; undefined where there's no terminal to open. */
  terminal: { open: boolean; toggle: () => void } | undefined
}) {
  const on = keptAwake !== undefined
  return (
    <>
      {/* While it's on, the Session doesn't go to sleep when idle; Sleep now turns it off. */}
      <IconButton
        label={on ? `${keptAwake}. Stop keeping it awake` : "Keep awake"}
        size="sm"
        intent={on ? "secondary" : "ghost"}
        aria-pressed={on}
        onClick={() => setKeepAwake(!on)}
      >
        <SunIcon />
      </IconButton>
      {terminal && (
        <Button
          size="sm"
          intent={terminal.open ? "secondary" : "ghost"}
          aria-pressed={terminal.open}
          onClick={terminal.toggle}
        >
          Terminal
        </Button>
      )}
    </>
  )
}

/** The Session's subagents, as chips over the Composer, each opening its view. */
export function AgentChips({
  agents,
  onOpen,
}: {
  agents: ReadonlyArray<{ id: AgentId; description: string; status: AgentStatusName }>
  onOpen: (id: AgentId) => void
}) {
  if (agents.length === 0) return null
  return (
    <div role="group" aria-label="Agents" {...stylex.props(styles.column, styles.chips)}>
      {agents.map((agent) => (
        <button
          key={agent.id}
          type="button"
          onClick={() => onOpen(agent.id)}
          {...stylex.props(styles.chip)}
        >
          <AgentStatus status={agent.status} variant="dot" />
          <span {...stylex.props(styles.chipText)}>{agent.description}</span>
        </button>
      ))}
    </div>
  )
}

type AgentStatusName = Parameters<typeof AgentStatus>[0]["status"]

/** The terminal, as a sheet under the conversation: the whole view on a phone. */
export function TerminalSheet({
  open,
  onClose,
  children,
}: {
  open: boolean
  onClose: () => void
  children: ReactNode
}) {
  const wide = useMediaQuery(WIDE)
  return (
    <section
      aria-label="Terminal"
      hidden={!open}
      {...stylex.props(styles.sheet, !wide && styles.sheetFull)}
    >
      <div {...stylex.props(styles.sheetBar)}>
        <span {...stylex.props(textRole.subheading)}>Terminal</span>
        <span {...stylex.props(styles.grow)} />
        <IconButton label="Close the terminal" size="sm" onClick={onClose}>
          <CloseIcon />
        </IconButton>
      </div>
      <div {...stylex.props(styles.sheetBody)}>{children}</div>
    </section>
  )
}
