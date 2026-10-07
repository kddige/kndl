// Helpers for the Hub's tests: a real Hub on 127.0.0.1 and a free port, and ways to sign in to
// it. Not part of the Hub.

import { createServer } from "node:net"
import { BunHttpServer } from "@effect/platform-bun"
import {
  DefaultEnvironmentDraft,
  type EnvironmentDraft,
  ParticipantId,
  RunnerId,
  TestBuildId,
} from "@kndl/protocol"
import { Context, Duration, Effect, Exit, Layer, Option, Scope } from "effect"
import { HttpRouter, HttpServer } from "effect/http"
import type { SqlClient } from "effect/sql"
import { signInCookie } from "./Auth.ts"
import { ClaudeCheck } from "./ClaudeCredentials.ts"
import { CliBuilds } from "./CliBuilds.ts"
import { DatabaseTest } from "./Database.ts"
import { Environments } from "./Environments.ts"
import { GitHub } from "./GitHub.ts"
import { GitHubApp } from "./GitHubApp.ts"
import { HubRoutes, HubServices, idleTimeoutSeconds, websocketOptions } from "./Hub.ts"
import {
  DefaultArchiveRetention,
  DefaultRepoAccessTtl,
  DefaultSleepAfter,
  HubConfig,
  type HubConfigInput,
} from "./HubConfig.ts"
import { drainFirst } from "./HubShutdown.ts"
import { HubVersion } from "./HubVersion.ts"
import { Members } from "./Members.ts"

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
  insecureCookies: false,
  devLoginName: "dev",
  sleepAfterMs: Duration.toMillis(DefaultSleepAfter),
  archiveRetentionMs: Duration.toMillis(DefaultArchiveRetention),
  repoAccessTtlMs: Duration.toMillis(DefaultRepoAccessTtl),
  secretsKey: Option.none(),
  // No web UI build: WebUi.test.ts makes its own.
  webDir: "/nonexistent/kndl/web",
  // No CLI builds: CliRoutes.test.ts gives its own.
  cliDir: "/nonexistent/kndl/cli",
}

/** The Hub's stores and services, and its database, which tests can reach into. */
export type Services = Layer.Success<typeof HubServices> | SqlClient.SqlClient | HubVersion

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
    /** The Hub's own version; this checkout's by default. */
    readonly hubVersion?: Layer.Layer<HubVersion>
    /** How Claude credentials are checked; by default as ClaudeCheck.layerTest, asking no one. */
    readonly claudeCheck?: Layer.Layer<ClaudeCheck>
    /** The CLI binaries the Hub serves; by default ones it never builds. */
    readonly cliBuilds?: Layer.Layer<CliBuilds>
  } = {},
): Promise<TestHub> {
  const layer = drainFirst(
    HttpRouter.serve(HubRoutes, { disableLogger: true, disableListenLog: true }),
  ).pipe(
    Layer.provideMerge(
      BunHttpServer.layer({
        hostname: "127.0.0.1",
        port: 0,
        idleTimeout: idleTimeoutSeconds,
        websocket: websocketOptions,
      }),
    ),
    Layer.provideMerge(options.github ?? GitHub.layer),
    Layer.provideMerge(HubServices),
    Layer.provideMerge(options.claudeCheck ?? ClaudeCheck.layerTest),
    Layer.provideMerge(options.githubApp ?? GitHubApp.layer),
    Layer.provideMerge(options.cliBuilds ?? CliBuilds.unused),
    Layer.provideMerge(options.hubVersion ?? HubVersion.layer),
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

/** A port nothing listens on, for now. */
export const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const server = createServer()
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      server.close(() =>
        typeof address === "object" && address
          ? resolve(address.port)
          : reject(new Error("no port")),
      )
    })
  })

const mainPath = new URL("./main.ts", import.meta.url).pathname

/**
 * The Hub as `bun run hub` runs it, in a child process, on the database file `database`, once it
 * answers `/health`, with `env` added to its environment. Fails, saying what it printed, if it exits
 * first. Kill `child` when done.
 */
export async function startHubProcess(database: string, env: Record<string, string> = {}) {
  const port = await freePort()
  const child = Bun.spawn(["bun", mainPath], {
    env: {
      ...process.env,
      ...env,
      HUB_DATABASE: database,
      HOST: "127.0.0.1",
      PORT: String(port),
    },
    stdout: "pipe",
    stderr: "pipe",
  })
  const url = `http://127.0.0.1:${port}`
  for (let attempt = 0; ; attempt++) {
    const up = await fetch(`${url}/health`).then(
      (response) => response.ok,
      () => false,
    )
    if (up) return { child, url }
    if (child.exitCode !== null) {
      const printed = (await child.stdout.text()) + (await child.stderr.text())
      throw new Error(`The Hub exited with ${child.exitCode}: ${printed}`)
    }
    if (attempt > 100) {
      child.kill("SIGKILL")
      throw new Error("The Hub didn't start")
    }
    await Bun.sleep(50)
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

/** The value of the cookie `name` a response set, if it set one. */
const setCookie = (response: Response, name: string) =>
  response.headers
    .getSetCookie()
    .map((cookie) => new RegExp(`^${name}=([^;]*)`).exec(cookie)?.[1])
    .find((value) => value !== undefined && value !== "")

/**
 * Signs in through the stand-in GitHub (GitHub.layerTest) with `code`, `good-code` by default, as
 * the web UI's /setup and /invite pages do with `ticket` (a Setup link's or Invite's secret) when
 * given, from the web UI at `origin`: the callback's response.
 */
export async function githubSignIn(
  hub: TestHub,
  options: { readonly ticket?: string; readonly code?: string; readonly origin?: string } = {},
): Promise<Response> {
  const { ticket, code = "good-code", origin = webOrigin } = options
  const cookies: Array<string> = []
  if (ticket !== undefined) {
    const handed = await fetch(`${hub.url}/auth/github/admission`, {
      method: "POST",
      headers: { origin, "content-type": "application/json" },
      body: JSON.stringify({ ticket }),
    })
    if (handed.status !== 204) throw new Error(`the ticket was answered ${handed.status}`)
    cookies.push(`kndl_oauth_admission=${setCookie(handed, "kndl_oauth_admission")}`)
  }
  const start = await fetch(`${hub.url}/auth/github`, { redirect: "manual" })
  const state = new URL(start.headers.get("location") ?? "").searchParams.get("state") ?? ""
  cookies.push(`kndl_oauth_state=${setCookie(start, "kndl_oauth_state")}`)
  return fetch(`${hub.url}/auth/github/callback?code=${code}&state=${encodeURIComponent(state)}`, {
    redirect: "manual",
    headers: { cookie: cookies.join("; ") },
  })
}

/** A new Setup link's secret for the Hub, as `kndl hub setup-link` makes. */
export const setupSecret = (hub: TestHub) =>
  hub.run(Effect.flatMap(Members, (members) => members.newSetupLink))

/** Signs in through the stand-in GitHub with a new Setup link, as the Hub's Owner. */
export const ownerSignIn = async (
  hub: TestHub,
  options: { readonly code?: string; readonly origin?: string } = {},
) => githubSignIn(hub, { ...options, ticket: await setupSecret(hub) })

/**
 * Gives `repo` its first Environment version, applied by `by` (someone signed in), as if a Test
 * build of `draft` had passed: a Repo needs one before its first Session (ADR 0009).
 */
export const seedEnvironment = (
  hub: TestHub,
  repo: string,
  by: string,
  draft: EnvironmentDraft = DefaultEnvironmentDraft,
) =>
  hub.run(
    Effect.gen(function* () {
      const environments = yield* Environments
      const prepared = yield* environments.prepare(repo, draft)
      const id = TestBuildId.make(`seed-${repo}`)
      yield* environments.recordTestBuild({
        id,
        repo,
        runnerId: RunnerId.make("seed"),
        digest: prepared.digest,
        startedBy: ParticipantId.make(by),
        startedAt: 0,
      })
      yield* environments.finishTestBuild(id, "Passed", 0)
      yield* environments.apply(repo, null, draft, ParticipantId.make(by), 0)
    }),
  )
