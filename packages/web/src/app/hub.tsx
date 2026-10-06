// The HubClient for React: one per app, given by HubProvider, read with useHubState.

import { createContext, type ReactNode, useContext, useSyncExternalStore } from "react"
import { HubClient } from "../hub/client.ts"
import { fakeHubMode } from "../hub/config.ts"
import type { HubState } from "../hub/store.ts"
import { browserTransport } from "../hub/transport.ts"

const HubContext = createContext<HubClient | null>(null)

export function HubProvider({ client, children }: { client: HubClient; children: ReactNode }) {
  return <HubContext value={client}>{children}</HubContext>
}

export function useHub(): HubClient {
  const client = useContext(HubContext)
  if (!client) throw new Error("useHub needs a HubProvider above it")
  return client
}

/**
 * A slice of the Hub's state. `select` must return something already in the state (or a
 * primitive), not a new object, or every render would see a change.
 */
export function useHubState<T>(select: (state: HubState) => T): T {
  const client = useHub()
  return useSyncExternalStore(client.subscribe, () => select(client.getState()))
}

/**
 * The app's HubClient: the real Hub on this origin, or the fake one when `VITE_FAKE_HUB` is set.
 * The fake is imported only then, so builds without the flag leave it out.
 */
export async function createHubClient(): Promise<HubClient> {
  // Checked inline first: Vite replaces the unset flag with `undefined`, so the build drops the rest.
  if (!import.meta.env.VITE_FAKE_HUB) return new HubClient(browserTransport())
  const mode = fakeHubMode(import.meta.env.VITE_FAKE_HUB)
  if (mode === "off") return new HubClient(browserTransport())
  const { FakeHub } = await import("../hub/fake/FakeHub.ts")
  console.info(`Using the fake Hub (VITE_FAKE_HUB=${String(import.meta.env.VITE_FAKE_HUB)})`)
  const fake = new FakeHub({ signedIn: mode === "signed-in" })
  // Its test controls, from the console: fakeHub.teammateApplies("kddige/kndl").
  Object.assign(globalThis, { fakeHub: fake })
  return new HubClient(fake, { retryDelay: () => 300 })
}
