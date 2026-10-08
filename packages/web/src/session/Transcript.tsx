import type {
  AgentId,
  Participant,
  SessionId,
  SessionStateChanged,
  TurnEnded,
} from "@kndl/protocol"
import * as stylex from "@stylexjs/stylex"
import { Link } from "@tanstack/react-router"
import { createContext, memo, type ReactNode, useContext, useState } from "react"
import { clock, count, duration, statusOf } from "../app/format.ts"
import type {
  AgentView,
  Block,
  NoticeEvent,
  SteeredPrompt,
  TranscriptItem,
  TurnView,
} from "../hub/transcript.ts"
import {
  AgentIcon,
  AgentStatus,
  Avatar,
  Badge,
  BranchIcon,
  Disclosure,
  Markdown,
  SessionStatus,
  Spinner,
  SteerIcon,
  WarningIcon,
} from "../ui/index.ts"
import { focus } from "../ui/shared.ts"
import { color, font, leading, radius, space, text, weight } from "../ui/tokens.stylex.ts"
import { modelSwitchedText } from "./models.ts"
import { QuestionChip } from "./QuestionChip.tsx"
import { ToolCall } from "./ToolCall.tsx"

/**
 * Names the model a Turn ran when the footer should say so: when it isn't the one the Session is
 * set to, as for a Turn before a switch (#128). Undefined says nothing.
 */
type NameTurnModel = (model: string) => string | undefined

const TurnModelContext = createContext<NameTurnModel>(() => undefined)

/** The Session the transcript is of, for links to its agents. */
const SessionContext = createContext<SessionId | null>(null)

const styles = stylex.create({
  list: {
    display: "flex",
    flexDirection: "column",
    gap: space.s6,
    margin: 0,
    padding: 0,
    listStyle: "none",
  },
  turn: { display: "flex", flexDirection: "column", gap: space.s3 },
  speaker: {
    display: "flex",
    alignItems: "center",
    gap: space.s2,
    minWidth: 0,
  },
  name: { fontWeight: weight.semibold },
  time: { color: color.textSubtle, fontSize: text.xs },
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
  claudeMark: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    width: "1.75rem",
    height: "1.75rem",
    borderRadius: radius.full,
    backgroundColor: color.accentSubtle,
    color: color.accentSubtleText,
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
    color: color.textMuted,
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
    color: color.textMuted,
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
    textUnderlineOffset: "2px",
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
    color: color.textMuted,
  },
  agentCount: {
    flexShrink: 0,
    marginInlineStart: "auto",
    color: color.textSubtle,
    fontSize: text.xs,
  },
  agentMeta: {
    display: "flex",
    alignItems: "center",
    flexWrap: "wrap",
    gap: space.s2,
    color: color.textSubtle,
    fontSize: text.xs,
  },
  agentLink: {
    color: color.textMuted,
    textDecorationLine: { default: "underline", ":hover": "underline" },
    textUnderlineOffset: "2px",
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
    color: color.textSubtle,
    fontSize: text.xs,
  },
  footer: {
    display: "flex",
    alignItems: "center",
    flexWrap: "wrap",
    gap: space.s2,
    color: color.textSubtle,
    fontSize: text.xs,
  },
  working: {
    display: "inline-flex",
    alignItems: "center",
    gap: space.s1_5,
    color: color.textMuted,
    fontSize: text.sm,
  },
  notice: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    flexWrap: "wrap",
    gap: space.s2,
    color: color.textMuted,
    fontSize: text.sm,
    textAlign: "center",
  },
  noticeError: { color: color.dangerSubtleText },
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
}: {
  sessionId: SessionId
  items: ReadonlyArray<TranscriptItem>
  /** Names a Turn's model in its footer when it isn't the Session's own. */
  nameTurnModel?: NameTurnModel
}) {
  return (
    <SessionContext value={sessionId}>
      <TurnModelContext value={nameTurnModel}>
        <ol aria-label="Conversation" {...stylex.props(styles.list)}>
          {items.map((item) => (
            <li key={item.key}>
              {item.kind === "turn" ? (
                <Turn turn={item.turn} />
              ) : (
                <Notice at={item.at} event={item.event} />
              )}
            </li>
          ))}
        </ol>
      </TurnModelContext>
    </SessionContext>
  )
})

const noTurnModel: NameTurnModel = () => undefined

const Turn = memo(function Turn({ turn }: { turn: TurnView }) {
  return (
    <article {...stylex.props(styles.turn)} data-turn={turn.turnId}>
      <div {...stylex.props(styles.speaker)}>
        <Sender turn={turn} />
        <time {...stylex.props(styles.time)} dateTime={new Date(turn.at).toISOString()}>
          {clock(turn.at)}
        </time>
      </div>
      {turn.prompt !== "" && <div {...stylex.props(styles.prompt)}>{turn.prompt}</div>}
      <div {...stylex.props(styles.speaker)}>
        <span aria-hidden="true" {...stylex.props(styles.claudeMark)}>
          C
        </span>
        <span {...stylex.props(styles.name)}>Claude</span>
      </div>
      <div {...stylex.props(styles.reply)}>
        <Blocks blocks={turn.blocks} ended={turn.end !== null} />
        {turn.unread.map((prompt) => (
          <Steered
            key={prompt.key}
            prompt={prompt}
            note={
              turn.end === null
                ? "Steered in · Claude reads it at its next step"
                : "Steered in, not read before the Turn ended · Claude reads it with the next prompt"
            }
            unread
          />
        ))}
        <TurnFooter turn={turn} />
      </div>
    </article>
  )
})

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
          <div {...stylex.props(styles.messageText)}>{block.text}</div>
        </div>
      )
    case "steered":
      return <Steered prompt={block} note="Steered into the Turn" />
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
      <div {...stylex.props(styles.messageText, unread && styles.messageUnread)}>{prompt.text}</div>
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
        {tools} {tools === 1 ? "tool call" : "tool calls"}
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
        <AgentLink agentId={agent.agentId} sx={styles.agentLink}>
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

function TurnFooter({ turn }: { turn: TurnView }) {
  const nameTurnModel = useContext(TurnModelContext)
  const stoppers = names(turn.stopRequests)
  if (turn.end === null) {
    return (
      <div {...stylex.props(styles.footer)}>
        <span {...stylex.props(styles.working)}>
          <Spinner size="sm" />
          {stoppers ? `Stopping (asked by ${stoppers})` : "Working"}
        </span>
      </div>
    )
  }
  const otherModel = turn.end.usage && nameTurnModel(turn.end.usage.model)
  return (
    <div {...stylex.props(styles.footer)}>
      <EndBadge end={turn.end} stoppers={stoppers} />
      {otherModel !== undefined && <span title="The model this Turn ran on">{otherModel}</span>}
      <span>{duration(turn.end.durationMs)}</span>
      {turn.end.usage && (
        <span title={turn.end.usage.model}>
          {count(turn.end.usage.inputTokens + turn.end.usage.cacheReadInputTokens)} in ·{" "}
          {count(turn.end.usage.outputTokens)} out
        </span>
      )}
    </div>
  )
}

function EndBadge({ end, stoppers }: { end: TurnEnded; stoppers: string }) {
  switch (end.reason) {
    case "Answered":
      return null
    case "Stopped":
      return <Badge intent="warning">{stoppers ? `Stopped by ${stoppers}` : "Stopped"}</Badge>
    case "Refused":
      return <Badge intent="warning">Refused</Badge>
    case "Failed":
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
  // An Installation that fails the Session (#216): an error, with a way to fix it.
  if (event._tag === "SandboxNoted" && event.installationFailed !== undefined) {
    const failed = event.installationFailed
    return (
      <p role="note" {...stylex.props(styles.notice, styles.noticeError)}>
        <WarningIcon aria-hidden="true" />
        <span>{event.message}</span>
        <Link
          to="/plugins"
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
      ) : (
        <span>{event.message}</span>
      )}
      <time {...stylex.props(styles.time)} dateTime={new Date(at).toISOString()}>
        {clock(at)}
      </time>
    </p>
  )
}
