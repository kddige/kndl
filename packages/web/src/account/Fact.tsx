import * as stylex from "@stylexjs/stylex"
import type { ReactNode } from "react"
import { color, space, text, weight } from "../ui/tokens.stylex.ts"

const styles = stylex.create({
  fact: { display: "flex", flexDirection: "column", gap: space.s0_5, minWidth: 0 },
  term: { color: color.textMuted, fontSize: text.sm },
  detail: {
    margin: 0,
    fontSize: text.base,
    fontWeight: weight.medium,
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
})

/**
 * One fact of a credential's or a Connected provider's card, in its `<dl>`: what it is, quietly,
 * above what it says.
 */
export function Fact({ term, children }: { term: string; children: ReactNode }) {
  return (
    <div {...stylex.props(styles.fact)}>
      <dt {...stylex.props(styles.term)}>{term}</dt>
      <dd {...stylex.props(styles.detail)}>{children}</dd>
    </div>
  )
}
