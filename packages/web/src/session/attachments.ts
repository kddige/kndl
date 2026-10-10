// Which files the Composer takes as attachments (#276), before any is uploaded: the images Claude
// reads, up to the Hub's limits. The Hub checks again, by the bytes; this says why up front.

import { ImageMediaTypes, MaxAttachments, MaxImageBytes } from "@kndl/protocol"

/** The files to upload, and why each of the rest isn't. */
export interface Admitted {
  readonly accepted: ReadonlyArray<File>
  readonly refused: ReadonlyArray<string>
}

const isImage = (type: string) => (ImageMediaTypes as ReadonlyArray<string>).includes(type)

/**
 * Of `files`, those a prompt holding `held` attachments already can take: JPEG, PNG, GIF and WebP
 * images of up to 5 MB, and {@link MaxAttachments} in all. The rest are refused, saying why.
 */
export function admitImages(files: ReadonlyArray<File>, held: number): Admitted {
  const refused: Array<string> = []
  const images = files.filter((file) => {
    if (!isImage(file.type)) {
      refused.push(`${file.name} isn't a JPEG, PNG, GIF or WebP image.`)
      return false
    }
    if (file.size > MaxImageBytes) {
      refused.push(`${file.name} is over ${MaxImageBytes / 1024 / 1024} MB.`)
      return false
    }
    return true
  })
  const room = Math.max(0, MaxAttachments - held)
  if (images.length > room) {
    const left = images.length - room
    refused.push(
      `A prompt takes ${MaxAttachments} files at most: ${left} ${left === 1 ? "was" : "were"} left out.`,
    )
  }
  return { accepted: images.slice(0, room), refused }
}
