// Images pasted into the Composer (#276): each is uploaded at once, as a chip with its progress
// and a remove button, and the prompt is sent with the ids of those uploaded. What Claude can't
// read is refused there, with a reason.

import { afterEach, expect, test } from "bun:test"
import type { AttachmentId } from "@kndl/protocol"
import { installDom } from "./dom.ts"
import { button, render, step } from "./render.ts"

let cleanup: (() => Promise<void>) | undefined
installDom(() => cleanup?.())
afterEach(async () => {
  await cleanup?.()
  cleanup = undefined
})

// Loaded after installDom() and the StyleX compiler, so components see the DOM and compile.
const { Composer } = await import("../src/session/Composer.tsx")
const { MaxImageBytes } = await import("@kndl/protocol")

/** An upload the test finishes, or fails, when it likes. */
interface Upload {
  readonly file: File
  readonly progress: (sent: number) => void
  readonly signal: AbortSignal
  readonly finish: (id: string) => Promise<void>
  readonly fail: (reason: string) => Promise<void>
}

async function composer() {
  const sent: Array<{ text: string; attachments: ReadonlyArray<string> }> = []
  const uploads: Array<Upload> = []
  const view = await render(
    <Composer
      onSend={(text, attachments) => {
        sent.push({ text, attachments })
        return true
      }}
      onStop={() => {}}
      running={false}
      attach={(file, { onProgress, signal }) =>
        new Promise<AttachmentId>((resolve, reject) => {
          uploads.push({
            file,
            progress: onProgress,
            signal,
            finish: (id) => step(() => resolve(id as AttachmentId)),
            fail: (reason) => step(() => reject(new Error(reason))),
          })
        })
      }
    />,
  )
  cleanup = view.unmount
  const field = view.container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Prompt"]')
  if (!field) throw new Error("no Prompt field")
  const chips = () =>
    [...view.container.querySelectorAll('[aria-label="Attachments"] li')].map(
      (chip) => chip.textContent ?? "",
    )
  const said = () => view.container.querySelector('[aria-label="Attachments refused"]')?.textContent
  return { sent, uploads, field, chips, said, container: view.container }
}

const image = (name: string, type = "image/png", size = 1_000) =>
  new File([new Uint8Array(size)], name, { type })

/** Pastes `files`, and `text` with them, as a screenshot or a copied image is pasted. */
async function paste(field: HTMLTextAreaElement, files: ReadonlyArray<File>, text = "") {
  const clipboardData = new DataTransfer()
  for (const file of files) clipboardData.items.add(file)
  if (text !== "") clipboardData.setData("text/plain", text)
  await step(() =>
    field.dispatchEvent(
      new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData }),
    ),
  )
}

function typeInto(field: HTMLTextAreaElement, value: string): void {
  const setValue = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), "value")?.set
  setValue?.call(field, value)
  field.dispatchEvent(new Event("input", { bubbles: true }))
}

test("a pasted image uploads as a chip, and the prompt waits for it, then carries it", async () => {
  const { sent, uploads, field, chips } = await composer()
  await step(() => typeInto(field, "What broke?"))
  await paste(field, [image("shot.png", "image/png", 2_000)])

  expect(uploads.map((upload) => upload.file.name)).toEqual(["shot.png"])
  await step(() => uploads[0]?.progress(500))
  expect(chips()).toEqual([expect.stringContaining("shot.png")])
  expect(chips()[0]).toContain("25%")
  expect(button("Send prompt").disabled).toBe(true)

  await uploads[0]?.finish("att-1")
  expect(chips()[0]).not.toContain("%")
  await step(() => button("Send prompt").click())
  expect(sent).toEqual([{ text: "What broke?", attachments: ["att-1"] }])
  expect(chips()).toEqual([])
})

test("an image alone is a prompt", async () => {
  const { sent, uploads, field } = await composer()
  await paste(field, [image("one.png"), image("two.jpg", "image/jpeg")])
  await uploads[0]?.finish("att-1")
  await uploads[1]?.finish("att-2")

  await step(() => button("Send prompt").click())
  expect(sent).toEqual([{ text: "", attachments: ["att-1", "att-2"] }])
})

test("a removed image is left out of the prompt, and its upload given up", async () => {
  const { sent, uploads, field, chips, container } = await composer()
  await paste(field, [image("keep.png"), image("drop.png")])
  await step(() => button("Remove drop.png", container).click())

  expect(uploads[1]?.signal.aborted).toBe(true)
  expect(chips()).toEqual([expect.stringContaining("keep.png")])
  await uploads[0]?.finish("att-1")
  await step(() => button("Send prompt").click())
  expect(sent).toEqual([{ text: "", attachments: ["att-1"] }])
})

test("what Claude can't read, over 5 MB or past 20 files, is refused with a reason", async () => {
  const { uploads, field, said } = await composer()
  await paste(field, [
    image("notes.pdf", "application/pdf"),
    image("huge.png", "image/png", MaxImageBytes + 1),
  ])

  expect(uploads).toEqual([])
  expect(said()).toContain("notes.pdf")
  expect(said()).toContain("JPEG, PNG, GIF or WebP")
  expect(said()).toContain("huge.png")
  expect(said()).toContain("5 MB")

  await paste(
    field,
    Array.from({ length: 21 }, (_, i) => image(`${i}.png`)),
  )
  expect(uploads).toHaveLength(20)
  expect(said()).toContain("20 files at most")
})

test("an upload the Hub refuses says why, and holds the prompt until it is removed", async () => {
  const { sent, uploads, field, chips, container } = await composer()
  await step(() => typeInto(field, "look"))
  await paste(field, [image("shot.png")])
  await uploads[0]?.fail("The Session is archived.")

  expect(chips()[0]).toContain("The Session is archived.")
  expect(button("Send prompt").disabled).toBe(true)
  await step(() => button("Remove shot.png", container).click())
  await step(() => button("Send prompt").click())
  expect(sent).toEqual([{ text: "look", attachments: [] }])
})

test("a paste with an image and a long text gives each its chip (#279)", async () => {
  const { uploads, field, chips, container } = await composer()
  const table = Array.from({ length: 6 }, (_, i) => `row ${i}\t${i * 2}`).join("\n")
  await paste(field, [image("chart.png")], table)

  expect(uploads.map((upload) => upload.file.name)).toEqual(["chart.png"])
  expect(chips()).toEqual([expect.stringContaining("chart.png")])
  expect(field.value).toBe("[Pasted text #1 +5 lines]")
  expect(container.querySelector('[aria-label="Pasted texts"]')).not.toBeNull()
})

test("a Composer that takes no attachments leaves pasted files alone", async () => {
  const sent: Array<string> = []
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
  const field = view.container.querySelector<HTMLTextAreaElement>("textarea")
  if (!field) throw new Error("no field")
  await paste(field, [image("shot.png")])
  expect(view.container.querySelector('[aria-label="Attachments"]')).toBeNull()
})

test("files in the draft are dropped once it stops taking attachments, as for a reply", async () => {
  const { useState } = await import("react")
  const sent: Array<{ text: string; attachments: ReadonlyArray<string> }> = []
  let finish: ((id: AttachmentId) => void) | undefined
  function Replying() {
    const [asking, setAsking] = useState(false)
    return (
      <>
        <button type="button" onClick={() => setAsking(true)}>
          Ask
        </button>
        <Composer
          onSend={(text, attachments) => {
            sent.push({ text, attachments })
            return true
          }}
          onStop={() => {}}
          running={false}
          attach={
            asking
              ? undefined
              : () =>
                  new Promise<AttachmentId>((resolve) => {
                    finish = resolve
                  })
          }
        />
      </>
    )
  }
  const view = await render(<Replying />)
  cleanup = view.unmount
  const field = view.container.querySelector<HTMLTextAreaElement>("textarea")
  if (!field) throw new Error("no field")
  await step(() => typeInto(field, "no"))
  await paste(field, [image("shot.png")])
  await step(() => finish?.("att-1" as AttachmentId))

  await step(() => button("Ask").click())
  expect(view.container.querySelector('[aria-label="Attachments"]')).toBeNull()
  await step(() => button("Send prompt").click())
  expect(sent).toEqual([{ text: "no", attachments: [] }])
})
