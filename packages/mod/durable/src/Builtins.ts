// pi-ai's own providers, read for their streams and catalogues only: the agent never registers
// one as it is, since it would call its Provider directly (Providers.ts).

import type { Provider } from "@earendil-works/pi-ai"
import { builtinProviders } from "@earendil-works/pi-ai/providers/all"

let builtins: ReadonlyArray<Provider> | undefined

/** pi-ai's built-in provider of that name, for its streams and catalogue. */
export const builtinProvider = (id: string): Provider | undefined =>
  (builtins ??= builtinProviders()).find((provider) => provider.id === id)
