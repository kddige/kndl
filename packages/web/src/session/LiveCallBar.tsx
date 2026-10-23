// The live call's bar (ADR 0033): floating over the Composer while a live voice call is up, so the
// call is never out of sight. It says the call is live and for how long, shows bars that move with
// what either side says, what the voice says, and what it last really handed to the Session, and
// holds the call's controls: the voice's settings, mute and hang up.

import * as stylex from "@stylexjs/stylex"
import { useNavigate } from "@tanstack/react-router"
import { useEffect, useRef, useState } from "react"
import {
  IconButton,
  MicIcon,
  MicOffIcon,
  PhoneDownIcon,
  SettingsIcon,
  Spinner,
} from "../ui/index.ts"
import { color, font, radius, shadow, space, text } from "../ui/tokens.stylex.ts"
import type { LiveVoiceStatus } from "./liveVoice.ts"

const REDUCED = "@media (prefers-reduced-motion: reduce)"
const HOVER = "@media (hover: hover)"

/** How many bars: half of them, mirrored about the middle. */
const HALF = 12
/** The quietest a bar is drawn, as a part of its height, so the row reads as bars at rest. */
const REST = 0.12

const pulse = stylex.keyframes({
  "0%": { opacity: 1 },
  "50%": { opacity: 0.35 },
  "100%": { opacity: 1 },
})

const styles = stylex.create({
  bar: {
    display: "flex",
    flexDirection: "column",
    gap: space.s1,
    marginBottom: space.s2,
    paddingBlock: space.s2,
    paddingInlineStart: space.s3,
    paddingInlineEnd: space.s2,
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: color.border,
    borderRadius: radius.lg,
    backgroundColor: color.surface,
    boxShadow: shadow.md,
  },
  row: { display: "flex", alignItems: "center", gap: space.s3, minWidth: 0 },
  state: {
    display: "flex",
    alignItems: "center",
    gap: space.s2,
    flexShrink: 0,
    fontSize: text.sm,
    fontWeight: 500,
    color: color.text,
  },
  dot: (live: boolean) => ({
    width: "0.5rem",
    height: "0.5rem",
    borderRadius: radius.full,
    backgroundColor: live ? color.success : color.warning,
    animationName: { default: pulse, [REDUCED]: "none" },
    animationDuration: "1.6s",
    animationIterationCount: "infinite",
  }),
  timer: {
    fontFamily: font.mono,
    fontSize: text.xs,
    fontVariantNumeric: "tabular-nums",
    color: color.textSecondary,
  },
  waves: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: "3px",
    flexGrow: 1,
    minWidth: 0,
    height: "1.5rem",
    overflow: "hidden",
  },
  wave: (muted: boolean) => ({
    flexShrink: 0,
    width: "3px",
    height: "100%",
    borderRadius: radius.full,
    backgroundColor: muted ? color.textTertiary : color.text,
    transformOrigin: "center",
    transform: `scaleY(${REST})`,
    transitionProperty: { default: "transform", [REDUCED]: "none" },
    transitionDuration: "60ms",
  }),
  controls: { display: "flex", alignItems: "center", gap: space.s1, flexShrink: 0 },
  hangUp: {
    display: "inline-grid",
    placeItems: "center",
    width: "2rem",
    height: "2rem",
    borderWidth: 0,
    borderRadius: radius.full,
    backgroundColor: {
      default: color.danger,
      ":hover": { default: null, [HOVER]: color.dangerHover },
    },
    color: color.onDanger,
    cursor: "pointer",
    outlineOffset: "2px",
    ":focus-visible": { outlineWidth: "2px", outlineStyle: "solid", outlineColor: color.focus },
  },
  handedOff: {
    minWidth: 0,
    overflow: "hidden",
    whiteSpace: "nowrap",
    textOverflow: "ellipsis",
    color: color.textSecondary,
    fontSize: text.xs,
  },
  handedOffLabel: { fontWeight: 500, color: color.text },
  caption: {
    minWidth: 0,
    overflow: "hidden",
    whiteSpace: "nowrap",
    textOverflow: "ellipsis",
    // The newest words stay in view: they are at the start of a right-to-left line.
    direction: "rtl",
    textAlign: "start",
    color: color.textSecondary,
    fontSize: text.xs,
  },
})

/** `mm:ss` since `since`. */
const elapsed = (since: number, now: number) => {
  const seconds = Math.max(0, Math.floor((now - since) / 1000))
  return `${Math.floor(seconds / 60)
    .toString()
    .padStart(2, "0")}:${(seconds % 60).toString().padStart(2, "0")}`
}

/**
 * Bars that move with the call's sound: the lower pitches, where speech is, in the middle, mirrored
 * out to both ends. Drawn straight onto the bars each frame, not through React; still under reduced
 * motion.
 */
function Waves({
  levels,
  muted,
}: {
  levels: (into: Uint8Array<ArrayBuffer>) => boolean
  muted: boolean
}) {
  const bars = useRef<Array<HTMLSpanElement | null>>([])
  useEffect(() => {
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return
    // fftSize 256 at 48 kHz: bins of about 190 Hz, so the first dozen hold most of a voice.
    const bins = new Uint8Array(128)
    let frame = 0
    const draw = () => {
      frame = requestAnimationFrame(draw)
      if (!levels(bins)) return
      for (let i = 0; i < HALF; i++) {
        const level = REST + (1 - REST) * ((bins[i + 1] ?? 0) / 255) ** 1.5
        const scale = `scaleY(${level.toFixed(3)})`
        const left = bars.current[HALF - 1 - i]
        const right = bars.current[HALF + i]
        if (left) left.style.transform = scale
        if (right) right.style.transform = scale
      }
    }
    frame = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(frame)
  }, [levels])
  return (
    <span aria-hidden {...stylex.props(styles.waves)}>
      {Array.from({ length: HALF * 2 }, (_, i) => (
        <span
          key={i}
          ref={(bar) => {
            bars.current[i] = bar
          }}
          {...stylex.props(styles.wave(muted))}
        />
      ))}
    </span>
  )
}

export function LiveCallBar({
  status,
  levels,
  onMute,
  onHangUp,
}: {
  status: Extract<LiveVoiceStatus, { phase: "connecting" | "live" }>
  levels: (into: Uint8Array<ArrayBuffer>) => boolean
  onMute: (muted: boolean) => void
  onHangUp: () => void
}) {
  const navigate = useNavigate()
  const live = status.phase === "live"
  // The timer ticks once a second.
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!live) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [live])

  return (
    <section aria-label="Live voice call" {...stylex.props(styles.bar)}>
      <div {...stylex.props(styles.row)}>
        <span {...stylex.props(styles.state)}>
          <span {...stylex.props(styles.dot(live))} />
          {live ? (
            <>
              Live
              <span {...stylex.props(styles.timer)}>{elapsed(status.since, now)}</span>
            </>
          ) : (
            <>
              Connecting
              <Spinner size="sm" />
            </>
          )}
        </span>
        <Waves levels={levels} muted={live && status.muted} />
        <span {...stylex.props(styles.controls)}>
          <IconButton
            label="Live voice settings"
            size="sm"
            onClick={() => void navigate({ to: "/account" })}
          >
            <SettingsIcon />
          </IconButton>
          {live && (
            <IconButton
              label={status.muted ? "Unmute" : "Mute"}
              size="sm"
              intent={status.muted ? "secondary" : "ghost"}
              aria-pressed={status.muted}
              onClick={() => onMute(!status.muted)}
            >
              {status.muted ? <MicOffIcon /> : <MicIcon />}
            </IconButton>
          )}
          <button
            type="button"
            aria-label="Hang up"
            title="Hang up"
            onClick={onHangUp}
            {...stylex.props(styles.hangUp)}
          >
            <PhoneDownIcon />
          </button>
        </span>
      </div>
      {live && status.speaking !== "" && (
        <p aria-live="polite" title={status.speaking} {...stylex.props(styles.caption)}>
          <bdi>{status.speaking}</bdi>
        </p>
      )}
      {/* What really went to the Session: a hand-off the voice claims, and this lacks, didn't happen. */}
      {live && status.handedOff !== undefined && (
        <p title={status.handedOff.text} {...stylex.props(styles.handedOff)}>
          <span {...stylex.props(styles.handedOffLabel)}>
            {status.handedOff.reply ? "Answered the agent:" : "Sent to the agent:"}
          </span>{" "}
          <bdi>{status.handedOff.text}</bdi>
        </p>
      )}
    </section>
  )
}
