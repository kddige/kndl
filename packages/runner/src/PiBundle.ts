// Whether this Runner runs Sessions, as its hello says: once the bundle their durable agent runs
// on is in its cache (sandbox/SandboxPi.ts): Node.js, and pi's packages the agent loads.
//
// The Runner prepares the bundle as it starts, in the background, so taking back the Sessions an
// earlier Runner left running doesn't wait for it; its first hello does. The first start on a
// host downloads Node.js and installs the packages, which takes seconds on a good network; every
// later one finds them in the cache. When preparing fails, the Runner says why in its log and runs
// no Sessions, until it next starts.

import { join } from "node:path"
import { HomeConfig } from "@kndl/protocol/home"
import { Config, Context, Deferred, Duration, Effect, Layer } from "effect"
import {
  ensurePiBundle,
  type PiBundleReady,
  PinnedNodeVersion,
  PinnedPiVersion,
  type SandboxPiError,
  sandboxNodeModulesPath,
} from "./sandbox/SandboxPi.ts"

/** How long preparing the bundle may take before the Runner runs no Sessions. */
export const PreparePiTimeout = Duration.minutes(5)

/** What a Session's durable agent runs on, once the bundle is ready. */
export interface PiReady {
  /**
   * The install's `node_modules` in every Sandbox, where the agent finds the `@earendil-works/*`
   * packages it imports (SessionMod.ts).
   */
  readonly nodeModules: string
}

export class PiBundle extends Context.Service<
  PiBundle,
  {
    /** The host directory of the bundle, mounted read-only into every Sandbox. */
    readonly cacheDir: string
    /**
     * Where the agent's packages are once the bundle is ready, or undefined when this Runner runs
     * no Sessions. Waits for the preparation the Runner started with; never fails.
     */
    readonly ready: Effect.Effect<PiReady | undefined>
  }
>()("@kndl/runner/PiBundle") {}

/**
 * Prepares the bundle with `ensure`: what Sessions' agents run on, or undefined, logged, when it
 * couldn't be had.
 */
export const preparePi = (options: {
  readonly ensure: Effect.Effect<PiBundleReady, SandboxPiError>
}): Effect.Effect<PiReady | undefined> =>
  options.ensure.pipe(
    Effect.timeoutOrElse({
      duration: PreparePiTimeout,
      orElse: () =>
        Effect.fail({
          message: `getting pi took longer than ${Duration.format(PreparePiTimeout)}`,
        }),
    }),
    Effect.map((bundle): PiReady => ({ nodeModules: sandboxNodeModulesPath(bundle.appDir) })),
    Effect.tap(() =>
      Effect.logInfo(
        `Sessions can run the durable agent on pi ${PinnedPiVersion}, on Node.js ${PinnedNodeVersion}`,
      ),
    ),
    Effect.catch((error) =>
      Effect.as(Effect.logWarning(`Sessions can't run: ${error.message}`), undefined),
    ),
  )

/**
 * Prepares the bundle in the background, from the Runner's start. The cache is
 * `RUNNER_SANDBOX_PI_CACHE`, by default `pi` in the home: `~/.kndl-dev/pi`.
 */
export const PiBundleLive = Layer.effect(
  PiBundle,
  Effect.gen(function* () {
    const home = yield* HomeConfig
    const cacheDir = yield* Config.String("RUNNER_SANDBOX_PI_CACHE").pipe(
      Config.withDefault(join(home.dir, "pi")),
    )
    const prepared = yield* Deferred.make<PiReady | undefined>()
    yield* preparePi({ ensure: ensurePiBundle({ cacheDir }) }).pipe(
      Effect.flatMap((ready) => Deferred.succeed(prepared, ready)),
      Effect.forkScoped,
    )
    return PiBundle.of({ cacheDir, ready: Deferred.await(prepared) })
  }),
)

/** A bundle that is `ready` as given, for tests. */
export const StaticPiBundle = (ready: PiReady | undefined, cacheDir = "/unused") =>
  Layer.succeed(PiBundle, PiBundle.of({ cacheDir, ready: Effect.succeed(ready) }))
