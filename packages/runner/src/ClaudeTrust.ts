import { Context, Effect, FileSystem, Layer } from "effect"
import { trustDirectory } from "./ClaudeConfig.ts"
import { RunnerConfig } from "./RunnerConfig.ts"

/**
 * Keeps the sessions root trusted by Claude Code, so a Session's Claude Code never stops at the
 * folder-trust dialog, which nobody on the web can answer. Trust is inherited from parent
 * directories (spike #4), so this is one entry for the root, never one per Session.
 */
export class ClaudeTrust extends Context.Service<
  ClaudeTrust,
  {
    /**
     * Makes the sessions root and marks it trusted when it isn't yet. Run at startup and before
     * each Claude Code launch. Never fails: a Session that isn't trusted only asks.
     */
    readonly ensure: Effect.Effect<void>
  }
>()("@claude-hub/runner/ClaudeTrust") {}

/** Trusts the sessions root in Claude Code's config file at `configPath`. */
export const ClaudeTrustLive = (configPath: string) =>
  Layer.effect(
    ClaudeTrust,
    Effect.gen(function* () {
      const config = yield* RunnerConfig
      const fs = yield* FileSystem.FileSystem
      let warnedMissing = false

      const ensure = Effect.gen(function* () {
        yield* fs.makeDirectory(config.sessionsRoot, { recursive: true })
        const outcome = yield* trustDirectory(configPath, config.sessionsRoot)
        switch (outcome._tag) {
          case "Trusted":
            return yield* Effect.logInfo(
              `Trusted ${outcome.directory} in ${configPath}, so Sessions under it skip Claude Code's trust dialog`,
            )
          case "AlreadyTrusted":
            return
          case "NoConfigFile":
            if (warnedMissing) return
            warnedMissing = true
            return yield* Effect.logWarning(
              `Claude Code's config file ${configPath} doesn't exist, so the sessions root can't be trusted ` +
                `and each Session will ask. Run \`claude\` once and sign in.`,
            )
        }
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Could not trust the sessions root; each Session will ask", cause),
        ),
      )

      return ClaudeTrust.of({ ensure })
    }),
  )

/** Trusts nothing, for tests. */
export const NoClaudeTrust = Layer.succeed(ClaudeTrust, ClaudeTrust.of({ ensure: Effect.void }))
