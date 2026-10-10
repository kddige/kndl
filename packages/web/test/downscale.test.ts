// Images scaled down before upload (#276), as Claude Code scales a pasted one. The browser's
// drawing is faked: what is tested is what size and type each image is sent as.

import { describe, expect, test } from "bun:test"
import {
  downscale,
  type Drawn,
  fitWithin,
  type ImageCodec,
  MaxImageEdge,
  renamed,
  type Size,
} from "../src/session/downscale.ts"

const MB = 1024 * 1024

describe("the size an image is sent at", () => {
  test("is within 2000 px on its long edge, its shape kept", () => {
    expect(MaxImageEdge).toBe(2000)
    expect(fitWithin({ width: 4032, height: 3024 })).toEqual({ width: 2000, height: 1500 })
    expect(fitWithin({ width: 1170, height: 2532 })).toEqual({ width: 924, height: 2000 })
    expect(fitWithin({ width: 1600, height: 900 })).toEqual({ width: 1600, height: 900 })
    expect(fitWithin({ width: 100_000, height: 10 })).toEqual({ width: 2000, height: 1 })
  })
})

test("a file re-encoded is named for its new type", () => {
  expect(renamed("shot.png", "image/jpeg")).toBe("shot.jpg")
  expect(renamed("anim.gif", "image/png")).toBe("anim.png")
  expect(renamed("photo", "image/jpeg")).toBe("photo.jpg")
  expect(renamed("my.photo.webp", "image/jpeg")).toBe("my.photo.jpg")
})

/** A codec for images of `size`, transparent or not, whose encodings are `bytes(type, quality)` long. */
function fakeCodec(
  size: Size,
  options: {
    readonly transparent?: boolean
    readonly bytes?: (type: string, quality: number | undefined, at: Size) => number
  } = {},
) {
  const drawn: Array<Size> = []
  const encoded: Array<{ type: string; quality: number | undefined }> = []
  const codec: ImageCodec = {
    size: async () => size,
    draw: async (_, at): Promise<Drawn> => {
      drawn.push(at)
      return {
        hasTransparency: () => options.transparent === true,
        encode: async (type, quality) => {
          encoded.push({ type, quality })
          return new Blob([new Uint8Array(options.bytes?.(type, quality, at) ?? 1_000)], { type })
        },
        close: () => undefined,
      }
    },
  }
  return { codec, drawn, encoded }
}

const file = (name: string, type: string, bytes = 1_000) =>
  new File([new Uint8Array(bytes)], name, { type })

describe("downscale", () => {
  test("sends a small image at its size as it is", async () => {
    const shot = file("shot.png", "image/png", 300_000)
    const { codec, drawn } = fakeCodec({ width: 1440, height: 900 })
    expect(await downscale(shot, codec, 5 * MB)).toBe(shot)
    expect(drawn).toEqual([])
  })

  test("scales a large photo down to a JPEG at 0.85", async () => {
    const { codec, drawn, encoded } = fakeCodec({ width: 4032, height: 3024 })
    const sent = await downscale(file("IMG_1.HEIC.jpg", "image/jpeg", 3 * MB), codec, 5 * MB)
    expect(drawn).toEqual([{ width: 2000, height: 1500 }])
    expect(encoded).toEqual([{ type: "image/jpeg", quality: 0.85 }])
    expect(sent.type).toBe("image/jpeg")
    expect(sent.name).toBe("IMG_1.HEIC.jpg")
  })

  test("keeps a transparent PNG a PNG", async () => {
    const { codec, encoded } = fakeCodec({ width: 3000, height: 3000 }, { transparent: true })
    const sent = await downscale(file("logo.png", "image/png"), codec, 5 * MB)
    expect(encoded).toEqual([{ type: "image/png", quality: undefined }])
    expect(sent.name).toBe("logo.png")
  })

  test("makes an opaque PNG screenshot a JPEG once it is scaled down", async () => {
    const { codec } = fakeCodec({ width: 5120, height: 2880 })
    const sent = await downscale(file("Screenshot.png", "image/png"), codec, 5 * MB)
    expect(sent.type).toBe("image/jpeg")
    expect(sent.name).toBe("Screenshot.jpg")
  })

  test("encodes a large file again at its own size", async () => {
    const { codec, drawn } = fakeCodec({ width: 1800, height: 1200 })
    await downscale(file("big.png", "image/png", 4 * MB), codec, 5 * MB)
    expect(drawn).toEqual([{ width: 1800, height: 1200 }])
  })

  test("sends a GIF as its first frame, however small", async () => {
    const { codec, drawn } = fakeCodec({ width: 320, height: 240 })
    const sent = await downscale(file("dance.gif", "image/gif"), codec, 5 * MB)
    expect(drawn).toEqual([{ width: 320, height: 240 }])
    expect(sent.name).toBe("dance.jpg")
  })

  test("steps the quality down, then halves the size, until it fits", async () => {
    const { codec, drawn, encoded } = fakeCodec(
      { width: 4000, height: 4000 },
      { bytes: (_, quality, at) => (at.width === 2000 ? 6 * MB : Math.round((quality ?? 1) * MB)) },
    )
    const sent = await downscale(file("noise.jpg", "image/jpeg", 8 * MB), codec, 5 * MB)
    expect(encoded.map((encoding) => encoding.quality)).toEqual([0.85, 0.7, 0.5, 0.7])
    expect(drawn).toEqual([
      { width: 2000, height: 2000 },
      { width: 1000, height: 1000 },
    ])
    expect(sent.size).toBe(Math.round(0.7 * MB))
  })

  test("sends one the browser can't decode as it is, for the Hub to judge", async () => {
    const odd = file("odd.png", "image/png", 6 * MB)
    const codec: ImageCodec = {
      size: () => Promise.reject(new Error("can't decode")),
      draw: () => Promise.reject(new Error("can't decode")),
    }
    expect(await downscale(odd, codec, 5 * MB)).toBe(odd)
  })
})
