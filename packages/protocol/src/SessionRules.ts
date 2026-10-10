// What a Hub decides about a Session's Prompt queue and lifecycle, as pure rules over plain data.
// The real Hub (LiveSessions and the Session relay) and the web's fake Hub both decide by them, so
// the fake can't drift from what the Hub refuses, or why (#263). Each rule takes what the Hub
// knows of the Session as it is now, and says what is to happen: it changes nothing itself.

import type { AgentStatus, SessionInstallation, SessionState } from "./Session.ts"

/** Why a command is refused, as said to whoever sent it. */
export interface Refusal {
  readonly refusal: string
}

// ── The Prompt queue and Steer (ADR 0018) ──

/** Where a prompt is on its way from the Prompt queue to Claude Code. */
export interface PromptHandover {
  /** Whether it is in the Session's Prompt queue. */
  readonly queued: boolean
  /**
   * Whether the mod was sent it (DeliverPrompt), and no Turn started from it yet. It stays in the
   * queue until one does.
   */
  readonly delivered: boolean
  /**
   * Whether the mod was sent it to join the running Turn (DeliverIntoTurn) and hasn't answered.
   * It stays in its place in the queue until the mod says it joined (PromptSteered).
   */
  readonly steering: boolean
}

/**
 * Why files can't go to a Session's mod by a way that is `done` (steered, sent to a subagent,
 * replied with): it is from before they could (#278).
 */
export const modFromBeforeAttachments = (done: string): Refusal => ({
  refusal: `This Session's Claude Code runs a mod from before attachments could be ${done}. They can be once the Session starts again on an updated Runner.`,
})

/**
 * Why a prompt, message or reply (`what`) is refused when not each of its attachments is one its
 * sender uploaded to the Session, or one was deleted a day after upload unsent (#276, #280).
 */
export const attachmentsNotSent = (what: string): Refusal => ({
  refusal: `An attachment of the ${what} isn't one you uploaded to this Session, or was deleted a day after upload unsent: attach it again.`,
})

const notQueued: Refusal = { refusal: "The prompt is not in the Prompt queue." }
const alreadyDelivered: Refusal = { refusal: "The prompt was already delivered to Claude Code." }

/**
 * Whether a queued prompt can be steered into the running Turn: "ok", and the mod is to be sent the
 * DeliverIntoTurn, the prompt keeping its place in the queue; "already", if it is on its way into
 * the Turn, and nothing is to be done; or why not. `turnRunning` is whether the Session is Active
 * with a Turn, and not going to sleep. `modSteers` is whether its mod said in its hello that it
 * steers (#195). `hasAttachments` is whether the prompt carries files (#276), and `modAttaches`
 * whether the mod said in its hello that it marks them in a steered prompt (#278).
 */
export const steerVerdict = (
  steer: PromptHandover & {
    readonly turnRunning: boolean
    readonly modSteers: boolean
    readonly hasAttachments: boolean
    readonly modAttaches: boolean
  },
): "ok" | "already" | Refusal => {
  if (!steer.turnRunning) {
    return { refusal: "No Turn is running to steer the prompt into: it goes next." }
  }
  if (steer.delivered) return alreadyDelivered
  if (steer.steering) return "already"
  if (!steer.modSteers) {
    return {
      refusal:
        "This Session's Claude Code runs a mod from before steering, so the prompt waits for the Turn to end. It can be steered once the Session starts again on an updated Runner.",
    }
  }
  if (!steer.queued) return notQueued
  if (steer.hasAttachments && !steer.modAttaches) return modFromBeforeAttachments("steered")
  return "ok"
}

/**
 * Why a prompt can't be cancelled, if it can't: it is on its way to Claude Code, or not in the
 * queue. One that can is taken out of the queue.
 */
export const cancelRefusal = (prompt: PromptHandover): Refusal | undefined => {
  if (prompt.delivered) return alreadyDelivered
  if (prompt.steering) return { refusal: "The prompt is being handed to the running Turn." }
  if (!prompt.queued) return notQueued
  return undefined
}

/** What holds up the delivery of the head of a Session's Prompt queue. */
export interface DeliveryHolds {
  /** A prompt is out for delivery: the mod was sent it, and no Turn started from it yet. */
  readonly promptOut: boolean
  /** Its Claude Code was started or woken, and its new mod hasn't said hello yet. */
  readonly awaitingHello: boolean
  /** It was asked to stop, for sleep or a restart, and hasn't stopped yet. */
  readonly goingToSleep: boolean
  /** A steer awaits the mod's answer: the prompt it is about may be the head of the queue. */
  readonly steering: boolean
}

/**
 * Whether no prompt may be delivered now, whatever else holds: one at a time, to a mod that said
 * hello, not while it goes to sleep or a steer is under way. A Session that may take one gets
 * the head of its queue once it is Active and no Turn runs.
 */
export const deliveryBlocked = (holds: DeliveryHolds): boolean =>
  holds.promptOut || holds.awaitingHello || holds.goingToSleep || holds.steering

// ── The Session lifecycle ──

/** What the lifecycle rules read of a Session. */
export interface SessionNow {
  readonly state: SessionState
  /** Its Runner hasn't answered its StartSession yet (#70). */
  readonly starting: boolean
  /** Its Runner was asked to stop it, for sleep or a restart, and hasn't said it stopped. */
  readonly goingToSleep: boolean
  /** A restart of it is under way (ADR 0009). */
  readonly restarting: boolean
  /** A Turn of its main loop is running. */
  readonly turnRunning: boolean
  /** A prompt was delivered to its mod, and no Turn started from it yet. */
  readonly promptOut: boolean
  /** How many prompts wait in its Prompt queue. */
  readonly queued: number
  /** Whether its Runner is connected. */
  readonly runnerOnline: boolean
}

const archived: Refusal = { refusal: "The Session is archived." }

/** Why a prompt can't be sent to the Session, if it can't. A Frozen one's waits for its Runner. */
export const sendPromptRefusal = (session: Pick<SessionNow, "state">): Refusal | undefined =>
  session.state === "Archived"
    ? { refusal: "The Session is archived: restore it to send prompts." }
    : undefined

/** Why the Session's Turn can't be asked to stop, if it can't. Asking is logged either way. */
export const stopTurnRefusal = (session: Pick<SessionNow, "state">): Refusal | undefined =>
  session.state === "Archived"
    ? { refusal: "The Session is archived: no Turn is running." }
    : undefined

/**
 * SleepSession: "sleep", to put it to sleep, and Keep awake goes off (ADR 0016); "going", if it is
 * going to sleep already, and only Keep awake goes off; or why not. Only an idle Active Session.
 */
export const sleepVerdict = (session: SessionNow): "sleep" | "going" | Refusal => {
  if (session.goingToSleep) return "going"
  if (session.state !== "Active") {
    return {
      refusal: `Only an Active Session can be put to sleep; this one is ${session.state}.`,
    }
  }
  if (session.starting) {
    return { refusal: "The Session is still starting; put it to sleep once it has started." }
  }
  if (session.turnRunning) return { refusal: "A Turn is running: stop it first." }
  if (session.promptOut || session.queued > 0) {
    return { refusal: "Prompts are waiting in the Session's queue." }
  }
  return "sleep"
}

/** WakeSession: "wake" an Asleep Session; "awake", and nothing is done, for an Active one; or why not. */
export const wakeVerdict = (
  session: Pick<SessionNow, "state" | "goingToSleep">,
): "wake" | "awake" | Refusal => {
  switch (session.state) {
    case "Asleep":
      return "wake"
    case "Active":
      return session.goingToSleep
        ? { refusal: "The Session is still going to sleep; wake it once it is Asleep." }
        : "awake"
    case "Frozen":
      return {
        refusal:
          "The Session is Frozen: its Runner is offline. It wakes when the Runner returns, if prompts are waiting.",
      }
    case "Archived":
      return archived
  }
}

/**
 * RestartSession (ADR 0009): "wake" an Asleep Session, which starts on the Repo's latest
 * Environment version; "stop" an idle Active one, to be woken once it is Asleep; or why not.
 */
export const restartVerdict = (session: SessionNow): "wake" | "stop" | Refusal => {
  if (session.restarting) return { refusal: "The Session is already restarting." }
  switch (session.state) {
    case "Asleep":
      return "wake"
    case "Active":
      // Its Sandbox is being made from the version it was sent: restarting now would only
      // start it again behind this start.
      if (session.starting) {
        return { refusal: "The Session is still starting; restart it once it has started." }
      }
      if (session.goingToSleep) {
        return { refusal: "The Session is going to sleep; wake it once it is Asleep." }
      }
      if (session.turnRunning || session.promptOut) {
        return { refusal: "A Turn is running: stop it first, then restart." }
      }
      if (!session.runnerOnline) return { refusal: "The Session's Runner is offline." }
      return "stop"
    case "Frozen":
      return {
        refusal:
          "The Session is Frozen: its Runner is offline. Restart it once the Runner returns.",
      }
    case "Archived":
      return archived
  }
}

// ── Open questions (#193) ──

/**
 * Why an answer to an Open question with attachments is refused, if it is (#278): only a reply
 * carries them, and only to a mod that said it marks them.
 */
export const answerAttachmentsRefusal = (answer: {
  readonly replied: boolean
  readonly hasAttachments: boolean
  readonly modAttaches: boolean
}): Refusal | undefined => {
  if (!answer.hasAttachments) return undefined
  if (!answer.replied) return { refusal: "Only a reply to a question carries attachments." }
  return answer.modAttaches ? undefined : modFromBeforeAttachments("replied with")
}

// ── Subagents (ADR 0014) ──

const noSuchAgent: Refusal = { refusal: "The Session has no such agent." }

/**
 * MessageAgent: "deliver" the message to the Session's mod; "wake" an Asleep Session first, whose
 * new Claude Code resumes the agent from its transcript; or why not. `hasAttachments` is whether
 * the message carries attachments, and `modAttaches` whether the running mod said it marks them
 * (#278). A woken Session's mod is a new one, which does: a Runner behind the Hub wakes no Session
 * (ADR 0011).
 */
export const messageAgentVerdict = (
  session: Pick<SessionNow, "state" | "goingToSleep"> & {
    readonly agentKnown: boolean
    readonly hasAttachments: boolean
    readonly modAttaches: boolean
  },
): "deliver" | "wake" | Refusal => {
  if (!session.agentKnown) return noSuchAgent
  switch (session.state) {
    case "Archived":
      return { refusal: "The Session is archived: restore it to message agents." }
    case "Frozen":
      return { refusal: "The Session's Runner is offline: message the agent once it is back." }
    case "Active":
      if (session.goingToSleep)
        return { refusal: "The Session is going to sleep: message the agent once it is Asleep." }
      return session.hasAttachments && !session.modAttaches
        ? modFromBeforeAttachments("sent to a subagent")
        : "deliver"
    case "Asleep":
      return "wake"
  }
}

/** Why the agent can't be stopped, if it can't: only a Running one of an Active Session can. */
export const stopAgentRefusal = (session: {
  readonly state: SessionState
  /** The agent's status, or none for an agent the Session doesn't have. */
  readonly agent: AgentStatus | undefined
}): Refusal | undefined => {
  if (session.agent === undefined) return noSuchAgent
  if (session.agent !== "Running" || session.state !== "Active") {
    return { refusal: "The agent isn't running." }
  }
  return undefined
}

// ── Installations (ADR 0020) ──

/**
 * What of an Installation a Session runs with: its names, and when its values were set. A change to
 * any of it takes a Restart.
 */
const runsWith = (installation: typeof SessionInstallation.Encoded) =>
  JSON.stringify([
    installation.id,
    installation.name,
    installation.mcpServerName,
    installation.mcpServerVersion ?? null,
    installation.server,
    (installation.values ?? []).map((value) => [value.key, value.setAt]),
  ])

/** Whether two lists of a Session's Installations differ, in what it runs with. */
export const installationsDiffer = (
  a: ReadonlyArray<typeof SessionInstallation.Encoded>,
  b: ReadonlyArray<typeof SessionInstallation.Encoded>,
): boolean => {
  const left = a.map(runsWith).toSorted()
  const right = b.map(runsWith).toSorted()
  return left.length !== right.length || left.some((entry, index) => entry !== right[index])
}
