import { ClaudeSubscriptionType, defaultRateLimitTier, type ClaudePlan } from "@kndl/protocol"
import { HomeConfig } from "@kndl/protocol/home"
import { Config, Context, Effect, Layer, Option } from "effect"

/** Where the Runner's credential is read from, as `RUNNER_CLAUDE_CREDENTIAL` says. */
export type CredentialSource =
  /** Unset: the setup-token where the Runner looks for one, else Claude Code's own login. */
  | { readonly _tag: "Auto" }
  /** A setup-token or API key in a generic macOS Keychain item, by its service name. */
  | { readonly _tag: "Keychain"; readonly service: string }
  /** A setup-token or API key in a file only the Runner's user can read. */
  | { readonly _tag: "File"; readonly path: string }
  /** Claude Code's own login on this host. */
  | { readonly _tag: "ClaudeCode" }
  /** None: a Session without its own credential can't run. */
  | { readonly _tag: "None" }

/** The Keychain item the Runner looks for a setup-token in, unless told another. */
export const DefaultKeychainService = "kndl-setup-token"

/** The file in the Runner's home it looks for one in, off macOS. */
export const DefaultTokenFile = "claude-token"

/**
 * Reads `RUNNER_CLAUDE_CREDENTIAL`: `auto`, `keychain`, `keychain:<service>`, `file:<path>`,
 * `claude-code` or `none`. Undefined for anything else.
 */
export function parseCredentialSource(text: string): CredentialSource | undefined {
  const value = text.trim()
  if (value === "auto") return { _tag: "Auto" }
  if (value === "none") return { _tag: "None" }
  if (value === "claude-code") return { _tag: "ClaudeCode" }
  if (value === "keychain") return { _tag: "Keychain", service: DefaultKeychainService }
  if (value.startsWith("keychain:") && value.length > "keychain:".length)
    return { _tag: "Keychain", service: value.slice("keychain:".length) }
  if (value.startsWith("file:") && value.length > "file:".length)
    return { _tag: "File", path: value.slice("file:".length) }
  return undefined
}

/** How the Runner's credential proxy and its own Claude credential are set up. */
export interface ProxySettings {
  /** The port the proxy listens on, on the host's loopback. */
  readonly port: number
  /** Where the Runner's own credential is read from, for Sessions without their own. */
  readonly credential: CredentialSource
  /** The plan the Runner's credential is on, when stated. */
  readonly plan: ClaudePlan | undefined
  /** The Runner's home, where the setup-token file is looked for off macOS. */
  readonly home: string
}

export class ProxyConfig extends Context.Service<ProxyConfig, ProxySettings>()(
  "@kndl/runner/ProxyConfig",
) {}

/** The proxy's port in an installed home, and in a checkout's dev home, so both can run. */
export const DefaultProxyPort = { installed: 7778, dev: 7779 } as const

/**
 * Reads the proxy's settings from the environment, beside RunnerConfigLive.
 *
 * | Variable | Default |
 * |---|---|
 * | `RUNNER_PROXY_PORT` | `7778`; `7779` in the dev home |
 * | `RUNNER_CLAUDE_CREDENTIAL` | the setup-token in Keychain item `kndl-setup-token` on macOS, or in `<home>/claude-token` elsewhere; else Claude Code's own login |
 * | `RUNNER_CLAUDE_PLAN` | the plan of the account in Claude Code's `.claude.json` |
 * | `RUNNER_CLAUDE_RATE_LIMIT_TIER` | Claude Code's for the plan: `default_claude_ai` for pro, `default_claude_max_5x` for max |
 */
export const ProxyConfigLive = Layer.effect(
  ProxyConfig,
  Effect.gen(function* () {
    const home = yield* HomeConfig
    const settings = yield* Config.all({
      port: Config.Port("RUNNER_PROXY_PORT").pipe(
        Config.withDefault(home.dev ? DefaultProxyPort.dev : DefaultProxyPort.installed),
      ),
      credential: Config.option(Config.NonEmptyString("RUNNER_CLAUDE_CREDENTIAL")),
      plan: Config.option(Config.schema(ClaudeSubscriptionType, "RUNNER_CLAUDE_PLAN")),
      tier: Config.option(Config.NonEmptyString("RUNNER_CLAUDE_RATE_LIMIT_TIER")),
    })
    const credential = Option.match(settings.credential, {
      onNone: (): CredentialSource | undefined => ({ _tag: "Auto" }),
      onSome: parseCredentialSource,
    })
    if (credential === undefined)
      return yield* Effect.die(
        new Error(
          "RUNNER_CLAUDE_CREDENTIAL must be auto, keychain, keychain:<service>, file:<path>, claude-code or none",
        ),
      )
    const plan = Option.map(settings.plan, (subscriptionType): ClaudePlan => {
      const tier = Option.getOrUndefined(settings.tier) ?? defaultRateLimitTier(subscriptionType)
      return tier === undefined ? { subscriptionType } : { subscriptionType, rateLimitTier: tier }
    })
    return ProxyConfig.of({
      port: settings.port,
      credential,
      plan: Option.getOrUndefined(plan),
      home: home.dir,
    })
  }),
)
