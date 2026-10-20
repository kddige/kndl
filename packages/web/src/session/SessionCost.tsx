import * as stylex from "@stylexjs/stylex"
import { spent } from "../app/format.ts"
import type { Transcript } from "../hub/transcript.ts"
import { Popover } from "../ui/index.ts"
import { focus } from "../ui/shared.ts"
import { color, motion, radius, space, text } from "../ui/tokens.stylex.ts"

const styles = stylex.create({
  trigger: {
    paddingBlock: 0,
    paddingInline: space.s0_5,
    marginInline: `calc(${space.s0_5} * -1)`,
    borderWidth: 0,
    borderRadius: radius.sm,
    backgroundColor: "transparent",
    color: "inherit",
    fontFamily: "inherit",
    fontSize: "inherit",
    whiteSpace: "nowrap",
    textDecorationLine: "underline",
    textDecorationStyle: "dotted",
    textDecorationColor: color.borderStrong,
    textUnderlineOffset: "2px",
    cursor: "pointer",
    transitionProperty: "text-decoration-color",
    transitionDuration: motion.durationFast,
    ":hover": { textDecorationColor: { default: null, "@media (hover: hover)": "currentColor" } },
  },
  list: {
    display: "flex",
    flexDirection: "column",
    gap: space.s1,
    margin: 0,
    padding: 0,
    listStyle: "none",
  },
  part: {
    display: "flex",
    justifyContent: "space-between",
    gap: space.s3,
    fontSize: text.sm,
    fontVariantNumeric: "tabular-nums",
  },
  what: { minWidth: 0, overflowWrap: "anywhere" },
  cost: { flexShrink: 0, color: color.textSecondary },
})

/** One conversation's share of what a Session has spent. */
export interface CostPart {
  readonly id: string
  readonly label: string
  readonly cost: number
}

/**
 * What a Session has spent: the main conversation's, its threads' and its agents' each as the
 * agent last said, which are separate conversations and add up. Only those that spent anything.
 */
export function sessionCost(transcript: Pick<Transcript, "usage" | "threads" | "agents">): {
  readonly total: number
  readonly parts: ReadonlyArray<CostPart>
} {
  const parts: Array<CostPart> = [
    { id: "main", label: "Main conversation", cost: transcript.usage?.cost ?? 0 },
    ...[...transcript.threads.values()].map((thread) => ({
      id: `thread-${thread.threadId}`,
      label: `Thread: ${thread.title}`,
      cost: thread.usage?.cost ?? 0,
    })),
    ...[...transcript.agents.values()].map((agent) => ({
      id: `agent-${agent.agentId}`,
      label: `Agent: ${agent.description || agent.agentId}`,
      cost: agent.usage?.cost ?? 0,
    })),
  ].filter((part) => part.cost > 0)
  return { total: parts.reduce((sum, part) => sum + part.cost, 0), parts }
}

/**
 * What the Session has spent in all, after a separator, for its header meta line: a button that opens where it went, which
 * conversation spent what, and whose accounts pay (`accounts`, such as "Alice's accounts").
 */
export function SessionCost({
  transcript,
  accounts,
}: {
  transcript: Pick<Transcript, "usage" | "threads" | "agents">
  accounts: string
}) {
  const { total, parts } = sessionCost(transcript)
  if (total <= 0) return null
  return (
    <>
      {" "}
      <span aria-hidden="true">·</span>{" "}
      <Popover
        trigger={
          <button type="button" {...stylex.props(styles.trigger, focus.ring)}>
            {spent(total)} spent
          </button>
        }
        title="Spent so far"
        description={`The main conversation, its threads and its agents, on ${accounts}.`}
        align="start"
      >
        <ul aria-label="Spent" {...stylex.props(styles.list)}>
          {parts.map((part) => (
            <li key={part.id} {...stylex.props(styles.part)}>
              <span {...stylex.props(styles.what)}>{part.label}</span>
              <span {...stylex.props(styles.cost)}>{spent(part.cost)}</span>
            </li>
          ))}
        </ul>
      </Popover>
    </>
  )
}
