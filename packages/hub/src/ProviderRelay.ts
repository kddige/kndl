// What the Session relay does with the web's commands about Connected providers (ADR 0029): a
// Claude credential's are SessionRelay's, the rest this relay's (ConnectedProviders.ts keeps them).
//
// - Each Member is sent their Connected providers, what they can connect and the Models their pi
//   Sessions can run (ProvidersState) after the welcome, and to each of their connections whenever
//   that changes: a connection made or lost, a refresh refused, the Models found again, or their
//   Claude credential changed, since Claude's Models are among them. No one else is sent them.
// - Which Harness runs Claude's Models in a Member's new Sessions (ADR 0030) is theirs to set
//   (SetClaudeHarness), kept with them as a Member (Members.ts), sent with the rest.
// - Connecting with an API key waits for the Provider to list its Models with it, and asking for
//   the Models again waits for each Provider: both off the lock, and off the connection's other
//   commands, which are answered meanwhile.
// - A sign-in runs the Provider's flow on the Hub, off the connection's own messages, so the
//   Member can answer its steps: each is sent to the connection that started it (SignInStepped),
//   and then how it ended (SignInEnded). The steps are pi-ai's, in the Hub's words where pi-ai's
//   don't fit: Sign in with ChatGPT, and OpenRouter's, end on `127.0.0.1` on the Hub's machine,
//   which the Member's browser can't reach, so they paste the address it landed on instead, and
//   GitHub Copilot's asks which GitHub first, as a choice. One sign-in per Member at a time: a new one, from any of
//   their connections, cancels the last. It is cancelled too when its connection goes, or the
//   Member is removed.

import type { AuthEvent, AuthPrompt } from "@earendil-works/pi-ai"
import {
  CommandFailed,
  type HubToWeb,
  type Participant,
  type ParticipantId,
  ProviderCommand,
  type ProviderId,
  ProvidersState,
  type RequestId,
  SignInEnded,
  type SignInStep,
  SignInStepped,
  type WebToHub,
} from "@kndl/protocol"
import { Cause, Effect, Exit, Fiber, Option, Redacted, Schema, type Scope } from "effect"
import type { SqlError } from "effect/sql/SqlError"
import { ConnectedProviders, type ProviderRefusal } from "./ConnectedProviders.ts"
import { Members } from "./Members.ts"
import type { Peer } from "./Peers.ts"

const isProviderMessage = Schema.is(ProviderCommand)

/** A web command about Connected providers other than a Claude credential's. */
export const isProviderCommand = (message: WebToHub): message is Command =>
  message._tag !== "SetClaudeCredential" &&
  message._tag !== "RemoveClaudeCredential" &&
  isProviderMessage(message)

/** A command this relay handles. */
type Command = Exclude<
  ProviderCommand,
  { readonly _tag: "SetClaudeCredential" | "RemoveClaudeCredential" }
>

/** A web connection, as the relay knows it. */
export interface ProviderWebClient {
  readonly you: Participant
  readonly peer: Peer<HubToWeb>
}

/** What the provider relay needs of the Session relay. */
export interface ProviderRelayHost {
  readonly webClients: () => Iterable<ProviderWebClient>
}

/** A sign-in running for a Member. */
interface SignIn {
  readonly requestId: RequestId
  readonly provider: ProviderId
  readonly peer: Peer<HubToWeb>
  /** Answers the step waiting for one, if any. */
  answer?: (value: string) => void
  fiber?: Fiber.Fiber<void>
}

// ── A sign-in's steps, in the Hub's words ──────────────────────────────────

/** A step that asks the Member to paste or choose something. */
type Asking = Extract<SignInStep, { readonly _tag: "Paste" | "Choose" }>

/** Asks the Member a step: their answer. Rejects once `signal` aborts. */
type Ask = (step: Asking, signal: AbortSignal) => Promise<string>

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
function askOf(provider: ProviderId, prompt: AuthPrompt): Asking {
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

/**
 * Asks the Member what a pi-ai sign-in prompt asks: as a choice first, for GitHub Copilot's
 * question of which GitHub, which takes a blank answer for github.com.
 */
async function answerTo(
  provider: ProviderId,
  prompt: AuthPrompt,
  ask: Ask,
  signal: AbortSignal,
): Promise<string> {
  if (
    provider === "github-copilot" &&
    prompt.type === "text" &&
    /enterprise/i.test(prompt.message)
  ) {
    const which = await ask(
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
    // As typed: pi-ai takes a domain or an address, and refuses one it can't read.
    return ask(
      {
        _tag: "Paste",
        message: "Your GitHub Enterprise address",
        placeholder: prompt.placeholder ?? "company.ghe.com",
      },
      signal,
    )
  }
  return ask(askOf(provider, prompt), signal)
}

// ── The relay ──────────────────────────────────────────────────────────────

/** Tells the web client its command was refused, and why. */
const refuse = (client: ProviderWebClient, message: Command, why: string) =>
  client.peer.send(
    CommandFailed.make({ command: message._tag, requestId: message.requestId, message: why }),
  )

/** Answers the command's refusal, or the Hub's failure, to the web client. */
const answeringFailures =
  (client: ProviderWebClient, message: Command) =>
  <R>(effect: Effect.Effect<void, ProviderRefusal | SqlError, R>) =>
    effect.pipe(
      Effect.catchTags({
        ProviderRefusal: (refused) => Effect.sync(() => refuse(client, message, refused.message)),
        SqlError: (error) =>
          Effect.logError("A Connected provider command failed", error).pipe(
            Effect.andThen(
              Effect.sync(() => refuse(client, message, "The Hub could not do that; try again.")),
            ),
          ),
      }),
    )

export const makeProviderRelay = Effect.fnUntraced(function* (host: ProviderRelayHost) {
  const providers = yield* ConnectedProviders
  const members = yield* Members
  const scope = yield* Effect.scope
  /** The sign-in running for each Member. */
  const signIns = new Map<ParticipantId, SignIn>()

  /** What the Member is sent of their Connected providers. */
  const stateOf = Effect.fn("ProviderRelay.stateOf")(function* (
    participantId: ParticipantId,
    requestId?: RequestId,
  ) {
    return ProvidersState.make({
      ...(requestId !== undefined && { requestId }),
      ...(yield* providers.state(participantId)),
      claudeHarness: yield* members.claudeHarness(participantId),
      liveVoice: yield* members.liveVoice(participantId),
    })
  })

  /**
   * Sends each of the Member's connections what they have now; the one that asked, if any, with
   * its `requestId`.
   */
  const changed = Effect.fn("ProviderRelay.changed")(function* (
    participantId: ParticipantId,
    asker?: { readonly peer: Peer<HubToWeb>; readonly requestId: RequestId },
  ) {
    const state = yield* stateOf(participantId)
    for (const client of host.webClients()) {
      if (client.you.id !== participantId || client.peer === asker?.peer) continue
      client.peer.send(state)
    }
    if (asker !== undefined) asker.peer.send({ ...state, requestId: asker.requestId })
  })

  /** Cancels the Member's sign-in, if one runs: it ends Cancelled. */
  const cancel = (participantId: ParticipantId) =>
    Effect.suspend(() => {
      const running = signIns.get(participantId)
      return running?.fiber === undefined
        ? Effect.void
        : Effect.asVoid(Fiber.interrupt(running.fiber))
    })

  const startSignIn = Effect.fn("ProviderRelay.startSignIn")(function* (
    client: ProviderWebClient,
    requestId: RequestId,
    provider: ProviderId,
  ) {
    const { you, peer } = client
    yield* cancel(you.id)
    const signIn: SignIn = { requestId, provider, peer }
    signIns.set(you.id, signIn)
    const ended = (outcome: SignInEnded["outcome"], message?: string) =>
      peer.send(
        SignInEnded.make({
          requestId,
          provider,
          outcome,
          ...(message !== undefined && { message }),
        }),
      )
    const show = (step: SignInStep) => peer.send(SignInStepped.make({ requestId, provider, step }))
    const ask: Ask = (step, signal) =>
      new Promise<string>((resolve, reject) => {
        const withdraw = () => {
          if (signIn.answer === answer) delete signIn.answer
          reject(new Error("Login cancelled"))
        }
        const answer = (value: string) => {
          delete signIn.answer
          signal.removeEventListener("abort", withdraw)
          resolve(value)
        }
        if (signal.aborted) return withdraw()
        signal.addEventListener("abort", withdraw, { once: true })
        signIn.answer = answer
        show(step)
      })
    signIn.fiber = yield* providers
      .signIn(you.id, provider, {
        notify: (event) => {
          const step = stepOf(provider, event)
          if (step !== undefined) show(step)
        },
        prompt: (prompt, signal) => answerTo(provider, prompt, ask, signal),
      })
      .pipe(
        Effect.onExit((exit) =>
          Effect.gen(function* () {
            if (signIns.get(you.id) === signIn) signIns.delete(you.id)
            if (Exit.isSuccess(exit)) {
              yield* Effect.logInfo(`${you.login} signed in to ${provider}`)
              ended("Connected")
              return yield* changed(you.id)
            }
            if (Cause.hasInterruptsOnly(exit.cause)) return ended("Cancelled")
            const error = Cause.findErrorOption(exit.cause)
            if (Option.isSome(error) && error.value._tag === "ProviderRefusal") {
              return ended("Failed", error.value.message)
            }
            yield* Effect.logError("A sign-in failed", exit.cause)
            ended("Failed", "The Hub could not keep the connection; try again.")
          }),
        ),
        Effect.ignore,
        Effect.forkIn(scope),
      )
  })

  /**
   * Runs a command that waits on a Provider, up to a minute, off the web client's other
   * commands, as a sign-in runs: its answer comes when it is done.
   */
  const inBackground = <R>(
    client: ProviderWebClient,
    message: Command,
    effect: Effect.Effect<void, ProviderRefusal | SqlError, R>,
  ) => effect.pipe(answeringFailures(client, message), Effect.forkIn(scope), Effect.asVoid)

  const handle = Effect.fn("ProviderRelay.handle")(function* (
    client: ProviderWebClient,
    message: Command,
  ) {
    const { you, peer } = client
    const asker = { peer, requestId: message.requestId }
    switch (message._tag) {
      case "GetProviders":
        return peer.send(yield* stateOf(you.id, message.requestId))
      case "ConnectProviderKey":
        return yield* inBackground(
          client,
          message,
          Effect.gen(function* () {
            yield* providers.connectKey(you.id, message.provider, message.apiKey)
            yield* Effect.logInfo(`${you.login} connected ${message.provider} with an API key`)
            yield* changed(you.id, asker)
          }),
        )
      case "StartSignIn":
        return yield* startSignIn(client, message.requestId, message.provider)
      case "AnswerSignIn": {
        const running = signIns.get(you.id)
        if (running?.requestId !== message.requestId || running.answer === undefined) {
          return refuse(client, message, "This sign-in isn't waiting for an answer.")
        }
        return running.answer(Redacted.value(message.value))
      }
      case "CancelSignIn": {
        const running = signIns.get(you.id)
        if (running?.requestId !== message.requestId) {
          return refuse(client, message, "This sign-in isn't running.")
        }
        return yield* cancel(you.id)
      }
      case "DisconnectProvider": {
        if (yield* providers.disconnect(you.id, message.provider)) {
          yield* Effect.logInfo(`${you.login} disconnected ${message.provider}`)
        }
        return yield* changed(you.id, asker)
      }
      case "RefreshProviderModels":
        return yield* inBackground(
          client,
          message,
          providers
            .refreshModels(you.id, message.provider)
            .pipe(Effect.andThen(changed(you.id, asker))),
        )
      case "SetClaudeHarness": {
        yield* members.setClaudeHarness(you.id, message.harness)
        return yield* changed(you.id, asker)
      }
      case "SetLiveVoice": {
        yield* members.setLiveVoice(you.id, message.setting)
        return yield* changed(you.id, asker)
      }
    }
  })

  /** Handles a command from the web client. */
  const receiveWeb = (client: ProviderWebClient, message: Command) =>
    handle(client, message).pipe(answeringFailures(client, message))

  /** Cancels the sign-in the web client started, if one runs, when the scope closes. */
  const attach = (client: ProviderWebClient): Effect.Effect<void, never, Scope.Scope> =>
    Effect.addFinalizer(() =>
      Effect.suspend(() =>
        signIns.get(client.you.id)?.peer === client.peer ? cancel(client.you.id) : Effect.void,
      ),
    )

  /** Forgets the removed Member's Connected providers, cancelling their sign-in. */
  const forget = Effect.fn("ProviderRelay.forget")(function* (participantId: ParticipantId) {
    yield* cancel(participantId)
    yield* providers.forget(participantId)
  })

  return { receiveWeb, stateOf, changed, attach, forget }
})

export type ProviderRelay = Effect.Success<ReturnType<typeof makeProviderRelay>>
