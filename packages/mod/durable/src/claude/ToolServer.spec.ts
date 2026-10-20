// What the bridge puts on the MCP wire: tool schemas as pi declares them, below the top level too,
// and each tool call paired with Claude's own tool_use id. Driven as the Agent SDK drives the
// server (`instance.connect()` with a transport, then raw JSON-RPC), so these cover what Claude
// receives.
//
// Ported from pi-claude-bridge 0.9.3's unit-mcp-server tests (MIT, Copyright (c) 2026 Eli
// Dickinson): see THIRD_PARTY_NOTICES.md.

import { beforeAll, describe, expect, test } from "bun:test"
import type { McpResult } from "./ToolResults.ts"
import { createToolServer } from "./ToolServer.ts"
import type { McpToolDef } from "./ToolServer.ts"

type Json = Record<string, unknown>

interface Listed {
  readonly name: string
  readonly description: string
  readonly inputSchema: Json
}

interface Reply {
  readonly result?: Json & { readonly tools?: ReadonlyArray<Listed> }
  readonly error?: { readonly message?: string }
}

const NestedToolSchema = {
  type: "object",
  properties: {
    question: { type: "string", description: "Question to ask" },
    options: {
      type: "array",
      description: "Choices to offer",
      items: {
        type: "object",
        properties: {
          label: { type: "string", description: "Short label" },
          detail: { type: "string" },
        },
        required: ["label"],
      },
    },
    config: {
      type: "object",
      properties: {
        mode: { type: "string", enum: ["single", "multi"] },
        retries: { type: "integer" },
      },
      required: ["mode"],
    },
    either: { anyOf: [{ type: "string" }, { type: "number" }] },
  },
  required: ["question", "options"],
}

/** Connects as the SDK's connectSdkMcpServer does. */
async function connectClient(server: ReturnType<typeof createToolServer>) {
  const pending = new Map<number, (reply: Reply) => void>()
  const transport: {
    start: () => Promise<void>
    close: () => Promise<void>
    send: (msg: { id?: number } & Reply) => Promise<void>
    onmessage?: (msg: unknown) => void
  } = {
    start: async () => {},
    close: async () => {},
    send: async (msg) => {
      if (msg.id !== undefined) pending.get(msg.id)?.(msg)
    },
  }
  await server.instance.connect(transport as never)
  let nextId = 0
  const request = (method: string, params: unknown) =>
    new Promise<Reply>((resolve) => {
      const id = ++nextId
      pending.set(id, resolve)
      transport.onmessage?.({ jsonrpc: "2.0", id, method, params })
    })
  // Claude Code names the call it makes in _meta, on every tools/call.
  const callTool = (name: string, toolUseId: string | null, args: Json = {}) =>
    request("tools/call", {
      name,
      arguments: args,
      ...(toolUseId ? { _meta: { "claudecode/toolUseId": toolUseId } } : {}),
    })
  await request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "test", version: "1.0.0" },
  })
  transport.onmessage?.({ jsonrpc: "2.0", method: "notifications/initialized" })
  return { request, callTool }
}

const tool = (
  name: string,
  inputSchema: unknown,
  handler: (toolCallId: string) => Promise<McpResult> = async () => ({ content: [] }),
  description = name,
): McpToolDef => ({ name, description, inputSchema, handler })

const listedTool = async (request: (method: string, params: unknown) => Promise<Reply>) => {
  const listed = (await request("tools/list", {})).result?.tools?.[0]
  if (listed === undefined) throw new Error("no tool listed")
  return listed
}

const resultText = (reply: Reply) =>
  (reply.result?.content as ReadonlyArray<{ readonly text?: string }> | undefined)?.[0]?.text

describe("the tool schemas advertised", () => {
  let listed: Json

  beforeAll(async () => {
    const server = createToolServer("custom-tools", [
      tool("ask_user_question", NestedToolSchema, async () => ({
        content: [{ type: "text", text: "ok" }],
      })),
    ])
    const { request } = await connectClient(server)
    listed = (await listedTool(request)).inputSchema
  })

  // A non-object schema typechecks (pi takes any TypeBox schema) but can't go on the wire.
  test("refuses a parameter schema that isn't an object, naming the tool", () => {
    expect(() => createToolServer("custom-tools", [tool("bad_tool", { type: "string" })])).toThrow(
      /bad_tool: MCP tool parameters must be an object schema/,
    )
  })

  test("keep the top-level properties and required", () => {
    const properties = listed.properties as Json
    expect(Object.keys(properties).toSorted()).toEqual(["config", "either", "options", "question"])
    expect(listed.required).toEqual(["question", "options"])
    expect((properties.question as Json).description).toBe("Question to ask")
  })

  test("keep an object's properties nested in an array", () => {
    const item = ((listed.properties as Json).options as Json).items as Json
    expect(Object.keys(item.properties as Json).toSorted()).toEqual(["detail", "label"])
    expect(item.required).toEqual(["label"])
  })

  test("keep nested objects' properties, enums and required", () => {
    const config = (listed.properties as Json).config as Json
    const properties = config.properties as Json
    expect(Object.keys(properties).toSorted()).toEqual(["mode", "retries"])
    expect(config.required).toEqual(["mode"])
    expect((properties.mode as Json).enum).toEqual(["single", "multi"])
    expect((properties.retries as Json).type).toBe("integer")
  })

  test("keep anyOf branches", () => {
    expect(((listed.properties as Json).either as Json).anyOf).toEqual([
      { type: "string" },
      { type: "number" },
    ])
  })
})

async function listTool(inputSchema: Json) {
  const server = createToolServer("custom-tools", [tool("union_tool", inputSchema, undefined, "d")])
  const { request } = await connectClient(server)
  return listedTool(request)
}

// Claude Code drops a tool whose schema has a top-level anyOf/oneOf/allOf, while a call to it
// still reached pi: the tool ran twice, or the retry's handler waited forever.
describe("a tool schema with a top-level combinator", () => {
  test("is flattened into one object schema Claude Code takes", async () => {
    const { description, inputSchema: listed } = await listTool({
      type: "object",
      additionalProperties: false,
      required: ["operation"],
      properties: {
        operation: { type: "string", enum: ["start", "status"] },
        input: { type: "string" },
      },
      anyOf: [
        {
          type: "object",
          properties: {
            operation: { type: "string", enum: ["start"] },
            baseRef: { type: "string" },
          },
        },
        {
          type: "object",
          properties: { operation: { type: "string", enum: ["status"] } },
          required: ["input"],
        },
      ],
    })

    for (const key of ["anyOf", "oneOf", "allOf"]) expect(key in listed).toBe(false)
    expect(listed.type).toBe("object")
    expect(listed.additionalProperties).toBe(false)
    const properties = listed.properties as Json
    expect(Object.keys(properties).toSorted()).toEqual(["baseRef", "input", "operation"])
    // The root's declaration wins over a branch's.
    expect((properties.operation as Json).enum).toEqual(["start", "status"])
    // A branch's requirement isn't everyone's.
    expect(listed.required).toEqual(["operation"])
    expect(description).toBe(
      "Input constraint: Provide parameters for at least one of: (operation, baseRef) or (input).\n\nd",
    )
  })

  test("keeps allOf's requirements, which hold for every call", async () => {
    const { description, inputSchema: listed } = await listTool({
      type: "object",
      properties: { a: { type: "string" } },
      required: ["a"],
      allOf: [{ type: "object", properties: { b: { type: "number" } }, required: ["b"] }],
    })

    expect("allOf" in listed).toBe(false)
    expect(Object.keys(listed.properties as Json).toSorted()).toEqual(["a", "b"])
    expect(listed.required).toEqual(["a", "b"])
    expect(description.startsWith("Input constraint: all listed parameters apply together")).toBe(
      true,
    )
  })

  test("follows a oneOf's $defs refs and names each group in the description", async () => {
    const { description, inputSchema: listed } = await listTool({
      type: "object",
      $defs: {
        byId: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
        byName: {
          type: "object",
          properties: { name: { type: "string" }, scope: { type: "string" } },
          required: ["name"],
        },
      },
      oneOf: [{ $ref: "#/$defs/byId" }, { $ref: "#/$defs/byName" }],
    })

    expect("oneOf" in listed).toBe(false)
    expect(Object.keys(listed.properties as Json).toSorted()).toEqual(["id", "name", "scope"])
    expect("required" in listed).toBe(false)
    expect(description).toBe(
      "Input constraint: Provide parameters for exactly one of: (id) or (name).\n\nd",
    )
  })

  test("leaves the description alone without one", async () => {
    const { description } = await listTool({
      type: "object",
      properties: { a: { type: "string" } },
    })
    expect(description).toBe("d")
  })
})

// Two tools, so a handler picked by position rather than by name shows.
const twoTools = (record: Array<[string, string]>) => [
  tool("alpha", { type: "object", properties: {} }, async (toolCallId) => {
    record.push(["alpha", toolCallId])
    return { content: [{ type: "text", text: "from alpha" }] }
  }),
  tool(
    "beta",
    { type: "object", properties: { x: { type: "string" } }, required: ["x"] },
    async (toolCallId) => {
      record.push(["beta", toolCallId])
      return { content: [{ type: "text", text: "from beta" }], isError: true }
    },
  ),
]

describe("calling a tool", () => {
  test("runs the handler of the tool named", async () => {
    const calls: Array<[string, string]> = []
    const { callTool } = await connectClient(createToolServer("custom-tools", twoTools(calls)))

    const beta = await callTool("beta", "toolu_b", { x: "hi" })
    expect(calls).toEqual([["beta", "toolu_b"]])
    expect(resultText(beta)).toBe("from beta")
    expect(beta.result?.isError).toBe(true)
  })

  test("hands the handler Claude's tool_use id, not one from the call order", async () => {
    const calls: Array<[string, string]> = []
    const { callTool } = await connectClient(createToolServer("custom-tools", twoTools(calls)))

    await callTool("beta", "toolu_second", { x: "hi" })
    await callTool("alpha", "toolu_first")

    expect(calls).toEqual([
      ["beta", "toolu_second"],
      ["alpha", "toolu_first"],
    ])
  })

  test("fails loudly with no tool_use id, rather than pairing wrongly", async () => {
    const calls: Array<[string, string]> = []
    const { callTool } = await connectClient(createToolServer("custom-tools", twoTools(calls)))

    const reply = await callTool("alpha", null)
    const message = reply.error?.message ?? JSON.stringify(reply.result)
    expect(message).toMatch(/toolUseId/i)
    expect(calls).toEqual([])
  })

  // toolCallId is the bridge's bookkeeping, not MCP's CallToolResult.
  test("puts none of the bridge's own fields in the result", async () => {
    const { callTool } = await connectClient(
      createToolServer("custom-tools", [
        tool("alpha", { type: "object", properties: {} }, async (toolCallId) => ({
          content: [{ type: "text", text: "ok" }],
          isError: false,
          toolCallId,
        })),
      ]),
    )

    const reply = await callTool("alpha", "toolu_x")
    expect(Object.keys(reply.result ?? {}).toSorted()).toEqual(["content", "isError"])
  })

  // pi validates and runs the tool; a rejection here would only strand the call.
  test("runs the handler even when the arguments don't match the schema", async () => {
    let called = false
    const { callTool } = await connectClient(
      createToolServer("custom-tools", [
        tool(
          "strict",
          {
            type: "object",
            properties: { count: { type: "number" } },
            required: ["count"],
            additionalProperties: false,
          },
          async () => {
            called = true
            return { content: [{ type: "text", text: "ran" }] }
          },
        ),
      ]),
    )

    const reply = await callTool("strict", "toolu_y", { count: "not-a-number", extra: 1 })
    expect(called).toBe(true)
    expect(resultText(reply)).toBe("ran")
  })
})
