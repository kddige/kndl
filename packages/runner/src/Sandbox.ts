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
 * A backend reports its state to the Hub with `SandboxStateReport`, and the mod (#11) routes
 * Claude Code's file and command tools into it.
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
  }
>()("@claude-hub/runner/Sandboxes") {}

/** No Sandbox yet: Sessions run with nothing around them until #9 lands. */
export const NoSandboxes = Layer.succeed(
  Sandboxes,
  Sandboxes.of({ start: () => Effect.void, stop: () => Effect.void }),
)
