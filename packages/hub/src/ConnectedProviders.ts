// Each Member's Connected providers (ADR 0029): their own accounts at the Providers pi-ai serves
// (PiProviders.ts), held on the Hub, which the pi Sessions they create run on through the Gateway
// (GatewayRoutes.ts).
//
// - Connecting: with an API key, which the Hub lists the Provider's Models with first, refusing a
//   key the Provider rejects; or by signing in with a subscription, through pi-ai's own flow, run
//   on the Hub (ProviderRelay.ts passes its steps on). Sign in with ChatGPT, and OpenRouter's,
//   end on `127.0.0.1` on the Hub's machine, which the Member's browser can't reach: they paste
//   the address it landed on instead. GitHub Copilot's asks which GitHub first, as a choice. One
//   per Member and Provider: connecting again replaces it.
// - Storing: pi-ai's credential JSON, encrypted as a Claude credential is (Secrets.ts), bound to
//   its owner and Provider. Write-only: its owner sees its kind and a label (the account the
//   sign-in named, or an API key's last 4 characters), never a token. A row the Hub can't decrypt
//   is taken as none.
// - A sign-in's tokens are refreshed for a call when they expire within 5 minutes, and once after
//   the Provider refused them, one refresh at a time per credential, and the rotated credential is
//   kept. A refresh the Provider refuses is the connection's `problem`: its Member connects it
//   again on the Account page, and until then its Models aren't theirs.
// - The Models: the Hub asks the Provider under the account on connecting, when its Member asks,
//   and when its copy is a day old (off the call that found it so). It keeps those pi-ai's built-in
//   catalogue knows, which the Runner's pi was built with. A Provider that doesn't list them, or
//   can't now, keeps those it listed before, or else offers all of the catalogue's, and its
//   `modelsProblem` says which. Claude's come from Anthropic under the
//   Member's Claude credential (ClaudeCredentials.ts), kept the same way, and are the catalogue's
//   current ones when Anthropic can't say.
// - Every key and token, and every one replaced or forgotten since the Hub started, until a
//   sign-in's expires, is masked in what Sessions print (Redaction.ts), as Claude credentials are.
// - Removing a Member forgets theirs.
// - Each Member chooses which Harness runs Claude's Models in their new Sessions (ADR 0030): Claude
//   Code unless they chose pi, kept with them as a Participant.

import { randomUUID } from "node:crypto"
import type {
  AuthEvent,
  AuthPrompt,
  Credential,
  LoginOptions,
  ModelAuth,
  OAuthCredential,
  ProviderAuthInteraction,
} from "@earendil-works/pi-ai"
import {
  type ConnectableProvider,
  type ConnectedProvider,
  type ConnectionKind,
  type Harness,
  type ModelProvider,
  type ParticipantId,
  type ProviderId,
  ProviderIds,
  ProviderModel,
  type SignInStep,
} from "@kndl/protocol"
import {
  Clock,
  Context,
  Duration,
  Effect,
  Fiber,
  Layer,
  Option,
  PubSub,
  Redacted,
  type Result,
  type Scope,
  Schema,
  Semaphore,
} from "effect"
import { SqlClient } from "effect/sql"
import type { SqlError } from "effect/sql/SqlError"
import { ClaudeCredentials, oauthBeta } from "./ClaudeCredentials.ts"
import { HubConfig } from "./HubConfig.ts"
import { ModelCatalog } from "./ModelCatalog.ts"
import {
  accountNameOf,
  accountOf,
  type ApiCall,
  apiOrigin,
  authorize,
  catalogueModels,
  connectable,
  currentClaude,
  enterpriseDomainOf,
  keyAuth,
  modelsCall,
  modelsListed,
  nameOf,
  oauthOf,
  parseJson,
  reasonIn,
  reasonOf,
  record,
  rejectsKey,
  signInDomainTrusted,
  signInOrigin,
  takesApiKey,
  upstreamUrl,
} from "./PiProviders.ts"
import { discard } from "./ReadAtMost.ts"
import { Secrets } from "./Secrets.ts"

// ── pi-ai and the Providers ────────────────────────────────────────────────

/**
 * What the Hub needs of the Providers: how to reach them, and pi-ai's sign-in flows. The live
 * layer is pi-ai's built-in providers and `fetch`; the test layer asks no one.
 */
export class ProviderApis extends Context.Service<
  ProviderApis,
  {
    /**
     * Sends a request to a Provider, as `fetch`: a model call's with Bun's `decompress` and
     * `timeout` off, so its answer streams back as it comes, for as long as it takes.
     */
    readonly fetch: (
      request: Request,
      init?: { readonly decompress?: boolean; readonly timeout?: boolean },
    ) => Promise<Response>
    /** Runs the Provider's sign-in: pi-ai's `auth.oauth.login`. */
    readonly signIn: (
      provider: ProviderId,
      interaction: ProviderAuthInteraction,
      options: LoginOptions,
    ) => Promise<OAuthCredential>
    /** Refreshes a sign-in's tokens: pi-ai's `auth.oauth.refresh`. Rejects on a refusal. */
    readonly refresh: (
      provider: ProviderId,
      credential: OAuthCredential,
      signal: AbortSignal,
    ) => Promise<OAuthCredential>
    /**
     * What a call with a sign-in's tokens goes with: pi-ai's `auth.oauth.toAuth`, a key, headers,
     * or another address for the Provider's API, as GitHub Copilot's names for each account.
     */
    readonly toAuth: (provider: ProviderId, credential: OAuthCredential) => Promise<ModelAuth>
  }
>()("@kndl/hub/ProviderApis") {
  static readonly layer = Layer.succeed(ProviderApis, {
    fetch: (request, init) => fetch(request, init as RequestInit),
    signIn: (provider, interaction, options) => oauthOf(provider).login(interaction, options),
    refresh: (provider, credential, signal) => oauthOf(provider).refresh(credential, signal),
    toAuth: (provider, credential) => oauthOf(provider).toAuth(credential),
  })

  /**
   * Fakes for tests, but pi-ai's own `toAuth`, which asks no one: by default every Provider
   * answers 503, and every sign-in and refresh fails.
   */
  static readonly layerTest = (
    fakes: {
      readonly fetch?: ProviderApis["Service"]["fetch"]
      readonly signIn?: ProviderApis["Service"]["signIn"]
      readonly refresh?: ProviderApis["Service"]["refresh"]
      readonly toAuth?: ProviderApis["Service"]["toAuth"]
    } = {},
  ) =>
    Layer.succeed(ProviderApis, {
      fetch: fakes.fetch ?? (async () => new Response("No Provider in tests", { status: 503 })),
      signIn: fakes.signIn ?? (async () => Promise.reject(new Error("No sign-in in tests"))),
      refresh: fakes.refresh ?? (async () => Promise.reject(new Error("No refresh in tests"))),
      toAuth: fakes.toAuth ?? ((provider, credential) => oauthOf(provider).toAuth(credential)),
    })
}

// ── The Models ─────────────────────────────────────────────────────────────

/** How long the Models last found are kept before the Hub asks again. */
const modelsLifetime = Duration.toMillis(Duration.days(1))
/** How long the Hub waits for a Provider to list its Models. */
const listTimeout = Duration.seconds(15)
/**
 * How long a sign-in may take, its Member's steps and all: then it fails, and its flow stops,
 * freeing what it holds, such as ChatGPT's port 1455 on the Hub's machine.
 */
const signInTimeout = Duration.minutes(10)

/** What asking a Provider for its Models came to. */
type Listed =
  | { readonly _tag: "Listed"; readonly models: ReadonlyArray<ProviderModel> }
  /** The Provider refused the credential: `message` says why, for its owner. */
  | { readonly _tag: "Rejected"; readonly message: string }
  /** The Provider couldn't be asked, or gave no clear answer: `message` says so. */
  | { readonly _tag: "Unavailable"; readonly message: string }

/**
 * The Models a connection keeps when its Provider didn't list them, and why: those found before,
 * or, with none, every one pi-ai's catalogue has for it, which Sessions can try.
 */
function unlisted(
  provider: ProviderId,
  listed: Exclude<Listed, { readonly _tag: "Listed" }>,
  before: ReadonlyArray<ProviderModel>,
): { readonly models: ReadonlyArray<ProviderModel>; readonly modelsProblem: string } {
  const catalogue = catalogueModels(provider)
  return before.length > 0 && JSON.stringify(before) !== JSON.stringify(catalogue)
    ? {
        models: before,
        modelsProblem: `${listed.message}. These are the Models from the last check that worked.`,
      }
    : {
        models: catalogue,
        modelsProblem: `${listed.message}, so these are all the Models pi-ai knows for ${nameOf(provider)}.`,
      }
}

/**
 * Whether pi-ai's refresh failed because the Provider refused it, rather than couldn't be asked:
 * pi-ai says the token endpoint's status, or that the credential can't be refreshed.
 */
const refusedRefresh = (error: unknown) =>
  /\((?:HTTP |status )?(?:400|401|403)\b|^(?:400|401|403)\b|reconnect|sign in again/i.test(
    reasonOf(error),
  )

/** The answer's body as text: its reading cancelled, and the body let go, once interrupted. */
const textOf = (response: Response) =>
  Effect.tryPromise(async (signal) => {
    const reader = response.body?.getReader()
    if (reader === undefined) return ""
    const cancel = () => void reader.cancel().catch(() => undefined)
    signal.addEventListener("abort", cancel, { once: true })
    try {
      const chunks: Array<Uint8Array> = []
      for (let read = await reader.read(); !read.done; read = await reader.read()) {
        chunks.push(read.value)
      }
      return Buffer.concat(chunks).toString("utf8")
    } finally {
      signal.removeEventListener("abort", cancel)
    }
  })

/** What the Provider's answer to a call for its Models says: those pi-ai knows, or why not. */
const readListing = (provider: ModelProvider, kind: ConnectionKind, called: Called) => {
  const name = nameOf(provider)
  const unreachable: Listed = { _tag: "Unavailable", message: `${name} couldn't be reached` }
  if (called._tag !== "Answered") return Effect.succeed(unreachable)
  const { response } = called
  return textOf(response).pipe(
    Effect.timeout(listTimeout),
    Effect.map((body): Listed => {
      if (rejectsKey(response.status, body)) {
        return {
          _tag: "Rejected",
          message:
            kind === "ApiKey"
              ? `${name} rejected this key${reasonIn(body)}`
              : `${name} refused the sign-in${reasonIn(body)}`,
        }
      }
      if (!response.ok) {
        return { _tag: "Unavailable", message: `${name} answered ${response.status}` }
      }
      const models = modelsListed(provider, parseJson(body))
      return models === undefined
        ? { _tag: "Unavailable", message: `${name} didn't list its Models` }
        : { _tag: "Listed", models }
    }),
    Effect.catch(() => Effect.succeed(unreachable)),
  )
}

// ── Sign-in steps ──────────────────────────────────────────────────────────

/** How a sign-in shows its steps to the Member who started it (ProviderRelay.ts). */
export interface SignInSteps {
  /** Shows the Member what to do, or what the flow is doing. */
  readonly show: (step: SignInStep) => void
  /** Asks the Member to paste or choose something: their answer. Rejects once `signal` aborts. */
  readonly ask: (
    step: Extract<SignInStep, { readonly _tag: "Paste" | "Choose" }>,
    signal: AbortSignal,
  ) => Promise<string>
}

/**
 * The sign-ins that land the browser on the Hub's own loopback, `127.0.0.1`, which is the Member's
 * machine, not the Hub's, unless they are the same: they paste the address it landed on instead.
 */
const loopback: Partial<Record<ProviderId, { readonly name: string; readonly address: string }>> = {
  openai: { name: "ChatGPT", address: "http://127.0.0.1:1455/" },
  openrouter: { name: "OpenRouter", address: "http://127.0.0.1" },
}

const loopbackOpen = (name: string) =>
  `Sign in to ${name} in the page this opens. It then lands on a page at 127.0.0.1 that may not load: that's expected. Copy that page's address from the address bar and paste it below.`
const loopbackPaste = (address: string) =>
  `Paste the address of the page your browser landed on after you signed in: it starts with ${address}.`

/** The step a pi-ai sign-in event shows the Member. */
function stepOf(provider: ProviderId, event: AuthEvent): SignInStep | undefined {
  const landing = loopback[provider]
  switch (event.type) {
    case "auth_url":
      return {
        _tag: "OpenUrl",
        url: event.url,
        ...(landing !== undefined
          ? { instructions: loopbackOpen(landing.name) }
          : event.instructions !== undefined && { instructions: event.instructions }),
      }
    case "device_code":
      return { _tag: "EnterCode", url: event.verificationUri, code: event.userCode }
    case "progress":
    case "info":
      // Where the Hub listens for the browser is no use to the Member, whose browser can't reach it.
      if (landing !== undefined && /listening/i.test(event.message)) return undefined
      return { _tag: "Progress", message: event.message }
  }
}

/** The step a pi-ai sign-in prompt asks of the Member. */
function askOf(
  provider: ProviderId,
  prompt: AuthPrompt,
): Extract<SignInStep, { readonly _tag: "Paste" | "Choose" }> {
  const landing = loopback[provider]
  switch (prompt.type) {
    case "select":
      return {
        _tag: "Choose",
        message: prompt.message,
        options: prompt.options.map(({ id, label }) => ({ id, label })),
      }
    case "manual_code":
    case "text":
    case "secret":
      return {
        _tag: "Paste",
        message:
          landing !== undefined && prompt.type === "manual_code"
            ? loopbackPaste(landing.address)
            : prompt.message,
        ...(prompt.placeholder !== undefined && { placeholder: prompt.placeholder }),
      }
  }
}

const github = "github.com"
const enterprise = "enterprise"
const enterpriseOnly =
  "kndl signs in to GitHub Copilot Enterprise on GHE.com only: give your company's domain ending in .ghe.com, such as company.ghe.com."

/**
 * Asks the Member what a pi-ai sign-in prompt asks: as a choice first, for GitHub Copilot's
 * question of which GitHub, which takes a blank answer for github.com.
 */
async function answerTo(
  provider: ProviderId,
  prompt: AuthPrompt,
  steps: SignInSteps,
  signal: AbortSignal,
): Promise<string> {
  if (
    provider === "github-copilot" &&
    prompt.type === "text" &&
    /enterprise/i.test(prompt.message)
  ) {
    const which = await steps.ask(
      {
        _tag: "Choose",
        message: "Which GitHub is your Copilot subscription on?",
        options: [
          { id: github, label: "GitHub.com" },
          { id: enterprise, label: "GitHub Enterprise" },
        ],
      },
      signal,
    )
    if (which !== enterprise) return ""
    const answer = await steps.ask(
      {
        _tag: "Paste",
        message: "Your GitHub Enterprise address",
        placeholder: prompt.placeholder ?? "company.ghe.com",
      },
      signal,
    )
    // The Hub sends the sign-in's requests there: GitHub's own, not an address of anyone's choosing.
    const domain = enterpriseDomainOf(answer)
    if (domain === undefined) throw new Error(enterpriseOnly)
    return domain
  }
  return steps.ask(askOf(provider, prompt), signal)
}

// ── Storing ────────────────────────────────────────────────────────────────

/** A connection can't be made: `message` says why, for its Member. */
// oxlint-disable-next-line unicorn/throw-new-error -- Effect makes error classes with a factory call
export class ProviderRefusal extends Schema.TaggedError<ProviderRefusal>()("ProviderRefusal", {
  message: Schema.String,
}) {}

/** The Member's Provider can't take a call now: `message` says why, in the Provider's words. */
// oxlint-disable-next-line unicorn/throw-new-error -- Effect makes error classes with a factory call
export class ProviderUnusable extends Schema.TaggedError<ProviderUnusable>()("ProviderUnusable", {
  /**
   * `NotConnected`: they haven't connected it. `Broken`: its connection has a problem, and they
   * connect it again. `Unavailable`: its sign-in couldn't be refreshed just now.
   */
  reason: Schema.Literals(["NotConnected", "Broken", "Unavailable"]),
  message: Schema.String,
}) {}

const unusable = (reason: ProviderUnusable["reason"], message: string) =>
  new ProviderUnusable({ reason, message })

const notConnected = (provider: ModelProvider) =>
  unusable(
    "NotConnected",
    provider === "anthropic"
      ? "Claude's Models run through Claude Code in the Sandbox, not the Gateway."
      : `The Session's Creator hasn't connected ${nameOf(provider)}: they connect it on the Account page.`,
  )

/** Why a sign-in whose `toAuth` names an address the Hub doesn't trust can't be used. */
const untrustedAddress = (provider: ProviderId) =>
  `${nameOf(provider)}'s sign-in names an address for its API that kndl doesn't send calls to: connect it again on the Account page.`

/** Why a connection can't be kept on a Hub without a secrets key. */
const noKey = (provider: ProviderId) =>
  `This Hub can't store a ${nameOf(provider)} connection: it needs HUB_SECRETS_KEY in its configuration. Ask whoever runs it to set one.`

/** What a call to a Provider came to. */
export type Called =
  /** The Provider's answer, its body unread: a redirect isn't followed. */
  | { readonly _tag: "Answered"; readonly response: Response }
  /** The Provider could not be reached. */
  | { readonly _tag: "Unreachable" }
  /** The call's path would leave the Provider's API: it wasn't sent. */
  | { readonly _tag: "BadAddress" }

/** A Member's Connected providers changed. */
export interface ProvidersChanged {
  readonly participantId: ParticipantId
  /** Whether a command's answer tells them: otherwise their web clients are to be told. */
  readonly answered: boolean
}

/** A Connected provider as the Hub holds it. */
interface Connection {
  readonly provider: ProviderId
  readonly kind: ConnectionKind
  readonly label: string
  readonly connectedAt: number
  readonly credential: Credential
  readonly models: ReadonlyArray<ProviderModel>
  readonly modelsCheckedAt?: number
  readonly modelsProblem?: string
  readonly problem?: string
  /** When its sign-in was last refreshed, since the Hub started. */
  readonly refreshedAt?: number
}

/** Claude's Models as last found for a Claude credential. */
interface ClaudeModels {
  readonly token: string
  readonly models: ReadonlyArray<ProviderModel>
  readonly checkedAt: number
}

interface Row {
  readonly participantId: string
  readonly provider: string
  readonly kind: string
  readonly credential: string
  readonly label: string
  readonly connectedAt: number
  readonly models: string
  readonly modelsCheckedAt: number | null
  readonly modelsProblem: string | null
  readonly problem: string | null
}

/** What a credential is encrypted with, so a ciphertext can't be moved to another person. */
const contextOf = (participantId: ParticipantId, provider: ProviderId) =>
  `connected-provider:${participantId}:${provider}`

const decodeModels = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Array(ProviderModel)))
const encodeModels = Schema.encodeSync(Schema.fromJsonString(Schema.Array(ProviderModel)))

/** The pi-ai credential a row holds, if it reads as one. */
function credentialFrom(text: string): Credential | undefined {
  const credential = record(parseJson(text))
  if (credential?.type === "api_key" && typeof credential.key === "string") {
    return { type: "api_key", key: credential.key }
  }
  if (
    credential?.type === "oauth" &&
    typeof credential.access === "string" &&
    typeof credential.refresh === "string" &&
    typeof credential.expires === "number"
  ) {
    return credential as OAuthCredential
  }
  return undefined
}

/** Every secret in a credential, to redact. */
const secretsOf = (credential: Credential): ReadonlyArray<string> =>
  credential.type === "api_key"
    ? credential.key === undefined
      ? []
      : [credential.key]
    : [credential.access, credential.refresh]

/** What the call goes with: the access token, or the key. */
const tokenOf = (credential: Credential) =>
  credential.type === "oauth" ? credential.access : (credential.key ?? "")

/** How far ahead of its expiry a sign-in's token is refreshed for a call. */
const refreshAhead = Duration.toMillis(Duration.minutes(5))
/**
 * How long after a refresh a Provider's 401 is answered as it is, with no refresh: a Sandbox that
 * makes calls the Provider refuses can't make the Hub hammer its token endpoint.
 */
const refreshedLately = Duration.toMillis(Duration.minutes(1))
/** How long the Hub waits for a Provider to refresh a sign-in. */
const refreshTimeout = Duration.seconds(30)

/** Each Member's Connected providers (ADR 0029). */
export class ConnectedProviders extends Context.Service<
  ConnectedProviders,
  {
    /**
     * The Member's Connected providers as they see them, what they can connect, and every Model
     * their pi Sessions can run: ProvidersState's.
     */
    readonly state: (participantId: ParticipantId) => Effect.Effect<{
      readonly connected: ReadonlyArray<ConnectedProvider>
      readonly connectable: ReadonlyArray<ConnectableProvider>
      readonly models: ReadonlyArray<ProviderModel>
    }>
    /**
     * Every Model the Member's pi Sessions can run now: Claude's first, when they have a Claude
     * credential, then each Connected provider's that works. Answers at once: a list a day old is
     * asked for again off the call.
     */
    readonly modelsFor: (
      participantId: ParticipantId,
    ) => Effect.Effect<ReadonlyArray<ProviderModel>>
    /**
     * Lists the Provider's Models with the key, refusing one it rejects, and keeps it as the
     * Member's connection to it, replacing any before.
     */
    readonly connectKey: (
      participantId: ParticipantId,
      provider: ProviderId,
      apiKey: Redacted.Redacted<string>,
    ) => Effect.Effect<void, ProviderRefusal | SqlError>
    /**
     * Runs the Provider's sign-in, its steps shown as `steps` says, then lists its Models and keeps
     * it as the Member's connection to it, replacing any before. Interrupting it cancels the flow.
     */
    readonly signIn: (
      participantId: ParticipantId,
      provider: ProviderId,
      steps: SignInSteps,
    ) => Effect.Effect<void, ProviderRefusal | SqlError>
    /** Forgets the Member's connection to the Provider: whether they had one. */
    readonly disconnect: (
      participantId: ParticipantId,
      provider: ProviderId,
    ) => Effect.Effect<boolean, SqlError>
    /** Asks the Provider (or each, and Anthropic) for the Member's Models again now. */
    readonly refreshModels: (
      participantId: ParticipantId,
      provider?: ProviderId,
    ) => Effect.Effect<void, SqlError>
    /**
     * Which Harness runs Claude's Models in the Member's new Sessions (ADR 0030): Claude Code, on
     * their setup token, unless they chose pi.
     */
    readonly claudeHarness: (participantId: ParticipantId) => Effect.Effect<Harness, SqlError>
    /** Sets which Harness runs Claude's Models in the Member's new Sessions. */
    readonly setClaudeHarness: (
      participantId: ParticipantId,
      harness: Harness,
    ) => Effect.Effect<void, SqlError>
    /** Forgets every connection of the Member, as when they are removed. */
    readonly forget: (participantId: ParticipantId) => Effect.Effect<void, SqlError>
    /** How the Member connected the Provider, if they have. */
    readonly kindOf: (
      participantId: ParticipantId,
      provider: ModelProvider,
    ) => ConnectionKind | undefined
    /**
     * Sends the call to the Provider's API with the Member's credential: to the origin it or pi-ai
     * names, the key in the call's `keyHeader`, and a sign-in's own headers over the call's. A
     * sign-in that expires within 5 minutes is refreshed first. One the Provider refuses with a
     * 401 is refreshed, once however many calls it refused, and the call sent once more, if its
     * body can be (bytes, not a stream) and the sign-in wasn't refreshed in the last minute: else
     * the 401 is the answer. One refreshed is kept, rotated, unless it was disconnected or
     * connected again meanwhile.
     */
    readonly call: (
      participantId: ParticipantId,
      provider: ModelProvider,
      call: ApiCall,
    ) => Effect.Effect<Called, ProviderUnusable>
    /**
     * Every key and token held, and every one replaced or forgotten since the Hub started: a
     * sign-in's until it expires.
     */
    readonly values: () => ReadonlyArray<string>
    /** Each change to a Member's Connected providers, or the Models they can run, from now on. */
    readonly changes: Effect.Effect<PubSub.Subscription<ProvidersChanged>, never, Scope.Scope>
  }
>()("@kndl/hub/ConnectedProviders") {
  static readonly layer = Layer.effect(
    ConnectedProviders,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const secrets = yield* Secrets
      const claude = yield* ClaudeCredentials
      const apis = yield* ProviderApis
      const config = yield* HubConfig
      const scope = yield* Effect.scope
      const published = yield* PubSub.unbounded<ProvidersChanged>()

      const connections = new Map<ParticipantId, Map<ProviderId, Connection>>()
      const claudeModels = new Map<ParticipantId, ClaudeModels>()
      /**
       * The secrets of credentials no longer held, for redaction: each with when a sign-in's
       * expired, after which it is let go, as it can't be used; a key's for as long as the Hub runs.
       */
      const retired = new Map<string, number | undefined>()
      /** One refresh at a time for each connection, let go with it. */
      const refreshLocks = new Map<string, Semaphore.Semaphore>()
      /** The Model lists being asked for off a call, so each is asked once at a time. */
      const asking = new Set<string>()

      // Secrets.ts refuses to start without the key they were stored with, so each decrypts.
      const rows = yield* sql<Row>`
        SELECT participant_id AS participantId, provider, kind, credential, label,
          connected_at AS connectedAt, models, models_checked_at AS modelsCheckedAt,
          models_problem AS modelsProblem, problem
        FROM connected_providers
      `.pipe(Effect.orDie)
      for (const row of rows) {
        const participantId = row.participantId as ParticipantId
        const provider = row.provider as ProviderId
        if (!ProviderIds.includes(provider)) continue
        const secret = yield* secrets
          .decrypt(row.credential, contextOf(participantId, provider))
          .pipe(
            Effect.catchTag("SecretsUnavailable", (error) =>
              Effect.as(
                Effect.logError(`A Connected provider of ${participantId} can't be read`, error),
                undefined,
              ),
            ),
          )
        const credential = secret === undefined ? undefined : credentialFrom(Redacted.value(secret))
        if (credential === undefined) continue
        const held = connections.get(participantId) ?? new Map<ProviderId, Connection>()
        held.set(provider, {
          provider,
          kind: row.kind === "SignIn" ? "SignIn" : "ApiKey",
          label: row.label,
          connectedAt: row.connectedAt,
          credential,
          models: Option.getOrElse(decodeModels(row.models), () => []),
          ...(row.modelsCheckedAt !== null && { modelsCheckedAt: row.modelsCheckedAt }),
          ...(row.modelsProblem !== null && { modelsProblem: row.modelsProblem }),
          ...(row.problem !== null && { problem: row.problem }),
        })
        connections.set(participantId, held)
      }

      const connectionOf = (participantId: ParticipantId, provider: ModelProvider) =>
        provider === "anthropic" ? undefined : connections.get(participantId)?.get(provider)

      const keep = (participantId: ParticipantId, connection: Connection) => {
        const held = connections.get(participantId) ?? new Map<ProviderId, Connection>()
        held.set(connection.provider, connection)
        connections.set(participantId, held)
      }

      /**
       * Keeps the secrets of a credential no longer held, for redaction, letting those that
       * expired by `now` go.
       */
      const retire = (now: number, before: Credential | undefined, after?: Credential) => {
        for (const [secret, expires] of retired) {
          if (expires !== undefined && expires < now) retired.delete(secret)
        }
        if (before === undefined) return
        const kept = new Set(after === undefined ? [] : secretsOf(after))
        const expires = before.type === "oauth" ? before.expires : undefined
        for (const secret of secretsOf(before)) {
          if (!kept.has(secret) && !(expires !== undefined && expires < now)) {
            retired.set(secret, expires)
          }
        }
      }

      const changed = (participantId: ParticipantId, answered: boolean) =>
        PubSub.publish(published, { participantId, answered })

      const lockKey = (participantId: ParticipantId, provider: ProviderId) =>
        `${participantId}\n${provider}`

      const lockOf = (participantId: ParticipantId, provider: ProviderId) => {
        const key = lockKey(participantId, provider)
        let lock = refreshLocks.get(key)
        if (lock === undefined) {
          lock = Semaphore.makeUnsafe(1)
          refreshLocks.set(key, lock)
        }
        return lock
      }

      const seal = (participantId: ParticipantId, provider: ProviderId, credential: Credential) =>
        secrets
          .encrypt(Redacted.make(JSON.stringify(credential)), contextOf(participantId, provider))
          .pipe(
            Effect.catchTag("SecretsUnavailable", (error) =>
              Effect.fail(new ProviderRefusal({ message: error.message })),
            ),
          )

      /** The Hub's one device id, which ChatGPT's sign-in names the Hub by: made on first use. */
      const deviceId = Effect.gen(function* () {
        const [found] = yield* sql<{ readonly id: string }>`SELECT id FROM hub_device`
        if (found !== undefined) return found.id
        const id = randomUUID()
        yield* sql`INSERT INTO hub_device (id) VALUES (${id})`
        return id
      }).pipe(sql.withTransaction)

      // ── Asking for Models ──────────────────────────────────────────────

      /**
       * Sends the call to `origin` with what `auth` says: a model call's answer streaming back as
       * it comes, for as long as it takes; a Model list's within listTimeout.
       */
      const send = (
        origin: string,
        auth: ModelAuth,
        call: ApiCall,
        listing: boolean,
      ): Effect.Effect<Called> => {
        const to = upstreamUrl(origin, call.path)
        if (to === undefined) return Effect.succeed({ _tag: "BadAddress" })
        const fetched = Effect.tryPromise({
          try: (signal) => {
            const headers = new Headers(call.headers)
            authorize(headers, auth, call.keyHeader)
            const hasBody = !["GET", "HEAD"].includes(call.method) && call.body !== undefined
            return apis.fetch(
              new Request(to.href, {
                method: call.method,
                headers,
                ...(hasBody && { body: call.body, duplex: "half" }),
                redirect: "manual",
                signal: call.signal === undefined ? signal : AbortSignal.any([signal, call.signal]),
              } as RequestInit),
              listing ? undefined : { decompress: false, timeout: false },
            )
          },
          catch: (error) => error,
        })
        return (listing ? Effect.timeout(fetched, listTimeout) : fetched).pipe(
          Effect.map((response): Called => ({ _tag: "Answered", response })),
          Effect.catch(() => Effect.succeed<Called>({ _tag: "Unreachable" })),
        )
      }

      /** Asks the Provider for its Models with a credential not kept yet: those pi-ai knows. */
      const listModels = (
        provider: ModelProvider,
        origin: string,
        auth: ModelAuth,
        kind: ConnectionKind,
      ) =>
        send(origin, auth, modelsCall(provider), true).pipe(
          Effect.flatMap((called) => readListing(provider, kind, called)),
        )

      /** Asks Anthropic for Claude's Models under the Member's Claude credential, and keeps them. */
      const askClaude = Effect.fn("ConnectedProviders.askClaude")(function* (
        participantId: ParticipantId,
      ) {
        const credential = claude.credentialOf(participantId)
        if (credential === undefined || !config.claudeModels) return
        const token = Redacted.value(credential.token)
        const call = modelsCall("anthropic")
        call.headers.set("anthropic-beta", oauthBeta)
        const called = yield* send(apiOrigin("anthropic"), { apiKey: token }, call, true)
        const listed = yield* readListing("anthropic", "SignIn", called)
        const models =
          listed._tag === "Listed" && listed.models.length > 0 ? listed.models : currentClaude
        const before = claudeModels.get(participantId)
        const shown = before?.token === token ? before.models : currentClaude
        claudeModels.set(participantId, {
          token,
          models,
          checkedAt: yield* Clock.currentTimeMillis,
        })
        if (JSON.stringify(shown) !== JSON.stringify(models)) yield* changed(participantId, false)
      })

      /**
       * Asks the Provider for the Member's Models, and keeps what it said: whether that changed
       * what they see. A sign-in that can't be refreshed or used just now lists none, as a Provider
       * that didn't answer, so it isn't asked again until the next ask is due.
       */
      const askModels = Effect.fn("ConnectedProviders.askModels")(function* (
        participantId: ParticipantId,
        provider: ProviderId,
      ): Effect.fn.Return<boolean, SqlError> {
        const before = connectionOf(participantId, provider)
        if (before === undefined || before.problem !== undefined) return false
        const called = yield* Effect.result(
          callWith(participantId, provider, modelsCall(provider), true),
        )
        const listed: Listed =
          called._tag === "Success"
            ? yield* readListing(provider, before.kind, called.success)
            : { _tag: "Unavailable", message: called.failure.message }
        const now = yield* Clock.currentTimeMillis
        const current = connectionOf(participantId, provider)
        // Disconnected or connected again meanwhile, or its refresh refused, which said so.
        if (
          current === undefined ||
          current.connectedAt !== before.connectedAt ||
          current.problem !== undefined
        ) {
          return false
        }
        const { modelsProblem: _, ...rest } = current
        const next: Connection =
          listed._tag === "Listed"
            ? { ...rest, models: listed.models, modelsCheckedAt: now }
            : { ...rest, modelsCheckedAt: now, ...unlisted(provider, listed, current.models) }
        yield* sql`
          UPDATE connected_providers SET models = ${encodeModels(next.models)},
            models_checked_at = ${now}, models_problem = ${next.modelsProblem ?? null}
          WHERE participant_id = ${participantId} AND provider = ${provider}
        `
        keep(participantId, next)
        return true
      })

      /**
       * Asks off the call, once at a time for each list, telling the Member's web clients after,
       * if what they see changed.
       */
      const askInBackground = (participantId: ParticipantId, provider: ModelProvider) => {
        const key = `${participantId}\n${provider}`
        if (asking.has(key)) return Effect.void
        asking.add(key)
        const ask: Effect.Effect<void, SqlError> =
          provider === "anthropic"
            ? askClaude(participantId)
            : askModels(participantId, provider).pipe(
                Effect.flatMap((kept) => (kept ? changed(participantId, false) : Effect.void)),
              )
        return ask.pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Could not ask for a Provider's Models", cause),
          ),
          Effect.ensuring(Effect.sync(() => asking.delete(key))),
          Effect.forkIn(scope),
          Effect.asVoid,
        )
      }

      /** Claude's Models for the Member's Claude credential as last found: asked again off the call. */
      const claudeFor = Effect.fn("ConnectedProviders.claudeFor")(function* (
        participantId: ParticipantId,
        now: number,
      ) {
        const credential = claude.credentialOf(participantId)
        if (credential === undefined || !config.claudeModels) return []
        const token = Redacted.value(credential.token)
        const known = claudeModels.get(participantId)
        if (known?.token !== token || now - known.checkedAt >= modelsLifetime) {
          yield* askInBackground(participantId, "anthropic")
        }
        return known?.token === token ? known.models : currentClaude
      })

      const modelsFor = Effect.fn("ConnectedProviders.modelsFor")(function* (
        participantId: ParticipantId,
      ) {
        const now = yield* Clock.currentTimeMillis
        const models = [...(yield* claudeFor(participantId, now))]
        const held = connections.get(participantId)
        for (const provider of ProviderIds) {
          const connection = held?.get(provider)
          if (connection === undefined || connection.problem !== undefined) continue
          if (
            connection.modelsCheckedAt === undefined ||
            now - connection.modelsCheckedAt >= modelsLifetime
          ) {
            yield* askInBackground(participantId, provider)
          }
          models.push(...connection.models)
        }
        return models
      })

      const state = Effect.fn("ConnectedProviders.state")(function* (participantId: ParticipantId) {
        const held = connections.get(participantId)
        const connected = ProviderIds.flatMap((provider): ReadonlyArray<ConnectedProvider> => {
          const connection = held?.get(provider)
          if (connection === undefined) return []
          return [
            {
              provider,
              kind: connection.kind,
              label: connection.label,
              connectedAt: connection.connectedAt,
              models: connection.models,
              ...(connection.modelsCheckedAt !== undefined && {
                modelsCheckedAt: connection.modelsCheckedAt,
              }),
              ...(connection.modelsProblem !== undefined && {
                modelsProblem: connection.modelsProblem,
              }),
              ...(connection.problem !== undefined && { problem: connection.problem }),
            },
          ]
        })
        return { connected, connectable, models: yield* modelsFor(participantId) }
      })

      // ── Connecting ─────────────────────────────────────────────────────

      /** Keeps the credential as the Member's connection to the Provider, with the Models listed. */
      const store = Effect.fn("ConnectedProviders.store")(function* (
        participantId: ParticipantId,
        provider: ProviderId,
        connection: { readonly kind: ConnectionKind; readonly label: string },
        credential: Credential,
        listed: Listed,
      ) {
        const ciphertext = yield* seal(participantId, provider, credential)
        const now = yield* Clock.currentTimeMillis
        // Later than the one it replaces, which a refresh of that one is told apart by.
        const connectedAt = Math.max(
          now,
          (connectionOf(participantId, provider)?.connectedAt ?? 0) + 1,
        )
        const kept = listed._tag === "Listed" ? undefined : unlisted(provider, listed, [])
        const models = kept?.models ?? (listed._tag === "Listed" ? listed.models : [])
        const modelsProblem = kept?.modelsProblem ?? null
        yield* sql`
          INSERT INTO connected_providers (participant_id, provider, kind, credential, label,
            connected_at, models, models_checked_at, models_problem, problem)
          VALUES (${participantId}, ${provider}, ${connection.kind}, ${ciphertext},
            ${connection.label}, ${connectedAt}, ${encodeModels(models)}, ${now}, ${modelsProblem},
            NULL)
          ON CONFLICT (participant_id, provider) DO UPDATE SET kind = excluded.kind,
            credential = excluded.credential, label = excluded.label,
            connected_at = excluded.connected_at, models = excluded.models,
            models_checked_at = excluded.models_checked_at,
            models_problem = excluded.models_problem, problem = NULL
        `
        const before = connectionOf(participantId, provider)
        retire(now, before?.credential, credential)
        for (const secret of secretsOf(credential)) retired.delete(secret)
        keep(participantId, {
          provider,
          ...connection,
          connectedAt,
          credential,
          models,
          modelsCheckedAt: now,
          ...(modelsProblem !== null && { modelsProblem }),
        })
        yield* changed(participantId, true)
      })

      const connectKey = Effect.fn("ConnectedProviders.connectKey")(function* (
        participantId: ParticipantId,
        provider: ProviderId,
        apiKey: Redacted.Redacted<string>,
      ) {
        if (!takesApiKey(provider)) {
          return yield* new ProviderRefusal({
            message: `${nameOf(provider)} isn't connected with an API key: sign in to it instead.`,
          })
        }
        const key = Redacted.value(apiKey).trim()
        if (key === "" || /\s/.test(key)) {
          return yield* new ProviderRefusal({ message: `Paste the ${nameOf(provider)} API key.` })
        }
        if (!secrets.available) return yield* new ProviderRefusal({ message: noKey(provider) })
        const listed = yield* listModels(provider, apiOrigin(provider), { apiKey: key }, "ApiKey")
        if (listed._tag === "Rejected") {
          return yield* new ProviderRefusal({ message: listed.message })
        }
        yield* store(
          participantId,
          provider,
          { kind: "ApiKey", label: key.slice(-4) },
          { type: "api_key", key },
          listed,
        )
      })

      const signIn = Effect.fn("ConnectedProviders.signIn")(function* (
        participantId: ParticipantId,
        provider: ProviderId,
        steps: SignInSteps,
      ) {
        if (!secrets.available) return yield* new ProviderRefusal({ message: noKey(provider) })
        const device = yield* deviceId
        const signedIn = yield* Effect.tryPromise({
          try: (signal) =>
            apis.signIn(
              provider,
              {
                signal,
                notify: (event) => {
                  const step = stepOf(provider, event)
                  if (step !== undefined) steps.show(step)
                },
                prompt: (prompt) =>
                  answerTo(
                    provider,
                    prompt,
                    steps,
                    prompt.signal === undefined ? signal : AbortSignal.any([signal, prompt.signal]),
                  ),
              },
              { getDeviceId: () => device, agentName: "kndl" },
            ),
          catch: (error) => new ProviderRefusal({ message: reasonOf(error) }),
        }).pipe(
          Effect.timeoutOrElse({
            duration: signInTimeout,
            orElse: () =>
              Effect.fail(
                new ProviderRefusal({ message: "The sign-in took too long; start again." }),
              ),
          }),
        )
        const credential: OAuthCredential = { ...signedIn, type: "oauth" }
        if (!signInDomainTrusted(credential)) {
          return yield* new ProviderRefusal({ message: enterpriseOnly })
        }
        const auth = yield* Effect.tryPromise({
          try: () => apis.toAuth(provider, credential),
          catch: (error) => new ProviderRefusal({ message: reasonOf(error) }),
        })
        const origin = signInOrigin(provider, credential, auth)
        if (origin === undefined) {
          return yield* new ProviderRefusal({ message: untrustedAddress(provider) })
        }
        const listed = yield* listModels(provider, origin, auth, "SignIn")
        yield* store(
          participantId,
          provider,
          { kind: "SignIn", label: accountOf(credential.access) ?? accountNameOf(provider) },
          credential,
          listed,
        )
      })

      const disconnect = Effect.fn("ConnectedProviders.disconnect")(function* (
        participantId: ParticipantId,
        provider: ProviderId,
      ) {
        yield* sql`
          DELETE FROM connected_providers
          WHERE participant_id = ${participantId} AND provider = ${provider}
        `
        const before = connectionOf(participantId, provider)
        if (before === undefined) return false
        retire(yield* Clock.currentTimeMillis, before.credential)
        connections.get(participantId)?.delete(provider)
        // A refresh of it under way finds it gone, and keeps nothing.
        refreshLocks.delete(lockKey(participantId, provider))
        yield* changed(participantId, true)
        return true
      })

      const forget = Effect.fn("ConnectedProviders.forget")(function* (
        participantId: ParticipantId,
      ) {
        yield* sql`DELETE FROM connected_providers WHERE participant_id = ${participantId}`
        const now = yield* Clock.currentTimeMillis
        for (const connection of connections.get(participantId)?.values() ?? []) {
          retire(now, connection.credential)
          refreshLocks.delete(lockKey(participantId, connection.provider))
        }
        connections.delete(participantId)
        claudeModels.delete(participantId)
        yield* changed(participantId, true)
      })

      const refreshModels = Effect.fn("ConnectedProviders.refreshModels")(function* (
        participantId: ParticipantId,
        provider?: ProviderId,
      ) {
        const providers = provider === undefined ? ProviderIds : [provider]
        yield* Effect.forEach(providers, (each) => askModels(participantId, each), {
          concurrency: "unbounded",
          discard: true,
        })
        if (provider === undefined) yield* askClaude(participantId)
      })

      // ── Calls ──────────────────────────────────────────────────────────

      /** The Member's connection to the Provider, if it can take a call. */
      const usable = (participantId: ParticipantId, provider: ModelProvider) =>
        Effect.suspend(() => {
          const connection = connectionOf(participantId, provider)
          if (connection === undefined) return Effect.fail(notConnected(provider))
          if (connection.problem !== undefined) {
            return Effect.fail(unusable("Broken", connection.problem))
          }
          return Effect.succeed(connection)
        })

      /** Whether `connection` is still the Member's, refreshed or not: not connected again. */
      const still = (participantId: ParticipantId, connection: Connection) =>
        connectionOf(participantId, connection.provider)?.connectedAt === connection.connectedAt

      /**
       * Whether `connection` is still the Member's after an update of its row, as the rows it
       * returned say: as the Hub holds it, when the update failed.
       */
      const stillHeld = (
        participantId: ParticipantId,
        connection: Connection,
        updated: Result.Result<ReadonlyArray<unknown>, unknown>,
      ) =>
        still(participantId, connection) &&
        (updated._tag === "Failure" || updated.success.length > 0)

      /**
       * The Member's connection to the Provider, its sign-in refreshed first if `due` says so, one
       * refresh at a time; the rotated credential kept. A refresh the Provider refuses is kept as
       * the connection's problem. Either is kept only on the connection it refreshed: one
       * disconnected or connected again meanwhile is left as it is now, and is the answer.
       */
      const refreshed = (
        participantId: ParticipantId,
        provider: ModelProvider,
        due: (connection: Connection, credential: OAuthCredential, now: number) => boolean,
      ): Effect.Effect<Connection, ProviderUnusable> => {
        const needed = Effect.fnUntraced(function* () {
          const connection = yield* usable(participantId, provider)
          const now = yield* Clock.currentTimeMillis
          const { credential } = connection
          return {
            connection,
            now,
            refresh:
              credential.type === "oauth" && due(connection, credential, now)
                ? credential
                : undefined,
          }
        })
        return Effect.gen(function* () {
          const first = yield* needed()
          if (first.refresh === undefined) return first.connection
          // On the layer's scope, not the call's: a Provider may spend the old refresh token as it
          // rotates it, so a call given up meanwhile mustn't lose the new one.
          const rotating = lockOf(participantId, first.connection.provider).withPermits(1)(
            Effect.gen(function* () {
              // Another call may have refreshed it meanwhile.
              const { connection, now, refresh } = yield* needed()
              if (refresh === undefined) return connection
              const name = nameOf(provider)
              if (!signInDomainTrusted(refresh)) {
                return yield* unusable("Broken", untrustedAddress(connection.provider))
              }
              const rotated = yield* Effect.tryPromise({
                try: (signal) => apis.refresh(connection.provider, refresh, signal),
                catch: (error) => error,
              }).pipe(
                Effect.timeoutOrElse({
                  duration: refreshTimeout,
                  orElse: () => Effect.fail(new Error(`${name} didn't answer in time`)),
                }),
                Effect.result,
              )
              if (rotated._tag === "Failure") {
                const reason = reasonOf(rotated.failure)
                if (!refusedRefresh(rotated.failure)) {
                  return yield* unusable(
                    "Unavailable",
                    `${name} couldn't refresh the sign-in just now: ${reason}`,
                  )
                }
                const problem = `${name} refused to refresh the sign-in (${reason}): connect it again on the Account page.`
                const marked = yield* sql`
                  UPDATE connected_providers SET problem = ${problem}
                  WHERE participant_id = ${participantId} AND provider = ${connection.provider}
                    AND connected_at = ${connection.connectedAt}
                  RETURNING provider
                `.pipe(Effect.result)
                if (!stillHeld(participantId, connection, marked)) {
                  return yield* usable(participantId, provider)
                }
                if (marked._tag === "Failure") {
                  yield* Effect.logError(
                    `Could not store that ${name} refused a refresh`,
                    marked.failure,
                  )
                }
                const current = connectionOf(participantId, connection.provider) ?? connection
                keep(participantId, { ...current, problem })
                yield* changed(participantId, false)
                return yield* unusable("Broken", problem)
              }
              const credential: OAuthCredential = { ...rotated.success, type: "oauth" }
              const stored = yield* seal(participantId, connection.provider, credential).pipe(
                Effect.flatMap(
                  (ciphertext) => sql`
                    UPDATE connected_providers SET credential = ${ciphertext}
                    WHERE participant_id = ${participantId} AND provider = ${connection.provider}
                      AND connected_at = ${connection.connectedAt}
                    RETURNING provider
                  `,
                ),
                Effect.result,
              )
              if (!stillHeld(participantId, connection, stored)) {
                retire(now, credential)
                return yield* usable(participantId, provider)
              }
              // Used for calls all the same: the Provider may have spent the old one.
              if (stored._tag === "Failure") {
                yield* Effect.logError(
                  `Could not store ${name}'s refreshed sign-in: it is used until the Hub restarts`,
                  stored.failure,
                )
              }
              retire(now, connection.credential, credential)
              const current = connectionOf(participantId, connection.provider) ?? connection
              const next: Connection = { ...current, credential, refreshedAt: now }
              keep(participantId, next)
              yield* changed(participantId, false)
              return next
            }),
          )
          return yield* Fiber.join(yield* Effect.forkIn(rotating, scope))
        })
      }

      /** Sends the call with the connection's credential: a key itself, or what its sign-in says. */
      const sendWith = Effect.fnUntraced(function* (
        connection: Connection,
        call: ApiCall,
        listing: boolean,
      ) {
        const { credential, provider } = connection
        if (credential.type !== "oauth") {
          return yield* send(apiOrigin(provider), keyAuth(credential) ?? {}, call, listing)
        }
        const auth = yield* Effect.tryPromise({
          try: () => apis.toAuth(provider, credential),
          catch: (error) =>
            unusable(
              "Unavailable",
              `${nameOf(provider)}'s sign-in can't be used: ${reasonOf(error)}`,
            ),
        })
        const origin = signInOrigin(provider, credential, auth)
        if (origin === undefined || !signInDomainTrusted(credential)) {
          return yield* unusable("Broken", untrustedAddress(provider))
        }
        return yield* send(origin, auth, call, listing)
      })

      const callWith = Effect.fnUntraced(function* (
        participantId: ParticipantId,
        provider: ModelProvider,
        call: ApiCall,
        listing: boolean,
      ): Effect.fn.Return<Called, ProviderUnusable> {
        const connection = yield* refreshed(
          participantId,
          provider,
          (_connection, credential, now) => credential.expires - now < refreshAhead,
        )
        const first = yield* sendWith(connection, call, listing)
        const { credential } = connection
        if (
          first._tag !== "Answered" ||
          first.response.status !== 401 ||
          credential.type !== "oauth" ||
          call.body instanceof ReadableStream
        ) {
          return first
        }
        // Refreshed once however many calls it refused, and not again within a minute.
        const refused = credential.access
        const next = yield* Effect.option(
          refreshed(
            participantId,
            provider,
            (again, current, now) =>
              current.access === refused &&
              (again.refreshedAt === undefined || now - again.refreshedAt >= refreshedLately),
          ),
        )
        if (Option.isNone(next) || tokenOf(next.value.credential) === refused) return first
        yield* discard(first.response)
        return yield* sendWith(next.value, call, listing)
      })

      const call = (participantId: ParticipantId, provider: ModelProvider, request: ApiCall) =>
        callWith(participantId, provider, request, false).pipe(
          Effect.withSpan("ConnectedProviders.call"),
        )

      const claudeHarness = Effect.fn("ConnectedProviders.claudeHarness")(function* (
        participantId: ParticipantId,
      ) {
        const chosen = yield* sql<{ readonly harness: string | null }>`
          SELECT claude_harness AS harness FROM participants WHERE id = ${participantId}
        `
        return chosen[0]?.harness === "Pi" ? ("Pi" as const) : ("ClaudeCode" as const)
      })

      const setClaudeHarness = Effect.fn("ConnectedProviders.setClaudeHarness")(function* (
        participantId: ParticipantId,
        harness: Harness,
      ) {
        yield* sql`
          UPDATE participants SET claude_harness = ${harness === "Pi" ? harness : null}
          WHERE id = ${participantId}
        `
      })

      return ConnectedProviders.of({
        state,
        claudeHarness,
        setClaudeHarness,
        modelsFor,
        connectKey,
        signIn,
        disconnect,
        refreshModels,
        forget,
        kindOf: (participantId, provider) => connectionOf(participantId, provider)?.kind,
        call,
        values: () => [
          ...[...connections.values()].flatMap((held) =>
            [...held.values()].flatMap((connection) => secretsOf(connection.credential)),
          ),
          ...retired.keys(),
        ],
        changes: PubSub.subscribe(published),
      })
    }),
  )

  /** The Models each Member's pi Sessions can run, as ConnectedProviders keeps them. */
  static readonly modelCatalog = Layer.effect(
    ModelCatalog,
    Effect.map(ConnectedProviders, (providers) =>
      ModelCatalog.of({
        modelsFor: providers.modelsFor,
        signedIn: (participantId) =>
          Effect.map(providers.state(participantId), ({ connected }) =>
            connected
              .filter((provider) => provider.kind === "SignIn" && provider.problem === undefined)
              .map((provider) => provider.provider),
          ),
      }),
    ),
  )
}
