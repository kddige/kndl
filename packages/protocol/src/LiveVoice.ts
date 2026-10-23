// Live voice (spike, ADR 0033): talking with a Session. A live voice Model holds the spoken
// conversation in the browser, and hands every piece of work to the Session underneath, whose
// agent does it, as a prompt from its Creator. The Hub starts the voice session with the Creator's
// own Connected provider, so the credential never reaches the browser.

import { Schema } from "effect"
import { RequestId } from "./Ids.ts"

/** A live voice Model kndl knows how to talk to: its Provider, and its id there. */
export interface LiveVoiceModelInfo {
  /** `<provider>/<id>`, as the setting names it. */
  readonly name: string
  /** The Provider whose Connected provider it runs on. */
  readonly provider: "openai"
  readonly id: string
  readonly label: string
  /** The voices it speaks with, the first its default. */
  readonly voices: ReadonlyArray<string>
}

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
 * Every live voice Model kndl talks to, the default first. One Provider's for now; another's, such
 * as xAI's, joins this list with its own way of starting a session (LiveVoiceRoutes.ts).
 */
export const LiveVoiceModels: ReadonlyArray<LiveVoiceModelInfo> = [
  {
    name: "openai/gpt-live-1",
    provider: "openai",
    id: "gpt-live-1",
    label: "GPT-Live 1",
    voices: gptLiveVoices,
  },
]

/** The live voice Model a Member talks to until they choose one. */
export const DefaultLiveVoiceModel = "openai/gpt-live-1"

/** The live voice Model by its name, if kndl knows it. */
export const liveVoiceModel = (name: string): LiveVoiceModelInfo | undefined =>
  LiveVoiceModels.find((model) => model.name === name)

/** A Member's live voice setting: the Model they talk to, and its voice, else its default. */
export const LiveVoiceSetting = Schema.Struct({
  model: Schema.String.check(
    Schema.makeFilter((name) =>
      liveVoiceModel(name) === undefined ? `kndl can't talk to ${name}.` : undefined,
    ),
  ),
  voice: Schema.optionalKey(Schema.NonEmptyString),
})
export type LiveVoiceSetting = typeof LiveVoiceSetting.Type

/** What a Member talks with before they choose. */
export const defaultLiveVoice: LiveVoiceSetting = { model: DefaultLiveVoiceModel }

/** The voice a setting speaks with: its own if its Model has it, else the Model's default. */
export const liveVoiceOf = (setting: LiveVoiceSetting): string => {
  const voices = liveVoiceModel(setting.model)?.voices ?? []
  return setting.voice !== undefined && voices.includes(setting.voice)
    ? setting.voice
    : (voices[0] ?? "")
}

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
})
export type LiveVoiceAnswer = typeof LiveVoiceAnswer.Type
