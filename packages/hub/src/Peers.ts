// The Hub's connections to its peers (#243): the web clients, `kndl forward`s and Runners
// connected now, and who they make present in each Session.
//
// A peer is attached for its connection's scope: registered and its removal put in place at
// once, so a connection that fails part way through connecting never leaves it behind.

import type {
  BuildVersion,
  CliTokenId,
  HubToForward,
  HubToRunner,
  HubToWeb,
  Participant,
  ParticipantId,
  PresentParticipant,
  RunnerId,
  RunnerUpdater,
  SessionId,
} from "@kndl/protocol"
import { Effect, type Scope } from "effect"
import type { SqlError } from "effect/sql/SqlError"
import { closeReason } from "./CloseReason.ts"
import type { RepoMap } from "./RepoMap.ts"

/** A connection to a peer, as its channel gives it: sending never waits. */
export interface Peer<Out> {
  readonly send: (message: Out) => void
  /** Closes the connection with a WebSocket close code, after what was sent before. */
  readonly close: (code: number, reason: string) => void
}

/** A web UI connection. */
export interface WebClient {
  readonly kind: "Web"
  readonly you: Participant
  readonly peer: Peer<HubToWeb>
  /** The Sessions this connection has joined. */
  readonly joined: Set<SessionId>
  /** The Sessions whose terminal this connection watches. */
  readonly terminals: Set<SessionId>
  /**
   * Whether its person has access to each Repo, as last asked (ADR 0003). It is sent the
   * Sessions of a Repo only once this says so. Any spelling of a Repo's name finds it.
   */
  readonly repos: RepoMap<boolean>
}

/** A `kndl forward` of one Session (#180), by a CLI token. */
export interface ForwardClient {
  readonly kind: "Forward"
  readonly you: Participant
  readonly tokenId: CliTokenId
  /** The machine its CLI token is named after, as presence shows it. */
  readonly machine: string
  readonly sessionId: SessionId
  readonly repo: string
  readonly peer: Peer<HubToForward>
}

/** A Runner's connection. */
export interface OnlineRunner {
  readonly id: RunnerId
  readonly name: string
  readonly peer: Peer<HubToRunner>
  /** Whether it asks how to clone a Test build (#104). */
  readonly asksCloneAccess: boolean
  /** The commit it runs, as its hello said. */
  readonly version: BuildVersion | undefined
  /** Whether it updates itself (#87); `undefined` from a Runner too old to say. */
  readonly updater: RunnerUpdater | undefined
  /** Whether it takes a RelaunchSession (#128). */
  readonly relaunches: boolean
  /** Whether it takes an OpenTunnel (#177). */
  readonly forwardsPorts: boolean
  /** Whether it gives Claude Code the MCP servers of its Session's Installations (#221). */
  readonly relaysMcpServers: boolean
}

/** Who was present in each Session before a change, to tell whether it changed. */
export type Presences = ReadonlyMap<SessionId, ReadonlyArray<PresentParticipant>>

/** The peers connected now. Only the Session relay's lock (`serialized`) reads and writes them. */
export interface Peers {
  readonly webClients: ReadonlySet<WebClient>
  readonly forwards: ReadonlySet<ForwardClient>
  /** The Runner's connection, if it is online. */
  readonly runner: (id: RunnerId) => OnlineRunner | undefined
  /** Every online Runner, in the order they first connected. */
  readonly runners: () => ReadonlyArray<OnlineRunner>
  /**
   * The Participants who have joined the Session or forward it, each once, in the order they
   * connected: those in it in the web first, then those only forwarding it. Each one
   * forwarding it says from which machines.
   */
  readonly presenceOf: (sessionId: SessionId) => ReadonlyArray<PresentParticipant>
  /**
   * Closes the web clients and forwards `which` picks, with their channel's `code` and `reason`.
   * Forwards are taken out at once, since they are presence; web clients go when their
   * connection closes. Who was present before, in each Session whose forwards it took out.
   */
  readonly closeWhere: (
    which: (peer: WebClient | ForwardClient) => boolean,
    code: { readonly web: number; readonly forward: number },
    reason: string,
  ) => Presences
  /**
   * Attaches the web client until the scope closes. Then, under the lock, it is taken out, and
   * `left` is told who was present before in each Session it had joined.
   */
  readonly attachWeb: (
    client: WebClient,
    left: (before: Presences) => Effect.Effect<void, SqlError>,
  ) => Effect.Effect<void, never, Scope.Scope>
  /** Attaches the forward until the scope closes, as `attachWeb` does a web client. */
  readonly attachForward: (
    forward: ForwardClient,
    left: (before: Presences) => Effect.Effect<void, SqlError>,
  ) => Effect.Effect<void, never, Scope.Scope>
  /**
   * Attaches the Runner's connection until the scope closes, in place of any it had: the one it
   * replaces, if any, for the caller to close and settle. Then, under the lock, unless a newer
   * connection replaced it meanwhile, it is taken out and `left` runs.
   */
  readonly attachRunner: (
    runner: OnlineRunner,
    left: Effect.Effect<void, SqlError>,
  ) => Effect.Effect<OnlineRunner | undefined, never, Scope.Scope>
}

export const makePeers = (options: {
  /** The Session relay's lock, which a peer's removal takes. */
  readonly serialized: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
}): Peers => {
  const webClients = new Set<WebClient>()
  const forwards = new Set<ForwardClient>()
  const runners = new Map<RunnerId, OnlineRunner>()

  const presenceOf = (sessionId: SessionId): ReadonlyArray<PresentParticipant> => {
    const present = new Map<ParticipantId, Participant>()
    for (const client of webClients) {
      if (client.joined.has(sessionId) && !present.has(client.you.id)) {
        present.set(client.you.id, client.you)
      }
    }
    const machines = new Map<ParticipantId, Array<string>>()
    for (const forward of forwards) {
      if (forward.sessionId !== sessionId) continue
      if (!present.has(forward.you.id)) present.set(forward.you.id, forward.you)
      const from = machines.get(forward.you.id) ?? []
      if (!from.includes(forward.machine)) from.push(forward.machine)
      machines.set(forward.you.id, from)
    }
    return [...present.values()].map((person) => {
      const from = machines.get(person.id)
      return from === undefined ? person : { ...person, forwardingFrom: from }
    })
  }

  const presencesOf = (sessionIds: Iterable<SessionId>): Presences =>
    new Map([...sessionIds].map((id) => [id, presenceOf(id)]))

  /** A peer's removal, under the lock: it can only log what goes wrong. */
  const removal = (remove: () => Effect.Effect<void, SqlError>) =>
    options.serialized(Effect.suspend(remove)).pipe(Effect.catchCause(Effect.logError))

  return {
    webClients,
    forwards,
    runner: (id) => runners.get(id),
    runners: () => [...runners.values()],
    presenceOf,
    closeWhere: (which, code, reason) => {
      for (const client of webClients) {
        if (which(client)) client.peer.close(code.web, closeReason(reason))
      }
      const ended = [...forwards].filter(which)
      const before = new Map(
        ended.map((forward) => [forward.sessionId, presenceOf(forward.sessionId)]),
      )
      for (const forward of ended) {
        forwards.delete(forward)
        forward.peer.close(code.forward, closeReason(reason))
      }
      return before
    },
    attachWeb: (client, left) =>
      Effect.acquireRelease(
        Effect.sync(() => void webClients.add(client)),
        () =>
          removal(() => {
            const before = presencesOf(client.joined)
            webClients.delete(client)
            return left(before)
          }),
      ),
    attachForward: (forward, left) =>
      Effect.acquireRelease(
        Effect.sync(() => void forwards.add(forward)),
        () =>
          removal(() => {
            const before = presencesOf([forward.sessionId])
            forwards.delete(forward)
            return left(before)
          }),
      ),
    attachRunner: (runner, left) =>
      Effect.acquireRelease(
        Effect.sync(() => {
          const replaced = runners.get(runner.id)
          runners.set(runner.id, runner)
          return replaced
        }),
        () =>
          removal(() => {
            if (runners.get(runner.id) !== runner) return Effect.void
            runners.delete(runner.id)
            return left
          }),
      ),
  }
}
