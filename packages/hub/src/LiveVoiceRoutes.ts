// Live voice (spike, ADR 0033): `POST /sessions/<id>/voice` starts a live voice session with a
// Session, for its Creator alone, since what they say drives it (ADR 0026).
//
// - The browser sends its WebRTC offer; the Hub starts the voice session at the Provider of the
//   Creator's live voice Model, with their own Connected provider, and answers with the Provider's
//   SDP. The credential stays on the Hub, as the Gateway's do. After that, audio and the data
//   channel run between the browser and the Provider: the Hub isn't in them.
// - Which GPT-Live depends on what the Creator has. Their live voice connection, the Codex CLI's
//   ChatGPT sign-in (LiveVoiceConnections.ts), reaches `gpt-live-1-codex` through ChatGPT's backend
//   as Codex calls it (`POST https://chatgpt.com/backend-api/codex/realtime/calls`, `{sdp, session}`
//   in, the SDP answer out, with its account in `chatgpt-account-id`). An OpenAI API key, their
//   Connected provider, reaches `gpt-live-1` through the API (`POST /v1/live/sessions`). kndl's own
//   ChatGPT sign-in reaches neither: both answer it 401. Until the Creator chooses, the first they
//   have; one chosen that they lack is refused, saying what to do.
// - With a reasoning model, the default (spike): GPT-Live runs with Responses delegation, handing
//   what it is asked to a stronger reasoning model of OpenAI's, the Member's choice, with web search
//   and the kndl tools (LiveVoiceTools), which the browser runs on the Session as its Creator. Talk
//   only: GPT-Live runs with client delegation: it holds the conversation, and when it is asked
//   for work it delegates to the browser, which prompts the Session. Its instructions say so, and
//   carry the Session's latest Turns, so it knows what has happened. The answer names the protocol
//   its data channel speaks, which differs between the two, and the mode.
// - Refusals: `403` for anyone but the Creator, `409` for an Archived Session, or a Creator without
//   what the Model runs on (or who must connect it again), `502` with the Provider's
//   reason when it refuses or can't be reached. Logged with the Session, never what is said.

import {
  driveRefusal,
  type HistoryTurn,
  type LiveVoiceProtocol,
  LiveVoiceAnswer,
  LiveVoiceOffer,
  LiveVoicePrompt,
  type LiveVoicePromptAsk,
  LiveVoicePromptAsk as LiveVoicePromptAskSchema,
  type ProviderModel,
  DefaultReasoningModel,
  LiveVoiceTools,
  liveVoiceModeOf,
  liveVoiceModelFor,
  liveVoiceOf,
  type Participant,
  type ParticipantId,
  SessionId,
  type SessionSummary,
  sessionTitle,
} from "@kndl/protocol"
import { Duration, Effect, Option, Schema } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http"
import { authenticateParticipant, requireSameOrigin } from "./Auth.ts"
import { ConnectedProviders, ProviderApis } from "./ConnectedProviders.ts"
import { historyPage } from "./Handoff.ts"
import { LiveVoiceConnections } from "./LiveVoiceConnections.ts"
import { Members } from "./Members.ts"
import type { ApiCall } from "./PiProviders.ts"
import { readAtMost } from "./ReadAtMost.ts"
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

/**
 * How each protocol tells the voice what to keep quiet and what to say (as OpenClaw words it): the
 * bridge sends progress quietly, and the agent's answers and questions to say.
 */
const channelInstructions: Record<LiveVoiceProtocol, string> = {
  Codex:
    "Context on the commentary channel is silent background: use it, but never read it aloud. Context on the speakable channel is what to say now: deliver it naturally, in your own words. Never mention the channel or the delegation.",
  Live: "Information in session.thinking.append is silent context: use it when relevant, but don't read it aloud because it arrives. Information in session.commentary.append is an update to say aloud now, naturally, in your own words. Never mention the channel or the delegation.",
}

/** What the voice is told it is, for a Session, its Creator and the Session's latest Turns. */
export const voiceInstructions = (
  session: SessionSummary,
  you: Participant,
  turns: ReadonlyArray<HistoryTurn>,
  protocol: LiveVoiceProtocol = "Codex",
): string => {
  const history = turnsText(turns)
  return [
    `You are the voice of a kndl Session, "${sessionTitle(session)}" on ${session.repo}: a coding agent's session. You are talking with ${you.name}, who drives it.`,
    "You do no work yourself and have no tools: the Session's agent does the work. Whenever they ask for anything to be done, checked, explained from the code, or changed, or anything about the code, the Session or the agent, delegate it. Handle small talk, and questions about what they want, yourself.",
    "You can't see the code, the Session or what the agent did, beyond what you are told here and on your channels. Never answer such a request yourself, from the history below or from what you know, and never make up what the agent did, found or said: delegate, and say only what you are told back. Never say you passed something on unless you delegated it, and claim no progress you weren't told of.",
    "Delegate each request once, and wait for its result. A follow-up, a correction or a retry from them is a new request. The agent's progress, answers and questions are not requests: never delegate them, and don't repeat the request when they arrive.",
    channelInstructions[protocol],
    "While the agent works you are told its progress quietly; say something only if asked. When it finishes you are told its answer, perhaps in several parts: say it briefly, in plain speech, without reading code, paths or long lists out. If the agent asks a question, put it to them, and delegate their answer.",
    "Keep every reply short and spoken-friendly.",
    history === ""
      ? "Nothing has happened in the Session yet."
      : `Background, so you follow what they talk about: what happened in the Session before this call, oldest first. It may be out of date. Don't answer from it: delegate.\n\n${history}`,
  ].join("\n\n")
}

/** The history, as background the voice or its reasoning model follows the talk by. */
const background = (turns: ReadonlyArray<HistoryTurn>) => {
  const history = turnsText(turns)
  return history === ""
    ? "Nothing has happened in the Session yet."
    : `Background, so you follow what they talk about: what happened in the Session before this call, oldest first. It may be out of date. Don't answer from it: check.\n\n${history}`
}

/**
 * What the voice is told it is with a reasoning model behind it (spike): it holds the
 * conversation, and hands anything that needs thought or action to the reasoning model.
 */
export const reasoningVoiceInstructions = (
  session: SessionSummary,
  you: Participant,
  protocol: LiveVoiceProtocol = "Codex",
): string =>
  [
    `You are the voice of a kndl Session, "${sessionTitle(session)}" on ${session.repo}: a coding agent's session. You are talking with ${you.name}, who drives it.`,
    "Behind you is a reasoning assistant: it thinks, can search the web, and works the Session's coding agent. It gives the agent work, checks on it, reads what it did, answers its questions and stops it. Delegate to it anything that needs thought, facts or action, and anything about the code, the Session or the agent. Handle small talk, and questions about what they want, yourself. Keep the conversation going naturally while it works.",
    "You can't see the code, the Session or what the agent did, beyond what you are told. Never answer such a request yourself, and never make up what was done, found or said: say only what you are told back. Never say something was passed on or done unless you were told it was.",
    "Delegate each request once, and wait for its result. A follow-up, a correction or a retry from them is a new request. The agent's progress, answers and questions are not requests: never delegate them, and don't repeat the request when they arrive.",
    channelInstructions[protocol],
    "When the agent finishes work it was given, you are told its answer, perhaps in several parts: say it briefly, in plain speech, without reading code, paths or long lists out. If the agent asks a question, put it to them, and delegate their answer.",
    "Keep every reply short and spoken-friendly.",
  ].join("\n\n")

/** What the reasoning model behind the voice is told it is, and what its kndl tools are for. */
export const reasoningInstructions = (
  session: SessionSummary,
  you: Participant,
  turns: ReadonlyArray<HistoryTurn>,
): string =>
  [
    `You are the reasoning assistant behind a voice conversation with ${you.name} about a kndl Session, "${sessionTitle(session)}" on ${session.repo}. The Session's coding agent works on the code there. You can't see the code yourself.`,
    "To have anything done, checked, explained from the code or changed, use send_to_agent, with a clear, self-contained instruction: what they want, not a transcript of how they said it. It returns at once. The agent's answer reaches the conversation, and them, when the agent is done: don't wait or poll for it.",
    "Use agent_status for what the agent is doing now, read_agent_history for what it did or answered, answer_agent_question when they answer the agent's question, and stop_agent when they want it stopped. Use web search for facts beyond the code.",
    "Answer for speech: briefly and plainly, without code or long lists. Say what you did, and nothing you didn't.",
    background(turns),
  ].join("\n\n")

const decodeOffer = Schema.decodeUnknownOption(LiveVoiceOffer)

/** GPT-Live's API (`gpt-live-1`): a key's call, JSON in, JSON out. */
const liveApiCall = (sdp: string, session: Record<string, unknown>): ApiCall => ({
  method: "POST",
  path: "/v1/live/sessions",
  headers: new Headers({ "content-type": "application/json", accept: "application/json" }),
  keyHeader: "authorization",
  body: new TextEncoder().encode(JSON.stringify({ session, transport: { type: "webrtc", sdp } })),
})

/** Where GPT-Live through ChatGPT's backend starts a call, as Codex calls it. */
export const codexCallUrl =
  "https://chatgpt.com/backend-api/codex/realtime/calls?intent=quicksilver&architecture=avas"

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

/**
 * The Session in the path, and the person talking with it, if they may: its Creator, since what is
 * said drives it (ADR 0026), from the web UI's origin, on a Session not archived; else the answer
 * refusing them.
 */
const talkingTo = Effect.gen(function* () {
  yield* requireSameOrigin
  const you = yield* authenticateParticipant
  const { sessionId } = yield* HttpRouter.params
  const access = yield* authorizeAccessFor(you, SessionId.make(sessionId ?? "-")).pipe(
    Effect.map((found) => ({ session: found.session })),
    Effect.catchTag("SessionAccessRefused", (refusal) =>
      Effect.succeed({
        refused: errorResponse(refusal.reason === "AccessUnknown" ? 503 : 404, refusal.message),
      }),
    ),
  )
  if ("refused" in access) return access
  const { session } = access
  const notYours = driveRefusal(you, session.creator, session.harness)
  if (notYours !== undefined) return { refused: errorResponse(403, notYours.refusal) }
  if (session.state === "Archived") {
    return { refused: errorResponse(409, "The Session is archived: restore it to talk with it.") }
  }
  return { you, session }
})

// ── Clean prompts ───────────────────────────────────────────────────────────

/** How long the Hub waits for the prompt to be written: then the browser sends what was said. */
const promptTimeout = Duration.seconds(10)

/** The most of the Model's answer read. */
const promptAnswerLimit = 256 * 1024

/**
 * The Model that writes prompts: the Creator's fastest-sounding OpenAI Model (a mini, nano or
 * Luna), else their first. None without an OpenAI connection.
 */
export const promptModelOf = (models: ReadonlyArray<ProviderModel>): ProviderModel | undefined => {
  const openai = models.filter((model) => model.provider === "openai")
  return openai.find((model) => /mini|nano|luna/i.test(model.id)) ?? openai[0]
}

/** The least thinking the Model takes, as OpenAI's `reasoning.effort`; none for one that doesn't. */
const leastEffort = (model: ProviderModel): string | undefined =>
  model.thinkingLevels.find((level) => level === "minimal" || level === "low")

/** What the Model is told it does, for the Session, and the question answered if there is one. */
export const promptInstructions = (
  session: SessionSummary,
  turns: ReadonlyArray<HistoryTurn>,
  question: string | undefined,
): string =>
  [
    `You turn what a person said aloud into the prompt they mean a coding agent to get. The agent works on the code of a kndl Session, "${sessionTitle(session)}" on ${session.repo}. You get what was said in a voice call since the last prompt: the person's words, transcribed with fillers, false starts and mishearings, and the voice assistant's replies.`,
    question === undefined
      ? "Write the one prompt the person means: clear, direct and specific, in their language, as they would type it to the agent. A question stays a question."
      : `The agent asked them: "${question}". Write their answer to it, as a short, clear reply to the agent, in their language.`,
    'Keep every detail that matters: names, files, numbers, constraints. Drop fillers, hesitations and small talk. Add nothing they didn\'t ask for: no extra tasks, steps or assumptions. When they refer to something earlier ("that test", "it"), name it from the conversation or the Session\'s history if that is clear; else keep their words.',
    "Reply with the prompt alone: no quotes, labels or preamble.",
    background(turns),
  ].join("\n\n")

/** What was said, as the Model reads it. */
export const exchangeText = (ask: LiveVoicePromptAsk): string =>
  [
    "What was said since the last prompt:",
    ...ask.exchange
      .filter((line) => line.text.trim() !== "")
      .map((line) => `${line.role === "user" ? "Person" : "Voice"}: ${line.text.trim()}`),
    ...(ask.asked !== undefined && ask.asked.trim() !== ""
      ? [`The voice named the task as: ${ask.asked.trim()}`]
      : []),
  ].join("\n")

/** JSON's object, or undefined for anything else. */
const parseObject = (text: string): Record<string, unknown> | undefined => {
  try {
    const value: unknown = JSON.parse(text)
    return typeof value === "object" && value !== null
      ? (value as Record<string, unknown>)
      : undefined
  } catch {
    return undefined
  }
}

/**
 * The text a Responses API answer holds: from its stream's events (`response.output_text.delta`, or
 * `.done` whole), or from a whole JSON answer's `output`. Undefined when there is none.
 */
export const responseText = (body: string): string | undefined => {
  const events = body
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .filter((data) => data !== "" && data !== "[DONE]")
  if (events.length > 0) {
    let deltas = ""
    for (const data of events) {
      const event = parseObject(data)
      if (event?.["type"] === "response.output_text.done" && typeof event["text"] === "string") {
        return event["text"]
      }
      if (event?.["type"] === "response.output_text.delta" && typeof event["delta"] === "string") {
        deltas += event["delta"]
      }
    }
    return deltas === "" ? undefined : deltas
  }
  const whole = parseObject(body)
  const output = Array.isArray(whole?.["output"]) ? (whole["output"] as Array<unknown>) : []
  const texts = output.flatMap((item) => {
    const content = (item as { content?: unknown }).content
    return Array.isArray(content)
      ? content.flatMap((part) => {
          const { type, text } = part as { type?: unknown; text?: unknown }
          return type === "output_text" && typeof text === "string" ? [text] : []
        })
      : []
  })
  return texts.length === 0 ? undefined : texts.join("")
}

/** The prompt as written, without quotes or a label a Model may add anyway. */
const cleaned = (text: string) =>
  text
    .trim()
    .replace(/^(prompt|reply)\s*:\s*/i, "")
    .replace(/^["“”'](.*)["“”']$/s, "$1")
    .trim()

const decodePromptAsk = Schema.decodeUnknownOption(LiveVoicePromptAskSchema)

export const LiveVoiceRoutes = HttpRouter.use(
  Effect.fn(function* (router) {
    const providers = yield* ConnectedProviders
    const voiceConnections = yield* LiveVoiceConnections
    const apis = yield* ProviderApis
    const members = yield* Members
    const log = yield* SessionLog

    /**
     * GPT-Live through ChatGPT's backend (`gpt-live-1-codex`), on the live voice connection, as
     * Codex calls it: `{sdp, session}` in, the SDP answer alone out, with the account in
     * `chatgpt-account-id` and fresh ids. A 401 has the sign-in refreshed and the call sent once
     * more. A failure: why, for the Member.
     */
    const codexCall = (
      participantId: ParticipantId,
      sdp: string,
      session: Record<string, unknown>,
    ) => {
      const send = (force: boolean) =>
        Effect.gen(function* () {
          const access = yield* voiceConnections.access(participantId, { force })
          const headers = new Headers({
            authorization: `Bearer ${access.token}`,
            "content-type": "application/json",
            "openai-alpha": "quicksilver=v2",
            "session-id": crypto.randomUUID(),
            "thread-id": crypto.randomUUID(),
            "x-session-id": crypto.randomUUID(),
          })
          if (access.accountId !== undefined) headers.set("chatgpt-account-id", access.accountId)
          const response = yield* Effect.tryPromise(() =>
            apis.fetch(
              new Request(codexCallUrl, {
                method: "POST",
                headers,
                body: JSON.stringify({ sdp, session }),
                redirect: "manual",
              }),
            ),
          ).pipe(Effect.option)
          return response._tag === "Some"
            ? ({ _tag: "Answered", response: response.value } as const)
            : ({ _tag: "Unreachable" } as const)
        })
      return send(false).pipe(
        Effect.flatMap((first) =>
          first._tag === "Answered" && first.response.status === 401
            ? Effect.andThen(
                Effect.promise(() => first.response.body?.cancel() ?? Promise.resolve()),
                send(true),
              )
            : Effect.succeed(first),
        ),
        Effect.mapError((unusable) => unusable.message),
        Effect.result,
      )
    }

    yield* router.add(
      "POST",
      "/sessions/:sessionId/voice",
      Effect.gen(function* () {
        const access = yield* talkingTo
        if ("refused" in access) return access.refused
        const { you, session } = access
        const request = yield* HttpServerRequest.HttpServerRequest
        const offer = decodeOffer(yield* request.json.pipe(Effect.orElseSucceed(() => null)))
        if (offer._tag === "None") return errorResponse(400, "Expected a WebRTC offer, {sdp}.")

        // What they have picks the way to GPT-Live: their live voice connection through ChatGPT,
        // or an OpenAI API key through the API.
        const keyed = yield* providers.usableAs(you.id, "openai").pipe(Effect.option)
        const has = [
          ...(voiceConnections.info(you.id) !== undefined ? (["Codex"] as const) : []),
          ...(keyed._tag === "Some" && keyed.value === "ApiKey" ? (["ApiKey"] as const) : []),
        ]
        const setting = yield* members.liveVoice(you.id).pipe(Effect.orDie)
        const model = liveVoiceModelFor(setting, has)
        if (!has.includes(model.connection)) {
          return errorResponse(
            409,
            model.connection === "Codex"
              ? `${model.label} needs your live voice connection: sign in with ChatGPT (Codex) under Live voice on the Account page.`
              : `${model.label} runs on an OpenAI API key, and your OpenAI connection isn't one: pick GPT-Live 1 (ChatGPT, through Codex) on the Account page, or connect a key.`,
          )
        }
        const voice = liveVoiceOf(model, setting)
        const { entries, earlier } = yield* log
          .lastTurns(session.id, { count: contextTurns })
          .pipe(Effect.orDie)
        const { turns } = historyPage(entries, { limit: contextTurns, earlier })
        // With a reasoning model behind it (spike), GPT-Live hands what you ask to it, and the
        // browser runs its kndl tools; else straight to the Session, as prompts.
        // Through ChatGPT, Talk only: its backend runs no reasoning model's tools (as Codex uses it).
        const mode = liveVoiceModeOf(setting, model)
        const configured = {
          model: model.id,
          instructions:
            mode === "Reasoning"
              ? reasoningVoiceInstructions(session, you, model.protocol)
              : voiceInstructions(session, you, turns, model.protocol),
          audio: { output: { voice } },
          delegation:
            mode === "Reasoning"
              ? {
                  type: "responses",
                  responses: {
                    model: setting?.reasoningModel ?? DefaultReasoningModel,
                    instructions: reasoningInstructions(session, you, turns),
                    tools: [...LiveVoiceTools, { type: "web_search" }],
                    tool_choice: "auto",
                    parallel_tool_calls: false,
                  },
                }
              : { type: "client" },
        }

        const called =
          model.connection === "Codex"
            ? yield* codexCall(you.id, offer.value.sdp, configured)
            : yield* providers
                .call(you.id, model.provider, liveApiCall(offer.value.sdp, configured))
                .pipe(
                  Effect.mapError(
                    (unusable) =>
                      `${unusable.message} Live voice runs on your OpenAI API key: connect it on the Account page.`,
                  ),
                  Effect.result,
                )
        if (called._tag === "Failure") return errorResponse(409, called.failure)
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
        // As sent: an SDP's every line ends with CRLF, the last too, or browsers lose that line.
        const sdp =
          model.connection === "Codex" ? (text.trim() === "" ? undefined : text) : answerSdp(text)
        if (sdp === undefined) {
          return errorResponse(502, "OpenAI's answer had no WebRTC answer in it.")
        }
        return yield* HttpServerResponse.schemaJson(LiveVoiceAnswer)(
          { sdp, model: model.name, voice, protocol: model.protocol, mode },
          { status: 201 },
        )
      }),
    )

    // What was said since the last hand-off, written into the prompt the person means, by a fast
    // Model on their OpenAI connection, as they'd type it. A refusal leaves the browser to send
    // what was said as it is.
    yield* router.add(
      "POST",
      "/sessions/:sessionId/voice/prompt",
      Effect.gen(function* () {
        const access = yield* talkingTo
        if ("refused" in access) return access.refused
        const { you, session } = access
        const request = yield* HttpServerRequest.HttpServerRequest
        const ask = decodePromptAsk(yield* request.json.pipe(Effect.orElseSucceed(() => null)))
        if (ask._tag === "None")
          return errorResponse(400, "Expected {exchange, asked?, question?}.")
        if (!ask.value.exchange.some((line) => line.role === "user" && line.text.trim() !== "")) {
          return errorResponse(400, "Nothing the person said to write a prompt from.")
        }
        const model = promptModelOf(yield* providers.modelsFor(you.id))
        if (model === undefined) {
          return errorResponse(409, "Connect OpenAI to have the voice write clean prompts.")
        }
        const { entries, earlier } = yield* log
          .lastTurns(session.id, { count: 3 })
          .pipe(Effect.orDie)
        const { turns } = historyPage(entries, { limit: 3, earlier })
        const effort = leastEffort(model)
        // As pi sends a ChatGPT sign-in's: streamed, not stored, with none of the fields it refuses.
        const body = JSON.stringify({
          model: model.id,
          instructions: promptInstructions(session, turns, ask.value.question),
          input: [{ role: "user", content: exchangeText(ask.value) }],
          stream: true,
          store: false,
          ...(effort !== undefined && { reasoning: { effort } }),
        })
        const written = yield* providers
          .call(you.id, "openai", {
            method: "POST",
            path: "/v1/responses",
            headers: new Headers({
              "content-type": "application/json",
              accept: "text/event-stream",
            }),
            keyHeader: "authorization",
            body: new TextEncoder().encode(body),
          })
          .pipe(
            Effect.flatMap((called) =>
              called._tag === "Answered" && called.response.ok
                ? Effect.promise(() => readAtMost(called.response.body, promptAnswerLimit)).pipe(
                    Effect.map((bytes) =>
                      bytes === undefined
                        ? undefined
                        : responseText(new TextDecoder().decode(bytes)),
                    ),
                  )
                : Effect.as(
                    Effect.logWarning(
                      `Writing a voice prompt: OpenAI ${called._tag === "Answered" ? `answered ${called.response.status}` : "couldn't be reached"}`,
                    ),
                    undefined,
                  ),
            ),
            Effect.timeoutOption(promptTimeout),
            Effect.result,
          )
        // Not written: refused, unreachable, too slow, or nothing in the answer.
        const text = written._tag === "Success" ? Option.getOrUndefined(written.success) : undefined
        const prompt = text === undefined ? "" : cleaned(text)
        yield* Effect.logInfo(
          `Live voice prompt on ${model.id}: ${prompt === "" ? "not written" : `${prompt.length} characters`}`,
        ).pipe(Effect.annotateLogs({ sessionId: session.id, component: "LiveVoice" }))
        if (prompt === "") return errorResponse(502, "The prompt couldn't be written just now.")
        return yield* HttpServerResponse.schemaJson(LiveVoicePrompt)({ prompt })
      }),
    )
  }),
)
