import type { SessionId, StopSession } from "@claude-hub/protocol"
import { Context, Data, Effect, Layer } from "effect"
import type { SessionDirectories } from "./SessionNames.ts"

export class SandboxError extends Data.TaggedError("SandboxError")<{
  readonly message: string
}> {}

/**
 * The seam for a Session's Sandbox (#9): created and started around its Workspace before Claude
 * Code launches, and stopped after Claude Code stops.
 *
 * The live one (SessionSandboxes.ts) reports its state to the Hub with `SandboxStateReport`,
 * and serves the Session's tool bridge, through which the mod routes Claude Code's file and
 * command tools into the Sandbox (#11).
 */
export class Sandboxes extends Context.Service<
  Sandboxes,
  {
    /** Creates the Session's Sandbox, or reuses its stopped one, and starts it. */
    readonly start: (
      sessionId: SessionId,
      directories: SessionDirectories,
    ) => Effect.Effect<void, SandboxError>
    /** `Sleep` stops the Sandbox and keeps its volumes; `Archive` destroys it (ADR 0006). */
    readonly stop: (sessionId: SessionId, reason: StopSession["reason"]) => Effect.Effect<void>
    /**
     * Destroys whatever is left of a purged Session's Sandbox: the Sandbox if any, and every one
     * of its volumes. Succeeds when nothing is left.
     */
    readonly purge: (sessionId: SessionId) => Effect.Effect<void, SandboxError>
    /**
     * Stops any of this Runner's Sandboxes left running for a Session not among `running`, as
     * after a crash, and logs the Sandboxes it doesn't know. Other Runners' Sandboxes, and ones
     * from before Sandboxes carried their Runner's mark, are left alone. Destroys nothing.
     */
    readonly reconcile: (running: Iterable<SessionId>) => Effect.Effect<void>
  }
>()("@claude-hub/runner/Sandboxes") {}

/** No Sandbox: Sessions run with nothing around them, and the mod refuses every routed tool. */
export const NoSandboxes = Layer.succeed(
  Sandboxes,
  Sandboxes.of({
    start: () => Effect.void,
    stop: () => Effect.void,
    purge: () => Effect.void,
    reconcile: () => Effect.void,
  }),
)
