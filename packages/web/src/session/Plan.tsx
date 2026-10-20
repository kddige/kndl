// The Plan (docs/design/durable-harness.md): the checklist the agent keeps with its `update_plan`
// tool, per conversation. The main loop's is docked over the composer, a thread's in its panel,
// each live: the step in progress stands out, and a step's state changes as it moves. Where the
// agent changed it, the Turn marks it, and what changed is a click away.

import type { Plan, PlanStep, PlanStepStatus } from "@kndl/protocol"
import * as stylex from "@stylexjs/stylex"
import { useId, useState } from "react"
import { counted } from "../app/format.ts"
import { CircleCheckIcon, CircleIcon, Disclosure, PlanIcon } from "../ui/index.ts"
import { focus, srOnly } from "../ui/shared.ts"
import { color, leading, motion, radius, space, text, weight } from "../ui/tokens.stylex.ts"

const HOVER = "@media (hover: hover)"
const MOTION_OK = "@media (prefers-reduced-motion: no-preference)"

/** How far along a Plan is: steps done of all, and the one in progress, or else the next. */
export function planProgress(plan: Plan): {
  readonly done: number
  readonly total: number
  readonly current: PlanStep | undefined
} {
  const done = plan.steps.filter((step) => step.status === "done").length
  const current =
    plan.steps.find((step) => step.status === "in_progress") ??
    plan.steps.find((step) => step.status === "pending")
  return { done, total: plan.steps.length, current }
}

/** What changed from one Plan to the next, for its marker: the steps finished, started and added. */
export function planChanges(
  plan: Plan,
  previous: Plan | undefined,
): {
  readonly finished: ReadonlyArray<string>
  readonly started: ReadonlyArray<string>
  readonly added: ReadonlyArray<string>
} {
  const before = new Map(previous?.steps.map((step) => [step.text, step.status]))
  const finished: Array<string> = []
  const started: Array<string> = []
  const added: Array<string> = []
  for (const step of plan.steps) {
    const was = before.get(step.text)
    if (previous !== undefined && was === undefined) added.push(step.text)
    else if (step.status === "done" && was !== "done") finished.push(step.text)
    else if (step.status === "in_progress" && was !== "in_progress") started.push(step.text)
  }
  return { finished, started, added }
}

/** One line on what a change did, for the Turn's marker. */
export function planChangeText(plan: Plan, previous: Plan | undefined): string {
  const { finished, started, added } = planChanges(plan, previous)
  if (plan.steps.length === 0) return "Cleared the plan"
  // A plan mostly of steps the last one didn't have is a new one.
  if (previous === undefined || added.length * 2 > plan.steps.length)
    return `Made a plan of ${counted(plan.steps.length, { one: "step", other: "steps" })}`
  if (finished.length > 0 && started.length > 0)
    return `Finished “${finished.at(-1)}”, started “${started[0]}”`
  if (finished.length > 0) return `Finished “${finished.at(-1)}”`
  if (started.length > 0) return `Started “${started[0]}”`
  if (added.length > 0)
    return `Added “${added[0]}”${added.length > 1 ? ` and ${added.length - 1} more` : ""}`
  return "Updated the plan"
}

const statusWords: Record<PlanStepStatus, string> = {
  done: "Done",
  in_progress: "In progress",
  pending: "Not started",
}

const pop = stylex.keyframes({
  from: { opacity: 0, transform: "scale(0.25)", filter: "blur(4px)" },
  to: { opacity: 1, transform: "scale(1)", filter: "blur(0)" },
})

const fade = stylex.keyframes({ from: { opacity: 0 }, to: { opacity: 1 } })

const breathe = stylex.keyframes({
  "0%": { transform: "scale(0.7)", opacity: 0.7 },
  "50%": { transform: "scale(1)", opacity: 1 },
  "100%": { transform: "scale(0.7)", opacity: 0.7 },
})

const styles = stylex.create({
  dock: {
    display: "flex",
    flexDirection: "column",
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: color.border,
    borderRadius: radius.lg,
    backgroundColor: color.surface,
    overflow: "hidden",
  },
  header: {
    display: "flex",
    alignItems: "center",
    gap: space.s2,
    width: "100%",
    minHeight: "2.25rem",
    paddingInline: space.s3,
    borderWidth: 0,
    backgroundColor: {
      default: "transparent",
      ":hover": { default: null, [HOVER]: color.surfaceHover },
    },
    color: color.text,
    fontFamily: "inherit",
    fontSize: text.base,
    textAlign: "start",
    cursor: "pointer",
    transitionProperty: "background-color",
    transitionDuration: motion.durationFast,
  },
  icon: { flexShrink: 0, color: color.accentText },
  title: { fontWeight: weight.semibold, flexShrink: 0 },
  count: {
    flexShrink: 0,
    color: color.textSecondary,
    fontSize: text.sm,
    fontVariantNumeric: "tabular-nums",
  },
  // A thin bar, so how far along it is reads at a glance.
  track: {
    position: "relative",
    flexShrink: 0,
    width: "3rem",
    height: "4px",
    borderRadius: radius.full,
    backgroundColor: color.surfaceActive,
    overflow: "hidden",
  },
  fill: {
    position: "absolute",
    inset: 0,
    borderRadius: radius.full,
    backgroundColor: color.success,
    transformOrigin: { default: "left center", ":dir(rtl)": "right center" },
    transitionProperty: "transform",
    transitionDuration: motion.durationSlow,
    transitionTimingFunction: motion.easeOut,
  },
  progress: (share: number) => ({ transform: `scaleX(${share})` }),
  // Closed, the step it's on is the one line that matters.
  now: {
    flex: 1,
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    color: color.textSecondary,
  },
  grow: { flex: 1 },
  chevron: {
    flexShrink: 0,
    color: color.textTertiary,
    transitionProperty: "transform",
    transitionDuration: motion.durationMove,
    transitionTimingFunction: motion.easeStandard,
  },
  chevronOpen: { transform: "rotate(180deg)" },
  body: {
    display: "flex",
    flexDirection: "column",
    gap: space.s2,
    paddingInline: space.s2,
    paddingBottom: space.s2,
    // Long Plans scroll inside the dock rather than pushing the composer off screen.
    maxHeight: "min(16rem, 35vh)",
    overflowY: "auto",
    overscrollBehavior: "contain",
  },
  explanation: {
    margin: 0,
    paddingInline: space.s2,
    color: color.textSecondary,
    fontSize: text.sm,
    lineHeight: leading.snug,
  },
  steps: {
    display: "flex",
    flexDirection: "column",
    gap: space.s0_5,
    margin: 0,
    padding: 0,
    listStyle: "none",
  },
  step: {
    display: "flex",
    alignItems: "flex-start",
    gap: space.s2,
    paddingBlock: space.s1,
    paddingInline: space.s2,
    borderRadius: radius.md,
    lineHeight: leading.snug,
    transitionProperty: "background-color, color",
    transitionDuration: motion.durationNormal,
    transitionTimingFunction: motion.easeOut,
  },
  stepDone: { color: color.textSecondary },
  stepNow: { backgroundColor: color.accentTint, color: color.text, fontWeight: weight.medium },
  stepPending: { color: color.textSecondary },
  stepIcon: {
    display: "inline-grid",
    placeItems: "center",
    flexShrink: 0,
    width: "1rem",
    height: "1.25em",
    animationName: { default: fade, [MOTION_OK]: pop },
    animationDuration: "300ms",
    animationTimingFunction: "cubic-bezier(0.2, 0, 0, 1)",
    animationFillMode: "both",
  },
  doneIcon: { color: color.successText },
  pendingIcon: { color: color.textTertiary },
  // The step in progress: a ring with a dot that breathes while the agent works on it.
  nowRing: {
    position: "relative",
    display: "inline-grid",
    placeItems: "center",
    width: "0.875rem",
    height: "0.875rem",
    borderRadius: radius.full,
    borderWidth: "1.5px",
    borderStyle: "solid",
    borderColor: color.accentText,
  },
  nowDot: {
    width: "0.375rem",
    height: "0.375rem",
    borderRadius: radius.full,
    backgroundColor: color.accentText,
  },
  nowDotLive: {
    animationName: { default: "none", [MOTION_OK]: breathe },
    animationDuration: "1.6s",
    animationTimingFunction: "ease-in-out",
    animationIterationCount: "infinite",
  },
  stepText: { minWidth: 0, overflowWrap: "anywhere" },
  added: {
    flexShrink: 0,
    marginInlineStart: "auto",
    color: color.accentText,
    fontSize: text.xs,
    fontWeight: weight.medium,
  },
  marker: { color: color.textSecondary, fontSize: text.sm },
  markerSummary: {
    display: "inline-flex",
    alignItems: "center",
    gap: space.s1_5,
    minWidth: 0,
  },
  markerText: { minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  markerBody: { paddingBlock: space.s1, paddingInlineStart: space.s4 },
})

/** A step's status, as an icon that changes as the step does, with the status for screen readers. */
function StepIcon({ status, live }: { status: PlanStepStatus; live: boolean }) {
  return (
    // Keyed by status, so a step that moves on shows its new state arriving.
    <span key={status} {...stylex.props(styles.stepIcon)}>
      {status === "done" ? (
        <CircleCheckIcon {...stylex.props(styles.doneIcon)} />
      ) : status === "in_progress" ? (
        <span {...stylex.props(styles.nowRing)}>
          <span {...stylex.props(styles.nowDot, live && styles.nowDotLive)} />
        </span>
      ) : (
        <CircleIcon {...stylex.props(styles.pendingIcon)} />
      )}
      <span {...stylex.props(srOnly.root)}>{statusWords[status]}: </span>
    </span>
  )
}

/** A Plan's steps, the one in progress standing out; with `previous`, the steps it added marked. */
export function PlanSteps({
  plan,
  previous,
  live = true,
}: {
  plan: Plan
  previous?: Plan | undefined
  /** Whether the agent works on it now, so the step in progress shows it moving. */
  live?: boolean
}) {
  const known = previous && new Set(previous.steps.map((step) => step.text))
  // Steps are known by their text, so a step keeps its row as others come and go; one renamed is
  // a new step. Two of the same text are told apart by which of them it is.
  const seen = new Map<string, number>()
  const keys = plan.steps.map((step) => {
    const nth = (seen.get(step.text) ?? 0) + 1
    seen.set(step.text, nth)
    return nth === 1 ? step.text : `${step.text} (${nth})`
  })
  return (
    <ol {...stylex.props(styles.steps)}>
      {plan.steps.map((step, index) => (
        <li
          key={keys[index]}
          {...stylex.props(
            styles.step,
            step.status === "done" && styles.stepDone,
            step.status === "in_progress" && styles.stepNow,
            step.status === "pending" && styles.stepPending,
          )}
          {...(step.status === "in_progress" && { "aria-current": "step" as const })}
        >
          <StepIcon status={step.status} live={live} />
          <span {...stylex.props(styles.stepText)}>{step.text}</span>
          {known !== undefined && !known.has(step.text) && (
            <span {...stylex.props(styles.added)}>New</span>
          )}
        </li>
      ))}
    </ol>
  )
}

/**
 * A conversation's Plan, docked: one line with how far along it is and the step it's on, that
 * opens into the checklist. Its open state is the viewer's; a change of step is announced.
 */
export function PlanDock({
  plan,
  live,
  defaultOpen = false,
  label = "Plan",
}: {
  plan: Plan
  /** Whether the conversation runs now. */
  live: boolean
  defaultOpen?: boolean
  label?: string
}) {
  const [open, setOpen] = useState(defaultOpen)
  const id = useId()
  const { done, total, current } = planProgress(plan)
  if (total === 0) return null
  const finished = done === total
  return (
    <section aria-label={label} {...stylex.props(styles.dock)}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen(!open)}
        {...stylex.props(styles.header, focus.ringInset)}
      >
        <PlanIcon {...stylex.props(styles.icon)} />
        <span {...stylex.props(styles.title)}>{label}</span>
        <span {...stylex.props(styles.count)}>
          {finished ? `All ${total} done` : `${done} of ${total}`}
        </span>
        <span aria-hidden="true" {...stylex.props(styles.track)}>
          <span {...stylex.props(styles.fill, styles.progress(done / total))} />
        </span>
        {!open && current !== undefined && !finished ? (
          <span {...stylex.props(styles.now)} title={current.text}>
            {current.text}
          </span>
        ) : (
          <span {...stylex.props(styles.grow)} />
        )}
        <ChevronUp open={open} />
      </button>
      {/* The step it's on, said once it changes, wherever focus is. */}
      <span role="status" {...stylex.props(srOnly.root)}>
        {current !== undefined && !finished
          ? `${label}: step ${plan.steps.indexOf(current) + 1} of ${total}, ${current.text}`
          : ""}
      </span>
      {open && (
        <div id={id} {...stylex.props(styles.body)}>
          {plan.explanation !== undefined && (
            <p {...stylex.props(styles.explanation)}>{plan.explanation}</p>
          )}
          <PlanSteps plan={plan} live={live} />
        </div>
      )}
    </section>
  )
}

function ChevronUp({ open }: { open: boolean }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...stylex.props(styles.chevron, open && styles.chevronOpen)}
    >
      <path d="m4.5 9.5 3.5-3.5 3.5 3.5" />
    </svg>
  )
}

/**
 * Where the agent changed its Plan in a Turn, in place of its `update_plan` call: what changed in
 * one line, and the Plan as it was then, with the steps it added, a click away.
 */
export function PlanMarker({ plan, previous }: { plan: Plan; previous?: Plan | undefined }) {
  const { done, total } = planProgress(plan)
  return (
    <Disclosure
      variant="plain"
      sx={styles.marker}
      summary={
        <span {...stylex.props(styles.markerSummary)}>
          <PlanIcon {...stylex.props(styles.icon)} />
          <span {...stylex.props(styles.markerText)}>{planChangeText(plan, previous)}</span>
          {total > 0 && (
            <span {...stylex.props(styles.count)}>
              · {done} of {total}
            </span>
          )}
        </span>
      }
    >
      <div {...stylex.props(styles.markerBody)}>
        {plan.explanation !== undefined && (
          <p {...stylex.props(styles.explanation)}>{plan.explanation}</p>
        )}
        <PlanSteps plan={plan} previous={previous} live={false} />
      </div>
    </Disclosure>
  )
}
