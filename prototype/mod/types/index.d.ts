export type Link = {
  /** Whether the last exchange with the hub succeeded. */
  isConnected: boolean
  /** Names of the people watching this session in the web UI. */
  viewers: string[]
  /** Prompts the hub has handed over that have not started yet. */
  queued: number
}

declare module 'claude-code' {
  interface PluginState {
    'hub-link': { link: Link }
  }
}
