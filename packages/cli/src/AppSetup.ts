// Onboard's GitHub App step (issue #86): create the App on GitHub from claude-hub's manifest, or
// take the settings of one made by hand. AppManifest.ts decides what is sent and saved; this serves
// the page, waits for GitHub's redirect, trades its code for the App's credentials and saves the
// private key.
//
// The page is served by onboard itself, on a free port on 127.0.0.1, not by the Hub: onboard runs
// before the Hub does, and only loopback can be trusted with the redirect, whose code is the App's
// credentials. A browser on another machine reaches it through an SSH tunnel; one that can't reach
// it at all can't be redirected back either, so the address it lands on can be pasted instead.
import { randomBytes } from "node:crypto"
import { statSync } from "node:fs"
import { homedir, hostname } from "node:os"
import { isAbsolute, join, resolve } from "node:path"
import { appInstallUrl } from "@claude-hub/hub/src/AppPermissions.ts"
import { convertManifest } from "@claude-hub/hub/src/GitHubApp.ts"
import { Context, Effect, Redacted } from "effect"
import { FetchHttpClient } from "effect/http"
import {
  type AppOwner,
  type AppSettings,
  type AppSetupChoice,
  appKeyFile,
  appManifest,
  checkAppId,
  checkCredential,
  checkLogin,
  GitHubDotCom,
  type GitHubSite,
  landedPage,
  manifestPage,
  newAppUrl,
  readRedirect,
  settingsFromConversion,
} from "./AppManifest.ts"
import { fail } from "./Failure.ts"
import { writeFileWhole } from "./Host.ts"
import type { Layout } from "./Layout.ts"
import type { Platform } from "./Services.ts"
import { Shell, step } from "./Shell.ts"
import { Ui } from "./Ui.ts"

/** Where onboard finds GitHub: github.com, or a test's stand-in. */
export const GitHubSiteRef = Context.Reference<GitHubSite>("@claude-hub/cli/GitHubSite", {
  defaultValue: () => GitHubDotCom,
})

/** What onboard does about the GitHub App, once every question is answered. */
export type AppPlan =
  | { readonly _tag: "Keep" }
  | { readonly _tag: "Create"; readonly owner: AppOwner }
  | { readonly _tag: "Manual"; readonly settings: AppSettings }

export const AppSetupTitles = (hasApp: boolean): Record<AppSetupChoice, string> => ({
  create: "Create it on GitHub now, from claude-hub's manifest (in a browser)",
  manual: "Paste the settings of an App I made on GitHub myself",
  skip: hasApp
    ? "Keep the App hub.env has"
    : "Not now: GitHub sign-in stays off (`claude-hub onboard --github-app create` later)",
})

/** The questions for `choice`: whose App to create, or the settings of one made by hand. */
export const askAppPlan = (choice: AppSetupChoice) =>
  Effect.gen(function* () {
    const ui = yield* Ui
    if (choice === "skip") return { _tag: "Keep" } satisfies AppPlan
    if (!ui.interactive) {
      return yield* fail(
        choice === "create"
          ? "--github-app create needs a terminal: it waits for your browser, and asks whose App it is."
          : "--github-app manual needs a terminal, to paste the App's settings into.",
      )
    }
    if (choice === "create") {
      const kind = yield* ui.select({
        message: "Whose GitHub App?",
        choices: [
          { value: "Personal", label: "My own account's" },
          {
            value: "Organization",
            label: "An organization's I own",
            hint: "its Repos can then use it",
          },
        ],
      })
      if (kind === "Personal") {
        return { _tag: "Create", owner: { _tag: "Personal" } } satisfies AppPlan
      }
      const login = yield* ui.text({
        message: "The organization, as in github.com/<organization>",
        validate: checkLogin,
      })
      return {
        _tag: "Create",
        owner: { _tag: "Organization", login: login.trim() },
      } satisfies AppPlan
    }
    yield* ui.note(
      "From the App's settings on GitHub: its General page has the App ID and Client ID, generates a client secret, and generates a private key, which downloads a .pem file.",
      "The App's settings",
    )
    const appId = yield* ui.text({ message: "The App ID", validate: checkAppId })
    const clientId = yield* ui.text({ message: "The Client ID", validate: checkCredential })
    const clientSecret = yield* ui.password({
      message: "A client secret",
      validate: checkCredential,
    })
    const keyPath = yield* ui.text({
      message: "The private key's .pem file",
      validate: checkKeyFile,
    })
    const privateKeyPath = expandPath(keyPath)
    const mode = statSync(privateKeyPath).mode
    if ((mode & 0o077) !== 0) {
      yield* ui.log(
        "warn",
        `${privateKeyPath} is readable by others (mode ${(mode & 0o777).toString(8)}): \`chmod 600 ${privateKeyPath}\`.`,
      )
    }
    return {
      _tag: "Manual",
      settings: {
        appId: appId.trim(),
        clientId: clientId.trim(),
        clientSecret: Redacted.make(clientSecret.trim()),
        privateKeyPath,
      },
    } satisfies AppPlan
  })

/** The new App: its settings, with the private key saved, and where to install it. */
export interface CreatedApp {
  readonly settings: AppSettings
  readonly slug: string
  readonly installUrl: string
}

/**
 * Creates the App for the Hub at `hubUrl` on `owner`'s account: serves the page that hands GitHub
 * the manifest, waits for GitHub's redirect back (or the address it landed on, pasted), trades its
 * code for the App's credentials and saves the private key, 0600, in the home. In a dry run,
 * nothing: it only says what it would do.
 */
export const createApp = (layout: Layout, hubUrl: string, owner: AppOwner, on: Platform) =>
  Effect.scoped(
    Effect.gen(function* () {
      const ui = yield* Ui
      const shell = yield* Shell
      const site = yield* GitHubSiteRef
      if (shell.dryRun) {
        yield* ui.log(
          "info",
          `[dry run] the GitHub App isn't created: onboard would serve a page on 127.0.0.1 that sends GitHub claude-hub's manifest, for ${newAppUrl(site, owner, "…")}.`,
        )
        return undefined
      }

      const state = randomBytes(16).toString("hex")
      const page = yield* servePage((origin) => {
        const manifest = appManifest({
          hubUrl,
          redirectUrl: `${origin}${CreatedPath}`,
          machine: hostname(),
        })
        return manifestPage(newAppUrl(site, owner, state), manifest, owner)
      }, state)

      yield* ui.note(
        [
          `Open ${page.url} in a browser on this machine. It sends GitHub the App's manifest; create the App there, and GitHub sends the browser back here.`,
          `Over SSH, forward the port first, from your own machine: ssh -L ${page.port}:127.0.0.1:${page.port} ${hostname()}`,
          "Should the page GitHub sends you back to not load, paste its address below.",
        ].join("\n\n"),
        "Create the GitHub App",
      )
      const opener = browserOpener(on, process.env)
      if (opener !== undefined) {
        yield* shell
          .capture(step(opener, [page.url], { mayFail: true }))
          .pipe(Effect.ignore({ log: false }))
      }

      const pasted = ui
        .text({
          message: "Waiting for GitHub. Or paste the address it sent the browser to",
          validate: (value) => {
            const read = readRedirect(value, state)
            return read._tag === "Invalid" ? read.reason : undefined
          },
        })
        .pipe(
          Effect.map((value) => {
            const read = readRedirect(value, state)
            return read._tag === "Code" ? read.code : ""
          }),
        )
      const code = yield* Effect.raceFirst(page.code, pasted)

      const conversion = yield* ui.spin(
        "Fetching the new App's settings from GitHub",
        () =>
          convertManifest(code, site.api).pipe(
            Effect.provide(FetchHttpClient.layer),
            Effect.mapError((error) =>
              fail(
                `${error.message}. A code works once, within an hour: run \`claude-hub onboard --github-app create\` again, or delete the App on GitHub and paste another's settings with --github-app manual.`,
              ),
            ),
          ),
        (made) => `GitHub made the App ${made.slug} (ID ${made.id})`,
      )
      const keyPath = appKeyFile(layout.home.dir, conversion.id)
      yield* writeFileWhole(keyPath, Redacted.value(conversion.pem), 0o600)
      yield* ui.log("step", `saved its private key in ${keyPath}, readable only by you`)
      return {
        settings: settingsFromConversion(conversion, keyPath),
        slug: conversion.slug,
        installUrl: appInstallUrl({ htmlUrl: conversion.htmlUrl }),
      } satisfies CreatedApp
    }),
  )

/** Where GitHub's redirect lands on the page's server. */
const CreatedPath = "/github-app/created"

/**
 * Serves the manifest page on a free port on 127.0.0.1 until the scope closes. `code` is the code
 * of the first redirect back with `state`. Requests for any other host name are refused, so a web
 * page can't reach the server by pointing its own name at 127.0.0.1.
 */
const servePage = (page: (origin: string) => string, state: string) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const code = Promise.withResolvers<string>()
      const server: Bun.Server<undefined> = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch: (request): Response => {
          const url = new URL(request.url)
          const origin = `http://127.0.0.1:${server.port}`
          const host = request.headers.get("host")
          if (host !== `127.0.0.1:${server.port}` && host !== `localhost:${server.port}`) {
            return new Response("not found", { status: 404 })
          }
          if (request.method !== "GET") return new Response("not found", { status: 404 })
          if (url.pathname === "/") return htmlResponse(page(origin))
          if (url.pathname === CreatedPath) {
            const read = readRedirect(url.href, state)
            if (read._tag === "Code") code.resolve(read.code)
            return htmlResponse(landedPage(read._tag === "Code"), read._tag === "Code" ? 200 : 400)
          }
          return new Response("not found", { status: 404 })
        },
      })
      return {
        server,
        port: server.port ?? 0,
        url: `http://127.0.0.1:${server.port}/`,
        code: Effect.promise(() => code.promise),
      }
    }),
    ({ server }) => Effect.promise(() => server.stop(true)),
  )

const htmlResponse = (body: string, status = 200) =>
  new Response(body, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
    },
  })

/**
 * The command that opens a browser on this machine, when it has a desktop to open one on: `open`
 * on macOS; `xdg-open` on Linux with a display, unless over SSH, where the browser is elsewhere.
 */
export function browserOpener(
  on: Platform,
  env: Readonly<Record<string, string | undefined>>,
): string | undefined {
  if (env.SSH_CONNECTION || env.SSH_TTY) return undefined
  if (on === "darwin") return "open"
  return env.DISPLAY || env.WAYLAND_DISPLAY ? "xdg-open" : undefined
}

/** `~` and relative paths, from where onboard runs. */
function expandPath(path: string): string {
  const trimmed = path.trim()
  if (trimmed === "~" || trimmed.startsWith("~/")) return join(homedir(), trimmed.slice(1))
  return isAbsolute(trimmed) ? trimmed : resolve(trimmed)
}

/** Why `path` isn't a file onboard can point the Hub at, or `undefined` when it is. */
function checkKeyFile(path: string): string | undefined {
  try {
    return statSync(expandPath(path)).isFile() ? undefined : `${path} isn't a file.`
  } catch {
    return `There's no file at ${path}.`
  }
}
