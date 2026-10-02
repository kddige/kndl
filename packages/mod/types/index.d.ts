// hub-link's contract: the state its Participants band draws from.

/** What the band above the prompt shows. */
export type HubLinkBand = {
  /** Where the link to the Hub stands. */
  status: "Linking" | "Linked" | "Offline" | "Rejected" | "Unlinked"
  /** Why the Hub refused the link, when `status` is `Rejected`. */
  detail: string
  /** The names of the Participants connected to the Session now. */
  participants: string[]
}

declare module "claude-code" {
  interface PluginState {
    "hub-link": { band: HubLinkBand }
  }
}
