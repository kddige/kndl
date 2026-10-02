// Helpers for the Hub's tests: a real Hub on 127.0.0.1 and a free port, and ways to sign in to
// it. Not part of the Hub.

import { BunHttpServer } from "@effect/platform-bun"
import { Context, Duration, Effect, Exit, Layer, Option, Scope } from "effect"
import { HttpRouter, HttpServer } from "effect/http"
import type { SqlClient } from "effect/sql"
import { signInCookie } from "./Auth.ts"
import { DatabaseTest } from "./Database.ts"
import { GitHub } from "./GitHub.ts"
import { GitHubApp } from "./GitHubApp.ts"
import { HubRoutes, HubServices, idleTimeoutSeconds } from "./Hub.ts"
import { DefaultSleepAfter, HubConfig, type HubConfigInput } from "./HubConfig.ts"
import { drainFirst } from "./HubShutdown.ts"

export const webOrigin = "http://localhost:5173"

export const baseConfig: HubConfigInput = {
  host: "127.0.0.1",
  port: 0,
  publicUrl: new URL(webOrigin),
  githubClientId: Option.none(),
  githubClientSecret: Option.none(),
  githubAppId: Option.none(),
  githubAppPrivateKey: Option.none(),
  devLogin: false,
  devLoginName: "dev",
  sleepAfterMs: Duration.toMillis(DefaultSleepAfter),
}

/** The Hub's stores and services, which tests can reach into. */
export type Services = Layer.Success<typeof HubServices>

export interface TestHub {
  /** The Hub's address, such as `http://127.0.0.1:54321`. */
  readonly url: string
  /** Runs an effect against the Hub's services. */
  readonly run: <A, E>(effect: Effect.Effect<A, E, Services>) => Promise<A>
  /** Shuts the Hub down, as a restart would. */
  readonly stop: () => Promise<void>
}

const openHubs = new Set<Scope.Closeable>()

/** Shuts down every Hub a test started: pass to `afterEach`. */
export async function stopHubs() {
  const scopes = [...openHubs]
  openHubs.clear()
  await Promise.all(scopes.map((scope) => Effect.runPromise(Scope.close(scope, Exit.void))))
}

export async function startHub(
  options: {
    readonly config?: Partial<HubConfigInput>
    readonly github?: Layer.Layer<GitHub>
    /** The GitHub App; by default from the config, which has none. */
    readonly githubApp?: Layer.Layer<GitHubApp, unknown, HubConfig>
    /** The database; a fresh in-memory one by default. */
    readonly database?: Layer.Layer<SqlClient.SqlClient, unknown>
  } = {},
): Promise<TestHub> {
  const layer = drainFirst(
    HttpRouter.serve(HubRoutes, { disableLogger: true, disableListenLog: true }),
  ).pipe(
    Layer.provideMerge(
      BunHttpServer.layer({ hostname: "127.0.0.1", port: 0, idleTimeout: idleTimeoutSeconds }),
    ),
    Layer.provideMerge(options.github ?? GitHub.layer),
    Layer.provideMerge(HubServices),
    Layer.provideMerge(options.githubApp ?? GitHubApp.layer),
    Layer.provideMerge(options.database ?? DatabaseTest),
    Layer.provideMerge(HubConfig.layerFrom({ ...baseConfig, ...options.config })),
  )
  const scope = Scope.makeUnsafe()
  openHubs.add(scope)
  const context = await Effect.runPromise(Layer.buildWithScope(layer, scope))
  const address = Context.get(context, HttpServer.HttpServer).address
  if (!("port" in address)) throw new Error("expected a TCP address")
  return {
    url: `http://127.0.0.1:${address.port}`,
    run: (effect) => Effect.runPromise(Effect.provideContext(effect, context)),
    stop: async () => {
      openHubs.delete(scope)
      await Effect.runPromise(Scope.close(scope, Exit.void))
    },
  }
}

export const bearer = (token: string) => ({ authorization: `Bearer ${token}` })

/** The sign-in cookie to send back, from a response that set it. */
export function cookieFrom(response: Response): string {
  const value = new RegExp(`${signInCookie}=([^;]+)`).exec(
    response.headers.get("set-cookie") ?? "",
  )?.[1]
  if (value === undefined) throw new Error("no sign-in cookie was set")
  return `${signInCookie}=${value}`
}

export const devSignIn = (hub: TestHub, login = "alice") =>
  fetch(`${hub.url}/auth/dev`, {
    method: "POST",
    headers: { origin: webOrigin, "content-type": "application/json" },
    body: JSON.stringify({ login }),
  })
