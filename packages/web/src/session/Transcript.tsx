import {
  type AgentId,
  type Participant,
  type PromptCancelled,
  type SessionId,
  type SessionStateChanged,
  type ThreadId,
  type TurnEnded,
  type TurnId,
} from "@kndl/protocol"
import * as stylex from "@stylexjs/stylex"
import { Link } from "@tanstack/react-router"
import { createContext, memo, type ReactNode, useContext, useState } from "react"
import { clock, count, counted, dollars, duration, statusOf } from "../app/format.ts"
import type {
  AgentView,
  Block,
  NoticeEvent,
  SteeredPrompt,
  ThreadView,
  TranscriptItem,
  TurnView,
} from "../hub/transcript.ts"
import {
  AgentIcon,
  AgentStatus,
  Avatar,
  Badge,
  BranchIcon,
  CloseIcon,
  Disclosure,
  Markdown,
  ResumeIcon,
  SessionStatus,
  Spinner,
  SteerIcon,
  ThreadIcon,
  WarningIcon,
} from "../ui/index.ts"
import { turnRow } from "../ui/markers.stylex.ts"
import { focus, textLink } from "../ui/shared.ts"
import { color, font, leading, motion, radius, space, text, weight } from "../ui/tokens.stylex.ts"
import { CompactionLine } from "./Compaction.tsx"
import { ModelNamesContext, modelSwitchedText, threadModelChangedText } from "./models.ts"
import { PlanMarker } from "./Plan.tsx"
import { QuestionChip } from "./QuestionChip.tsx"
import { SentAttachments, SessionContext } from "./SentAttachments.tsx"
import { ThreadRows } from "./ThreadRows.tsx"
import { ToolCall } from "./ToolCall.tsx"

const HOVER = "@media (hover: hover)"

/**
 * Names the model a Turn ran when the footer should say so: when it isn't the one the Session is
 * set to, as for a Turn before a switch (#128). Undefined says nothing.
 */
type NameTurnModel = (model: string) => string | undefined

const TurnModelContext = createContext<NameTurnModel>(() => undefined)

/**
 * Who answers a Turn, by the model it ran (undefined while it runs): the Session's Model, or the
 * thread's, by name.
 */
export type NameReplier = (turnModel: string | undefined) => string

const agentReplier: NameReplier = () => "Agent"

const ReplierContext = createContext<NameReplier>(agentReplier)

/**
 * The main conversation's threads (docs/design/durable-harness.md): each Turn's, shown under it,
 * and how to reply in a new one.
 */
export interface TranscriptThreads {
  /** The threads off each Turn, by its id. */
  readonly anchored: ReadonlyMap<TurnId, ReadonlyArray<ThreadView>>
  /** The thread whose panel is open. */
  readonly open?: ThreadId | undefined
  /** The Turn a new thread is being written off, marked as replied to. */
  readonly forking?: TurnId | undefined
  /** Starts a thread off a Turn; absent where none can start, as in an Archived Session. */
  readonly onReply?: ((turnId: TurnId) => void) | undefined
}

const styles = stylex.create({
  list: {
    display: "flex",
    flexDirection: "column",
    gap: space.s6,
    margin: 0,
    padding: 0,
    listStyle: "none",
  },
  turn: {
    display: "flex",
    flexDirection: "column",
    gap: space.s3,
    // A Turn jumped to from a thread lights up for a moment, so the eye finds it.
    marginInline: `calc(${space.s2} * -1)`,
    paddingInline: space.s2,
    borderRadius: radius.lg,
    backgroundColor: { default: "transparent", ":is([data-flash])": color.accentTint },
    transitionProperty: "background-color",
    transitionDuration: { default: "700ms", ":is([data-flash])": motion.durationNormal },
    transitionTimingFunction: motion.easeOut,
    scrollMarginBlock: space.s6,
  },
  // A Turn the agent resumed after a restart hangs from the one the restart ended.
  continuation: { marginTop: `calc(${space.s3} * -1)` },
  resumedLine: {
    display: "flex",
    alignItems: "center",
    gap: space.s2,
    minWidth: 0,
    color: color.textSecondary,
    fontSize: text.sm,
  },
  resumedMark: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    width: "1.75rem",
    height: "1.75rem",
    borderRadius: radius.full,
    backgroundColor: color.successTint,
    color: color.successText,
    flexShrink: 0,
  },
  resumedText: { minWidth: 0, color: color.text, fontWeight: weight.medium },
  // The new Turn's thread being written: this is the answer it forks from.
  forking: { backgroundColor: color.surfaceMuted },
  threads: { marginInlineStart: space.s8, marginTop: `calc(${space.s1} * -1)` },
  replyButton: {
    display: "inline-flex",
    alignItems: "center",
    gap: space.s1,
    marginInlineStart: "auto",
    height: "1.5rem",
    paddingInline: space.s1_5,
    borderWidth: 0,
    borderRadius: radius.md,
    backgroundColor: {
      default: "transparent",
      ":hover": { default: null, [HOVER]: color.surfaceHover },
    },
    color: {
      default: color.textTertiary,
      [stylex.when.ancestor(":hover", turnRow)]: { default: null, [HOVER]: color.textSecondary },
      [stylex.when.ancestor(":focus-within", turnRow)]: color.textSecondary,
    },
    fontFamily: "inherit",
    fontSize: text.xs,
    fontWeight: weight.medium,
    cursor: "pointer",
    transitionProperty: "background-color, color",
    transitionDuration: motion.durationFast,
  },
  speaker: {
    display: "flex",
    alignItems: "center",
    gap: space.s2,
    minWidth: 0,
  },
  name: { fontWeight: weight.semibold, whiteSpace: "nowrap" },
  time: { color: color.textTertiary, fontSize: text.xs },
  prompt: {
    marginInlineStart: space.s8,
    paddingBlock: space.s2,
    paddingInline: space.s3,
    borderRadius: radius.lg,
    backgroundColor: color.surfaceMuted,
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: color.border,
    whiteSpace: "pre-wrap",
    overflowWrap: "anywhere",
    lineHeight: leading.normal,
  },
  // A prompt that never ran: cancelled out of the queue (ADR 0026).
  cancelledPrompt: {
    borderStyle: "dashed",
    borderColor: color.borderStrong,
    backgroundColor: "transparent",
    color: color.textSecondary,
  },
  cancelledNote: {
    display: "inline-flex",
    alignItems: "center",
    gap: space.s1,
    marginInlineStart: space.s8,
    color: color.textTertiary,
    fontSize: text.xs,
  },
  sentFiles: { marginInlineStart: space.s8 },
  // The initial of whoever answers: Claude, or a pi Session's Model.
  replierMark: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    width: "1.75rem",
    height: "1.75rem",
    borderRadius: radius.full,
    backgroundColor: color.accentTint,
    color: color.accentText,
    fontSize: text.xs,
    fontWeight: weight.semibold,
    flexShrink: 0,
  },
  terminalMark: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    width: "1.75rem",
    height: "1.75rem",
    borderRadius: radius.full,
    backgroundColor: color.surfaceActive,
    color: color.textSecondary,
    fontFamily: font.mono,
    fontSize: text.xs,
    flexShrink: 0,
  },
  sessionMark: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    width: "1.75rem",
    height: "1.75rem",
    borderRadius: radius.md,
    backgroundColor: color.surfaceActive,
    color: color.textSecondary,
    flexShrink: 0,
  },
  sessionLink: {
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontWeight: weight.semibold,
    color: "inherit",
    textDecorationLine: { default: "none", ":hover": "underline" },
    textUnderlinePosition: "from-font",
    borderRadius: radius.sm,
  },
  reply: {
    display: "flex",
    flexDirection: "column",
    gap: space.s2,
    marginInlineStart: space.s8,
    minWidth: 0,
  },
  agentBody: {
    display: "flex",
    flexDirection: "column",
    gap: space.s2,
    padding: space.s3,
  },
  agentTitle: {
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontWeight: weight.medium,
  },
  agentBranch: {
    display: "inline-flex",
    alignItems: "center",
    gap: space.s1,
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontFamily: font.mono,
    fontSize: text.xs,
    color: color.textSecondary,
  },
  agentCount: {
    flexShrink: 0,
    marginInlineStart: "auto",
    color: color.textTertiary,
    fontSize: text.xs,
  },
  agentMeta: {
    display: "flex",
    alignItems: "center",
    flexWrap: "wrap",
    gap: space.s2,
    color: color.textTertiary,
    fontSize: text.xs,
  },
  agentLink: {
    color: color.textSecondary,
    borderRadius: radius.sm,
  },
  message: {
    display: "flex",
    flexDirection: "column",
    gap: space.s1,
  },
  messageText: {
    paddingBlock: space.s1_5,
    paddingInline: space.s3,
    borderRadius: radius.lg,
    backgroundColor: color.surfaceMuted,
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: color.border,
    whiteSpace: "pre-wrap",
    overflowWrap: "anywhere",
    lineHeight: leading.normal,
  },
  // Steered in, but not read yet.
  messageUnread: { borderStyle: "dashed", borderColor: color.borderStrong },
  steerNote: {
    display: "inline-flex",
    alignItems: "center",
    gap: space.s1,
    minWidth: 0,
    flexBasis: "12rem",
    flexGrow: 1,
    color: color.textTertiary,
    fontSize: text.xs,
  },
  footer: {
    display: "flex",
    alignItems: "center",
    flexWrap: "wrap",
    gap: space.s2,
    color: color.textTertiary,
    fontSize: text.xs,
  },
  failure: {
    flexBasis: "100%",
    color: color.dangerText,
    overflowWrap: "anywhere",
  },
  working: {
    display: "inline-flex",
    alignItems: "center",
    gap: space.s1_5,
    color: color.textSecondary,
    fontSize: text.sm,
  },
  notice: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    flexWrap: "wrap",
    gap: space.s2,
    color: color.textSecondary,
    fontSize: text.sm,
    textAlign: "center",
  },
  noticeError: { color: color.dangerText },
  noticeLink: {
    color: "inherit",
    fontWeight: weight.semibold,
    textDecoration: { default: "underline", ":hover": "none" },
    borderRadius: radius.sm,
  },
})

/**
 * The Session's conversation: each Turn's prompt and Claude's reply, with its subagents' cards,
 * and state changes.
 */
export const Transcript = memo(function Transcript({
  sessionId,
  items,
  nameTurnModel = noTurnModel,
  nameReplier = agentReplier,
  threads,
  label = "Conversation",
}: {
  sessionId: SessionId
  items: ReadonlyArray<TranscriptItem>
  /** Names a Turn's model in its footer when it isn't the Session's own. */
  nameTurnModel?: NameTurnModel
  /** Names who answers each Turn. */
  nameReplier?: NameReplier
  /** The main conversation's threads; absent in a thread's own. */
  threads?: TranscriptThreads | undefined
  label?: string
}) {
  return (
    <SessionContext value={sessionId}>
      <ReplierContext value={nameReplier}>
        <TurnModelContext value={nameTurnModel}>
          <ol aria-label={label} {...stylex.props(styles.list)}>
            {items.map((item) => {
              const anchored =
                item.kind === "turn" ? threads?.anchored.get(item.turn.turnId) : undefined
              return (
                <li
                  key={item.key}
                  {...stylex.props(
                    item.kind === "turn" &&
                      item.turn.sender._tag === "Resumed" &&
                      styles.continuation,
                  )}
                >
                  {item.kind === "turn" ? (
                    <Turn
                      turn={item.turn}
                      threads={anchored}
                      // Only the Turn the open thread is under needs to know which it is, so opening
                      // or switching one doesn't render every Turn again.
                      open={
                        anchored?.some((thread) => thread.threadId === threads?.open)
                          ? threads?.open
                          : undefined
                      }
                      forking={threads?.forking === item.turn.turnId}
                      onReply={threads?.onReply}
                    />
                  ) : item.kind === "cancelled" ? (
                    <CancelledPrompt at={item.at} prompt={item.event} />
                  ) : item.kind === "compaction" ? (
                    <CompactionLine compaction={item.compaction} />
                  ) : (
                    <Notice at={item.at} event={item.event} />
                  )}
                </li>
              )
            })}
          </ol>
        </TurnModelContext>
      </ReplierContext>
    </SessionContext>
  )
})

const noTurnModel: NameTurnModel = () => undefined

const Turn = memo(function Turn({
  turn,
  threads,
  open,
  forking = false,
  onReply,
}: {
  turn: TurnView
  /** The threads off it, in the main conversation. */
  threads?: ReadonlyArray<ThreadView> | undefined
  /** The thread whose panel is open. */
  open?: ThreadId | undefined
  /** Whether a new thread is being written off it. */
  forking?: boolean
  /** Starts a thread off it; absent where threads don't start, as in a thread. */
  onReply?: ((turnId: TurnId) => void) | undefined
}) {
  const replier = useContext(ReplierContext)(turn.end?.usage?.model)
  const sessionId = useContext(SessionContext)
  const resumed = turn.sender._tag === "Resumed"
  return (
    <article
      {...stylex.props(styles.turn, turnRow, forking && styles.forking)}
      data-turn={turn.turnId}
    >
      {resumed ? (
        <ResumedLine at={turn.at} />
      ) : (
        <>
          <div {...stylex.props(styles.speaker)}>
            <Sender turn={turn} />
            <time {...stylex.props(styles.time)} dateTime={new Date(turn.at).toISOString()}>
              {clock(turn.at)}
            </time>
          </div>
          {turn.prompt !== "" && <div {...stylex.props(styles.prompt)}>{turn.prompt}</div>}
          <SentAttachments
            attachments={turn.attachments}
            label="The prompt's attachments"
            sx={styles.sentFiles}
          />
          <div {...stylex.props(styles.speaker)}>
            <span aria-hidden="true" {...stylex.props(styles.replierMark)}>
              {replier.charAt(0).toUpperCase()}
            </span>
            <span {...stylex.props(styles.name)}>{replier}</span>
          </div>
        </>
      )}
      <div {...stylex.props(styles.reply)}>
        <Blocks blocks={turn.blocks} ended={turn.end !== null} />
        {turn.unread.map((prompt) => (
          <Steered
            key={prompt.key}
            prompt={prompt}
            note={
              turn.end === null
                ? `Steered in · ${replier} reads it at its next step`
                : `Steered in, not read before the Turn ended · ${replier} reads it with the next prompt`
            }
            unread
          />
        ))}
        <TurnFooter turn={turn} onReply={onReply} />
      </div>
      {threads !== undefined && threads.length > 0 && sessionId !== null && (
        <div {...stylex.props(styles.threads)}>
          <ThreadRows sessionId={sessionId} threads={threads} open={open} />
        </div>
      )}
    </article>
  )
})

/**
 * Where a Turn resumed after a restart begins (docs/design/durable-harness.md): the agent picked
 * its run up where it stopped, as the Turn the restart ended goes on.
 */
function ResumedLine({ at }: { at: number }) {
  return (
    <div {...stylex.props(styles.resumedLine)}>
      <span aria-hidden="true" {...stylex.props(styles.resumedMark)}>
        <ResumeIcon />
      </span>
      <span {...stylex.props(styles.resumedText)}>Picked up where it left off</span>
      <span>after a restart</span>
      <time {...stylex.props(styles.time)} dateTime={new Date(at).toISOString()}>
        {clock(at)}
      </time>
    </div>
  )
}

/**
 * A queued prompt the Hub cancelled without it running (ADR 0026): its sender's words, shown as
 * cancelled, and why.
 */
function CancelledPrompt({ at, prompt }: { at: number; prompt: PromptCancelled }) {
  return (
    <article {...stylex.props(styles.turn)} data-cancelled={prompt.promptId}>
      <div {...stylex.props(styles.speaker)}>
        <Avatar name={prompt.sender.name} src={prompt.sender.avatarUrl} />
        <span {...stylex.props(styles.name)}>{prompt.sender.name}</span>
        <time {...stylex.props(styles.time)} dateTime={new Date(at).toISOString()}>
          {clock(at)}
        </time>
      </div>
      <div {...stylex.props(styles.prompt, styles.cancelledPrompt)}>
        {prompt.text === "" ? "A prompt of attachments" : prompt.text}
      </div>
      <span {...stylex.props(styles.cancelledNote)}>
        <CloseIcon aria-hidden="true" />
        {`Cancelled · ${prompt.message}`}
      </span>
    </article>
  )
}

/**
 * Who prompted a Turn: a person, the terminal, a subagent that ended (ADR 0014), or, in history
 * from before, another Session.
 */
function Sender({ turn }: { turn: TurnView }) {
  const sender = turn.sender
  switch (sender._tag) {
    case "FromParticipant":
      return (
        <>
          <Avatar name={sender.participant.name} src={sender.participant.avatarUrl} />
          <span {...stylex.props(styles.name)}>{sender.participant.name}</span>
        </>
      )
    case "FromTerminal":
      return (
        <>
          <span aria-hidden="true" {...stylex.props(styles.terminalMark)}>
            &gt;_
          </span>
          <span {...stylex.props(styles.name)}>Terminal</span>
        </>
      )
    case "FromAgent":
      // A background command's end: Claude Code tells the model of it as of an agent's.
      if (turn.agentDescription === undefined)
        return (
          <>
            <span aria-hidden="true" {...stylex.props(styles.terminalMark)}>
              &gt;_
            </span>
            <span {...stylex.props(styles.name)}>Background task</span>
          </>
        )
      return (
        <>
          <span aria-hidden="true" {...stylex.props(styles.sessionMark)}>
            <AgentIcon />
          </span>
          <AgentLink agentId={sender.agentId} sx={styles.sessionLink}>
            {turn.agentDescription || sender.agentId}
          </AgentLink>
          <Badge intent="accent">Agent</Badge>
        </>
      )
    case "Resumed":
      return (
        <>
          <span aria-hidden="true" {...stylex.props(styles.sessionMark)}>
            <ResumeIcon />
          </span>
          <span {...stylex.props(styles.name)}>Resumed</span>
        </>
      )
    case "FromSession":
      return (
        <>
          <span aria-hidden="true" {...stylex.props(styles.sessionMark)}>
            <BranchIcon />
          </span>
          <Link
            to="/sessions/$sessionId"
            params={{ sessionId: sender.session.id }}
            {...stylex.props(styles.sessionLink, focus.ring)}
          >
            {sender.session.title}
          </Link>
          <Badge>Session</Badge>
        </>
      )
  }
}

/** A link to the agent view of the transcript's Session's agent. */
function AgentLink({
  agentId,
  children,
  sx,
}: {
  agentId: AgentId
  children: ReactNode
  sx: stylex.StyleXStyles
}) {
  const sessionId = useContext(SessionContext)
  if (sessionId === null) return <span {...stylex.props(sx)}>{children}</span>
  return (
    <Link
      to="/sessions/$sessionId"
      params={{ sessionId }}
      search={{ agent: agentId }}
      {...stylex.props(sx, focus.ring)}
    >
      {children}
    </Link>
  )
}

/**
 * A loop's blocks: the main loop's in a Turn, or a subagent's in its card. Once the loop has
 * `ended`, a tool call it never saw end was cut short, as by a stopped agent's.
 */
export function Blocks({ blocks, ended }: { blocks: ReadonlyArray<Block>; ended: boolean }) {
  return blocks.map((block) => <BlockView key={block.key} block={block} ended={ended} />)
}

function BlockView({ block, ended }: { block: Block; ended: boolean }) {
  switch (block.kind) {
    case "text":
      return <Markdown text={block.text} />
    case "tool":
      return <ToolCall call={block.call} cutShort={ended && block.call.outcome === undefined} />
    case "agent":
      return <AgentCard agent={block.agent} />
    case "question":
      return <QuestionChip question={block.question} />
    case "message":
      return (
        <div {...stylex.props(styles.message)}>
          <div {...stylex.props(styles.speaker)}>
            <Avatar name={block.sender.name} src={block.sender.avatarUrl} size="sm" />
            <span {...stylex.props(styles.name)}>{block.sender.name}</span>
          </div>
          {block.text !== "" && <div {...stylex.props(styles.messageText)}>{block.text}</div>}
          <SentAttachments
            attachments={block.attachments}
            label="The message's attachments"
            sx={styles.sentFiles}
          />
        </div>
      )
    case "steered":
      return <Steered prompt={block} note="Steered into the Turn" />
    case "compaction":
      return <CompactionLine compaction={block.compaction} />
    case "plan":
      return <PlanMarker plan={block.plan} previous={block.previous} />
  }
}

/** A queued prompt a person steered into the running Turn (#195), with what became of it. */
function Steered({
  prompt,
  note,
  unread = false,
}: {
  prompt: SteeredPrompt
  note: string
  unread?: boolean
}) {
  return (
    <div {...stylex.props(styles.message)} data-steered={prompt.promptId}>
      <div {...stylex.props(styles.speaker)}>
        <Avatar name={prompt.sender.name} src={prompt.sender.avatarUrl} size="sm" />
        <span {...stylex.props(styles.name)}>{prompt.sender.name}</span>
        <span {...stylex.props(styles.steerNote)}>
          <SteerIcon />
          {note}
        </span>
      </div>
      {prompt.text !== "" && (
        <div {...stylex.props(styles.messageText, unread && styles.messageUnread)}>
          {prompt.text}
        </div>
      )}
      <SentAttachments
        attachments={prompt.attachments}
        label="The prompt's attachments"
        sx={styles.sentFiles}
      />
    </div>
  )
}

/** The one-line summary of a subagent: what it's for, its status, branch and tool calls. */
export function AgentSummaryRow({ agent }: { agent: AgentView }) {
  const tools = agent.blocks.filter((block) => block.kind === "tool").length
  return (
    <>
      {agent.status === "Running" ? (
        <Spinner size="sm" label="Running" />
      ) : (
        <AgentStatus status={agent.status} />
      )}
      <span {...stylex.props(styles.agentTitle)} title={agent.description}>
        {agent.description || agent.agentId}
      </span>
      {agent.worktree && (
        <span {...stylex.props(styles.agentBranch)} title={agent.worktree.path}>
          <BranchIcon />
          {agent.worktree.branch}
        </span>
      )}
      <span {...stylex.props(styles.agentCount)}>
        {counted(tools, { one: "tool call", other: "tool calls" })}
      </span>
    </>
  )
}

/** What a subagent is: its type and model, whether it runs in the background. */
export function AgentMeta({ agent, link }: { agent: AgentView; link?: boolean }) {
  return (
    <div {...stylex.props(styles.agentMeta)}>
      <Badge intent="accent" icon={<AgentIcon />}>
        {agent.agentType || "Agent"}
      </Badge>
      {agent.model !== "" && <span>{agent.model}</span>}
      <span>{agent.background ? "In the background" : "In the foreground"}</span>
      {link === true && (
        <AgentLink agentId={agent.agentId} sx={[textLink.underline, styles.agentLink]}>
          Message or stop it
        </AgentLink>
      )}
    </div>
  )
}

/**
 * A subagent's card (ADR 0014), at the Agent call that started it, streaming its text and tool
 * calls. It is open while the agent runs and folds once it has stopped, unless someone opened or
 * closed it.
 */
const AgentCard = memo(function AgentCard({ agent }: { agent: AgentView }) {
  const [open, setOpen] = useState<boolean>()
  return (
    <Disclosure
      open={open ?? agent.status === "Running"}
      onOpenChange={setOpen}
      summary={<AgentSummaryRow agent={agent} />}
    >
      <div {...stylex.props(styles.agentBody)}>
        <AgentMeta agent={agent} link />
        <Blocks blocks={agent.blocks} ended={agent.status !== "Running"} />
      </div>
    </Disclosure>
  )
})

function TurnFooter({
  turn,
  onReply,
}: {
  turn: TurnView
  onReply?: ((turnId: TurnId) => void) | undefined
}) {
  const nameTurnModel = useContext(TurnModelContext)
  const stoppers = names(turn.stopRequests)
  const reply = onReply && (
    <button
      type="button"
      onClick={() => onReply(turn.turnId)}
      {...stylex.props(styles.replyButton, focus.ring)}
    >
      <ThreadIcon />
      Reply in thread
    </button>
  )
  if (turn.end === null) {
    return (
      <div {...stylex.props(styles.footer)}>
        <span {...stylex.props(styles.working)}>
          <Spinner size="sm" />
          {stoppers ? `Stopping (asked by ${stoppers})` : "Working"}
        </span>
        {reply}
      </div>
    )
  }
  const { usage } = turn.end
  const otherModel = usage && nameTurnModel(usage.model)
  return (
    <div {...stylex.props(styles.footer)}>
      <EndBadge end={turn.end} stoppers={stoppers} continued={turn.continued === true} />
      {otherModel !== undefined && <span title="The model this Turn ran on">{otherModel}</span>}
      <span>{duration(turn.end.durationMs)}</span>
      {usage && (
        <span title={usage.model}>
          {count(usage.input + usage.cacheRead)} in · {count(usage.output)} out
          {/* What the Harness reported it cost, as it is. */}
          {usage.cost !== undefined && ` · ${dollars(usage.cost)}`}
        </span>
      )}
      {turn.end.reason === "error" && turn.end.errorMessage !== undefined && (
        // Why it failed, as the Provider or Harness said it.
        <span {...stylex.props(styles.failure)}>{turn.end.errorMessage}</span>
      )}
      {reply}
    </div>
  )
}

function EndBadge({
  end,
  stoppers,
  continued,
}: {
  end: TurnEnded
  stoppers: string
  /** Whether the agent picked it up again after a restart, in the next Turn. */
  continued: boolean
}) {
  // Ended by a restart, and picked up again: nobody stopped it.
  if (continued && stoppers === "")
    return <Badge icon={<ResumeIcon />}>Interrupted by a restart</Badge>
  switch (end.reason) {
    case "stop":
      return null
    case "aborted":
      return <Badge intent="warning">{stoppers ? `Stopped by ${stoppers}` : "Stopped"}</Badge>
    case "length":
      return <Badge intent="warning">Hit the output limit</Badge>
    case "error":
      return <Badge intent="danger">Failed</Badge>
  }
}

function names(people: ReadonlyArray<Participant>): string {
  return [...new Set(people.map((person) => person.name))].join(", ")
}

const stateWords: Record<SessionStateChanged["state"], string> = {
  Active: "The Session is Active",
  Asleep: "The Session is Asleep",
  Frozen: "The Session is Frozen",
  Archived: "The Session was archived",
}

function Notice({ at, event }: { at: number; event: NoticeEvent }) {
  const nameModel = useContext(ModelNamesContext)
  // An Installation that fails the Session (#216): an error, with a way to fix it.
  if (event._tag === "SandboxNoted" && event.installationFailed !== undefined) {
    const failed = event.installationFailed
    return (
      <p role="note" {...stylex.props(styles.notice, styles.noticeError)}>
        <WarningIcon aria-hidden="true" />
        <span>{event.message}</span>
        <Link
          to="/mcp"
          search={{ installation: failed.installationId }}
          aria-label={`Fix ${failed.installation}`}
          {...stylex.props(styles.noticeLink, focus.ring)}
        >
          Fix
        </Link>
        <time {...stylex.props(styles.time)} dateTime={new Date(at).toISOString()}>
          {clock(at)}
        </time>
      </p>
    )
  }
  return (
    <p role="note" {...stylex.props(styles.notice)}>
      {event._tag === "SessionStateChanged" ? (
        <>
          <SessionStatus state={statusOf(event.state)} variant="dot" />
          <span>
            {stateWords[event.state]}
            {event.message ? `: ${event.message}` : ""}
            {event.by ? `${event.message ? "," : ""} by ${event.by.name}` : ""}
          </span>
        </>
      ) : event._tag === "ModelSwitched" ? (
        <>
          <Avatar name={event.by.name} src={event.by.avatarUrl} size="sm" />
          <span>{modelSwitchedText(event)}</span>
        </>
      ) : event._tag === "ThreadModelChanged" ? (
        <>
          <Avatar name={event.by.name} src={event.by.avatarUrl} size="sm" />
          <span>{threadModelChangedText(event, nameModel)}</span>
        </>
      ) : (
        <span>{event.message}</span>
      )}
      <time {...stylex.props(styles.time)} dateTime={new Date(at).toISOString()}>
        {clock(at)}
      </time>
    </p>
  )
}
