// The line above pi's editor that says how the Session's link to the Hub stands and who is
// watching, as hub-link-commands' band does in Claude Code.

import type { PresenceChanged } from "@kndl/protocol"
import type { LinkStatus } from "../../src/HubLink.ts"

/** Who is watching, as the band names them: someone forwarding a port says from where (#180). */
export const watching = (participants: PresenceChanged["participants"]): Array<string> =>
  participants.map((person) =>
    person.forwardingFrom === undefined
      ? person.name
      : `${person.name} (forwarding from ${person.forwardingFrom.join(", ")})`,
  )

/** The line: whether it is linked, and who watches once it is. */
export const presenceLine = (status: LinkStatus, people: ReadonlyArray<string>): string => {
  switch (status._tag) {
    case "Rejected":
      return `○ kndl: the Hub refused the link: ${status.reason}`
    case "Linking":
      return "○ kndl: linking to the Hub"
    case "Offline":
      return "○ kndl: Hub offline"
    case "Linked":
      return `● kndl${people.length === 0 ? " · nobody watching" : ` · ${people.join(", ")}`}`
  }
}
