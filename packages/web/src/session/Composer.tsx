import * as stylex from "@stylexjs/stylex"
import { type FormEvent, type KeyboardEvent, useState } from "react"
import { ArrowUpIcon, Button, IconButton, StopIcon, Textarea } from "../ui/index.ts"
import { color, radius, shadow, space, text } from "../ui/tokens.stylex.ts"

const styles = stylex.create({
  form: {
    display: "flex",
    flexDirection: "column",
    gap: space.s2,
    padding: space.s2,
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: { default: color.borderStrong, ":focus-within": color.focus },
    borderRadius: radius.lg,
    backgroundColor: color.surface,
    boxShadow: shadow.sm,
  },
  textarea: {
    maxHeight: "12rem",
    borderWidth: 0,
    backgroundColor: "transparent",
    boxShadow: "none",
    resize: "none",
    // The form's border shows focus instead.
    outlineStyle: "none",
  },
  bar: {
    display: "flex",
    alignItems: "center",
    gap: space.s2,
  },
  hint: { flex: 1, color: color.textSubtle, fontSize: text.xs },
})

export interface ComposerProps {
  /** Queues the prompt; returns false if it couldn't be sent, so the text stays. */
  onSend: (text: string) => boolean
  onStop: () => void
  /** A Turn is running, so Stop is offered and a prompt waits in the queue. */
  running: boolean
  /** Why prompts can't be sent now, such as the Session being Frozen. */
  disabledReason?: string | undefined
  /** What a prompt does now, such as waking an Asleep Session. */
  hint?: string | undefined
}

/** Where a Participant writes prompts. A prompt always goes through the Prompt queue. */
export function Composer({ onSend, onStop, running, disabledReason, hint }: ComposerProps) {
  const [draft, setDraft] = useState("")
  const disabled = disabledReason !== undefined
  const empty = draft.trim() === ""

  const send = () => {
    if (disabled || empty) return
    if (onSend(draft)) setDraft("")
  }

  const submit = (event: FormEvent) => {
    event.preventDefault()
    send()
  }

  const keyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter sends; Shift+Enter is a new line. Not while an IME is composing a character.
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault()
      send()
    }
  }

  return (
    <form onSubmit={submit} {...stylex.props(styles.form)}>
      <Textarea
        aria-label="Prompt"
        value={draft}
        onValueChange={setDraft}
        onKeyDown={keyDown}
        placeholder={
          disabledReason ?? (running ? "Queue a prompt for after this Turn" : "Ask Claude")
        }
        rows={2}
        autoResize
        disabled={disabled}
        sx={styles.textarea}
      />
      <div {...stylex.props(styles.bar)}>
        <span {...stylex.props(styles.hint)}>
          {hint ??
            (disabled
              ? null
              : running
                ? "Prompts wait in the queue until the Turn ends."
                : "Enter to send, Shift+Enter for a new line.")}
        </span>
        {running && (
          <Button size="sm" intent="secondary" icon={<StopIcon />} onClick={onStop}>
            Stop
          </Button>
        )}
        <IconButton
          type="submit"
          size="sm"
          intent="primary"
          label={running ? "Queue prompt" : "Send prompt"}
          disabled={disabled || empty}
        >
          <ArrowUpIcon />
        </IconButton>
      </div>
    </form>
  )
}
