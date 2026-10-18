// hub-link-commands: the plugin that runs the Hub's commands in a Session's Claude Code, beside
// hub-link, which reports (ADR 0014). They are two because a plugin's hooks don't see the work it
// causes: an agent this plugin resumes with a message runs past its own hooks, but not past
// hub-link's (spike #148).
//
// - The Hub: says hello and long-polls for commands (see HubLink.ts): prompts from the Prompt
//   queue, prompts steered into the running Turn, stopping the Turn, messages to subagents and
//   stopping one, and presence.
// - hub-link: reads which prompt it delivered last, and who sent it, to report the Turn it starts
//   and tell Claude of its files; and which it is steering, to report it joining the Turn.
// - The person at the terminal, the Session's Creator: a band above the prompt shows the link and
//   the Participants watching (ADR 0026).
// - Claude: a tool that opens the files the Creator attaches to prompts (#276, ADR 0024), which the
//   plugin API's prompts can't carry: it fetches each from the Hub, and answers with the image or
//   PDF (#277). After the Session switched to Claude Code from another Harness, a context handoff
//   of what happened meanwhile, and a tool that reads further back in its history (ADR 0030).
//
// The rest of the plugin, with Effect and the protocol, is bundled from the mod package's src/
// into hooks/hub-link-lib.js (`bun run build`).

import { atom, read, update } from "claude-code"
import type { EngineInterface, On } from "claude-code"
import type { HubLinkBand } from "../types"
import {
  askedAsyncText,
  askedQuestions,
  attachmentContext,
  attachmentToolName,
  attachmentToolSpec,
  deliveredPrompt,
  handoffNote,
  historyAnswer,
  historyPath,
  historyRequest,
  historyToolName,
  historyToolSpec,
  HubLink,
  openAttachment,
  questionResultText,
  questionToolName,
  questionToolSpec,
  steeredPrompt,
  stillOpenText,
} from "./hub-link-lib.js"
import type {
  Command,
  LinkStatus,
  ModCommand,
  Participant,
  Question,
  QuestionAnswer,
} from "./hub-link-lib.js"
import { dialogs, PANE, registerQuestionDialog, rowsFor } from "./question-dialog.ts"
import type { Submit } from "./question-dialog.ts"

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
/** The question dialog's state, which question-dialog.ts draws from. */
const question = { plugin: "hub-link-commands", key: "question" } as const

/** The module's own state; a reload starts it over, and fires `session.start` again. */
const state = {
  link: undefined as HubLink | undefined,
  /** Where the Hub is, and the mod token, for the attachment tool's fetches. */
  hub: undefined as { readonly url: string; readonly modToken: string } | undefined,

  /** The Turn running on the main loop, which StopTurn stops. */
  mainTurn: undefined as string | undefined,
  /**
   * The question tool's calls waiting for an answer, by id (#193): each takes an answer, from the
   * web UI with its sender, or from the terminal's dialog with none, and says whether it came
   * first.
   */
  asking: new Map<string, (answer: QuestionAnswer, sender: Participant | undefined) => boolean>(),
  /** The call of the question asked `async` that is still waiting for an answer, if one is. */
  asyncOpen: undefined as string | undefined,
  /**
   * A context handoff Claude Code wouldn't append as a note (ADR 0030): it goes, out of sight,
   * with the next prompt instead.
   */
  handoff: undefined as string | undefined,
}

/** The handoff waiting for the next prompt, if one is: taken, so it goes once. */
const takeHandoff = () => {
  const note = state.handoff
  state.handoff = undefined
  return note
}

/** A handoff taken for a prompt that never went: it waits for the next, unless a later one does. */
const putBackHandoff = (note: string | undefined) => {
  state.handoff ??= note
}

const report = (event: Record<string, unknown>) => state.link?.report(event)

/**
 * The prompts given Claude Code, by id, so one delivered again isn't run twice (#323): the Hub
 * delivers the head of its queue again when it restarts, or when the TurnStarted that takes a
 * prompt out of it was lost. Kept here for this process, and in the store, which is in the
 * Session's own Claude configuration, for the next: the last `SubmittedKept` of them.
 */
const submitted = {
  ids: new Set<string>(),
  /** The store's list is read, changed and written back one change at a time. */
  writing: Promise.resolve(),
}
const SubmittedKept = 200

const storeSubmitted = (
  $: EngineInterface,
  change: (ids: ReadonlyArray<string>) => Array<string>,
) => {
  submitted.writing = submitted.writing
    .then(async () => {
      const kept = await $.store.get("submitted")
      const ids = Array.isArray(kept) ? kept.filter((id) => typeof id === "string") : []
      await $.store.set("submitted", change(ids).slice(-SubmittedKept))
    })
    .catch(() => undefined)
  return submitted.writing
}

/** Whether `promptId` was given Claude Code already; if not, it is now said to be. */
const submittedBefore = async ($: EngineInterface, promptId: string) => {
  // Checked and taken before anything is awaited, so a prompt delivered twice at once runs once.
  if (submitted.ids.has(promptId)) return true
  submitted.ids.add(promptId)
  const kept = await $.store.get("submitted").catch(() => undefined)
  if (Array.isArray(kept) && kept.includes(promptId)) return true
  await storeSubmitted($, (ids) => [...ids, promptId])
  return false
}

/** `promptId` wasn't given Claude Code after all, so it may be delivered again. */
const notSubmitted = ($: EngineInterface, promptId: string) => {
  submitted.ids.delete(promptId)
  void storeSubmitted($, (ids) => ids.filter((id) => id !== promptId))
}

const setBand = ($: EngineInterface, change: Partial<HubLinkBand>) =>
  update($, band, (value) => ({ ...value, ...change })).catch(() => undefined)

const bandStatus = (status: LinkStatus): Partial<HubLinkBand> =>
  status._tag === "Rejected"
    ? { status: "Rejected", detail: status.reason }
    : { status: status._tag, detail: "" }

const deliverPrompt = async ($: EngineInterface, command: Command<"DeliverPrompt">) => {
  if (await submittedBefore($, command.promptId)) {
    // A Hub from before #323 would refuse the event, so it keeps the prompt queued: still run once.
    if (state.link?.takesAlreadySubmitted) {
      report({ _tag: "PromptAlreadySubmitted", promptId: command.promptId })
    }
    return
  }
  const handoff = takeHandoff()
  const failed = (message: string) => {
    // No Turn starts with it, nor with its handoff, which waits for the next prompt.
    putBackHandoff(handoff)
    void $.state.set(delivered, null).catch(() => undefined)
    notSubmitted($, command.promptId)
    report({ _tag: "PromptFailed", promptId: command.promptId, message })
  }
  const attachments = command.attachments ?? []
  const text = deliveredPrompt(command.sender, command.text, attachments)
  const context = [
    handoff,
    attachments.length > 0 ? attachmentContext(attachments) : undefined,
  ].filter((part) => part !== undefined)
  try {
    // Said before it is submitted, so hub-link reads it when the Turn starts, and adds what Claude
    // is told of its files, and a handoff that waits: a plugin's own hooks don't see the prompt it
    // submits.
    await $.state.set(delivered, {
      promptId: command.promptId,
      sender: command.sender,
      text,
      ...(context.length > 0 && { context: context.join("\n\n") }),
    })
    const entered = await $.prompt.submit({ text, asUser: true })
    if (entered.drop !== undefined) failed(`a hook dropped the prompt: ${entered.drop}`)
  } catch (error) {
    failed(String(error))
  }
}

/**
 * A queued prompt the Creator steered into the running Turn (#195, ADR 0018): a row of the
 * Turn's conversation, which Claude reads at its next step, as Claude Code adds a prompt typed
 * while it works. hub-link sees it join, and reports it. Once the Turn has ended it can't join:
 * the Hub keeps it queued.
 */
const deliverIntoTurn = async ($: EngineInterface, command: Command<"DeliverIntoTurn">) => {
  const failed = (message: string) =>
    report({ _tag: "PromptFailed", promptId: command.promptId, message })
  if (state.mainTurn === undefined) return failed("no Turn is running")
  const { promptId, sender, text } = command
  const attachments = command.attachments ?? []
  // Its files are marked in the row (#278): Claude opens them by the markers alone.
  const row = steeredPrompt(sender, text, attachments)
  try {
    // Said before it is appended, so hub-link knows the row.
    await $.state.set(steering, {
      promptId,
      sender,
      text,
      ...(attachments.length > 0 && { attachments: [...attachments] }),
      appended: row,
    })
    const appended = await $.session.append({
      message: { type: "user", content: [{ type: "text", text: row }] },
    })
    if (appended.deny !== undefined) failed(appended.deny)
  } catch (error) {
    failed(String(error))
  } finally {
    await $.state.set(steering, null).catch(() => undefined)
  }
}

/**
 * What happened in the Session while another Harness ran it (ADR 0030), as a note in the
 * conversation, appended as a steered prompt is: Claude reads it with the next prompt, ahead of it,
 * and no Turn starts with it (spike #195; in a new conversation too, checked against Claude Code
 * 2.1.296 with a stub API). It comes once Claude Code has started, before the next
 * prompt, so while Claude is idle; if it comes during a Turn, Claude reads it at the Turn's next
 * step. One Claude Code won't append goes with the next prompt instead, unless a later one is
 * appended first, which takes its place.
 */
const deliverHandoff = async ($: EngineInterface, command: Command<"DeliverHandoff">) => {
  const note = handoffNote(command, historyToolName)
  if (note === undefined) return
  const held = (why: string) => {
    $.ui.log(`hub-link-commands: the handoff waits for the next prompt: ${why}`, { to: "debug" })
    state.handoff = note
  }
  try {
    const appended = await $.session.append({
      message: { type: "user", content: [{ type: "text", text: note }] },
    })
    if (appended.deny !== undefined) held(appended.deny)
    else state.handoff = undefined
  } catch (error) {
    held(String(error))
  }
}

/**
 * The Creator's message to an agent (ADR 0014), with their name and a marker for each file
 * (#278), as a prompt is: a running agent reads it at its next tool call; one that has stopped
 * resumes with it. A subagent type that lists its own tools can't open the files.
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
      text: deliveredPrompt(command.sender, command.text, command.attachments ?? []),
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

/** A tool's result that is text alone. */
const textResult = (text: string) => ({ result: [{ type: "text" as const, text }] })

/**
 * The answer to the question Claude asked `async` (#193), as a note in its conversation if a Turn
 * runs, as a steered prompt is: it reads it at its next step. With none, or once it has ended, a
 * Turn of its own starts with it, from whoever answered: the person at the terminal, who has no
 * `sender`, answers it from the dialog.
 */
const giveAnswer = async (
  $: EngineInterface,
  toolCallId: string,
  sender: Participant | undefined,
  text: string,
) => {
  const lost = (why: string) =>
    $.ui.log(`hub-link-commands: couldn't give Claude the answer to a question: ${why}`, {
      to: "debug",
    })
  try {
    if (state.mainTurn !== undefined) {
      const appended = await $.session.append({
        message: { type: "user", content: [{ type: "text", text }] },
      })
      if (appended.deny === undefined) return
    }
    // Said before it is submitted, so hub-link reports the Turn as the answerer's. Without one it
    // is the terminal's, as a prompt typed there is.
    if (sender !== undefined)
      await $.state.set(delivered, { promptId: `answer-${toolCallId}`, sender, text })
    const entered = await $.prompt.submit({ text, asUser: true })
    if (entered.drop !== undefined) lost(`a hook dropped the prompt: ${entered.drop}`)
  } catch (error) {
    lost(String(error))
  }
}

/**
 * Opens the question's pane, and says if it is drawn. One the person's command opens is placed at
 * any width; one a tool opens waits undrawn below 144 columns.
 */
const showPane = async ($: EngineInterface, questions: ReadonlyArray<Question>) => {
  try {
    const opened = await $.ui.open({
      id: PANE,
      title: "Question",
      focus: true,
      rows: rowsFor(questions),
    })
    return opened.isPlaced
  } catch (error) {
    $.ui.log(`hub-link-commands: couldn't open the question pane: ${error}`, { to: "debug" })
    return false
  }
}

/**
 * Shows the questions of `toolCallId` in the terminal's pane (#193), until the question closes
 * (`closeDialog`) or the pane answers it: `submit` takes the answer, and tells the question's call.
 * Never rejects: a pane that can't be drawn leaves the web UI to answer.
 */
const openDialog = async (
  $: EngineInterface,
  opened: { toolCallId: string; async: boolean; questions: ReadonlyArray<Question> },
  submit: Submit,
) => {
  const { toolCallId, questions } = opened
  dialogs.submitters.set(toolCallId, submit)
  dialogs.current = toolCallId
  try {
    await $.state.set(question, {
      toolCallId,
      async: opened.async,
      questions: [...questions],
      index: 0,
      answers: {},
      picked: [],
    })
    // Closed already, by an answer from the web UI or a Stop, while the state was written.
    if (dialogs.current !== toolCallId) return
    const isPlaced = await showPane($, questions)
    if (dialogs.current !== toolCallId) {
      // Closed while the pane opened: it goes, unless another question has it by now.
      if (dialogs.current === undefined) await $.ui.close({ id: PANE })
      return
    }
    if (!isPlaced) $.ui.toast("The agent has a question: type /question, or widen the terminal.")
  } catch (error) {
    $.ui.log(`hub-link-commands: couldn't show the question: ${error}`, { to: "debug" })
  }
}

/** The question of `toolCallId` is answered or closed: its pane goes, if it is the one shown. */
const closeDialog = async ($: EngineInterface, toolCallId: string) => {
  dialogs.submitters.delete(toolCallId)
  if (dialogs.current !== toolCallId) return
  dialogs.current = undefined
  try {
    await $.state.set(question, null)
    // Another question opened meanwhile, and has the pane.
    if (dialogs.current !== undefined) return
    // Our own close, which `ui.close` hears as the plugin's: it dismisses nothing.
    await $.ui.close({ id: PANE })
  } catch (error) {
    $.ui.log(`hub-link-commands: couldn't close the question pane: ${error}`, { to: "debug" })
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
    // Appended before the prompt that follows it is submitted.
    case "DeliverHandoff":
      await deliverHandoff($, command)
      return
    case "StopAgent":
      await stopAgent($, command)
      return
    case "StopTurn":
      if (state.mainTurn === undefined) return
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
  const [hubUrl, sessionId, modToken, kind, launched] = await Promise.all([
    $.env.get("KNDL_URL"),
    $.env.get("KNDL_SESSION_ID"),
    $.env.get("KNDL_MOD_TOKEN"),
    $.env.get("CLAUDE_CODE_SESSION_KIND"),
    $.env.get("KNDL_CONVERSATION_ID"),
  ])
  // hub-link says so in the debug log. A background job or daemon of Claude Code's isn't the
  // Session's Claude Code, and runs none of its commands (#191); nor does a `claude` run inside
  // the Session as another conversation than the one the Runner launched (#321).
  if (!hubUrl || !sessionId || !modToken || kind) return false
  const conversation = await $.session.id()
  if (launched && conversation !== launched) return false
  state.hub = { url: hubUrl.replace(/\/+$/, ""), modToken }
  state.link?.stop()
  state.link = new HubLink({
    hubUrl,
    modToken,
    hello: { sessionId, conversationId: conversation, model: await $.session.model() },
    fetch: (url, init) => $.http.fetch(url, init),
    // Its own timers, so a Stop can't cut what it does short (#165).
    after: (ms, fn) => void $.clock.after(ms, fn),
    onCommand: (command) => runCommand($, command),
    onStatus: (status) => void setBand($, bandStatus(status)),
    log: (text) => $.ui.log(text, { to: "debug" }),
  })
  state.link.start()
  return true
}

export function register(on: On) {
  on("session.start", async ($, e, next) => {
    const started = await next(e)
    const linked = await startLink($).catch((error) => {
      $.ui.log(`hub-link-commands: ${error}`, { to: "debug" })
      return false
    })
    // In the tool list from the first request on, beside the Hub link they fetch through.
    if (linked) {
      for (const tool of [attachmentToolSpec, historyToolSpec, questionToolSpec])
        await $.tool
          .register(tool)
          .catch((error) => $.ui.log(`hub-link-commands: ${error}`, { to: "debug" }))
      // The way to the pane where the terminal is too narrow for a tool to open it.
      await $.command
        .register({
          name: "question",
          description: "Show the agent's open question",
          // The agent may be waiting for the answer, with its Turn running.
          immediate: true,
        })
        .catch((error) => $.ui.log(`hub-link-commands: ${error}`, { to: "debug" }))
    }
    return started
  })

  // A handoff that waits goes with a prompt typed at the terminal, if that comes first, out of
  // sight. This plugin's own prompts don't pass here: they carry it themselves.
  on("prompt.submit", async ($, e, next) => {
    const note = takeHandoff()
    return next(note === undefined ? e : { ...e, context: [...(e.context ?? []), note] })
  })

  // The Session's earlier Turns (ADR 0030), as the handoff or the tool's last answer says where
  // they start: fetched from the Hub, through the Runner's relay, and handed Claude as text.
  on("tool.call", { tool: historyToolName }, async ($, e) => {
    const hub = state.hub
    if (hub === undefined) return { deny: "This session is not linked to a kndl Hub." }
    const request = historyRequest(e)
    if ("error" in request) return { deny: request.error }
    try {
      const response = await $.http.fetch(`${hub.url}${historyPath(request)}`, {
        headers: { authorization: `Bearer ${hub.modToken}` },
      })
      const answer = historyAnswer(response.status, response.text, request, historyToolName)
      return "error" in answer
        ? { deny: answer.error }
        : { result: [{ type: "text" as const, text: answer.text }] }
    } catch (error) {
      return { deny: `Could not read the session's history: ${String(error)}` }
    }
  })

  // A file the Creator attached (#276, ADR 0024), by the id its marker gives: fetched from the
  // Hub, through the Runner's relay, in parts the runtime's fetch can read, and handed to Claude as
  // an image block, or a document block for a PDF (#277).
  on("tool.call", { tool: attachmentToolName }, async ($, e) => {
    const hub = state.hub
    if (hub === undefined) return { deny: "This session is not linked to a kndl Hub." }
    return openAttachment(typeof e.id === "string" ? e.id : "", (path) =>
      $.http.fetch(`${hub.url}${path}`, { headers: { authorization: `Bearer ${hub.modToken}` } }),
    )
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

  // Claude's question on the main loop is the Session's Open question (#193). The tool replaces
  // Claude Code's AskUserQuestion, which the Runner turns off: it takes the same questions, and an
  // `async` option, with which Claude goes on while they are answered. Claude Code's own dialog
  // can't be opened with its tool off, so a pane of this plugin's asks at the terminal, beside the
  // web UI: whichever answers first wins. A question Claude waits for holds the call until the
  // answer, or a Stop; one asked `async` returns at once, and its answer reaches Claude as a note,
  // or as a Turn of its own. A subagent's questions are refused.
  on("tool.call", { tool: questionToolName }, async ($, e, next) => {
    const turnId = state.mainTurn
    const toolCallId = e.tool_use_id
    if (e.agentId !== undefined)
      return { deny: "Subagents can't ask the people in this session questions." }
    const questions = askedQuestions(e.questions)
    if (questions.length === 0) return { deny: "Ask one to four questions: none came." }
    if (state.link === undefined || turnId === undefined || !toolCallId)
      return { deny: "There is no one to ask now: this session isn't linked to a kndl Hub." }
    if (state.asyncOpen !== undefined) return textResult(stillOpenText)
    const isAsync = e.async === true
    report({
      _tag: "QuestionAsked",
      turnId,
      toolCallId,
      questions,
      ...(isAsync && { async: true }),
    })
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
      if (state.asyncOpen === toolCallId) state.asyncOpen = undefined
      // The pane goes, whoever answered, or if the Turn was stopped.
      void closeDialog($, toolCallId)
      return true
    }
    const dialog = { toolCallId, async: isAsync, questions }
    // The terminal's dialog answers as the web UI does, with no one to name.
    const answerFromTerminal = (answer: QuestionAnswer) =>
      state.asking.get(toolCallId)?.(answer, undefined)
    if (isAsync) {
      state.asyncOpen = toolCallId
      state.asking.set(toolCallId, (answer, sender) => {
        if (!settle()) return false
        closed(answer, sender)
        void giveAnswer(
          $,
          toolCallId,
          sender,
          questionResultText(questions, { outcome: answer, by: sender }, true),
        )
        return true
      })
      await openDialog($, dialog, answerFromTerminal)
      return textResult(askedAsyncText)
    }
    const answered = new Promise<Awaited<ReturnType<typeof next>>>((resolve) => {
      // Stopped, from the web UI or at the terminal: Claude reads no answer, and the Hub
      // hears so now.
      next.signal.addEventListener("abort", () => {
        if (!settle()) return
        closed({ _tag: "Cancelled" })
        resolve({ deny: "The questions were closed without an answer: the Turn was stopped." })
      })
      state.asking.set(toolCallId, (answer, sender) => {
        if (!settle()) return false
        closed(answer, sender)
        resolve(textResult(questionResultText(questions, { outcome: answer, by: sender })) as never)
        return true
      })
    })
    await openDialog($, dialog, answerFromTerminal)
    return answered
  })

  registerQuestionDialog(on)

  on("command.run", { command: "question" }, async ($) => {
    if (dialogs.current === undefined) return { text: "No question is open." }
    const shown = await read($, question)
    const isPlaced = await showPane($, shown?.questions ?? [])
    return {
      text: isPlaced
        ? "The question is open in a pane."
        : "The question's pane couldn't be drawn; answer it in the web UI.",
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
