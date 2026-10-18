import * as stylex from "@stylexjs/stylex"
import { Link } from "@tanstack/react-router"
import { focus } from "../ui/shared.ts"
import { color, radius, space, text, tracking, weight } from "../ui/tokens.stylex.ts"

const styles = stylex.create({
  brand: {
    display: "inline-flex",
    alignItems: "center",
    gap: space.s1,
    // It hugs the logo and name, so a tap on empty bar space doesn't go home; the buttons after it
    // still sit at the end.
    marginInlineEnd: "auto",
    fontSize: text.md,
    fontWeight: weight.semibold,
    letterSpacing: tracking.tight,
    color: color.text,
    textDecoration: "none",
    borderRadius: radius.sm,
  },
  kip: { flexShrink: 0, height: "1.375rem", width: "auto" },
})

/** kndl's name with Kip beside it, linking home. Kip's colours are the brand's, in either theme. */
export function Brand() {
  return (
    <Link to="/" {...stylex.props(styles.brand, focus.ring)}>
      <Kip />
      kndl
    </Link>
  )
}

/** Kip, the flame on two crossed logs, as in brand/kip.svg. */
function Kip() {
  return (
    <svg viewBox="24 8 80 114" aria-hidden {...stylex.props(styles.kip)}>
      <rect
        x="28"
        y="100"
        width="72"
        height="13"
        rx="6.5"
        fill="#6B4A3A"
        transform="rotate(-11 64 106)"
      />
      <rect
        x="28"
        y="100"
        width="72"
        height="13"
        rx="6.5"
        fill="#8C5F47"
        transform="rotate(11 64 106)"
      />
      <path
        d="M64 12C74 30 100 46 100 74c0 22-16 34-36 34S28 96 28 74c0-16 8-26 16-34 1 12 6 18 13 20-3-16-1-34 7-48z"
        fill="#F6C445"
      />
      <path
        d="M64 50c6 12 21 20 21 36 0 12-9 19-21 19s-21-7-21-19c0-11 9-20 21-36z"
        fill="#FFEDB5"
      />
      <g fill="#2A1F3D">
        <ellipse cx="56" cy="85" rx="3.4" ry="4.4" />
        <ellipse cx="72" cy="85" rx="3.4" ry="4.4" />
      </g>
      <g fill="#F9B89A">
        <circle cx="49.5" cy="93" r="3.4" />
        <circle cx="78.5" cy="93" r="3.4" />
      </g>
      <path
        d="M59 94q5 5.5 10 0"
        fill="none"
        stroke="#2A1F3D"
        strokeWidth="2.6"
        strokeLinecap="round"
      />
    </svg>
  )
}
