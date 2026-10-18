import {
  type OpenQuestion,
  type Participant,
  type QuestionAnswerFromWeb,
  questionClosedText,
  type QuestionPick,
  type SessionSummary,
  type ToolCallId,
} from "@kndl/protocol"
import * as stylex from "@stylexjs/stylex"
import { type KeyboardEvent, useCallback, useEffect, useRef, useState } from "react"
import { notSent } from "../app/copy.ts"
import { useHub, useHubState } from "../app/hub.tsx"
import type { QuestionPicksState } from "../hub/store.ts"
import type { QuestionView } from "../hub/transcript.ts"
import {
  Avatar,
  AvatarStack,
  Badge,
  Banner,
  Button,
  CheckIcon,
  ChevronRightIcon,
  CloseIcon,
  IconButton,
  InfoIcon,
  Input,
  PencilIcon,
} from "../ui/index.ts"
import { focus } from "../ui/shared.ts"
import { color, leading, radius, shadow, space, text, weight } from "../ui/tokens.stylex.ts"
import {
  type Draft,
  draftAnswer,
  draftAnswers,
  emptyDraft,
  othersPicks,
  pickOption,
} from "./question.ts"
import { WaitingDot } from "./QuestionChip.tsx"

const styles = stylex.create({
  card: {
    display: "flex",
    flexDirection: "column",
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: color.warning,
    borderRadius: radius.lg,
    backgroundColor: color.surface,
    boxShadow: shadow.sm,
    overflow: "hidden",
  },
  header: {
    display: "flex",
    alignItems: "flex-start",
    gap: space.s2,
    paddingBlock: space.s2,
    paddingInlineStart: space.s3,
    paddingInlineEnd: space.s1_5,
    backgroundColor: color.warningTint,
    borderBottomWidth: "1px",
    borderBottomStyle: "solid",
    borderBottomColor: color.border,
  },
  dot: { marginTop: "0.3125rem" },
  heading: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    columnGap: space.s2,
    rowGap: space.s1,
    flex: 1,
    minWidth: 0,
    margin: 0,
    fontSize: text.md,
    fontWeight: weight.semibold,
    lineHeight: leading.snug,
  },
  pager: {
    display: "inline-flex",
    alignItems: "center",
    flexShrink: 0,
    color: color.textSecondary,
    fontSize: text.xs,
    fontVariantNumeric: "tabular-nums",
  },
  previous: { transform: "rotate(180deg)" },
  rows: {
    display: "flex",
    flexDirection: "column",
    margin: 0,
    padding: space.s1,
    listStyle: "none",
  },
  row: {
    display: "flex",
    alignItems: "flex-start",
    gap: space.s2,
    width: "100%",
    paddingBlock: space.s1_5,
    paddingInline: space.s2,
    borderWidth: 0,
    borderRadius: radius.md,
    backgroundColor: "transparent",
    color: color.text,
    font: "inherit",
    fontSize: text.base,
    lineHeight: leading.snug,
    textAlign: "start",
    cursor: { default: "pointer", ":disabled": "default" },
  },
  active: { backgroundColor: color.surfaceHover },
  // An option as someone watching sees it: not a button.
  watchedRow: { cursor: "default" },
  arrow: {
    flexShrink: 0,
    width: "0.75rem",
    color: color.warningText,
    fontWeight: weight.semibold,
  },
  number: {
    flexShrink: 0,
    minWidth: "1rem",
    color: color.textTertiary,
    fontVariantNumeric: "tabular-nums",
  },
  option: { display: "flex", flexDirection: "column", gap: space.s0_5, flex: 1, minWidth: 0 },
  label: { fontWeight: weight.medium },
  description: { color: color.textSecondary, fontSize: text.sm },
  check: { display: "inline-flex", flexShrink: 0, color: color.accent, minWidth: "1rem" },
  hidden: { visibility: "hidden" },
  other: {
    display: "flex",
    alignItems: "center",
    gap: space.s2,
    paddingBlock: space.s1,
    paddingInline: space.s2,
    borderRadius: radius.md,
  },
  pencil: { display: "inline-flex", flexShrink: 0, color: color.textTertiary },
  otherInput: { flex: 1, minWidth: 0 },
  typed: {
    display: "flex",
    alignItems: "center",
    gap: space.s1_5,
    paddingInline: space.s8,
    paddingBottom: space.s1,
    color: color.textSecondary,
    fontSize: text.sm,
  },
  footer: {
    display: "flex",
    alignItems: "center",
    flexWrap: "wrap",
    gap: space.s2,
    paddingBlock: space.s1_5,
    paddingInline: space.s3,
    borderTopWidth: "1px",
    borderTopStyle: "solid",
    borderTopColor: color.border,
    color: color.textTertiary,
    fontSize: text.xs,
  },
  keys: { flex: 1, minWidth: 0 },
})

/**
 * A question Claude asked (#193), docked above the prompt box: the card to answer it, or, once
 * someone else has, who did and how. Only the Session's Creator answers (ADR 0026): anyone else
 * sees the question, and what the Creator picks, without the controls to answer it.
 */
export function QuestionDock({
  summary,
  questions,
  picks,
  drives,
}: {
  summary: SessionSummary
  questions: ReadonlyMap<ToolCallId, QuestionView>
  picks: QuestionPicksState | null
  /** Whether the signed-in person drives the Session, and so answers it. */
  drives: boolean
}) {
  const hub = useHub()
  const you = useHubState((state) => state.you)
  const open = summary.openQuestion
  const closed = useClosedQuestion(open, questions, you)
  const onPick = useCallback(
    (question: string, answer: string) => {
      if (open) hub.pickAnswer(summary.id, open.toolCallId, question, answer)
    },
    [hub, summary.id, open],
  )
  if (open) {
    return (
      <QuestionCard
        // A new question starts with nothing picked.
        key={open.toolCallId}
        open={open}
        picks={picks?.toolCallId === open.toolCallId ? picks.picks : []}
        you={you}
        {...(drives
          ? {
              onAnswer: (answer: QuestionAnswerFromWeb) => {
                const sent = hub.answerQuestion(summary.id, open.toolCallId, answer)
                if (!sent) notSent("Answer")
                return sent
              },
              onPick,
            }
          : { answerer: summary.creator.name })}
      />
    )
  }
  if (!closed) return null
  return (
    <Banner
      intent="warning"
      icon={<InfoIcon />}
      title={`${questionClosedText(closed.view, true)}.`}
      action={
        <IconButton label="Dismiss" size="sm" onClick={closed.dismiss}>
          <CloseIcon />
        </IconButton>
      }
    />
  )
}

/**
 * The question last shown here, once someone else has closed it: answered at the terminal or by
 * another Participant first, or dismissed. Not a Stop's, which the transcript says.
 */
function useClosedQuestion(
  open: OpenQuestion | undefined,
  questions: ReadonlyMap<ToolCallId, QuestionView>,
  you: Participant | null,
) {
  const [shown, setShown] = useState<ToolCallId | null>(null)
  const [dismissed, setDismissed] = useState<ToolCallId | null>(null)
  if (open && open.toolCallId !== shown) setShown(open.toolCallId)
  if (open || shown === null || dismissed === shown) return undefined
  const closed = questions.get(shown)?.closed
  if (closed === undefined || closed.outcome._tag === "Cancelled") return undefined
  if (closed.by !== undefined && closed.by.id === you?.id) return undefined
  return { view: closed, dismiss: () => setDismissed(shown) }
}

/**
 * Answers Claude's questions, one at a time, as Claude Code's dialog does: an option, several for
 * a multi-select question, or something else typed in. Picking the last question's answer sends
 * them all; Skip leaves a question unanswered, and × dismisses them, as Esc does at the terminal.
 * Without `onAnswer`, it only shows them, waiting on `answerer`.
 */
export function QuestionCard({
  open,
  picks,
  you,
  onAnswer,
  onPick,
  answerer,
}: {
  open: OpenQuestion
  picks: ReadonlyArray<QuestionPick>
  you: Participant | null
  /** Sends an answer; absent for someone watching, who can't answer (ADR 0026). */
  onAnswer?: ((answer: QuestionAnswerFromWeb) => boolean) | undefined
  onPick?: ((question: string, answer: string) => void) | undefined
  /** Who answers it, for someone watching. */
  answerer?: string | undefined
}) {
  if (onAnswer === undefined)
    return <WatchedQuestion open={open} picks={picks} you={you} answerer={answerer} />
  return (
    <AnsweredQuestion
      open={open}
      picks={picks}
      you={you}
      onAnswer={onAnswer}
      onPick={onPick ?? noPick}
    />
  )
}

const noPick = () => {}

function AnsweredQuestion({
  open,
  picks,
  you,
  onAnswer,
  onPick,
}: {
  open: OpenQuestion
  picks: ReadonlyArray<QuestionPick>
  you: Participant | null
  onAnswer: (answer: QuestionAnswerFromWeb) => boolean
  onPick: (question: string, answer: string) => void
}) {
  const { questions } = open
  const [index, setIndex] = useState(0)
  const [drafts, setDrafts] = useState<Readonly<Record<string, Draft>>>({})
  const [active, setActive] = useState(0)
  const [sent, setSent] = useState(false)
  const rows = useRef<Array<HTMLElement | null>>([])
  const card = useRef<HTMLDivElement>(null)

  const question = questions[index]
  const draft = (question && drafts[question.question]) ?? emptyDraft
  const last = index === questions.length - 1
  const waitsFor =
    open.async === true
      ? "The agent works on meanwhile, and reads your answer when it comes."
      : "It waits for an answer here or at the terminal."

  // Everyone sees what the others have picked so far, a moment after they pick it.
  const shared = useRef<Record<string, string>>({})
  useEffect(() => {
    if (sent) return
    const timer = setTimeout(() => {
      for (const asked of questions) {
        const answer = draftAnswer(asked, drafts[asked.question] ?? emptyDraft)
        if ((shared.current[asked.question] ?? "") === answer) continue
        shared.current[asked.question] = answer
        onPick(asked.question, answer)
      }
    }, 250)
    return () => clearTimeout(timer)
  }, [drafts, questions, onPick, sent])

  // Ready to answer from the keyboard, unless someone is typing elsewhere.
  useEffect(() => {
    const focused = document.activeElement
    if (focused === null || focused === document.body) rows.current[0]?.focus()
  }, [])

  if (!question) return null

  const others = othersPicks(picks, question, you)
  const otherRow = question.options.length

  const focusRow = (row: number) => {
    const next = Math.max(0, Math.min(otherRow, row))
    setActive(next)
    rows.current[next]?.focus()
  }

  const goTo = (next: number) => {
    if (next < 0 || next >= questions.length) return
    const focusedHere = card.current?.contains(document.activeElement) ?? false
    setIndex(next)
    setActive(0)
    // The rows re-render for the next question: focus its first once they have.
    if (focusedHere) requestAnimationFrame(() => rows.current[0]?.focus())
  }

  const submit = (next: Readonly<Record<string, Draft>>) => {
    if (onAnswer({ _tag: "Answered", answers: draftAnswers(questions, next) })) setSent(true)
  }

  /** With this question's draft settled: on to the next question, or after the last, send. */
  const settle = (settled: Draft) => {
    const next = { ...drafts, [question.question]: settled }
    setDrafts(next)
    if (last) submit(next)
    else goTo(index + 1)
  }

  const pick = (label: string) => {
    if (sent) return
    const picked = pickOption(question, draft, label)
    if (question.multiSelect) setDrafts({ ...drafts, [question.question]: picked })
    else settle(picked)
  }

  const setOther = (other: string) =>
    setDrafts({
      ...drafts,
      [question.question]: question.multiSelect ? { ...draft, other } : { picked: [], other },
    })

  const confirmable = draftAnswer(question, draft) !== ""

  const keyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (sent || event.nativeEvent.isComposing) return
    const typing = event.target instanceof HTMLInputElement
    if (event.key === "ArrowDown") {
      event.preventDefault()
      focusRow(active + 1)
    } else if (event.key === "ArrowUp") {
      event.preventDefault()
      focusRow(active - 1)
    } else if (typing) {
      return
    } else if (event.key === "ArrowLeft") {
      event.preventDefault()
      goTo(index - 1)
    } else if (event.key === "ArrowRight") {
      event.preventDefault()
      goTo(index + 1)
    } else if (/^[1-9]$/.test(event.key) && !event.metaKey && !event.ctrlKey && !event.altKey) {
      const option = question.options[Number(event.key) - 1]
      if (option === undefined) return
      event.preventDefault()
      setActive(Number(event.key) - 1)
      pick(option.label)
    }
  }

  return (
    <div
      ref={card}
      role="group"
      aria-label="Question"
      onKeyDown={keyDown}
      {...stylex.props(styles.card)}
    >
      <div {...stylex.props(styles.header)}>
        <WaitingDot sx={styles.dot} />
        <h2 {...stylex.props(styles.heading)}>
          {question.header !== "" && <Badge intent="warning">{question.header}</Badge>}
          <span>{question.question}</span>
        </h2>
        {questions.length > 1 && (
          <span {...stylex.props(styles.pager)}>
            <IconButton
              label="Previous question"
              size="sm"
              disabled={index === 0}
              onClick={() => goTo(index - 1)}
            >
              <ChevronRightIcon {...stylex.props(styles.previous)} />
            </IconButton>
            {index + 1} of {questions.length}
            <IconButton
              label="Next question"
              size="sm"
              disabled={last}
              onClick={() => goTo(index + 1)}
            >
              <ChevronRightIcon />
            </IconButton>
          </span>
        )}
        <IconButton
          label="Dismiss the question"
          size="sm"
          disabled={sent}
          onClick={() => {
            if (onAnswer({ _tag: "Dismissed" })) setSent(true)
          }}
        >
          <CloseIcon />
        </IconButton>
      </div>

      <ol {...stylex.props(styles.rows)}>
        {question.options.map((option, row) => {
          const picked = draft.picked.includes(option.label)
          const by = others.byOption.get(option.label) ?? []
          return (
            <li key={option.label}>
              <button
                ref={(element) => {
                  rows.current[row] = element
                }}
                type="button"
                disabled={sent}
                aria-pressed={question.multiSelect ? picked : undefined}
                onClick={() => {
                  setActive(row)
                  pick(option.label)
                }}
                onMouseEnter={() => setActive(row)}
                onFocus={() => setActive(row)}
                {...stylex.props(styles.row, focus.ring, active === row && styles.active)}
              >
                <span aria-hidden="true" {...stylex.props(styles.arrow)}>
                  {active === row ? "→" : ""}
                </span>
                <span {...stylex.props(styles.number)}>{row + 1}.</span>
                <span {...stylex.props(styles.option)}>
                  <span {...stylex.props(styles.label)}>{option.label}</span>
                  {option.description !== undefined && (
                    <span {...stylex.props(styles.description)}>{option.description}</span>
                  )}
                </span>
                {by.length > 0 && (
                  <AvatarStack
                    label="Picked by"
                    size="sm"
                    max={3}
                    people={by.map((person) => ({
                      id: person.id,
                      name: person.name,
                      src: person.avatarUrl,
                    }))}
                  />
                )}
                <span {...stylex.props(styles.check, !picked && styles.hidden)}>
                  <CheckIcon />
                </span>
              </button>
            </li>
          )
        })}
        <li>
          <div
            onMouseEnter={() => setActive(otherRow)}
            {...stylex.props(styles.other, active === otherRow && styles.active)}
          >
            <span aria-hidden="true" {...stylex.props(styles.arrow)}>
              {active === otherRow ? "→" : ""}
            </span>
            <span {...stylex.props(styles.pencil)}>
              <PencilIcon />
            </span>
            <Input
              ref={(element: HTMLInputElement | null) => {
                rows.current[otherRow] = element
              }}
              size="sm"
              aria-label="Something else"
              placeholder="Something else"
              value={draft.other}
              disabled={sent}
              onValueChange={setOther}
              onFocus={() => setActive(otherRow)}
              onKeyDown={(event) => {
                if (event.key !== "Enter" || event.nativeEvent.isComposing) return
                event.preventDefault()
                if (draft.other.trim() !== "") settle(draft)
              }}
              sx={styles.otherInput}
            />
            <Button size="sm" intent="ghost" disabled={sent} onClick={() => settle(emptyDraft)}>
              Skip
            </Button>
          </div>
          {others.typed.map(({ participant, text: typed }) => (
            <div key={participant.id} {...stylex.props(styles.typed)}>
              <Avatar name={participant.name} src={participant.avatarUrl} size="sm" />
              <span>
                {participant.name}: {typed}
              </span>
            </div>
          ))}
        </li>
      </ol>

      <div {...stylex.props(styles.footer)}>
        <span {...stylex.props(styles.keys)}>
          {sent
            ? "Sending your answer…"
            : question.multiSelect
              ? `Pick any number, then confirm. ${waitsFor}`
              : `Pick one, or press its number. ${waitsFor}`}
        </span>
        {question.multiSelect && (
          <Button
            size="sm"
            intent="primary"
            disabled={sent || !confirmable}
            onClick={() => settle(draft)}
          >
            {last ? "Submit" : "Next"}
          </Button>
        )}
      </div>
    </div>
  )
}

/**
 * Claude's questions as someone watching sees them (ADR 0026): each with its options, and what
 * the Creator has picked so far, waiting on them to answer.
 */
function WatchedQuestion({
  open,
  picks,
  you,
  answerer,
}: {
  open: OpenQuestion
  picks: ReadonlyArray<QuestionPick>
  you: Participant | null
  answerer: string | undefined
}) {
  const { questions } = open
  const [index, setIndex] = useState(0)
  const question = questions[index]
  if (!question) return null
  const others = othersPicks(picks, question, you)
  return (
    <div role="group" aria-label="Question" {...stylex.props(styles.card)}>
      <div {...stylex.props(styles.header)}>
        <WaitingDot sx={styles.dot} />
        <h2 {...stylex.props(styles.heading)}>
          {question.header !== "" && <Badge intent="warning">{question.header}</Badge>}
          <span>{question.question}</span>
        </h2>
        {questions.length > 1 && (
          <span {...stylex.props(styles.pager)}>
            <IconButton
              label="Previous question"
              size="sm"
              disabled={index === 0}
              onClick={() => setIndex(index - 1)}
            >
              <ChevronRightIcon {...stylex.props(styles.previous)} />
            </IconButton>
            {index + 1} of {questions.length}
            <IconButton
              label="Next question"
              size="sm"
              disabled={index === questions.length - 1}
              onClick={() => setIndex(index + 1)}
            >
              <ChevronRightIcon />
            </IconButton>
          </span>
        )}
      </div>
      <ol {...stylex.props(styles.rows)}>
        {question.options.map((option, row) => {
          const by = others.byOption.get(option.label) ?? []
          return (
            <li key={option.label} {...stylex.props(styles.row, styles.watchedRow)}>
              <span {...stylex.props(styles.number)}>{row + 1}.</span>
              <span {...stylex.props(styles.option)}>
                <span {...stylex.props(styles.label)}>{option.label}</span>
                {option.description !== undefined && (
                  <span {...stylex.props(styles.description)}>{option.description}</span>
                )}
              </span>
              {by.length > 0 && (
                <AvatarStack
                  label="Picked by"
                  size="sm"
                  max={3}
                  people={by.map((person) => ({
                    id: person.id,
                    name: person.name,
                    src: person.avatarUrl,
                  }))}
                />
              )}
            </li>
          )
        })}
        {others.typed.map(({ participant, text: typed }) => (
          <li key={participant.id} {...stylex.props(styles.typed)}>
            <Avatar name={participant.name} src={participant.avatarUrl} size="sm" />
            <span>
              {participant.name}: {typed}
            </span>
          </li>
        ))}
      </ol>
      <div {...stylex.props(styles.footer)}>
        <span {...stylex.props(styles.keys)}>
          {open.async === true
            ? `${answerer === undefined ? "An answer" : `${answerer}'s answer`} reaches the agent when it comes: it works on meanwhile.`
            : answerer === undefined
              ? "Waiting on an answer, here or at the terminal."
              : `Waiting on ${answerer} to answer, here or at the terminal.`}
        </span>
      </div>
    </div>
  )
}
