// hub-link: the plugin that reports a Session's Claude Code to its Hub. A Runner loads it, with
// hub-link-commands beside it, into each Session's Claude Code, which runs in the Session's
// Sandbox (ADR 0013).
//
// - The Hub: says hello and reports the Turns, their tool calls, the prompts steered into them
//   (#195) and the subagents (ADR 0014). It
//   runs none of the Hub's commands: a plugin's hooks don't see the work it causes, such as an
//   agent it resumes, so hub-link-commands runs them, and this plugin sees what follows.
// - Tools: Claude Code runs them, in the Sandbox, without asking (ADR 0004).
// - The model: the system prompt says the Session is shared.
//
// The rest of the plugin, with Effect and the protocol, is bundled from the mod package's src/
// into hooks/hub-link-lib.js (`bun run build`): Claude Code's mod runtime loads no package but its
// own (spike #4).

import type { EngineInterface, On } from "claude-code"
import {
  agentWorktree,
  backgroundedByStop,
  clip,
  HubLink,
  resultSummary,
  sharedSessionNote,
  startsDelivered,
  steeredPrompt,
  taskNotificationAgent,
  toolArguments,
  turnEndReason,
  turnUsage,
} from "./hub-link-lib.js"
import type { ToolCallOutcome } from "./hub-link-lib.js"

const plugin = "hub-link"

// The environment variables the Runner sets (the Runner's ClaudeLaunch.ts) are read by literal
// name: the loader lists a module's variables from its `$.env.get` calls.

/** The module's own state; a reload starts it over, and fires `session.start` again. */
const state = {
  link: undefined as HubLink | undefined,
  /** The Turn running on the main loop. */
  mainTurn: undefined as string | undefined,
  /** The run each subagent's loop is in, from its steps; tool calls carry only the agent. */
  agentTurns: new Map<string, string>(),
  /** The directory each running agent started in, from SubagentStart. */
  startedIn: new Map<string, string>(),
  /** The agents reported Stopped since they last ran, so a stop is reported once. */
  stopped: new Set<string>(),
  /** The last prompt from the Hub a Turn started with, so no other Turn claims it. */
  claimed: undefined as string | undefined,
  /** The prompts steered into the main loop's Turn that no step has read yet, by id. */
  unread: new Map<string, string>(),
  minted: 0,
}

const report = (event: Record<string, unknown>) => state.link?.report(event)

/** The agent is running, in its worktree if it has one. */
const reportRunning = (agentId: string, cwd: string | undefined) => {
  state.stopped.delete(agentId)
  const worktree = cwd === undefined ? undefined : agentWorktree(cwd)
  report({
    _tag: "AgentStatusChanged",
    agentId,
    status: "Running",
    ...(worktree === undefined ? {} : { worktree }),
  })
}

/** The agent was stopped, by TaskStop or with the Turn it ran in. */
const reportStopped = (agentId: string) => {
  state.startedIn.delete(agentId)
  if (state.stopped.has(agentId)) return
  state.stopped.add(agentId)
  report({ _tag: "AgentStatusChanged", agentId, status: "Stopped" })
}

/** The id of the task a TaskStop stopped; a shell's id the Hub ignores, as no agent's. */
const stoppedTask = (result: unknown): string | undefined =>
  typeof result === "object" &&
  result !== null &&
  "task_id" in result &&
  typeof result.task_id === "string"
    ? result.task_id
    : undefined

const startLink = async ($: EngineInterface) => {
  const [hubUrl, sessionId, modToken, kind] = await Promise.all([
    $.env.get("KNDL_URL"),
    $.env.get("KNDL_SESSION_ID"),
    $.env.get("KNDL_MOD_TOKEN"),
    $.env.get("CLAUDE_CODE_SESSION_KIND"),
  ])
  if (!hubUrl || !sessionId || !modToken) {
    $.ui.log("hub-link: not started by a Runner, so not linked to a Hub", { to: "debug" })
    return
  }
  // A background job or daemon of Claude Code's inherits the Session's mod token, but isn't the
  // Session's Claude Code: linked too, it would run each prompt again (#191).
  if (kind) {
    $.ui.log(`hub-link: a Claude Code ${kind} process, so not linked to the Hub`, { to: "debug" })
    return
  }
  state.link?.stop()
  state.link = new HubLink({
    hubUrl,
    modToken,
    hello: { sessionId, claudeSessionId: await $.session.id(), model: await $.session.model() },
    fetch: (url, init) => $.http.fetch(url, init),
    // Its own timers, so a Stop can't cut what it does short (#165).
    after: (ms, fn) => void $.clock.after(ms, fn),
    // hub-link-commands draws the link in the band; this one only reports.
    onStatus: () => undefined,
    log: (text) => $.ui.log(text, { to: "debug" }),
  })
  state.link.start()
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

  // Every tool call is reported to the Hub; Claude Code runs it, in the Sandbox.
  on("tool.call", async ($, e, next) => {
    const tool = String(e.tool)
    const agentId = e.agentId
    // hub-link-commands' TaskStop, for a Participant's Stop, is no tool call of the Turn running.
    const turnId =
      next.origin.plugin === "hub-link-commands"
        ? undefined
        : agentId === undefined
          ? state.mainTurn
          : state.agentTurns.get(agentId)
    const toolCallId = e.tool_use_id || `hub-link-${++state.minted}`
    const loop = agentId === undefined ? {} : { agentId }
    const ended = (outcome: ToolCallOutcome, output: string) => {
      if (turnId !== undefined)
        report({ _tag: "ToolCallEnded", turnId, ...loop, toolCallId, tool, outcome, output })
    }
    if (turnId !== undefined) {
      const input = toolArguments(e as unknown as Record<string, unknown>)
      report({
        _tag: "ToolCallStarted",
        turnId,
        ...loop,
        toolCallId,
        tool,
        input: clip(JSON.stringify(input)),
      })
    }
    const done = await next(e)
    if (done.deny !== undefined) ended("Denied", clip(done.deny))
    // It didn't end: a Stop moved it to the background, so it stays without an outcome, and the
    // web shows it cut short once its Turn ends. Its own end comes in a task-notification Turn.
    else if (backgroundedByStop(done.result)) return done
    else ended(done.isError ? "Failed" : "Succeeded", resultSummary(tool, done.result))
    // A stopped background agent's run ends with no hook of its own, whoever called TaskStop: the
    // model, or hub-link-commands (#152). The result names the task, called by id or by name.
    if (tool === "TaskStop" && done.deny === undefined && !done.isError) {
      const stopped = stoppedTask(done.result)
      if (stopped !== undefined) reportStopped(stopped)
    }
    return done
  })

  // Sessions never ask for approval (ADR 0004): Claude Code runs with its permission prompts
  // bypassed, and a mode switched to at the terminal asks for none either.
  on("tool.check", async () => ({ decision: "allow" as const }))

  on("turn.start", async ($, e, next) => {
    state.mainTurn = e.turnId
    // hub-link-commands says which prompt from the Hub it submitted last, and who sent it.
    const { value: delivered } = await $.state.get({
      plugin: "hub-link-commands",
      key: "delivered",
    })
    const fromHub =
      delivered !== undefined &&
      delivered !== null &&
      delivered.promptId !== state.claimed &&
      startsDelivered(e.text, delivered.text)
        ? delivered
        : undefined
    if (fromHub !== undefined) state.claimed = fromHub.promptId
    const agentId = fromHub === undefined ? taskNotificationAgent(e.text) : undefined
    report({
      _tag: "TurnStarted",
      turnId: e.turnId,
      text: e.text,
      sender:
        fromHub !== undefined
          ? { _tag: "FromParticipant", participant: fromHub.sender }
          : agentId !== undefined
            ? { _tag: "FromAgent", agentId }
            : { _tag: "FromTerminal" },
      ...(fromHub === undefined ? {} : { promptId: fromHub.promptId }),
    })
    return next(e)
  })

  // A prompt hub-link-commands steers into the running Turn (#195, ADR 0018) is a row it appends:
  // reported as joining the Turn when it is kept. Once the Turn has ended, it is refused, so it
  // waits in the queue rather than in the conversation for whatever prompt comes next.
  on("session.append", { door: "note" }, async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    const { value: steered } = await $.state.get({ plugin: "hub-link-commands", key: "steering" })
    const block = e.message.content[0]
    if (
      steered === undefined ||
      steered === null ||
      block?.type !== "text" ||
      block.text !== steeredPrompt(steered.sender, steered.text)
    )
      return next(e)
    const turnId = state.mainTurn
    if (turnId === undefined) return { deny: "the Turn ended before the prompt could join it" }
    const appended = await next(e)
    if (appended.deny !== undefined) return appended
    state.unread.set(steered.promptId, turnId)
    report({
      _tag: "PromptSteered",
      turnId,
      promptId: steered.promptId,
      text: steered.text,
      sender: steered.sender,
    })
    return appended
  })

  on("turn.step", async function* ($, e, next) {
    if (e.agentId !== undefined) state.agentTurns.set(e.agentId, e.turnId)
    // The main loop's next request after a steered prompt joined carries it: Claude reads it now.
    else
      for (const [promptId, turnId] of state.unread) {
        if (turnId !== e.turnId) continue
        state.unread.delete(promptId)
        report({ _tag: "SteeredPromptRead", turnId, promptId })
      }
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
    if (e.agentId === undefined) {
      state.mainTurn = undefined
      // Left unread, Claude Code keeps it in the conversation for the next prompt (spike #195).
      state.unread.clear()
    } else {
      state.agentTurns.delete(e.agentId)
      // A foreground agent's run ends as aborted when it is stopped, with no SubagentStop (spike
      // #148).
      if (e.reason === "aborted") reportStopped(e.agentId)
    }
    return completed
  })

  // Subagents (ADR 0014): each is reported once it has started, under the Agent call that
  // started it; then Running at each run's SubagentStart, a resumed one's included, and Done at
  // its SubagentStop. The Hub knows only agents reported at their spawn, so it ignores the status
  // of Claude Code's own, such as progress summaries, which never pass `agent.spawn` (spike #148).
  on("agent.spawn", async ($, e, next) => {
    const spawned = await next(e)
    const agentId = spawned.agentId
    const turnId =
      e.parentAgentId === undefined ? state.mainTurn : state.agentTurns.get(e.parentAgentId)
    // Teammates (agent teams) are out of scope: they stay off unless a Repo turns them on.
    if (agentId === undefined || e.isTeammate === true || turnId === undefined) return spawned
    report({
      _tag: "AgentStarted",
      turnId,
      agentId,
      toolCallId: e.tool_use_id,
      agentType: e.subagentType,
      description: e.description,
      model: spawned.model,
      background: e.background,
    })
    // Its SubagentStart may have come first, while the spawn was under way, before the Hub knew
    // it.
    reportRunning(agentId, state.startedIn.get(agentId))
    return spawned
  })

  on("classic.SubagentStart", async ($, e, next) => {
    const done = await next(e)
    state.startedIn.set(e.agent_id, e.cwd)
    reportRunning(e.agent_id, e.cwd)
    return done
  })

  on("classic.SubagentStop", async ($, e, next) => {
    const done = await next(e)
    state.startedIn.delete(e.agent_id)
    report({ _tag: "AgentStatusChanged", agentId: e.agent_id, status: "Done" })
    return done
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
}
