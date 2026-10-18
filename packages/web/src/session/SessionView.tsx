import {
  type AgentId,
  type AttachmentId,
  type Harness,
  harnessOfModel,
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
import { useCommands } from "../app/commands.tsx"
import { notSent } from "../app/copy.ts"
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
import { Composer } from "./Composer.tsx"
import { useDriveRefusal } from "./drive.ts"
import { InstallationsFailedBanner } from "./InstallationsFailed.tsx"
import { keptAwakeText } from "./keepAwake.ts"
import { ModelPicker, ModelSettingLabel } from "./ModelPicker.tsx"
import {
  harnessNames,
  isClaudeModel,
  knownModelLabel,
  type ModelSetting,
  modelName,
  otherProviderTurnModel,
  otherTurnModel,
  providerModelLabel,
} from "./models.ts"
import { PromptQueue } from "./PromptQueue.tsx"
import { QuestionDock } from "./QuestionCard.tsx"
import {
  AgentChips,
  ComposerTools,
  type SessionActions,
  TerminalSheet,
  TitleStrip,
} from "./SessionChrome.tsx"
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
 *
 * Only its Creator drives it (ADR 0026). Anyone else watches: the composer is disabled, saying
 * why, and what would drive it is hidden, the terminal included.
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
  // change of model or thinking level ask first, with what they'd interrupt.
  const runningAgents = summary.agents?.filter((agent) => agent.status === "Running").length ?? 0
  const [confirming, setConfirming] = useState<Interruption | null>(null)
  const interrupting = (interruption: Interruption) => {
    if (runningAgents === 0) interruption.go()
    else setConfirming(interruption)
  }
  const asked = useRestart(summary, () => command("Restart", hub.restartSession(summary.id)))
  const restart: Restart = {
    asked: asked.asked,
    ask: () => interrupting({ title: "Restart the Session?", action: "Restart", go: asked.ask }),
  }

  // Its model and thinking level (#128): Claude Code's from what its Runner said its Claude Code
  // has; pi's from its Creator's Models (ADR 0029), which only they are sent, so anyone else knows
  // a pi Session's Model by the name the transcript last gave it. Its Creator may pick any Model its
  // Runner can run, on either Harness (ADR 0030). While a switch of Harness waits for a Turn to end,
  // the Session still runs on its Harness, but its model is the other's already: the model is named
  // and found by the Harness it names.
  const harness = summary.harness ?? "ClaudeCode"
  const pi = harness === "Pi"
  const modelOnPi = harnessOfModel(summary.model) === "Pi"
  const runner = useHubState((hubState) =>
    hubState.runners?.find((candidate) => candidate.id === summary.runnerId),
  )
  const models = runner?.models
  // A Runner from before pi runs Claude Code alone.
  const runnerHarnesses = runner?.harnesses ?? ["ClaudeCode"]
  const yours = useHubState((hubState) => hubState.you?.id === summary.creator.id)
  const providerModels = useHubState((hubState) => (yours ? hubState.providers?.models : undefined))
  const connectable = useHubState((hubState) =>
    yours ? hubState.providers?.connectable : undefined,
  )
  // Claude Code runs on its Creator's setup token (ADR 0026): without one, it isn't offered.
  const hasClaudeCredential = useHubState((hubState) => hubState.claudeCredential !== null)
  // Looked for only when the log or the model changes, not on every change the Hub sends.
  const log = useHubState((hubState) => hubState.joined[summary.id]?.log)
  const knownLabel = useMemo(
    () => (modelOnPi ? knownModelLabel(log ?? [], summary.model) : undefined),
    [modelOnPi, log, summary.model],
  )
  const offered = {
    ...(((runnerHarnesses.includes("ClaudeCode") && hasClaudeCredential) || !pi) && {
      claudeCode: { models },
    }),
    ...((runnerHarnesses.includes("Pi") || pi) && { pi: { models: providerModels, connectable } }),
  }
  const setting = useMemo(
    () => ({
      ...(summary.model !== undefined && { model: summary.model }),
      ...(summary.thinkingLevel !== undefined && { thinkingLevel: summary.thinkingLevel }),
    }),
    [summary.model, summary.thinkingLevel],
  )
  // A switch shows in the picker from the pick, while it is asked about and then sent, until the
  // Hub says the Session's setting: a cancel, or a refusal, shows the setting again.
  const [picked, setPicked] = useState<PickedSetting | null>(null)
  const shownSetting = picked !== null && picked.from === setting ? picked.to : setting
  useEffect(() => {
    if (!picked?.sent) return
    const timer = setTimeout(() => setPicked(null), switchSentMs)
    return () => clearTimeout(timer)
  }, [picked])
  // The other Harness's Model switches the Session to it (ADR 0030), which is said first, once. A
  // pi Session switches between Turns without stopping anything (ADR 0029), so it doesn't ask;
  // Claude Code restarts, which asks while agents run.
  const pick = (next: ModelSetting) => {
    const from = setting
    setPicked({ from, to: next, sent: false })
    const go = () =>
      setPicked(
        command("Model change", hub.setSessionModel(summary.id, next))
          ? { from, to: next, sent: true }
          : null,
      )
    const cancel = () => setPicked(null)
    const to = harnessOfModel(next.model)
    if (to !== harness)
      setConfirming({
        title: `Switch to ${harnessNames[to]}?`,
        description: harnessSwitchText(to, runningAgents),
        action: "Switch",
        go,
        cancel,
      })
    else if (pi) go()
    else interrupting({ title: "Switch the model?", action: "Switch", go, cancel })
  }
  // A Turn that ran on another Model than the Session's is named, as one from before a switch,
  // of Harness too: by its Runner's name for it, or its Creator's Model's.
  const nameTurnModel = useCallback(
    (model: string) =>
      modelOnPi
        ? otherProviderTurnModel(providerModels, setting, model)
        : otherTurnModel(models, setting, model, providerModels),
    [modelOnPi, models, providerModels, setting],
  )
  const settingName = modelOnPi
    ? providerModelLabel(providerModels, setting, knownLabel)
    : modelName(models, setting)
  // Who answers: Claude, on Claude Code, unless a Turn from before a switch ran another Provider's
  // Model; on pi, the Model a Turn ran, by name, or the Session's.
  const nameReplier = useCallback(
    (turnModel: string | undefined) =>
      !modelOnPi
        ? turnModel === undefined || isClaudeModel(turnModel)
          ? "Claude"
          : (otherTurnModel(models, setting, turnModel, providerModels) ?? "Claude")
        : turnModel === undefined
          ? settingName
          : (otherProviderTurnModel(providerModels, setting, turnModel) ?? settingName),
    [modelOnPi, models, providerModels, setting, settingName],
  )

  const you = useHubState((hubState) => hubState.you)
  // Only its Creator drives it (ADR 0026): anyone else watches.
  const cantDrive = useDriveRefusal(summary)
  const drives = cantDrive === undefined
  // On Claude Code, it runs on its Creator's setup token, and can't wake without one.
  const noToken = useHubState((hubState) => !pi && hubState.claudeCredential === null)
  const state = summary.state
  // Being started or restarted, it can't be put to sleep or restarted (#70).
  const busy = summary.starting !== undefined || summary.restarting !== undefined
  const disabledReason =
    cantDrive ?? (state === "Archived" ? "Archived: restore it to send prompts" : undefined)
  const hint = !drives
    ? undefined
    : busy
      ? `${summary.restarting ? "Restarting" : "Starting"}: prompts wait in the queue until ${pi ? "it's" : "Claude Code is"} up.`
      : summary.modelPending === true && running
        ? `${settingName} takes over when this Turn ends.`
        : state === "Asleep"
          ? noToken
            ? "Asleep: add a setup token on your Account page to wake it."
            : "Asleep: sending a prompt wakes it."
          : state === "Frozen"
            ? "Frozen: prompts wait in the queue until its Runner is back."
            : undefined

  // While Claude asks a question (#193), what is sent declines it and goes to Claude instead.
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
  // An Archived Session has no terminal to open, and someone watching sees none (ADR 0026): it
  // shows its conversation only.
  const archived = state === "Archived"
  const view: SessionTab = archived || !drives ? "chat" : tab
  const canTerminal = !archived && drives
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

  const keptAwake =
    summary.keepAwake === undefined ? undefined : keptAwakeText(summary.keepAwake, you?.id)
  const terminalOpen = view === "terminal"
  const showTerminal = (open: boolean) => onTabChange?.(open ? "terminal" : "chat")
  const actions: SessionActions = {
    rename: () => setRenaming(true),
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
  // ⌘K offers its Creator what the ⋯ menu does (#399).
  const kept = summary.keepAwake !== undefined
  const canSleep = actions.sleep !== undefined
  const canRestart = actions.restart !== undefined
  const thisSession = useMemo(
    () =>
      drives && !archived
        ? {
            label: "This Session",
            commands: [
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
          }
        : undefined,
    // Rebuilt when what it offers changes, not on every render.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
    [drives, archived, kept, canSleep, canRestart, canTerminal, terminalOpen, summary.id],
  )
  useCommands(thisSession)

  // On a phone the terminal takes the view, so the conversation steps aside while it's open.
  const wide = useMediaQuery(WIDE)
  const conversationShown = wide || !terminalOpen

  return (
    <main {...stylex.props(styles.view)}>
      <TitleStrip
        summary={summary}
        // Its name, edited in place: its Creator may rename it, whatever its state.
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
            {drives ? "you drive it" : `${summary.creator.name} drives it`}
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
        drives={drives}
        presence={presence}
        actions={actions}
      />

      <Dialog
        size="sm"
        open={confirming !== null}
        onOpenChange={(open) => {
          if (open) return
          confirming?.cancel?.()
          setConfirming(null)
        }}
        title={confirming?.title}
        description={
          confirming?.description ??
          `${
            runningAgents === 1 ? "An agent is running" : `${runningAgents} agents are running`
          }; stopping ${pi ? "the Session" : "Claude Code"} interrupts ${runningAgents === 1 ? "it" : "them"}. A message to an interrupted agent resumes it.`
        }
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

      {conversationShown &&
        (agentId !== undefined ? (
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
                  drives={drives}
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
                    description={
                      drives
                        ? `Send the first prompt. Everyone in the Session sees ${pi ? "the" : "Claude's"} answer as it streams.`
                        : `Once ${summary.creator.name} sends the first prompt, you see ${pi ? "the" : "Claude's"} answer here as it streams.`
                    }
                  />
                ) : (
                  <Transcript
                    sessionId={summary.id}
                    items={items}
                    nameTurnModel={nameTurnModel}
                    nameReplier={nameReplier}
                  />
                )}
              </div>
            </div>

            <AgentChips agents={summary.agents ?? []} onOpen={(id) => onAgentChange?.(id)} />
            <div {...stylex.props(styles.column, styles.dock)}>
              <QuestionDock
                summary={summary}
                questions={transcript.questions}
                picks={questionPicks}
                drives={drives}
              />
              <PromptQueue
                queue={queue}
                onCancel={
                  drives
                    ? (prompt) => {
                        if (!hub.cancelPrompt(summary.id, prompt.id)) {
                          notSent("Cancel")
                        }
                      }
                    : undefined
                }
                onSteer={
                  drives && steerable
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
                onStop={drives ? () => hub.stopTurn(summary.id) : undefined}
                running={running}
                disabledReason={disabledReason}
                hint={
                  drives && asking
                    ? `${nameReplier(undefined)} is waiting on an answer: a reply here declines its question.`
                    : hint
                }
                attach={drives ? attach : undefined}
                {...(pi && { placeholder: "Send a prompt" })}
                {...(drives && asking && { copy: replyCopy, needsText: true })}
                tools={
                  drives && !archived ? (
                    <ComposerTools
                      keptAwake={keptAwake}
                      setKeepAwake={(on) => command("Keep awake", hub.setKeepAwake(summary.id, on))}
                      terminal={{ open: terminalOpen, toggle: () => showTerminal(!terminalOpen) }}
                    />
                  ) : undefined
                }
                picker={
                  drives ? (
                    <ModelPicker
                      {...offered}
                      value={shownSetting}
                      onChange={pick}
                      disabled={archived}
                      side="top"
                    />
                  ) : (
                    // Someone watching sees what it runs on, but can't change it (ADR 0026).
                    <ModelSettingLabel
                      claudeCode={{ models }}
                      pi={{ models: providerModels }}
                      value={setting}
                      knownLabel={knownLabel}
                    />
                  )
                }
              />
            </div>
          </>
        ))}

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
  )
}

/** The prompt box's words while Claude waits on an answer to its question (#193). */
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

/**
 * What a switch to the other Harness does (ADR 0030), said once before it is sent: its own
 * conversation, a handoff, a relaunch the next prompt waits for, and the agents it interrupts.
 */
function harnessSwitchText(to: Harness, runningAgents: number): string {
  const agents =
    runningAgents === 0
      ? ""
      : ` It interrupts ${runningAgents === 1 ? "the running agent" : `${runningAgents} running agents`}.`
  return `Switching to ${harnessNames[to]} continues in its own conversation, with a handoff of this one. The next prompt waits until it's up.${agents}`
}

/**
 * Something that stops the Session's Claude Code, confirmed first while agents run; or a switch of
 * Harness, always confirmed.
 */
interface Interruption {
  readonly title: string
  /** What the dialog says; absent, which running agents it interrupts. */
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
 *
 * The output is shown here rather than in the Terminal tab: the terminal draws only from a
 * Snapshot of Claude Code's screen, which there is none of until Claude Code is up, and the chat
 * is where people wait for it.
 */
function StartingBanner({
  summary,
  startLog,
  drives,
}: {
  summary: SessionSummary
  startLog: JoinedSession["startLog"]
  drives: boolean
}) {
  const { starting, restarting } = summary
  const you = useHubState((state) => state.you)
  const asker = restarting && (restarting.by.id === you?.id ? "You" : restarting.by.name)
  const output = starting && startLog?.since === starting.since ? startLog.text : ""
  const plain = useMemo(() => terminalText(output), [output])
  const version = starting?.environmentVersion
  const pi = summary.harness === "Pi"
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
        ? `${asker ? `${asker} asked for a restart. ` : ""}${pi ? "Stopping its Sandbox, to start it" : "Stopping Claude Code and its Sandbox, to start them"} again on ${summary.repo}'s latest Environment. `
        : version === undefined
          ? pi
            ? "Starting a fresh Sandbox. "
            : "Starting Claude Code in a fresh Sandbox. "
          : `Starting the Sandbox on version ${version} of ${summary.repo}'s Environment: building it if its Runner hasn't yet, which can take a few minutes, then running its Start script. `}
      {drives && `Prompts sent now wait in the queue until ${pi ? "it's" : "Claude Code is"} up.`}
    </Banner>
  )
}

/**
 * Shown while the Session is starting or restarting, Frozen, Asleep or Archived, or runs on an
 * older Environment or other Installations than its Repo's, with why from its latest state change.
 * Its Restart, Wake and Restore are its Creator's alone (ADR 0026): someone watching sees why, but
 * not them.
 */
function StateBanner({
  summary,
  change,
  running,
  startLog,
  drives,
  restart,
  onWake,
  onRestore,
  onEnterValues,
}: {
  summary: SessionSummary
  change: SessionStateChanged | undefined
  running: boolean
  startLog: JoinedSession["startLog"]
  /** Whether the signed-in person drives the Session. */
  drives: boolean
  restart: Restart
  onWake: () => void
  onRestore: () => void
  onEnterValues: () => void
}) {
  const navigate = useNavigate()
  // Its Creator's setup token, which it can't wake without (ADR 0026); undefined while loading.
  const credential = useHubState((state) => state.claudeCredential)
  // A pi Session runs on its Creator's Connected providers, and wakes without one (ADR 0029).
  const pi = summary.harness === "Pi"
  const why = change?.state === summary.state ? change.message : undefined
  const busy = summary.starting !== undefined || summary.restarting !== undefined
  if (busy && (summary.state === "Active" || summary.state === "Asleep")) {
    return <StartingBanner summary={summary} startLog={startLog} drives={drives} />
  }
  switch (summary.state) {
    case "Active": {
      const environment = summary.environment
      const mcpServers = mcpServersChanged(summary)
      const restartButton = drives && (
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
            {drives ? running && " Once the running Turn ends." : ` ${restarter(summary)}`}
          </Banner>
        )
      }
      if (!mcpServers) return null
      // Installations change no Environment version (ADR 0020): Claude Code is given them as it starts.
      return (
        <Banner
          intent="neutral"
          icon={<InfoIcon />}
          title="MCP servers changed"
          action={restartButton}
        >
          {summary.repo}'s Installations changed since this Session started, and{" "}
          {pi ? "the Session gets" : "Claude Code gets"} its MCP servers as it starts. A Restart
          applies the change, with the Workspace and conversation as they are.
          {drives ? running && " Once the running Turn ends." : ` ${restarter(summary)}`}
        </Banner>
      )
    }
    case "Frozen":
      return (
        <Banner intent="frozen" icon={<InfoIcon />} title="This Session is Frozen">
          {why ? sentence(why) : "Its Runner is offline. "}
          {drives && "Prompts sent now wait in the queue until the Runner is back."}
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
            {drives && "Prompts sent now wait in the queue until it starts."}
          </Banner>
        )
      }
      // It didn't start for its Repo's Installations (#216): fixing them, or taking it off, will.
      if (change?.state === "Asleep" && (change.installationsFailed?.length ?? 0) > 0) {
        return (
          <InstallationsFailedBanner
            summary={summary}
            failures={change.installationsFailed ?? []}
            onRetry={drives ? onWake : undefined}
          />
        )
      }
      // It runs on its Creator's setup token, and can't wake without one (ADR 0026).
      if (drives && !pi && credential === null) {
        return (
          <Banner
            intent="danger"
            icon={<InfoIcon />}
            title="This Session can't wake"
            action={
              <Button size="sm" onClick={() => void navigate({ to: "/account" })}>
                Add a setup token
              </Button>
            }
          >
            {why ? sentence(why) : ""}
            It runs on your Claude setup token, and you have none on this Hub. Add one on your
            Account page, then wake it.
          </Banner>
        )
      }
      return (
        <Banner
          intent="asleep"
          icon={<InfoIcon />}
          title="This Session is Asleep"
          action={
            drives && (
              <Button size="sm" onClick={onWake}>
                Wake now
              </Button>
            )
          }
          detail={
            // What Claude Code printed before it exited on its own, as why it did (#105).
            summary.lastOutput !== undefined && (
              <Disclosure
                variant="plain"
                summary={pi ? "Show its last output" : "Show Claude Code's last output"}
              >
                <LogView label={pi ? "Its last output" : "Claude Code's last output"}>
                  {summary.lastOutput}
                </LogView>
              </Disclosure>
            )
          }
        >
          {why ? sentence(why) : ""}
          {drives
            ? "Its Sandbox is stopped. Sending a prompt wakes it, with its Workspace and conversation as they were."
            : `Its Sandbox is stopped until ${summary.creator.name} wakes it.`}
        </Banner>
      )
    case "Archived": {
      const archived = summary.archived
      return (
        <Banner
          icon={<InfoIcon />}
          title="This Session is Archived"
          action={
            drives && (
              <Button size="sm" onClick={onRestore}>
                Restore
              </Button>
            )
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

/** Who may restart a Session, for someone watching it (ADR 0026). */
const restarter = (summary: SessionSummary) => `Only ${summary.creator.name} can restart it.`

/** The reason as a sentence, with a space after it for the one that follows. */
const sentence = (reason: string) => (/[.!?]$/.test(reason) ? `${reason} ` : `${reason}. `)
