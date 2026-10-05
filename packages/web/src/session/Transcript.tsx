import type {
  Participant,
  PromptSender,
  SessionStateChanged,
  TurnEnded,
} from "@claude-hub/protocol"
import * as stylex from "@stylexjs/stylex"
import { Link } from "@tanstack/react-router"
import { createContext, memo, useContext } from "react"
import { clock, count, duration, statusOf } from "../app/format.ts"
import type {
  AgentView,
  Block,
  NoticeEvent,
  TranscriptItem,
  TurnBlock,
  TurnView,
} from "../hub/transcript.ts"
import {
  Avatar,
  Badge,
  BranchIcon,
  Disclosure,
  Markdown,
  SessionStatus,
  Spinner,
} from "../ui/index.ts"
import { focus } from "../ui/shared.ts"
import { color, font, leading, radius, space, text, weight } from "../ui/tokens.stylex.ts"
import { modelSwitchedText } from "./models.ts"
import { ToolCall } from "./ToolCall.tsx"

/**
 * Names the model a Turn ran when the footer should say so: when it isn't the one the Session is
 * set to, as for a Turn before a switch (#128). Undefined says nothing.
 */
type NameTurnModel = (model: string) => string | undefined

const TurnModelContext = createContext<NameTurnModel>(() => undefined)

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
  agentId: { fontFamily: font.mono, fontSize: text.sm, color: color.textMuted },
  agentCount: { color: color.textSubtle, fontSize: text.sm },
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
})

/** The Session's conversation: each Turn's prompt and Claude's reply, and state changes. */
export const Transcript = memo(function Transcript({
  items,
  nameTurnModel = noTurnModel,
}: {
  items: ReadonlyArray<TranscriptItem>
  /** Names a Turn's model in its footer when it isn't the Session's own. */
  nameTurnModel?: NameTurnModel
}) {
  return (
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
  )
})

const noTurnModel: NameTurnModel = () => undefined

const Turn = memo(function Turn({ turn }: { turn: TurnView }) {
  const sender = turn.sender
  return (
    <article {...stylex.props(styles.turn)} data-turn={turn.turnId}>
      <div {...stylex.props(styles.speaker)}>
        <Sender sender={sender} />
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
        {turn.blocks.map((block) => (
          <TurnBlockView key={block.key} block={block} />
        ))}
        <TurnFooter turn={turn} />
      </div>
    </article>
  )
})

/** What another Session's prompt is, beside its link (ADR 0012). */
const sessionSender = {
  FromParentSession: "Parent Session",
  FromChildSession: "Report from Child Session",
  FromChildSessionMessage: "Message from Child Session",
} as const

/** Who prompted a Turn: a person, the terminal, or another Session, linked (ADR 0012). */
function Sender({ sender }: { sender: PromptSender }) {
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
    case "FromParentSession":
    case "FromChildSession":
    case "FromChildSessionMessage":
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
          <Badge intent={sender._tag === "FromParentSession" ? "neutral" : "accent"}>
            {sessionSender[sender._tag]}
          </Badge>
        </>
      )
  }
}

function TurnBlockView({ block }: { block: TurnBlock }) {
  if (block.kind === "agent") return <Agent agent={block.agent} />
  return <BlockView block={block} />
}

function BlockView({ block }: { block: Block }) {
  return block.kind === "text" ? <Markdown text={block.text} /> : <ToolCall call={block.call} />
}

/** A subagent's work, grouped under its agentId and closed by default like a tool call. */
const Agent = memo(function Agent({ agent }: { agent: AgentView }) {
  const tools = agent.blocks.filter((block) => block.kind === "tool").length
  return (
    <Disclosure
      summary={
        <>
          {agent.end === null && <Spinner size="sm" label="Running" />}
          <Badge intent="accent">Subagent</Badge>
          <span {...stylex.props(styles.agentId)}>{agent.agentId}</span>
          <span {...stylex.props(styles.agentCount)}>
            {tools} {tools === 1 ? "tool call" : "tool calls"}
          </span>
        </>
      }
    >
      <div {...stylex.props(styles.agentBody)}>
        {agent.blocks.map((block) => (
          <BlockView key={block.key} block={block} />
        ))}
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
      ) : event._tag === "WipNotPushed" ? (
        <span>The WIP ref could not be pushed: {event.message}</span>
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
