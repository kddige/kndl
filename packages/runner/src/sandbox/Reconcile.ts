// Finding Sandboxes the Runner has lost track of, such as after a crash.
//
// On startup the Runner hands over the Sessions it knows. Any Sandbox or volume of this Runner's
// (carrying its mark, see Naming.ts) for another Session is reported, and a running Sandbox among
// them is stopped so it stops costing memory. Nothing is destroyed here: the Session may only be
// Asleep, or the Hub may still know it, so removal waits for an explicit `destroy`.
//
// Another Runner's Sandboxes, and unmarked ones made before Sandboxes carried a mark, are left
// alone and only logged (#38): their Sessions may be live on a Runner this one knows nothing of.

import type { SessionId } from "@kndl/protocol"
import { Effect } from "effect"
import { SandboxBackend } from "./SandboxBackend.ts"
import type { SandboxListing } from "./SandboxBackend.ts"

export interface UnknownSandbox extends SandboxListing {
  /** Whether reconciling stopped it. */
  readonly stopped: boolean
}

export interface ReconcileReport {
  /** This Runner's Sandboxes for Sessions it doesn't know. */
  readonly unknown: ReadonlyArray<UnknownSandbox>
  /** Sandboxes of other Runners, or of none, which were left alone. */
  readonly others: ReadonlyArray<SandboxListing>
}

const isRunning = (listing: SandboxListing) =>
  listing.state === "Running" || listing.state === "Starting"

export const reconcileSandboxes = Effect.fn("reconcileSandboxes")(function* (
  known: Iterable<SessionId>,
) {
  const backend = yield* SandboxBackend
  const knownIds = new Set<string>(known)
  const listings = yield* backend.list
  const others = listings.filter((listing) => listing.runner !== backend.runner)
  for (const listing of others) {
    const volumes = `volumes: ${listing.volumes.join(", ") || "none"}`
    // An unmarked Sandbox of a Session this Runner runs is its own, from before the mark.
    yield* listing.runner === undefined && !knownIds.has(listing.sessionId)
      ? Effect.logWarning(
          `Sandbox for Session ${listing.sessionId} carries no Runner mark, so it belongs to no ` +
            `Runner; left ${listing.state}; ${volumes}`,
        )
      : Effect.logDebug(
          `Sandbox for Session ${listing.sessionId} belongs to ` +
            `${listing.runner === undefined ? "no Runner" : `Runner ${listing.runner}`}; left alone`,
        )
  }
  const unknown = yield* Effect.forEach(
    listings.filter(
      (listing) => listing.runner === backend.runner && !knownIds.has(listing.sessionId),
    ),
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
  return { unknown, others } satisfies ReconcileReport
})
