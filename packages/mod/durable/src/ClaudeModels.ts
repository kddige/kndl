// Claude's Models in the durable agent: run by the Claude bridge, a pi-ai provider for `anthropic`
// that runs the pinned Claude Code in the Sandbox, as a model only, on the Creator's Claude
// credential (ADR 0026, 0029). The bridge is ported to a pi-ai provider in `./claude/` on its own
// branch; this module is the one place the agent meets it, so the merge changes only `loadBridge`.
//
// It registers only when the Runner gave the agent Claude Code and the Creator's Claude token
// (`KNDL_CLAUDE_CODE`, `CLAUDE_CODE_OAUTH_TOKEN`, `CLAUDE_CONFIG_DIR`), and only for the Claude
// Models the Hub lists, from pi-ai's `anthropic` catalogue.

import type { Api, Model, MutableModels, Provider } from "@earendil-works/pi-ai"
import type { ProviderModel } from "@kndl/protocol"
import { builtinProvider } from "./Builtins.ts"

/** The bridge's provider, as `createClaudeBridgeProvider` makes it. */
export type ClaudeBridgeProvider = Provider & {
  /** Lets go of a conversation's Claude Code session. */
  forget(sessionId: string): void
  /** Stops every Claude Code it runs. */
  close(): Promise<void>
}

/** What the bridge takes, as the bridge's branch has it. */
export interface ClaudeBridgeOptions {
  readonly claudeCodePath: string
  readonly configDir: string
  readonly oauthToken: string
  readonly cwd: string
  readonly models: ReadonlyArray<Model<Api>>
  readonly logPath?: string
  readonly onNotice?: (text: string) => void
}

/** The bridge's module, once merged. */
export interface ClaudeBridgeModule {
  readonly createClaudeBridgeProvider: (options: ClaudeBridgeOptions) => ClaudeBridgeProvider
}

/**
 * The bridge, if this build has it.
 *
 * TODO(merge): the Claude bridge is on spike/bridge. Once merged, return its module:
 *   `import * as bridge from "./claude/index.ts"` at the top, and `return bridge` here.
 */
const loadBridge = (): ClaudeBridgeModule | undefined => undefined

/** The Claude bridge installed into the agent's Models, while it is. */
export interface ClaudeInstall {
  /** The Hub listed the Creator's Models again: the bridge serves those of Claude's. */
  update(listed: ReadonlyArray<ProviderModel>): void
  close(): Promise<void>
}

/** pi-ai's `anthropic` models the Hub lists, in its order. */
export const listedClaudeModels = (
  listed: ReadonlyArray<ProviderModel>,
  catalogue: ReadonlyArray<Model<Api>> = builtinProvider("anthropic")?.getModels() ?? [],
): Array<Model<Api>> =>
  listed.flatMap((model) => {
    if (model.provider !== "anthropic") return []
    const known = catalogue.find((entry) => entry.id === model.id)
    return known === undefined ? [] : [known]
  })

/**
 * Installs the Claude bridge as `anthropic` in `models`, for the Claude Models in `listed`;
 * undefined when the Runner gave the agent no Claude Code or credential, or the bridge isn't in
 * this build. `bridge` stands in for the bridge in tests.
 */
export const installClaude = (
  models: MutableModels,
  listed: ReadonlyArray<ProviderModel>,
  options: {
    readonly env: NodeJS.ProcessEnv
    readonly cwd: string
    readonly log: (text: string) => void
    readonly bridge?: ClaudeBridgeModule | undefined
  },
): ClaudeInstall | undefined => {
  const { KNDL_CLAUDE_CODE, CLAUDE_CODE_OAUTH_TOKEN, CLAUDE_CONFIG_DIR } = options.env
  if (!KNDL_CLAUDE_CODE || !CLAUDE_CODE_OAUTH_TOKEN || !CLAUDE_CONFIG_DIR) return undefined
  const bridge = options.bridge ?? loadBridge()
  if (bridge === undefined) {
    if (listed.some((model) => model.provider === "anthropic"))
      options.log("kndl: Claude bridge not merged yet: Claude's Models are unavailable")
    return undefined
  }
  let provider: ClaudeBridgeProvider | undefined
  let served = ""
  const install: ClaudeInstall = {
    update: (next) => {
      const claude = listedClaudeModels(next)
      const ids = claude.map((model) => model.id).join("\n")
      if (ids === served) return
      served = ids
      const before = provider
      provider = undefined
      void before?.close().catch((error: unknown) => options.log(`kndl: ${error}`))
      if (claude.length === 0) return models.deleteProvider("anthropic")
      provider = bridge.createClaudeBridgeProvider({
        claudeCodePath: KNDL_CLAUDE_CODE,
        configDir: CLAUDE_CONFIG_DIR,
        oauthToken: CLAUDE_CODE_OAUTH_TOKEN,
        cwd: options.cwd,
        models: claude,
        onNotice: (text) => options.log(`kndl: Claude bridge: ${text}`),
      })
      models.setProvider(provider)
    },
    close: async () => {
      await provider?.close()
    },
  }
  install.update(listed)
  return install
}
