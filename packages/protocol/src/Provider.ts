import { Schema } from "effect"
import {
  ClaudeCredentialState,
  RemoveClaudeCredential,
  SetClaudeCredential,
} from "./ClaudeCredential.ts"
import { SecretValue } from "./Environment.ts"
import { RequestId } from "./Ids.ts"
import { ModelName, ThinkingLevel } from "./Model.ts"
import { EpochMillis } from "./Session.ts"

// Connected providers (ADR 0029): a Member's own accounts at Providers, held on the Hub, which
// pi Sessions they create run on. The Hub runs each sign-in itself, keeps and refreshes the
// tokens, and adds them to a Session's model calls at the Gateway, so none enters a Sandbox. A
// Claude credential is the Connected provider for Anthropic, and stays as it is (ADR 0026).

/**
 * A Provider a Member can connect, as pi-ai names it: OpenAI (a ChatGPT subscription, or an API
 * key) and xAI (a SuperGrok or X Premium subscription, or an API key).
 */
export const ProviderId = Schema.Literals(["openai", "xai"])
export type ProviderId = typeof ProviderId.Type

/** Every Provider a Member can connect, in the order the Account page lists them. */
export const ProviderIds: ReadonlyArray<ProviderId> = ProviderId.literals

/**
 * A Provider whose Models a pi Session can run on: a Connected provider's, or `anthropic`, whose
 * Models run through Claude Code on the Creator's Claude credential, in the Sandbox (ADR 0029).
 */
export const ModelProvider = Schema.Literals(["openai", "xai", "anthropic"])
export type ModelProvider = typeof ModelProvider.Type

/** How a Connected provider was connected: a subscription sign-in, or a pasted API key. */
export const ConnectionKind = Schema.Literals(["SignIn", "ApiKey"])
export type ConnectionKind = typeof ConnectionKind.Type

/**
 * A Model a pi Session can run, as the Hub found it under its Creator's account: in the Provider's
 * own model list, and in the pi-ai catalogue the Runner's pi was built with.
 */
export const ProviderModel = Schema.Struct({
  provider: ModelProvider,
  /** The Provider's id for it: `gpt-6-sol`. */
  id: Schema.NonEmptyString,
  /** What the Provider calls it: `GPT-6-Sol`. */
  label: Schema.NonEmptyString,
  /** The thinking levels it takes, lowest first; none for a Model that doesn't think. */
  thinkingLevels: Schema.Array(ThinkingLevel),
  contextWindow: Schema.optionalKey(Schema.Natural),
})
export type ProviderModel = typeof ProviderModel.Type

/** The Session model name a {@link ProviderModel} goes by: `openai/gpt-6-sol`. */
export const providerModelName = (model: Pick<ProviderModel, "provider" | "id">): ModelName =>
  `${model.provider}/${model.id}`

/** The Provider and id a pi Session's model name says, or undefined for one that isn't one. */
export function parseProviderModelName(
  name: string,
): { readonly provider: ModelProvider; readonly id: string } | undefined {
  const slash = name.indexOf("/")
  if (slash <= 0 || slash === name.length - 1) return undefined
  const provider = name.slice(0, slash)
  if (!Schema.is(ModelProvider)(provider)) return undefined
  return { provider, id: name.slice(slash + 1) }
}

/**
 * A Connected provider, as its Member sees it: write-only, so never a token, only what tells it
 * apart, and the Models the Hub last found under it.
 */
export const ConnectedProvider = Schema.Struct({
  provider: ProviderId,
  kind: ConnectionKind,
  /** The account, as the sign-in named it, or an API key's last 4 characters. */
  label: Schema.String,
  connectedAt: EpochMillis,
  models: Schema.Array(ProviderModel),
  /** When the Hub last asked the Provider for its Models; absent before it first has. */
  modelsCheckedAt: Schema.optionalKey(EpochMillis),
  /** Why the last ask failed, kept until one succeeds: the Models above are from before it. */
  modelsProblem: Schema.optionalKey(Schema.String),
  /**
   * Why the connection no longer works, as when the Provider refused to refresh its sign-in:
   * connect it again.
   */
  problem: Schema.optionalKey(Schema.String),
})
export type ConnectedProvider = typeof ConnectedProvider.Type

/** A Provider a Member can connect, and how. */
export const ConnectableProvider = Schema.Struct({
  provider: ProviderId,
  /** `OpenAI`, `xAI`. */
  name: Schema.NonEmptyString,
  /** The sign-in's label, `Sign in with ChatGPT`; absent when it has none. */
  signIn: Schema.optionalKey(Schema.NonEmptyString),
  /** Whether it takes a pasted API key. */
  apiKey: Schema.Boolean,
})
export type ConnectableProvider = typeof ConnectableProvider.Type

/** What a sign-in asks of the Member next, as the Provider's flow goes. */
export const SignInStep = Schema.Union([
  /** Open this URL and sign in; then, if the browser lands on a page that won't load, paste its URL. */
  Schema.TaggedStruct("OpenUrl", {
    url: Schema.NonEmptyString,
    instructions: Schema.optionalKey(Schema.String),
  }),
  /** Open this URL and enter this code there. */
  Schema.TaggedStruct("EnterCode", {
    url: Schema.NonEmptyString,
    code: Schema.NonEmptyString,
  }),
  /** Type or paste something, such as the URL the browser landed on, and send it. */
  Schema.TaggedStruct("Paste", {
    message: Schema.String,
    placeholder: Schema.optionalKey(Schema.String),
  }),
  /** Pick one of these. */
  Schema.TaggedStruct("Choose", {
    message: Schema.String,
    options: Schema.Array(
      Schema.Struct({ id: Schema.NonEmptyString, label: Schema.NonEmptyString }),
    ),
  }),
  /** What the flow is doing, for the Member to read. */
  Schema.TaggedStruct("Progress", { message: Schema.String }),
]).pipe(Schema.toTaggedUnion("_tag"))
export type SignInStep = typeof SignInStep.Type

/**
 * The Runner relay's and the Hub's path for a Session's model calls to a Provider (ADR 0029): pi
 * sends a Provider's own API requests to `<this>/<the API's path>`, with the Session token as its
 * key, and the Gateway sends them on with its Creator's credential.
 */
export const modelGatewayPath = (provider: ModelProvider) => `/gateway/models/${provider}`

// ── Web to Hub ─────────────────────────────────────────────────────────────

/** Ask for the signed-in Member's Connected providers. Answered with {@link ProvidersState}. */
export const GetProviders = Schema.TaggedStruct("GetProviders", {
  requestId: RequestId,
})
export type GetProviders = typeof GetProviders.Type

/**
 * Connect a Provider with an API key, replacing any connection to it. The Hub asks the Provider
 * for its Models with it first, and refuses a key it rejects. Answered with
 * {@link ProvidersState}, or a CommandFailed saying why.
 */
export const ConnectProviderKey = Schema.TaggedStruct("ConnectProviderKey", {
  requestId: RequestId,
  provider: ProviderId,
  apiKey: SecretValue,
})
export type ConnectProviderKey = typeof ConnectProviderKey.Type

/**
 * Start signing in to a Provider with a subscription. The Hub runs the Provider's flow and sends
 * each {@link SignInStepped} as it goes, then {@link SignInEnded}. One sign-in per Member at a
 * time: a new one cancels the last.
 */
export const StartSignIn = Schema.TaggedStruct("StartSignIn", {
  requestId: RequestId,
  provider: ProviderId,
})
export type StartSignIn = typeof StartSignIn.Type

/** Answer a sign-in's Paste or Choose step: the text pasted, or the option's id. */
export const AnswerSignIn = Schema.TaggedStruct("AnswerSignIn", {
  /** The StartSignIn's. */
  requestId: RequestId,
  value: SecretValue,
})
export type AnswerSignIn = typeof AnswerSignIn.Type

/** Cancel a sign-in. Answered with its {@link SignInEnded}. */
export const CancelSignIn = Schema.TaggedStruct("CancelSignIn", {
  requestId: RequestId,
})
export type CancelSignIn = typeof CancelSignIn.Type

/**
 * Disconnect a Provider: the Hub forgets its tokens. Sessions on its Models fail their next model
 * call until it is connected again. Answered with {@link ProvidersState}.
 */
export const DisconnectProvider = Schema.TaggedStruct("DisconnectProvider", {
  requestId: RequestId,
  provider: ProviderId,
})
export type DisconnectProvider = typeof DisconnectProvider.Type

/**
 * Ask each Connected provider (or the one named) for its Models again now, instead of when the
 * Hub's copy is a day old. Answered with {@link ProvidersState} once they answered.
 */
export const RefreshProviderModels = Schema.TaggedStruct("RefreshProviderModels", {
  requestId: RequestId,
  provider: Schema.optionalKey(ProviderId),
})
export type RefreshProviderModels = typeof RefreshProviderModels.Type

// ── Hub to web ─────────────────────────────────────────────────────────────

/**
 * The signed-in Member's Connected providers, what they can connect, and the Models their pi
 * Sessions can run: their Connected providers', and Claude's when they have a Claude credential.
 * Sent to them alone: after the welcome, and to each of their connections when it changes.
 */
export const ProvidersState = Schema.TaggedStruct("ProvidersState", {
  requestId: Schema.optionalKey(RequestId),
  connected: Schema.Array(ConnectedProvider),
  connectable: Schema.Array(ConnectableProvider),
  /** Every Model the Member's pi Sessions can run, most capable first within each Provider. */
  models: Schema.Array(ProviderModel),
})
export type ProvidersState = typeof ProvidersState.Type

/** A sign-in's next step, to the connection that started it. */
export const SignInStepped = Schema.TaggedStruct("SignInStepped", {
  requestId: RequestId,
  provider: ProviderId,
  step: SignInStep,
})
export type SignInStepped = typeof SignInStepped.Type

/**
 * A sign-in ended: connected (a ProvidersState follows), failed with the Provider's reason, or
 * cancelled.
 */
export const SignInEnded = Schema.TaggedStruct("SignInEnded", {
  requestId: RequestId,
  provider: ProviderId,
  outcome: Schema.Literals(["Connected", "Failed", "Cancelled"]),
  message: Schema.optionalKey(Schema.String),
})
export type SignInEnded = typeof SignInEnded.Type

/**
 * Every command about Connected providers, one member of WebToHub: a Claude credential's, the
 * Connected provider for Anthropic, among them.
 */
export const ProviderCommand = Schema.Union([
  SetClaudeCredential,
  RemoveClaudeCredential,
  GetProviders,
  ConnectProviderKey,
  StartSignIn,
  AnswerSignIn,
  CancelSignIn,
  DisconnectProvider,
  RefreshProviderModels,
])
export type ProviderCommand = typeof ProviderCommand.Type

/** Every message about Connected providers, one member of HubToWeb, a Claude credential's too. */
export const ProviderMessage = Schema.Union([
  ClaudeCredentialState,
  ProvidersState,
  SignInStepped,
  SignInEnded,
])
export type ProviderMessage = typeof ProviderMessage.Type

// ── Mod to Hub ─────────────────────────────────────────────────────────────

/**
 * The answer to `GET /mod/providers`: what a pi Session's kndl extension registers at start, the
 * Providers its Creator's Models are at, through the Gateway, and those Models. Claude's are
 * listed when the Creator has a Claude credential, and run through Claude Code in the Sandbox,
 * not the Gateway.
 */
export const ModProviders = Schema.Struct({
  models: Schema.Array(ProviderModel),
  /**
   * The Providers among them connected by a sign-in: their APIs refuse some request fields that
   * an API key's take, which pi leaves out only for a request it sees going to the Provider
   * directly.
   */
  signedIn: Schema.optionalKey(Schema.Array(ProviderId)),
})
export type ModProviders = typeof ModProviders.Type
