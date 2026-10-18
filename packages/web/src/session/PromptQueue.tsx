import { attachmentCount, type PromptId, type QueuedPrompt } from "@kndl/protocol"
import * as stylex from "@stylexjs/stylex"
import { Avatar, Button, CloseIcon, IconButton, SteerIcon, Tooltip } from "../ui/index.ts"
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

const steerNow = "Send it into the running Turn now, to be read at its next step"

/** What Steer does; for a prompt with attachments, how they reach Claude (#278). */
const steerTip = (prompt: QueuedPrompt) =>
  (prompt.attachments?.length ?? 0) > 0
    ? `${steerNow}: its attachments go with it as markers, to be opened from there.`
    : steerNow

/** A queued prompt as its row shows it: its text, and how many images and PDFs it carries. */
function queuedText(prompt: QueuedPrompt): string {
  const files = prompt.attachments ?? []
  if (files.length === 0) return prompt.text
  const note = attachmentCount(files)
  return prompt.text === "" ? note : `${prompt.text} · ${note}`
}

/**
 * The prompts waiting for the current Turn to end, in order. The Session's Creator may cancel one,
 * or, while a Turn runs, steer it into that Turn now (#195); everyone else only sees them (ADR
 * 0026).
 */
export function PromptQueue({
  queue,
  onCancel,
  onSteer,
  steering = new Set(),
}: {
  queue: ReadonlyArray<QueuedPrompt>
  /** Cancels a queued prompt; absent for someone watching. */
  onCancel?: ((prompt: QueuedPrompt) => void) | undefined
  /** Steers a prompt into the running Turn; absent when no Turn is running. */
  onSteer?: ((prompt: QueuedPrompt) => void) | undefined
  /** The prompts on their way into the running Turn, which leave the queue once they joined it. */
  steering?: ReadonlySet<PromptId>
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
              {queuedText(prompt)}
            </span>
            {onSteer && (
              <Tooltip content={steerTip(prompt)}>
                <Button
                  size="sm"
                  intent="ghost"
                  icon={<SteerIcon />}
                  aria-label={`Steer ${prompt.sender.name}'s prompt into the running Turn`}
                  loading={steering.has(prompt.id)}
                  onClick={() => onSteer(prompt)}
                >
                  Steer
                </Button>
              </Tooltip>
            )}
            {onCancel && (
              <IconButton
                size="sm"
                label={`Cancel ${prompt.sender.name}'s prompt`}
                onClick={() => onCancel(prompt)}
              >
                <CloseIcon />
              </IconButton>
            )}
          </li>
        ))}
      </ol>
    </section>
  )
}
