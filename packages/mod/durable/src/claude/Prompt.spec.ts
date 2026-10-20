// A call's transcript read back as the conversation, its system prompt and its tools, which Claude
// Code gets appended to its own preset; and the guard against sending pi's harness text, which
// Anthropic's subscription gate reads as a third-party app.
//
// Ported in part from pi-claude-bridge 0.9.3's tests (MIT, Copyright (c) 2026 Eli Dickinson): see
// THIRD_PARTY_NOTICES.md.

import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { getCurrentSystemPrompt } from "@earendil-works/pi-ai"
import type { Message, SystemMessage, Tool, TranscriptContext } from "@earendil-works/pi-ai"
import { assertSendablePrompt, PiPreamble, toBridgeContext } from "./Prompt.ts"
import { makeBridge } from "./testing/BridgeTesting.ts"
import { testModel } from "./testing/StreamHarness.ts"

const system = (overrides: Partial<SystemMessage>): SystemMessage => ({
  role: "system",
  content: "",
  timestamp: 0,
  ...overrides,
})

const user = (text: string): Message => ({
  role: "user",
  content: [{ type: "text", text }],
  timestamp: 0,
})

const tool = (name: string) => ({ name, description: name, parameters: {} }) as unknown as Tool

const thrown = (run: () => void): Error => {
  try {
    run()
  } catch (error) {
    return error as Error
  }
  throw new Error("didn't throw")
}

describe("toBridgeContext", () => {
  // Pi Durable writes a system message only where the prompt or the tools changed.
  const messages: Array<Message> = [
    system({ sections: { preamble: "P", cwd: "<cwd>/w</cwd>" }, toolsAdded: [tool("read")] }),
    user("one"),
    system({ sections: { plan: "<plan>step</plan>" }, toolsAdded: [tool("later")] }),
    user("two"),
    system({ sections: { plan: null }, toolsRemoved: [{ name: "read" }] }),
    user("three"),
  ]

  test("takes the system messages out of the conversation", () => {
    expect(toBridgeContext(messages).messages).toEqual([user("one"), user("two"), user("three")])
  })

  test("is the prompt as it stands, replayed as pi-ai renders it", () => {
    const { systemPrompt } = toBridgeContext(messages)
    expect(systemPrompt).toBe(getCurrentSystemPrompt(messages))
    expect(systemPrompt).toContain("P")
    expect(systemPrompt).toContain("<cwd>/w</cwd>")
    expect(systemPrompt).not.toContain("<plan>")
    expect(toBridgeContext(messages.slice(0, 4)).systemPrompt).toContain("<plan>step</plan>")
  })

  test("serves the tools as they stand", () => {
    expect(toBridgeContext(messages).tools?.map((each) => each.name)).toEqual(["later"])
    expect(toBridgeContext(messages.slice(0, 2)).tools?.map((each) => each.name)).toEqual(["read"])
  })

  test("leaves out a prompt and tools there are none of", () => {
    expect(toBridgeContext([user("one")])).toEqual({ messages: [user("one")] })
  })
})

describe("the guard against sending pi's harness", () => {
  test("refuses pi's preamble at a line's start", () => {
    const error = thrown(() =>
      assertSendablePrompt(`<voice>\nquiet\n</voice>\n${PiPreamble}, a coding agent harness.`),
    )
    expect(error.message).toContain(PiPreamble)
    expect(error.message).toMatch(/offset \d+ of \d+ chars/)
    expect(error.message).toMatch(/AGENTS\.md or CLAUDE\.md/)
    expect(error.message).not.toContain("KNDL_CLAUDE_DEBUG")
  })

  test("lets a mention of pi's preamble mid-line through", () => {
    expect(() => assertSendablePrompt(`note: ${PiPreamble}, allegedly`)).not.toThrow()
  })

  test("refuses the trigger pair, and lets either path alone through", () => {
    expect(() => assertSendablePrompt("see docs/custom-provider.md and docs/packages.md")).toThrow(
      /docs\/custom-provider\.md and docs\/packages\.md/,
    )
    for (const path of ["docs/custom-provider.md", "docs/packages.md"])
      expect(() => assertSendablePrompt(`see ${path}`)).not.toThrow()
  })

  test("lets no prompt through", () => {
    expect(() => assertSendablePrompt(undefined)).not.toThrow()
  })
})

describe("a turn whose prompt the guard refuses", () => {
  let dir: string | undefined
  afterEach(() => {
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true })
  })

  test("fails on its stream, and starts no query", async () => {
    dir = mkdtempSync(join(tmpdir(), "kndl-claude-refused-"))
    let queries = 0
    const bridge = makeBridge({
      claudeDir: dir,
      query: () => {
        queries++
        throw new Error("no query expected")
      },
    })
    const message = await bridge
      .streamSimple(
        testModel(),
        { messages: [system({ content: `${PiPreamble}.` }), user("go")] } as TranscriptContext,
        { sessionId: "refused" },
      )
      .result()
    expect(message.stopReason).toBe("error")
    expect(message.errorMessage).toContain("refusing to send this system prompt")
    expect(queries).toBe(0)
    await bridge.close()
  })
})
