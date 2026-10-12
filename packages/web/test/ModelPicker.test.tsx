// The model and effort pickers (#128): what they offer, what choosing sends, and that a model
// without effort levels has no effort picker.

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

/** Renders the picker, keeping what it is changed to, and records each change. */
async function picker(initial: ModelSetting = {}) {
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
  return { changes, container: view.container }
}

/** The picker's buttons, by the start of their label: `Model: ` and `Effort: `. */
const trigger = (within: ParentNode, kind: "Model" | "Effort") =>
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

/** The open effort popover's slider input, which takes the keys. */
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
  const { container } = await picker({ model: "sonnet", effort: "high" })
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

  // Claude Code's default names its model; the effort button says none is set.
  const unset = await picker()
  expect(trigger(unset.container, "Model")?.textContent).toBe("Opus 5.5")
  expect(trigger(unset.container, "Effort")?.textContent).toBe("Effort")
  expect(trigger(unset.container, "Effort")?.getAttribute("aria-label")).toBe("Effort: Default")
  await click(trigger(unset.container, "Model"))
  expect(checked()).toEqual(["Default · Opus 5.5"])
  await cleanup?.()

  // Without the Runner's list, only Claude Code's default is offered, and no effort.
  const view = await render(<ModelPicker models={undefined} value={{}} onChange={() => {}} />)
  cleanup = view.unmount
  expect(trigger(view.container, "Effort")).toBeNull()
  await click(button("Model: Default model", view.container))
  expect(radios().map((row) => row.textContent)).toEqual(["Default"])
})

test("choosing a model sends it, keeping the effort level", async () => {
  const { container, changes } = await picker({ effort: "high" })
  await click(trigger(container, "Model"))
  await click(radio("Sonnet 5.5"))
  expect(changes).toEqual([{ model: "sonnet", effort: "high" }])
  expect(trigger(container, "Model")?.textContent).toBe("Sonnet 5.5")
  expect(trigger(container, "Effort")?.textContent).toBe("High")

  // The default row sets no model at all: Claude Code's own.
  await click(trigger(container, "Model"))
  await click(radio("Default"))
  expect(changes.at(-1)).toEqual({ effort: "high" })
})

test("a model that takes no effort level drops it, and has no effort button", async () => {
  const { container, changes } = await picker({ model: "sonnet", effort: "max" })
  await click(trigger(container, "Model"))
  await click(radio("Haiku 4.5"))
  expect(changes).toEqual([{ model: "haiku" }])
  expect(trigger(container, "Effort")).toBeNull()
})

test("the effort slider steps through the CLI's levels, named as claude.ai names them", async () => {
  const { container, changes } = await picker({ model: "opus" })
  await click(trigger(container, "Effort"))
  const popover = document.querySelector<HTMLElement>('[role="dialog"]')
  // Unset, it rests on Claude Code's default, Medium.
  expect(popover?.textContent).toContain("Medium")
  expect(popover?.textContent).toContain("Claude Code's default")
  expect(slider()?.getAttribute("aria-valuetext")).toBe("Medium")
  // Nothing to go back to while none is set.
  expect(popover?.textContent).not.toContain("Use the default")

  await press("ArrowRight")
  expect(changes).toEqual([{ model: "opus", effort: "high" }])
  expect(trigger(container, "Effort")?.textContent).toBe("High")
  expect(slider()?.getAttribute("aria-valuetext")).toBe("High")

  await press("End")
  expect(changes.at(-1)).toEqual({ model: "opus", effort: "max" })
  expect(popover?.textContent).toContain("4× or more usage")

  await click(button("Use the default", document))
  expect(changes.at(-1)).toEqual({ model: "opus" })
  expect(trigger(container, "Effort")?.textContent).toBe("Effort")
})
