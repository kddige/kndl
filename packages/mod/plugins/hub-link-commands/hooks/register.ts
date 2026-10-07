// hub-link-commands: the plugin that runs the Hub's commands in a Session's Claude Code, beside
// hub-link, which reports (ADR 0014). They are two because a plugin's hooks don't see the work it
// causes: an agent this plugin resumes with a message runs past its own hooks, but not past
// hub-link's (spike #148).
//
// - The Hub: says hello and long-polls for commands (see HubLink.ts): prompts from the Prompt
//   queue, prompts steered into the running Turn, stopping the Turn, messages to subagents and
//   stopping one, and presence.
// - hub-link: reads which prompt it delivered last, and who sent it, to report the Turn it starts;
//   and which it is steering, to report it joining the Turn.
// - The person at the terminal: a band above the prompt shows the link and the Participants.
//
// The rest of the plugin, with Effect and the protocol, is bundled from the mod package's src/
// into hooks/hub-link-lib.js (`bun run build`).

import { atom, read, update } from "claude-code"
import type { EngineInterface, On } from "claude-code"
import type { HubLinkBand } from "../types"
import {
  answerResult,
  askedQuestions,
  HubLink,
  promptFromParticipant,
  steeredPrompt,
  terminalOutcome,
} from "./hub-link-lib.js"
import type { LinkStatus, ModCommand, Participant, QuestionAnswer } from "./hub-link-lib.js"

const band = atom(
  { plugin: "hub-link-commands", key: "band" } as const,
  {
    status: "Unlinked",
    detail: "",
    participants: [],
  } as HubLinkBand,
)

const delivered = { plugin: "hub-link-commands", key: "delivered" } as const
const steering = { plugin: "hub-link-commands", key: "steering" } as const

/** The module's own state; a reload starts it over, and fires `session.start` again. */
const state = {
  link: undefined as HubLink | undefined,
  /** The Turn running on the main loop, which StopTurn stops. */
  mainTurn: undefined as string | undefined,
  /** The Turn StopTurn stopped last. */
  stoppedTurn: undefined as string | undefined,
  /**
   * The AskUserQuestion calls waiting for an answer, by id (#193): each takes a Participant's
   * answer, and says whether it came first.
   */
  asking: new Map<string, (answer: QuestionAnswer, sender: Participant) => boolean>(),
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
 * A queued prompt a Participant steered into the running Turn (#195, ADR 0018): a row of the
 * Turn's conversation, which Claude reads at its next step, as Claude Code adds a prompt typed
 * while it works. hub-link sees it join, and reports it. Once the Turn has ended it can't join:
 * the Hub keeps it queued.
 */
const deliverIntoTurn = async ($: EngineInterface, command: Command<"DeliverIntoTurn">) => {
  const failed = (message: string) =>
    report({ _tag: "PromptFailed", promptId: command.promptId, message })
  if (state.mainTurn === undefined) return failed("no Turn is running")
  const { promptId, sender, text } = command
  try {
    // Said before it is appended, so hub-link knows the row.
    await $.state.set(steering, { promptId, sender, text })
    const appended = await $.session.append({
      message: { type: "user", content: [{ type: "text", text: steeredPrompt(sender, text) }] },
    })
    if (appended.deny !== undefined) failed(appended.deny)
  } catch (error) {
    failed(String(error))
  } finally {
    await $.state.set(steering, null).catch(() => undefined)
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
    // Appended at once, so one steered prompt is told from the next.
    case "DeliverIntoTurn":
      await deliverIntoTurn($, command)
      return
    case "StopAgent":
      await stopAgent($, command)
      return
    case "StopTurn":
      if (state.mainTurn === undefined) return
      state.stoppedTurn = state.mainTurn
      await $.turn.abort({ turnId: state.mainTurn })
      return
    case "DeliverAnswer":
      // Too late: answered at the terminal or by someone else first, or cancelled. The Hub tells
      // the sender which.
      if (state.asking.get(command.toolCallId)?.(command.answer, command.sender) !== true)
        report({
          _tag: "AnswerFailed",
          toolCallId: command.toolCallId,
          senderId: command.sender.id,
          message: "The question was answered or closed already.",
        })
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
    $.env.get("KNDL_URL"),
    $.env.get("KNDL_SESSION_ID"),
    $.env.get("KNDL_MOD_TOKEN"),
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

  // Claude's question on the main loop is the Session's Open question (#193): its dialog opens at
  // the terminal as ever, and any Participant may answer it from the web UI meanwhile. The first
  // answer is the one Claude reads; one from the web closes the dialog, by settling this call
  // while it is still open. A subagent's questions are answered at the terminal alone.
  on("tool.call", { tool: "AskUserQuestion" }, async ($, e, next) => {
    const turnId = state.mainTurn
    const toolCallId = e.tool_use_id
    if (e.agentId !== undefined || state.link === undefined || turnId === undefined || !toolCallId)
      return next(e)
    report({ _tag: "QuestionAsked", turnId, toolCallId, questions: askedQuestions(e.questions) })
    const closed = (outcome: Record<string, unknown>, by?: Participant) =>
      report({
        _tag: "QuestionClosed",
        turnId,
        toolCallId,
        outcome,
        ...(by === undefined ? {} : { by }),
      })
    let settled = false
    const settle = () => {
      if (settled) return false
      settled = true
      state.asking.delete(toolCallId)
      return true
    }
    // Stopped from the web UI: Claude reads no answer, and the Hub hears so now. Esc at the
    // terminal stops the Turn too, and the call then ends refused, as dismissed (#206). One
    // stopped otherwise that never ends, the Hub closes as cancelled with its Turn.
    const isStopped = () => state.stoppedTurn === turnId
    next.signal.addEventListener("abort", () => {
      if (isStopped() && settle()) closed({ _tag: "Cancelled" })
    })
    return new Promise<Awaited<ReturnType<typeof next>>>((resolve, reject) => {
      state.asking.set(toolCallId, (answer, sender) => {
        if (!settle()) return false
        closed(answer, sender)
        resolve(answerResult(e.questions, answer, sender) as never)
        return true
      })
      next(e).then(
        (done) => {
          if (settle()) closed(isStopped() ? { _tag: "Cancelled" } : terminalOutcome(done))
          resolve(done)
        },
        (error: unknown) => {
          if (settle()) closed({ _tag: "Cancelled" })
          reject(error)
        },
      )
    })
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
