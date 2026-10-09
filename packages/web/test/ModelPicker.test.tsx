// The model and effort picker (#128): what it offers, what choosing sends, and that it works on a
// phone.

import { afterEach, expect, test } from "bun:test"
import type { ModelSetting } from "../src/session/models.ts"
import { installDom } from "./dom.ts"
import { button, render, settle, step } from "./render.ts"

let cleanup: (() => Promise<void>) | undefined
installDom(() => cleanup?.())
afterEach(async () => {
  await cleanup?.()
  cleanup = undefined
  await settle()
})

const { useState } = await import("react")
const { ModelPicker } = await import("../src/session/ModelPicker.tsx")
const { fakeModels } = await import("../src/hub/fake/script.ts")

/** Resizes happy-dom's window, which media queries follow. */
function setWidth(width: number): void {
  ;(
    window as unknown as { happyDOM: { setViewport(size: { width: number }): void } }
  ).happyDOM.setViewport({ width })
}

/** Renders the picker at `width`, keeping what it is changed to, and records each change. */
async function picker(initial: ModelSetting = {}, width = 1024) {
  setWidth(width)
  const changes: Array<ModelSetting> = []
  function Harness() {
    const [value, setValue] = useState<ModelSetting>(initial)
    return (
      <ModelPicker
        models={fakeModels}
        value={value}
        onChange={(next) => {
          changes.push(next)
          setValue(next)
        }}
      />
    )
  }
  const view = await render(<Harness />)
  cleanup = view.unmount
  return { changes, trigger: view.container.querySelector("button") as HTMLButtonElement }
}

const menu = () => document.querySelector<HTMLElement>('[role="menu"]')
const menus = () => [...document.querySelectorAll<HTMLElement>('[role="menu"]')]
/** The radio rows of the open menus, by their text. */
const radios = () => [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')]
const radio = (start: string) => {
  const found = radios().find((row) => row.textContent?.startsWith(start))
  if (!found) throw new Error(`no "${start}" row in ${radios().map((row) => row.textContent)}`)
  return found
}
const item = (start: string) => {
  const found = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((row) =>
    row.textContent?.startsWith(start),
  )
  if (!found) throw new Error(`no "${start}" item`)
  return found
}
const checked = () =>
  radios()
    .filter((row) => row.getAttribute("aria-checked") === "true")
    .map((row) => row.textContent)

async function open(trigger: HTMLButtonElement): Promise<void> {
  await step(() => trigger.click())
  await settle()
  expect(menu()).not.toBeNull()
}

test("the button names the setting, and the menu lists the Runner's models, or only the default without them", async () => {
  const { trigger } = await picker({ model: "sonnet", effort: "high" })
  expect(trigger.textContent).toBe("Sonnet 5.5 · High")
  expect(trigger.getAttribute("aria-label")).toBe("Model and effort: Sonnet 5.5 · High")

  await open(trigger)
  // The default row and the Runner's five models.
  expect(radios()).toHaveLength(6)
  expect(radio("Default (recommended)").textContent).toContain("Opus 5.5")
  expect(radio("Sonnet 5.5").textContent?.length).toBeGreaterThan("Sonnet 5.5".length)
  expect(checked()).toEqual([expect.stringMatching(/^Sonnet 5\.5/)])
  await cleanup?.()

  // Claude Code's default names its model, with no effort claimed.
  const unset = await picker()
  expect(unset.trigger.textContent).toBe("Opus 5.5")
  await open(unset.trigger)
  expect(checked()).toEqual([expect.stringMatching(/^Default \(recommended\)/)])
  expect(item("Effort").textContent).toContain("Default")
  await cleanup?.()

  // Without the Runner's list, only Claude Code's default is offered.
  setWidth(1024)
  const view = await render(<ModelPicker models={undefined} value={{}} onChange={() => {}} />)
  cleanup = view.unmount
  await open(button("Model and effort: Default model", view.container))
  expect(radios().map((row) => row.textContent)).toEqual([
    "Default (recommended)Claude Code's own default",
  ])
  expect(document.querySelector('[role="menuitem"]')).toBeNull()
})

test("choosing a model sends it, keeping the effort level", async () => {
  const { trigger, changes } = await picker({ effort: "high" })
  await open(trigger)
  await step(() => radio("Sonnet 5.5").click())
  await settle()
  expect(changes).toEqual([{ model: "sonnet", effort: "high" }])
  expect(trigger.textContent).toBe("Sonnet 5.5 · High")

  // The default row sets no model at all: Claude Code's own.
  await open(trigger)
  await step(() => radio("Default (recommended)").click())
  await settle()
  expect(changes.at(-1)).toEqual({ effort: "high" })
})

test("a model that takes no effort level drops it, and its Effort is off", async () => {
  const { trigger, changes } = await picker({ model: "sonnet", effort: "max" })
  await open(trigger)
  await step(() => radio("Haiku 4.5").click())
  await settle()
  expect(changes).toEqual([{ model: "haiku" }])
  await open(trigger)
  const effort = item("Effort")
  expect(effort.textContent).toContain("None")
  expect(effort.getAttribute("aria-disabled")).toBe("true")
})

test("the Effort submenu offers the CLI's levels, named as claude.ai names them", async () => {
  const { trigger, changes } = await picker({ model: "opus" })
  await open(trigger)
  await step(() => item("Effort").click())
  await settle()
  expect(menus()).toHaveLength(2)
  const levels = radios().filter((row) => menus()[1]?.contains(row))
  expect(levels.map((row) => row.textContent)).toEqual([
    "Low",
    "MediumRecommended",
    "High",
    "Extra",
    "Max4× or more usage",
  ])
  await step(() => radio("Extra").click())
  await settle()
  expect(changes).toEqual([{ model: "opus", effort: "xhigh" }])
  expect(trigger.textContent).toBe("Opus 5.5 · Extra")
})

test("on a phone, Effort is a second panel in the menu, with a way back", async () => {
  const { trigger, changes } = await picker({ model: "opus" }, 400)
  await open(trigger)
  await step(() => item("Effort").click())
  await settle()
  // Still the one menu, now showing the levels.
  expect(menus()).toHaveLength(1)
  expect(radios().map((row) => row.textContent)).toContain("High")
  expect(radios().some((row) => row.textContent?.startsWith("Sonnet"))).toBe(false)

  await step(() => item("Back to models").click())
  await settle()
  expect(radios().some((row) => row.textContent?.startsWith("Sonnet"))).toBe(true)

  await step(() => item("Effort").click())
  await settle()
  await step(() => radio("High").click())
  await settle()
  expect(changes).toEqual([{ model: "opus", effort: "high" }])
})
