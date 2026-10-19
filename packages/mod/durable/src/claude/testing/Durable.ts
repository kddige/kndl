// A real Pi Durable Harness on the Claude bridge, for the bridge's tests: the bridge's provider set
// on the Harness's Models, Claude Code's query replaced by a FakeClaudeCode that keeps its session
// files in a temporary state directory, and a few tools whose calls a test holds open or ends.

import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import { fauxProvider, Type } from "@earendil-works/pi-ai"
import type {
  Api,
  AssistantMessageEventStream,
  FauxProviderHandle,
  Model,
  SimpleStreamOptions,
} from "@earendil-works/pi-ai"
import { createModels } from "@earendil-works/pi-ai/models"
import {
  createRegistry,
  defineExtension,
  defineTool,
  Harness,
  MemoryStorage,
  section,
} from "@earendil-works/pi-durable"
import type { Conversation, Extension, HarnessSettings, Storage } from "@earendil-works/pi-durable"
import { openNodeJsonlStorage } from "@earendil-works/pi-durable/storage/jsonl/node"
import { createClaudeBridgeProvider } from "../index.ts"
import type { ClaudeBridgeOptions, ClaudeBridgeProvider } from "../index.ts"
import { FakeClaudeCode } from "./FakeClaudeCode.ts"
import type { FakeClaudeCodeOptions } from "./FakeClaudeCode.ts"

export const context = BACKGROUND_CONTEXT

export const HaikuId = "claude-haiku-5-5"

/** The Model a conversation runs on: Claude Haiku, through the bridge. */
export const haiku = { provider: "anthropic", modelId: HaikuId } as const

/** Another Provider's Model, pi-ai's faux one, which answers as the test sets it to. */
export const other = { provider: "other", modelId: "other-model" } as const

/** A promise and what settles it. */
export interface Deferred<T = void> {
  readonly promise: Promise<T>
  readonly resolve: (value: T) => void
}

export function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

/** A tool whose calls run until the test opens its gate, or the call is aborted. */
export interface Gate {
  /** Settles when a call starts. */
  readonly started: Promise<void>
  /** Lets every call waiting end, with `answer`. */
  readonly open: (answer?: string) => void
}

/** What the system prompt carries: the test's section. */
export const SectionText = "Answer in the voice of a lighthouse keeper."

/** One provider call, as the bridge got it. */
export interface ProviderCall {
  readonly options: SimpleStreamOptions | undefined
  readonly roles: ReadonlyArray<string>
}

export interface DurableBridge {
  readonly dir: string
  readonly claudeDir: string
  readonly fake: FakeClaudeCode
  /** The other Provider, on the Harness's Models beside the bridge. */
  readonly faux: FauxProviderHandle
  provider: ClaudeBridgeProvider
  harness: Harness
  /** The root conversation, on Claude Haiku. */
  conversation: Conversation
  /** Every call into the provider, in order. */
  readonly calls: Array<ProviderCall>
  /** The `gate` tool's, renewed each time a call starts. */
  gate: Gate
  /** Closes the Harness and the bridge, and opens both again over the same storage. */
  readonly reopen: () => Promise<void>
  /** Closes the Harness and the bridge, and deletes the directory. */
  readonly dispose: () => Promise<void>
}

/** The answer each tool gives, and the gate's. */
export const Echoed = "echoed"

const text = (value: string) => [{ type: "text" as const, text: value }]

/**
 * A Harness over `storage` (memory, or JSONL in the test's directory, which survives reopen()),
 * with the tools `echo` (answers at once), `gate` (waits for the test, or an abort), `finish`
 * (ends the run, asking for no further request), `load` (loads the deferred `later`), and a
 * section, on the bridge's provider with a fake Claude Code.
 */
export async function startDurable(
  options: {
    readonly storage?: "memory" | "jsonl"
    readonly fake?: FakeClaudeCodeOptions
    readonly settings?: HarnessSettings
    readonly bridge?: Partial<ClaudeBridgeOptions>
  } = {},
): Promise<DurableBridge> {
  const dir = mkdtempSync(join(tmpdir(), "kndl-claude-durable-"))
  const claudeDir = join(dir, "claude")
  const fake = new FakeClaudeCode({ claudeDir, ...options.fake })
  const calls: Array<ProviderCall> = []
  const faux = fauxProvider({ provider: other.provider, models: [{ id: other.modelId }] })

  let gateWaiters: Array<(answer: string) => void> = []
  let started = deferred()
  const gate: Gate = {
    get started() {
      return started.promise
    },
    open: (answer = Echoed) => {
      for (const waiter of gateWaiters.splice(0)) waiter(answer)
    },
  }
  const Tools: Extension = defineExtension({
    name: "test-tools",
    tools: [
      defineTool({
        name: "echo",
        description: "Answers at once.",
        parameters: Type.Object({}),
        execute: async () => ({ output: text(Echoed) }),
      }),
      defineTool({
        name: "gate",
        description: "Waits for the test.",
        parameters: Type.Object({}),
        execute: async (_args, _api, callContext) => {
          const answer = new Promise<string>((resolve, reject) => {
            gateWaiters.push(resolve)
            callContext.abortSignal?.addEventListener("abort", () => reject(new Error("stopped")))
          })
          started.resolve()
          started = deferred()
          return { output: text(await answer) }
        },
      }),
      defineTool({
        name: "finish",
        description: "Ends the run.",
        parameters: Type.Object({}),
        execute: async () => ({ output: text("finished"), control: { terminate: true } }),
      }),
      defineTool({
        name: "load",
        description: "Loads the tool later.",
        parameters: Type.Object({}),
        execute: async () => ({ output: text("loaded"), control: { addTools: ["later"] } }),
      }),
      defineTool({
        name: "later",
        description: "Loaded by load.",
        parameters: Type.Object({}),
        deferred: true,
        execute: async () => ({ output: text("later") }),
      }),
    ],
    sections: [section("voice", () => SectionText)],
  })
  const registry = createRegistry()
  registry.install(Tools)

  const makeProvider = () =>
    createClaudeBridgeProvider({
      claudeCodePath: "/opt/kndl/claude-code/claude",
      configDir: claudeDir,
      oauthToken: "sk-ant-oat-test",
      cwd: dir,
      models: [{ id: HaikuId }],
      query: fake.query,
      env: { PATH: process.env.PATH },
      report: () => {},
      ...options.bridge,
    })
  const openStorage = async (): Promise<Storage> =>
    options.storage === "jsonl"
      ? await openNodeJsonlStorage(join(dir, "durable"), context)
      : new MemoryStorage()
  const openHarness = async (provider: ClaudeBridgeProvider) => {
    const models = createModels()
    models.setProvider(faux.provider)
    // Every call recorded, as the bridge gets it.
    models.setProvider({
      ...provider,
      streamSimple: (
        model: Model<Api>,
        request: Parameters<typeof provider.streamSimple>[1],
        streamOptions?: SimpleStreamOptions,
      ): AssistantMessageEventStream => {
        calls.push({
          options: streamOptions,
          roles: request.messages.map((message) => message.role),
        })
        return provider.streamSimple(model, request, streamOptions)
      },
    })
    return Harness.open(
      await openStorage(),
      { models, registry, ...(options.settings ? { settings: options.settings } : {}) },
      context,
    )
  }

  const provider = makeProvider()
  const harness = await openHarness(provider)
  const env: DurableBridge = {
    dir,
    claudeDir,
    fake,
    faux,
    provider,
    harness,
    conversation: await harness.root(context, { agent: { model: haiku } }),
    calls,
    gate,
    reopen: async () => {
      gateWaiters = []
      await env.harness.close(context)
      await env.provider.close()
      env.provider = makeProvider()
      env.harness = await openHarness(env.provider)
      env.conversation = await env.harness.root(context)
    },
    dispose: async () => {
      await env.harness.close(context)
      await env.provider.close()
      rmSync(dir, { recursive: true, force: true })
    },
  }
  return env
}

/** The conversation's messages, one line each: `role:text`, a tool call as `call:<name>`. */
export async function transcript(conversation: Conversation): Promise<Array<string>> {
  const view = await conversation.context(context)
  return view.messages
    .filter((message) => message.role !== "system")
    .map((message) => {
      const content = message.content as string | ReadonlyArray<Record<string, unknown>>
      const blocks = typeof content === "string" ? [{ type: "text", text: content }] : content
      return `${message.role}:${blocks
        .map((block) =>
          block.type === "text"
            ? String(block.text)
            : block.type === "toolCall"
              ? `call:${String(block.name)}`
              : `[${String(block.type)}]`,
        )
        .join("")}`
    })
}

/** Submits `prompt` to `conversation` and waits for it to settle. */
export async function ask(conversation: Conversation, prompt: string) {
  const submission = await conversation.submit({ type: "input", content: prompt }, context)
  return submission.wait(context)
}
