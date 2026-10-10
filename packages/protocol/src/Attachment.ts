import { Schema } from "effect"
import { AttachmentId } from "./Ids.ts"

// Attachments (#276, ADR 0024): files a Participant attaches to a prompt, which reach Claude
// through a tool the mod registers. The web scales each image down as Claude Code does a pasted
// one, uploads it to the Hub over HTTP as soon as it is added, and the prompt carries the ids:
//
// - `POST /sessions/<id>/attachments`: the raw file as the body, its name URI-encoded in
//   {@link AttachmentNameHeader}. Answered with {@link AttachmentUploaded}; 413 past
//   {@link MaxImageBytes}, 415 for what isn't an image of {@link ImageMediaTypes}, as its bytes
//   say, whatever its `Content-Type` says.
// - `GET /sessions/<id>/attachments/<attachmentId>`: the file, to the Session's Participants.
// - `GET /mod/attachments/<attachmentId>?offset=<n>`: the file, base64 in ModAttachment parts
//   (Mod.ts), to the Session's own mod only.

/** The image types Claude reads, as the Hub tells them from their bytes. */
export const ImageMediaTypes = ["image/jpeg", "image/png", "image/gif", "image/webp"] as const
export const ImageMediaType = Schema.Literals(ImageMediaTypes)
export type ImageMediaType = typeof ImageMediaType.Type

/** The largest image the Hub takes, in bytes: the most the Messages API reads of one. */
export const MaxImageBytes = 5 * 1024 * 1024

/** The most files a prompt may carry. */
export const MaxAttachments = 20

/** The longest an attachment's name is kept, in characters. */
export const MaxAttachmentNameLength = 100

/** The request header the upload names its file in, URI-encoded. */
export const AttachmentNameHeader = "x-kndl-filename"

/** An attachment's name: one line, without brackets, as {@link attachmentName} makes it. */
export const AttachmentName = Schema.NonEmptyString.check(
  Schema.isMaxLength(MaxAttachmentNameLength),
)

/** A file attached to a prompt, as the prompt carries it. Its bytes stay on the Hub. */
export const Attachment = Schema.Struct({
  id: AttachmentId,
  name: AttachmentName,
  mediaType: ImageMediaType,
  /** In bytes. */
  size: Schema.Natural,
})
export type Attachment = typeof Attachment.Type

/** A prompt's attachments, in the order they were added; at most {@link MaxAttachments}. */
export const PromptAttachments = Schema.Array(Attachment).check(Schema.isMaxLength(MaxAttachments))

/** The ids of the files a prompt carries, as a Participant sends it. */
export const AttachmentIds = Schema.Array(AttachmentId).check(Schema.isMaxLength(MaxAttachments))

/** The Hub's answer to an upload. */
export const AttachmentUploaded = Schema.Struct({ id: AttachmentId })
export type AttachmentUploaded = typeof AttachmentUploaded.Type

/**
 * A prompt's text and its attachments' ids or files: an image alone is a prompt, but nothing at
 * all is not one.
 */
export const textOrAttachments = Schema.makeFilter(
  (prompt: { readonly text: string; readonly attachments?: ReadonlyArray<unknown> }) =>
    prompt.text.trim() !== "" ||
    (prompt.attachments?.length ?? 0) > 0 ||
    "needs text or an attachment",
)

// oxlint-disable-next-line no-control-regex
const notInMarker = /[\u0000-\u001f\u007f[\]]+/g

/**
 * The name an uploaded file is kept under: what its sender's browser called it, as one line
 * without brackets, since it goes into the prompt's marker, at most
 * {@link MaxAttachmentNameLength} UTF-16 units, cut between characters, never inside one; "image"
 * for none.
 */
export const attachmentName = (raw: string): string => {
  const name = raw.replace(notInMarker, " ").replace(/\s+/g, " ").trim()
  if (name === "") return "image"
  let kept = ""
  for (const character of name) {
    if (kept.length + character.length > MaxAttachmentNameLength) break
    kept += character
  }
  return kept.trimEnd()
}

/** How many images a prompt carries, in words: "1 image", "3 images". */
export const imageCount = (count: number): string => (count === 1 ? "1 image" : `${count} images`)

/** What a marker names of a file: plain strings, as the mod, which has no brands, has them. */
export interface MarkedFile {
  readonly id: string
  readonly name: string
}

/**
 * The line that stands for the `index`th file (from 0) in a prompt Claude reads, in the style of
 * Claude Code's `[Image #1]`, with the id its tool opens it by.
 */
export const attachmentMarker = (attachment: MarkedFile, index: number): string =>
  `[Image #${index + 1}: ${attachment.name} (attachment ${attachment.id})]`

const markers = (attachments: ReadonlyArray<MarkedFile>) =>
  attachments.map(attachmentMarker).join("\n")

/** The prompt as Claude reads it: its text, then a marker line for each file. */
export const withAttachmentMarkers = (
  text: string,
  attachments: ReadonlyArray<MarkedFile>,
): string => [text, ...attachments.map(attachmentMarker)].filter((line) => line !== "").join("\n")

/**
 * The prompt as its sender wrote it, from one {@link withAttachmentMarkers} made: the markers
 * come off, since the transcript shows the files themselves.
 */
export const withoutAttachmentMarkers = (
  text: string,
  attachments: ReadonlyArray<MarkedFile>,
): string => {
  if (attachments.length === 0) return text
  const lines = markers(attachments)
  if (text === lines) return ""
  return text.endsWith(`\n${lines}`) ? text.slice(0, -lines.length - 1) : text
}
