// What `claude-hub runner join` asks the Hub over plain HTTP(S) (issue #85):
//
// - `POST /runner/pair` redeems a Pairing code for a Runner token. It is open: the code is the
//   credential. Every refused code gets the same 403 (PairingCodes.ts).
// - `GET /runner/connection`, with a Runner token, says whether the Hub has that Runner
//   connected, so `runner join` can tell its service came up. A token that no longer works
//   (removed, or replaced by a Re-pair) gets 401, as on the Runner channel.

import {
  normalizePairingCode,
  PairRequest,
  Paired,
  PairingCodeRefused,
  RunnerConnection,
} from "@claude-hub/protocol"
import { Effect } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http"
import { authenticateRunner } from "./Auth.ts"
import { SessionRelay } from "./SessionRelay.ts"

const errorResponse = (status: number, error: string) =>
  HttpServerResponse.jsonUnsafe({ error }, { status })

export const PairingRoutes = HttpRouter.use(
  Effect.fn(function* (router) {
    const relay = yield* SessionRelay

    yield* router.add(
      "POST",
      "/runner/pair",
      Effect.gen(function* () {
        const body = yield* HttpServerRequest.schemaBodyJson(PairRequest)
        const code = normalizePairingCode(body.code)
        if (code === undefined) return errorResponse(403, PairingCodeRefused)
        const { pairingCodeId: _, ...paired } = yield* relay.redeemPairing(code, body.name.trim())
        yield* Effect.logInfo(
          paired.repaired
            ? `Runner ${paired.name} (${paired.runnerId}) was paired again`
            : `Runner ${paired.name} (${paired.runnerId}) was paired`,
        )
        return yield* HttpServerResponse.schemaJson(Paired)(paired)
      }).pipe(
        Effect.catchTags({
          PairingRefused: (error) => Effect.succeed(errorResponse(error.status, error.message)),
          SchemaError: () =>
            Effect.succeed(errorResponse(400, "Expected a JSON body with a code and a name")),
          HttpServerError: () => Effect.succeed(errorResponse(400, "The body is not JSON")),
          SqlError: (error) =>
            Effect.logError("Could not redeem a Pairing code", error).pipe(
              Effect.as(errorResponse(500, "The Hub could not pair the Runner; try again.")),
            ),
        }),
      ),
    )

    yield* router.add(
      "GET",
      "/runner/connection",
      Effect.gen(function* () {
        const runner = yield* authenticateRunner
        return yield* HttpServerResponse.schemaJson(RunnerConnection)({
          runnerId: runner.runnerId,
          name: runner.name,
          online: relay.runnerOnline(runner.runnerId),
        })
      }),
    )
  }),
)
