// Drives the Claude bridge's consumeQuery with a list of SDK messages, into a fake pi stream that
// records what it was given: for the bridge's streaming tests.

import type {
  Api,
  AssistantMessage,
  AssistantMessageEvent,
  AssistantMessageEventStream,
  Model,
} from "@earendil-works/pi-ai"
import { consumeQuery } from "../src/claude/Bridge.ts"
import { ClaudeApi } from "../src/claude/Names.ts"
import { QueryContext } from "../src/claude/QueryState.ts"

export type RecordedEvent = AssistantMessageEvent | { readonly type: "end" }

/** A pi stream that records every event, and its end as `{ type: "end" }`. */
export interface FakeStream {
  readonly events: Array<RecordedEvent>
  readonly push: (event: AssistantMessageEvent) => void
  readonly end: () => void
}

export function fakeStream(): FakeStream {
  const events: Array<RecordedEvent> = []
  return { events, push: (event) => events.push(event), end: () => events.push({ type: "end" }) }
}

/** A Claude Model at no price, as the bridge registers them. */
export const testModel = (id = "test-model"): Model<Api> =>
  ({
    id,
    name: id,
    api: ClaudeApi,
    provider: "anthropic",
    baseUrl: "claude-code",
    reasoning: false,
    input: ["text"],
    contextWindow: 200_000,
    maxTokens: 8192,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  }) as Model<Api>

/** A query context with a turn open on a fresh fake stream. */
export function makeCtx(model: Model<Api> = testModel()): { c: QueryContext; stream: FakeStream } {
  const c = new QueryContext()
  const stream = fakeStream()
  c.currentPiStream = stream as unknown as AssistantMessageEventStream
  c.resetTurnState(model)
  return { c, stream }
}

/** Plays `messages` through consumeQuery, as a query would yield them. */
export async function consume(
  c: QueryContext,
  messages: ReadonlyArray<unknown>,
  toolMap: Map<string, string>,
  model: Model<Api> = testModel(),
) {
  async function* gen() {
    for (const message of messages) yield message
  }
  return consumeQuery(gen(), toolMap, model, () => false, c)
}

/** The stream's terminal event (done or error), if it got one. */
export function terminal(
  stream: FakeStream,
): Extract<AssistantMessageEvent, { type: "done" | "error" }> | undefined {
  for (const event of stream.events)
    if (event.type === "done" || event.type === "error") return event
  return undefined
}

/** The message the turn ended with: what pi got in the terminal event. */
export function ended(stream: FakeStream): AssistantMessage {
  const event = terminal(stream)
  if (event === undefined) throw new Error("the turn didn't end")
  return event.type === "done" ? event.message : event.error
}

export const streamEvent = (event: Record<string, unknown>) => ({ type: "stream_event", event })

export const types = (stream: FakeStream) => stream.events.map((event) => event.type)
