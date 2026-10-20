// What the durable agent gives a conversation, as Pi Durable inputs: each is placed as an entry of
// a kind of kndl's own, whose data says where it came from, so the transcript records who sent
// what, and a run's Turn knows its sender from its first input alone, also after a restart.
//
// The model reads each input's `content`: a prompt with its sender's name and a marker per file
// (hub/HubMessages.deliveredPrompt).

import type { Context, JsonValue } from "@earendil-works/chord"
import type {
  Conversation,
  EntryRecord,
  InputSubmissionDraft,
  SubmissionRecord,
} from "@earendil-works/pi-durable"
import type { PromptAttachments } from "@kndl/protocol"
import type { SenderJson } from "./Docs.ts"
import { attachmentContext, deliveredPrompt, isRecord, steeredPrompt } from "./hub/HubMessages.ts"
import type { Sender } from "./hub/HubMessages.ts"
import type { Runtime } from "./Runtime.ts"

/** A Participant's prompt: from the Prompt queue, steered into a Turn, or posted in a thread. */
export const PromptEntry = "kndl.prompt"
/** A subagent's result, given to the conversation that started it (ADR 0014). */
export const AgentResultEntry = "kndl.agent-result"
/** The answer to a question the model asked `async` (ADR 0031). */
export const AnswerEntry = "kndl.answer"
/** A message to a subagent: from its parent, or from a Participant. */
export const AgentMessageEntry = "kndl.agent-message"
/** What carries a run on past the agent's handoff to itself: the same Turn goes on. */
export const ContinueEntry = "kndl.continue"
/** A write that changes nothing the model sees, to have the conversation place what is queued. */
export const NudgeEntry = "kndl.nudge"
/** A context handoff from another Harness (ADR 0030), as a note the model reads. */
export const HandoffEntry = "kndl.handoff"

type Attachments = typeof PromptAttachments.Encoded

/** A prompt's data, as its entry keeps it. */
export interface PromptData {
  readonly promptId: string
  readonly sender: SenderJson
  /** As its sender wrote it; empty for a prompt of attachments alone. */
  readonly text: string
  readonly attachments?: Attachments
  /** It was steered into a running Turn. */
  readonly steered?: true
}

/** The files a prompt carries, as entry data keeps them. */
const filesOf = (attachments: Attachments | undefined) =>
  attachments === undefined || attachments.length === 0 ? {} : { attachments }

/** The sender as JSON, without what the entry needn't keep. */
const senderJson = (sender: Sender): SenderJson => ({
  id: sender.id,
  login: sender.login,
  name: sender.name,
})

/**
 * A prompt as an input. The model reads it with the sender's name and a marker per file, and, out
 * of the transcript's sight, a note to open each file before answering. Steered, it is framed as a
 * message that came while the agent worked, as Claude Code frames one.
 */
export const promptInput = (
  prompt: {
    readonly promptId: string
    readonly sender: Sender
    readonly text: string
    readonly attachments?: Attachments | undefined
  },
  options: {
    readonly steer: boolean
    readonly attachmentTool: string
    /** What the conversation knows the submission by; the prompt's id unless admitPrompt said. */
    readonly requestId?: string
  },
): InputSubmissionDraft => {
  const files = prompt.attachments ?? []
  const text = options.steer
    ? steeredPrompt(prompt.sender, prompt.text, files)
    : deliveredPrompt(prompt.sender, prompt.text, files)
  const data: PromptData = {
    promptId: prompt.promptId,
    sender: senderJson(prompt.sender),
    text: prompt.text,
    ...filesOf(prompt.attachments),
    ...(options.steer && { steered: true as const }),
  }
  return {
    type: "input",
    requestId: options.requestId ?? prompt.promptId,
    content:
      files.length === 0
        ? text
        : [
            { type: "text", text },
            { type: "text", text: attachmentContext(files, `the ${options.attachmentTool} tool`) },
          ],
    whenBusy: options.steer ? "steer" : "followUp",
    entry: { kind: PromptEntry, data: data as unknown as JsonValue },
  }
}

/** What a request id that was withdrawn and given again is followed by. */
const keptSuffix = ":kept"

/**
 * Whether a stop withdrew the submission before the conversation placed it: the model never read
 * it, and nothing in the transcript shows it. Withdrawn once placed, it is in the conversation.
 */
export const withdrawn = (record: SubmissionRecord | undefined): boolean =>
  record?.status === "unanswered" && record.reason === "aborted" && record.entry === undefined

/**
 * The request id to submit an input under so the conversation takes it once: `requestId` itself,
 * or, when a stop withdrew that submission unread, the id it is given again under. Undefined when
 * the conversation has the input already, placed or given again. Pi Durable finds a withdrawn
 * submission by its request id and answers with it, so the input would never run under that id.
 */
export const freeRequestId = async (
  conversation: Conversation,
  requestId: string,
  context: Context,
): Promise<string | undefined> => {
  for (let key = requestId; ; key += keptSuffix) {
    const record = await conversation.commit(
      (tx) => tx.submissionByRequest(conversation.id, key),
      context,
    )
    if (record === undefined) return key
    if (!withdrawn(record)) return undefined
  }
}

/**
 * The request id to give a prompt, or undefined when the conversation has it already, which the
 * Hub is told (PromptAlreadySubmitted): the original start or steer may have died in the
 * volatile event queue, and the receipt takes the prompt out of the Hub's queue without a second
 * Turn. One a stop withdrew unread was not given, so it runs.
 */
export const admitPrompt = async (
  runtime: Runtime,
  conversation: Conversation,
  promptId: string,
): Promise<string | undefined> => {
  const requestId = await freeRequestId(conversation, promptId, runtime.context)
  if (requestId === undefined) runtime.report({ _tag: "PromptAlreadySubmitted", promptId })
  return requestId
}

/** Who a run's first input says started its Turn. */
export type InputOrigin =
  | {
      readonly _tag: "Prompt"
      readonly promptId: string
      readonly sender: SenderJson
      readonly attachments?: Attachments
    }
  | { readonly _tag: "AgentResult"; readonly agentId: string }
  | { readonly _tag: "Answer"; readonly sender?: SenderJson }
  | { readonly _tag: "Continue" }
  | { readonly _tag: "Other" }

const isSender = (value: unknown): value is SenderJson =>
  isRecord(value) &&
  typeof value.id === "string" &&
  typeof value.login === "string" &&
  typeof value.name === "string"

/** Where an input's entry came from, by its kind and data. */
export const inputOrigin = (entry: Pick<EntryRecord, "kind" | "data"> | undefined): InputOrigin => {
  const data = isRecord(entry?.data) ? entry.data : {}
  switch (entry?.kind) {
    case PromptEntry: {
      const { promptId, sender, attachments } = data
      if (typeof promptId !== "string" || !isSender(sender)) return { _tag: "Other" }
      return {
        _tag: "Prompt",
        promptId,
        sender,
        ...(Array.isArray(attachments) && attachments.length > 0
          ? { attachments: attachments as unknown as Attachments }
          : {}),
      }
    }
    case AgentResultEntry:
      return typeof data.agentId === "string"
        ? { _tag: "AgentResult", agentId: data.agentId }
        : { _tag: "Other" }
    case AnswerEntry:
      return isSender(data.sender) ? { _tag: "Answer", sender: data.sender } : { _tag: "Answer" }
    case ContinueEntry:
      return { _tag: "Continue" }
    default:
      return { _tag: "Other" }
  }
}

/** The text of a message's content: a string, or its text blocks. */
export const contentText = (content: unknown): string => {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content
    .filter(isRecord)
    .flatMap((block) =>
      block.type === "text" && typeof block.text === "string" ? [block.text] : [],
    )
    .join("\n")
}

/**
 * What the model reads of an input entry, as its Turn shows it: the first text of its user
 * message, without the note about attachments that follows it.
 */
export const inputText = (entry: Pick<EntryRecord, "model"> | undefined): string => {
  const message = entry?.model?.[0]
  if (message === undefined || message.role !== "user") return ""
  const { content } = message
  if (typeof content === "string") return content
  const first = content.find((block) => block.type === "text")
  return first?.type === "text" ? first.text : ""
}
