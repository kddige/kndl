// Subagents (ADR 0014, amended by ADR 0029), on Pi Durable's owned conversations: each subagent
// is a conversation of its own, owned by a background anchor task of the conversation that started
// it (Pi Durable's example 23), so its parent's stop and idle waits never reach it, and it outlives
// the Turn that started it. Each message to it, the first included, is a background task that
// delivers it, waits for the answer, and gives that to the parent as a follow-up input in the
// shape of Claude Code's task notification, which starts a Turn from the agent. Tasks and
// conversations are durable, so a subagent survives a restart: it goes on where it was, Running
// again, and its result still comes.
//
// The model starts one with `agent` (in the background, or `wait`ing for it as a foreground
// agent, which the Turn's stop stops), messages it with `message_agent` (a running agent reads it
// at its next step, one that has finished resumes with its whole context) and stops it with
// `stop_agent`. The Creator does the same from the web (DeliverAgentMessage, StopAgent). A
// subagent has the parent's tools but these and the question tool: it starts no agents of its own
// and asks no one.

import type { Context } from "@earendil-works/chord"
import { Type } from "@earendil-works/pi-ai"
import type { AssistantMessage } from "@earendil-works/pi-ai"
import {
  AssistantEntry,
  configure,
  defineExtension,
  defineTask,
  defineTool,
  LiveDoc,
} from "@earendil-works/pi-durable"
import type {
  ConversationId,
  Extension,
  TaskId,
  Tx,
} from "@earendil-works/pi-durable"
import { deliveredPrompt } from "../../src/HubMessages.ts"
import type { Command } from "../../src/HubMessages.ts"
import { AgentsDoc } from "./Docs.ts"
import type { AgentRecord, SenderJson } from "./Docs.ts"
import { AgentMessageEntry, AgentResultEntry, contentText } from "./Inputs.ts"
import { loopFields } from "./Loops.ts"
import type { Runtime } from "./Runtime.ts"
import { modelName } from "./Turns.ts"

/** The tools' names, as the model calls them. */
export const agentTool = "agent"
export const messageAgentTool = "message_agent"
export const stopAgentTool = "stop_agent"

/** The kind of agent the web shows; there is only one. */
const agentType = "general-purpose"

/** What a subagent is told of itself, after the session's own sections. */
export const subagentNote = [
  "You are an agent that another agent started to do one task, which its first message describes. Do it with your tools, without asking anyone: no one answers you but that agent.",
  "When you are done, answer with a concise report of what you did and found, with the paths and details it needs. Your last message is all it reads.",
  "It may message you later, with more to do: carry on from where you were.",
  'A message from a person may come while you work, led by their name in brackets, such as "[Ada] ...": follow it.',
].join("\n")

/** How an agent's run ended, as its notification says. */
export type RunOutcome = "completed" | "stopped" | "failed"

const summaries: Record<RunOutcome, string> = {
  completed: "finished",
  stopped: "was stopped",
  failed: "failed",
}

/**
 * The message the parent is given when an agent's run ends, in the shape of Claude Code's task
 * notification, which the web shows as from the agent: its summary and result.
 */
export const agentNotification = (
  agentId: string,
  description: string,
  outcome: RunOutcome,
  result: string,
) =>
  [
    "<task-notification>",
    `<task-id>${agentId}</task-id>`,
    `<status>${outcome}</status>`,
    `<summary>Agent "${description}" ${summaries[outcome]}</summary>`,
    `<note>Message it with ${messageAgentTool} to give it more to do; it keeps its context.</note>`,
    `<result>${result}</result>`,
    "</task-notification>",
  ].join("\n")

/** The text of an assistant message. */
const answerText = (message: unknown): string => {
  const content = (message as Partial<AssistantMessage> | undefined)?.content
  return Array.isArray(content) ? contentText(content.filter((block) => block.type === "text")) : ""
}

/** What the agent said last, from its newest answers. */
const lastSaid = async (tx: Tx, conversationId: ConversationId): Promise<string> => {
  const page = await tx.scanEntries({ conversationId }, 50)
  for (const entry of page.items) {
    const message = entry.model?.[0]
    if (message?.role !== "assistant") continue
    const text = answerText(message)
    if (text !== "") return text
  }
  return ""
}

/**
 * The anchor that owns a subagent's conversation: a background task of its parent's
 * conversation, done at once, so the parent's stop and idle waits never reach the agent.
 */
const AnchorTask = defineTask<null, { phase: "done" }, null>({
  name: "kndl.agent-anchor",
  version: 1,
  initial: () => ({ phase: "done" }),
  phases: {
    done: (_task, runtime, context) =>
      runtime.commit(
        () => ({ status: "terminal", outcome: { status: "completed", result: null } }),
        context,
      ),
  },
  abort: (_task, runtime, context) =>
    runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
})

interface MessageInput {
  readonly agentId: string
  readonly text: string
  /** Whether the run's end goes to the parent, as a notification; a call that waits takes it. */
  readonly report: boolean
  /** The Participant who sent it, for one from the web. */
  readonly sender?: SenderJson
}

type MessageState =
  | { readonly phase: "deliver" }
  | {
      readonly phase: "report"
      readonly outcome: RunOutcome
      readonly text: string
      readonly notify: boolean
      readonly attempt: number
    }
  | {
      readonly phase: "await"
      readonly outcome: RunOutcome
      readonly text: string
      readonly attempt: number
    }

/** How a run of the agent ended: its final answer, as a call that waits for it returns it. */
interface MessageResult {
  readonly outcome: RunOutcome
  readonly text: string
}

const done = (result: MessageResult) =>
  ({ status: "terminal", outcome: { status: "completed", result } }) as const

/** Takes a message task off its agent's list of those under way. */
const settle = async (tx: Tx, agentId: string, taskId: TaskId) => {
  const agent = (await tx.doc(AgentsDoc)).agents[agentId]
  if (agent === undefined) return
  agent.pending = agent.pending.filter((id) => id !== taskId)
  agent.quiet = agent.quiet.filter((id) => id !== taskId)
}

/**
 * One message to a subagent: delivered (a steer while it runs, else a run of its own), its answer
 * awaited, and given to the parent as a notification, once, whatever restarts come between.
 */
const MessageTask = defineTask<MessageInput, MessageState, MessageResult>({
  name: "kndl.agent-message",
  version: 1,
  initial: () => ({ phase: "deliver" }),
  phases: {
    deliver: async (task, runtime, context) => {
      const { agentId, text, sender } = task.input
      const record = (await runtime.snapshot(AgentsDoc, context))?.agents[agentId]
      if (record === undefined) {
        await runtime.commit(
          () => done({ outcome: "failed", text: `There is no agent ${agentId}.` }),
          context,
        )
        return
      }
      const child = await runtime.conversation(record.conversationId, context)
      if (child === undefined) throw new Error(`agent ${agentId}'s conversation is gone`)
      const submission = await child.submit(
        {
          type: "input",
          content: text,
          whenBusy: "steer",
          requestId: `agent-message:${task.id}`,
          entry: {
            kind: AgentMessageEntry,
            data: sender === undefined ? { agentId } : { agentId, sender },
          },
        },
        context,
      )
      const settled = await submission.wait(context)
      await runtime.commit(async (tx) => {
        const agent = (await tx.doc(AgentsDoc)).agents[agentId]
        const quiet = agent?.quiet.includes(task.id) === true
        const next = (outcome: RunOutcome, said: string, notify: boolean) =>
          ({
            status: "running",
            checkpoint: {
              phase: "report",
              outcome,
              text: said,
              notify: notify && task.input.report && !quiet,
              attempt: 1,
            },
          }) as const
        if (settled.status === "unanswered") {
          if (settled.reason === "aborted") {
            const said = await lastSaid(tx, record.conversationId)
            return next(
              "stopped",
              `The agent was stopped before it finished.${said === "" ? "" : ` What it had said:\n${said}`}`,
              true,
            )
          }
          const why = typeof settled.detail === "string" ? settled.detail : settled.reason
          return next("failed", `The agent's run failed: ${why}`, true)
        }
        if (settled.type !== "input") return next("completed", "", false)
        // Several messages can end in one answer: it is given once.
        const fresh = agent !== undefined && !agent.delivered.includes(settled.answer)
        if (fresh) agent.delivered.push(settled.answer)
        const answer = await tx.entry(AssistantEntry, settled.answer)
        const said = answerText(answer?.model?.[0])
        return next(
          "completed",
          said === "" ? "The agent finished without a final answer." : said,
          fresh,
        )
      }, context)
    },
    report: async (task, runtime, context) => {
      const { outcome, text, notify, attempt } = task.state.checkpoint
      const record = (await runtime.snapshot(AgentsDoc, context))?.agents[task.input.agentId]
      if (!notify || record === undefined) {
        await runtime.commit(async (tx) => {
          await settle(tx, task.input.agentId, task.id)
          return done({ outcome, text })
        }, context)
        return
      }
      const parent = await runtime.conversation(record.parentConversationId, context)
      await parent?.submit(
        {
          type: "input",
          content: agentNotification(task.input.agentId, record.description, outcome, text),
          whenBusy: "followUp",
          requestId: `agent-result:${task.id}:${attempt}`,
          entry: { kind: AgentResultEntry, data: { agentId: task.input.agentId } },
        },
        context,
      )
      await runtime.commit(
        () => ({ status: "running", checkpoint: { phase: "await", outcome, text, attempt } }),
        context,
      )
    },
    // A stop of the parent withdraws its queued follow-ups: the result goes again once it is idle.
    await: async (task, runtime, context) => {
      const { outcome, text, attempt } = task.state.checkpoint
      const record = (await runtime.snapshot(AgentsDoc, context))?.agents[task.input.agentId]
      const parent =
        record === undefined
          ? undefined
          : await runtime.conversation(record.parentConversationId, context)
      const submission =
        parent === undefined || record === undefined
          ? undefined
          : await parent.submit(
              {
                type: "input",
                content: agentNotification(task.input.agentId, record.description, outcome, text),
                whenBusy: "followUp",
                requestId: `agent-result:${task.id}:${attempt}`,
                entry: { kind: AgentResultEntry, data: { agentId: task.input.agentId } },
              },
              context,
            )
      const settled = await submission?.wait(context)
      if (
        parent !== undefined &&
        settled?.status === "unanswered" &&
        settled.reason === "aborted" &&
        settled.entry === undefined
      ) {
        await parent.waitForIdle(context)
        await runtime.commit(
          () => ({
            status: "running",
            checkpoint: { phase: "report", outcome, text, notify: true, attempt: attempt + 1 },
          }),
          context,
        )
        return
      }
      await runtime.commit(async (tx) => {
        await settle(tx, task.input.agentId, task.id)
        return done({ outcome, text })
      }, context)
    },
  },
  abort: (task, runtime, context) =>
    runtime.commit(async (tx) => {
      await settle(tx, task.input.agentId, task.id)
      return { status: "terminal", outcome: { status: "aborted" } }
    }, context),
})

/** Creates a message task for the agent, under its parent's conversation, in the background. */
const createMessage = async (
  tx: Tx,
  record: AgentRecord,
  input: MessageInput,
): Promise<TaskId<MessageResult>> => {
  const taskId = await tx.createTask(MessageTask, input, {
    ownership: { kind: "conversation" },
    conversationId: record.parentConversationId,
    background: true,
  })
  const agent = (await tx.doc(AgentsDoc)).agents[input.agentId]
  agent?.pending.push(taskId)
  return taskId
}

/** What a call that doesn't wait says of a run under way. */
const comesLater =
  "Its result will come to you as a new message when it finishes: don't wait or poll for it. Carry on with other work meanwhile, or end your turn."

const text = (said: string) => ({ output: [{ type: "text" as const, text: said }] })

export interface SubagentsOptions {
  readonly runtime: Runtime
  /** The extensions a subagent goes without: the agent tools' and the question tool's. */
  readonly withheld: () => ReadonlyArray<Extension>
}

/** The agent, message and stop tools, offering the Creator's Models as the catalogue has them. */
export const agentsExtension = ({ runtime, withheld }: SubagentsOptions): Extension => {
  const harness = () => runtime.harness()

  /** The agent's record, if the calling conversation started it. */
  const ownAgent = async (agentId: string, conversationId: ConversationId, context: Context) => {
    const record = (await harness().snapshot(AgentsDoc, context))?.agents[agentId]
    if (record === undefined || record.parentConversationId !== conversationId)
      throw new Error(`You have no agent ${agentId}.`)
    return record
  }

  /** Waits for a message task a call waits for; the Turn's stop stops the agent. */
  const waitFor = async (
    taskId: TaskId<MessageResult>,
    record: AgentRecord,
    context: Context,
  ): Promise<MessageResult> => {
    try {
      const settled = await harness().waitForTask(taskId, context)
      const { outcome } = settled.state
      if (outcome.status === "completed") return outcome.result
      return { outcome: "failed", text: `The agent's run ended: ${outcome.status}.` }
    } catch (error) {
      // Stopped with the Turn, as a foreground agent is; a shutdown leaves it to the restart.
      if (!runtime.closing())
        await (await harness().conversation(record.conversationId, runtime.context))
          ?.abort(runtime.context)
          .catch(() => undefined)
      throw error
    }
  }

  const models = runtime.catalog.names()
  const agent = defineTool({
    name: agentTool,
    description: [
      "Starts an agent to do a task on its own, in the background.",
      "The agent works in the same directory with the same tools as you, except that it can't start agents or ask the people in this session questions. It sees none of this conversation: the prompt is all it knows, so give it everything it needs, and say what it should report back.",
      "Use it for a self-contained task, such as researching a question across many files or making a change you can describe fully, to keep its detail out of your own context. Start several to work in parallel.",
      "The call returns at once with the agent's id. When the agent finishes, its result comes to you as a new message, in a <task-notification>, which only you see: tell the people what it found. Don't wait or poll for it: carry on with other work, or end your turn.",
      "Only when you can't go on without its answer, set wait to true: the call then waits for the agent and returns its final answer.",
      `Message an agent with ${messageAgentTool}, which also resumes one that has finished, with its context; stop one with ${stopAgentTool}. Agents survive this session restarting.`,
    ].join(" "),
    parameters: Type.Object({
      description: Type.String({
        description: "A short description of the task, in three to five words, which people see.",
      }),
      prompt: Type.String({ description: "The task for the agent, with everything it needs." }),
      model: Type.Optional(
        Type.String({
          description: `The model the agent runs on, as <provider>/<id>; the one you run on by default.${
            models.length === 0 ? "" : ` One of: ${models.join(", ")}.`
          }`,
        }),
      ),
      wait: Type.Optional(
        Type.Boolean({
          description:
            "Wait for the agent to finish, and get its final answer as the call's result. False by default: its result comes later, as a message.",
        }),
      ),
    }),
    // A rerun after a restart finds the agent it started, and the message it sent, by its memo.
    replay: "safe",
    execute: async (args, api, context) => {
      const agentId = await api.memo("kndl.agentId", runtime.newId(), context)
      const wait = args.wait === true
      let model = (await api.agent(context)).model
      if (args.model !== undefined && args.model.trim() !== "") {
        const found = await runtime.catalog.resolve(args.model.trim())
        if ("why" in found)
          throw new Error(
            `Can't run the agent on ${args.model}: ${found.why}. Use one of: ${runtime.catalog.names().join(", ")}.`,
          )
        model = found.model
      }
      if (model === undefined) throw new Error("There is no model to run the agent on.")
      const parentLoop = runtime.loops.loopOf(api.conversationId)
      const turnId = runtime.loops.get(api.conversationId)?.turnId
      const named = modelName({ provider: model.provider, id: model.modelId })
      const created = await api.commit(async (tx) => {
        const doc = await tx.doc(AgentsDoc)
        const known = doc.agents[agentId]
        if (known !== undefined) return { record: known, fresh: false }
        const anchorTaskId = await tx.createTask(AnchorTask, null, {
          ownership: { kind: "conversation" },
          background: true,
        })
        const child = await tx.createConversation({
          ownership: { kind: "task", taskId: anchorTaskId },
        })
        await configure(tx, child.id, {
          model: { provider: model.provider, modelId: model.modelId },
          extensions: { remove: withheld() },
          instructions: subagentNote,
        })
        const record: AgentRecord = {
          conversationId: child.id,
          parentConversationId: api.conversationId,
          anchorTaskId,
          description: args.description,
          model: named,
          reported: turnId !== undefined && parentLoop !== undefined && parentLoop.kind !== "agent",
          status: "Running",
          delivered: [],
          quiet: [],
          pending: [],
          calls: {},
        }
        doc.agents[agentId] = record
        return { record, fresh: true }
      }, context)
      const { record } = created
      // Followed before its first message, so its first run's events all reach the Hub.
      await runtime.loops.attach(record.conversationId, {
        kind: "agent",
        agentId,
        reported: record.reported,
      })
      if (created.fresh && record.reported && parentLoop !== undefined)
        runtime.report({
          _tag: "AgentStarted",
          turnId,
          ...(parentLoop.kind === "thread" ? loopFields(parentLoop) : {}),
          agentId,
          toolCallId: api.callId,
          agentType,
          description: args.description,
          model: named,
          background: !wait,
        })
      const taskId = await api.commit(async (tx) => {
        const now = (await tx.doc(AgentsDoc)).agents[agentId]
        if (now === undefined) throw new Error(`The agent ${agentId} is gone.`)
        const sent = now.calls[api.callId]
        if (sent !== undefined) return sent as TaskId<MessageResult>
        const created = await createMessage(tx, now, { agentId, text: args.prompt, report: !wait })
        now.calls[api.callId] = created
        return created
      }, context)
      if (!wait) return text(`Started the agent ${agentId} in the background. ${comesLater}`)
      const result = await waitFor(taskId, record, context)
      return text(result.text)
    },
  })

  const message = defineTool({
    name: messageAgentTool,
    description: [
      "Sends a message to an agent you started, by its id.",
      "A running agent reads it at its next step. One that has finished or was stopped resumes with it, where it left off: it keeps its whole conversation, so say only what is new, which is cheaper than starting a new agent. Its result comes to you as a new message, as when it was started.",
      "Set wait to true only when you can't go on without its answer: the call then waits for the resumed run and returns its final answer.",
    ].join(" "),
    parameters: Type.Object({
      agentId: Type.String({ description: "The agent's id, as the agent tool returned it." }),
      message: Type.String({ description: "What to tell or ask it." }),
      wait: Type.Optional(
        Type.Boolean({
          description:
            "Wait for a resumed agent to finish, and get its final answer as the call's result. False by default.",
        }),
      ),
    }),
    replay: "safe",
    execute: async (args, api, context) => {
      const record = await ownAgent(args.agentId, api.conversationId, context)
      const wait = args.wait === true
      const running =
        (await harness().snapshot(LiveDoc, record.conversationId, context))?.run !== undefined
      const taskId = await api.commit(async (tx) => {
        const now = (await tx.doc(AgentsDoc)).agents[args.agentId]
        if (now === undefined) throw new Error(`You have no agent ${args.agentId}.`)
        const sent = now.calls[api.callId]
        if (sent !== undefined) return sent as TaskId<MessageResult>
        const created = await createMessage(tx, now, {
          agentId: args.agentId,
          text: args.message,
          report: !wait,
        })
        now.calls[api.callId] = created
        return created
      }, context)
      if (wait) return text((await waitFor(taskId, record, context)).text)
      return text(
        running
          ? `The agent ${args.agentId} is running: it reads your message at its next step. ${comesLater}`
          : `Resumed the agent ${args.agentId} with your message. ${comesLater}`,
      )
    },
  })

  const stop = defineTool({
    name: stopAgentTool,
    description: [
      "Stops a running agent you started, by its id, and returns what it had said.",
      `It can be resumed later with ${messageAgentTool}.`,
    ].join(" "),
    parameters: Type.Object({
      agentId: Type.String({ description: "The agent's id, as the agent tool returned it." }),
    }),
    execute: async (args, _api, context) => {
      const record = await ownAgent(args.agentId, _api.conversationId, context)
      const child = await harness().conversation(record.conversationId, context)
      if ((await harness().snapshot(LiveDoc, record.conversationId, context))?.run === undefined)
        throw new Error("The agent isn't running.")
      // Its end is this call's to say, not a notification's.
      await harness().commit(async (tx) => {
        const agent = (await tx.doc(AgentsDoc)).agents[args.agentId]
        if (agent !== undefined) agent.quiet = [...agent.pending]
      }, context)
      await child?.abort(context)
      const said = await harness().commit((tx) => lastSaid(tx, record.conversationId), context)
      return text(
        `Stopped the agent ${args.agentId}.${said === "" ? "" : ` What it had said:\n${said}`}`,
      )
    },
  })

  return defineExtension({
    name: "kndl-agents",
    tools: [agent, message, stop],
    tasks: [AnchorTask, MessageTask],
  })
}

/** The Creator's message to an agent (DeliverAgentMessage), with their name, as a prompt is. */
export const messageFromCreator = async (
  runtime: Runtime,
  command: Command<"DeliverAgentMessage">,
) => {
  const failed = (message: string) =>
    runtime.report({
      _tag: "AgentCommandFailed",
      agentId: command.agentId,
      command: "MessageAgent",
      senderId: command.sender.id,
      message,
    })
  try {
    const sender = { id: command.sender.id, login: command.sender.login, name: command.sender.name }
    const created = await runtime.harness().commit(async (tx) => {
      const record = (await tx.doc(AgentsDoc)).agents[command.agentId]
      if (record === undefined) return false
      await createMessage(tx, record, {
        agentId: command.agentId,
        text: deliveredPrompt(command.sender, command.text, command.attachments ?? []),
        report: true,
        sender,
      })
      return true
    }, runtime.context)
    if (!created) failed(`This Session has no agent ${command.agentId}.`)
  } catch (error) {
    failed(error instanceof Error ? error.message : String(error))
  }
}

/** The Creator's stop (StopAgent): the parent is told how the run ended, as of any. */
export const stopFromCreator = async (runtime: Runtime, command: Command<"StopAgent">) => {
  const failed = (message: string) =>
    runtime.report({
      _tag: "AgentCommandFailed",
      agentId: command.agentId,
      command: "StopAgent",
      message,
    })
  const harness = runtime.harness()
  const record = (await harness.snapshot(AgentsDoc, runtime.context))?.agents[command.agentId]
  if (record === undefined) return failed(`This Session has no agent ${command.agentId}.`)
  if ((await harness.snapshot(LiveDoc, record.conversationId, runtime.context))?.run === undefined)
    return failed("The agent isn't running.")
  const child = await harness.conversation(record.conversationId, runtime.context)
  void child?.abort(runtime.context).catch((error: unknown) => failed(String(error)))
}

/** The subagents the Session has, for the agent to follow at start. */
export const knownAgents = async (runtime: Runtime) =>
  Object.entries((await runtime.harness().snapshot(AgentsDoc, runtime.context))?.agents ?? {})
