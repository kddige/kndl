// A thread's panel (docs/design/durable-harness.md): a fork of the main conversation at one of
// its Turns' answers, which runs beside it, on a model of its own: the Session's as it was when the
// thread started, until someone picks another. Anyone here posts into it; a post while it replies
// steers the reply. Beside the conversation on a wide screen, so
// both stream at once; the whole view on a narrow one.

import type {
  AttachmentId,
  ConnectableProvider,
  ProviderModel,
  RequestId,
  SessionSummary,
  ThreadId,
  TurnId,
} from "@kndl/protocol"
import * as stylex from "@stylexjs/stylex"
import { useEffect, useId, useRef, useState } from "react"
import { accountsOf, notSent, sentence } from "../app/copy.ts"
import { clock, spent } from "../app/format.ts"
import { useHub, useHubState } from "../app/hub.tsx"
import { CommandError } from "../hub/client.ts"
import type { FailedPrompt, SentPrompt, ThreadView, TurnView } from "../hub/transcript.ts"
import {
  ArrowLeftIcon,
  Avatar,
  Button,
  CloseIcon,
  CompactIcon,
  EmptyState,
  IconButton,
  Markdown,
  Menu,
  MenuItem,
  MoreIcon,
  Spinner,
  ThreadIcon,
  WarningIcon,
} from "../ui/index.ts"
import { focus, srOnly } from "../ui/shared.ts"
import { color, leading, motion, radius, space, text, weight } from "../ui/tokens.stylex.ts"
import { CompactDialog } from "./Compaction.tsx"
import { Composer, type ComposerCopy } from "./Composer.tsx"
import { ModelPicker } from "./ModelPicker.tsx"
import { modelLabel, type ModelSetting, providerModelLabel, useNameReplier } from "./models.ts"
import { PlanDock } from "./Plan.tsx"
import { SentAttachments } from "./SentAttachments.tsx"
import { useStickToBottom } from "./stickToBottom.ts"
import {
  failedThreadPrompt,
  pendingThreadPrompts,
  type PendingThreadPrompt,
  unconfirmedThreadPrompts,
} from "./threadPrompts.ts"
import { threadActivity } from "./ThreadRows.tsx"
import { Transcript } from "./Transcript.tsx"

const HOVER = "@media (hover: hover)"

const styles = stylex.create({
  panel: {
    display: "flex",
    flexDirection: "column",
    minWidth: 0,
    minHeight: 0,
    backgroundColor: color.surface,
  },
  // Beside the conversation: its own column, an edge between them, entering from its side.
  side: {
    flexShrink: 0,
    width: "clamp(22rem, 38%, 32rem)",
    borderInlineStartWidth: "1px",
    borderInlineStartStyle: "solid",
    borderInlineStartColor: color.border,
  },
  full: { flex: 1, backgroundColor: color.bg },
  header: {
    display: "flex",
    flexDirection: "column",
    gap: space.s1,
    flexShrink: 0,
    paddingBlock: space.s2,
    paddingInline: space.s4,
    borderBottomWidth: "1px",
    borderBottomStyle: "solid",
    borderBottomColor: color.border,
  },
  titleRow: { display: "flex", alignItems: "center", gap: space.s2, minHeight: "2rem" },
  titleIcon: { flexShrink: 0, color: color.accentText },
  title: {
    flex: 1,
    minWidth: 0,
    margin: 0,
    overflowWrap: "anywhere",
    fontSize: text.md,
    fontWeight: weight.semibold,
    // Focus lands here when a thread opens; it isn't a control, so it shows no ring.
    outline: "none",
  },
  meta: {
    display: "flex",
    alignItems: "center",
    flexWrap: "wrap",
    columnGap: space.s1_5,
    rowGap: space.s0_5,
    color: color.textSecondary,
    fontSize: text.sm,
    fontVariantNumeric: "tabular-nums",
  },
  dot: { color: color.textTertiary },
  live: {
    display: "inline-flex",
    alignItems: "center",
    flexShrink: 0,
    gap: space.s1_5,
    height: "1.5rem",
    paddingInline: space.s2,
    borderRadius: radius.full,
    backgroundColor: color.accentTint,
    color: color.accentText,
    fontSize: text.sm,
    fontWeight: weight.medium,
  },
  jump: {
    paddingBlock: 0,
    paddingInline: space.s0_5,
    marginInline: `calc(${space.s0_5} * -1)`,
    borderWidth: 0,
    borderRadius: radius.sm,
    backgroundColor: "transparent",
    color: color.text,
    fontFamily: "inherit",
    fontSize: "inherit",
    fontWeight: weight.medium,
    textDecorationLine: "underline",
    textDecorationColor: color.borderStrong,
    textUnderlineOffset: "2px",
    cursor: "pointer",
    transitionProperty: "text-decoration-color",
    transitionDuration: motion.durationFast,
    ":hover": { textDecorationColor: { default: null, [HOVER]: "currentColor" } },
  },
  scroll: { flex: 1, minHeight: 0, overflowY: "auto", overscrollBehavior: "contain" },
  missing: { display: "grid", placeItems: "center", flex: 1, padding: space.s4 },
  body: {
    display: "flex",
    flexDirection: "column",
    gap: space.s5,
    paddingBlock: space.s4,
    paddingInline: space.s4,
  },
  fullColumn: { width: "100%", maxWidth: "48rem", marginInline: "auto" },
  // The answer it forked from, quoted for context.
  quote: {
    display: "flex",
    flexDirection: "column",
    gap: space.s1_5,
    margin: 0,
    paddingBlock: space.s2,
    paddingInline: space.s3,
    borderInlineStartWidth: "2px",
    borderInlineStartStyle: "solid",
    borderInlineStartColor: color.borderStrong,
    borderRadius: radius.sm,
    backgroundColor: color.surfaceMuted,
  },
  quoteHead: {
    display: "flex",
    alignItems: "center",
    gap: space.s1_5,
    color: color.textSecondary,
    fontSize: text.sm,
  },
  quotePrompt: {
    margin: 0,
    color: color.textSecondary,
    fontSize: text.sm,
    lineHeight: leading.snug,
    display: "-webkit-box",
    WebkitLineClamp: 2,
    WebkitBoxOrient: "vertical",
    overflow: "hidden",
    overflowWrap: "anywhere",
  },
  answer: { position: "relative", fontSize: text.sm },
  toggle: {
    alignSelf: "flex-start",
    paddingBlock: 0,
    paddingInline: space.s1,
    marginInline: `calc(${space.s1} * -1)`,
    borderWidth: 0,
    borderRadius: radius.sm,
    backgroundColor: {
      default: "transparent",
      ":hover": { default: null, [HOVER]: color.surfaceHover },
    },
    color: color.accentText,
    fontFamily: "inherit",
    fontSize: text.sm,
    fontWeight: weight.medium,
    cursor: "pointer",
  },
  intro: { margin: 0, color: color.textSecondary, fontSize: text.sm, lineHeight: leading.normal },
  sentList: { display: "flex", flexDirection: "column", gap: space.s3 },
  sent: { display: "flex", flexDirection: "column", gap: space.s1 },
  sentHead: {
    display: "flex",
    alignItems: "center",
    gap: space.s2,
    minWidth: 0,
    fontSize: text.sm,
  },
  name: { fontWeight: weight.semibold },
  sentNote: {
    display: "inline-flex",
    alignItems: "center",
    gap: space.s1,
    minWidth: 0,
    color: color.textTertiary,
    fontSize: text.xs,
  },
  failedNote: { color: color.dangerText },
  bubble: {
    marginInlineStart: space.s6,
    paddingBlock: space.s2,
    paddingInline: space.s3,
    borderWidth: "1px",
    borderStyle: "dashed",
    borderColor: color.borderStrong,
    borderRadius: radius.lg,
    backgroundColor: color.surfaceMuted,
    whiteSpace: "pre-wrap",
    overflowWrap: "anywhere",
    lineHeight: leading.normal,
  },
  sentFiles: { marginInlineStart: space.s6 },
  dock: {
    display: "flex",
    flexDirection: "column",
    gap: space.s2,
    flexShrink: 0,
    paddingTop: space.s2,
    paddingBottom: space.s4,
    paddingInline: space.s4,
  },
  nowrap: { whiteSpace: "nowrap" },
})

/** What the panel shows: a thread, or a new one being written off a Turn. */
export type ThreadPanelOf =
  | {
      readonly kind: "thread"
      readonly threadId: ThreadId
      readonly thread: ThreadView | undefined
    }
  | { readonly kind: "new"; readonly anchorTurnId: TurnId }

export function ThreadPanel({
  session,
  of,
  anchor,
  models,
  connectable,
  sessionSetting,
  layout,
  onClose,
  onJumpToAnchor,
  onCreated,
  focusComposer = false,
}: {
  session: SessionSummary
  of: ThreadPanelOf
  /** The main conversation's Turn it forks off, once known. */
  anchor: TurnView | undefined
  /** The Session's Models, its Creator's, for the thread's picker and to name them. */
  models: ReadonlyArray<ProviderModel> | undefined
  connectable: ReadonlyArray<ConnectableProvider> | undefined
  /** The Session's own model as it is now, which a new thread is preselected to run on. */
  sessionSetting: ModelSetting
  layout: "side" | "full"
  onClose: () => void
  onJumpToAnchor: (turnId: TurnId) => void
  /** A new thread was made from what was written: open it. */
  onCreated: (threadId: ThreadId) => void
  /** Opening it puts focus where to write rather than on its title: it was just made from there. */
  focusComposer?: boolean
}) {
  const hub = useHub()
  const titleId = useId()
  const heading = useRef<HTMLHeadingElement>(null)
  const panel = useRef<HTMLElement>(null)
  const thread = of.kind === "thread" ? of.thread : undefined
  const anchorTurnId = of.kind === "new" ? of.anchorTurnId : thread?.anchorTurnId
  const scroller = useStickToBottom(thread)
  const [compacting, setCompacting] = useState(false)
  // What was sent to start a new thread, while the Hub makes it, or why it couldn't.
  const [creating, setCreating] = useState<{
    text: string
    attachments: ReadonlyArray<AttachmentId>
    failed?: string
    /** It may have been made: the connection dropped before the Hub answered. */
    unconfirmed?: boolean
  } | null>(null)
  // The model a new thread is to run on, if one other than the Session's was picked before its
  // first prompt. Until then it is the Session's current Model, which the thread keeps.
  const [pickedSetting, setPickedSetting] = useState<ModelSetting | undefined>(undefined)
  const newSetting = pickedSetting ?? sessionSetting
  const log = useHubState((state) => state.joined[session.id]?.log)
  const connection = useHubState((state) => state.connection.status)
  const [pending, setPending] = useState<ReadonlyArray<PendingThreadPrompt>>([])
  const previews =
    of.kind === "thread" ? pendingThreadPrompts(pending, log ?? [], of.threadId) : pending
  useEffect(() => {
    if (previews !== pending) setPending(previews)
  }, [pending, previews])
  useEffect(() => {
    if (connection === "online") return
    setPending(unconfirmedThreadPrompts)
  }, [connection])
  // The replies sent from here, whose refusals this panel shows itself, in place: the app's toast
  // would say it twice.
  const sentReplies = useRef(new Set<RequestId>())
  useEffect(
    () =>
      hub.claimCommandFailure((failure) => {
        // The refusal names the reply it is for by the request id it was sent with.
        const { requestId, message } = failure
        if (failure.command !== "PromptThread" || requestId === undefined) return false
        if (!sentReplies.current.has(requestId)) return false
        setPending((prompts) => failedThreadPrompt(prompts, requestId, message))
        return true
      }),
    [hub],
  )

  // Opening a thread moves focus to it: its title, or, for a new one, or one just made from the
  // composer, where to write.
  const opened = of.kind === "thread" ? of.threadId : `new:${of.anchorTurnId}`
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
    if (of.kind === "new" || focusComposer) panel.current?.querySelector("textarea")?.focus()
    else heading.current?.focus({ preventScroll: true })
    setCreating(null)
    return () => {
      // A replacement panel gets focus first. Only return to the opener when no other control
      // took focus (closing this one), and the opener still exists.
      queueMicrotask(() => {
        if (document.activeElement === document.body && opener?.isConnected) opener.focus()
      })
    }
    // Once per thread opened, not on every change in it.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [opened])

  const archived = session.state === "Archived"
  const you = useHubState((state) => state.you)
  const accounts = accountsOf(session, you)
  const running = thread?.running !== undefined
  const threadSetting: ModelSetting =
    of.kind === "new"
      ? newSetting
      : {
          ...(thread?.model !== undefined && { model: thread.model }),
          ...(thread?.thinkingLevel !== undefined && { thinkingLevel: thread.thinkingLevel }),
        }
  const modelName =
    threadSetting.model === undefined
      ? providerModelLabel(models, threadSetting)
      : modelLabel(models, threadSetting.model)
  const nameReplier = useNameReplier(models, modelName)

  const attach = (file: File, options: Parameters<typeof hub.uploadAttachment>[2]) =>
    hub.uploadAttachment(session.id, file, options)

  const send = (prompt: string, attachments: ReadonlyArray<AttachmentId>): boolean => {
    if (of.kind === "thread") {
      const requestId = hub.promptThread(session.id, of.threadId, prompt, attachments)
      if (requestId === undefined) {
        notSent("Reply")
        return false
      }
      sentReplies.current.add(requestId)
      setPending((prompts) => [
        ...prompts,
        { requestId, after: log?.at(-1)?.seq, text: prompt.trim(), attachments },
      ])
      return true
    }
    if (creating !== null && creating.failed === undefined) return false
    setCreating({ text: prompt, attachments })
    hub.createThread(session.id, of.anchorTurnId, prompt, attachments, newSetting).then(
      (threadId) => onCreated(threadId),
      (error: unknown) =>
        setCreating({
          text: prompt,
          attachments,
          failed: error instanceof Error ? error.message : "Not sent",
          unconfirmed: error instanceof CommandError && error.unconfirmed,
        }),
    )
    return true
  }

  const pickModel = (setting: ModelSetting) => {
    if (of.kind === "new") {
      setPickedSetting(setting)
      return
    }
    const { model } = setting
    if (model === undefined) return
    if (
      !hub.setThreadModel(session.id, of.threadId, {
        model,
        ...(setting.thinkingLevel !== undefined && { thinkingLevel: setting.thinkingLevel }),
      })
    )
      notSent("Model change")
  }

  const stop = () => {
    if (of.kind === "thread" && !hub.stopThread(session.id, of.threadId)) notSent("Stop")
  }

  const copy: ComposerCopy = {
    field: "Reply",
    placeholder:
      of.kind === "new"
        ? "Ask about this answer…"
        : running
          ? "Steer the reply…"
          : "Reply in Thread…",
    send: of.kind === "new" ? "Start Thread" : running ? "Steer" : "Send reply",
    stop: "Stop",
  }
  const hint = archived
    ? undefined
    : of.kind === "new"
      ? "Forks the conversation here. The main conversation keeps going."
      : running
        ? "Sending steers the reply: it reads it at its next step."
        : session.state === "Asleep"
          ? "Asleep: a reply wakes the Session."
          : undefined
  const activity = thread && threadActivity(thread)
  // A link to a thread, or to a Turn to reply to, that the Session doesn't have.
  const missing = of.kind === "thread" ? thread === undefined : anchor === undefined
  const title = of.kind === "new" ? "New Thread" : (thread?.title ?? "Thread")
  const cost = thread?.usage?.cost

  return (
    <aside
      ref={panel}
      aria-labelledby={titleId}
      onKeyDown={(event) => {
        // From anywhere in the panel, unless something took the key first. A menu or dialog opened
        // from here is portaled out of it, so its Escape reaches this handler too: it isn't ours.
        if (
          event.key === "Escape" &&
          !event.defaultPrevented &&
          !event.nativeEvent.isComposing &&
          event.target instanceof Node &&
          event.currentTarget.contains(event.target)
        ) {
          event.preventDefault()
          onClose()
        }
      }}
      {...stylex.props(styles.panel, layout === "side" ? styles.side : styles.full)}
    >
      <header {...stylex.props(styles.header)}>
        <div {...stylex.props(styles.titleRow, layout === "full" && styles.fullColumn)}>
          {layout === "full" && (
            <IconButton label="Back to the conversation" size="sm" onClick={onClose}>
              <ArrowLeftIcon />
            </IconButton>
          )}
          <ThreadIcon {...stylex.props(styles.titleIcon)} />
          <h2
            id={titleId}
            ref={heading}
            tabIndex={-1}
            title={title}
            {...stylex.props(styles.title)}
          >
            {title}
          </h2>
          {activity !== undefined && (
            // What it does now, in words, so it reads the same without a pointer or a screen.
            <span {...stylex.props(styles.live)}>
              {running && <Spinner size="sm" />}
              {activity}…
            </span>
          )}
          {of.kind === "thread" && !archived && (
            <Menu
              align="end"
              trigger={
                <IconButton label="Thread actions" size="sm">
                  <MoreIcon />
                </IconButton>
              }
            >
              <MenuItem icon={<CompactIcon />} onClick={() => setCompacting(true)}>
                Compact Thread…
              </MenuItem>
            </Menu>
          )}
          {layout === "side" && (
            <IconButton label="Close the Thread" size="sm" onClick={onClose}>
              <CloseIcon />
            </IconButton>
          )}
        </div>
        {!missing && (
          <p {...stylex.props(styles.meta, layout === "full" && styles.fullColumn)}>
            {anchor !== undefined && anchorTurnId !== undefined ? (
              <span>
                Forked from{" "}
                <button
                  type="button"
                  onClick={() => onJumpToAnchor(anchorTurnId)}
                  {...stylex.props(styles.jump, focus.ring)}
                >
                  {anchorName(anchor)}
                </button>{" "}
                at {clock(anchor.at)}
              </span>
            ) : (
              <span>Forked from the conversation</span>
            )}
            {cost !== undefined && cost > 0 && (
              <>
                <span aria-hidden="true" {...stylex.props(styles.dot)}>
                  ·
                </span>
                <span
                  title={`What this Thread has spent, on ${accounts}`}
                  {...stylex.props(styles.nowrap)}
                >
                  {spent(cost)} spent
                </span>
              </>
            )}
          </p>
        )}
      </header>

      {missing ? (
        <div {...stylex.props(styles.missing)}>
          <EmptyState
            title={of.kind === "thread" ? "No such Thread" : "No such Turn"}
            description={
              of.kind === "thread"
                ? "The Session has no Thread with this link. It may have failed to start."
                : "The Session has no Turn with this link, so there is nothing to start a Thread off."
            }
            action={
              <Button size="sm" intent="secondary" onClick={onClose}>
                Back to the conversation
              </Button>
            }
          />
        </div>
      ) : (
        <>
          <div ref={scroller.ref} onScroll={scroller.onScroll} {...stylex.props(styles.scroll)}>
            <div {...stylex.props(styles.body, layout === "full" && styles.fullColumn)}>
              {anchor !== undefined && (
                <AnchorQuote
                  turn={anchor}
                  onJump={() => onJumpToAnchor(anchor.turnId)}
                  note={anchorNote(anchor, thread)}
                />
              )}
              {of.kind === "new" && creating === null && (
                <p {...stylex.props(styles.intro)}>
                  Ask about this answer without derailing the main conversation. The Thread starts
                  from everything said up to here, runs beside it, and anyone in the Session can
                  reply.
                </p>
              )}
              {thread !== undefined && thread.items.length > 0 && (
                <Transcript
                  sessionId={session.id}
                  items={thread.items}
                  label="Thread"
                  nameReplier={nameReplier}
                />
              )}
              {thread !== undefined && thread.sent.length > 0 && (
                <SentList sent={thread.sent} running={running} />
              )}
              {thread !== undefined && thread.failed.length > 0 && (
                <FailedList failed={thread.failed} />
              )}
              {previews.map((prompt) => (
                <div key={prompt.requestId} data-pending-reply="">
                  <CreatingPrompt
                    text={prompt.text}
                    failed={prompt.failed}
                    unconfirmed={prompt.unconfirmed === true}
                    reply
                  />
                  {prompt.attachments.length > 0 && (
                    <p {...stylex.props(styles.intro)}>{prompt.attachments.length} attached</p>
                  )}
                  {prompt.failed !== undefined && (
                    <Button
                      size="sm"
                      intent="secondary"
                      onClick={() => {
                        if (send(prompt.text, prompt.attachments))
                          setPending((prompts) =>
                            prompts.filter((each) => each.requestId !== prompt.requestId),
                          )
                      }}
                    >
                      Retry reply
                    </Button>
                  )}
                </div>
              ))}
              {creating !== null && (
                <div>
                  <CreatingPrompt
                    text={creating.text}
                    failed={creating.failed}
                    unconfirmed={creating.unconfirmed === true}
                  />
                  {creating.failed !== undefined && (
                    <Button
                      size="sm"
                      intent="secondary"
                      onClick={() => send(creating.text, creating.attachments)}
                    >
                      Retry starting Thread
                    </Button>
                  )}
                </div>
              )}
            </div>
          </div>

          <div {...stylex.props(styles.dock, layout === "full" && styles.fullColumn)}>
            {thread?.plan !== undefined && (
              <PlanDock plan={thread.plan} live={running} label="Thread Plan" />
            )}
            <Composer
              copy={copy}
              running={running}
              onSend={send}
              onStop={stop}
              disabledReason={
                archived
                  ? "Archived: restore it to reply"
                  : of.kind === "new" && creating !== null && creating.failed === undefined
                    ? "Starting the Thread…"
                    : undefined
              }
              hint={hint}
              attach={attach}
              picker={
                <ModelPicker
                  models={models}
                  connectable={connectable}
                  value={threadSetting}
                  onChange={pickModel}
                  owner={session.creator.id === you?.id ? undefined : session.creator.name}
                  footer={`Runs on ${accounts}. A Thread keeps its own model: it can try a cheaper or smarter one than the Session's, and doesn't follow the Session's switches.`}
                  disabled={archived}
                  side="top"
                />
              }
            />
          </div>

          {of.kind === "thread" && (
            <CompactDialog
              open={compacting}
              onOpenChange={setCompacting}
              thread={{ threadId: of.threadId, title }}
              onCompact={(instructions) => {
                const sent = hub.compact(session.id, { threadId: of.threadId, instructions })
                if (!sent) notSent("Compact")
                return sent
              }}
            />
          )}
        </>
      )}
    </aside>
  )
}

/** Who a Turn answered, for "Forked from Alice's prompt". */
function anchorName(turn: TurnView): string {
  switch (turn.sender._tag) {
    case "FromParticipant":
      return `${turn.sender.participant.name}'s prompt`
    case "FromAgent":
      return turn.agentDescription ? `${turn.agentDescription}'s result` : "an agent's result"
    case "Resumed":
      return "the answer after the restart"
    default:
      return "a Turn"
  }
}

/**
 * What to say about a quote of a Turn that was still running when the thread forked off it: the
 * Turn's answer has kept growing since, and what is quoted is its text now, not what the thread
 * saw. The log doesn't say how much of the answer there was by then, so it can't be cut there.
 */
function anchorNote(anchor: TurnView, thread: ThreadView | undefined): string | undefined {
  if (thread === undefined)
    return anchor.end === null
      ? "This Turn is still running: the Thread forks from where it has got to."
      : undefined
  const forkedLive = anchor.end === null || thread.at < anchor.at + anchor.end.durationMs
  return forkedLive
    ? "Forked while this Turn was running: the Thread saw less of the answer than this."
    : undefined
}

/** How much of an answer shows before it's opened, in characters. */
const longAnswer = 280

/** The Turn a thread forks off, quoted: its prompt, and its answer so far, opened on request. */
function AnchorQuote({
  turn,
  onJump,
  note,
}: {
  turn: TurnView
  onJump: () => void
  note?: string | undefined
}) {
  const [open, setOpen] = useState(false)
  const id = useId()
  const answer = turn.blocks
    .flatMap((block) => (block.kind === "text" ? [block.text] : []))
    .join("")
    .trim()
  const long = answer.length > longAnswer
  return (
    <figure aria-label="The answer it forks from" {...stylex.props(styles.quote)}>
      <figcaption {...stylex.props(styles.quoteHead)}>
        {turn.sender._tag === "FromParticipant" && (
          <Avatar
            name={turn.sender.participant.name}
            src={turn.sender.participant.avatarUrl}
            size="sm"
          />
        )}
        <button type="button" onClick={onJump} {...stylex.props(styles.jump, focus.ring)}>
          {anchorName(turn)}
        </button>
        <span>· {clock(turn.at)}</span>
      </figcaption>
      {turn.prompt !== "" && <p {...stylex.props(styles.quotePrompt)}>{turn.prompt}</p>}
      {answer === "" ? (
        <p {...stylex.props(styles.intro)}>
          {turn.end === null
            ? "No answer yet: it forks from where the Turn has got to."
            : "It answered with tool calls alone."}
        </p>
      ) : (
        <div id={id} {...stylex.props(styles.answer)}>
          {long && !open ? <p>{answer.slice(0, longAnswer)}…</p> : <Markdown text={answer} />}
        </div>
      )}
      {long && (
        <button
          type="button"
          aria-expanded={open}
          aria-controls={id}
          onClick={() => setOpen(!open)}
          {...stylex.props(styles.toggle, focus.ring)}
        >
          {open ? "Show less" : "Show the whole answer"}
        </button>
      )}
      {note !== undefined && <p {...stylex.props(styles.intro)}>{note}</p>}
    </figure>
  )
}

/**
 * The prompts posted into the thread that the agent hasn't taken up yet, shown as sent, until a
 * Turn starts from one or it steers the running one.
 */
function SentList({ sent, running }: { sent: ReadonlyArray<SentPrompt>; running: boolean }) {
  return (
    <ol aria-label="Sent" {...stylex.props(styles.sentList)}>
      {sent.map((prompt) => (
        <li key={prompt.key} {...stylex.props(styles.sent)} data-sent={prompt.promptId}>
          <div {...stylex.props(styles.sentHead)}>
            <Avatar name={prompt.sender.name} src={prompt.sender.avatarUrl} size="sm" />
            <span {...stylex.props(styles.name)}>{prompt.sender.name}</span>
            <span {...stylex.props(styles.sentNote)}>
              <Spinner size="sm" />
              {running
                ? "Sent · steers the reply at its next step"
                : "Sent · the agent picks it up next"}
            </span>
          </div>
          {prompt.text !== "" && <div {...stylex.props(styles.bubble)}>{prompt.text}</div>}
          <SentAttachments
            attachments={prompt.attachments}
            label="The prompt's attachments"
            sx={styles.sentFiles}
          />
        </li>
      ))}
    </ol>
  )
}

/**
 * The prompts posted into the thread that the agent couldn't take, shown to everyone with why, as
 * the log says: they are not sent after all.
 */
function FailedList({ failed }: { failed: ReadonlyArray<FailedPrompt> }) {
  return (
    <ol aria-label="Not sent" {...stylex.props(styles.sentList)}>
      {failed.map((prompt) => (
        <li key={prompt.key} {...stylex.props(styles.sent)} data-failed={prompt.promptId}>
          <div role="alert" {...stylex.props(styles.sentHead)}>
            <Avatar name={prompt.sender.name} src={prompt.sender.avatarUrl} size="sm" />
            <span {...stylex.props(styles.name)}>{prompt.sender.name}</span>
            <span {...stylex.props(styles.sentNote, styles.failedNote)}>
              <WarningIcon />
              {`Reply not sent: ${prompt.message}`}
            </span>
          </div>
          {prompt.text !== "" && <div {...stylex.props(styles.bubble)}>{prompt.text}</div>}
          <SentAttachments
            attachments={prompt.attachments}
            label="The prompt's attachments"
            sx={styles.sentFiles}
          />
        </li>
      ))}
    </ol>
  )
}

/**
 * The first prompt of a thread being started, until the Hub has made it, or why it couldn't; or a
 * reply being sent, until the Hub echoes it, or why it wasn't. When the connection dropped
 * (`unconfirmed`) it may have arrived after all, so it says to check before retrying.
 */
function CreatingPrompt({
  text: prompt,
  failed,
  unconfirmed = false,
  reply = false,
}: {
  text: string
  failed?: string | undefined
  unconfirmed?: boolean
  reply?: boolean
}) {
  const note =
    failed === undefined
      ? reply
        ? "Sending reply…"
        : "Starting the Thread…"
      : unconfirmed
        ? reply
          ? `Reply may not have arrived: ${sentence(failed)}Check the Thread before retrying.`
          : `Thread may have started: ${sentence(failed)}Check the Threads list before retrying.`
        : `${reply ? "Reply not sent" : "Thread not started"}: ${sentence(failed)}Retry below.`
  return (
    <div {...stylex.props(styles.sent)}>
      <div {...stylex.props(styles.sentHead)}>
        {/* Said by the live regions, which are what a screen reader hears. */}
        <span
          aria-hidden="true"
          {...stylex.props(styles.sentNote, failed !== undefined && styles.failedNote)}
        >
          {failed === undefined ? <Spinner size="sm" /> : <WarningIcon />}
          {note}
        </span>
        <Said role="status" words={failed === undefined ? note : ""} />
        <Said role="alert" words={failed === undefined ? "" : note} />
      </div>
      <div {...stylex.props(styles.bubble)}>{prompt}</div>
    </div>
  )
}

/**
 * A live region that mounts empty and is given its words after, as the Plan's dock does: one
 * mounted holding its text isn't announced.
 */
function Said({ role, words }: { role: "status" | "alert"; words: string }) {
  const [said, setSaid] = useState("")
  useEffect(() => setSaid(words), [words])
  return (
    <span role={role} {...stylex.props(srOnly.root)}>
      {said}
    </span>
  )
}
