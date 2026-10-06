// Signing the `kndl` CLI in (issue #179, ADR 0016; CliTokens.ts says how):
//
// - `POST /auth/cli/approve`, from the `/cli-login` page with the sign-in cookie, approves a
//   machine: a Login code for it. Anyone signed in may, not only operators.
// - `POST /auth/cli/token`, from the CLI, trades the code and its PKCE verifier for a CLI token.
//   It is open: the code and the verifier together are the credential. Every refused code gets
//   the same 400.
// - `GET /auth/cli/me`, with a CLI token, says whose it is, for `kndl whoami`.
// - `POST /auth/cli/sign-out`, with a CLI token, revokes it, for `kndl logout`.
//
// No token is ever logged: only the machine, the person and the token's id.

import {
  CliLoginApproval,
  CliLoginApproved,
  CliSignedIn,
  CliTokenRequest,
  CliWhoAmI,
} from "@kndl/protocol"
import { Effect } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http"
import { authenticateCli, authenticateParticipant, requireSameOrigin } from "./Auth.ts"
import { CliTokens } from "./CliTokens.ts"
import { SessionRelay } from "./SessionRelay.ts"

const errorResponse = (status: number, error: string) =>
  HttpServerResponse.jsonUnsafe({ error }, { status })

export const CliLoginRoutes = HttpRouter.use(
  Effect.fn(function* (router) {
    const cliTokens = yield* CliTokens
    const relay = yield* SessionRelay

    yield* router.add(
      "POST",
      "/auth/cli/approve",
      Effect.gen(function* () {
        yield* requireSameOrigin
        const you = yield* authenticateParticipant
        const body = yield* HttpServerRequest.schemaBodyJson(CliLoginApproval)
        const approved = yield* cliTokens.approve(you, body.machine, body.challenge)
        return yield* HttpServerResponse.schemaJson(CliLoginApproved)(approved)
      }).pipe(
        Effect.catchTags({
          SchemaError: () =>
            Effect.succeed(
              errorResponse(400, "Expected a JSON body with a machine and a challenge"),
            ),
          HttpServerError: () => Effect.succeed(errorResponse(400, "The body is not JSON")),
        }),
      ),
    )

    yield* router.add(
      "POST",
      "/auth/cli/token",
      Effect.gen(function* () {
        const body = yield* HttpServerRequest.schemaBodyJson(CliTokenRequest)
        const signedIn = yield* cliTokens.redeem(body.code, body.verifier)
        yield* Effect.logInfo(
          `${signedIn.participant.login} signed in the CLI on ${signedIn.machine} (${signedIn.id})`,
        )
        yield* relay.cliTokensChanged(signedIn.participant.id)
        return yield* HttpServerResponse.schemaJson(CliSignedIn)({
          you: signedIn.participant,
          id: signedIn.id,
          machine: signedIn.machine,
          createdAt: signedIn.createdAt,
          token: signedIn.token,
        })
      }).pipe(
        Effect.catchTags({
          LoginRefused: (error) => Effect.succeed(errorResponse(400, error.message)),
          SchemaError: () =>
            Effect.succeed(errorResponse(400, "Expected a JSON body with a code and a verifier")),
          HttpServerError: () => Effect.succeed(errorResponse(400, "The body is not JSON")),
          SqlError: (error) =>
            Effect.logError("Could not issue a CLI token", error).pipe(
              Effect.as(errorResponse(500, "The Hub could not sign the CLI in; try again.")),
            ),
        }),
      ),
    )

    yield* router.add(
      "GET",
      "/auth/cli/me",
      Effect.gen(function* () {
        const cli = yield* authenticateCli
        return yield* HttpServerResponse.schemaJson(CliWhoAmI)({
          you: cli.participant,
          id: cli.id,
          machine: cli.machine,
          createdAt: cli.createdAt,
        })
      }),
    )

    yield* router.add(
      "POST",
      "/auth/cli/sign-out",
      Effect.gen(function* () {
        const cli = yield* authenticateCli
        yield* cliTokens.revoke(cli.participant.id, cli.id)
        yield* Effect.logInfo(
          `${cli.participant.login} signed the CLI out on ${cli.machine} (${cli.id})`,
        )
        yield* relay.cliTokensChanged(cli.participant.id)
        return HttpServerResponse.empty({ status: 204 })
      }),
    )
  }),
)
