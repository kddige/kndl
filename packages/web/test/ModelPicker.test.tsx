// The model and thinking level pickers (#128): what they offer, what choosing sends, and that a
// model without thinking levels has no thinking picker. One list for every Session and thread:
// its Creator's Models, by Provider, Claude's under Anthropic (docs/design/durable-harness.md).

import { afterEach, expect, test } from "bun:test"
import type { ProviderModel } from "@kndl/protocol"
import type { ModelPickerProps } from "../src/session/ModelPicker.tsx"
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
const { claudeModels, connectable, providerModels } = await import("../src/hub/fake/providers.ts")

/** Claude's Models and OpenAI's, as the Hub lists them for a Creator with both. */
const models: ReadonlyArray<ProviderModel> = [...claudeModels, ...providerModels("openai")]

const opus = "anthropic/claude-opus-5-5"

/** Renders the picker, keeping what it is changed to, and records each change. */
async function picker(initial: ModelSetting = {}, props: Partial<ModelPickerProps> = {}) {
  const changes: Array<ModelSetting> = []
  function Picker() {
    const [value, setValue] = useState<ModelSetting>(initial)
    return (
      <ModelPicker
        models={models}
        connectable={connectable}
        {...props}
        value={value}
        onChange={(next) => {
          changes.push(next)
          setValue(next)
        }}
      />
    )
  }
  const view = await render(<Picker />)
  cleanup = view.unmount
  return { changes, container: view.container }
}

/** The picker's buttons, by the start of their label: `Model: ` and `Thinking: `. */
const trigger = (within: ParentNode, kind: "Model" | "Thinking") =>
  [...within.querySelectorAll("button")].find((el) =>
    el.getAttribute("aria-label")?.startsWith(`${kind}: `),
  ) ?? null

/** The open list's rows, by their text. */
const options = () => [...document.querySelectorAll<HTMLElement>('[role="option"]')]
const option = (label: string) => {
  const found = options().find((row) => row.textContent === label)
  if (!found) throw new Error(`no "${label}" row in ${options().map((row) => row.textContent)}`)
  return found
}
const selected = () =>
  options()
    .filter((row) => row.getAttribute("aria-selected") === "true")
    .map((row) => row.textContent)

/** The open list's groups: each one's name and its rows. */
const groups = () =>
  [...document.querySelectorAll<HTMLElement>('[role="listbox"] [role="group"]')].map((group) => [
    document.getElementById(group.getAttribute("aria-labelledby") ?? "")?.textContent,
    [...group.querySelectorAll('[role="option"]')].map((row) => row.textContent),
  ])

/** The open list's search field. */
const search = () => document.querySelector<HTMLInputElement>('input[aria-label="Search Models"]')

async function typeSearch(text: string): Promise<void> {
  const field = search()
  if (!field) throw new Error("no search field")
  await step(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(field, text)
    field.dispatchEvent(new Event("input", { bubbles: true }))
  })
  await settle()
}

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

/** The open thinking popover. */
const thinkingPopover = () => document.querySelector<HTMLElement>('[role="dialog"]')

test("the model button names the model, and the list opens with a search", async () => {
  const { container } = await picker({ model: opus })
  expect(trigger(container, "Model")?.textContent).toBe("Claude Opus 5.5")
  expect(trigger(container, "Model")?.getAttribute("title")).toBe("Claude Opus 5.5")
  await click(trigger(container, "Model"))
  expect(document.querySelector('[role="listbox"]')).not.toBeNull()
  expect(search()?.getAttribute("aria-label")).toBe("Search Models")
})

test("without a model, the button names the Hub's pick: Claude's first", async () => {
  const { container } = await picker({})
  expect(trigger(container, "Model")?.textContent).toBe("Claude Opus 5.5")
})

test("with no level set, the thinking slider says the Model thinks as it usually does, and is on no level", async () => {
  const { container, changes } = await picker({ model: opus })
  await click(trigger(container, "Thinking"))
  const popover = thinkingPopover()
  // Named Thinking, with the level as its content.
  expect(popover?.getAttribute("aria-label")).toBe("Thinking")
  expect(popover?.hasAttribute("aria-labelledby")).toBe(false)
  expect(popover?.textContent).toContain("Default")
  expect(popover?.textContent).toContain("The Model's usual level.")
  expect(popover?.textContent).not.toContain("Medium")
  expect(slider()?.getAttribute("aria-valuetext")).toBe("Default")
  // Nothing to go back to while none is set.
  expect(popover?.textContent).not.toContain("Use the default")

  // The first key goes to an end, so every level, the first included, is a step and Enter away.
  await press("ArrowRight")
  expect(slider()?.getAttribute("aria-valuetext")).toBe("Low")
  await press("Enter")
  expect(changes).toEqual([{ model: opus, thinkingLevel: "low" }])
})

test("the slider names every level a Model may take, Off and Minimal included", async () => {
  const every: ProviderModel = {
    ...(claudeModels[0] as ProviderModel),
    thinkingLevels: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
  }
  const { container, changes } = await picker({ model: opus }, { models: [every] })
  await click(trigger(container, "Thinking"))
  const names = []
  for (const _ of [1, 2, 3, 4, 5, 6, 7]) {
    await press("ArrowRight")
    names.push(slider()?.getAttribute("aria-valuetext"))
  }
  expect(names).toEqual(["Off", "Minimal", "Low", "Medium", "High", "Extra", "Max"])
  await press("Home")
  await press("Enter")
  expect(changes).toEqual([{ model: opus, thinkingLevel: "off" }])
  expect(trigger(container, "Thinking")?.getAttribute("aria-label")).toBe("Thinking: Off")
})

test("arrow keys only move the thinking slider: Enter sets the level, once", async () => {
  const { container, changes } = await picker({ model: opus, thinkingLevel: "low" })
  await click(trigger(container, "Thinking"))
  for (const _ of [1, 2, 3, 4]) await press("ArrowRight")
  // Low to Max, shown but not set.
  expect(changes).toEqual([])
  expect(slider()?.getAttribute("aria-valuetext")).toBe("Max")
  expect(thinkingPopover()?.textContent).toContain("4× or more usage")
  expect(trigger(container, "Thinking")?.textContent).toBe("Low")

  await press("Enter")
  expect(changes).toEqual([{ model: opus, thinkingLevel: "max" }])
  expect(trigger(container, "Thinking")?.textContent).toBe("Max")
  // Enter again on the level set sends nothing more.
  await press("Enter")
  expect(changes).toHaveLength(1)
})

test("closing the thinking slider on another level sets it, unless by Escape; on the same one, nothing", async () => {
  const { container, changes } = await picker({ model: opus, thinkingLevel: "high" })
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
  expect(changes).toEqual([{ model: opus, thinkingLevel: "low" }])
  expect(trigger(container, "Thinking")?.getAttribute("aria-label")).toBe("Thinking: Low")

  // As does pressing its button again.
  await click(trigger(container, "Thinking"))
  await press("End")
  await click(trigger(container, "Thinking"))
  expect(changes.at(-1)).toEqual({ model: opus, thinkingLevel: "max" })
})

test("Use the default unsets the level", async () => {
  const { container, changes } = await picker({ model: opus, thinkingLevel: "high" })
  await click(trigger(container, "Thinking"))
  await click(button("Use the default", document))
  expect(changes).toEqual([{ model: opus }])
  expect(trigger(container, "Thinking")?.textContent).toBe("Thinking")
})

test("the picker lists the Session's Models by Provider, Claude's under Anthropic, and sends the one chosen as provider/id", async () => {
  const { container, changes } = await picker({
    model: "anthropic/claude-sonnet-5-5",
    thinkingLevel: "high",
  })
  expect(trigger(container, "Model")?.textContent).toBe("Claude Sonnet 5.5")
  expect(trigger(container, "Thinking")?.textContent).toBe("High")

  await click(trigger(container, "Model"))
  expect(groups()).toEqual([
    ["Anthropic", ["Claude Opus 5.5", "Claude Sonnet 5.5", "Claude Haiku 4.5"]],
    ["OpenAI", ["GPT-6-Sol", "GPT-6-Sol mini", "GPT-4.1"]],
  ])
  // A Session always runs a Model of its own: there is no default row.
  expect(options().some((row) => row.textContent?.startsWith("Default"))).toBe(false)
  expect(selected()).toEqual(["Claude Sonnet 5.5"])

  await click(option("GPT-6-Sol"))
  expect(changes).toEqual([{ model: "openai/gpt-6-sol", thinkingLevel: "high" }])
  expect(trigger(container, "Model")?.textContent).toBe("GPT-6-Sol")
})

test("the thinking slider has the Model's own levels, and a Model without drops the level", async () => {
  const { container, changes } = await picker({ model: "openai/gpt-6-sol" })
  await click(trigger(container, "Thinking"))
  const names = []
  for (const _ of [1, 2, 3, 4, 5]) {
    await press("ArrowRight")
    names.push(slider()?.getAttribute("aria-valuetext"))
  }
  expect(names).toEqual(["Minimal", "Low", "Medium", "High", "Extra"])
  await press("Enter")
  expect(changes).toEqual([{ model: "openai/gpt-6-sol", thinkingLevel: "xhigh" }])

  // GPT-6-Sol mini has no Extra: the level goes.
  await click(trigger(container, "Model"))
  await click(option("GPT-6-Sol mini"))
  expect(changes.at(-1)).toEqual({ model: "openai/gpt-6-sol-mini" })
  // GPT-4.1 doesn't think: no thinking button.
  await click(trigger(container, "Model"))
  await click(option("GPT-4.1"))
  expect(trigger(container, "Thinking")).toBeNull()
})

test("the picker opens with a search, which narrows its Models by every word, and the Provider", async () => {
  const { container, changes } = await picker({ model: "openai/gpt-6-sol" })
  await click(trigger(container, "Model"))
  expect(search()).not.toBeNull()

  // Each word typed is in the Model's name, its id or its Provider's name.
  await typeSearch("sol mini")
  expect(groups()).toEqual([["OpenAI", ["GPT-6-Sol mini"]]])
  await typeSearch("anthropic haiku")
  expect(groups()).toEqual([["Anthropic", ["Claude Haiku 4.5"]]])
  await typeSearch("gpt-4.1")
  expect(groups()).toEqual([["OpenAI", ["GPT-4.1"]]])

  // Nothing matching says so.
  await typeSearch("llama")
  expect(groups()).toEqual([])
  expect(document.body.textContent).toContain('No Models match "llama".')

  // Picking from what's left sends it; opened again, the whole list is back.
  await typeSearch("haiku")
  await click(option("Claude Haiku 4.5"))
  expect(changes).toEqual([{ model: "anthropic/claude-haiku-4-5" }])
  await click(trigger(container, "Model"))
  expect(search()?.value).toBe("")
  expect(options()).toHaveLength(6)
  expect(selected()).toEqual(["Claude Haiku 4.5"])
})

test("the picker says so when there are no Models, and while they load", async () => {
  const changes: Array<ModelSetting> = []
  const view = await render(
    <ModelPicker models={[]} value={{}} onChange={(next) => changes.push(next)} />,
  )
  cleanup = view.unmount
  await click(trigger(view.container, "Model"))
  expect(search()).toBeNull()
  expect(document.body.textContent).toContain(
    "No Models yet. Connect a Provider on your Account page.",
  )
  await cleanup?.()

  const loading = await render(<ModelPicker models={undefined} value={{}} onChange={() => {}} />)
  cleanup = loading.unmount
  await click(trigger(loading.container, "Model"))
  expect(document.body.textContent).toContain("Loading the Models…")
})

test("a thread's picker follows the Session's model until another is picked, and back", async () => {
  const { container, changes } = await picker(
    {},
    {
      inherit: { label: "Same as the Session · Claude Sonnet 5.5", name: "Claude Sonnet 5.5" },
      footer: "Runs on Alice's accounts.",
    },
  )
  expect(trigger(container, "Model")?.textContent).toBe("Claude Sonnet 5.5")
  // Following the Session, it has no level of its own.
  expect(trigger(container, "Thinking")).toBeNull()
  await click(trigger(container, "Model"))
  expect(groups()[0]).toEqual(["The Session's", ["Same as the Session · Claude Sonnet 5.5"]])
  expect(selected()).toEqual(["Same as the Session · Claude Sonnet 5.5"])
  expect(document.body.textContent).toContain("Runs on Alice's accounts.")

  await click(option("GPT-6-Sol mini"))
  expect(changes).toEqual([{ model: "openai/gpt-6-sol-mini" }])
  expect(trigger(container, "Model")?.textContent).toBe("GPT-6-Sol mini")

  await click(trigger(container, "Model"))
  await click(option("Same as the Session · Claude Sonnet 5.5"))
  expect(changes.at(-1)).toEqual({})
})
