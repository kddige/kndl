// What the durable agent's tools, sections and commands share: the Harness, the reporters that
// tell the Hub of each conversation, the Hub itself, and the agent's Models. Tools are installed
// before the Harness opens, so they reach it through this, once it has.

import type { Context } from "@earendil-works/chord"
import type { Harness } from "@earendil-works/pi-durable"
import type { HubGet } from "../../src/HubMessages.ts"
import type { Loops } from "./Loops.ts"
import type { Catalog } from "./Providers.ts"

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
  /** A new id, for a Turn, an agent or a question. */
  readonly newId: () => string
  readonly log: (text: string) => void
  /** Whether the agent is shutting down: a call cut off now resumes after the restart. */
  readonly closing: () => boolean
}
