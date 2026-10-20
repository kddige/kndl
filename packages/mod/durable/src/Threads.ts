// Threads (docs/design/durable-harness.md): anyone replies in a thread off one of the main loop's
// answers. A thread is a Pi Durable fork of the main conversation at that answer, ownerless, so it
// runs beside the main loop and every other thread, on its own Model if it was given one, with the
// Plan the main loop had there. Its Turns carry its ThreadId. A prompt into a busy thread steers
// it; into an idle one, it starts a Turn. Each prompt's id is its request id, so a command the Hub
// delivers again runs once.

import { LiveDoc } from "@earendil-works/pi-durable"
import type { Conversation, EntryId, Extension } from "@earendil-works/pi-durable"
import { threadTitleFrom } from "@kndl/protocol"
import type { Command } from "../../src/HubMessages.ts"
import { attachmentTool } from "./Attachments.ts"
import { PlanDoc, ThreadsDoc, TurnsDoc } from "./Docs.ts"
import { admitPrompt, promptInput } from "./Inputs.ts"
import { reportPlan } from "./Plan.ts"
import type { Runtime } from "./Runtime.ts"
import { stopConversation } from "./Stopping.ts"
import { modelName } from "./Turns.ts"

/** What a thread's model is told of where it is. */
export const threadNote = (title: string) =>
  [
    `This is a thread of the session, "${title}": a fork of the main conversation at one of your answers, where people follow up on it.`,
    "Answer the people in this thread. The main conversation goes on separately and doesn't see this thread, and this thread doesn't see what happens there after the fork.",
  ].join(" ")

/** The thread's conversation, if the Session has it. */
export const threadConversation = async (
  runtime: Runtime,
  threadId: string,
): Promise<Conversation | undefined> => {
  const harness = runtime.harness()
  const record = (await harness.snapshot(ThreadsDoc, runtime.context))?.threads[threadId]
  return record === undefined
    ? undefined
    : harness.conversation(record.conversationId, runtime.context)
}

/**
 * Where a thread off `anchorTurnId` forks the main loop: that Turn's answer, its newest entry if
 * it has none yet, or the main loop's newest entry for a Turn the agent doesn't know.
 */
export const forkPoint = async (
  runtime: Runtime,
  root: Conversation,
  anchorTurnId: string,
): Promise<EntryId | undefined> => {
  const turns = await runtime.harness().snapshot(TurnsDoc, root.id, runtime.context)
  // A running Turn has no answer/last yet. Fork at its newest committed progress, never an
  // in-flight partial, rather than at the prompt recordCurrent saved when it began.
  if (turns?.current?.turnIds.includes(anchorTurnId)) {
    const newest = await root.entries({}, 1, undefined, runtime.context)
    return newest.items[0]?.id
  }
  const turn = turns?.turns[anchorTurnId]
  const known = turn?.answer ?? turn?.last ?? turn?.entry
  if (known !== undefined) return known
  const newest = await root.entries({}, 1, undefined, runtime.context)
  return newest.items[0]?.id
}

/** Whether a conversation runs now. */
const busy = async (runtime: Runtime, conversation: Conversation) =>
  (await runtime.harness().snapshot(LiveDoc, conversation.id, runtime.context))?.run !== undefined

/**
 * Gives a thread a prompt: it steers a busy thread, which the Hub hears as PromptSteered, and
 * starts a Turn in an idle one. One given before (by its request id) isn't given again.
 */
const promptThread = async (
  runtime: Runtime,
  thread: Conversation,
  command: Command<"DeliverThreadPrompt"> | Command<"StartThread">,
) => {
  const { context } = runtime
  const requestId = await admitPrompt(runtime, thread, command.promptId)
  if (requestId === undefined) return
  const steer = await busy(runtime, thread)
  const reporter = runtime.loops.get(thread.id)
  // The thread's reporter tells the Hub of a steer, and of its placement, in the order of the
  // thread's events; an idle thread starts a Turn, which the Hub hears of instead.
  if (steer)
    reporter?.steering(requestId, {
      promptId: command.promptId,
      text: command.text,
      sender: command.sender,
      attachments: command.attachments,
    })
  try {
    await thread.submit(promptInput(command, { steer, attachmentTool, requestId }), context)
  } catch (error) {
    reporter?.unsteer(requestId)
    throw error
  }
}

/**
 * StartThread: forks the main loop at the anchor's answer, follows the fork, and gives it the
 * prompt. A thread started before is only given the prompt, which its request id runs once.
 */
export const startThread = async (
  runtime: Runtime,
  command: Command<"StartThread">,
  withheld: ReadonlyArray<Extension>,
) => {
  const harness = runtime.harness()
  const { context } = runtime
  const known = await threadConversation(runtime, command.threadId)
  if (known !== undefined) return promptThread(runtime, known, command)
  const root = await harness.root(context)
  const at = await forkPoint(runtime, root, command.anchorTurnId)
  if (at === undefined) {
    runtime.report({
      _tag: "PromptFailed",
      promptId: command.promptId,
      message: "The main loop has nothing to fork a thread from yet.",
    })
    return
  }
  let model: { provider: string; modelId: string } | undefined
  if (command.model !== undefined) {
    const found = await runtime.catalog.resolve(command.model)
    if ("model" in found) model = found.model
    else {
      const current = (await root.agent(context)).model
      runtime.report({
        _tag: "ModelSwitchFailed",
        asked: command.model,
        model:
          current === undefined
            ? command.model
            : modelName({ provider: current.provider, id: current.modelId }),
        message: found.why,
        threadId: command.threadId,
      })
    }
  }
  const title = threadTitleFrom(command.text)
  const thread = await root.fork(
    at,
    {
      ownership: { kind: "ownerless" },
      agent: {
        ...(model === undefined ? {} : { model }),
        ...(command.thinkingLevel === undefined ? {} : { thinkingLevel: command.thinkingLevel }),
        extensions: { remove: withheld },
        instructions: threadNote(title),
      },
      init: async (tx, conversationId) => {
        ;(await tx.doc(ThreadsDoc)).threads[command.threadId] = {
          conversationId,
          anchorTurnId: command.anchorTurnId,
          title,
        }
      },
    },
    context,
  )
  // Followed before its first prompt, so its first Turn's events all reach the Hub.
  await runtime.loops.attach(thread.id, { kind: "thread", threadId: command.threadId })
  const plan = await harness.snapshot(PlanDoc, thread.id, context)
  if (plan !== undefined && plan.steps.length > 0) reportPlan(runtime, thread.id, plan)
  await promptThread(runtime, thread, command)
}

/** DeliverThreadPrompt: steers the thread's Turn, or starts one. */
export const deliverThreadPrompt = async (
  runtime: Runtime,
  command: Command<"DeliverThreadPrompt">,
) => {
  const thread = await threadConversation(runtime, command.threadId)
  if (thread === undefined)
    return runtime.report({
      _tag: "PromptFailed",
      promptId: command.promptId,
      message: "The Session has no such thread.",
    })
  await promptThread(runtime, thread, command)
}

/** StopThread: the thread's Turn stops; its background agents run on. */
export const stopThread = async (runtime: Runtime, command: Command<"StopThread">) => {
  const thread = await threadConversation(runtime, command.threadId)
  if (thread === undefined) {
    // The protocol has no failure for it; the Hub's stop button has nothing to undo.
    runtime.log(`kndl: StopThread: the Session has no thread ${command.threadId}`)
    return
  }
  void stopConversation(runtime, thread).catch((error: unknown) =>
    runtime.log(`kndl: stopping thread ${command.threadId} failed: ${error}`),
  )
}
