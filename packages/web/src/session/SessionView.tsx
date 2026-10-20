import {
  type AgentId,
  type AttachmentId,
  MaxSessionNameLength,
  type PromptId,
  type SessionId,
  type SessionStateChanged,
  type SessionSummary,
  sessionTitle,
  type ThreadId,
  type TurnId,
} from "@kndl/protocol"
import * as stylex from "@stylexjs/stylex"
import { useNavigate } from "@tanstack/react-router"
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useCommands } from "../app/commands.tsx"
import { accountsOf, accountsPay, notSent, sentence } from "../app/copy.ts"
import {
  day,
  environmentChanged,
  mcpServersChanged,
  purgedIn,
  repoParams,
  terminalText,
} from "../app/format.ts"
import { useHub, useHubState } from "../app/hub.tsx"
import { findSession, type JoinedSession } from "../hub/store.ts"
import type { TurnView } from "../hub/transcript.ts"
import type { UploadOptions } from "../hub/transport.ts"
import { restoreSession } from "../sessions/ArchivedSessions.tsx"
import { renameSession } from "../sessions/rename.ts"
import {
  Banner,
  Button,
  Dialog,
  DialogClose,
  Disclosure,
  EmptyState,
  fieldText,
  InfoIcon,
  InlineEdit,
  LogView,
  RestartIcon,
  Spinner,
  SunIcon,
  toast,
  useMediaQuery,
  WIDE,
} from "../ui/index.ts"
import { space } from "../ui/tokens.stylex.ts"
import { AgentPanel } from "./AgentPanel.tsx"
import { CompactDialog } from "./Compaction.tsx"
import { Composer } from "./Composer.tsx"
import { InstallationsFailedBanner } from "./InstallationsFailed.tsx"
import { keptAwakeText } from "./keepAwake.ts"
import { ModelPicker } from "./ModelPicker.tsx"
import {
  knownModelLabel,
  modelLabel,
  ModelNamesContext,
  type ModelSetting,
  otherProviderTurnModel,
  providerModelLabel,
  useNameReplier,
} from "./models.ts"
import { PlanDock } from "./Plan.tsx"
import { PromptQueue } from "./PromptQueue.tsx"
import { QuestionDock } from "./QuestionCard.tsx"
import {
  AgentChips,
  ComposerTools,
  type SessionActions,
  TerminalSheet,
  TitleStrip,
} from "./SessionChrome.tsx"
import { SessionCost } from "./SessionCost.tsx"
import { useStickToBottom } from "./stickToBottom.ts"
import { ThreadPanel, type ThreadPanelOf } from "./ThreadPanel.tsx"
import { Transcript, type TranscriptThreads } from "./Transcript.tsx"

/** Wide enough for a thread's panel beside the conversation, each still readable. */
const SIDE_BY_SIDE = "(min-width: 72rem)"

const styles = stylex.create({
  view: {
    display: "flex",
    flexDirection: "column",
    flex: 1,
    minHeight: 0,
  },
  hidden: { display: "none" },
  // The conversation, and a thread's panel beside it.
  body: {
    display: "flex",
    flex: 1,
    minHeight: 0,
  },
  conversation: {
    display: "flex",
    flexDirection: "column",
    flex: 1,
    minWidth: 0,
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
  // The name being edited, as wide as a long name needs.
  nameField: {
    width: "24rem",
    maxWidth: "100%",
  },
  // Who keeps it awake, on the meta line: the sun lines up with the text.
  keptAwake: { whiteSpace: "nowrap" },
  sun: {
    width: "0.875rem",
    height: "0.875rem",
    marginRight: space.s1,
    verticalAlign: "-0.125em",
  },
  nowrap: { whiteSpace: "nowrap" },
})

// xterm.js is most of the terminal's weight: it loads when the terminal is first shown.
const TerminalPanel = lazy(async () => ({
  default: (await import("./TerminalPanel.tsx")).TerminalPanel,
}))

/** The Session view's tabs: the conversation, or the shell in its Sandbox. */
export type SessionTab = "chat" | "terminal"

/** A thread to open in the panel, or a Turn to start one off. */
export type ThreadTarget = { readonly thread: ThreadId } | { readonly fork: TurnId }

/**
 * One Session: its conversation, who's here, the Prompt queue and the composer, its threads in a
 * panel beside it, and its terminal under it. With `agentId`, the chat shows that subagent's view
 * instead (ADR 0014). `tab`, `agentId`, `threadId`, `forkOf` and their callbacks let the URL track
 * what is open.
 *
 * Everyone in it drives it (docs/design/durable-harness.md): it runs on its Creator's accounts,
 * which it says, but anyone prompts it, answers it, stops it, starts threads and uses its terminal.
 */
export function SessionView({
  sessionId,
  tab = "chat",
  onTabChange,
  agentId,
  onAgentChange,
  threadId,
  forkOf,
  onThreadChange,
}: {
  sessionId: SessionId
  tab?: SessionTab
  onTabChange?: (tab: SessionTab) => void
  agentId?: AgentId
  onAgentChange?: (agentId: AgentId | undefined) => void
  threadId?: ThreadId
  forkOf?: TurnId
  onThreadChange?: (target: ThreadTarget | undefined, options?: { replace?: boolean }) => void
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
      key={summary.id}
      tab={tab}
      onTabChange={onTabChange}
      agentId={agentId}
      onAgentChange={onAgentChange}
      threadId={threadId}
      forkOf={forkOf}
      onThreadChange={onThreadChange}
      summary={summary}
      transcript={joined.transcript}
      presence={joined.presence}
      queue={joined.queue}
      startLog={joined.startLog}
      questionPicks={joined.questionPicks}
      sessionModels={joined.models}
    />
  )
}

function LoadedSession({
  tab,
  onTabChange,
  agentId,
  onAgentChange,
  threadId,
  forkOf,
  onThreadChange,
  summary,
  transcript,
  presence,
  queue,
  startLog,
  questionPicks,
  sessionModels,
}: {
  tab: SessionTab
  onTabChange: ((tab: SessionTab) => void) | undefined
  agentId: AgentId | undefined
  onAgentChange: ((agentId: AgentId | undefined) => void) | undefined
  threadId: ThreadId | undefined
  forkOf: TurnId | undefined
  onThreadChange:
    | ((target: ThreadTarget | undefined, options?: { replace?: boolean }) => void)
    | undefined
  summary: SessionSummary
  transcript: JoinedSession["transcript"]
  presence: JoinedSession["presence"]
  queue: JoinedSession["queue"]
  startLog: JoinedSession["startLog"]
  questionPicks: JoinedSession["questionPicks"]
  sessionModels: JoinedSession["models"]
}) {
  const hub = useHub()
  const navigate = useNavigate()
  const items = transcript.items
  const running = summary.currentTurn !== null || transcript.running !== undefined
  const scroller = useStickToBottom(items)

  const [renaming, setRenaming] = useState(false)
  const [compacting, setCompacting] = useState(false)
  const title = sessionTitle(summary)

  // A restart or sleep pauses what runs in the background: its agents and threads, which the
  // durable agent picks up again where they were once the Session is back. Each asks first.
  const runningAgents = summary.agents?.filter((agent) => agent.status === "Running").length ?? 0
  const runningThreads = summary.threads?.filter((thread) => thread.running).length ?? 0
  const background = runningAgents + runningThreads
  const [confirming, setConfirming] = useState<Interruption | null>(null)
  const interrupting = (interruption: Interruption) => {
    if (background === 0) interruption.go()
    else setConfirming(interruption)
  }
  const asked = useRestart(summary, () => command("Restart", hub.restartSession(summary.id)))
  const restart: Restart = {
    asked: asked.asked,
    ask: () => interrupting({ title: "Restart the Session?", action: "Restart", go: asked.ask }),
  }

  // Its Models are its Creator's (ADR 0026), which the Hub sends everyone in it; the Creator's own
  // ProvidersState has them too, before SessionModels comes.
  const yours = useHubState((hubState) => hubState.you?.id === summary.creator.id)
  const ownModels = useHubState((hubState) => (yours ? hubState.providers?.models : undefined))
  const models = sessionModels ?? ownModels
  const connectable = useHubState((hubState) => hubState.providers?.connectable)
  // Looked for only when the log or the model changes, not on every change the Hub sends.
  const log = useHubState((hubState) => hubState.joined[summary.id]?.log)
  const knownLabel = useMemo(() => knownModelLabel(log ?? [], summary.model), [log, summary.model])
  const setting = useMemo(
    () => ({
      ...(summary.model !== undefined && { model: summary.model }),
      ...(summary.thinkingLevel !== undefined && { thinkingLevel: summary.thinkingLevel }),
    }),
    [summary.model, summary.thinkingLevel],
  )
  // A switch shows in the picker from the pick, while it is sent, until the Hub says the
  // Session's setting: a refusal shows the setting again.
  const [picked, setPicked] = useState<PickedSetting | null>(null)
  const shownSetting = picked !== null && picked.from === setting ? picked.to : setting
  useEffect(() => {
    if (!picked?.sent) return
    const timer = setTimeout(() => setPicked(null), switchSentMs)
    return () => clearTimeout(timer)
  }, [picked])
  // The durable agent switches between Turns without stopping anything, so nothing asks first.
  const pick = (next: ModelSetting) => {
    const from = setting
    setPicked(
      command("Model change", hub.setSessionModel(summary.id, next))
        ? { from, to: next, sent: true }
        : null,
    )
  }
  const settingName = providerModelLabel(models, setting, knownLabel)
  // A Turn that ran on another Model than the Session's is named, as one from before a switch.
  const nameTurnModel = useCallback(
    (model: string) => otherProviderTurnModel(models, setting, model),
    [models, setting],
  )
  const nameReplier = useNameReplier(models, settingName)
  const nameModel = useCallback((model: string) => modelLabel(models, model), [models])

  const you = useHubState((hubState) => hubState.you)
  const state = summary.state
  // Being started or restarted, it can't be put to sleep or restarted (#70).
  const busy = summary.starting !== undefined || summary.restarting !== undefined
  const disabledReason = state === "Archived" ? "Archived: restore it to send prompts" : undefined
  const hint = busy
    ? `${summary.restarting ? "Restarting" : "Starting"}: prompts wait in the queue until it's up.`
    : summary.modelPending === true && running
      ? `${settingName} takes over when this Turn ends.`
      : state === "Asleep"
        ? "Asleep: sending a prompt wakes it."
        : state === "Frozen"
          ? "Frozen: prompts wait in the queue until its Runner is back."
          : undefined

  // While the agent asks a question (#193), what is sent declines it and goes to it instead.
  const asking = summary.openQuestion
  // A reply carries the draft's files too (#278).
  const send = (prompt: string, attachments: ReadonlyArray<AttachmentId>) =>
    asking
      ? command(
          "Reply",
          hub.answerQuestion(
            summary.id,
            asking.toolCallId,
            { _tag: "Replied", text: prompt.trim() },
            attachments,
          ),
        )
      : command("Prompt", hub.sendPrompt(summary.id, prompt, attachments))
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
  const canTerminal = !archived
  // The terminal mounts when first shown and stays, so its scrollback survives switching tabs.
  const [shownTerminal, setShownTerminal] = useState(view === "terminal")
  if (view === "terminal" && !shownTerminal) setShownTerminal(true)

  // Deleting archives at once, so there's nothing to confirm: the toast's Undo restores it.
  const remove = () => {
    if (!command("Delete", hub.archiveSession(summary.id))) return
    toast.show({
      title: "Session deleted",
      description: `${title} is archived. Restore it from ${summary.repo}'s Archived Sessions.`,
      action: { label: "Undo", onAction: () => command("Restore", hub.restoreSession(summary.id)) },
    })
    void navigate({ to: "/" })
  }
  const agent = agentId === undefined ? undefined : transcript.agents.get(agentId)
  const closeAgent = () => onAgentChange?.(undefined)

  // ── Threads (docs/design/durable-harness.md) ──
  const sideBySide = useMediaQuery(SIDE_BY_SIDE)
  const panelOf: ThreadPanelOf | undefined =
    agentId !== undefined
      ? undefined
      : threadId !== undefined
        ? { kind: "thread", threadId, thread: transcript.threads.get(threadId) }
        : forkOf !== undefined
          ? { kind: "new", anchorTurnId: forkOf }
          : undefined
  const anchorTurnId =
    panelOf?.kind === "new" ? panelOf.anchorTurnId : panelOf?.thread?.anchorTurnId
  // The thread you just made from the composer: opening it keeps focus there.
  const [made, setMade] = useState<ThreadId | undefined>(undefined)
  const anchor = useMemo(
    () => (anchorTurnId === undefined ? undefined : findTurn(items, anchorTurnId)),
    [items, anchorTurnId],
  )
  const reply = useCallback(
    (turnId: TurnId) => {
      // The Turn's latest thread opens if one was just started off it by you; a new one otherwise.
      onThreadChange?.({ fork: turnId })
    },
    [onThreadChange],
  )
  // An Archived Session starts no threads: its ⌘K doesn't offer one either.
  const threads = useMemo<TranscriptThreads>(
    () => ({
      anchored: transcript.anchored,
      open: threadId,
      forking: forkOf,
      onReply: archived ? undefined : reply,
    }),
    [transcript.anchored, threadId, forkOf, reply, archived],
  )
  // A Turn jumped to from a thread scrolls into view and lights up for a moment.
  const flashed = useRef<ReturnType<typeof setTimeout>>(undefined)
  const jumpToTurn = (turnId: TurnId) => {
    const show = () => {
      const element = scroller.ref.current?.querySelector<HTMLElement>(
        `[data-turn="${CSS.escape(turnId)}"]`,
      )
      if (!element) return
      const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches
      element.scrollIntoView({ block: "start", behavior: reduced ? "auto" : "smooth" })
      element.tabIndex = -1
      element.focus({ preventScroll: true })
      element.setAttribute("data-flash", "")
      clearTimeout(flashed.current)
      flashed.current = setTimeout(() => element.removeAttribute("data-flash"), 1_400)
    }
    // Narrow, the thread steps aside first, to show the conversation.
    if (sideBySide) show()
    else {
      onThreadChange?.(undefined)
      requestAnimationFrame(() => requestAnimationFrame(show))
    }
  }
  useEffect(() => () => clearTimeout(flashed.current), [])
  const latestTurn = useMemo(() => findLatestTurn(items), [items])

  const keptAwake =
    summary.keepAwake === undefined ? undefined : keptAwakeText(summary.keepAwake, you?.id)
  const terminalOpen = view === "terminal"
  const showTerminal = (open: boolean) => onTabChange?.(open ? "terminal" : "chat")
  const actions: SessionActions = {
    rename: () => setRenaming(true),
    compact: () => setCompacting(true),
    setKeepAwake: (on) => command("Keep awake", hub.setKeepAwake(summary.id, on)),
    // The Hub only puts a Session to sleep once started, with nothing running or waiting.
    sleep:
      busy || running || queue.length > 0
        ? undefined
        : () =>
            interrupting({
              title: "Put the Session to sleep?",
              action: "Sleep now",
              go: () => command("Sleep", hub.sleepSession(summary.id)),
            }),
    restart: state === "Active" && !busy ? restart.ask : undefined,
    remove,
  }
  // ⌘K offers what the ⋯ menu does (#399), and a thread off the latest answer.
  const kept = summary.keepAwake !== undefined
  const canSleep = actions.sleep !== undefined
  const canRestart = actions.restart !== undefined
  const latestTurnId = latestTurn?.turnId
  const thisSession = useMemo(
    () =>
      archived
        ? undefined
        : {
            label: "This Session",
            commands: [
              ...(latestTurnId !== undefined
                ? [
                    {
                      id: "reply-in-thread",
                      label: "Reply in Thread to the latest answer",
                      run: () => reply(latestTurnId),
                    },
                  ]
                : []),
              { id: "compact", label: "Compact conversation…", run: actions.compact },
              { id: "rename", label: "Rename", run: actions.rename },
              {
                id: "keep-awake",
                label: kept ? "Stop keeping awake" : "Keep awake",
                run: () => actions.setKeepAwake(!kept),
              },
              ...(actions.sleep ? [{ id: "sleep", label: "Sleep now", run: actions.sleep }] : []),
              ...(actions.restart
                ? [{ id: "restart", label: "Restart", run: actions.restart }]
                : []),
              ...(canTerminal
                ? [
                    {
                      id: "terminal",
                      label: terminalOpen ? "Close the terminal" : "Open the terminal",
                      run: () => showTerminal(!terminalOpen),
                    },
                  ]
                : []),
              { id: "delete", label: "Delete Session", run: actions.remove },
            ],
          },
    // Rebuilt when what it offers changes, not on every render.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
    [archived, kept, canSleep, canRestart, canTerminal, terminalOpen, latestTurnId, summary.id],
  )
  useCommands(thisSession)

  // On a phone the terminal takes the view, so the conversation steps aside while it's open; so
  // does a thread where there's no room for it beside the conversation.
  const wide = useMediaQuery(WIDE)
  const panelShown = panelOf !== undefined
  const conversationShown = (wide || !terminalOpen) && (sideBySide || !panelShown)
  const accounts = accountsOf(summary, you)

  const titleStrip = (
    <TitleStrip
      summary={summary}
      // Its name, edited in place: anyone may rename it, whatever its state.
      title={
        renaming ? (
          <InlineEdit
            label="Session name"
            defaultValue={title}
            placeholder={summary.workBranch}
            maxLength={MaxSessionNameLength}
            // A rename that isn't sent keeps the field open, with what was typed.
            onCommit={(typed) => {
              const sent = renameSession(hub, summary, typed)
              if (sent) setRenaming(false)
              return sent
            }}
            onCancel={() => setRenaming(false)}
            sx={[styles.nameField, fieldText.title]}
          />
        ) : (
          title
        )
      }
      meta={
        <>
          {summary.workBranch === summary.baseBranch ? (
            `on ${summary.baseBranch}`
          ) : (
            <>
              {/* Named, the title no longer says which branch it works on. */}
              {summary.name !== undefined && `${summary.workBranch} `}from {summary.baseBranch}
            </>
          )}{" "}
          <span aria-hidden="true">·</span>{" "}
          <span {...stylex.props(styles.nowrap)}>{accountsPay(summary, you)}</span>
          <SessionCost transcript={transcript} accounts={accounts} />
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
      presence={presence}
      actions={actions}
    />
  )

  return (
    <ModelNamesContext value={nameModel}>
      <main {...stylex.props(styles.view)}>
        <Dialog
          size="sm"
          open={confirming !== null}
          onOpenChange={(open) => {
            if (open) return
            confirming?.cancel?.()
            setConfirming(null)
          }}
          title={confirming?.title}
          description={confirming?.description ?? pausedText(runningAgents, runningThreads)}
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
        <CompactDialog
          open={compacting}
          onOpenChange={setCompacting}
          onCompact={(instructions) =>
            command("Compact", hub.compact(summary.id, { instructions }))
          }
        />

        <div {...stylex.props(styles.body)}>
          {agentId !== undefined ? (
            <div
              hidden={!conversationShown}
              {...stylex.props(styles.conversation, !conversationShown && styles.hidden)}
            >
              {titleStrip}
              <AgentPanel session={summary} agentId={agentId} agent={agent} onClose={closeAgent} />
            </div>
          ) : (
            <div
              hidden={!conversationShown}
              {...stylex.props(styles.conversation, !conversationShown && styles.hidden)}
            >
              {titleStrip}
              <div ref={scroller.ref} onScroll={scroller.onScroll} {...stylex.props(styles.scroll)}>
                <div {...stylex.props(styles.column, styles.transcript)}>
                  <StateBanner
                    summary={summary}
                    change={transcript.stateChange}
                    running={running}
                    startLog={startLog}
                    restart={restart}
                    onWake={() => command("Wake", hub.wakeSession(summary.id))}
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
                      description="Send the first prompt. Everyone in the Session sees the answer as it streams, and can reply in a Thread off it."
                    />
                  ) : (
                    <Transcript
                      sessionId={summary.id}
                      items={items}
                      nameTurnModel={nameTurnModel}
                      nameReplier={nameReplier}
                      threads={threads}
                    />
                  )}
                </div>
              </div>

              <AgentChips agents={summary.agents ?? []} onOpen={(id) => onAgentChange?.(id)} />
              <div {...stylex.props(styles.column, styles.dock)}>
                {transcript.plan !== undefined && (
                  <PlanDock plan={transcript.plan} live={transcript.running !== undefined} />
                )}
                <QuestionDock
                  summary={summary}
                  questions={transcript.questions}
                  picks={questionPicks}
                />
                <PromptQueue
                  queue={queue}
                  onCancel={(prompt) => {
                    if (!hub.cancelPrompt(summary.id, prompt.id)) notSent("Cancel")
                  }}
                  onSteer={
                    steerable
                      ? (prompt) => {
                          if (command("Steer", hub.steerPrompt(summary.id, prompt.id)))
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
                      ? `${nameReplier(undefined)} is waiting on an answer: a reply here declines its question.`
                      : hint
                  }
                  attach={attach}
                  placeholder="Send a prompt"
                  {...(asking && { copy: replyCopy, needsText: true })}
                  tools={
                    archived ? undefined : (
                      <ComposerTools
                        keptAwake={keptAwake}
                        setKeepAwake={(on) =>
                          command("Keep awake", hub.setKeepAwake(summary.id, on))
                        }
                        terminal={{
                          open: terminalOpen,
                          toggle: () => showTerminal(!terminalOpen),
                        }}
                      />
                    )
                  }
                  picker={
                    <ModelPicker
                      models={models}
                      connectable={connectable}
                      value={shownSetting}
                      onChange={pick}
                      owner={yours ? undefined : summary.creator.name}
                      footer={`Runs on ${accounts}.`}
                      disabled={archived}
                      side="top"
                    />
                  }
                />
              </div>
            </div>
          )}
          {panelOf !== undefined && (!terminalOpen || wide) && (
            <ThreadPanel
              key={panelOf.kind === "thread" ? panelOf.threadId : `new-${panelOf.anchorTurnId}`}
              session={summary}
              of={panelOf}
              anchor={anchor}
              models={models}
              connectable={connectable}
              sessionSetting={setting}
              layout={sideBySide ? "side" : "full"}
              onClose={() => onThreadChange?.(undefined)}
              onJumpToAnchor={jumpToTurn}
              focusComposer={panelOf.kind === "thread" && panelOf.threadId === made}
              onCreated={(created) => {
                setMade(created)
                onThreadChange?.({ thread: created }, { replace: true })
              }}
            />
          )}
        </div>

        {/* Mounted once opened, and kept while hidden, so its scrollback survives. */}
        {shownTerminal && canTerminal && (
          <TerminalSheet open={terminalOpen} onClose={() => showTerminal(false)}>
            <Suspense
              fallback={
                <div {...stylex.props(styles.centered)}>
                  <Spinner label="Loading the terminal" />
                </div>
              }
            >
              <TerminalPanel session={summary} />
            </Suspense>
          </TerminalSheet>
        )}
      </main>
    </ModelNamesContext>
  )
}

/** The main conversation's Turn of this id, if it has it. */
function findTurn(
  items: JoinedSession["transcript"]["items"],
  turnId: TurnId,
): TurnView | undefined {
  for (const item of items)
    if (item.kind === "turn" && item.turn.turnId === turnId) return item.turn
  return undefined
}

/** The main conversation's latest Turn a person or an agent prompted, to reply to from ⌘K. */
function findLatestTurn(items: JoinedSession["transcript"]["items"]): TurnView | undefined {
  for (let index = items.length - 1; index >= 0; index--) {
    const item = items[index]
    if (item?.kind === "turn") return item.turn
  }
  return undefined
}

/** What a restart or sleep does to what runs in the background, which the durable agent resumes. */
function pausedText(agents: number, threads: number): string {
  const parts = [
    ...(agents > 0 ? [agents === 1 ? "an agent" : `${agents} agents`] : []),
    ...(threads > 0 ? [threads === 1 ? "a Thread" : `${threads} Threads`] : []),
  ]
  const what = parts.join(" and ")
  const one = agents + threads === 1
  return `${what.charAt(0).toUpperCase()}${what.slice(1)} ${one ? "is" : "are"} running. ${one ? "It pauses" : "They pause"}, and ${one ? "picks" : "pick"} up where ${one ? "it" : "they"} left off once the Session is back.`
}

/** The prompt box's words while the agent waits on an answer to its question (#193). */
const replyCopy = {
  field: "Reply",
  placeholder: "Or reply directly…",
  send: "Reply",
  stop: "Stop",
} as const

/** Says so when a command couldn't be sent for want of a connection to the Hub. */
function command(what: string, sent: boolean): boolean {
  if (!sent) notSent(what)
  return sent
}

/** Something that pauses the Session's background work, confirmed first while it runs. */
interface Interruption {
  readonly title: string
  /** What the dialog says; absent, what runs in the background and that it resumes. */
  readonly description?: string
  /** Its button's label. */
  readonly action: string
  readonly go: () => void
  /** What not going on with it undoes. */
  readonly cancel?: () => void
}

/** A model and thinking level picked, from the setting it was picked on, and whether it was sent. */
interface PickedSetting {
  readonly from: ModelSetting
  readonly to: ModelSetting
  readonly sent: boolean
}

/** How long a sent switch shows without word from the Hub, as when it refuses it. */
const switchSentMs = 5_000

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
      intent="neutral"
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
        ? `${asker ? `${asker} asked for a restart. ` : ""}Stopping its Sandbox, to start it again on ${summary.repo}'s latest Environment. Whatever was running picks up where it left off. `
        : version === undefined
          ? "Starting a fresh Sandbox. "
          : `Starting the Sandbox on version ${version} of ${summary.repo}'s Environment: building it if its Runner hasn't yet, which can take a few minutes, then running its Start script. `}
      Prompts sent now wait in the queue until it's up.
    </Banner>
  )
}

/**
 * Shown while the Session is starting or restarting, Frozen, Asleep or Archived, or runs on an
 * older Environment or other Installations than its Repo's, with why from its latest state change.
 * Anyone in it can restart, wake or restore it.
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
            intent="neutral"
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
      // Installations change no Environment version (ADR 0020): the agent is given them as it starts.
      return (
        <Banner
          intent="neutral"
          icon={<InfoIcon />}
          title="MCP servers changed"
          action={restartButton}
        >
          {summary.repo}'s Installations changed since this Session started, and the agent gets its
          MCP servers as it starts. A Restart applies the change, with the Workspace and
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
            // What the agent printed before it exited on its own, as why it did (#105).
            summary.lastOutput !== undefined && (
              <Disclosure variant="plain" summary="Show its last output">
                <LogView label="Its last output">{summary.lastOutput}</LogView>
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
