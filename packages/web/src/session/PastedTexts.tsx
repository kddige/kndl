import * as stylex from "@stylexjs/stylex"
import { type ClipboardEvent, useRef, useState } from "react"
import { Button, CloseIcon, IconButton, Popover } from "../ui/index.ts"
import { color, font, leading, radius, space, text } from "../ui/tokens.stylex.ts"
import {
  expandPastes,
  longPaste,
  type PastedText,
  pastePlaceholder,
  pastesIn,
  removePaste,
} from "./pastedText.ts"

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
  // Wider than a Popover is by default, for lines of code.
  panel: { width: "min(36rem, var(--available-width))", maxWidth: "none" },
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
 * The long pastes in a Composer's draft (#279). A long paste goes into the draft as its
 * placeholder, at the caret, so where it was pasted is kept; `expand` puts the full text back for
 * sending.
 */
export function usePastedTexts(draft: string, setDraft: (draft: string) => void) {
  // Counts up for the Composer's life, so two prompts never both have a `#1`.
  const next = useRef(1)
  const [pastes, setPastes] = useState<readonly PastedText[]>([])

  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    // A paste's files are attachments (#276); text beside them, as a spreadsheet copies with a
    // picture of itself, is text all the same.
    const long = longPaste(event.clipboardData.getData("text/plain"))
    if (long === undefined) return
    event.preventDefault()
    const paste = { number: next.current++, text: long }
    setPastes((all) => [...all, paste])
    // insertText keeps the paste in the browser's undo history, and fires `input` to update the
    // draft. Where it isn't supported, put the placeholder in by hand.
    const field = event.currentTarget
    const placeholder = pastePlaceholder(paste)
    if (!document.execCommand?.("insertText", false, placeholder)) {
      field.setRangeText(placeholder, field.selectionStart, field.selectionEnd, "end")
      setDraft(field.value)
    }
  }

  return {
    onPaste,
    /** The pastes in the draft, to show as chips. */
    shown: pastesIn(draft, pastes),
    /** Takes the paste out of the draft, and forgets it, so a copy of its placeholder is text. */
    remove: (paste: PastedText) => {
      setDraft(removePaste(draft, paste))
      setPastes((all) => all.filter((p) => p !== paste))
    },
    /** The draft as it is sent, with each paste's full text. */
    expand: () => expandPastes(draft, pastes),
    /** Forgets the pastes, once the prompt with them is sent. */
    clear: () => setPastes([]),
  }
}

/** A chip for each long paste in the draft: its placeholder, which shows the text, and remove. */
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
        const placeholder = pastePlaceholder(paste)
        return (
          <li key={paste.number} {...stylex.props(styles.chip)}>
            <Popover
              trigger={
                <Button size="sm" intent="ghost">
                  {placeholder}
                </Button>
              }
              title={placeholder}
              side="top"
              align="start"
              sx={styles.panel}
            >
              <pre {...stylex.props(styles.text)}>{paste.text}</pre>
            </Popover>
            <IconButton size="sm" label={`Remove ${placeholder}`} onClick={() => onRemove(paste)}>
              <CloseIcon />
            </IconButton>
          </li>
        )
      })}
    </ul>
  )
}
