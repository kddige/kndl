// An in-process stand-in for the Hub's web channel, until the real one (issues #7 and #8) is
// done. It speaks the protocol over a fake socket, so the HubClient can't tell the difference,
// and plays a scripted Session: streamed text, tool calls, subagents in the foreground and the
// background, which its Creator can message and stop, a second Participant joining to watch, and
// a terminal to watch and type into; Environments, shared
// variables and Test builds with a streaming log (environments.ts); MCP servers and their
// Installations, with each Repo's change log (mcpServers.ts); Connected providers, their sign-ins
// and the Models of pi Sessions (providers.ts); and, when asked to, a GitHub App short of
// permissions. `VITE_FAKE_HUB=1` runs the UI against it; tests use it too.
//
// It keeps its data in the wire (encoded) shapes and decodes what the client sends, so a client
// message the real Hub would refuse fails here too. What it refuses of a Session, and how its Prompt
// queue and Steer behave, it decides by the protocol's Session rules (SessionRules.ts), as the real
// Hub does; HubContract.test.ts runs the same HubClient tests against both. Only a Session's
// Creator drives it (ADR 0026), on their setup token: the fake refuses anyone else's prompts,
// answers, stops, controls and terminal, and assumes every Creator but the signed-in person has a
// token stored.

import {
  admissionLink,
  type BranchChoice,
  branchesFor,
  cancelRefusal,
  cantStartText,
  checkHandshake,
  claudeCredentialProblem,
  CliLoginApproval,
  type CliLoginApproved,
  CliLoginCodeLength,
  CliLoginCodeLifetimeMs,
  QuestionClosed,
  questionClosedText,
  findModel,
  formatCliLoginCode,
  formatPairingCode,
  deliveryBlocked,
  driveRefusal,
  installationFailureText,
  installationsDiffer,
  installationsCantStartText,
  InviteLifetimeMs,
  InvitePath,
  attachmentCount,
  attachmentName,
  AttachmentId,
  AttachmentMediaTypes,
  attachmentRules,
  memberRemovalRefusal,
  MaxAttachmentBytes,
  tooLargeForAnyReason,
  unsupportedAttachmentReason,
  messageAgentVerdict,
  modelNotFoundText,
  parseProviderModelName,
  type ProviderId,
  providerModelName,
  hubPinnedMessage,
  hubUpdatesOffMessage,
  ownerOnlyMessage,
  updateRunningText,
  PairingAlphabet,
  PairingCodeLength,
  PairingCodeLifetimeMs,
  pairingLink,
  Participant,
  ProtocolVersion,
  type PromptHandover,
  type RepoStatus,
  repoKey,
  restartVerdict,
  runnerRemovalRefusal,
  sameRepo,
  sendPromptRefusal,
  SessionId,
  withAttachmentMarkers,
  type SessionNow,
  sessionNameFrom,
  sleepVerdict,
  steerVerdict,
  answerAttachmentsRefusal,
  attachmentsNotSent,
  stopAgentRefusal,
  stopTurnRefusal,
  type Harness,
  type ThinkingLevel,
  UpdateDrainMillis,
  wakeVerdict,
  WebToHub,
} from "@kndl/protocol"
import { Redacted, Schema } from "effect"
import type { SignInOptions } from "../config.ts"
import type {
  HubSocket,
  HubTransport,
  SignInStatus,
  SocketHandlers,
  UploadOptions,
} from "../transport.ts"
import { FakeEnvironments, sessionStartScript, testBuildScript } from "./environments.ts"
import { FakeMcpServers, type McpServerChangeCommand } from "./mcpServers.ts"
import {
  FakeProviders,
  pasteProblem,
  providerName,
  seedProviders,
  signInSteps,
} from "./providers.ts"
import {
  archiveRetentionMs,
  bob,
  demoSessionId,
  fakeRunnerHistory,
  hubVersion,
  type ReplyStep,
  replyTo,
  scriptedTurn,
  seedClaudeCredential,
  seedCliTokens,
  seedInvites,
  seedMembers,
  seedRunners,
  seedSessions,
  taskNotification,
  you as defaultYou,
} from "./script.ts"
import { FakeTerminal } from "./terminal.ts"
import type {
  AgentSummaryWire,
  AttachmentWire,
  AppPermissionsCheckWire,
  BuildVersionWire,
  ClaudeCredentialInfoWire,
  CliTokenInfoWire,
  ConnectedProviderWire,
  HubMessage,
  HubUpdateRunWire,
  HubUpdateStateWire,
  LogEntryWire,
  MemberWire,
  OpenPortWire,
  ParticipantWire,
  PresentParticipantWire,
  PendingInviteWire,
  PendingPairingCodeWire,
  QuestionAnswerWire,
  QuestionPickWire,
  QueuedPromptWire,
  RunnerSummaryWire,
  SessionEventWire,
  SessionInstallationWire,
  SessionSummaryWire,
  SignInStepWire,
} from "./wire.ts"

const decodeParticipant = Schema.decodeUnknownSync(Participant)
const decodeQuestionClosed = Schema.decodeUnknownSync(QuestionClosed)
const decodeApproval = Schema.decodeUnknownSync(CliLoginApproval)

export interface FakeHubOptions {
  /** Milliseconds per step of the script; text streams a few words a step. Default 120. */
  stepMs?: number
  /** Whether someone is signed in. Default true. */
  signedIn?: boolean
  /** Which sign-in methods the signed-out screen offers. Default both. */
  signInOptions?: SignInOptions
  /** Start the demo Session's script when it's first joined. Default true. */
  autoplay?: boolean
  /**
   * What the last check of the GitHub App's permissions found, as the Hub sends it; null for a
   * Hub without the App. Default null.
   */
  appPermissions?: AppPermissionsCheckWire | null
  /**
   * The signed-in person's Claude credential, a setup token (ADR 0026), as the Hub shows it; null
   * for none, so their Sessions can't start or wake. Default one, added a month ago.
   */
  claudeCredential?: ClaudeCredentialInfoWire | null
  /**
   * Who is signed in. Default Alice, the Creator of most seeded Sessions; Bob watches them, and
   * drives his own.
   */
  you?: ParticipantWire
  /** The signed-in person's CLI tokens (issue #179), newest first. Default two, on two machines. */
  cliTokens?: ReadonlyArray<CliTokenInfoWire>
  /** Whether the signed-in person is the Hub's Owner (#209), who has the People page. Default true. */
  owner?: boolean
  /**
   * The Hub's update check (ADR 0028), which only a Hub the kndl service runs from its install has,
   * sent to its Owner alone; null for a Hub without it, as one run from a checkout. Default null.
   */
  hubUpdate?: HubUpdateStateWire | null
  /** The kndl the Hub runs. Default `hubVersion`, a commit on main. */
  hubVersion?: BuildVersionWire
  /** The Hub's latest update (#362), sent to its Owner alone. Default none. */
  hubUpdateRun?: HubUpdateRunWire | null
  /**
   * How the fake plays an update the Owner starts: it moves the Hub, which restarts on the new
   * commit, or it rolls back, with an error and a log. Default `Succeeded`.
   */
  hubUpdateOutcome?: "Succeeded" | "RolledBack"
  /**
   * The signed-in person's Connected providers (ADR 0029). Default their ChatGPT sign-in, with
   * its Models.
   */
  providers?: ReadonlyArray<ConnectedProviderWire>
  /** How Claude answers a prompt from the web, as a script. Default `replyTo`'s. */
  reply?: (text: string) => ReadonlyArray<ReplyStep>
}

/** A sign-in the fake plays (ADR 0029). */
interface FakeSignIn {
  readonly requestId: string
  readonly provider: ProviderId
  readonly socket: FakeSocket
  /** What it waits for the Member to answer, if anything. */
  waitsFor: "Paste" | "Choose" | null
  /** Its steps after the choice it waits for. */
  afterChoice: ReadonlyArray<SignInStepWire>
}

interface FakeSession {
  summary: SessionSummaryWire
  log: Array<LogEntryWire>
  queue: Array<QueuedPromptWire>
  /**
   * The queued prompt delivered to its mod that no Turn has started from yet: it stays in the
   * queue until one does, as on the Hub.
   */
  inFlight: string | null
  /**
   * The queued prompts sent to join the running Turn (ADR 0018), until the mod says each joined
   * or failed: each keeps its place in the queue until then.
   */
  steering: Set<string>
  /** Whether its mod said in its hello that it steers (#195): one from before steering doesn't. */
  modSteers: boolean
  /**
   * Whether its mod said in its hello that it marks the attachments of a steered prompt, a
   * message to a subagent and a reply (#278): one from before doesn't.
   */
  modAttaches: boolean
  /** People the script puts in the Session, besides whoever is connected. */
  guests: Array<PresentParticipantWire>
  /** Cancels the running Turn's remaining steps. */
  stopTurn: (() => void) | null
  /** Its Claude Code terminal, made when first opened. */
  terminal: FakeTerminal | null
  /** What its latest start printed, for clients that join while it runs. */
  startLog: string
  /** Its subagents, in the order they started. */
  agents: Map<string, FakeAgent>
  /** What listens in its Sandbox once Claude Code is up (#175); none while it isn't Active. */
  ports: ReadonlyArray<OpenPortWire>
  /** Its Open question (#193), while Claude waits for an answer. */
  asking?: FakeQuestion | null
}

/** An Open question, as the mod and the Hub hold it (#193). */
interface FakeQuestion {
  readonly toolCallId: string
  /** What people have picked so far, as the Hub shares it. */
  picks: Array<QuestionPickWire>
  /** Settles it with the first answer, as the mod does, and goes on with the Turn. */
  readonly answer: (answer: QuestionAnswerWire, by: ParticipantWire) => void
}

interface FakeAgent {
  summary: AgentSummaryWire
  /** The run it's in while Running. */
  run: string | null
  /** Ends its run early, with the status it ends in; null while it doesn't run. */
  stop: ((status: "Stopped" | "Interrupted") => void) | null
}

type TurnStart = Pick<
  Extract<SessionEventWire, { _tag: "TurnStarted" }>,
  "text" | "sender" | "promptId"
>

/** A seeded Session's subagents, as its log says they are. */
function agentsFromLog(log: ReadonlyArray<LogEntryWire>): Map<string, FakeAgent> {
  const agents = new Map<string, FakeAgent>()
  for (const { event } of log) {
    if (event._tag === "AgentStarted") {
      agents.set(event.agentId, {
        summary: { id: event.agentId, description: event.description, status: "Running" },
        run: null,
        stop: null,
      })
    } else if (event._tag === "AgentStatusChanged") {
      const agent = agents.get(event.agentId)
      if (agent) agent.summary = { ...agent.summary, status: event.status }
    }
  }
  return agents
}

/** The agents a summary lists: the Running and Interrupted ones (ADR 0014). */
function listedAgents(agents: Map<string, FakeAgent>): Array<AgentSummaryWire> {
  return [...agents.values()]
    .map((agent) => agent.summary)
    .filter((agent) => agent.status === "Running" || agent.status === "Interrupted")
}

class FakeSocket implements HubSocket {
  welcomed = false
  readonly joined = new Set<string>()
  /** The Sessions whose terminal this connection watches. */
  readonly terminals = new Set<string>()
  closed = false

  constructor(
    readonly hub: FakeHub,
    readonly handlers: SocketHandlers,
  ) {}

  send(text: string): void {
    if (this.closed) return
    // The network is asynchronous; so is the fake.
    queueMicrotask(() => this.hub.receive(this, text))
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.hub.disconnected(this)
    setTimeout(() => this.handlers.onClose(), 0)
  }

  deliver(message: HubMessage): void {
    if (this.closed) return
    const text = JSON.stringify(message)
    setTimeout(() => {
      if (!this.closed) this.handlers.onMessage(text)
    }, 0)
  }
}

const decodeWebToHub = Schema.decodeUnknownSync(WebToHub)

/** Why a Session can't be created without the person's own setup token (ADR 0026). */
const noCredentialText =
  "Add your Claude setup token on your Account page first: a Session runs on its Creator's own."

/** Why a pi Session can't be created without a Model to run on (ADR 0029). */
const noModelsText =
  "Connect a Provider on your Account page first: a Session runs on its Creator's own Models."

/** How many steps xAI's sign-in waits, as if for the code to be entered. */
const codeEnteredSteps = 60

/** What a listing that fails says, as the Hub words it. */
const notListed = "Could not list your Repos; try again."

/** A summary's Installations: absent for none, as the Hub sends them. */
const withMcpServers = (mcpServers: ReadonlyArray<SessionInstallationWire>) =>
  mcpServers.length > 0 ? { mcpServers } : {}

/** The People page's commands (#209). */
type PeopleCommand =
  | "CreateInvite"
  | "ListInvites"
  | "RevokeInvite"
  | "ListMembers"
  | "RemoveMember"

export class FakeHub implements HubTransport {
  readonly stepMs: number
  readonly sessions = new Map<string, FakeSession>()
  /**
   * What each Session takes of its Runner's disk, in bytes (#352): what the Hub is told when it
   * asks, for an Archived Session whose Runner is online. A Session not here has no size, as one
   * on a Runner that can't measure it. In the browser, `fakeHub.diskBytes.set("s-flaky", 2e9)`.
   */
  readonly diskBytes = new Map<string, number>([["s-flaky", Math.round(1.8 * 1024 ** 3)]])
  /** The paired Runners; their `openSessions` is counted afresh from `sessions` as they're sent. */
  runners: Array<RunnerSummaryWire>
  /** Pairing codes not yet redeemed or revoked; one may have expired. */
  readonly pairingCodes: Array<PendingPairingCodeWire> = []
  readonly environments = new FakeEnvironments()
  readonly mcpServers = new FakeMcpServers()
  readonly providers: FakeProviders
  /**
   * What GitHub says of the signed-in person and each Repo (#104); any Repo not here is Allowed.
   * Seeded with one of each refusal for the demo.
   */
  readonly repoAccess = new Map<string, RepoStatus>([
    ["kddige/secret", "NoAccess"],
    ["someone-else/their-repo", "NotInstalled"],
  ])
  /**
   * Each Repo's branches and default branch, as the Hub lists them (ADR 0023); a Repo not here has
   * `main` alone.
   */
  readonly branches = new Map<string, { names: Array<string>; defaultBranch: string }>([
    ["kddige/kndl", { names: ["main", "dev", "release/1.0"], defaultBranch: "main" }],
  ])
  /** While set, ListRepos and ListBranches answer that there is no GitHub App. */
  listingDown = false
  /** While set, they fail, as when GitHub can't answer. */
  listingFails = false
  /** Every message each client sent, decoded, for tests to inspect. */
  readonly received: Array<WebToHub> = []
  #signedIn: boolean
  #signInOptions: SignInOptions
  #you: ParticipantWire = defaultYou
  #autoplay: boolean
  #appPermissions: AppPermissionsCheckWire | null
  #claudeCredential: ClaudeCredentialInfoWire | null
  #cliTokens: Array<CliTokenInfoWire>
  #owner: boolean
  #hubUpdate: HubUpdateStateWire | null
  #hubVersion: BuildVersionWire
  #hubUpdateRun: HubUpdateRunWire | null
  readonly #hubUpdateOutcome: "Succeeded" | "RolledBack"
  /** The Hub is down, restarting after an update: no connection opens. */
  #down = false
  readonly #reply: (text: string) => ReadonlyArray<ReplyStep>
  /** The Hub's Members (#209), the Owner first. */
  members: Array<MemberWire> = seedMembers()
  /** Invites not yet used or revoked; one may have expired. */
  invites: Array<PendingInviteWire> = seedInvites()
  /** The Setup link and Invite secrets the /setup and /invite pages handed over, in order. */
  readonly admissions: Array<string> = []
  #scriptStarted = false
  /**
   * The signed-in person's sign-in in progress, as the Hub runs one per Member (ADR 0029): with
   * the connection that started it, what it waits for, a paste or a choice, and its steps after
   * the choice.
   */
  #signIn: FakeSignIn | null = null
  readonly #sockets = new Set<FakeSocket>()
  readonly #timers = new Set<ReturnType<typeof setTimeout>>()
  /** While held, the timed steps that came due, in order, waiting for `step` (#315). */
  #holding = false
  readonly #held: Array<{ timer: ReturnType<typeof setTimeout>; fn: () => void }> = []
  #heldArrived: (() => void) | undefined
  /** The scripted reply each queued prompt gets when it's delivered. */
  readonly #replies = new Map<string, ReadonlyArray<ReplyStep>>()
  /** The files uploaded (#276), by id, with who uploaded each where, and a URL to show it at. */
  readonly #attachments = new Map<
    string,
    {
      readonly attachment: AttachmentWire
      readonly sessionId: string
      readonly by: string
      readonly url: string
    }
  >()
  #ids = 0

  constructor(options: FakeHubOptions = {}) {
    this.stepMs = options.stepMs ?? 120
    this.#signedIn = options.signedIn ?? true
    this.#signInOptions = options.signInOptions ?? { github: true, dev: true }
    this.#autoplay = options.autoplay ?? true
    this.#appPermissions = options.appPermissions ?? null
    this.#claudeCredential =
      options.claudeCredential === undefined ? seedClaudeCredential() : options.claudeCredential
    this.#you = options.you ?? defaultYou
    this.#cliTokens = [...(options.cliTokens ?? seedCliTokens())]
    this.#owner = options.owner ?? true
    this.#hubUpdate = options.hubUpdate ?? null
    this.#hubVersion = options.hubVersion ?? hubVersion
    this.#hubUpdateRun = options.hubUpdateRun ?? null
    this.#hubUpdateOutcome = options.hubUpdateOutcome ?? "Succeeded"
    this.#reply = options.reply ?? replyTo
    this.providers = new FakeProviders(options.providers ?? seedProviders())
    this.runners = seedRunners()
    for (const seed of seedSessions()) {
      const log = seed.events.map((event, seq) => ({ seq, at: seed.at + seq * 1_000, event }))
      const agents = agentsFromLog(log)
      const listed = listedAgents(agents)
      this.sessions.set(seed.summary.id, {
        summary: {
          ...seed.summary,
          ...(listed.length > 0 && { agents: listed }),
          ...(seed.summary.state === "Active" &&
            seed.ports !== undefined && { openPorts: seed.ports }),
          ...withMcpServers(this.mcpServers.forSession(seed.summary.repo)),
        },
        log,
        queue: [],
        inFlight: null,
        steering: new Set(),
        modSteers: true,
        modAttaches: true,
        guests: [],
        stopTurn: null,
        terminal: null,
        startLog: "",
        agents,
        ports: seed.ports ?? [],
      })
    }
  }

  // ── HubTransport ─────────────────────────────────────────────────────────

  open(handlers: SocketHandlers): HubSocket {
    const socket = new FakeSocket(this, handlers)
    if (!this.#signedIn || this.#down) {
      // The real Hub refuses the upgrade without a sign-in cookie: the socket never opens.
      socket.closed = true
      setTimeout(() => handlers.onClose(), 0)
      return socket
    }
    this.#sockets.add(socket)
    setTimeout(() => {
      if (!socket.closed) handlers.onOpen()
    }, 0)
    return socket
  }

  async signInStatus(): Promise<SignInStatus> {
    return this.#signedIn
      ? { signedIn: true, you: decodeParticipant(this.#you) }
      : { signedIn: false, options: this.#signInOptions }
  }

  /**
   * As the Hub does: a Login code for the machine. The fake then plays the CLI trading it at once,
   * so the Account page lists a CLI token for the machine.
   */
  async approveCli(request: CliLoginApproval): Promise<CliLoginApproved> {
    if (!this.#signedIn) throw new Error("Sign in first.")
    const approval = decodeApproval(request)
    let code = ""
    for (let i = 0; i < CliLoginCodeLength; i++) {
      code += PairingAlphabet[Math.floor(Math.random() * PairingAlphabet.length)]
    }
    const now = Date.now()
    this.#cliTokens.unshift({ id: `ct-${++this.#ids}`, machine: approval.machine, createdAt: now })
    this.#toAll({ _tag: "CliTokenList", tokens: this.#cliTokens })
    return { code: formatCliLoginCode(code), expiresAt: now + CliLoginCodeLifetimeMs }
  }

  /** Keeps the secret, as the Hub keeps it in a cookie for the GitHub sign-in that follows. */
  async admit(ticket: string): Promise<void> {
    if (!this.#signInOptions.github) throw new Error("Not Found")
    this.admissions.push(ticket)
  }

  /**
   * As the Hub does (#276, #277): an image Claude reads, of 5 MB at most, or a PDF of 10 MB at
   * most, kept for the Session. The fake trusts the file's type, and shows it from the browser's
   * own copy.
   */
  async uploadAttachment(
    sessionId: SessionId,
    file: File,
    { onProgress, signal }: UploadOptions,
  ): Promise<AttachmentId> {
    if (!this.#signedIn) throw new Error("Sign in first")
    if (file.size > MaxAttachmentBytes) throw new Error(tooLargeForAnyReason)
    const mediaType = AttachmentMediaTypes.find((type) => type === file.type)
    if (mediaType === undefined) throw new Error(unsupportedAttachmentReason)
    const rules = attachmentRules(mediaType)
    if (file.size > rules.maxBytes) throw new Error(rules.tooLarge)
    onProgress(Math.round(file.size / 2))
    await new Promise((resolve) => setTimeout(resolve, this.stepMs))
    if (signal.aborted) throw new DOMException("Aborted", "AbortError")
    onProgress(file.size)
    const id = AttachmentId.make(`att-${++this.#ids}`)
    this.#attachments.set(id, {
      attachment: {
        id,
        name: attachmentName(file.name, rules.fallbackName),
        mediaType,
        size: file.size,
      },
      sessionId,
      by: this.#you.id,
      url: URL.createObjectURL(file),
    })
    return id
  }

  attachmentUrl(_sessionId: SessionId, attachmentId: AttachmentId): string {
    return this.#attachments.get(attachmentId)?.url ?? ""
  }

  async devSignIn(login?: string): Promise<void> {
    if (!this.#signInOptions.dev) throw new Error("Dev login is off.")
    this.#signedIn = true
    if (login) this.#you = { id: `dev:${login}`, login, name: login }
  }

  async signOut(): Promise<void> {
    this.#signedIn = false
    this.#closeAll()
  }

  // ── Test controls ────────────────────────────────────────────────────────

  /**
   * Changes a Runner as the Hub would list it: online and behind the Hub, say, or with an update
   * refused or failed. In the browser, `fakeHub.patchRunner("r-ci", { isOnline: true })`.
   */
  patchRunner(runnerId: string, patch: Partial<RunnerSummaryWire>): void {
    this.runners = this.runners.map((runner) =>
      runner.id === runnerId ? { ...runner, ...patch } : runner,
    )
    this.#toAll(this.#runnerList())
  }

  /**
   * A machine redeems the newest Pairing code, as `kndl runner join` would, and connects: a
   * new Runner named `name`, or, for a Re-pair's code, that Runner with a new token. In the
   * browser, `fakeHub.redeemPairingCode("mac-mini")` in the console.
   */
  redeemPairingCode(name = "mac-mini"): void {
    const code = this.pairingCodes.at(-1)
    if (code === undefined) return
    this.#dropCodes((other) => other.id === code.id)
    const connected = {
      isOnline: true,
      version: hubVersion,
      versionStatus: "Current" as const,
      lastSeenAt: Date.now(),
    }
    const runnerId = code.runnerId ?? `r-${++this.#ids}`
    const repaired = this.runners.find((runner) => runner.id === runnerId)
    if (repaired === undefined) {
      this.runners = [...this.runners, { id: runnerId, name, openSessions: 0, ...connected }]
    } else {
      this.runners = this.runners.map((runner) =>
        runner.id === runnerId ? { ...runner, ...connected } : runner,
      )
    }
    this.#toAll({
      _tag: "PairingCodeRedeemed",
      id: code.id,
      runnerId,
      name: repaired?.name ?? name,
      repaired: repaired !== undefined,
    })
    this.#toAll(this.#runnerList())
    this.#toAll(this.#pairingCodeList())
  }

  /**
   * Someone signs in with the oldest Invite they can use, as GitHub sign-in would admit them: a new
   * Member, and the Invite used up. In the browser, `fakeHub.acceptInvite("carol-dev")`.
   */
  acceptInvite(login = "carol-dev"): void {
    const now = Date.now()
    const invite = this.invites.find(
      (candidate) =>
        candidate.expiresAt > now &&
        (candidate.login === undefined || candidate.login.toLowerCase() === login.toLowerCase()),
    )
    if (invite === undefined) return
    this.invites = this.invites.filter((other) => other !== invite)
    this.members.push({
      participant: { id: `u-${login}`, login, name: login },
      owner: false,
      admittedAt: now,
    })
    this.#toOwner(this.#memberList())
    this.#toOwner(this.#inviteList())
  }

  /**
   * The Session's Creator prompts it from elsewhere, as from another tab, and Claude replies as
   * it does to a prompt from the web: for whoever watches it (ADR 0026). In the browser,
   * `fakeHub.creatorPrompts("s-landing", "ask me first")` in the console.
   */
  creatorPrompts(sessionId: string, text: string): void {
    const session = this.sessions.get(sessionId)
    if (session) this.#prompt(session, session.summary.creator, text, this.#reply(text))
  }

  /**
   * The Session's Claude Code runs a mod from before steering (#195), as on a Runner not updated
   * yet: its queued prompts can't be steered. In the browser,
   * `fakeHub.modFromBeforeSteering("s-demo")` in the console.
   */
  modFromBeforeSteering(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (session) {
      session.modSteers = false
      session.modAttaches = false
    }
  }

  /**
   * The Session's Claude Code runs a mod from before attachments went beyond prompts (#278): it
   * steers, but files can't be steered, sent to a subagent or replied with. In the browser,
   * `fakeHub.modFromBeforeAttaching("s-demo")` in the console.
   */
  modFromBeforeAttaching(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (session) session.modAttaches = false
  }

  /**
   * The attachments a prompt, message or reply names, marked sent as the Hub marks them (#276,
   * #278): only those its sender uploaded to the Session, all or none; none, having refused the
   * command, if not.
   */
  #markSentOrRefuse(
    socket: FakeSocket,
    message: {
      readonly _tag: string
      readonly sessionId: string
      readonly attachments?: ReadonlyArray<string>
    },
    what: string,
  ): ReadonlyArray<AttachmentWire> | undefined {
    const named = (message.attachments ?? []).map((id) => this.#attachments.get(id))
    const taken = named.flatMap((uploaded) =>
      uploaded?.sessionId === message.sessionId && uploaded.by === this.#you.id
        ? [uploaded.attachment]
        : [],
    )
    if (taken.length === named.length) return taken
    this.#fail(socket, message._tag, attachmentsNotSent(what).refusal, message.sessionId)
    return undefined
  }

  /** Drops every connection, as a network blip would. */
  dropConnections(): void {
    this.#closeAll()
  }

  /**
   * Holds every timed step from now on: one that comes due waits for `step`, until `resume`. A
   * test that looks at what shows between two steps holds them, so a slow machine can't skip
   * past one (#315).
   */
  hold(): void {
    this.#holding = true
  }

  /** Runs the next held step, in the order they came due, waiting for one if none has yet. */
  async step(): Promise<void> {
    for (;;) {
      const next = this.#held.shift()
      if (next === undefined) {
        await new Promise<void>((resolve) => (this.#heldArrived = resolve))
        continue
      }
      // A step stopped while it waited, as a Turn's are when it ends, stays stopped.
      if (!this.#timers.delete(next.timer)) continue
      next.fn()
      return
    }
  }

  /** Stops holding: runs every held step, in order, and the rest when they come due. */
  resume(): void {
    this.#holding = false
    for (const next of this.#held.splice(0)) if (this.#timers.delete(next.timer)) next.fn()
  }

  /** Stops every timer, so a test leaves nothing running. */
  dispose(): void {
    for (const timer of this.#timers) clearTimeout(timer)
    this.#timers.clear()
    this.#closeAll()
  }

  #closeAll(): void {
    // Closing a socket takes it out of the set, so iterate over a copy.
    for (const socket of Array.from(this.#sockets)) socket.close()
  }

  /**
   * Bob applies a version of `repo`'s Environment that gives each Sandbox more memory, as a
   * teammate would meanwhile: a draft made from the version before is then stale. In the browser,
   * `fakeHub.teammateApplies("kddige/kndl")` in the console.
   */
  teammateApplies(repo: string): void {
    const { environment } = this.environments.state(repo)
    if (!environment) return
    const { version: _, repo: __, ...recipe } = environment
    const refused = this.environments.apply(
      repo,
      environment.version,
      {
        ...recipe,
        resources: { ...recipe.resources, memoryMib: recipe.resources.memoryMib + 1024 },
      },
      bob,
    )
    if (refused === undefined) this.#environmentApplied(repo)
  }

  /** Tells everyone but `except` (who asked) the Repo's new version, and its Sessions too. */
  #environmentApplied(repo: string, except?: FakeSocket): void {
    const state = this.environments.state(repo)
    for (const socket of this.#sockets) {
      if (socket !== except && socket.welcomed) socket.deliver(state)
    }
    const latestVersion = this.environments.latestVersion(repo)
    if (latestVersion === undefined) return
    for (const session of this.sessions.values()) {
      if (!sameRepo(session.summary.repo, repo)) continue
      session.summary = {
        ...session.summary,
        environment: { version: session.summary.environment?.version ?? null, latestVersion },
      }
      this.#summaryChanged(session)
    }
  }

  /**
   * Changes what the GitHub App's permission check finds, as fixing them on GitHub would, and tells
   * everyone: the real Hub does at its next check. In the browser,
   * `fakeHub.setAppPermissions(null)` in the console.
   */
  setAppPermissions(check: AppPermissionsCheckWire | null): void {
    this.#appPermissions = check
    if (check === null) return
    for (const socket of this.#sockets) {
      if (socket.welcomed) socket.deliver({ _tag: "AppPermissionsChecked", check })
    }
  }

  /**
   * Changes what the Hub's update check found (ADR 0028), as its next check would, and tells the
   * Owner. In the browser, `fakeHub.setHubUpdate({ follows: { _tag: "Pinned", ref: "fix" } })` in
   * the console.
   */
  setHubUpdate(update: HubUpdateStateWire): void {
    this.#hubUpdate = update
    if (this.#owner) this.#toAll({ _tag: "HubUpdateChecked", update })
  }

  /**
   * Takes the signed-in person's access to `repo` away, as the real Hub does when GitHub says so
   * at its next check: its Sessions and Environment are gone from them. In the browser,
   * `fakeHub.revokeRepo("kddige/kndl")` in the console.
   */
  revokeRepo(repo: string): void {
    this.repoAccess.set(repo, "NoAccess")
    for (const session of this.sessions.values()) {
      if (!sameRepo(session.summary.repo, repo)) continue
      this.sessions.delete(session.summary.id)
      this.#toAll({ _tag: "SessionRemoved", sessionId: session.summary.id })
    }
    this.#toAll({ _tag: "RepoAccessLost", repo })
  }

  /**
   * Claude Code exits on its own, as when it can't start (#105): the Session goes Asleep with
   * what it printed last, as the Hub keeps it from its Runner's SessionStopped. In the browser,
   * `fakeHub.claudeExits("s-demo", 1, "error: …")` in the console.
   */
  claudeExits(sessionId: string, exitCode: number, output: string): void {
    const session = this.sessions.get(sessionId)
    if (!session) return
    const { starting: _, restarting: __, ...summary } = session.summary
    session.summary = { ...summary, currentTurn: null, lastOutput: output }
    this.#setState(session, "Asleep", `Claude Code exited with code ${exitCode}`)
  }

  /**
   * A running Session's Installation fails (#216), as the Gateway notes a server refusing its
   * credential: an error in the Session, which runs on. In the browser,
   * `fakeHub.installationFails("s-demo", "Sentry", 401)` in the console.
   */
  installationFails(sessionId: string, name: string, status: number): void {
    const session = this.sessions.get(sessionId)
    const installation = session?.summary.mcpServers?.find((one) => one.name === name)
    if (!session || !installation) return
    const failure = {
      installationId: installation.id,
      installation: installation.name,
      reason: "Rejected" as const,
      status,
    }
    this.#append(session, {
      _tag: "SandboxNoted",
      message: `${installationFailureText(failure)} Its tools fail until the Installation is fixed and the Session restarted.`,
      installationFailed: failure,
    })
  }

  /** What GitHub says of the signed-in person and `repo`, however its name is spelled (#197). */
  #repoStatus(repo: string): RepoStatus {
    for (const [known, status] of this.repoAccess) if (sameRepo(known, repo)) return status
    return "Allowed"
  }

  /** Whether the signed-in person has access to `repo`. */
  readonly #allowed = (repo: string): boolean => this.#repoStatus(repo) === "Allowed"

  /**
   * A change to the MCP servers, as the Hub makes it (ADR 0020): everyone is sent them again, each
   * changed Repo's change log, and its Sessions whether their Installations changed since they
   * started, which a Restart applies. A change to a global Installation reaches every Repo (#219).
   */
  #changeMcpServers(socket: FakeSocket, message: McpServerChangeCommand): void {
    const outcome = this.mcpServers.change(message, this.#you, this.#allowed, this.#owner)
    if ("refused" in outcome) {
      this.#refuse(socket, message._tag, message.requestId, outcome.refused)
      return
    }
    if ("needsClient" in outcome) {
      // No Dynamic Client Registration (#218): a client entered by hand first, nothing changed.
      if (message._tag !== "ConnectInstallation") return
      socket.deliver({
        _tag: "InstallationNeedsClient",
        requestId: message.requestId,
        installationId: message.installationId,
        ...outcome.needsClient,
        callbackUrl: `${globalThis.location?.origin ?? "http://localhost:5173"}/auth/mcp/callback`,
      })
      return
    }
    const state = this.mcpServers.state(this.#allowed)
    if (message._tag === "ConnectInstallation" && outcome.authorizing !== undefined) {
      // Where the browser goes to connect (#217): the fake's "consent" is already given.
      socket.deliver({
        _tag: "InstallationAuthorizing",
        requestId: message.requestId,
        installationId: message.installationId,
        url: outcome.authorizing,
      })
      socket.deliver(state)
    } else {
      socket.deliver({ ...state, requestId: message.requestId })
    }
    this.#toOthers(socket, state)
    const repos = new Map(outcome.repos.map((repo) => [repoKey(repo), repo]))
    if (outcome.everyRepo === true) {
      for (const session of this.sessions.values()) {
        repos.set(repoKey(session.summary.repo), session.summary.repo)
      }
    }
    for (const repo of repos.values()) {
      this.#toAll({ _tag: "McpServerLog", repo, entries: [...this.mcpServers.log(repo)] })
      const now = this.mcpServers.forSession(repo)
      for (const session of this.sessions.values()) {
        if (!sameRepo(session.summary.repo, repo) || session.summary.state === "Archived") continue
        const { mcpServersChanged: _, ...summary } = session.summary
        const changed = installationsDiffer(session.summary.mcpServers ?? [], now)
        session.summary = changed ? { ...summary, mcpServersChanged: true } : summary
        this.#summaryChanged(session)
      }
    }
  }

  /** Refuses a command about a Repo out of reach, as the real Hub does; whether it did. */
  #refusedRepo(socket: FakeSocket, command: string, requestId: string, repo: string): boolean {
    if (this.#repoStatus(repo) === "Allowed") return false
    this.#refuse(
      socket,
      command,
      requestId,
      `You have no access to ${repo} on GitHub, or the GitHub App isn't installed on it.`,
    )
    return true
  }

  /** Starts the demo Session's script now, rather than on the first join. */
  play(): void {
    if (this.#scriptStarted) return
    this.#scriptStarted = true
    const session = this.sessions.get(demoSessionId)
    if (!session) return
    this.#after(4, () => {
      // Bob forwards its dev servers to his laptop, too (#180).
      session.guests.push({ ...bob, forwardingFrom: ["bob-mbp"] })
      this.#presence(session)
    })
    // Its Creator prompts it, as from another tab: only they drive it (ADR 0026).
    this.#after(6, () =>
      this.#prompt(
        session,
        session.summary.creator,
        "Can you make tool calls collapse by default?",
        scriptedTurn,
      ),
    )
  }

  // ── The channel ──────────────────────────────────────────────────────────

  receive(socket: FakeSocket, text: string): void {
    if (socket.closed) return
    const raw: unknown = JSON.parse(text)
    if (!socket.welcomed) {
      const rejection = checkHandshake(raw)
      if (rejection) {
        socket.deliver(rejection)
        socket.close()
        return
      }
    }
    let message: WebToHub
    try {
      message = decodeWebToHub(raw)
    } catch (error) {
      throw new Error(`The fake Hub got a message the protocol refuses: ${text}`, { cause: error })
    }
    this.received.push(message)
    if (!socket.welcomed && message._tag !== "WebHello") return
    switch (message._tag) {
      case "WebHello":
        socket.welcomed = true
        socket.deliver({
          _tag: "WebWelcome",
          protocolVersion: ProtocolVersion,
          you: this.#you,
          hub: this.#hubVersion,
          ...(this.#owner && { owner: true }),
          ...(this.#owner && this.#hubUpdate !== null && { hubUpdate: this.#hubUpdate }),
          ...(this.#owner &&
            this.#hubUpdate !== null &&
            this.#hubUpdateRun !== null && { hubUpdateRun: this.#hubUpdateRun }),
        })
        socket.deliver(this.#runnerList())
        socket.deliver(this.#pairingCodeList())
        socket.deliver({
          _tag: "SessionList",
          sessions: [...this.sessions.values()].map((session) => session.summary),
        })
        socket.deliver({ _tag: "ClaudeCredentialState", credential: this.#claudeCredential })
        socket.deliver(this.#providersState())
        socket.deliver({ _tag: "CliTokenList", tokens: this.#cliTokens })
        if (this.#appPermissions !== null) {
          socket.deliver({ _tag: "AppPermissionsChecked", check: this.#appPermissions })
        }
        break
      // As the Hub does (ADR 0015, ADR 0026): a setup token only, with Anthropic played by the
      // secret: one with REJECTED in it is refused, one with UNREACHABLE in it stored with a
      // warning. Every value here is fake.
      case "SetClaudeCredential": {
        const secret = Redacted.value(message.secret).trim()
        const problem = claudeCredentialProblem(secret)
        if (problem !== undefined) {
          this.#refuse(socket, message._tag, message.requestId, problem)
          break
        }
        if (secret.includes("REJECTED")) {
          this.#refuse(
            socket,
            message._tag,
            message.requestId,
            "Anthropic rejected this token: it is invalid.",
          )
          break
        }
        this.#setClaudeCredential(
          socket,
          message.requestId,
          { kind: "OAuthToken", last4: secret.slice(-4), addedAt: Date.now() },
          secret.includes("UNREACHABLE")
            ? "Saved without checking it: Anthropic couldn't be reached. If it is wrong, Sessions on it can't run a Turn; replace it here."
            : undefined,
        )
        break
      }
      case "RemoveClaudeCredential":
        this.#setClaudeCredential(socket, message.requestId, null)
        break
      case "GetProviders":
        socket.deliver(this.#providersState(message.requestId))
        break
      case "ConnectProviderKey": {
        const refused = this.providers.connectKey(message.provider, Redacted.value(message.apiKey))
        if (refused !== undefined) this.#refuse(socket, message._tag, message.requestId, refused)
        else this.#providersChanged(socket, message.requestId)
        break
      }
      case "DisconnectProvider": {
        const refused = this.providers.disconnect(message.provider)
        if (refused !== undefined) this.#refuse(socket, message._tag, message.requestId, refused)
        else this.#providersChanged(socket, message.requestId)
        break
      }
      case "RefreshProviderModels":
        this.providers.refresh(message.provider)
        this.#providersChanged(socket, message.requestId)
        break
      case "StartSignIn":
        this.#startSignIn(socket, message.requestId, message.provider)
        break
      case "AnswerSignIn": {
        const signIn = this.#signIn
        if (signIn?.requestId !== message.requestId || signIn.waitsFor === null) {
          this.#refuse(socket, message._tag, message.requestId, "No sign-in is waiting for that.")
          break
        }
        // GitHub Copilot's choice of GitHub: its code follows, whichever.
        if (signIn.waitsFor === "Choose") {
          signIn.waitsFor = null
          this.#playSignIn(signIn, signIn.afterChoice)
          break
        }
        signIn.waitsFor = null
        const problem = pasteProblem(Redacted.value(message.value))
        if (problem !== undefined) {
          this.#endSignIn("Failed", problem)
          break
        }
        this.#signInStep({
          _tag: "Progress",
          message: `Checking with ${providerName(signIn.provider)}…`,
        })
        this.#after(2, () => this.#signInConnected(signIn.requestId))
        break
      }
      case "CancelSignIn":
        if (this.#signIn?.requestId === message.requestId) this.#endSignIn("Cancelled")
        else this.#refuse(socket, message._tag, message.requestId, "No sign-in is in progress.")
        break
      case "RevokeCliToken": {
        const kept = this.#cliTokens.filter((token) => token.id !== message.cliTokenId)
        if (kept.length === this.#cliTokens.length) {
          this.#refuse(socket, message._tag, message.requestId, "You have no such CLI token.")
          break
        }
        this.#cliTokens = kept
        socket.deliver({ _tag: "CliTokenList", requestId: message.requestId, tokens: kept })
        this.#toOthers(socket, { _tag: "CliTokenList", tokens: kept })
        break
      }
      case "CreateInvite":
      case "ListInvites":
      case "RevokeInvite":
      case "ListMembers":
      case "RemoveMember":
        this.#people(socket, message)
        break
      case "CheckAppPermissions":
        if (this.#appPermissions === null) {
          this.#refuse(
            socket,
            message._tag,
            message.requestId,
            "This needs the GitHub App, which the Hub doesn't have.",
          )
          break
        }
        socket.deliver({
          _tag: "AppPermissionsChecked",
          requestId: message.requestId,
          check: { ...this.#appPermissions, checkedAt: Date.now() },
        })
        break
      // As the Hub does: the Owner's alone, on a Hub that checks. GitHub has nothing new since.
      case "CheckHubUpdate": {
        if (!this.#owner) {
          this.#refuse(socket, message._tag, message.requestId, ownerOnlyMessage)
          break
        }
        const update = this.#hubUpdate
        if (update === null) {
          this.#refuse(socket, message._tag, message.requestId, hubUpdatesOffMessage)
          break
        }
        const checked: HubUpdateStateWire =
          update.follows._tag === "Pinned"
            ? update
            : {
                follows: update.follows,
                checked: { at: Date.now(), found: update.checked?.found ?? { _tag: "UpToDate" } },
              }
        this.#hubUpdate = checked
        socket.deliver({ _tag: "HubUpdateChecked", requestId: message.requestId, update: checked })
        this.#toOthers(socket, { _tag: "HubUpdateChecked", update: checked })
        break
      }
      case "UpdateHub":
        this.#updateHub(socket, message)
        break
      case "CheckRepo": {
        const status = this.#repoStatus(message.repo)
        socket.deliver({
          _tag: "RepoChecked",
          requestId: message.requestId,
          repo: message.repo,
          status,
          ...(status === "NotInstalled" && {
            installUrl: "https://github.com/apps/kndl/installations/new",
          }),
        })
        break
      }
      case "ListRepos": {
        if (this.listingDown) {
          socket.deliver({ _tag: "ListingUnavailable", requestId: message.requestId })
          break
        }
        if (this.listingFails) {
          this.#refuse(socket, message._tag, message.requestId, notListed)
          break
        }
        const repos = new Map<string, string>()
        for (const session of this.sessions.values()) {
          repos.set(repoKey(session.summary.repo), session.summary.repo)
        }
        for (const repo of this.branches.keys()) repos.set(repoKey(repo), repo)
        socket.deliver({
          _tag: "ReposListed",
          requestId: message.requestId,
          repos: [...repos.values()].filter(this.#allowed).toSorted(),
        })
        break
      }
      case "ListBranches": {
        if (this.#refusedRepo(socket, message._tag, message.requestId, message.repo)) break
        if (this.listingDown) {
          socket.deliver({ _tag: "ListingUnavailable", requestId: message.requestId })
          break
        }
        if (this.listingFails) {
          this.#refuse(socket, message._tag, message.requestId, notListed)
          break
        }
        const listed = this.branches.get(message.repo) ?? { names: ["main"], defaultBranch: "main" }
        socket.deliver({
          _tag: "BranchesListed",
          requestId: message.requestId,
          repo: message.repo,
          branches: listed.names,
          defaultBranch: listed.defaultBranch,
        })
        break
      }
      case "CreateSession":
        if (this.#refusedRepo(socket, message._tag, message.requestId, message.repo)) break
        this.#create(socket, message.requestId, message.repo, message.branch, message.runnerId, {
          ...(message.harness !== undefined && { harness: message.harness }),
          ...(message.model !== undefined && { model: message.model }),
          ...(message.thinkingLevel !== undefined && { thinkingLevel: message.thinkingLevel }),
        })
        break
      // As the Hub does (#128): its Creator may (ADR 0026), but not in an Archived Session; the
      // Runner's Claude Code must have the model and level. A running Turn finishes on the old
      // model.
      case "SetSessionModel": {
        const session = this.#drivenFor(socket, message)
        if (!session) break
        if (session.summary.state === "Archived") {
          const refusal = "The Session is archived: restore it to change its model."
          this.#fail(socket, message._tag, refusal, message.sessionId)
          break
        }
        const checked =
          session.summary.harness === "Pi"
            ? this.#checkProviderModel(message)
            : this.#checkModel(session.summary.runnerId, message)
        if (typeof checked === "string") {
          this.#fail(socket, message._tag, checked, message.sessionId)
          break
        }
        const { model: _, thinkingLevel: __, modelPending: ___, ...rest } = session.summary
        if (
          session.summary.model === checked.model &&
          session.summary.thinkingLevel === checked.thinkingLevel
        )
          break
        // The Hub restarts Claude Code with it once no Turn runs, which interrupts its agents.
        const pending = session.summary.currentTurn !== null
        if (!pending) this.#interruptAgents(session)
        session.summary = {
          ...rest,
          ...(checked.model !== undefined && { model: checked.model }),
          ...(checked.thinkingLevel !== undefined && { thinkingLevel: checked.thinkingLevel }),
          ...(pending && { modelPending: true }),
        }
        this.#append(session, {
          _tag: "ModelSwitched",
          by: this.#you,
          ...(checked.model !== undefined && { model: checked.model }),
          ...(checked.label !== undefined && { modelLabel: checked.label }),
          ...(checked.thinkingLevel !== undefined && { thinkingLevel: checked.thinkingLevel }),
        })
        this.#summaryChanged(session)
        break
      }
      case "JoinSession": {
        const session = this.#sessionFor(socket, message)
        if (!session) break
        socket.joined.add(message.sessionId)
        const after = message.afterSeq ?? -1
        socket.deliver({
          _tag: "SessionHistory",
          sessionId: message.sessionId,
          entries: session.log.filter((entry) => entry.seq > after),
        })
        socket.deliver({
          _tag: "PromptQueueChanged",
          sessionId: message.sessionId,
          queue: session.queue,
        })
        if (session.asking && session.asking.picks.length > 0) {
          socket.deliver({
            _tag: "QuestionPicks",
            sessionId: message.sessionId,
            toolCallId: session.asking.toolCallId,
            picks: session.asking.picks,
          })
        }
        const starting = session.summary.starting
        if (starting && session.startLog !== "") {
          socket.deliver({
            _tag: "SessionStartLogged",
            sessionId: message.sessionId,
            since: starting.since,
            data: session.startLog,
            replace: true,
          })
        }
        this.#presence(session)
        if (message.sessionId === demoSessionId && this.#autoplay) this.play()
        break
      }
      case "LeaveSession": {
        socket.joined.delete(message.sessionId)
        const session = this.sessions.get(message.sessionId)
        if (session) this.#presence(session)
        break
      }
      case "SendPrompt": {
        const session = this.#drivenFor(socket, message)
        if (!session) break
        const cantSend = sendPromptRefusal(session.summary)
        if (cantSend !== undefined) {
          this.#fail(socket, message._tag, cantSend.refusal, message.sessionId)
          break
        }
        const attachments = this.#markSentOrRefuse(socket, message, "prompt")
        if (!attachments) break
        this.#prompt(session, this.#you, message.text, this.#reply(message.text), attachments)
        break
      }
      // As the Hub does: a prompt on its way to Claude Code can't be cancelled.
      case "CancelPrompt": {
        const session = this.#drivenFor(socket, message)
        if (!session) break
        const cantCancel = cancelRefusal(this.#handover(session, message.promptId))
        if (cantCancel !== undefined) {
          this.#fail(socket, message._tag, cantCancel.refusal, message.sessionId)
          break
        }
        session.queue = session.queue.filter((prompt) => prompt.id !== message.promptId)
        this.#replies.delete(message.promptId)
        this.#queueChanged(session)
        break
      }
      // As the Hub and the mod do (ADR 0018): the prompt keeps its place in the queue until the
      // mod has appended it to the running Turn, which reads it at its next step.
      case "SteerPrompt": {
        const session = this.#drivenFor(socket, message)
        if (!session) break
        const { promptId } = message
        const verdict = steerVerdict({
          ...this.#handover(session, promptId),
          turnRunning:
            session.summary.state === "Active" &&
            session.summary.currentTurn !== null &&
            !this.#goingToSleep(session),
          modSteers: session.modSteers,
          hasAttachments:
            (session.queue.find((prompt) => prompt.id === promptId)?.attachments?.length ?? 0) > 0,
          modAttaches: session.modAttaches,
        })
        if (typeof verdict === "object") {
          this.#fail(socket, message._tag, verdict.refusal, message.sessionId)
          break
        }
        if (verdict === "ok") this.#steer(session, promptId)
        break
      }
      case "StopTurn": {
        const session = this.#drivenFor(socket, message)
        if (!session) break
        const cantStop = stopTurnRefusal(session.summary)
        if (cantStop !== undefined) {
          this.#fail(socket, message._tag, cantStop.refusal, message.sessionId)
          break
        }
        // Logged and sent to the mod whether or not a Turn runs, as on the Hub.
        this.#append(session, { _tag: "TurnStopRequested", by: this.#you })
        session.stopTurn?.()
        break
      }
      // As the Hub and the mod do (#193): the first answer is Claude's; a later one is refused,
      // saying who answered first.
      case "AnswerQuestion": {
        const session = this.#drivenFor(socket, message)
        if (!session) break
        if (session.asking?.toolCallId !== message.toolCallId) {
          const closed = session.log.findLast(
            ({ event }) =>
              event._tag === "QuestionClosed" && event.toolCallId === message.toolCallId,
          )
          this.#fail(
            socket,
            message._tag,
            closed
              ? `${questionClosedText(decodeQuestionClosed(closed.event), true)}.`
              : "The question is no longer open.",
            message.sessionId,
          )
          break
        }
        const { answer } = message
        const cantAttach = answerAttachmentsRefusal({
          replied: answer._tag === "Replied",
          hasAttachments: (message.attachments?.length ?? 0) > 0,
          modAttaches: session.modAttaches,
        })
        if (cantAttach !== undefined) {
          this.#fail(socket, message._tag, cantAttach.refusal, message.sessionId)
          break
        }
        const carried = this.#markSentOrRefuse(socket, message, "reply")
        if (!carried) break
        session.asking.answer(
          answer._tag === "Replied" && carried.length > 0
            ? { ...answer, attachments: carried }
            : answer,
          this.#you,
        )
        break
      }
      case "PickAnswer": {
        const session = this.#drivenFor(socket, message)
        const asking = session?.asking
        if (!session || asking?.toolCallId !== message.toolCallId) break
        const { question, answer } = message
        this.#pick(session, { participant: this.#you, question, answer })
        break
      }
      // As the Hub does (ADR 0014): its Creator may message an agent (ADR 0026), which resumes one
      // that has stopped, waking its Session first; a Running one can be stopped.
      case "MessageAgent": {
        const session = this.#drivenFor(socket, message)
        if (!session) break
        const verdict = messageAgentVerdict({
          state: session.summary.state,
          goingToSleep: this.#goingToSleep(session),
          agentKnown: session.agents.has(message.agentId),
          hasAttachments: (message.attachments?.length ?? 0) > 0,
          modAttaches: session.modAttaches,
        })
        if (typeof verdict === "object") {
          this.#fail(socket, message._tag, verdict.refusal, message.sessionId)
          break
        }
        if (verdict === "wake") {
          this.#wake(session, "Woken on studio", this.#you)
          if (!session.summary.starting) {
            const reason = "The Session could not be woken: see its history."
            this.#fail(socket, message._tag, reason, message.sessionId)
            break
          }
        }
        // Marked sent as it is logged, as on the Hub: a refused wake keeps none.
        const carried = this.#markSentOrRefuse(socket, message, "message")
        if (!carried) break
        this.#append(session, {
          _tag: "AgentMessaged",
          agentId: message.agentId,
          sender: this.#you,
          text: message.text,
          ...(carried.length > 0 && { attachments: carried }),
        })
        this.#deliverAgentMessage(
          session,
          message.agentId,
          message.text || attachmentCount(carried),
        )
        break
      }
      case "StopAgent": {
        const session = this.#drivenFor(socket, message)
        if (!session) break
        const agent = session.agents.get(message.agentId)
        const cantStop = stopAgentRefusal({
          state: session.summary.state,
          agent: agent?.summary.status,
        })
        if (cantStop !== undefined) {
          this.#fail(socket, message._tag, cantStop.refusal, message.sessionId)
          break
        }
        agent?.stop?.("Stopped")
        break
      }
      case "SleepSession": {
        const session = this.#drivenFor(socket, message)
        if (!session) break
        const verdict = sleepVerdict(this.#sessionNow(session))
        // Pressing Sleep turns Keep awake off, as on the Hub (ADR 0016), even while it is going
        // to sleep.
        if (typeof verdict === "object") {
          this.#fail(socket, message._tag, verdict.refusal, message.sessionId)
          break
        }
        this.#setKeepAwake(session, false)
        if (verdict === "sleep") this.#setState(session, "Asleep", "Put to sleep", this.#you)
        break
      }
      case "SetKeepAwake": {
        const session = this.#drivenFor(socket, message)
        if (!session) break
        if (session.summary.state === "Archived") {
          this.#fail(socket, message._tag, "The Session is archived.", message.sessionId)
          break
        }
        this.#setKeepAwake(session, message.on)
        if (message.on && session.summary.state === "Asleep") {
          this.#wake(session, "Woken on studio", this.#you)
          this.#next(session)
        }
        break
      }
      case "WakeSession": {
        const session = this.#drivenFor(socket, message)
        if (!session) break
        const verdict = wakeVerdict({
          state: session.summary.state,
          goingToSleep: this.#goingToSleep(session),
        })
        if (typeof verdict === "object") {
          this.#fail(socket, message._tag, verdict.refusal, message.sessionId)
          break
        }
        if (verdict === "wake") {
          this.#wake(session, "Woken on studio", this.#you)
          this.#next(session)
        }
        break
      }
      case "RestartSession":
        if (this.#drivenFor(socket, message)) this.#restart(socket, message.sessionId)
        break
      case "GetMcpServers":
        socket.deliver({ ...this.mcpServers.state(this.#allowed), requestId: message.requestId })
        break
      case "GetMcpServerLog":
        if (this.#refusedRepo(socket, message._tag, message.requestId, message.repo)) break
        socket.deliver({
          _tag: "McpServerLog",
          requestId: message.requestId,
          repo: message.repo,
          entries: [...this.mcpServers.log(message.repo)],
        })
        break
      case "CreateMcpServer":
      case "EditMcpServer":
      case "DeleteMcpServer":
      case "CreateInstallation":
      case "EditInstallation":
      case "DeleteInstallation":
      case "AddMcpServerPackage":
      case "UpgradeMcpServer":
      case "TurnGlobalInstallation":
      case "ConnectInstallation":
      case "DisconnectInstallation":
        this.#changeMcpServers(socket, message)
        break
      case "ReadMcpServerPackage":
      case "CheckMcpServerUpgrade": {
        const read = this.mcpServers.read(message, this.#you)
        if ("refused" in read) this.#refuse(socket, message._tag, message.requestId, read.refused)
        else socket.deliver(read)
        break
      }
      case "GetEnvironment":
        if (this.#refusedRepo(socket, message._tag, message.requestId, message.repo)) break
        socket.deliver({ ...this.environments.state(message.repo), requestId: message.requestId })
        break
      case "CheckEnvironmentDraft": {
        if (this.#refusedRepo(socket, message._tag, message.requestId, message.repo)) break
        const prepared = this.environments.prepare(message.repo, message.draft)
        if (typeof prepared === "string") {
          this.#refuse(socket, message._tag, message.requestId, prepared)
          break
        }
        socket.deliver({
          _tag: "EnvironmentDraftChecked",
          requestId: message.requestId,
          repo: message.repo,
          needsTestBuild: prepared.changesBuild,
          testBuildPassed: this.environments.testBuildPassed(message.repo, prepared.digest),
        })
        break
      }
      case "StartTestBuild": {
        if (this.#refusedRepo(socket, message._tag, message.requestId, message.repo)) break
        const runner = this.runners.find((candidate) => candidate.id === message.runnerId)
        if (!runner?.isOnline) {
          const reason = `Runner ${message.runnerId} is not online.`
          this.#refuse(socket, message._tag, message.requestId, reason)
          break
        }
        const prepared = this.environments.prepare(message.repo, message.draft)
        if (typeof prepared === "string") {
          this.#refuse(socket, message._tag, message.requestId, prepared)
          break
        }
        const testBuildId = `tb-${++this.#ids}`
        socket.deliver({
          _tag: "TestBuildStarted",
          requestId: message.requestId,
          testBuild: {
            id: testBuildId,
            repo: message.repo,
            runnerId: runner.id,
            startedBy: this.#you,
            startedAt: Date.now(),
          },
        })
        const { lines, passes } = testBuildScript(message.repo, message.draft)
        lines.forEach((line, index) =>
          this.#after(index + 1, () =>
            socket.deliver({ _tag: "TestBuildLogged", testBuildId, data: `${line}\n` }),
          ),
        )
        this.#after(lines.length + 1, () => {
          if (passes) this.environments.recordPassed(message.repo, prepared.digest)
          socket.deliver({
            _tag: "TestBuildEnded",
            testBuildId,
            repo: message.repo,
            result: passes ? "Passed" : "Failed",
            ...(!passes && { message: "The bootstrap script failed." }),
          })
        })
        break
      }
      case "ApplyEnvironment": {
        const { repo } = message
        if (this.#refusedRepo(socket, message._tag, message.requestId, repo)) break
        const refused = this.environments.apply(repo, message.baseVersion, message.draft, this.#you)
        if (refused !== undefined) {
          this.#refuse(socket, message._tag, message.requestId, refused)
          break
        }
        socket.deliver({ ...this.environments.state(repo), requestId: message.requestId })
        this.#environmentApplied(repo, socket)
        break
      }
      case "GetSharedVariables":
        socket.deliver({
          _tag: "SharedVariables",
          requestId: message.requestId,
          variables: this.environments.sharedVariables(),
        })
        break
      case "SetSharedVariable":
      case "DeleteSharedVariable": {
        const refused =
          message._tag === "SetSharedVariable"
            ? this.environments.setShared(message.variable)
            : this.environments.deleteShared(message.name)
        if (refused !== undefined) {
          this.#refuse(socket, message._tag, message.requestId, refused)
          break
        }
        const shared = {
          _tag: "SharedVariables" as const,
          variables: this.environments.sharedVariables(),
        }
        socket.deliver({ ...shared, requestId: message.requestId })
        this.#toOthers(socket, shared)
        break
      }
      case "CreatePairingCode": {
        const { runnerId } = message
        if (runnerId !== undefined && !this.runners.some((runner) => runner.id === runnerId)) {
          this.#refuse(socket, message._tag, message.requestId, "There is no such Runner.")
          break
        }
        let code = ""
        for (let i = 0; i < PairingCodeLength; i++) {
          code += PairingAlphabet[Math.floor(Math.random() * PairingAlphabet.length)]
        }
        const createdAt = Date.now()
        const pending: PendingPairingCodeWire = {
          id: `pc-${++this.#ids}`,
          createdBy: this.#you,
          createdAt,
          expiresAt: createdAt + PairingCodeLifetimeMs,
          ...(runnerId !== undefined && { runnerId }),
        }
        // A Re-pair's new code replaces the Runner's earlier one, as on the Hub.
        this.#dropCodes((other) => runnerId !== undefined && other.runnerId === runnerId)
        this.pairingCodes.push(pending)
        socket.deliver({
          _tag: "PairingCodeCreated",
          requestId: message.requestId,
          id: pending.id,
          code: formatPairingCode(code),
          link: pairingLink(globalThis.location?.origin ?? "http://localhost:5173", code),
          expiresAt: pending.expiresAt,
          ...(runnerId !== undefined && { runnerId }),
        })
        this.#toAll(this.#pairingCodeList())
        break
      }
      case "RevokePairingCode": {
        this.#dropCodes((code) => code.id === message.pairingCodeId)
        socket.deliver({ ...this.#pairingCodeList(), requestId: message.requestId })
        this.#toOthers(socket, this.#pairingCodeList())
        break
      }
      case "RemoveRunner": {
        const runner = this.#runnerList().runners.find(
          (candidate) => candidate.id === message.runnerId,
        )
        if (!runner) {
          this.#refuse(socket, message._tag, message.requestId, "There is no such Runner.")
          break
        }
        const refused = runnerRemovalRefusal(runner.name, runner.openSessions)
        if (refused !== undefined) {
          this.#refuse(socket, message._tag, message.requestId, refused)
          break
        }
        this.runners = this.runners.filter((candidate) => candidate.id !== runner.id)
        this.#dropCodes((code) => code.runnerId === runner.id)
        socket.deliver({ _tag: "RunnerRemoved", requestId: message.requestId, runnerId: runner.id })
        this.#toAll(this.#runnerList())
        this.#toAll(this.#pairingCodeList())
        break
      }
      case "GetRunnerHistory": {
        const runner = this.runners.find((candidate) => candidate.id === message.runnerId)
        if (!runner) {
          this.#refuse(socket, message._tag, message.requestId, "There is no such Runner.")
          break
        }
        socket.deliver({
          _tag: "RunnerHistory",
          requestId: message.requestId,
          runnerId: runner.id,
          points: fakeRunnerHistory(runner.sysinfo),
        })
        break
      }
      case "UpdateRunner": {
        const runner = this.runners.find((candidate) => candidate.id === message.runnerId)
        const refused = !this.#owner
          ? ownerOnlyMessage
          : runner === undefined
            ? "There is no such Runner."
            : !runner.isOnline
              ? `${runner.name} is offline: it can update once it is back.`
              : runner.updater?.self !== true
                ? `${runner.name} doesn't update itself.`
                : runner.versionStatus === "Current"
                  ? `${runner.name} already runs the Hub's commit.`
                  : undefined
        if (runner === undefined || refused !== undefined) {
          this.#refuse(socket, message._tag, message.requestId, refused ?? "")
          break
        }
        socket.deliver({
          _tag: "RunnerUpdateRequested",
          requestId: message.requestId,
          runnerId: runner.id,
        })
        this.#updateRunner(runner.id)
        break
      }
      case "ArchiveSession": {
        const session = this.#drivenFor(socket, message)
        if (!session) break
        if (session.summary.state === "Archived") {
          this.#fail(
            socket,
            "ArchiveSession",
            "The Session is already archived.",
            message.sessionId,
          )
          break
        }
        this.#archive(session)
        this.#toAll(this.#runnerList())
        break
      }
      case "RestoreSession": {
        const session = this.#drivenFor(socket, message)
        if (!session) break
        if (session.summary.state !== "Archived") {
          this.#fail(socket, "RestoreSession", "The Session is not archived.", message.sessionId)
          break
        }
        const { archived: _, ...summary } = session.summary
        session.summary = summary
        this.#setState(session, "Asleep", "Restored from the archive", this.#you)
        this.#toAll(this.#runnerList())
        break
      }
      // As the Hub does: a size for an Archived Session whose Runner is online and has one,
      // otherwise none, in the order asked.
      case "GetSessionDiskUsage": {
        const sizes = message.sessionIds.map((sessionId) => {
          const session = this.sessions.get(sessionId)
          const runner = this.runners.find(
            (candidate) => candidate.id === session?.summary.runnerId,
          )
          const bytes = this.diskBytes.get(sessionId)
          return session?.summary.state === "Archived" &&
            runner?.isOnline === true &&
            bytes !== undefined
            ? { sessionId, bytes }
            : { sessionId }
        })
        socket.deliver({ _tag: "SessionDiskUsage", requestId: message.requestId, sizes })
        break
      }
      // As the Hub does: anyone who can see it may, not just its Creator (ADR 0027), once it is
      // Archived. The disk frees at once if its Runner is online, otherwise when it is back.
      case "PurgeArchivedSession": {
        const { requestId, sessionId } = message
        const session = this.sessions.get(sessionId)
        const refused =
          session === undefined
            ? "There is no such Session."
            : session.summary.state !== "Archived"
              ? "Only an Archived Session can be purged: delete it first."
              : undefined
        if (session === undefined || refused !== undefined) {
          socket.deliver({
            _tag: "CommandFailed",
            command: message._tag,
            sessionId,
            requestId,
            message: refused ?? "",
          })
          break
        }
        this.sessions.delete(sessionId)
        this.#toAll({ _tag: "SessionRemoved", sessionId })
        const runner = this.runners.find((candidate) => candidate.id === session.summary.runnerId)
        socket.deliver({
          _tag: "ArchivedSessionPurged",
          requestId,
          sessionId,
          runnerOnline: runner?.isOnline === true,
        })
        break
      }
      // As the Hub does: its Creator may (ADR 0026), in any state; trimmed, empty clears it, too
      // long is refused.
      case "RenameSession": {
        const session = this.#drivenFor(socket, message)
        if (!session) break
        const renamed = sessionNameFrom(message.name)
        if (typeof renamed === "string") {
          this.#fail(socket, "RenameSession", renamed, message.sessionId)
          break
        }
        if ((session.summary.name ?? null) === renamed.name) break
        const { name: _, ...summary } = session.summary
        session.summary = renamed.name === null ? summary : { ...summary, name: renamed.name }
        this.#summaryChanged(session)
        break
      }
      // The terminal, as the real Hub relays it: its Creator's alone (ADR 0026), as raw frames are
      // where their token is easiest to leak. Opening it needs no running terminal, but
      // keystrokes and resizes reach only an Active Session, from a client that opened it. An
      // Archived Session has no terminal to open.
      case "OpenTerminal": {
        const session = this.#drivenFor(socket, message)
        if (!session) break
        if (session.summary.state === "Archived") {
          this.#fail(
            socket,
            "OpenTerminal",
            "The Session is archived: it has no terminal to open.",
            message.sessionId,
          )
          break
        }
        socket.terminals.add(message.sessionId)
        if (session.summary.state === "Active") this.#snapshot(session, [socket])
        break
      }
      case "CloseTerminal":
        socket.terminals.delete(message.sessionId)
        break
      case "TerminalInput":
      case "TerminalResize": {
        const session = this.#drivenFor(socket, message)
        if (!session) break
        if (!socket.terminals.has(message.sessionId)) {
          this.#fail(socket, message._tag, "Open the Session's terminal first.", message.sessionId)
          break
        }
        if (session.summary.state !== "Active") {
          const reason = `The Session is ${session.summary.state}: its terminal isn't running.`
          this.#fail(socket, message._tag, reason, message.sessionId)
          break
        }
        const terminal = this.#terminal(session)
        if (message._tag === "TerminalInput") terminal.type(message.data)
        // Like the Runner, a resize redraws everyone from a snapshot at the new size.
        else if (terminal.resize(message.size)) this.#snapshot(session)
        break
      }
    }
  }

  disconnected(socket: FakeSocket): void {
    this.#sockets.delete(socket)
    for (const sessionId of socket.joined) {
      const session = this.sessions.get(sessionId)
      if (session) this.#presence(session)
    }
  }

  // ── What the Hub does ────────────────────────────────────────────────────

  /**
   * A model setting as the Runner's Claude Code has it, as the Hub checks it (#128): the setting
   * to keep, with the `default` alias as none, and the model's name; or why it is refused.
   */
  #checkModel(
    runnerId: string,
    asked: { readonly model?: string; readonly thinkingLevel?: ThinkingLevel },
  ): { model?: string; thinkingLevel?: ThinkingLevel; label?: string } | string {
    const runner = this.runners.find((candidate) => candidate.id === runnerId)
    const models = runner?.models
    if (models === undefined) {
      if (asked.model === undefined && asked.thinkingLevel === undefined) return {}
      return `${runner?.name ?? "The Runner"} hasn't said which models its Claude Code has: only Claude Code's default model can be used there.`
    }
    const option = asked.model === undefined ? models.default : findModel(models, asked.model)
    if (option === undefined) return modelNotFoundText(asked.model ?? "")
    if (asked.thinkingLevel !== undefined) {
      if (!option.reasoning) return `${option.label} takes no thinking level.`
      if (!models.thinkingLevels.includes(asked.thinkingLevel))
        return `Claude Code on ${runner?.name ?? "the Runner"} has no thinking level '${asked.thinkingLevel}'.`
    }
    return {
      ...(option !== models.default && asked.model !== undefined && { model: asked.model }),
      ...(asked.thinkingLevel !== undefined && { thinkingLevel: asked.thinkingLevel }),
      label: option.label,
    }
  }

  /**
   * A pi Session's model setting, as the Hub checks it against its Creator's Models (ADR 0029):
   * with none asked for, their first, Claude's when they have a credential. Or why it is refused.
   */
  #checkProviderModel(asked: {
    readonly model?: string
    readonly thinkingLevel?: ThinkingLevel
  }): { model: string; thinkingLevel?: ThinkingLevel; label: string } | string {
    const models = this.#providersState().models
    if (models.length === 0) return noModelsText
    const found =
      asked.model === undefined
        ? models[0]
        : models.find((each) => providerModelName(each) === asked.model)
    if (found === undefined) return modelNotFoundText(asked.model ?? "")
    if (asked.thinkingLevel !== undefined && !found.thinkingLevels.includes(asked.thinkingLevel))
      return `${found.label} has no thinking level '${asked.thinkingLevel}'.`
    return {
      model: providerModelName(found),
      ...(asked.thinkingLevel !== undefined && { thinkingLevel: asked.thinkingLevel }),
      label: found.label,
    }
  }

  /** The model a Session's Turns run, as its Runner's Claude Code resolves its setting. */
  #modelId(session: FakeSession): string {
    if (session.summary.harness === "Pi")
      return parseProviderModelName(session.summary.model ?? "")?.id ?? "gpt-6-sol"
    const models = this.runners.find((runner) => runner.id === session.summary.runnerId)?.models
    const { model } = session.summary
    if (models === undefined) return model ?? "claude-opus-5-5"
    const option = model === undefined ? models.default : findModel(models, model)
    return option?.id ?? model ?? models.default.id
  }

  #create(
    socket: FakeSocket,
    requestId: string,
    repo: string,
    branch: BranchChoice,
    runnerId: string | undefined,
    asked: {
      readonly harness?: Harness
      readonly model?: string
      readonly thinkingLevel?: ThinkingLevel
    },
  ): void {
    const runner =
      runnerId === undefined
        ? this.runners.find((candidate) => candidate.isOnline)
        : this.runners.find((candidate) => candidate.id === runnerId)
    if (!runner || !runner.isOnline) {
      const message = runner ? `${runner.name} is offline.` : "No Runner is online."
      socket.deliver({ _tag: "CommandFailed", command: "CreateSession", requestId, message })
      return
    }
    // pi when its Runner runs it, unless Claude Code is asked for (ADR 0029).
    const harness: Harness =
      asked.harness ?? (runner.harnesses?.includes("Pi") === true ? "Pi" : "ClaudeCode")
    if (harness === "Pi" && runner.harnesses?.includes("Pi") !== true) {
      const message = `${runner.name} doesn't run pi.`
      socket.deliver({ _tag: "CommandFailed", command: "CreateSession", requestId, message })
      return
    }
    // A Claude Code Session runs on its Creator's own setup token, with no fallback (ADR 0026).
    if (harness === "ClaudeCode" && this.#claudeCredential === null) {
      const message = noCredentialText
      socket.deliver({ _tag: "CommandFailed", command: "CreateSession", requestId, message })
      return
    }
    const checked =
      harness === "Pi" ? this.#checkProviderModel(asked) : this.#checkModel(runner.id, asked)
    if (typeof checked === "string") {
      socket.deliver({
        _tag: "CommandFailed",
        command: "CreateSession",
        requestId,
        message: checked,
      })
      return
    }
    const version = this.environments.latestVersion(repo)
    if (version === undefined) {
      const message = `${repo} has no Environment yet: set one up before its first Session.`
      socket.deliver({ _tag: "CommandFailed", command: "CreateSession", requestId, message })
      return
    }
    const id = `s-new-${++this.#ids}`
    const summary: SessionSummaryWire = {
      id,
      repo,
      ...branchesFor(branch, SessionId.make(id)),
      state: "Active",
      runnerId: runner.id,
      creator: this.#you,
      createdAt: Date.now(),
      currentTurn: null,
      // Not started on any version until its Runner says so: it is being started on `version`.
      environment: { version: null, latestVersion: version },
      harness,
      ...(checked.model !== undefined && { model: checked.model }),
      ...(checked.thinkingLevel !== undefined && { thinkingLevel: checked.thinkingLevel }),
    }
    const session: FakeSession = {
      summary,
      log: [],
      queue: [],
      inFlight: null,
      steering: new Set(),
      modSteers: true,
      modAttaches: true,
      guests: [],
      stopTurn: null,
      terminal: null,
      startLog: "",
      agents: new Map(),
      ports: [],
    }
    this.sessions.set(id, session)
    this.#start(session)
    socket.deliver({ _tag: "SessionCreated", requestId, session: session.summary })
    for (const other of this.#sockets) {
      if (other !== socket && other.welcomed)
        other.deliver({ _tag: "SessionUpdated", session: session.summary })
    }
    this.#toAll(this.#runnerList())
  }

  /**
   * Starts the Session's Claude Code and Sandbox, as the Hub does on create and wake: Active at
   * once, with `why` in its history, and starting until its Runner says it started, which
   * streams the start's output meanwhile (#70). Queued prompts wait until it has started.
   */
  #start(session: FakeSession, why?: { message: string; by?: ParticipantWire }): void {
    const sessionId = session.summary.id
    const { environment } = this.environments.state(session.summary.repo)
    const since = Date.now()
    // Built the first time it starts on a version; after that the Runner has the build.
    const build =
      environment !== null && session.summary.environment?.version !== environment.version
    session.startLog = ""
    // As on the Hub, what Claude Code printed before it last exited goes once it starts again.
    const {
      lastOutput: _lastOutput,
      mcpServers: _mcpServers,
      mcpServersChanged: _mcpServersChanged,
      ...rest
    } = session.summary
    session.summary = {
      ...rest,
      ...withMcpServers(this.mcpServers.forSession(session.summary.repo)),
      starting: { since, ...(environment !== null && { environmentVersion: environment.version }) },
    }
    if (why) this.#setState(session, "Active", why.message, why.by)
    const lines = sessionStartScript(environment, build)
    const stillStarting = () => session.summary.starting?.since === since
    lines.forEach((data, index) =>
      this.#after(2 * index + 1, () => {
        if (!stillStarting()) return
        session.startLog += data
        for (const socket of this.#joinedSockets(session)) {
          socket.deliver({ _tag: "SessionStartLogged", sessionId, since, data })
        }
      }),
    )
    this.#after(2 * lines.length + 1, () => {
      if (!stillStarting()) return
      const { starting: _, restarting: __, ...started } = session.summary
      // Its dev servers come up with it, and its Runner reports them.
      const summary = session.ports.length > 0 ? { ...started, openPorts: session.ports } : started
      session.summary =
        environment === null
          ? summary
          : {
              ...summary,
              environment: {
                version: environment.version,
                latestVersion: this.environments.latestVersion(summary.repo) ?? environment.version,
              },
            }
      this.#summaryChanged(session)
      // Claude Code is up: its Runner sends a snapshot to everyone watching.
      this.#snapshot(session)
      this.#next(session)
    })
  }

  /**
   * Sleep then wake, so the Sandbox is rebuilt from the latest Environment version; an Asleep
   * Session is just woken. Refused as the Hub refuses it.
   */
  #restart(socket: FakeSocket, sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (!session) {
      this.#fail(socket, "RestartSession", "There is no such Session.", sessionId)
      return
    }
    const verdict = restartVerdict(this.#sessionNow(session))
    if (typeof verdict === "object") {
      this.#fail(socket, "RestartSession", verdict.refusal, sessionId)
      return
    }
    const restarting = { by: this.#you, since: Date.now() }
    session.summary = { ...session.summary, restarting }
    if (verdict === "wake") {
      this.#wake(session, "Woken on studio", this.#you)
      return
    }
    // Active until its Runner has stopped it, then Asleep, then started again.
    this.#summaryChanged(session)
    this.#after(3, () => {
      if (session.summary.restarting !== restarting) return
      this.#setState(
        session,
        "Asleep",
        "Restarting for the Environment's latest version",
        this.#you,
      )
    })
    this.#after(6, () => {
      if (session.summary.state !== "Asleep" || session.summary.restarting !== restarting) {
        return
      }
      this.#wake(session, "Woken on studio", this.#you)
    })
  }

  /**
   * Starts an Asleep Session again, on its Repo's latest Environment version; queued prompts are
   * delivered once it has started.
   */
  #wake(session: FakeSession, message: string, by?: ParticipantWire): void {
    // As on the Hub, it stays Asleep while its Creator has no setup token (ADR 0026).
    if (!this.#hasCredential(session)) {
      this.#append(session, {
        _tag: "SessionStateChanged",
        state: "Asleep",
        message: `Claude Code could not start: ${session.summary.creator.name} has no Claude setup token on this Hub.`,
      })
      this.#summaryChanged(session)
      return
    }
    // And while its Environment needs values (#57).
    const needed = this.environments.valuesNeeded(session.summary.repo)
    if (needed.length > 0) {
      this.#append(session, {
        _tag: "SessionStateChanged",
        state: "Asleep",
        message: `Claude Code could not start: ${cantStartText(session.summary.repo, needed)}`,
        valuesNeeded: true,
      })
      this.#summaryChanged(session)
      return
    }
    // And while an Installation on for its Repo can't work (#216).
    const failing = this.mcpServers.failing(session.summary.repo)
    if (failing.length > 0) {
      this.#append(session, {
        _tag: "SessionStateChanged",
        state: "Asleep",
        message: `Claude Code could not start: ${installationsCantStartText(session.summary.repo, failing)}`,
        installationsFailed: failing,
      })
      this.#summaryChanged(session)
      return
    }
    this.#start(session, { message, ...(by !== undefined && { by }) })
  }

  /** Turns the Session's Keep awake on, by you, or off (ADR 0016); a change reaches every tab. */
  #setKeepAwake(session: FakeSession, on: boolean): void {
    if ((session.summary.keepAwake !== undefined) === on) return
    const { keepAwake: _, ...summary } = session.summary
    session.summary = on ? { ...summary, keepAwake: { by: this.#you, at: Date.now() } } : summary
    this.#summaryChanged(session)
  }

  #archive(session: FakeSession): void {
    const at = Date.now()
    // A start or restart under way is over, and Keep awake goes off: its Claude Code is stopped
    // for good.
    const { starting: _, restarting: __, keepAwake: ___, ...summary } = session.summary
    session.summary = {
      ...summary,
      archived: { by: this.#you, at, purgeAt: at + archiveRetentionMs },
    }
    this.#setState(session, "Archived", undefined, this.#you)
    // Its Claude Code is stopped for good; the queue waits for a restore, as on the Hub.
    session.stopTurn?.()
    for (const watcher of this.#sockets) watcher.terminals.delete(session.summary.id)
  }

  /** A prompt arrives: it runs now if the Session is idle, or waits in the Prompt queue. */
  #prompt(
    session: FakeSession,
    sender: ParticipantWire,
    text: string,
    reply: ReadonlyArray<ReplyStep>,
    attachments: ReadonlyArray<AttachmentWire> = [],
  ): void {
    const prompt: QueuedPromptWire = {
      id: `p-${++this.#ids}`,
      text,
      sender,
      queuedAt: Date.now(),
      ...(attachments.length > 0 && { attachments }),
    }
    this.#replies.set(prompt.id, reply)
    session.queue.push(prompt)
    this.#queueChanged(session)
    // A Frozen Session's prompts wait for its Runner.
    this.#next(session)
  }

  /**
   * Delivers the head of the Prompt queue, as the Hub does, when the Session is Active and idle and
   * nothing holds delivery up; an Asleep Session is woken first, and a starting or restarting one
   * gets it once it has started. The mod starts a Turn from it a step later, and it stays in the
   * queue until then.
   */
  #next(session: FakeSession): void {
    const { state, starting, restarting, currentTurn } = session.summary
    const [prompt] = session.queue
    if (!prompt) return
    if (state === "Asleep") {
      // One restarting is woken by its restart.
      if (!restarting) this.#wake(session, "Woken by a prompt")
      return
    }
    if (state !== "Active" || currentTurn !== null || session.stopTurn) return
    const blocked = deliveryBlocked({
      promptOut: session.inFlight !== null,
      awaitingHello: starting !== undefined,
      goingToSleep: this.#goingToSleep(session),
      steering: session.steering.size > 0,
    })
    if (blocked) return
    session.inFlight = prompt.id
    this.#after(1, () => {
      if (session.inFlight === prompt.id) this.#turnFrom(session, prompt)
    })
  }

  /** Claude Code starts a Turn from the prompt it was delivered: it leaves the queue. */
  #turnFrom(session: FakeSession, prompt: QueuedPromptWire): void {
    session.inFlight = null
    const reply = this.#replies.get(prompt.id) ?? this.#reply(prompt.text)
    this.#replies.delete(prompt.id)
    this.#runTurn(
      session,
      {
        // The mod tells the model who is talking, and marks each file.
        text: `[${prompt.sender.name}] ${withAttachmentMarkers(prompt.text, prompt.attachments ?? [])}`,
        sender: { _tag: "FromParticipant", participant: prompt.sender },
        promptId: prompt.id,
        ...(prompt.attachments !== undefined && { attachments: prompt.attachments }),
      },
      reply,
    )
    session.queue = session.queue.filter((queued) => queued.id !== prompt.id)
    this.#queueChanged(session)
  }

  /**
   * The mod is sent the queued prompt to join the running Turn (DeliverIntoTurn), and appends it a
   * step later, which hub-link reports as PromptSteered: it leaves the queue then, and the Turn
   * reads it at its next step. A Turn that ends first leaves it unappended: the mod fails it, and
   * it waits in its place, as any queued prompt does.
   */
  #steer(session: FakeSession, promptId: string): void {
    const turnId = session.summary.currentTurn
    if (turnId === null) return
    session.steering.add(promptId)
    this.#after(1, () => {
      // Its Claude Code stopped meanwhile, and the mod with it: nothing answers.
      if (!session.steering.delete(promptId)) return
      const prompt = session.queue.find((queued) => queued.id === promptId)
      if (!prompt || session.summary.currentTurn !== turnId) {
        // PromptFailed, told to whoever steered it, as the Hub words it.
        this.#toAll({
          _tag: "CommandFailed",
          command: "SteerPrompt",
          sessionId: session.summary.id,
          message:
            "The prompt could not join the running Turn, so it waits in the queue: no Turn is running.",
        })
        this.#next(session)
        return
      }
      this.#append(session, {
        _tag: "PromptSteered",
        turnId,
        promptId,
        text: prompt.text,
        sender: prompt.sender,
        ...(prompt.attachments !== undefined && { attachments: prompt.attachments }),
      })
      session.queue = session.queue.filter((queued) => queued !== prompt)
      this.#replies.delete(promptId)
      this.#queueChanged(session)
      this.#after(2, () => {
        if (session.summary.currentTurn !== turnId) return
        this.#append(session, { _tag: "SteeredPromptRead", turnId, promptId })
      })
    })
  }

  #runTurn(session: FakeSession, start: TurnStart, steps: ReadonlyArray<ReplyStep>): void {
    const turnId = `t-${++this.#ids}`
    const started = Date.now()
    // Settled when it starts: a switch while it runs takes over from the next Turn.
    const turnModel = this.#modelId(session)
    const timers: Array<ReturnType<typeof setTimeout>> = []
    const openTools = new Map<string, string>()
    /** The subagents it started in the foreground: stopping the Turn stops them too. */
    const foreground = new Set<string>()
    let ended = false

    const end = (reason: "stop" | "aborted") => {
      if (ended) return
      ended = true
      for (const timer of timers) {
        clearTimeout(timer)
        this.#timers.delete(timer)
      }
      for (const agentId of foreground) session.agents.get(agentId)?.stop?.("Stopped")
      // A Stop cancels the Open question, as the Hub does when its Turn ends.
      this.#closeQuestion(session, turnId, { _tag: "Cancelled" })
      for (const [toolCallId, tool] of openTools) {
        this.#append(session, {
          _tag: "ToolCallEnded",
          turnId,
          toolCallId,
          tool,
          outcome: "Failed",
          output: "Interrupted: the Turn was stopped.",
        })
      }
      this.#append(session, {
        _tag: "TurnEnded",
        turnId,
        reason,
        durationMs: Date.now() - started,
        ...(reason === "stop" && {
          usage: {
            model: turnModel,
            input: 1_200 + steps.length * 300,
            output: 180 + steps.length * 40,
            cacheRead: 24_000,
            cacheWrite: 900,
          },
        }),
      })
      session.stopTurn = null
      // A model switched while it ran takes over now, as the Hub restarts Claude Code with it.
      if (session.summary.modelPending) this.#interruptAgents(session)
      const { modelPending: _, ...summary } = session.summary
      session.summary = { ...summary, currentTurn: null }
      this.#summaryChanged(session)
      this.#after(2, () => this.#next(session))
    }

    session.stopTurn = () => end("aborted")
    session.summary = { ...session.summary, currentTurn: turnId }
    this.#summaryChanged(session)
    this.#append(session, { _tag: "TurnStarted", turnId, ...start })

    let at = 1
    const schedule = (delay: number, fn: () => void) => {
      at += delay
      timers.push(this.#after(at, fn))
    }
    // Lays out the steps from `rest` on; a question waits for its answer to lay out the others.
    const play = (rest: ReadonlyArray<ReplyStep>): void => {
      for (const [index, step] of rest.entries()) {
        switch (step.kind) {
          case "text":
          case "tool":
          case "pause":
            at = this.#layoutStep(session, { turnId }, step, at, schedule, openTools)
            break
          case "question":
            schedule(1, () =>
              this.#ask(session, turnId, step, openTools, () => {
                at = 0
                play(rest.slice(index + 1))
              }),
            )
            return
          case "agent": {
            // The Agent call, and the subagent it starts: a foreground one's work is the call's,
            // and the Turn waits for it; a background one's call returns at once.
            const toolCallId = `tool-${++this.#ids}`
            const input = JSON.stringify({
              description: step.description,
              prompt: step.prompt,
              subagent_type: step.agentType,
              ...(step.background && { run_in_background: true }),
            })
            const run = () => this.#runAgent(session, step.agentId, step.steps)
            let length = 0
            schedule(1, () => {
              openTools.set(toolCallId, "Agent")
              this.#append(session, {
                _tag: "ToolCallStarted",
                turnId,
                toolCallId,
                tool: "Agent",
                input,
              })
              this.#startAgent(session, turnId, toolCallId, step)
              if (step.background) {
                this.#runAgent(session, step.agentId, step.steps, () =>
                  this.#fromAgent(session, step.agentId, step.result, step.relay),
                )
              } else {
                foreground.add(step.agentId)
                run()
              }
            })
            if (!step.background) {
              // The steps it takes: its run's own schedule, laid out the same way.
              let agentAt = 0
              for (const inner of step.steps)
                agentAt = this.#layoutStep(session, null, inner, agentAt, () => {}, null)
              length = agentAt + 2
            }
            schedule(Math.max(1, length), () => {
              openTools.delete(toolCallId)
              this.#append(session, {
                _tag: "ToolCallEnded",
                turnId,
                toolCallId,
                tool: "Agent",
                outcome: "Succeeded",
                output: step.background
                  ? `Async agent launched successfully. agentId: ${step.agentId}`
                  : step.result,
              })
            })
            break
          }
          case "queue":
            schedule(0, () => this.#prompt(session, step.sender, step.text, replyTo(step.text)))
            break
        }
      }
      schedule(1, () => end("stop"))
    }
    play(steps)
  }

  /**
   * Claude asks with AskUserQuestion (#193): its tool call, and the Session's Open question until
   * the first answer, which goes on with the Turn. Someone else's pick is shared a few steps in.
   */
  #ask(
    session: FakeSession,
    turnId: string,
    step: Extract<ReplyStep, { kind: "question" }>,
    openTools: Map<string, string>,
    then: () => void,
  ): void {
    const toolCallId = `tool-${++this.#ids}`
    const tool = "AskUserQuestion"
    openTools.set(toolCallId, tool)
    const input = JSON.stringify({ questions: step.questions })
    this.#append(session, { _tag: "ToolCallStarted", turnId, toolCallId, tool, input })
    this.#append(session, { _tag: "QuestionAsked", turnId, toolCallId, questions: step.questions })
    session.summary = {
      ...session.summary,
      openQuestion: { turnId, toolCallId, questions: step.questions, askedAt: Date.now() },
    }
    this.#summaryChanged(session)
    session.asking = {
      toolCallId,
      picks: [],
      answer: (answer, by) => {
        this.#closeQuestion(session, turnId, answer, by)
        openTools.delete(toolCallId)
        this.#append(session, {
          _tag: "ToolCallEnded",
          turnId,
          toolCallId,
          tool,
          outcome: answer._tag === "Dismissed" ? "Denied" : "Succeeded",
          output: answerOutput(answer),
        })
        then()
      },
    }
    const pick = step.pick
    if (pick) {
      this.#after(6, () => {
        if (session.asking?.toolCallId === toolCallId) this.#pick(session, pick)
      })
    }
  }

  /** Closes the Session's Open question, if it has one, with how it closed. */
  #closeQuestion(
    session: FakeSession,
    turnId: string,
    outcome: Extract<SessionEventWire, { _tag: "QuestionClosed" }>["outcome"],
    by?: ParticipantWire,
  ): void {
    const asking = session.asking
    if (!asking) return
    session.asking = null
    this.#append(session, {
      _tag: "QuestionClosed",
      turnId,
      toolCallId: asking.toolCallId,
      outcome,
      ...(by && { by }),
    })
    const { openQuestion: _, ...summary } = session.summary
    session.summary = summary
    this.#summaryChanged(session)
  }

  /** Someone's pick for one of the Open question's questions, in place of theirs before. */
  #pick(session: FakeSession, pick: QuestionPickWire): void {
    const asking = session.asking
    if (!asking) return
    asking.picks = asking.picks.filter(
      (held) => held.participant.id !== pick.participant.id || held.question !== pick.question,
    )
    if (pick.answer !== "") asking.picks.push(pick)
    for (const socket of this.#joinedSockets(session)) {
      socket.deliver({
        _tag: "QuestionPicks",
        sessionId: session.summary.id,
        toolCallId: asking.toolCallId,
        picks: [...asking.picks],
      })
    }
  }

  /**
   * Lays out a text, tool or pause step from step `at` on, for a Turn's main loop or, with
   * `agentId`, a subagent's run; returns the step after it. With no `loop`, only counts.
   */
  #layoutStep(
    session: FakeSession,
    loop: { turnId: string; agentId?: string } | null,
    step: ReplyStep,
    at: number,
    schedule: (delay: number, fn: () => void) => void,
    openTools: Map<string, string> | null,
  ): number {
    switch (step.kind) {
      case "text":
        for (const chunk of chunks(step.text)) {
          schedule(1, () => {
            if (loop) this.#append(session, { _tag: "TextDelta", ...loop, text: chunk })
          })
          at += 1
        }
        return at
      case "tool": {
        const toolCallId = `tool-${++this.#ids}`
        const steps = step.steps ?? 4
        schedule(1, () => {
          if (!loop) return
          openTools?.set(toolCallId, step.tool)
          this.#append(session, {
            _tag: "ToolCallStarted",
            ...loop,
            toolCallId,
            tool: step.tool,
            input: JSON.stringify(step.input),
          })
        })
        schedule(steps, () => {
          if (!loop) return
          openTools?.delete(toolCallId)
          this.#append(session, {
            _tag: "ToolCallEnded",
            ...loop,
            toolCallId,
            tool: step.tool,
            outcome: step.outcome ?? "Succeeded",
            output: step.output,
          })
        })
        return at + 1 + steps
      }
      case "pause":
        schedule(step.steps, () => {})
        return at + step.steps
      default:
        return at
    }
  }

  /** The Agent tool started a subagent, as the mod reports it: started, and Running. */
  #startAgent(
    session: FakeSession,
    turnId: string,
    toolCallId: string,
    step: Extract<ReplyStep, { kind: "agent" }>,
  ): void {
    session.agents.set(step.agentId, {
      summary: { id: step.agentId, description: step.description, status: "Running" },
      run: null,
      stop: null,
    })
    this.#append(session, {
      _tag: "AgentStarted",
      turnId,
      agentId: step.agentId,
      toolCallId,
      agentType: step.agentType,
      description: step.description,
      model: step.model,
      background: step.background ?? false,
    })
    this.#agentStatus(session, step.agentId, "Running", step.worktree)
  }

  /**
   * Plays a run of a subagent's: its steps, on a schedule of its own, then Done and `then`. A
   * Stopped run ends there; an Interrupted one, its Claude Code gone, just stops.
   */
  #runAgent(
    session: FakeSession,
    agentId: string,
    steps: ReadonlyArray<ReplyStep>,
    then?: () => void,
  ): void {
    const agent = session.agents.get(agentId)
    if (!agent) return
    const turnId = `t-${++this.#ids}`
    const started = Date.now()
    const timers: Array<ReturnType<typeof setTimeout>> = []
    const openTools = new Map<string, string>()
    const schedule = (delay: number, fn: () => void) => {
      at += delay
      timers.push(this.#after(at, fn))
    }
    let at = 0
    for (const step of steps)
      at = this.#layoutStep(session, { turnId, agentId }, step, at, schedule, openTools)
    const finish = (status: "Done" | "Stopped" | "Interrupted") => {
      if (agent.run !== turnId) return
      agent.run = null
      agent.stop = null
      for (const timer of timers) {
        clearTimeout(timer)
        this.#timers.delete(timer)
      }
      if (status !== "Interrupted") {
        for (const [toolCallId, tool] of openTools) {
          this.#append(session, {
            _tag: "ToolCallEnded",
            turnId,
            agentId,
            toolCallId,
            tool,
            outcome: "Failed",
            output: "Interrupted: the agent was stopped.",
          })
        }
        this.#append(session, {
          _tag: "TurnEnded",
          turnId,
          agentId,
          reason: status === "Done" ? "stop" : "aborted",
          durationMs: Date.now() - started,
        })
      }
      this.#agentStatus(session, agentId, status)
      if (status === "Done") then?.()
    }
    agent.run = turnId
    agent.stop = finish
    schedule(1, () => finish("Done"))
  }

  /**
   * A message reaches a subagent: a Running one reads it at its next tool call; one that has
   * stopped is resumed with it, in the background, and tells the Session when it's done.
   */
  #deliverAgentMessage(session: FakeSession, agentId: string, text: string): void {
    const agent = session.agents.get(agentId)
    if (!agent) return
    // A Session being woken resumes it once its Claude Code is up.
    if (session.summary.starting) {
      this.#after(3, () => this.#deliverAgentMessage(session, agentId, text))
      return
    }
    if (session.summary.state !== "Active") return
    const quoted = text.length > 60 ? `${text.slice(0, 57)}…` : text
    if (agent.summary.status === "Running" && agent.run !== null) {
      const run = agent.run
      this.#after(2, () => {
        if (agent.run !== run) return
        this.#append(session, {
          _tag: "TextDelta",
          turnId: run,
          agentId,
          text: `\n\nGot your message: "${quoted}". Taking it into account.`,
        })
      })
      return
    }
    this.#agentStatus(session, agentId, "Running")
    const result = `Picked up where I left off: "${quoted}". Done.`
    this.#runAgent(session, agentId, [{ kind: "text", text: result }], () =>
      this.#fromAgent(session, agentId, result),
    )
  }

  /**
   * A background agent is done: Claude Code tells itself, which starts a Turn from the agent once
   * none runs (ADR 0014).
   */
  #fromAgent(session: FakeSession, agentId: string, result: string, relay?: string): void {
    const agent = session.agents.get(agentId)
    if (!agent || session.summary.state !== "Active") return
    if (session.stopTurn || session.summary.starting || session.summary.restarting) {
      this.#after(3, () => this.#fromAgent(session, agentId, result, relay))
      return
    }
    const { description } = agent.summary
    this.#runTurn(
      session,
      {
        text: taskNotification(agentId, description, result),
        sender: { _tag: "FromAgent", agentId },
      },
      [{ kind: "text", text: relay ?? `**${description}** is done: ${result}` }],
    )
  }

  /** A subagent's status changed: logged, and its Session's summary lists it if it should. */
  #agentStatus(
    session: FakeSession,
    agentId: string,
    status: AgentSummaryWire["status"],
    worktree?: { readonly path: string; readonly branch: string },
  ): void {
    const agent = session.agents.get(agentId)
    if (!agent) return
    agent.summary = { ...agent.summary, status }
    this.#append(session, {
      _tag: "AgentStatusChanged",
      agentId,
      status,
      ...(worktree !== undefined && { worktree }),
    })
    const { agents: _, ...rest } = session.summary
    const listed = listedAgents(session.agents)
    session.summary = { ...rest, ...(listed.length > 0 && { agents: listed }) }
    this.#summaryChanged(session)
  }

  /** Its Claude Code stopped: its Running agents are Interrupted, as on the Hub. */
  #interruptAgents(session: FakeSession): void {
    for (const [agentId, agent] of session.agents) {
      if (agent.summary.status !== "Running") continue
      if (agent.stop) agent.stop("Interrupted")
      else this.#agentStatus(session, agentId, "Interrupted")
    }
  }

  #terminal(session: FakeSession): FakeTerminal {
    if (session.terminal) return session.terminal
    const terminal = new FakeTerminal(
      {
        after: (steps, fn) => void this.#after(steps, fn),
        changed: () => this.#terminalOutput(session),
      },
      {
        cwd: `/workspace/${session.summary.repo.split("/").at(-1) ?? "repo"}`,
        demo: session.summary.id === demoSessionId,
      },
    )
    session.terminal = terminal
    return terminal
  }

  /** Sends the whole screen to `sockets`, or to everyone watching. */
  #snapshot(session: FakeSession, sockets = this.#watching(session)): void {
    const terminal = this.#terminal(session)
    for (const socket of sockets) {
      socket.deliver({
        _tag: "TerminalFrame",
        sessionId: session.summary.id,
        kind: "Snapshot",
        data: terminal.snapshot(),
        size: terminal.size,
      })
    }
  }

  #terminalOutput(session: FakeSession): void {
    if (session.summary.state !== "Active") return
    const terminal = this.#terminal(session)
    for (const socket of this.#watching(session)) {
      socket.deliver({
        _tag: "TerminalFrame",
        sessionId: session.summary.id,
        kind: "Output",
        data: terminal.redraw(),
        size: terminal.size,
      })
    }
  }

  #watching(session: FakeSession): Array<FakeSocket> {
    return [...this.#sockets].filter(
      (socket) => socket.welcomed && socket.terminals.has(session.summary.id),
    )
  }

  #setState(
    session: FakeSession,
    state: SessionSummaryWire["state"],
    message?: string,
    by?: ParticipantWire,
  ): void {
    const wasActive = session.summary.state === "Active"
    if (wasActive && (state === "Asleep" || state === "Archived")) this.#interruptAgents(session)
    // Its Claude Code is gone, and its mod: a delivery or steer under way is never answered, and
    // the prompt stays in its place in the queue.
    if (state === "Asleep" || state === "Archived") {
      session.inFlight = null
      session.steering.clear()
    }
    // As on the Hub, a Session that isn't Active has no Open ports (#175).
    const { openPorts: _openPorts, ...summary } = session.summary
    session.summary = { ...(state === "Active" ? session.summary : summary), state }
    this.#append(session, {
      _tag: "SessionStateChanged",
      state,
      ...(by !== undefined && { by }),
      ...(message !== undefined && { message }),
    })
    this.#summaryChanged(session)
    // Claude Code starts again with the Session, and its Runner sends a snapshot to everyone
    // watching; a Session being started sends it once Claude Code is up.
    if (state === "Active" && !wasActive && !session.summary.starting) this.#snapshot(session)
  }

  #append(session: FakeSession, event: SessionEventWire): void {
    const entry: LogEntryWire = { seq: session.log.length, at: Date.now(), event }
    session.log.push(entry)
    for (const socket of this.#joinedSockets(session)) {
      socket.deliver({ _tag: "SessionEventLogged", sessionId: session.summary.id, entry })
    }
  }

  #summaryChanged(session: FakeSession): void {
    for (const socket of this.#sockets) {
      if (socket.welcomed) socket.deliver({ _tag: "SessionUpdated", session: session.summary })
    }
  }

  #queueChanged(session: FakeSession): void {
    for (const socket of this.#joinedSockets(session)) {
      socket.deliver({
        _tag: "PromptQueueChanged",
        sessionId: session.summary.id,
        queue: [...session.queue],
      })
    }
  }

  #presence(session: FakeSession): void {
    // Every connection is the one signed-in person, so they're here if any of theirs joined.
    const sockets = this.#joinedSockets(session)
    const participants = new Map<string, PresentParticipantWire>()
    if (sockets.length > 0) participants.set(this.#you.id, this.#you)
    for (const guest of session.guests) participants.set(guest.id, guest)
    for (const socket of sockets) {
      socket.deliver({
        _tag: "PresenceChanged",
        sessionId: session.summary.id,
        participants: [...participants.values()],
      })
    }
  }

  #joinedSockets(session: FakeSession): Array<FakeSocket> {
    return [...this.#sockets].filter(
      (socket) => socket.welcomed && socket.joined.has(session.summary.id),
    )
  }

  /** The Session a command names, or none, having refused the command, as the Hub does. */
  #sessionFor(
    socket: FakeSocket,
    message: Extract<WebToHub, { readonly sessionId: unknown }>,
  ): FakeSession | undefined {
    const session = this.sessions.get(message.sessionId)
    if (!session) this.#fail(socket, message._tag, "There is no such Session.", message.sessionId)
    return session
  }

  /**
   * The Session a command that drives it names, if the signed-in person is its Creator (ADR 0026);
   * none, having refused the command, as the Hub does, if not.
   */
  #drivenFor(
    socket: FakeSocket,
    message: Extract<WebToHub, { readonly sessionId: unknown }>,
  ): FakeSession | undefined {
    const session = this.#sessionFor(socket, message)
    if (!session) return undefined
    const refused = driveRefusal(this.#you, session.summary.creator)
    if (refused === undefined) return session
    this.#fail(socket, message._tag, refused.refusal, message.sessionId)
    return undefined
  }

  /**
   * Whether the Session's Creator has a setup token stored, which a Claude Code Session runs on
   * (ADR 0026). A pi Session runs on their Connected providers too, so it needs none (ADR 0029).
   */
  #hasCredential(session: FakeSession): boolean {
    return (
      session.summary.harness === "Pi" ||
      session.summary.creator.id !== this.#you.id ||
      this.#claudeCredential !== null
    )
  }

  /** Where a prompt is on its way to Claude Code, as the Hub's rules read it (SessionRules). */
  #handover(session: FakeSession, promptId: string): PromptHandover {
    return {
      queued: session.queue.some((prompt) => prompt.id === promptId),
      delivered: session.inFlight === promptId,
      steering: session.steering.has(promptId),
    }
  }

  /** Whether it is being stopped for a restart, which the fake's Sleep, done at once, never is. */
  #goingToSleep(session: FakeSession): boolean {
    const { state, starting, restarting } = session.summary
    return state === "Active" && restarting !== undefined && starting === undefined
  }

  /** What the Hub's lifecycle rules (SessionRules) read of the Session. */
  #sessionNow(session: FakeSession): SessionNow {
    const { summary } = session
    return {
      state: summary.state,
      starting: summary.starting !== undefined,
      goingToSleep: this.#goingToSleep(session),
      restarting: summary.restarting !== undefined,
      turnRunning: summary.currentTurn !== null,
      promptOut: session.inFlight !== null,
      queued: session.queue.length,
      runnerOnline: this.runners.some(
        (runner) => runner.id === summary.runnerId && runner.isOnline,
      ),
    }
  }

  #fail(socket: FakeSocket, command: string, message: string, sessionId?: string): void {
    socket.deliver({
      _tag: "CommandFailed",
      command,
      message,
      ...(sessionId !== undefined && { sessionId }),
    })
  }

  /** Refuses a command that has a request to answer. */
  #refuse(socket: FakeSocket, command: string, requestId: string, message: string): void {
    socket.deliver({ _tag: "CommandFailed", command, requestId, message })
  }

  /** The People page's commands (#209): the Owner's alone, as on the Hub. */
  #people(socket: FakeSocket, message: Extract<WebToHub, { _tag: PeopleCommand }>): void {
    if (!this.#owner) {
      this.#refuse(socket, message._tag, message.requestId, ownerOnlyMessage)
      return
    }
    switch (message._tag) {
      case "CreateInvite": {
        const createdAt = Date.now()
        const invite: PendingInviteWire = {
          id: `inv-${++this.#ids}`,
          createdBy: this.#you,
          createdAt,
          expiresAt: createdAt + InviteLifetimeMs,
          ...(message.login !== undefined && { login: message.login }),
        }
        this.invites.push(invite)
        const secret = Math.random().toString(36).slice(2)
        socket.deliver({
          _tag: "InviteCreated",
          requestId: message.requestId,
          id: invite.id,
          link: admissionLink(
            globalThis.location?.origin ?? "http://localhost:5173",
            InvitePath,
            `chi_${invite.id}.${secret}`,
          ),
          ...(invite.login !== undefined && { login: invite.login }),
          expiresAt: invite.expiresAt,
        })
        this.#toOwner(this.#inviteList())
        return
      }
      case "ListInvites":
        socket.deliver({ ...this.#inviteList(), requestId: message.requestId })
        return
      case "RevokeInvite":
        this.invites = this.invites.filter((invite) => invite.id !== message.inviteId)
        socket.deliver({ ...this.#inviteList(), requestId: message.requestId })
        this.#toOthers(socket, this.#inviteList())
        return
      case "ListMembers":
        socket.deliver({ ...this.#memberList(), requestId: message.requestId })
        return
      case "RemoveMember": {
        const member = this.members.find(
          (candidate) => candidate.participant.id === message.participantId,
        )
        const refusal = memberRemovalRefusal(member)
        if (refusal !== undefined) {
          this.#refuse(socket, message._tag, message.requestId, refusal)
          return
        }
        this.members = this.members.filter((other) => other !== member)
        socket.deliver({ ...this.#memberList(), requestId: message.requestId })
        this.#toOthers(socket, this.#memberList())
        return
      }
    }
  }

  /** The Invites not yet used, revoked or expired, oldest first. */
  #inviteList(): Extract<HubMessage, { _tag: "InviteList" }> {
    const now = Date.now()
    return {
      _tag: "InviteList",
      invites: this.invites
        .filter((invite) => invite.expiresAt > now)
        .toSorted((a, b) => a.createdAt - b.createdAt),
    }
  }

  /** The Members, the Owner first, then by when they were admitted. */
  #memberList(): Extract<HubMessage, { _tag: "MemberList" }> {
    return {
      _tag: "MemberList",
      members: this.members.toSorted(
        (a, b) => Number(b.owner) - Number(a.owner) || a.admittedAt - b.admittedAt,
      ),
    }
  }

  /** Tells the Owner's clients: every client, when the one signed in is the Owner. */
  #toOwner(message: HubMessage): void {
    if (this.#owner) this.#toAll(message)
  }

  /** Tells every client. */
  #toAll(message: HubMessage): void {
    for (const socket of this.#sockets) if (socket.welcomed) socket.deliver(message)
  }

  /** The Runners as the Hub lists them, each with its Sessions that aren't Archived counted. */
  #runnerList(): Extract<HubMessage, { _tag: "RunnerList" }> {
    const sessions = [...this.sessions.values()].map((session) => session.summary)
    return {
      _tag: "RunnerList",
      runners: this.runners.map((runner) => ({
        ...runner,
        openSessions: sessions.filter(
          (session) => session.runnerId === runner.id && session.state !== "Archived",
        ).length,
      })),
    }
  }

  /**
   * Plays a Runner's update to the Hub's commit, as the Hub reports it: checked, drained (the fake
   * has no Turns to wait for), applied step by step, restarted, and back on the Hub's commit.
   */
  #updateRunner(runnerId: string): void {
    const set = (update: RunnerSummaryWire["update"], more: Partial<RunnerSummaryWire> = {}) => {
      this.runners = this.runners.map((runner) => {
        if (runner.id !== runnerId) return runner
        const { update: _, ...rest } = runner
        return { ...rest, ...more, ...(update !== undefined && { update }) }
      })
      this.#toAll(this.#runnerList())
    }
    const target = this.#hubVersion
    const since = Date.now()
    const plan: Array<() => void> = [
      () => set({ _tag: "Checking", target, since }),
      () =>
        set({
          _tag: "Draining",
          target,
          since,
          deadline: since + UpdateDrainMillis,
          now: false,
          waitingFor: 0,
        }),
      ...(["Fetching", "CheckingOut", "Installing", "Restarting"] as const).map(
        (step) => () => set({ _tag: "Applying", target, since, step }),
      ),
      () => set({ _tag: "Restarting", target, since }, { isOnline: false }),
      () =>
        set(undefined, {
          isOnline: true,
          version: target,
          versionStatus: "Current",
          lastSeenAt: Date.now(),
        }),
    ]
    plan.forEach((step, index) => this.#after(index * 6, step))
  }

  /**
   * Plays an update of the Hub (#362), as `kndl update --source hub` runs and the Hub reports it:
   * its steps, then the Hub goes down to restart, and comes back on the new commit with how it
   * ended, its self-updating Runners draining to follow. Moving from dev to stable with nothing
   * newer records the Channel, and the Hub stays up where it is. Refused as on the Hub.
   */
  #updateHub(socket: FakeSocket, message: Extract<WebToHub, { _tag: "UpdateHub" }>): void {
    const update = this.#hubUpdate
    const refuse = (why: string) => this.#refuse(socket, message._tag, message.requestId, why)
    if (!this.#owner) return refuse(ownerOnlyMessage)
    if (update === null) return refuse(hubUpdatesOffMessage)
    const { follows } = update
    if (follows._tag === "Pinned" && message.channel === undefined) {
      return refuse(hubPinnedMessage(follows.ref))
    }
    const latest = this.#hubUpdateRun
    if (latest?.status.state === "Running") {
      return refuse(
        updateRunningText({ pid: 4242, startedAt: latest.status.startedAt, source: "hub" }),
      )
    }
    socket.deliver({ _tag: "HubUpdateStarted", requestId: message.requestId })

    const channel = message.channel ?? (follows._tag === "Channel" ? follows.channel : "stable")
    const found = update.checked?.found
    const from = this.#hubVersion
    const target: BuildVersionWire | undefined =
      channel === "dev"
        ? {
            commit: found?._tag === "NewerCommits" ? found.head : "f".repeat(40),
            branch: "main",
            channel: "dev",
          }
        : found?._tag === "NewerRelease" && message.channel === undefined
          ? { commit: "7".repeat(40), release: found.releases[0].version, channel: "stable" }
          : undefined
    const startedAt = Date.now()
    const begun = {
      id: `fake-${startedAt.toString(36)}`,
      source: "hub" as const,
      startedAt,
      from: { commit: from.commit, ...(from.release !== undefined && { version: from.release }) },
      ...(target !== undefined && {
        target: {
          ref: target.release === undefined ? "main" : `v${target.release}`,
          commit: target.commit,
        },
      }),
    }
    const set = (run: HubUpdateRunWire) => {
      this.#hubUpdateRun = run
      if (this.#owner) this.#toAll({ _tag: "HubUpdateRunChanged", run })
    }
    const step = (label: string) => () =>
      set({ status: { ...begun, step: label, state: "Running" } })
    const ended = (state: "Succeeded" | "RolledBack", label: string) => {
      const log = [
        "== Fetching",
        "$ git fetch --tags --force origin",
        "== Building the web UI",
        "$ bun run web:build",
        ...(state === "RolledBack"
          ? ["error: vite exited with 1", "== Rolling back", "$ git checkout --force -B main"]
          : ["✓ built in 4.2s"]),
      ].join("\n")
      return {
        status: {
          ...begun,
          step: label,
          state,
          finishedAt: Date.now(),
          ...(state === "RolledBack" && {
            error: "Building the web UI failed: `bun run web:build` exited with 1.",
          }),
        },
        logTail: log,
      } satisfies HubUpdateRunWire
    }

    if (target === undefined) {
      // dev → stable with no newer Release, or stable with nothing newer: nothing moves.
      const plan = [
        step("Starting"),
        step("Asking origin for its branches and tags"),
        step("Recording the Channel"),
        () => {
          set(ended("Succeeded", "Recording the Channel"))
          this.setHubUpdate({
            follows: { _tag: "Channel", channel },
            checked: { at: Date.now(), found: { _tag: "UpToDate" } },
          })
        },
      ]
      plan.forEach((run, index) => this.#after(index * 2, run))
      return
    }
    const outcome = this.#hubUpdateOutcome
    const plan = [
      step("Starting"),
      step("Fetching"),
      step("Checking out"),
      step("Installing dependencies"),
      step("Building the web UI"),
      ...(outcome === "Succeeded" ? [step("Restarting the Hub")] : [step("Rolling back")]),
      () => {
        this.#down = true
        this.#closeAll()
      },
    ]
    plan.forEach((run, index) => this.#after(index * 2, run))
    this.#after(plan.length * 2 + 4, () => {
      if (outcome === "Succeeded") {
        this.#hubVersion = target
        this.#hubUpdate = {
          follows: { _tag: "Channel", channel },
          checked: { at: Date.now(), found: { _tag: "UpToDate" } },
        }
        this.#hubUpdateRun = ended("Succeeded", "Checking the Hub's health")
        // Its Runners follow the new commit, each once its running Turns end.
        const since = Date.now()
        this.runners = this.runners.map((runner) =>
          runner.isOnline && runner.updater?.self === true
            ? {
                ...runner,
                versionStatus: "Behind",
                update: {
                  _tag: "Draining",
                  target,
                  since,
                  deadline: since + UpdateDrainMillis,
                  now: message.now,
                  waitingFor: runner.openSessions,
                },
              }
            : runner,
        )
      } else {
        this.#hubUpdateRun = ended("RolledBack", "Rolling back")
      }
      this.#down = false
    })
  }

  #pairingCodeList(): Extract<HubMessage, { _tag: "PairingCodeList" }> {
    const now = Date.now()
    return {
      _tag: "PairingCodeList",
      codes: this.pairingCodes.filter((code) => code.expiresAt > now),
    }
  }

  #dropCodes(drop: (code: PendingPairingCodeWire) => boolean): void {
    const kept = this.pairingCodes.filter((code) => !drop(code))
    this.pairingCodes.splice(0, this.pairingCodes.length, ...kept)
  }

  /** Tells every other client, as the Hub broadcasts an applied version or changed variables. */
  /**
   * Stores or removes the signed-in person's Claude credential, telling whoever asked and their
   * other connections. As on the Hub (ADR 0026), their awake Sessions go to sleep, saying why: a
   * new token reaches each at its next wake, and without one, none wakes.
   */
  #setClaudeCredential(
    socket: FakeSocket,
    requestId: string,
    credential: ClaudeCredentialInfoWire | null,
    warning?: string,
  ): void {
    const had = this.#claudeCredential !== null
    this.#claudeCredential = credential
    const state = { _tag: "ClaudeCredentialState" as const, credential }
    socket.deliver({ ...state, requestId, ...(warning !== undefined && { warning }) })
    this.#toOthers(socket, state)
    // Claude's Models come and go with it.
    if (had !== (credential !== null)) this.#toAll(this.#providersState())
    if (!had) return
    const why =
      credential === null
        ? `${this.#you.name} removed their Claude setup token`
        : `${this.#you.name} replaced their Claude setup token: it wakes on the new one`
    for (const session of this.sessions.values()) {
      if (session.summary.creator.id !== this.#you.id || session.summary.state !== "Active")
        continue
      const { starting: _, restarting: __, keepAwake: ___, ...summary } = session.summary
      session.summary = summary
      this.#setState(session, "Asleep", why)
      session.stopTurn?.()
    }
  }

  /** The signed-in person's Connected providers and Models, as the Hub sends them. */
  #providersState(requestId?: string) {
    return this.providers.state(this.#claudeCredential !== null, requestId)
  }

  /** Answers a change to the Connected providers, and tells the person's other connections. */
  #providersChanged(socket: FakeSocket, requestId: string): void {
    socket.deliver(this.#providersState(requestId))
    this.#toOthers(socket, this.#providersState())
  }

  /**
   * Plays a Provider's sign-in, in place of any before, which ends cancelled (ADR 0029): its steps,
   * then, for ChatGPT's and OpenRouter's, a wait for the address pasted, and for the rest, for the code.
   */
  #startSignIn(socket: FakeSocket, requestId: string, provider: ProviderId): void {
    if (this.#signIn !== null) this.#endSignIn("Cancelled")
    const signIn: FakeSignIn = { requestId, provider, socket, waitsFor: null, afterChoice: [] }
    this.#signIn = signIn
    this.#playSignIn(signIn, signInSteps(provider))
  }

  /**
   * Shows a sign-in's steps, one a step apart, up to a choice, which waits for the answer; then a
   * wait for the address pasted, or for the code to be entered.
   */
  #playSignIn(signIn: FakeSignIn, steps: ReadonlyArray<SignInStepWire>): void {
    const choice = steps.findIndex((step) => step._tag === "Choose")
    const shown = choice === -1 ? steps : steps.slice(0, choice + 1)
    signIn.afterChoice = choice === -1 ? [] : steps.slice(choice + 1)
    shown.forEach((step, index) =>
      this.#after(index + 1, () => {
        if (this.#signIn !== signIn) return
        if (step._tag === "Paste" || step._tag === "Choose") signIn.waitsFor = step._tag
        this.#signInStep(step)
      }),
    )
    if (!shown.some((step) => step._tag === "Paste" || step._tag === "Choose"))
      this.#after(shown.length + codeEnteredSteps, () => this.#signInConnected(signIn.requestId))
  }

  #signInStep(step: SignInStepWire): void {
    const signIn = this.#signIn
    if (signIn === null) return
    signIn.socket.deliver({
      _tag: "SignInStepped",
      requestId: signIn.requestId,
      provider: signIn.provider,
      step,
    })
  }

  /** The sign-in found its account: it's connected, and every connection hears of it. */
  #signInConnected(requestId: string): void {
    const signIn = this.#signIn
    if (signIn?.requestId !== requestId) return
    this.providers.signedIn(signIn.provider)
    this.#endSignIn("Connected")
    this.#toAll(this.#providersState())
  }

  #endSignIn(outcome: "Connected" | "Failed" | "Cancelled", message?: string): void {
    const signIn = this.#signIn
    if (signIn === null) return
    this.#signIn = null
    signIn.socket.deliver({
      _tag: "SignInEnded",
      requestId: signIn.requestId,
      provider: signIn.provider,
      outcome,
      ...(message !== undefined && { message }),
    })
  }

  #toOthers(socket: FakeSocket, message: HubMessage): void {
    for (const other of this.#sockets) {
      if (other !== socket && other.welcomed) other.deliver(message)
    }
  }

  #after(steps: number, fn: () => void): ReturnType<typeof setTimeout> {
    const timer = setTimeout(() => {
      if (this.#holding) {
        this.#held.push({ timer, fn })
        this.#heldArrived?.()
        this.#heldArrived = undefined
        return
      }
      this.#timers.delete(timer)
      fn()
    }, steps * this.stepMs)
    this.#timers.add(timer)
    return timer
  }
}

/** What Claude reads back from AskUserQuestion, as Claude Code words it. */
function answerOutput(answer: QuestionAnswerWire): string {
  switch (answer._tag) {
    case "Answered": {
      const said = Object.entries(answer.answers)
        .map(([question, picked]) => `"${question}"="${picked}"`)
        .join(", ")
      return `User has answered your questions: ${said}. You can now continue with the user's answers in mind.`
    }
    case "Replied":
      return `The user responded: ${answer.text}`
    case "Dismissed":
      return "User declined to answer questions"
  }
}

/** Splits text into the pieces it streams in: a few words at a time. */
export function chunks(text: string): Array<string> {
  const words = text.match(/\S+\s*|\s+/g) ?? []
  const pieces: Array<string> = []
  for (let index = 0; index < words.length; index += 3) {
    pieces.push(words.slice(index, index + 3).join(""))
  }
  return pieces
}
