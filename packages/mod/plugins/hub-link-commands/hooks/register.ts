// hub-link-commands: the plugin that runs the Hub's commands in a Session's Claude Code, beside
// hub-link, which reports (ADR 0014). They are two because a plugin's hooks don't see the work it
// causes: an agent this plugin resumes with a message runs past its own hooks, but not past
// hub-link's (spike #148).
//
// - The Hub: says hello and long-polls for commands (see HubLink.ts): prompts from the Prompt
//   queue, stopping the Turn, messages to subagents and stopping one, and presence.
// - hub-link: reads which prompt it delivered last, and who sent it, to report the Turn it starts.
// - The person at the terminal: a band above the prompt shows the link and the Participants.
//
// The rest of the plugin, with Effect and the protocol, is bundled from the mod package's src/
// into hooks/hub-link-lib.js (`bun run build`).

import { atom, read, update } from "claude-code"
import type { EngineInterface, On } from "claude-code"
import type { HubLinkBand } from "../types"
import { HubLink, promptFromParticipant } from "./hub-link-lib.js"
import type { LinkStatus, ModCommand } from "./hub-link-lib.js"

const band = atom(
  { plugin: "hub-link-commands", key: "band" } as const,
  {
    status: "Unlinked",
    detail: "",
    participants: [],
  } as HubLinkBand,
)

const delivered = { plugin: "hub-link-commands", key: "delivered" } as const

/** The module's own state; a reload starts it over, and fires `session.start` again. */
const state = {
  link: undefined as HubLink | undefined,
  /** The Turn running on the main loop, which StopTurn stops. */
  mainTurn: undefined as string | undefined,
}

const report = (event: Record<string, unknown>) => state.link?.report(event)

const setBand = ($: EngineInterface, change: Partial<HubLinkBand>) =>
  update($, band, (value) => ({ ...value, ...change })).catch(() => undefined)

const bandStatus = (status: LinkStatus): Partial<HubLinkBand> =>
  status._tag === "Rejected"
    ? { status: "Rejected", detail: status.reason }
    : { status: status._tag, detail: "" }

type Command<Tag extends ModCommand["_tag"]> = Extract<ModCommand, { _tag: Tag }>

const deliverPrompt = async ($: EngineInterface, command: Command<"DeliverPrompt">) => {
  const failed = (message: string) => {
    // No Turn starts with it.
    void $.state.set(delivered, null).catch(() => undefined)
    report({ _tag: "PromptFailed", promptId: command.promptId, message })
  }
  const text = promptFromParticipant(command.sender, command.text)
  try {
    // Said before it is submitted, so hub-link reads it when the Turn starts.
    await $.state.set(delivered, { promptId: command.promptId, sender: command.sender, text })
    const entered = await $.prompt.submit({ text, asUser: true })
    if (entered.drop !== undefined) failed(`a hook dropped the prompt: ${entered.drop}`)
  } catch (error) {
    failed(String(error))
  }
}

/**
 * A Participant's message to an agent (ADR 0014), with their name, as a prompt is: a running
 * agent reads it at its next tool call; one that has stopped resumes with it.
 */
const messageAgent = async ($: EngineInterface, command: Command<"DeliverAgentMessage">) => {
  const failed = (message: string) =>
    report({
      _tag: "AgentCommandFailed",
      agentId: command.agentId,
      command: "MessageAgent",
      senderId: command.sender.id,
      message,
    })
  try {
    const sent = await $.session.send({
      to: { agentId: command.agentId },
      text: promptFromParticipant(command.sender, command.text),
    })
    if (!sent.isDelivered) failed(sent.reason)
  } catch (error) {
    failed(String(error))
  }
}

/** Stops an agent with Claude Code's TaskStop, by its id; hub-link sees the call, and reports it. */
const stopAgent = async ($: EngineInterface, command: Command<"StopAgent">) => {
  const failed = (message: string) =>
    report({
      _tag: "AgentCommandFailed",
      agentId: command.agentId,
      command: "StopAgent",
      message,
    })
  try {
    const stopped = await $.tool.call({ tool: "TaskStop", task_id: command.agentId })
    if (stopped.deny !== undefined) failed(stopped.deny)
    else if (stopped.isError) failed(String(stopped.result))
  } catch (error) {
    failed(String(error))
  }
}

const runCommand = async ($: EngineInterface, command: ModCommand) => {
  switch (command._tag) {
    // Neither waits: a prompt waits for the session to be idle, and a resumed agent runs on, while
    // the poll goes on.
    case "DeliverPrompt":
      void deliverPrompt($, command)
      return
    case "DeliverAgentMessage":
      void messageAgent($, command)
      return
    case "StopAgent":
      await stopAgent($, command)
      return
    case "StopTurn":
      if (state.mainTurn !== undefined) await $.turn.abort({ turnId: state.mainTurn })
      return
    case "PresenceChanged":
      // Someone forwarding a port is here too, from a machine (#180).
      await setBand($, {
        participants: command.participants.map((person) =>
          person.forwardingFrom === undefined
            ? person.name
            : `${person.name} (forwarding from ${person.forwardingFrom.join(", ")})`,
        ),
      })
      return
  }
}

const startLink = async ($: EngineInterface) => {
  const [hubUrl, sessionId, modToken, kind] = await Promise.all([
    $.env.get("CLAUDE_HUB_URL"),
    $.env.get("CLAUDE_HUB_SESSION_ID"),
    $.env.get("CLAUDE_HUB_MOD_TOKEN"),
    $.env.get("CLAUDE_CODE_SESSION_KIND"),
  ])
  // hub-link says so in the debug log. A background job or daemon of Claude Code's isn't the
  // Session's Claude Code, and runs none of its commands (#191).
  if (!hubUrl || !sessionId || !modToken || kind) return
  state.link?.stop()
  state.link = new HubLink({
    hubUrl,
    modToken,
    hello: { sessionId, claudeSessionId: await $.session.id(), model: await $.session.model() },
    fetch: (url, init) => $.http.fetch(url, init),
    // Its own timers, so a Stop can't cut what it does short (#165).
    after: (ms, fn) => void $.clock.after(ms, fn),
    onCommand: (command) => runCommand($, command),
    onStatus: (status) => void setBand($, bandStatus(status)),
    log: (text) => $.ui.log(text, { to: "debug" }),
  })
  state.link.start()
}

export function register(on: On) {
  on("session.start", async ($, e, next) => {
    const started = await next(e)
    await startLink($).catch((error) => $.ui.log(`hub-link-commands: ${error}`, { to: "debug" }))
    return started
  })

  on("session.end", async ($, e, next) => {
    const ended = await next(e)
    await state.link?.flushNow()
    return ended
  })

  // A Turn from a prompt this plugin submitted reaches these hooks too: only an agent it resumes
  // runs past them.
  on("turn.start", async ($, e, next) => {
    state.mainTurn = e.turnId
    return next(e)
  })

  on("turn.complete", async ($, e, next) => {
    if (e.agentId === undefined && e.turnId === state.mainTurn) state.mainTurn = undefined
    return next(e)
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
