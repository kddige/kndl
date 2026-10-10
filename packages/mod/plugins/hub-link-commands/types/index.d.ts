// hub-link-commands' contract: the state its band draws from, and the prompts it delivered and
// steered last, which hub-link reads.

/** What the band above the prompt shows. */
export type HubLinkBand = {
  /** Where the link to the Hub stands. */
  status: "Linking" | "Linked" | "Offline" | "Rejected" | "Unlinked"
  /** Why the Hub refused the link, when `status` is `Rejected`. */
  detail: string
  /** The names of the Participants connected to the Session now. */
  participants: string[]
}

/** A Participant, as the protocol has them. */
export type HubLinkParticipant = {
  id: string
  login: string
  name: string
  avatarUrl?: string
}

/** The prompt from the Prompt queue submitted last: the Turn it starts is reported as theirs. */
export type HubLinkDelivered = {
  promptId: string
  sender: HubLinkParticipant
  /** As submitted, led by the sender's name, with a marker for each file it carries. */
  text: string
  /**
   * What Claude is told beside it, out of sight, when it carries files (#276): hub-link adds it
   * as the prompt is submitted, since a plugin's hooks don't see the prompt it submits itself.
   */
  context?: string
}

/**
 * The prompt from the Prompt queue being steered into the running Turn (#195): hub-link reports it
 * joined when its row is appended.
 */
export type HubLinkSteering = {
  promptId: string
  sender: HubLinkParticipant
  /** As its sender wrote it. */
  text: string
}

declare module "claude-code" {
  interface PluginState {
    "hub-link-commands": {
      band: HubLinkBand
      delivered: HubLinkDelivered | null
      steering: HubLinkSteering | null
    }
  }
}
