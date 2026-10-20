// The Session's MCP servers (ADR 0020), at the Hub's Gateway as the pi extension had them: the
// Runner names them in `KNDL_MCP_SERVERS` (Installation ids and server names, nothing secret), and
// the agent connects to each at `${KNDL_URL}/gateway/<installationId>` with the Session token,
// which the Runner's relay swaps for the mod token, so no credential is ever in the Sandbox.
//
// Each server's tools are Pi Durable tools named `mcp__<server>__<tool>`, deferred: the model
// isn't offered them until it finds them with `tool_search`, which keeps the tool list short in a
// Session with many servers; code mode scripts call any of them, grouped by server. A call isn't
// replayed after a restart: a server's tool may change things, and the model is told the call was
// cut off instead.

import { Type } from "@earendil-works/pi-ai"
import { defineExtension, defineTool } from "@earendil-works/pi-durable"
import type { Extension, ToolRegistration } from "@earendil-works/pi-durable"
import type { CodemodeNamespace } from "@earendil-works/pi-durable/codemode"
import {
  McpClient,
  McpConnectionClosedError,
  McpSessionExpiredError,
  StreamableHttpTransport,
  toLlmContent,
} from "@earendil-works/pi-mcp"
import type { Tool } from "@earendil-works/pi-mcp"
import { GatewayServer, gatewayPath } from "@kndl/protocol"
import { Exit, Schema } from "effect"

/** The variable the Runner names the Session's MCP servers in. */
export const McpServersVariable = "KNDL_MCP_SERVERS"

/** An MCP server of the Session's: its Installation and its server's name. */
export interface McpServerSpec {
  readonly installationId: string
  readonly server: string
}

const decodeServers = Schema.decodeUnknownExit(Schema.fromJsonString(Schema.Array(GatewayServer)))

/** The servers {@link McpServersVariable} names; none when it names none, or can't be read. */
export const mcpServerSpecs = (
  value: string | undefined,
  log: (text: string) => void,
): ReadonlyArray<McpServerSpec> => {
  if (value === undefined || value === "") return []
  const servers = decodeServers(value)
  if (Exit.isFailure(servers)) {
    log(`kndl: ${McpServersVariable} isn't a list of MCP servers, so the agent has none of them`)
    return []
  }
  return servers.value
}

/** A name as Providers take a tool's: letters, digits, `_` and `-`. */
const toolNamePart = (name: string) => name.replace(/[^A-Za-z0-9_-]/g, "_")

/** The prefix of a server's tools. */
export const mcpPrefix = (server: string) => `mcp__${toolNamePart(server)}__`

/** A server's tool as the model calls it, at most 64 characters, as Providers allow. */
export const mcpToolName = (server: string, tool: string) =>
  `${mcpPrefix(server)}${toolNamePart(tool)}`.slice(0, 64)

/** Each server's tools as a code mode namespace, so scripts find them by server. */
export const mcpNamespaces = (servers: ReadonlyArray<McpServerSpec>): Array<CodemodeNamespace> =>
  servers.map(({ server }) => ({
    name: toolNamePart(server),
    description: `The ${server} MCP server's tools.`,
    prefix: mcpPrefix(server),
  }))

export interface McpOptions {
  readonly hubUrl: string
  readonly modToken: string
  readonly log: (text: string) => void
  /** How long a server has to connect and list its tools. */
  readonly connectTimeoutMs?: number
}

/** One server's connection, made again when it drops. */
class Connection {
  private client: Promise<McpClient> | undefined

  constructor(
    readonly spec: McpServerSpec,
    private readonly options: McpOptions,
  ) {}

  /** The connected client, connecting when there is none. */
  connected(): Promise<McpClient> {
    this.client ??= (async () => {
      const client = new McpClient({ name: "kndl", version: "1.0.0" })
      const url = `${this.options.hubUrl.replace(/\/+$/, "")}${gatewayPath(this.spec.installationId)}`
      const transport = new StreamableHttpTransport({
        url,
        headers: { Authorization: `Bearer ${this.options.modToken}` },
        openGetStream: false,
      })
      const timeout = AbortSignal.timeout(this.options.connectTimeoutMs ?? 15_000)
      await Promise.race([
        client.connect(transport),
        new Promise((_, reject) =>
          timeout.addEventListener("abort", () => reject(new Error("timed out connecting"))),
        ),
      ])
      client.onClose(() => {
        this.client = undefined
      })
      return client
    })()
    this.client.catch(() => {
      this.client = undefined
    })
    return this.client
  }

  async tools(): Promise<Array<Tool>> {
    return (await this.connected()).listTools({
      timeoutMs: this.options.connectTimeoutMs ?? 15_000,
    })
  }

  /** Calls a tool; a session the server forgot is made again, and the call made once more. */
  async call(name: string, args: Record<string, unknown>, signal: AbortSignal | undefined) {
    try {
      return await (
        await this.connected()
      ).callTool(name, args, signal === undefined ? {} : { signal })
    } catch (error) {
      if (!(error instanceof McpSessionExpiredError || error instanceof McpConnectionClosedError))
        throw error
      this.client = undefined
      if (error instanceof McpConnectionClosedError) throw error
      return (await this.connected()).callTool(name, args, signal === undefined ? {} : { signal })
    }
  }

  async close() {
    const client = this.client
    this.client = undefined
    await (await client?.catch(() => undefined))?.close().catch(() => undefined)
  }
}

/** A server's tool as a Pi Durable tool: deferred, never replayed. */
export const mcpTool = (connection: Connection, tool: Tool): ToolRegistration =>
  defineTool({
    name: mcpToolName(connection.spec.server, tool.name),
    description: `[${connection.spec.server}] ${tool.description ?? tool.title ?? tool.name}`,
    // Providers want an object schema, and some refuse one without `properties`.
    parameters: Type.Unsafe<Record<string, unknown>>({
      ...tool.inputSchema,
      type: "object",
      properties: (tool.inputSchema.properties as object | undefined) ?? {},
    }),
    deferred: true,
    replay: "unsafe",
    execute: async (args, _api, context) => {
      const result = await connection.call(tool.name, args, context.abortSignal)
      return { output: toLlmContent(result), isError: result.isError === true }
    },
  })

/** The Session's MCP servers, and their tools once they have connected. */
export class McpServers {
  private readonly connections: Array<Connection>

  constructor(
    specs: ReadonlyArray<McpServerSpec>,
    private readonly options: McpOptions,
  ) {
    this.connections = specs.map((spec) => new Connection(spec, options))
  }

  /**
   * Connects to each server and lists its tools, as the `kndl-mcp` extension; a server that
   * can't be reached is left out, and said in the log.
   */
  async extension(): Promise<Extension> {
    const tools = await Promise.all(
      this.connections.map(async (connection) => {
        try {
          return (await connection.tools()).map((tool) => mcpTool(connection, tool))
        } catch (error) {
          this.options.log(
            `kndl: couldn't reach the MCP server ${connection.spec.server}: ${String(error)}`,
          )
          return []
        }
      }),
    )
    return defineExtension({ name: "kndl-mcp", tools: tools.flat() })
  }

  async close() {
    await Promise.all(this.connections.map((connection) => connection.close()))
  }
}
