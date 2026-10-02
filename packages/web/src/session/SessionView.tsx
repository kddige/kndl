import type {
  SessionId,
  SessionLogEntry,
  SessionStateChanged,
  SessionSummary,
} from "@claude-hub/protocol"
import * as stylex from "@stylexjs/stylex"
import { Link } from "@tanstack/react-router"
import { useEffect, useLayoutEffect, useMemo, useRef } from "react"
import { statusOf } from "../app/format.ts"
import { useHub, useHubState } from "../app/hub.tsx"
import { findSession, type JoinedSession } from "../hub/store.ts"
import { buildTranscript, runningTurn } from "../hub/transcript.ts"
import {
  ArrowLeftIcon,
  AvatarStack,
  Banner,
  BranchIcon,
  Button,
  EmptyState,
  InfoIcon,
  SessionStatus,
  Spinner,
  toast,
} from "../ui/index.ts"
import { color, font, leading, space, text, tracking, weight } from "../ui/tokens.stylex.ts"
import { Composer } from "./Composer.tsx"
import { PromptQueue } from "./PromptQueue.tsx"
import { Transcript } from "./Transcript.tsx"

const styles = stylex.create({
  view: {
    display: "flex",
    flexDirection: "column",
    flex: 1,
    minHeight: 0,
  },
  header: {
    display: "flex",
    alignItems: "center",
    flexWrap: "wrap",
    gap: space.s3,
    paddingBlock: space.s2,
    paddingInline: space.s4,
    borderBottomWidth: "1px",
    borderBottomStyle: "solid",
    borderBottomColor: color.border,
    backgroundColor: color.surface,
  },
  heading: {
    display: "flex",
    flexDirection: "column",
    gap: space.s0_5,
    flex: 1,
    minWidth: 0,
  },
  titleRow: { display: "flex", alignItems: "center", gap: space.s2, minWidth: 0 },
  title: {
    fontSize: text.md,
    fontWeight: weight.semibold,
    letterSpacing: tracking.tight,
    lineHeight: leading.tight,
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
  branch: {
    display: "inline-flex",
    alignItems: "center",
    gap: space.s1,
    fontFamily: font.mono,
    fontSize: text.xs,
  },
  scroll: {
    flex: 1,
    minHeight: 0,
    overflowY: "auto",
    overscrollBehavior: "contain",
  },
  column: {
    width: "100%",
    maxWidth: "48rem",
    marginInline: "auto",
    paddingInline: space.s4,
  },
  transcript: {
    display: "flex",
    flexDirection: "column",
    gap: space.s4,
    paddingBlock: space.s6,
  },
  dock: {
    display: "flex",
    flexDirection: "column",
    gap: space.s2,
    paddingBottom: space.s4,
    paddingTop: space.s2,
  },
  centered: { display: "grid", placeItems: "center", flex: 1, padding: space.s4 },
})

/** One Session: its conversation, who's here, the Prompt queue and the composer. */
export function SessionView({ sessionId }: { sessionId: SessionId }) {
  const hub = useHub()
  const sessions = useHubState((state) => state.sessions)
  const summary = useHubState((state) => findSession(state, sessionId))
  const joined = useHubState((state) => state.joined[sessionId])

  useEffect(() => {
    hub.join(sessionId)
    return () => hub.leave(sessionId)
  }, [hub, sessionId])

  if (sessions !== null && !summary) {
    return (
      <div {...stylex.props(styles.centered)}>
        <EmptyState
          size="page"
          title="No such Session"
          description="It may have been purged, or it's on a Repo you can't access."
          action={
            <Button nativeButton={false} render={<Link to="/" />} icon={<ArrowLeftIcon />}>
              All Sessions
            </Button>
          }
        />
      </div>
    )
  }
  if (!summary || !joined?.historyLoaded) {
    return (
      <div {...stylex.props(styles.centered)}>
        <Spinner size="lg" label="Loading the Session" />
      </div>
    )
  }
  return (
    <LoadedSession
      summary={summary}
      log={joined.log}
      presence={joined.presence}
      queue={joined.queue}
    />
  )
}

function LoadedSession({
  summary,
  log,
  presence,
  queue,
}: {
  summary: SessionSummary
  log: ReadonlyArray<SessionLogEntry>
  presence: JoinedSession["presence"]
  queue: JoinedSession["queue"]
}) {
  const hub = useHub()
  const items = useMemo(() => buildTranscript(log), [log])
  const running = summary.currentTurn !== null || runningTurn(items) !== undefined
  const lastChange = useMemo(() => latestStateChange(log), [log])
  const scroller = useStickToBottom(items)

  const state = summary.state
  const disabledReason = state === "Archived" ? "Archived: restore it to send prompts" : undefined
  const hint =
    state === "Asleep"
      ? "Asleep: sending a prompt wakes it."
      : state === "Frozen"
        ? "Frozen: prompts wait in the queue until its Runner is back."
        : undefined

  const send = (prompt: string) => command(hub.sendPrompt(summary.id, prompt))

  return (
    <div {...stylex.props(styles.view)}>
      <header {...stylex.props(styles.header)}>
        <Button
          nativeButton={false}
          render={<Link to="/" />}
          intent="ghost"
          size="sm"
          icon={<ArrowLeftIcon />}
          aria-label="All Sessions"
        />
        <div {...stylex.props(styles.heading)}>
          <div {...stylex.props(styles.titleRow)}>
            <h1 {...stylex.props(styles.title)}>{summary.repo}</h1>
            <SessionStatus state={statusOf(state)} />
          </div>
          <div {...stylex.props(styles.meta)}>
            <span {...stylex.props(styles.branch)}>
              <BranchIcon />
              {summary.workBranch}
            </span>
            <span aria-hidden="true">·</span>
            <span>from {summary.baseBranch}</span>
            <span aria-hidden="true">·</span>
            <span>on {summary.runnerLogin.account}</span>
          </div>
        </div>
        {state === "Active" && (
          <Button
            size="sm"
            intent="secondary"
            // The Hub only puts a Session to sleep with nothing running or waiting.
            disabled={running || queue.length > 0}
            onClick={() => command(hub.sleepSession(summary.id))}
          >
            Sleep now
          </Button>
        )}
        <AvatarStack
          label="Here now"
          people={presence.map((p) => ({ id: p.id, name: p.name, src: p.avatarUrl }))}
          size="sm"
        />
      </header>

      <div ref={scroller.ref} onScroll={scroller.onScroll} {...stylex.props(styles.scroll)}>
        <div {...stylex.props(styles.column, styles.transcript)}>
          <StateBanner
            summary={summary}
            change={lastChange}
            onWake={() => command(hub.wakeSession(summary.id))}
          />
          {items.length === 0 ? (
            <EmptyState
              title="Nothing here yet"
              description="Send the first prompt. Everyone in the Session sees Claude's answer as it streams."
            />
          ) : (
            <Transcript items={items} />
          )}
        </div>
      </div>

      <div {...stylex.props(styles.column, styles.dock)}>
        <PromptQueue
          queue={queue}
          onCancel={(prompt) => {
            if (!hub.cancelPrompt(summary.id, prompt.id)) {
              toast.show({ title: "Not connected to the Hub", intent: "warning" })
            }
          }}
        />
        <Composer
          onSend={send}
          onStop={() => hub.stopTurn(summary.id)}
          running={running}
          disabledReason={disabledReason}
          hint={hint}
        />
      </div>
    </div>
  )
}

/** Says so when a command couldn't be sent for want of a connection to the Hub. */
function command(sent: boolean): boolean {
  if (!sent) toast.show({ title: "Not connected to the Hub", intent: "warning" })
  return sent
}

/** Shown while the Session is Frozen, Asleep or Archived, with why from its latest state change. */
function StateBanner({
  summary,
  change,
  onWake,
}: {
  summary: SessionSummary
  change: SessionStateChanged | undefined
  onWake: () => void
}) {
  const why = change?.state === summary.state ? change.message : undefined
  switch (summary.state) {
    case "Active":
      return null
    case "Frozen":
      return (
        <Banner intent="frozen" icon={<InfoIcon />} title="This Session is Frozen">
          {why ? sentence(why) : "Its Runner is offline. "}
          Prompts sent now wait in the queue until the Runner is back.
        </Banner>
      )
    case "Asleep":
      return (
        <Banner
          intent="asleep"
          icon={<InfoIcon />}
          title="This Session is Asleep"
          action={
            <Button size="sm" onClick={onWake}>
              Wake now
            </Button>
          }
        >
          {why ? sentence(why) : ""}
          Its Sandbox is stopped. Sending a prompt wakes it, with its Workspace and conversation as
          they were.
        </Banner>
      )
    case "Archived":
      return (
        <Banner icon={<InfoIcon />} title="This Session is Archived">
          It can be restored for 30 days, then it's purged.
        </Banner>
      )
  }
}

/** The reason as a sentence, with a space after it for the one that follows. */
const sentence = (reason: string) => (/[.!?]$/.test(reason) ? `${reason} ` : `${reason}. `)

function latestStateChange(log: ReadonlyArray<SessionLogEntry>): SessionStateChanged | undefined {
  for (let index = log.length - 1; index >= 0; index--) {
    const event = log[index]?.event
    if (event?._tag === "SessionStateChanged") return event
  }
  return undefined
}

/**
 * Keeps the transcript scrolled to the bottom as it grows, unless the reader has scrolled up to
 * read something.
 */
function useStickToBottom(content: unknown) {
  const ref = useRef<HTMLDivElement>(null)
  const stuck = useRef(true)
  useLayoutEffect(() => {
    const element = ref.current
    if (element && stuck.current) element.scrollTop = element.scrollHeight
  }, [content])
  return {
    ref,
    onScroll: () => {
      const element = ref.current
      if (!element) return
      stuck.current = element.scrollHeight - element.scrollTop - element.clientHeight < 64
    },
  }
}
