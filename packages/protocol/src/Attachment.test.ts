import { describe, expect, test } from "bun:test"
import {
  Attachment,
  attachmentName,
  attachmentCount,
  withAttachmentMarkers,
  withoutAttachmentMarkers,
} from "./Attachment.ts"
import { DeliverPrompt } from "./Mod.ts"
import { QueuedPrompt } from "./Session.ts"
import { alice, expectRejected, expectRoundTrips } from "./testSupport.ts"
import { TurnStarted } from "./Turn.ts"
import { WebToHub } from "./Web.ts"

const shot = { id: "att-1", name: "shot.png", mediaType: "image/png", size: 48_213 }
const photo = { id: "att-2", name: "photo.jpg", mediaType: "image/jpeg", size: 1_204_000 }

describe("an Attachment (#276)", () => {
  test("is an image or a PDF, of a type Claude reads (#277)", () => {
    expectRoundTrips(Attachment, [shot, photo, { ...shot, mediaType: "image/gif" }])
    expectRoundTrips(Attachment, [{ ...shot, mediaType: "image/webp" }])
    expectRoundTrips(Attachment, [{ ...shot, name: "spec.pdf", mediaType: "application/pdf" }])
    expectRejected(Attachment, { ...shot, mediaType: "image/svg+xml" })
    expectRejected(Attachment, { ...shot, mediaType: "text/plain" })
    expectRejected(Attachment, { ...shot, name: "" })
  })

  test("rides with a prompt sent, queued, delivered and started", () => {
    const queuedAt = 1_700_000_000_000
    expectRoundTrips(WebToHub, [
      { _tag: "SendPrompt", sessionId: "s-1", text: "what is wrong here?", attachments: ["att-1"] },
    ])
    expectRoundTrips(QueuedPrompt, [
      { id: "p-1", text: "look", sender: alice, queuedAt, attachments: [shot] },
    ])
    expectRoundTrips(DeliverPrompt, [
      {
        _tag: "DeliverPrompt",
        sessionId: "s-1",
        promptId: "p-1",
        text: "look",
        sender: alice,
        attachments: [shot, photo],
      },
    ])
    expectRoundTrips(TurnStarted, [
      {
        _tag: "TurnStarted",
        turnId: "t-1",
        text: "[Alice] look",
        sender: { _tag: "FromParticipant", participant: alice },
        promptId: "p-1",
        attachments: [shot],
      },
    ])
  })

  test("makes a prompt of its own: an image with no text is sent, but nothing at all is not", () => {
    expectRoundTrips(WebToHub, [
      { _tag: "SendPrompt", sessionId: "s-1", text: "", attachments: ["att-1"] },
    ])
    expectRoundTrips(QueuedPrompt, [
      { id: "p-1", text: "", sender: alice, queuedAt: 1, attachments: [shot] },
    ])
    expectRejected(WebToHub, { _tag: "SendPrompt", sessionId: "s-1", text: "", attachments: [] })
    expectRejected(QueuedPrompt, { id: "p-1", text: "", sender: alice, queuedAt: 1 })
    expectRejected(DeliverPrompt, {
      _tag: "DeliverPrompt",
      sessionId: "s-1",
      promptId: "p-1",
      text: "",
      sender: alice,
    })
  })

  test("comes 20 to a prompt at most", () => {
    const ids = Array.from({ length: 21 }, (_, index) => `att-${index}`)
    expectRoundTrips(WebToHub, [
      { _tag: "SendPrompt", sessionId: "s-1", text: "all", attachments: ids.slice(0, 20) },
    ])
    expectRejected(WebToHub, {
      _tag: "SendPrompt",
      sessionId: "s-1",
      text: "all",
      attachments: ids,
    })
  })
})

describe("an attachment's marker", () => {
  const [one, two] = [
    { id: "att-1", name: "shot.png", mediaType: "image/png" },
    { id: "att-2", name: "photo.jpg", mediaType: "image/jpeg" },
  ] as const
  const spec = { id: "att-3", name: "spec.pdf", mediaType: "application/pdf" } as const

  test("follows the prompt, one line per file, as Claude Code numbers pasted images", () => {
    expect(withAttachmentMarkers("what is wrong here?", [one, two])).toBe(
      "what is wrong here?\n[Image #1: shot.png (attachment att-1)]\n[Image #2: photo.jpg (attachment att-2)]",
    )
    expect(withAttachmentMarkers("", [one])).toBe("[Image #1: shot.png (attachment att-1)]")
    expect(withAttachmentMarkers("just text", [])).toBe("just text")
  })

  test("numbers PDFs apart from images, as Claude Code numbers each kind (#277)", () => {
    expect(withAttachmentMarkers("read these", [one, spec, two])).toBe(
      "read these\n[Image #1: shot.png (attachment att-1)]\n[PDF #1: spec.pdf (attachment att-3)]\n[Image #2: photo.jpg (attachment att-2)]",
    )
    expect(withoutAttachmentMarkers(withAttachmentMarkers("x", [spec, one]), [spec, one])).toBe("x")
  })

  test("comes off again for the transcript, which shows the files themselves", () => {
    const text = "what is wrong here?"
    expect(withoutAttachmentMarkers(withAttachmentMarkers(text, [one, two]), [one, two])).toBe(text)
    expect(withoutAttachmentMarkers(withAttachmentMarkers("", [one]), [one])).toBe("")
    // Text that doesn't end with them is left as it is.
    expect(withoutAttachmentMarkers("[Image #1] typed", [one])).toBe("[Image #1] typed")
  })
})

describe("an attachment's name", () => {
  test("is one short line the marker can hold", () => {
    expect(attachmentName("shot.png")).toBe("shot.png")
    expect(attachmentName("  my [draft]\nshot.png ")).toBe("my draft shot.png")
    expect(attachmentName("a".repeat(300))).toHaveLength(100)
    expect(attachmentName("")).toBe("image")
    expect(attachmentName("[]")).toBe("image")
    expect(attachmentName("", "document")).toBe("document")
  })

  test("is cut between characters, never through one", () => {
    const name = attachmentName(`${"a".repeat(99)}😀b.png`)
    expect(name).toBe("a".repeat(99))
    // Whole characters encode: half of one would throw.
    expect(() => encodeURIComponent(attachmentName(`${"a".repeat(98)}😀😀.png`))).not.toThrow()
    expect(attachmentName(`${"a".repeat(98)}😀😀.png`)).toBe(`${"a".repeat(98)}😀`)
  })
})

test("a prompt's files are counted in words, images and PDFs apart (#277)", () => {
  const image = { mediaType: "image/png" }
  const pdf = { mediaType: "application/pdf" }
  expect(attachmentCount([image])).toBe("1 image")
  expect(attachmentCount([image, image, image])).toBe("3 images")
  expect(attachmentCount([pdf])).toBe("1 PDF")
  expect(attachmentCount([image, pdf, image, pdf])).toBe("2 images and 2 PDFs")
})
