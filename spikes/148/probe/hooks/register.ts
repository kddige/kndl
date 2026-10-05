// Spike #148: a probe mod that shows what Claude Code's mod API exposes about subagents.
//
// It logs, to the host's probe server (SPIKE148_LOG_URL), every event that says something about
// an agent: turn.start, turn.step, turn.complete, tool.call, agent.spawn, session.send,
// session.receive and the classic hooks (SubagentStart, SubagentStop, TaskCreated, WorktreeCreate
// and the rest), with a `$.agent.list()` snapshot after each agent event. The commands a person
// in the web UI would send (message an agent, stop one) are in the control plugin beside it.
//
// Nothing here changes what Claude Code does: every hook passes its event on unchanged.

import type { EngineInterface, On } from "claude-code"

const state: { url?: string } = {}

const clip = (value: unknown, max = 600) => {
  const text = typeof value === "string" ? value : JSON.stringify(value)
  if (text === undefined) return undefined
  return text.length > max ? `${text.slice(0, max)}…(${text.length})` : text
}

const post = async ($: EngineInterface, path: string, body: unknown) => {
  state.url ??= (await $.env.get("SPIKE148_LOG_URL")) || undefined
  if (state.url === undefined) return undefined
  return $.http
    .fetch(`${state.url}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })
    .catch(() => undefined)
}

const log = ($: EngineInterface, event: string, data: Record<string, unknown>) =>
  post($, "/log", { event, ...data })

const snapshot = async ($: EngineInterface, why: string) => {
  try {
    await log($, "agent.list", { why, agents: await $.agent.list() })
  } catch (error) {
    await log($, "agent.list", { why, error: String(error) })
  }
}

export function register(on: On) {
  on("session.start", async ($, e, next) => {
    const started = await next(e)
    await log($, "session.start", {
      input: clip(e, 400),
      sessionId: await $.session.id(),
      cwd: await $.session.cwd(),
    })
    return started
  })

  on("turn.start", async ($, e, next) => {
    await log($, "turn.start", { turnId: e.turnId, text: clip(e.text, 200) })
    return next(e)
  })

  on("turn.step", async function* ($, e, next) {
    const stream = next(e)
    while (true) {
      const piece = await stream.next()
      if (piece.done) {
        const result = piece.value
        await log($, "turn.step", {
          agentId: e.agentId,
          turnId: e.turnId,
          index: e.index,
          model: e.model,
          messageCount: e.messageCount,
          answer: clip(result.answer, 200),
          toolUses: result.toolUses.map((use) => clip(use, 300)),
          stopReason: result.stopReason,
        })
        return result
      }
      yield piece.value
    }
  })

  on("turn.complete", async ($, e, next) => {
    const completed = await next(e)
    await log($, "turn.complete", {
      agentId: e.agentId,
      turnId: e.turnId,
      reason: e.reason,
      durationMs: e.durationMs,
      answer: clip(e.answer, 300),
      usage: e.usage,
    })
    if (e.agentId !== undefined) await snapshot($, "turn.complete")
    return completed
  })

  on("tool.call", async ($, e, next) => {
    await log($, "tool.call", {
      phase: "before",
      tool: e.tool,
      agentId: e.agentId,
      toolUseId: e.tool_use_id,
      input: clip(e, 800),
    })
    const done = await next(e)
    await log($, "tool.call", {
      phase: "after",
      tool: e.tool,
      agentId: e.agentId,
      toolUseId: e.tool_use_id,
      deny: done.deny,
      isError: (done as { isError?: boolean }).isError,
      result: clip((done as { result?: unknown }).result, 1500),
    })
    if (["Agent", "Task", "TaskStop", "SendMessage"].includes(String(e.tool)))
      await snapshot($, `tool.call ${String(e.tool)}`)
    return done
  })

  on("agent.spawn", async ($, e, next) => {
    await log($, "agent.spawn", { phase: "before", input: clip(e, 1200) })
    const spawned = await next(e)
    await log($, "agent.spawn", { phase: "after", result: clip(spawned, 600) })
    await snapshot($, "agent.spawn")
    return spawned
  })

  on("session.send", async ($, e, next) => {
    const sent = await next(e)
    await log($, "session.send", { input: clip(e, 800), result: sent })
    return sent
  })

  on("session.receive", async ($, e, next) => {
    const received = await next(e)
    await log($, "session.receive", { input: clip(e, 800), result: clip(received, 300) })
    return received
  })

  on("classic.*", async ($, e, next) => {
    await log($, next.event, { input: clip(e, 1500) })
    const done = await next(e)
    if (/Subagent|Task|Teammate|Worktree/.test(next.event)) await snapshot($, next.event)
    return done
  })
}
