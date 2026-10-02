// Sample Hub messages for the web package's tests, decoded with the protocol's schemas so they
// carry the same branded types the client sees.
import { HubToWeb, ProtocolVersion, SessionLogEntry } from "@claude-hub/protocol"
import { Schema } from "effect"

type HubToWebEncoded = typeof HubToWeb.Encoded
type EventEncoded = (typeof SessionLogEntry.Encoded)["event"]

export const alice = { id: "u-1", login: "alice", name: "Alice" }
export const bob = { id: "u-2", login: "bob", name: "Bob" }
export const runnerLogin = { account: "alice@example.com" }

export const sessionSummary = {
  id: "s-1",
  repo: "kddige/claude-hub",
  baseBranch: "main",
  workBranch: "claude/s-1",
  state: "Active",
  runnerId: "r-1",
  runnerLogin,
  creator: alice,
  createdAt: 1_790_000_000_000,
  currentTurn: null,
} as const

/** A Hub message, decoded. */
export function hub(message: HubToWebEncoded): HubToWeb {
  return Schema.decodeUnknownSync(HubToWeb)(message)
}

export function welcome(): HubToWeb {
  return hub({ _tag: "WebWelcome", protocolVersion: ProtocolVersion, you: alice })
}

/** Log entries numbered from `from`, one per event. */
export function entries(
  events: ReadonlyArray<EventEncoded>,
  from = 0,
): ReadonlyArray<SessionLogEntry> {
  return events.map((event, index) =>
    Schema.decodeUnknownSync(SessionLogEntry)({
      seq: from + index,
      at: 1_790_000_000_000 + from + index,
      event,
    }),
  )
}

export function history(
  events: ReadonlyArray<EventEncoded>,
  from = 0,
  sessionId = "s-1",
): HubToWeb {
  return hub({
    _tag: "SessionHistory",
    sessionId,
    entries: events.map((event, index) => ({
      seq: from + index,
      at: 1_790_000_000_000 + from + index,
      event,
    })),
  })
}

export function logged(seq: number, event: EventEncoded, sessionId = "s-1"): HubToWeb {
  return hub({
    _tag: "SessionEventLogged",
    sessionId,
    entry: { seq, at: 1_790_000_000_000 + seq, event },
  })
}

export const fromAlice = { _tag: "FromParticipant", participant: alice } as const
export const fromBob = { _tag: "FromParticipant", participant: bob } as const
