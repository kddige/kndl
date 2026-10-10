// Which files the Composer takes as attachments (#276, #277), however they come in (pasted,
// dropped or picked), before any is scaled down and uploaded: the images Claude reads and PDFs,
// as many as a prompt holds. An image's size is checked once it is scaled down; a PDF, sent as it
// is, is checked here. The Hub checks again, by the bytes; this says why up front.

import {
  AttachmentMediaTypes,
  isImage,
  MaxAttachments,
  MaxPdfBytes,
  PdfMediaType,
} from "@kndl/protocol"

/** What the attach button's file picker offers: the types Claude reads, and a PDF by its name. */
export const pickerAccepts = [...AttachmentMediaTypes, ".pdf"].join(",")

/** The files to upload, and why each of the rest isn't. */
export interface Admitted {
  readonly accepted: ReadonlyArray<File>
  readonly refused: ReadonlyArray<string>
}

/** Whether the file is a PDF: by its type, or by its name where it came without one. */
export const isPdf = (file: File) =>
  file.type === PdfMediaType || (file.type === "" && /\.pdf$/i.test(file.name))

/** The file with its type, for a PDF that came without one, as some desktops drop them. */
const typed = (file: File) =>
  file.type === "" && isPdf(file) ? new File([file], file.name, { type: PdfMediaType }) : file

/** A size in words: "512 B", "1.5 KB", "2.4 MB". */
export function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const kilobytes = bytes / 1024
  if (kilobytes < 1024) return `${kilobytes.toFixed(1)} KB`
  return `${(kilobytes / 1024).toFixed(1)} MB`
}

/**
 * Of `files`, those a prompt holding `held` attachments already can take: JPEG, PNG, GIF and WebP
 * images, and PDFs of {@link MaxPdfBytes} at most, {@link MaxAttachments} in all. The rest are
 * refused, saying why.
 */
export function admitFiles(files: ReadonlyArray<File>, held: number): Admitted {
  const refused: Array<string> = []
  const taken = files.flatMap((file) => {
    if (isPdf(file)) {
      if (file.size <= MaxPdfBytes) return [typed(file)]
      refused.push(`${file.name} is over ${MaxPdfBytes / 1024 / 1024} MB, the most a PDF may be.`)
      return []
    }
    if (isImage(file.type)) return [file]
    refused.push(`${file.name} isn't a JPEG, PNG, GIF or WebP image, or a PDF.`)
    return []
  })
  const room = Math.max(0, MaxAttachments - held)
  if (taken.length > room) {
    const left = taken.length - room
    refused.push(
      `A prompt takes ${MaxAttachments} files at most: ${left} ${left === 1 ? "was" : "were"} left out.`,
    )
  }
  return { accepted: taken.slice(0, room), refused }
}
