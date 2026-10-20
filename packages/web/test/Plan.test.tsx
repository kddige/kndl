// What the Plan's marker says in a Turn about a change.
import { expect, test } from "bun:test"
import { installDom } from "./dom.ts"

installDom()
const { planChangeText } = await import("../src/session/Plan.tsx")

const step = (text: string, status: "pending" | "in_progress" | "done" = "pending") => ({
  text,
  status,
})

test("a new Plan says how many steps it has, in the right number", () => {
  expect(planChangeText({ steps: [step("Add the route")] }, undefined)).toBe(
    "Made a Plan of 1 step",
  )
  expect(planChangeText({ steps: [step("A"), step("B")] }, undefined)).toBe(
    "Made a Plan of 2 steps",
  )
})

test("a Plan with no steps left says it was cleared", () => {
  const before = { steps: [step("Add the route", "done")] }
  expect(planChangeText({ steps: [] }, before)).toBe("Cleared the Plan")
  expect(planChangeText({ steps: [] }, undefined)).toBe("Cleared the Plan")
})

test("a change names the steps it finished and started", () => {
  const before = { steps: [step("Add the route", "in_progress"), step("Test it")] }
  const after = { steps: [step("Add the route", "done"), step("Test it", "in_progress")] }
  expect(planChangeText(after, before)).toBe("Finished “Add the route”, started “Test it”")
})
