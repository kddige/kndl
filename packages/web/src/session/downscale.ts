// Images are scaled down in the browser before they are uploaded (#276), as Claude Code scales a
// pasted image: the long edge to 2000 px at most (its default, Claude Code 2.1.296). A whole
// Messages API request is capped at 32 MB, and every image a Turn opened stays in the
// conversation, so full-size images would soon break every request after them.
//
// The sizing is plain maths, here; the drawing and encoding is the browser's (`browserCodec`),
// which a test replaces.

/** The longest edge an image is sent with, in pixels: Claude Code's for a pasted image. */
export const MaxImageEdge = 2000

/**
 * Past this many bytes an image is encoded again even at its own size: the most Claude Code sends
 * of an image as it is, whose base64 is 5 MiB.
 */
export const ReencodeAboveBytes = 3_932_160

/** The JPEG qualities tried in turn, until the image fits. */
const jpegQualities = [0.85, 0.7, 0.5] as const

/** A size in pixels. */
export interface Size {
  readonly width: number
  readonly height: number
}

/** The size to send an image of `size` at: within `maxEdge` on its long edge, its shape kept. */
export function fitWithin(size: Size, maxEdge = MaxImageEdge): Size {
  const longest = Math.max(size.width, size.height)
  if (longest <= maxEdge) return size
  const scale = maxEdge / longest
  return {
    width: Math.max(1, Math.round(size.width * scale)),
    height: Math.max(1, Math.round(size.height * scale)),
  }
}

/**
 * Whether an image is sent as it is: at its size, small enough, and not a GIF, which is sent as
 * its first frame, the one Claude reads, as Claude Code sends it.
 */
export function sentAsIs(file: { readonly type: string; readonly size: number }, size: Size) {
  const fitted = fitWithin(size)
  return (
    file.type !== "image/gif" &&
    fitted.width === size.width &&
    fitted.height === size.height &&
    file.size <= ReencodeAboveBytes
  )
}

/** The image types a source may be transparent in. */
const mayBeTransparent = new Set(["image/png", "image/webp", "image/gif"])

/** `name` with the extension of `type`, as the bytes now are: `shot.png` as JPEG is `shot.jpg`. */
export function renamed(name: string, type: string): string {
  const extension = type === "image/png" ? "png" : type === "image/jpeg" ? "jpg" : undefined
  if (extension === undefined) return name
  const base = name.replace(/\.[^./]*$/, "")
  return `${base === "" ? "image" : base}.${extension}`
}

/** An image drawn at the size it is sent at, ready to encode. */
export interface Drawn {
  /** Whether any pixel is less than opaque. */
  hasTransparency(): boolean
  /** The image encoded as `type`; the browser may answer another type it can encode. */
  encode(type: "image/png" | "image/jpeg", quality?: number): Promise<Blob>
  close(): void
}

/** How the browser decodes and draws an image. */
export interface ImageCodec {
  /** The image's size, upright. */
  size(file: Blob): Promise<Size>
  /** The image drawn upright at `size`: a GIF's first frame. */
  draw(file: Blob, size: Size): Promise<Drawn>
}

/**
 * The image to upload for `file`, scaled down if it is larger than Claude Code would send it:
 * PNG where it is transparent, else JPEG, at the best quality that fits `maxBytes`, and named
 * for its type. One that is small enough is sent as it is; one the browser can't decode, too, and
 * the Hub has the last word.
 */
export async function downscale(file: File, codec: ImageCodec, maxBytes: number): Promise<File> {
  let drawn: Drawn | undefined
  try {
    const size = await codec.size(file)
    if (sentAsIs(file, size)) return file
    let fitted = fitWithin(size)
    drawn = await codec.draw(file, fitted)
    const transparent = mayBeTransparent.has(file.type) && drawn.hasTransparency()
    let blob = transparent
      ? await drawn.encode("image/png")
      : await encodeWithin(drawn, maxBytes, jpegQualities)
    // Still too large: once more at half the size, before the Hub refuses it.
    if (blob.size > maxBytes) {
      drawn.close()
      fitted = fitWithin(fitted, Math.round(Math.max(fitted.width, fitted.height) / 2))
      drawn = await codec.draw(file, fitted)
      blob = transparent ? await drawn.encode("image/png") : await drawn.encode("image/jpeg", 0.7)
    }
    return new File([blob], renamed(file.name, blob.type), { type: blob.type })
  } catch {
    return file
  } finally {
    drawn?.close()
  }
}

async function encodeWithin(drawn: Drawn, maxBytes: number, qualities: ReadonlyArray<number>) {
  let blob: Blob | undefined
  for (const quality of qualities) {
    blob = await drawn.encode("image/jpeg", quality)
    if (blob.size <= maxBytes) return blob
  }
  if (blob === undefined) throw new Error("no quality to encode at")
  return blob
}

/** Decodes upright, honouring EXIF orientation, where the browser takes the option. */
async function bitmapOf(file: Blob, size?: Size): Promise<ImageBitmap> {
  const resize =
    size === undefined
      ? {}
      : { resizeWidth: size.width, resizeHeight: size.height, resizeQuality: "high" as const }
  try {
    return await createImageBitmap(file, { imageOrientation: "from-image", ...resize })
  } catch {
    return await createImageBitmap(file, resize)
  }
}

/** A 2d canvas of `size`, offscreen where the browser has one, and how to encode it. */
const canvasOf = (size: Size) => {
  if (typeof OffscreenCanvas === "function") {
    const canvas = new OffscreenCanvas(size.width, size.height)
    const context = canvas.getContext("2d")
    if (context !== null)
      return {
        context,
        encode: (type: string, quality?: number) =>
          canvas.convertToBlob(quality === undefined ? { type } : { type, quality }),
      }
  }
  const canvas = document.createElement("canvas")
  canvas.width = size.width
  canvas.height = size.height
  const context = canvas.getContext("2d")
  if (context === null) throw new Error("no 2d canvas")
  return {
    context,
    encode: (type: string, quality?: number) =>
      new Promise<Blob>((resolve, reject) =>
        canvas.toBlob(
          (blob) => (blob === null ? reject(new Error("could not encode")) : resolve(blob)),
          type,
          quality,
        ),
      ),
  }
}

/**
 * The browser's codec: `createImageBitmap`, resized as it decodes so a camera photo is never held
 * at full size, drawn on an OffscreenCanvas, or a canvas where there is none. Undefined where the
 * browser has neither, as in tests: images are then sent as they are.
 */
export function browserCodec(): ImageCodec | undefined {
  if (typeof createImageBitmap !== "function") return undefined
  return {
    size: async (file) => {
      const bitmap = await bitmapOf(file)
      const size = { width: bitmap.width, height: bitmap.height }
      bitmap.close()
      return size
    },
    draw: async (file, size) => {
      const bitmap = await bitmapOf(file, size)
      const { context, encode } = canvasOf(size)
      context.drawImage(bitmap, 0, 0, size.width, size.height)
      bitmap.close()
      return {
        hasTransparency: () => {
          const { data } = context.getImageData(0, 0, size.width, size.height)
          for (let alpha = 3; alpha < data.length; alpha += 4) if (data[alpha] !== 255) return true
          return false
        },
        encode,
        close: () => undefined,
      }
    },
  }
}
