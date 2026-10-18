// kndl's Claude bridge (ADR 0029): Claude's Models in a pi Session, run by Claude Code in the
// Sandbox on the Session's Creator's Claude credential, as a model only, with pi's tools.
//
// kndl's own port of pi-claude-bridge 0.9.3 by Eli Dickinson (MIT; its notice is in
// THIRD_PARTY_NOTICES.md), keeping its approach: Claude Code through the Agent SDK with
// `tools: []`, pi's tools over in-process MCP, each tool call held open across pi's turns, and
// pi's history mirrored into Claude Code's session to resume. Left out: its AskClaude tool, its
// config file (the Runner's environment says all there is), and its startup notices. Changed: a
// message pi holds is never changed again (QueryState.ts), which the reference broke after an
// abort (docs/research/claude-bridge-spike.md).

import { getModels } from "@earendil-works/pi-ai/compat"
import type { ExtensionAPI, ProviderConfig } from "@earendil-works/pi-coding-agent"
import type { ProviderModel } from "@kndl/protocol"
import {
  capturedPrompts,
  clearRewriteMarks,
  configureBridge,
  markRebuildForSession,
  setPiUI,
  streamClaude,
} from "./Bridge.ts"
import { configureLog, debug } from "./Log.ts"
import { claudeModels } from "./Models.ts"
import type { CatalogueModel } from "./Models.ts"
import { ClaudeApi, ClaudeProvider } from "./Names.ts"
import type { PromptCaptureInput } from "./PromptCapture.ts"
import { forgetSessionCwd, rememberSessionCwd, rememberSummarySession } from "./SessionCwd.ts"
import { clearSessionStates, sessionStateCount, setClaudeDir } from "./SessionMirror.ts"
import { claudeSettings } from "./Settings.ts"

export interface RegisterClaudeOptions {
  /** pi's environment; the process's by default. */
  readonly env?: NodeJS.ProcessEnv
  /** The extension's log, for what should never happen. */
  readonly log?: (text: string) => void
  /** pi-ai's `anthropic` catalogue; pi-ai's own by default. */
  readonly catalogue?: ReadonlyArray<CatalogueModel>
}

/** The prompt options the bridge records, as pi's before_agent_start gives them. */
interface SystemPromptOptions {
  readonly customPrompt?: string | undefined
  readonly appendSystemPrompt?: string | undefined
  readonly contextFiles?: ReadonlyArray<{ readonly path: string; readonly content: string }>
  readonly skills?: PromptCaptureInput["skills"] | undefined
  readonly sections?: Readonly<Record<string, string>> | undefined
  readonly selectedTools?: ReadonlyArray<string> | undefined
}

/** Forgets every pi session's mirror. */
const clearSessions = (event: string) => {
  debug(`${event}: clearing ${sessionStateCount()} mirror(s)`)
  clearSessionStates()
  clearRewriteMarks()
}

/**
 * Registers pi's `anthropic` provider for the Claude Models the Hub listed, run through Claude
 * Code. Does nothing when the Session's Creator has no Claude credential, or the Runner gave pi no
 * Claude Code (ADR 0026: a Session spends only its Creator's), or the Hub listed no Claude Model.
 */
export const registerClaude = (
  pi: ExtensionAPI,
  models: ReadonlyArray<ProviderModel>,
  options: RegisterClaudeOptions = {},
): void => {
  const env = options.env ?? process.env
  const settings = claudeSettings(env)
  if (settings === undefined) return
  const listed = models.filter((model) => model.provider === ClaudeProvider)
  if (listed.length === 0) return
  const catalogue =
    options.catalogue ?? (getModels(ClaudeProvider as never) as unknown as Array<CatalogueModel>)
  const { models: registered, missing } = claudeModels(listed, catalogue)
  if (missing.length > 0) options.log?.(`kndl: pi doesn't know anthropic's ${missing.join(", ")}`)
  if (registered.length === 0) return

  configureLog({ debug: settings.debug, report: options.log })
  setClaudeDir(settings.configDir)
  configureBridge({ settings, env })

  // A new conversation in the same pi starts over with no mirror.
  pi.on("session_start", (event, ctx) => {
    setPiUI(ctx.ui)
    if (event.reason === "new" || event.reason === "resume" || event.reason === "fork")
      clearSessions(`session_start:${event.reason}`)
  })
  pi.on("session_shutdown", () => clearSessions("session_shutdown"))
  followClaudeSession(pi)

  const config: ProviderConfig = {
    name: "Claude (Claude Code)",
    // pi wants both for a provider with models; neither is used, Claude Code being the transport.
    baseUrl: "claude-code",
    apiKey: "claude-code",
    api: ClaudeApi,
    models: registered,
    // pi hands it a transcript, which toBridgeContext reads as a Context.
    streamSimple: streamClaude as unknown as NonNullable<ProviderConfig["streamSimple"]>,
  }
  pi.registerProvider(ClaudeProvider, config)
}

/**
 * What the bridge needs to hear of a pi session whose turns may run on Claude: its working
 * directory, its compactions, and what pi assembles into its system prompt. registerClaude
 * follows the Session's own; a child session in the same process (a subagent's) that may run on
 * Claude needs the same, through its own extension factories, or its Claude turns fail for want
 * of its prompt.
 */
export const followClaudeSession = (pi: ExtensionAPI): void => {
  // The session's working directory, which Claude Code runs in.
  pi.on("session_start", (_event, ctx) => {
    rememberSessionCwd(ctx.sessionManager.getSessionId(), ctx.cwd)
  })
  pi.on("session_shutdown", (_event, ctx) => forgetSessionCwd(ctx.sessionManager.getSessionId()))

  // Summaries run in a Claude Code of their own, in the session's directory: pi gives every
  // summary call the operation's signal.
  pi.on("session_before_compact", (event, ctx) => {
    rememberSummarySession(event.signal, ctx.sessionManager.getSessionId())
  })
  pi.on("session_before_tree", (event, ctx) => {
    rememberSummarySession(event.signal, ctx.sessionManager.getSessionId())
  })
  // A compaction or tree navigation replaces pi's history: the mirror rebuilds, and a query held
  // at a tool call is discarded rather than resumed on the old conversation.
  pi.on("session_compact", (event, ctx) =>
    markRebuildForSession(
      ctx.sessionManager.getSessionId(),
      `session_compact:${event.reason}:willRetry=${event.willRetry}`,
    ),
  )
  pi.on("session_tree", (_event, ctx) =>
    markRebuildForSession(ctx.sessionManager.getSessionId(), "session_tree"),
  )

  // What pi assembled into each prompt, so Claude Code gets its portable parts. The options are
  // pi's configuration for the run, and live: handlers after this one (kndl's own section) change
  // them, which the later records see. The prompt the query is made with is the fully widened one
  // (tools' descriptions join after before_agent_start), so it's recorded again at agent_start,
  // and at each turn_start, where a mid-run change lands.
  const captures = capturedPrompts()
  let lastOptions: SystemPromptOptions | undefined
  const record = (source: string, systemPrompt: string | undefined) => {
    if (!systemPrompt) return
    const hasRead = !lastOptions?.selectedTools || lastOptions.selectedTools.includes("read")
    captures.record(
      systemPrompt,
      {
        custom: lastOptions?.customPrompt,
        append: lastOptions?.appendSystemPrompt,
        contextFiles: lastOptions?.contextFiles ?? [],
        skills: hasRead ? (lastOptions?.skills ?? []) : [],
        sections: lastOptions?.sections,
      },
      source,
    )
  }
  pi.on("before_agent_start", (event) => {
    lastOptions = event.systemPromptOptions
    record("before_agent_start", event.systemPrompt)
  })
  pi.on("agent_start", (_event, ctx) => record("agent_start", ctx.getSystemPrompt()))
  pi.on("turn_start", (_event, ctx) => record("turn_start", ctx.getSystemPrompt()))
}
