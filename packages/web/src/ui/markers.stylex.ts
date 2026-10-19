/**
 * StyleX markers: a component marks an element with one so the element's descendants can style
 * themselves on its state, with `stylex.when.ancestor(":hover", marker)`.
 */
import * as stylex from "@stylexjs/stylex"

/** A NavItem's row: its action shows while the row is hovered or holds focus. */
export const navRow = stylex.defineMarker()

/** A Turn in the conversation: its quiet actions come forward while it is hovered or holds focus. */
export const turnRow = stylex.defineMarker()
