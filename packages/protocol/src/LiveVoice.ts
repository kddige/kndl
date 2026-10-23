// Live voice (spike, ADR 0033): talking with a Session. A live voice Model holds the spoken
// conversation in the browser, and hands every piece of work to the Session underneath, whose
// agent does it, as a prompt from its Creator. The Hub starts the voice session with the Creator's
// own Connected provider, so the credential never reaches the browser.

import { Schema } from "effect"
import { RequestId } from "./Ids.ts"

/**
 * How the browser talks with a live voice session once it is started, on its data channel:
 * `Live`, the GPT-Live API's events (`session.*`); `Codex`, those of GPT-Live through ChatGPT's
 * backend, as Codex has them (`delegation.*`, `*_transcript.added`).
 */
export const LiveVoiceProtocol = Schema.Literals(["Live", "Codex"])
export type LiveVoiceProtocol = typeof LiveVoiceProtocol.Type

/** A live voice Model kndl knows how to talk to: its Provider, and its id there. */
export interface LiveVoiceModelInfo {
  /** `<provider>/<id>`, as the setting names it. */
  readonly name: string
  /** The Provider whose Connected provider it runs on. */
  readonly provider: "openai"
  readonly id: string
  readonly label: string
  /**
   * What it runs on: `Codex`, the Member's live voice connection, the Codex CLI's ChatGPT sign-in,
   * through ChatGPT's backend; `ApiKey`, their Connected provider for OpenAI, connected with an
   * API key, through OpenAI's API, which takes nothing else.
   */
  readonly connection: LiveVoiceCredential
  readonly protocol: LiveVoiceProtocol
  /** The voices it speaks with, the first its default. */
  readonly voices: ReadonlyArray<string>
}

/** GPT-Live's voices through ChatGPT, as Codex names them: its default first. */
const gptLiveChatGptVoices = [
  "cove",
  "arbor",
  "breeze",
  "ember",
  "juniper",
  "maple",
  "sol",
  "spruce",
  "vale",
]

/** GPT-Live's voices, as OpenAI names them: its default, then the English ones, then the rest. */
const gptLiveVoices = [
  "marin",
  "quartz",
  "ripple",
  "vesper",
  "willow",
  "stone",
  "gleam",
  "meridian",
  "beacon",
  "delta",
  "cinder",
  "bossa",
  "tempo",
  "nuri",
  "juni",
  "flitz",
  "brise",
  "sillage",
  "nira",
  "harema",
  "shida",
  "noeul",
]

/**
 * Every live voice Model kndl talks to. One Provider's for now: GPT-Live, through ChatGPT for the
 * live voice connection and through OpenAI's API for a key. Another Provider's, such as xAI's, joins this list
 * with its own way of starting a session (LiveVoiceRoutes.ts).
 */
export const LiveVoiceModels: ReadonlyArray<LiveVoiceModelInfo> = [
  {
    name: "openai/gpt-live-1-codex",
    provider: "openai",
    id: "gpt-live-1-codex",
    label: "GPT-Live 1 (ChatGPT, through Codex)",
    connection: "Codex",
    protocol: "Codex",
    voices: gptLiveChatGptVoices,
  },
  {
    name: "openai/gpt-live-1",
    provider: "openai",
    id: "gpt-live-1",
    label: "GPT-Live 1 (API key)",
    connection: "ApiKey",
    protocol: "Live",
    voices: gptLiveVoices,
  },
]

/** The live voice Model by its name, if kndl knows it. */
export const liveVoiceModel = (name: string): LiveVoiceModelInfo | undefined =>
  LiveVoiceModels.find((model) => model.name === name)

/** What a live voice Model runs on: the live voice connection, or an OpenAI API key. */
export type LiveVoiceCredential = "Codex" | "ApiKey"

/**
 * The live voice Model a Member talks to: the one they chose, else the first that runs on what
 * they `has`: their live voice connection, an OpenAI API key, or both.
 */
export const liveVoiceModelFor = (
  setting: LiveVoiceSetting | undefined,
  has: ReadonlyArray<LiveVoiceCredential>,
): LiveVoiceModelInfo => {
  const chosen = setting === undefined ? undefined : liveVoiceModel(setting.model)
  if (chosen !== undefined) return chosen
  return (
    LiveVoiceModels.find((model) => has.includes(model.connection)) ??
    (LiveVoiceModels[0] as LiveVoiceModelInfo)
  )
}

/**
 * A Member's live voice setting: the Model they talk to, and its voice, else its default. Absent
 * until they choose, when the Model is the one for how they connected (`liveVoiceModelFor`).
 */
export const LiveVoiceSetting = Schema.Struct({
  model: Schema.String.check(
    Schema.makeFilter((name) =>
      liveVoiceModel(name) === undefined ? `kndl can't talk to ${name}.` : undefined,
    ),
  ),
  voice: Schema.optionalKey(Schema.NonEmptyString),
})
export type LiveVoiceSetting = typeof LiveVoiceSetting.Type

/** The voice to speak with on the Model: the setting's if the Model has it, else its default. */
export const liveVoiceOf = (model: LiveVoiceModelInfo, setting?: LiveVoiceSetting): string =>
  setting?.voice !== undefined &&
  setting.model === model.name &&
  model.voices.includes(setting.voice)
    ? setting.voice
    : (model.voices[0] ?? "")

/** What a sign-in is for, besides a Connected provider: the live voice connection. */
export const SignInFor = Schema.Literal("LiveVoice")
export type SignInFor = typeof SignInFor.Type

/**
 * A Member's live voice connection, as the Account page shows it: the Codex CLI's ChatGPT sign-in,
 * apart from their Connected provider for OpenAI, whose sign-in GPT-Live refuses.
 */
export const LiveVoiceConnection = Schema.Struct({
  /** The ChatGPT account, as its token names it. */
  label: Schema.String,
  connectedAt: Schema.Number,
})
export type LiveVoiceConnection = typeof LiveVoiceConnection.Type

/** Web to Hub: set the signed-in Member's live voice. Answered with ProvidersState. */
export const SetLiveVoice = Schema.TaggedStruct("SetLiveVoice", {
  requestId: RequestId,
  setting: LiveVoiceSetting,
})
export type SetLiveVoice = typeof SetLiveVoice.Type

// ── Starting one: `POST /sessions/<id>/voice` ───────────────────────────────

/** The Hub's path that starts a live voice session with a Session. */
export const liveVoicePath = (sessionId: string) =>
  `/sessions/${encodeURIComponent(sessionId)}/voice`

/** The browser's WebRTC offer, with its microphone and the `oai-events` data channel. */
export const LiveVoiceOffer = Schema.Struct({ sdp: Schema.NonEmptyString })
export type LiveVoiceOffer = typeof LiveVoiceOffer.Type

/** The Provider's WebRTC answer, and what the voice session runs on. */
export const LiveVoiceAnswer = Schema.Struct({
  sdp: Schema.NonEmptyString,
  model: Schema.String,
  voice: Schema.String,
  /** The events to speak on its data channel. */
  protocol: LiveVoiceProtocol,
})
export type LiveVoiceAnswer = typeof LiveVoiceAnswer.Type
