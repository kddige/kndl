import type { AttachmentId } from "@kndl/protocol"
import * as stylex from "@stylexjs/stylex"
import {
  type ClipboardEvent,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
  useState,
} from "react"
import { ArrowUpIcon, Button, IconButton, StopIcon, Textarea } from "../ui/index.ts"
import { color, radius, shadow, space, text } from "../ui/tokens.stylex.ts"
import { type Attach, AttachmentChips, useAttachments } from "./Attachments.tsx"
import { PastedTextChips, usePastedTexts } from "./PastedTexts.tsx"

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
  hint: { flex: 1, minWidth: 0, color: color.textSubtle, fontSize: text.xs },
})

export interface ComposerProps {
  /**
   * Queues the prompt, with the ids of the files attached to it; returns false if it couldn't be
   * sent, so the text and files stay.
   */
  onSend: (text: string, attachments: ReadonlyArray<AttachmentId>) => boolean
  onStop: () => void
  /** A Turn is running, so Stop is offered and a prompt waits in the queue. */
  running: boolean
  /** Why prompts can't be sent now, such as the Session being Frozen. */
  disabledReason?: string | undefined
  /** What a prompt does now, such as waking an Asleep Session. */
  hint?: string | undefined
  /** The model picker, at the start of the bar under the prompt (#128). */
  picker?: ReactNode
  /** What is written, for one that isn't a prompt: a message to an agent (ADR 0014). */
  copy?: ComposerCopy
  /** Uploads a pasted image (#276); without it, the Composer takes no attachments. */
  attach?: Attach | undefined
  /** Why a paste of files is refused without `attach`. */
  cantAttach?: string
  /** Scales a pasted image down before it is uploaded; Claude Code's way by default. */
  prepare?: (file: File) => Promise<File>
}

/** The words of a composer for something other than prompts. */
export interface ComposerCopy {
  readonly field: string
  readonly placeholder: string
  readonly send: string
  readonly stop: string
}

const promptCopy = (running: boolean): ComposerCopy => ({
  field: "Prompt",
  placeholder: running ? "Queue a prompt for after this Turn" : "Ask Claude",
  send: running ? "Queue prompt" : "Send prompt",
  stop: "Stop",
})

/**
 * Where a Participant writes prompts. A prompt always goes through the Prompt queue, with the
 * images pasted into it, given `attach` (#276). With `copy`, it writes something else, such as a
 * message to an agent.
 */
export function Composer({
  onSend,
  onStop,
  running,
  disabledReason,
  hint,
  picker,
  copy = promptCopy(running),
  attach,
  cantAttach = "Images can be attached to prompts only, not here yet.",
  prepare,
}: ComposerProps) {
  const [draft, setDraft] = useState("")
  const pastes = usePastedTexts(draft, setDraft)
  const attachments = useAttachments(attach, cantAttach, prepare)
  // Files kept from before it stopped taking them, as for a reply, wait for the next prompt.
  const taking = attach !== undefined
  const disabled = disabledReason !== undefined
  const empty = draft.trim() === "" && (!taking || attachments.chips.length === 0)
  // A prompt waits for its files to upload, and for one that failed to be taken out.
  const waiting = disabled || empty || (taking && attachments.holding)

  const send = () => {
    if (waiting) return
    if (!onSend(pastes.expand(), taking ? attachments.ids : [])) return
    setDraft("")
    pastes.clear()
    if (taking) attachments.clear()
  }

  const paste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    if (event.clipboardData.files.length > 0) attachments.add([...event.clipboardData.files])
    pastes.onPaste(event)
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
      <AttachmentChips
        chips={attachments.chips}
        refused={attachments.refused}
        waiting={taking ? undefined : cantAttach}
        onRemove={attachments.remove}
      />
      <PastedTextChips pastes={pastes.shown} onRemove={pastes.remove} />
      <Textarea
        aria-label={copy.field}
        value={draft}
        onValueChange={setDraft}
        onKeyDown={keyDown}
        onPaste={paste}
        placeholder={disabledReason ?? copy.placeholder}
        rows={2}
        autoResize
        disabled={disabled}
        sx={styles.textarea}
      />
      <div {...stylex.props(styles.bar)}>
        {picker}
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
            {copy.stop}
          </Button>
        )}
        <IconButton type="submit" size="sm" intent="primary" label={copy.send} disabled={waiting}>
          <ArrowUpIcon />
        </IconButton>
      </div>
    </form>
  )
}
