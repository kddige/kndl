// `kndl forward` (#180, ADR 0016): see Forward.ts in the protocol.
//
// - `GET /ws/forward/<session id>`, by a CLI token only: a forward is presence, named after the
//   machine the token is. The caller's access to the Session's Repo is checked as for a tunnel
//   (SessionAccess.ts). A missing or revoked token is answered `401` with no socket; a caller
//   without access, after the upgrade, with a ForwardCloseCode. Then the channel opens as the
//   others do (Channels.ts), and the SessionRelay takes it.
// - `GET /auth/cli/sessions`, by a CLI token: the Sessions `forward` picks from.

import {
  CliSessionList,
  ForwardCloseCode,
  ForwardHello,
  ForwardToHub,
  ForwardWelcome,
  HubToForward,
  ProtocolVersion,
  SessionId,
} from "@kndl/protocol"
import { Effect } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http"
import { Socket } from "effect/socket"
import { authenticateCli } from "./Auth.ts"
import { serveChannel } from "./Channels.ts"
import { closeReason } from "./CloseReason.ts"
import { authorizeAccessFor } from "./SessionAccess.ts"
import { SessionRelay } from "./SessionRelay.ts"

const notAnUpgrade = HttpServerResponse.jsonUnsafe(
  { error: "Open a WebSocket here." },
  { status: 426, headers: { upgrade: "websocket" } },
)

export const ForwardRoutes = HttpRouter.use(
  Effect.fn(function* (router) {
    const relay = yield* SessionRelay

    yield* router.add(
      "GET",
      "/ws/forward/:sessionId",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        if (request.headers.upgrade?.toLowerCase() !== "websocket") return notAnUpgrade
        // A token that won't do fails here, as 401, before the upgrade.
        const cli = yield* authenticateCli
        const sessionId = SessionId.make((yield* HttpRouter.params).sessionId ?? "-")
        const refused = yield* authorizeAccessFor(cli.participant, sessionId).pipe(
          Effect.as(undefined),
          Effect.catchTag("SessionAccessRefused", (refusal) =>
            Effect.succeed({
              code:
                refusal.reason === "AccessUnknown"
                  ? ForwardCloseCode.AccessUnknown
                  : ForwardCloseCode.NoSuchSession,
              reason: refusal.message,
            }),
          ),
        )
        if (refused !== undefined) {
          const socket = yield* request.upgrade
          yield* Effect.scoped(
            Effect.flatMap(socket.writer, (writer) =>
              writer.write(new Socket.CloseEvent(refused.code, closeReason(refused.reason))),
            ),
          ).pipe(Effect.ignore)
          return HttpServerResponse.empty()
        }
        return yield* serveChannel({
          hello: ForwardHello,
          incoming: ForwardToHub,
          outgoing: HubToForward,
          welcome: () => ForwardWelcome.make({ protocolVersion: ProtocolVersion }),
          connect: (_hello, peer) => relay.connectForward(cli, sessionId, peer),
        })
      }),
    )

    yield* router.add(
      "GET",
      "/auth/cli/sessions",
      Effect.gen(function* () {
        const cli = yield* authenticateCli
        const sessions = yield* relay.forwardableSessions(cli.participant)
        return yield* HttpServerResponse.schemaJson(CliSessionList)({ sessions })
      }),
    )
  }),
)
