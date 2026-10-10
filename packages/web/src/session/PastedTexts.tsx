import * as stylex from "@stylexjs/stylex"
import { type ClipboardEvent, useRef, useState } from "react"
import { Button, CloseIcon, IconButton, Popover } from "../ui/index.ts"
import { color, font, leading, radius, space, text } from "../ui/tokens.stylex.ts"
import { expandPastes, isLongPaste, type PastedText, pasteRef, pastesIn } from "./pastedText.ts"

const styles = stylex.create({
  chips: {
    display: "flex",
    flexWrap: "wrap",
    gap: space.s1_5,
    margin: 0,
    padding: 0,
    listStyle: "none",
  },
  chip: {
    display: "inline-flex",
    alignItems: "center",
    minWidth: 0,
    borderRadius: radius.md,
    backgroundColor: color.surfaceMuted,
  },
  panel: { width: "min(36rem, var(--available-width))" },
  text: {
    maxHeight: "16rem",
    margin: 0,
    overflow: "auto",
    fontFamily: font.mono,
    fontSize: text.xs,
    lineHeight: leading.normal,
    whiteSpace: "pre-wrap",
    overflowWrap: "anywhere",
  },
})

/**
 * The long pastes in a Composer's draft (#279). A long paste goes into the draft as its reference,
 * at the caret, so where it was pasted is kept; `expand` puts the full text back for sending.
 */
export function usePastedTexts(setDraft: (draft: string) => void) {
  // Counts up for the Composer's life, so two prompts never both have a `#1`.
  const next = useRef(1)
  const [pastes, setPastes] = useState<readonly PastedText[]>([])

  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    // Files are attachments, not text.
    if (event.clipboardData.files.length > 0) return
    // As the terminal sends it: Windows' line breaks as plain ones.
    const pasted = event.clipboardData.getData("text/plain").replaceAll(/\r\n?/g, "\n")
    if (!isLongPaste(pasted)) return
    event.preventDefault()
    const paste = { n: next.current++, text: pasted }
    setPastes((all) => [...all, paste])
    // insertText keeps the paste in the browser's undo history, and fires `input` to update the
    // draft. Where it isn't supported, put the reference in by hand.
    const field = event.currentTarget
    const ref = pasteRef(paste)
    if (!document.execCommand?.("insertText", false, ref)) {
      field.setRangeText(ref, field.selectionStart, field.selectionEnd, "end")
      setDraft(field.value)
    }
  }

  return {
    onPaste,
    /** The pastes still in `draft`, to show as chips. */
    shown: (draft: string) => pastesIn(draft, pastes),
    /** `draft` without the paste's reference. */
    remove: (draft: string, paste: PastedText) => draft.replace(pasteRef(paste), ""),
    /** `draft` as it is sent, with each paste's full text. */
    expand: (draft: string) => expandPastes(draft, pastes),
    /** Forgets the pastes, once the prompt with them is sent. */
    clear: () => setPastes([]),
  }
}

/** A chip for each long paste in the draft: its reference, which shows the text, and remove. */
export function PastedTextChips({
  pastes,
  onRemove,
}: {
  pastes: readonly PastedText[]
  onRemove: (paste: PastedText) => void
}) {
  if (pastes.length === 0) return null
  return (
    <ul aria-label="Pasted texts" {...stylex.props(styles.chips)}>
      {pastes.map((paste) => {
        const ref = pasteRef(paste)
        return (
          <li key={paste.n} {...stylex.props(styles.chip)}>
            <Popover
              trigger={
                <Button size="sm" intent="ghost">
                  {ref}
                </Button>
              }
              title={ref}
              side="top"
              align="start"
              sx={styles.panel}
            >
              <pre {...stylex.props(styles.text)}>{paste.text}</pre>
            </Popover>
            <IconButton size="sm" label={`Remove ${ref}`} onClick={() => onRemove(paste)}>
              <CloseIcon />
            </IconButton>
          </li>
        )
      })}
    </ul>
  )
}
