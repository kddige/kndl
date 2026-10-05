import {
  MaxSessionNameLength,
  type SessionId,
  type SessionLogEntry,
  type SessionStateChanged,
  type SessionSummary,
  sessionTitle,
} from "@claude-hub/protocol"
import * as stylex from "@stylexjs/stylex"
import { useNavigate } from "@tanstack/react-router"
import { lazy, Suspense, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import {
  day,
  environmentChanged,
  purgedIn,
  repoParams,
  statusOf,
  terminalText,
} from "../app/format.ts"
import { useHub, useHubState } from "../app/hub.tsx"
import { findSession, type JoinedSession } from "../hub/store.ts"
import { buildTranscript, runningTurn } from "../hub/transcript.ts"
import { restoreSession } from "../sessions/ArchivedSessions.tsx"
import { renameSession } from "../sessions/rename.ts"
import {
  AvatarStack,
  Banner,
  Button,
  Dialog,
  DialogClose,
  Disclosure,
  EmptyState,
  IconButton,
  InfoIcon,
  InlineEdit,
  LogView,
  PageHeader,
  PencilIcon,
  RestartIcon,
  SessionStatus,
  Spinner,
  Tab,
  TabList,
  TabPanel,
  Tabs,
  toast,
  TrashIcon,
} from "../ui/index.ts"
import { color, space, text, weight } from "../ui/tokens.stylex.ts"
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
  tabs: { display: "flex", flexDirection: "column", flex: 1, minHeight: 0 },
  // The name being edited, in the title's type, as wide as a long name needs.
  nameField: {
    width: "24rem",
    maxWidth: "100%",
    fontSize: text.md,
    fontWeight: weight.semibold,
  },
  badges: { display: "inline-flex", alignItems: "center", gap: space.s1 },
  children: {
    display: "flex",
    flexDirection: "column",
    gap: space.s1,
    margin: 0,
    padding: 0,
    listStyle: "none",
  },
  child: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: space.s2,
    minWidth: 0,
  },
  childTitle: {
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontWeight: weight.medium,
  },
  tabList: {
    paddingInline: space.s4,
    backgroundColor: color.surface,
  },
  tabPanel: {
    display: { default: "flex", ":is([hidden])": "none" },
    flexDirection: "column",
    flex: 1,
    minHeight: 0,
  },
})

// xterm.js is most of the terminal's weight: it loads when the terminal is first shown.
const TerminalPanel = lazy(async () => ({
  default: (await import("./TerminalPanel.tsx")).TerminalPanel,
}))

/** The Session view's tabs: the conversation, or Claude Code's own terminal. */
export type SessionTab = "chat" | "terminal"

/**
 * One Session: its conversation, who's here, the Prompt queue and the composer, and in another
 * tab its terminal. `tab` and `onTabChange` let the URL track the open tab.
 */
export function SessionView({
  sessionId,
  tab = "chat",
  onTabChange,
}: {
  sessionId: SessionId
  tab?: SessionTab
  onTabChange?: (tab: SessionTab) => void
}) {
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
      tab={tab}
      onTabChange={onTabChange}
      summary={summary}
      log={joined.log}
      presence={joined.presence}
      queue={joined.queue}
      startLog={joined.startLog}
    />
  )
}

function LoadedSession({
  tab,
  onTabChange,
  summary,
  log,
  presence,
  queue,
  startLog,
}: {
  tab: SessionTab
  onTabChange: ((tab: SessionTab) => void) | undefined
  summary: SessionSummary
  log: ReadonlyArray<SessionLogEntry>
  presence: JoinedSession["presence"]
  queue: JoinedSession["queue"]
  startLog: JoinedSession["startLog"]
}) {
  const hub = useHub()
  const navigate = useNavigate()
  const items = useMemo(() => buildTranscript(log), [log])
  const running = summary.currentTurn !== null || runningTurn(items) !== undefined
  const lastChange = useMemo(() => latestStateChange(log), [log])
  const scroller = useStickToBottom(items)
  const restart = useRestart(summary, () => command(hub.restartSession(summary.id)))

  const [renaming, setRenaming] = useState(false)
  const title = sessionTitle(summary)

  // Its Child Sessions that deleting it would archive too (ADR 0012).
  const sessions = useHubState((hubState) => hubState.sessions)
  const children = useMemo(
    () =>
      (sessions ?? []).filter(
        (session) => session.parentId === summary.id && session.state !== "Archived",
      ),
    [sessions, summary.id],
  )
  const [confirmingDelete, setConfirmingDelete] = useState(false)

  const state = summary.state
  // Being started or restarted, it can't be put to sleep or restarted (#70).
  const busy = summary.starting !== undefined || summary.restarting !== undefined
  const disabledReason = state === "Archived" ? "Archived: restore it to send prompts" : undefined
  const hint = busy
    ? `${summary.restarting ? "Restarting" : "Starting"}: prompts wait in the queue until Claude Code is up.`
    : state === "Asleep"
      ? "Asleep: sending a prompt wakes it."
      : state === "Frozen"
        ? "Frozen: prompts wait in the queue until its Runner is back."
        : undefined

  const send = (prompt: string) => command(hub.sendPrompt(summary.id, prompt))
  // An Archived Session has no terminal to open: it shows its conversation only.
  const archived = state === "Archived"
  const view: SessionTab = archived ? "chat" : tab
  // The terminal mounts when first shown and stays, so its scrollback survives switching tabs.
  const [shownTerminal, setShownTerminal] = useState(view === "terminal")
  if (view === "terminal" && !shownTerminal) setShownTerminal(true)

  // Deleting archives at once, so there's nothing to confirm: the toast's Undo restores it. Its
  // Child Sessions are archived with it, and Undo leaves them archived, so a Parent Session's
  // delete is confirmed first, listing them.
  const archive = () => {
    setConfirmingDelete(false)
    if (!command(hub.archiveSession(summary.id))) return
    toast.show({
      title: "Session deleted",
      description:
        children.length === 0
          ? `${title} is archived. Restore it from ${summary.repo}'s Archived Sessions.`
          : `${title} and its Child Sessions are archived. Restore them from ${summary.repo}'s Archived Sessions.`,
      action: { label: "Undo", onAction: () => command(hub.restoreSession(summary.id)) },
    })
    void navigate({ to: "/" })
  }
  const remove = () => (children.length === 0 ? archive() : setConfirmingDelete(true))

  return (
    <main {...stylex.props(styles.view)}>
      <PageHeader
        // Its name, edited in place: anyone with access may rename it, whatever its state.
        title={
          renaming ? (
            <InlineEdit
              label="Session name"
              defaultValue={title}
              placeholder={summary.workBranch}
              maxLength={MaxSessionNameLength}
              onCommit={(typed) => {
                setRenaming(false)
                renameSession(hub, summary, typed)
              }}
              onCancel={() => setRenaming(false)}
              sx={styles.nameField}
            />
          ) : (
            title
          )
        }
        badge={
          <span {...stylex.props(styles.badges)}>
            {!renaming && (
              <IconButton label="Rename Session" size="sm" onClick={() => setRenaming(true)}>
                <PencilIcon />
              </IconButton>
            )}
            <SessionStatus state={statusOf(state)} />
          </span>
        }
        description={
          <>
            {summary.repo} <span aria-hidden="true">·</span>{" "}
            {/* Named, the title no longer says which branch it works on. */}
            {summary.name !== undefined && `${summary.workBranch} `}from {summary.baseBranch}{" "}
            <span aria-hidden="true">·</span> on {summary.runnerLogin.account}
          </>
        }
        actions={
          <>
            {state === "Active" && (
              <Button
                size="sm"
                intent="secondary"
                // The Hub only puts a Session to sleep once started, with nothing running or waiting.
                disabled={busy || running || queue.length > 0}
                onClick={() => command(hub.sleepSession(summary.id))}
              >
                Sleep now
              </Button>
            )}
            {state !== "Archived" && (
              <IconButton label="Delete Session" size="sm" onClick={remove}>
                <TrashIcon />
              </IconButton>
            )}
            <AvatarStack
              label="Here now"
              people={presence.map((p) => ({ id: p.id, name: p.name, src: p.avatarUrl }))}
              size="sm"
            />
          </>
        }
      />

      <Dialog
        size="sm"
        open={confirmingDelete}
        onOpenChange={(open) => {
          if (!open) setConfirmingDelete(false)
        }}
        title={`Delete ${title} and its Child Sessions?`}
        description={`${
          children.length === 1
            ? "Its Child Session is archived with it."
            : `Its ${children.length} Child Sessions are archived with it.`
        } Undo restores only ${title}; restore a Child Session from ${summary.repo}'s Archived Sessions.`}
        footer={
          <>
            <DialogClose>Cancel</DialogClose>
            <Button intent="danger" onClick={archive}>
              Delete
            </Button>
          </>
        }
      >
        <ul aria-label="Its Child Sessions" {...stylex.props(styles.children)}>
          {children.map((child) => (
            <li key={child.id} {...stylex.props(styles.child)}>
              <span {...stylex.props(styles.childTitle)}>{sessionTitle(child)}</span>
              <SessionStatus state={statusOf(child.state)} />
            </li>
          ))}
        </ul>
      </Dialog>

      <Tabs
        value={view}
        onValueChange={(next) => onTabChange?.(next === "terminal" ? "terminal" : "chat")}
        sx={styles.tabs}
      >
        <div {...stylex.props(styles.tabList)}>
          <TabList label="Session views">
            <Tab value="chat">Chat</Tab>
            <Tab value="terminal" disabled={archived}>
              Terminal
            </Tab>
          </TabList>
        </div>
        <TabPanel value="chat" keepMounted sx={styles.tabPanel}>
          <div ref={scroller.ref} onScroll={scroller.onScroll} {...stylex.props(styles.scroll)}>
            <div {...stylex.props(styles.column, styles.transcript)}>
              <StateBanner
                summary={summary}
                change={lastChange}
                running={running}
                startLog={startLog}
                restart={restart}
                onWake={() => command(hub.wakeSession(summary.id))}
                onRestore={() => restoreSession(hub, summary.id)}
                onEnterValues={() =>
                  void navigate({
                    to: "/repos/$owner/$repo/environment",
                    params: repoParams(summary.repo),
                  })
                }
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
        </TabPanel>
        <TabPanel value="terminal" keepMounted sx={styles.tabPanel}>
          {shownTerminal && !archived && (
            <Suspense
              fallback={
                <div {...stylex.props(styles.centered)}>
                  <Spinner label="Loading the terminal" />
                </div>
              }
            >
              <TerminalPanel session={summary} />
            </Suspense>
          )}
        </TabPanel>
      </Tabs>
    </main>
  )
}

/** Says so when a command couldn't be sent for want of a connection to the Hub. */
function command(sent: boolean): boolean {
  if (!sent) toast.show({ title: "Not connected to the Hub", intent: "warning" })
  return sent
}

/** Asking for a restart, and whether it was just asked: from the click until the Hub answers. */
interface Restart {
  readonly ask: () => void
  readonly asked: boolean
}

/** How long a restart shows as asked without word from the Hub, as when it refuses it. */
const restartAskedMs = 5_000

function useRestart(summary: SessionSummary, send: () => boolean): Restart {
  // The summary when it was asked: any update from the Hub, the restart's included, replaces it.
  const [askedOf, setAskedOf] = useState<SessionSummary | null>(null)
  const asked = askedOf === summary
  useEffect(() => {
    if (!asked) return
    // A refusal changes nothing in the summary: the toast says why.
    const timer = setTimeout(() => setAskedOf(null), restartAskedMs)
    return () => clearTimeout(timer)
  }, [asked])
  return {
    asked,
    ask: () => {
      if (send()) setAskedOf(summary)
    },
  }
}

/**
 * Shown while the Session is being started or restarted (#70): what is going on, and the start's
 * output so far, which is its Environment's build and start script.
 *
 * The output is shown here rather than in the Terminal tab: the terminal draws only from a
 * Snapshot of Claude Code's screen, which there is none of until Claude Code is up, and the chat
 * is where people wait for it.
 */
function StartingBanner({
  summary,
  startLog,
}: {
  summary: SessionSummary
  startLog: JoinedSession["startLog"]
}) {
  const { starting, restarting } = summary
  const you = useHubState((state) => state.you)
  const asker = restarting && (restarting.by.id === you?.id ? "You" : restarting.by.name)
  const output = starting && startLog?.since === starting.since ? startLog.text : ""
  const plain = useMemo(() => terminalText(output), [output])
  const version = starting?.environmentVersion
  return (
    <Banner
      intent="accent"
      icon={<Spinner size="sm" />}
      title={restarting ? "Restarting…" : "Starting…"}
      detail={
        starting && (
          <Disclosure variant="plain" summary="Show log">
            <LogView label="Start log" placeholder="Nothing printed yet.">
              {plain}
            </LogView>
          </Disclosure>
        )
      }
    >
      {starting === undefined
        ? `${asker ? `${asker} asked for a restart. ` : ""}Stopping Claude Code and its Sandbox, to start them again on ${summary.repo}'s latest Environment. `
        : version === undefined
          ? "Starting Claude Code in a fresh Sandbox. "
          : `Starting the Sandbox on version ${version} of ${summary.repo}'s Environment: building it if its Runner hasn't yet, which can take a few minutes, then running its start script. `}
      Prompts sent now wait in the queue until Claude Code is up.
    </Banner>
  )
}

/**
 * Shown while the Session is starting or restarting, Frozen, Asleep or Archived, or runs on an
 * older Environment, with why from its latest state change.
 */
function StateBanner({
  summary,
  change,
  running,
  startLog,
  restart,
  onWake,
  onRestore,
  onEnterValues,
}: {
  summary: SessionSummary
  change: SessionStateChanged | undefined
  running: boolean
  startLog: JoinedSession["startLog"]
  restart: Restart
  onWake: () => void
  onRestore: () => void
  onEnterValues: () => void
}) {
  const why = change?.state === summary.state ? change.message : undefined
  const busy = summary.starting !== undefined || summary.restarting !== undefined
  if (busy && (summary.state === "Active" || summary.state === "Asleep")) {
    return <StartingBanner summary={summary} startLog={startLog} />
  }
  switch (summary.state) {
    case "Active": {
      const environment = summary.environment
      if (!environmentChanged(summary) || environment === undefined) return null
      return (
        <Banner
          intent="accent"
          icon={<InfoIcon />}
          title="Environment changed"
          action={
            <Button
              size="sm"
              icon={<RestartIcon />}
              // The Hub only restarts a Session with no Turn running.
              disabled={running}
              loading={restart.asked}
              onClick={restart.ask}
            >
              Restart
            </Button>
          }
        >
          {environment.version === null
            ? `This Sandbox was started before ${summary.repo} had an Environment`
            : `This Sandbox runs version ${environment.version} of ${summary.repo}'s Environment`}
          ; version {environment.latestVersion} is the latest. Restarting puts the Session to sleep
          and wakes it on a fresh Sandbox, with its Workspace and conversation as they are.
          {running && " Once the running Turn ends."}
        </Banner>
      )
    }
    case "Frozen":
      return (
        <Banner intent="frozen" icon={<InfoIcon />} title="This Session is Frozen">
          {why ? sentence(why) : "Its Runner is offline. "}
          Prompts sent now wait in the queue until the Runner is back.
        </Banner>
      )
    case "Asleep":
      // It didn't start because variables need a value (#57): waking it again won't help.
      if (change?.state === "Asleep" && change.valuesNeeded === true) {
        return (
          <Banner
            intent="danger"
            icon={<InfoIcon />}
            title="This Session can't start"
            action={
              <Button size="sm" onClick={onEnterValues}>
                Enter values
              </Button>
            }
          >
            {why ? sentence(why) : ""}
            Prompts sent now wait in the queue until it starts.
          </Banner>
        )
      }
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
          detail={
            // What Claude Code printed before it exited on its own, as why it did (#105).
            summary.lastOutput !== undefined && (
              <Disclosure variant="plain" summary="Show Claude Code's last output">
                <LogView label="Claude Code's last output">{summary.lastOutput}</LogView>
              </Disclosure>
            )
          }
        >
          {why ? sentence(why) : ""}
          Its Sandbox is stopped. Sending a prompt wakes it, with its Workspace and conversation as
          they were.
        </Banner>
      )
    case "Archived": {
      const archived = summary.archived
      return (
        <Banner
          icon={<InfoIcon />}
          title="This Session is Archived"
          action={
            <Button size="sm" onClick={onRestore}>
              Restore
            </Button>
          }
        >
          {archived
            ? `${archived.by.name} deleted it. It can be restored until ${day(archived.purgeAt)}, when it's purged (${purgedIn(archived.purgeAt)}). `
            : "It can be restored until it's purged. "}
          Its Sandbox is gone; restored, it wakes with a fresh one on the same Workspace.
        </Banner>
      )
    }
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
