import { Avatar as BaseAvatar } from "@base-ui/react/avatar"
import * as stylex from "@stylexjs/stylex"
import { color, radius, space, text, weight } from "./tokens.stylex.ts"

export type AvatarSize = "sm" | "md" | "lg"

export interface AvatarPerson {
  /** Shown as initials until (or instead of) the picture, and read out. */
  name: string
  /** A picture, e.g. the GitHub avatar URL. */
  src?: string | undefined
}

export interface AvatarProps extends AvatarPerson {
  size?: AvatarSize
  sx?: stylex.StyleXStyles
}

const styles = stylex.create({
  avatar: {
    position: "relative",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
    overflow: "hidden",
    borderRadius: radius.full,
    fontWeight: weight.medium,
    lineHeight: 1,
    userSelect: "none",
    verticalAlign: "middle",
  },
  image: {
    width: "100%",
    height: "100%",
    objectFit: "cover",
  },
  // Each person keeps one hue everywhere; the theme decides how light and saturated it is.
  tint: (hue: number) => ({
    backgroundColor: `oklch(${color.avatarBgLightness} ${color.avatarBgChroma} ${hue})`,
    color: `oklch(${color.avatarFgLightness} ${color.avatarFgChroma} ${hue})`,
  }),
  stack: {
    display: "inline-flex",
    alignItems: "center",
    flexDirection: "row",
  },
  // Overlapping avatars get a ring in the page colour so each one stays distinct.
  stacked: {
    boxShadow: `0 0 0 2px ${color.bg}`,
    marginInlineStart: `calc(${space.s1_5} * -1)`,
  },
  first: {
    marginInlineStart: 0,
  },
  slot: {
    display: "inline-flex",
    borderRadius: radius.full,
  },
  overflow: {
    backgroundColor: color.surfaceActive,
    color: color.textSecondary,
  },
})

const sizes = stylex.create({
  sm: { width: "1.25rem", height: "1.25rem", fontSize: text.xs },
  md: { width: "1.75rem", height: "1.75rem", fontSize: text.xs },
  lg: { width: "2.25rem", height: "2.25rem", fontSize: text.base },
})

/** Up to two initials: first and last word, or the first two letters of a single word. */
export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean)
  const first = words[0] ?? ""
  if (words.length === 1) return first.slice(0, 2).toUpperCase()
  const last = words[words.length - 1] ?? ""
  return `${first.charAt(0)}${last.charAt(0)}`.toUpperCase()
}

/** A stable hue (0–359) for a name, so a person is the same colour on every screen. */
export function hueFor(name: string): number {
  let hash = 0
  for (const char of name) hash = (hash * 31 + (char.codePointAt(0) ?? 0)) >>> 0
  return hash % 360
}

/** A person's picture, or their initials on their own colour until it loads or if it fails. */
export function Avatar({ name, src, size = "md", sx }: AvatarProps) {
  return (
    <BaseAvatar.Root
      role="img"
      aria-label={name}
      {...stylex.props(styles.avatar, sizes[size], styles.tint(hueFor(name)), sx)}
    >
      {src && <BaseAvatar.Image src={src} alt="" {...stylex.props(styles.image)} />}
      <BaseAvatar.Fallback aria-hidden="true" {...(src && { delay: 300 })}>
        {initials(name)}
      </BaseAvatar.Fallback>
    </BaseAvatar.Root>
  )
}

export interface AvatarStackProps {
  /** The people to show, most relevant first (e.g. Participants by who joined first). */
  people: ReadonlyArray<AvatarPerson & { id: string }>
  /** How many avatars to show before collapsing the rest into "+N". */
  max?: number
  size?: AvatarSize
  /** What the people are, for screen readers: "Participants". */
  label: string
  sx?: stylex.StyleXStyles
}

/** Overlapping avatars for a group, like a Session's Participants. */
export function AvatarStack({ people, max = 4, size = "md", label, sx }: AvatarStackProps) {
  // Showing "+1" in place of one avatar saves nothing, so only collapse two or more.
  const visible = people.length > max ? people.slice(0, max - 1) : people
  const hidden = people.slice(visible.length)
  const names = people.map((person) => person.name).join(", ")
  return (
    <div role="group" aria-label={`${label}: ${names}`} {...stylex.props(styles.stack, sx)}>
      {visible.map((person, index) => (
        // The group's label names everyone, so the avatars themselves stay quiet.
        <span
          key={person.id}
          aria-hidden="true"
          {...stylex.props(styles.slot, styles.stacked, index === 0 && styles.first)}
        >
          <Avatar name={person.name} src={person.src} size={size} />
        </span>
      ))}
      {hidden.length > 0 && (
        <span
          aria-hidden="true"
          {...stylex.props(styles.avatar, sizes[size], styles.overflow, styles.stacked)}
        >
          +{hidden.length}
        </span>
      )}
    </div>
  )
}
