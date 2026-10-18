// The model and thinking level pickers (#128): what they offer, what choosing sends, and that a
// model without thinking levels has no thinking picker.

import { afterEach, expect, test } from "bun:test"
import type { RunnerModels } from "@kndl/protocol"
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

/** Renders the picker, keeping what it is changed to, and records each change. */
async function picker(initial: ModelSetting = {}, models: RunnerModels = fakeModels) {
  const changes: Array<ModelSetting> = []
  function Harness() {
    const [value, setValue] = useState<ModelSetting>(initial)
    return (
      <ModelPicker
        models={models}
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
  return { changes, container: view.container }
}

/** The picker's buttons, by the start of their label: `Model: ` and `Thinking: `. */
const trigger = (within: ParentNode, kind: "Model" | "Thinking") =>
  [...within.querySelectorAll("button")].find((el) =>
    el.getAttribute("aria-label")?.startsWith(`${kind}: `),
  ) ?? null

/** The radio rows of the open menu, by their text. */
const radios = () => [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')]
const radio = (start: string) => {
  const found = radios().find((row) => row.textContent?.startsWith(start))
  if (!found) throw new Error(`no "${start}" row in ${radios().map((row) => row.textContent)}`)
  return found
}
const checked = () =>
  radios()
    .filter((row) => row.getAttribute("aria-checked") === "true")
    .map((row) => row.textContent)

/** The open thinking popover's slider input, which takes the keys. */
const slider = () => document.querySelector<HTMLInputElement>('[role="dialog"] input[type="range"]')

async function click(el: HTMLElement | null): Promise<void> {
  if (!el) throw new Error("nothing to click")
  await step(() => el.click())
  await settle()
}

async function press(key: string): Promise<void> {
  const input = slider()
  if (!input) throw new Error("no slider")
  await step(() => {
    input.focus()
    input.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }))
  })
  await settle()
}

test("the model button names the model, and its menu lists names only, or only the default without them", async () => {
  const { container } = await picker({ model: "sonnet", thinkingLevel: "high" })
  expect(trigger(container, "Model")?.textContent).toBe("Sonnet 5.5")
  expect(trigger(container, "Model")?.getAttribute("aria-label")).toBe("Model: Sonnet 5.5")

  await click(trigger(container, "Model"))
  // The default row and the Runner's five models, with no lines under them.
  expect(radios().map((row) => row.textContent)).toEqual([
    "Default · Opus 5.5",
    "Opus 5.5",
    "Fable 5.1",
    "Sonnet 5.5",
    "Haiku 4.5",
    "Opus 5.5 (1M context)",
  ])
  expect(checked()).toEqual(["Sonnet 5.5"])
  await cleanup?.()

  // Claude Code's default names its model; the thinking button says none is set.
  const unset = await picker()
  expect(trigger(unset.container, "Model")?.textContent).toBe("Opus 5.5")
  expect(trigger(unset.container, "Thinking")?.textContent).toBe("Thinking")
  expect(trigger(unset.container, "Thinking")?.getAttribute("aria-label")).toBe("Thinking: Default")
  await click(trigger(unset.container, "Model"))
  expect(checked()).toEqual(["Default · Opus 5.5"])
  await cleanup?.()

  // Without the Runner's list, only Claude Code's default is offered, and no thinking level.
  const view = await render(<ModelPicker models={undefined} value={{}} onChange={() => {}} />)
  cleanup = view.unmount
  expect(trigger(view.container, "Thinking")).toBeNull()
  await click(button("Model: Default model", view.container))
  expect(radios().map((row) => row.textContent)).toEqual(["Default"])
})

test("choosing a model sends it, keeping the thinking level", async () => {
  const { container, changes } = await picker({ thinkingLevel: "high" })
  await click(trigger(container, "Model"))
  await click(radio("Sonnet 5.5"))
  expect(changes).toEqual([{ model: "sonnet", thinkingLevel: "high" }])
  expect(trigger(container, "Model")?.textContent).toBe("Sonnet 5.5")
  expect(trigger(container, "Thinking")?.textContent).toBe("High")

  // The default row sets no model at all: Claude Code's own.
  await click(trigger(container, "Model"))
  await click(radio("Default"))
  expect(changes.at(-1)).toEqual({ thinkingLevel: "high" })
})

test("a model that takes no thinking level drops it, and has no thinking button", async () => {
  const { container, changes } = await picker({ model: "sonnet", thinkingLevel: "max" })
  await click(trigger(container, "Model"))
  await click(radio("Haiku 4.5"))
  expect(changes).toEqual([{ model: "haiku" }])
  expect(trigger(container, "Thinking")).toBeNull()
})

/** The open thinking popover. */
const thinkingPopover = () => document.querySelector<HTMLElement>('[role="dialog"]')

test("the menu's rows are a group named Model", async () => {
  const { container } = await picker()
  await click(trigger(container, "Model"))
  const group = radio("Opus 5.5").closest('[role="group"]')
  const labelledBy = group?.getAttribute("aria-labelledby") ?? ""
  expect(document.getElementById(labelledBy)?.textContent).toBe("Model")
})

test("with no level set, the thinking slider says the Harness picks, and is on no level", async () => {
  const { container, changes } = await picker({ model: "opus" })
  await click(trigger(container, "Thinking"))
  const popover = thinkingPopover()
  // Named Thinking, with the level as its content.
  expect(popover?.getAttribute("aria-label")).toBe("Thinking")
  expect(popover?.hasAttribute("aria-labelledby")).toBe(false)
  expect(popover?.textContent).toContain("Default")
  expect(popover?.textContent).toContain("The Harness picks the level.")
  expect(popover?.textContent).not.toContain("Medium")
  expect(slider()?.getAttribute("aria-valuetext")).toBe("Default")
  // Nothing to go back to while none is set.
  expect(popover?.textContent).not.toContain("Use the default")

  // The first key goes to an end, so every level, the first included, is a step and Enter away.
  await press("ArrowRight")
  expect(slider()?.getAttribute("aria-valuetext")).toBe("Low")
  await press("Enter")
  expect(changes).toEqual([{ model: "opus", thinkingLevel: "low" }])
})

test("the slider names every level a Harness may take, Off and Minimal included", async () => {
  const { container, changes } = await picker(
    { model: "opus" },
    {
      ...fakeModels,
      thinkingLevels: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
    },
  )
  await click(trigger(container, "Thinking"))
  const names = []
  for (const _ of [1, 2, 3, 4, 5, 6, 7]) {
    await press("ArrowRight")
    names.push(slider()?.getAttribute("aria-valuetext"))
  }
  expect(names).toEqual(["Off", "Minimal", "Low", "Medium", "High", "Extra", "Max"])
  await press("Home")
  await press("Enter")
  expect(changes).toEqual([{ model: "opus", thinkingLevel: "off" }])
  expect(trigger(container, "Thinking")?.getAttribute("aria-label")).toBe("Thinking: Off")
})

test("arrow keys only move the thinking slider: Enter sets the level, once", async () => {
  const { container, changes } = await picker({ model: "opus", thinkingLevel: "low" })
  await click(trigger(container, "Thinking"))
  for (const _ of [1, 2, 3, 4]) await press("ArrowRight")
  // Low to Max, shown but not set.
  expect(changes).toEqual([])
  expect(slider()?.getAttribute("aria-valuetext")).toBe("Max")
  expect(thinkingPopover()?.textContent).toContain("4× or more usage")
  expect(trigger(container, "Thinking")?.textContent).toBe("Low")

  await press("Enter")
  expect(changes).toEqual([{ model: "opus", thinkingLevel: "max" }])
  expect(trigger(container, "Thinking")?.textContent).toBe("Max")
  // Enter again on the level set sends nothing more.
  await press("Enter")
  expect(changes).toHaveLength(1)
})

test("closing the thinking slider on another level sets it, unless by Escape; on the same one, nothing", async () => {
  const { container, changes } = await picker({ model: "opus", thinkingLevel: "high" })
  await click(trigger(container, "Thinking"))
  await press("ArrowLeft")
  await press("ArrowRight")
  await click(trigger(container, "Thinking"))
  expect(thinkingPopover()).toBeNull()
  expect(changes).toEqual([])

  // Escape takes back what was moved, and sends nothing.
  await click(trigger(container, "Thinking"))
  await press("ArrowLeft")
  expect(slider()?.getAttribute("aria-valuetext")).toBe("Medium")
  await press("Escape")
  expect(thinkingPopover()).toBeNull()
  expect(changes).toEqual([])
  await click(trigger(container, "Thinking"))
  expect(slider()?.getAttribute("aria-valuetext")).toBe("High")
  await click(trigger(container, "Thinking"))
  expect(changes).toEqual([])

  // A click outside sets it.
  await click(trigger(container, "Thinking"))
  await press("ArrowLeft")
  await press("ArrowLeft")
  await step(() => {
    document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }))
    document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }))
    document.body.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }))
    document.body.dispatchEvent(new MouseEvent("click", { bubbles: true }))
  })
  await settle()
  expect(thinkingPopover()).toBeNull()
  expect(changes).toEqual([{ model: "opus", thinkingLevel: "low" }])
  expect(trigger(container, "Thinking")?.getAttribute("aria-label")).toBe("Thinking: Low")

  // As does pressing its button again.
  await click(trigger(container, "Thinking"))
  await press("End")
  await click(trigger(container, "Thinking"))
  expect(changes.at(-1)).toEqual({ model: "opus", thinkingLevel: "max" })
})

test("Use the default unsets the level", async () => {
  const { container, changes } = await picker({ model: "opus", thinkingLevel: "high" })
  await click(trigger(container, "Thinking"))
  await click(button("Use the default", document))
  expect(changes).toEqual([{ model: "opus" }])
  expect(trigger(container, "Thinking")?.textContent).toBe("Thinking")
})
