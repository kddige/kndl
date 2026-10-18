// kndl's pi extension: the mod for a pi Session (ADR 0029, docs/design/pi-harness.md, "The pi
// extension"). A Runner starts pi with it (`-e /opt/kndl/mod/pi/kndl.js`), and it speaks the same
// mod protocol to the Hub as the Claude Code plugins do (HubLink), so the Hub and web barely know
// which Harness a Session has.
//
// - At load: asks the Hub for the Creator's Models and points pi's providers for them at the
//   Gateway (Providers.ts); Claude's go to the Claude bridge (`registerClaude`). Adds the
//   Session's MCP servers, at the Gateway too, and the Repo's Claude Code skills (RepoSetup.ts).
// - The Hub: says hello once pi's session is known, reports each pi run as a Turn (Turns.ts), and
//   runs the Hub's commands: prompts and steering (MainLoopDelivery.ts), stopping, switching the
//   model (ModelSwitch.ts), presence, and a context handoff after the Session switched to pi
//   (History.ts).
// - The model: the system prompt says the Session is shared, and a tool opens attachments; others
//   ask the people questions (Questions.ts), start, message and stop subagents, which run in the
//   background, kept on disk, and whose results start Turns of their own (Subagents.ts), and read
//   the Session's earlier Turns (History.ts).
// - The person at the terminal: a line above the editor shows the link and who watches.
//
// pi loads this bundle with its own copies of its packages (`@earendil-works/*` stay external);
// Effect and the protocol are bundled in (`bun run mod:build`).

import { randomUUID } from "node:crypto"
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { getAgentDir } from "@earendil-works/pi-coding-agent"
import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionToolContext,
} from "@earendil-works/pi-coding-agent"
import { providerModelName } from "@kndl/protocol"
import type { ModCommand, ModProviders } from "@kndl/protocol"
import { HubLink } from "../../src/HubLink.ts"
import type { HubFetch, LinkStatus } from "../../src/HubLink.ts"
import { attachmentContext, isRecord, sharedSessionNoteFor } from "../../src/HubMessages.ts"
import type { Command } from "../../src/HubMessages.ts"
import { attachmentTool, attachmentToolDefinition, pdfFileName } from "./Attachments.ts"
import { registerClaude } from "./claude/Claude.ts"
import { registerHistory } from "./History.ts"
import { MainLoopDelivery } from "./MainLoopDelivery.ts"
import { switchModel, throughKndl } from "./ModelSwitch.ts"
import { presenceLine, watching } from "./Presence.ts"
import { builtinCatalog, fetchProviders, gatewayProviders } from "./Providers.ts"
import { Questions, questionToolDefinition } from "./Questions.ts"
import { claudeSkills, installationServers, McpServersVariable } from "./RepoSetup.ts"
import {
  agentToolDefinitions,
  childModel,
  childModels,
  childTools,
  createChild,
  Subagents,
} from "./Subagents.ts"
import { modelName, Turns } from "./Turns.ts"

/** What the Runner tells the extension (the Runner's pi launch), or undefined outside a Session. */
interface KndlEnv {
  readonly hubUrl: string
  readonly modToken: string
  readonly sessionId: string
  /** The conversation the Runner launched pi on; absent from a Runner that doesn't say. */
  readonly conversationId: string | undefined
}

const readEnv = (env: NodeJS.ProcessEnv): KndlEnv | undefined => {
  const { KNDL_URL, KNDL_MOD_TOKEN, KNDL_SESSION_ID, KNDL_CONVERSATION_ID } = env
  if (!KNDL_URL || !KNDL_MOD_TOKEN || !KNDL_SESSION_ID) return undefined
  return {
    hubUrl: KNDL_URL.replace(/\/+$/, ""),
    modToken: KNDL_MOD_TOKEN,
    sessionId: KNDL_SESSION_ID,
    conversationId: KNDL_CONVERSATION_ID || undefined,
  }
}

/** The custom entry that records which prompts from the Hub pi was given (#323). */
const submittedEntry = "kndl-prompt"
/** The custom message a steered prompt is (ADR 0018). */
const steeredMessage = "kndl-steered"
/** The hidden custom message that tells the model to open a prompt's files (ADR 0024). */
const attachmentsMessage = "kndl-attachments"
/** The system prompt section that says the Session is shared. */
const sharedSection = "kndl_shared_session"
/** The custom message an agent's result is, which starts a Turn from the agent (ADR 0014). */
const agentMessage = "kndl-agent"
/** The custom message that tells the main loop, with its next prompt, of an interrupted agent. */
const agentNote = "kndl-agent-note"
/** The key of the line above the editor. */
const widgetKey = "kndl"

/** The Models the Hub lists, as `<provider>/<id>`. */
const modelNames = (listed: ModProviders) => listed.models.map(providerModelName)

/** The agent's result a custom message is, if it is one: what starts a Turn from the agent. */
const agentResult = (message: {
  readonly customType: string
  readonly content: unknown
  readonly details?: unknown
}) => {
  if (message.customType !== agentMessage || !isRecord(message.details)) return undefined
  const { agentId } = message.details
  if (typeof agentId !== "string" || typeof message.content !== "string") return undefined
  return { agentId, text: message.content }
}

/** The prompts from the Hub a session recorded as given to pi, or not (#323), oldest first. */
const submittedPrompts = (context: ExtensionContext) =>
  context.sessionManager.getEntries().flatMap((entry): Array<readonly [string, boolean]> => {
    if (entry.type !== "custom" || entry.customType !== submittedEntry || !isRecord(entry.data))
      return []
    const { promptId, submitted } = entry.data
    return typeof promptId === "string" ? [[promptId, submitted === true]] : []
  })

export default async function kndl(pi: ExtensionAPI) {
  const env = readEnv(process.env)
  // Not started by a Runner: pi runs as it would without kndl.
  if (env === undefined) return

  const agentDir = getAgentDir()
  const logFile = join(agentDir, "kndl.log")
  const log = (text: string) => {
    try {
      appendFileSync(logFile, `${new Date().toISOString()} ${text}\n`)
    } catch {
      // Nowhere to say it.
    }
  }

  // Every request to the Hub, so the session's end cuts the long poll short; a tool's request is
  // cut short by its call's signal too, as when the Turn is stopped.
  const inFlight = new Set<AbortController>()
  const fetchHub = async (
    url: string,
    init: Parameters<HubFetch>[1],
    signal?: AbortSignal,
  ): ReturnType<HubFetch> => {
    const controller = new AbortController()
    const abort = () => controller.abort(signal?.reason)
    if (signal?.aborted) abort()
    signal?.addEventListener("abort", abort, { once: true })
    inFlight.add(controller)
    try {
      const response = await fetch(url, {
        method: init.method,
        headers: init.headers,
        ...(init.body === undefined ? {} : { body: init.body }),
        signal: controller.signal,
      })
      return { status: response.status, text: await response.text() }
    } finally {
      signal?.removeEventListener("abort", abort)
      inFlight.delete(controller)
    }
  }
  /** GETs a path on the Hub, with the mod token, for a tool's call. */
  const getFromHub = (path: string, signal?: AbortSignal) =>
    fetchHub(
      `${env.hubUrl}${path}`,
      { method: "GET", headers: { authorization: `Bearer ${env.modToken}` } },
      signal,
    )

  const askForProviders = () =>
    fetchProviders({
      hubUrl: env.hubUrl,
      modToken: env.modToken,
      fetch: fetchHub,
      wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      log,
    })
  /**
   * Points pi's providers for the Creator's Models at the Gateway (Providers.ts). One the Hub no
   * longer lists stays registered, at the Gateway, which refuses it: taken back, pi's built-in one
   * would call the Provider itself.
   */
  const registerGateway = (listed: ModProviders) => {
    for (const provider of gatewayProviders(listed, {
      hubUrl: env.hubUrl,
      modToken: env.modToken,
      catalog: builtinCatalog,
    })) {
      pi.registerProvider(provider.name, provider.config)
      if (provider.missing.length > 0)
        log(`kndl: pi doesn't know ${provider.name}'s ${provider.missing.join(", ")}`)
    }
  }
  // pi waits for this before it picks the model the Runner named.
  let providers: ModProviders = (await askForProviders()) ?? { models: [] }
  registerGateway(providers)
  /** The Models a subagent may run on: the Creator's, as the Hub listed them last. */
  let agentModels = modelNames(providers)
  registerClaude(pi, providers.models, { log })

  // The Session's MCP servers, at the Gateway, and the Repo's Claude Code skills (RepoSetup.ts).
  for (const server of installationServers(process.env[McpServersVariable], env.hubUrl, log)) {
    try {
      pi.registerMcpServer(server.name, server.config)
    } catch (error) {
      log(`kndl: couldn't add the MCP server ${server.name}: ${error}`)
    }
  }
  pi.on("resources_discover", (event) => {
    const skills = claudeSkills(event.cwd)
    return skills === undefined ? undefined : { skillPaths: [skills] }
  })

  /** The session's context, from its start: commands from the Hub act through it. */
  let ctx: ExtensionContext | undefined
  let link: HubLink | undefined
  let status: LinkStatus = { _tag: "Linking" }
  let people: Array<string> = []

  const report = (event: Record<string, unknown>) => link?.report(event)
  // What a failed Turn's message must never say: a Provider may say back the key pi sent.
  const secrets = [env.modToken, process.env.CLAUDE_CODE_OAUTH_TOKEN ?? ""].filter(Boolean)
  const turns = new Turns({ report, now: () => performance.now(), newId: randomUUID, secrets })
  // Open questions and subagents (ADR 0014, #193): Questions.ts, Subagents.ts.
  const questions = new Questions({ report })
  /** The context of the last call of one of this extension's tools, which has the parent's tools. */
  let toolContext: ExtensionToolContext | undefined
  /** The parent's tools a subagent runs, as the last tool call's context has them, live. */
  const callableTools = () => {
    try {
      return toolContext?.tools
    } catch {
      // That context's session has ended.
      return undefined
    }
  }
  const subagents = new Subagents({
    report,
    now: () => performance.now(),
    newId: randomUUID,
    secrets,
    dir: join(agentDir, "kndl", "agents"),
    open: async (file, name) => {
      const current = ctx
      if (current === undefined) throw new Error("pi's session hasn't started.")
      const modelRuntime = await childModels(current.modelRegistry)
      const model = childModel(modelRuntime, name, current.model, agentModels)
      const session = await createChild({
        cwd: current.cwd,
        agentDir,
        file,
        modelRuntime,
        model,
        thinkingLevel: pi.getThinkingLevel(),
        ...childTools(pi.getActiveTools(), pi.getAllTools(), callableTools),
        settings: pi.getSettings(),
      })
      return { session, model: modelName(model) }
    },
    deliver: (result) => delivery.result(result),
    note: (text) =>
      pi.sendMessage(
        { customType: agentNote, content: text, display: true },
        { deliverAs: "nextTurn" },
      ),
    log,
  })
  // What the main loop is given from outside it: the Hub's prompts and the agents' results.
  const delivery = new MainLoopDelivery({
    turns,
    report,
    takesAlreadySubmitted: () => link?.takesAlreadySubmitted === true,
    resultTaken: (result) => subagents.resultTaken(result.agentId, result.text),
    every: (ms, fn) => {
      const timer = setInterval(fn, ms)
      return () => clearInterval(timer)
    },
    soon: (fn) => void setTimeout(fn, 0),
    log,
  })

  const drawLine = () => {
    try {
      if (ctx?.hasUI) ctx.ui.setWidget(widgetKey, [presenceLine(status, people)])
    } catch (error) {
      log(`kndl: couldn't draw the line: ${error}`)
    }
  }

  const currentModelName = () => {
    const model = ctx?.model
    if (model !== undefined) return modelName(model)
    const first = providers.models[0]
    return first === undefined ? "none" : providerModelName(first)
  }

  /** The agent, message and stop tools, the agent tool offering the Models the Hub listed last. */
  const registerAgentTools = () => {
    const [agentTool, messageAgentTool, stopAgentTool] = agentToolDefinitions({
      subagents,
      turnId: () => turns.turnId,
      models: agentModels,
      seen: (context) => {
        toolContext = context
      },
    })
    pi.registerTool(agentTool)
    pi.registerTool(messageAgentTool)
    pi.registerTool(stopAgentTool)
  }

  /**
   * Asks the Hub again for the Creator's Models, as for a Provider connected since pi started,
   * and gives pi those it lists; false when the Hub doesn't answer.
   */
  const refreshProviders = async () => {
    const listed = await askForProviders()
    if (listed === undefined) return false
    providers = listed
    registerGateway(listed)
    const names = modelNames(listed)
    if (names.join("\n") !== agentModels.join("\n")) {
      agentModels = names
      registerAgentTools()
    }
    return true
  }

  /**
   * Runs the Session's next Turns on a model and thinking level (ADR 0029). One it can't switch to
   * is said to the Hub, which keeps the Session on the model it runs on (ModelSwitch.ts). The
   * thinking level is set either way, as the Hub keeps it.
   */
  const switchToModel = async (command: Command<"SwitchModel">) => {
    const current = ctx
    if (current === undefined) return
    const registry = current.modelRegistry
    const switched = await switchModel(command.model, {
      providers: () => providers,
      find: (provider, id) => {
        const model = registry.find(provider, id)
        return model !== undefined && throughKndl(model, env.hubUrl) ? model : undefined
      },
      refresh: refreshProviders,
      setModel: (model) => pi.setModel(model),
    })
    if (switched._tag === "Failed") {
      const text = `couldn't switch to ${command.model ?? "the default model"}: ${switched.message}`
      log(`kndl: ${text}`)
      current.ui.notify(`kndl: ${text}`, "warning")
      report({
        _tag: "ModelSwitchFailed",
        ...(command.model === undefined ? {} : { asked: command.model }),
        model: currentModelName(),
        message: switched.message,
      })
    }
    pi.setThinkingLevel(command.thinkingLevel ?? pi.getSettings().defaultThinkingLevel ?? "medium")
  }

  const runCommand = async (command: ModCommand) => {
    switch (command._tag) {
      case "DeliverPrompt":
        delivery.prompt(command)
        return
      case "DeliverIntoTurn":
        delivery.steer(command)
        return
      case "StopTurn":
        if (turns.turnId !== undefined) ctx?.abort()
        return
      case "SwitchModel":
        await switchToModel(command)
        return
      case "PresenceChanged":
        people = watching(command.participants)
        drawLine()
        return
      case "DeliverAgentMessage":
        void subagents.messageFromCreator(command)
        return
      case "StopAgent":
        subagents.stopFromCreator(command)
        return
      case "DeliverAnswer":
        questions.answer(command)
        return
      case "DeliverHandoff":
        history.deliver(command)
        return
    }
  }

  const stopLink = async () => {
    const stopping = link
    link = undefined
    if (stopping === undefined) return
    await stopping.flushNow().catch(() => undefined)
    stopping.stop()
    for (const controller of inFlight) controller.abort()
  }

  // The attachment tool (ADR 0024), in the tool list from the first request on.
  pi.registerTool(
    attachmentToolDefinition({
      fetchPart: getFromHub,
      savePdf: async (id, name, data) => {
        const dir = join(tmpdir(), "kndl-attachments", id.replace(/[^A-Za-z0-9_-]/g, "_"))
        mkdirSync(dir, { recursive: true })
        const path = join(dir, pdfFileName(name))
        writeFileSync(path, Buffer.from(data, "base64"))
        return path
      },
    }),
  )

  // The history tool, and how a handoff is drawn (ADR 0030).
  const history = registerHistory(pi, { fetchHistory: getFromHub })

  // The question and agent tools (ADR 0029).
  pi.registerTool(questionToolDefinition({ questions, turnId: () => turns.turnId }))
  registerAgentTools()

  pi.on("session_start", async (event, context) => {
    await stopLink()
    ctx = context
    const conversationId = context.sessionManager.getSessionId()
    // A `pi` run inside the Session, by a tool or in a terminal, with this extension is another
    // conversation: linked, it would become the one the Session resumes when it wakes (#321). A
    // conversation the person at the terminal switches to in this pi is the Session's from now on.
    if (event.reason === "startup" && env.conversationId && env.conversationId !== conversationId) {
      log(`kndl: conversation ${conversationId} isn't the one the Runner launched, so not linked`)
      return
    }
    delivery.attach(
      {
        isIdle: () => context.isIdle(),
        cannotRun: () => {
          const model = context.model
          if (model === undefined) return "pi has no model to run the prompt on"
          return context.modelRegistry.hasConfiguredAuth(model)
            ? undefined
            : `pi has no credential for ${modelName(model)}`
        },
        prompt: (text) => pi.sendUserMessage(text),
        // pi starts the run at once.
        result: (result) =>
          pi.sendMessage(
            {
              customType: agentMessage,
              content: result.text,
              display: true,
              details: { agentId: result.agentId },
            },
            { triggerTurn: true },
          ),
        // A custom message: if the run ends first, pi keeps it for the next prompt, and starts no
        // run of its own with it.
        steer: (promptId, text) =>
          pi.sendMessage(
            { customType: steeredMessage, content: text, display: true, details: { promptId } },
            { deliverAs: "steer" },
          ),
        record: (promptId, submitted) => pi.appendEntry(submittedEntry, { promptId, submitted }),
      },
      submittedPrompts(context),
    )
    toolContext = undefined
    link = new HubLink({
      hubUrl: env.hubUrl,
      modToken: env.modToken,
      hello: () => ({
        sessionId: env.sessionId,
        conversationId,
        model: currentModelName(),
        switchesModels: true,
      }),
      fetch: fetchHub,
      after: (ms, fn) => void setTimeout(fn, ms),
      onCommand: runCommand,
      onStatus: (next) => {
        status = next
        drawLine()
      },
      log,
    })
    link.start()
    // The Session's agents, from its volume: those pi's stopping interrupted are said to the model,
    // and the results it hadn't taken given it again, as Turns the link reports.
    subagents.load()
  })

  pi.on("session_shutdown", async () => {
    // Running agents are Interrupted, said to the Hub before the link stops.
    subagents.dispose()
    delivery.detach()
    await stopLink()
    ctx = undefined
  })

  pi.on("input", (event) => {
    turns.input(event.text, event.source)
  })

  pi.on("before_agent_start", (event) => {
    event.systemPromptOptions.sections[sharedSection] = sharedSessionNoteFor(attachmentTool)
    const from =
      event.messageType === "user"
        ? turns.beforeAgentStart(event.prompt)
        : turns.beforeAgentStart(undefined, agentResult(event.message))
    const attachments = from?.attachments ?? []
    // What the model is told of a prompt's files, out of sight: to open each before answering.
    if (attachments.length === 0) return
    return {
      message: {
        customType: attachmentsMessage,
        content: attachmentContext(attachments, attachmentTool),
        display: false,
      },
    }
  })

  pi.on("agent_start", () => delivery.started(turns.agentStart()))

  pi.on("message_start", (event) => {
    const message = event.message
    if (message.role !== "custom" || message.customType !== steeredMessage) return
    const promptId = isRecord(message.details) ? message.details.promptId : undefined
    if (typeof promptId === "string") turns.steeredMessageStarted(promptId)
  })

  pi.on("message_update", (event) => {
    if (event.assistantMessageEvent.type === "text_delta")
      turns.textDelta(event.assistantMessageEvent.delta)
  })

  pi.on("message_end", (event) => {
    if (event.message.role === "assistant") turns.assistantEnded(event.message)
  })

  pi.on("tool_execution_start", (event) =>
    turns.toolStarted(event.toolCallId, event.toolName, event.args, event.parentToolCallId),
  )

  pi.on("tool_execution_end", (event) =>
    turns.toolEnded(
      event.toolCallId,
      event.toolName,
      event.result,
      event.isError,
      event.parentToolCallId,
    ),
  )

  pi.on("agent_settled", (event) => {
    turns.settled(event.aborted)
    // An agent's result, or a prompt, that waited for this run goes once pi has settled.
    delivery.settled()
  })
}
