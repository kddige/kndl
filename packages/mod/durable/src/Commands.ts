// The Hub's commands (the protocol's ModCommand), run one at a time in the order the Hub queued
// them, each as a Pi Durable submission or call that returns once it is admitted: none waits for
// a run. A command the Hub delivers again is harmless: every prompt's id is its request id, so a
// prompt given before isn't given again (PromptAlreadySubmitted, #323).

import { LiveDoc } from "@earendil-works/pi-durable"
import type { Conversation, Extension } from "@earendil-works/pi-durable"
import type { ModCommand, ThinkingLevel } from "@kndl/protocol"
import type { Command } from "../../src/HubMessages.ts"
import { attachmentTool } from "./Attachments.ts"
import { deliverHandoff } from "./History.ts"
import { promptInput } from "./Inputs.ts"
import type { Questions } from "./Questions.ts"
import type { Runtime } from "./Runtime.ts"
import { messageFromCreator, stopFromCreator } from "./Subagents.ts"
import { deliverThreadPrompt, startThread, stopThread, threadConversation } from "./Threads.ts"
import { modelName, turnErrorMessage } from "./Turns.ts"

export interface CommandsOptions {
  readonly runtime: Runtime
  readonly questions: Questions
  /** The extensions a thread goes without: the question tool's. */
  readonly threadWithheld: () => ReadonlyArray<Extension>
  /** The Session's model changed: the hello says it from now on. */
  readonly modelChanged?: (model: string) => void
}

/** The model a conversation runs on, as `<provider>/<id>`. */
export const conversationModel = async (runtime: Runtime, conversation: Conversation) => {
  const model = (await conversation.agent(runtime.context)).model
  return model === undefined
    ? undefined
    : modelName({ provider: model.provider, id: model.modelId })
}

/**
 * Runs a conversation's next requests on `asked`, `<provider>/<id>`, or the first of the
 * Creator's Models without one, and the thinking level given, or its default. One the agent can't
 * run is said to the Hub (ModelSwitchFailed), which keeps it on the model it runs on.
 */
export const switchModel = async (
  runtime: Runtime,
  conversation: Conversation,
  asked: string | undefined,
  thinkingLevel: ThinkingLevel | undefined,
  threadId?: string,
): Promise<string | undefined> => {
  const found = await runtime.catalog.resolve(asked)
  if ("why" in found) {
    const current = (await conversationModel(runtime, conversation)) ?? asked ?? "none"
    runtime.log(`kndl: couldn't switch to ${asked ?? "the default model"}: ${found.why}`)
    runtime.report({
      _tag: "ModelSwitchFailed",
      ...(asked === undefined ? {} : { asked }),
      model: current,
      message: found.why,
      ...(threadId === undefined ? {} : { threadId }),
    })
    return undefined
  }
  await conversation.configure(
    {
      model: found.model,
      thinkingLevel: thinkingLevel ?? null,
    },
    runtime.context,
  )
  return modelName({ provider: found.model.provider, id: found.model.modelId })
}

export class Commands {
  constructor(private readonly options: CommandsOptions) {}

  private get runtime() {
    return this.options.runtime
  }

  private root() {
    return this.runtime.harness().root(this.runtime.context)
  }

  async run(command: ModCommand) {
    try {
      return await this.dispatch(command)
    } catch (error) {
      // The link acknowledges commands even when their handler throws. A failed admission
      // must therefore clear the Hub's pending prompt, not leave it waiting for a start forever.
      const message = turnErrorMessage(String(error), this.runtime.secrets) ?? "The command failed."
      this.runtime.log(`kndl: ${command._tag}: ${message}`)
      if (
        command._tag === "DeliverPrompt" ||
        command._tag === "DeliverIntoTurn" ||
        command._tag === "StartThread" ||
        command._tag === "DeliverThreadPrompt"
      )
        this.runtime.report({ _tag: "PromptFailed", promptId: command.promptId, message })
      else throw error
    }
  }

  private async dispatch(command: ModCommand) {
    switch (command._tag) {
      case "DeliverPrompt":
        return this.prompt(command)
      case "DeliverIntoTurn":
        return this.steer(command)
      case "StopTurn": {
        const root = await this.root()
        void root
          .abort(this.runtime.context)
          .catch((error: unknown) => this.runtime.log(`kndl: stopping the Turn failed: ${error}`))
        return
      }
      case "SwitchModel": {
        const switched = await switchModel(
          this.runtime,
          await this.root(),
          command.model,
          command.thinkingLevel,
        )
        if (switched !== undefined) this.options.modelChanged?.(switched)
        return
      }
      case "DeliverAgentMessage":
        return messageFromCreator(this.runtime, command)
      case "StopAgent":
        return stopFromCreator(this.runtime, command)
      case "DeliverAnswer":
        return this.options.questions.answer(command)
      case "DeliverHandoff":
        return deliverHandoff(this.runtime, command)
      case "PresenceChanged":
        // Who is here changes too often for the system prompt, whose cache it would break.
        return
      case "StartThread":
        return startThread(this.runtime, command, this.options.threadWithheld())
      case "DeliverThreadPrompt":
        return deliverThreadPrompt(this.runtime, command)
      case "StopThread":
        return stopThread(this.runtime, command)
      case "SwitchThreadModel": {
        const thread = await threadConversation(this.runtime, command.threadId)
        if (thread === undefined)
          return this.runtime.report({
            _tag: "ModelSwitchFailed",
            asked: command.model,
            model: command.model,
            message: "The Session has no such thread.",
            threadId: command.threadId,
          })
        await switchModel(
          this.runtime,
          thread,
          command.model,
          command.thinkingLevel,
          command.threadId,
        )
        return
      }
      case "Compact":
        return this.compact(command)
    }
  }

  /** A prompt from the Prompt queue, sent while the main loop is idle: it starts a Turn. */
  private async prompt(command: Command<"DeliverPrompt">) {
    const { runtime } = this
    const root = await this.root()
    const given = await root.commit(
      (tx) => tx.submissionByRequest(root.id, command.promptId),
      runtime.context,
    )
    if (given !== undefined) {
      // A Hub from before #323 would refuse the event, so it keeps the prompt queued: still once.
      if (runtime.takesAlreadySubmitted())
        runtime.report({ _tag: "PromptAlreadySubmitted", promptId: command.promptId })
      return
    }
    // Should a run have started meanwhile, as an agent's result's, it waits for that run.
    await root.submit(promptInput(command, { steer: false, attachmentTool }), runtime.context)
  }

  /**
   * A queued prompt steered into the running Turn (ADR 0018): placed after its current tool round,
   * which the Hub hears as SteeredPromptRead; PromptFailed when no Turn runs to take it.
   */
  private async steer(command: Command<"DeliverIntoTurn">) {
    const { runtime } = this
    const root = await this.root()
    const given = await root.commit(
      (tx) => tx.submissionByRequest(root.id, command.promptId),
      runtime.context,
    )
    if (given !== undefined) {
      if (runtime.takesAlreadySubmitted())
        runtime.report({ _tag: "PromptAlreadySubmitted", promptId: command.promptId })
      return
    }
    const reporter = runtime.loops.get(root.id)
    const running = (await runtime.harness().snapshot(LiveDoc, root.id, runtime.context))?.run
    const turnId = reporter?.turnId
    if (turnId === undefined || running === undefined)
      return runtime.report({
        _tag: "PromptFailed",
        promptId: command.promptId,
        message: "no Turn is running",
      })
    const submission = await root.submit(
      promptInput(command, { steer: true, attachmentTool }),
      runtime.context,
    )
    // Placed at once, the Turn had ended: it starts the next, which the Hub hears of instead.
    if ((await submission.status(runtime.context)).status !== "queued") return
    reporter?.steered(submission.id, command.promptId)
    runtime.report({
      _tag: "PromptSteered",
      turnId,
      promptId: command.promptId,
      text: command.text,
      sender: command.sender,
      ...(command.attachments === undefined || command.attachments.length === 0
        ? {}
        : { attachments: command.attachments }),
    })
  }

  /** Compact: summarizes the main loop's or a thread's older messages now, as someone asked. */
  private async compact(command: Command<"Compact">) {
    const { runtime } = this
    const conversation =
      command.threadId === undefined
        ? await this.root()
        : await threadConversation(runtime, command.threadId)
    const instructions = command.instructions?.trim()
    // compact() admits a task, not its result. Publish before admission: a fast task (including
    // a skipped one) can finish before the command's await continuation runs.
    runtime.report({
      _tag: "CompactionStarted",
      ...(command.threadId === undefined ? {} : { threadId: command.threadId }),
      reason: "manual",
      by: command.sender,
    })
    try {
      if (conversation === undefined) throw new Error("The Session has no such thread.")
      await conversation.compact(instructions === "" ? undefined : instructions, runtime.context)
    } catch (error) {
      runtime.report({
        _tag: "CompactionEnded",
        ...(command.threadId === undefined ? {} : { threadId: command.threadId }),
        outcome: "failed",
        error: turnErrorMessage(String(error), runtime.secrets) ?? "Compaction failed.",
      })
    }
  }
}
