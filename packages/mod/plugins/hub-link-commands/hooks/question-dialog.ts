// The question dialog in Claude Code's terminal (#193, ADR 0031): a pane the plugin draws, since the
// native AskUserQuestion dialog can't be opened with the tool turned off. The terminal and the web
// UI both answer a question, and the first answer wins: this module only offers the questions, and
// hands the answer to the callback it was opened with (register.ts), which says whether it came
// first. A pane a tool opens is "unasked", and waits undrawn below 144 columns (the Session's tmux
// is 120 wide), so the person is told to type /question, a command being "asked", placed at any
// width.
//
// This is the pane: what it draws, and what closing it does. Opening and closing it are register.ts's,
// since a hooks module's `$` goes into no function across an import.

import { atom, read, update } from "claude-code"
import type { EngineInterface, On } from "claude-code"
import type { QuestionDialog } from "../types"
import { joinAnswers } from "./hub-link-lib.js"
import type { Question, QuestionAnswer } from "./hub-link-lib.js"

export const PANE = "kndl-question"

export const dialog = atom(
  { plugin: "hub-link-commands", key: "question" } as const,
  null as QuestionDialog | null,
)

/** What gives a dialog's answer to the question's call; it says whether the answer came first. */
export type Submit = (answer: QuestionAnswer) => unknown

/** The dialogs open, and which of them is in the pane. */
export const dialogs = {
  /** Each one's callback, by the call it asks for. */
  submitters: new Map<string, Submit>(),
  /** The call whose dialog is the one in the pane, if one is. */
  current: undefined as string | undefined,
}

const debug = ($: EngineInterface, text: string) => {
  try {
    $.ui.log(`hub-link-commands: ${text}`, { to: "debug" })
  } catch {
    // A log that fails is not worth failing for.
  }
}

/** The rows the dialog wants: its options, a header, the field, the buttons, a footer. */
export const rowsFor = (questions: ReadonlyArray<Question>) =>
  Math.max(0, ...questions.map((question) => question.options.length)) * 2 + 6

/**
 * `answer` to question `index` (none: it is skipped), and on to the next; the last one's answer
 * sends them all.
 */
const answerQuestion = async (
  $: EngineInterface,
  toolCallId: string,
  index: number,
  answer: string | undefined,
) => {
  const state = await update($, dialog, (shown) => {
    const question = shown?.questions[index]
    if (shown === null || shown.toolCallId !== toolCallId || shown.index !== index || !question)
      return shown
    return {
      ...shown,
      index: index + 1,
      picked: [],
      answers:
        answer === undefined ? shown.answers : { ...shown.answers, [question.question]: answer },
    }
  })
  if (state?.toolCallId === toolCallId && state.index >= state.questions.length)
    dialogs.submitters.get(toolCallId)?.({ _tag: "Answered", answers: state.answers })
}

const togglePick = ($: EngineInterface, toolCallId: string, index: number, label: string) =>
  update($, dialog, (shown) =>
    shown === null || shown.toolCallId !== toolCallId || shown.index !== index
      ? shown
      : {
          ...shown,
          picked: shown.picked.includes(label)
            ? shown.picked.filter((each) => each !== label)
            : [...shown.picked, label],
        },
  )

export function registerQuestionDialog(on: On) {
  on("ui.render", { component: "Pane", requestId: PANE }, async ($, e) => {
    const shown = await read($, dialog)
    const elements = $.ui.resolve(e)
    const { Box, Text, Button } = elements
    // The mobile app draws no field: it picks an option, or skips.
    const Input = "Input" in elements ? elements.Input : undefined
    const question = shown?.questions[shown.index]
    if (shown === null || question === undefined)
      return Box({ children: [Text({ dimColor: true, children: "No question is open." })] })

    const { toolCallId, index } = shown
    const many = shown.questions.length
    const isLast = index === many - 1
    const run = (work: Promise<unknown>) =>
      void work.catch((error) => debug($, `the question pane: ${error}`))
    const typed = (value: string) => {
      const text = value.trim()
      if (text === "") return
      run(
        answerQuestion(
          $,
          toolCallId,
          index,
          question.multiSelect ? joinAnswers([...shown.picked, text]) : text,
        ),
      )
    }

    return Box({
      flexDirection: "column",
      children: [
        Text({
          bold: true,
          children: `${question.header}: ${question.question}${many > 1 ? ` (${index + 1} of ${many})` : ""}`,
        }),
        ...question.options.slice(0, 9).map((option, position) =>
          Box({
            flexDirection: "column",
            children: [
              Button({
                key: `option-${position}`,
                hotkey: String(position + 1),
                label: `${
                  question.multiSelect
                    ? shown.picked.includes(option.label)
                      ? "[x] "
                      : "[ ] "
                    : ""
                }${position + 1}. ${option.label}`,
                onPress: () =>
                  run(
                    question.multiSelect
                      ? togglePick($, toolCallId, index, option.label)
                      : answerQuestion($, toolCallId, index, option.label),
                  ),
              }),
              ...(option.description === undefined
                ? []
                : [
                    Box({
                      paddingLeft: 4,
                      children: [Text({ dimColor: true, children: option.description })],
                    }),
                  ]),
            ],
          }),
        ),
        ...(Input === undefined
          ? []
          : [Input({ key: "other", placeholder: "Something else", onSubmit: typed })]),
        Box({
          flexDirection: "row",
          gap: 2,
          children: [
            Button({
              key: "skip",
              label: "Skip",
              onPress: () => run(answerQuestion($, toolCallId, index, undefined)),
            }),
            Button({
              key: "dismiss",
              label: "Dismiss",
              hotkey: "d",
              role: "dismiss",
              dimColor: true,
              onPress: () => dialogs.submitters.get(toolCallId)?.({ _tag: "Dismissed" }),
            }),
            ...(question.multiSelect
              ? [
                  Button({
                    key: "next",
                    label: isLast ? "Submit" : "Next",
                    variant: "primary",
                    onPress: () =>
                      run(
                        answerQuestion(
                          $,
                          toolCallId,
                          index,
                          shown.picked.length === 0 ? undefined : joinAnswers(shown.picked),
                        ),
                      ),
                  }),
                ]
              : []),
          ],
        }),
        Text({
          dimColor: true,
          children: shown.async
            ? "The agent works on meanwhile and reads your answer when it comes."
            : "The agent waits for your answer, here or in the web UI.",
        }),
      ],
    })
  })

  // The pane's close mark, a deliberate close: the person at the terminal dismisses the question. The plugin's
  // own close, once the question is answered or closed elsewhere, dismisses nothing.
  on("ui.close", { id: PANE }, async ($, e, next) => {
    const toolCallId = dialogs.current
    if (e.origin.kind === "person" && toolCallId !== undefined) {
      dialogs.current = undefined
      await update($, dialog, () => null).catch(() => undefined)
      dialogs.submitters.get(toolCallId)?.({ _tag: "Dismissed" })
    }
    return next(e)
  })
}
