// Compaction (docs/design/durable-harness.md): the agent summarizes a conversation's older
// messages so it keeps fitting its model's context. Each shows as a slim divider where it happened,
// live while it runs, and anyone can ask for one, with what to keep.

import type { ThreadId } from "@kndl/protocol"
import * as stylex from "@stylexjs/stylex"
import { useId, useState } from "react"
import { clock } from "../app/format.ts"
import type { CompactionView } from "../hub/transcript.ts"
import {
  Button,
  CompactIcon,
  Dialog,
  DialogClose,
  Field,
  Textarea,
  WarningIcon,
} from "../ui/index.ts"
import { focus } from "../ui/shared.ts"
import { color, leading, motion, radius, space, text, weight } from "../ui/tokens.stylex.ts"

const MOTION_OK = "@media (prefers-reduced-motion: no-preference)"
const HOVER = "@media (hover: hover)"

const shimmer = stylex.keyframes({
  from: { backgroundPosition: "100% 0" },
  to: { backgroundPosition: "-100% 0" },
})

const styles = stylex.create({
  root: { display: "flex", flexDirection: "column", gap: space.s2 },
  line: {
    display: "flex",
    alignItems: "center",
    gap: space.s3,
    color: color.textSecondary,
    fontSize: text.sm,
  },
  rule: { flex: 1, height: "1px", minWidth: space.s4, backgroundColor: color.separator },
  label: {
    display: "inline-flex",
    alignItems: "center",
    flexWrap: "wrap",
    justifyContent: "center",
    gap: space.s1_5,
    minWidth: 0,
    textAlign: "center",
  },
  icon: { flexShrink: 0, color: color.textTertiary },
  failed: { color: color.dangerText },
  // While it runs, the words shimmer, where motion is welcome; otherwise they stay as they are.
  running: {
    color: color.textSecondary,
    backgroundImage: {
      default: "none",
      [MOTION_OK]: `linear-gradient(90deg, ${color.textSecondary} 0%, ${color.textSecondary} 40%, ${color.text} 50%, ${color.textSecondary} 60%, ${color.textSecondary} 100%)`,
    },
    backgroundSize: "200% 100%",
    backgroundClip: { default: "border-box", [MOTION_OK]: "text" },
    WebkitBackgroundClip: { default: "border-box", [MOTION_OK]: "text" },
    WebkitTextFillColor: { default: "currentColor", [MOTION_OK]: "transparent" },
    animationName: { default: "none", [MOTION_OK]: shimmer },
    animationDuration: "1.8s",
    animationTimingFunction: "linear",
    animationIterationCount: "infinite",
  },
  meta: { color: color.textTertiary, fontVariantNumeric: "tabular-nums" },
  toggle: {
    paddingBlock: 0,
    paddingInline: space.s1,
    borderWidth: 0,
    borderRadius: radius.sm,
    backgroundColor: {
      default: "transparent",
      ":hover": { default: null, [HOVER]: color.surfaceHover },
    },
    color: color.accentText,
    fontFamily: "inherit",
    fontSize: text.sm,
    fontWeight: weight.medium,
    cursor: "pointer",
    transitionProperty: "background-color",
    transitionDuration: motion.durationFast,
  },
  summary: {
    margin: 0,
    marginInline: "auto",
    width: "100%",
    maxWidth: "36rem",
    maxHeight: "16rem",
    overflowY: "auto",
    overscrollBehavior: "contain",
    paddingBlock: space.s2,
    paddingInline: space.s3,
    borderRadius: radius.md,
    backgroundColor: color.surfaceMuted,
    color: color.textSecondary,
    fontSize: text.sm,
    lineHeight: leading.normal,
    whiteSpace: "pre-wrap",
    overflowWrap: "anywhere",
  },
  form: { display: "flex", flexDirection: "column", gap: space.s3 },
})

/** Why it started, as a few words after what it does. */
function why(compaction: CompactionView): string | undefined {
  if (compaction.by !== undefined) return `asked by ${compaction.by.name}`
  switch (compaction.reason) {
    case "threshold":
      return "the context was getting full"
    case "overflow":
      return "the context was full"
    case "manual":
      return undefined
  }
}

/**
 * A compaction, where it happened: a divider saying it's summarizing, then that it did, with the
 * summary the model reads from now on a click away; that there was nothing to summarize; or that
 * it failed, and why.
 */
export function CompactionLine({ compaction }: { compaction: CompactionView }) {
  const [open, setOpen] = useState(false)
  const id = useId()
  const end = compaction.end
  const reason = why(compaction)
  const words =
    end === undefined
      ? "Summarizing earlier messages…"
      : end.outcome === "compacted"
        ? "Earlier messages summarized"
        : end.outcome === "skipped"
          ? "Nothing to summarize yet"
          : "Couldn't summarize earlier messages"
  return (
    <div role="note" {...stylex.props(styles.root)}>
      <div {...stylex.props(styles.line)}>
        <span aria-hidden="true" {...stylex.props(styles.rule)} />
        <span {...stylex.props(styles.label)}>
          {end?.outcome === "failed" ? (
            <WarningIcon {...stylex.props(styles.icon, styles.failed)} />
          ) : (
            <CompactIcon {...stylex.props(styles.icon)} />
          )}
          <span
            {...stylex.props(
              end === undefined && styles.running,
              end?.outcome === "failed" && styles.failed,
            )}
          >
            {words}
            {end?.outcome === "failed" && end.error !== undefined && `: ${end.error}`}
          </span>
          {reason !== undefined && (
            <span {...stylex.props(styles.meta)}>
              <span aria-hidden="true">· </span>
              {reason}
            </span>
          )}
          <time
            {...stylex.props(styles.meta)}
            dateTime={new Date(compaction.at).toISOString()}
          >
            <span aria-hidden="true">· </span>
            {clock(compaction.at)}
          </time>
          {end?.outcome === "compacted" && end.summary !== undefined && (
            <button
              type="button"
              aria-expanded={open}
              aria-controls={id}
              onClick={() => setOpen(!open)}
              {...stylex.props(styles.toggle, focus.ring)}
            >
              {open ? "Hide summary" : "Show summary"}
            </button>
          )}
        </span>
        <span aria-hidden="true" {...stylex.props(styles.rule)} />
      </div>
      {open && end?.summary !== undefined && (
        <p id={id} {...stylex.props(styles.summary)}>
          {end.summary}
        </p>
      )}
    </div>
  )
}

/**
 * Asks the agent to summarize a conversation's older messages now: the main loop's, or a
 * thread's. What to keep is optional.
 */
export function CompactDialog({
  open,
  onOpenChange,
  thread,
  onCompact,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The thread's, when it is a thread's; else the main conversation's. */
  thread?: { readonly threadId: ThreadId; readonly title: string } | undefined
  /** Sends it; false when it couldn't be, so the dialog stays open with what was typed. */
  onCompact: (instructions: string) => boolean
}) {
  const [instructions, setInstructions] = useState("")
  const formId = useId()
  return (
    <Dialog
      size="sm"
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next)
        if (!next) setInstructions("")
      }}
      title={thread ? "Compact this thread" : "Compact the conversation"}
      description={`The agent summarizes the older messages ${thread ? "of this thread" : "of the main conversation"}, so it keeps fitting its model's context. It keeps working meanwhile, and everyone here sees the summary.`}
      footer={
        <>
          <DialogClose>Cancel</DialogClose>
          <Button intent="primary" type="submit" form={formId} icon={<CompactIcon />}>
            Compact
          </Button>
        </>
      }
    >
      <form
        id={formId}
        onSubmit={(event) => {
          event.preventDefault()
          if (onCompact(instructions)) {
            onOpenChange(false)
            setInstructions("")
          }
        }}
        {...stylex.props(styles.form)}
      >
        <Field
          label="What to keep"
          description="Optional. The summary keeps this in full, such as decisions or names."
        >
          <Textarea
            value={instructions}
            onValueChange={setInstructions}
            placeholder="The API we settled on, and the failing test names"
            rows={3}
          />
        </Field>
      </form>
    </Dialog>
  )
}
