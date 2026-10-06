import type { QueuedPrompt } from "@kndl/protocol"
import * as stylex from "@stylexjs/stylex"
import { Avatar, CloseIcon, IconButton } from "../ui/index.ts"
import { color, leading, radius, space, text, weight } from "../ui/tokens.stylex.ts"

const styles = stylex.create({
  root: {
    display: "flex",
    flexDirection: "column",
    gap: space.s1,
  },
  heading: {
    fontSize: text.xs,
    fontWeight: weight.medium,
    color: color.textSubtle,
    paddingInline: space.s1,
  },
  list: {
    display: "flex",
    flexDirection: "column",
    gap: space.s1,
    margin: 0,
    padding: 0,
    listStyle: "none",
  },
  item: {
    display: "flex",
    alignItems: "center",
    gap: space.s2,
    paddingBlock: space.s1,
    paddingInlineStart: space.s2,
    paddingInlineEnd: space.s1,
    borderWidth: "1px",
    borderStyle: "dashed",
    borderColor: color.borderStrong,
    borderRadius: radius.md,
    backgroundColor: color.surface,
  },
  position: {
    flexShrink: 0,
    width: "1rem",
    color: color.textSubtle,
    fontSize: text.xs,
    fontVariantNumeric: "tabular-nums",
    textAlign: "center",
  },
  text: {
    flex: 1,
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    lineHeight: leading.snug,
  },
})

/** The prompts waiting for the current Turn to end, in order. Any Participant may cancel one. */
export function PromptQueue({
  queue,
  onCancel,
}: {
  queue: ReadonlyArray<QueuedPrompt>
  onCancel: (prompt: QueuedPrompt) => void
}) {
  if (queue.length === 0) return null
  return (
    <section aria-label="Prompt queue" {...stylex.props(styles.root)}>
      <h2 {...stylex.props(styles.heading)}>Queued · runs when the current Turn ends</h2>
      <ol {...stylex.props(styles.list)}>
        {queue.map((prompt, index) => (
          <li key={prompt.id} {...stylex.props(styles.item)}>
            <span {...stylex.props(styles.position)}>{index + 1}</span>
            <Avatar name={prompt.sender.name} src={prompt.sender.avatarUrl} size="sm" />
            <span {...stylex.props(styles.text)} title={prompt.text}>
              {prompt.text}
            </span>
            <IconButton
              size="sm"
              label={`Cancel ${prompt.sender.name}'s prompt`}
              onClick={() => onCancel(prompt)}
            >
              <CloseIcon />
            </IconButton>
          </li>
        ))}
      </ol>
    </section>
  )
}
