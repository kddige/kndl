// The GitHub App, as onboard registers it from a manifest (issue #86): the manifest, from the
// Hub's required permissions (AppPermissions.ts); the local page that hands it to GitHub; the
// redirect GitHub sends the browser back with; and what the new App's credentials write into
// `hub.env`. Pure and tested; AppSetup.ts serves the page and talks to GitHub.
//
// GitHub's manifest flow: a form POSTs the manifest to GitHub's "new App" page, for the person's
// account or an organization. They name the App there and create it, and GitHub redirects the
// browser to the manifest's `redirect_url` with a one-time `code`, which `POST
// /app-manifests/{code}/conversions` trades for the App's id, client id and secret, and private key.
import { join } from "node:path"
import { manifestPermissions, RequiredEvents } from "@kndl/hub/src/AppPermissions.ts"
import type { ManifestConversion } from "@kndl/hub/src/GitHubApp.ts"
import { Redacted } from "effect"

/** GitHub's web and API origins: github.com unless a test points them elsewhere. */
export interface GitHubSite {
  readonly web: URL
  readonly api: URL
}

export const GitHubDotCom: GitHubSite = {
  web: new URL("https://github.com"),
  api: new URL("https://api.github.com"),
}

/** Whose App it is: the person's own account, or an organization they own. */
export type AppOwner =
  | { readonly _tag: "Personal" }
  | { readonly _tag: "Organization"; readonly login: string }

/** The manifest's fields that kndl sets; the rest take GitHub's defaults. */
export interface AppManifest {
  readonly name: string
  readonly url: string
  readonly description: string
  readonly redirect_url: string
  readonly callback_urls: ReadonlyArray<string>
  readonly public: boolean
  readonly request_oauth_on_install: boolean
  readonly default_permissions: Readonly<Record<string, string>>
  readonly default_events: ReadonlyArray<string>
}

/** The longest name GitHub takes for an App. */
const NameLength = 34

/**
 * The App's manifest, for the Hub at `hubUrl`. GitHub sends the browser back to `redirectUrl` once
 * the App is made, and sign-in back to the Hub's `/auth/github/callback`. No webhook: the Hub has
 * none, and with no `hook_attributes` GitHub makes the App without one. Only the account it is
 * made on can install it.
 */
export function appManifest(options: {
  readonly hubUrl: string
  readonly redirectUrl: string
  readonly machine: string
}): AppManifest {
  const hub = new URL(options.hubUrl).origin
  return {
    name: appName(options.machine),
    url: hub,
    description: `kndl at ${hub}: coding-agent Sessions on its Runners, watched and driven together.`,
    redirect_url: options.redirectUrl,
    callback_urls: [`${hub}/auth/github/callback`],
    public: false,
    request_oauth_on_install: false,
    default_permissions: manifestPermissions(),
    default_events: RequiredEvents,
  }
}

/** A name for the App: `kndl-<machine>`, as GitHub takes it. It can be changed on GitHub. */
export function appName(machine: string): string {
  const host = machine
    .split(".")[0]
    ?.toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
  return (host ? `kndl-${host}` : "kndl").slice(0, NameLength).replace(/-+$/, "")
}

/** GitHub's page that makes an App from a manifest POSTed to it, for `owner`. */
export function newAppUrl(site: GitHubSite, owner: AppOwner, state: string): string {
  const path =
    owner._tag === "Organization"
      ? `/organizations/${encodeURIComponent(owner.login)}/settings/apps/new`
      : "/settings/apps/new"
  const url = new URL(path, site.web)
  url.searchParams.set("state", state)
  return url.href
}

/** Why `login` isn't a GitHub account name, or `undefined` when it can be. */
export function checkLogin(login: string): string | undefined {
  return /^[A-Za-z0-9](?:-?[A-Za-z0-9]){0,38}$/.test(login.trim())
    ? undefined
    : "A GitHub organization's name: letters, digits and single hyphens, as in github.com/<name>."
}

/**
 * The local page that hands the manifest to GitHub: a form POSTed as soon as it loads, with a
 * button for a browser that doesn't run its script.
 */
export function manifestPage(action: string, manifest: AppManifest, owner: AppOwner): string {
  const where = owner._tag === "Organization" ? `the ${owner.login} organization` : "your account"
  const permissions = Object.entries(manifest.default_permissions)
    .map(([name, access]) => `<li><code>${html(name)}</code>: ${html(access)}</li>`)
    .join("")
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>kndl: create the GitHub App</title>
<style>
body { font: 15px/1.5 system-ui, sans-serif; max-width: 34rem; margin: 3rem auto; padding: 0 1rem; color: #1f2328; background: #fff; }
button { font: inherit; padding: 0.5rem 1rem; border-radius: 6px; border: 1px solid #1f883d; background: #1f883d; color: #fff; cursor: pointer; }
code { font-size: 0.9em; }
@media (prefers-color-scheme: dark) { body { color: #e6edf3; background: #0d1117; } }
</style>
</head>
<body>
<h1>Create the GitHub App</h1>
<p>This sends GitHub the kndl App's manifest, to create <strong>${html(manifest.name)}</strong> on ${html(where)}, for the Hub at <code>${html(manifest.url)}</code>, with these permissions:</p>
<ul>${permissions}</ul>
<p>On GitHub you can change its name, then create it. GitHub sends you back here, and <code>kndl onboard</code> finishes in the terminal.</p>
<form id="manifest" method="post" action="${html(action)}">
<input type="hidden" name="manifest" value="${html(JSON.stringify(manifest))}">
<button type="submit">Continue to GitHub</button>
</form>
<script>document.getElementById("manifest").submit()</script>
</body>
</html>
`
}

/** The page GitHub's redirect lands on once the App is made. */
export function landedPage(ok: boolean): string {
  const message = ok
    ? "GitHub created the App. Go back to the terminal: <code>kndl onboard</code> saves its settings."
    : "This isn't the redirect onboard is waiting for: it's from another attempt, or has no code. Start again from the terminal."
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>kndl: the GitHub App</title>
<style>body { font: 15px/1.5 system-ui, sans-serif; max-width: 34rem; margin: 3rem auto; padding: 0 1rem; }</style>
</head>
<body><p>${message}</p></body>
</html>
`
}

/** The code GitHub redirected back with, from what a person pasted. */
export type Redirected =
  | { readonly _tag: "Code"; readonly code: string }
  | { readonly _tag: "Invalid"; readonly reason: string }

/**
 * What GitHub's redirect carries: the address the browser landed on, with its `code` and `state`,
 * or the code alone. A `state` other than `state` is another attempt's.
 */
export function readRedirect(pasted: string, state: string): Redirected {
  const text = pasted.trim()
  if (/^[A-Za-z0-9_-]{8,}$/.test(text)) return { _tag: "Code", code: text }
  let url: URL
  try {
    url = new URL(text)
  } catch {
    return {
      _tag: "Invalid",
      reason: "Paste the whole address GitHub sent the browser to, or the code in it.",
    }
  }
  const code = url.searchParams.get("code")
  if (code === null || code === "") {
    return { _tag: "Invalid", reason: "That address has no code= in it." }
  }
  if (url.searchParams.get("state") !== state) {
    return { _tag: "Invalid", reason: "That address is from another attempt: its state differs." }
  }
  return { _tag: "Code", code }
}

/** Where the new App's private key goes: `<home>/github-app-<id>.pem`. */
export const appKeyFile = (homeDir: string, appId: number | string) =>
  join(homeDir, `github-app-${appId}.pem`)

/** What an App's settings write into `hub.env`. Secrets are Redacted until here. */
export interface AppSettings {
  readonly appId: string
  readonly clientId: string
  readonly clientSecret: Redacted.Redacted<string>
  readonly privateKeyPath: string
  readonly webhookSecret?: Redacted.Redacted<string> | undefined
}

/** The App's settings from GitHub's conversion, its key saved at `privateKeyPath`. */
export const settingsFromConversion = (
  conversion: ManifestConversion,
  privateKeyPath: string,
): AppSettings => ({
  appId: String(conversion.id),
  clientId: conversion.clientId,
  clientSecret: conversion.clientSecret,
  privateKeyPath,
  webhookSecret:
    conversion.webhookSecret._tag === "Some" ? conversion.webhookSecret.value : undefined,
})

/**
 * What the App's settings write into `hub.env`: its id and private key for tokens, and its client
 * id and secret for GitHub sign-in. A webhook secret only an App with a webhook has; the Hub
 * doesn't use one yet.
 */
export function appEnvUpdates(settings: AppSettings): Record<string, string | undefined> {
  return {
    GITHUB_APP_ID: settings.appId,
    GITHUB_APP_PRIVATE_KEY_PATH: settings.privateKeyPath,
    GITHUB_CLIENT_ID: settings.clientId,
    GITHUB_CLIENT_SECRET: Redacted.value(settings.clientSecret),
    GITHUB_WEBHOOK_SECRET:
      settings.webhookSecret === undefined ? undefined : Redacted.value(settings.webhookSecret),
  }
}

/** Why `value` isn't a GitHub App's id, or `undefined` when it can be. */
export const checkAppId = (value: string) =>
  /^\d+$/.test(value.trim()) ? undefined : "The App ID is a number, on the App's General page."

/** Why `value` isn't a GitHub App's client id or secret, or `undefined` when it can be. */
export const checkCredential = (value: string) =>
  /^\S+$/.test(value.trim()) ? undefined : "Paste it as GitHub shows it, with no spaces."

/** How onboard sets up the GitHub App: `--github-app`. */
export type AppSetupChoice = "create" | "manual" | "skip"

export const AppSetupChoices: ReadonlyArray<AppSetupChoice> = ["create", "manual", "skip"]

function html(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;")
}
