// The fake Hub's Connected providers (ADR 0029): Alice's ChatGPT sign-in, connected a week ago, and
// the Models each Provider lists, Claude's while she has a Claude credential. An API key with
// REJECTED in it is refused, as a Provider rejecting it; any other connects, named by its last 4
// characters. The sign-ins are played by FakeHub with the steps below: ChatGPT's opens a page and
// takes the address the browser landed on, pasted, which must have a code in it; xAI's shows a
// code to enter, and connects a few seconds later. Every account, key and code here is made up.

import {
  type ConnectableProvider,
  type ProviderId,
  ProviderIds,
  type ThinkingLevel,
} from "@kndl/protocol"
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

/** What each Provider lists under an account, most capable first. */
export const providerModels: Record<ProviderId, ReadonlyArray<ProviderModelWire>> = {
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
}

export const connectable: ReadonlyArray<ConnectableProvider> = [
  { provider: "openai", name: "OpenAI", signIn: "Sign in with ChatGPT", apiKey: true },
  { provider: "xai", name: "xAI", signIn: "Sign in with SuperGrok or X Premium", apiKey: true },
]

export const providerName = (provider: ProviderId) =>
  connectable.find((each) => each.provider === provider)?.name ?? provider

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
  return { provider, kind, label, connectedAt, models: providerModels[provider], modelsCheckedAt }
}

/** The account each Provider's sign-in finds. */
const signedInAs: Record<ProviderId, string> = { openai: "alice@example.com", xai: "@alice_kim" }

/** The ChatGPT sign-in's page, which sends the browser to its loopback once signed in. */
export const chatGptUrl =
  "https://auth.openai.com/oauth/authorize?response_type=code&client_id=app_fake_kndl&redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback&state=fake-state"

/** What each sign-in shows before it waits: for a paste, or for the code to be entered. */
export const signInSteps: Record<ProviderId, ReadonlyArray<SignInStepWire>> = {
  openai: [
    {
      _tag: "OpenUrl",
      url: chatGptUrl,
      instructions: "Sign in with your ChatGPT account, then come back here.",
    },
    {
      _tag: "Paste",
      message: "Paste the authorization code, or the whole redirect URL.",
      placeholder: "http://localhost:1455/auth/callback?code=…",
    },
  ],
  xai: [
    { _tag: "Progress", message: "Asking xAI for a code…" },
    { _tag: "EnterCode", url: "https://accounts.x.ai/device", code: "WDJB-MJHT" },
  ],
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
    this.#connect(connection(provider, "SignIn", signedInAs[provider], Date.now()))
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
        ? { ...each, models: providerModels[each.provider], modelsCheckedAt: now }
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
