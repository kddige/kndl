// Answering Claude's question from the web UI (#193): what someone has picked so far for each
// question, the answers that makes, as Claude Code's dialog would submit them, and what the others
// have picked.

import {
  joinAnswers,
  type Participant,
  type Question,
  type QuestionAnswers,
  type QuestionPick,
} from "@kndl/protocol"

/** What someone has picked for one question so far: options, and text typed under Other. */
export interface Draft {
  /** The options' labels, in the order the question lists them. */
  readonly picked: ReadonlyArray<string>
  readonly other: string
}

export const emptyDraft: Draft = { picked: [], other: "" }

/**
 * A question's answer from what was picked, as the dialog submits it: one option, or the text
 * typed under Other instead; for a multi-select question, every option picked and the text after
 * them, joined. "" for none.
 */
export function draftAnswer(question: Question, draft: Draft): string {
  const other = draft.other.trim()
  const picked = question.options
    .map((option) => option.label)
    .filter((label) => draft.picked.includes(label))
  if (question.multiSelect) return joinAnswers(other === "" ? picked : [...picked, other])
  return other !== "" ? other : (picked[0] ?? "")
}

/** The answers to send, keyed by question; a question with none is left out, as skipped. */
export function draftAnswers(
  questions: ReadonlyArray<Question>,
  drafts: Readonly<Record<string, Draft>>,
): QuestionAnswers {
  const answers: Record<string, string> = {}
  for (const question of questions) {
    const answer = draftAnswer(question, drafts[question.question] ?? emptyDraft)
    if (answer !== "") answers[question.question] = answer
  }
  return answers
}

/** Picks an option: in place of the others, or for a multi-select question, toggled. */
export function pickOption(question: Question, draft: Draft, label: string): Draft {
  if (!question.multiSelect) return { picked: [label], other: "" }
  return {
    ...draft,
    picked: draft.picked.includes(label)
      ? draft.picked.filter((held) => held !== label)
      : [...draft.picked, label],
  }
}

/** The parts of an answer, split where joinAnswers joined them. */
export function splitAnswer(answer: string): ReadonlyArray<string> {
  const parts: Array<string> = []
  let rest = answer
  while (rest !== "") {
    if (rest.startsWith('"')) {
      // A part that holds ", " or a quote was written as a JSON string.
      const end = closingQuote(rest)
      if (end > 0) {
        try {
          parts.push(JSON.parse(rest.slice(0, end + 1)) as string)
          rest = rest.slice(end + 1).replace(/^, /, "")
          continue
        } catch {
          // Not JSON after all: read it as it is.
        }
      }
    }
    const comma = rest.indexOf(", ")
    parts.push(comma === -1 ? rest : rest.slice(0, comma))
    rest = comma === -1 ? "" : rest.slice(comma + 2)
  }
  return parts
}

function closingQuote(text: string): number {
  for (let index = 1; index < text.length; index++) {
    if (text[index] === "\\") index++
    else if (text[index] === '"') return index
  }
  return -1
}

/** Who else has picked what for one question: by option label, and what they typed instead. */
export interface OthersPicks {
  readonly byOption: ReadonlyMap<string, ReadonlyArray<Participant>>
  readonly typed: ReadonlyArray<{ readonly participant: Participant; readonly text: string }>
}

/** The other Participants' picks for `question`, as the Hub shared them. */
export function othersPicks(
  picks: ReadonlyArray<QuestionPick>,
  question: Question,
  you: Participant | null,
): OthersPicks {
  const labels = new Set(question.options.map((option) => option.label))
  const byOption = new Map<string, Array<Participant>>()
  const typed: Array<{ participant: Participant; text: string }> = []
  for (const pick of picks) {
    if (pick.question !== question.question || pick.participant.id === you?.id) continue
    const parts = question.multiSelect ? splitAnswer(pick.answer) : [pick.answer]
    const others: Array<string> = []
    for (const part of parts) {
      if (labels.has(part)) byOption.set(part, [...(byOption.get(part) ?? []), pick.participant])
      else others.push(part)
    }
    if (others.length > 0) typed.push({ participant: pick.participant, text: others.join(", ") })
  }
  return { byOption, typed }
}
