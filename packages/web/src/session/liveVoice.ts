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
import { useCallback, useEffect, useRef, useState } from "react"
import { useHub } from "../app/hub.tsx"
import type { HubClient } from "../hub/client.ts"
import { toast } from "../ui/index.ts"
import { VoiceBridge, type VoiceEvent } from "./voiceBridge.ts"
import { appendsOf, heardEvent, wireEvent } from "./voiceProtocol.ts"

export type LiveVoiceStatus =
  | { readonly phase: "off" }
  | { readonly phase: "connecting" }
  | {
      readonly phase: "live"
      /** What GPT-Live is saying now, the latest of it. */
      readonly speaking: string
      readonly muted: boolean
      /** When the call connected, for its timer. */
      readonly since: number
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
  #since = 0
  #protocol: LiveVoiceProtocol = "Live"
  /** Both sides of the call, mixed for the call bar's bars: never played, only measured. */
  #sound: AudioContext | undefined
  #analyser: AnalyserNode | undefined
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
      // What is said, by either side, is measured for the call bar.
      const sound = new AudioContext()
      const analyser = sound.createAnalyser()
      analyser.fftSize = 256
      analyser.smoothingTimeConstant = 0.7
      this.#sound = sound
      this.#analyser = analyser
      sound.createMediaStreamSource(this.#mic).connect(analyser)
      pc.ontrack = (event) => {
        const stream = event.streams[0]
        audio.srcObject = stream ?? null
        // Chrome feeds a remote stream to Web Audio only while it also plays in an element.
        if (stream !== undefined) sound.createMediaStreamSource(stream).connect(analyser)
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
        const joined = state.joined[this.sessionId]
        if (summary === undefined || joined === undefined) return
        this.#bridge.observe({
          summary,
          turns: joined.transcript.items.flatMap((item) =>
            item.kind === "turn" ? [item.turn] : [],
          ),
          queue: joined.queue,
        })
      }
      this.#unsubscribe = this.hub.subscribe(observe)
      observe()
      this.#since = Date.now()
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
    void this.#sound?.close().catch(() => undefined)
    this.#sound = undefined
    this.#analyser = undefined
    this.onStatus({ phase: "off" })
  }

  /**
   * How loud the call is now, across `into`'s length, from the lowest pitches up, each 0 to 255;
   * false while there is nothing to measure.
   */
  levels(into: Uint8Array<ArrayBuffer>): boolean {
    if (this.#analyser === undefined) return false
    this.#analyser.getByteFrequencyData(into)
    return true
  }

  #live() {
    this.onStatus({
      phase: "live",
      speaking: this.#speaking,
      muted: this.#muted,
      since: this.#since,
    })
  }

  #fail(message: string) {
    this.stop()
    this.onStatus({ phase: "failed", message })
  }

  #send(event: VoiceEvent) {
    const channel = this.#channel
    if (channel?.readyState !== "open") return
    // GPT-Live refuses an append over 500 bytes: the agent's answer goes in pieces.
    for (const piece of appendsOf(event)) {
      channel.send(JSON.stringify(wireEvent(this.#protocol, piece)))
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

/** What `useLiveVoice` gives: the call's status, and its controls. */
export type LiveVoice = ReturnType<typeof useLiveVoice>

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
  const levels = useCallback(
    (into: Uint8Array<ArrayBuffer>) => call.current?.levels(into) ?? false,
    [],
  )
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
    /** How loud the call is now, for the call bar: as the call's `levels`. The same each render. */
    levels,
  }
}
