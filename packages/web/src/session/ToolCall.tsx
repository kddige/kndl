import * as stylex from "@stylexjs/stylex"
import { memo } from "react"
import { prettyInput, type ToolCallView, toolSummary } from "../hub/transcript.ts"
import {
  Badge,
  CheckIcon,
  CloseIcon,
  Disclosure,
  Spinner,
  StopIcon,
  WarningIcon,
} from "../ui/index.ts"
import { color, font, leading, space, text, weight } from "../ui/tokens.stylex.ts"

const styles = stylex.create({
  name: { fontWeight: weight.medium, flexShrink: 0 },
  summary: {
    flex: 1,
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontFamily: font.mono,
    fontSize: text.sm,
    color: color.textMuted,
  },
  status: { display: "inline-flex", flexShrink: 0 },
  succeeded: { color: color.success },
  cutShort: { color: color.textSubtle },
  failed: { color: color.danger },
  details: { display: "flex", flexDirection: "column" },
  section: {
    display: "flex",
    flexDirection: "column",
    gap: space.s1,
    paddingBlock: space.s2,
    paddingInline: space.s3,
  },
  sectionRule: {
    borderTopWidth: "1px",
    borderTopStyle: "solid",
    borderTopColor: color.border,
  },
  label: { fontSize: text.xs, fontWeight: weight.medium, color: color.textSubtle },
  pre: {
    margin: 0,
    maxHeight: "20rem",
    overflow: "auto",
    fontFamily: font.mono,
    fontSize: text.sm,
    lineHeight: leading.snug,
    whiteSpace: "pre-wrap",
    overflowWrap: "anywhere",
    color: color.text,
  },
})

/**
 * One tool call: a summary row, closed by default, that opens on its input and output. One
 * `cutShort` never ended: its loop stopped first.
 */
export const ToolCall = memo(function ToolCall({
  call,
  cutShort = false,
}: {
  call: ToolCallView
  cutShort?: boolean
}) {
  const summary = toolSummary(call.input)
  return (
    <Disclosure
      summary={
        <>
          {cutShort ? (
            <span {...stylex.props(styles.status, styles.cutShort)}>
              <StopIcon aria-label="Cut short" role="img" aria-hidden={false} />
            </span>
          ) : (
            <ToolStatus call={call} />
          )}
          <span {...stylex.props(styles.name)}>{call.tool}</span>
          {summary && <span {...stylex.props(styles.summary)}>{summary}</span>}
          {call.outcome === "Denied" && <Badge intent="warning">Denied</Badge>}
          {call.outcome === "Failed" && <Badge intent="danger">Failed</Badge>}
        </>
      }
    >
      <div {...stylex.props(styles.details)}>
        {call.input !== "" && (
          <div {...stylex.props(styles.section)}>
            <span {...stylex.props(styles.label)}>Input</span>
            <pre {...stylex.props(styles.pre)}>{prettyInput(call.input)}</pre>
          </div>
        )}
        <div {...stylex.props(styles.section, call.input !== "" && styles.sectionRule)}>
          <span {...stylex.props(styles.label)}>
            {call.outcome === "Denied" ? "Reason" : "Output"}
          </span>
          <pre {...stylex.props(styles.pre)}>
            {call.outcome !== undefined
              ? call.output || "(no output)"
              : cutShort
                ? "Cut short: it stopped before it finished."
                : "Running…"}
          </pre>
        </div>
      </div>
    </Disclosure>
  )
})

function ToolStatus({ call }: { call: ToolCallView }) {
  switch (call.outcome) {
    case undefined:
      return <Spinner size="sm" label="Running" />
    case "Succeeded":
      return (
        <span {...stylex.props(styles.status, styles.succeeded)}>
          <CheckIcon aria-label="Succeeded" role="img" aria-hidden={false} />
        </span>
      )
    case "Failed":
      return (
        <span {...stylex.props(styles.status, styles.failed)}>
          <CloseIcon aria-label="Failed" role="img" aria-hidden={false} />
        </span>
      )
    case "Denied":
      return (
        <span {...stylex.props(styles.status, styles.failed)}>
          <WarningIcon aria-label="Denied" role="img" aria-hidden={false} />
        </span>
      )
  }
}
