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
// - Steering (#195, ADR 0018): while a Turn runs, any Participant can hand a queued prompt to it
//   (SteerPrompt), if the Session's mod said in its hello that it steers. The prompt keeps its
//   place in the queue until the mod reports it joined the Turn (PromptSteered), and nothing else
//   is delivered meanwhile. A steer the mod reports as PromptFailed leaves the prompt where it
//   was, and whoever pressed Steer gets a CommandFailed.
// - The Session lifecycle (#12; archiving is #18):
//   - CreateSession starts a Session on a Runner, Active.
//   - Sleep: an Active Session with no Turn running, no prompt queued and no Participant present
//     for `HubConfig.sleepAfter` (or put to sleep by hand with SleepSession) is stopped: the Hub
//     sends StopSession `Sleep`, and records it Asleep when the Runner reports SessionStopped.
//   - Wake: a prompt to an Asleep Session (or WakeSession) wakes it. The Hub records it Active and
//     sends StartSession with `resume`, the Claude Code session id from the mod's last hello. The
//     prompt waits in the queue until the new mod says hello.
//   - Keep awake (SetKeepAwake, ADR 0016): anyone with access to the Repo can turn it on, and it
//     stays on, recorded with who turned it on, until someone turns it off or presses Sleep, or
//     the Session is archived. While it is on the Session is never idle, so never put to sleep
//     for it; an Asleep one is woken when it is turned on, and again whenever its Runner is back
//     from a drain or a restart (or the Hub's). A Claude Code that exits on its own leaves it
//     Asleep, as without Keep awake, rather than starting it again and again.
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
//     are waiting. A Runner that restarted under it says it has no mod token for it, and is sent
//     a new one (ModTokenReissued, #157).
//   - Archive (#18, ADR 0003): any Participant can delete a Session, which archives it at once.
//     The Hub records it Archived, with who did it and when, and sends StopSession `Archive`: the
//     Runner destroys the Sandbox and its volumes, keeping the Workspace.
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
// - Subagents (#152, ADR 0014): a Session's Claude Code starts subagents with its Agent tool, and
//   its mod reports each one. AgentStarted and AgentStatusChanged are logged and kept with the
//   Session (Sessions.ts), whose summary lists the Running and Interrupted ones; a status for an
//   agent the Hub never saw start is dropped. A Session with a Running agent is working: it isn't
//   idle, so it doesn't sleep under the agent, and a draining Runner waits for it as for a Turn.
//   When its Claude Code stops (sleep, exit, a lost Runner, a relaunch for a new model), its
//   Running agents are Interrupted.
//   - Any Participant can message an agent (MessageAgent): logged as AgentMessaged and sent to
//     the mod, which resumes one that has stopped. An Asleep Session is woken for it first. A
//     Running agent can be stopped (StopAgent). A mod that can't do either says so with
//     AgentCommandFailed, passed on to the person as a CommandFailed.
// - Open questions (#193): when Claude asks with AskUserQuestion on the main loop, the mod reports
//   QuestionAsked. The Hub logs it and keeps it as the Session's Open question (Sessions.ts), so
//   a client that reloads, or a Hub that restarts, still shows it; while it is open the Session
//   isn't idle. Any Participant may answer it (AnswerQuestion): the Hub sends the mod a
//   DeliverAnswer for the question it reported only, and the mod settles which answer came first,
//   there or at the terminal, and reports QuestionClosed, which closes it. A later answer is
//   refused, by the Hub or by the mod (AnswerFailed), saying who answered first and what. A
//   question still open when its Turn ends, or its Claude Code stops, or it is archived, is
//   closed Cancelled. What Participants pick before answering (PickAnswer) is passed to everyone
//   in the Session (QuestionPicks), in memory only.
// - The terminal mirror: frames from the Runner to the web clients watching, keystrokes back.
// - Open ports (#175, ADR 0016): while a Session is Active its Runner reports what listens in its
//   Sandbox whenever that changes, the whole list each time. The Hub keeps the latest list in
//   memory only, process names redacted, and sends it with the Session to the web. It is cleared
//   as soon as the Session is no longer Active: asleep, Frozen or Archived.
// - Git (ADR 0010): the Runner's GitRequests are answered by SessionGit, off the lock, since
//   they may wait on GitHub.
// - Environments (#47, ADR 0009): StartSession carries the Repo's Environment as last applied,
//   and the Runner reports the version it started the Session on. Environment commands, Test
//   builds and variable fetches are handled by EnvironmentRelay.ts.
// - MCP servers (#221, ADR 0020): StartSession carries an MCP server for each Installation on for
//   the Session's Repo, which its Claude Code reaches through the Gateway (GatewayRoutes.ts), and
//   the Hub records them as it sends it; RelaunchSession carries the same ones again. A change to
//   the Repo's Installations reaches the Session at its next wake or Restart; until then its
//   summary says so. MCP server commands are handled by McpServerRelay.ts.
// - Failing loudly (#216, ADR 0020): before a start or wake sends StartSession, each Installation
//   it starts with is checked, off the lock, while the Session shows as starting. One without a
//   header secret's value fails without asking its server; any other has its server sent an MCP
//   `initialize` through the Gateway's own path (Gateway.ts), waiting up to
//   HUB_MCP_SERVER_CHECK_TIMEOUT_MS. A missing value, a 401 or 403 or values the Hub can't decrypt
//   leave the Session Asleep, as a failed start does, with a SessionStateChanged naming each
//   Installation and why; its prompts stay queued for the next wake. A server that can't be
//   reached, is slow or answers another error doesn't hold the Session up: it starts, and a
//   SandboxNoted warns of each. Mid-Session, the Gateway reports a server's 401 or 403 and its own
//   409 for a value needed: each is noted in the Session once, until the Installation works again,
//   and the Session runs on.
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
//   entered, before a new Session or Environment is set up; ListRepos and ListBranches fill in
//   New Session's Repo and branch choices (ADR 0023), off the lock too. Shared variables aren't
//   any Repo's.
// - Claude credentials (ADR 0015, ClaudeCredentials.ts): each person stores their own, checked
//   with Anthropic off the lock, and is sent what they can see of it (ClaudeCredentialState)
//   after the welcome and whenever it changes. A Session runs on its Creator's, else on its
//   Runner's own: a Runner asks for it just before it starts Claude Code, and only for a Session
//   it runs. A Session neither has a credential for doesn't start: CreateSession is refused, and
//   a wake leaves it Asleep. Every credential is redacted from every Session.
// - Tunnels (#177, ADR 0016): a connection to one of an Active Session's Open ports. Once
//   TunnelRoutes.ts has checked the caller's access, `openTunnel` checks the Session can take
//   one, picks the loopback address in the port's address family, and sends its Runner an
//   OpenTunnel; Tunnels.ts pairs the client with the socket the Runner dials back. A Runner that
//   says TunnelFailed, or goes offline first, fails the tunnel.
// - CLI tokens (CliTokens.ts): each person is sent their own (CliTokenList) after the welcome and
//   whenever one is made or revoked, and may revoke them from any of their web clients.
// - Forwards (#180, ADR 0016): `kndl forward` keeps a connection per Session it forwards
//   (ForwardRoutes.ts), sent the Session whenever it changes. A forward is presence, named with
//   the machine its CLI token is named after, so it keeps the Session from being idle. One to an
//   Asleep Session wakes it. When the Session goes to sleep anyway, or is archived or purged, or
//   its person loses access or revokes the CLI token, the forward is closed, saying why.
//
// Every change runs under one lock, so a joining client's history and the live entries after it
// neither overlap nor leave a gap, and the queue's one-delivery-at-a-time rule holds. Messages to
// peers are queued on each connection without waiting (see Channels.ts), so a slow peer holds up
// no one else.

import {
  AgentMessaged,
  AgentStatusChanged,
  BranchesListed,
  type BranchChoice,
  branchesFor,
  ClaudeCredentialFetched,
  ClaudeCredentialRefused,
  ClaudeCredentialState,
  CliTokenList,
  type CliTokenId,
  CommandFailed,
  DeliverAgentMessage,
  DeliverAnswer,
  DeliverIntoTurn,
  DeliverPrompt,
  type EnvironmentVersion,
  ForwardCloseCode,
  ForwardSession,
  GitAnswer,
  GitReply,
  type HubToForward,
  type HubToRunner,
  HubToWeb,
  type ModEvent,
  type ModHello,
  type OpenPort,
  OpenQuestion,
  type Participant,
  type ParticipantId,
  type McpServerCommand,
  PresenceChanged,
  type PresentParticipant,
  PromptId,
  PromptQueueChanged,
  QueuedPrompt,
  QuestionClosed,
  QuestionPick,
  QuestionPicks,
  questionClosedText,
  type RequestId,
  RequestTerminalSnapshot,
  NeedsUpdateText,
  type RunnerHello,
  type RunnerList,
  type RunnerId,
  type RunnerToHub,
  RunnerUpdateRequested,
  sessionsRefusal,
  type SessionEvent,
  SessionEventLogged,
  type SessionInstallation,
  failureBlocksStart,
  type InstallationFailure,
  installationFailureText,
  installationsCantStartText,
  type InstallationId,
  type TerminalFrame,
  type TextDelta,
  SessionId,
  SessionRemoved,
  type SessionRestart,
  SessionStartLogged,
  type SessionState,
  SessionStateChanged,
  type SessionSummary,
  StartSession,
  type ToolCallId,
  StopAgent,
  StopSession,
  StopTurn,
  PurgeSession,
  RepoName,
  RepoAccessLost,
  RepoChecked,
  ReposListed,
  ListingUnavailable,
  TurnStopRequested,
  type WebToHub,
  cantStartText,
  AppPermissionsChecked,
  SandboxNoted,
  MaxLastOutputLength,
  sessionNameFrom,
  findModel,
  modelNotFoundText,
  ModelSwitched,
  ModTokenReissued,
  loopbackFor,
  OpenTunnel,
  RelaunchSession,
  TunnelCloseCode,
  repoKey,
  sameRepo,
} from "@kndl/protocol"
import {
  Clock,
  Context,
  Duration,
  Effect,
  Layer,
  Option,
  PubSub,
  Redacted,
  type Scope,
  Semaphore,
} from "effect"
import type { SqlError } from "effect/sql/SqlError"
import { ClaudeCredentials } from "./ClaudeCredentials.ts"
import { type CliIdentity, CliTokens } from "./CliTokens.ts"
import { closeReason } from "./CloseReason.ts"
import {
  type EnvironmentWebClient,
  isEnvironmentCommand,
  makeEnvironmentRelay,
} from "./EnvironmentRelay.ts"
import { Environments } from "./Environments.ts"
import { type Checked, Gateway } from "./Gateway.ts"
import { GitHubApp } from "./GitHubApp.ts"
import { HubConfig } from "./HubConfig.ts"
import { HubVersion } from "./HubVersion.ts"
import { makeLiveSessions, type TextStream, type Why } from "./LiveSessions.ts"
import { McpServerOAuth } from "./McpServerOAuth.ts"
import { isMcpServerCommand, makeMcpServerRelay, type McpServerRelay } from "./McpServerRelay.ts"
import { McpServers } from "./McpServers.ts"
import {
  isMemberCommand,
  type MemberCommand,
  makeMemberRelay,
  RemovedCloseCode,
} from "./MemberRelay.ts"
import { ModOutbox } from "./ModOutbox.ts"
import { ModTokens } from "./ModTokens.ts"
import type { PairingRefused, Redeemed } from "./PairingCodes.ts"
import {
  type ForwardClient,
  makePeers,
  type OnlineRunner,
  type Peer,
  type WebClient,
} from "./Peers.ts"
import { PermissionDrift } from "./PermissionDrift.ts"
import { PromptQueue } from "./PromptQueue.ts"
import {
  everything,
  holdMillis,
  type Needles,
  needlesOf,
  redactEvent,
  redactOutcome,
  redactQuestions,
  redactText,
  StreamRedactor,
} from "./Redaction.ts"
import { RepoAccess, type RepoAccessUnknown, type RepoListingUnavailable } from "./RepoAccess.ts"
import { RepoMap, uniqueRepos } from "./RepoMap.ts"
import { isRunnerCommand, makeRunnerRelay } from "./RunnerRelay.ts"
import { Runners } from "./Runners.ts"
import type { RunnerIdentity } from "./RunnerTokens.ts"
import { RunnerUpdatePush } from "./RunnerUpdatePush.ts"
import { makeRunnerUpdates } from "./RunnerUpdates.ts"
import { creatorIdentity, SessionGit } from "./SessionGit.ts"
import { SessionLog } from "./SessionLog.ts"
import { type ModelSetting, Sessions } from "./Sessions.ts"
import { randomId } from "./Tokens.ts"
import { type PendingTunnel, TunnelRefused, Tunnels } from "./Tunnels.ts"

export type { Peer } from "./Peers.ts"

/** Handles one message from a connected peer. */
export type Receive<In> = (message: In) => Effect.Effect<void>

/** Close codes the relay closes connections with. */
export const RelayCloseCode = {
  /** The Runner connected again, and its newer connection replaces this one. */
  Replaced: 4409,
} as const

/** Why, as one line: "Put to sleep by alice". */
const whyText = (why: Why) => {
  const by = why.by === undefined ? "" : ` by ${why.by.login}`
  return `${why.message ?? (by === "" ? "" : "Changed")}${by}`
}

/** How much of a start's output the Hub keeps for clients that join while it runs. */
export const startLogLimit = 64 * 1024

/**
 * A SessionStopped's `output` as the Hub keeps it (#105): redacted first, so a value cut in two by
 * the cap is still found, then its last {@link MaxLastOutputLength} characters.
 */
export const lastOutputText = (needles: Needles, output: string) =>
  redactText(needles, output).slice(-MaxLastOutputLength)

/** Whether two lists of Open ports say the same. */
const samePorts = (a: ReadonlyArray<OpenPort>, b: ReadonlyArray<OpenPort>) =>
  a.length === b.length &&
  a.every((port, i) => {
    const other = b[i]
    return (
      other !== undefined &&
      port.port === other.port &&
      port.process === other.process &&
      port.addresses.join(" ") === other.addresses.join(" ")
    )
  })

/** What presence shows of a Participant, to tell whether it changed. */
const presenceKey = (person: PresentParticipant) =>
  [person.id, ...(person.forwardingFrom ?? [])].join("\n")

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

/** Fails opening a tunnel, with the close code its client gets (ADR 0016). */
const refuseTunnel = (code: TunnelCloseCode, message: string) =>
  Effect.fail(new TunnelRefused({ code, message }))

/** What a dev login is told when a listing needs the GitHub App, which the Hub doesn't have. */
const noGitHubAppHint =
  "This needs the GitHub App, which the Hub doesn't have: set GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY_PATH on the Hub."

/** Why a command about a Repo is refused: alike whether the Repo exists or not (ADR 0003). */
const noRepoAccess = (repo: string) =>
  `You have no access to ${repo} on GitHub, or the GitHub App isn't installed on it.`

/** Why a dev login's Test build is refused: the App can't mint a token to clone it with. */
const notInstalledForTestBuild = (repo: string) =>
  `The GitHub App isn't installed on ${repo}, so a Test build can't clone it: install the App on the Repo, then try again.`

/** StartSession's and RelaunchSession's MCP servers, for the Installations (ADR 0020). */
const gatewayServers = (installations: ReadonlyArray<SessionInstallation>) =>
  installations.length === 0
    ? {}
    : {
        mcpServers: installations.map((installation) => ({
          installationId: installation.id,
          server: installation.server,
        })),
      }

/** That the Installation failed its Session, and why (#216). */
const failureOf = (
  installation: SessionInstallation,
  why: Omit<InstallationFailure, "installationId" | "installation">,
): InstallationFailure => ({
  installationId: installation.id,
  installation: installation.name,
  ...why,
  ...(installation.global === true && { global: true }),
})

/**
 * What a Session's start found failing in checking the Installation's server (#216), or in
 * authorising it before or after a refresh.
 */
const checkFailures = (
  installation: SessionInstallation,
  found: Checked,
): Array<InstallationFailure> => {
  switch (found._tag) {
    case "Answered": {
      const { status } = found.response
      if (status === 401 || status === 403) {
        return [failureOf(installation, { reason: "Rejected", status })]
      }
      if (status < 200 || status >= 300) {
        return [failureOf(installation, { reason: "Errored", status })]
      }
      return []
    }
    // A redirect isn't followed.
    case "Redirected":
      return [failureOf(installation, { reason: "Errored", status: found.status })]
    // Its token expired and its authorization server didn't answer: it may only be down.
    case "Unavailable":
    case "Unreachable":
      return [failureOf(installation, { reason: "Unreachable" })]
    // Its server refused its OAuth token, and the refreshed one too (#217).
    case "Refused":
      return [failureOf(installation, { reason: "Rejected", status: 401 })]
    case "Lost":
    case "NotConnected":
      return [failureOf(installation, { reason: "NotConnected" })]
    // One taken off the Repo meanwhile isn't started with: the Gateway refuses it. A value
    // missing, or values the Hub can't decrypt, were sure before any server was asked; found only
    // once a token is refreshed, they don't hold the start up.
    case "Off":
    case "NotActive":
    case "NeedsValue":
    case "Unreadable":
      return []
  }
}

/** StartSession's and RelaunchSession's `model` and `effort` (#128): the Session's setting. */
const modelFlags = (setting: ModelSetting): ModelSetting => ({
  ...(setting.model !== undefined && { model: setting.model }),
  ...(setting.effort !== undefined && { effort: setting.effort }),
})

/** Whether a subagent of the Session is running (ADR 0014): it is working, Turn or not. */
const hasRunningAgents = (session: SessionSummary) =>
  session.agents?.some((agent) => agent.status === "Running") === true

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
    /**
     * A person's CLI tokens changed, as at `kndl login`: their web clients are sent them,
     * and the forwards of a token revoked are closed.
     */
    readonly cliTokensChanged: (participantId: ParticipantId) => Effect.Effect<void>
    /**
     * The Members or the pending Invites changed, as when someone is admitted with an Invite
     * (#209): the Owner's web clients are sent them.
     */
    readonly membersChanged: Effect.Effect<void>
    /**
     * A `kndl forward`, once welcomed, by a caller already checked for access (#180): sends
     * it the Session, now and whenever it changes, and counts it as presence until the scope
     * closes. An Asleep Session is woken; one that can't be is closed, saying why.
     */
    readonly connectForward: (
      cli: CliIdentity,
      sessionId: SessionId,
      peer: Peer<HubToForward>,
    ) => Effect.Effect<Receive<never>, never, Scope.Scope>
    /** The Sessions `kndl forward` can pick from: the caller's that aren't Archived. */
    readonly forwardableSessions: (
      you: Participant,
    ) => Effect.Effect<ReadonlyArray<SessionSummary>, SqlError>
    /** The Session's mod said hello. */
    readonly modHello: (sessionId: SessionId, hello: ModHello) => Effect.Effect<void, SqlError>
    /** The Session's mod reported Turn events and failed deliveries, oldest first. */
    readonly modEvents: (
      sessionId: SessionId,
      events: ReadonlyArray<ModEvent>,
    ) => Effect.Effect<void, SqlError>
    /**
     * Asks the Session's Runner to open a tunnel to one of its Open ports (#177), for a caller
     * already checked for access: refused unless the Session is Active, its Runner online and
     * new enough, and something listens on the port.
     */
    readonly openTunnel: (
      sessionId: SessionId,
      port: number,
    ) => Effect.Effect<PendingTunnel, TunnelRefused | SqlError>
    /**
     * The Gateway found an Installation failing the Active Session (#216): its server refused the
     * credential, or it has no value for a header secret. Noted in the Session once, until the
     * Installation works again.
     */
    readonly installationFailed: (
      sessionId: SessionId,
      installationId: InstallationId,
      failure: Omit<InstallationFailure, "installationId" | "installation">,
    ) => Effect.Effect<void>
    /** The Gateway got a good answer through the Installation: a new failure is noted again. */
    readonly installationWorks: (sessionId: SessionId, installationId: InstallationId) => void
    /**
     * Finishes connecting an OAuth Installation (#217), as its authorization server sent the
     * person's browser back to the Hub: the Installation, and why it failed, if it did.
     */
    readonly finishMcpServerConnect: (
      you: Participant,
      response: {
        readonly state: string
        readonly code?: string
        readonly error?: string
        readonly errorDescription?: string
        readonly iss?: string
      },
    ) => Effect.Effect<{ readonly installationId?: InstallationId; readonly error?: string }>
  }
>()("@kndl/hub/SessionRelay") {
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
      const mcpServers = yield* McpServers
      const oauth = yield* McpServerOAuth
      const gateway = yield* Gateway
      const access = yield* RepoAccess
      const app = yield* GitHubApp
      const drift = yield* PermissionDrift
      const hubVersion = yield* HubVersion
      const updatePush = yield* RunnerUpdatePush
      const claudeCredentials = yield* ClaudeCredentials
      const tunnels = yield* Tunnels
      const cliTokens = yield* CliTokens
      const layerScope = yield* Effect.scope
      const lock = yield* Semaphore.make(1)
      const serialized = lock.withPermits(1)

      /** The web clients, forwards and Runners connected now (Peers.ts). */
      const peers = makePeers({ serialized })
      /** Each Session's live state, in memory only (LiveSessions.ts). */
      const live = makeLiveSessions()

      const markBusy = (sessionId: SessionId) =>
        Effect.map(Clock.currentTimeMillis, (now) => void live.lastBusy.set(sessionId, now))

      // ── Sending ──────────────────────────────────────────────────────────

      /** StartSession's Environment: the Repo's as last applied, if it has one. */
      const sessionEnvironment = Effect.fn("SessionRelay.sessionEnvironment")(function* (
        repo: string,
      ) {
        const environment = yield* environments.forSession(repo)
        return Option.isSome(environment) ? { environment: environment.value } : {}
      })

      const toWeb = (message: HubToWeb, to: (client: WebClient) => boolean = () => true) => {
        for (const client of peers.webClients) if (to(client)) client.peer.send(message)
      }
      const toJoined = (sessionId: SessionId, message: HubToWeb) =>
        toWeb(message, (client) => client.joined.has(sessionId))

      const runnerList: Effect.Effect<RunnerList, SqlError> = Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis
        return HubToWeb.cases.RunnerList.make({
          runners: (yield* runners.list).map(({ updater, models, ...runner }) => {
            const online = peers.runner(runner.id)
            const isOnline = online !== undefined
            const update = runnerUpdates.stateOf(runner.id)
            return {
              ...runner,
              isOnline,
              versionStatus: hubVersion.statusOf(runner.version),
              lastSeenAt: isOnline ? now : runner.lastSeenAt,
              ...(updater !== null && { updater }),
              ...(models !== null && { models }),
              ...(update !== undefined && { update }),
              ...(online !== undefined && { ownClaudeCredential: online.ownClaudeCredential }),
            }
          }),
        })
      })

      const runnerRelay = yield* makeRunnerRelay({
        toWeb: (message, to) => toWeb(message, to),
        runnersChanged: Effect.map(runnerList, (list) => toWeb(list)),
        disconnect: (id, code, reason) => peers.runner(id)?.peer.close(code, reason),
      })

      const memberRelay = yield* makeMemberRelay({
        toWeb: (message, to) => toWeb(message, to),
        removed: (participantId) =>
          serialized(
            Effect.gen(function* () {
              const before = peers.closeWhere(
                (peer) => peer.you.id === participantId,
                { web: RemovedCloseCode, forward: ForwardCloseCode.SignedOut },
                "You were removed from this Hub.",
              )
              for (const [id, present] of before) yield* presenceChanged(id, present)
            }),
          ),
      })

      // Runners follow the Hub's commit (#87): RunnerUpdates.ts drains a Runner and moves it.
      const runnerUpdates = makeRunnerUpdates({
        hub: hubVersion.version,
        statusOf: (version) => hubVersion.statusOf(version ?? null),
        push:
          hubVersion.version === undefined
            ? undefined
            : Option.getOrUndefined(yield* updatePush.forCommit(hubVersion.version.commit)),
        online: (id) => peers.runner(id),
        drainSessions: (id) =>
          Effect.map(sessions.listByRunner(id), (list) =>
            list.map((session) => ({
              id: session.id,
              state: session.state,
              turn:
                session.currentTurn !== null ||
                live.promptOut(session.id) ||
                hasRunningAgents(session),
              settling: live.settling(session.id),
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
       * The online Runner a Session goes to when its Creator picked none: one that can run it on
       * a Claude credential, its Creator's or its own (ADR 0015), if any can.
       */
      const anyRunnerFor = (creator: Participant): OnlineRunner | undefined => {
        const online = peers.runners()
        return (
          online.find((runner) => noClaudeCredential(creator, runner) === undefined) ?? online[0]
        )
      }

      /**
       * The Session as the web sees it: what is stored, whose Claude account it runs on, and
       * whether it is starting or restarting.
       */
      const forWeb = (session: SessionSummary): SessionSummary => {
        const start = live.starts.get(session.id)
        const restart = live.restarts.get(session.id)
        const ports = session.state === "Active" ? live.openPorts.get(session.id) : undefined
        return {
          ...session,
          ...(ports !== undefined && ports.length > 0 && { openPorts: ports }),
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
        for (const client of peers.webClients) {
          const known = client.repos.get(session.repo)
          if (known === true) client.peer.send(message)
          else if (known === undefined) yield* learnAccess(client.you, session.repo)
        }
        yield* sessionToForwards(session)
      })

      /**
       * Sends the Session to its forwards. Once it is Asleep, but for the moment of a restart, or
       * Archived, closes them instead.
       */
      const sessionToForwards = Effect.fn("SessionRelay.sessionToForwards")(function* (
        session: SessionSummary,
      ) {
        const ofSession = (forward: ForwardClient) => forward.sessionId === session.id
        if (session.state === "Archived") {
          return yield* endForwards(
            ofSession,
            ForwardCloseCode.Archived,
            "The Session was archived.",
          )
        }
        if (session.state === "Asleep" && !live.restarts.has(session.id)) {
          const why = live.asleepWhy.get(session.id)
          return yield* endForwards(
            ofSession,
            ForwardCloseCode.WentAsleep,
            why === undefined ? "" : whyText(why),
          )
        }
        const message = ForwardSession.make({ session: forWeb(session) })
        for (const forward of peers.forwards) if (ofSession(forward)) forward.peer.send(message)
      })

      /** Closes the forwards `which` picks, saying why, and updates their Sessions' presence. */
      const endForwards = Effect.fn("SessionRelay.endForwards")(function* (
        which: (forward: ForwardClient) => boolean,
        code: number,
        reason: string,
      ) {
        const before = peers.closeWhere(
          (peer) => peer.kind === "Forward" && which(peer),
          { web: code, forward: code },
          reason,
        )
        for (const [id, present] of before) yield* presenceChanged(id, present)
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
        live.startSent(sessionId, {
          since: yield* Clock.currentTimeMillis,
          environmentVersion: environment.environment?.version,
          log: "",
          attached: false,
        })
      })

      // ── Redaction (#48) ──────────────────────────────────────────────────

      /**
       * What to redact from each Repo's Sessions, until its Sensitive values, its Installations'
       * header secret values (#215) or the Sandbox tokens of its Sessions change.
       */
      const needlesByRepo = new RepoMap<Needles>()

      /**
       * Redacts the Session's new Sandbox token from now on, with the one before it. Called off
       * the lock, as a GitRequest is answered: it is synchronous, so it lands between two changes
       * under the lock, never inside one (see LiveSessions).
       */
      const sandboxTokenMinted = (session: SessionSummary, token: string) => {
        const before = live.sandboxTokens.get(session.id)?.tokens ?? []
        live.sandboxTokens.set(session.id, {
          repo: session.repo,
          tokens: [...before.slice(-1), token],
        })
        needlesByRepo.delete(session.repo)
      }

      const tokensOfRepo = (repo: string) =>
        [...live.sandboxTokens.values()].flatMap((known) =>
          sameRepo(known.repo, repo) ? known.tokens : [],
        )

      const needlesFor = Effect.fn("SessionRelay.needlesFor")(function* (repo: string) {
        const known = needlesByRepo.get(repo)
        if (known !== undefined) return known
        const unreadable = (error: { readonly message: string }) =>
          Effect.logError(
            `Could not read the Sensitive values of ${repo}: masking everything its Sessions print`,
            error,
          ).pipe(Effect.as(Option.none<ReadonlyArray<Redacted.Redacted<string>>>()))
        const values = yield* Effect.all([
          environments.sensitiveValues(repo),
          // The values of its Installations' header secrets (#215), which only the Gateway sends,
          // but which a server may echo back.
          mcpServers.valuesOn(repo),
        ]).pipe(
          Effect.map(([sensitive, headers]) =>
            Option.some<ReadonlyArray<Redacted.Redacted<string>>>([...sensitive, ...headers]),
          ),
          Effect.catchTags({
            EnvironmentRefused: unreadable,
            SecretsUnavailable: unreadable,
          }),
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
        let streams = live.textStreams.get(sessionId)
        if (streams === undefined) {
          streams = new Map()
          live.textStreams.set(sessionId, streams)
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
        const streams = live.textStreams.get(sessionId)
        if (streams !== undefined) {
          for (const stream of streams.values()) yield* letTextGo(sessionId, stream)
          if (event._tag === "TurnEnded") {
            if (event.agentId === undefined) live.textStreams.delete(sessionId)
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
          const start = live.starts.get(sessionId)
          if (start === undefined || start.attached || data === "") return
          start.log = (start.log + data).slice(-startLogLimit)
          toJoined(sessionId, SessionStartLogged.make({ sessionId, since: start.since, data }))
        }
        let stream = live.terminalStreams.get(sessionId)
        if (stream === undefined) {
          stream = { redactor: new StreamRedactor(needles), size: frame.size, flushing: false }
          live.terminalStreams.set(sessionId, stream)
        }
        stream.redactor.needles = needles
        stream.size = frame.size
        if (frame.kind === "Snapshot") {
          const start = live.starts.get(sessionId)
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

      /** Tells web clients the Repo's Sessions changed, as when its Environment has a new version. */
      const repoSessionsUpdated = Effect.fn("SessionRelay.repoSessionsUpdated")(function* (
        repo: string,
      ) {
        for (const session of yield* sessions.list) {
          if (sameRepo(session.repo, repo)) yield* sessionToWeb(session)
        }
      })

      /** Moves the Session to `state`, if it isn't there, logging why. */
      const environmentRelay = yield* makeEnvironmentRelay({
        hasGitHubApp: app.isConfigured,
        onlineRunner: (id) => peers.runner(id),
        toWeb: (message, to: (client: EnvironmentWebClient) => boolean) => toWeb(message, to),
        repoSessionsUpdated: (repo) => repoSessionsUpdated(repo),
        sensitiveValuesChanged: (repo) => {
          if (repo === undefined) needlesByRepo.clear()
          else needlesByRepo.delete(repo)
        },
        afterHold,
      })

      const mcpServerRelay: McpServerRelay = yield* makeMcpServerRelay({
        webClients: () => peers.webClients,
        serialized,
        accessKnown: (who, repo, allowed) => accessKnown(who, repo, allowed),
        repoSessionsUpdated: (repo) => repoSessionsUpdated(repo),
        // A global Installation's change reaches every Repo's Sessions (#219).
        everySessionUpdated: Effect.fn("SessionRelay.everySessionUpdated")(function* () {
          for (const session of yield* sessions.list) yield* sessionToWeb(session)
        }),
        headerValuesChanged: () => needlesByRepo.clear(),
        respell: Effect.fn("SessionRelay.respell")(function* (repo: RepoName) {
          const github = yield* access.fullName(repo)
          return Option.isSome(github)
            ? github.value
            : RepoName.make(yield* environments.storedName(repo))
        }),
      })

      const changeState = Effect.fn("SessionRelay.changeState")(function* (
        session: SessionSummary,
        state: SessionState,
        why: Why,
      ) {
        if (session.state === state) return
        // Nothing listens in a Sandbox whose Claude Code isn't known to run.
        if (state !== "Active") live.openPorts.delete(session.id)
        if (state === "Asleep") live.asleepWhy.set(session.id, why)
        yield* sessions.setState(session.id, state)
        yield* logEvent(session.id, SessionStateChanged.make({ state, ...why }))
        yield* sessionUpdated(session.id)
      })

      const queueChanged = Effect.fn("SessionRelay.queueChanged")(function* (sessionId: SessionId) {
        const queue = yield* prompts.list(sessionId)
        toJoined(sessionId, PromptQueueChanged.make({ sessionId, queue }))
        yield* markBusy(sessionId)
      })

      /** Tells the Session's mod who is present, if Claude Code may be running to hear it. */
      const presenceToMod = Effect.fn("SessionRelay.presenceToMod")(function* (
        sessionId: SessionId,
      ) {
        const session = yield* sessions.get(sessionId)
        if (Option.isNone(session) || session.value.state !== "Active") return
        yield* outbox.enqueue(
          sessionId,
          PresenceChanged.make({ sessionId, participants: peers.presenceOf(sessionId) }),
        )
      })

      /** Announces the Session's presence if it differs from `before`. */
      const presenceChanged = Effect.fn("SessionRelay.presenceChanged")(function* (
        sessionId: SessionId,
        before: ReadonlyArray<PresentParticipant>,
      ) {
        const after = peers.presenceOf(sessionId)
        const same =
          before.length === after.length &&
          before.every((p, i) => {
            const now = after[i]
            return now !== undefined && presenceKey(p) === presenceKey(now)
          })
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
      ): Effect.fn.Return<void, SqlError> {
        if (!allowed) {
          yield* endForwards(
            (forward) => forward.you.id === who.id && sameRepo(forward.repo, repo),
            ForwardCloseCode.NoSuchSession,
            `You no longer have access to ${repo}.`,
          )
        }
        const changed = [...peers.webClients].filter(
          (client) => client.you.id === who.id && client.repos.get(repo) !== allowed,
        )
        if (changed.length === 0) return
        const ofRepo = (yield* sessions.list).filter((session) => sameRepo(session.repo, repo))
        for (const client of changed) {
          const before = client.repos.get(repo)
          client.repos.set(repo, allowed)
          yield* mcpServerRelay.accessChanged(client)
          if (allowed) {
            for (const session of ofRepo) {
              client.peer.send(HubToWeb.cases.SessionUpdated.make({ session: forWeb(session) }))
            }
            continue
          }
          if (before !== true) continue
          // Their list of Repos to start a Session on no longer holds it.
          yield* access.forgetAccessible(who)
          yield* Effect.logInfo(
            `${who.login} no longer has access to ${repo}: out of its Sessions and Environment`,
          )
          client.peer.send(RepoAccessLost.make({ repo }))
          for (const session of ofRepo) {
            client.terminals.delete(session.id)
            if (client.joined.has(session.id)) {
              const presence = peers.presenceOf(session.id)
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
        const key = `${who.id}\n${repoKey(repo)}`
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
        // Each Repo once, whatever spellings it goes by.
        const repos = (yield* sessions.list).map((session) => session.repo)
        // And those someone was let into without a Session, such as an Environment being set up.
        for (const client of peers.webClients) {
          for (const [repo, allowed] of client.repos) if (allowed) repos.push(repo)
        }
        const people = new Map([...peers.webClients].map((client) => [client.you.id, client.you]))
        // And everyone forwarding a Session, who may have no web client.
        for (const forward of peers.forwards) {
          people.set(forward.you.id, forward.you)
          repos.push(forward.repo)
        }
        const unique = uniqueRepos(repos)
        const failures: Array<string> = []
        const answers = yield* Effect.forEach(
          [...people.values()].flatMap((who) => unique.map((repo) => ({ who, repo }))),
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
        if (live.blocksDelivery(sessionId)) return
        const session = yield* sessions.get(sessionId)
        if (Option.isNone(session)) return
        if (session.value.state !== "Active" || session.value.currentTurn !== null) return
        // A Runner draining for its update takes no prompts: they wait for it to be back.
        if (runnerUpdates.holding(session.value.runnerId)) return
        // A new model or effort first (#128): the prompt waits for the new mod's hello.
        if (session.value.modelPending === true && (yield* relaunch(session.value))) return
        const [head] = yield* prompts.list(sessionId)
        if (head === undefined) return
        live.delivering(sessionId, head.id)
        yield* outbox.enqueue(
          sessionId,
          DeliverPrompt.make({
            sessionId,
            promptId: head.id,
            text: head.text,
            sender: head.sender,
          }),
        )
      })

      /**
       * The Installations the Session starts with (ADR 0020): those on for its Repo, recorded as
       * the Session's, which its summary shows; StartSession carries an MCP server for each. None
       * for a Runner that doesn't relay them: its Claude Code starts without.
       */
      const startMcpServers = Effect.fn("SessionRelay.startMcpServers")(function* (
        sessionId: SessionId,
        repo: string,
        runner: OnlineRunner,
      ) {
        const installations = runner.relaysMcpServers
          ? yield* mcpServers.forSession(sessionId, repo)
          : []
        yield* sessions.setMcpServers(sessionId, installations)
        return installations
      })

      /**
       * Notes in the Session that an Installation fails it (#216), unless it already said so since
       * the Installation last worked. `after` says what that means for the Session.
       */
      const noteFailure = Effect.fn("SessionRelay.noteFailure")(function* (
        sessionId: SessionId,
        failure: InstallationFailure,
        after: string,
      ) {
        const noted = live.installationTrouble.get(sessionId) ?? new Map<InstallationId, string>()
        live.installationTrouble.set(sessionId, noted)
        const why = `${failure.reason} ${failure.status ?? ""}`
        if (noted.get(failure.installationId) === why) return
        noted.set(failure.installationId, why)
        yield* logEvent(
          sessionId,
          SandboxNoted.make({
            message: `${installationFailureText(failure)} ${after}`,
            installationFailed: failure,
          }),
        )
      })

      /**
       * Checks each Installation the Session starts with (#216), off the lock: what fails, and
       * why. A value missing, or values the Hub can't decrypt, are sure without asking a server;
       * then no server is asked. Otherwise each server is sent an MCP `initialize`, at once.
       */
      const checkInstallations = Effect.fn("SessionRelay.checkInstallations")(function* (
        sessionId: SessionId,
        repo: string,
        installations: ReadonlyArray<SessionInstallation>,
      ) {
        const starting = { starting: sessionId, repo }
        const authorised = yield* Effect.forEach(installations, (installation) =>
          Effect.map(gateway.authorise(starting, installation.id), (found) => ({
            installation,
            found,
          })),
        )
        const sure = authorised.flatMap(({ installation, found }): Array<InstallationFailure> => {
          if (found._tag === "Unreadable") {
            return [failureOf(installation, { reason: "Unreadable" })]
          }
          if (found._tag === "NeedsValue") {
            return [failureOf(installation, { reason: "ValueNeeded", secrets: found.secrets })]
          }
          // Not connected, or the connection was lost (#217): no server is asked.
          if (found._tag === "NotConnected") {
            return [failureOf(installation, { reason: "NotConnected" })]
          }
          return []
        })
        if (sure.length > 0) return sure
        const checked = yield* Effect.forEach(
          authorised,
          ({ installation, found }) =>
            found._tag === "Authorised"
              ? Effect.map(gateway.check(found, config.mcpServerCheckTimeout), (outcome) =>
                  checkFailures(installation, outcome),
                )
              : Effect.succeed(checkFailures(installation, found)),
          { concurrency: "unbounded" },
        )
        return checked.flat()
      })

      /**
       * Sends the Session its StartSession: at once when it starts with no Installations, else
       * once they are checked (#216). Meanwhile it shows as starting. One that surely can't work
       * leaves the Session Asleep instead, as a start that fails does; one whose server may only
       * be down is noted, and the Session starts.
       */
      const sendStart = Effect.fn("SessionRelay.sendStart")(function* (
        session: SessionSummary,
        runner: OnlineRunner,
        installations: ReadonlyArray<SessionInstallation>,
        start: StartSession,
      ) {
        const under = live.starts.get(session.id)
        if (installations.length === 0 || under === undefined) return runner.peer.send(start)
        const settle = (failures: ReadonlyArray<InstallationFailure>) =>
          Effect.gen(function* () {
            const now = yield* sessions.get(session.id)
            // Settled meanwhile, as by an archive or its Runner going offline.
            if (
              Option.isNone(now) ||
              now.value.state !== "Active" ||
              live.starts.get(session.id) !== under ||
              peers.runner(runner.id) !== runner
            ) {
              return
            }
            const blocking = failures.filter(failureBlocksStart)
            if (blocking.length > 0) {
              return yield* claudeGone(now.value, {
                message: `Claude Code could not start: ${installationsCantStartText(now.value.repo, blocking)}`,
                installationsFailed: blocking,
              })
            }
            for (const failure of failures) {
              yield* noteFailure(
                session.id,
                failure,
                "Claude Code started all the same: its tools fail until it answers.",
              )
            }
            runner.peer.send(start)
          })
        yield* checkInstallations(session.id, session.repo, installations).pipe(
          // A check that can't be made doesn't hold the Session up.
          Effect.catchCause((cause) =>
            Effect.as(
              Effect.logError("Could not check the Installations a Session starts with", cause),
              [],
            ),
          ),
          Effect.flatMap((failures) => serialized(settle(failures))),
          Effect.catchCause((cause) =>
            Effect.logError("Could not start a Session after checking its Installations", cause),
          ),
          Effect.annotateLogs({ sessionId: session.id }),
          Effect.forkIn(layerScope),
        )
      })

      /** See the service: the Gateway's failures, noted in the Session (#216). */
      const installationFailed = (
        sessionId: SessionId,
        installationId: InstallationId,
        why: Omit<InstallationFailure, "installationId" | "installation">,
      ) =>
        serialized(
          Effect.gen(function* () {
            const session = yield* sessions.get(sessionId)
            if (Option.isNone(session) || session.value.state !== "Active") return
            const installation = session.value.mcpServers?.find((one) => one.id === installationId)
            if (installation === undefined) return
            yield* noteFailure(
              sessionId,
              { installationId, installation: installation.name, ...why },
              why.reason === "NotConnected"
                ? "Its tools fail until it is reconnected on the MCP page."
                : "Its tools fail until the Installation is fixed and the Session restarted.",
            )
          }),
        ).pipe(
          Effect.catchCause((cause) =>
            Effect.logError("Could not note an Installation failing", cause),
          ),
          Effect.withSpan("SessionRelay.installationFailed"),
        )

      // Off the lock, as the Gateway calls it, and synchronous (see LiveSessions).
      const installationWorks = (sessionId: SessionId, installationId: InstallationId) => {
        live.installationTrouble.get(sessionId)?.delete(installationId)
      }

      /** See the service (#217). */
      const finishMcpServerConnect = (
        you: Participant,
        response: {
          readonly state: string
          readonly code?: string
          readonly error?: string
          readonly errorDescription?: string
          readonly iss?: string
        },
      ) =>
        mcpServerRelay.finishConnect(you, response).pipe(
          Effect.catchCause((cause) =>
            Effect.as(Effect.logError("Could not finish connecting an OAuth Installation", cause), {
              error: "The Hub could not keep the connection; try again.",
            }),
          ),
          Effect.withSpan("SessionRelay.finishMcpServerConnect"),
        )

      /**
       * Starts the Session's Claude Code again with its model and effort as set now (#128), once
       * they changed while it ran: Claude Code alone, resuming its conversation, its Sandbox left
       * running. Only between Turns: `deliverNext` asks, when the Session is Active and idle.
       * Whether it was sent; not to a Runner that doesn't take it, or before Claude Code's
       * conversation is known, when the setting waits for the Session's next wake instead.
       */
      const relaunch = Effect.fn("SessionRelay.relaunch")(function* (session: SessionSummary) {
        const runner = peers.runner(session.runnerId)
        if (runner === undefined || !runner.relaunches) return false
        const resume = yield* sessions.claudeSessionId(session.id)
        if (Option.isNone(resume)) return false
        // In place of the old one: the old mod has nothing more to say.
        const modToken = yield* modTokens.issue({ sessionId: session.id, runnerId: runner.id })
        // Commands the old mod didn't collect are stale, as when it sleeps.
        yield* outbox.clear(session.id)
        live.relaunched(session.id)
        yield* sessions.setModelPending(session.id, false)
        yield* Effect.logInfo(`Restarting Claude Code of ${session.id} for its new model`)
        runner.peer.send(
          RelaunchSession.make({
            sessionId: session.id,
            repo: session.repo,
            workBranch: session.workBranch,
            resume: resume.value,
            modToken,
            ...modelFlags(session),
            // The same as before: a change to the Repo's waits for its next wake or Restart.
            ...gatewayServers(session.mcpServers ?? []),
          }),
        )
        // Its agents stop with the old Claude Code.
        yield* agentsInterrupted(session.id)
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
        // Claude's held text is logged before what says it is gone, as the next event would.
        for (const stream of live.textStreams.get(session.id)?.values() ?? []) {
          yield* letTextGo(session.id, stream)
        }
        live.ended(session.id, restartGoesOn ? "ClaudeGoneRestarting" : "ClaudeGone")
        // Commands the mod didn't collect are stale: a new Claude Code starts with a new mod.
        yield* outbox.clear(session.id)
        if (session.currentTurn !== null) yield* sessions.setCurrentTurn(session.id, null)
        // Its next start takes its model and effort as set then.
        if (session.modelPending === true) yield* sessions.setModelPending(session.id, false)
        // No one can answer its question now: the next Claude Code doesn't ask it again.
        const cancelled = yield* cancelQuestion(session)
        const interrupted = yield* agentsInterrupted(session.id)
        if (session.state === "Archived") {
          if (interrupted || cancelled) yield* sessionUpdated(session.id)
          return
        }
        if (session.state === "Asleep") return yield* sessionUpdated(session.id)
        yield* changeState(session, "Asleep", why)
      })

      /**
       * The Session's Claude Code stopped: its Running agents are Interrupted (ADR 0014), each
       * logged. Whether there were any; the caller sends the SessionUpdated.
       */
      const agentsInterrupted = Effect.fn("SessionRelay.agentsInterrupted")(function* (
        sessionId: SessionId,
      ) {
        const agents = yield* sessions.interruptAgents(sessionId)
        for (const agentId of agents) {
          yield* logEvent(sessionId, AgentStatusChanged.make({ agentId, status: "Interrupted" }))
        }
        return agents.length > 0
      })

      /**
       * Wakes an Asleep Session on its online Runner: records it Active and starts its Claude
       * Code again, resuming the conversation its mod last said hello from, on the same
       * Workspace and Sandbox volumes. Queued prompts are delivered once the new mod says hello.
       */
      const wake = Effect.fn("SessionRelay.wake")(function* (
        session: SessionSummary,
        why: Why,
      ): Effect.fn.Return<string | undefined, SqlError> {
        const runner = peers.runner(session.runnerId)
        // A restored Session still being stopped for its archive wakes once it is stopped.
        if (
          runner === undefined ||
          session.state !== "Asleep" ||
          live.archiveStopping(session.id)
        ) {
          return undefined
        }
        // Its prompts wait in its queue, and wake it once its Runner is updated.
        const refusal = runnerRefusal(runner)
        if (refusal !== undefined) return refusal
        const cantStart = yield* cantStartOn(session, runner, why.by)
        if (cantStart !== undefined) {
          // Asleep, it has no start under way.
          live.restartOver(session.id)
          yield* logEvent(
            session.id,
            SessionStateChanged.make({
              state: "Asleep",
              ...why,
              message: cantStart.message,
              ...(cantStart.valuesNeeded && { valuesNeeded: true }),
            }),
          )
          yield* sessionUpdated(session.id)
          return undefined
        }
        const resume = yield* sessions.claudeSessionId(session.id)
        const environment = yield* sessionEnvironment(session.repo)
        const modToken = yield* modTokens.issue({ sessionId: session.id, runnerId: runner.id })
        const installations = yield* startMcpServers(session.id, session.repo, runner)
        yield* startSent(session.id, environment)
        // It starts with its model and effort as set now (#128).
        if (session.modelPending === true) yield* sessions.setModelPending(session.id, false)
        const woken = `Woken on ${runner.name}`
        yield* changeState(session, "Active", {
          ...why,
          message: Option.isSome(resume)
            ? woken
            : `${woken}, with a new conversation: Claude Code's last one is unknown`,
        })
        yield* sendStart(
          session,
          runner,
          installations,
          StartSession.make({
            sessionId: session.id,
            repo: session.repo,
            baseBranch: session.baseBranch,
            workBranch: session.workBranch,
            modToken,
            ...(Option.isSome(resume) ? { resume: resume.value } : {}),
            ...environment,
            gitIdentity: creatorIdentity(session.creator),
            ...modelFlags(session),
            ...gatewayServers(installations),
          }),
        )
        return undefined
      })

      /**
       * Why the Session's Claude Code can't start on `runner`: values its Environment needs are
       * unset, or there is no Claude credential to run it on. `you` is who is told.
       */
      const cantStartOn = Effect.fn("SessionRelay.cantStartOn")(function* (
        session: SessionSummary,
        runner: OnlineRunner,
        you: Participant | undefined,
      ) {
        const needed = yield* environments.valuesNeeded(session.repo)
        if (needed.length > 0) {
          return {
            message: `Claude Code could not start: ${cantStartText(session.repo, needed)}`,
            valuesNeeded: true,
          }
        }
        const noCredential = noClaudeCredential(session.creator, runner, you)
        if (noCredential !== undefined) {
          return { message: `Claude Code could not start: ${noCredential}`, valuesNeeded: false }
        }
        return undefined
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
       * Wakes the Session if it is Asleep with Keep awake on (ADR 0016), as once its Runner is back
       * from a drain or a restart. A wake its Runner refuses, as while it is Behind, waits for the
       * next time it is back.
       */
      const wakeKeptAwake = Effect.fn("SessionRelay.wakeKeptAwake")(function* (
        sessionId: SessionId,
      ) {
        const session = yield* sessions.get(sessionId)
        if (Option.isNone(session) || session.value.state !== "Asleep") return
        if (session.value.keepAwake === undefined) return
        const refused = yield* wake(session.value, { message: "Woken: Keep awake is on" })
        if (refused !== undefined) {
          yield* Effect.logInfo(`Session ${sessionId} is kept awake but can't wake: ${refused}`)
        }
      })

      /** Turns the Session's Keep awake off, as pressing Sleep does (ADR 0016). */
      const stopKeepingAwake = Effect.fn("SessionRelay.stopKeepingAwake")(function* (
        session: SessionSummary,
      ) {
        if (session.keepAwake === undefined) return
        yield* sessions.setKeepAwake(session.id, null)
        yield* sessionUpdated(session.id)
      })

      /**
       * Asks the Session's Runner to stop its Claude Code and Sandbox, keeping the Workspace and
       * the Sandbox's volumes. It stays Active, taking no deliveries, until SessionStopped.
       */
      const putToSleep = Effect.fn("SessionRelay.putToSleep")(function* (
        session: SessionSummary,
        why: Why,
        /** Who asked to restart it, and when: it is woken again once stopped (ADR 0009). */
        restart?: SessionRestart,
      ) {
        const runner = peers.runner(session.runnerId)
        if (runner === undefined || !live.stopAsked(session.id, why, restart)) return
        yield* Effect.logInfo(`Putting Session ${session.id} to sleep: ${why.message ?? ""}`)
        runner.peer.send(StopSession.make({ sessionId: session.id, reason: "Sleep" }))
      })

      /** Whether the Session is Active with nothing going on and no one there. */
      const isIdle = Effect.fn("SessionRelay.isIdle")(function* (session: SessionSummary) {
        if (session.state !== "Active" || session.currentTurn !== null) return false
        // Its agents work on after the Turn that started them (ADR 0014).
        if (hasRunningAgents(session)) return false
        // Claude waits on its question (#193), as its Turn does.
        if (session.openQuestion !== undefined) return false
        if (peers.runner(session.runnerId) === undefined) return false
        // Going to sleep, a prompt in flight, or a start, which can take minutes.
        if (live.busy(session.id)) return false
        // Someone is in it, in the web or forwarding its ports (#180).
        if (peers.presenceOf(session.id).length > 0) return false
        // Someone asked for it to stay up, as for a dev server (ADR 0016).
        if (session.keepAwake !== undefined) return false
        return (yield* prompts.list(session.id)).length === 0
      })

      /** Puts to sleep every Session that has been idle for `sleepAfter`. */
      const sleepIdle = Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis
        const sleepAfter = Duration.toMillis(config.sleepAfter)
        for (const session of yield* sessions.list) {
          if (!(yield* isIdle(session))) {
            live.lastBusy.set(session.id, now)
            continue
          }
          const since = live.lastBusy.get(session.id)
          if (since === undefined) live.lastBusy.set(session.id, now)
          else if (now - since >= sleepAfter) {
            yield* putToSleep(session, {
              message: `Idle for ${Duration.format(config.sleepAfter)}`,
            })
          }
        }
      }).pipe(Effect.withSpan("SessionRelay.sleepIdle"))

      // ── Archive, restore and purge ───────────────────────────────────────

      /** Asks the Runner to stop the Archived Session for good: its Sandbox goes, its Workspace stays. */
      const stopForArchive = (runner: OnlineRunner, sessionId: SessionId) => {
        live.archiveStopAsked(sessionId)
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
        live.ended(session.id, "Archived")
        yield* outbox.clear(session.id)
        // Its Claude Code is being stopped for good: its mod has nothing more to say.
        yield* modTokens.revoke(session.id)
        for (const client of peers.webClients) client.terminals.delete(session.id)
        yield* cancelQuestion(session)
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
        const runner = peers.runner(session.runnerId)
        if (runner !== undefined) stopForArchive(runner, session.id)
      })

      /** Brings an Archived Session back Asleep, or Frozen while its Runner is offline. */
      const restore = Effect.fn("SessionRelay.restore")(function* (
        session: SessionSummary,
        by: Participant,
      ) {
        const state = peers.runner(session.runnerId) !== undefined ? "Asleep" : "Frozen"
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
          live.ended(session.id, "Purged")
          yield* outbox.clear(session.id)
          for (const client of peers.webClients) {
            client.joined.delete(session.id)
            client.terminals.delete(session.id)
          }
          toWeb(
            SessionRemoved.make({ sessionId: session.id }),
            (client) => client.repos.get(session.repo) === true,
          )
          peers.runner(session.runnerId)?.peer.send(PurgeSession.make({ sessionId: session.id }))
        }
      }).pipe(Effect.withSpan("SessionRelay.purgeDue"))

      // ── New Sessions ─────────────────────────────────────────────────────

      /** A Session to create and start, from New Session. */
      interface NewSessionPlan {
        readonly repo: RepoName
        /** Which branch it works on; `branchesFor` makes of it its base and Work branches. */
        readonly branch: BranchChoice
        readonly runner: OnlineRunner
        /** Whom it runs for: who created it. */
        readonly creator: Participant
        /** Why it is Active, as its first SessionStateChanged says. */
        readonly why: Why
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
          ...branchesFor(plan.branch, id),
          state: "Active",
          runnerId: runner.id,
          runnerLogin: runner.login,
          creatorId: plan.creator.id,
          createdAt: yield* Clock.currentTimeMillis,
          ...modelFlags(plan.model ?? {}),
        })
        const modToken = yield* modTokens.issue({ sessionId: id, runnerId: runner.id })
        const installations = yield* startMcpServers(id, session.repo, runner)
        yield* startSent(id, environment)
        yield* logEvent(id, SessionStateChanged.make({ state: "Active", ...plan.why }))
        yield* sendStart(
          session,
          runner,
          installations,
          StartSession.make({
            sessionId: id,
            repo: session.repo,
            baseBranch: session.baseBranch,
            workBranch: session.workBranch,
            modToken,
            ...environment,
            gitIdentity: creatorIdentity(session.creator),
            ...modelFlags(session),
            ...gatewayServers(installations),
          }),
        )
        // As recorded now, with the Installations it starts with.
        const recorded = Option.getOrElse(yield* sessions.get(id), () => session)
        plan.created?.(recorded)
        toWeb(yield* runnerList)
        yield* sessionToWeb(recorded)
        return recorded
      })

      // ── The web channel ──────────────────────────────────────────────────

      /** A web command the relay handles under its lock, once Repo access allows it. */
      type RelayedCommand = Exclude<
        WebToHub,
        | {
            readonly _tag:
              | "CheckAppPermissions"
              | "CheckRepo"
              | "ListRepos"
              | "ListBranches"
              | "SetClaudeCredential"
              | "RemoveClaudeCredential"
              | "RevokeCliToken"
          }
        | MemberCommand
        | McpServerCommand
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

        /**
         * A command that stores a Repo's name, under the one spelling the Hub keeps of it (#197):
         * GitHub's, or without the GitHub App the spelling its Environment is stored under, or as
         * typed. Asked once access lets the command through, so that a refusal reads the same
         * whatever GitHub calls the Repo (ADR 0009); and off the lock, since it may wait on GitHub.
         */
        const respelled = Effect.fn("SessionRelay.respelled")(function* (
          message: RelayedCommand,
        ): Effect.fn.Return<RelayedCommand, SqlError> {
          if (
            message._tag !== "CreateSession" &&
            message._tag !== "ApplyEnvironment" &&
            message._tag !== "StartTestBuild"
          ) {
            return message
          }
          const github = yield* access.fullName(message.repo)
          const repo = Option.isSome(github)
            ? github.value
            : RepoName.make(yield* environments.storedName(message.repo))
          return repo === message.repo ? message : { ...message, repo }
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
                message.runnerId === undefined ? anyRunnerFor(you) : peers.runner(message.runnerId)
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
              // Repo access was checked before the lock was taken. The branches are the form's
              // word (ADR 0023): one that isn't there fails the clone, as it always has.
              const { branch } = message
              const created = yield* startNew({
                repo: message.repo,
                branch,
                runner,
                creator: you,
                why: {
                  by: you,
                  message:
                    branch._tag === "Existing" && !branch.newWorkBranch
                      ? `Started on ${runner.name} on ${branch.name}`
                      : `Started on ${runner.name} from ${branch._tag === "Create" ? branch.from : branch.name}`,
                },
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
              const start = live.starts.get(sessionId)
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
              const before = peers.presenceOf(sessionId)
              client.joined.add(sessionId)
              peer.send(
                PromptQueueChanged.make({ sessionId, queue: yield* prompts.list(sessionId) }),
              )
              const picked = live.questionPicks.get(sessionId)
              if (picked !== undefined && picked.picks.length > 0) {
                peer.send(QuestionPicks.make({ sessionId, ...picked }))
              }
              if (!(yield* presenceChanged(sessionId, before))) {
                peer.send(PresenceChanged.make({ sessionId, participants: before }))
              }
              return
            }

            case "LeaveSession": {
              const before = peers.presenceOf(message.sessionId)
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
              // Pressing Sleep turns Keep awake off (ADR 0016), even while it is going to sleep.
              if (live.goingToSleep(sessionId)) return yield* stopKeepingAwake(session.value)
              if (session.value.state !== "Active") {
                return refuse(
                  message,
                  `Only an Active Session can be put to sleep; this one is ${session.value.state}.`,
                  { sessionId },
                )
              }
              if (live.startUnderWay(sessionId)) {
                return refuse(
                  message,
                  "The Session is still starting; put it to sleep once it has started.",
                  { sessionId },
                )
              }
              if (session.value.currentTurn !== null) {
                return refuse(message, "A Turn is running: stop it first.", { sessionId })
              }
              if (live.promptOut(sessionId) || (yield* prompts.list(sessionId)).length > 0) {
                return refuse(message, "Prompts are waiting in the Session's queue.", {
                  sessionId,
                })
              }
              yield* stopKeepingAwake(session.value)
              return yield* putToSleep(session.value, { by: you, message: "Put to sleep" })
            }

            case "SetKeepAwake": {
              // Anyone with access to the Session's Repo may, in any state but Archived (ADR 0016).
              const { sessionId } = message
              const session = yield* sessionFor(message)
              if (Option.isNone(session)) return
              if (session.value.state === "Archived") {
                return refuse(message, "The Session is archived.", { sessionId })
              }
              if (!message.on) return yield* stopKeepingAwake(session.value)
              if (session.value.keepAwake === undefined) {
                yield* sessions.setKeepAwake(sessionId, {
                  by: you.id,
                  at: yield* Clock.currentTimeMillis,
                })
                yield* sessionUpdated(sessionId)
              }
              // Kept awake from now: an Asleep one is woken; a Frozen one when its Runner is back.
              if (session.value.state !== "Asleep") return
              const refused = yield* wake(session.value, { by: you })
              if (refused !== undefined) return refuse(message, refused, { sessionId })
              return
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
                  if (live.goingToSleep(sessionId)) {
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
              if (live.restarts.has(sessionId)) {
                return refuse(message, "The Session is already restarting.", { sessionId })
              }
              switch (session.value.state) {
                case "Asleep": {
                  // Set first, so the woken Session shows it is restarting.
                  live.restartWaking(sessionId, { by: you, since: yield* Clock.currentTimeMillis })
                  const refused = yield* wake(session.value, { by: you })
                  live.restartOver(sessionId)
                  if (refused !== undefined) return refuse(message, refused, { sessionId })
                  return
                }
                case "Active":
                  if (live.startUnderWay(sessionId)) {
                    // Its Sandbox is being made from the version it was sent: restarting now
                    // would only start it again behind this start.
                    return refuse(
                      message,
                      "The Session is still starting; restart it once it has started.",
                      { sessionId },
                    )
                  }
                  if (live.goingToSleep(sessionId)) {
                    return refuse(
                      message,
                      "The Session is going to sleep; wake it once it is Asleep.",
                      { sessionId },
                    )
                  }
                  if (session.value.currentTurn !== null || live.promptOut(sessionId)) {
                    return refuse(message, "A Turn is running: stop it first, then restart.", {
                      sessionId,
                    })
                  }
                  if (peers.runner(session.value.runnerId) === undefined) {
                    return refuse(message, "The Session's Runner is offline.", { sessionId })
                  }
                  yield* putToSleep(
                    session.value,
                    { by: you, message: "Restarting for the Environment's latest version" },
                    { by: you, since: yield* Clock.currentTimeMillis },
                  )
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
              const cantCancel = live.cancelRefusal(sessionId, promptId)
              if (cantCancel !== undefined)
                return refuse(message, cantCancel.refusal, { sessionId })
              const removed = yield* prompts.remove(sessionId, promptId)
              if (Option.isNone(removed)) {
                return refuse(message, "The prompt is not in the Prompt queue.", { sessionId })
              }
              yield* queueChanged(sessionId)
              return
            }

            case "SteerPrompt": {
              const { sessionId, promptId } = message
              const session = yield* sessionFor(message)
              if (Option.isNone(session)) return
              const prompt = (yield* prompts.list(sessionId)).find(({ id }) => id === promptId)
              const steered = live.steer(sessionId, {
                promptId,
                by: you.id,
                turnRunning: session.value.state === "Active" && session.value.currentTurn !== null,
                queued: prompt !== undefined,
              })
              if (typeof steered === "object") {
                return refuse(message, steered.refusal, { sessionId })
              }
              // It keeps its place in the queue until the mod says it joined the Turn.
              if (steered === "already" || prompt === undefined) return
              yield* outbox.enqueue(
                sessionId,
                DeliverIntoTurn.make({
                  sessionId,
                  promptId,
                  text: prompt.text,
                  sender: prompt.sender,
                }),
              )
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

            case "MessageAgent": {
              const { sessionId, agentId } = message
              const session = yield* sessionFor(message)
              if (Option.isNone(session)) return
              if (Option.isNone(yield* sessions.agentStatus(sessionId, agentId))) {
                return refuse(message, "The Session has no such agent.", { sessionId })
              }
              switch (session.value.state) {
                case "Archived":
                  return refuse(message, "The Session is archived: restore it to message agents.", {
                    sessionId,
                  })
                case "Frozen":
                  return refuse(
                    message,
                    "The Session's Runner is offline: message the agent once it is back.",
                    { sessionId },
                  )
                case "Active":
                  if (live.goingToSleep(sessionId)) {
                    return refuse(
                      message,
                      "The Session is going to sleep: message the agent once it is Asleep.",
                      {
                        sessionId,
                      },
                    )
                  }
                  break
                case "Asleep": {
                  // Its new Claude Code resumes the agent from its transcript.
                  const refused = yield* wake(session.value, { by: you })
                  if (refused !== undefined) return refuse(message, refused, { sessionId })
                  if (!live.awaitingHello(sessionId)) {
                    return refuse(message, "The Session could not be woken: see its history.", {
                      sessionId,
                    })
                  }
                }
              }
              yield* logEvent(
                sessionId,
                AgentMessaged.make({ agentId, sender: you, text: message.text }),
              )
              yield* outbox.enqueue(
                sessionId,
                DeliverAgentMessage.make({ sessionId, agentId, text: message.text, sender: you }),
              )
              return
            }

            case "AnswerQuestion": {
              const { sessionId, toolCallId } = message
              const session = yield* sessionFor(message)
              if (Option.isNone(session)) return
              // Only the question the mod reported is sent on: a mod from before #193 asks none.
              if (session.value.openQuestion?.toolCallId !== toolCallId) {
                return refuse(message, closedText(sessionId, toolCallId), { sessionId })
              }
              // The mod settles which answer came first, this one or another, or the terminal's.
              yield* outbox.enqueue(
                sessionId,
                DeliverAnswer.make({ sessionId, toolCallId, answer: message.answer, sender: you }),
              )
              return
            }

            case "PickAnswer": {
              const { sessionId, toolCallId } = message
              const session = yield* sessionFor(message)
              if (Option.isNone(session)) return
              // A pick for a question that has closed meanwhile is moot.
              if (session.value.openQuestion?.toolCallId !== toolCallId) return
              const before = live.questionPicks.get(sessionId)
              const others = (before?.toolCallId === toolCallId ? before.picks : []).filter(
                (pick) => pick.participant.id !== you.id || pick.question !== message.question,
              )
              const picks =
                message.answer === ""
                  ? others
                  : [
                      ...others,
                      QuestionPick.make({
                        participant: you,
                        question: message.question,
                        answer: message.answer,
                      }),
                    ]
              live.questionPicks.set(sessionId, { toolCallId, picks })
              toJoined(sessionId, QuestionPicks.make({ sessionId, toolCallId, picks }))
              return
            }

            case "StopAgent": {
              const { sessionId, agentId } = message
              const session = yield* sessionFor(message)
              if (Option.isNone(session)) return
              const status = yield* sessions.agentStatus(sessionId, agentId)
              if (Option.isNone(status)) {
                return refuse(message, "The Session has no such agent.", { sessionId })
              }
              if (status.value !== "Running" || session.value.state !== "Active") {
                return refuse(message, "The agent isn't running.", { sessionId })
              }
              yield* outbox.enqueue(sessionId, StopAgent.make({ sessionId, agentId }))
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
              const runner = peers.runner(session.value.runnerId)
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
              const runner = peers.runner(session.value.runnerId)
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
                for (const other of peers.webClients) {
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
         * Revokes one of the person's CLI tokens. The asker gets the tokens left with its
         * `requestId`, their other web clients just the tokens.
         */
        const revokeCliToken = (message: Extract<WebToHub, { readonly _tag: "RevokeCliToken" }>) =>
          Effect.gen(function* () {
            const revoked = yield* cliTokens.revoke(you.id, message.cliTokenId)
            if (!revoked) return refuse(message, "You have no such CLI token.")
            yield* Effect.logInfo(`${you.login} revoked a CLI token (${message.cliTokenId})`)
            yield* serialized(
              Effect.gen(function* () {
                const tokens = yield* cliTokens.list(you.id)
                for (const other of peers.webClients) {
                  if (other.you.id === you.id && other !== client)
                    other.peer.send(CliTokenList.make({ tokens }))
                }
                peer.send(CliTokenList.make({ requestId: message.requestId, tokens }))
                yield* forwardsSignedOut(you.id, tokens)
              }),
            )
          }).pipe(
            Effect.catchTag("SqlError", (error) =>
              Effect.logError("A CLI token command failed", error).pipe(
                Effect.andThen(
                  Effect.sync(() => refuse(message, "The Hub could not do that; try again.")),
                ),
              ),
            ),
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

        /**
         * What a listing says when it can't: a fixed message, with the details in the Hub's log
         * (GitHub's own words and the Hub's set-up hints aren't for the browser). Without the
         * GitHub App, a distinct answer, for the web UI to fall back without offering a retry; a
         * dev login, who runs the Hub, is told what to set.
         */
        const listingFailed = (
          message: Extract<WebToHub, { readonly _tag: "ListRepos" | "ListBranches" }>,
          failure: RepoAccessUnknown | RepoListingUnavailable,
          fixed: string,
        ) =>
          Effect.gen(function* () {
            if (failure._tag === "RepoListingUnavailable") {
              return peer.send(
                ListingUnavailable.make({
                  requestId: message.requestId,
                  ...(you.id.startsWith("dev:") && { hint: noGitHubAppHint }),
                }),
              )
            }
            yield* Effect.logWarning(failure.message)
            return refuse(message, fixed)
          })

        /**
         * Lists the Repos the person may start a Session on (ADR 0023), off the lock since it
         * waits on GitHub: the App's, filtered by their access and kept for a few minutes.
         */
        const listRepos = Effect.fn("SessionRelay.listRepos")(function* (
          message: Extract<WebToHub, { readonly _tag: "ListRepos" }>,
        ) {
          const listed = yield* Effect.result(access.accessible(you))
          if (listed._tag === "Failure") {
            return yield* listingFailed(
              message,
              listed.failure,
              "Could not list your Repos; try again.",
            )
          }
          peer.send(ReposListed.make({ requestId: message.requestId, repos: listed.success }))
        })

        /**
         * Lists a Repo's branches and its default branch (ADR 0023), off the lock since it waits
         * on GitHub: to a person with access to the Repo, as for any command about it.
         */
        const listBranches = Effect.fn("SessionRelay.listBranches")(function* (
          message: Extract<WebToHub, { readonly _tag: "ListBranches" }>,
        ) {
          const { requestId, repo } = message
          const allowed = yield* Effect.result(access.check(you, repo))
          if (allowed._tag === "Failure") {
            yield* Effect.logWarning(allowed.failure.message)
            return refuse(message, "Could not check your access on GitHub; try again.")
          }
          if (!allowed.success) return refuse(message, noRepoAccess(repo))
          const listed = yield* Effect.result(access.branches(repo))
          if (listed._tag === "Failure") {
            return yield* listingFailed(
              message,
              listed.failure,
              `Could not list the branches of ${repo}; try again.`,
            )
          }
          peer.send(BranchesListed.make({ requestId, repo, ...listed.success }))
        })

        return (message) =>
          isMemberCommand(message)
            ? memberRelay.receiveWeb(client, message)
            : isMcpServerCommand(message)
              ? mcpServerRelay.receiveWeb(client, message)
              : message._tag === "SetClaudeCredential" || message._tag === "RemoveClaudeCredential"
                ? claudeCredentialCommand(message)
                : message._tag === "RevokeCliToken"
                  ? revokeCliToken(message)
                  : message._tag === "CheckAppPermissions"
                    ? checkAppPermissions(message.requestId)
                    : message._tag === "ListRepos"
                      ? listRepos(message)
                      : message._tag === "ListBranches"
                        ? listBranches(message)
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
                                Effect.gen(function* () {
                                  const command =
                                    verdict.refusal === undefined
                                      ? yield* respelled(message)
                                      : message
                                  return yield* serialized(
                                    Effect.gen(function* () {
                                      const { learned, refusal } = verdict
                                      if (learned !== undefined)
                                        yield* accessKnown(you, learned.repo, learned.allowed)
                                      if (refusal !== undefined) return refuse(message, refusal)
                                      return yield* handle(command)
                                    }),
                                  )
                                }),
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
            kind: "Web",
            you,
            peer,
            joined: new Set(),
            terminals: new Set(),
            repos: new RepoMap(),
          }
          yield* Effect.gen(function* () {
            // Off the lock, since it may wait on GitHub. A Repo GitHub can't say about now is
            // asked about again at the next recheck.
            const asked = new RepoMap(
              (yield* sessions.list).map((session) => [session.repo, true] as const),
            )
            yield* Effect.forEach(
              asked.keys(),
              (repo) =>
                access.check(you, repo).pipe(
                  Effect.map((allowed) => void client.repos.set(repo, allowed)),
                  Effect.catchTag("RepoAccessUnknown", (error) => Effect.logWarning(error.message)),
                ),
              { concurrency: accessCheckConcurrency, discard: true },
            )
            yield* serialized(
              Effect.gen(function* () {
                // Out of every Session it joined when it goes, with presence updated.
                yield* peers.attachWeb(client, (before) =>
                  Effect.forEach(before, ([id, present]) => presenceChanged(id, present), {
                    discard: true,
                  }),
                )
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
                peer.send(CliTokenList.make({ tokens: yield* cliTokens.list(you.id) }))
                const checked = yield* drift.latest
                if (Option.isSome(checked)) {
                  peer.send(AppPermissionsChecked.make({ check: checked.value }))
                }
              }),
            )
          }).pipe(Effect.orDie)
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
          if (message._tag === "TunnelFailed") {
            return yield* tunnels.fail(
              message.tunnelId,
              runner.id,
              new TunnelRefused({
                code: TunnelCloseCode.PortUnreachable,
                message: message.message,
              }),
            )
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
              if (session.value.state === "Archived" || live.archiveStopping(message.sessionId))
                return
              live.claudeStarted(message.sessionId)
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
              const settled = live.stopped(message.sessionId)
              if (settled._tag === "Archive") {
                if (session.value.state === "Archived") {
                  // Stopped for good: its Sandbox is destroyed.
                  yield* sessions.setArchiveStopped(message.sessionId)
                  return yield* claudeGone(session.value, {})
                }
                // Restored meanwhile: Asleep on a destroyed Sandbox, and woken if prompts wait.
                yield* claudeGone(session.value, {})
                return yield* wakeIfWaiting(message.sessionId)
              }
              const { asked, restartBy } = settled
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
                if (live.restartOver(message.sessionId)) {
                  yield* sessionUpdated(message.sessionId)
                }
                return
              }
              // A prompt sent while it was going to sleep wakes it again, as Keep awake turned on
              // meanwhile does.
              if (asked !== undefined) {
                yield* wakeIfWaiting(message.sessionId)
                yield* wakeKeptAwake(message.sessionId)
              }
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
            case "SandboxNote":
              return yield* logEvent(
                message.sessionId,
                SandboxNoted.make({ message: message.message }),
              )
            case "SessionPorts": {
              // A list that raced the Session's stop: it has none now.
              if (session.value.state !== "Active") return
              const needles = yield* needlesFor(session.value.repo)
              const ports = message.ports.map((port) =>
                port.process === undefined
                  ? port
                  : { ...port, process: redactText(needles, port.process) },
              )
              const before = live.openPorts.get(message.sessionId) ?? []
              if (ports.length === 0) live.openPorts.delete(message.sessionId)
              else live.openPorts.set(message.sessionId, ports)
              if (!samePorts(before, ports)) yield* sessionUpdated(message.sessionId)
              return
            }
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
            forwardsPorts: hello.forwardsPorts === true,
            relaysMcpServers: hello.relaysMcpServers === true,
          }
          yield* serialized(
            Effect.gen(function* () {
              const replaced = yield* peers.attachRunner(runner, runnerGone(runner))
              if (replaced !== undefined) {
                replaced.peer.close(RelayCloseCode.Replaced, "Replaced by a newer connection")
                // Its removal finds it replaced and does nothing: it is settled here, as if it
                // had gone offline just before, its Sessions left to what this hello says.
                yield* runnerGone(replaced, { replaced: true })
              }
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
              const withoutModToken = new Set(hello.withoutModToken)
              // Sessions purged while it was away, and archived ones it hasn't stopped yet.
              for (const sessionId of yield* sessions.pendingPurges(runner.id)) {
                peer.send(PurgeSession.make({ sessionId }))
              }
              const unstopped = new Set(yield* sessions.unstoppedArchives(runner.id))
              const keptAwake: Array<SessionId> = []
              for (const session of yield* sessions.listByRunner(runner.id)) {
                if (session.state === "Archived") {
                  if (unstopped.has(session.id) || running.has(session.id)) {
                    stopForArchive(runner, session.id)
                  }
                  continue
                }
                if (running.has(session.id)) {
                  // Kept running across its restart, its mod token lost with its memory.
                  if (withoutModToken.has(session.id)) {
                    const modToken = yield* modTokens.issue({
                      sessionId: session.id,
                      runnerId: runner.id,
                    })
                    peer.send(ModTokenReissued.make({ sessionId: session.id, modToken }))
                  }
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
                  if (session.keepAwake !== undefined) keptAwake.push(session.id)
                }
              }
              // A push `kndl update` left drains it, now its Sessions are settled.
              yield* runnerUpdates.drain(runner.id)
              // Back from a drain or a restart, its Sessions with Keep awake on wake (ADR 0016),
              // unless that drain has just begun: then they wake once it is back from it.
              for (const sessionId of keptAwake) yield* wakeKeptAwake(sessionId)
            }),
          ).pipe(Effect.orDie)
          return receiveRunner(runner)
        })

      /**
       * The Runner's connection is gone: the tunnels it was asked to open fail, its update goes on
       * as after a disconnect (ADR 0011), its Test builds fail, and its Sessions are Frozen until
       * it is back. One a newer connection `replaced` leaves its Sessions to that one's hello,
       * which runs next and says which are running.
       */
      const runnerGone = Effect.fn("SessionRelay.runnerGone")(function* (
        runner: OnlineRunner,
        options: { readonly replaced: boolean } = { replaced: false },
      ) {
        yield* tunnels.runnerGone(runner.id)
        yield* runnerUpdates.gone(runner.id)
        if (!options.replaced) yield* runners.recordSeen(runner.id, yield* Clock.currentTimeMillis)
        yield* environmentRelay.runnerGone(runner)
        for (const session of yield* sessions.listByRunner(runner.id)) {
          // A stop or start it was asked for is settled by what it says when it is back.
          live.ended(session.id, "RunnerGone")
          if (options.replaced) continue
          if (session.state === "Active" || session.state === "Asleep") {
            yield* changeState(session, "Frozen", {
              message: `${runner.name} went offline`,
            })
          }
        }
        if (!options.replaced) toWeb(yield* runnerList)
      })

      // ── The mod channel ──────────────────────────────────────────────────

      const modHello = Effect.fn("SessionRelay.modHello")(function* (
        sessionId: SessionId,
        hello: ModHello,
      ) {
        const session = yield* sessions.get(sessionId)
        if (Option.isNone(session)) return
        yield* sessions.setClaudeSessionId(sessionId, hello.claudeSessionId)
        live.modHello(sessionId, hello.steers === true)
        yield* presenceToMod(sessionId)
        yield* deliverNext(sessionId)
      }, serialized)

      const modEvent = Effect.fn("SessionRelay.modEvent")(function* (
        sessionId: SessionId,
        event: ModEvent,
      ) {
        if (event._tag === "PromptFailed") {
          const steeredBy = live.promptFailed(sessionId, event.promptId)
          if (steeredBy !== undefined) {
            // A steer that failed leaves the prompt in its place, to wait for the Turn to end.
            return toWeb(
              CommandFailed.make({
                command: "SteerPrompt",
                sessionId,
                message: `The prompt could not join the running Turn, so it waits in the queue: ${event.message}`,
              }),
              (client) => client.you.id === steeredBy,
            )
          }
          // The prompt is dropped, and its sender told: put back, it would most likely fail
          // again at once, and hold up the rest of the queue.
          const failed = yield* prompts.remove(sessionId, event.promptId)
          if (Option.isNone(failed)) return
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

        if (event._tag === "AgentCommandFailed") {
          // Nothing to log: the agent is as it was. Told to whoever sent it, else to everyone there.
          const what =
            event.command === "MessageAgent"
              ? "Your message could not be delivered to the agent"
              : "The agent could not be stopped"
          return toWeb(
            CommandFailed.make({
              command: event.command,
              sessionId,
              message: `${what}: ${event.message}`,
            }),
            (client) =>
              event.senderId !== undefined
                ? client.you.id === event.senderId
                : client.joined.has(sessionId),
          )
        }

        if (event._tag === "AnswerFailed") {
          // The question is as it was: closed. Told to whoever sent the answer.
          const known = live.closedQuestions.get(sessionId)
          return toWeb(
            CommandFailed.make({
              command: "AnswerQuestion",
              sessionId,
              message:
                known?.toolCallId === event.toolCallId
                  ? `${questionClosedText(known, true)}.`
                  : `Your answer came too late: ${event.message}`,
            }),
            (client) => client.you.id === event.senderId,
          )
        }

        if (event._tag === "QuestionAsked") {
          const session = yield* sessions.get(sessionId)
          if (Option.isNone(session)) return
          // The mod asks one at a time; one left open was cut short.
          const before = session.value.openQuestion
          if (before !== undefined && before.toolCallId !== event.toolCallId) {
            yield* cancelQuestion(session.value)
          }
          yield* logEvent(sessionId, event)
          yield* sessions.setOpenQuestion(
            sessionId,
            OpenQuestion.make({
              turnId: event.turnId,
              toolCallId: event.toolCallId,
              questions: redactQuestions(yield* needlesForSession(sessionId), event.questions),
              askedAt: yield* Clock.currentTimeMillis,
            }),
          )
          live.questionPicks.delete(sessionId)
          return yield* sessionUpdated(sessionId)
        }

        if (event._tag === "QuestionClosed") {
          const session = yield* sessions.get(sessionId)
          // One closed already, as Cancelled when its Turn ended first, stays as it closed.
          if (Option.getOrUndefined(session)?.openQuestion?.toolCallId !== event.toolCallId) return
          yield* closeQuestion(sessionId, event)
          return yield* sessionUpdated(sessionId)
        }

        if (event._tag === "AgentStatusChanged") {
          // An agent the Hub never saw start is none of the Session's, as one Claude Code started
          // for itself: its status is dropped, not logged.
          if (!(yield* sessions.setAgentStatus(sessionId, event.agentId, event.status))) return
          yield* logEvent(sessionId, event)
          return yield* sessionUpdated(sessionId)
        }

        yield* logEvent(sessionId, event)
        if (event._tag === "AgentStarted") {
          // Its summary shows the description too, redacted as the log has it.
          yield* sessions.agentStarted(sessionId, {
            id: event.agentId,
            description: redactText(yield* needlesForSession(sessionId), event.description),
            startedAt: yield* Clock.currentTimeMillis,
          })
          yield* sessionUpdated(sessionId)
        } else if (event._tag === "TurnStarted") {
          yield* sessions.setCurrentTurn(sessionId, event.turnId)
          if (event.promptId !== undefined) {
            live.turnStarted(sessionId, event.promptId)
            const started = yield* prompts.remove(sessionId, event.promptId)
            if (Option.isSome(started)) yield* queueChanged(sessionId)
          }
          yield* sessionUpdated(sessionId)
        } else if (event._tag === "PromptSteered") {
          // It joined the Turn: out of the queue, and shown in the Turn instead.
          live.promptSteered(sessionId, event.promptId)
          const steered = yield* prompts.remove(sessionId, event.promptId)
          if (Option.isSome(steered)) yield* queueChanged(sessionId)
        } else if (event._tag === "TurnEnded" && event.agentId === undefined) {
          yield* sessions.setCurrentTurn(sessionId, null)
          // Its question can't be answered once it has ended.
          const session = yield* sessions.get(sessionId)
          if (Option.isSome(session)) yield* cancelQuestion(session.value)
          yield* sessionUpdated(sessionId)
        }
      })

      /**
       * Closes the Session's Open question (#193): logged, taken off its summary, and remembered,
       * so an answer that comes after is told how it closed. The caller sends the SessionUpdated.
       */
      const closeQuestion = Effect.fn("SessionRelay.closeQuestion")(function* (
        sessionId: SessionId,
        closed: QuestionClosed,
      ) {
        yield* logEvent(sessionId, closed)
        const needles = yield* needlesForSession(sessionId)
        live.closedQuestions.set(sessionId, {
          ...closed,
          outcome: redactOutcome(needles, closed.outcome),
        })
        live.questionPicks.delete(sessionId)
        yield* sessions.setOpenQuestion(sessionId, null)
      })

      /**
       * Closes the Session's Open question as Cancelled, if it has one: its Turn ended, or its
       * Claude Code stopped, before anyone answered. Whether it had one.
       */
      const cancelQuestion = Effect.fn("SessionRelay.cancelQuestion")(function* (
        session: SessionSummary,
      ) {
        const open = session.openQuestion
        if (open === undefined) return false
        yield* closeQuestion(
          session.id,
          QuestionClosed.make({
            turnId: open.turnId,
            toolCallId: open.toolCallId,
            outcome: { _tag: "Cancelled" },
          }),
        )
        return true
      })

      /** Why an answer to a question that isn't open is refused: how it closed, if it did. */
      const closedText = (sessionId: SessionId, toolCallId: ToolCallId): string => {
        const closed = live.closedQuestions.get(sessionId)
        return closed?.toolCallId === toolCallId
          ? `${questionClosedText(closed, true)}.`
          : "The question is no longer open."
      }

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

      // An OAuth Installation's tokens changed (#217): what Sessions print is redacted of the new
      // ones; one lost is shown so on the MCP page.
      const connectionChanges = yield* oauth.changes
      yield* PubSub.take(connectionChanges).pipe(
        Effect.flatMap((change) => {
          needlesByRepo.clear()
          return change.lost ? serialized(mcpServerRelay.connectionsChanged) : Effect.void
        }),
        Effect.catchCause((cause) =>
          Effect.logError("Could not send an OAuth Installation's lost connection", cause),
        ),
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

      const openTunnel = (sessionId: SessionId, port: number) =>
        serialized(
          Effect.gen(function* () {
            const session = yield* sessions.get(sessionId)
            if (Option.isNone(session)) {
              return yield* refuseTunnel(TunnelCloseCode.NoSuchSession, "There is no such Session.")
            }
            const offline = "The Session's Runner is offline."
            switch (session.value.state) {
              case "Asleep":
                return yield* refuseTunnel(
                  TunnelCloseCode.NotActive,
                  "The Session is Asleep: wake it first.",
                )
              case "Archived":
                return yield* refuseTunnel(TunnelCloseCode.NotActive, "The Session is archived.")
              case "Frozen":
                return yield* refuseTunnel(TunnelCloseCode.RunnerOffline, offline)
              case "Active":
                break
            }
            if (live.goingToSleep(sessionId)) {
              return yield* refuseTunnel(
                TunnelCloseCode.NotActive,
                "The Session is going to sleep.",
              )
            }
            const runner = peers.runner(session.value.runnerId)
            if (runner === undefined)
              return yield* refuseTunnel(TunnelCloseCode.RunnerOffline, offline)
            if (!runner.forwardsPorts) {
              return yield* refuseTunnel(
                TunnelCloseCode.RunnerTooOld,
                `${runner.name} runs a version from before forwarding ports: update it.`,
              )
            }
            const open = live.openPorts.get(sessionId)?.find((listening) => listening.port === port)
            if (open === undefined) {
              return yield* refuseTunnel(
                TunnelCloseCode.PortNotOpen,
                `Nothing listens on port ${port} in the Session's Sandbox.`,
              )
            }
            const tunnel = yield* tunnels.register(runner.id)
            runner.peer.send(
              OpenTunnel.make({
                tunnelId: tunnel.tunnelId,
                sessionId,
                port,
                address: loopbackFor(open.addresses),
              }),
            )
            return tunnel
          }),
        )

      const cliTokensChanged = (participantId: ParticipantId) =>
        serialized(
          Effect.gen(function* () {
            const tokens = yield* cliTokens.list(participantId)
            for (const client of peers.webClients) {
              if (client.you.id === participantId) client.peer.send(CliTokenList.make({ tokens }))
            }
            yield* forwardsSignedOut(participantId, tokens)
          }),
        ).pipe(
          Effect.catchTag("SqlError", (error) =>
            Effect.logError("Could not send a person their CLI tokens", error),
          ),
        )

      // ── Forwards (#180) ──────────────────────────────────────────────────

      /**
       * A forward to the Session, from a caller ForwardRoutes.ts has checked for access. An Asleep
       * Session is woken first: one that can't be is closed with why, and never counted present.
       */
      const connectForward = (cli: CliIdentity, sessionId: SessionId, peer: Peer<HubToForward>) =>
        Effect.gen(function* () {
          yield* serialized(
            Effect.gen(function* () {
              const found = yield* sessions.get(sessionId)
              if (Option.isNone(found)) {
                peer.close(ForwardCloseCode.NoSuchSession, "There is no such Session.")
                return undefined
              }
              let session = found.value
              if (session.state === "Archived") {
                peer.close(ForwardCloseCode.Archived, "The Session is archived.")
                return undefined
              }
              if (session.state === "Asleep") {
                const refused = yield* wake(session, { by: cli.participant })
                const woken = Option.getOrUndefined(yield* sessions.get(sessionId))
                if (refused !== undefined || woken === undefined || woken.state !== "Active") {
                  const runner = peers.runner(session.runnerId)
                  const cantStart =
                    runner === undefined
                      ? undefined
                      : yield* cantStartOn(session, runner, cli.participant)
                  peer.close(
                    ForwardCloseCode.WentAsleep,
                    closeReason(
                      refused ?? cantStart?.message ?? "The Session is Asleep and could not wake.",
                    ),
                  )
                  return undefined
                }
                session = woken
              }
              const client: ForwardClient = {
                kind: "Forward",
                you: cli.participant,
                tokenId: cli.id,
                machine: cli.machine,
                sessionId,
                repo: session.repo,
                peer,
              }
              const before = peers.presenceOf(sessionId)
              yield* peers.attachForward(client, (left) =>
                Effect.forEach(left, ([id, present]) => presenceChanged(id, present), {
                  discard: true,
                }),
              )
              peer.send(ForwardSession.make({ session: forWeb(session) }))
              yield* Effect.logInfo(
                `${cli.participant.login} forwards Session ${sessionId} to ${cli.machine}`,
              )
              yield* presenceChanged(sessionId, before)
            }),
          ).pipe(Effect.orDie)
          return (_message: never) => Effect.void
        })

      /** Closes the person's forwards by a CLI token that is no longer one of `tokens`. */
      const forwardsSignedOut = (
        participantId: ParticipantId,
        tokens: ReadonlyArray<{ readonly id: CliTokenId }>,
      ) => {
        const current = new Set(tokens.map((token) => token.id))
        return endForwards(
          (forward) => forward.you.id === participantId && !current.has(forward.tokenId),
          ForwardCloseCode.SignedOut,
          "This machine's CLI token was revoked: run kndl login to sign in again.",
        )
      }

      const forwardableSessions = (you: Participant) =>
        Effect.gen(function* () {
          const listed = (yield* sessions.list).filter((session) => session.state !== "Archived")
          const allowed = new RepoMap<boolean>()
          yield* Effect.forEach(
            uniqueRepos(listed.map((session) => session.repo)),
            (repo) =>
              access.check(you, repo).pipe(
                Effect.map((yes) => {
                  if (yes) allowed.set(repo, true)
                }),
                // Left out, as one they have no access to; `forward` says so if it is named.
                Effect.catchTag("RepoAccessUnknown", (error) => Effect.logWarning(error.message)),
              ),
            { concurrency: accessCheckConcurrency, discard: true },
          )
          return yield* serialized(
            Effect.sync(() =>
              listed
                .filter((session) => allowed.has(session.repo))
                .toSorted((a, b) => b.createdAt - a.createdAt)
                .map(forWeb),
            ),
          )
        })

      return SessionRelay.of({
        connectForward,
        forwardableSessions,
        connectWeb,
        connectRunner,
        redeemPairing,
        runnerOnline: (id) => peers.runner(id) !== undefined,
        cliTokensChanged,
        membersChanged: memberRelay.membersChanged,
        modHello,
        modEvents,
        openTunnel,
        installationFailed,
        installationWorks,
        finishMcpServerConnect,
      })
    }),
  )
}
