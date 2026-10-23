// The kndl tools the reasoning model behind live voice has (spike, ADR 0033), as the browser runs
// them: on the Session the call is with, as its Creator, through their web connection, so each can
// do only what they can. Framework-free, so they are tested without a browser.

import type { LiveVoiceToolName, OpenQuestion } from "@kndl/protocol"
import { answerOf, type SessionView } from "./voiceBridge.ts"

/** What the tools act through: the call's Session, and its Creator's commands. */
export interface ToolHost {
  /** The Session now, as the store has it; undefined before it has come. */
  readonly view: () => SessionView | undefined
  /** Sends the agent a prompt, followed to its answer: whether it went. */
  readonly sendToAgent: (prompt: string) => boolean
  /** Replies to the agent's question: whether it went. */
  readonly answer: (question: OpenQuestion, text: string) => boolean
  /** Stops the agent's running Turn: whether it went. */
  readonly stop: () => boolean
}

const clip = (text: string, limit: number) =>
  text.length <= limit ? text : `${text.slice(0, limit - 1)}…`

/** Arguments, as the model wrote them: an object, or none. */
const argumentsOf = (written: string): Record<string, unknown> => {
  try {
    const parsed: unknown = JSON.parse(written)
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

const result = (value: unknown) => JSON.stringify(value)
const failed = (error: string) => JSON.stringify({ error })

/** Runs the tool the reasoning model called: its output, as JSON. */
export function runVoiceTool(name: string, written: string, host: ToolHost): string {
  const args = argumentsOf(written)
  const view = host.view()
  if (view === undefined) return failed("The Session isn't loaded in the browser yet: try again.")
  const { summary, turns } = view
  switch (name as LiveVoiceToolName) {
    case "send_to_agent": {
      const prompt = typeof args["prompt"] === "string" ? args["prompt"].trim() : ""
      if (prompt === "") return failed("Give the agent an instruction.")
      if (!host.sendToAgent(prompt)) return failed("The Session can't take a prompt just now.")
      return result({
        sent: true,
        note:
          summary.currentTurn === null
            ? "The agent is on it. Its answer reaches the conversation when it is done."
            : "The agent is busy: this waits in its queue, then its answer reaches the conversation.",
      })
    }
    case "agent_status": {
      const running = turns.findLast((turn) => turn.end === null)
      const latest = running?.blocks.findLast((block) => block.kind === "tool")
      const queued = (view.queue ?? []).length
      return result({
        state: summary.state,
        working: summary.currentTurn !== null,
        ...(running !== undefined && { workingOn: clip(running.prompt, 300) }),
        ...(latest?.kind === "tool" && {
          latestTool: `${latest.call.tool} ${clip(latest.call.input, 160)}`,
        }),
        ...(summary.openQuestion !== undefined && {
          asks: summary.openQuestion.questions.map((question) => ({
            question: question.question,
            options: question.options.map((option) => option.label),
          })),
        }),
        ...(queued > 0 && { queuedPrompts: queued }),
      })
    }
    case "read_agent_history": {
      const count =
        typeof args["turns"] === "number" ? Math.min(Math.max(Math.floor(args["turns"]), 1), 10) : 3
      return result(
        turns.slice(-count).map((turn) => ({
          asked: clip(turn.prompt, 400),
          ...(turn.end === null
            ? { status: "running" }
            : { answered: clip(answerOf(turn.blocks), 1200) }),
        })),
      )
    }
    case "answer_agent_question": {
      const answer = typeof args["answer"] === "string" ? args["answer"].trim() : ""
      if (answer === "") return failed("Give the answer.")
      const question = summary.openQuestion
      if (question === undefined) return failed("The agent asks no question now.")
      return host.answer(question, answer)
        ? result({ answered: true })
        : failed("The answer couldn't reach the agent just now.")
    }
    case "stop_agent": {
      if (summary.currentTurn === null)
        return result({ stopped: false, note: "The agent is idle." })
      return host.stop() ? result({ stopped: true }) : failed("Couldn't stop the agent just now.")
    }
    default:
      return failed(`There is no tool called ${name}.`)
  }
}
