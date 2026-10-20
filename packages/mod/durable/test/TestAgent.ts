// The durable agent under test: started as a Session starts it, over SQLite in a temporary
// directory (so a test can stop it and start it again on the same storage, as a restart does), a
// fake Hub over HTTP, and pi-ai's faux provider for its Models, scripted by what each request says.

import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Type } from "@earendil-works/pi-ai"
import type { AssistantMessage, Message, TranscriptContext } from "@earendil-works/pi-ai"
import { createModels } from "@earendil-works/pi-ai/models"
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux"
import { defineExtension, defineTool } from "@earendil-works/pi-durable"
import type { Extension, HarnessSettings } from "@earendil-works/pi-durable"
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node"
import type { ModAttachmentEncoded } from "@kndl/protocol"
import { startDurableAgent } from "../src/DurableAgent.ts"
import type { DurableAgent, DurableAgentOptions } from "../src/DurableAgent.ts"
import type { McpServerSpec } from "../src/Mcp.ts"
import { catalogOf, gatewayCatalog } from "../src/Providers.ts"
import { FakeHub } from "./FakeHub.ts"

export { fauxAssistantMessage, fauxText, fauxToolCall }

export const modToken = "tok-durable-test-1234"
export const sessionId = "s-durable"
export const ada = { id: "p1", login: "ada", name: "Ada Lovelace" }
export const bob = { id: "p2", login: "bob", name: "Bob" }

/** What the scripted model answers a request with, given what it says. */
export type Reply = (request: Request) => AssistantMessage | Promise<AssistantMessage>

/** A request to the scripted model, read for what tests route on. */
export interface Request {
  readonly context: TranscriptContext
  readonly model: string
  /** The last message that isn't a system prompt change. */
  readonly last: Message | undefined
  /** Its text. */
  readonly text: string
  /** Every system text of the request, sections included. */
  readonly system: string
}

export const textOf = (message: Message | undefined): string => {
  if (message === undefined) return ""
  if (message.role === "system") return ""
  const { content } = message
  if (typeof content === "string") return content
  return content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n")
}

const systemOf = (context: TranscriptContext) =>
  context.messages
    .flatMap((message) =>
      message.role === "system"
        ? [
            typeof message.content === "string" ? message.content : "",
            ...Object.values(message.sections ?? {}).filter((text) => text !== null),
          ]
        : [],
    )
    .join("\n")

/** What a request carries after its system messages, in order: each message's role and text. */
export const conversationOf = (request: Request | undefined) =>
  (request?.context.messages ?? [])
    .filter((message) => message.role !== "system")
    .map((message) => ({ role: message.role, text: textOf(message) }))

/** A call of `tool` with `args`. */
export const callTool = (tool: string, args: Parameters<typeof fauxToolCall>[1], id?: string) =>
  fauxAssistantMessage([fauxToolCall(tool, args, id === undefined ? undefined : { id })], {
    stopReason: "toolUse",
  })

/** An answer that says `text`. */
export const say = (text: string) => fauxAssistantMessage([fauxText(text)])

export interface TestAgentOptions {
  readonly model?: string
  readonly reply: Reply
  readonly settings?: HarnessSettings
  readonly extensions?: ReadonlyArray<Extension>
  readonly mcpServers?: ReadonlyArray<McpServerSpec>
  readonly codemode?: boolean
  readonly attachments?: Record<string, ModAttachmentEncoded>
  /** Streamed this fast, in tokens a second; at once without. */
  readonly tokensPerSecond?: number
  /** Runs on the Gateway's catalogue of the fake Hub's `/mod/providers`, not the faux models. */
  readonly gateway?: boolean
}

/** The Creator's Models, as the Hub lists them. */
export const listedModels = [
  "openai/gpt-test",
  "openai/gpt-other",
  "xai/grok-test",
  "openai/gpt-tiny",
]

export class TestAgent {
  readonly hub: FakeHub
  readonly dir: string
  agent: DurableAgent | undefined
  /** The model names the requests ran on, in order. */
  readonly requests: Array<Request> = []
  /** The Creator's Models the catalogue lists. */
  listed = [...listedModels]
  /** Models the Hub lists once asked again, as of a Provider connected after the agent started. */
  connectedLater: Array<string> = []
  /** How often the agent asked for the Creator's Models again. */
  refreshes = 0
  /** The provider session ids of the conversations whose runs settled, in order. */
  readonly settled: Array<string> = []

  constructor(private readonly options: TestAgentOptions) {
    this.hub = new FakeHub({
      modToken,
      providers: { models: [] },
      attachments: options.attachments ?? {},
    })
    this.dir = mkdtempSync(join(tmpdir(), "kndl-durable-"))
  }

  /** Starts the agent, on the storage the last start left, as a restart does. */
  async start(extra: Partial<DurableAgentOptions> = {}) {
    const providers = [
      fauxProvider({
        provider: "openai",
        models: [
          { id: "gpt-test", contextWindow: 200_000 },
          { id: "gpt-tiny", contextWindow: 3_000 },
          { id: "gpt-other" },
          { id: "gpt-later" },
        ],
        ...(this.options.tokensPerSecond === undefined
          ? {}
          : { tokensPerSecond: this.options.tokensPerSecond }),
      }),
      fauxProvider({ provider: "xai", models: [{ id: "grok-test" }] }),
    ]
    const models = createModels()
    for (const faux of providers) {
      models.setProvider(faux.provider)
      faux.setResponses(
        Array.from(
          { length: 500 },
          () =>
            async (
              context: TranscriptContext,
              _options: unknown,
              _state: unknown,
              model: { provider: string; id: string },
            ) => {
              const last = context.messages.findLast((message) => message.role !== "system")
              const request: Request = {
                context,
                model: `${model.provider}/${model.id}`,
                last,
                text: textOf(last),
                system: systemOf(context),
              }
              this.requests.push(request)
              return this.options.reply(request)
            },
        ),
      )
    }
    this.agent = await startDurableAgent({
      hubUrl: this.hub.url,
      modToken,
      sessionId,
      conversationId: "conv-1",
      model: this.options.model ?? "openai/gpt-test",
      cwd: this.dir,
      storage: await openNodeSqliteStorage(join(this.dir, "session.sqlite")),
      catalog:
        this.options.gateway === true
          ? (fetch) =>
              gatewayCatalog({
                hubUrl: this.hub.url,
                modToken,
                fetch,
                env: {},
                cwd: this.dir,
                log: () => {},
              })
          : async () =>
              catalogOf(
                models,
                () => this.listed,
                async () => {
                  this.refreshes++
                  this.listed = [...this.listed, ...this.connectedLater]
                  this.connectedLater = []
                  return true
                },
                undefined,
                (providerSession) => void this.settled.push(providerSession),
              ),
      log: (text) => {
        if (process.env.KNDL_TEST_LOG) console.log(text)
      },
      secrets: [modToken],
      codemode: this.options.codemode ?? false,
      images: false,
      flushDelayMs: 5,
      ...(this.options.settings === undefined ? {} : { settings: this.options.settings }),
      ...(this.options.mcpServers === undefined ? {} : { mcpServers: this.options.mcpServers }),
      ...(this.options.extensions === undefined ? {} : { extensions: this.options.extensions }),
      ...extra,
    })
    return this.agent
  }

  /** Stops the agent, as the Runner does with SIGTERM. */
  async stop() {
    await this.agent?.shutdown()
    this.agent = undefined
  }

  /** Stops everything and removes the storage. */
  async dispose() {
    await this.stop()
    this.hub.stop()
    rmSync(this.dir, { recursive: true, force: true })
  }

  /** Sends the agent a command, as the Hub's outbox does. */
  send(command: Record<string, unknown>) {
    this.hub.send({ sessionId, ...command })
  }

  /** The events of the Hub from the `from`th on, once one matches `check`. */
  until(
    check: (event: Record<string, unknown> & { _tag: string }) => boolean,
    from = 0,
    ms?: number,
  ) {
    return this.hub.eventsUntil(from, check, ms)
  }

  /** Waits for the event, and returns it. */
  async event(check: (event: Record<string, unknown> & { _tag: string }) => boolean, from = 0) {
    const events = await this.until(check, from)
    return events.at(-1) as Record<string, unknown> & { _tag: string }
  }
}

/** Waits until `check` holds, up to `ms`. */
export const eventually = async <T>(
  check: () => T | undefined | Promise<T | undefined>,
  ms = 10_000,
) => {
  const deadline = Date.now() + ms
  for (;;) {
    const value = await check()
    if (value !== undefined && value !== false) return value
    if (Date.now() > deadline) throw new Error("timed out")
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

/**
 * A tool that holds its call until the test lets it go, `hold`: so a Turn stays busy for as long
 * as a test needs. Replay-safe, so a call a restart cut off runs again.
 */
export const holdTool = () => {
  let released = false
  let release!: () => void
  let gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const calls: Array<string> = []
  let called!: () => void
  const firstCall = new Promise<void>((resolve) => {
    called = resolve
  })
  const extension = defineExtension({
    name: "test-hold",
    tools: [
      defineTool({
        name: "hold",
        description: "Waits.",
        parameters: Type.Object({ label: Type.Optional(Type.String()) }),
        replay: "safe",
        execute: async (args, api, context) => {
          calls.push(args.label ?? api.callId)
          called()
          if (!released)
            await new Promise<void>((resolve, reject) => {
              void gate.then(resolve)
              context.abortSignal?.addEventListener("abort", () => reject(new Error("aborted")), {
                once: true,
              })
            })
          return { output: [{ type: "text", text: `held ${args.label ?? ""}`.trim() }] }
        },
      }),
    ],
  })
  return {
    extension,
    calls,
    /** Resolves once a call has started. */
    firstCall,
    release: () => {
      released = true
      release()
    },
    /** Holds the next calls again. */
    rearm: () => {
      released = false
      gate = new Promise<void>((resolve) => {
        release = resolve
      })
    },
  }
}
