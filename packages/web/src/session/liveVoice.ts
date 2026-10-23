// Live voice in the browser (ADR 0033): the microphone and GPT-Live's voice over WebRTC, its
// `oai-events` data channel, and the VoiceBridge that turns what is said into the Session's
// prompts. The Hub only starts it (`POST /sessions/<id>/voice`), with the Creator's own OpenAI
// connection: audio and events then go between the browser and OpenAI.

import { LiveVoiceAnswer, liveVoicePath, type SessionId } from "@kndl/protocol"
import { Schema } from "effect"
import { useEffect, useRef, useState } from "react"
import { useHub } from "../app/hub.tsx"
import type { HubClient } from "../hub/client.ts"
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

/** One live voice conversation with a Session, from `start` until `stop`. */
class LiveVoiceCall {
  #pc: RTCPeerConnection | undefined
  #channel: RTCDataChannel | undefined
  #mic: MediaStream | undefined
  #audio: HTMLAudioElement | undefined
  #unsubscribe: (() => void) | undefined
  #speaking = ""
  #muted = false
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
        if (pc.connectionState === "failed") this.#fail("The voice connection was lost.")
      })
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
      await pc.setRemoteDescription({ type: "answer", sdp: answer.sdp })
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
    if (this.#channel?.readyState === "open") this.#channel.send(JSON.stringify(event))
  }

  #received(data: unknown) {
    if (typeof data !== "string") return
    let event: { type?: string; [key: string]: unknown }
    try {
      event = JSON.parse(data) as typeof event
    } catch {
      return
    }
    switch (event.type) {
      case "session.input_transcript.delta":
        if (typeof event["delta"] === "string") this.#bridge.heard(event["delta"])
        return
      case "session.output_transcript.delta":
        if (typeof event["delta"] === "string") {
          // The caption keeps the latest few hundred characters.
          this.#speaking = (this.#speaking + event["delta"]).slice(-280)
          this.#live()
        }
        return
      case "session.delegation.created": {
        const delegation = event["delegation"] as { id?: unknown; target?: unknown } | undefined
        if (typeof delegation?.id === "string" && delegation.target === "client") {
          this.#bridge.delegated(delegation.id)
        }
        return
      }
      case "session.closed":
        this.stop()
        return
      case "error": {
        const error = event["error"] as { message?: unknown } | undefined
        console.warn("Live voice:", error?.message ?? event)
        return
      }
    }
  }
}

/** Live voice with the Session: its status, and how to start, stop and mute it. */
export function useLiveVoice(sessionId: SessionId) {
  const hub = useHub()
  const [status, setStatus] = useState<LiveVoiceStatus>({ phase: "off" })
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
