// Live voice (spike, ADR 0033): `POST /sessions/<id>/voice` starts a live voice session with a
// Session, for its Creator alone, since what they say drives it (ADR 0026).
//
// - The browser sends its WebRTC offer; the Hub starts the voice session at the Provider of the
//   Creator's live voice Model, with their own Connected provider, and answers with the Provider's
//   SDP. The credential stays on the Hub, as the Gateway's do. After that, audio and the data
//   channel run between the browser and the Provider: the Hub isn't in them.
// - GPT-Live (`POST /v1/live/sessions`) runs with client delegation: it holds the conversation,
//   and when it is asked for work it delegates to the browser, which prompts the Session. Its
//   instructions say so, and carry the Session's latest Turns, so it knows what has happened.
// - Refusals: `403` for anyone but the Creator, `409` for an Archived Session, or a Creator who
//   hasn't connected the Model's Provider (or must connect it again), `502` with the Provider's
//   reason when it refuses or can't be reached. Logged with the Session, never what is said.

import {
  driveRefusal,
  type HistoryTurn,
  LiveVoiceAnswer,
  LiveVoiceOffer,
  liveVoiceModel,
  liveVoiceOf,
  type Participant,
  SessionId,
  type SessionSummary,
  sessionTitle,
} from "@kndl/protocol"
import { Effect, Schema } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http"
import { authenticateParticipant, requireSameOrigin } from "./Auth.ts"
import { ConnectedProviders } from "./ConnectedProviders.ts"
import { historyPage } from "./Handoff.ts"
import { Members } from "./Members.ts"
import { authorizeAccessFor } from "./SessionAccess.ts"
import { SessionLog } from "./SessionLog.ts"

const errorResponse = (status: number, error: string) =>
  HttpServerResponse.jsonUnsafe({ error }, { status })

/** How many of the Session's latest Turns the voice is told of as it starts. */
const contextTurns = 6

/** The most characters of them it is told, the newest kept. */
const contextLimit = 6000

const clip = (text: string, limit: number) =>
  text.length <= limit ? text : `${text.slice(0, limit - 1)}…`

/** The Turns, as the voice reads them: who asked what, and what the agent answered. */
export const turnsText = (turns: ReadonlyArray<HistoryTurn>): string => {
  const lines = turns.map(
    (turn) =>
      `${turn.by} asked: ${clip(turn.prompt, 600)}\nThe agent ${
        turn.tools.length === 0 ? "" : `used ${turn.tools.length} tools and `
      }answered: ${clip(turn.answer, 900)}`,
  )
  // The newest are kept whole.
  let text = ""
  for (const line of lines.toReversed()) {
    if (text.length + line.length > contextLimit) break
    text = `${line}\n\n${text}`
  }
  return text.trim()
}

/** What the voice is told it is, for a Session, its Creator and the Session's latest Turns. */
export const voiceInstructions = (
  session: SessionSummary,
  you: Participant,
  turns: ReadonlyArray<HistoryTurn>,
): string => {
  const history = turnsText(turns)
  return [
    `You are the voice of a kndl Session, "${sessionTitle(session)}" on ${session.repo}: a coding agent's session. You are talking with ${you.name}, who drives it.`,
    "You do no work yourself and have no tools: the Session's agent does the work. Whenever they ask for anything to be done, checked, explained from the code, or changed, delegate it, and say in a few words that you are passing it on. Handle small talk, and questions about what they want, yourself.",
    "While the agent works you are told its progress quietly; say something only if asked. When it finishes you are told its answer: say it briefly, in plain speech, without reading code, paths or long lists out. If the agent asks a question, put it to them, and delegate their answer.",
    "Keep every reply short and spoken-friendly.",
    history === ""
      ? "Nothing has happened in the Session yet."
      : `What has happened in the Session so far, oldest first:\n\n${history}`,
  ].join("\n\n")
}

const decodeOffer = Schema.decodeUnknownOption(LiveVoiceOffer)

/** The SDP in GPT-Live's answer, `{session: {id}, transport: {type, sdp}}`. */
const answerSdp = (body: unknown): string | undefined => {
  if (typeof body !== "object" || body === null) return undefined
  const transport = (body as { readonly transport?: { readonly sdp?: unknown } }).transport
  return typeof transport?.sdp === "string" && transport.sdp !== "" ? transport.sdp : undefined
}

/** A Provider's reason for refusing, from its `{error: {message}}`, else its status. */
const providerReason = (status: number, text: string) => {
  try {
    const message = (JSON.parse(text) as { readonly error?: { readonly message?: unknown } }).error
      ?.message
    if (typeof message === "string" && message !== "") return clip(message, 300)
  } catch {}
  return `it answered ${status}`
}

export const LiveVoiceRoutes = HttpRouter.use(
  Effect.fn(function* (router) {
    const providers = yield* ConnectedProviders
    const members = yield* Members
    const log = yield* SessionLog

    yield* router.add(
      "POST",
      "/sessions/:sessionId/voice",
      Effect.gen(function* () {
        yield* requireSameOrigin
        const you = yield* authenticateParticipant
        const { sessionId } = yield* HttpRouter.params
        const access = yield* authorizeAccessFor(you, SessionId.make(sessionId ?? "-")).pipe(
          Effect.map((found) => ({ session: found.session })),
          Effect.catchTag("SessionAccessRefused", (refusal) =>
            Effect.succeed({
              refused: errorResponse(
                refusal.reason === "AccessUnknown" ? 503 : 404,
                refusal.message,
              ),
            }),
          ),
        )
        if ("refused" in access) return access.refused
        const { session } = access
        // What is said drives the Session: its Creator's alone.
        const notYours = driveRefusal(you, session.creator, session.harness)
        if (notYours !== undefined) return errorResponse(403, notYours.refusal)
        if (session.state === "Archived") {
          return errorResponse(409, "The Session is archived: restore it to talk with it.")
        }
        const request = yield* HttpServerRequest.HttpServerRequest
        const offer = decodeOffer(yield* request.json.pipe(Effect.orElseSucceed(() => null)))
        if (offer._tag === "None") return errorResponse(400, "Expected a WebRTC offer, {sdp}.")

        const setting = yield* members.liveVoice(you.id).pipe(Effect.orDie)
        const model = liveVoiceModel(setting.model)
        if (model === undefined) return errorResponse(409, `kndl can't talk to ${setting.model}.`)
        const voice = liveVoiceOf(setting)
        const { entries, earlier } = yield* log
          .lastTurns(session.id, { count: contextTurns })
          .pipe(Effect.orDie)
        const { turns } = historyPage(entries, { limit: contextTurns, earlier })

        const body = JSON.stringify({
          session: {
            model: model.id,
            instructions: voiceInstructions(session, you, turns),
            audio: { output: { voice } },
            delegation: { type: "client" },
          },
          transport: { type: "webrtc", sdp: offer.value.sdp },
        })
        const called = yield* providers
          .call(you.id, model.provider, {
            method: "POST",
            path: "/v1/live/sessions",
            headers: new Headers({
              "content-type": "application/json",
              accept: "application/json",
            }),
            keyHeader: "authorization",
            body: new TextEncoder().encode(body),
          })
          .pipe(Effect.result)
        if (called._tag === "Failure") {
          return errorResponse(
            409,
            `${called.failure.message} Live voice runs on your OpenAI connection: connect it on the Account page.`,
          )
        }
        const answered = called.success
        if (answered._tag !== "Answered") {
          return errorResponse(502, "OpenAI could not be reached to start the voice.")
        }
        const text = yield* Effect.promise(() => answered.response.text())
        yield* Effect.logInfo(
          `Live voice ${model.name}: OpenAI answered ${answered.response.status}`,
        ).pipe(Effect.annotateLogs({ sessionId: session.id, component: "LiveVoice" }))
        if (!answered.response.ok) {
          return errorResponse(
            502,
            `OpenAI didn't start the voice: ${providerReason(answered.response.status, text)}`,
          )
        }
        let parsed: unknown
        try {
          parsed = JSON.parse(text)
        } catch {
          parsed = undefined
        }
        const sdp = answerSdp(parsed)
        if (sdp === undefined)
          return errorResponse(502, "OpenAI's answer had no WebRTC answer in it.")
        return yield* HttpServerResponse.schemaJson(LiveVoiceAnswer)(
          { sdp, model: model.name, voice },
          { status: 201 },
        )
      }),
    )
  }),
)
