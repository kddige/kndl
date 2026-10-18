// Reading what a sender may make too large to hold: an MCP server's icon, an authorization server's
// answer, or a request through the Gateway that may have to be sent again (#217). And letting an
// answer go unread.

import { Effect } from "effect"

/**
 * A body read to its end, unless it is longer than `max` bytes: then the rest is left unread, and
 * it is `undefined`. However the sender frames it, the Hub never holds more than `max` of it.
 */
export const readAtMost = async (
  body: ReadableStream<Uint8Array> | null,
  max: number,
): Promise<Uint8Array | undefined> => {
  if (body === null) return new Uint8Array(0)
  const reader = body.getReader()
  const chunks: Array<Uint8Array> = []
  let size = 0
  for (let read = await reader.read(); !read.done; read = await reader.read()) {
    size += read.value.byteLength
    if (size > max) {
      await reader.cancel().catch(() => undefined)
      return undefined
    }
    chunks.push(read.value)
  }
  return Buffer.concat(chunks, size)
}

/** Lets an answer's body go unread. */
export const discard = (response: Response) =>
  Effect.promise(() => response.body?.cancel() ?? Promise.resolve()).pipe(Effect.ignore)
