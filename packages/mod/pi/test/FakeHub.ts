// A Hub for the pi extension's end-to-end test: it plays the mod endpoints (hello, events,
// commands, providers, attachments) and the Gateway, where it answers pi-ai's OpenAI Responses
// requests with scripted streams.

import { ProtocolVersion } from "@kndl/protocol"
import type { ModAttachmentEncoded, ModProviders } from "@kndl/protocol"

export interface GatewayRequest {
  readonly path: string
  readonly authorization: string | null
  readonly body: Record<string, unknown>
}

/** How the Gateway answers one request: a stream of Responses events, which may never end. */
export interface Script {
  readonly events: ReadonlyArray<Record<string, unknown>>
  /** Keep the stream open after the events, until pi gives up on it. */
  readonly hang?: boolean
}

type Event = Record<string, unknown> & { readonly _tag: string }

const usage = (input: number, output: number, cached = 0) => ({
  input_tokens: input + cached,
  output_tokens: output,
  total_tokens: input + cached + output,
  input_tokens_details: { cached_tokens: cached },
  output_tokens_details: { reasoning_tokens: 0 },
})

let responses = 0

/** A Responses stream that answers with `text`. */
export const textReply = (
  text: string,
  tokens: { input: number; output: number; cached?: number },
): Script => {
  const id = `resp_${++responses}`
  const item = {
    type: "message",
    id: `msg_${responses}`,
    role: "assistant",
    status: "in_progress",
    content: [],
  }
  const done = {
    ...item,
    status: "completed",
    content: [{ type: "output_text", text, annotations: [] }],
  }
  return {
    events: [
      { type: "response.created", response: { id, status: "in_progress", output: [] } },
      { type: "response.output_item.added", output_index: 0, item },
      {
        type: "response.output_text.delta",
        output_index: 0,
        item_id: item.id,
        content_index: 0,
        delta: text,
      },
      { type: "response.output_item.done", output_index: 0, item: done },
      {
        type: "response.completed",
        response: {
          id,
          status: "completed",
          output: [done],
          usage: usage(tokens.input, tokens.output, tokens.cached),
        },
      },
    ],
  }
}

/** A Responses stream that calls `name` with `args`. */
export const toolCallReply = (
  name: string,
  args: Record<string, unknown>,
  tokens: { input: number; output: number },
): Script => {
  const id = `resp_${++responses}`
  const item = {
    type: "function_call",
    id: `fc_${responses}`,
    call_id: `call_${responses}`,
    name,
    arguments: "",
    status: "in_progress",
  }
  const done = { ...item, arguments: JSON.stringify(args), status: "completed" }
  return {
    events: [
      { type: "response.created", response: { id, status: "in_progress", output: [] } },
      { type: "response.output_item.added", output_index: 0, item },
      {
        type: "response.function_call_arguments.done",
        output_index: 0,
        item_id: item.id,
        arguments: JSON.stringify(args),
      },
      { type: "response.output_item.done", output_index: 0, item: done },
      {
        type: "response.completed",
        response: {
          id,
          status: "completed",
          output: [done],
          usage: usage(tokens.input, tokens.output),
        },
      },
    ],
  }
}

/** A Responses stream that starts to say `text`, and never finishes. */
export const hangingReply = (text: string): Script => {
  const id = `resp_${++responses}`
  const item = {
    type: "message",
    id: `msg_${responses}`,
    role: "assistant",
    status: "in_progress",
    content: [],
  }
  return {
    events: [
      { type: "response.created", response: { id, status: "in_progress", output: [] } },
      { type: "response.output_item.added", output_index: 0, item },
      {
        type: "response.output_text.delta",
        output_index: 0,
        item_id: item.id,
        content_index: 0,
        delta: text,
      },
    ],
    hang: true,
  }
}

const sse = (script: Script, signal: AbortSignal) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder()
      for (const event of script.events)
        controller.enqueue(
          encoder.encode(`event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`),
        )
      if (!script.hang) return controller.close()
      signal.addEventListener("abort", () => {
        try {
          controller.close()
        } catch {
          // Closed already.
        }
      })
    },
  })

export class FakeHub {
  readonly hellos: Array<Record<string, unknown>> = []
  readonly events: Array<Event> = []
  readonly gatewayRequests: Array<GatewayRequest> = []
  /** What the Gateway answers next, in order. */
  readonly scripts: Array<Script> = []
  private readonly commands: Array<{ seq: number; message: unknown }> = []
  private wake: Array<() => void> = []
  private watchers: Array<() => void> = []
  private readonly server: ReturnType<typeof Bun.serve>

  constructor(
    readonly options: {
      readonly modToken: string
      readonly providers: ModProviders
      readonly attachments: Record<string, ModAttachmentEncoded>
    },
  ) {
    this.server = Bun.serve({ port: 0, idleTimeout: 0, fetch: (request) => this.handle(request) })
  }

  get url() {
    return `http://127.0.0.1:${this.server.port}`
  }

  stop() {
    this.server.stop(true)
  }

  /** Queues a command for the mod, as the Hub's outbox does. */
  send(message: Record<string, unknown>) {
    this.commands.push({ seq: this.commands.length + 1, message })
    for (const wake of this.wake.splice(0)) wake()
  }

  /** Waits for `check` to hold of what the Hub has heard, up to `ms`. */
  async until<T>(check: () => T | undefined, ms = 20_000): Promise<T> {
    const deadline = Date.now() + ms
    while (true) {
      const value = check()
      if (value !== undefined) return value
      if (Date.now() > deadline)
        throw new Error(`timed out; events: ${JSON.stringify(this.events)}`)
      await new Promise<void>((resolve) => {
        this.watchers.push(resolve)
        setTimeout(resolve, 100)
      })
    }
  }

  /** The events after the `from`th, up to the first that matches, once it has come. */
  eventsUntil(from: number, check: (event: Event) => boolean, ms?: number) {
    return this.until(() => {
      const index = this.events.findIndex((event, at) => at >= from && check(event))
      return index === -1 ? undefined : this.events.slice(from, index + 1)
    }, ms)
  }

  private heard() {
    for (const watcher of this.watchers.splice(0)) watcher()
  }

  private async handle(request: Request): Promise<Response> {
    const url = new URL(request.url)
    const authorization = request.headers.get("authorization")
    if (url.pathname.startsWith("/gateway/models/")) {
      const body = (await request.json()) as Record<string, unknown>
      this.gatewayRequests.push({ path: url.pathname, authorization, body })
      this.heard()
      if (authorization !== `Bearer ${this.options.modToken}`)
        return Response.json({ error: { message: "bad token" } }, { status: 401 })
      const script = this.scripts.shift()
      if (script === undefined)
        return Response.json({ error: { message: "no script" } }, { status: 500 })
      return new Response(sse(script, request.signal), {
        headers: { "content-type": "text/event-stream" },
      })
    }
    if (authorization !== `Bearer ${this.options.modToken}`)
      return new Response(null, { status: 403 })
    if (url.pathname === "/mod/hello") {
      this.hellos.push((await request.json()) as Record<string, unknown>)
      this.heard()
      return Response.json({
        _tag: "ModWelcome",
        protocolVersion: ProtocolVersion,
        alreadySubmitted: true,
      })
    }
    if (url.pathname === "/mod/events") {
      const { messages } = (await request.json()) as { messages: Array<Event> }
      this.events.push(...messages)
      this.heard()
      return new Response(null, { status: 204 })
    }
    if (url.pathname === "/mod/providers") return Response.json(this.options.providers)
    if (url.pathname === "/mod/commands") {
      const after = Number(url.searchParams.get("after") ?? 0)
      const pending = () => this.commands.filter((command) => command.seq > after)
      if (pending().length === 0)
        await new Promise<void>((resolve) => {
          this.wake.push(resolve)
          setTimeout(resolve, 500)
        })
      return Response.json({ messages: pending() })
    }
    const attachment = /^\/mod\/attachments\/([^/]+)$/.exec(url.pathname)
    if (attachment?.[1] !== undefined) {
      const file = this.options.attachments[decodeURIComponent(attachment[1])]
      return file === undefined
        ? Response.json({ error: "No such attachment." }, { status: 404 })
        : Response.json(file)
    }
    return new Response(null, { status: 404 })
  }
}
