// What the Session relay does for the Runners page (issue #85): Pairing codes minted, revoked and
// redeemed, and Runners removed. It runs under the Session relay's lock, as part of it, so a
// Runner's removal and its Sessions' states never race.
//
// - Anyone signed in may mint a code, revoke one, or remove a Runner: there are no roles yet.
// - A Re-pair's redemption replaces the Runner's token, so a Runner still connected with the old
//   one is disconnected; it can't connect again with it.
// - A Runner is removed only while all its Sessions are Archived (runnerRemovalRefusal). Its token stops
//   working, its codes not yet used are revoked, and, if it is connected, it is disconnected.

import {
  CommandFailed,
  type HubToWeb,
  PairingCodeCreated,
  PairingCodeList,
  PairingCodeRedeemed,
  pairingLink,
  type Participant,
  type RequestId,
  type RunnerId,
  RunnerRemoved,
  runnerRemovalRefusal,
  type WebToHub,
} from "@claude-hub/protocol"
import { Effect, Option } from "effect"
import type { SqlError } from "effect/sql/SqlError"
import { HubConfig } from "./HubConfig.ts"
import { PairingCodes } from "./PairingCodes.ts"
import { Runners } from "./Runners.ts"
import { RunnerTokens } from "./RunnerTokens.ts"

const webTags = ["CreatePairingCode", "RevokePairingCode", "RemoveRunner"] as const

/** A web command from the Runners page. */
export type RunnerCommand = Extract<WebToHub, { readonly _tag: (typeof webTags)[number] }>

export const isRunnerCommand = (message: WebToHub): message is RunnerCommand =>
  (webTags as ReadonlyArray<string>).includes(message._tag)

/** Close codes a Runner's connection is closed with when its token stops working. */
export const RunnerGoneCloseCode = {
  /** It was removed on the Runners page. */
  Removed: 4410,
  /** Its token was replaced by a Re-pair. */
  Repaired: 4411,
} as const

/** A web connection, as the relay knows it. */
export interface RunnerWebClient {
  readonly you: Participant
  readonly peer: { readonly send: (message: HubToWeb) => void }
}

export const makeRunnerRelay = Effect.fn("makeRunnerRelay")(function* (deps: {
  /** Sends a message to every web client `to` picks. */
  readonly toWeb: (message: HubToWeb, to?: (client: RunnerWebClient) => boolean) => void
  /** Sends every web client the Runner list, as it now stands. */
  readonly runnersChanged: Effect.Effect<void, SqlError>
  /** Closes a Runner's connection, if it is connected. */
  readonly disconnect: (id: RunnerId, code: number, reason: string) => void
}) {
  const codes = yield* PairingCodes
  const runners = yield* Runners
  const tokens = yield* RunnerTokens
  const { publicUrl } = yield* HubConfig

  const pendingList = (requestId?: RequestId) =>
    Effect.map(codes.pending, (pending) =>
      PairingCodeList.make({ codes: pending, ...(requestId !== undefined && { requestId }) }),
    )

  /**
   * Every web client gets the codes as they now stand; the one that asked, if one did, with its
   * request's id as the answer.
   */
  const codesChanged = Effect.fn("RunnerRelay.codesChanged")(function* (
    asked?: RunnerWebClient,
    requestId?: RequestId,
  ) {
    const list = yield* pendingList()
    if (asked === undefined || requestId === undefined) return deps.toWeb(list)
    deps.toWeb(list, (client) => client.peer !== asked.peer)
    asked.peer.send(PairingCodeList.make({ ...list, requestId }))
  })

  const receiveWeb = Effect.fn("RunnerRelay.receiveWeb")(function* (
    client: RunnerWebClient,
    message: RunnerCommand,
  ) {
    const { peer } = client
    const refuse = (why: string) =>
      peer.send(
        CommandFailed.make({ command: message._tag, message: why, requestId: message.requestId }),
      )
    switch (message._tag) {
      case "CreatePairingCode": {
        const minted = yield* codes
          .mint(client.you, message.runnerId)
          .pipe(Effect.catchTag("MintRefused", (error) => Effect.succeed(error)))
        if ("_tag" in minted) return refuse(minted.message)
        peer.send(
          PairingCodeCreated.make({
            requestId: message.requestId,
            id: minted.id,
            code: minted.code,
            link: pairingLink(publicUrl.origin, minted.code),
            expiresAt: minted.expiresAt,
            ...(minted.runnerId !== undefined && { runnerId: minted.runnerId }),
          }),
        )
        return yield* codesChanged()
      }
      case "RevokePairingCode": {
        yield* codes.revoke(message.pairingCodeId)
        return yield* codesChanged(client, message.requestId)
      }
      case "RemoveRunner": {
        const runner = yield* runners.get(message.runnerId)
        if (Option.isNone(runner)) return refuse("There is no such Runner.")
        const refusal = runnerRemovalRefusal(runner.value.name, runner.value.openSessions)
        if (refusal !== undefined) return refuse(refusal)
        yield* tokens.remove(message.runnerId)
        yield* codes.revokeFor(message.runnerId)
        deps.disconnect(
          message.runnerId,
          RunnerGoneCloseCode.Removed,
          "This Runner was removed from the Hub",
        )
        peer.send(RunnerRemoved.make({ requestId: message.requestId, runnerId: message.runnerId }))
        yield* deps.runnersChanged
        return yield* codesChanged()
      }
    }
  })

  /**
   * Redeems a code for a Runner token (PairingCodes.redeem). A Re-pair disconnects the Runner
   * connected with the token it replaced.
   */
  const redeem = Effect.fn("RunnerRelay.redeem")(function* (code: string, name: string) {
    const redeemed = yield* codes.redeem(code, name)
    if (redeemed.repaired) {
      deps.disconnect(
        redeemed.runnerId,
        RunnerGoneCloseCode.Repaired,
        "This Runner was paired again, and its token replaced",
      )
    }
    deps.toWeb(
      PairingCodeRedeemed.make({
        id: redeemed.pairingCodeId,
        runnerId: redeemed.runnerId,
        name: redeemed.name,
        repaired: redeemed.repaired,
      }),
    )
    yield* deps.runnersChanged
    yield* codesChanged()
    return redeemed
  })

  return { receiveWeb, redeem, pendingList }
})
