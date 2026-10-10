// Long pastes in the Composer (#279), as Claude Code's terminal shows them: the field holds a
// short reference such as `[Pasted text #1 +11 lines]` where the text was pasted, and the prompt
// sent has the full text in its place.

/** A paste longer than this many characters, or than `maxLines` lines, becomes a reference. */
const maxChars = 800
const maxLines = 3

/** A paste the field shows as its reference. */
export interface PastedText {
  /** Counts up from 1 in each Composer, as Claude Code's do. */
  readonly n: number
  readonly text: string
}

/** The line breaks in `text`: the lines after the first, which the reference counts. */
function lineBreaks(text: string): number {
  return text.match(/\r\n|\r|\n/g)?.length ?? 0
}

/** Whether a paste is long enough to show as a reference rather than as itself. */
export function isLongPaste(text: string): boolean {
  return text.length > maxChars || lineBreaks(text) + 1 > maxLines
}

/** What the field shows for a paste: `[Pasted text #N +X lines]`, X being the lines after the first. */
export function pasteRef({ n, text }: PastedText): string {
  const more = lineBreaks(text)
  return more === 0 ? `[Pasted text #${n}]` : `[Pasted text #${n} +${more} lines]`
}

/** The pastes whose reference is still in the draft; one deleted by hand is gone. */
export function pastesIn(draft: string, pastes: readonly PastedText[]): PastedText[] {
  return pastes.filter((paste) => draft.includes(pasteRef(paste)))
}

/** A reference as `pasteRef` writes it, with the paste's number. */
const ref = /\[Pasted text #(\d+)(?: \+\d+ lines)?\]/g

/** The draft as it is sent: each paste's reference replaced by its text. */
export function expandPastes(draft: string, pastes: readonly PastedText[]): string {
  // One pass over the draft, so a reference inside a pasted text is left as it is.
  return draft.replace(ref, (match, n: string) => {
    const paste = pastes.find((p) => p.n === Number(n))
    return paste && pasteRef(paste) === match ? paste.text : match
  })
}
