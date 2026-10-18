import type { PresentParticipant } from "@kndl/protocol"
import * as stylex from "@stylexjs/stylex"
import { Avatar, AvatarStack, Popover } from "../ui/index.ts"
import { focus } from "../ui/shared.ts"
import { color, leading, radius, space, text } from "../ui/tokens.stylex.ts"

const styles = stylex.create({
  trigger: {
    display: "inline-flex",
    alignItems: "center",
    padding: space.s1,
    borderWidth: 0,
    borderRadius: radius.full,
    backgroundColor: { default: "transparent", ":hover": color.surfaceHover },
    color: "inherit",
    cursor: "pointer",
  },
  list: {
    display: "flex",
    flexDirection: "column",
    gap: space.s2,
    margin: 0,
    padding: 0,
    listStyle: "none",
  },
  person: { display: "flex", alignItems: "center", gap: space.s2, minWidth: 0 },
  text: { display: "flex", flexDirection: "column", minWidth: 0, lineHeight: leading.snug },
  name: { fontSize: text.sm },
  forwarding: { color: color.textSecondary, fontSize: text.xs, overflowWrap: "anywhere" },
})

/** "forwarding from macbook", or from more than one machine (#180). */
export const forwardingText = (person: PresentParticipant): string | undefined =>
  person.forwardingFrom === undefined
    ? undefined
    : `forwarding from ${person.forwardingFrom.join(", ")}`

/** How a person here is named: "Alice Kim · forwarding from macbook" for a forward. */
export const presentText = (person: PresentParticipant): string => {
  const forwarding = forwardingText(person)
  return forwarding === undefined ? person.name : `${person.name} · ${forwarding}`
}

/**
 * Who's in the Session: their avatars in its header, which open the list of them, a forward
 * (`kndl forward`) with the machine it's from (#180).
 */
export function Presence({ presence }: { presence: ReadonlyArray<PresentParticipant> }) {
  if (presence.length === 0) return null
  return (
    <Popover
      trigger={
        <button
          type="button"
          aria-label={`Here now: ${presence.map(presentText).join(", ")}`}
          {...stylex.props(styles.trigger, focus.ring)}
        >
          <AvatarStack
            label="Here now"
            people={presence.map((p) => ({ id: p.id, name: p.name, src: p.avatarUrl }))}
            size="sm"
          />
        </button>
      }
      title="Here now"
      align="end"
    >
      <ul aria-label="Here now" {...stylex.props(styles.list)}>
        {presence.map((person) => {
          const forwarding = forwardingText(person)
          return (
            <li key={person.id} {...stylex.props(styles.person)}>
              <Avatar name={person.name} src={person.avatarUrl} size="md" />
              <span {...stylex.props(styles.text)}>
                <span {...stylex.props(styles.name)}>{person.name}</span>
                {forwarding !== undefined && (
                  <span {...stylex.props(styles.forwarding)}>{forwarding}</span>
                )}
              </span>
            </li>
          )
        })}
      </ul>
    </Popover>
  )
}
