import {
  type AgentId,
  type AttachmentId,
  MaxSessionNameLength,
  type PromptId,
  type SessionId,
  type SessionStateChanged,
  type SessionSummary,
  sessionTitle,
} from "@kndl/protocol"
import * as stylex from "@stylexjs/stylex"
import { useNavigate } from "@tanstack/react-router"
import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from "react"
import {
  day,
  environmentChanged,
  mcpServersChanged,
  purgedIn,
  repoParams,
  statusOf,
  terminalText,
} from "../app/format.ts"
import { useHub, useHubState } from "../app/hub.tsx"
import { findSession, type JoinedSession } from "../hub/store.ts"
import type { UploadOptions } from "../hub/transport.ts"
import { restoreSession } from "../sessions/ArchivedSessions.tsx"
import { renameSession } from "../sessions/rename.ts"
import {
  Badge,
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
  SunIcon,
  Switch,
  Tab,
  TabList,
  TabPanel,
  Tabs,
  toast,
  Tooltip,
  TrashIcon,
} from "../ui/index.ts"
import { color, space, text, weight } from "../ui/tokens.stylex.ts"
import { AgentPanel } from "./AgentPanel.tsx"
import { Composer } from "./Composer.tsx"
import { InstallationsFailedBanner } from "./InstallationsFailed.tsx"
import { keptAwakeText } from "./keepAwake.ts"
import { ModelPicker } from "./ModelPicker.tsx"
import { modelName, otherTurnModel } from "./models.ts"
import { OpenPorts } from "./OpenPorts.tsx"
import { Presence } from "./Presence.tsx"
import { PromptQueue } from "./PromptQueue.tsx"
import { QuestionDock } from "./QuestionCard.tsx"
import { WaitingDot } from "./QuestionChip.tsx"
import { SessionMcpServers } from "./SessionMcpServers.tsx"
import { useStickToBottom } from "./stickToBottom.ts"
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
  // Who keeps it awake, in the description line: the sun lines up with the text.
  keptAwake: { whiteSpace: "nowrap" },
  sun: {
    width: "0.875rem",
    height: "0.875rem",
    marginRight: space.s1,
    verticalAlign: "-0.125em",
  },
  keepAwake: { alignItems: "center" },
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
 * tab its terminal. With `agentId`, the chat shows that subagent's view instead (ADR 0014). `tab`,
 * `agentId` and their callbacks let the URL track what is open.
 */
export function SessionView({
  sessionId,
  tab = "chat",
  onTabChange,
  agentId,
  onAgentChange,
}: {
  sessionId: SessionId
  tab?: SessionTab
  onTabChange?: (tab: SessionTab) => void
  agentId?: AgentId
  onAgentChange?: (agentId: AgentId | undefined) => void
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
      agentId={agentId}
      onAgentChange={onAgentChange}
      summary={summary}
      transcript={joined.transcript}
      presence={joined.presence}
      queue={joined.queue}
      startLog={joined.startLog}
      questionPicks={joined.questionPicks}
    />
  )
}

function LoadedSession({
  tab,
  onTabChange,
  agentId,
  onAgentChange,
  summary,
  transcript,
  presence,
  queue,
  startLog,
  questionPicks,
}: {
  tab: SessionTab
  onTabChange: ((tab: SessionTab) => void) | undefined
  agentId: AgentId | undefined
  onAgentChange: ((agentId: AgentId | undefined) => void) | undefined
  summary: SessionSummary
  transcript: JoinedSession["transcript"]
  presence: JoinedSession["presence"]
  queue: JoinedSession["queue"]
  startLog: JoinedSession["startLog"]
  questionPicks: JoinedSession["questionPicks"]
}) {
  const hub = useHub()
  const navigate = useNavigate()
  const items = transcript.items
  const running = summary.currentTurn !== null || transcript.running !== undefined
  const scroller = useStickToBottom(items)

  const [renaming, setRenaming] = useState(false)
  const title = sessionTitle(summary)

  // Stopping its Claude Code interrupts its running agents (ADR 0014): sleep, a restart and a
  // change of model or effort ask first, with what they'd interrupt.
  const runningAgents = summary.agents?.filter((agent) => agent.status === "Running").length ?? 0
  const [confirming, setConfirming] = useState<Interruption | null>(null)
  const interrupting = (interruption: Interruption) => {
    if (runningAgents === 0) interruption.go()
    else setConfirming(interruption)
  }
  const asked = useRestart(summary, () => command(hub.restartSession(summary.id)))
  const restart: Restart = {
    asked: asked.asked,
    ask: () => interrupting({ title: "Restart the Session?", action: "Restart", go: asked.ask }),
  }

  // Its model and effort, from what its Runner said its Claude Code has (#128).
  const models = useHubState(
    (hubState) => hubState.runners?.find((runner) => runner.id === summary.runnerId)?.models,
  )
  const setting = useMemo(
    () => ({
      ...(summary.model !== undefined && { model: summary.model }),
      ...(summary.effort !== undefined && { effort: summary.effort }),
    }),
    [summary.model, summary.effort],
  )
  const nameTurnModel = useCallback(
    (model: string) => otherTurnModel(models, setting, model),
    [models, setting],
  )

  const you = useHubState((hubState) => hubState.you)
  const state = summary.state
  // Being started or restarted, it can't be put to sleep or restarted (#70).
  const busy = summary.starting !== undefined || summary.restarting !== undefined
  const disabledReason = state === "Archived" ? "Archived: restore it to send prompts" : undefined
  const hint = busy
    ? `${summary.restarting ? "Restarting" : "Starting"}: prompts wait in the queue until Claude Code is up.`
    : summary.modelPending === true && running
      ? `${modelName(models, setting)} takes over when this Turn ends.`
      : state === "Asleep"
        ? "Asleep: sending a prompt wakes it."
        : state === "Frozen"
          ? "Frozen: prompts wait in the queue until its Runner is back."
          : undefined

  // While Claude asks a question (#193), what is sent declines it and goes to Claude instead.
  const asking = summary.openQuestion
  // A reply carries the draft's files too (#278).
  const send = (prompt: string, attachments: ReadonlyArray<AttachmentId>) =>
    asking
      ? command(
          hub.answerQuestion(
            summary.id,
            asking.toolCallId,
            { _tag: "Replied", text: prompt.trim() },
            attachments,
          ),
        )
      : command(hub.sendPrompt(summary.id, prompt, attachments))
  const attach = (file: File, options: UploadOptions) =>
    hub.uploadAttachment(summary.id, file, options)
  // A prompt can be steered into a Turn the Hub has running and isn't stopping (#195). One being
  // steered leaves the queue once it has joined the Turn, or stays, with the Hub's reason.
  const steerable =
    state === "Active" &&
    summary.currentTurn !== null &&
    (transcript.running?.stopRequests.length ?? 0) === 0
  const [steering, setSteering] = useState<ReadonlySet<PromptId>>(new Set())
  useEffect(
    () =>
      hub.onCommandFailed((failure) => {
        if (failure.command === "SteerPrompt" && failure.sessionId === summary.id)
          setSteering(new Set())
      }),
    [hub, summary.id],
  )
  // An Archived Session has no terminal to open: it shows its conversation only.
  const archived = state === "Archived"
  const view: SessionTab = archived ? "chat" : tab
  // The terminal mounts when first shown and stays, so its scrollback survives switching tabs.
  const [shownTerminal, setShownTerminal] = useState(view === "terminal")
  if (view === "terminal" && !shownTerminal) setShownTerminal(true)

  // Deleting archives at once, so there's nothing to confirm: the toast's Undo restores it.
  const remove = () => {
    if (!command(hub.archiveSession(summary.id))) return
    toast.show({
      title: "Session deleted",
      description: `${title} is archived. Restore it from ${summary.repo}'s Archived Sessions.`,
      action: { label: "Undo", onAction: () => command(hub.restoreSession(summary.id)) },
    })
    void navigate({ to: "/" })
  }
  const agent = agentId === undefined ? undefined : transcript.agents.get(agentId)
  const closeAgent = () => onAgentChange?.(undefined)

  return (
    <main {...stylex.props(styles.view)}>
      <PageHeader
        // On a phone the name keeps its row, and the toggle and buttons go on one of their own.
        stackActions
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
            {summary.openQuestion && (
              <Badge intent="warning" icon={<WaitingDot />}>
                Waiting on you
              </Badge>
            )}
          </span>
        }
        description={
          <>
            {summary.repo} <span aria-hidden="true">·</span>{" "}
            {summary.workBranch === summary.baseBranch ? (
              `on ${summary.baseBranch}`
            ) : (
              <>
                {/* Named, the title no longer says which branch it works on. */}
                {summary.name !== undefined && `${summary.workBranch} `}from {summary.baseBranch}
              </>
            )}{" "}
            <span aria-hidden="true">·</span> {claudeAccountText(summary)}
            {summary.keepAwake !== undefined && (
              <>
                {" "}
                <span aria-hidden="true">·</span>{" "}
                <span {...stylex.props(styles.keptAwake)}>
                  <SunIcon {...stylex.props(styles.sun)} />
                  {keptAwakeText(summary.keepAwake, you?.id)}
                </span>
              </>
            )}
          </>
        }
        actions={
          <>
            <OpenPorts summary={summary} />
            <SessionMcpServers summary={summary} />
            {state !== "Archived" && (
              // Anyone with access may turn it on or off (ADR 0016); Sleep now turns it off.
              <Tooltip content="While it's on, the Session doesn't go to sleep when idle. Sleep now turns it off.">
                <span>
                  <Switch
                    label="Keep awake"
                    checked={summary.keepAwake !== undefined}
                    onCheckedChange={(on) => command(hub.setKeepAwake(summary.id, on))}
                    sx={styles.keepAwake}
                  />
                </span>
              </Tooltip>
            )}
            {state === "Active" && (
              <Button
                size="sm"
                intent="secondary"
                // The Hub only puts a Session to sleep once started, with nothing running or waiting.
                disabled={busy || running || queue.length > 0}
                onClick={() =>
                  interrupting({
                    title: "Put the Session to sleep?",
                    action: "Sleep now",
                    go: () => command(hub.sleepSession(summary.id)),
                  })
                }
              >
                Sleep now
              </Button>
            )}
            {state !== "Archived" && (
              <IconButton label="Delete Session" size="sm" onClick={remove}>
                <TrashIcon />
              </IconButton>
            )}
            <Presence presence={presence} />
          </>
        }
      />

      <Dialog
        size="sm"
        open={confirming !== null}
        onOpenChange={(open) => {
          if (!open) setConfirming(null)
        }}
        title={confirming?.title}
        description={`${
          runningAgents === 1 ? "An agent is running" : `${runningAgents} agents are running`
        }; stopping Claude Code interrupts ${runningAgents === 1 ? "it" : "them"}. A message to an interrupted agent resumes it.`}
        footer={
          <>
            <DialogClose>Cancel</DialogClose>
            <Button
              onClick={() => {
                confirming?.go()
                setConfirming(null)
              }}
            >
              {confirming?.action}
            </Button>
          </>
        }
      />

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
          {agentId !== undefined ? (
            <AgentPanel session={summary} agentId={agentId} agent={agent} onClose={closeAgent} />
          ) : (
            <>
              <div ref={scroller.ref} onScroll={scroller.onScroll} {...stylex.props(styles.scroll)}>
                <div {...stylex.props(styles.column, styles.transcript)}>
                  <StateBanner
                    summary={summary}
                    change={transcript.stateChange}
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
                    <Transcript
                      sessionId={summary.id}
                      items={items}
                      nameTurnModel={nameTurnModel}
                    />
                  )}
                </div>
              </div>

              <div {...stylex.props(styles.column, styles.dock)}>
                <QuestionDock
                  summary={summary}
                  questions={transcript.questions}
                  picks={questionPicks}
                />
                <PromptQueue
                  queue={queue}
                  onCancel={(prompt) => {
                    if (!hub.cancelPrompt(summary.id, prompt.id)) {
                      toast.show({ title: "Not connected to the Hub", intent: "warning" })
                    }
                  }}
                  onSteer={
                    steerable
                      ? (prompt) => {
                          if (command(hub.steerPrompt(summary.id, prompt.id)))
                            setSteering((ids) => new Set(ids).add(prompt.id))
                        }
                      : undefined
                  }
                  steering={steering}
                />
                <Composer
                  onSend={send}
                  onStop={() => hub.stopTurn(summary.id)}
                  running={running}
                  disabledReason={disabledReason}
                  hint={
                    asking
                      ? "Claude is waiting on an answer: a reply here declines its question."
                      : hint
                  }
                  attach={attach}
                  {...(asking && { copy: replyCopy, needsText: true })}
                  picker={
                    <ModelPicker
                      models={models}
                      value={setting}
                      onChange={(next) =>
                        interrupting({
                          title: "Switch the model?",
                          action: "Switch",
                          go: () => command(hub.setSessionModel(summary.id, next)),
                        })
                      }
                      disabled={archived}
                      side="top"
                    />
                  }
                />
              </div>
            </>
          )}
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

/**
 * Whose Claude account a Session runs on (ADR 0015): its Creator's own credential, or else its
 * Runner's own, shown as its Runner showed it then. A Hub from before says only the Runner's.
 */
function claudeAccountText(summary: SessionSummary): string {
  switch (summary.claudeAccount) {
    case "Creator":
      return `on ${summary.creator.name}'s Claude account`
    case "Runner":
      return `on the Runner's Claude account, ${summary.runnerLogin.account}`
    default:
      return `on ${summary.runnerLogin.account}`
  }
}

/** The prompt box's words while Claude waits on an answer to its question (#193). */
const replyCopy = {
  field: "Reply",
  placeholder: "Or reply directly…",
  send: "Reply",
  stop: "Stop",
} as const

/** Says so when a command couldn't be sent for want of a connection to the Hub. */
function command(sent: boolean): boolean {
  if (!sent) toast.show({ title: "Not connected to the Hub", intent: "warning" })
  return sent
}

/** Something that stops the Session's Claude Code, confirmed first while agents run. */
interface Interruption {
  readonly title: string
  /** Its button's label. */
  readonly action: string
  readonly go: () => void
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
 * older Environment or other Installations than its Repo's, with why from its latest state change.
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
      const mcpServers = mcpServersChanged(summary)
      const restartButton = (
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
      )
      if (environmentChanged(summary) && environment !== undefined) {
        return (
          <Banner
            intent="accent"
            icon={<InfoIcon />}
            title="Environment changed"
            action={restartButton}
          >
            {environment.version === null
              ? `This Sandbox was started before ${summary.repo} had an Environment`
              : `This Sandbox runs version ${environment.version} of ${summary.repo}'s Environment`}
            ; version {environment.latestVersion} is the latest. Restarting puts the Session to
            sleep and wakes it on a fresh Sandbox, with its Workspace and conversation as they are.
            {mcpServers && ` It applies the change to ${summary.repo}'s Installations too.`}
            {running && " Once the running Turn ends."}
          </Banner>
        )
      }
      if (!mcpServers) return null
      // Installations change no Environment version (ADR 0020): Claude Code is given them as it starts.
      return (
        <Banner
          intent="accent"
          icon={<InfoIcon />}
          title="MCP servers changed"
          action={restartButton}
        >
          {summary.repo}'s Installations changed since this Session started, and Claude Code gets
          its MCP servers as it starts. A Restart applies the change, with the Workspace and
          conversation as they are.
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
      // It didn't start for its Repo's Installations (#216): fixing them, or taking it off, will.
      if (change?.state === "Asleep" && (change.installationsFailed?.length ?? 0) > 0) {
        return (
          <InstallationsFailedBanner
            summary={summary}
            failures={change.installationsFailed ?? []}
            onRetry={onWake}
          />
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
