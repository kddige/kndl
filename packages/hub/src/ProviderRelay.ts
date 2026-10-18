// What the Session relay does with the web's commands about Connected providers (ADR 0029): a
// Claude credential's are SessionRelay's, the rest this relay's (ConnectedProviders.ts keeps them).
//
// - Each Member is sent their Connected providers, what they can connect and the Models their pi
//   Sessions can run (ProvidersState) after the welcome, and to each of their connections whenever
//   that changes: a connection made or lost, a refresh refused, the Models found again, or their
//   Claude credential changed, since Claude's Models are among them. No one else is sent them.
// - Connecting with an API key waits for the Provider to list its Models with it, off the lock.
// - A sign-in runs the Provider's flow on the Hub, off the connection's own messages, so the
//   Member can answer its steps: each is sent to the connection that started it (SignInStepped),
//   and then how it ended (SignInEnded). One sign-in per Member at a time: a new one, from any of
//   their connections, cancels the last. It is cancelled too when its connection goes, or the
//   Member is removed.

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
  SignInStepped,
  type WebToHub,
} from "@kndl/protocol"
import { Cause, Effect, Exit, Fiber, Option, Redacted, Schema, type Scope } from "effect"
import { ConnectedProviders } from "./ConnectedProviders.ts"
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

/** Tells the web client its command was refused, and why. */
const refuse = (client: ProviderWebClient, message: Command, why: string) =>
  client.peer.send(
    CommandFailed.make({ command: message._tag, requestId: message.requestId, message: why }),
  )

export const makeProviderRelay = Effect.fnUntraced(function* (host: ProviderRelayHost) {
  const providers = yield* ConnectedProviders
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
      // Until the Member can choose (ADR 0030).
      claudeHarness: "ClaudeCode",
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
    signIn.fiber = yield* providers
      .signIn(you.id, provider, {
        show: (step) => peer.send(SignInStepped.make({ requestId, provider, step })),
        ask: (step, signal) =>
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
            peer.send(SignInStepped.make({ requestId, provider, step }))
          }),
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

  const handle = Effect.fn("ProviderRelay.handle")(function* (
    client: ProviderWebClient,
    message: Command,
  ) {
    const { you, peer } = client
    const asker = { peer, requestId: message.requestId }
    switch (message._tag) {
      case "GetProviders":
        return peer.send(yield* stateOf(you.id, message.requestId))
      case "ConnectProviderKey": {
        yield* providers.connectKey(you.id, message.provider, message.apiKey)
        yield* Effect.logInfo(`${you.login} connected ${message.provider} with an API key`)
        return yield* changed(you.id, asker)
      }
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
      case "RefreshProviderModels": {
        yield* providers.refreshModels(you.id, message.provider)
        return yield* changed(you.id, asker)
      }
      case "SetClaudeHarness":
        return refuse(client, message, "This Hub can't choose the Harness for Claude yet.")
    }
  })

  /** Handles a command from the web client. */
  const receiveWeb = (client: ProviderWebClient, message: Command) =>
    handle(client, message).pipe(
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
