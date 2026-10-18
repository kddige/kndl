import { describe, expect, test } from "bun:test"
import { MaxModAttachmentPartBytes } from "@kndl/protocol"
import { openAttachment } from "./Attachments.ts"

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
