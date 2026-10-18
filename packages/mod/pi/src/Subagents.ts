// Subagents (ADR 0014, amended by ADR 0029): pi has none, so kndl's extension adds an `agent` tool
// that starts one as a child pi session in the same process, on any of the Creator's Models, the
// parent's by default. It has the parent's tools but the agent, question, message and stop tools,
// so it starts no agents of its own and asks no one: it answers its caller.
//
// An agent runs in the background, as Claude Code's do: the call returns at once, the parent's
// Turn can end, and the agent's result comes to the main loop as a message of its own, which
// starts a Turn from the agent (or follows the running one, as pi's follow-up), in the shape of
// Claude Code's task notification. A call can wait for it instead (`wait`), as a foreground agent.
//
// Each is reported as hub-link reports Claude Code's: AgentStarted under the call that started
// it, its runs' events tagged with its id (Turns.ts), and its status: Running, then Done, or
// Stopped. The model messages (`message_agent`) or stops (`stop_agent`) one, as the Creator does
// (DeliverAgentMessage, StopAgent): a running agent reads a message at its next step; one that has
// ended resumes with it, a new run on its own conversation, whose result comes the same way.
//
// Each agent's pi session is a file in the agents' directory on the Session's volume
// (`<agentDir>/kndl/agents/<agentId>.jsonl`), beside an index of them (`index.json`): their
// description, model and status. So they outlive pi: when pi stops (sleep, a restart, a lost
// Runner), a running one is Interrupted, and when it starts again, a message resumes any of them
// on its saved conversation.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
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
  ExtensionToolContext,
  ModelRegistry,
  ToolDefinition,
  ToolInfo,
} from "@earendil-works/pi-coding-agent"
import type { AgentStatus, ModCommand } from "@kndl/protocol"
import { deliveredPrompt } from "../../src/HubMessages.ts"
import { followClaudeSession } from "./claude/Claude.ts"
import { questionTool } from "./Questions.ts"
import { Turns } from "./Turns.ts"

/** The tools' names, as the model calls them. */
export const agentTool = "agent"
export const messageAgentTool = "message_agent"
export const stopAgentTool = "stop_agent"

/** What the model reads of the agent tool, whichever model it is. */
export const agentToolDescription = [
  "Starts an agent to do a task on its own, in the background.",
  "The agent works in the same directory with the same tools as you, except that it can't start agents or ask the people in this session questions. It sees none of this conversation: the prompt is all it knows, so give it everything it needs, and say what it should report back.",
  "Use it for a self-contained task, such as researching a question across many files or making a change you can describe fully, to keep its detail out of your own context. Start several to work in parallel.",
  "The call returns at once with the agent's id. When the agent finishes, its result comes to you as a new message, in a <task-notification>, which only you see: tell the people what it found. Don't wait or poll for it: carry on with other work, or end your turn.",
  "Only when you can't go on without its answer, set wait to true: the call then waits for the agent and returns its final answer.",
  `Message an agent with ${messageAgentTool}, which also resumes one that has finished, with its context; stop one with ${stopAgentTool}.`,
].join(" ")

/** The agent tool's parameters, as Claude Code's Agent tool has them where they apply. */
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
    wait: Type.Optional(
      Type.Boolean({
        description:
          "Wait for the agent to finish, and get its final answer as the call's result. False by default: its result comes later, as a message.",
      }),
    ),
  })

/** What the model reads of the message tool. */
export const messageAgentToolDescription = [
  "Sends a message to an agent you started, by its id.",
  "A running agent reads it at its next step. One that has finished, was stopped or was interrupted resumes with it, where it left off: it keeps its whole conversation, so say only what is new, which is cheaper than starting a new agent. Its result comes to you as a new message, as when it was started.",
  "Set wait to true only when you can't go on without its answer: the call then waits for the resumed run and returns its final answer.",
].join(" ")

export const messageAgentParameters = Type.Object({
  agentId: Type.String({ description: "The agent's id, as the agent tool returned it." }),
  message: Type.String({ description: "What to tell or ask it." }),
  wait: Type.Optional(
    Type.Boolean({
      description:
        "Wait for a resumed agent to finish, and get its final answer as the call's result. False by default.",
    }),
  ),
})

/** What the model reads of the stop tool. */
export const stopAgentToolDescription = [
  "Stops a running agent you started, by its id, and returns what it had said.",
  `It can be resumed later with ${messageAgentTool}.`,
].join(" ")

export const stopAgentParameters = Type.Object({
  agentId: Type.String({ description: "The agent's id, as the agent tool returned it." }),
})

/** What a subagent is told of itself, after pi's own system prompt. */
export const subagentNote = [
  "You are an agent that another agent started to do one task, which its first message describes. Do it with your tools, without asking anyone: no one answers you but that agent.",
  "When you are done, answer with a concise report of what you did and found, with the paths and details it needs. Your last message is all it reads.",
  "It may message you later, with more to do: carry on from where you were.",
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
  /** The file its conversation is kept in: a new one, or one to resume. */
  readonly file: string
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
 * A subagent's pi session: its conversation in its own file, new or resumed, with pi's system
 * prompt, context files and skills as pi finds them, and none of its extensions, which are the
 * parent's to run (this one among them), but the Claude bridge's following of its session.
 */
export const createChild = async (spec: ChildSpec): Promise<AgentSession> => {
  const settingsManager = SettingsManager.inMemory(spec.settings)
  const resourceLoader = new DefaultResourceLoader({
    cwd: spec.cwd,
    agentDir: spec.agentDir,
    settingsManager,
    noExtensions: true,
    // The Claude bridge follows each session it runs Claude for: a subagent's too, resumed or not.
    extensionFactories: [{ name: "kndl-claude", factory: followClaudeSession }],
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
    sessionManager: SessionManager.open(spec.file, dirname(spec.file), spec.cwd),
    settingsManager,
  })
  // Starts the session for its extensions: the Claude bridge learns its directory on session_start.
  await session.bindExtensions({})
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
const notForAgents = new Set([agentTool, messageAgentTool, stopAgentTool, questionTool])

/** The parent's tools a call can run, when it has any: a tool's context has them. */
type CallableTools = ExtensionToolContext["tools"]

/**
 * The parent's active tools a subagent has, but the agent, message, stop and question tools: pi's
 * own by name, for the child to make, and the rest as the parent runs them. `callable` says which
 * the parent can run now, which only a tool's context knows: a tool it doesn't know yet, as when
 * the Creator resumes an agent before the main loop has run a tool, is described as pi lists it,
 * and found when the agent calls it.
 */
export const childTools = (
  active: ReadonlyArray<string>,
  all: ReadonlyArray<Pick<ToolInfo, "name" | "description" | "parameters" | "sourceInfo">>,
  callable: () => CallableTools | undefined,
): { builtinTools: Array<string>; customTools: Array<ToolDefinition> } => {
  const builtin = new Set(
    all.filter((tool) => tool.sourceInfo.source === "builtin").map((tool) => tool.name),
  )
  const wanted = new Set(active.filter((name) => !notForAgents.has(name)))
  const known = callable()
  const find = (name: string) => callable()?.find((tool) => tool.name === name)
  return {
    builtinTools: [...wanted].filter((name) => builtin.has(name)),
    customTools: all
      .filter((info) => wanted.has(info.name) && !builtin.has(info.name))
      .flatMap((info): Array<ToolDefinition> => {
        const tool = known?.find((each) => each.name === info.name)
        if (known !== undefined && tool === undefined) return []
        return [
          {
            name: info.name,
            label: tool?.label ?? info.name,
            description: tool?.description ?? info.description,
            parameters: tool?.parameters ?? info.parameters,
            ...(tool?.prepareArguments === undefined
              ? {}
              : { prepareArguments: tool.prepareArguments }),
            ...(tool?.executionMode === undefined ? {} : { executionMode: tool.executionMode }),
            execute: (toolCallId, params, signal, onUpdate) => {
              const run = tool ?? find(info.name)
              if (run === undefined) throw new Error(`The tool ${info.name} isn't available.`)
              return run.execute(toolCallId, params, signal, onUpdate)
            },
          },
        ]
      }),
  }
}

/** How an agent's run ended, as its notification says. */
export type RunOutcome = "completed" | "stopped" | "failed" | "interrupted"

const summaries: Record<RunOutcome, string> = {
  completed: "finished",
  stopped: "was stopped",
  failed: "failed",
  interrupted: "was interrupted when this session stopped",
}

/**
 * The message the main loop is given when an agent's run ends, in the shape of Claude Code's
 * task notification, which the web shows as from the agent: its summary and result.
 */
export const agentNotification = (
  agentId: string,
  description: string,
  outcome: RunOutcome,
  result?: string,
) =>
  [
    "<task-notification>",
    `<task-id>${agentId}</task-id>`,
    `<status>${outcome}</status>`,
    `<summary>Agent "${description}" ${summaries[outcome]}</summary>`,
    outcome === "interrupted"
      ? `<note>Message it with ${messageAgentTool} to resume it where it left off; it keeps its context.</note>`
      : `<note>Message it with ${messageAgentTool} to give it more to do; it keeps its context.</note>`,
    ...(result === undefined ? [] : [`<result>${result}</result>`]),
    "</task-notification>",
  ].join("\n")

type Command<Tag extends ModCommand["_tag"]> = Extract<ModCommand, { _tag: Tag }>

/** An agent's pi session, opened from its file, and the model it runs on, as `<provider>/<id>`. */
export interface OpenedChild {
  readonly session: ChildSession
  readonly model: string
}

export interface SubagentsOptions {
  readonly report: (event: Record<string, unknown>) => void
  /** Milliseconds, for a run's duration. */
  readonly now: () => number
  /** A new agent's id, or a new run's. */
  readonly newId: () => string
  /** Where the agents are kept: their index, and a file of each one's conversation. */
  readonly dir: string
  /**
   * Opens an agent's pi session on its file, new or saved, on `model` (`<provider>/<id>`), or the
   * parent's. Throws, for the model to read, when it can't run on it.
   */
  readonly open: (file: string, model: string | undefined) => Promise<OpenedChild>
  /** Gives the main loop an agent's result: a message that starts a Turn from the agent. */
  readonly deliver: (message: { readonly agentId: string; readonly text: string }) => void
  /** Tells the main loop, with its next prompt, of an agent pi's stopping interrupted. */
  readonly note: (text: string) => void
  /** What its runs' error messages must never say (Turns.ts). */
  readonly secrets?: ReadonlyArray<string> | undefined
}

export interface StartOptions {
  /** The main loop's Turn that starts it; undefined when there is none, and it goes unreported. */
  readonly turnId: string | undefined
  /** The agent call that starts it. */
  readonly toolCallId: string
  readonly description: string
  readonly prompt: string
  /** The model it runs on, as `<provider>/<id>`; the parent's when undefined. */
  readonly model: string | undefined
  /** Whether the call waits for it, as a foreground agent, which the Turn's stop stops. */
  readonly wait?: boolean | undefined
  /** The Turn's, which stops an agent the call waits for. */
  readonly signal?: AbortSignal | undefined
}

/** How a run of the agent ended: its final answer, as a call that waits for it returns it. */
export interface RunResult {
  readonly agentId: string
  readonly outcome: RunOutcome
  readonly text: string
}

/** One of the Session's agents, as the index keeps it. */
interface AgentRecord {
  readonly agentId: string
  readonly description: string
  readonly model: string
  /** Running until pi has set where its last run ended, even if pi stopped meanwhile. */
  status: AgentStatus
  /** Whether the Hub knows it: one started outside a Turn never is. */
  readonly reported: boolean
}

interface Run {
  /** Whether pi started it: a prompt pi refused starts no run, and settles none. */
  started: boolean
  readonly settle: (aborted: boolean) => void
  /** A call waits for its result: it isn't delivered to the main loop. */
  waited: boolean
  /** The model stopped it, and its stop call returns the result: it isn't delivered either. */
  quiet: boolean
  /** pi is stopping: the run is Interrupted, and its end goes nowhere. */
  interrupted: boolean
  readonly ended: Promise<RunResult>
}

interface Agent {
  readonly record: AgentRecord
  readonly report: (event: Record<string, unknown>) => void
  readonly turns: Turns
  /** Its pi session, once opened: at its start, or when it is first resumed after pi started. */
  session: Promise<ChildSession> | undefined
  unsubscribe: () => void
  /** What the agent said last, from the last model request of its run. */
  last: { text: string; error: string | undefined }
  /** The run under way; undefined between runs. */
  run: Run | undefined
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

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const statuses: ReadonlySet<string> = new Set(["Running", "Done", "Stopped", "Interrupted"])

/** The index's agents, or none when there is no index yet, or it can't be read. */
const readIndex = (file: string): Array<AgentRecord> => {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"))
  } catch {
    return []
  }
  const agents = isRecord(parsed) && Array.isArray(parsed.agents) ? parsed.agents : []
  return agents.flatMap((agent: unknown) =>
    isRecord(agent) &&
    typeof agent.agentId === "string" &&
    /^[A-Za-z0-9_-]+$/.test(agent.agentId) &&
    typeof agent.description === "string" &&
    typeof agent.model === "string" &&
    typeof agent.status === "string" &&
    statuses.has(agent.status)
      ? [
          {
            agentId: agent.agentId,
            description: agent.description,
            model: agent.model,
            status: agent.status as AgentStatus,
            reported: agent.reported !== false,
          },
        ]
      : [],
  )
}

export class Subagents {
  private readonly agents = new Map<string, Agent>()

  constructor(private readonly options: SubagentsOptions) {}

  /** The file an agent's conversation is kept in. */
  file(agentId: string) {
    return join(this.options.dir, `${agentId}.jsonl`)
  }

  private get indexFile() {
    return join(this.options.dir, "index.json")
  }

  /**
   * Takes in the agents kept from before pi started (a wake, a restart). One that was running
   * then is Interrupted, and the main loop is told, with its next prompt, that it can resume it.
   * The Hub marks them Interrupted itself when pi stops, as it does Claude Code's.
   */
  load() {
    this.dispose()
    for (const record of readIndex(this.indexFile)) {
      if (record.status === "Running") {
        record.status = "Interrupted"
        this.options.note(agentNotification(record.agentId, record.description, "interrupted"))
      }
      this.adopt(record)
    }
    this.save()
  }

  /**
   * Starts an agent, which runs in the background: its result goes to the main loop when it
   * ends, unless the call waits for it (`wait`), when it is the call's.
   */
  async start(options: StartOptions): Promise<{ readonly agentId: string; result?: RunResult }> {
    if (options.signal?.aborted) throw new Error("The Turn was stopped before the agent started.")
    const agentId = this.options.newId()
    const opened = await this.options.open(this.file(agentId), options.model)
    if (options.signal?.aborted) {
      opened.session.dispose()
      throw new Error("The Turn was stopped before the agent started.")
    }
    const agent = this.adopt({
      agentId,
      description: options.description,
      model: opened.model,
      status: "Running",
      reported: options.turnId !== undefined,
    })
    this.attach(agent, opened.session)
    agent.report({
      _tag: "AgentStarted",
      turnId: options.turnId,
      agentId,
      toolCallId: options.toolCallId,
      agentType,
      description: options.description,
      model: opened.model,
      background: options.wait !== true,
    })
    const run = this.launch(agent, options.prompt, options.wait === true)
    if (options.wait !== true) return { agentId }
    return { agentId, result: await this.waitFor(agent, run, options.signal) }
  }

  /**
   * A message to an agent: read by a running one at its next step, or resuming one that has
   * ended, on its saved conversation. Says which; a resumed run's result goes to the main loop
   * when it ends, unless the caller waits for it (`wait`). Throws, saying why, when it can't.
   */
  async message(
    agentId: string,
    text: string,
    options: {
      readonly wait?: boolean | undefined
      readonly signal?: AbortSignal | undefined
    } = {},
  ): Promise<{ readonly steered: true } | { readonly steered: false; result?: RunResult }> {
    const agent = this.agents.get(agentId)
    if (agent === undefined) throw new Error(`This Session has no agent ${agentId}.`)
    const session = await this.sessionOf(agent)
    if (agent.run !== undefined || session.isStreaming) {
      await session.steer(text)
      return { steered: true }
    }
    const run = this.launch(agent, text, options.wait === true)
    if (options.wait !== true) return { steered: false }
    return { steered: false, result: await this.waitFor(agent, run, options.signal) }
  }

  /**
   * Stops a running agent, for the model (its stop tool): what the agent had said is the call's,
   * not delivered to the main loop. Throws, saying why, when it can't.
   */
  async stop(agentId: string): Promise<RunResult> {
    const agent = this.agents.get(agentId)
    if (agent === undefined) throw new Error(`This Session has no agent ${agentId}.`)
    const run = agent.run
    if (run === undefined) throw new Error("The agent isn't running.")
    run.quiet = true
    await (await this.sessionOf(agent)).abort()
    return run.ended
  }

  /** The Creator's message to an agent (DeliverAgentMessage), with their name. */
  async messageFromCreator(command: Command<"DeliverAgentMessage">) {
    const text = deliveredPrompt(command.sender, command.text, command.attachments ?? [])
    try {
      await this.message(command.agentId, text)
    } catch (error) {
      this.options.report({
        _tag: "AgentCommandFailed",
        agentId: command.agentId,
        command: "MessageAgent",
        senderId: command.sender.id,
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }

  /**
   * The Creator's stop (StopAgent), as Claude Code's TaskStop: the main loop is told how the run
   * ended, as of any run it didn't wait for.
   */
  stopFromCreator(command: Command<"StopAgent">) {
    const failed = (message: string) =>
      this.options.report({
        _tag: "AgentCommandFailed",
        agentId: command.agentId,
        command: "StopAgent",
        message,
      })
    const agent = this.agents.get(command.agentId)
    if (agent === undefined) return failed(`This Session has no agent ${command.agentId}.`)
    if (agent.run === undefined) return failed("The agent isn't running.")
    void this.sessionOf(agent)
      .then((session) => session.abort())
      .catch((error: unknown) => failed(String(error)))
  }

  /**
   * pi is stopping: its running agents are Interrupted, said to the Hub, and every session ends.
   * The index keeps them Running, so the next start tells the main loop they can be resumed.
   */
  dispose() {
    for (const agent of this.agents.values()) {
      agent.unsubscribe()
      const run = agent.run
      if (run !== undefined) {
        run.interrupted = true
        agent.report({
          _tag: "AgentStatusChanged",
          agentId: agent.record.agentId,
          status: "Interrupted",
        })
      }
      void agent.session?.then(
        (session) => {
          if (run !== undefined) void session.abort().catch(() => undefined)
          session.dispose()
        },
        () => undefined,
      )
    }
    this.agents.clear()
  }

  /** Takes an agent in, by its record, reporting its runs as the agent's. */
  private adopt(record: AgentRecord): Agent {
    const report = record.reported ? this.options.report : () => undefined
    const agent: Agent = {
      record,
      report,
      turns: new Turns({
        report,
        now: this.options.now,
        newId: this.options.newId,
        agentId: record.agentId,
        secrets: this.options.secrets,
      }),
      session: undefined,
      unsubscribe: () => undefined,
      last: { text: "", error: undefined },
      run: undefined,
    }
    this.agents.set(record.agentId, agent)
    return agent
  }

  /** The agent's pi session, opened from its file on its model the first time it is wanted. */
  private sessionOf(agent: Agent): Promise<ChildSession> {
    agent.session ??= this.options
      .open(this.file(agent.record.agentId), agent.record.model)
      .then(({ session }) => {
        if (this.agents.get(agent.record.agentId) !== agent) {
          session.dispose()
          throw new Error("pi's session ended.")
        }
        this.attach(agent, session)
        return session
      })
    // One that failed to open is tried again next time.
    agent.session.catch(() => {
      agent.session = undefined
    })
    return agent.session
  }

  /** Follows the agent's session: its runs' events are the agent's. */
  private attach(agent: Agent, session: ChildSession) {
    agent.session ??= Promise.resolve(session)
    const { turns } = agent
    agent.unsubscribe = session.subscribe((event: AgentSessionEvent) => {
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
    })
  }

  /**
   * Runs the agent with a prompt, from Running to Done or Stopped. Its result goes to the main
   * loop, unless a call waits for it, the model stopped it, or pi is stopping.
   */
  private launch(agent: Agent, text: string, waited: boolean): Run {
    const { promise: settled, resolve: settle } = Promise.withResolvers<boolean>()
    const { promise: ended, resolve: end } = Promise.withResolvers<RunResult>()
    const run: Run = { started: false, settle, waited, quiet: false, interrupted: false, ended }
    agent.run = run
    agent.last = { text: "", error: undefined }
    const { agentId } = agent.record
    this.setStatus(agent, "Running")
    void (async () => {
      let failure: string | undefined
      let stopped = false
      try {
        const session = await this.sessionOf(agent)
        await session.prompt(text, { expandPromptTemplates: false })
        stopped = run.started ? await settled : false
      } catch (error) {
        failure = error instanceof Error ? error.message : String(error)
      } finally {
        if (agent.run === run) agent.run = undefined
      }
      const result = this.result(agent, stopped, failure)
      end(result)
      if (run.interrupted) return
      this.setStatus(agent, stopped ? "Stopped" : "Done")
      if (run.waited || run.quiet) return
      this.options.deliver({
        agentId,
        text: agentNotification(agentId, agent.record.description, result.outcome, result.text),
      })
    })()
    return run
  }

  /** Waits for a run a call waits for: the Turn's stop stops it, as a foreground agent's. */
  private async waitFor(agent: Agent, run: Run, signal: AbortSignal | undefined) {
    const stop = () =>
      void this.sessionOf(agent)
        .then((session) => session.abort())
        .catch(() => undefined)
    signal?.addEventListener("abort", stop, { once: true })
    try {
      return await run.ended
    } finally {
      signal?.removeEventListener("abort", stop)
    }
  }

  private setStatus(agent: Agent, status: AgentStatus) {
    agent.record.status = status
    agent.report({ _tag: "AgentStatusChanged", agentId: agent.record.agentId, status })
    this.save()
  }

  /**
   * Writes the index in place of the last, with its agents as they are here, and those another
   * pi on the same directory keeps there, such as one a tool runs in the Session, left as they are.
   */
  private save() {
    const here = [...this.agents.values()].map((agent) => agent.record)
    const records = [
      ...readIndex(this.indexFile).filter((record) => !this.agents.has(record.agentId)),
      ...here,
    ]
    try {
      mkdirSync(this.options.dir, { recursive: true })
      const temporary = `${this.indexFile}.${process.pid}.tmp`
      writeFileSync(temporary, `${JSON.stringify({ agents: records }, null, 2)}\n`)
      renameSync(temporary, this.indexFile)
    } catch {
      // The agents run on; only a restart would forget them.
    }
  }

  /** How a run ended, and what the main loop, or the call, reads of it. */
  private result(agent: Agent, stopped: boolean, failure: string | undefined): RunResult {
    const { agentId } = agent.record
    const { text, error } = agent.last
    if (stopped)
      return {
        agentId,
        outcome: "stopped",
        text: `The agent was stopped before it finished.${text === "" ? "" : ` What it had said:\n${text}`}`,
      }
    if (failure !== undefined)
      return { agentId, outcome: "failed", text: `The agent's run failed: ${failure}` }
    if (text !== "") return { agentId, outcome: "completed", text }
    if (error !== undefined)
      return { agentId, outcome: "failed", text: `The agent's run failed: ${error}` }
    return { agentId, outcome: "completed", text: "The agent finished without a final answer." }
  }
}

/** What a call that doesn't wait says of a run under way. */
const comesLater =
  "Its result will come to you as a new message when it finishes: don't wait or poll for it. Carry on with other work meanwhile, or end your turn."

export interface AgentToolsDeps {
  readonly subagents: Subagents
  /** The main loop's running Turn. */
  readonly turnId: () => string | undefined
  /** The Creator's Models, as `<provider>/<id>`, which the model is told it may choose from. */
  readonly models: ReadonlyArray<string>
  /** Each call's context, through which a subagent runs the parent's tools (childTools). */
  readonly seen: (ctx: ExtensionToolContext) => void
}

const text = (said: string) => [{ type: "text" as const, text: said }]

/** The agent, message and stop tools, as pi registers them. */
export const agentToolDefinitions = ({ subagents, turnId, models, seen }: AgentToolsDeps) => {
  const agent: ToolDefinition<ReturnType<typeof agentParameters>, { agentId: string }> = {
    name: agentTool,
    label: "Agent",
    description: agentToolDescription,
    promptSnippet: "Start an agent to do a self-contained task in the background",
    parameters: agentParameters(models),
    // It runs other tools, in its own session: never from another tool, and never in a subagent.
    exposure: "model-only",
    execute: async (toolCallId, params, signal, _onUpdate, ctx) => {
      seen(ctx)
      const started = await subagents.start({
        turnId: turnId(),
        toolCallId,
        description: params.description,
        prompt: params.prompt,
        model: params.model,
        wait: params.wait,
        signal,
      })
      const { agentId } = started
      return {
        content: text(
          started.result?.text ?? `Started the agent ${agentId} in the background. ${comesLater}`,
        ),
        details: { agentId },
      }
    },
  }
  const message: ToolDefinition<typeof messageAgentParameters, { agentId: string }> = {
    name: messageAgentTool,
    label: "Message agent",
    description: messageAgentToolDescription,
    promptSnippet: "Message an agent you started, or resume one that has finished, by its id",
    parameters: messageAgentParameters,
    exposure: "model-only",
    execute: async (_toolCallId, params, signal, _onUpdate, ctx) => {
      seen(ctx)
      const { agentId } = params
      const sent = await subagents.message(agentId, params.message, { wait: params.wait, signal })
      const said = sent.steered
        ? `The agent ${agentId} is running: it reads your message at its next step. ${comesLater}`
        : (sent.result?.text ?? `Resumed the agent ${agentId} with your message. ${comesLater}`)
      return { content: text(said), details: { agentId } }
    },
  }
  const stop: ToolDefinition<typeof stopAgentParameters, { agentId: string }> = {
    name: stopAgentTool,
    label: "Stop agent",
    description: stopAgentToolDescription,
    promptSnippet: "Stop a running agent you started, by its id",
    parameters: stopAgentParameters,
    exposure: "model-only",
    execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
      seen(ctx)
      const result = await subagents.stop(params.agentId)
      return { content: text(result.text), details: { agentId: params.agentId } }
    },
  }
  return [agent, message, stop] as const
}
