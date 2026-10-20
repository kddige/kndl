// The Hub's commands (the protocol's ModCommand), run one at a time in the order the Hub queued
// them, each as a Pi Durable submission or call that returns once it is admitted: none waits for
// a run. A command the Hub delivers again is harmless: every prompt's id is its request id, so a
// prompt given before isn't given again (PromptAlreadySubmitted, #323).

import { LiveDoc } from "@earendil-works/pi-durable"
import type { Conversation, Extension } from "@earendil-works/pi-durable"
import type { ModCommand, ThinkingLevel } from "@kndl/protocol"
import { attachmentTool } from "./Attachments.ts"
import { deliverHandoff } from "./History.ts"
import type { Command } from "./hub/HubMessages.ts"
import { admitPrompt, promptInput } from "./Inputs.ts"
import type { Questions } from "./Questions.ts"
import type { Runtime } from "./Runtime.ts"
import { stopConversation } from "./Stopping.ts"
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
const switchModel = async (
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
      const isPrompt =
        command._tag === "DeliverPrompt" ||
        command._tag === "DeliverIntoTurn" ||
        command._tag === "StartThread" ||
        command._tag === "DeliverThreadPrompt"
      // A prompt that failed because the agent was closing its Harness didn't fail: the link has
      // stopped polling, so thrown, it stays unacknowledged and the Hub brings it to the next
      // start, where its request id makes it run once.
      if (isPrompt && this.runtime.closing()) throw error
      if (isPrompt)
        this.runtime.report({ _tag: "PromptFailed", promptId: command.promptId, message })
      else if (command._tag === "SwitchModel" || command._tag === "SwitchThreadModel")
        await this.switchFailed(command, message)
      else if (command._tag === "DeliverAnswer")
        this.runtime.report({
          _tag: "AnswerFailed",
          toolCallId: command.toolCallId,
          senderId: command.sender.id,
          message,
        })
      else throw error
    }
  }

  /** A model switch that threw: the Hub keeps the conversation on the model it runs on. */
  private async switchFailed(
    command: Command<"SwitchModel"> | Command<"SwitchThreadModel">,
    message: string,
  ) {
    const { runtime } = this
    const threadId = command._tag === "SwitchThreadModel" ? command.threadId : undefined
    // What it runs on may be what failed to be read.
    const running = await (async () => {
      const conversation =
        threadId === undefined ? await this.root() : await threadConversation(runtime, threadId)
      return conversation === undefined ? undefined : await conversationModel(runtime, conversation)
    })().catch(() => undefined)
    runtime.report({
      _tag: "ModelSwitchFailed",
      ...(command.model === undefined ? {} : { asked: command.model }),
      model: running ?? command.model ?? "none",
      message,
      ...(threadId === undefined ? {} : { threadId }),
    })
  }

  private async dispatch(command: ModCommand) {
    switch (command._tag) {
      case "DeliverPrompt":
        return this.prompt(command)
      case "DeliverIntoTurn":
        return this.steer(command)
      case "StopTurn": {
        const root = await this.root()
        void stopConversation(this.runtime, root).catch((error: unknown) =>
          this.runtime.log(`kndl: stopping the Turn failed: ${error}`),
        )
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
    const requestId = await admitPrompt(runtime, root, command.promptId)
    if (requestId === undefined) return
    // Should a run have started meanwhile, as an agent's result's, it waits for that run.
    await root.submit(
      promptInput(command, { steer: false, attachmentTool, requestId }),
      runtime.context,
    )
  }

  /**
   * A queued prompt steered into the running Turn (ADR 0018): placed after its current tool round,
   * which the Hub hears as SteeredPromptRead; PromptFailed when no Turn runs to take it.
   */
  private async steer(command: Command<"DeliverIntoTurn">) {
    const { runtime } = this
    const root = await this.root()
    const requestId = await admitPrompt(runtime, root, command.promptId)
    if (requestId === undefined) return
    const reporter = runtime.loops.get(root.id)
    const running = (await runtime.harness().snapshot(LiveDoc, root.id, runtime.context))?.run
    if (reporter === undefined || running === undefined)
      return runtime.report({
        _tag: "PromptFailed",
        promptId: command.promptId,
        message: "no Turn is running",
      })
    // The Turn's reporter tells the Hub of the steer, and of its placement, in the order of the
    // conversation's events: if the Turn ended meanwhile, the next one starts from the steer instead.
    reporter.steering(requestId, {
      promptId: command.promptId,
      text: command.text,
      sender: command.sender,
      attachments: command.attachments,
    })
    try {
      await root.submit(
        promptInput(command, { steer: true, attachmentTool, requestId }),
        runtime.context,
      )
    } catch (error) {
      reporter.unsteer(requestId)
      throw error
    }
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
