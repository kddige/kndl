// `claude-hub login`, `logout` and `whoami` (issue #179, ADR 0016): signing the CLI in to a Hub
// with a CLI token, for the commands that act on the Hub as someone (`claude-hub forward`, #177).
//
// Login opens the Hub's `/cli-login` page in a browser, where a signed-in person approves this
// machine. The page sends the browser back to the CLI on a `localhost` port with a one-time Login
// code, and the CLI trades the code, with the PKCE verifier only it knows, for a CLI token. When
// the browser is elsewhere, as over SSH or with `--no-browser`, the page shows the code instead,
// to paste here. The token goes in the CLI's config (CliConfig.ts), 0600, and is never printed.
import { createHash, randomBytes } from "node:crypto"
import { hostname } from "node:os"
import {
  CliLoginCodeLifetimeMs,
  CliSignedIn,
  CliWhoAmI,
  normalizeCliLoginCode,
} from "@claude-hub/protocol"
import { Console, Duration, Effect, Option, Schema } from "effect"
import { browserOpener } from "./AppSetup.ts"
import { readCliConfig, writeCliConfig } from "./CliConfig.ts"
import { type CliFailure, fail } from "./Failure.ts"
import { shortHostname } from "./Join.ts"
import type { Platform } from "./Services.ts"
import { Shell, step } from "./Shell.ts"
import { Ui } from "./Ui.ts"

/** What login, logout and whoami need of the machine, given so tests can stand in for it. */
export interface LoginContext {
  /** Where the CLI's config is (cliConfigPath). */
  readonly configPath: string
  readonly env: Readonly<Record<string, string | undefined>>
  readonly platform: Platform | undefined
  /** This machine's name, which the CLI token is named after. */
  readonly machine: string
}

export const loginContext = (configPath: string): LoginContext => ({
  configPath,
  env: process.env,
  platform:
    process.platform === "darwin" || process.platform === "linux" ? process.platform : undefined,
  machine: shortHostname(hostname()),
})

/** Whether the CLI runs over SSH, where a browser that opens is on another machine. */
export const overSsh = (env: Readonly<Record<string, string | undefined>>) =>
  Boolean(env.SSH_CONNECTION || env.SSH_CLIENT || env.SSH_TTY)

/** A Hub's origin from what was typed: `hub.example.com` is read as https. */
export function hubOrigin(text: string): string | undefined {
  const trimmed = text.trim()
  if (trimmed === "") return undefined
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`)
    return url.protocol === "http:" || url.protocol === "https:" ? url.origin : undefined
  } catch {
    return undefined
  }
}

/** A PKCE verifier (RFC 7636) and its S256 challenge. */
export function newPkce(random: (size: number) => Uint8Array = randomBytes) {
  const verifier = Buffer.from(random(32)).toString("base64url")
  const challenge = createHash("sha256").update(verifier).digest("base64url")
  return { verifier, challenge }
}

/** The `/cli-login` page for this machine: with the port and state to send the code back to. */
export function loginPageUrl(
  hub: string,
  request: {
    readonly machine: string
    readonly challenge: string
    readonly callback?: { readonly port: number; readonly state: string }
  },
): string {
  const url = new URL("/cli-login", hub)
  url.searchParams.set("machine", request.machine)
  url.searchParams.set("challenge", request.challenge)
  if (request.callback !== undefined) {
    url.searchParams.set("port", String(request.callback.port))
    url.searchParams.set("state", request.callback.state)
  }
  return url.href
}

/** Where the page sends the browser back to, on the CLI's port. */
export const CallbackPath = "/callback"

const HubTimeoutMs = 15_000

const decodeSignedIn = Schema.decodeUnknownOption(CliSignedIn)
const decodeWhoAmI = Schema.decodeUnknownOption(CliWhoAmI)

const jsonOf = (response: Response): Promise<unknown> => response.json().catch(() => undefined)

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

/** The Hub's `{ error }`, or `undefined` when it didn't answer one. */
function hubError(body: unknown): string | undefined {
  if (typeof body !== "object" || body === null || !("error" in body)) return undefined
  return typeof body.error === "string" ? body.error : undefined
}

/** What became of trading a Login code. */
type Exchange =
  | { readonly _tag: "SignedIn"; readonly signedIn: CliSignedIn }
  | { readonly _tag: "Refused"; readonly message: string }

/** Trades a Login code and the verifier for a CLI token. Fails only when the Hub can't be reached. */
const exchange = (hub: string, code: string, verifier: string) =>
  Effect.tryPromise({
    try: async (): Promise<Exchange> => {
      const response = await fetch(new URL("/auth/cli/token", hub), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code, verifier }),
        signal: AbortSignal.timeout(HubTimeoutMs),
      })
      const body = await jsonOf(response)
      const signedIn = response.status === 200 ? decodeSignedIn(body) : Option.none()
      if (Option.isSome(signedIn)) return { _tag: "SignedIn", signedIn: signedIn.value }
      return {
        _tag: "Refused",
        message: hubError(body) ?? `${hub} answered ${response.status} to the sign-in.`,
      }
    },
    catch: (error) => fail(`Couldn't reach the Hub at ${hub} (${messageOf(error)}).`),
  })

/** What a Hub says of a CLI token. */
export type TokenCheck =
  | { readonly _tag: "SignedIn"; readonly who: CliWhoAmI }
  | { readonly _tag: "Refused" }
  | { readonly _tag: "Unreachable"; readonly detail: string }

export const checkToken = (hub: string, token: string) =>
  Effect.promise(async (): Promise<TokenCheck> => {
    try {
      const response = await fetch(new URL("/auth/cli/me", hub), {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(HubTimeoutMs),
      })
      if (response.status === 401) return { _tag: "Refused" }
      const who = decodeWhoAmI(await jsonOf(response))
      if (response.status === 200 && Option.isSome(who)) return { _tag: "SignedIn", who: who.value }
      return { _tag: "Unreachable", detail: `it answered ${response.status}` }
    } catch (error) {
      return { _tag: "Unreachable", detail: messageOf(error) }
    }
  })

/** Revokes a CLI token at its Hub: whether it is gone, which it is too if the Hub refused it. */
export const revokeToken = (hub: string, token: string) =>
  Effect.promise(
    async (): Promise<{
      readonly revoked: boolean
      readonly detail?: string
    }> => {
      try {
        const response = await fetch(new URL("/auth/cli/sign-out", hub), {
          method: "POST",
          headers: { authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(HubTimeoutMs),
        })
        if (response.status === 204 || response.status === 401) return { revoked: true }
        return { revoked: false, detail: `it answered ${response.status}` }
      } catch (error) {
        return { revoked: false, detail: messageOf(error) }
      }
    },
  )

const textResponse = (text: string, status: number) =>
  new Response(`${text}\n`, {
    status,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
    },
  })

/**
 * Serves the callback on a free port on 127.0.0.1 until the scope closes. `code` is the Login code
 * of the first request back with `state`. Its answer waits for `settle`: the browser goes on to the
 * Hub's done page, or is told why not. Requests for any other host name are refused, so a web page
 * can't reach the server by pointing its own name at 127.0.0.1.
 */
const serveCallback = (state: string) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const code = Promise.withResolvers<string>()
      const outcome = Promise.withResolvers<Response>()
      let taken = false
      const server: Bun.Server<undefined> = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch: async (request): Promise<Response> => {
          const url = new URL(request.url)
          const host = request.headers.get("host")
          if (host !== `127.0.0.1:${server.port}` && host !== `localhost:${server.port}`) {
            return new Response("not found", { status: 404 })
          }
          if (request.method !== "GET" || url.pathname !== CallbackPath) {
            return new Response("not found", { status: 404 })
          }
          const given = url.searchParams.get("code")
          if (url.searchParams.get("state") !== state || given === null) {
            return textResponse(
              "This isn't the sign-in claude-hub login is waiting for. Run claude-hub login again.",
              400,
            )
          }
          if (taken) return textResponse("claude-hub login already has a code.", 409)
          taken = true
          code.resolve(given)
          return outcome.promise
        },
      })
      return {
        server,
        port: server.port ?? 0,
        code: Effect.promise(() => code.promise),
        settle: (response: Response) => Effect.sync(() => outcome.resolve(response)),
        stop: () =>
          Effect.andThen(
            Effect.sync(() =>
              outcome.resolve(textResponse("claude-hub login stopped waiting.", 410)),
            ),
            Effect.promise(() => server.stop(false)),
          ),
      }
    }),
    ({ stop }) => stop(),
  )

const codeProblem = (value: string) =>
  normalizeCliLoginCode(value) === undefined
    ? "That isn't a whole code: 16 letters and digits, such as ABCD-EFGH-JKMN-PQRS."
    : undefined

/** Gives up waiting once a Login code would have expired. */
const withDeadline = <A, E, R>(effect: Effect.Effect<A, E | CliFailure, R>) =>
  effect.pipe(
    Effect.timeoutOrElse({
      duration: Duration.millis(CliLoginCodeLifetimeMs),
      orElse: () =>
        Effect.fail(fail("Gave up waiting for the sign-in. Run claude-hub login again.")),
    }),
  )

/** What a pasted code answers the browser with: nothing, as the browser isn't waiting. */
const browserNotWaiting = (_response: Response): Effect.Effect<void> => Effect.void

/** How many times a pasted code is asked for, when the Hub refuses it. */
const PasteTries = 3

/**
 * Signs the CLI in to `hub` (or the Hub its config names), replacing any CLI token it had: the old
 * one is revoked, if its Hub can be reached.
 */
export const login = (
  options: { readonly hub: string | undefined; readonly noBrowser: boolean },
  on: LoginContext,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const ui = yield* Ui
      const shell = yield* Shell
      const before = readCliConfig(on.configPath)
      const given = options.hub ?? before.hub
      if (given === undefined) {
        return yield* fail("Say which Hub to sign in to: claude-hub login <hub-url>")
      }
      const hub = hubOrigin(given)
      if (hub === undefined) return yield* fail(`${given} isn't a Hub's http:// or https:// URL.`)

      const { verifier, challenge } = newPkce()
      const pasteOnly = options.noBrowser || overSsh(on.env)
      if (pasteOnly && !ui.interactive) {
        return yield* fail(
          "claude-hub login needs a terminal to paste the code into. Run it in one, or without --no-browser on a machine with a browser.",
        )
      }
      const askForCode = (message: string) => ui.text({ message, validate: codeProblem })

      // The code, whether the browser brought it, and what to answer the browser with if it did.
      let code: string
      let fromBrowser = false
      let answerBrowser = browserNotWaiting
      if (pasteOnly) {
        const url = loginPageUrl(hub, { machine: on.machine, challenge })
        yield* ui.note(
          [
            `Open ${url} in a browser where you can sign in to the Hub, and approve claude-hub on ${on.machine}.`,
            "The page then shows a code: paste it here.",
          ].join("\n\n"),
          "Sign in to the Hub",
        )
        code = yield* withDeadline(askForCode("Paste the code the page shows"))
      } else {
        const state = randomBytes(16).toString("hex")
        const callback = yield* serveCallback(state)
        answerBrowser = callback.settle
        const url = loginPageUrl(hub, {
          machine: on.machine,
          challenge,
          callback: { port: callback.port, state },
        })
        const opener = browserOpener(on.platform ?? "linux", on.env)
        yield* ui.note(
          [
            opener === undefined
              ? `Open ${url} in a browser on this machine, and approve claude-hub on ${on.machine}.`
              : `Opening ${url} in your browser: approve claude-hub on ${on.machine} there.`,
            "If the browser can't come back here once you approve, go back a page there: it shows a code to paste here.",
          ].join("\n\n"),
          "Sign in to the Hub",
        )
        if (opener !== undefined) {
          yield* shell
            .capture(step(opener, [url], { mayFail: true }))
            .pipe(Effect.ignore({ log: false }))
        }
        const pasted = ui.interactive
          ? askForCode("Waiting for the browser. Or paste the code the page shows")
          : Effect.never
        const came = yield* withDeadline(
          Effect.raceFirst(
            Effect.map(callback.code, (value) => ({ value, fromBrowser: true })),
            Effect.map(pasted, (value) => ({ value, fromBrowser: false })),
          ),
        )
        code = came.value
        fromBrowser = came.fromBrowser
      }

      let traded = yield* exchange(hub, code, verifier)
      // A code mistyped matches none, so the one the page shows still works: ask again. A code
      // the browser brought wasn't typed, so it isn't asked for again.
      const tries = fromBrowser ? 1 : PasteTries
      for (let tried = 1; tried < tries; tried++) {
        if (traded._tag === "SignedIn") break
        yield* ui.log("warn", traded.message)
        const again = yield* withDeadline(
          askForCode("Paste the code again, or approve again on the page for a new one"),
        )
        traded = yield* exchange(hub, again, verifier)
      }
      if (traded._tag === "Refused") {
        yield* answerBrowser(textResponse(traded.message, 400))
        return yield* fail(traded.message)
      }

      const { signedIn } = traded
      yield* writeCliConfig(on.configPath, { hub, token: signedIn.token })
      const done = new URL("/cli-login/done", hub)
      done.searchParams.set("machine", signedIn.machine)
      yield* answerBrowser(Response.redirect(done.href, 302))
      if (before.token !== undefined && before.token !== signedIn.token) {
        yield* revokeToken(before.hub ?? hub, before.token)
      }
      yield* ui.log(
        "success",
        `Signed in to ${hub} as ${signedIn.you.login}, on ${signedIn.machine}. The CLI token is in ${on.configPath}, readable only by you.`,
      )
      if (before.hub !== undefined && before.hub !== hub) {
        yield* ui.log("info", `The CLI now updates itself from ${hub}, not ${before.hub}.`)
      }
    }),
  )

/** Signs the CLI out: revokes its token at the Hub, and forgets it. The Hub it updates from stays. */
export const logout = (on: LoginContext) =>
  Effect.gen(function* () {
    const config = readCliConfig(on.configPath)
    if (config.token === undefined) {
      yield* Console.log("The CLI isn't signed in to a Hub.")
      return
    }
    const { token, ...rest } = config
    const revoked =
      rest.hub === undefined
        ? { revoked: false, detail: "no Hub is recorded" }
        : yield* revokeToken(rest.hub, token)
    yield* writeCliConfig(on.configPath, rest)
    if (revoked.revoked) {
      yield* Console.log(
        `Signed out of ${rest.hub}: the CLI token is revoked, and gone from this machine.`,
      )
    } else {
      yield* Console.error(
        `Couldn't revoke the CLI token at ${rest.hub ?? "the Hub"} (${revoked.detail}). It is gone from this machine; revoke ${on.machine} under CLI tokens on your Account page too.`,
      )
    }
  })

/** Says which Hub the CLI is signed in to, and as whom. Fails when it isn't, or can't say. */
export const whoami = (on: LoginContext) =>
  Effect.gen(function* () {
    const config = readCliConfig(on.configPath)
    if (config.token === undefined || config.hub === undefined) {
      return yield* fail("The CLI isn't signed in to a Hub: run claude-hub login <hub-url>")
    }
    const check = yield* checkToken(config.hub, config.token)
    switch (check._tag) {
      case "Refused":
        return yield* fail(
          `${config.hub} doesn't accept this machine's CLI token: it was revoked. Run claude-hub login to sign in again.`,
        )
      case "Unreachable":
        return yield* fail(`Couldn't reach the Hub at ${config.hub} (${check.detail}).`)
      case "SignedIn": {
        const { you, machine, createdAt } = check.who
        const name = you.name === you.login ? you.login : `${you.login} (${you.name})`
        yield* Console.log(
          [
            `Hub:     ${config.hub}`,
            `Account: ${name}`,
            `Machine: ${machine}, signed in ${new Date(createdAt).toISOString().slice(0, 10)}`,
          ].join("\n"),
        )
      }
    }
  })
