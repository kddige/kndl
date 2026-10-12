import { Slider as BaseSlider } from "@base-ui/react/slider"
import * as stylex from "@stylexjs/stylex"
import { color, motion, radius, shadow } from "./tokens.stylex.ts"

/** One stop on a {@link Slider}. */
export interface SliderStep<Value extends string> {
  value: Value
  /** Its name, which screen readers say for it. */
  label: string
}

export interface SliderProps<Value extends string> {
  /** The stops, in order, left to right. */
  steps: ReadonlyArray<SliderStep<Value>>
  value: Value
  /** Each move, while it is dragged too: for showing where it is. */
  onValueChange?: (value: Value) => void
  /** Where it was let go, or moved to with a key or a click: for acting on. */
  onValueCommitted?: (value: Value) => void
  /** Its accessible name. */
  label: string
  disabled?: boolean
  sx?: stylex.StyleXStyles
}

/** The thumb's diameter; the track is as tall, so the thumb sits in it. */
const thumb = "1.25rem"

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
  thumb: {
    width: thumb,
    height: thumb,
    borderRadius: radius.full,
    backgroundColor: color.surface,
    boxShadow: shadow.sm,
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: color.borderStrong,
    // The thumb holds the focused input: the ring goes on the thumb, for keyboard focus only.
    outlineStyle: { default: "none", ":has(:focus-visible)": "solid" },
    outlineWidth: "2px",
    outlineColor: color.focus,
    outlineOffset: "2px",
    transitionProperty: "box-shadow",
    transitionDuration: motion.durationFast,
  },
})

/**
 * Picks one of a few ordered stops by sliding, as an effort level: a dot marks each stop, and the
 * thumb snaps to them. Arrow keys step, Home and End go to the ends.
 */
export function Slider<Value extends string>({
  steps,
  value,
  onValueChange,
  onValueCommitted,
  label,
  disabled = false,
  sx,
}: SliderProps<Value>) {
  const last = Math.max(steps.length - 1, 1)
  const index = Math.max(
    steps.findIndex((step) => step.value === value),
    0,
  )
  const at = (next: number) => steps[Math.round(next)]?.value
  return (
    <BaseSlider.Root
      value={index}
      min={0}
      max={last}
      step={1}
      disabled={disabled}
      thumbAlignment="edge"
      onValueChange={(next: number) => {
        const step = at(next)
        if (step !== undefined) onValueChange?.(step)
      }}
      onValueCommitted={(next: number) => {
        const step = at(next)
        if (step !== undefined) onValueCommitted?.(step)
      }}
      {...stylex.props(sx)}
    >
      <BaseSlider.Control {...stylex.props(styles.control)}>
        <BaseSlider.Track {...stylex.props(styles.track)}>
          <BaseSlider.Indicator {...stylex.props(styles.indicator)} />
          {steps.map((step, i) => (
            <span
              key={step.value}
              aria-hidden
              // With the thumb inset at the ends, its centre runs from half a thumb in to half a
              // thumb short of the end: the dots sit where it stops.
              {...stylex.props(styles.dot, i <= index && styles.dotFilled)}
              style={{ left: `calc(${thumb} / 2 + (100% - ${thumb}) * ${i / last})` }}
            />
          ))}
          <BaseSlider.Thumb
            aria-label={label}
            getAriaValueText={(_formatted: string, next: number) =>
              steps[Math.round(next)]?.label ?? ""
            }
            {...stylex.props(styles.thumb)}
          />
        </BaseSlider.Track>
      </BaseSlider.Control>
    </BaseSlider.Root>
  )
}
