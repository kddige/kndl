// The in-process MCP server that serves pi's tools to Claude Code.
//
// pi declares a tool's parameters as TypeBox objects, which are JSON Schema already, as MCP puts
// them on the wire, so they're served as they are, not through the SDK's `createSdkMcpServer`,
// which takes only Zod: its JSON Schema → Zod → JSON Schema round trip loses everything below the
// top level (nested objects become open records, `anyOf`/`const` vanish). The one exception is a
// top-level combinator, flattened below because Claude Code drops a tool whose schema has one.
//
// Handlers go on the protocol server itself, not through `McpServer.registerTool` (Zod again),
// which also skips its argument validation: pi validates and runs the tool, and a rejection here
// would only strand the call. The SDK treats the instance as an opaque JSON-RPC endpoint
// (`connectSdkMcpServer` calls `instance.connect(transport)` and nothing else).
//
// Ported from pi-claude-bridge 0.9.3 (MIT, Copyright (c) 2026 Eli Dickinson): see
// THIRD_PARTY_NOTICES.md.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import type { McpResult } from "./ToolResults.ts"

/**
 * Where Claude Code puts the id of the tool_use block a `tools/call` came from: the only reliable
 * way to pair a call with its result, as calls needn't come in the order the blocks did. A Claude
 * Code extension, not MCP; if it ever stops sending it, every call fails loudly rather than pairing
 * results with the wrong calls.
 */
const ToolUseIdMeta = "claudecode/toolUseId"

export interface McpToolDef {
  readonly name: string
  readonly description: string
  readonly inputSchema: unknown
  readonly handler: (toolCallId: string) => Promise<McpResult>
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/** MCP needs an object schema: anything else is a bug in the tool, named as a query serves it. */
function assertObjectSchema(tool: McpToolDef): void {
  const schema = tool.inputSchema
  if (!isRecord(schema) || schema.type !== "object") {
    throw new Error(
      `${tool.name}: MCP tool parameters must be an object schema, got ${JSON.stringify(schema)}`,
    )
  }
}

// Claude Code drops a tool whose input schema has a top-level anyOf/oneOf/allOf, while a call to
// it would still reach pi and run while Claude Code answers "No such tool available" and retries.
// So a flat object is advertised instead, built as Claude Code's own normalizer does: root
// properties win over branch ones, root `required` stays and allOf's joins it, branch `$ref`s
// into the root's `$defs`/`definitions` are followed, and the lost constraint is restated in the
// description.
const RootCombinators = ["anyOf", "oneOf", "allOf"] as const

function resolveLocalRef(branch: unknown, root: Record<string, unknown>): unknown {
  if (!isRecord(branch) || typeof branch.$ref !== "string") return branch
  const match = /^#\/(\$defs|definitions)\/([^/]+)$/.exec(branch.$ref)
  const defs = match?.[1] === undefined ? undefined : root[match[1]]
  const target = match?.[2] !== undefined && isRecord(defs) ? defs[match[2]] : undefined
  return isRecord(target) ? target : branch
}

/** A branch, named by its required keys, else by all its keys. */
function branchGroup(branch: unknown): string | null {
  if (!isRecord(branch)) return null
  const { required, properties } = branch
  if (
    Array.isArray(required) &&
    required.length > 0 &&
    required.every((key) => typeof key === "string")
  )
    return required.join(", ")
  const keys = isRecord(properties) ? Object.keys(properties) : []
  return keys.length > 0 ? keys.join(", ") : null
}

/** Claude Code's wording, so the tool reads as one it normalized itself. */
function combinatorNote(
  combinators: ReadonlyArray<string>,
  branchesOf: (key: string) => Array<unknown>,
): string {
  if (!combinators.includes("anyOf") && !combinators.includes("oneOf")) {
    return "Input constraint: all listed parameters apply together (flattened from a JSON Schema allOf)."
  }
  const key = combinators.includes("oneOf") ? "oneOf" : "anyOf"
  const rule =
    key === "oneOf"
      ? "Provide parameters for exactly one of"
      : "Provide parameters for at least one of"
  const groups = [
    ...new Set(
      branchesOf(key)
        .map(branchGroup)
        .filter((group) => group !== null),
    ),
  ]
  if (groups.length === 0)
    return `Input constraint: ${rule} the documented parameter groups (flattened from a JSON Schema ${key}).`
  return `Input constraint: ${rule}: ${groups.map((group) => `(${group})`).join(" or ")}.`
}

export function flattenRootCombinators(schema: Record<string, unknown>): {
  schema: Record<string, unknown>
  note?: string
} {
  const combinators = RootCombinators.filter((key) => key in schema)
  if (combinators.length === 0) return { schema }

  const { anyOf: _anyOf, oneOf: _oneOf, allOf: _allOf, ...rest } = schema
  const branchesOf = (key: string) => {
    const branches = schema[key]
    return Array.isArray(branches)
      ? branches.map((branch: unknown) => resolveLocalRef(branch, schema))
      : []
  }
  const properties: Record<string, unknown> = {}
  const required: Array<string> = []
  const addProperties = (source: unknown) => {
    if (!isRecord(source) || !isRecord(source.properties)) return
    for (const [key, value] of Object.entries(source.properties))
      if (!(key in properties)) properties[key] = value
  }
  const addRequired = (source: unknown) => {
    if (!isRecord(source) || !Array.isArray(source.required)) return
    for (const key of source.required as Array<unknown>)
      if (typeof key === "string" && !required.includes(key)) required.push(key)
  }

  addProperties(schema)
  for (const key of combinators) for (const branch of branchesOf(key)) addProperties(branch)
  addRequired(schema)
  for (const branch of branchesOf("allOf")) addRequired(branch)

  const flat: Record<string, unknown> = { ...rest, type: "object", properties }
  if (required.length > 0) flat.required = required
  else delete flat.required
  return { schema: flat, note: combinatorNote(combinators, branchesOf) }
}

/** The MCP server for the SDK's `mcpServers` option, serving `tools`. */
export function createToolServer(name: string, tools: ReadonlyArray<McpToolDef>) {
  const server = new McpServer({ name, version: "1.0.0" }, { capabilities: { tools: {} } })
  const byName = new Map(tools.map((tool) => [tool.name, tool]))
  for (const tool of tools) assertObjectSchema(tool)

  server.server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: tools.map((tool) => {
      const { schema, note } = flattenRootCombinators(tool.inputSchema as Record<string, unknown>)
      return {
        name: tool.name,
        description: [note, tool.description].filter(Boolean).join("\n\n"),
        inputSchema: schema as { type: "object" },
      }
    }),
  }))

  server.server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const tool = byName.get(request.params.name)
    if (!tool) throw new Error(`Unknown tool: ${request.params.name}`)
    const toolCallId = request.params["_meta"]?.[ToolUseIdMeta]
    if (typeof toolCallId !== "string") {
      throw new Error(
        `${tool.name}: tools/call is missing _meta["${ToolUseIdMeta}"] — cannot pair the result with its tool call`,
      )
    }
    // Not `toolCallId`, the bridge's own bookkeeping, which isn't MCP's.
    const { content, isError } = await tool.handler(toolCallId)
    return { content, ...(isError === undefined ? {} : { isError }) }
  })

  return { type: "sdk" as const, name, instance: server }
}
