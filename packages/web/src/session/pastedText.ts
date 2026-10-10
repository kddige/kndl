// Long pastes in the Composer (#279), as Claude Code's terminal shows them: the field holds a
// short placeholder such as `[Pasted text #1 +11 lines]` where the text was pasted, and the prompt
// sent has the full text in its place.

/** A paste longer than this many characters, or than `maxLines` lines, becomes a placeholder. */
const maxChars = 800
const maxLines = 3

/** A paste the field shows as its placeholder. */
export interface PastedText {
  /** Counts up from 1 in each Composer, as Claude Code's do. */
  readonly number: number
  readonly text: string
}

/** The lines after the first. A line break at the end starts no line. */
function moreLines(text: string): number {
  return text.replace(/\n$/, "").split("\n").length - 1
}

/**
 * The text of a paste that is long enough to show as a placeholder, or undefined for one that goes
 * in as it is. Windows' line breaks become plain ones, as the terminal sends them.
 */
export function longPaste(pasted: string): string | undefined {
  const text = pasted.replaceAll(/\r\n?/g, "\n")
  return text.length > maxChars || moreLines(text) + 1 > maxLines ? text : undefined
}

/** What the field shows for a paste: `[Pasted text #N +X lines]`, X being the lines after the first. */
export function pastePlaceholder({ number, text }: PastedText): string {
  const more = moreLines(text)
  return more === 0 ? `[Pasted text #${number}]` : `[Pasted text #${number} +${more} lines]`
}

/**
 * Where each paste's placeholder is in the draft, in order. A paste stands at the first copy of its
 * placeholder; a later copy, pasted by hand, is only text.
 */
function placed(draft: string, pastes: readonly PastedText[]) {
  return pastes
    .map((paste) => ({ paste, at: draft.indexOf(pastePlaceholder(paste)) }))
    .filter(({ at }) => at !== -1)
    .toSorted((a, b) => a.at - b.at)
}

/** The pastes whose placeholder is still in the draft; one deleted by hand is gone. */
export function pastesIn(draft: string, pastes: readonly PastedText[]): PastedText[] {
  return placed(draft, pastes).map(({ paste }) => paste)
}

/** The draft without the paste: the placeholder that `expandPastes` would expand. */
export function removePaste(draft: string, paste: PastedText): string {
  return draft.replace(pastePlaceholder(paste), "")
}

/** The draft as it is sent: each paste's placeholder replaced by its text. */
export function expandPastes(draft: string, pastes: readonly PastedText[]): string {
  let sent = ""
  let from = 0
  for (const { paste, at } of placed(draft, pastes)) {
    sent += draft.slice(from, at) + paste.text
    from = at + pastePlaceholder(paste).length
  }
  return sent + draft.slice(from)
}
