// What the Hub knows of each Session in memory only, beside what Sessions.ts stores: what its mod
// was sent, what its Runner was asked, its Open ports, its Sandbox tokens, its text streams.
//
// A Session's live state ends in one of five ways, and `ended` clears what each one ends:
//
//   ClaudeGone            Its Claude Code is no longer running: put to sleep, exited on its own,
//                         failed to start, or not running on a Runner that is back.
//   ClaudeGoneRestarting  The same, for a restart that goes on: it is about to be woken.
//   Archived              It was archived: its Runner is asked to stop it for good.
//   RunnerGone            Its Runner went offline: it goes Frozen.
//   Purged                It was purged, past its archive's retention.
//
// This step only moves the state out of SessionRelay.ts: each way clears what the relay cleared
// by hand before, gaps included. The gaps are marked "Kept as before" for the follow-ups.

import type {
  EnvironmentVersion,
  InstallationFailure,
  InstallationId,
  OpenPort,
  Participant,
  ParticipantId,
  PromptId,
  QuestionClosed,
  QuestionPick,
  SessionId,
  SessionRestart,
  TerminalFrame,
  TextDelta,
  ToolCallId,
} from "@kndl/protocol"
import type { StreamRedactor } from "./Redaction.ts"

/** Who or what moved a Session to another state, as its SessionStateChanged records. */
export interface Why {
  readonly by?: Participant
  readonly message?: string
  /** The Installations that kept it from starting (#216). */
  readonly installationsFailed?: ReadonlyArray<InstallationFailure>
}

/** A StartSession its Runner hasn't answered yet (#70). */
export interface StartUnderWay {
  readonly since: number
  /** The Environment version it was sent, if the Repo has an Environment. */
  readonly environmentVersion: EnvironmentVersion | undefined
  /**
   * What its terminal printed before Claude Code's terminal was up, redacted: the Environment's
   * build and start script. Its last `startLogLimit` characters.
   */
  log: string
  /** Whether the Runner has sent a Snapshot of Claude Code's terminal: output after it is Claude's. */
  attached: boolean
}

/** Claude's text of a Turn's loop, as it streams. */
export interface TextStream {
  readonly turnId: TextDelta["turnId"]
  readonly agentId: TextDelta["agentId"]
  readonly redactor: StreamRedactor
  flushing: boolean
}

/** A Session's terminal Output, and the last frame's size, for held text let go. */
export interface TerminalStream {
  readonly redactor: StreamRedactor
  size: TerminalFrame["size"]
  flushing: boolean
}

/** What the Participants have picked for an Open question so far (#193). */
export interface Picks {
  readonly toolCallId: ToolCallId
  readonly picks: ReadonlyArray<QuestionPick>
}

/** A Session's Sandbox tokens (#73): the current one and the one before it. */
export interface SandboxTokens {
  readonly repo: string
  readonly tokens: ReadonlyArray<string>
}

/** One piece of the live state: a value for some Sessions, read and written a Session at a time. */
export interface PerSession<V> {
  readonly get: (id: SessionId) => V | undefined
  readonly has: (id: SessionId) => boolean
  readonly set: (id: SessionId, value: V) => void
  readonly delete: (id: SessionId) => boolean
}

/** One piece of the live state that is only yes or no for each Session. */
export interface SessionSet {
  readonly has: (id: SessionId) => boolean
  readonly add: (id: SessionId) => void
  readonly delete: (id: SessionId) => boolean
}

/** How a Session's live state ends: see the top of this file. */
export type SessionEnd =
  | "ClaudeGone"
  | "ClaudeGoneRestarting"
  | "Archived"
  | "RunnerGone"
  | "Purged"

/**
 * Each Session's live state. Only the Session relay's lock (`serialized`) reads and writes it, so
 * nothing changes between a check and the change it decides; it is synchronous, so a write never
 * waits. Two writes are made off the lock, each synchronous, so neither lands inside another's
 * check: `sandboxTokens.set`, as a GitRequest's answer mints a Sandbox token (it waited on GitHub),
 * and deleting from `installationTrouble`'s inner map, as the Gateway says an Installation works.
 */
export interface LiveSessions {
  /**
   * The prompt each Session's mod has been sent and not yet started a Turn with or failed.
   * In memory only: after a Hub restart the head of the queue is delivered again (see
   * README.md).
   */
  readonly inFlight: PerSession<PromptId>
  /**
   * The prompts each Session's mod has been sent to join the running Turn (DeliverIntoTurn),
   * with who steered each, until the mod says it joined or failed. In memory only, as
   * `inFlight` is.
   */
  readonly steering: PerSession<Map<PromptId, ParticipantId>>
  /** Sessions whose mod said in its hello that it steers (#195). */
  readonly steers: SessionSet
  /**
   * Sessions whose Claude Code was started or woken and whose new mod hasn't said hello yet.
   * Prompts wait for that hello.
   */
  readonly starting: SessionSet
  /** Sessions the Hub asked their Runner to stop for sleep, with why, until SessionStopped. */
  readonly stopping: PerSession<Why>
  /**
   * Sessions being restarted (RestartSession), with who asked: put to sleep, and woken again
   * once their Runner says they stopped.
   */
  readonly restarting: PerSession<Participant>
  /**
   * Sessions whose StartSession the Runner hasn't answered yet, with the output of their
   * build and start script so far: the web shows them starting (#70).
   */
  readonly starts: PerSession<StartUnderWay>
  /**
   * Restarts under way, shown to the web: from the RestartSession until the Session has
   * started again, or failed to. `restarting` is only the part before it is Asleep.
   */
  readonly restarts: PerSession<SessionRestart>
  /**
   * Archived Sessions whose Runner was asked to stop them for good, until SessionStopped. The
   * stop is recorded done only then, so a Runner that drops off first is asked again.
   */
  readonly archiving: SessionSet
  /**
   * What listens in each Active Session's Sandbox, as its Runner last said (#175). In memory
   * only: a Runner that reconnects sends it again.
   */
  readonly openPorts: PerSession<ReadonlyArray<OpenPort>>
  /**
   * The Installations each Active Session has noted failing since it started (#216), each by
   * why, so the Gateway's failures are noted once until the Installation works again.
   */
  readonly installationTrouble: PerSession<Map<InstallationId, string>>
  /** When each Session was last seen busy: an event logged, its queue or presence changing. */
  readonly lastBusy: PerSession<number>
  /**
   * What the Participants have picked for each Session's Open question so far (#193), before
   * answering it. In memory only: cleared when the question closes.
   */
  readonly questionPicks: PerSession<Picks>
  /**
   * How each Session's last Open question closed, redacted, so an answer that comes after is
   * told who answered first, and what. In memory only.
   */
  readonly closedQuestions: PerSession<QuestionClosed>
  /** Why each Session last went Asleep, said to its forwards as they are closed. */
  readonly asleepWhy: PerSession<Why>
  /**
   * Each Session's Sandbox tokens (#73): the current one and the one before it, which a
   * process may still hold. In memory only; a Runner asks for a fresh one when it reconnects.
   * Every Session's are read at once to redact a Repo's.
   */
  readonly sandboxTokens: PerSession<SandboxTokens> & {
    readonly values: () => Iterable<SandboxTokens>
  }
  /** Each Session's text streams, by Turn and subagent, until the Turn ends. */
  readonly textStreams: PerSession<Map<string, TextStream>>
  /** Each Session's terminal Output, and the last frame's size, for held text let go. */
  readonly terminalStreams: PerSession<TerminalStream>
  /** The Session's live state ended `how`: what that ends is cleared (see `clearedWhen`). */
  readonly ended: (id: SessionId, how: SessionEnd) => void
}

type Piece = Exclude<keyof LiveSessions, "ended">

/**
 * What each way a Session's live state ends clears; the rest is kept. Each list is what the relay
 * cleared by hand on that path before; a piece another path clears, kept here, is marked.
 */
const clearedWhen: { readonly [How in SessionEnd]: ReadonlyArray<Piece> } = {
  ClaudeGone: [
    "inFlight",
    "steering",
    "steers",
    "starting",
    "starts",
    "openPorts",
    "installationTrouble",
    "stopping",
    "restarting",
    "restarts",
    // `archiving` is kept: an Archived Session's stop is settled by its SessionStopped.
    // `lastBusy`, `asleepWhy` and `sandboxTokens` are kept until it is purged.
    // `questionPicks` is cleared as its question is cancelled, `closedQuestions` kept to say so.
    // `textStreams` and `terminalStreams`: kept as before; see the follow-up.
  ],
  // As ClaudeGone, but its restart goes on: it is about to be woken.
  ClaudeGoneRestarting: [
    "inFlight",
    "steering",
    "steers",
    "starting",
    "starts",
    "openPorts",
    "installationTrouble",
    "stopping",
    "restarting",
    // `restarts` is kept: the web shows the restart until the Session has started again.
    // The rest is kept as for ClaudeGone.
  ],
  Archived: [
    "inFlight",
    "starting",
    "starts",
    "stopping",
    "restarting",
    "restarts",
    // Its mod token is revoked: a steer under way is never answered, by a mod that is gone.
    "steering",
    "steers",
    // Its Sandbox is destroyed, and what listened or failed in it with it: a Runner that
    // drops off before it stops it leaves nothing to show after a restore.
    "openPorts",
    "installationTrouble",
    // `archiving` is kept: the stop for good is asked for after this.
    // `questionPicks` is cleared as its question is cancelled.
    // `textStreams` and `terminalStreams`: kept as before; see the follow-up.
  ],
  RunnerGone: [
    // A stop it was asked for is settled by what it says when it is back.
    "stopping",
    "restarting",
    "archiving",
    // A start under way is settled by what it says when it is back, too.
    "starts",
    "restarts",
    // `inFlight`, `starting`, `steering`, `steers` and `installationTrouble`: kept as before; see
    // the follow-up. Going Frozen clears `openPorts`.
  ],
  // Nothing is left of it: whatever another way left behind goes too.
  Purged: [
    "inFlight",
    "steering",
    "steers",
    "starting",
    "stopping",
    "restarting",
    "starts",
    "restarts",
    "archiving",
    "openPorts",
    "installationTrouble",
    "lastBusy",
    "questionPicks",
    "closedQuestions",
    "asleepWhy",
    "sandboxTokens",
    "textStreams",
    "terminalStreams",
  ],
}

export const makeLiveSessions = (): LiveSessions => {
  const pieces: { readonly [P in Piece]: LiveSessions[P] } = {
    inFlight: new Map(),
    steering: new Map(),
    steers: new Set(),
    starting: new Set(),
    stopping: new Map(),
    restarting: new Map(),
    starts: new Map(),
    restarts: new Map(),
    archiving: new Set(),
    openPorts: new Map(),
    installationTrouble: new Map(),
    lastBusy: new Map(),
    questionPicks: new Map(),
    closedQuestions: new Map(),
    asleepWhy: new Map(),
    sandboxTokens: new Map(),
    textStreams: new Map(),
    terminalStreams: new Map(),
  }
  return {
    ...pieces,
    ended: (id, how) => {
      for (const piece of clearedWhen[how]) pieces[piece].delete(id)
    },
  }
}
