// Images and PDFs attached in the Composer, pasted (#276), dropped or picked (#277): each is
// uploaded at once, as a chip with its progress and a remove button, and the prompt is sent with
// the ids of those uploaded. What Claude can't read is refused there, with a reason.

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
const { MaxImageBytes, MaxPdfBytes } = await import("@kndl/protocol")

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
  const prepared: Array<string> = []
  const view = await render(
    <Composer
      onSend={(text, attachments) => {
        sent.push({ text, attachments })
        return true
      }}
      onStop={() => {}}
      running={false}
      prepare={async (file) => {
        prepared.push(file.name)
        return file
      }}
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
  return { sent, uploads, prepared, field, chips, said, container: view.container }
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

test("what Claude can't read, or past 20 attachments, is refused with a reason", async () => {
  const { uploads, field, said } = await composer()
  await paste(field, [image("notes.zip", "application/zip")])

  expect(uploads).toEqual([])
  expect(said()).toContain("notes.zip")
  expect(said()).toContain("JPEG, PNG, GIF or WebP image, or a PDF")

  await paste(
    field,
    Array.from({ length: 21 }, (_, i) => image(`${i}.png`)),
  )
  expect(uploads).toHaveLength(20)
  expect(said()).toContain("20 attachments at most")
})

/** Fifteen images, numbered on from `from`. */
const batch = (from: number) => Array.from({ length: 15 }, (_, i) => image(`${from + i}.png`))

test("two pastes at once still hold 20 attachments at most", async () => {
  const { uploads, field, said } = await composer()
  const twice = () => {
    for (const files of [batch(0), batch(15)]) {
      const clipboardData = new DataTransfer()
      for (const file of files) clipboardData.items.add(file)
      field.dispatchEvent(
        new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData }),
      )
    }
  }
  await step(twice)
  expect(uploads).toHaveLength(20)
  expect(said()).toContain("10 were left out")
})

test("an image over 5 MB even scaled down is held back, saying so", async () => {
  const { uploads, field, chips } = await composer()
  await paste(field, [image("huge.png", "image/png", MaxImageBytes + 1)])

  expect(uploads).toEqual([])
  expect(chips()[0]).toContain("over 5 MB, even scaled down")
  expect(button("Send prompt").disabled).toBe(true)
})

test("an image is sent as it was scaled down, under its new name", async () => {
  const sent: Array<ReadonlyArray<string>> = []
  const uploaded: Array<string> = []
  const view = await render(
    <Composer
      onSend={(_, attachments) => {
        sent.push(attachments)
        return true
      }}
      onStop={() => {}}
      running={false}
      prepare={async (file) =>
        new File([new Uint8Array(10)], file.name.replace(".png", ".jpg"), { type: "image/jpeg" })
      }
      attach={async (file) => {
        uploaded.push(`${file.name} ${file.type} ${file.size}`)
        return "att-1" as AttachmentId
      }}
    />,
  )
  cleanup = view.unmount
  const field = view.container.querySelector<HTMLTextAreaElement>("textarea")
  if (!field) throw new Error("no field")
  await paste(field, [image("photo.png", "image/png", 9 * 1024 * 1024)])

  expect(uploaded).toEqual(["photo.jpg image/jpeg 10"])
  expect(view.container.querySelector('[aria-label="Attachments"]')?.textContent).toContain(
    "photo.jpg",
  )
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

test("a Composer that takes no attachments says why when files are pasted", async () => {
  const view = await render(
    <Composer
      onSend={() => true}
      onStop={() => {}}
      running={false}
      cantAttach="Attachments can't go to a subagent yet: attach them to a prompt."
    />,
  )
  cleanup = view.unmount
  const field = view.container.querySelector<HTMLTextAreaElement>("textarea")
  if (!field) throw new Error("no field")
  await paste(field, [image("shot.png")])
  expect(view.container.querySelector('[aria-label="Attachments"]')).toBeNull()
  expect(view.container.querySelector('[aria-label="Attachments refused"]')?.textContent).toBe(
    "Attachments can't go to a subagent yet: attach them to a prompt.",
  )
})

test("files in a draft that becomes a reply go with the reply, which needs words too (#278)", async () => {
  const { useState } = await import("react")
  const sent: Array<{ text: string; attachments: ReadonlyArray<string> }> = []
  let finish: ((id: AttachmentId) => void) | undefined
  function Replying() {
    const [asking, setAsking] = useState(false)
    return (
      <>
        <button type="button" onClick={() => setAsking(!asking)}>
          Ask
        </button>
        <Composer
          onSend={(text, attachments) => {
            sent.push({ text, attachments })
            return true
          }}
          onStop={() => {}}
          running={false}
          {...(asking && {
            copy: { field: "Reply", placeholder: "Reply", send: "Reply", stop: "Stop" },
            needsText: true,
          })}
          attach={() =>
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
  await paste(field, [image("shot.png")])
  await step(() => finish?.("att-1" as AttachmentId))

  await step(() => button("Ask").click())
  expect(view.container.querySelector('[aria-label="Attachments"]')?.textContent).toContain(
    "shot.png",
  )
  // The images alone are no reply: it is in your own words.
  expect(button("Reply").disabled).toBe(true)
  await step(() => typeInto(field, "like this"))
  await step(() => button("Reply").click())
  expect(sent).toEqual([{ text: "like this", attachments: ["att-1"] }])
  expect(view.container.querySelector('[aria-label="Attachments"]')).toBeNull()
})

/** Drags `files` over the Composer's form and drops them, as from the desktop. */
async function drop(container: HTMLElement, files: ReadonlyArray<File>) {
  const form = container.querySelector("form")
  if (!form) throw new Error("no form")
  const dataTransfer = new DataTransfer()
  for (const file of files) dataTransfer.items.add(file)
  // happy-dom's DragEvent is a plain Event: the files ride on it as a browser's do.
  const drag = (type: string) => {
    const event = new Event(type, { bubbles: true, cancelable: true })
    Object.defineProperty(event, "dataTransfer", { value: dataTransfer })
    form.dispatchEvent(event)
  }
  await step(() => drag("dragenter"))
  await step(() => drag("dragover"))
  const target = container.querySelector('[aria-label="Drop to attach"]')
  await step(() => drag("drop"))
  return target
}

test("files dropped on the Composer upload as pasted ones do, over a drop target (#277)", async () => {
  const { sent, uploads, chips, container } = await composer()
  const target = await drop(container, [image("shot.png"), image("notes.zip", "application/zip")])

  expect(target?.textContent).toContain("Drop")
  expect(container.querySelector('[aria-label="Drop to attach"]')).toBeNull()
  expect(uploads.map((upload) => upload.file.name)).toEqual(["shot.png"])
  expect(chips()).toEqual([expect.stringContaining("shot.png")])
  expect(container.querySelector('[aria-label="Attachments refused"]')?.textContent).toContain(
    "notes.zip",
  )
  await uploads[0]?.finish("att-1")
  await step(() => button("Send prompt").click())
  expect(sent).toEqual([{ text: "", attachments: ["att-1"] }])
})

test("the attach button picks files of the types Claude reads, camera and photos included (#277)", async () => {
  const { uploads, chips, container } = await composer()
  const input = container.querySelector<HTMLInputElement>('input[type="file"]')
  if (!input) throw new Error("no file input")
  expect(input.multiple).toBe(true)
  expect(input.accept.split(",")).toEqual([
    "image/jpeg",
    "image/png",
    "image/gif",
    "image/webp",
    "application/pdf",
    ".pdf",
  ])
  let opened = false
  input.addEventListener("click", () => {
    opened = true
  })
  await step(() => button("Attach", container).click())
  expect(opened).toBe(true)

  const picked = new DataTransfer()
  picked.items.add(image("photo.jpg", "image/jpeg"))
  Object.defineProperty(input, "files", { value: picked.files, configurable: true })
  await step(() => input.dispatchEvent(new Event("change", { bubbles: true })))
  expect(uploads.map((upload) => upload.file.name)).toEqual(["photo.jpg"])
  expect(chips()).toEqual([expect.stringContaining("photo.jpg")])
  // The same file can be picked again.
  expect(input.value).toBe("")
})

test("a PDF uploads as it is, its chip naming it and its size; past 10 MB it is refused (#277)", async () => {
  const { sent, uploads, prepared, field, chips, said, container } = await composer()
  await paste(field, [
    image("spec.pdf", "application/pdf", 6_000_000),
    // Dropped from some desktops without a type: a PDF by its name.
    image("notes.pdf", "", 1_000),
    image("huge.pdf", "application/pdf", MaxPdfBytes + 1),
  ])

  expect(prepared).toEqual([])
  expect(uploads.map((upload) => upload.file.name)).toEqual(["spec.pdf", "notes.pdf"])
  expect(said()).toContain("huge.pdf is over 10 MB")
  expect(chips()[0]).toContain("spec.pdf")
  expect(chips()[0]).toContain("5.7 MB")
  expect(chips()[0]).toContain("Uploading")
  expect(container.querySelector('[aria-label="Attachments"] img')).toBeNull()
  await uploads[0]?.finish("att-1")
  await uploads[1]?.finish("att-2")
  await step(() => button("Send prompt").click())
  expect(sent).toEqual([{ text: "", attachments: ["att-1", "att-2"] }])
})

test("a Composer that takes no attachments has no attach button, and says why for a drop (#277)", async () => {
  const view = await render(
    <Composer
      onSend={() => true}
      onStop={() => {}}
      running={false}
      cantAttach="Attachments can't go to a subagent yet: attach them to a prompt."
    />,
  )
  cleanup = view.unmount
  expect(view.container.querySelector('input[type="file"]')).toBeNull()
  expect(view.container.querySelector('[aria-label="Attach"]')).toBeNull()
  await drop(view.container, [image("shot.png")])
  expect(view.container.querySelector('[aria-label="Attachments refused"]')?.textContent).toBe(
    "Attachments can't go to a subagent yet: attach them to a prompt.",
  )
})

test("files dropped or picked on a Composer that can't send are left out, with no drop target (#277)", async () => {
  const uploads: Array<string> = []
  const view = await render(
    <Composer
      onSend={() => true}
      onStop={() => {}}
      running={false}
      disabledReason="The Session is Frozen."
      attach={async (file) => {
        uploads.push(file.name)
        return "att-1" as AttachmentId
      }}
    />,
  )
  cleanup = view.unmount
  const target = await drop(view.container, [image("shot.png")])
  expect(target).toBeNull()
  // Nor are those picked in a picker opened before it was disabled.
  const input = view.container.querySelector<HTMLInputElement>('input[type="file"]')
  const picked = new DataTransfer()
  picked.items.add(image("photo.jpg", "image/jpeg"))
  if (input) Object.defineProperty(input, "files", { value: picked.files, configurable: true })
  await step(() => input?.dispatchEvent(new Event("change", { bubbles: true })))
  expect(uploads).toEqual([])
  expect(view.container.querySelector('[aria-label="Attachments"]')).toBeNull()
})
