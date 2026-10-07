import { describe, expect, test } from "bun:test"
import { joinAnswers, type Participant, type Question, type QuestionPick } from "@kndl/protocol"
import {
  draftAnswer,
  draftAnswers,
  emptyDraft,
  othersPicks,
  pickOption,
  splitAnswer,
} from "../src/session/question.ts"

const single: Question = {
  question: "Which library?",
  header: "Library",
  multiSelect: false,
  options: [{ label: "date-fns" }, { label: "Luxon" }],
}
const multi: Question = {
  question: "Which views?",
  header: "Views",
  multiSelect: true,
  options: [{ label: "Sessions list" }, { label: "Transcript" }, { label: 'The "Runners", page' }],
}

const alice = { id: "p-alice", login: "alice", name: "Alice Kim" } as Participant
const bob = { id: "p-bob", login: "bob", name: "Bob Lee" } as Participant

describe("an answer, as Claude Code's dialog submits it (#193)", () => {
  test("one option; or what was typed under Other instead of it", () => {
    expect(draftAnswer(single, emptyDraft)).toBe("")
    expect(draftAnswer(single, pickOption(single, emptyDraft, "Luxon"))).toBe("Luxon")
    expect(draftAnswer(single, { picked: ["Luxon"], other: " Day.js " })).toBe("Day.js")
    // Another option replaces the one before.
    const twice = pickOption(single, pickOption(single, emptyDraft, "Luxon"), "date-fns")
    expect(twice.picked).toEqual(["date-fns"])
  })

  test("several options toggle, joined with \", \" in the question's order, Other's text last", () => {
    let draft = pickOption(multi, emptyDraft, "Transcript")
    draft = pickOption(multi, draft, "Sessions list")
    expect(draftAnswer(multi, draft)).toBe("Sessions list, Transcript")
    draft = pickOption(multi, draft, "Transcript")
    expect(draftAnswer(multi, { ...draft, other: "Runners" })).toBe("Sessions list, Runners")
  })

  test("questions with no answer are left out, as skipped", () => {
    expect(
      draftAnswers([single, multi], { [single.question]: { picked: ["Luxon"], other: "" } }),
    ).toEqual({ [single.question]: "Luxon" })
    expect(draftAnswers([single, multi], {})).toEqual({})
  })
})

describe("splitAnswer", () => {
  test("splits what joinAnswers joined, labels with commas or quotes included", () => {
    const labels = ["Sessions list", 'The "Runners", page', "a, b"]
    expect(splitAnswer(joinAnswers(labels))).toEqual(labels)
    expect(splitAnswer("Luxon")).toEqual(["Luxon"])
    expect(splitAnswer("")).toEqual([])
    // A quote that isn't JSON is read as it is.
    expect(splitAnswer('"half, open')).toEqual(['"half', "open"])
  })
})

describe("othersPicks", () => {
  test("the others' picks for one question, by option, and what they typed instead", () => {
    const picks: ReadonlyArray<QuestionPick> = [
      { participant: alice, question: multi.question, answer: "Transcript" },
      { participant: bob, question: multi.question, answer: "Transcript, Runners page" },
      { participant: bob, question: single.question, answer: "Luxon" },
    ]
    const others = othersPicks(picks, multi, alice)
    expect(others.byOption.get("Transcript")?.map((person) => person.name)).toEqual(["Bob Lee"])
    expect(others.byOption.get("Sessions list")).toBeUndefined()
    expect(others.typed).toEqual([{ participant: bob, text: "Runners page" }])
    // A single-choice answer is never split.
    const typed = [{ participant: bob, question: single.question, answer: "Luxon, or date-fns" }]
    expect(othersPicks(typed, single, alice).typed[0]?.text).toBe("Luxon, or date-fns")
  })
})
