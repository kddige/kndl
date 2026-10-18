// Subagents (ADR 0014, amended by ADR 0029): pi has none, so kndl's extension adds an `agent` tool
// that starts one as a child pi session in the same process, on any of the Creator's Models, the
// parent's by default. It has the parent's tools but `agent` and `ask_user_question`, so it starts
// no agents of its own and asks no one: it answers its caller.
//
// Each is reported as hub-link reports Claude Code's: AgentStarted under the call that started
// it, its runs' events tagged with its id (Turns.ts), and its status: Running, then Done, or
// Stopped. The Creator messages it (DeliverAgentMessage): a running agent reads the message at its
// next step; one that has stopped resumes with it, and the main loop is told how that run ended
// with its next prompt. StopAgent stops it.
//
// The call waits for the agent (foreground only): its result is the agent's final answer.

import { Type } from "@earendil-works/pi-ai/compat"
import type { Api, Model } from "@earendil-works/pi-ai/compat"
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent"
import type {
  AgentSession,
  AgentSessionEvent,
  ExtensionAPI,
  ExtensionToolContext,
  ModelRegistry,
  ToolDefinition,
  ToolInfo,
} from "@earendil-works/pi-coding-agent"
import type { ModCommand } from "@kndl/protocol"
import { deliveredPrompt } from "../../src/HubMessages.ts"
import { questionTool } from "./Questions.ts"
import { Turns } from "./Turns.ts"

/** The tool's name, as the model calls it. */
export const agentTool = "agent"

/** What the model reads of the tool, whichever model it is. */
export const agentToolDescription = [
  "Starts an agent to do a task on its own and waits for its answer.",
  "The agent works in the same directory with the same tools as you, except that it can't start agents or ask the people in this session questions. It sees none of this conversation: the prompt is all it knows, so give it everything it needs, and say what it should report back.",
  "Use it for a self-contained task, such as researching a question across many files or making a change you can describe fully, to keep its detail out of your own context. Several calls in one message can run in parallel.",
  "The result is the agent's final answer, which only you see: tell the people what it found.",
].join(" ")

/** The tool's parameters, as Claude Code's Agent tool has them where they apply. */
export const agentParameters = (models: ReadonlyArray<string>) =>
  Type.Object({
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
  })

/** What a subagent is told of itself, after pi's own system prompt. */
export const subagentNote = [
  "You are an agent that another agent started to do one task, which its first message describes. Do it with your tools, without asking anyone: no one answers you but that agent.",
  "When you are done, answer with a concise report of what you did and found, with the paths and details it needs. Your last message is all it reads.",
  'A message from a person may come while you work, led by their name in brackets, such as "[Ada] ...": follow it.',
].join("\n")

/** The kind of agent the web shows; there is only one. */
const agentType = "general-purpose"

/** A child pi session, as a subagent is one: what Subagents uses of pi's AgentSession. */
export type ChildSession = Pick<
  AgentSession,
  "prompt" | "steer" | "abort" | "subscribe" | "isStreaming" | "dispose"
>

export interface ChildSpec {
  readonly cwd: string
  readonly agentDir: string
  /** The models it may run on, with their providers and credentials. */
  readonly modelRuntime: ModelRuntime
  readonly model: Model<Api>
  readonly thinkingLevel: AgentSession["thinkingLevel"]
  /** pi's own tools it has, by name, which it makes for its directory as the parent's are made. */
  readonly builtinTools: ReadonlyArray<string>
  /** The other tools it has: extensions' and MCP servers', run as the parent runs them. */
  readonly customTools: ReadonlyArray<ToolDefinition>
  /** The parent's settings, which it keeps in memory. */
  readonly settings: Parameters<typeof SettingsManager.inMemory>[0]
}

/**
 * A subagent's pi session: in memory, with pi's system prompt, context files and skills as pi
 * finds them, and none of its extensions, which are the parent's to run (this one among them).
 */
export const createChild = async (spec: ChildSpec): Promise<AgentSession> => {
  const settingsManager = SettingsManager.inMemory(spec.settings)
  const resourceLoader = new DefaultResourceLoader({
    cwd: spec.cwd,
    agentDir: spec.agentDir,
    settingsManager,
    noExtensions: true,
    appendSystemPrompt: [subagentNote],
  })
  await resourceLoader.reload()
  const { session } = await createAgentSession({
    cwd: spec.cwd,
    agentDir: spec.agentDir,
    modelRuntime: spec.modelRuntime,
    model: spec.model,
    thinkingLevel: spec.thinkingLevel,
    tools: [...spec.builtinTools, ...spec.customTools.map((tool) => tool.name)],
    customTools: [...spec.customTools],
    resourceLoader,
    sessionManager: SessionManager.inMemory(spec.cwd),
    settingsManager,
  })
  return session
}

/**
 * The models a subagent may run on: pi's own, with the providers kndl's extension and others
 * registered in the parent (the Gateway's, the Claude bridge), so it runs as the parent does.
 */
export const childModels = async (registry: ModelRegistry): Promise<ModelRuntime> => {
  const runtime = await ModelRuntime.create({ refreshOnCreate: false })
  for (const id of registry.getRegisteredProviderIds()) {
    const native = registry.getRegisteredNativeProvider(id)
    const config = registry.getRegisteredProviderConfig(id)
    if (native !== undefined) runtime.registerNativeProvider(native)
    else if (config !== undefined) runtime.registerProvider(id, config)
  }
  return runtime
}

/**
 * The model a subagent runs on: `name`, as `<provider>/<id>`, or the parent's. Throws, for the
 * model to read, when there is no such model, or no credential for it.
 */
export const childModel = (
  runtime: Pick<ModelRuntime, "getModel" | "hasConfiguredAuth">,
  name: string | undefined,
  parent: Pick<Model<Api>, "provider" | "id"> | undefined,
  offered: ReadonlyArray<string>,
): Model<Api> => {
  const choose = offered.length === 0 ? "" : ` Use one of: ${offered.join(", ")}.`
  const wanted = name?.trim() || (parent && `${parent.provider}/${parent.id}`)
  if (!wanted) throw new Error(`There is no model to run the agent on.${choose}`)
  const slash = wanted.indexOf("/")
  const model =
    slash <= 0 ? undefined : runtime.getModel(wanted.slice(0, slash), wanted.slice(slash + 1))
  if (model === undefined) throw new Error(`There is no model ${wanted}.${choose}`)
  if (!runtime.hasConfiguredAuth(model.provider))
    throw new Error(`There is no credential for ${wanted}.${choose}`)
  return model
}

/** pi's tools in the parent, as the subagent has them: the parent's own, but these. */
const notForAgents = new Set([agentTool, questionTool])

/**
 * The parent's active tools a subagent has, but the agent and question tools: pi's own by name,
 * for the child to make, and the rest as the parent runs them.
 */
export const childTools = (
  active: ReadonlyArray<string>,
  all: ReadonlyArray<Pick<ToolInfo, "name" | "sourceInfo">>,
  callable: ExtensionToolContext["tools"],
): { builtinTools: Array<string>; customTools: Array<ToolDefinition> } => {
  const builtin = new Set(
    all.filter((tool) => tool.sourceInfo.source === "builtin").map((tool) => tool.name),
  )
  const wanted = new Set(active.filter((name) => !notForAgents.has(name)))
  return {
    builtinTools: [...wanted].filter((name) => builtin.has(name)),
    customTools: callable
      .filter((tool) => wanted.has(tool.name) && !builtin.has(tool.name))
      .map((tool) => ({
        name: tool.name,
        label: tool.label,
        description: tool.description,
        parameters: tool.parameters,
        ...(tool.prepareArguments === undefined ? {} : { prepareArguments: tool.prepareArguments }),
        ...(tool.executionMode === undefined ? {} : { executionMode: tool.executionMode }),
        execute: (toolCallId, params, signal, onUpdate) =>
          tool.execute(toolCallId, params, signal, onUpdate),
      })),
  }
}

type Command<Tag extends ModCommand["_tag"]> = Extract<ModCommand, { _tag: Tag }>

export interface SubagentsOptions {
  readonly report: (event: Record<string, unknown>) => void
  /** Milliseconds, for a run's duration. */
  readonly now: () => number
  /** A new agent's id, or a new run's. */
  readonly newId: () => string
  /** Tells the main loop, with its next prompt, how a run it didn't wait for ended. */
  readonly notify: (text: string) => void
}

export interface RunOptions {
  /** The main loop's Turn that starts it; undefined when there is none, and it goes unreported. */
  readonly turnId: string | undefined
  /** The agent call that starts it. */
  readonly toolCallId: string
  readonly description: string
  readonly prompt: string
  /** The model it runs on, as `<provider>/<id>`. */
  readonly model: string
  readonly session: ChildSession
  /** The Turn's, which stops it. */
  readonly signal?: AbortSignal | undefined
}

/** How a run of the agent ended: its final answer, as the agent call returns it. */
export interface RunResult {
  readonly agentId: string
  readonly text: string
  readonly stopped: boolean
}

interface Agent {
  readonly agentId: string
  readonly description: string
  readonly session: ChildSession
  readonly report: (event: Record<string, unknown>) => void
  readonly unsubscribe: () => void
  /** What the agent said last, from the last model request of its run. */
  last: { text: string; error: string | undefined }
  /** The run under way, which ends when pi settles; undefined between runs. */
  run:
    | {
        /** Whether pi started it: a prompt pi refused starts no run, and settles none. */
        started: boolean
        readonly settle: (aborted: boolean) => void
      }
    | undefined
}

const assistantText = (content: unknown): string =>
  Array.isArray(content)
    ? content
        .filter(
          (block): block is { type: "text"; text: string } =>
            typeof block === "object" && block !== null && block.type === "text",
        )
        .map((block) => block.text)
        .join("")
    : ""

export class Subagents {
  private readonly agents = new Map<string, Agent>()

  constructor(private readonly options: SubagentsOptions) {}

  /** Starts an agent, and waits for its run to end: what the agent call returns. */
  async run(options: RunOptions): Promise<RunResult> {
    if (options.signal?.aborted) {
      options.session.dispose()
      throw new Error("The Turn was stopped before the agent started.")
    }
    const agentId = this.options.newId()
    const report = options.turnId === undefined ? () => undefined : this.options.report
    const agent = this.adopt(agentId, options.description, options.session, report)
    report({
      _tag: "AgentStarted",
      turnId: options.turnId,
      agentId,
      toolCallId: options.toolCallId,
      agentType,
      description: options.description,
      model: options.model,
      background: false,
    })
    const stop = () => void agent.session.abort()
    options.signal?.addEventListener("abort", stop, { once: true })
    try {
      const stopped = await this.runWith(agent, options.prompt)
      return { agentId, text: this.answer(agent, stopped), stopped }
    } finally {
      options.signal?.removeEventListener("abort", stop)
    }
  }

  /**
   * The Creator's message to an agent: read by a running one at its next step, or resuming one
   * that has stopped.
   */
  async message(command: Command<"DeliverAgentMessage">) {
    const failed = (message: string) =>
      this.options.report({
        _tag: "AgentCommandFailed",
        agentId: command.agentId,
        command: "MessageAgent",
        senderId: command.sender.id,
        message,
      })
    const agent = this.agents.get(command.agentId)
    if (agent === undefined) return failed(`This Session has no agent ${command.agentId}.`)
    const text = deliveredPrompt(command.sender, command.text, command.attachments ?? [])
    if (agent.session.isStreaming) {
      try {
        await agent.session.steer(text)
      } catch (error) {
        failed(String(error))
      }
      return
    }
    void this.runWith(agent, text).then(
      (stopped) =>
        this.options.notify(
          [
            "<agent-notification>",
            `The agent ${agent.agentId} ("${agent.description}"), which ${command.sender.name} resumed with a message, ended its run:`,
            this.answer(agent, stopped),
            "</agent-notification>",
          ].join("\n"),
        ),
      (error: unknown) => failed(String(error)),
    )
  }

  /** Stops a running agent (StopAgent), as Claude Code's TaskStop does. */
  stop(command: Command<"StopAgent">) {
    const failed = (message: string) =>
      this.options.report({
        _tag: "AgentCommandFailed",
        agentId: command.agentId,
        command: "StopAgent",
        message,
      })
    const agent = this.agents.get(command.agentId)
    if (agent === undefined) return failed(`This Session has no agent ${command.agentId}.`)
    if (agent.run === undefined && !agent.session.isStreaming)
      return failed("The agent isn't running.")
    void agent.session.abort().catch((error: unknown) => failed(String(error)))
  }

  /** Ends every agent, with the session they belong to. */
  dispose() {
    for (const agent of this.agents.values()) {
      agent.unsubscribe()
      agent.session.dispose()
    }
    this.agents.clear()
  }

  /** Takes an agent's session in, reporting its runs as the agent's. */
  private adopt(
    agentId: string,
    description: string,
    session: ChildSession,
    report: (event: Record<string, unknown>) => void,
  ): Agent {
    const turns = new Turns({ report, now: this.options.now, newId: this.options.newId, agentId })
    const onEvent = (event: AgentSessionEvent) => {
      switch (event.type) {
        case "agent_start":
          if (agent.run !== undefined) agent.run.started = true
          turns.agentStart()
          return
        case "message_update":
          if (event.assistantMessageEvent.type === "text_delta")
            turns.textDelta(event.assistantMessageEvent.delta)
          return
        case "message_end":
          if (event.message.role !== "assistant") return
          turns.assistantEnded(event.message)
          agent.last = {
            text: assistantText(event.message.content),
            error: event.message.errorMessage,
          }
          return
        case "tool_execution_start":
          turns.toolStarted(event.toolCallId, event.toolName, event.args, event.parentToolCallId)
          return
        case "tool_execution_end":
          turns.toolEnded(
            event.toolCallId,
            event.toolName,
            event.result,
            event.isError,
            event.parentToolCallId,
          )
          return
        case "agent_settled":
          turns.settled(event.aborted)
          agent.run?.settle(event.aborted)
          return
      }
    }
    const agent: Agent = {
      agentId,
      description,
      session,
      report,
      unsubscribe: session.subscribe(onEvent),
      last: { text: "", error: undefined },
      run: undefined,
    }
    this.agents.set(agentId, agent)
    return agent
  }

  /** Runs the agent with a prompt, from Running to Done or Stopped; whether it was stopped. */
  private async runWith(agent: Agent, text: string): Promise<boolean> {
    const { promise: settled, resolve: settle } = Promise.withResolvers<boolean>()
    const run = { started: false, settle }
    agent.run = run
    agent.last = { text: "", error: undefined }
    agent.report({ _tag: "AgentStatusChanged", agentId: agent.agentId, status: "Running" })
    try {
      await agent.session.prompt(text, { expandPromptTemplates: false })
      const stopped = run.started ? await settled : false
      agent.report({
        _tag: "AgentStatusChanged",
        agentId: agent.agentId,
        status: stopped ? "Stopped" : "Done",
      })
      return stopped
    } catch (error) {
      agent.report({ _tag: "AgentStatusChanged", agentId: agent.agentId, status: "Done" })
      throw error
    } finally {
      agent.run = undefined
    }
  }

  /** What the agent call, or the main loop's note, says of a run that ended. */
  private answer(agent: Agent, stopped: boolean): string {
    const { text, error } = agent.last
    if (stopped)
      return `The agent was stopped before it finished.${text === "" ? "" : ` What it had said:\n${text}`}`
    if (text !== "") return text
    if (error !== undefined) return `The agent's run failed: ${error}`
    return "The agent finished without a final answer."
  }
}

export interface AgentToolDeps {
  readonly subagents: Subagents
  /** The main loop's running Turn. */
  readonly turnId: () => string | undefined
  /** The Creator's Models, as `<provider>/<id>`, which the model is told it may choose from. */
  readonly models: ReadonlyArray<string>
  readonly pi: Pick<
    ExtensionAPI,
    "getActiveTools" | "getAllTools" | "getThinkingLevel" | "getSettings"
  >
  /** pi's own directory, for the child's resources. */
  readonly agentDir: () => string
}

/** The agent tool, as pi registers it. */
export const agentToolDefinition = ({
  subagents,
  turnId,
  models,
  pi,
  agentDir,
}: AgentToolDeps): ToolDefinition<ReturnType<typeof agentParameters>, { agentId: string }> => ({
  name: agentTool,
  label: "Agent",
  description: agentToolDescription,
  promptSnippet: "Start an agent to do a self-contained task, and wait for its answer",
  parameters: agentParameters(models),
  // It runs other tools, in its own session: never from another tool, and never in a subagent.
  exposure: "model-only",
  execute: async (toolCallId, params, signal, _onUpdate, ctx) => {
    const modelRuntime = await childModels(ctx.modelRegistry)
    const model = childModel(modelRuntime, params.model, ctx.model, models)
    const session = await createChild({
      cwd: ctx.cwd,
      agentDir: agentDir(),
      modelRuntime,
      model,
      thinkingLevel: pi.getThinkingLevel(),
      ...childTools(pi.getActiveTools(), pi.getAllTools(), ctx.tools),
      settings: pi.getSettings(),
    })
    const result = await subagents.run({
      turnId: turnId(),
      toolCallId,
      description: params.description,
      prompt: params.prompt,
      model: `${model.provider}/${model.id}`,
      session,
      signal,
    })
    return {
      content: [{ type: "text", text: result.text }],
      details: { agentId: result.agentId },
    }
  },
})
