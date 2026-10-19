// The Claude bridge against the real Claude, through the pinned Claude Code, under a real Pi
// Durable Harness: a run whose second tool call comes after the first's result, in one query held
// across the generation task's invocations; a run stopped while its tool runs; and a question after
// it, which the next query must answer from the session the stopped one left.
//
// It spends a few Haiku requests of a real subscription, so it runs only when asked:
//   KNDL_CLAUDE_IT=1 CLAUDE_CODE_OAUTH_TOKEN=… [KNDL_CLAUDE_CODE=…/claude] bun test durable/src/claude/Live.spec.ts

import { afterAll, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import { Type } from "@earendil-works/pi-ai"
import { createModels } from "@earendil-works/pi-ai/models"
import {
  createRegistry,
  defineExtension,
  defineTool,
  Harness,
  MemoryStorage,
} from "@earendil-works/pi-durable"
import { createClaudeBridgeProvider } from "./index.ts"
import { deferred, transcript } from "./testing/Durable.ts"

const context = BACKGROUND_CONTEXT
const claudeCode = process.env.KNDL_CLAUDE_CODE ?? "/opt/kndl/claude-code/2.1.296-glibc/claude"
const token = process.env.CLAUDE_CODE_OAUTH_TOKEN

const skip = (() => {
  if (process.env.KNDL_CLAUDE_IT !== "1") return "KNDL_CLAUDE_IT=1 isn't set"
  if (!token) return "there's no CLAUDE_CODE_OAUTH_TOKEN"
  if (!existsSync(claudeCode)) return `there's no Claude Code at ${claudeCode}`
  return undefined
})()
if (skip !== undefined && process.env.KNDL_CLAUDE_IT === "1")
  console.warn(`skipping the Claude bridge's live test: ${skip}`)

const word = "periwinkle"
const dir = mkdtempSync(join(tmpdir(), "kndl-claude-live-"))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe.skipIf(skip !== undefined)("the Claude bridge, live", () => {
  test("holds a query across tool calls, stops one, and goes on from it", async () => {
    const logPath = join(dir, "bridge.log")
    const provider = createClaudeBridgeProvider({
      claudeCodePath: claudeCode,
      // A state directory of its own, not the Session's Claude Code's.
      configDir: join(dir, "claude"),
      oauthToken: token ?? "",
      cwd: dir,
      models: [{ id: "claude-haiku-5-5" }],
      debug: true,
      logPath,
    })
    const shouted: Array<string> = []
    const started = deferred()
    const registry = createRegistry()
    registry.install(
      defineExtension({
        name: "live",
        tools: [
          defineTool({
            name: "secret",
            description: "Tells the secret word.",
            parameters: Type.Object({}),
            execute: async () => ({ output: [{ type: "text", text: `The word is ${word}.` }] }),
          }),
          defineTool({
            name: "shout",
            description: "Shouts a word.",
            parameters: Type.Object({ word: Type.String() }),
            execute: async (args) => {
              shouted.push(args.word)
              return { output: [{ type: "text", text: `${args.word.toUpperCase()}!` }] }
            },
          }),
          defineTool({
            name: "wait",
            description: "Waits for a long time.",
            parameters: Type.Object({}),
            execute: async (_args, _api, callContext) => {
              started.resolve()
              await new Promise((_resolve, reject) =>
                callContext.abortSignal?.addEventListener("abort", () =>
                  reject(new Error("stopped")),
                ),
              )
              return {}
            },
          }),
        ],
      }),
    )
    const models = createModels()
    models.setProvider(provider)
    const harness = await Harness.open(new MemoryStorage(), { models, registry }, context)
    try {
      const conversation = await harness.root(context, {
        agent: { model: { provider: "anthropic", modelId: "claude-haiku-5-5" } },
      })
      const ask = async (content: string) =>
        (await conversation.submit({ type: "input", content }, context)).wait(context)

      const first = await ask(
        "Call the secret tool. Then, as a separate step after its result, call the shout tool " +
          "with the word it told you. Then answer with that word, nothing else.",
      )
      expect(first.status).toBe("done")
      expect(shouted).toEqual([word])
      expect((await transcript(conversation)).at(-1)?.toLowerCase()).toContain(word)

      const stopped = await conversation.submit(
        { type: "input", content: "Call the wait tool." },
        context,
      )
      await started.promise
      await conversation.abort(context)
      expect((await stopped.wait(context)).status).toBe("unanswered")

      expect(
        (await ask("Never mind the waiting. What was the secret word? Just the word.")).status,
      ).toBe("done")
      expect((await transcript(conversation)).at(-1)?.toLowerCase()).toContain(word)

      const log = readFileSync(logPath, "utf8")
      // One query a run: the first's held across both its tool calls, the second's stopped by the
      // question's, which went on from its session.
      expect(log.match(/provider: query session=/g)).toHaveLength(3)
      expect(log).toContain("a tool result of a stopped run")
      expect(log).not.toContain("interrupted and resumed")
    } catch (error) {
      console.error(existsSync(logPath) ? readFileSync(logPath, "utf8").slice(-6000) : "")
      throw error
    } finally {
      await harness.close(context)
      await provider.close()
    }
  }, 180_000)
})
