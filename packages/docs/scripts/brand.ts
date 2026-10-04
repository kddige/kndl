// Makes the raster brand assets from the SVG sources in brand/, and copies the favicons into the
// docs site's and the web UI's public folders. After changing brand/, run `bun run brand` here, or
// `bun run --filter @claude-hub/docs brand` from the repo root.
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import sharp from "sharp"

const root = join(import.meta.dir, "..", "..", "..")
const brand = join(root, "brand")
const raster = join(brand, "raster")
const docsPublic = join(root, "packages", "docs", "public")
const publics = [docsPublic, join(root, "packages", "web", "public")]

const mark = readFileSync(join(brand, "mark.svg"))

const png = (svg: Buffer, width: number, height = width) =>
  sharp(svg, { density: 600 }).resize(width, height).png({ compressionLevel: 9 }).toBuffer()

/** An ICO whose frames are PNGs, which every current browser and Windows since Vista reads. */
const ico = (frames: ReadonlyArray<{ readonly size: number; readonly data: Buffer }>) => {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(frames.length, 4)
  const directory = Buffer.alloc(16 * frames.length)
  let offset = header.length + directory.length
  frames.forEach((frame, i) => {
    const at = i * 16
    directory.writeUInt8(frame.size >= 256 ? 0 : frame.size, at)
    directory.writeUInt8(frame.size >= 256 ? 0 : frame.size, at + 1)
    directory.writeUInt16LE(1, at + 4)
    directory.writeUInt16LE(32, at + 6)
    directory.writeUInt32LE(frame.data.length, at + 8)
    directory.writeUInt32LE(offset, at + 12)
    offset += frame.data.length
  })
  return Buffer.concat([header, directory, ...frames.map((frame) => frame.data)])
}

mkdirSync(raster, { recursive: true })

const frames = await Promise.all(
  [16, 32, 48].map(async (size) => ({ size, data: await png(mark, size) })),
)
writeFileSync(join(raster, "favicon.ico"), ico(frames))
writeFileSync(join(raster, "favicon-32.png"), await png(mark, 32))

// iOS rounds the corners itself, so the apple-touch icon is the mark on a full square, without
// the tile's rounded corners and edge.
const square = mark
  .toString()
  .replace(/<rect width="64" height="64" rx="15"/, '<rect width="64" height="64" rx="0"')
  .replace(/<rect x="0.75"[^>]*\/>/, "")
writeFileSync(join(raster, "apple-touch-icon.png"), await png(Buffer.from(square), 180))

writeFileSync(
  join(raster, "og.png"),
  await sharp(readFileSync(join(brand, "og.svg")))
    .png({ compressionLevel: 9 })
    .toBuffer(),
)

for (const dir of publics) {
  mkdirSync(dir, { recursive: true })
  copyFileSync(join(brand, "mark.svg"), join(dir, "favicon.svg"))
  copyFileSync(join(raster, "favicon.ico"), join(dir, "favicon.ico"))
  copyFileSync(join(raster, "apple-touch-icon.png"), join(dir, "apple-touch-icon.png"))
}
copyFileSync(join(raster, "og.png"), join(docsPublic, "og.png"))

console.log(`Wrote brand/raster and the favicons in ${publics.length} public folders.`)
