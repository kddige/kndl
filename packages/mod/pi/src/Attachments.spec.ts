import { describe, expect, test } from "bun:test"
import { MaxModAttachmentPartBytes } from "@kndl/protocol"
import { attachmentToolDefinition, openAttachment, pdfFileName } from "./Attachments.ts"

const part = (overrides: Record<string, unknown>) =>
  JSON.stringify({
    id: "att-1",
    name: "shot.png",
    mediaType: "image/png",
    data: "aGk=",
    ...overrides,
  })

describe("the attachment tool (ADR 0024)", () => {
  test("hands the model an image the Hub sent in parts, with its name", async () => {
    const asked: Array<string> = []
    const content = await openAttachment("att-1", {
      fetchPart: async (path) => {
        asked.push(path)
        return path.endsWith("offset=0")
          ? { status: 200, text: part({ data: "aGVs", next: MaxModAttachmentPartBytes }) }
          : { status: 200, text: part({ data: "bG8=" }) }
      },
      savePdf: async () => "/never",
    })
    expect(asked).toEqual([
      "/mod/attachments/att-1?offset=0",
      `/mod/attachments/att-1?offset=${MaxModAttachmentPartBytes}`,
    ])
    expect(content).toEqual([
      { type: "text", text: "shot.png" },
      { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
    ])
  })

  test("a PDF, which pi's tool results can't carry, is saved outside the Workspace and its path given", async () => {
    const saved: Array<[string, string, string]> = []
    const content = await openAttachment("att-3", {
      fetchPart: async () => ({
        status: 200,
        text: part({ id: "att-3", name: "spec.pdf", mediaType: "application/pdf", data: "JVBE" }),
      }),
      savePdf: async (id, name, data) => {
        saved.push([id, name, data])
        return "/tmp/kndl-attachments/att-3/spec.pdf"
      },
    })
    expect(saved).toEqual([["att-3", "spec.pdf", "JVBE"]])
    expect(content).toHaveLength(1)
    expect(content[0]?.type).toBe("text")
    const text = content[0]?.type === "text" ? content[0].text : ""
    expect(text).toContain("spec.pdf")
    expect(text).toContain("/tmp/kndl-attachments/att-3/spec.pdf")
  })

  test("a stopped Turn cuts the tool's fetches short: the call's signal goes with each", async () => {
    const signals: Array<AbortSignal | undefined> = []
    const tool = attachmentToolDefinition({
      fetchPart: async (_path, signal) => {
        signals.push(signal)
        return { status: 200, text: part({}) }
      },
      savePdf: async () => "/never",
    })
    const stop = new AbortController()
    await tool.execute("call-1", { id: "att-1" }, stop.signal, undefined, undefined as never)
    expect(signals).toEqual([stop.signal])
  })

  test("a PDF is saved under its own name, as one path segment, or as an unnamed one's when its own isn't a file's", () => {
    expect(pdfFileName("spec.pdf")).toBe("spec.pdf")
    expect(pdfFileName("../etc/passwd")).toBe(".._etc_passwd")
    expect(pdfFileName("a\\b.pdf")).toBe("a_b.pdf")
    expect(pdfFileName(".")).toBe("document.pdf")
    expect(pdfFileName("..")).toBe("document.pdf")
    expect(pdfFileName("")).toBe("document.pdf")
  })

  test("fails with the Hub's reason", async () => {
    await expect(
      openAttachment("att-9", {
        fetchPart: async () => ({
          status: 404,
          text: JSON.stringify({ error: "No such attachment." }),
        }),
        savePdf: async () => "/never",
      }),
    ).rejects.toThrow("Could not open the attachment: No such attachment.")
    await expect(
      openAttachment("", {
        fetchPart: async () => ({ status: 200, text: "" }),
        savePdf: async () => "",
      }),
    ).rejects.toThrow("Give the attachment's id")
  })
})
