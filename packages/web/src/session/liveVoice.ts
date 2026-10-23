// Live voice in the browser (ADR 0033): the microphone and GPT-Live's voice over WebRTC, its
// `oai-events` data channel, and the VoiceBridge that turns what is said into the Session's
// prompts. The Hub only starts it (`POST /sessions/<id>/voice`), with the Creator's own OpenAI
// connection: audio and events then go between the browser and OpenAI.

import {
  LiveVoiceAnswer,
  liveVoicePath,
  type LiveVoiceProtocol,
  type SessionId,
} from "@kndl/protocol"
import { Schema } from "effect"
import { useEffect, useRef, useState } from "react"
import { useHub } from "../app/hub.tsx"
import type { HubClient } from "../hub/client.ts"
import { toast } from "../ui/index.ts"
import { VoiceBridge, type VoiceEvent } from "./voiceBridge.ts"

export type LiveVoiceStatus =
  | { readonly phase: "off" }
  | { readonly phase: "connecting" }
  | {
      readonly phase: "live"
      /** What GPT-Live is saying now, the latest of it. */
      readonly speaking: string
      readonly muted: boolean
    }
  | { readonly phase: "failed"; readonly message: string }

const decodeAnswer = Schema.decodeUnknownSync(LiveVoiceAnswer)

/**
 * What the bridge tells GPT-Live, in the events of its protocol: the API's `session.thinking.append`
 * and `session.commentary.append`; through ChatGPT, Codex's `delegation.context.append` (or
 * `session.context.append`), quiet on its `commentary` channel and said on `speakable`.
 */
export const wireEvent = (protocol: LiveVoiceProtocol, event: VoiceEvent): object =>
  protocol === "Live"
    ? {
        type: event.kind === "say" ? "session.commentary.append" : "session.thinking.append",
        event_id: event.id,
        delegation_id: event.delegationId,
        content: event.content,
      }
    : {
        type: event.delegationId === null ? "session.context.append" : "delegation.context.append",
        ...(event.delegationId !== null && { delegation_item_id: event.delegationId }),
        channel: event.kind === "say" ? "speakable" : "commentary",
        content: [{ type: "input_text", text: event.content }],
      }

/** What GPT-Live said on its data channel, as the call acts on it, in either protocol. */
export type HeardEvent =
  | { readonly kind: "heard"; readonly text: string }
  | { readonly kind: "spoke"; readonly text: string }
  | { readonly kind: "delegated"; readonly id: string; readonly asked?: string }
  | { readonly kind: "closed"; readonly reason?: string }
  | { readonly kind: "error"; readonly message: string }

/** The value, if it is a string. */
const stringOf = (value: unknown) => (typeof value === "string" ? value : undefined)

/** One of GPT-Live's events, in `protocol`; undefined for one the call needn't act on. */
export function heardEvent(protocol: LiveVoiceProtocol, data: string): HeardEvent | undefined {
  let event: Record<string, unknown>
  try {
    event = JSON.parse(data) as Record<string, unknown>
  } catch {
    return undefined
  }
  const item = (event["item"] ?? {}) as Record<string, unknown>
  switch (event["type"]) {
    case "error": {
      const error = (event["error"] ?? {}) as Record<string, unknown>
      return { kind: "error", message: stringOf(error["message"]) ?? "GPT-Live reported an error." }
    }
    case "session.closed": {
      const reason = stringOf(event["reason"])
      return { kind: "closed", ...(reason !== undefined && { reason }) }
    }
  }
  if (protocol === "Live") {
    switch (event["type"]) {
      case "session.input_transcript.delta": {
        const delta = stringOf(event["delta"])
        return delta === undefined ? undefined : { kind: "heard", text: delta }
      }
      case "session.output_transcript.delta": {
        const delta = stringOf(event["delta"])
        return delta === undefined ? undefined : { kind: "spoke", text: delta }
      }
      case "session.delegation.created": {
        const delegation = (event["delegation"] ?? {}) as Record<string, unknown>
        const id = stringOf(delegation["id"])
        return id !== undefined && delegation["target"] === "client"
          ? { kind: "delegated", id }
          : undefined
      }
    }
    return undefined
  }
  switch (event["type"]) {
    // Whole pieces, not deltas: a space keeps them apart.
    case "input_transcript.added": {
      const said = stringOf(item["text"])
      return said === undefined ? undefined : { kind: "heard", text: ` ${said}` }
    }
    case "output_transcript.added": {
      const said = stringOf(item["text"])
      return said === undefined ? undefined : { kind: "spoke", text: ` ${said}` }
    }
    case "delegation.created": {
      const id = stringOf(item["id"])
      if (id === undefined || item["target"] !== "client") return undefined
      const parts = Array.isArray(item["content"]) ? (item["content"] as Array<unknown>) : []
      const asked = parts
        .map((part) => (part ?? {}) as Record<string, unknown>)
        .filter((part) => part["type"] === "input_text")
        .map((part) => stringOf(part["text"]) ?? "")
        .join("")
      return { kind: "delegated", id, ...(asked.trim() !== "" && { asked }) }
    }
  }
  return undefined
}

/** One live voice conversation with a Session, from `start` until `stop`. */
class LiveVoiceCall {
  #pc: RTCPeerConnection | undefined
  #channel: RTCDataChannel | undefined
  #mic: MediaStream | undefined
  #audio: HTMLAudioElement | undefined
  #unsubscribe: (() => void) | undefined
  #speaking = ""
  #muted = false
  #protocol: LiveVoiceProtocol = "Live"
  readonly #bridge: VoiceBridge

  constructor(
    private readonly hub: HubClient,
    private readonly sessionId: SessionId,
    private readonly onStatus: (status: LiveVoiceStatus) => void,
  ) {
    this.#bridge = new VoiceBridge(
      {
        sendPrompt: (text) => hub.sendPrompt(sessionId, text),
        reply: (question, text) =>
          hub.answerQuestion(sessionId, question.toolCallId, { _tag: "Replied", text }),
      },
      (event) => this.#send(event),
    )
  }

  async start() {
    this.onStatus({ phase: "connecting" })
    try {
      this.#mic = await navigator.mediaDevices.getUserMedia({ audio: true })
      const pc = new RTCPeerConnection()
      this.#pc = pc
      const audio = new Audio()
      audio.autoplay = true
      this.#audio = audio
      pc.ontrack = (event) => {
        audio.srcObject = event.streams[0] ?? null
      }
      for (const track of this.#mic.getAudioTracks()) pc.addTrack(track, this.#mic)
      // Before the offer, so it is in it.
      const channel = pc.createDataChannel("oai-events")
      this.#channel = channel
      channel.addEventListener("message", (message) => this.#received(message.data))
      pc.addEventListener("connectionstatechange", () => {
        console.debug("Live voice connection:", pc.connectionState)
        if (pc.connectionState === "failed") this.#fail("The voice connection was lost.")
      })
      channel.addEventListener("close", () => console.debug("Live voice: data channel closed"))
      const offer = await pc.createOffer()
      await pc.setLocalDescription(offer)
      const response = await fetch(liveVoicePath(this.sessionId), {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sdp: offer.sdp }),
      })
      const text = await response.text()
      if (!response.ok) {
        let reason = `The Hub answered ${response.status}.`
        try {
          reason = (JSON.parse(text) as { error?: string }).error ?? reason
        } catch {}
        throw new Error(reason)
      }
      const answer = decodeAnswer(JSON.parse(text))
      this.#protocol = answer.protocol
      // Every SDP line ends with CRLF, the last too, or the browser drops it.
      const sdp = /\r?\n$/.test(answer.sdp) ? answer.sdp : `${answer.sdp}\r\n`
      await pc.setRemoteDescription({ type: "answer", sdp })
      // Follow the Session as the store has it: it is joined while its view is open.
      const observe = () => {
        const state = this.hub.getState()
        const summary = state.sessions?.find((session) => session.id === this.sessionId)
        const transcript = state.joined[this.sessionId]?.transcript
        if (summary === undefined || transcript === undefined) return
        this.#bridge.observe({
          summary,
          turns: transcript.items.flatMap((item) => (item.kind === "turn" ? [item.turn] : [])),
        })
      }
      this.#unsubscribe = this.hub.subscribe(observe)
      observe()
      this.#live()
    } catch (cause) {
      this.#fail(cause instanceof Error ? cause.message : String(cause))
    }
  }

  setMuted(muted: boolean) {
    this.#muted = muted
    for (const track of this.#mic?.getAudioTracks() ?? []) track.enabled = !muted
    this.#live()
  }

  stop() {
    if (this.#channel?.readyState === "open") {
      this.#channel.send(JSON.stringify({ type: "session.close", event_id: "kndl_close" }))
    }
    this.#unsubscribe?.()
    this.#channel?.close()
    this.#pc?.close()
    for (const track of this.#mic?.getTracks() ?? []) track.stop()
    if (this.#audio) this.#audio.srcObject = null
    this.onStatus({ phase: "off" })
  }

  #live() {
    this.onStatus({ phase: "live", speaking: this.#speaking, muted: this.#muted })
  }

  #fail(message: string) {
    this.stop()
    this.onStatus({ phase: "failed", message })
  }

  #send(event: VoiceEvent) {
    if (this.#channel?.readyState === "open") {
      this.#channel.send(JSON.stringify(wireEvent(this.#protocol, event)))
    }
  }

  #received(data: unknown) {
    if (typeof data !== "string") return
    // Which events come, for whoever debugs a call: their types alone, never what was said.
    console.debug("Live voice event:", /"type"\s*:\s*"([^"]+)"/.exec(data)?.[1] ?? "?")
    const event = heardEvent(this.#protocol, data)
    switch (event?.kind) {
      case "heard":
        return this.#bridge.heard(event.text)
      case "spoke":
        // The caption keeps the latest few hundred characters.
        this.#speaking = (this.#speaking + event.text).slice(-280)
        return this.#live()
      case "delegated":
        return this.#bridge.delegated(event.id, event.asked)
      case "closed":
        // Ended by GPT-Live, not by Hang up: say why.
        return this.#fail(
          `GPT-Live ended the call${event.reason === undefined ? "" : ` (${event.reason})`}.`,
        )
      case "error":
        console.warn("Live voice:", event.message)
        return
    }
  }
}

/** Live voice with the Session: its status, and how to start, stop and mute it. */
export function useLiveVoice(sessionId: SessionId) {
  const hub = useHub()
  const [status, setStatus] = useState<LiveVoiceStatus>({ phase: "off" })
  // A call that fails or is ended says why, where it can be read.
  useEffect(() => {
    if (status.phase === "failed") {
      toast.show({ title: "Live voice stopped", description: status.message, intent: "warning" })
    }
  }, [status])
  const call = useRef<LiveVoiceCall | undefined>(undefined)
  // Leaving the Session hangs up.
  useEffect(
    () => () => {
      call.current?.stop()
      call.current = undefined
    },
    [sessionId],
  )
  return {
    status,
    start: () => {
      call.current?.stop()
      const next = new LiveVoiceCall(hub, sessionId, setStatus)
      call.current = next
      void next.start()
    },
    stop: () => {
      call.current?.stop()
      call.current = undefined
    },
    setMuted: (muted: boolean) => call.current?.setMuted(muted),
  }
}
