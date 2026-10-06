// hub-link: the mod a Runner loads into each Session's Claude Code, which runs in the Session's
// Sandbox (ADR 0013).
//
// - Tools: Claude Code runs them, in the Sandbox, without asking (ADR 0004). The mod reports each
//   call to the Hub, and answers the Child Session tools from the Hub.
// - The Hub: says hello, reports the Turn's events, and takes prompts, stops and presence from
//   the Hub (see HubLink.ts).
// - Child Sessions (ADR 0012): a Session that isn't a Child Session gets the tools that create
//   and coordinate them; a Child Session gets one, to message its parent. The Hub answers both
//   (see src/ChildTools.ts).
// - The person at the terminal: a band above the prompt shows the Participants.
// - The model: the system prompt says the Session is shared.
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
  HubLink,
  parentTools,
  promptFromParticipant,
  resultSummary,
  sharedSessionNote,
  toolArguments,
  turnEndReason,
  turnUsage,
} from "./hub-link-lib.js"
import type {
  ChildToolAnswer,
  FromSession,
  LinkStatus,
  ModCommand,
  Participant,
  ToolCallOutcome,
} from "./hub-link-lib.js"

const plugin = "hub-link"

// The environment variables the Runner sets (the Runner's ClaudeLaunch.ts) are read by literal
// name: the loader lists a module's variables from its `$.env.get` calls.

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
  minted: 0,
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
  // Sessions nest one level deep: a Child Session gets only the tool to message its parent, in
  // place of the ones that make and coordinate children (the Hub refuses the wrong one too).
  // Registered before the link starts (#139): a new Session's first prompt is already queued at
  // the Hub, and a Turn only has the tools that were visible when it started. `$.tool.register`
  // resolves once its tool is. The link starts even if they fail: the Session still takes prompts.
  const tools = parentSessionId ? parentTools : childTools
  await Promise.all(tools.map((tool) => $.tool.register(tool))).catch((error) =>
    $.ui.log(`hub-link: registering its tools failed: ${error}`, { to: "debug" }),
  )
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
}

/** Answers a call to one of the Child Session tools, or message_parent, from the Hub. */
const answerChildTool = async (
  request: Exclude<ReturnType<typeof childToolRequest>, undefined>,
): Promise<ChildToolAnswer> => {
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

const outcomes: Record<ChildToolAnswer["_tag"], ToolCallOutcome> = {
  Ran: "Succeeded",
  Failed: "Failed",
  Refused: "Denied",
}

export function register(on: On) {
  on("session.start", async ($, e, next) => {
    const started = await next(e)
    await startLink($).catch((error) => $.ui.log(`hub-link: ${error}`, { to: "debug" }))
    return started
  })

  on("session.end", async ($, e, next) => {
    const ended = await next(e)
    await state.link?.flushNow()
    return ended
  })

  // Every tool call is reported to the Hub. The Child Session tools are answered from the Hub;
  // Claude Code runs every other, in the Sandbox.
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
    if (childRequest === undefined) {
      const done = await next(e)
      if (done.deny !== undefined) ended("Denied", clip(done.deny))
      else ended(done.isError ? "Failed" : "Succeeded", resultSummary(tool, done.result))
      return done
    }
    const answer = await answerChildTool(childRequest)
    ended(
      outcomes[answer._tag],
      answer._tag === "Ran" ? resultSummary(tool, answer.result) : clip(answer.message),
    )
    // A hook's `{ isError, result }` fails Claude Code's output check (spike #2), so a tool that
    // reported an error is answered as a deny: the model reads the same text as an error result.
    return answer._tag === "Ran" ? ({ result: answer.result } as never) : { deny: answer.message }
  })

  // Sessions never ask for approval (ADR 0004): Claude Code runs with its permission prompts
  // bypassed, and a mode switched to at the terminal asks for none either.
  on("tool.check", async () => ({ decision: "allow" as const }))

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
    return {
      sections: [
        ...composed.sections,
        { id: `${plugin}:shared-session`, text: sharedSessionNote, scope: "session" },
      ],
    }
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
