// What the CLI asks a Hub over HTTP(S) for a Runner: to redeem a Pairing code, and whether it has
// the Runner connected (PairingRoutes.ts in the Hub). Join.ts reads the answers; this only asks.
// A service, so onboard's flow runs in tests against a Hub that answers from a script.
import type { PairingTarget } from "@claude-hub/protocol"
import { Context, Effect, Layer } from "effect"
import {
  type ConnectionCheck,
  type PairOutcome,
  readConnectionAnswer,
  readPairAnswer,
} from "./Join.ts"

export class HubClient extends Context.Service<
  HubClient,
  {
    /** Redeems the target's code for a Runner token, asking for `name` (a Re-pair keeps its own). */
    readonly pair: (target: PairingTarget, name: string) => Effect.Effect<PairOutcome>
    /** Whether the Hub at `hubUrl` has the Runner with `token` connected. */
    readonly connection: (hubUrl: string, token: string) => Effect.Effect<ConnectionCheck>
  }
>()("@claude-hub/cli/HubClient") {
  static readonly layer = Layer.succeed(
    HubClient,
    HubClient.of({
      pair: (target, name) =>
        Effect.promise(async (): Promise<PairOutcome> => {
          try {
            const response = await fetch(new URL("/runner/pair", target.hubUrl), {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ code: target.code, name }),
              signal: AbortSignal.timeout(15_000),
            })
            return readPairAnswer(target.hubUrl, response.status, await jsonOf(response))
          } catch (error) {
            return {
              _tag: "Refused",
              message: `Couldn't reach the Hub at ${target.hubUrl} (${messageOf(error)}). Is that the address this machine reaches it at?`,
            }
          }
        }),
      connection: (hubUrl, token) =>
        Effect.promise(async (): Promise<ConnectionCheck> => {
          try {
            const response = await fetch(new URL("/runner/connection", hubUrl), {
              headers: { authorization: `Bearer ${token}` },
              signal: AbortSignal.timeout(5_000),
            })
            return readConnectionAnswer(response.status, await jsonOf(response))
          } catch (error) {
            return { _tag: "Unreachable", detail: messageOf(error) }
          }
        }),
    }),
  )

  /** For tests that never reach a Hub: asking one is a defect. */
  static readonly unused = Layer.succeed(
    HubClient,
    HubClient.of({
      pair: () => Effect.die(new Error("HubClient.pair: no Hub in this test")),
      connection: () => Effect.die(new Error("HubClient.connection: no Hub in this test")),
    }),
  )
}

const jsonOf = (response: Response): Promise<unknown> => response.json().catch(() => undefined)

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))
