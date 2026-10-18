// The fake Hub's Connected providers (ADR 0029): Alice's ChatGPT sign-in, connected a week ago, and
// the Models each Provider lists, Claude's while she has a Claude credential. Every Provider the Hub
// connects is offered, by the sign-in and key pi-ai has for it. An API key with REJECTED in it is
// refused, as a Provider rejecting it; any other connects, named by its last 4 characters. The
// sign-ins are played by FakeHub with the steps below: ChatGPT's and OpenRouter's open a page and
// take the address the browser landed on, pasted, which must have a code in it, worded as the Hub
// words them (ConnectedProviders.ts); the others show a code to enter, and connect a few seconds
// later, GitHub Copilot's once asked which GitHub. Every account, key and code here is made up.

import {
  type ConnectableProvider,
  type ProviderId,
  ProviderIds,
  type ThinkingLevel,
} from "@kndl/protocol"
import { providerNames } from "../../session/models.ts"
import type {
  ConnectedProviderWire,
  HubMessage,
  ProviderModelWire,
  SignInStepWire,
} from "./wire.ts"

type ProvidersStateWire = Extract<HubMessage, { _tag: "ProvidersState" }>

const day = 24 * 3_600_000

const model = (
  provider: ProviderModelWire["provider"],
  id: string,
  label: string,
  thinkingLevels: ReadonlyArray<ThinkingLevel>,
  contextWindow: number,
): ProviderModelWire => ({ provider, id, label, thinkingLevels, contextWindow })

/** Claude's Models, under a Claude credential, most capable first. */
export const claudeModels: ReadonlyArray<ProviderModelWire> = [
  model(
    "anthropic",
    "claude-opus-5-5",
    "Claude Opus 5.5",
    ["low", "medium", "high", "xhigh", "max"],
    1_000_000,
  ),
  model(
    "anthropic",
    "claude-sonnet-5-5",
    "Claude Sonnet 5.5",
    ["low", "medium", "high", "max"],
    1_000_000,
  ),
  model("anthropic", "claude-haiku-4-5", "Claude Haiku 4.5", [], 200_000),
]

/**
 * A gateway's long list, as OpenRouter's few hundred and Vercel's: made-up Models of a dozen
 * vendors, named as the gateway names them.
 */
function gatewayModels(
  provider: ProviderModelWire["provider"],
  name: (vendor: string, model: string) => string,
): ReadonlyArray<ProviderModelWire> {
  const vendors: ReadonlyArray<readonly [string, string, ReadonlyArray<string>]> = [
    ["anthropic", "Anthropic", ["Claude Sonnet 5", "Claude Haiku 5", "Claude Opus 4.6"]],
    ["openai", "OpenAI", ["GPT-6-Sol mini", "GPT-5.5", "GPT-5.5 mini", "o5", "o5-mini"]],
    ["google", "Google", ["Gemini 4 Argon", "Gemini 3.8 Flash", "Gemini 3.8 Flash Lite"]],
    ["x-ai", "xAI", ["Grok 5", "Grok 5 Fast", "Grok Code 2"]],
    ["deepseek", "DeepSeek", ["DeepSeek V5", "DeepSeek R3", "DeepSeek V4.2"]],
    ["mistralai", "Mistral", ["Mistral Large 4", "Devstral 3", "Codestral 3", "Mistral Small 4"]],
    ["qwen", "Qwen", ["Qwen 4 Coder 480B", "Qwen 4 235B", "Qwen 4 32B", "Qwen 4 Max"]],
    ["moonshotai", "MoonshotAI", ["Kimi K3", "Kimi K3 Thinking"]],
    ["z-ai", "Z.AI", ["GLM 5.5", "GLM 5.5 Air"]],
    ["meta-llama", "Meta", ["Llama 5 Maverick", "Llama 5 Scout"]],
    ["minimax", "MiniMax", ["MiniMax M3"]],
    ["nvidia", "NVIDIA", ["Nemotron Ultra 300B", "Nemotron Super 70B"]],
  ]
  return vendors.flatMap(([vendor, vendorName, names]) =>
    names.map((each) =>
      model(
        provider,
        `${vendor}/${each.toLowerCase().replaceAll(" ", "-")}`,
        name(vendorName, each),
        /thinking|^o5|r3|opus|sonnet|argon/i.test(each) ? ["low", "medium", "high"] : [],
        200_000,
      ),
    ),
  )
}

/** What some Providers list under an account, most capable first. */
const listed: Partial<Record<ProviderId, ReadonlyArray<ProviderModelWire>>> = {
  openai: [
    model(
      "openai",
      "gpt-6-sol",
      "GPT-6-Sol",
      ["minimal", "low", "medium", "high", "xhigh"],
      400_000,
    ),
    model("openai", "gpt-6-sol-mini", "GPT-6-Sol mini", ["low", "medium", "high"], 400_000),
    model("openai", "gpt-4.1", "GPT-4.1", [], 1_000_000),
  ],
  xai: [
    model("xai", "grok-5", "Grok 5", ["low", "high"], 2_000_000),
    model("xai", "grok-5-fast", "Grok 5 Fast", [], 2_000_000),
  ],
  "github-copilot": [
    model("github-copilot", "claude-opus-5", "Claude Opus 5", ["low", "medium", "high"], 200_000),
    model("github-copilot", "gpt-6-sol", "GPT-6-Sol", ["low", "medium", "high"], 400_000),
  ],
  openrouter: [
    model("openrouter", "anthropic/claude-opus-5", "Anthropic: Claude Opus 5", ["high"], 200_000),
    model("openrouter", "openai/gpt-6-sol", "OpenAI: GPT-6-Sol", ["low", "high"], 400_000),
    ...gatewayModels("openrouter", (vendor, name) => `${vendor}: ${name}`),
  ],
  "vercel-ai-gateway": gatewayModels("vercel-ai-gateway", (_, name) => name),
  google: [
    model("google", "gemini-4-argon", "Gemini 4 Argon", ["low", "medium", "high"], 1_048_576),
    model("google", "gemini-3.8-flash", "Gemini 3.8 Flash", ["low", "high"], 1_048_576),
  ],
}

/** What each Provider lists under an account: a made-up Model for one with none above. */
export const providerModels = (provider: ProviderId): ReadonlyArray<ProviderModelWire> =>
  listed[provider] ?? [
    model(provider, `${provider}-large`, `${providerNames[provider]} Large`, [], 128_000),
  ]

/** The sign-ins pi-ai has, by Provider. */
const signIns: Partial<Record<ProviderId, string>> = {
  openai: "Sign in with ChatGPT",
  xai: "Sign in with SuperGrok or X Premium",
  "github-copilot": "Sign in with GitHub Copilot",
  openrouter: "Sign in with OpenRouter",
  "kimi-coding": "Sign in with Kimi Code",
  meta: "Sign in with Meta",
}

/** What pi-ai calls a Provider's key, where it isn't `<name> API key`. */
const keyNames: Partial<Record<ProviderId, string>> = {
  google: "Gemini API key",
  "kimi-coding": "Kimi API key",
  meta: "Meta Model API key",
  huggingface: "Hugging Face token",
  "moonshotai-cn": "Moonshot AI API key",
}

export const connectable: ReadonlyArray<ConnectableProvider> = ProviderIds.map((provider) => {
  const signIn = signIns[provider]
  // GitHub Copilot's key is the one its sign-in gets.
  const apiKey = provider !== "github-copilot"
  return {
    provider,
    name: providerNames[provider],
    ...(signIn !== undefined && { signIn }),
    apiKey,
    ...(apiKey && { keyName: keyNames[provider] ?? `${providerNames[provider]} API key` }),
  }
})

export const providerName = (provider: ProviderId) => providerNames[provider]

/** Alice's Connected providers: her ChatGPT sign-in, connected a week ago. */
export function seedProviders(now = Date.now()): Array<ConnectedProviderWire> {
  return [connection("openai", "SignIn", "alice@example.com", now - 7 * day, now - 2 * 3_600_000)]
}

function connection(
  provider: ProviderId,
  kind: ConnectedProviderWire["kind"],
  label: string,
  connectedAt: number,
  modelsCheckedAt = connectedAt,
): ConnectedProviderWire {
  return { provider, kind, label, connectedAt, models: providerModels(provider), modelsCheckedAt }
}

/** The account each Provider's sign-in finds. */
const signedInAs: Partial<Record<ProviderId, string>> = {
  openai: "alice@example.com",
  xai: "@alice_kim",
}

/** The ChatGPT sign-in's page, which sends the browser to its loopback once signed in. */
export const chatGptUrl =
  "https://auth.openai.com/oauth/authorize?response_type=code&client_id=app_fake_kndl&redirect_uri=http%3A%2F%2F127.0.0.1%3A1455%2Fauth%2Fcallback&state=fake-state"

/** Where each device-code sign-in has its code entered. */
const devicePages: Partial<Record<ProviderId, string>> = {
  xai: "https://accounts.x.ai/device",
  "github-copilot": "https://github.com/login/device",
  "kimi-coding": "https://auth.kimi.com/device",
  meta: "https://www.meta.ai/device",
}

/** What each sign-in shows before it waits: for a paste, or for the code to be entered. */
export function signInSteps(provider: ProviderId): ReadonlyArray<SignInStepWire> {
  if (provider === "openai" || provider === "openrouter") {
    const name = provider === "openai" ? "ChatGPT" : "OpenRouter"
    return [
      {
        _tag: "OpenUrl",
        url:
          provider === "openai"
            ? chatGptUrl
            : "https://openrouter.ai/auth?callback_url=http%3A%2F%2Flocalhost%3A3000%2Fcallback",
        instructions: `Sign in to ${name} in the page this opens. It then lands on a page at 127.0.0.1 that may not load: that's expected. Copy that page's address from the address bar and paste it below.`,
      },
      {
        _tag: "Paste",
        message: `Paste the address of the page your browser landed on after you signed in: it starts with ${provider === "openai" ? "http://127.0.0.1:1455/" : "http://127.0.0.1"}.`,
        placeholder: "http://127.0.0.1:1455/auth/callback?code=…",
      },
    ]
  }
  return [
    ...(provider === "github-copilot"
      ? [
          {
            _tag: "Choose" as const,
            message: "Which GitHub is your Copilot subscription on?",
            options: [
              { id: "github.com", label: "GitHub.com" },
              { id: "enterprise", label: "GitHub Enterprise" },
            ],
          },
        ]
      : []),
    { _tag: "Progress", message: `Asking ${providerNames[provider]} for a code…` },
    {
      _tag: "EnterCode",
      url: devicePages[provider] ?? "https://example.com/device",
      code: "WDJB-MJHT",
    },
  ]
}

/** Why a pasted answer to ChatGPT's sign-in fails, or undefined for one with a code. */
export const pasteProblem = (value: string) =>
  /[?&]code=[^&\s]+/.test(value) || /^[\w-]{6,}$/.test(value.trim())
    ? undefined
    : "That address has no code in it: paste the whole address from the browser's address bar."

export class FakeProviders {
  connected: Array<ConnectedProviderWire>

  constructor(connected: ReadonlyArray<ConnectedProviderWire>) {
    this.connected = [...connected]
  }

  /** What the Hub sends the signed-in person: Claude's Models first while they have a credential. */
  state(withClaude: boolean, requestId?: string): ProvidersStateWire {
    return {
      _tag: "ProvidersState",
      ...(requestId !== undefined && { requestId }),
      connected: [...this.connected],
      connectable: [...connectable],
      models: [
        ...(withClaude ? claudeModels : []),
        ...ProviderIds.flatMap(
          (provider) => this.connected.find((each) => each.provider === provider)?.models ?? [],
        ),
      ],
    }
  }

  /** Connects with an API key, or says why the Provider refused it. */
  connectKey(provider: ProviderId, apiKey: string): string | undefined {
    if (apiKey.includes("REJECTED")) return `${providerName(provider)} rejected this key.`
    this.#connect(connection(provider, "ApiKey", apiKey.trim().slice(-4), Date.now()))
    return undefined
  }

  /** Connects as a sign-in found the account. */
  signedIn(provider: ProviderId): void {
    const account = signedInAs[provider] ?? `${providerNames[provider]} subscription`
    this.#connect(connection(provider, "SignIn", account, Date.now()))
  }

  disconnect(provider: ProviderId): string | undefined {
    const kept = this.connected.filter((each) => each.provider !== provider)
    if (kept.length === this.connected.length)
      return `You haven't connected ${providerName(provider)}.`
    this.connected = kept
    return undefined
  }

  /** Asks the Provider, or each, for its Models again: they answer with the same. */
  refresh(provider: ProviderId | undefined): void {
    const now = Date.now()
    this.connected = this.connected.map((each) =>
      provider === undefined || each.provider === provider
        ? { ...each, models: providerModels(each.provider), modelsCheckedAt: now }
        : each,
    )
  }

  #connect(connected: ConnectedProviderWire): void {
    this.connected = [
      ...this.connected.filter((each) => each.provider !== connected.provider),
      connected,
    ].toSorted((a, b) => ProviderIds.indexOf(a.provider) - ProviderIds.indexOf(b.provider))
  }
}
