// The durable agent (docs/design/durable-harness.md): one Pi Durable Harness over the Session's
// storage, the extensions that make it kndl's, and the link to the Hub. `agent.ts` starts it from
// the Runner's environment; tests start it over memory storage and a scripted model.
//
// It opens the storage, installs its extensions, says hello, and resumes: a run that was going
// when the process stopped continues where it was, reported as a Turn `Resumed` (Loops.ts).

import { randomUUID } from "node:crypto"
import type { Context } from "@earendil-works/chord"
import { BACKGROUND_CONTEXT, withCancel } from "@earendil-works/chord/context"
import {
  createRegistry,
  defineExtension,
  Harness,
  hook,
  ToolTask,
} from "@earendil-works/pi-durable"
import type {
  Extension,
  HarnessSettings,
  SessionEnd,
  Storage,
  ToolExecutionResult,
} from "@earendil-works/pi-durable"
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node"
import { createToolSearchExtension } from "@earendil-works/pi-durable/tool-search"
import { createCodingTools } from "@earendil-works/pi-durable/tools"
import { ConversationId } from "@kndl/protocol"
import type { ThinkingLevel } from "@kndl/protocol"
import { Schema } from "effect"
import { HubLink } from "../../src/HubLink.ts"
import type { HubFetch, LinkStatus } from "../../src/HubLink.ts"
import { attachmentToolDefinition } from "./Attachments.ts"
import { Commands, conversationModel } from "./Commands.ts"
import { AgentsDoc, SessionDoc, ThreadsDoc } from "./Docs.ts"
import {
  handoffToolDefinition,
  searchHistoryToolDefinition,
  sessionHistoryToolDefinition,
} from "./History.ts"
import { Loops } from "./Loops.ts"
import { McpServers, mcpNamespaces } from "./Mcp.ts"
import type { McpServerSpec } from "./Mcp.ts"
import { planToolDefinition } from "./Plan.ts"
import type { Catalog } from "./Providers.ts"
import { Questions } from "./Questions.ts"
import type { Runtime } from "./Runtime.ts"
import { kndlSections } from "./Sections.ts"
import { agentsExtension } from "./Subagents.ts"
import { redact } from "./Turns.ts"

export interface DurableAgentOptions {
  readonly hubUrl: string
  readonly modToken: string
  readonly sessionId: string
  /** The conversation the Runner launched the agent as, kept as the Session's on first start. */
  readonly conversationId?: string | undefined
  /** The Session's model, `<provider>/<id>`, which the Hub keeps. */
  readonly model?: string | undefined
  readonly thinkingLevel?: ThinkingLevel | undefined
  readonly mcpServers?: ReadonlyArray<McpServerSpec>
  /** The Workspace, where tools run. */
  readonly cwd: string
  readonly storage: Storage
  /** The Models it runs on, given the Hub's fetch: the Gateway's in a Session. */
  readonly catalog: (fetch: HubFetch) => Promise<Catalog>
  readonly log: (text: string) => void
  /** What never leaves the agent: the mod token, the Claude token. */
  readonly secrets: ReadonlyArray<string>
  /** Code mode scripts, in a QuickJS sandbox; on by default. */
  readonly codemode?: boolean
  /** Images that `read` prepares, with Photon; on by default. */
  readonly images?: boolean
  /** Settings over the agent's own, as tests make compaction quick. */
  readonly settings?: HarnessSettings
  /** More extensions, installed after the agent's own: tests' tools. */
  readonly extensions?: ReadonlyArray<Extension>
  /** How long events wait to be batched for the Hub. */
  readonly flushDelayMs?: number
  readonly fetch?: typeof fetch
}

export interface DurableAgent {
  readonly harness: Harness
  readonly link: HubLink
  readonly loops: Loops
  /** The conversation the agent says hello with. */
  readonly conversationId: string
  /** Settles once the Harness has closed: `failed` when its storage failed. */
  readonly closed: Promise<SessionEnd>
  /** Shuts down cleanly: a run in progress stays in storage, and resumes at the next start. */
  shutdown(): Promise<void>
}

const isConversationId = Schema.is(ConversationId)

/**
 * A tool result without the agent's secrets, as a Provider or a command might say them back: the
 * model, the transcript and the Hub never read them.
 */
export const redactResult = (
  result: ToolExecutionResult,
  secrets: ReadonlyArray<string>,
): ToolExecutionResult | undefined => {
  if (secrets.length === 0) return undefined
  const said = JSON.stringify({ output: result.output, structuredOutput: result.structuredOutput })
  const clean = redact(said, secrets)
  if (clean === said) return undefined
  const parsed = JSON.parse(clean) as Pick<ToolExecutionResult, "output" | "structuredOutput">
  return {
    ...result,
    ...(parsed.output === undefined ? {} : { output: parsed.output }),
    ...(parsed.structuredOutput === undefined ? {} : { structuredOutput: parsed.structuredOutput }),
  }
}

/** The agent's run policy: tools at once, retries, and compaction in the background. */
export const agentSettings: HarnessSettings = {
  toolExecution: "parallel",
  retry: { enabled: true, maxRetries: 3 },
  compaction: { enabled: true, backgroundTokens: 32_768 },
}

/** Code mode's extension, when its sandbox loads here. */
const codemodeExtension = async (
  servers: ReadonlyArray<McpServerSpec>,
  log: (text: string) => void,
): Promise<Extension | undefined> => {
  try {
    const { CodemodeSandbox } = await import("@earendil-works/pi-codemode")
    const { createCodemodeExtension } = await import("@earendil-works/pi-durable/codemode")
    return createCodemodeExtension({
      sandbox: new CodemodeSandbox({ memoryLimitBytes: 256 * 1024 * 1024 }),
      namespaces: mcpNamespaces(servers),
    })
  } catch (error) {
    log(`kndl: code mode isn't available: ${error}`)
    return undefined
  }
}

/** `read`'s image processor, when Photon loads here. */
const imageProcessor = async (log: (text: string) => void) => {
  try {
    const { createNodePhotonImages } = await import("@earendil-works/pi-durable/images/node")
    return await createNodePhotonImages()
  } catch (error) {
    log(`kndl: images go to the model as they are: ${error}`)
    return undefined
  }
}

export const startDurableAgent = async (options: DurableAgentOptions): Promise<DurableAgent> => {
  const { log, secrets } = options
  const hubUrl = options.hubUrl.replace(/\/+$/, "")
  const lifetime = withCancel(BACKGROUND_CONTEXT)
  const context: Context = lifetime.context
  let closing = false

  // Every request to the Hub, so a shutdown cuts the long poll short; a tool's request is cut
  // short by its call's signal too, as when the Turn is stopped.
  const inFlight = new Set<AbortController>()
  const doFetch = options.fetch ?? fetch
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
      const response = await doFetch(url, {
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
  const hubGet = (path: string, signal?: AbortSignal) =>
    fetchHub(
      `${hubUrl}${path}`,
      { method: "GET", headers: { authorization: `Bearer ${options.modToken}` } },
      signal,
    )

  const catalog = await options.catalog(fetchHub)

  // The link and the Harness, once made: tools and reporters are made before either.
  const made: { link?: HubLink; harness?: Harness } = {}
  const report = (event: Record<string, unknown>) => made.link?.report(event)
  const openHarness = () => {
    if (made.harness === undefined) throw new Error("the Harness hasn't opened")
    return made.harness
  }
  const loops = new Loops({
    harness: openHarness,
    report,
    newId: randomUUID,
    now: () => performance.now(),
    secrets,
    log,
    context,
  })
  const runtime: Runtime = {
    harness: openHarness,
    loops,
    report,
    context,
    hubGet,
    catalog,
    newId: randomUUID,
    log,
    closing: () => closing,
  }

  // ── Extensions ──
  const servers = options.mcpServers ?? []
  const questions = new Questions(runtime)
  const questionsExtension = questions.extension()
  const registry = createRegistry()
  // Install order is section order: who kndl is first.
  registry.install(
    defineExtension({
      name: "kndl",
      sections: kndlSections(),
      tools: [
        attachmentToolDefinition(hubGet),
        searchHistoryToolDefinition(runtime),
        sessionHistoryToolDefinition(runtime),
        handoffToolDefinition(),
      ],
      hooks: [hook(ToolTask, { afterTool: (_call, result) => redactResult(result, secrets) })],
    }),
  )
  const images = options.images === false ? undefined : await imageProcessor(log)
  registry.install(createCodingTools(images === undefined ? {} : { images }))
  const codemode = options.codemode === false ? undefined : await codemodeExtension(servers, log)
  if (codemode !== undefined) registry.install(codemode)
  registry.install(createToolSearchExtension())
  registry.install(questionsExtension)
  const installAgents = () => {
    const extension = agentsExtension({
      runtime,
      withheld: () => [agents, questionsExtension],
    })
    registry.install(extension)
    return extension
  }
  let agents = installAgents()
  for (const extension of options.extensions ?? []) registry.install(extension)
  registry.install(defineExtension({ name: "kndl-plan", tools: [planToolDefinition(runtime)] }))
  const mcp = new McpServers(servers, { hubUrl, modToken: options.modToken, log })

  // ── The Harness ──
  const opened = await Harness.open(
    options.storage,
    {
      models: catalog.models,
      registry,
      settings: { ...agentSettings, ...options.settings },
      env: ({ cwd }) => new NodeExecutionEnv({ cwd: cwd ?? options.cwd }),
      onReport: (error) => log(`kndl: ${redact(String(error), secrets)}`),
    },
    context,
  )
  made.harness = opened

  // The root, on the Session's model: the Hub keeps it, so a stored one that differs gives way.
  const wanted = options.model === undefined ? undefined : await catalog.resolve(options.model)
  const model = wanted !== undefined && "model" in wanted ? wanted.model : undefined
  if (wanted !== undefined && "why" in wanted)
    log(`kndl: the Session's model ${options.model} isn't available: ${wanted.why}`)
  const root = await opened.root(context, {
    agent: {
      ...(model === undefined ? {} : { model }),
      ...(options.thinkingLevel === undefined ? {} : { thinkingLevel: options.thinkingLevel }),
    },
  })
  const stored = (await root.agent(context)).model
  if (
    model !== undefined &&
    (stored?.provider !== model.provider || stored.modelId !== model.modelId)
  )
    await root.configure(
      {
        model,
        ...(options.thinkingLevel === undefined ? {} : { thinkingLevel: options.thinkingLevel }),
      },
      context,
    )

  // The conversation the Session resumes: the Runner's, on its first start, and the same after.
  const conversationId = await opened.commit(async (tx) => {
    const doc = await tx.doc(SessionDoc)
    if (doc.conversationId === "")
      doc.conversationId =
        options.conversationId !== undefined && isConversationId(options.conversationId)
          ? options.conversationId
          : randomUUID()
    return doc.conversationId
  }, context)

  let sessionModel = (await conversationModel(runtime, root)) ?? options.model ?? "none"
  const commands = new Commands({
    runtime,
    questions,
    takesAlreadySubmitted: () => made.link?.takesAlreadySubmitted === true,
    threadWithheld: () => [questionsExtension],
    modelChanged: (name) => {
      sessionModel = name
    },
  })
  const link = new HubLink({
    hubUrl,
    modToken: options.modToken,
    hello: () => ({
      sessionId: options.sessionId,
      conversationId,
      model: sessionModel,
      switchesModels: true,
      durable: true,
    }),
    fetch: fetchHub,
    after: (ms, fn) => void setTimeout(fn, ms),
    onCommand: (command) => commands.run(command),
    onStatus: (status: LinkStatus) => {
      if (status._tag === "Rejected") log(`kndl: the Hub refused the link: ${status.reason}`)
    },
    log,
    ...(options.flushDelayMs === undefined ? {} : { flushDelayMs: options.flushDelayMs }),
  })
  made.link = link

  // Every conversation the Session has, followed before anything runs.
  await loops.attach(root.id, { kind: "main" }, true)
  const threads = (await opened.snapshot(ThreadsDoc, context))?.threads ?? {}
  for (const [threadId, thread] of Object.entries(threads))
    await loops.attach(thread.conversationId, { kind: "thread", threadId }, true)
  const known = (await opened.snapshot(AgentsDoc, context))?.agents ?? {}
  for (const [agentId, agent] of Object.entries(known))
    await loops.attach(
      agent.conversationId,
      { kind: "agent", agentId, reported: agent.reported },
      true,
    )

  link.start()
  await questions.reaskAsync()
  opened.resume()

  // The MCP servers connect meanwhile: their tools are deferred, found when the model searches.
  void mcp.extension().then((extension) => {
    if (!closing) registry.install(extension)
  })
  // The agent tool offers the Creator's Models as the catalogue has them now.
  const offered = () => catalog.names().join("\n")
  let offeredNow = offered()
  const refreshOffered = setInterval(() => {
    if (offered() === offeredNow) return
    offeredNow = offered()
    agents = installAgents()
  }, 5_000)
  refreshOffered.unref?.()

  const shutdown = async () => {
    if (closing) return
    closing = true
    clearInterval(refreshOffered)
    await opened.close(BACKGROUND_CONTEXT).catch((error: unknown) => log(`kndl: closing: ${error}`))
    await loops.stop()
    await link.drain().catch(() => undefined)
    link.stop()
    lifetime.cancel()
    for (const controller of inFlight) controller.abort()
    await mcp.close()
    await catalog.close().catch(() => undefined)
  }

  return {
    harness: opened,
    link,
    loops,
    conversationId,
    closed: opened.closed,
    shutdown,
  }
}
