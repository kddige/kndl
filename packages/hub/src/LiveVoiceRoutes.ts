// Live voice (spike, ADR 0033): `POST /sessions/<id>/voice` starts a live voice session with a
// Session, for its Creator alone, since what they say drives it (ADR 0026).
//
// - The browser sends its WebRTC offer; the Hub starts the voice session at the Provider of the
//   Creator's live voice Model, with their own Connected provider, and answers with the Provider's
//   SDP. The credential stays on the Hub, as the Gateway's do. After that, audio and the data
//   channel run between the browser and the Provider: the Hub isn't in them.
// - Which GPT-Live depends on how the Creator connected OpenAI. A ChatGPT sign-in reaches only
//   `gpt-live-1-codex`, through ChatGPT's backend as Codex calls it (`POST https://chatgpt.com/
//   backend-api/codex/realtime/calls`, `{sdp, session}` in, the SDP answer out, with the sign-in's
//   account in `chatgpt-account-id`): OpenAI's API refuses it (401). An API key reaches
//   `gpt-live-1` through the API (`POST /v1/live/sessions`). Until the Creator chooses, the one for
//   their connection; one chosen for the other connection is refused, saying which to pick.
// - Either runs with client delegation: it holds the conversation, and when it is asked for work
//   it delegates to the browser, which prompts the Session. Its instructions say so, and carry the
//   Session's latest Turns, so it knows what has happened. The answer names the protocol its data
//   channel speaks, which differs between the two.
// - Refusals: `403` for anyone but the Creator, `409` for an Archived Session, or a Creator who
//   hasn't connected the Model's Provider (or must connect it again), `502` with the Provider's
//   reason when it refuses or can't be reached. Logged with the Session, never what is said.

import {
  driveRefusal,
  type HistoryTurn,
  LiveVoiceAnswer,
  LiveVoiceOffer,
  liveVoiceModelFor,
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
import type { ApiCall } from "./PiProviders.ts"
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

/** GPT-Live's API (`gpt-live-1`): a key's call, JSON in, JSON out. */
const liveApiCall = (sdp: string, session: Record<string, unknown>): ApiCall => ({
  method: "POST",
  path: "/v1/live/sessions",
  headers: new Headers({ "content-type": "application/json", accept: "application/json" }),
  keyHeader: "authorization",
  body: new TextEncoder().encode(JSON.stringify({ session, transport: { type: "webrtc", sdp } })),
})

/**
 * GPT-Live through ChatGPT's backend (`gpt-live-1-codex`), for a ChatGPT sign-in, as Codex calls it:
 * `{sdp, session}` in, the SDP answer alone out. ConnectedProviders adds the sign-in and its
 * account; the ids are fresh for each call.
 */
const chatGptCall = (sdp: string, session: Record<string, unknown>): ApiCall => ({
  signInOrigin: "https://chatgpt.com",
  method: "POST",
  path: "/backend-api/codex/realtime/calls?intent=quicksilver&architecture=avas",
  headers: new Headers({
    "content-type": "application/json",
    "openai-alpha": "quicksilver=v2",
    "session-id": crypto.randomUUID(),
    "thread-id": crypto.randomUUID(),
    "x-session-id": crypto.randomUUID(),
  }),
  keyHeader: "authorization",
  body: new TextEncoder().encode(JSON.stringify({ sdp, session })),
})

/** The SDP in GPT-Live's API's answer, `{session: {id}, transport: {type, sdp}}`. */
const answerSdp = (text: string): string | undefined => {
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    return undefined
  }
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

        // How they connected OpenAI picks the way to GPT-Live: a ChatGPT sign-in through ChatGPT's
        // backend, a key through the API.
        const connection = yield* providers.usableAs(you.id, "openai").pipe(Effect.result)
        if (connection._tag === "Failure") {
          return errorResponse(
            409,
            `${connection.failure.message} Live voice runs on your OpenAI connection: connect it on the Account page.`,
          )
        }
        const setting = yield* members.liveVoice(you.id).pipe(Effect.orDie)
        const model = liveVoiceModelFor(setting, connection.success)
        if (model.connection !== connection.success) {
          return errorResponse(
            409,
            model.connection === "SignIn"
              ? `${model.label} runs on a ChatGPT sign-in, and your OpenAI connection is an API key: pick another live voice on the Account page, or sign in with ChatGPT.`
              : `${model.label} runs on an OpenAI API key, and you are signed in with ChatGPT: pick GPT-Live 1 (ChatGPT) on the Account page, or connect a key.`,
          )
        }
        const voice = liveVoiceOf(model, setting)
        const { entries, earlier } = yield* log
          .lastTurns(session.id, { count: contextTurns })
          .pipe(Effect.orDie)
        const { turns } = historyPage(entries, { limit: contextTurns, earlier })
        const configured = {
          model: model.id,
          instructions: voiceInstructions(session, you, turns),
          audio: { output: { voice } },
          delegation: { type: "client" },
        }

        const called = yield* providers
          .call(
            you.id,
            model.provider,
            model.protocol === "Codex"
              ? chatGptCall(offer.value.sdp, configured)
              : liveApiCall(offer.value.sdp, configured),
          )
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
        const sdp = model.protocol === "Codex" ? text.trim() || undefined : answerSdp(text)
        if (sdp === undefined) {
          return errorResponse(502, "OpenAI's answer had no WebRTC answer in it.")
        }
        return yield* HttpServerResponse.schemaJson(LiveVoiceAnswer)(
          { sdp, model: model.name, voice, protocol: model.protocol },
          { status: 201 },
        )
      }),
    )
  }),
)
