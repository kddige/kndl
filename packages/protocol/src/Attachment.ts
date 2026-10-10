import { Schema } from "effect"
import { AttachmentId } from "./Ids.ts"

// Attachments (#276, ADR 0024): files a Participant attaches to a prompt, which reach Claude
// through a tool the mod registers. The web scales each image down as Claude Code does a pasted
// one, uploads it to the Hub over HTTP as soon as it is added, and the prompt carries the ids:
//
// - `POST /sessions/<id>/attachments`: the raw file as the body, its name URI-encoded in
//   {@link AttachmentNameHeader}. Answered with {@link AttachmentUploaded}; 413 past
//   the limit for its type ({@link maxAttachmentBytes}), 415 for what isn't an image of
//   {@link ImageMediaTypes} or a PDF (#277), as its bytes say, whatever its `Content-Type` says.
// - `GET /sessions/<id>/attachments/<attachmentId>`: the file, to the Session's Participants.
// - `GET /mod/attachments/<attachmentId>?offset=<n>`: the file, base64 in ModAttachment parts
//   (Mod.ts), to the Session's own mod only.

/** The image types Claude reads, as the Hub tells them from their bytes. */
export const ImageMediaTypes = ["image/jpeg", "image/png", "image/gif", "image/webp"] as const
export const ImageMediaType = Schema.Literals(ImageMediaTypes)
export type ImageMediaType = typeof ImageMediaType.Type

/** The largest image the Hub takes, in bytes: the most the Messages API reads of one. */
export const MaxImageBytes = 5 * 1024 * 1024

/** A PDF's type (#277): Claude reads one whole, as a document. */
export const PdfMediaType = "application/pdf"

/** The types of file a prompt carries: the images Claude reads, and PDFs. */
export const AttachmentMediaTypes = [...ImageMediaTypes, PdfMediaType] as const
export const AttachmentMediaType = Schema.Literals(AttachmentMediaTypes)
export type AttachmentMediaType = typeof AttachmentMediaType.Type

/** The largest PDF the Hub takes, in bytes: the most Claude Code's Read takes of a whole one. */
export const MaxPdfBytes = 20 * 1024 * 1024

/** Whether a file of this type is an image, rather than a PDF. */
export const isImage = (mediaType: string): mediaType is ImageMediaType =>
  (ImageMediaTypes as ReadonlyArray<string>).includes(mediaType)

/** The largest file of this type the Hub takes, in bytes. */
export const maxAttachmentBytes = (mediaType: AttachmentMediaType): number =>
  isImage(mediaType) ? MaxImageBytes : MaxPdfBytes

/** The largest file of any type the Hub takes, in bytes. */
export const MaxAttachmentBytes = Math.max(MaxImageBytes, MaxPdfBytes)

const megabytes = (bytes: number) => `${bytes / 1024 / 1024} MB`

/** Why a file of this type is refused past {@link maxAttachmentBytes}, as the Hub says it. */
export const tooLargeReason = (mediaType: AttachmentMediaType): string =>
  isImage(mediaType)
    ? `An image may be ${megabytes(MaxImageBytes)} at most, the most Claude reads.`
    : `A PDF may be ${megabytes(MaxPdfBytes)} at most.`

/** Why a file is refused past {@link MaxAttachmentBytes}, before its type is known. */
export const tooLargeForAnyReason = `A file may be ${megabytes(MaxPdfBytes)} at most if a PDF, ${megabytes(MaxImageBytes)} if an image.`

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
  mediaType: AttachmentMediaType,
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
 * {@link MaxAttachmentNameLength} UTF-16 units, cut between characters, never inside one;
 * `fallback` for none.
 */
export const attachmentName = (raw: string, fallback = "image"): string => {
  const name = raw.replace(notInMarker, " ").replace(/\s+/g, " ").trim()
  if (name === "") return fallback
  let kept = ""
  for (const character of name) {
    if (kept.length + character.length > MaxAttachmentNameLength) break
    kept += character
  }
  return kept.trimEnd()
}

const counted = (count: number, kind: string) => `${count} ${kind}${count === 1 ? "" : "s"}`

/** How many files a prompt carries, in words: "1 image", "3 images", "2 images and 1 PDF". */
export const attachmentCount = (
  attachments: ReadonlyArray<{ readonly mediaType: string }>,
): string => {
  const images = attachments.filter((file) => isImage(file.mediaType)).length
  const pdfs = attachments.length - images
  return [images > 0 ? counted(images, "image") : "", pdfs > 0 ? counted(pdfs, "PDF") : ""]
    .filter((part) => part !== "")
    .join(" and ")
}

/** What a marker names of a file: plain strings, as the mod, which has no brands, has them. */
export interface MarkedFile {
  readonly id: string
  readonly name: string
  readonly mediaType: string
}

/** What a marker calls a file of this type: "Image", as Claude Code calls a pasted one, or "PDF". */
const markerKind = (mediaType: string) => (isImage(mediaType) ? "Image" : "PDF")

/**
 * What each file of a prompt is called, as Claude Code numbers pasted images: "Image #1". Images
 * and PDFs are numbered apart (#277): "Image #1", "PDF #1", "Image #2".
 */
export const attachmentLabels = (
  attachments: ReadonlyArray<{ readonly mediaType: string }>,
): Array<string> => {
  const numbers = new Map<string, number>()
  return attachments.map((attachment) => {
    const kind = markerKind(attachment.mediaType)
    const number = (numbers.get(kind) ?? 0) + 1
    numbers.set(kind, number)
    return `${kind} #${number}`
  })
}

/**
 * The line for each file in a prompt Claude reads, in the style of Claude Code's `[Image #1]`,
 * with the id its tool opens it by: `[Image #1: shot.png (attachment <id>)]`,
 * `[PDF #1: spec.pdf (attachment <id>)]`.
 */
export const attachmentMarkers = (attachments: ReadonlyArray<MarkedFile>): Array<string> => {
  const labels = attachmentLabels(attachments)
  return attachments.map(
    (attachment, index) => `[${labels[index]}: ${attachment.name} (attachment ${attachment.id})]`,
  )
}

/** The prompt as Claude reads it: its text, then a marker line for each file. */
export const withAttachmentMarkers = (
  text: string,
  attachments: ReadonlyArray<MarkedFile>,
): string => [text, ...attachmentMarkers(attachments)].filter((line) => line !== "").join("\n")

/**
 * The prompt as its sender wrote it, from one {@link withAttachmentMarkers} made: the markers
 * come off, since the transcript shows the files themselves.
 */
export const withoutAttachmentMarkers = (
  text: string,
  attachments: ReadonlyArray<MarkedFile>,
): string => {
  if (attachments.length === 0) return text
  const lines = attachmentMarkers(attachments).join("\n")
  if (text === lines) return ""
  return text.endsWith(`\n${lines}`) ? text.slice(0, -lines.length - 1) : text
}
