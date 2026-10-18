import { describe, expect, test } from "bun:test"
import {
  askedAsyncText,
  questionInputSchema,
  questionResultText,
  questionToolDescription,
  questionToolName,
  questionToolSpec,
} from "./Questions.ts"

const ada = { id: "p1", login: "ada", name: "Ada Lovelace" }
const questions = [{ question: "Which?", header: "Pick", options: [], multiSelect: false }]

describe("the question tool", () => {
  test("is named after its plugin in Claude Code, and in the tool list from the first request", () => {
    expect(questionToolName).toBe("mcp__hub-link-commands__ask_user_question")
    expect(questionToolSpec).toMatchObject({ name: "ask_user_question", isDeferred: false })
  })

  test("tells the model what async does, and offers it as an optional flag", () => {
    expect(questionToolDescription).toContain("Set async to true")
    expect(questionToolDescription).toContain("as a new turn if you have finished")
    expect(questionInputSchema.properties.async.type).toBe("boolean")
    expect(questionInputSchema.required).toEqual(["questions"])
    expect(askedAsyncText).toContain("Don't wait or poll")
  })

  test("what an async question's answer says is told apart from a waited one's", () => {
    const closed = { outcome: { _tag: "Dismissed" as const }, by: ada }
    expect(questionResultText(questions, closed)).toContain("dismissed the questions")
    expect(questionResultText(questions, closed)).toContain("wait for them")
    expect(questionResultText(questions, closed, true)).toContain("the questions you asked earlier")
    expect(questionResultText(questions, closed, true)).toContain("Carry on without an answer")
    expect(
      questionResultText(questions, { outcome: { _tag: "Replied", text: "no" }, by: ada }, true),
    ).toBe(
      [
        "Ada Lovelace didn't pick an answer to the questions you asked earlier, and replied instead:",
        "[Ada Lovelace] no",
        "Follow what they said.",
      ].join("\n"),
    )
  })
})
