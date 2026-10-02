// Finding Sandboxes the Runner has lost track of, such as after a crash.
//
// On startup the Runner hands over the Sessions it knows. Any Sandbox or volume of ours (see
// Naming.ts) for another Session is reported, and a running Sandbox among them is stopped so it
// stops costing memory. Nothing is destroyed here: the Session may only be Asleep, or the Hub may
// still know it, so removal waits for an explicit `destroy`.

import type { SessionId } from "@claude-hub/protocol"
import { Effect } from "effect"
import { SandboxBackend } from "./SandboxBackend.ts"
import type { SandboxListing } from "./SandboxBackend.ts"

export interface UnknownSandbox extends SandboxListing {
  /** Whether reconciling stopped it. */
  readonly stopped: boolean
}

export interface ReconcileReport {
  readonly unknown: ReadonlyArray<UnknownSandbox>
}

const isRunning = (listing: SandboxListing) =>
  listing.state === "Running" || listing.state === "Starting"

export const reconcileSandboxes = Effect.fn("reconcileSandboxes")(function* (
  known: Iterable<SessionId>,
) {
  const backend = yield* SandboxBackend
  const knownIds = new Set<string>(known)
  const listings = yield* backend.list
  const unknown = yield* Effect.forEach(
    listings.filter((listing) => !knownIds.has(listing.sessionId)),
    Effect.fnUntraced(function* (listing): Effect.fn.Return<UnknownSandbox> {
      // A Sandbox that won't stop is still reported, so one bad VM doesn't hide the rest.
      const stopped = isRunning(listing)
        ? yield* backend.stop(listing.sessionId).pipe(
            Effect.as(true),
            Effect.catch((error) =>
              Effect.logError(
                `Could not stop Sandbox for Session ${listing.sessionId}`,
                error,
              ).pipe(Effect.as(false)),
            ),
          )
        : false
      const state = stopped ? "Stopped" : listing.state
      yield* Effect.logWarning(
        `Unknown Sandbox for Session ${listing.sessionId}: ${state}` +
          `${stopped ? " (stopped now)" : ""}; volumes: ${listing.volumes.join(", ") || "none"}`,
      )
      return { ...listing, state, stopped }
    }),
  )
  return { unknown } satisfies ReconcileReport
})
