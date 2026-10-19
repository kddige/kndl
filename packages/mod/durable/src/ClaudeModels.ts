// Claude's Models in the durable agent: run by the Claude bridge (`./claude/`), a pi-ai provider
// for `anthropic` that runs the pinned Claude Code in the Sandbox, as a model only, on the
// Creator's Claude credential (ADR 0026, 0029). This module is the one place the agent meets it.
//
// It installs only when the Runner gave the agent Claude Code and the Creator's Claude token
// (`KNDL_CLAUDE_CODE`, `CLAUDE_CODE_OAUTH_TOKEN`, `CLAUDE_CONFIG_DIR`), and only for the Claude
// Models the Hub lists. When the Hub lists other Claude Models later, the bridge is made again for
// them.

import type { MutableModels } from "@earendil-works/pi-ai"
import type { ProviderModel } from "@kndl/protocol"
import {
  claudeBridgeOptionsFromEnv,
  ClaudeProvider,
  createClaudeBridgeProvider,
} from "./claude/index.ts"
import type { ClaudeBridgeOptions, ClaudeBridgeProvider } from "./claude/index.ts"

/** The Claude bridge installed into the agent's Models, while it is. */
export interface ClaudeInstall {
  /** The Hub listed the Creator's Models again: the bridge serves those of Claude's. */
  update(listed: ReadonlyArray<ProviderModel>): void
  close(): Promise<void>
}

/**
 * Installs the Claude bridge as `anthropic` in `models`, for the Claude Models in `listed`;
 * undefined when the Runner gave the agent no Claude Code or no Claude credential. `create`
 * stands in for the bridge in tests.
 */
export const installClaude = (
  models: MutableModels,
  listed: ReadonlyArray<ProviderModel>,
  options: {
    /** The Runner's environment, the Claude token still in it. */
    readonly env: Readonly<Record<string, string | undefined>>
    readonly cwd: string
    readonly log: (text: string) => void
    readonly create?: (options: ClaudeBridgeOptions) => ClaudeBridgeProvider
  },
): ClaudeInstall | undefined => {
  const create = options.create ?? createClaudeBridgeProvider
  const optionsFor = (claude: ReadonlyArray<ProviderModel>) =>
    claudeBridgeOptionsFromEnv(options.env, {
      cwd: options.cwd,
      models: claude,
      report: (text) => options.log(`kndl: Claude bridge: ${text}`),
      onNotice: (text, level) => options.log(`kndl: Claude bridge ${level}: ${text}`),
    })
  if (optionsFor([]) === undefined) return undefined
  let provider: ClaudeBridgeProvider | undefined
  let served = ""
  const install: ClaudeInstall = {
    update: (next) => {
      const claude = next.filter((model) => model.provider === ClaudeProvider)
      const ids = claude.map((model) => model.id).join("\n")
      if (ids === served) return
      served = ids
      const before = provider
      provider = undefined
      void before?.close().catch((error: unknown) => options.log(`kndl: ${error}`))
      const bridgeOptions = optionsFor(claude)
      if (claude.length === 0 || bridgeOptions === undefined)
        return models.deleteProvider(ClaudeProvider)
      provider = create(bridgeOptions)
      if (provider.missing.length > 0)
        options.log(`kndl: pi-ai doesn't know anthropic's ${provider.missing.join(", ")}`)
      models.setProvider(provider)
    },
    close: async () => {
      await provider?.close()
    },
  }
  install.update(listed)
  return install
}
