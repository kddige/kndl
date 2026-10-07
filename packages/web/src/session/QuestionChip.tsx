import { questionClosedText } from "@kndl/protocol"
import * as stylex from "@stylexjs/stylex"
import { memo } from "react"
import type { QuestionView } from "../hub/transcript.ts"
import { Badge, CheckIcon, CloseIcon, Disclosure, StopIcon } from "../ui/index.ts"
import { color, leading, motion, radius, space, text, weight } from "../ui/tokens.stylex.ts"
import { splitAnswer } from "./question.ts"

const pulse = stylex.keyframes({
  "0%": { opacity: 1, transform: "scale(1)" },
  "50%": { opacity: 0.4, transform: "scale(0.75)" },
  "100%": { opacity: 1, transform: "scale(1)" },
})

const styles = stylex.create({
  dot: {
    display: "inline-block",
    flexShrink: 0,
    width: "0.5rem",
    height: "0.5rem",
    borderRadius: radius.full,
    backgroundColor: color.warning,
    animationName: pulse,
    // 1.6s; none under reduced motion, where the duration collapses to zero and the dot holds still.
    animationDuration: `calc(${motion.durationSlow} * 6.4)`,
    animationTimingFunction: "ease-in-out",
    animationIterationCount: "infinite",
  },
  open: {
    borderColor: color.warning,
    backgroundColor: color.warningSubtle,
  },
  asking: { fontWeight: weight.medium, color: color.warningSubtleText, flexShrink: 0 },
  headers: {
    flex: 1,
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    color: color.textMuted,
  },
  outcome: {
    flex: 1,
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  status: { display: "inline-flex", flexShrink: 0 },
  answered: { color: color.success },
  closed: { color: color.textSubtle },
  body: {
    display: "flex",
    flexDirection: "column",
    gap: space.s3,
    paddingBlock: space.s2,
    paddingInline: space.s3,
    fontSize: text.sm,
    lineHeight: leading.snug,
  },
  question: { display: "flex", flexDirection: "column", gap: space.s1 },
  title: { display: "flex", alignItems: "baseline", gap: space.s2, fontWeight: weight.medium },
  options: {
    display: "flex",
    flexDirection: "column",
    gap: space.s0_5,
    margin: 0,
    paddingInlineStart: space.s5,
  },
  description: { color: color.textMuted },
  chosen: { fontWeight: weight.semibold },
  answer: { color: color.textMuted },
})

/** The amber dot that pulses while Claude waits for an answer (#193). */
export function WaitingDot({ sx }: { sx?: stylex.StyleXStyles }) {
  return <span aria-hidden="true" {...stylex.props(styles.dot, sx)} />
}

/**
 * A question Claude asked (#193), in the transcript: amber while it waits, with the questions
 * under it; once closed, how and by whom.
 */
export const QuestionChip = memo(function QuestionChip({ question }: { question: QuestionView }) {
  const { closed } = question
  const headers = question.questions.map((asked) => asked.header || asked.question).join(" · ")
  return (
    <Disclosure
      sx={closed === undefined && styles.open}
      summary={
        closed === undefined ? (
          <>
            <WaitingDot />
            <span {...stylex.props(styles.asking)}>Asking a question</span>
            <span {...stylex.props(styles.headers)}>{headers}</span>
          </>
        ) : (
          <>
            <ClosedIcon outcome={closed.outcome._tag} />
            <span {...stylex.props(styles.outcome)}>{questionClosedText(closed)}</span>
          </>
        )
      }
    >
      <div {...stylex.props(styles.body)}>
        {question.questions.map((asked) => {
          const answer =
            closed?.outcome._tag === "Answered" ? closed.outcome.answers[asked.question] : undefined
          const chosen = new Set(
            answer === undefined ? [] : asked.multiSelect ? splitAnswer(answer) : [answer],
          )
          const typed = [...chosen].filter(
            (part) => !asked.options.some((option) => option.label === part),
          )
          return (
            <div key={asked.question} {...stylex.props(styles.question)}>
              <div {...stylex.props(styles.title)}>
                {asked.header !== "" && <Badge intent="warning">{asked.header}</Badge>}
                <span>{asked.question}</span>
              </div>
              {asked.options.length > 0 && (
                <ol {...stylex.props(styles.options)}>
                  {asked.options.map((option) => (
                    <li key={option.label}>
                      <span {...stylex.props(chosen.has(option.label) && styles.chosen)}>
                        {option.label}
                      </span>
                      {option.description !== undefined && (
                        <span {...stylex.props(styles.description)}> — {option.description}</span>
                      )}
                    </li>
                  ))}
                </ol>
              )}
              {typed.length > 0 && (
                <span {...stylex.props(styles.answer)}>Answered: {typed.join(", ")}</span>
              )}
              {closed?.outcome._tag === "Answered" && answer === undefined && (
                <span {...stylex.props(styles.answer)}>Skipped</span>
              )}
            </div>
          )
        })}
      </div>
    </Disclosure>
  )
})

function ClosedIcon({ outcome }: { outcome: "Answered" | "Replied" | "Dismissed" | "Cancelled" }) {
  switch (outcome) {
    case "Answered":
    case "Replied":
      return (
        <span {...stylex.props(styles.status, styles.answered)}>
          <CheckIcon aria-label={outcome} role="img" aria-hidden={false} />
        </span>
      )
    case "Dismissed":
      return (
        <span {...stylex.props(styles.status, styles.closed)}>
          <CloseIcon aria-label="Dismissed" role="img" aria-hidden={false} />
        </span>
      )
    case "Cancelled":
      return (
        <span {...stylex.props(styles.status, styles.closed)}>
          <StopIcon aria-label="Cancelled" role="img" aria-hidden={false} />
        </span>
      )
  }
}
