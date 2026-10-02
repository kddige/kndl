// A minimal MCP client over a spawned command's stdio: newline-delimited JSON-RPC 2.0, as
// `claude mcp serve` speaks it. Requests may overlap; each waits for the response with its id.

import { Data, Deferred, Effect, Stream } from "effect"
import type { Scope } from "effect"
import type { SpawnedCommand } from "./sandbox/SandboxBackend.ts"

/** The server answered with a JSON-RPC error. */
export class McpRpcError extends Data.TaggedError("McpRpcError")<{
  readonly code: number
  readonly message: string
}> {}

/** The server is gone, or never answered properly. */
export class McpClosed extends Data.TaggedError("McpClosed")<{
  readonly message: string
}> {}

export type McpError = McpRpcError | McpClosed

export interface McpSession {
  readonly request: (method: string, params: unknown) => Effect.Effect<unknown, McpError>
  /** Completes, with why, once the server has exited or its output has ended. */
  readonly closed: Deferred.Deferred<string>
}

/** The most stderr kept for explaining why a server went away. */
const stderrTail = 4096

interface JsonRpcResponse {
  readonly id?: unknown
  readonly result?: unknown
  readonly error?: { readonly code?: unknown; readonly message?: unknown }
}

/**
 * Talks MCP to the spawned command: reads its output in a fiber that lives as long as the scope,
 * then runs the `initialize` handshake. Fails if the handshake does.
 */
export const connectMcp = (
  command: SpawnedCommand,
  clientName: string,
): Effect.Effect<McpSession, McpClosed | McpRpcError, Scope.Scope> =>
  Effect.gen(function* () {
    const pending = new Map<number, Deferred.Deferred<unknown, McpError>>()
    const closed = yield* Deferred.make<string>()
    let nextId = 1
    let stderr = ""

    const settle = (line: string) =>
      Effect.suspend(() => {
        let message: JsonRpcResponse
        try {
          message = JSON.parse(line) as JsonRpcResponse
        } catch {
          return Effect.logDebug(`mcp: ignored a line that isn't JSON: ${line.slice(0, 200)}`)
        }
        if (typeof message.id !== "number") return Effect.void
        const waiter = pending.get(message.id)
        if (waiter === undefined) return Effect.void
        pending.delete(message.id)
        if (message.error !== undefined)
          return Deferred.fail(
            waiter,
            new McpRpcError({
              code: typeof message.error.code === "number" ? message.error.code : 0,
              message: String(message.error.message ?? "unknown error"),
            }),
          )
        return Deferred.succeed(waiter, message.result)
      })

    const close = (reason: string) =>
      Effect.gen(function* () {
        const why = stderr.trim() === "" ? reason : `${reason}: ${stderr.trim()}`
        yield* Deferred.succeed(closed, why)
        const waiters = [...pending.values()]
        pending.clear()
        for (const waiter of waiters) yield* Deferred.fail(waiter, new McpClosed({ message: why }))
      })

    const decoder = new TextDecoder()
    let buffer = ""
    let exit = "the tool server's output ended"
    yield* command.events.pipe(
      Stream.runForEach((event) => {
        switch (event._tag) {
          case "Stdout": {
            buffer += decoder.decode(event.data, { stream: true })
            const lines = buffer.split("\n")
            buffer = lines.pop() ?? ""
            return Effect.forEach(
              lines.filter((line) => line.trim() !== ""),
              settle,
              { discard: true },
            )
          }
          case "Stderr":
            stderr = (stderr + new TextDecoder().decode(event.data)).slice(-stderrTail)
            return Effect.void
          case "Exit":
            exit = `the tool server exited with ${event.exitCode}`
            return Effect.void
        }
      }),
      Effect.catchCause((cause) =>
        Effect.sync(() => {
          exit = `lost the tool server: ${String(cause)}`
        }),
      ),
      Effect.ensuring(Effect.suspend(() => close(exit))),
      Effect.forkScoped,
    )

    const send = (message: unknown) =>
      command
        .write(`${JSON.stringify(message)}\n`)
        .pipe(Effect.mapError((error) => new McpClosed({ message: error.message })))

    const request = (method: string, params: unknown): Effect.Effect<unknown, McpError> =>
      Effect.gen(function* () {
        if (yield* Deferred.isDone(closed))
          return yield* new McpClosed({ message: yield* Deferred.await(closed) })
        const id = nextId++
        const waiter = yield* Deferred.make<unknown, McpError>()
        pending.set(id, waiter)
        yield* send({ jsonrpc: "2.0", id, method, params }).pipe(
          Effect.tapError(() => Effect.sync(() => pending.delete(id))),
        )
        return yield* Deferred.await(waiter)
      })

    yield* request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: clientName, version: "0" },
    })
    yield* send({ jsonrpc: "2.0", method: "notifications/initialized", params: {} })
    return { request, closed }
  })
