// Onboard's decisions, apart from asking: which roles a machine has, how browsers reach its Hub,
// and what that writes into `hub.env` and `runner.env`. Each answer comes from a flag, else from
// the existing env file (unless `--reset`), else from a question, or, with `--non-interactive`, a
// default or a failure. Cli.ts asks; this decides, and is tested.
import { isLoopback } from "@kndl/hub/src/HubConfig.ts"
import type { Role } from "./Layout.ts"

/** What onboard sets up: `--role`. */
export type RoleChoice = "hub" | "runner" | "both"

export const RoleChoices: ReadonlyArray<RoleChoice> = ["hub", "runner", "both"]

export function rolesOf(choice: RoleChoice): ReadonlyArray<Role> {
  return choice === "both" ? ["hub", "runner"] : [choice]
}

/** The roles a home is already set up for, from which env files exist. */
export function existingRole(hubEnv: boolean, runnerEnv: boolean): RoleChoice | undefined {
  if (hubEnv && runnerEnv) return "both"
  if (hubEnv) return "hub"
  if (runnerEnv) return "runner"
  return undefined
}

/**
 * Who reaches the Hub, `--reach`: only this machine (`local`), the local network over plain HTTP
 * (`lan`), or anyone through an HTTPS proxy or tunnel in front of it (`https`).
 */
export type Reach = "local" | "lan" | "https"

export const Reaches: ReadonlyArray<Reach> = ["local", "lan", "https"]

export const ReachTitles: Record<Reach, string> = {
  local: "Only this machine (127.0.0.1)",
  lan: "My local network, over plain HTTP (0.0.0.0)",
  https: "Behind HTTPS: a reverse proxy or tunnel in front of 127.0.0.1",
}

export const DefaultPort = 7777

/** The Hub's settings onboard decides. */
export interface HubChoices {
  readonly reach: Reach
  readonly port: number
  /** Where browsers reach the Hub: for `lan`, `http://<LAN address>:<port>`; for `https`, asked. */
  readonly publicUrl: string
  /** `lan` only: drop `Secure` from cookies, so sign-in works over plain HTTP. */
  readonly insecureCookies: boolean
  /** `local` only: sign in without GitHub, which the Hub allows only on loopback. */
  readonly devLogin: boolean
}

/** What an existing `hub.env` already answers. */
export function hubChoicesFrom(
  values: Readonly<Record<string, string>>,
): Partial<HubChoices> | undefined {
  const publicUrl = values.HUB_PUBLIC_URL
  if (publicUrl === undefined) return undefined
  const port = Number(values.PORT ?? DefaultPort)
  const url = parseUrl(publicUrl)
  const reach: Reach =
    url?.protocol === "https:"
      ? "https"
      : values.HOST !== undefined && !isLoopback(values.HOST)
        ? "lan"
        : "local"
  return {
    reach,
    port: Number.isSafeInteger(port) ? port : DefaultPort,
    publicUrl,
    insecureCookies: truthy(values.HUB_INSECURE_COOKIES),
    devLogin: truthy(values.KNDL_DEV_LOGIN),
  }
}

/** The public URL for `local` and `lan`; `https` is always asked. */
export function defaultPublicUrl(reach: Reach, port: number, address: string | undefined) {
  if (reach === "local") return `http://127.0.0.1:${port}`
  if (reach === "lan" && address !== undefined) return `http://${address}:${port}`
  return undefined
}

/** Why `url` can't be the Hub's public URL for `reach`, or `undefined` when it can. */
export function checkPublicUrl(reach: Reach, url: string): string | undefined {
  const parsed = parseUrl(url)
  if (parsed === undefined || (parsed.protocol !== "http:" && parsed.protocol !== "https:")) {
    return `${url} isn't an http or https URL.`
  }
  if (reach === "https" && parsed.protocol !== "https:") {
    return `Behind HTTPS, the public URL starts with https://, not ${parsed.protocol}//.`
  }
  if (parsed.pathname !== "/" || parsed.search !== "" || parsed.hash !== "") {
    return `The public URL is an origin, with no path: ${parsed.origin}.`
  }
  return undefined
}

/** What onboard writes into `hub.env`; `undefined` removes a variable. Others stay as they are. */
export function hubEnvUpdates(
  choices: HubChoices,
  secretsKey: string,
): Record<string, string | undefined> {
  const lan = choices.reach === "lan"
  return {
    HOST: lan ? "0.0.0.0" : "127.0.0.1",
    PORT: String(choices.port),
    HUB_PUBLIC_URL: new URL(choices.publicUrl).origin,
    HUB_INSECURE_COOKIES: lan && choices.insecureCookies ? "1" : undefined,
    KNDL_DEV_LOGIN: choices.reach === "local" && choices.devLogin ? "1" : undefined,
    HUB_SECRETS_KEY: secretsKey,
  }
}

/** The Hub's URL from its own machine: loopback, whichever address it listens on. */
export const localHubUrl = (port: number) => `http://127.0.0.1:${port}`

/** What onboard writes into `runner.env`. */
export function runnerEnvUpdates(choices: {
  readonly hubUrl: string
  readonly token: string
  readonly name: string | undefined
}): Record<string, string | undefined> {
  return {
    HUB_URL: new URL(choices.hubUrl).origin,
    RUNNER_TOKEN: choices.token,
    ...(choices.name === undefined ? {} : { RUNNER_NAME: choices.name }),
  }
}

/** Why `token` isn't a Runner token, or `undefined` when it looks like one. */
export function checkRunnerToken(token: string): string | undefined {
  return /^chr_\S+$/.test(token.trim())
    ? undefined
    : "A Runner token starts with chr_: issue one on the Hub's machine with `kndl runner token <name>`."
}

/**
 * This machine's address on the local network, for a `lan` Hub: the first private IPv4 address of
 * an interface that's up, preferring 192.168/16, then 10/8, then 172.16/12.
 */
export function lanAddress(
  interfaces: Readonly<
    Record<
      string,
      | ReadonlyArray<{
          readonly address: string
          readonly family: string | number
          readonly internal: boolean
        }>
      | undefined
    >
  >,
): string | undefined {
  const candidates = Object.values(interfaces)
    .flatMap((entries) => entries ?? [])
    .filter((entry) => !entry.internal && (entry.family === "IPv4" || entry.family === 4))
    .map((entry) => entry.address)
  return candidates
    .filter((address) => privateRank(address) < 3)
    .toSorted((a, b) => privateRank(a) - privateRank(b))[0]
}

/** 0 to 2 for the private ranges, in the order `lanAddress` prefers them; 3 for any other. */
function privateRank(address: string): number {
  if (address.startsWith("192.168.")) return 0
  if (address.startsWith("10.")) return 1
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(address)) return 2
  return 3
}

/** Where an onboard answer comes from: given, to be asked, or missing in a non-interactive run. */
export type Answer<A> =
  | { readonly _tag: "Given"; readonly value: A }
  | { readonly _tag: "Ask" }
  | { readonly _tag: "Missing" }

/**
 * An onboard answer: the flag's, else the existing setting's (which `--reset` ignores), else a
 * question. Without a terminal to ask on, or with `--non-interactive`, a yes-or-no answer takes its
 * default, and any other is missing, which fails onboard.
 */
export function pickAnswer<A>(options: {
  readonly flag: A | undefined
  readonly existing: A | undefined
  readonly reset: boolean
  readonly interactive: boolean
  readonly fallback?: A | undefined
}): Answer<A> {
  if (options.flag !== undefined) return { _tag: "Given", value: options.flag }
  if (options.existing !== undefined && !options.reset) {
    return { _tag: "Given", value: options.existing }
  }
  if (options.interactive) return { _tag: "Ask" }
  if (options.fallback !== undefined) return { _tag: "Given", value: options.fallback }
  return { _tag: "Missing" }
}

function parseUrl(text: string): URL | undefined {
  try {
    return new URL(text)
  } catch {
    return undefined
  }
}

function truthy(value: string | undefined): boolean {
  return value !== undefined && /^(?:1|true|yes|on)$/i.test(value.trim())
}
