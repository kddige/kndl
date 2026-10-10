import type { AttachmentId } from "@kndl/protocol"
import * as stylex from "@stylexjs/stylex"
import {
  type ChangeEvent,
  type ClipboardEvent,
  type DragEvent,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react"
import { ArrowUpIcon, Button, IconButton, PaperclipIcon, StopIcon, Textarea } from "../ui/index.ts"
import { color, radius, shadow, space, text } from "../ui/tokens.stylex.ts"
import { pickerAccepts } from "./attachments.ts"
import { type Attach, AttachmentChips, useAttachments } from "./Attachments.tsx"
import { PastedTextChips, usePastedTexts } from "./PastedTexts.tsx"

const styles = stylex.create({
  form: {
    position: "relative",
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
  dropTarget: {
    position: "absolute",
    inset: 0,
    zIndex: 1,
    display: "grid",
    placeItems: "center",
    borderWidth: "2px",
    borderStyle: "dashed",
    borderColor: color.focus,
    borderRadius: radius.lg,
    backgroundColor: color.accentSubtle,
    color: color.accentSubtleText,
    fontSize: text.sm,
    // The drop lands on the form beneath.
    pointerEvents: "none",
  },
  picker: { display: "none" },
})

/** Whether a drag carries files, rather than text or a link. */
const isFileDrag = (event: { readonly dataTransfer: DataTransfer | null }) =>
  [...(event.dataTransfer?.types ?? [])].includes("Files") ||
  [...(event.dataTransfer?.items ?? [])].some((item) => item.kind === "file")

/** Lets files be dropped on the Composer: without it, the browser opens the file instead. */
const dragOver = (event: DragEvent<HTMLFormElement>) => {
  if (!isFileDrag(event)) return
  event.preventDefault()
  if (event.dataTransfer !== null) event.dataTransfer.dropEffect = "copy"
}

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
  /**
   * Uploads a file pasted (#276), dropped or picked with the attach button (#277); without it,
   * the Composer takes no attachments, and has no attach button.
   */
  attach?: Attach | undefined
  /** Why files pasted or dropped are refused without `attach`. */
  cantAttach?: string
  /** Scales an image down before it is uploaded; Claude Code's way by default. */
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
 * images and PDFs pasted, dropped or picked for it, given `attach` (#276, #277). With `copy`, it
 * writes something else, such as a message to an agent.
 */
export function Composer({
  onSend,
  onStop,
  running,
  disabledReason,
  hint,
  picker: modelPicker,
  copy = promptCopy(running),
  attach,
  cantAttach = "Attachments go with prompts only, not here yet.",
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

  // Files dragged over the Composer show where to drop them. The drag enters and leaves each
  // element inside the form in turn, so it is counted, not flagged.
  const [dragging, setDragging] = useState(false)
  const depth = useRef(0)
  const dragEnter = (event: DragEvent<HTMLFormElement>) => {
    if (disabled || !isFileDrag(event)) return
    event.preventDefault()
    depth.current++
    setDragging(true)
  }
  const dragLeave = () => {
    depth.current = Math.max(0, depth.current - 1)
    if (depth.current === 0) setDragging(false)
  }
  const drop = (event: DragEvent<HTMLFormElement>) => {
    depth.current = 0
    setDragging(false)
    const files = [...(event.dataTransfer?.files ?? [])]
    // Nothing is added where nothing can be sent, as a paste can't reach a disabled field.
    if (disabled || files.length === 0) return
    event.preventDefault()
    attachments.add(files)
  }

  // A drop that misses the Composer would open the file in place of the app.
  useEffect(() => {
    const keep = (event: globalThis.DragEvent) => {
      if (isFileDrag(event)) event.preventDefault()
    }
    window.addEventListener("dragover", keep)
    window.addEventListener("drop", keep)
    return () => {
      window.removeEventListener("dragover", keep)
      window.removeEventListener("drop", keep)
    }
  }, [])

  const picker = useRef<HTMLInputElement>(null)
  const pick = (event: ChangeEvent<HTMLInputElement>) => {
    // The Composer may have been disabled while the picker was open.
    if (!disabled) attachments.add([...(event.target.files ?? [])])
    // The same file can be picked again.
    event.target.value = ""
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
    <form
      onSubmit={submit}
      onDragEnter={dragEnter}
      onDragOver={disabled ? undefined : dragOver}
      onDragLeave={dragLeave}
      onDrop={drop}
      {...stylex.props(styles.form)}
    >
      {dragging && taking && (
        <div role="status" aria-label="Drop to attach" {...stylex.props(styles.dropTarget)}>
          Drop images or PDFs to attach
        </div>
      )}
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
        {taking && (
          <>
            {/* On iPhone, the picker offers the camera and the photo library for the images. */}
            <input
              ref={picker}
              type="file"
              multiple
              accept={pickerAccepts}
              tabIndex={-1}
              onChange={pick}
              {...stylex.props(styles.picker)}
            />
            <IconButton
              size="sm"
              label="Attach"
              disabled={disabled}
              onClick={() => picker.current?.click()}
            >
              <PaperclipIcon />
            </IconButton>
          </>
        )}
        {modelPicker}
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
