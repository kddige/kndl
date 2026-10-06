// Permission drift (issue #86): whether the GitHub App, and each account it is installed on, has
// the permissions the Hub needs (AppPermissions.ts). The Hub checks as it starts, then every
// `checkInterval`, and when someone asks from the web UI after fixing something on GitHub; whoever
// asks while a check is under way gets that one. The last check that succeeded is kept, for each
// web client that connects; a check that finds something other than the one before is published
// to them all, and logged.
//
// Without the App there is nothing to check.

import type { AppPermissionsCheck } from "@kndl/protocol"
import { Context, Deferred, Duration, Effect, Layer, Option, PubSub, type Scope } from "effect"
import { describeDrift } from "./AppPermissions.ts"
import { GitHubApp, type GitHubAppError } from "./GitHubApp.ts"

/** How often the Hub checks on its own. Asking from the web checks at once. */
export const checkInterval = Duration.hours(1)

export class PermissionDrift extends Context.Service<
  PermissionDrift,
  {
    /** The last check that succeeded, if one has. */
    readonly latest: Effect.Effect<Option.Option<AppPermissionsCheck>>
    /** Checks now; or, while a check is under way, waits for that one. */
    readonly check: Effect.Effect<AppPermissionsCheck, GitHubAppError>
    /** Each check that found something other than the one before, from now on. */
    readonly changes: Effect.Effect<PubSub.Subscription<AppPermissionsCheck>, never, Scope.Scope>
  }
>()("@kndl/hub/PermissionDrift") {
  static readonly layer = Layer.effect(
    PermissionDrift,
    Effect.gen(function* () {
      const app = yield* GitHubApp
      const layerScope = yield* Effect.scope
      const published = yield* PubSub.unbounded<AppPermissionsCheck>()
      let latest: AppPermissionsCheck | undefined
      let lastFailure: string | undefined
      let running: Deferred.Deferred<AppPermissionsCheck, GitHubAppError> | undefined

      const checkNow = Effect.gen(function* () {
        const found = yield* app.checkPermissions.pipe(
          Effect.tapError((error) =>
            Effect.gen(function* () {
              // Once, not every interval of an outage.
              if (error.message !== lastFailure) yield* Effect.logWarning(error.message)
              lastFailure = error.message
            }),
          ),
        )
        lastFailure = undefined
        const changed = latest === undefined || !sameFindings(latest, found)
        latest = found
        if (changed) {
          for (const line of describeDrift(found)) yield* Effect.logWarning(line)
          yield* PubSub.publish(published, found)
        }
        return found
      })

      // In the layer's scope, so that one who asks and goes away doesn't stop it for the others.
      const check = Effect.suspend(() => {
        if (running !== undefined) return Deferred.await(running)
        const deferred = Deferred.makeUnsafe<AppPermissionsCheck, GitHubAppError>()
        running = deferred
        return checkNow.pipe(
          Effect.onExit((exit) =>
            Effect.suspend(() => {
              running = undefined
              return Deferred.done(deferred, exit)
            }),
          ),
          Effect.forkIn(layerScope),
          Effect.andThen(Deferred.await(deferred)),
        )
      })

      if (app.isConfigured) {
        // Forever: a failure is logged, and the next interval tries again.
        yield* check.pipe(
          Effect.ignore,
          Effect.andThen(Effect.sleep(checkInterval)),
          Effect.forever,
          Effect.forkIn(layerScope),
        )
      }

      return PermissionDrift.of({
        latest: Effect.sync(() => Option.fromUndefinedOr(latest)),
        check,
        changes: PubSub.subscribe(published),
      })
    }),
  )
}

/** Whether two checks found the same, whenever they ran. */
const sameFindings = (a: AppPermissionsCheck, b: AppPermissionsCheck) =>
  JSON.stringify({ ...a, checkedAt: 0 }) === JSON.stringify({ ...b, checkedAt: 0 })
