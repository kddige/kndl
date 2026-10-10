// The Prompt queue's rows: a prompt with images says how many, and can't be steered (#276, #278).

import { afterEach, expect, test } from "bun:test"
import { AttachmentId, ParticipantId, PromptId, type QueuedPrompt } from "@kndl/protocol"
import { installDom } from "./dom.ts"
import { button, render } from "./render.ts"

let cleanup: (() => Promise<void>) | undefined
installDom(() => cleanup?.())
afterEach(async () => {
  await cleanup?.()
  cleanup = undefined
})

const { PromptQueue } = await import("../src/session/PromptQueue.tsx")

const ada = { id: ParticipantId.make("p1"), login: "ada", name: "Ada" }
const shot = {
  id: AttachmentId.make("att-1"),
  name: "shot.png",
  mediaType: "image/png",
  size: 9,
} as const

test("a prompt with images says how many, and its Steer waits for the Turn, saying why", async () => {
  const queue: ReadonlyArray<QueuedPrompt> = [
    { id: PromptId.make("q1"), text: "look", sender: ada, queuedAt: 1, attachments: [shot, shot] },
    {
      id: PromptId.make("q2"),
      text: "",
      sender: { ...ada, name: "Bo" },
      queuedAt: 2,
      attachments: [shot],
    },
    { id: PromptId.make("q3"), text: "plain", sender: { ...ada, name: "Cy" }, queuedAt: 3 },
  ]
  const view = await render(<PromptQueue queue={queue} onCancel={() => {}} onSteer={() => {}} />)
  cleanup = view.unmount

  const rows = [...view.container.querySelectorAll("li")].map((row) => row.textContent ?? "")
  expect(rows[0]).toContain("look · 2 images")
  expect(rows[1]).toContain("1 image")
  const steer = (name: string) =>
    button(`Steer ${name}'s prompt into the running Turn`, view.container)
  expect(steer("Ada").getAttribute("aria-disabled") ?? String(steer("Ada").disabled)).toBe("true")
  expect(steer("Cy").disabled).toBe(false)
  expect(steer("Cy").getAttribute("aria-disabled")).not.toBe("true")
})

test("a prompt with images and PDFs counts each kind (#277)", async () => {
  const spec = {
    ...shot,
    id: AttachmentId.make("att-2"),
    name: "spec.pdf",
    mediaType: "application/pdf",
  } as const
  const queue: ReadonlyArray<QueuedPrompt> = [
    { id: PromptId.make("q1"), text: "read", sender: ada, queuedAt: 1, attachments: [shot, spec] },
  ]
  const view = await render(<PromptQueue queue={queue} onCancel={() => {}} />)
  cleanup = view.unmount
  expect(view.container.querySelector("li")?.textContent).toContain("read · 1 image and 1 PDF")
})
