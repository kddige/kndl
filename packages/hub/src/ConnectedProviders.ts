// Each Member's Connected providers (ADR 0029): their own accounts at OpenAI and xAI, held on the
// Hub, which the pi Sessions they create run on through the Gateway (GatewayRoutes.ts).
//
// - Connecting: with an API key, which the Hub lists the Provider's Models with first, refusing a
//   key the Provider rejects; or by signing in with a subscription, through pi-ai's own flow, run
//   on the Hub (ProviderRelay.ts passes its steps on). Sign in with ChatGPT ends on
//   `127.0.0.1:1455` on the Hub's machine, which the Member's browser can't reach: they paste the
//   address it landed on instead. One per Member and Provider: connecting again replaces it.
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
//   catalogue knows, which the Runner's pi was built with. Claude's come from Anthropic under the
//   Member's Claude credential (ClaudeCredentials.ts), kept the same way, and are the catalogue's
//   current ones when Anthropic can't say.
// - Every key and token, and every one replaced or forgotten since the Hub started, is masked in
//   what Sessions print (Redaction.ts), as Claude credentials are.
// - Removing a Member forgets theirs.

import { randomUUID } from "node:crypto"
import type {
  Api,
  AuthEvent,
  AuthPrompt,
  Credential,
  LoginOptions,
  Model,
  OAuthCredential,
  ProviderAuthInteraction,
} from "@earendil-works/pi-ai"
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai/models"
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic"
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai"
import { xaiProvider } from "@earendil-works/pi-ai/providers/xai"
import {
  type ConnectableProvider,
  type ConnectedProvider,
  type ConnectionKind,
  type ModelProvider,
  type ParticipantId,
  type ProviderId,
  ProviderIds,
  ProviderModel,
  type SignInStep,
  ThinkingLevel,
  ThinkingLevels,
} from "@kndl/protocol"
import {
  Clock,
  Context,
  Duration,
  Effect,
  Layer,
  Option,
  PubSub,
  Redacted,
  type Scope,
  Schema,
  Semaphore,
} from "effect"
import { SqlClient } from "effect/sql"
import type { SqlError } from "effect/sql/SqlError"
import { ClaudeCredentials, oauthBeta } from "./ClaudeCredentials.ts"
import { ModelCatalog } from "./ModelCatalog.ts"
import { Secrets } from "./Secrets.ts"

// ── pi-ai and the Providers ────────────────────────────────────────────────

/** pi-ai's built-in providers, whose URLs, sign-ins and catalogues the Hub uses. */
const builtIn = {
  openai: openaiProvider(),
  xai: xaiProvider(),
  anthropic: anthropicProvider(),
}

/** The Provider's sign-in, as pi-ai has it. */
const oauthOf = (provider: ProviderId) => {
  const oauth = builtIn[provider].auth.oauth
  if (oauth === undefined) throw new Error(`pi-ai has no sign-in for ${provider}`)
  return oauth
}

/**
 * What the Hub needs of the Providers: where their APIs are, how to reach them, and pi-ai's sign-in
 * flows. The live layer is pi-ai's built-in providers and `fetch`; the test layer asks no one.
 */
export class ProviderApis extends Context.Service<
  ProviderApis,
  {
    /** Where the Provider's API is, as pi-ai's built-in provider has it: `https://api.openai.com/v1`. */
    readonly baseUrl: (provider: ModelProvider) => string
    /** Sends a request to a Provider, as `fetch`. */
    readonly fetch: (
      request: Request,
      init?: { readonly decompress?: boolean },
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
  }
>()("@kndl/hub/ProviderApis") {
  static readonly layer = Layer.succeed(ProviderApis, {
    baseUrl: (provider) => builtIn[provider].baseUrl ?? "",
    fetch: (request, init) => fetch(request, init as RequestInit),
    signIn: (provider, interaction, options) => oauthOf(provider).login(interaction, options),
    refresh: (provider, credential, signal) => oauthOf(provider).refresh(credential, signal),
  })

  /**
   * pi-ai's URLs, with fakes for the rest, for tests: by default every Provider answers 503, and
   * every sign-in and refresh fails.
   */
  static readonly layerTest = (
    fakes: {
      readonly fetch?: (request: Request) => Promise<Response>
      readonly signIn?: ProviderApis["Service"]["signIn"]
      readonly refresh?: ProviderApis["Service"]["refresh"]
    } = {},
  ) =>
    Layer.succeed(ProviderApis, {
      baseUrl: (provider) => builtIn[provider].baseUrl ?? "",
      fetch: fakes.fetch ?? (async () => new Response("No Provider in tests", { status: 503 })),
      signIn: fakes.signIn ?? (async () => Promise.reject(new Error("No sign-in in tests"))),
      refresh: fakes.refresh ?? (async () => Promise.reject(new Error("No refresh in tests"))),
    })
}

/** What the Account page calls each Provider. */
const nameOf = (provider: ModelProvider) => builtIn[provider].name

/** What a sign-in is labelled when its tokens don't name the account. */
const subscriptionOf: Record<ProviderId, string> = {
  openai: "ChatGPT subscription",
  xai: "SuperGrok or X Premium",
}

/** Every Provider a Member can connect, and how, in the order the Account page lists them. */
const connectable: ReadonlyArray<ConnectableProvider> = ProviderIds.map((provider) => {
  const { auth } = builtIn[provider]
  const signIn = auth.oauth?.loginLabel
  return {
    provider,
    name: nameOf(provider),
    ...(signIn !== undefined && { signIn }),
    apiKey: auth.apiKey !== undefined,
  }
})

// ── The Models ─────────────────────────────────────────────────────────────

/** How long the Models last found are kept before the Hub asks again. */
const modelsLifetime = Duration.toMillis(Duration.days(1))
/** How long the Hub waits for a Provider to list its Models. */
const listTimeout = Duration.seconds(15)
/** How long a reason from a Provider is kept, so a strange answer can't flood the page. */
const reasonLimit = 200

const isThinkingLevel = Schema.is(ThinkingLevel)

/** The thinking levels the Model takes, lowest first: the Provider's, else pi-ai's. */
function thinkingLevelsOf(model: Model<Api>, said: ReadonlyArray<string> = []) {
  if (!model.reasoning) return []
  const fromProvider = said.filter(isThinkingLevel)
  const levels =
    fromProvider.length > 0
      ? fromProvider
      : getSupportedThinkingLevels(model).filter(isThinkingLevel)
  return ThinkingLevels.filter((level) => levels.includes(level))
}

/** The Model as the Hub lists it, if pi-ai's catalogue for the Provider has it. */
function modelOf(
  provider: ModelProvider,
  id: string,
  said: {
    readonly label?: unknown
    readonly contextWindow?: unknown
    readonly thinkingLevels?: ReadonlyArray<string>
  } = {},
): ProviderModel | undefined {
  const known = builtIn[provider].getModels().find((model) => model.id === id)
  if (known === undefined) return undefined
  const contextWindow =
    typeof said.contextWindow === "number" &&
    Number.isInteger(said.contextWindow) &&
    said.contextWindow > 0
      ? said.contextWindow
      : known.contextWindow
  return {
    provider,
    id,
    label: typeof said.label === "string" && said.label !== "" ? said.label : known.name,
    thinkingLevels: thinkingLevelsOf(known, said.thinkingLevels),
    ...(Number.isInteger(contextWindow) && contextWindow >= 0 && { contextWindow }),
  }
}

/**
 * Claude's current Models in pi-ai's catalogue, for when Anthropic can't say: the newest of each
 * kind, not a dated snapshot, the most costly first.
 */
const currentClaude: ReadonlyArray<ProviderModel> = (() => {
  const newest = new Map<string, Model<Api>>()
  for (const model of builtIn.anthropic.getModels()) {
    const kind = /^claude-([a-z]+)-/.exec(model.id)?.[1]
    if (kind === undefined || /-\d{8}$/.test(model.id)) continue
    newest.set(kind, model)
  }
  return [...newest.values()]
    .toSorted((a, b) => b.cost.output - a.cost.output)
    .flatMap((model) => modelOf("anthropic", model.id) ?? [])
})()

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined

const records = (value: unknown): ReadonlyArray<Record<string, unknown>> =>
  Array.isArray(value)
    ? value.flatMap<Record<string, unknown>>((each: unknown) => record(each) ?? [])
    : []

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/**
 * The Models a Provider's answer lists, those pi-ai knows. A ChatGPT sign-in's answer ranks them,
 * and says which to show; an API key's, and xAI's, are listed newest first.
 */
function modelsListed(provider: ModelProvider, body: unknown): ReadonlyArray<ProviderModel> {
  const answer = record(body)
  if (answer !== undefined && Array.isArray(answer.models)) {
    return records(answer.models).flatMap((model) => {
      if (model.visibility !== "list" || typeof model.slug !== "string") return []
      return (
        modelOf(provider, model.slug, {
          label: model.display_name,
          contextWindow: model.context_window,
          thinkingLevels: records(model.supported_reasoning_levels).flatMap((level) =>
            typeof level.effort === "string" ? [level.effort] : [],
          ),
        }) ?? []
      )
    })
  }
  const data = records(answer?.data)
  // Anthropic lists the newest first already, and says no `created`.
  const ranked =
    provider === "anthropic"
      ? data
      : data.toSorted(
          (a, b) =>
            (typeof b.created === "number" ? b.created : 0) -
            (typeof a.created === "number" ? a.created : 0),
        )
  return ranked.flatMap((model) =>
    typeof model.id === "string"
      ? (modelOf(provider, model.id, { label: model.display_name }) ?? [])
      : [],
  )
}

/** What asking a Provider for its Models came to. */
type Listed =
  | { readonly _tag: "Listed"; readonly models: ReadonlyArray<ProviderModel> }
  /** The Provider refused the credential: `message` says why, for its owner. */
  | { readonly _tag: "Rejected"; readonly message: string }
  /** The Provider couldn't be asked, or gave no clear answer: `message` says so. */
  | { readonly _tag: "Unavailable"; readonly message: string }

/** The Provider's own reason, from its error shape, kept short. */
const reasonIn = (body: string) => {
  const said = record(record(parseJson(body))?.error)?.message
  return typeof said === "string" ? `: ${said.slice(0, reasonLimit)}` : ""
}

/** A reason from pi-ai, kept short. */
const reasonOf = (error: unknown) =>
  (error instanceof Error ? error.message : String(error)).slice(0, reasonLimit)

/**
 * Whether pi-ai's refresh failed because the Provider refused it, rather than couldn't be asked:
 * pi-ai says the token endpoint's status, or that the credential can't be refreshed.
 */
const refusedRefresh = (error: unknown) =>
  /\((?:HTTP )?(?:400|401|403)\)|reconnect/i.test(reasonOf(error))

/**
 * Who the sign-in is for, if its access token says: a JWT's `email`, or OpenAI's profile's.
 * Read without checking its signature, for a label alone.
 */
function accountOf(access: string): string | undefined {
  const payload = access.split(".")[1]
  if (payload === undefined) return undefined
  try {
    const claims = record(JSON.parse(Buffer.from(payload, "base64url").toString("utf8")))
    const email = claims?.email ?? record(claims?.["https://api.openai.com/profile"])?.email
    return typeof email === "string" && email !== "" ? email : undefined
  } catch {
    return undefined
  }
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
 * ChatGPT's sign-in lands the browser on the Hub's own `127.0.0.1:1455`, which is the Member's
 * machine, not the Hub's, unless they are the same: they paste that address instead.
 */
const chatGptOpen =
  "Sign in to ChatGPT in the page this opens. It then lands on a page at 127.0.0.1 that may not load: that's expected. Copy that page's address from the address bar and paste it below."
const chatGptPaste =
  "Paste the address of the page your browser landed on after you signed in: it starts with http://127.0.0.1:1455/."

/** The step a pi-ai sign-in event shows the Member. */
function stepOf(provider: ProviderId, event: AuthEvent): SignInStep | undefined {
  switch (event.type) {
    case "auth_url":
      return {
        _tag: "OpenUrl",
        url: event.url,
        ...(provider === "openai"
          ? { instructions: chatGptOpen }
          : event.instructions !== undefined && { instructions: event.instructions }),
      }
    case "device_code":
      return { _tag: "EnterCode", url: event.verificationUri, code: event.userCode }
    case "progress":
    case "info":
      return { _tag: "Progress", message: event.message }
  }
}

/** The step a pi-ai sign-in prompt asks of the Member. */
function askOf(
  provider: ProviderId,
  prompt: AuthPrompt,
): Extract<SignInStep, { readonly _tag: "Paste" | "Choose" }> {
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
          provider === "openai" && prompt.type === "manual_code" ? chatGptPaste : prompt.message,
        ...(prompt.placeholder !== undefined && { placeholder: prompt.placeholder }),
      }
  }
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

/** Why a connection can't be kept on a Hub without a secrets key. */
const noKey = (provider: ProviderId) =>
  `This Hub can't store a ${nameOf(provider)} connection: it needs HUB_SECRETS_KEY in its configuration. Ask whoever runs it to set one.`

/** What a call to a Provider goes with: its access token or API key. */
export interface CallCredential {
  readonly kind: ConnectionKind
  readonly token: Redacted.Redacted<string>
}

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
    /** Forgets every connection of the Member, as when they are removed. */
    readonly forget: (participantId: ParticipantId) => Effect.Effect<void, SqlError>
    /**
     * What the Member's call to the Provider goes with now: its sign-in refreshed first if it
     * expires within 5 minutes.
     */
    readonly credentialFor: (
      participantId: ParticipantId,
      provider: ModelProvider,
    ) => Effect.Effect<CallCredential, ProviderUnusable>
    /**
     * The Provider refused `token`: the sign-in's tokens refreshed, once however many calls it
     * refused, to send the call with once more; none for an API key, or a refresh that failed.
     */
    readonly rejected: (
      participantId: ParticipantId,
      provider: ModelProvider,
      token: string,
    ) => Effect.Effect<Option.Option<CallCredential>>
    /** Every key and token held, and every one replaced or forgotten since the Hub started. */
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
      const scope = yield* Effect.scope
      const published = yield* PubSub.unbounded<ProvidersChanged>()

      const connections = new Map<ParticipantId, Map<ProviderId, Connection>>()
      const claudeModels = new Map<ParticipantId, ClaudeModels>()
      const retired = new Set<string>()
      /** One refresh at a time for each credential. */
      const refreshing = new Map<string, Semaphore.Semaphore>()
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

      /** Keeps the secrets of a credential no longer held, for redaction. */
      const retire = (before: Credential | undefined, after?: Credential) => {
        if (before === undefined) return
        const kept = new Set(after === undefined ? [] : secretsOf(after))
        for (const secret of secretsOf(before)) if (!kept.has(secret)) retired.add(secret)
      }

      const changed = (participantId: ParticipantId, answered: boolean) =>
        PubSub.publish(published, { participantId, answered })

      const lockOf = (participantId: ParticipantId, provider: ProviderId) => {
        const key = `${participantId}\n${provider}`
        let lock = refreshing.get(key)
        if (lock === undefined) {
          lock = Semaphore.makeUnsafe(1)
          refreshing.set(key, lock)
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

      /** Asks the Provider for its Models with the token: those pi-ai knows, or why not. */
      const listModels = (provider: ModelProvider, token: string, kind: ConnectionKind) =>
        Effect.tryPromise({
          try: async (signal): Promise<Listed> => {
            const name = nameOf(provider)
            const request =
              provider === "anthropic"
                ? new Request(`${apis.baseUrl(provider)}/v1/models?limit=1000`, {
                    headers: {
                      authorization: `Bearer ${token}`,
                      "anthropic-beta": oauthBeta,
                      "anthropic-version": "2023-06-01",
                    },
                    signal,
                  })
                : new Request(`${apis.baseUrl(provider)}/models`, {
                    headers: { authorization: `Bearer ${token}` },
                    signal,
                  })
            const response = await apis.fetch(request)
            const body = await response.text()
            if (response.status === 401 || response.status === 403) {
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
            return { _tag: "Listed", models: modelsListed(provider, parseJson(body)) }
          },
          catch: () => undefined,
        }).pipe(
          Effect.timeoutOrElse({
            duration: listTimeout,
            orElse: () => Effect.fail(undefined),
          }),
          Effect.catch(() =>
            Effect.succeed<Listed>({
              _tag: "Unavailable",
              message: `${nameOf(provider)} couldn't be reached`,
            }),
          ),
        )

      /** Asks Anthropic for Claude's Models under the Member's Claude credential, and keeps them. */
      const askClaude = Effect.fn("ConnectedProviders.askClaude")(function* (
        participantId: ParticipantId,
      ) {
        const credential = claude.credentialOf(participantId)
        if (credential === undefined) return
        const token = Redacted.value(credential.token)
        const listed = yield* listModels("anthropic", token, "SignIn")
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

      /** Asks the Provider for the Member's Models, and keeps what it said. */
      const askModels = Effect.fn("ConnectedProviders.askModels")(function* (
        participantId: ParticipantId,
        provider: ProviderId,
      ): Effect.fn.Return<void, SqlError> {
        const before = connectionOf(participantId, provider)
        if (before === undefined || before.problem !== undefined) return
        const credential = yield* Effect.option(credentialFor(participantId, provider))
        if (Option.isNone(credential)) return
        const listed = yield* listModels(
          provider,
          Redacted.value(credential.value.token),
          credential.value.kind,
        )
        const now = yield* Clock.currentTimeMillis
        const current = connectionOf(participantId, provider)
        // Disconnected or connected again meanwhile.
        if (current === undefined || current.connectedAt !== before.connectedAt) return
        const { modelsProblem: _, ...rest } = current
        const next: Connection =
          listed._tag === "Listed"
            ? { ...rest, models: listed.models, modelsCheckedAt: now }
            : { ...current, modelsCheckedAt: now, modelsProblem: listed.message }
        yield* sql`
          UPDATE connected_providers SET models = ${encodeModels(next.models)},
            models_checked_at = ${now}, models_problem = ${next.modelsProblem ?? null}
          WHERE participant_id = ${participantId} AND provider = ${provider}
        `
        keep(participantId, next)
      })

      /** Asks off the call, once at a time for each list, telling the Member's web clients after. */
      const askInBackground = (participantId: ParticipantId, provider: ModelProvider) => {
        const key = `${participantId}\n${provider}`
        if (asking.has(key)) return Effect.void
        asking.add(key)
        const ask: Effect.Effect<void, SqlError> =
          provider === "anthropic"
            ? askClaude(participantId)
            : askModels(participantId, provider).pipe(Effect.andThen(changed(participantId, false)))
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
        if (credential === undefined) return []
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
        const models = listed._tag === "Listed" ? listed.models : []
        const modelsProblem = listed._tag === "Listed" ? null : listed.message
        yield* sql`
          INSERT INTO connected_providers (participant_id, provider, kind, credential, label,
            connected_at, models, models_checked_at, models_problem, problem)
          VALUES (${participantId}, ${provider}, ${connection.kind}, ${ciphertext},
            ${connection.label}, ${now}, ${encodeModels(models)}, ${now}, ${modelsProblem}, NULL)
          ON CONFLICT (participant_id, provider) DO UPDATE SET kind = excluded.kind,
            credential = excluded.credential, label = excluded.label,
            connected_at = excluded.connected_at, models = excluded.models,
            models_checked_at = excluded.models_checked_at,
            models_problem = excluded.models_problem, problem = NULL
        `
        const before = connectionOf(participantId, provider)
        retire(before?.credential, credential)
        for (const secret of secretsOf(credential)) retired.delete(secret)
        keep(participantId, {
          provider,
          ...connection,
          connectedAt: now,
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
        const key = Redacted.value(apiKey).trim()
        if (key === "" || /\s/.test(key)) {
          return yield* new ProviderRefusal({ message: `Paste the ${nameOf(provider)} API key.` })
        }
        if (!secrets.available) return yield* new ProviderRefusal({ message: noKey(provider) })
        const listed = yield* listModels(provider, key, "ApiKey")
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
        const credential = yield* Effect.tryPromise({
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
                  steps.ask(
                    askOf(provider, prompt),
                    prompt.signal === undefined ? signal : AbortSignal.any([signal, prompt.signal]),
                  ),
              },
              { getDeviceId: () => device, agentName: "kndl" },
            ),
          catch: (error) => new ProviderRefusal({ message: reasonOf(error) }),
        })
        const listed = yield* listModels(provider, credential.access, "SignIn")
        yield* store(
          participantId,
          provider,
          { kind: "SignIn", label: accountOf(credential.access) ?? subscriptionOf[provider] },
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
        retire(before.credential)
        connections.get(participantId)?.delete(provider)
        yield* changed(participantId, true)
        return true
      })

      const forget = Effect.fn("ConnectedProviders.forget")(function* (
        participantId: ParticipantId,
      ) {
        yield* sql`DELETE FROM connected_providers WHERE participant_id = ${participantId}`
        for (const connection of connections.get(participantId)?.values() ?? []) {
          retire(connection.credential)
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

      /**
       * The Member's connection to the Provider, its sign-in refreshed first if `due` says so, one
       * refresh at a time; the rotated credential kept. A refresh the Provider refuses is kept as
       * the connection's problem.
       */
      const refreshed = (
        participantId: ParticipantId,
        provider: ModelProvider,
        due: (credential: OAuthCredential, now: number) => boolean,
      ): Effect.Effect<Connection, ProviderUnusable> => {
        const usable = Effect.gen(function* () {
          const connection = connectionOf(participantId, provider)
          if (connection === undefined) return yield* notConnected(provider)
          if (connection.problem !== undefined) {
            return yield* unusable("Broken", connection.problem)
          }
          const { credential } = connection
          const now = yield* Clock.currentTimeMillis
          return credential.type === "oauth" && due(credential, now)
            ? { refresh: credential, connection }
            : { connection }
        })
        return Effect.gen(function* () {
          const first = yield* usable
          if (first.refresh === undefined || provider === "anthropic") return first.connection
          return yield* lockOf(participantId, provider).withPermits(1)(
            Effect.gen(function* () {
              // Another call may have refreshed it meanwhile.
              const { connection, refresh } = yield* usable
              if (refresh === undefined) return connection
              const name = nameOf(provider)
              const rotated = yield* Effect.tryPromise({
                try: (signal) => apis.refresh(provider, refresh, signal),
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
                yield* sql`
                  UPDATE connected_providers SET problem = ${problem}
                  WHERE participant_id = ${participantId} AND provider = ${provider}
                `.pipe(Effect.orDie)
                keep(participantId, { ...connection, problem })
                yield* changed(participantId, false)
                return yield* unusable("Broken", problem)
              }
              const credential: OAuthCredential = { ...rotated.success, type: "oauth" }
              const ciphertext = yield* seal(participantId, provider, credential).pipe(
                Effect.mapError((error) => unusable("Unavailable", error.message)),
              )
              yield* sql`
                UPDATE connected_providers SET credential = ${ciphertext}
                WHERE participant_id = ${participantId} AND provider = ${provider}
              `.pipe(Effect.orDie)
              retire(connection.credential, credential)
              const next = { ...connection, credential }
              // Unless disconnected meanwhile.
              if (connectionOf(participantId, provider) === connection) keep(participantId, next)
              yield* changed(participantId, false)
              return next
            }),
          )
        })
      }

      const callCredential = (connection: Connection): CallCredential => ({
        kind: connection.kind,
        token: Redacted.make(tokenOf(connection.credential)),
      })

      const credentialFor = (participantId: ParticipantId, provider: ModelProvider) =>
        refreshed(
          participantId,
          provider,
          (credential, now) => credential.expires - now < refreshAhead,
        ).pipe(Effect.map(callCredential), Effect.withSpan("ConnectedProviders.credentialFor"))

      const rejected = (participantId: ParticipantId, provider: ModelProvider, token: string) =>
        refreshed(participantId, provider, (credential) => credential.access === token).pipe(
          Effect.map((connection) =>
            tokenOf(connection.credential) === token
              ? Option.none<CallCredential>()
              : Option.some(callCredential(connection)),
          ),
          Effect.catchTag("ProviderUnusable", () => Effect.succeed(Option.none<CallCredential>())),
          Effect.withSpan("ConnectedProviders.rejected"),
        )

      return ConnectedProviders.of({
        state,
        modelsFor,
        connectKey,
        signIn,
        disconnect,
        refreshModels,
        forget,
        credentialFor,
        rejected,
        values: () => [
          ...[...connections.values()].flatMap((held) =>
            [...held.values()].flatMap((connection) => secretsOf(connection.credential)),
          ),
          ...retired,
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
