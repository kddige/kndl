// Spike #148: the commands a person in the web UI would send to a Session's agents, run through
// the mod API: list them, message one, stop one, read its transcript, abort a turn, spawn one.
//
// It is a plugin of its own, apart from the probe, because a plugin's hooks don't see the work
// it causes: a subagent this plugin resumes with `$.session.send` (or spawns with
// `$.agent.spawn`) steps past this plugin's hooks, tool calls included. The probe, another
// plugin, sees all of it.
//
// It long-polls the probe server (SPIKE148_LOG_URL) for commands and posts back each result. A
// `foreground` command makes every later Agent call run in the foreground, by rewriting
// `agent.spawn`'s `background`.

import type { EngineInterface, On } from "claude-code"

const state: { url?: string; polling: boolean; foreground?: boolean } = { polling: false }

const clip = (value: unknown, max = 300) => {
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

type Command = { readonly id: number; readonly op: string; readonly [key: string]: unknown }

const run = async ($: EngineInterface, command: Command): Promise<unknown> => {
  switch (command.op) {
    case "list":
      return $.agent.list()
    case "send":
      return $.session.send({
        to: command.to as string | { agentId: string },
        text: String(command.text),
      })
    case "stop":
      return $.tool.call({ tool: "TaskStop", task_id: String(command.taskId) } as never)
    case "messages": {
      const messages = await $.session.messages({ agentId: String(command.agentId) } as never)
      return Array.isArray(messages) ? messages.map((message) => clip(message)) : messages
    }
    case "abort":
      return $.turn.abort({ turnId: String(command.turnId) } as never)
    case "submit":
      return $.prompt.submit({ text: String(command.text), asUser: true } as never)
    case "spawn":
      return $.agent.spawn(command.args as never)
    case "foreground":
      state.foreground = command.on === true
      return { foreground: state.foreground }
    case "id":
      return { id: await $.session.id(), cwd: await $.session.cwd() }
    default:
      return { error: `unknown op ${command.op}` }
  }
}

const poll = async ($: EngineInterface) => {
  if (state.polling) return
  state.polling = true
  while (true) {
    const response = await post($, "/commands", {})
    if (response === undefined || response.status !== 200) {
      await $.clock.sleep(2000)
      continue
    }
    for (const command of JSON.parse(response.text) as ReadonlyArray<Command>) {
      void run($, command).then(
        (result) => post($, "/result", { id: command.id, op: command.op, result }),
        (error) => post($, "/result", { id: command.id, op: command.op, error: String(error) }),
      )
    }
  }
}

export function register(on: On) {
  on("session.start", async ($, e, next) => {
    const started = await next(e)
    void poll($)
    return started
  })

  // Too late: Claude Code has already chosen foreground or background when agent.spawn runs, so
  // this rewrite doesn't change it (2.1.289). The tool.call rewrite below does.
  on("agent.spawn", async ($, e, next) =>
    state.foreground === true && !e.isTeammate ? next({ ...e, background: false }) : next(e),
  )

  on("tool.call", async ($, e, next) =>
    state.foreground === true && e.tool === "Agent" && (e as { name?: unknown }).name === undefined
      ? next({ ...e, run_in_background: false } as never)
      : next(e),
  )
}
