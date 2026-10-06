// The Session relay: what the Hub does with the messages of Runners, web clients and mods once
// their channel is open (issue #8).
//
// - Every Session has an event log (SessionLog.ts). Turn events from the mod are appended to it,
//   with what the Hub sees itself: SessionStateChanged and TurnStopRequested. A web client that
//   joins a Session gets its history, then each new entry, live.
// - Presence: the Participants with a web connection that has joined the Session, sent in full to
//   those connections and to the Session's mod whenever it changes.
// - The Prompt queue (PromptQueue.ts): prompts wait in order, and the head is delivered to the
//   mod when the Session is idle, one at a time. A prompt the mod reports as PromptFailed is
//   dropped, and its sender gets a CommandFailed, rather than put back to fail again.
// - The Session lifecycle (#12; archiving is #18):
//   - CreateSession starts a Session on a Runner, Active.
//   - Sleep: an Active Session with no Turn running, no prompt queued and no Participant present
//     for `HubConfig.sleepAfter` (or put to sleep by hand with SleepSession) is stopped: the Hub
//     sends StopSession `Sleep`, and records it Asleep when the Runner reports SessionStopped.
//   - Wake: a prompt to an Asleep Session (or WakeSession) wakes it. The Hub records it Active and
//     sends StartSession with `resume`, the Claude Code session id from the mod's last hello. The
//     prompt waits in the queue until the new mod says hello.
//   - Restart (RestartSession, ADR 0009): an Active Session with no Turn running is put to sleep
//     and woken as soon as it is Asleep, so its Sandbox is recreated from the Repo's latest
//     Environment version. An Asleep one is just woken.
//   - A start that fails, or a Claude Code that exits on its own, leaves the Session Asleep, with
//     the reason in the logged SessionStateChanged. Prompts queued stay queued and are not retried
//     on their own: the next prompt or WakeSession tries again. A Claude Code that exited on its
//     own also leaves the last lines its terminal showed (#105), redacted, on the Session's
//     summary while it is Asleep.
//   - A Session whose Environment has, or links, a variable that needs a value (#57) doesn't
//     start: CreateSession is refused, and a wake leaves it Asleep, its prompts queued, with a
//     SessionStateChanged naming the variables. Starting without them would be confusing.
//   - Frozen: while its Runner is offline. Prompts queue up. When the Runner is back the Session is
//     Active if its Claude Code is still running in tmux, otherwise Asleep, and woken if prompts
//     are waiting.
//   - Archive (#18, ADR 0003): any Participant can delete a Session, which archives it at once.
//     The Hub records it Archived, with who did it and when, and sends StopSession `Archive`: the
//     Runner pushes the WIP ref, then destroys the Sandbox and its volumes, keeping the Workspace.
//     A Runner that is offline is sent it when it is back. An Archived Session takes no prompts
//     and opens no terminal; its history stays readable.
//   - Restore: any Participant can bring an Archived Session back until it is purged. It comes
//     back Asleep (Frozen while its Runner is offline), and its next prompt wakes it on a fresh
//     Sandbox around the kept Workspace.
//   - Purge: `HubConfig.archiveRetention` after it was archived, a periodic sweep deletes the
//     Session, its log and its queue, and sends the Runner PurgeSession to delete its directory,
//     Claude Code's state and any volumes left. A Runner that is offline is sent it when it is
//     back, again on every connection until it answers SessionPurged.
// - Session names (#120): anyone with access can rename a Session (RenameSession), in any state;
//   every client that can see it gets the SessionUpdated. A Session without a name is shown by its
//   Work branch.
// - Model and effort (#128): a Session's setting, chosen with CreateSession or changed by anyone
//   with access (SetSessionModel) unless it is Archived, and checked against the models its
//   Runner's Claude Code said it has. Each change is logged as a ModelSwitched. Claude Code takes
//   them as `--model` and `--effort` when it starts; a running one never switches mid-Turn: once
//   no Turn runs, the Hub sends RelaunchSession, and the Runner starts Claude Code again,
//   resuming its conversation, in the same Sandbox. The queued prompts wait for its new mod.
// - Child Sessions (#121, ADR 0012): a Session's Claude Code creates, messages, lists, reads and
//   archives its Child Sessions with the mod's tools (`POST /mod/children`, `childRequest`).
//   - One level deep: a Child Session is refused. A child runs in its parent's Repo, for its
//     parent's Creator, whose Repo access is checked first, off the lock. Its base is the one
//     named, else the Repo's default branch as the GitHub App says, else its parent's base. It
//     goes on its parent's Runner when that can take it, else on another online Runner.
//   - Its task is its first prompt, and every message from its parent is queued like a person's
//     prompt, sent as from the Parent Session, and wakes it if it is Asleep.
//   - Reports: every main-loop TurnEnded of a child, whoever prompted it, queues its final
//     message (ChildSessions.ts) to the parent, sent as from the Child Session, waking an Asleep
//     parent. An Archived parent gets none. The loop guard counts a child's Turns in a row that
//     its parent prompted; a person's prompt to either starts it again. From LoopGuardExchanges
//     on, each Report's note asks the parent to check it is still making progress.
//   - A child messages its parent mid-Turn (MessageParent, #122): queued like a Report, sent as
//     from the Child Session's message, waking an Asleep parent. It neither counts for the loop
//     guard nor starts it again (the Turn it is sent from ends in a Report, which counts), but
//     its note carries the reminder while the count is at LoopGuardExchanges. Refused for a
//     Session that isn't a child, and when its parent is Archived or gone.
//   - Archiving a parent archives its children; restoring it restores only the parent.
// - The terminal mirror: frames from the Runner to the web clients watching, keystrokes back.
// - Git (ADR 0010): the Runner's GitRequests are answered by SessionGit, off the lock, since
//   they may wait on GitHub. When a Turn ends the Runner is told, to push the WIP ref.
// - Environments (#47, ADR 0009): StartSession carries the Repo's Environment as last applied,
//   and the Runner reports the version it started the Session on. Environment commands, Test
//   builds and variable fetches are handled by EnvironmentRelay.ts.
// - Redaction (#48, Redaction.ts): the Sensitive values of a Session's Repo, and the Sandbox
//   tokens of its Sessions (#73), are masked in every event before it is logged, and in terminal
//   frames before they are relayed. Claude's text
//   (TextDelta) and terminal Output are streams: text that could start a value is held back
//   until the next event or frame, or `holdMillis` at most.
// - Repo access (#52, ADR 0003, RepoAccess.ts): a web client is sent only the Sessions of Repos
//   its person has access to, and every command about a Session, or creating one, is checked
//   first, off the lock, since it may wait on GitHub. A Session the person has no access to is
//   refused as if there were no such Session. Each connection keeps what it knows of its person's
//   access to each Repo; a Session in a Repo it doesn't know yet is held back until it is asked.
//   Every `HubConfig.repoAccessTtl` the Repos of everyone connected are checked again, so a
//   person who lost access is taken out of the Repo's Sessions (and their presence) within about
//   twice that, or at their next command once their cached answer expires, whichever is first.
//   When GitHub can't say, a person keeps what they had.
//   Environments follow Repo access too (#104, ADR 0009): every Environment command about a Repo,
//   reading it, checking or applying a draft or starting a Test build, is checked the same way and
//   refused alike whether the Repo exists or not. A person who loses access is told the Repo's
//   Environment is gone from them with a RepoAccessLost. CheckRepo asks for a Repo as it is
//   entered, before a new Session or Environment is set up. Shared variables aren't any Repo's.
// - Claude credentials (ADR 0015, ClaudeCredentials.ts): each person stores their own, checked
//   with Anthropic off the lock, and is sent what they can see of it (ClaudeCredentialState)
//   after the welcome and whenever it changes. A Session runs on its Creator's (a Child
//   Session's Creator is its parent's), else on its Runner's own: a Runner asks for it just
//   before it starts Claude Code, and only for a Session it runs. A Session neither has a
//   credential for doesn't start: CreateSession is refused, and a wake leaves it Asleep. Every
//   credential is redacted from every Session.
//
// Every change runs under one lock, so a joining client's history and the live entries after it
// neither overlap nor leave a gap, and the queue's one-delivery-at-a-time rule holds. Messages to
// peers are queued on each connection without waiting (see Channels.ts), so a slow peer holds up
// no one else.

import {
  type BranchName,
  ChildReply,
  type ChildRequest,
  ClaudeCredentialFetched,
  ClaudeCredentialRefused,
  ClaudeCredentialState,
  type ChildSummary,
  CommandFailed,
  DeliverPrompt,
  FromChildSession,
  FromChildSessionMessage,
  FromParentSession,
  type EnvironmentVersion,
  GitAnswer,
  GitReply,
  type HubToRunner,
  HubToWeb,
  type ModEvent,
  type ModHello,
  type Participant,
  type ParticipantId,
  PresenceChanged,
  PromptId,
  PromptQueueChanged,
  QueuedPrompt,
  type RequestId,
  RequestTerminalSnapshot,
  type BuildVersion,
  NeedsUpdateText,
  type RunnerHello,
  type RunnerList,
  type RunnerId,
  type RunnerLogin,
  type RunnerToHub,
  type RunnerUpdater,
  RunnerUpdateRequested,
  sessionsRefusal,
  type SessionEvent,
  SessionEventLogged,
  type TerminalFrame,
  type TextDelta,
  SessionId,
  SessionRemoved,
  type SessionRestart,
  SessionStartLogged,
  type SessionState,
  SessionStateChanged,
  type SessionSummary,
  SessionTurnEnded,
  StartSession,
  StopSession,
  StopTurn,
  PurgeSession,
  type RepoName,
  RepoAccessLost,
  RepoChecked,
  TurnStopRequested,
  type WebToHub,
  cantStartText,
  AppPermissionsChecked,
  WipNotPushed,
  SandboxNoted,
  MaxLastOutputLength,
  sessionNameFrom,
  type SessionName,
  type SessionRef,
  sessionTitle,
  findModel,
  modelNotFoundText,
  ModelSwitched,
  RelaunchSession,
} from "@claude-hub/protocol"
import {
  Clock,
  Context,
  Duration,
  Effect,
  Layer,
  Option,
  PubSub,
  Redacted,
  Schema,
  type Scope,
  Semaphore,
} from "effect"
import type { SqlError } from "effect/sql/SqlError"
import {
  conversationText,
  finalMessage,
  isPerson,
  oneLevelDeep,
  childMessageText,
  notAChild,
  parentMessageText,
  reportText,
} from "./ChildSessions.ts"
import { ClaudeCredentials } from "./ClaudeCredentials.ts"
import {
  type EnvironmentWebClient,
  isEnvironmentCommand,
  makeEnvironmentRelay,
} from "./EnvironmentRelay.ts"
import { Environments } from "./Environments.ts"
import { GitHubApp } from "./GitHubApp.ts"
import { HubConfig } from "./HubConfig.ts"
import { HubVersion } from "./HubVersion.ts"
import { ModOutbox } from "./ModOutbox.ts"
import { ModTokens } from "./ModTokens.ts"
import type { PairingRefused, Redeemed } from "./PairingCodes.ts"
import { PermissionDrift } from "./PermissionDrift.ts"
import { PromptQueue } from "./PromptQueue.ts"
import {
  everything,
  holdMillis,
  type Needles,
  needlesOf,
  redactEvent,
  redactText,
  StreamRedactor,
} from "./Redaction.ts"
import { RepoAccess } from "./RepoAccess.ts"
import { isRunnerCommand, makeRunnerRelay } from "./RunnerRelay.ts"
import { Runners } from "./Runners.ts"
import type { RunnerIdentity } from "./RunnerTokens.ts"
import { RunnerUpdatePush } from "./RunnerUpdatePush.ts"
import { makeRunnerUpdates } from "./RunnerUpdates.ts"
import { creatorIdentity, SessionGit } from "./SessionGit.ts"
import { SessionLog } from "./SessionLog.ts"
import { type ModelSetting, Sessions } from "./Sessions.ts"
import { randomId } from "./Tokens.ts"

/** A connection to a peer, as its channel gives it: sending never waits. */
export interface Peer<Out> {
  readonly send: (message: Out) => void
  /** Closes the connection with a WebSocket close code, after what was sent before. */
  readonly close: (code: number, reason: string) => void
}

/** Handles one message from a connected peer. */
export type Receive<In> = (message: In) => Effect.Effect<void>

/** Close codes the relay closes connections with. */
export const RelayCloseCode = {
  /** The Runner connected again, and its newer connection replaces this one. */
  Replaced: 4409,
} as const

/** Who or what moved a Session to another state, as its SessionStateChanged records. */
interface Why {
  readonly by?: Participant
  readonly message?: string
}

/** A StartSession its Runner hasn't answered yet (#70). */
interface StartUnderWay {
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

/** How much of a start's output the Hub keeps for clients that join while it runs. */
export const startLogLimit = 64 * 1024

/**
 * A SessionStopped's `output` as the Hub keeps it (#105): redacted first, so a value cut in two by
 * the cap is still found, then its last {@link MaxLastOutputLength} characters.
 */
export const lastOutputText = (needles: Needles, output: string) =>
  redactText(needles, output).slice(-MaxLastOutputLength)

/** How often the Hub looks for idle Sessions to put to sleep: a tenth of the wait, 10 ms to 30 s. */
/** How often draining Runners are checked for Turns past their deadline (RunnerUpdates.ts). */
const drainCheckInterval = Duration.seconds(5)

export const idleCheckInterval = (sleepAfter: Duration.Duration) =>
  Duration.millis(Math.min(Math.max(Duration.toMillis(sleepAfter) / 10, 10), 30_000))

/** How often the Hub looks for Archived Sessions to purge: a tenth of the retention, 10 ms to 1 h. */
export const purgeCheckInterval = (retention: Duration.Duration) =>
  Duration.millis(Math.min(Math.max(Duration.toMillis(retention) / 10, 10), 3_600_000))

/** How many Repo access checks the Hub has GitHub answer at once. */
const accessCheckConcurrency = 8

/** What Repo access says of a web command (see `authorize`). */
interface AccessVerdict {
  /** What GitHub said of the person's access to the Repo the command is about. */
  readonly learned?: { readonly repo: string; readonly allowed: boolean }
  /** Why the command is refused, if it is. */
  readonly refusal?: string
}

/** Why a command about a Repo is refused: alike whether the Repo exists or not (ADR 0003). */
const noRepoAccess = (repo: string) =>
  `You have no access to ${repo} on GitHub, or the GitHub App isn't installed on it.`

/** Why a dev login's Test build is refused: the App can't mint a token to clone it with. */
const notInstalledForTestBuild = (repo: string) =>
  `The GitHub App isn't installed on ${repo}, so a Test build can't clone it: install the App on the Repo, then try again.`

/** StartSession's and RelaunchSession's `model` and `effort` (#128): the Session's setting. */
const modelFlags = (setting: ModelSetting): ModelSetting => ({
  ...(setting.model !== undefined && { model: setting.model }),
  ...(setting.effort !== undefined && { effort: setting.effort }),
})

/** The work branch a new Session commits to. */
export const workBranchFor = (sessionId: SessionId) => `claude/${sessionId}`

/** A Session as a prompt it sends names it. */
const sessionRef = (session: SessionSummary): SessionRef => ({
  id: session.id,
  title: sessionTitle(session),
})

/** How many of a Child Session's latest log entries its parent reads (see `conversationText`). */
const readChildEntries = 2_000

const isBranchName = Schema.is(Schema.NonEmptyString)

const childRefused = (message: string) => ChildReply.cases.ChildRefused.make({ message })

export class SessionRelay extends Context.Service<
  SessionRelay,
  {
    /**
     * A web client, once welcomed: sends it the Runner and Session lists, and keeps them
     * current until the scope closes, which takes it out of every Session it joined.
     */
    readonly connectWeb: (
      you: Participant,
      peer: Peer<HubToWeb>,
    ) => Effect.Effect<Receive<WebToHub>, never, Scope.Scope>
    /**
     * A Runner, once welcomed: its Sessions it says are running go Active. When the scope
     * closes, its Sessions go Frozen.
     */
    readonly connectRunner: (
      runner: RunnerIdentity,
      hello: RunnerHello,
      peer: Peer<HubToRunner>,
    ) => Effect.Effect<Receive<RunnerToHub>, never, Scope.Scope>
    /**
     * Redeems a Pairing code (`POST /runner/pair`): the Runner's new token, which a Re-pair gives
     * in place of the one the Runner had.
     */
    readonly redeemPairing: (
      code: string,
      name: string,
    ) => Effect.Effect<Redeemed, SqlError | PairingRefused>
    /** Whether a Runner is connected now. */
    readonly runnerOnline: (id: RunnerId) => boolean
    /** The Session's mod said hello. */
    readonly modHello: (sessionId: SessionId, hello: ModHello) => Effect.Effect<void, SqlError>
    /** The Session's mod reported Turn events and failed deliveries, oldest first. */
    readonly modEvents: (
      sessionId: SessionId,
      events: ReadonlyArray<ModEvent>,
    ) => Effect.Effect<void, SqlError>
    /** The Session's Claude Code asks about its Child Sessions (`POST /mod/children`, ADR 0012). */
    readonly childRequest: (
      sessionId: SessionId,
      request: ChildRequest,
    ) => Effect.Effect<ChildReply, SqlError>
  }
>()("@claude-hub/hub/SessionRelay") {
  static readonly layer = Layer.effect(
    SessionRelay,
    Effect.gen(function* () {
      const sessions = yield* Sessions
      const log = yield* SessionLog
      const prompts = yield* PromptQueue
      const runners = yield* Runners
      const modTokens = yield* ModTokens
      const outbox = yield* ModOutbox
      const config = yield* HubConfig
      const sessionGit = yield* SessionGit
      const environments = yield* Environments
      const access = yield* RepoAccess
      const app = yield* GitHubApp
      const drift = yield* PermissionDrift
      const hubVersion = yield* HubVersion
      const updatePush = yield* RunnerUpdatePush
      const claudeCredentials = yield* ClaudeCredentials
      const layerScope = yield* Effect.scope
      const lock = yield* Semaphore.make(1)
      const serialized = lock.withPermits(1)

      interface WebClient {
        readonly you: Participant
        readonly peer: Peer<HubToWeb>
        /** The Sessions this connection has joined. */
        readonly joined: Set<SessionId>
        /** The Sessions whose terminal this connection watches. */
        readonly terminals: Set<SessionId>
        /**
         * Whether its person has access to each Repo, as last asked (ADR 0003). It is sent the
         * Sessions of a Repo only once this says so.
         */
        readonly repos: Map<string, boolean>
      }
      interface OnlineRunner {
        readonly id: RunnerId
        readonly name: string
        readonly login: RunnerLogin
        readonly peer: Peer<HubToRunner>
        /** Whether it asks how to clone a Test build (#104). */
        readonly asksCloneAccess: boolean
        /** The commit it runs, as its hello said. */
        readonly version: BuildVersion | undefined
        /** Whether it updates itself (#87); `undefined` from a Runner too old to say. */
        readonly updater: RunnerUpdater | undefined
        /** Whether it takes a RelaunchSession (#128). */
        readonly relaunches: boolean
        /** Whether it has a Claude credential of its own for Sessions whose Creator has none. */
        readonly ownClaudeCredential: boolean
      }

      const webClients = new Set<WebClient>()
      const onlineRunners = new Map<RunnerId, OnlineRunner>()
      /**
       * The prompt each Session's mod has been sent and not yet started a Turn with or failed.
       * In memory only: after a Hub restart the head of the queue is delivered again (see
       * README.md).
       */
      const inFlight = new Map<SessionId, PromptId>()
      /**
       * Sessions whose Claude Code was started or woken and whose new mod hasn't said hello yet.
       * Prompts wait for that hello.
       */
      const starting = new Set<SessionId>()
      /** Sessions the Hub asked their Runner to stop for sleep, with why, until SessionStopped. */
      const stopping = new Map<SessionId, Why>()
      /**
       * Sessions being restarted (RestartSession), with who asked: put to sleep, and woken again
       * once their Runner says they stopped.
       */
      const restarting = new Map<SessionId, Participant>()
      /**
       * Sessions whose StartSession the Runner hasn't answered yet, with the output of their
       * build and start script so far: the web shows them starting (#70).
       */
      const starts = new Map<SessionId, StartUnderWay>()
      /**
       * Restarts under way, shown to the web: from the RestartSession until the Session has
       * started again, or failed to. `restarting` is only the part before it is Asleep.
       */
      const restarts = new Map<SessionId, SessionRestart>()
      /**
       * Archived Sessions whose Runner was asked to stop them for good, until SessionStopped. The
       * stop is recorded done only then, so a Runner that drops off first is asked again.
       */
      const archiving = new Set<SessionId>()
      /** When each Session was last seen busy: an event logged, its queue or presence changing. */
      const lastBusy = new Map<SessionId, number>()

      const markBusy = (sessionId: SessionId) =>
        Effect.map(Clock.currentTimeMillis, (now) => void lastBusy.set(sessionId, now))

      // ── Sending ──────────────────────────────────────────────────────────

      /** StartSession's Environment: the Repo's as last applied, if it has one. */
      const sessionEnvironment = Effect.fn("SessionRelay.sessionEnvironment")(function* (
        repo: string,
      ) {
        const environment = yield* environments.forSession(repo)
        return Option.isSome(environment) ? { environment: environment.value } : {}
      })

      const toWeb = (message: HubToWeb, to: (client: WebClient) => boolean = () => true) => {
        for (const client of webClients) if (to(client)) client.peer.send(message)
      }
      const toJoined = (sessionId: SessionId, message: HubToWeb) =>
        toWeb(message, (client) => client.joined.has(sessionId))

      const runnerList: Effect.Effect<RunnerList, SqlError> = Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis
        return HubToWeb.cases.RunnerList.make({
          runners: (yield* runners.list).map(({ updater, models, ...runner }) => {
            const isOnline = onlineRunners.has(runner.id)
            const update = runnerUpdates.stateOf(runner.id)
            return {
              ...runner,
              isOnline,
              versionStatus: hubVersion.statusOf(runner.version),
              lastSeenAt: isOnline ? now : runner.lastSeenAt,
              ...(updater !== null && { updater }),
              ...(models !== null && { models }),
              ...(update !== undefined && { update }),
            }
          }),
        })
      })

      const runnerRelay = yield* makeRunnerRelay({
        toWeb: (message, to) => toWeb(message, to),
        runnersChanged: Effect.map(runnerList, (list) => toWeb(list)),
        disconnect: (id, code, reason) => onlineRunners.get(id)?.peer.close(code, reason),
      })

      // Runners follow the Hub's commit (#87): RunnerUpdates.ts drains a Runner and moves it.
      const runnerUpdates = makeRunnerUpdates({
        hub: hubVersion.version,
        statusOf: (version) => hubVersion.statusOf(version ?? null),
        push:
          hubVersion.version === undefined
            ? undefined
            : Option.getOrUndefined(yield* updatePush.forCommit(hubVersion.version.commit)),
        online: (id) => onlineRunners.get(id),
        drainSessions: (id) =>
          Effect.map(sessions.listByRunner(id), (list) =>
            list.map((session) => ({
              id: session.id,
              state: session.state,
              turn: session.currentTurn !== null || inFlight.has(session.id),
              settling: starts.has(session.id) || stopping.has(session.id),
            })),
          ),
        session: (id) => Effect.map(sessions.get(id), Option.getOrUndefined),
        putToSleep: (session, message) => putToSleep(session, { message }),
        stopTurn: Effect.fn(function* (sessionId, by) {
          if (by !== undefined) yield* logEvent(sessionId, TurnStopRequested.make({ by }))
          yield* outbox.enqueue(sessionId, StopTurn.make({ sessionId }))
        }),
        runnersChanged: Effect.map(runnerList, (list) => toWeb(list)),
      })

      /**
       * Why no Session may start or wake on the Runner now: it is behind the Hub, or updating
       * (ADR 0011). Its running Sessions go on.
       */
      const runnerRefusal = (runner: OnlineRunner) => {
        const why = sessionsRefusal(
          hubVersion.statusOf(runner.version ?? null),
          runnerUpdates.stateOf(runner.id),
        )
        if (why === undefined) return undefined
        return why === NeedsUpdateText
          ? `${runner.name}: ${why}. Update it on the Runners page.`
          : `${runner.name}: ${why}. Sessions start and wake there again once it is back.`
      }

      /**
       * Why a Session for `creator` can't start on `runner`: neither has a Claude credential
       * (ADR 0015). `you` is who is told, when it is the Creator.
       */
      const noClaudeCredential = (
        creator: Participant,
        runner: OnlineRunner,
        you?: Participant,
      ): string | undefined => {
        if (runner.ownClaudeCredential || claudeCredentials.info(creator.id) !== undefined) {
          return undefined
        }
        return you?.id === creator.id
          ? `Neither you nor ${runner.name} has a Claude credential: add yours on the Account page.`
          : `Neither ${creator.login}, whom this Session runs for, nor ${runner.name} has a Claude credential: ${creator.login} can add theirs on the Account page.`
      }

      /**
       * The Session as the web sees it: what is stored, whose Claude account it runs on, and
       * whether it is starting or restarting.
       */
      const forWeb = (session: SessionSummary): SessionSummary => {
        const start = starts.get(session.id)
        const restart = restarts.get(session.id)
        return {
          ...session,
          claudeAccount:
            claudeCredentials.info(session.creator.id) === undefined ? "Runner" : "Creator",
          ...(start !== undefined && {
            starting: {
              since: start.since,
              ...(start.environmentVersion !== undefined && {
                environmentVersion: start.environmentVersion,
              }),
            },
          }),
          ...(restart !== undefined && { restarting: restart }),
        }
      }

      /**
       * Sends the Session to every client whose person has access to its Repo, and asks for those
       * who aren't known yet (see `learnAccess`).
       */
      const sessionToWeb = Effect.fn("SessionRelay.sessionToWeb")(function* (
        session: SessionSummary,
      ) {
        const message = HubToWeb.cases.SessionUpdated.make({ session: forWeb(session) })
        for (const client of webClients) {
          const known = client.repos.get(session.repo)
          if (known === true) client.peer.send(message)
          else if (known === undefined) yield* learnAccess(client.you, session.repo)
        }
      })

      const sessionUpdated = Effect.fn("SessionRelay.sessionUpdated")(function* (id: SessionId) {
        const session = yield* sessions.get(id)
        if (Option.isSome(session)) yield* sessionToWeb(session.value)
      })

      /** Records that the Hub sent the Session a StartSession, before the state change says so. */
      const startSent = Effect.fn("SessionRelay.startSent")(function* (
        sessionId: SessionId,
        environment: { readonly environment?: { readonly version: EnvironmentVersion } },
      ) {
        starts.set(sessionId, {
          since: yield* Clock.currentTimeMillis,
          environmentVersion: environment.environment?.version,
          log: "",
          attached: false,
        })
      })

      // ── Redaction (#48) ──────────────────────────────────────────────────

      /**
       * What to redact from each Repo's Sessions, until its Sensitive values or the Sandbox tokens
       * of its Sessions change.
       */
      const needlesByRepo = new Map<string, Needles>()

      /**
       * Each Session's Sandbox tokens (#73): the current one and the one before it, which a
       * process may still hold. In memory only; a Runner asks for a fresh one when it reconnects.
       */
      const sandboxTokens = new Map<
        SessionId,
        { readonly repo: string; readonly tokens: ReadonlyArray<string> }
      >()

      /** Redacts the Session's new Sandbox token from now on, with the one before it. */
      const sandboxTokenMinted = (session: SessionSummary, token: string) => {
        const before = sandboxTokens.get(session.id)?.tokens ?? []
        sandboxTokens.set(session.id, { repo: session.repo, tokens: [...before.slice(-1), token] })
        needlesByRepo.delete(session.repo)
      }

      const tokensOfRepo = (repo: string) =>
        [...sandboxTokens.values()].flatMap((known) => (known.repo === repo ? known.tokens : []))

      const needlesFor = Effect.fn("SessionRelay.needlesFor")(function* (repo: string) {
        const known = needlesByRepo.get(repo)
        if (known !== undefined) return known
        const values = yield* environments.sensitiveValues(repo).pipe(
          Effect.map(Option.some),
          Effect.catchTag("EnvironmentRefused", (error) =>
            Effect.logError(
              `Could not read the Sensitive values of ${repo}: masking everything its Sessions print`,
              error,
            ).pipe(Effect.as(Option.none())),
          ),
        )
        // Values that can't be read are tried again next time.
        if (Option.isNone(values)) return everything
        const needles = needlesOf([
          ...values.value.map(Redacted.value),
          ...tokensOfRepo(repo),
          ...claudeCredentials.values(),
        ])
        needlesByRepo.set(repo, needles)
        return needles
      })

      const needlesForSession = Effect.fn("SessionRelay.needlesForSession")(function* (
        sessionId: SessionId,
      ) {
        const session = yield* sessions.get(sessionId)
        return Option.isSome(session) ? yield* needlesFor(session.value.repo) : everything
      })

      /** Runs `effect` under the lock once `holdMillis` have passed. */
      const afterHold = (effect: Effect.Effect<void, SqlError>) =>
        Effect.sleep(Duration.millis(holdMillis)).pipe(
          Effect.andThen(serialized(effect)),
          Effect.catchCause((cause) => Effect.logError("Could not let held text go", cause)),
          Effect.forkIn(layerScope),
          Effect.asVoid,
        )

      /** Claude's text of a Turn's loop, as it streams. */
      interface TextStream {
        readonly turnId: TextDelta["turnId"]
        readonly agentId: TextDelta["agentId"]
        readonly redactor: StreamRedactor
        flushing: boolean
      }
      /** Each Session's text streams, by Turn and subagent, until the Turn ends. */
      const textStreams = new Map<SessionId, Map<string, TextStream>>()

      /** Each Session's terminal Output, and the last frame's size, for held text let go. */
      const terminalStreams = new Map<
        SessionId,
        { readonly redactor: StreamRedactor; size: TerminalFrame["size"]; flushing: boolean }
      >()

      const append = Effect.fn("SessionRelay.append")(function* (
        sessionId: SessionId,
        event: SessionEvent,
      ) {
        const entry = yield* log.append(sessionId, event)
        toJoined(sessionId, SessionEventLogged.make({ sessionId, entry }))
        yield* markBusy(sessionId)
      })

      /** Logs the text a stream holds back. */
      const letTextGo = Effect.fn("SessionRelay.letTextGo")(function* (
        sessionId: SessionId,
        stream: TextStream,
      ) {
        const text = stream.redactor.flush()
        if (text === "") return
        yield* append(sessionId, {
          _tag: "TextDelta",
          turnId: stream.turnId,
          ...(stream.agentId !== undefined && { agentId: stream.agentId }),
          text,
        })
      })

      /** Logs a TextDelta as far as it can be, redacted, holding back what could start a value. */
      const textDelta = Effect.fn("SessionRelay.textDelta")(function* (
        sessionId: SessionId,
        needles: Needles,
        event: TextDelta,
      ) {
        let streams = textStreams.get(sessionId)
        if (streams === undefined) {
          streams = new Map()
          textStreams.set(sessionId, streams)
        }
        const key = `${event.turnId}/${event.agentId ?? ""}`
        let stream = streams.get(key)
        if (stream === undefined) {
          stream = {
            turnId: event.turnId,
            agentId: event.agentId,
            redactor: new StreamRedactor(needles),
            flushing: false,
          }
          streams.set(key, stream)
        }
        stream.redactor.needles = needles
        const text = stream.redactor.push(event.text)
        if (text !== "") yield* append(sessionId, { ...event, text })
        if (!stream.redactor.holding || stream.flushing) return
        const held = stream
        held.flushing = true
        yield* afterHold(
          Effect.suspend(() => {
            held.flushing = false
            return letTextGo(sessionId, held)
          }),
        )
      })

      /**
       * Appends an event to the Session's log, redacted, and sends it to those who joined. Text
       * held back from Claude's text streams is logged first.
       */
      const logEvent = Effect.fn("SessionRelay.logEvent")(function* (
        sessionId: SessionId,
        event: SessionEvent,
      ) {
        const needles = yield* needlesForSession(sessionId)
        if (event._tag === "TextDelta") return yield* textDelta(sessionId, needles, event)
        const streams = textStreams.get(sessionId)
        if (streams !== undefined) {
          for (const stream of streams.values()) yield* letTextGo(sessionId, stream)
          if (event._tag === "TurnEnded") {
            if (event.agentId === undefined) textStreams.delete(sessionId)
            else streams.delete(`${event.turnId}/${event.agentId}`)
          }
        }
        yield* append(sessionId, redactEvent(needles, event))
      })

      /** Sends a terminal frame, redacted, to those watching. */
      const terminalFrame = Effect.fn("SessionRelay.terminalFrame")(function* (
        repo: string,
        frame: TerminalFrame,
      ) {
        const { sessionId } = frame
        const needles = yield* needlesFor(repo)
        const send = (data: string, size: TerminalFrame["size"]) => {
          toWeb({ ...frame, size, data }, (client) => client.terminals.has(sessionId))
          // Before Claude Code's terminal is up, the output is the start's: the Environment's
          // build and start script. A terminal shows nothing until a Snapshot, so the web shows
          // it from here instead (#70).
          const start = starts.get(sessionId)
          if (start === undefined || start.attached || data === "") return
          start.log = (start.log + data).slice(-startLogLimit)
          toJoined(sessionId, SessionStartLogged.make({ sessionId, since: start.since, data }))
        }
        let stream = terminalStreams.get(sessionId)
        if (stream === undefined) {
          stream = { redactor: new StreamRedactor(needles), size: frame.size, flushing: false }
          terminalStreams.set(sessionId, stream)
        }
        stream.redactor.needles = needles
        stream.size = frame.size
        if (frame.kind === "Snapshot") {
          const start = starts.get(sessionId)
          if (start !== undefined) start.attached = true
          // The whole screen, held Output included.
          stream.redactor.reset()
          return send(redactText(needles, frame.data), frame.size)
        }
        const data = stream.redactor.push(frame.data)
        if (data !== "") send(data, frame.size)
        if (!stream.redactor.holding || stream.flushing) return
        const held = stream
        held.flushing = true
        yield* afterHold(
          Effect.sync(() => {
            held.flushing = false
            const rest = held.redactor.flush()
            if (rest !== "") send(rest, held.size)
          }),
        )
      })

      /** Moves the Session to `state`, if it isn't there, logging why. */
      const environmentRelay = yield* makeEnvironmentRelay({
        hasGitHubApp: app.isConfigured,
        onlineRunner: (id) => onlineRunners.get(id),
        toWeb: (message, to: (client: EnvironmentWebClient) => boolean) => toWeb(message, to),
        repoSessionsUpdated: Effect.fn("SessionRelay.repoSessionsUpdated")(function* (repo) {
          for (const session of yield* sessions.list) {
            if (session.repo === repo) yield* sessionToWeb(session)
          }
        }),
        sensitiveValuesChanged: (repo) => {
          if (repo === undefined) needlesByRepo.clear()
          else needlesByRepo.delete(repo)
        },
        afterHold,
      })

      const changeState = Effect.fn("SessionRelay.changeState")(function* (
        session: SessionSummary,
        state: SessionState,
        why: Why,
      ) {
        if (session.state === state) return
        yield* sessions.setState(session.id, state)
        yield* logEvent(session.id, SessionStateChanged.make({ state, ...why }))
        yield* sessionUpdated(session.id)
      })

      const queueChanged = Effect.fn("SessionRelay.queueChanged")(function* (sessionId: SessionId) {
        const queue = yield* prompts.list(sessionId)
        toJoined(sessionId, PromptQueueChanged.make({ sessionId, queue }))
        yield* markBusy(sessionId)
      })

      /** The Participants who have joined the Session, each once, in the order they connected. */
      const presenceOf = (sessionId: SessionId): ReadonlyArray<Participant> => {
        const present = new Map<ParticipantId, Participant>()
        for (const client of webClients) {
          if (client.joined.has(sessionId) && !present.has(client.you.id)) {
            present.set(client.you.id, client.you)
          }
        }
        return [...present.values()]
      }

      /** Tells the Session's mod who is present, if Claude Code may be running to hear it. */
      const presenceToMod = Effect.fn("SessionRelay.presenceToMod")(function* (
        sessionId: SessionId,
      ) {
        const session = yield* sessions.get(sessionId)
        if (Option.isNone(session) || session.value.state !== "Active") return
        yield* outbox.enqueue(
          sessionId,
          PresenceChanged.make({ sessionId, participants: presenceOf(sessionId) }),
        )
      })

      /** Announces the Session's presence if it differs from `before`. */
      const presenceChanged = Effect.fn("SessionRelay.presenceChanged")(function* (
        sessionId: SessionId,
        before: ReadonlyArray<Participant>,
      ) {
        const after = presenceOf(sessionId)
        const same = before.length === after.length && before.every((p, i) => p.id === after[i]?.id)
        if (same) return false
        toJoined(sessionId, PresenceChanged.make({ sessionId, participants: after }))
        yield* markBusy(sessionId)
        yield* presenceToMod(sessionId)
        return true
      })

      // ── Repo access (#52, ADR 0003) ──────────────────────────────────────

      /**
       * Records what GitHub said of the person's access to the Repo on each of their connections.
       * A connection that gains it is sent the Repo's Sessions. One that loses it is taken out of
       * them, joined or watching, with presence updated, and told they are gone.
       */
      const accessKnown = Effect.fn("SessionRelay.accessKnown")(function* (
        who: Participant,
        repo: string,
        allowed: boolean,
      ) {
        const changed = [...webClients].filter(
          (client) => client.you.id === who.id && client.repos.get(repo) !== allowed,
        )
        if (changed.length === 0) return
        const ofRepo = (yield* sessions.list).filter((session) => session.repo === repo)
        for (const client of changed) {
          const before = client.repos.get(repo)
          client.repos.set(repo, allowed)
          if (allowed) {
            for (const session of ofRepo) {
              client.peer.send(HubToWeb.cases.SessionUpdated.make({ session: forWeb(session) }))
            }
            continue
          }
          if (before !== true) continue
          yield* Effect.logInfo(
            `${who.login} no longer has access to ${repo}: out of its Sessions and Environment`,
          )
          client.peer.send(RepoAccessLost.make({ repo }))
          for (const session of ofRepo) {
            client.terminals.delete(session.id)
            if (client.joined.has(session.id)) {
              const presence = presenceOf(session.id)
              client.joined.delete(session.id)
              yield* presenceChanged(session.id, presence)
            }
            client.peer.send(SessionRemoved.make({ sessionId: session.id }))
          }
        }
      })

      /** Asks GitHub, once at a time, for a person's access to a Repo none of their connections knows. */
      const learning = new Set<string>()
      const learnAccess = Effect.fn("SessionRelay.learnAccess")(function* (
        who: Participant,
        repo: string,
      ) {
        const key = `${who.id}\n${repo}`
        if (learning.has(key)) return
        learning.add(key)
        yield* access.check(who, repo).pipe(
          Effect.flatMap((allowed) => serialized(accessKnown(who, repo, allowed))),
          // Asked again at the next recheck.
          Effect.catchTag("RepoAccessUnknown", (error) => Effect.logWarning(error.message)),
          Effect.catchCause((cause) => Effect.logError("Could not check Repo access", cause)),
          Effect.ensuring(Effect.sync(() => learning.delete(key))),
          Effect.forkIn(layerScope),
        )
      })

      /**
       * Checks everyone connected against every Repo with Sessions, or that they were let into,
       * again, as the cache lets it: a person who lost access is taken out of the Repo's Sessions
       * and Environment. Off the lock but for the
       * changes, since it may wait on GitHub. When GitHub can't say, a person keeps what they had.
       */
      const recheckAccess = Effect.gen(function* () {
        const repos = new Set((yield* sessions.list).map((session) => session.repo))
        // And those someone was let into without a Session, such as an Environment being set up.
        for (const client of webClients) {
          for (const [repo, allowed] of client.repos) if (allowed) repos.add(repo)
        }
        const people = new Map([...webClients].map((client) => [client.you.id, client.you]))
        const failures: Array<string> = []
        const answers = yield* Effect.forEach(
          [...people.values()].flatMap((who) => [...repos].map((repo) => ({ who, repo }))),
          ({ who, repo }) =>
            access.check(who, repo).pipe(
              Effect.map((allowed) => ({ who, repo, allowed })),
              Effect.catchTag("RepoAccessUnknown", (error) =>
                Effect.sync(() => void failures.push(error.message)),
              ),
            ),
          { concurrency: accessCheckConcurrency },
        )
        if (failures.length > 0) {
          yield* Effect.logWarning(
            `Repo access rechecks failed (${failures.length}); those people keep what they had`,
            failures[0],
          )
        }
        yield* serialized(
          Effect.forEach(answers, (answer) =>
            answer === undefined
              ? Effect.void
              : accessKnown(answer.who, answer.repo, answer.allowed),
          ),
        )
      }).pipe(Effect.withSpan("SessionRelay.recheckAccess"))

      // ── The Prompt queue ─────────────────────────────────────────────────

      /**
       * Sends the head of the Session's Prompt queue to its mod, if the Session is Active and
       * idle, its mod has said hello, it isn't going to sleep, and no other prompt is out for
       * delivery. An Asleep Session is woken instead (see `wake`).
       */
      const deliverNext = Effect.fn("SessionRelay.deliverNext")(function* (sessionId: SessionId) {
        if (inFlight.has(sessionId) || starting.has(sessionId) || stopping.has(sessionId)) return
        const session = yield* sessions.get(sessionId)
        if (Option.isNone(session)) return
        if (session.value.state !== "Active" || session.value.currentTurn !== null) return
        // A Runner draining for its update takes no prompts: they wait for it to be back.
        if (runnerUpdates.holding(session.value.runnerId)) return
        // A new model or effort first (#128): the prompt waits for the new mod's hello.
        if (session.value.modelPending === true && (yield* relaunch(session.value))) return
        const [head] = yield* prompts.list(sessionId)
        if (head === undefined) return
        inFlight.set(sessionId, head.id)
        yield* outbox.enqueue(
          sessionId,
          DeliverPrompt.make({
            sessionId,
            promptId: head.id,
            text: head.text,
            sender: head.sender,
            ...(head.fromSession !== undefined && { fromSession: head.fromSession }),
          }),
        )
      })

      /**
       * Starts the Session's Claude Code again with its model and effort as set now (#128), once
       * they changed while it ran: Claude Code alone, resuming its conversation, its Sandbox left
       * running. Only between Turns: `deliverNext` asks, when the Session is Active and idle.
       * Whether it was sent; not to a Runner that doesn't take it, or before Claude Code's
       * conversation is known, when the setting waits for the Session's next wake instead.
       */
      const relaunch = Effect.fn("SessionRelay.relaunch")(function* (session: SessionSummary) {
        const runner = onlineRunners.get(session.runnerId)
        if (runner === undefined || !runner.relaunches) return false
        const resume = yield* sessions.claudeSessionId(session.id)
        if (Option.isNone(resume)) return false
        // In place of the old one: the old mod has nothing more to say.
        const modToken = yield* modTokens.issue({ sessionId: session.id, runnerId: runner.id })
        // Commands the old mod didn't collect are stale, as when it sleeps.
        yield* outbox.clear(session.id)
        starting.add(session.id)
        yield* sessions.setModelPending(session.id, false)
        yield* Effect.logInfo(`Restarting Claude Code of ${session.id} for its new model`)
        runner.peer.send(
          RelaunchSession.make({
            sessionId: session.id,
            repo: session.repo,
            workBranch: session.workBranch,
            resume: resume.value,
            modToken,
            ...(yield* parentOf(session)),
            ...modelFlags(session),
          }),
        )
        yield* sessionUpdated(session.id)
        return true
      })

      /**
       * The Session's Claude Code is no longer running: no Turn is, and nothing is in flight. It
       * is Asleep, whether it was put to sleep, exited on its own or failed to start.
       */
      const claudeGone = Effect.fn("SessionRelay.claudeGone")(function* (
        session: SessionSummary,
        why: Why,
        /** It went to sleep for a restart, and is about to be woken: the restart goes on. */
        restartGoesOn = false,
      ) {
        inFlight.delete(session.id)
        starting.delete(session.id)
        starts.delete(session.id)
        stopping.delete(session.id)
        restarting.delete(session.id)
        if (!restartGoesOn) restarts.delete(session.id)
        // Commands the mod didn't collect are stale: a new Claude Code starts with a new mod.
        yield* outbox.clear(session.id)
        if (session.currentTurn !== null) yield* sessions.setCurrentTurn(session.id, null)
        // Its next start takes its model and effort as set then.
        if (session.modelPending === true) yield* sessions.setModelPending(session.id, false)
        if (session.state === "Archived") return
        if (session.state === "Asleep") return yield* sessionUpdated(session.id)
        yield* changeState(session, "Asleep", why)
      })

      /**
       * Wakes an Asleep Session on its online Runner: records it Active and starts its Claude
       * Code again, resuming the conversation its mod last said hello from, on the same
       * Workspace and Sandbox volumes. Queued prompts are delivered once the new mod says hello.
       * `cause`, such as `for a Report from Child Session "Docs"`, follows "Woken on <Runner>" in
       * its history.
       */
      const wake = Effect.fn("SessionRelay.wake")(function* (
        session: SessionSummary,
        why: Why,
        cause?: string,
      ): Effect.fn.Return<string | undefined, SqlError> {
        const runner = onlineRunners.get(session.runnerId)
        // A restored Session still being stopped for its archive wakes once it is stopped.
        if (runner === undefined || session.state !== "Asleep" || archiving.has(session.id)) {
          return undefined
        }
        // Its prompts wait in its queue, and wake it once its Runner is updated.
        const refusal = runnerRefusal(runner)
        if (refusal !== undefined) return refusal
        const needed = yield* environments.valuesNeeded(session.repo)
        if (needed.length > 0) {
          restarts.delete(session.id)
          yield* logEvent(
            session.id,
            SessionStateChanged.make({
              state: "Asleep",
              ...why,
              message: `Claude Code could not start: ${cantStartText(session.repo, needed)}`,
              valuesNeeded: true,
            }),
          )
          yield* sessionUpdated(session.id)
          return undefined
        }
        const noCredential = noClaudeCredential(session.creator, runner, why.by)
        if (noCredential !== undefined) {
          restarts.delete(session.id)
          yield* logEvent(
            session.id,
            SessionStateChanged.make({
              state: "Asleep",
              ...why,
              message: `Claude Code could not start: ${noCredential}`,
            }),
          )
          yield* sessionUpdated(session.id)
          return undefined
        }
        const resume = yield* sessions.claudeSessionId(session.id)
        const environment = yield* sessionEnvironment(session.repo)
        const parent = yield* parentOf(session)
        const modToken = yield* modTokens.issue({ sessionId: session.id, runnerId: runner.id })
        starting.add(session.id)
        yield* startSent(session.id, environment)
        // It starts with its model and effort as set now (#128).
        if (session.modelPending === true) yield* sessions.setModelPending(session.id, false)
        const woken =
          cause === undefined ? `Woken on ${runner.name}` : `Woken on ${runner.name} ${cause}`
        yield* changeState(session, "Active", {
          ...why,
          message: Option.isSome(resume)
            ? woken
            : `${woken}, with a new conversation: Claude Code's last one is unknown`,
        })
        runner.peer.send(
          StartSession.make({
            sessionId: session.id,
            repo: session.repo,
            baseBranch: session.baseBranch,
            workBranch: session.workBranch,
            modToken,
            ...(Option.isSome(resume) ? { resume: resume.value } : {}),
            ...environment,
            gitIdentity: creatorIdentity(session.creator),
            ...parent,
            ...modelFlags(session),
          }),
        )
        return undefined
      })

      /** StartSession's `parent`, for a Child Session: its Parent Session as it is now. */
      const parentOf = Effect.fn("SessionRelay.parentOf")(function* (session: SessionSummary) {
        if (session.parentId === undefined) return {}
        const parent = yield* sessions.get(session.parentId)
        return {
          parent: Option.isSome(parent)
            ? sessionRef(parent.value)
            : { id: session.parentId, title: session.parentId },
        }
      })

      /** Wakes the Session if it is Asleep with prompts waiting, as ones queued while Frozen. */
      const wakeIfWaiting = Effect.fn("SessionRelay.wakeIfWaiting")(function* (
        sessionId: SessionId,
      ) {
        const session = yield* sessions.get(sessionId)
        if (Option.isNone(session) || session.value.state !== "Asleep") return
        if ((yield* prompts.list(sessionId)).length === 0) return
        yield* wake(session.value, { message: "Woken for the prompts waiting in its queue" })
      })

      /**
       * Asks the Session's Runner to stop its Claude Code and Sandbox, keeping the Workspace and
       * the Sandbox's volumes. It stays Active, taking no deliveries, until SessionStopped.
       */
      const putToSleep = Effect.fn("SessionRelay.putToSleep")(function* (
        session: SessionSummary,
        why: Why,
      ) {
        const runner = onlineRunners.get(session.runnerId)
        if (runner === undefined || stopping.has(session.id)) return
        stopping.set(session.id, why)
        yield* Effect.logInfo(`Putting Session ${session.id} to sleep: ${why.message ?? ""}`)
        runner.peer.send(StopSession.make({ sessionId: session.id, reason: "Sleep" }))
      })

      /** Whether the Session is Active with nothing going on and no one there. */
      const isIdle = Effect.fn("SessionRelay.isIdle")(function* (session: SessionSummary) {
        if (session.state !== "Active" || session.currentTurn !== null) return false
        if (!onlineRunners.has(session.runnerId)) return false
        if (stopping.has(session.id) || inFlight.has(session.id)) return false
        // A start can take minutes to build its Environment: it isn't idle until it's over.
        if (starts.has(session.id)) return false
        if (presenceOf(session.id).length > 0) return false
        return (yield* prompts.list(session.id)).length === 0
      })

      /** Puts to sleep every Session that has been idle for `sleepAfter`. */
      const sleepIdle = Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis
        const sleepAfter = Duration.toMillis(config.sleepAfter)
        for (const session of yield* sessions.list) {
          if (!(yield* isIdle(session))) {
            lastBusy.set(session.id, now)
            continue
          }
          const since = lastBusy.get(session.id)
          if (since === undefined) lastBusy.set(session.id, now)
          else if (now - since >= sleepAfter) {
            yield* putToSleep(session, {
              message: `Idle for ${Duration.format(config.sleepAfter)}`,
            })
          }
        }
      }).pipe(Effect.withSpan("SessionRelay.sleepIdle"))

      // ── Archive, restore and purge ───────────────────────────────────────

      /** Asks the Runner to stop the Archived Session for good: push its WIP ref, destroy its Sandbox. */
      const stopForArchive = (runner: OnlineRunner, sessionId: SessionId) => {
        archiving.add(sessionId)
        runner.peer.send(StopSession.make({ sessionId, reason: "Archive" }))
      }

      /**
       * Archives the Session now: nothing more is delivered to it, its terminal closes, and its
       * Runner is asked to stop it for good. Its history and Prompt queue are kept for a restore.
       */
      const archive = Effect.fn("SessionRelay.archive")(function* (
        session: SessionSummary,
        by: Participant,
        message?: string,
      ): Effect.fn.Return<void, SqlError> {
        const at = yield* Clock.currentTimeMillis
        inFlight.delete(session.id)
        starting.delete(session.id)
        starts.delete(session.id)
        stopping.delete(session.id)
        restarting.delete(session.id)
        restarts.delete(session.id)
        yield* outbox.clear(session.id)
        // Its Claude Code is being stopped for good: its mod has nothing more to say.
        yield* modTokens.revoke(session.id)
        for (const client of webClients) client.terminals.delete(session.id)
        yield* sessions.archive(session.id, {
          by: by.id,
          at,
          purgeAt: at + Duration.toMillis(config.archiveRetention),
        })
        yield* logEvent(
          session.id,
          SessionStateChanged.make({
            state: "Archived",
            by,
            ...(message !== undefined && { message }),
          }),
        )
        yield* sessionUpdated(session.id)
        // Its Runner has one Session fewer that keeps it from being removed.
        toWeb(yield* runnerList)
        const runner = onlineRunners.get(session.runnerId)
        if (runner !== undefined) stopForArchive(runner, session.id)
        // Its Child Sessions go with it (ADR 0012); a restore brings back only the parent.
        for (const child of yield* sessions.children(session.id)) {
          if (child.state === "Archived") continue
          yield* archive(child, by, `Archived with its Parent Session "${sessionTitle(session)}"`)
        }
      })

      /** Brings an Archived Session back Asleep, or Frozen while its Runner is offline. */
      const restore = Effect.fn("SessionRelay.restore")(function* (
        session: SessionSummary,
        by: Participant,
      ) {
        const state = onlineRunners.has(session.runnerId) ? "Asleep" : "Frozen"
        yield* sessions.restore(session.id, state)
        yield* logEvent(
          session.id,
          SessionStateChanged.make({ state, by, message: "Restored from the archive" }),
        )
        // It stays Asleep even with prompts queued from before: the next prompt or a wake wakes it.
        yield* sessionUpdated(session.id)
        toWeb(yield* runnerList)
      })

      /** Purges every Archived Session past its retention. */
      const purgeDue = Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis
        for (const session of yield* sessions.dueForPurge(now)) {
          yield* Effect.logInfo(`Purging Session ${session.id}, archived past its retention`)
          yield* sessions.purge(session, now)
          archiving.delete(session.id)
          lastBusy.delete(session.id)
          sandboxTokens.delete(session.id)
          yield* outbox.clear(session.id)
          for (const client of webClients) {
            client.joined.delete(session.id)
            client.terminals.delete(session.id)
          }
          toWeb(
            SessionRemoved.make({ sessionId: session.id }),
            (client) => client.repos.get(session.repo) === true,
          )
          onlineRunners
            .get(session.runnerId)
            ?.peer.send(PurgeSession.make({ sessionId: session.id }))
        }
      }).pipe(Effect.withSpan("SessionRelay.purgeDue"))

      // ── New Sessions ─────────────────────────────────────────────────────

      /** A Session to create and start: from New Session, or a Child Session (ADR 0012). */
      interface NewSessionPlan {
        readonly repo: RepoName
        readonly baseBranch: BranchName
        readonly runner: OnlineRunner
        /** Whom it runs for: who created it, or its Parent Session's Creator. */
        readonly creator: Participant
        /** Why it is Active, as its first SessionStateChanged says. */
        readonly why: Why
        readonly name?: SessionName
        readonly parent?: SessionSummary
        /** Its first prompt, queued before it starts: a Child Session's task. */
        readonly firstPrompt?: QueuedPrompt
        /** Called once it is created and starting, before every client is sent it. */
        readonly created?: (session: SessionSummary) => void
        /** Its model and effort (#128), checked with `checkModel`; Claude Code's default if absent. */
        readonly model?: ModelSetting
      }

      /** A model and effort checked against what a Runner's Claude Code takes (#128). */
      interface CheckedModel {
        readonly setting: ModelSetting
        /** What the Runner's Claude Code calls the model; for the default, the model it runs. */
        readonly label: string | undefined
      }

      /**
       * A model and effort as asked for (#128), checked against what the Runner's Claude Code
       * takes, as it last said in its hello: the setting, or why it is refused. A model it doesn't
       * list is refused with Claude Code's own words. With no list, as from a Runner whose Claude
       * Code couldn't say, only Claude Code's default is taken.
       */
      const checkModel = Effect.fn("SessionRelay.checkModel")(function* (
        runnerId: RunnerId,
        asked: ModelSetting,
      ): Effect.fn.Return<CheckedModel | string, SqlError> {
        const known = Option.getOrUndefined(yield* runners.get(runnerId))
        const models = known?.models ?? null
        if (models === null) {
          if (asked.model === undefined && asked.effort === undefined) {
            return { setting: {}, label: undefined }
          }
          return `${known?.name ?? "The Runner"} hasn't said which models its Claude Code has: only Claude Code's default model can be used there.`
        }
        const model = asked.model === undefined ? models.default : findModel(models, asked.model)
        if (model === undefined) return modelNotFoundText(asked.model ?? "")
        if (asked.effort !== undefined) {
          if (!model.effort) return `${model.label} takes no effort level.`
          if (!models.efforts.includes(asked.effort)) {
            return `Claude Code on ${known?.name ?? "the Runner"} has no effort level '${asked.effort}'.`
          }
        }
        return {
          setting: {
            // The `default` alias is no setting: Claude Code's default, whatever it is then.
            ...(model !== models.default && asked.model !== undefined && { model: asked.model }),
            ...(asked.effort !== undefined && { effort: asked.effort }),
          },
          label: model.label,
        }
      })

      /**
       * Creates a Session and starts it on the plan's Runner, which must be online and able to
       * start Sessions: the Session, or why it can't start, as for an Environment that is missing
       * or needs values.
       */
      const startNew = Effect.fn("SessionRelay.startNew")(function* (
        plan: NewSessionPlan,
      ): Effect.fn.Return<SessionSummary | string, SqlError> {
        const { repo, runner } = plan
        const noCredential = noClaudeCredential(plan.creator, runner, plan.why.by)
        if (noCredential !== undefined) return noCredential
        const missing = yield* environmentRelay.missingEnvironment(repo)
        if (missing !== undefined) return missing
        const needed = yield* environments.valuesNeeded(repo)
        if (needed.length > 0) return cantStartText(repo, needed)
        const environment = yield* sessionEnvironment(repo)
        const id = SessionId.make(randomId())
        const session = yield* sessions.create({
          id,
          repo,
          baseBranch: plan.baseBranch,
          workBranch: workBranchFor(id),
          state: "Active",
          runnerId: runner.id,
          runnerLogin: runner.login,
          creatorId: plan.creator.id,
          createdAt: yield* Clock.currentTimeMillis,
          ...(plan.name !== undefined && { name: plan.name }),
          ...(plan.parent !== undefined && { parentId: plan.parent.id }),
          ...modelFlags(plan.model ?? {}),
        })
        // Delivered once its mod says hello.
        if (plan.firstPrompt !== undefined) yield* prompts.add(id, plan.firstPrompt)
        const modToken = yield* modTokens.issue({ sessionId: id, runnerId: runner.id })
        starting.add(id)
        yield* startSent(id, environment)
        yield* logEvent(id, SessionStateChanged.make({ state: "Active", ...plan.why }))
        runner.peer.send(
          StartSession.make({
            sessionId: id,
            repo: session.repo,
            baseBranch: session.baseBranch,
            workBranch: session.workBranch,
            modToken,
            ...environment,
            gitIdentity: creatorIdentity(session.creator),
            ...(plan.parent !== undefined && { parent: sessionRef(plan.parent) }),
            ...modelFlags(session),
          }),
        )
        plan.created?.(session)
        toWeb(yield* runnerList)
        yield* sessionToWeb(session)
        return session
      })

      // ── Child Sessions (ADR 0012) ────────────────────────────────────────

      /** A Child Session as its parent's tools show it. */
      const childSummary = Effect.fn("SessionRelay.childSummary")(function* (
        session: SessionSummary,
      ): Effect.fn.Return<ChildSummary, SqlError> {
        const queued = (yield* prompts.list(session.id)).length
        const record = yield* sessions.childRecord(session.id)
        return {
          id: session.id,
          title: sessionTitle(session),
          baseBranch: session.baseBranch,
          workBranch: session.workBranch,
          state: session.state,
          working:
            session.currentTurn !== null ||
            inFlight.has(session.id) ||
            (starting.has(session.id) && queued > 0),
          queued,
          ...(record.lastReport !== undefined && { lastReport: record.lastReport }),
        }
      })

      /**
       * Where a Child Session goes (ADR 0012): its parent's Runner if it can start Sessions now,
       * else another online one that can. Else why none can.
       */
      const childRunner = (parent: SessionSummary): OnlineRunner | string => {
        const own = onlineRunners.get(parent.runnerId)
        const candidates = [
          ...(own === undefined ? [] : [own]),
          ...[...onlineRunners.values()].filter((runner) => runner !== own),
        ]
        const able = candidates.find((runner) => runnerRefusal(runner) === undefined)
        if (able !== undefined) return able
        if (own !== undefined) return runnerRefusal(own) ?? "No Runner is online."
        return "No Runner is online to start a Child Session on."
      }

      /**
       * The base a Child Session starts from when its parent names none: the Repo's default
       * branch, as the GitHub App says. Without the App, or when GitHub can't say, its parent's
       * base. Off the lock, since it waits on GitHub.
       */
      const childBase = Effect.fn("SessionRelay.childBase")(function* (parent: SessionSummary) {
        if (!app.isConfigured) return parent.baseBranch
        return yield* app.defaultBranch(parent.repo).pipe(
          Effect.map((branch): BranchName => (isBranchName(branch) ? branch : parent.baseBranch)),
          Effect.catchTag("GitHubAppError", (error) =>
            Effect.as(
              Effect.logWarning(
                `Could not look up ${parent.repo}'s default branch; the Child Session starts from its parent's base`,
                error.message,
              ),
              parent.baseBranch,
            ),
          ),
        )
      })

      /** Creates a Child Session of `parent`, under the lock, once its Creator's access is checked. */
      const createChild = Effect.fn("SessionRelay.createChild")(function* (
        parentId: SessionId,
        request: Extract<ChildRequest, { readonly _tag: "CreateChild" }>,
        baseBranch: BranchName,
      ): Effect.fn.Return<ChildReply, SqlError> {
        const found = yield* sessions.get(parentId)
        if (Option.isNone(found) || found.value.state === "Archived") {
          return childRefused("This Session is archived: it can't create Child Sessions.")
        }
        const parent = found.value
        const runner = childRunner(parent)
        if (typeof runner === "string") return childRefused(runner)
        const ref = sessionRef(parent)
        const created = yield* startNew({
          repo: parent.repo,
          baseBranch,
          runner,
          creator: parent.creator,
          why: {
            message: `Created by its Parent Session "${ref.title}"; started on ${runner.name} from ${baseBranch}`,
          },
          ...(request.name !== undefined && { name: request.name }),
          parent,
          firstPrompt: QueuedPrompt.make({
            id: PromptId.make(randomId()),
            text: parentMessageText(ref, request.prompt),
            sender: parent.creator,
            fromSession: FromParentSession.make({ session: ref }),
            queuedAt: yield* Clock.currentTimeMillis,
          }),
        })
        if (typeof created === "string") return childRefused(created)
        return ChildReply.cases.ChildCreated.make({ child: yield* childSummary(created) })
      })

      /** The caller's Child Session `childId`, or why it isn't one. */
      const ownChild = Effect.fn("SessionRelay.ownChild")(function* (
        parentId: SessionId,
        childId: SessionId,
      ) {
        const child = yield* sessions.get(childId)
        if (Option.isNone(child) || child.value.parentId !== parentId) {
          return `Session ${childId} is not one of your Child Sessions.`
        }
        return child.value
      })

      /** A Parent Session's request other than CreateChild, under the lock. */
      const childCommand = Effect.fn("SessionRelay.childCommand")(function* (
        parentId: SessionId,
        request: Exclude<ChildRequest, { readonly _tag: "CreateChild" | "MessageParent" }>,
      ): Effect.fn.Return<ChildReply, SqlError> {
        const found = yield* sessions.get(parentId)
        if (Option.isNone(found)) return childRefused("There is no such Session.")
        const parent = found.value
        if (request._tag === "ListChildren") {
          const children = (yield* sessions.children(parentId)).filter(
            (child) => child.state !== "Archived",
          )
          return ChildReply.cases.ChildList.make({
            children: yield* Effect.forEach(children, childSummary),
          })
        }
        const child = yield* ownChild(parentId, request.childId)
        if (typeof child === "string") return childRefused(child)
        switch (request._tag) {
          case "ReadChild":
            return ChildReply.cases.ChildRead.make({
              child: yield* childSummary(child),
              conversation: conversationText(yield* log.recent(child.id, readChildEntries)),
            })
          case "ArchiveChild": {
            if (child.state === "Archived") {
              return childRefused(`Child Session ${child.id} is already archived.`)
            }
            // On its Creator's behalf, as every prompt the parent sends is.
            yield* archive(
              child,
              parent.creator,
              `Archived by its Parent Session "${sessionTitle(parent)}"`,
            )
            const archived = yield* sessions.get(child.id)
            return ChildReply.cases.ChildArchived.make({
              child: yield* childSummary(Option.getOrElse(archived, () => child)),
            })
          }
          case "MessageChild": {
            if (child.state === "Archived") {
              return childRefused(
                `Child Session ${child.id} is archived: it takes no messages. Create a new one instead.`,
              )
            }
            const ref = sessionRef(parent)
            yield* prompts.add(
              child.id,
              QueuedPrompt.make({
                id: PromptId.make(randomId()),
                text: parentMessageText(ref, request.text),
                sender: parent.creator,
                fromSession: FromParentSession.make({ session: ref }),
                queuedAt: yield* Clock.currentTimeMillis,
              }),
            )
            yield* queueChanged(child.id)
            if (child.state === "Asleep") {
              const refused = yield* wake(
                child,
                {},
                `for a message from its Parent Session "${ref.title}"`,
              )
              if (refused !== undefined) {
                return childRefused(
                  `Your message waits in its queue, but it can't wake now. ${refused}`,
                )
              }
            } else {
              yield* deliverNext(child.id)
            }
            const after = yield* sessions.get(child.id)
            return ChildReply.cases.ChildMessaged.make({
              child: yield* childSummary(Option.getOrElse(after, () => child)),
            })
          }
        }
      })

      /**
       * A Child Session's message to its parent, mid-Turn, under the lock: queued as a prompt,
       * waking the parent if it is Asleep, as a Report is. Refused for a Session that isn't a
       * child, and when its parent is Archived or gone.
       */
      const messageParent = Effect.fn("SessionRelay.messageParent")(function* (
        childId: SessionId,
        request: Extract<ChildRequest, { readonly _tag: "MessageParent" }>,
      ): Effect.fn.Return<ChildReply, SqlError> {
        const found = yield* sessions.get(childId)
        if (Option.isNone(found)) return childRefused("There is no such Session.")
        const child = found.value
        if (child.parentId === undefined) return childRefused(notAChild)
        const parent = yield* sessions.get(child.parentId)
        if (Option.isNone(parent)) {
          return childRefused("Your Parent Session no longer exists: the message can't be sent.")
        }
        const parentRef = sessionRef(parent.value)
        if (parent.value.state === "Archived") {
          return childRefused(
            `Your Parent Session "${parentRef.title}" is archived: it takes no messages.`,
          )
        }
        const ref = sessionRef(child)
        // Mid-Turn or with a prompt on its way, the parent reads the message after that Turn.
        const working = parent.value.currentTurn !== null || inFlight.has(parent.value.id)
        // The loop guard's count as of the child's last Report: a message doesn't change it.
        const { exchanges } = yield* sessions.childRecord(childId)
        yield* prompts.add(
          parent.value.id,
          QueuedPrompt.make({
            id: PromptId.make(randomId()),
            text: childMessageText(ref, request.text, exchanges),
            sender: parent.value.creator,
            fromSession: FromChildSessionMessage.make({ session: ref }),
            queuedAt: yield* Clock.currentTimeMillis,
          }),
        )
        yield* queueChanged(parent.value.id)
        if (parent.value.state === "Asleep") {
          const refused = yield* wake(
            parent.value,
            {},
            `for a message from Child Session "${ref.title}"`,
          )
          if (refused !== undefined) {
            return childRefused(
              `Your message waits in its queue, but your Parent Session can't wake now. ${refused}`,
            )
          }
        } else {
          yield* deliverNext(parent.value.id)
        }
        return ChildReply.cases.ParentMessaged.make({ parent: parentRef, working })
      })

      const childRequest = Effect.fn("SessionRelay.childRequest")(function* (
        sessionId: SessionId,
        request: ChildRequest,
      ): Effect.fn.Return<ChildReply, SqlError> {
        if (request._tag === "MessageParent")
          return yield* serialized(messageParent(sessionId, request))
        if (request._tag !== "CreateChild")
          return yield* serialized(childCommand(sessionId, request))
        const found = yield* sessions.get(sessionId)
        if (Option.isNone(found)) return childRefused("There is no such Session.")
        const parent = found.value
        if (parent.parentId !== undefined) return childRefused(oneLevelDeep)
        // As its Creator, off the lock: a coordinator starts nothing its Creator couldn't.
        const allowed = yield* access
          .check(parent.creator, parent.repo)
          .pipe(
            Effect.catchTag("RepoAccessUnknown", (error) =>
              Effect.as(Effect.logWarning(error.message), undefined),
            ),
          )
        if (allowed === undefined) {
          return childRefused(
            `Could not check ${parent.creator.login}'s access to ${parent.repo} on GitHub; try again.`,
          )
        }
        if (!allowed) {
          return childRefused(
            `${parent.creator.login}, who this Session runs for, has no access to ${parent.repo} on GitHub, or the GitHub App isn't installed on it.`,
          )
        }
        const baseBranch = request.baseBranch ?? (yield* childBase(parent))
        return yield* serialized(createChild(sessionId, request, baseBranch))
      })

      /**
       * A Child Session's Turn ended: its final message goes to its parent as a Report, queued
       * as a prompt, waking the parent if it is Asleep. An Archived parent gets none.
       */
      const reportToParent = Effect.fn("SessionRelay.reportToParent")(function* (
        childId: SessionId,
      ) {
        const found = yield* sessions.get(childId)
        if (Option.isNone(found) || found.value.parentId === undefined) return
        const child = found.value
        const { text, sender } = finalMessage(yield* log.lastTurn(childId))
        // The loop guard counts Turns in a row its parent prompted.
        const exchanges =
          sender?._tag === "FromParentSession"
            ? (yield* sessions.childRecord(childId)).exchanges + 1
            : 0
        const at = yield* Clock.currentTimeMillis
        yield* sessions.recordReport(childId, { text, at }, exchanges)
        const parent = yield* sessions.get(found.value.parentId)
        if (Option.isNone(parent) || parent.value.state === "Archived") {
          return yield* Effect.logInfo(
            `A Report from Child Session ${childId} has no Parent Session to go to`,
          )
        }
        const ref = sessionRef(child)
        yield* prompts.add(
          parent.value.id,
          QueuedPrompt.make({
            id: PromptId.make(randomId()),
            text: reportText(ref, text, exchanges),
            sender: parent.value.creator,
            fromSession: FromChildSession.make({ session: ref }),
            queuedAt: at,
          }),
        )
        yield* queueChanged(parent.value.id)
        if (parent.value.state === "Asleep") {
          const refused = yield* wake(
            parent.value,
            {},
            `for a Report from Child Session "${ref.title}"`,
          )
          if (refused !== undefined) {
            yield* Effect.logInfo(`A Report waits for Session ${parent.value.id}: ${refused}`)
          }
        } else {
          yield* deliverNext(parent.value.id)
        }
      })

      // ── The web channel ──────────────────────────────────────────────────

      /** A web command the relay handles under its lock, once Repo access allows it. */
      type RelayedCommand = Exclude<
        WebToHub,
        {
          readonly _tag:
            | "CheckAppPermissions"
            | "CheckRepo"
            | "SetClaudeCredential"
            | "RemoveClaudeCredential"
        }
      >

      const receiveWeb = (client: WebClient): Receive<WebToHub> => {
        const { you, peer } = client
        const refuse = (
          message: WebToHub,
          why: string,
          about: { readonly sessionId?: SessionId; readonly requestId?: RequestId } = {
            ...("sessionId" in message ? { sessionId: message.sessionId } : {}),
            ...("requestId" in message ? { requestId: message.requestId } : {}),
          },
        ) => peer.send(CommandFailed.make({ command: message._tag, message: why, ...about }))

        /**
         * What Repo access says of a command (ADR 0003), asked off the lock: what GitHub said, to
         * record under it, and why the command is refused, if it is. A Session in a Repo the
         * person has no access to is refused as if there were no such Session, and a command about
         * a Repo, creating a Session or about its Environment (#104), alike whether the Repo
         * exists or not. Leaving a Session or closing its terminal needs no access, nor do Runner
         * commands or shared variables, which are no Repo's: there are no roles (ADR 0009).
         */
        const authorize = Effect.fn("SessionRelay.authorize")(function* (
          message: RelayedCommand,
        ): Effect.fn.Return<AccessVerdict, SqlError> {
          if (isRunnerCommand(message)) return {}
          let repo: string
          let refusal: string
          switch (message._tag) {
            case "WebHello":
            case "LeaveSession":
            case "CloseTerminal":
            case "GetSharedVariables":
            case "SetSharedVariable":
            case "DeleteSharedVariable":
            case "UpdateRunner":
              return {}
            case "StartTestBuild":
              return yield* authorizeTestBuild(message.repo)
            case "CreateSession":
            case "GetEnvironment":
            case "CheckEnvironmentDraft":
            case "ApplyEnvironment":
              repo = message.repo
              refusal = noRepoAccess(repo)
              break
            default: {
              const session = yield* sessions.get(message.sessionId)
              // Refused as no such Session, under the lock.
              if (Option.isNone(session)) return {}
              repo = session.value.repo
              refusal = "There is no such Session."
            }
          }
          const checked = yield* access.check(you, repo).pipe(
            Effect.map((allowed) => ({ allowed })),
            Effect.catchTag("RepoAccessUnknown", (error) =>
              Effect.succeed({ unknown: error.message }),
            ),
          )
          if ("allowed" in checked) {
            return {
              learned: { repo, allowed: checked.allowed },
              ...(!checked.allowed && { refusal }),
            }
          }
          // When GitHub can't say, the person keeps what they had.
          if (client.repos.get(repo) === true) return {}
          yield* Effect.logWarning(checked.unknown)
          return {
            refusal:
              "sessionId" in message
                ? "Could not check your access on GitHub; try again."
                : checked.unknown,
          }
        })

        /**
         * Repo access for a Test build; and, for a dev login, which has access whatever GitHub
         * says, that the GitHub App is installed on the Repo to clone it with (a GitHub sign-in
         * has access only where it is).
         */
        const authorizeTestBuild = Effect.fn("SessionRelay.authorizeTestBuild")(function* (
          repo: RepoName,
        ): Effect.fn.Return<AccessVerdict> {
          const status = yield* access
            .status(you, repo)
            .pipe(
              Effect.catchTag("RepoAccessUnknown", (error) =>
                Effect.as(Effect.logWarning(error.message), { unknown: error.message }),
              ),
            )
          if (status === "Allowed") return { learned: { repo, allowed: true } }
          if (status === "NotInstalled" && you.id.startsWith("dev:")) {
            return { learned: { repo, allowed: true }, refusal: notInstalledForTestBuild(repo) }
          }
          if (typeof status === "string") {
            return { learned: { repo, allowed: false }, refusal: noRepoAccess(repo) }
          }
          // When GitHub can't say, the person keeps what they had.
          if (client.repos.get(repo) === true) return {}
          return { refusal: status.unknown }
        })

        /** The Session a command names, or none, having refused the command. */
        const sessionFor = Effect.fn(function* (message: WebToHub & { sessionId: SessionId }) {
          const session = yield* sessions.get(message.sessionId)
          if (Option.isNone(session)) {
            refuse(message, "There is no such Session.", { sessionId: message.sessionId })
          }
          return session
        })

        const handle = Effect.fn("SessionRelay.receiveWeb")(function* (message: RelayedCommand) {
          if (isEnvironmentCommand(message))
            return yield* environmentRelay.receiveWeb(client, message)
          if (isRunnerCommand(message)) return yield* runnerRelay.receiveWeb(client, message)
          switch (message._tag) {
            case "WebHello":
              return

            case "UpdateRunner": {
              const { requestId, runnerId } = message
              const refused = yield* runnerUpdates.request(runnerId, {
                now: message.now,
                by: you,
              })
              if (refused !== undefined) return refuse(message, refused, { requestId })
              return peer.send(RunnerUpdateRequested.make({ requestId, runnerId }))
            }

            case "CreateSession": {
              const { requestId } = message
              const runner =
                message.runnerId === undefined
                  ? onlineRunners.values().next().value
                  : onlineRunners.get(message.runnerId)
              if (runner === undefined) {
                return refuse(
                  message,
                  message.runnerId === undefined
                    ? "No Runner is online."
                    : `Runner ${message.runnerId} is not online.`,
                  { requestId },
                )
              }
              const behind = runnerRefusal(runner)
              if (behind !== undefined) return refuse(message, behind, { requestId })
              const model = yield* checkModel(runner.id, message)
              if (typeof model === "string") return refuse(message, model, { requestId })
              // Repo access was checked before the lock was taken.
              // TODO: check that the base branch exists, once the GitHub App can tell.
              const created = yield* startNew({
                repo: message.repo,
                baseBranch: message.baseBranch,
                runner,
                creator: you,
                why: { by: you, message: `Started on ${runner.name} from ${message.baseBranch}` },
                model: model.setting,
                created: (session) =>
                  peer.send(
                    HubToWeb.cases.SessionCreated.make({ requestId, session: forWeb(session) }),
                  ),
              })
              if (typeof created === "string") return refuse(message, created, { requestId })
              return
            }

            case "JoinSession": {
              const { sessionId } = message
              const session = yield* sessionFor(message)
              if (Option.isNone(session)) return
              const entries = yield* log.history(sessionId, message.afterSeq)
              peer.send(HubToWeb.cases.SessionHistory.make({ sessionId, entries }))
              const start = starts.get(sessionId)
              if (start !== undefined && start.log !== "") {
                peer.send(
                  SessionStartLogged.make({
                    sessionId,
                    since: start.since,
                    data: start.log,
                    replace: true,
                  }),
                )
              }
              const before = presenceOf(sessionId)
              client.joined.add(sessionId)
              peer.send(
                PromptQueueChanged.make({ sessionId, queue: yield* prompts.list(sessionId) }),
              )
              if (!(yield* presenceChanged(sessionId, before))) {
                peer.send(PresenceChanged.make({ sessionId, participants: before }))
              }
              return
            }

            case "LeaveSession": {
              const before = presenceOf(message.sessionId)
              client.joined.delete(message.sessionId)
              yield* presenceChanged(message.sessionId, before)
              return
            }

            case "SendPrompt": {
              const { sessionId } = message
              const session = yield* sessionFor(message)
              if (Option.isNone(session)) return
              // A Frozen Session's prompts wait in the queue for its Runner to return.
              if (session.value.state === "Archived") {
                return refuse(message, "The Session is archived: restore it to send prompts.", {
                  sessionId,
                })
              }
              yield* prompts.add(
                sessionId,
                QueuedPrompt.make({
                  id: PromptId.make(randomId()),
                  text: message.text,
                  sender: you,
                  queuedAt: yield* Clock.currentTimeMillis,
                }),
              )
              yield* queueChanged(sessionId)
              if (session.value.state === "Asleep") {
                const refused = yield* wake(session.value, { by: you })
                if (refused !== undefined) {
                  return refuse(message, `Your prompt waits in the queue. ${refused}`, {
                    sessionId,
                  })
                }
              } else {
                yield* deliverNext(sessionId)
              }
              return
            }

            case "SleepSession": {
              const { sessionId } = message
              const session = yield* sessionFor(message)
              if (Option.isNone(session)) return
              if (stopping.has(sessionId)) return
              if (session.value.state !== "Active") {
                return refuse(
                  message,
                  `Only an Active Session can be put to sleep; this one is ${session.value.state}.`,
                  { sessionId },
                )
              }
              if (starts.has(sessionId)) {
                return refuse(
                  message,
                  "The Session is still starting; put it to sleep once it has started.",
                  { sessionId },
                )
              }
              if (session.value.currentTurn !== null) {
                return refuse(message, "A Turn is running: stop it first.", { sessionId })
              }
              if (inFlight.has(sessionId) || (yield* prompts.list(sessionId)).length > 0) {
                return refuse(message, "Prompts are waiting in the Session's queue.", {
                  sessionId,
                })
              }
              return yield* putToSleep(session.value, { by: you, message: "Put to sleep" })
            }

            case "WakeSession": {
              const { sessionId } = message
              const session = yield* sessionFor(message)
              if (Option.isNone(session)) return
              switch (session.value.state) {
                case "Asleep": {
                  const refused = yield* wake(session.value, { by: you })
                  if (refused !== undefined) return refuse(message, refused, { sessionId })
                  return
                }
                case "Active":
                  if (stopping.has(sessionId)) {
                    return refuse(
                      message,
                      "The Session is still going to sleep; wake it once it is Asleep.",
                      { sessionId },
                    )
                  }
                  return
                case "Frozen":
                  return refuse(
                    message,
                    "The Session is Frozen: its Runner is offline. It wakes when the Runner returns, if prompts are waiting.",
                    { sessionId },
                  )
                case "Archived":
                  return refuse(message, "The Session is archived.", { sessionId })
              }
              return
            }

            case "RestartSession": {
              // Recreates the Sandbox from the Repo's latest Environment version (ADR 0009).
              const { sessionId } = message
              const session = yield* sessionFor(message)
              if (Option.isNone(session)) return
              if (restarts.has(sessionId)) {
                return refuse(message, "The Session is already restarting.", { sessionId })
              }
              switch (session.value.state) {
                case "Asleep": {
                  // Set first, so the woken Session shows it is restarting.
                  restarts.set(sessionId, { by: you, since: yield* Clock.currentTimeMillis })
                  const refused = yield* wake(session.value, { by: you })
                  if (!starts.has(sessionId)) restarts.delete(sessionId)
                  if (refused !== undefined) return refuse(message, refused, { sessionId })
                  return
                }
                case "Active":
                  if (starts.has(sessionId)) {
                    // Its Sandbox is being made from the version it was sent: restarting now
                    // would only start it again behind this start.
                    return refuse(
                      message,
                      "The Session is still starting; restart it once it has started.",
                      { sessionId },
                    )
                  }
                  if (stopping.has(sessionId)) {
                    return refuse(
                      message,
                      "The Session is going to sleep; wake it once it is Asleep.",
                      { sessionId },
                    )
                  }
                  if (session.value.currentTurn !== null || inFlight.has(sessionId)) {
                    return refuse(message, "A Turn is running: stop it first, then restart.", {
                      sessionId,
                    })
                  }
                  if (!onlineRunners.has(session.value.runnerId)) {
                    return refuse(message, "The Session's Runner is offline.", { sessionId })
                  }
                  restarting.set(sessionId, you)
                  restarts.set(sessionId, { by: you, since: yield* Clock.currentTimeMillis })
                  yield* putToSleep(session.value, {
                    by: you,
                    message: "Restarting for the Environment's latest version",
                  })
                  // Nothing in the log says so until it is Asleep: the summary does.
                  return yield* sessionUpdated(sessionId)
                case "Frozen":
                  return refuse(
                    message,
                    "The Session is Frozen: its Runner is offline. Restart it once the Runner returns.",
                    { sessionId },
                  )
                case "Archived":
                  return refuse(message, "The Session is archived.", { sessionId })
              }
              return
            }

            case "ArchiveSession": {
              // Anyone with access to the Session's Repo may (ADR 0003).
              const { sessionId } = message
              const session = yield* sessionFor(message)
              if (Option.isNone(session)) return
              if (session.value.state === "Archived") {
                return refuse(message, "The Session is already archived.", { sessionId })
              }
              return yield* archive(session.value, you)
            }

            case "RenameSession": {
              // Anyone with access to the Session's Repo may, in any state (#120).
              const { sessionId } = message
              const session = yield* sessionFor(message)
              if (Option.isNone(session)) return
              const renamed = sessionNameFrom(message.name)
              if (typeof renamed === "string") return refuse(message, renamed, { sessionId })
              if ((session.value.name ?? null) === renamed.name) return
              yield* sessions.setName(sessionId, renamed.name)
              return yield* sessionUpdated(sessionId)
            }

            case "SetSessionModel": {
              // Anyone with access to the Session's Repo may, in any state but Archived (#128).
              const { sessionId } = message
              const session = yield* sessionFor(message)
              if (Option.isNone(session)) return
              if (session.value.state === "Archived") {
                return refuse(message, "The Session is archived: restore it to change its model.", {
                  sessionId,
                })
              }
              const checked = yield* checkModel(session.value.runnerId, message)
              if (typeof checked === "string") return refuse(message, checked, { sessionId })
              const { setting } = checked
              if (
                session.value.model === setting.model &&
                session.value.effort === setting.effort
              ) {
                return
              }
              // A running Claude Code is started again with it once no Turn runs (`relaunch`); one
              // that isn't running starts with it when it wakes.
              const running = session.value.state === "Active" || session.value.state === "Frozen"
              yield* sessions.setModel(sessionId, setting, running)
              yield* logEvent(
                sessionId,
                ModelSwitched.make({
                  by: you,
                  ...setting,
                  ...(checked.label !== undefined && { modelLabel: checked.label }),
                }),
              )
              yield* sessionUpdated(sessionId)
              return yield* deliverNext(sessionId)
            }

            case "RestoreSession": {
              const { sessionId } = message
              const session = yield* sessionFor(message)
              if (Option.isNone(session)) return
              const archived = session.value.archived
              if (session.value.state !== "Archived" || archived === undefined) {
                return refuse(message, "The Session is not archived.", { sessionId })
              }
              if (Option.isNone(yield* runners.get(session.value.runnerId))) {
                return refuse(
                  message,
                  "The Session's Runner was removed from the Hub, so it can't be restored.",
                  { sessionId },
                )
              }
              if ((yield* Clock.currentTimeMillis) >= archived.purgeAt) {
                return refuse(message, "The Session is past restoring: it is being purged.", {
                  sessionId,
                })
              }
              return yield* restore(session.value, you)
            }

            case "CancelPrompt": {
              const { sessionId, promptId } = message
              if (Option.isNone(yield* sessionFor(message))) return
              if (inFlight.get(sessionId) === promptId) {
                return refuse(message, "The prompt was already delivered to Claude Code.", {
                  sessionId,
                })
              }
              const removed = yield* prompts.remove(sessionId, promptId)
              if (Option.isNone(removed)) {
                return refuse(message, "The prompt is not in the Prompt queue.", { sessionId })
              }
              yield* queueChanged(sessionId)
              return
            }

            case "StopTurn": {
              const { sessionId } = message
              const session = yield* sessionFor(message)
              if (Option.isNone(session)) return
              if (session.value.state === "Archived") {
                return refuse(message, "The Session is archived: no Turn is running.", {
                  sessionId,
                })
              }
              yield* logEvent(sessionId, TurnStopRequested.make({ by: you }))
              yield* outbox.enqueue(sessionId, StopTurn.make({ sessionId }))
              return
            }

            case "OpenTerminal": {
              // Watching needs no running terminal: frames come once there is one, starting
              // with the snapshot the Runner sends when it attaches to a started Session, or
              // re-attaches after it reconnects.
              const session = yield* sessionFor(message)
              if (Option.isNone(session)) return
              if (session.value.state === "Archived") {
                return refuse(message, "The Session is archived: it has no terminal to open.", {
                  sessionId: message.sessionId,
                })
              }
              client.terminals.add(message.sessionId)
              const runner = onlineRunners.get(session.value.runnerId)
              if (session.value.state === "Active" && runner !== undefined) {
                runner.peer.send(RequestTerminalSnapshot.make({ sessionId: message.sessionId }))
              }
              return
            }

            case "CloseTerminal":
              client.terminals.delete(message.sessionId)
              return

            case "TerminalInput":
            case "TerminalResize": {
              // Keystrokes reach only a running Claude Code, from someone watching its terminal.
              const { sessionId } = message
              const session = yield* sessionFor(message)
              if (Option.isNone(session)) return
              if (!client.terminals.has(sessionId)) {
                return refuse(message, "Open the Session's terminal first.", { sessionId })
              }
              const runner = onlineRunners.get(session.value.runnerId)
              if (session.value.state !== "Active" || runner === undefined) {
                return refuse(
                  message,
                  `The Session is ${session.value.state}: its terminal isn't running.`,
                  { sessionId },
                )
              }
              runner.peer.send(message)
              return
            }
          }
        })

        /**
         * Stores or removes the person's Claude credential (ADR 0015), off the lock since a check
         * waits on Anthropic. Then, under it, every connection of theirs is sent what they can
         * see of it, the asker with its `requestId`, and their Sessions with whose account they
         * run on; and what Sessions print is redacted of it from now on.
         */
        const claudeCredentialCommand = (
          message: Extract<
            WebToHub,
            { readonly _tag: "SetClaudeCredential" | "RemoveClaudeCredential" }
          >,
        ) =>
          Effect.gen(function* () {
            const { requestId } = message
            const changed =
              message._tag === "SetClaudeCredential"
                ? yield* claudeCredentials.set(you.id, message.secret, message.plan)
                : yield* Effect.as(claudeCredentials.remove(you.id), { info: undefined })
            yield* serialized(
              Effect.gen(function* () {
                needlesByRepo.clear()
                // The asker gets its answer, with any warning; their other tabs, just the change.
                const credential = changed.info ?? null
                for (const other of webClients) {
                  if (other.you.id === you.id && other !== client)
                    other.peer.send(ClaudeCredentialState.make({ credential }))
                }
                peer.send(
                  ClaudeCredentialState.make({
                    requestId,
                    credential,
                    ...("warning" in changed && changed.warning !== undefined
                      ? { warning: changed.warning }
                      : {}),
                  }),
                )
                for (const session of yield* sessions.list) {
                  if (session.creator.id === you.id) yield* sessionToWeb(session)
                }
              }),
            )
          }).pipe(
            Effect.catchTags({
              ClaudeCredentialRefusal: (error) => Effect.sync(() => refuse(message, error.message)),
              SqlError: (error) =>
                Effect.logError("A Claude credential command failed", error).pipe(
                  Effect.andThen(
                    Effect.sync(() => refuse(message, "The Hub could not do that; try again.")),
                  ),
                ),
            }),
          )

        /**
         * Checks the GitHub App's permissions now, off the lock since it waits on GitHub. Anyone
         * signed in may ask: it changes nothing, and checks no more often than checkSpacing.
         */
        const checkAppPermissions = (requestId: RequestId) =>
          drift.check.pipe(
            Effect.match({
              onFailure: (error) =>
                peer.send(
                  CommandFailed.make({
                    command: "CheckAppPermissions",
                    message: error.message,
                    requestId,
                  }),
                ),
              onSuccess: (check) => peer.send(AppPermissionsChecked.make({ requestId, check })),
            }),
          )

        /**
         * Checks a Repo as it is entered (#104), off the lock since it waits on GitHub: whether the
         * person has access, recorded as any check is, and if not, why.
         */
        const checkRepo = Effect.fn("SessionRelay.checkRepo")(function* (
          message: Extract<WebToHub, { readonly _tag: "CheckRepo" }>,
        ) {
          const { requestId, repo } = message
          if (message.fresh === true) yield* access.forget(you, repo)
          const checked = yield* Effect.result(access.status(you, repo))
          if (checked._tag === "Failure") {
            yield* Effect.logWarning(checked.failure.message)
            return refuse(message, checked.failure.message)
          }
          const status = checked.success
          // A dev login's access doesn't hang on the App being installed.
          const allowed =
            status === "Allowed" || (you.id.startsWith("dev:") && status === "NotInstalled")
          yield* serialized(accessKnown(you, repo, allowed))
          const installUrl =
            status === "NotInstalled" && app.isConfigured
              ? yield* app.installUrl.pipe(
                  Effect.map(Option.some),
                  Effect.catchTag("GitHubAppError", (error) =>
                    Effect.as(Effect.logWarning(error.message), Option.none<string>()),
                  ),
                )
              : Option.none<string>()
          peer.send(
            RepoChecked.make({
              requestId,
              repo,
              status,
              ...(Option.isSome(installUrl) && { installUrl: installUrl.value }),
            }),
          )
        })

        return (message) =>
          message._tag === "SetClaudeCredential" || message._tag === "RemoveClaudeCredential"
            ? claudeCredentialCommand(message)
            : message._tag === "CheckAppPermissions"
              ? checkAppPermissions(message.requestId)
              : message._tag === "CheckRepo"
                ? checkRepo(message).pipe(
                    Effect.catchTag("SqlError", (error) =>
                      Effect.logError("A Repo check failed", error).pipe(
                        Effect.andThen(
                          Effect.sync(() =>
                            refuse(message, "The Hub could not do that; try again."),
                          ),
                        ),
                      ),
                    ),
                  )
                : authorize(message).pipe(
                    Effect.flatMap((verdict) =>
                      serialized(
                        Effect.gen(function* () {
                          const { learned, refusal } = verdict
                          if (learned !== undefined)
                            yield* accessKnown(you, learned.repo, learned.allowed)
                          if (refusal !== undefined) return refuse(message, refusal)
                          return yield* handle(message)
                        }),
                      ),
                    ),
                    Effect.catchTag("SqlError", (error) =>
                      Effect.logError("A web command failed", error).pipe(
                        Effect.andThen(
                          Effect.sync(() =>
                            refuse(message, "The Hub could not do that; try again."),
                          ),
                        ),
                      ),
                    ),
                  )
      }

      const connectWeb = (you: Participant, peer: Peer<HubToWeb>) =>
        Effect.gen(function* () {
          const client: WebClient = {
            you,
            peer,
            joined: new Set(),
            terminals: new Set(),
            repos: new Map(),
          }
          yield* Effect.gen(function* () {
            // Off the lock, since it may wait on GitHub. A Repo GitHub can't say about now is
            // asked about again at the next recheck.
            const asked = new Set((yield* sessions.list).map((session) => session.repo))
            yield* Effect.forEach(
              asked,
              (repo) =>
                access.check(you, repo).pipe(
                  Effect.map((allowed) => void client.repos.set(repo, allowed)),
                  Effect.catchTag("RepoAccessUnknown", (error) => Effect.logWarning(error.message)),
                ),
              { concurrency: accessCheckConcurrency, discard: true },
            )
            yield* serialized(
              Effect.gen(function* () {
                webClients.add(client)
                peer.send(yield* runnerList)
                peer.send(yield* runnerRelay.pendingList())
                // Only the Sessions of Repos the person has access to. Archived Sessions are
                // listed too, with who archived them, for the Archived screen; the web UI leaves
                // them out of its Session list.
                const listed: Array<SessionSummary> = []
                for (const session of yield* sessions.list) {
                  if (client.repos.get(session.repo) === true) listed.push(forWeb(session))
                  // A Repo whose first Session was created meanwhile.
                  else if (!asked.has(session.repo)) yield* learnAccess(you, session.repo)
                }
                peer.send(HubToWeb.cases.SessionList.make({ sessions: listed }))
                peer.send(
                  ClaudeCredentialState.make({
                    credential: claudeCredentials.info(you.id) ?? null,
                  }),
                )
                const checked = yield* drift.latest
                if (Option.isSome(checked)) {
                  peer.send(AppPermissionsChecked.make({ check: checked.value }))
                }
              }),
            )
          }).pipe(Effect.orDie)
          yield* Effect.addFinalizer(() =>
            serialized(
              Effect.gen(function* () {
                const joined = [...client.joined]
                const before = new Map(joined.map((id) => [id, presenceOf(id)] as const))
                webClients.delete(client)
                for (const id of joined) yield* presenceChanged(id, before.get(id) ?? [])
              }),
            ).pipe(Effect.catchCause(Effect.logError)),
          )
          return receiveWeb(client)
        })

      // ── The Runner channel ───────────────────────────────────────────────

      const receiveRunner = (runner: OnlineRunner): Receive<RunnerToHub> => {
        /** The Session a message names, if it is one of this Runner's. */
        const ownSession = Effect.fn(function* (sessionId: SessionId) {
          const session = yield* sessions.get(sessionId)
          if (Option.isSome(session) && session.value.runnerId === runner.id) return session
          yield* Effect.logWarning(
            `Runner ${runner.name} spoke of a Session not its own`,
            sessionId,
          )
          return Option.none<SessionSummary>()
        })

        const handle = Effect.fn("SessionRelay.receiveRunner")(function* (message: RunnerToHub) {
          if (message._tag === "RunnerHello") return
          if (
            message._tag === "UpdateChecked" ||
            message._tag === "UpdateProgress" ||
            message._tag === "UpdateFailed"
          ) {
            return yield* runnerUpdates.receive(runner.id, message)
          }
          if (
            message._tag === "FetchVariables" ||
            message._tag === "TestBuildLog" ||
            message._tag === "TestBuildFinished"
          ) {
            return yield* environmentRelay.receiveRunner(runner, message)
          }
          if (message._tag === "FetchClaudeCredential") {
            // Only for a Session this Runner runs (ADR 0015): its Creator's credential, if any.
            const { requestId } = message
            const session = yield* ownSession(message.sessionId)
            if (Option.isNone(session) || session.value.state === "Archived") {
              return runner.peer.send(
                ClaudeCredentialRefused.make({
                  requestId,
                  message: "Not a Session this Runner runs.",
                }),
              )
            }
            const credential = claudeCredentials.credentialOf(session.value.creator.id)
            return runner.peer.send(
              ClaudeCredentialFetched.make({
                requestId,
                ...(credential !== undefined && { credential }),
              }),
            )
          }
          if (message._tag === "FetchCloneAccess") {
            const { requestId } = message
            const repo = environmentRelay.testBuildRepo(runner, message.testBuildId)
            if (repo === undefined) {
              yield* Effect.logWarning(
                `Runner ${runner.name} asked to clone a Test build not its own`,
                message.testBuildId,
              )
              return runner.peer.send(
                GitReply.make({
                  requestId,
                  answer: GitAnswer.cases.GitFailed.make({
                    message: "Not a Test build this Runner runs.",
                  }),
                }),
              )
            }
            // Answered off the lock: it may wait on GitHub.
            yield* sessionGit.cloneAccess(repo).pipe(
              Effect.flatMap((answer) =>
                Effect.sync(() => runner.peer.send(GitReply.make({ requestId, answer }))),
              ),
              Effect.forkIn(layerScope),
            )
            return
          }
          if (message._tag === "SessionPurged") {
            // The Session is gone from the Hub by now; only the note to purge it is left.
            if (!(yield* sessions.purgeDone(message.sessionId, runner.id))) {
              yield* Effect.logWarning(
                `Runner ${runner.name} purged a Session the Hub wasn't purging`,
                message.sessionId,
              )
            }
            return
          }
          const session = yield* ownSession(message.sessionId)
          if (Option.isNone(session)) return
          switch (message._tag) {
            case "SessionStarted":
              // A start that raced an archive: the StopSession that follows settles it.
              if (session.value.state === "Archived" || archiving.has(message.sessionId)) return
              starts.delete(message.sessionId)
              restarts.delete(message.sessionId)
              yield* sessions.setLastOutput(message.sessionId, null)
              yield* sessions.setEnvironmentVersion(
                message.sessionId,
                message.environmentVersion ?? null,
              )
              yield* changeState(session.value, "Active", {
                message: `Claude Code started on ${runner.name}`,
              })
              if (session.value.state === "Active") yield* sessionUpdated(message.sessionId)
              yield* deliverNext(message.sessionId)
              return
            case "SessionStartFailed":
              // Asleep, with why in its history; queued prompts wait for the next wake.
              yield* sessions.setLastOutput(message.sessionId, null)
              return yield* claudeGone(session.value, {
                message: `Claude Code could not start on ${runner.name}: ${message.message}`,
              })
            case "SessionStopped": {
              if (archiving.delete(message.sessionId)) {
                if (session.value.state === "Archived") {
                  // Stopped for good: its Sandbox is destroyed.
                  yield* sessions.setArchiveStopped(message.sessionId)
                  return yield* claudeGone(session.value, {})
                }
                // Restored meanwhile: Asleep on a destroyed Sandbox, and woken if prompts wait.
                yield* claudeGone(session.value, {})
                return yield* wakeIfWaiting(message.sessionId)
              }
              const asked = stopping.get(message.sessionId)
              const restartBy = asked === undefined ? undefined : restarting.get(message.sessionId)
              // What Claude Code printed before it exited on its own (#105), redacted as its
              // terminal is: a Sensitive value it printed must not reach the summary.
              yield* sessions.setLastOutput(
                message.sessionId,
                message.reason === "Exited" && message.output !== undefined && message.output !== ""
                  ? lastOutputText(yield* needlesFor(session.value.repo), message.output)
                  : null,
              )
              yield* claudeGone(
                session.value,
                asked ?? {
                  message:
                    message.reason === "Requested"
                      ? "Claude Code stopped"
                      : `Claude Code exited${message.exitCode === undefined ? "" : ` with code ${message.exitCode}`}`,
                },
                restartBy !== undefined,
              )
              if (restartBy !== undefined) {
                const stopped = yield* sessions.get(message.sessionId)
                if (Option.isSome(stopped)) yield* wake(stopped.value, { by: restartBy })
                // Not woken after all, as for an archive meanwhile: the restart is over.
                if (!starts.has(message.sessionId) && restarts.delete(message.sessionId)) {
                  yield* sessionUpdated(message.sessionId)
                }
                return
              }
              // A prompt sent while it was going to sleep wakes it again.
              if (asked !== undefined) yield* wakeIfWaiting(message.sessionId)
              return
            }
            case "SandboxStateReport":
              if (message.state === "Failed") {
                return yield* claudeGone(session.value, {
                  message: `The Sandbox failed${message.message === undefined ? "" : `: ${message.message}`}`,
                })
              }
              // The Hub follows Claude Code, which stops before its Sandbox and starts after it:
              // the other Sandbox states are for the Runner's log.
              return yield* Effect.logDebug(`Sandbox of ${message.sessionId}: ${message.state}`)
            case "TerminalFrame":
              return yield* terminalFrame(session.value.repo, message)
            case "GitRequest":
              // Answered off the lock: it may wait on GitHub.
              yield* sessionGit.answer(session.value, message.ask).pipe(
                Effect.flatMap((answer) =>
                  Effect.sync(() => {
                    // Redacted before the Sandbox has it.
                    if (answer._tag === "SandboxToken") {
                      sandboxTokenMinted(session.value, Redacted.value(answer.token))
                    }
                    runner.peer.send(GitReply.make({ requestId: message.requestId, answer }))
                  }),
                ),
                Effect.forkIn(layerScope),
              )
              return
            case "WipPushFailed":
              yield* Effect.logWarning(
                `Runner ${runner.name} could not push the WIP ref of ${message.sessionId}: ${message.message}`,
              )
              return yield* logEvent(
                message.sessionId,
                WipNotPushed.make({ message: message.message }),
              )
            case "SandboxNote":
              return yield* logEvent(
                message.sessionId,
                SandboxNoted.make({ message: message.message }),
              )
          }
        })

        /** Messages after which a draining Runner may have a Session to put to sleep, or none left. */
        const settles = new Set<RunnerToHub["_tag"]>([
          "SessionStarted",
          "SessionStartFailed",
          "SessionStopped",
        ])
        return (message) =>
          serialized(
            settles.has(message._tag)
              ? Effect.andThen(handle(message), runnerUpdates.drain(runner.id))
              : handle(message),
          ).pipe(
            Effect.catchTag("SqlError", (error) =>
              Effect.logError(`A message from Runner ${runner.name} failed`, error),
            ),
          )
      }

      const connectRunner = (
        identity: RunnerIdentity,
        hello: RunnerHello,
        peer: Peer<HubToRunner>,
      ) =>
        Effect.gen(function* () {
          const runner: OnlineRunner = {
            id: identity.runnerId,
            name: identity.name,
            login: hello.login,
            peer,
            asksCloneAccess: hello.asksCloneAccess === true,
            version: hello.version,
            updater: hello.updater,
            relaunches: hello.relaunches === true,
            ownClaudeCredential: hello.ownClaudeCredential !== false,
          }
          yield* serialized(
            Effect.gen(function* () {
              onlineRunners
                .get(runner.id)
                ?.peer.close(RelayCloseCode.Replaced, "Replaced by a newer connection")
              onlineRunners.set(runner.id, runner)
              yield* runners.recordHello(
                runner.id,
                {
                  login: runner.login,
                  version: hello.version,
                  updater: hello.updater,
                  models: hello.models,
                },
                yield* Clock.currentTimeMillis,
              )
              // Settles an update it restarted for, before its Sessions wake.
              yield* runnerUpdates.hello(runner, hello.lastUpdate)
              toWeb(yield* runnerList)
              const running = new Set(hello.sessions)
              // Sessions purged while it was away, and archived ones it hasn't stopped yet.
              for (const sessionId of yield* sessions.pendingPurges(runner.id)) {
                peer.send(PurgeSession.make({ sessionId }))
              }
              const unstopped = new Set(yield* sessions.unstoppedArchives(runner.id))
              for (const session of yield* sessions.listByRunner(runner.id)) {
                if (session.state === "Archived") {
                  if (unstopped.has(session.id) || running.has(session.id)) {
                    stopForArchive(runner, session.id)
                  }
                  continue
                }
                if (running.has(session.id)) {
                  yield* changeState(session, "Active", { message: `${runner.name} is back` })
                  yield* deliverNext(session.id)
                } else {
                  if (session.state !== "Asleep") {
                    yield* claudeGone(session, {
                      message: `${runner.name} is back; Claude Code is not running there`,
                    })
                  }
                  // Prompts queued while it was Frozen wake it.
                  yield* wakeIfWaiting(session.id)
                }
              }
              // A push `claude-hub update` left drains it, now its Sessions are settled.
              yield* runnerUpdates.drain(runner.id)
            }),
          ).pipe(Effect.orDie)
          yield* Effect.addFinalizer(() =>
            serialized(
              Effect.gen(function* () {
                if (onlineRunners.get(runner.id) !== runner) return
                onlineRunners.delete(runner.id)
                yield* runnerUpdates.gone(runner.id)
                yield* runners.recordSeen(runner.id, yield* Clock.currentTimeMillis)
                yield* environmentRelay.runnerGone(runner)
                for (const session of yield* sessions.listByRunner(runner.id)) {
                  // A stop it was asked for is settled by what it says when it is back.
                  stopping.delete(session.id)
                  restarting.delete(session.id)
                  archiving.delete(session.id)
                  // A start under way is settled by what it says when it is back, too.
                  starts.delete(session.id)
                  restarts.delete(session.id)
                  if (session.state === "Active" || session.state === "Asleep") {
                    yield* changeState(session, "Frozen", {
                      message: `${runner.name} went offline`,
                    })
                  }
                }
                toWeb(yield* runnerList)
              }),
            ).pipe(Effect.catchCause(Effect.logError)),
          )
          return receiveRunner(runner)
        })

      // ── The mod channel ──────────────────────────────────────────────────

      const modHello = Effect.fn("SessionRelay.modHello")(function* (
        sessionId: SessionId,
        hello: ModHello,
      ) {
        const session = yield* sessions.get(sessionId)
        if (Option.isNone(session)) return
        yield* sessions.setClaudeSessionId(sessionId, hello.claudeSessionId)
        starting.delete(sessionId)
        yield* presenceToMod(sessionId)
        yield* deliverNext(sessionId)
      }, serialized)

      const modEvent = Effect.fn("SessionRelay.modEvent")(function* (
        sessionId: SessionId,
        event: ModEvent,
      ) {
        if (event._tag === "PromptFailed") {
          // The prompt is dropped, and its sender told: put back, it would most likely fail
          // again at once, and hold up the rest of the queue.
          if (inFlight.get(sessionId) === event.promptId) inFlight.delete(sessionId)
          const failed = yield* prompts.remove(sessionId, event.promptId)
          if (Option.isNone(failed)) return
          // Sent by another Session (ADR 0012): no person to tell.
          if (failed.value.fromSession !== undefined) {
            yield* Effect.logWarning(
              `A prompt from another Session could not be delivered to ${sessionId}: ${event.message}`,
            )
            return yield* queueChanged(sessionId)
          }
          toWeb(
            CommandFailed.make({
              command: "SendPrompt",
              sessionId,
              message: `Your prompt could not be delivered to Claude Code: ${event.message}`,
            }),
            (client) => client.you.id === failed.value.sender.id,
          )
          return yield* queueChanged(sessionId)
        }

        yield* logEvent(sessionId, event)
        if (event._tag === "TurnStarted") {
          yield* sessions.setCurrentTurn(sessionId, event.turnId)
          // A person stepped in: the loop guard counts afresh (ADR 0012).
          if (isPerson(event.sender)) yield* sessions.personPrompted(sessionId)
          if (event.promptId !== undefined) {
            if (inFlight.get(sessionId) === event.promptId) inFlight.delete(sessionId)
            const started = yield* prompts.remove(sessionId, event.promptId)
            if (Option.isSome(started)) yield* queueChanged(sessionId)
          }
          yield* sessionUpdated(sessionId)
        } else if (event._tag === "TurnEnded" && event.agentId === undefined) {
          yield* sessions.setCurrentTurn(sessionId, null)
          yield* sessionUpdated(sessionId)
          yield* turnEnded(sessionId)
          yield* reportToParent(sessionId)
        }
      })

      /** Tells the Session's Runner its Turn ended, so it pushes the WIP ref if anything changed. */
      const turnEnded = Effect.fn("SessionRelay.turnEnded")(function* (sessionId: SessionId) {
        const session = yield* sessions.get(sessionId)
        if (Option.isNone(session)) return
        onlineRunners.get(session.value.runnerId)?.peer.send(SessionTurnEnded.make({ sessionId }))
      })

      const modEvents = Effect.fn("SessionRelay.modEvents")(function* (
        sessionId: SessionId,
        events: ReadonlyArray<ModEvent>,
      ) {
        const session = yield* sessions.get(sessionId)
        if (Option.isNone(session)) {
          return yield* Effect.logWarning("Events from the mod of an unknown Session", sessionId)
        }
        for (const event of events) yield* modEvent(sessionId, event)
        yield* deliverNext(sessionId)
        // A Turn that ended may let its draining Runner's Session sleep.
        yield* runnerUpdates.drain(session.value.runnerId)
      }, serialized)

      // ── Start-up ─────────────────────────────────────────────────────────

      // No Runner is connected to a Hub that just started, so every Session waits Frozen for
      // its Runner to say hello.
      for (const session of yield* sessions.list) {
        if (session.state === "Active" || session.state === "Asleep") {
          yield* changeState(session, "Frozen", {
            message: "The Hub restarted; waiting for the Runner to reconnect",
          })
        }
      }

      yield* Effect.sleep(idleCheckInterval(config.sleepAfter)).pipe(
        Effect.andThen(serialized(sleepIdle)),
        Effect.catchCause((cause) => Effect.logError("Could not check for idle Sessions", cause)),
        Effect.forever,
        Effect.forkIn(layerScope),
      )

      yield* Effect.sleep(purgeCheckInterval(config.archiveRetention)).pipe(
        Effect.andThen(serialized(purgeDue)),
        Effect.catchCause((cause) => Effect.logError("Could not purge Archived Sessions", cause)),
        Effect.forever,
        Effect.forkIn(layerScope),
      )

      // A draining Runner's Turns are stopped at its deadline.
      yield* Effect.sleep(drainCheckInterval).pipe(
        Effect.andThen(serialized(runnerUpdates.drainAll)),
        Effect.catchCause((cause) => Effect.logError("Could not drain updating Runners", cause)),
        Effect.forever,
        Effect.forkIn(layerScope),
      )

      // As often as answers expire: access lost is noticed within twice that (see the top).
      yield* Effect.sleep(config.repoAccessTtl).pipe(
        Effect.andThen(recheckAccess),
        Effect.catchCause((cause) => Effect.logError("Could not recheck Repo access", cause)),
        Effect.forever,
        Effect.forkIn(layerScope),
      )

      // A check that found something new, for everyone connected.
      const driftChanges = yield* drift.changes
      yield* PubSub.take(driftChanges).pipe(
        Effect.map((check) => toWeb(AppPermissionsChecked.make({ check }))),
        Effect.forever,
        Effect.forkIn(layerScope),
      )

      const redeemPairing = (code: string, name: string) =>
        serialized(runnerRelay.redeem(code, name))

      return SessionRelay.of({
        connectWeb,
        connectRunner,
        redeemPairing,
        runnerOnline: (id) => onlineRunners.has(id),
        modHello,
        modEvents,
        childRequest,
      })
    }),
  )
}
