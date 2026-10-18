// Whether this Runner runs pi Sessions (ADR 0029), as its hello says: once the pi bundle is in its
// cache (sandbox/SandboxPi.ts), and its mod has the pi extension built (SessionMod.ts).
//
// The Runner prepares the bundle as it starts, in the background, so taking back the Sessions an
// earlier Runner left running doesn't wait for it; its first hello does. The first start on a
// host downloads Node.js and installs pi, which takes seconds on a good network; every later one
// finds them in the cache. When preparing fails, the Runner says why in its log and runs Claude
// Code Sessions alone, until it next starts.

import { join } from "node:path"
import { HomeConfig } from "@kndl/protocol/home"
import { Config, Context, Deferred, Duration, Effect, Layer } from "effect"
import { RunnerConfig } from "./RunnerConfig.ts"
import {
  ensurePiBundle,
  type PiBundleReady,
  PinnedNodeVersion,
  PinnedPiVersion,
  sandboxPiCliPath,
  type SandboxPiError,
} from "./sandbox/SandboxPi.ts"
import { hasPiExtension, piExtensionBuild } from "./SessionMod.ts"

/** How long preparing the bundle may take before the Runner runs Claude Code alone. */
export const PreparePiTimeout = Duration.minutes(5)

/** What a pi Session runs, once the bundle is ready. */
export interface PiReady {
  /** pi's CLI in every Sandbox. */
  readonly cli: string
}

export class PiBundle extends Context.Service<
  PiBundle,
  {
    /** The host directory of the bundle, mounted read-only into every Sandbox. */
    readonly cacheDir: string
    /**
     * pi's CLI once the bundle is ready, or undefined when this Runner runs Claude Code alone.
     * Waits for the preparation the Runner started with; never fails.
     */
    readonly ready: Effect.Effect<PiReady | undefined>
  }
>()("@kndl/runner/PiBundle") {}

/**
 * Prepares the bundle with `ensure`, if the mod under `modDir` has its pi extension: what pi
 * Sessions run, or undefined, logged, when there is anything they would lack.
 */
export const preparePi = (options: {
  readonly modDir: string
  readonly ensure: Effect.Effect<PiBundleReady, SandboxPiError>
}): Effect.Effect<PiReady | undefined> =>
  Effect.gen(function* () {
    if (!hasPiExtension(options.modDir)) {
      yield* Effect.logWarning(
        `Sessions run Claude Code alone: the mod's pi extension, ${join(options.modDir, piExtensionBuild)}, isn't built. Run \`bun run mod:build\`.`,
      )
      return undefined
    }
    return yield* options.ensure.pipe(
      Effect.timeoutOrElse({
        duration: PreparePiTimeout,
        orElse: () =>
          Effect.fail({
            message: `getting pi took longer than ${Duration.format(PreparePiTimeout)}`,
          }),
      }),
      Effect.map((bundle): PiReady => ({ cli: sandboxPiCliPath(bundle.appDir) })),
      Effect.tap(() =>
        Effect.logInfo(`Sessions can run pi ${PinnedPiVersion}, on Node.js ${PinnedNodeVersion}`),
      ),
      Effect.catch((error) =>
        Effect.as(Effect.logWarning(`Sessions run Claude Code alone: ${error.message}`), undefined),
      ),
    )
  })

/**
 * Prepares the bundle in the background, from the Runner's start. The cache is
 * `RUNNER_SANDBOX_PI_CACHE`, by default `pi` in the home: `~/.kndl-dev/pi`.
 */
export const PiBundleLive = Layer.effect(
  PiBundle,
  Effect.gen(function* () {
    const config = yield* RunnerConfig
    const home = yield* HomeConfig
    const cacheDir = yield* Config.String("RUNNER_SANDBOX_PI_CACHE").pipe(
      Config.withDefault(join(home.dir, "pi")),
    )
    const prepared = yield* Deferred.make<PiReady | undefined>()
    yield* preparePi({ modDir: config.modDir, ensure: ensurePiBundle({ cacheDir }) }).pipe(
      Effect.flatMap((ready) => Deferred.succeed(prepared, ready)),
      Effect.forkScoped,
    )
    return PiBundle.of({ cacheDir, ready: Deferred.await(prepared) })
  }),
)

/** A bundle that is `ready` as given, for tests. */
export const StaticPiBundle = (ready: PiReady | undefined, cacheDir = "/unused") =>
  Layer.succeed(PiBundle, PiBundle.of({ cacheDir, ready: Effect.succeed(ready) }))
