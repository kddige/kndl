// The attachment tool (ADR 0024, amended by ADR 0029): opens a file a Participant attached, by
// the id its marker gives, fetched from the Hub in parts, as hub-link-commands' tool does.
//
// pi's tool results carry text and images only, so an image reaches the model as itself, and a
// PDF can't: it is saved outside the Workspace, where `git add` won't find it, and the model is
// told where, to read it with its own tools.

import { Type } from "@earendil-works/pi-ai/compat"
import type { ToolDefinition } from "@earendil-works/pi-coding-agent"
import { AttachmentKinds } from "@kndl/protocol"
import { attachmentToolSpec, openAttachment as openFromHub } from "../../src/HubMessages.ts"

/** The tool's name, as the model calls it. */
export const attachmentTool = "attachment"

export type AttachmentContent =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "image"; readonly data: string; readonly mimeType: string }

export interface AttachmentDeps {
  /** GETs a path on the Hub, with the mod token, until `signal` (the call's) aborts. */
  readonly fetchPart: (
    path: string,
    signal?: AbortSignal | undefined,
  ) => Promise<{ readonly status: number; readonly text: string }>
  /** Writes a PDF's base64 `data` to a file of its own; its path. */
  readonly savePdf: (id: string, name: string, data: string) => Promise<string>
}

const attachmentParameters = Type.Object({
  id: Type.String({ description: "The attachment id from the marker." }),
})

/** The attachment tool, in the tool list from the first request on. */
export const attachmentToolDefinition = (
  deps: AttachmentDeps,
): ToolDefinition<typeof attachmentParameters, undefined> => ({
  name: attachmentTool,
  label: "Attachment",
  description: attachmentToolSpec.description,
  promptSnippet: "Open a file someone attached to a message, by its marker's id",
  parameters: attachmentParameters,
  execute: async (_toolCallId, params, signal) => ({
    content: await openAttachment(params.id, deps, signal),
    details: undefined,
  }),
})

/**
 * The name a PDF is saved under, in a directory of its own: its own, as one path segment, or the
 * name an unnamed PDF goes by when its own isn't one (`.`, `..`).
 */
export const pdfFileName = (name: string) => {
  const segment = name.replace(/[/\\]/g, "_")
  return segment === "" || segment === "." || segment === ".."
    ? AttachmentKinds.pdf.fallbackName
    : segment
}

/** The tool's result for the file `id`; throws, for a failed call, with why it couldn't. */
export const openAttachment = async (
  id: string,
  deps: AttachmentDeps,
  signal?: AbortSignal,
): Promise<Array<AttachmentContent>> => {
  const opened = await openFromHub(id, (path) => deps.fetchPart(path, signal))
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
