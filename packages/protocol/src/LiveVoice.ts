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
  /** How the voice works: with a reasoning model unless `Talk`. */
  mode: Schema.optionalKey(Schema.Literals(["Reasoning", "Talk"])),
  /** The reasoning model, for `Reasoning`; {@link DefaultReasoningModel} unless set. */
  reasoningModel: Schema.optionalKey(Schema.NonEmptyString),
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

// ── A reasoning model behind the voice (spike) ───────────────────────────────

/**
 * How the voice works (ADR 0033): `Reasoning`, GPT-Live hands what you ask to a stronger reasoning
 * model of OpenAI's, which thinks, can search the web, and drives the Session's agent with the kndl
 * tools the browser runs ({@link LiveVoiceTools}); `Talk`, GPT-Live hands it straight to the
 * Session's agent, as a prompt.
 */
export type LiveVoiceMode = "Reasoning" | "Talk"

/** The mode a setting asks for: with a reasoning model unless it says `Talk`. */
export const liveVoiceModeOf = (setting: LiveVoiceSetting | undefined): LiveVoiceMode =>
  setting?.mode ?? "Reasoning"

/** The reasoning models offered, the default first: as OpenAI's GPT-Live guide suggests them. */
export const ReasoningModels: ReadonlyArray<{ readonly id: string; readonly label: string }> = [
  { id: "gpt-6-luna", label: "GPT-6 Luna (faster)" },
  { id: "gpt-6-sol", label: "GPT-6 Sol (for harder work)" },
]

/** The reasoning model unless one is chosen. */
export const DefaultReasoningModel = "gpt-6-luna"

/**
 * The kndl tools the reasoning model has, on the Session the call is with, as OpenAI's function
 * tools take them. The browser runs each as the Session's Creator, through their web connection,
 * so each can do only what they can.
 */
export const LiveVoiceTools = [
  {
    type: "function",
    name: "send_to_agent",
    description:
      "Gives the Session's coding agent work, as a prompt from the person: a clear, self-contained instruction, not a transcript of what was said. Returns at once; the agent's answer reaches the conversation when it is done. Don't poll for it.",
    parameters: {
      type: "object",
      properties: { prompt: { type: "string", description: "The instruction for the agent." } },
      required: ["prompt"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "agent_status",
    description:
      "What the Session's coding agent is doing now: working or idle, what it is running, a question it asks, prompts waiting.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    type: "function",
    name: "read_agent_history",
    description:
      "The Session's latest Turns, newest last: what the agent was asked, and what it answered, shortened.",
    parameters: {
      type: "object",
      properties: { turns: { type: "integer", minimum: 1, maximum: 10 } },
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "answer_agent_question",
    description: "Answers the question the agent asks now, in the person's words.",
    parameters: {
      type: "object",
      properties: { answer: { type: "string" } },
      required: ["answer"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "stop_agent",
    description: "Stops what the agent is doing now: its running Turn.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
] as const

/** A kndl tool's name. */
export type LiveVoiceToolName = (typeof LiveVoiceTools)[number]["name"]

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
  /** How it works: the browser runs the kndl tools for `Reasoning`. Absent: `Talk`. */
  mode: Schema.optionalKey(Schema.Literals(["Reasoning", "Talk"])),
})
export type LiveVoiceAnswer = typeof LiveVoiceAnswer.Type
