// The attachment tool (ADR 0024, amended by ADR 0029): opens a file a Participant attached, by
// the id its marker gives, fetched from the Hub in parts, as hub-link-commands' tool does.
//
// pi's tool results carry text and images only, so an image reaches the model as itself, and a
// PDF can't: it is saved outside the Workspace, where `git add` won't find it, and the model is
// told where, to read it with its own tools.

import type { ModAttachment } from "@kndl/protocol"
import {
  attachmentPart,
  attachmentPartPath,
  attachmentResult,
  maxAttachmentParts,
} from "../../src/HubMessages.ts"

/** The tool's name, as the model calls it. */
export const attachmentTool = "attachment"

export type AttachmentContent =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "image"; readonly data: string; readonly mimeType: string }

export interface AttachmentDeps {
  /** GETs a path on the Hub, with the mod token. */
  readonly fetchPart: (path: string) => Promise<{ readonly status: number; readonly text: string }>
  /** Writes a PDF's base64 `data` to a file of its own; its path. */
  readonly savePdf: (id: string, name: string, data: string) => Promise<string>
}

/** The tool's result for the file `id`; throws, for a failed call, with why it couldn't. */
export const openAttachment = async (
  id: string,
  deps: AttachmentDeps,
): Promise<Array<AttachmentContent>> => {
  if (id === "") throw new Error("Give the attachment's id, from its marker.")
  const parts: Array<ModAttachment> = []
  for (let offset: number | undefined = 0; offset !== undefined;) {
    if (parts.length === maxAttachmentParts) break
    let response: { readonly status: number; readonly text: string }
    try {
      response = await deps.fetchPart(attachmentPartPath(id, offset))
    } catch (error) {
      throw new Error(`Could not open the attachment: ${String(error)}`, { cause: error })
    }
    const answer = attachmentPart(response.status, response.text)
    if ("deny" in answer) throw new Error(answer.deny)
    parts.push(answer.part)
    offset = answer.part.next
  }
  const opened = attachmentResult(parts)
  if ("deny" in opened) throw new Error(opened.deny)
  const [name, block] = opened.result
  if (block.type === "image")
    return [name, { type: "image", data: block.source.data, mimeType: block.source.media_type }]
  const path = await deps.savePdf(id, block.title, block.source.data)
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
