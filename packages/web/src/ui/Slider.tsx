import { Slider as BaseSlider } from "@base-ui/react/slider"
import * as stylex from "@stylexjs/stylex"
import type { KeyboardEvent } from "react"
import { color, radius, shadow } from "./tokens.stylex.ts"

/** One stop on a {@link Slider}. */
export interface SliderStep<Value extends string> {
  value: Value
  /** Its name, which screen readers say for it. */
  label: string
}

export interface SliderProps<Value extends string> {
  /** The stops, in order, left to right. */
  steps: ReadonlyArray<SliderStep<Value>>
  /** The stop it shows; undefined shows none, with no thumb. */
  value: Value | undefined
  /** Each move, from a drag or an arrow key: for showing where it is. */
  onValueChange?: (value: Value) => void
  /** Where a drag or a click lets go, or Enter: for acting on. Arrow keys only move it. */
  onValueCommitted?: (value: Value) => void
  /** Its accessible name. */
  label: string
  /** What screen readers say for it while it shows no stop. */
  unsetLabel?: string
  disabled?: boolean
  sx?: stylex.StyleXStyles
}

/** The thumb's diameter; the track is as tall, so the thumb sits in it. */
const thumb = "1.25rem"

/**
 * Where the slider is while it shows no stop: between the first two, so a click on any stop,
 * the first included, is a change Base UI reports. The thumb isn't drawn there.
 */
const between = 0.5

/** The keys that move the thumb from no stop: End to the last, the others to the first. */
const moveKeys = new Set([
  "ArrowRight",
  "ArrowLeft",
  "ArrowUp",
  "ArrowDown",
  "Home",
  "End",
  "PageUp",
  "PageDown",
])

const styles = stylex.create({
  control: {
    display: "flex",
    alignItems: "center",
    width: "100%",
    paddingBlock: "0.125rem",
    touchAction: "none",
    cursor: { default: "pointer", "[data-disabled]": "not-allowed" },
    opacity: { default: 1, "[data-disabled]": 0.6 },
  },
  track: {
    position: "relative",
    width: "100%",
    height: thumb,
    borderRadius: radius.full,
    backgroundColor: color.surfaceActive,
    // The focused element is Base UI's visually hidden range input inside the thumb, so the
    // shared focus.ring, which rings the focused element itself, can't show: the ring goes on
    // the track, around the input, for keyboard focus only.
    outlineStyle: { default: "none", ":has(:focus-visible)": "solid" },
    outlineWidth: "2px",
    outlineColor: color.focus,
    outlineOffset: "2px",
  },
  indicator: {
    borderRadius: radius.full,
    backgroundColor: color.accent,
  },
  dot: {
    position: "absolute",
    top: "50%",
    width: "0.25rem",
    height: "0.25rem",
    marginInlineStart: "-0.125rem",
    marginTop: "-0.125rem",
    borderRadius: radius.full,
    backgroundColor: color.textSubtle,
    pointerEvents: "none",
  },
  dotFilled: {
    backgroundColor: color.onAccent,
    opacity: 0.6,
  },
  // With the thumb inset at the ends, its centre runs from half a thumb in to half a thumb short
  // of the end: the dots sit where it stops.
  dotAt: (fraction: number) => ({
    insetInlineStart: `calc(${thumb} / 2 + (100% - ${thumb}) * ${fraction})`,
  }),
  thumb: {
    width: thumb,
    height: thumb,
    borderRadius: radius.full,
    backgroundColor: color.surface,
    boxShadow: shadow.sm,
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: color.borderStrong,
  },
  hidden: {
    opacity: 0,
  },
})

/**
 * Picks one of a few ordered stops by sliding, as a thinking level: a dot marks each stop, and the
 * thumb snaps to them. A drag or a click commits where it lets go. Arrow keys, Home and End only
 * move the thumb, and Enter commits, so stepping through the stops doesn't act on each.
 */
export function Slider<Value extends string>({
  steps,
  value,
  onValueChange,
  onValueCommitted,
  label,
  unsetLabel = "None",
  disabled = false,
  sx,
}: SliderProps<Value>) {
  const last = Math.max(steps.length - 1, 1)
  const index = steps.findIndex((step) => step.value === value)
  const set = index >= 0
  const at = (next: number) => steps[Math.round(next)]?.value

  // On the thumb's input, where Base UI runs it before its own handler, on the same event: one
  // on the root, even capturing, gets an event of its own, and couldn't stop Base UI's.
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Enter" && value !== undefined && set) {
      event.preventDefault()
      onValueCommitted?.(value)
      return
    }
    // From no stop, Base UI would step from the point between the first two: go to an end.
    if (!set && moveKeys.has(event.key)) {
      // Base UI's handler leaves a key alone once it is handled.
      event.preventDefault()
      const next = steps[event.key === "End" ? steps.length - 1 : 0]?.value
      if (next !== undefined) onValueChange?.(next)
    }
  }

  return (
    <BaseSlider.Root
      value={set ? index : between}
      min={0}
      max={last}
      step={1}
      disabled={disabled}
      thumbAlignment="edge"
      onValueChange={(next: number) => {
        const step = at(next)
        if (step !== undefined) onValueChange?.(step)
      }}
      onValueCommitted={(next: number, details) => {
        // A key only moves it; Enter commits, above.
        if (details.reason === "keyboard") return
        const step = at(next)
        if (step !== undefined) onValueCommitted?.(step)
      }}
      {...stylex.props(sx)}
    >
      <BaseSlider.Control {...stylex.props(styles.control)}>
        <BaseSlider.Track {...stylex.props(styles.track)}>
          {set && <BaseSlider.Indicator {...stylex.props(styles.indicator)} />}
          {steps.map((step, i) => (
            <span
              key={step.value}
              aria-hidden
              {...stylex.props(
                styles.dot,
                styles.dotAt(i / last),
                set && i <= index && styles.dotFilled,
              )}
            />
          ))}
          <BaseSlider.Thumb
            aria-label={label}
            onKeyDown={onKeyDown}
            getAriaValueText={() => (set ? (steps[index]?.label ?? "") : unsetLabel)}
            {...stylex.props(styles.thumb, !set && styles.hidden)}
          />
        </BaseSlider.Track>
      </BaseSlider.Control>
    </BaseSlider.Root>
  )
}
