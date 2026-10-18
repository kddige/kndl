// The question tool (#193), as both mods give it to their agent: `ask_user_question`, with the
// shape of Claude Code's AskUserQuestion that the protocol's Question has, so the web's Open
// question needs no change, and an `async` option that lets the agent go on while it waits. The
// words are for any model, Claude's or another Provider's.

import type { Question, QuestionOutcome } from "@kndl/protocol"
import { deliveredPrompt } from "./HubMessages.ts"
import type { Sender } from "./HubMessages.ts"

/** The tool's name in pi, and its short name where Claude Code prefixes it. */
export const questionTool = "ask_user_question"

/** The tool as Claude calls it: Claude Code names a plugin's tools after the plugin. */
export const questionToolName = `mcp__hub-link-commands__${questionTool}`

/** What the agent reads of the tool. */
export const questionToolDescription = [
  "Asks the people in this session one to four questions.",
  "Use it when you need a decision or a fact only they have: to choose between approaches, to settle what an ambiguous request means, or to confirm something hard to undo. Don't ask what you can find out yourself, and don't ask for permission to do what you were asked to do.",
  "Give each question two to four options, or none for one answered in their own words. They can always answer in their own words instead of picking, or dismiss the questions.",
  "By default the call waits for their answer: the result says what they chose, what they said instead, or that they dismissed the questions.",
  "Set async to true when you can make progress without the answer: the call returns at once and you keep working, and their answer comes to you later as a message, after one of your next tool calls, or as a new turn if you have finished by then. Don't wait or poll for it, and don't ask again until it comes.",
].join(" ")

/** What the agent reads of the `async` parameter. */
export const asyncDescription =
  "Whether to keep working while they answer. True: the call returns at once, and their answer reaches you later as a message. Omit it to wait for the answer. Only one question can be open at a time."

/** The parameters' descriptions, as both mods give them. */
export const questionDescriptions = {
  questions: "The questions to ask, one to four.",
  question: "The complete question, ending with a question mark.",
  header: 'A very short label for it, up to 12 characters, such as "Auth method".',
  label: "What the option says, in a few words: it is also the answer.",
  optionDescription: "What choosing it means, or what follows from it.",
  options:
    'Two to four distinct choices, or none for a free-text answer. Leave out "Other": an answer in their own words is always possible.',
  multiSelect: "Whether several options may be picked, rather than one.",
} as const

/** The tool's input, as a JSON Schema, for Claude Code's `$.tool.register`. */
export const questionInputSchema = {
  type: "object",
  properties: {
    questions: {
      type: "array",
      minItems: 1,
      maxItems: 4,
      description: questionDescriptions.questions,
      items: {
        type: "object",
        properties: {
          question: { type: "string", description: questionDescriptions.question },
          header: { type: "string", description: questionDescriptions.header },
          options: {
            type: "array",
            maxItems: 4,
            description: questionDescriptions.options,
            items: {
              type: "object",
              properties: {
                label: { type: "string", description: questionDescriptions.label },
                description: {
                  type: "string",
                  description: questionDescriptions.optionDescription,
                },
              },
              required: ["label"],
            },
          },
          multiSelect: { type: "boolean", description: questionDescriptions.multiSelect },
        },
        required: ["question", "header", "options", "multiSelect"],
      },
    },
    async: { type: "boolean", description: asyncDescription },
  },
  required: ["questions"],
} as const

/** The tool, as Claude Code's `$.tool.register` takes it: in the tool list from the first request. */
export const questionToolSpec = {
  name: questionTool,
  description: questionToolDescription,
  inputSchema: questionInputSchema,
  isDeferred: false,
}

/** How a question closed: its outcome, and who answered from the web UI, if anyone did. */
export interface Closed {
  readonly outcome: typeof QuestionOutcome.Encoded
  readonly by?: Sender | undefined
}

/**
 * What the agent reads once its questions closed. Of questions it waited for, the tool's result;
 * of an `async` one, the message that comes to it later, so it says which questions they were.
 */
export const questionResultText = (
  questions: ReadonlyArray<Question>,
  { outcome, by }: Closed,
  async = false,
): string => {
  const who = by?.name ?? "The person at the terminal"
  const yours = "the questions you asked earlier"
  switch (outcome._tag) {
    case "Answered": {
      const asked = new Set(questions.map((question) => question.question))
      const lines = [
        ...questions.map(
          ({ question }) => `- "${question}": ${outcome.answers[question] ?? "(no answer)"}`,
        ),
        // An answer keyed by a question the call didn't ask, which the web shouldn't send.
        ...Object.entries(outcome.answers)
          .filter(([question]) => !asked.has(question))
          .map(([question, answer]) => `- "${question}": ${answer}`),
      ]
      return [
        `${who} answered ${async ? yours : "your questions"}:`,
        ...lines,
        "Continue with these answers in mind.",
      ].join("\n")
    }
    case "Replied":
      return [
        `${who} didn't pick an answer${async ? ` to ${yours}` : ""}, and replied instead:`,
        by === undefined
          ? outcome.text
          : deliveredPrompt(by, outcome.text, outcome.attachments ?? []),
        "Follow what they said.",
      ].join("\n")
    case "Dismissed":
      return async
        ? `${who} dismissed ${yours} without answering. Carry on without an answer, and don't ask again unless you can't go on.`
        : `${who} dismissed the questions without answering. Stop what you are doing and wait for them to tell you how to proceed.`
    case "Cancelled":
      return "The questions were closed without an answer: the Turn was stopped."
  }
}

/** What the call of an `async` question returns at once. */
export const askedAsyncText =
  "The people have your questions. Don't wait or poll for the answer: carry on with whatever doesn't depend on it. It comes to you as a message, after one of your next tool calls, or as a new turn if you have finished by then. Don't ask again until it does."

/** Why a question is refused while an `async` one is still open. */
export const stillOpenText =
  "An earlier question you asked async is still waiting for an answer. Only one can be open at a time: carry on without, and ask again once the answer has come."
