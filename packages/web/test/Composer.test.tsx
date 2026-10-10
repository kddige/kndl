// Long pastes in the Composer (#279): like Claude Code's terminal, a long paste shows as a
// `[Pasted text #N +X lines]` chip, while the prompt sent keeps the full text.

import { afterEach, expect, test } from "bun:test"
import { installDom } from "./dom.ts"
import { button, dialog, render, settle, step } from "./render.ts"

let cleanup: (() => Promise<void>) | undefined
installDom(() => cleanup?.())
afterEach(async () => {
  await cleanup?.()
  cleanup = undefined
})

// Loaded after installDom() and the StyleX compiler, so components see the DOM and compile.
const { Composer } = await import("../src/session/Composer.tsx")

/** Twelve lines of a stack trace: long enough to become a chip. */
const trace = Array.from({ length: 12 }, (_, i) => `    at frame${i} (app.ts:${i + 1}:1)`).join(
  "\n",
)

async function composer() {
  const sent: string[] = []
  const view = await render(
    <Composer
      onSend={(text) => {
        sent.push(text)
        return true
      }}
      onStop={() => {}}
      running={false}
    />,
  )
  cleanup = view.unmount
  const field = view.container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Prompt"]')
  if (!field) throw new Error("no Prompt field")
  return { sent, field, container: view.container }
}

function typeInto(field: HTMLTextAreaElement, value: string): void {
  // React tracks the value it last saw; the prototype's setter goes around that, as typing does.
  const setValue = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), "value")?.set
  setValue?.call(field, value)
  field.setSelectionRange(value.length, value.length)
  field.dispatchEvent(new Event("input", { bubbles: true }))
}

/** Pastes `text` at the caret, as the browser does unless the page takes the paste. */
function paste(field: HTMLTextAreaElement, text: string): void {
  const clipboardData = new DataTransfer()
  clipboardData.setData("text/plain", text)
  const event = new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData })
  if (!field.dispatchEvent(event)) return
  const start = field.selectionStart
  typeInto(field, field.value.slice(0, start) + text + field.value.slice(field.selectionEnd))
}

test("a long paste shows as a chip in the Composer, and the prompt sent has the full text", async () => {
  const { sent, field, container } = await composer()
  await step(() => typeInto(field, "Why does this fail? "))
  await step(() => paste(field, trace))

  expect(field.value).toBe("Why does this fail? [Pasted text #1 +11 lines]")
  expect(button("[Pasted text #1 +11 lines]", container)).toBeDefined()

  await step(() => button("Send prompt").click())
  expect(sent).toEqual([`Why does this fail? ${trace}`])
  expect(field.value).toBe("")
})

test("a paste of three lines, or of 800 characters, goes in as it is", async () => {
  const { sent, field } = await composer()
  const threeLines = "one\ntwo\nthree"
  const long = "x".repeat(800)
  await step(() => paste(field, threeLines))
  await step(() => paste(field, long))

  expect(field.value).toBe(threeLines + long)
  await step(() => button("Send prompt").click())
  expect(sent).toEqual([threeLines + long])
})

test("a long paste on one line shows without a line count", async () => {
  const { sent, field } = await composer()
  const minified = "y".repeat(801)
  await step(() => paste(field, minified))

  expect(field.value).toBe("[Pasted text #1]")
  await step(() => button("Send prompt").click())
  expect(sent).toEqual([minified])
})

test("a paste's chip shows its text, and removing it takes it out of the prompt", async () => {
  const { sent, field, container } = await composer()
  await step(() => paste(field, trace))
  await step(() => typeInto(field, `${field.value} and `))
  await step(() => paste(field, `${trace}\nmore`))
  expect(field.value).toBe("[Pasted text #1 +11 lines] and [Pasted text #2 +12 lines]")

  await step(() => button("[Pasted text #2 +12 lines]", container).click())
  await settle()
  expect(dialog()?.textContent).toContain("at frame11 (app.ts:12:1)\nmore")

  await step(() => button("Remove [Pasted text #1 +11 lines]", container).click())
  expect(field.value).toBe(" and [Pasted text #2 +12 lines]")
  expect(container.querySelector('[aria-label="Pasted texts"]')?.textContent).not.toContain("#1")

  await step(() => button("Send prompt").click())
  expect(sent).toEqual([` and ${trace}\nmore`])
})

test("deleting a paste's reference from the field takes its chip away", async () => {
  const { field, container } = await composer()
  await step(() => paste(field, trace))
  await step(() => typeInto(field, "[Pasted text #1 +11 l"))

  expect(container.querySelector('[aria-label="Pasted texts"]')).toBeNull()
})

test("pastes are numbered on from the last prompt's", async () => {
  const { sent, field } = await composer()
  await step(() => paste(field, trace))
  await step(() => button("Send prompt").click())
  await step(() => paste(field, trace))

  expect(field.value).toBe("[Pasted text #2 +11 lines]")
  await step(() => button("Send prompt").click())
  expect(sent).toEqual([trace, trace])
})
