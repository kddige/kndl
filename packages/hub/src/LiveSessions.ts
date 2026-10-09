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
// Each way says, in `clearedWhen`, why it keeps what it keeps.

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

/** Why a command is refused, as said to whoever sent it. */
export interface Refusal {
  readonly refusal: string
}

/** What a SessionStopped settles: see `stopped`. */
export type Stopped =
  /** The stop for good of an archive (or of one restored since). */
  | { readonly _tag: "Archive" }
  /** Its Claude Code stopped: as asked for sleep, and for a restart, or on its own. */
  | {
      readonly _tag: "Stop"
      /** Why it was asked to stop, if it was. */
      readonly asked: Why | undefined
      /** Who asked to restart it, if it was asked to stop for a restart. */
      readonly restartBy: Participant | undefined
    }

/** How a Session's live state ends: see the top of this file. */
export type SessionEnd =
  | "ClaudeGone"
  | "ClaudeGoneRestarting"
  | "Archived"
  | "RunnerGone"
  | "Purged"

/** Every piece of the live state, as it is kept; the interface shows only what it must. */
interface Pieces {
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
}

type Piece = keyof Pieces

/**
 * Each Session's live state. Only the Session relay's lock (`serialized`) reads and writes it, so
 * nothing changes between a check and the change it decides; it is synchronous, so a write never
 * waits. Two writes are made off the lock, each synchronous, so neither lands inside another's
 * check: `sandboxTokens.set`, as a GitRequest's answer mints a Sandbox token (it waited on GitHub),
 * and deleting from `installationTrouble`'s inner map, as the Gateway says an Installation works.
 */
export interface LiveSessions extends Pick<
  Pieces,
  | "starts"
  | "restarts"
  | "openPorts"
  | "installationTrouble"
  | "lastBusy"
  | "questionPicks"
  | "closedQuestions"
  | "asleepWhy"
  | "sandboxTokens"
  | "textStreams"
  | "terminalStreams"
> {
  // ── Delivery: one prompt at a time, from the Prompt queue to the mod ──

  /** The mod was sent the prompt (DeliverPrompt): it is in flight until a Turn starts or it fails. */
  readonly delivering: (id: SessionId, promptId: PromptId) => void
  /** Whether the prompt is in flight: delivered, and no Turn started from it yet. */
  readonly delivered: (id: SessionId, promptId: PromptId) => boolean
  /** A Turn started, from the prompt if it names one: that prompt is no longer in flight. */
  readonly turnStarted: (id: SessionId, promptId: PromptId) => void
  /**
   * The mod failed the prompt. One being steered into the Turn is no longer (ADR 0018): it stays
   * in its place in the queue, and who steered it is returned, to be told. Any other is no
   * longer in flight, and `undefined` is returned.
   */
  readonly promptFailed: (id: SessionId, promptId: PromptId) => ParticipantId | undefined
  /** The mod said the prompt steered into the Turn joined it (PromptSteered): the steer is over. */
  readonly promptSteered: (id: SessionId, promptId: PromptId) => void
  /** StartSession was sent: prompts wait for the new mod's hello, and the web shows it starting. */
  readonly startSent: (id: SessionId, start: StartUnderWay) => void
  /**
   * RelaunchSession was sent (#128): prompts wait for the new mod's hello, and steers the old mod
   * was sent are dropped, since it won't answer them.
   */
  readonly relaunched: (id: SessionId) => void
  /** The Session's mod said hello, saying whether it steers (#195): prompts may go to it. */
  readonly modHello: (id: SessionId, steers: boolean) => void

  // ── Steering (ADR 0018) ──

  /**
   * Hands the queued prompt to the running Turn, if it can be: "ok", and the mod is to be sent
   * the DeliverIntoTurn; "already", if it is on its way into the Turn, and nothing is to be done;
   * or why not. `turnRunning` is whether the Session is Active with a Turn; one going to sleep
   * takes no steer. `queued` is whether the prompt is in the Session's Prompt queue.
   */
  readonly steer: (
    id: SessionId,
    steer: {
      readonly promptId: PromptId
      readonly by: ParticipantId
      readonly turnRunning: boolean
      readonly queued: boolean
    },
  ) => "ok" | "already" | Refusal
  /** Why the queued prompt can't be cancelled, if it can't: it is on its way to Claude Code. */
  readonly cancelRefusal: (id: SessionId, promptId: PromptId) => Refusal | undefined

  // ── Stopping and restarting ──

  /**
   * The Hub is to ask the Session's Runner to stop it for sleep (StopSession), for `why`, and
   * for a restart if `restart` says who asked (ADR 0009): it is woken again once stopped. False,
   * and nothing changes, if a stop is already under way.
   */
  readonly stopAsked: (id: SessionId, why: Why, restart?: SessionRestart) => boolean
  /** An Asleep Session is about to be woken for a restart: the web shows it restarting. */
  readonly restartWaking: (id: SessionId, restart: SessionRestart) => void
  /**
   * The restart is over unless a start is under way: whether it was under way and is over now,
   * for the web to be told.
   */
  readonly restartOver: (id: SessionId) => boolean
  /** The Hub asked its Runner to stop the Archived Session for good (StopSession `Archive`). */
  readonly archiveStopAsked: (id: SessionId) => void
  /**
   * Its Runner said it stopped (SessionStopped): what that settles. The stop for good of an
   * archive comes first, and is over now. Otherwise, the stop it was asked for, if any, is read
   * here and cleared as Claude Code is gone (`ended`), which the caller says next.
   */
  readonly stopped: (id: SessionId) => Stopped
  /** Its Runner said Claude Code started (SessionStarted): its start and restart are over. */
  readonly claudeStarted: (id: SessionId) => void

  // ── What it is doing ──

  /**
   * Whether no prompt may be delivered to it now: one is in flight, its new mod hasn't said hello,
   * it is going to sleep, or a steer awaits the mod's answer, since the prompt it is about may be
   * the head of the queue.
   */
  readonly blocksDelivery: (id: SessionId) => boolean
  /** Whether its Runner is yet to answer a start or a stop: a drain waits for it (ADR 0011). */
  readonly settling: (id: SessionId) => boolean
  /**
   * Whether it is busy, so not idle: going to sleep, a prompt in flight, or a start under way,
   * which can take minutes to build its Environment.
   */
  readonly busy: (id: SessionId) => boolean
  /** Whether a prompt is in flight to its mod. */
  readonly promptOut: (id: SessionId) => boolean
  /** Whether its Claude Code was started or woken, and its new mod hasn't said hello yet. */
  readonly awaitingHello: (id: SessionId) => boolean
  /** Whether its Runner was asked to stop it for sleep, and hasn't said it stopped. */
  readonly goingToSleep: (id: SessionId) => boolean
  /** Whether its Runner hasn't answered its StartSession yet. */
  readonly startUnderWay: (id: SessionId) => boolean
  /** Whether its Runner was asked to stop it for good, for an archive, and hasn't said it did. */
  readonly archiveStopping: (id: SessionId) => boolean

  /** The Session's live state ended `how`: what that ends is cleared (see `clearedWhen`). */
  readonly ended: (id: SessionId, how: SessionEnd) => void
}

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
    // Its Turns are over and its terminal gone: a new Claude Code has Turns of its own, and its
    // terminal starts with a Snapshot. The relay lets held text go first; a hold under way lets
    // its own go.
    "textStreams",
    "terminalStreams",
    // `archiving` is kept: an Archived Session's stop is settled by its SessionStopped.
    // `lastBusy`, `asleepWhy` and `sandboxTokens` are kept until it is purged.
    // `questionPicks` is cleared as its question is cancelled, `closedQuestions` kept to say so.
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
    "textStreams",
    "terminalStreams",
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
    // `textStreams` and `terminalStreams` are kept until its Runner stops it: ClaudeGone.
  ],
  RunnerGone: [
    // A stop it was asked for is settled by what it says when it is back.
    "stopping",
    "restarting",
    "archiving",
    // A start under way is settled by what it says when it is back, too.
    "starts",
    "restarts",
    // `inFlight`, `starting`, `steering`, `steers`, `installationTrouble` and the streams are
    // kept: Claude Code can outlive its Runner's restart, and its mod talks to the Hub on its own,
    // so they stay true while it is Frozen. A Runner back without it ends them with ClaudeGone.
    // Going Frozen clears `openPorts`.
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

/** Where `piecesOf` finds the pieces: not part of the interface. */
const piecesKey = Symbol("pieces")

/**
 * Every piece of the live state, for LiveSessions.test.ts: the clearing table is about each piece,
 * including those the interface shows only through its decisions.
 */
export const piecesOf = (live: LiveSessions): Pieces =>
  (live as LiveSessions & { readonly [piecesKey]: Pieces })[piecesKey]

export const makeLiveSessions = (): LiveSessions => {
  const pieces: Pieces = {
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
  const steerAnswered = (id: SessionId, promptId: PromptId) => {
    const steered = pieces.steering.get(id)
    steered?.delete(promptId)
    if (steered?.size === 0) pieces.steering.delete(id)
  }

  const live: LiveSessions & { readonly [piecesKey]: Pieces } = {
    ...pieces,
    [piecesKey]: pieces,
    delivering: (id, promptId) => pieces.inFlight.set(id, promptId),
    delivered: (id, promptId) => pieces.inFlight.get(id) === promptId,
    turnStarted: (id, promptId) => {
      if (pieces.inFlight.get(id) === promptId) pieces.inFlight.delete(id)
    },
    promptFailed: (id, promptId) => {
      const steeredBy = pieces.steering.get(id)?.get(promptId)
      if (steeredBy !== undefined) {
        steerAnswered(id, promptId)
        return steeredBy
      }
      if (pieces.inFlight.get(id) === promptId) pieces.inFlight.delete(id)
      return undefined
    },
    promptSteered: steerAnswered,
    startSent: (id, start) => {
      pieces.starting.add(id)
      pieces.starts.set(id, start)
    },
    relaunched: (id) => {
      pieces.steering.delete(id)
      pieces.starting.add(id)
    },
    modHello: (id, steers) => {
      if (steers) pieces.steers.add(id)
      else pieces.steers.delete(id)
      pieces.starting.delete(id)
    },
    steer: (id, { promptId, by, turnRunning, queued }) => {
      if (!turnRunning || pieces.stopping.has(id)) {
        return { refusal: "No Turn is running to steer the prompt into: it goes next." }
      }
      if (pieces.inFlight.get(id) === promptId) {
        return { refusal: "The prompt was already delivered to Claude Code." }
      }
      if (pieces.steering.get(id)?.has(promptId) === true) return "already"
      if (!pieces.steers.has(id)) {
        return {
          refusal:
            "This Session's Claude Code runs a mod from before steering, so the prompt waits for the Turn to end. It can be steered once the Session starts again on an updated Runner.",
        }
      }
      if (!queued) return { refusal: "The prompt is not in the Prompt queue." }
      // It stays in its place until the mod says it joined the Turn.
      const steered = pieces.steering.get(id) ?? new Map<PromptId, ParticipantId>()
      pieces.steering.set(id, steered.set(promptId, by))
      return "ok"
    },
    cancelRefusal: (id, promptId) => {
      if (pieces.inFlight.get(id) === promptId) {
        return { refusal: "The prompt was already delivered to Claude Code." }
      }
      if (pieces.steering.get(id)?.has(promptId) === true) {
        return { refusal: "The prompt is being handed to the running Turn." }
      }
      return undefined
    },
    stopAsked: (id, why, restart) => {
      if (pieces.stopping.has(id)) return false
      if (restart !== undefined) {
        pieces.restarting.set(id, restart.by)
        pieces.restarts.set(id, restart)
      }
      pieces.stopping.set(id, why)
      return true
    },
    restartWaking: (id, restart) => pieces.restarts.set(id, restart),
    restartOver: (id) => !pieces.starts.has(id) && pieces.restarts.delete(id),
    archiveStopAsked: (id) => pieces.archiving.add(id),
    stopped: (id) => {
      if (pieces.archiving.delete(id)) return { _tag: "Archive" }
      const asked = pieces.stopping.get(id)
      return {
        _tag: "Stop",
        asked,
        restartBy: asked === undefined ? undefined : pieces.restarting.get(id),
      }
    },
    claudeStarted: (id) => {
      pieces.starts.delete(id)
      pieces.restarts.delete(id)
    },
    blocksDelivery: (id) =>
      pieces.inFlight.has(id) ||
      pieces.starting.has(id) ||
      pieces.stopping.has(id) ||
      pieces.steering.has(id),
    settling: (id) => pieces.starts.has(id) || pieces.stopping.has(id),
    busy: (id) => pieces.stopping.has(id) || pieces.inFlight.has(id) || pieces.starts.has(id),
    promptOut: (id) => pieces.inFlight.has(id),
    awaitingHello: (id) => pieces.starting.has(id),
    goingToSleep: (id) => pieces.stopping.has(id),
    startUnderWay: (id) => pieces.starts.has(id),
    archiveStopping: (id) => pieces.archiving.has(id),
    ended: (id, how) => {
      for (const piece of clearedWhen[how]) pieces[piece].delete(id)
    },
  }
  return live
}
