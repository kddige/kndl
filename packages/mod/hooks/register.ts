// hub-link: the mod a Runner loads into each Session's Claude Code (ADR 0001).
//
// - Tools: the file and command tools run in the Session's Sandbox through the Runner's tool
//   bridge; WebSearch, a server tool that runs at Anthropic, is passed on to Claude Code without
//   asking; every other tool is denied. Nothing else is passed on to Claude Code to run, so a
//   tool can't reach the host even when the bridge is down: the call is refused instead. A call
//   runs for as long as its tool allows; the mod cancels it in the Sandbox when the Turn is
//   interrupted or the session ends (see src/ToolBridgeClient.ts).
// - The Hub: says hello, reports the Turn's events, and takes prompts, stops and presence from
//   the Hub (see HubLink.ts).
// - Child Sessions (ADR 0012): a Session that isn't a Child Session gets the tools that create
//   and coordinate them, answered by the Hub (see src/ChildTools.ts).
// - The person at the terminal: a band above the prompt shows the Participants, and the `!`
//   shell shortcut, which would run a command on the host, is refused.
// - The model: the system prompt says the Session is shared, and describes the Sandbox, where its
//   tools run, in place of Claude Code's description of the host.
// - The Repo: its CLAUDE.md and skills, which the Runner copied out of the Sandbox, stand in for
//   any instruction files from the host, and its skills point at the Workspace (see
//   src/RepoFiles.ts).
//
// The rest of the mod, with Effect and the protocol, is bundled from src/ into
// hooks/hub-link-lib.js (`bun run build`): Claude Code's mod runtime loads no package but its
// own (spike #4).

import { atom, read, update } from "claude-code"
import type { EngineInterface, On } from "claude-code"
import type { HubLinkBand } from "../types"
import {
  childReplyText,
  childToolRequest,
  childTools,
  clip,
  decideTool,
  HubLink,
  isClaudeCodeTool,
  newCallId,
  parseRepoInstructions,
  promptFromParticipant,
  ReadBeforeEdit,
  repoInstructionsFile,
  resultSummary,
  runInSandbox,
  sandboxEnvironment,
  sharedSessionNote,
  skillInWorkspace,
  startsShellMode,
  toolArguments,
  turnEndReason,
  turnUsage,
  withRepoInstructions,
} from "./hub-link-lib.js"
import type {
  BridgeExchange,
  FromSession,
  LinkStatus,
  ModCommand,
  Participant,
  SandboxFacts,
  ToolAnswer,
  ToolCallOutcome,
  ToolDecision,
} from "./hub-link-lib.js"

const plugin = "hub-link"

// The environment variables the Runner sets (the Runner's ClaudeLaunch.ts) are read by literal
// name: the loader lists a module's variables from its `$.env.get` calls. The tools socket's name
// is the protocol's ToolsSocketVariable (src/HubMessages.spec.ts checks they match).

const band = atom(
  { plugin: "hub-link", key: "band" } as const,
  {
    status: "Unlinked",
    detail: "",
    participants: [],
  } as HubLinkBand,
)

/** The module's own state; a reload starts it over, and fires `session.start` again. */
const state = {
  link: undefined as HubLink | undefined,
  toolsSocket: undefined as string | undefined,
  /** What the Runner said about the Sandbox; null when no Runner started this Claude Code. */
  sandbox: undefined as SandboxFacts | null | undefined,
  /** Where the Runner copied the Repo's skills and CLAUDE.md; null when it copied none. */
  repoFiles: undefined as string | null | undefined,
  /** The Turn running on the main loop. */
  mainTurn: undefined as string | undefined,
  /** The Turn each subagent's loop is in, from its steps; tool calls carry only the agent. */
  agentTurns: new Map<string, string>(),
  /**
   * The prompt delivered from the Hub that the next Turn starts with, and who sent it: a person,
   * or another Session.
   */
  delivered: undefined as
    | {
        readonly promptId: string
        readonly sender: Participant
        readonly fromSession: FromSession | undefined
      }
    | undefined,
  readBeforeEdit: new ReadBeforeEdit(),
  minted: 0,
  /** The calls running in the Sandbox, by the id the bridge knows each by. */
  running: new Set<string>(),
}

const report = (event: Record<string, unknown>) => state.link?.report(event)

const setBand = ($: EngineInterface, change: Partial<HubLinkBand>) =>
  update($, band, (value) => ({ ...value, ...change })).catch(() => undefined)

const bandStatus = (status: LinkStatus): Partial<HubLinkBand> =>
  status._tag === "Rejected"
    ? { status: "Rejected", detail: status.reason }
    : { status: status._tag, detail: "" }

const deliverPrompt = async (
  $: EngineInterface,
  command: Extract<ModCommand, { _tag: "DeliverPrompt" }>,
) => {
  const failed = (message: string) => {
    if (state.delivered?.promptId === command.promptId) state.delivered = undefined
    report({ _tag: "PromptFailed", promptId: command.promptId, message })
  }
  state.delivered = {
    promptId: command.promptId,
    sender: command.sender,
    fromSession: command.fromSession,
  }
  try {
    const entered = await $.prompt.submit({
      // Another Session's prompt comes with its note, saying where it is from.
      text:
        command.fromSession === undefined
          ? promptFromParticipant(command.sender, command.text)
          : command.text,
      asUser: true,
    })
    if (entered.drop !== undefined) failed(`a hook dropped the prompt: ${entered.drop}`)
  } catch (error) {
    failed(String(error))
  }
}

const runCommand = async ($: EngineInterface, command: ModCommand) => {
  switch (command._tag) {
    case "DeliverPrompt":
      // Not awaited: the prompt waits for the session to be idle, and the poll goes on.
      void deliverPrompt($, command)
      return
    case "StopTurn":
      if (state.mainTurn !== undefined) await $.turn.abort({ turnId: state.mainTurn })
      return
    case "PresenceChanged":
      await setBand($, { participants: command.participants.map((person) => person.name) })
      return
  }
}

const startLink = async ($: EngineInterface) => {
  const [hubUrl, sessionId, modToken, parentSessionId] = await Promise.all([
    $.env.get("CLAUDE_HUB_URL"),
    $.env.get("CLAUDE_HUB_SESSION_ID"),
    $.env.get("CLAUDE_HUB_MOD_TOKEN"),
    $.env.get("CLAUDE_HUB_PARENT_SESSION_ID"),
  ])
  if (!hubUrl || !sessionId || !modToken) {
    $.ui.log("hub-link: not started by a Runner, so not linked to a Hub", { to: "debug" })
    return
  }
  state.link?.stop()
  state.link = new HubLink({
    hubUrl,
    modToken,
    hello: { sessionId, claudeSessionId: await $.session.id(), model: await $.session.model() },
    fetch: (url, init) => $.http.fetch(url, init),
    sleep: (ms) => $.clock.sleep(ms),
    onCommand: (command) => runCommand($, command),
    onStatus: (status) => void setBand($, bandStatus(status)),
    log: (text) => $.ui.log(text, { to: "debug" }),
  })
  state.link.start()
  // Sessions nest one level deep: a Child Session doesn't get the tools (the Hub refuses it too).
  if (!parentSessionId) await Promise.all(childTools.map((tool) => $.tool.register(tool)))
}

/** Answers a call to one of the Child Session tools, from the Hub. */
const answerChildTool = async (
  request: Exclude<ReturnType<typeof childToolRequest>, undefined>,
): Promise<ToolAnswer> => {
  if ("invalid" in request) return { _tag: "Failed", message: request.invalid }
  if (state.link === undefined)
    return { _tag: "Refused", message: "This Session isn't linked to a Claude Hub." }
  const reply = await state.link.askChildren(request)
  if ("failed" in reply)
    return { _tag: "Failed", message: `The Hub didn't answer: ${reply.failed}. Try again later.` }
  const answer = childReplyText(reply)
  return "text" in answer
    ? { _tag: "Ran", result: answer.text }
    : { _tag: "Failed", message: answer.refused }
}

const sandboxFacts = async ($: EngineInterface) => {
  if (state.sandbox !== undefined) return state.sandbox
  const [workspace, repo, workBranch] = await Promise.all([
    $.env.get("CLAUDE_HUB_WORKSPACE"),
    $.env.get("CLAUDE_HUB_REPO"),
    $.env.get("CLAUDE_HUB_WORK_BRANCH"),
  ])
  state.sandbox = workspace
    ? { workspace, repo: repo || undefined, workBranch: workBranch || undefined }
    : null
  return state.sandbox
}

const repoFilesDirectory = async ($: EngineInterface) => {
  if (state.repoFiles !== undefined) return state.repoFiles
  state.repoFiles = (await $.env.get("CLAUDE_HUB_REPO_FILES"))?.replace(/\/+$/, "") || null
  return state.repoFiles
}

/** The Repo's instruction files, as the Runner copied them; none when it copied none. */
const repoInstructions = async ($: EngineInterface, directory: string) => {
  try {
    return parseRepoInstructions(String(await $.fs.read(`${directory}/${repoInstructionsFile}`)))
  } catch (error) {
    $.ui.log(`hub-link: no Repo instructions: ${error}`, { to: "debug" })
    return []
  }
}

/** One exchange with the tool bridge, through Claude Code's fetch. */
const bridgeExchange =
  ($: EngineInterface): BridgeExchange =>
  (socketPath, request) =>
    $.http.fetch(`http://tool-bridge${request.path}`, {
      method: request.method,
      socketPath,
      ...(request.body === undefined
        ? {}
        : { headers: { "content-type": "application/json" }, body: request.body }),
    })

/** Answers a tool call the mod doesn't leave to Claude Code: from the Sandbox, or refused. */
const answerToolCall = async (
  $: EngineInterface,
  decision: Exclude<ToolDecision, { readonly _tag: "LeaveToClaudeCode" }>,
  input: Record<string, unknown>,
  toolUseId: string | undefined,
  signal: AbortSignal,
): Promise<ToolAnswer> => {
  if (decision._tag === "Deny") return { _tag: "Refused", message: decision.reason }
  const unread = state.readBeforeEdit.check(decision.tool, input)
  if (unread !== undefined) return { _tag: "Failed", message: unread }
  state.toolsSocket ??= (await $.env.get("CLAUDE_HUB_TOOLS_SOCKET")) || undefined
  const callId = newCallId(toolUseId)
  state.running.add(callId)
  try {
    const answer = await runInSandbox(bridgeExchange($), state.toolsSocket, decision.tool, input, {
      callId,
      signal,
    })
    if (answer._tag === "Ran") state.readBeforeEdit.record(decision.tool, input, answer.result)
    return answer
  } finally {
    state.running.delete(callId)
  }
}

/** Cancels the calls still running in the Sandbox, as the session ends. */
const cancelRunning = async ($: EngineInterface) => {
  const socketPath = state.toolsSocket
  const running = [...state.running]
  state.running.clear()
  if (socketPath === undefined) return
  const exchange = bridgeExchange($)
  await Promise.all(
    running.map((callId) =>
      exchange(socketPath, {
        method: "DELETE",
        path: `/tools/calls/${encodeURIComponent(callId)}`,
      }).catch(() => undefined),
    ),
  )
}

const outcomes: Record<ToolAnswer["_tag"], ToolCallOutcome> = {
  Ran: "Succeeded",
  Failed: "Failed",
  Refused: "Denied",
  Lost: "Failed",
}

export function register(on: On) {
  on("session.start", async ($, e, next) => {
    const started = await next(e)
    await startLink($).catch((error) => $.ui.log(`hub-link: ${error}`, { to: "debug" }))
    return started
  })

  on("session.end", async ($, e, next) => {
    const ended = await next(e)
    await Promise.all([cancelRunning($), state.link?.flushNow()])
    return ended
  })

  // Every tool call is answered here: from the Sandbox, from the Hub (the Child Session tools), or
  // refused. Only WebSearch, which runs at Anthropic rather than on the host (#126), is passed on to
  // Claude Code.
  on("tool.call", async ($, e, next) => {
    const tool = String(e.tool)
    const input = toolArguments(e as unknown as Record<string, unknown>)
    const agentId = e.agentId
    const turnId = agentId === undefined ? state.mainTurn : state.agentTurns.get(agentId)
    const toolCallId = e.tool_use_id || `hub-link-${++state.minted}`
    const loop = agentId === undefined ? {} : { agentId }
    if (turnId !== undefined)
      report({
        _tag: "ToolCallStarted",
        turnId,
        ...loop,
        toolCallId,
        tool,
        input: clip(JSON.stringify(input)),
      })
    const ended = (outcome: ToolCallOutcome, output: string) => {
      if (turnId !== undefined)
        report({ _tag: "ToolCallEnded", turnId, ...loop, toolCallId, tool, outcome, output })
    }
    const childRequest = childToolRequest(tool, input)
    let answer: ToolAnswer
    if (childRequest !== undefined) answer = await answerChildTool(childRequest)
    else {
      const decision = decideTool(tool, input)
      if (decision._tag === "LeaveToClaudeCode") {
        const done = await next(e)
        if (done.deny !== undefined) ended("Denied", clip(done.deny))
        else ended(done.isError ? "Failed" : "Succeeded", resultSummary(tool, done.result))
        return done
      }
      // Waiting on the bridge is `$` calls, which the hook's budget doesn't count, so a call may
      // run for as long as its tool allows. `next.signal` aborts when the Turn is interrupted.
      answer = await answerToolCall($, decision, input, e.tool_use_id || undefined, next.signal)
    }
    ended(
      outcomes[answer._tag],
      answer._tag === "Ran" ? resultSummary(tool, answer.result) : clip(answer.message),
    )
    // A hook's `{ isError, result }` fails Claude Code's output check (spike #2), so a tool that
    // reported an error is answered as a deny: the model reads the same text as an error result.
    return answer._tag === "Ran" ? ({ result: answer.result } as never) : { deny: answer.message }
  }).catch((_$, e) => ({
    // A hook that throws or overruns would let Claude Code run the tool on the host.
    deny: `${String(e.tool)} was refused: hub-link failed while answering it. It never runs on the host.`,
  }))

  // Sessions never ask for approval (ADR 0004): a tool left to Claude Code runs without asking.
  // Every other tool is answered or refused at `tool.call`, before Claude Code would decide.
  on("tool.check", async ($, e, next) =>
    isClaudeCodeTool(e.tool) ? { decision: "allow" as const } : next(e),
  )

  on("turn.start", async ($, e, next) => {
    state.mainTurn = e.turnId
    // The Hub delivers one prompt at a time, only while the Session is idle, so the next Turn
    // with a prompt is the delivered one.
    const delivered = e.text === "" ? undefined : state.delivered
    if (delivered !== undefined) state.delivered = undefined
    report({
      _tag: "TurnStarted",
      turnId: e.turnId,
      text: e.text,
      sender:
        delivered === undefined
          ? { _tag: "FromTerminal" }
          : (delivered.fromSession ?? { _tag: "FromParticipant", participant: delivered.sender }),
      ...(delivered === undefined ? {} : { promptId: delivered.promptId }),
    })
    return next(e)
  })

  on("turn.step", async function* ($, e, next) {
    if (e.agentId !== undefined) state.agentTurns.set(e.agentId, e.turnId)
    const loop = e.agentId === undefined ? {} : { agentId: e.agentId }
    const stream = next(e)
    while (true) {
      const piece = await stream.next()
      if (piece.done) return piece.value
      if (piece.value.kind === "text" && piece.value.text !== "")
        report({ _tag: "TextDelta", turnId: e.turnId, ...loop, text: piece.value.text })
      yield piece.value
    }
  })

  on("turn.complete", async ($, e, next) => {
    const completed = await next(e)
    report({
      _tag: "TurnEnded",
      turnId: e.turnId,
      ...(e.agentId === undefined ? {} : { agentId: e.agentId }),
      reason: turnEndReason(e.reason),
      durationMs: Math.max(0, Math.round(e.durationMs)),
      ...(e.usage === undefined ? {} : { usage: turnUsage(e.usage) }),
    })
    if (e.agentId === undefined) state.mainTurn = undefined
    else state.agentTurns.delete(e.agentId)
    return completed
  })

  on("prompt.compose", async ($, e, next) => {
    const composed = await next(e)
    const sandbox = await sandboxFacts($)
    return {
      sections: [
        ...composed.sections,
        { id: `${plugin}:shared-session`, text: sharedSessionNote, scope: "session" },
        ...(sandbox === null
          ? []
          : [
              {
                id: `${plugin}:sandbox-environment`,
                text: sandboxEnvironment(sandbox),
                scope: "session" as const,
              },
            ]),
      ],
    }
  })

  // Claude Code's environment block describes the host (its directory, platform and OS), and comes
  // only with a prompt typed at the terminal, so late in a Session driven from the Hub (#127). The
  // Sandbox's is in the system prompt instead, so the host's is left out.
  on("prompt.attachment", { type: "environment" }, async ($, e, next) =>
    (await sandboxFacts($)) === null ? next(e) : { text: null },
  )

  // The Repo's CLAUDE.md, read in the Sandbox by the Runner, is the Session's project instructions
  // (#125). Claude Code loads no project's from the host (`--setting-sources ""`); any other file
  // it found there, but the organization's managed policy, is left out too. A hook above that
  // rewrote the instructions' text leaves their files unknown, and then none is added.
  on("prompt.context", async ($, e, next) => {
    const context = await next(e)
    const directory = await repoFilesDirectory($)
    if (directory === null || context.instructionFiles === undefined) return context
    return {
      blocks: context.blocks,
      instructionFiles: withRepoInstructions(
        context.instructionFiles,
        await repoInstructions($, directory),
      ),
    }
  })

  // A Repo skill's directory is the copy on the host Claude Code loaded it from; the model's tools
  // run in the Sandbox, where the skill's own files are, so its prompt points there.
  on("skill.prompt", async ($, e, next) => {
    const prompt = await next(e)
    const [directory, sandbox] = await Promise.all([repoFilesDirectory($), sandboxFacts($)])
    if (directory === null || sandbox === null) return prompt
    return { text: skillInWorkspace(prompt.text, directory, sandbox.workspace) }
  })

  // `!` runs a shell command on the host, outside every tool hook (spike #2): refuse the key.
  on("prompt.edit", async ($, e, next) => {
    if (!startsShellMode(e)) return next(e)
    $.ui.toast("Shell commands (!) are off in a Claude Hub Session: ask Claude to run them.")
    return { text: e.text, cursor: e.cursor }
  })

  on("ui.render", { component: "AbovePrompt" }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const value = await read($, band)
    if (value.status === "Unlinked") return next(e)
    const { Box, Text } = $.ui.resolve(e)
    const isLinked = value.status === "Linked"
    const label =
      value.status === "Rejected"
        ? `Hub refused the link: ${value.detail}`
        : value.status === "Linking"
          ? "linking to the Hub"
          : value.status === "Offline"
            ? "Hub offline"
            : "Hub"
    const people =
      value.participants.length === 0 ? " · nobody watching" : ` · ${value.participants.join(", ")}`
    return Box({
      flexDirection: "row",
      children: [
        Text({ color: isLinked ? "green" : "red", children: isLinked ? "● " : "○ " }),
        Text({ dimColor: true, children: isLinked ? `${label}${people}` : label }),
      ],
    })
  })
}
