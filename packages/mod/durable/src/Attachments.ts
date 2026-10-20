// The attachment tool (ADR 0024, amended by ADR 0029): opens a file a Participant attached, by
// the id its marker gives, fetched from the Hub in parts (`GET /mod/attachments/<id>`).
//
// A tool's result carries text and images only, so an image reaches the model as itself, and a
// PDF can't: it is saved outside the Workspace, where `git add` won't find it, and the model is
// told where, to read it with its own tools.

import { mkdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Type } from "@earendil-works/pi-ai"
import { defineTool } from "@earendil-works/pi-durable"
import { AttachmentKinds } from "@kndl/protocol"
import { openAttachment as openFromHub } from "./hub/HubMessages.ts"
import type { HubGet } from "./hub/HubMessages.ts"

/** The tool's name, as the model calls it. */
export const attachmentTool = "attachment"

const attachmentToolDescription =
  'Opens a file someone in this shared session attached to a message, by the id its marker gives: "[Image #1: shot.png (attachment <id>)]" or "[PDF #1: spec.pdf (attachment <id>)]". Returns the image or PDF itself. Call it once per file.'

/**
 * The name a PDF is saved under, in a directory of its own: its own, as one path segment, or the
 * name an unnamed PDF goes by when its own isn't one (`.`, `..`).
 */
const pdfFileName = (name: string) => {
  const segment = name.replace(/[/\\]/g, "_")
  return segment === "" || segment === "." || segment === ".."
    ? AttachmentKinds.pdf.fallbackName
    : segment
}

/** Writes a PDF's base64 `data` to a file of its own, outside the Workspace; its path. */
const savePdf = async (id: string, name: string, data: string) => {
  const dir = join(tmpdir(), "kndl-attachments", id.replace(/[^A-Za-z0-9_-]/g, "_"))
  await mkdir(dir, { recursive: true })
  const path = join(dir, pdfFileName(name))
  await writeFile(path, Buffer.from(data, "base64"))
  return path
}

export type AttachmentContent =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "image"; readonly data: string; readonly mimeType: string }

/** The tool's result for the file `id`; throws, for a failed call, with why it couldn't. */
export const openAttachment = async (
  id: string,
  get: HubGet,
  save: (id: string, name: string, data: string) => Promise<string> = savePdf,
): Promise<Array<AttachmentContent>> => {
  const opened = await openFromHub(id, get)
  if ("deny" in opened) throw new Error(opened.deny)
  const [name, block] = opened.result
  if (block.type === "image")
    return [name, { type: "image", data: block.source.data, mimeType: block.source.media_type }]
  const path = await save(id, block.title, block.source.data)
  return [
    {
      type: "text",
      text: [
        `${block.title} is a PDF, which this session can't hand you as a document.`,
        `It is saved at ${path}: read it from there with your tools, such as \`pdftotext\`.`,
      ].join(" "),
    },
  ]
}

/**
 * The attachment tool, offered from the first request on. Replay-safe: it only reads from the
 * Hub, so a call a restart cut off is made again.
 */
export const attachmentToolDefinition = (
  get: (path: string, signal?: AbortSignal) => ReturnType<HubGet>,
) =>
  defineTool({
    name: attachmentTool,
    description: attachmentToolDescription,
    parameters: Type.Object({
      id: Type.String({ description: "The attachment id from the marker." }),
    }),
    replay: "safe",
    execute: async (args, _api, context) => ({
      output: await openAttachment(args.id, (path) => get(path, context.abortSignal)),
    }),
  })
