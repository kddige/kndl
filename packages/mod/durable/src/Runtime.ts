// What the durable agent's tools, sections and commands share: the Harness, the reporters that
// tell the Hub of each conversation, the Hub itself, and the agent's Models. Tools are installed
// before the Harness opens, so they reach it through this, once it has. Also whose a conversation
// is (`Loop`), which every event the Hub hears of it says.

import type { Context } from "@earendil-works/chord"
import type { Harness } from "@earendil-works/pi-durable"
import type { HubGet } from "./hub/HubMessages.ts"
import type { Loops } from "./Loops.ts"
import type { Catalog } from "./Providers.ts"

/** Whose a conversation is, as the Hub tells them apart. */
export type Loop =
  | { readonly kind: "main" }
  | { readonly kind: "thread"; readonly threadId: string }
  | { readonly kind: "agent"; readonly agentId: string; readonly reported: boolean }

/** What every event of a loop carries of whose it is. */
export const loopFields = (loop: Loop): { threadId?: string; agentId?: string } =>
  loop.kind === "thread"
    ? { threadId: loop.threadId }
    : loop.kind === "agent"
      ? { agentId: loop.agentId }
      : {}

export interface Runtime {
  /** The open Harness; throws before it has opened. */
  readonly harness: () => Harness
  readonly loops: Loops
  /** Queues an event for the Hub. */
  readonly report: (event: Record<string, unknown>) => void
  /** The agent's lifetime: cancelled as it shuts down. */
  readonly context: Context
  /** GETs a path on the Hub with the mod token, until `signal` aborts. */
  readonly hubGet: (path: string, signal?: AbortSignal) => ReturnType<HubGet>
  readonly catalog: Catalog
  readonly secrets: ReadonlyArray<string>
  /** A new id, for a Turn, an agent or a question. */
  readonly newId: () => string
  readonly log: (text: string) => void
  /** Whether the agent is shutting down: a call cut off now resumes after the restart. */
  readonly closing: () => boolean
}
