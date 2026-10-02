import * as stylex from "@stylexjs/stylex"
import { Link } from "@tanstack/react-router"
import { color, leading, space, text, tracking, weight } from "./ui/tokens.stylex.ts"

const styles = stylex.create({
  main: {
    maxWidth: "40rem",
    marginInline: "auto",
    paddingBlock: space.s8,
    paddingInline: space.s4,
    display: "flex",
    flexDirection: "column",
    gap: space.s3,
  },
  title: {
    fontSize: text.xl,
    fontWeight: weight.semibold,
    letterSpacing: tracking.tight,
    lineHeight: leading.tight,
  },
  lede: { color: color.textMuted },
  link: { color: color.accentSubtleText },
})

export function App() {
  return (
    <main {...stylex.props(styles.main)}>
      <h1 {...stylex.props(styles.title)}>Claude Hub</h1>
      <p {...stylex.props(styles.lede)}>
        Run Claude Code Sessions in Sandboxes and work in them together.
      </p>
      <p>
        <Link to="/kit" {...stylex.props(styles.link)}>
          UI kit
        </Link>
      </p>
    </main>
  )
}
