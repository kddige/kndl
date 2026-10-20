// A Turn's threads (docs/design/durable-harness.md), as rows under it, the way Slack shows "3
// replies" under a message: who's in each, how many replies, whether it's replying now and what it
// does, and its model when it isn't the Session's. Each leads to the thread's panel.

import type { SessionId, ThreadId } from "@kndl/protocol"
import * as stylex from "@stylexjs/stylex"
import { Link } from "@tanstack/react-router"
import { useContext } from "react"
import { counted, timeAgo } from "../app/format.ts"
import type { ThreadView } from "../hub/transcript.ts"
import { AvatarStack, ChevronRightIcon, Spinner, ThreadIcon } from "../ui/index.ts"
import { focus } from "../ui/shared.ts"
import { color, motion, radius, space, text, weight } from "../ui/tokens.stylex.ts"
import { ModelNamesContext } from "./models.ts"

const HOVER = "@media (hover: hover)"

/** What a thread is doing, in a few words: what its running Turn does now, or that it waits. */
export function threadActivity(thread: ThreadView): string | undefined {
  const running = thread.running
  if (running === undefined) return thread.sent.length > 0 ? "Waiting for the agent" : undefined
  if (running.stopRequests.length > 0) return "Stopping"
  const last = running.blocks.at(-1)
  switch (last?.kind) {
    case "tool":
      return last.call.outcome === undefined ? `Running ${last.call.tool}` : "Thinking"
    case "agent":
      return last.agent.status === "Running" ? "Working with an agent" : "Thinking"
    case "compaction":
      return last.compaction.end === undefined ? "Summarizing" : "Thinking"
    case "text":
      return "Writing"
    default:
      return "Thinking"
  }
}

const styles = stylex.create({
  list: {
    display: "flex",
    flexDirection: "column",
    gap: space.s1,
    margin: 0,
    padding: 0,
    listStyle: "none",
  },
  row: {
    display: "flex",
    alignItems: "center",
    gap: space.s2,
    minWidth: 0,
    minHeight: "2.25rem",
    paddingBlock: space.s1,
    paddingInlineStart: space.s1_5,
    paddingInlineEnd: space.s2,
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: "transparent",
    borderRadius: radius.lg,
    backgroundColor: {
      default: "transparent",
      ":hover": { default: null, [HOVER]: color.surfaceHover },
    },
    color: color.text,
    fontSize: text.sm,
    textDecoration: "none",
    transitionProperty: "background-color, border-color",
    transitionDuration: motion.durationFast,
  },
  // The thread whose panel is open: marked by more than colour, an edge and the weight of its title.
  current: {
    borderColor: color.border,
    backgroundColor: color.surfaceMuted,
  },
  currentTitle: { fontWeight: weight.semibold },
  title: {
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontWeight: weight.medium,
  },
  replies: { flexShrink: 0, color: color.accentText, fontWeight: weight.medium },
  meta: {
    display: "inline-flex",
    alignItems: "center",
    gap: space.s1,
    flexShrink: 1,
    minWidth: 0,
    overflow: "hidden",
    color: color.textTertiary,
    whiteSpace: "nowrap",
    fontVariantNumeric: "tabular-nums",
  },
  // Replying now: the words say it, the spinner shows it.
  live: { color: color.textSecondary },
  model: {
    flexShrink: 0,
    maxWidth: "9rem",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    paddingInline: space.s1_5,
    borderRadius: radius.sm,
    backgroundColor: color.surfaceActive,
    color: color.textSecondary,
    fontSize: text.xs,
    lineHeight: "1.125rem",
  },
  end: { flex: 1 },
  chevron: { flexShrink: 0, color: color.textTertiary },
  icon: { flexShrink: 0, color: color.textTertiary },
})

/** The rows of a Turn's threads, oldest first; the open one's marked. */
export function ThreadRows({
  sessionId,
  threads,
  open,
}: {
  sessionId: SessionId
  threads: ReadonlyArray<ThreadView>
  /** The thread whose panel is open, if it is one of these. */
  open?: ThreadId | undefined
}) {
  const nameModel = useContext(ModelNamesContext)
  return (
    <ul aria-label="Threads" {...stylex.props(styles.list)}>
      {threads.map((thread) => {
        const current = thread.threadId === open
        const activity = threadActivity(thread)
        const people = thread.people.length > 0 ? thread.people : [thread.startedBy]
        return (
          <li key={thread.threadId}>
            <Link
              to="/sessions/$sessionId"
              params={{ sessionId }}
              search={{ thread: thread.threadId }}
              aria-current={current ? "true" : undefined}
              {...stylex.props(styles.row, current && styles.current, focus.ring)}
            >
              {thread.people.length > 0 ? (
                <AvatarStack people={people} size="sm" max={3} label="In this thread" />
              ) : (
                <ThreadIcon {...stylex.props(styles.icon)} />
              )}
              <span {...stylex.props(styles.title, current && styles.currentTitle)}>
                {thread.title}
              </span>
              <span {...stylex.props(styles.replies)}>
                {counted(thread.replies, { one: "reply", other: "replies" })}
              </span>
              <span {...stylex.props(styles.meta, activity !== undefined && styles.live)}>
                {thread.running !== undefined && <Spinner size="sm" />}
                {activity !== undefined ? `${activity}…` : `Last reply ${timeAgo(thread.lastAt)}`}
              </span>
              <span {...stylex.props(styles.end)} />
              {thread.model !== undefined && (
                <span title="The model this thread runs on" {...stylex.props(styles.model)}>
                  {nameModel(thread.model)}
                </span>
              )}
              <ChevronRightIcon {...stylex.props(styles.chevron)} />
            </Link>
          </li>
        )
      })}
    </ul>
  )
}
