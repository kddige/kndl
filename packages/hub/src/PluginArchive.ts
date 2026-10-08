// Reading a Plugin package from an uploaded archive (#220): a `.tgz`, as `npm pack` makes, or a
// `.zip`, as GitHub's "Download ZIP" does. The archive is untrusted data: nothing in it is
// written to disk or run, and only `package.json` and `kndl.json` are read, at its root or in its
// one top-level folder (npm's `package/`, GitHub's `<repo>-<ref>/`).
//
// - It unpacks in memory, to at most MaxUnpackedBytes, so a small archive can't unpack to a large
//   one. Each of the two files is at most MaxPluginPackageFileBytes.
// - A path outside the archive, absolute or with a `..`, refuses it, even where the Hub wouldn't
//   read it. So does either file twice, which tar allows and which would be ambiguous.
// - Only regular files count: a symlink, hard link or device named like either file refuses it.

import { inflateRawSync, gunzipSync } from "node:zlib"
import { MaxPluginPackageFileBytes, PluginManifestFile } from "@kndl/protocol"
import { Result } from "effect"

/** What an archive unpacks to, at most: past it, it is refused. */
export const MaxUnpackedBytes = 32 * 1024 * 1024

/** The entries an archive holds, at most. */
const MaxEntries = 20_000

/** A Plugin package's two files, as text. */
export interface PackageFiles {
  readonly packageJson: string
  readonly manifest: string
}

const notAnArchive =
  "That isn't a .tgz or .zip archive, such as npm pack or GitHub's Download ZIP makes."

/** An archive's entry: a regular file's bytes, or something else, which is never read. */
interface Entry {
  readonly path: string
  readonly file: boolean
  /** A regular file's bytes, read only when it may be one of the two files. */
  readonly bytes: () => Uint8Array | string
}

/** Thrown inside a reader, with what to tell the person. */
class Refusal extends Error {}

const refuse = (message: string): never => {
  throw new Refusal(message)
}

/** An entry's path as compared: without `./` before it; refused if outside the archive. */
function entryPath(path: string): string {
  const stripped = path.replace(/^(?:\.\/)+/, "")
  if (
    stripped.startsWith("/") ||
    /^[A-Za-z]:/.test(stripped) ||
    stripped.split(/[/\\]/).some((segment) => segment === "..")
  ) {
    refuse(`The archive holds ${path}, a path outside it.`)
  }
  return stripped
}

const text = new TextDecoder("utf-8", { fatal: false })

const cString = (bytes: Uint8Array, from: number, length: number) => {
  const field = bytes.subarray(from, from + length)
  const end = field.indexOf(0)
  return text.decode(end === -1 ? field : field.subarray(0, end))
}

const octal = (bytes: Uint8Array, from: number, length: number) => {
  // A size over 8 GiB is base-256, which no Plugin package needs.
  if ((bytes[from] ?? 0) & 0x80) refuse(notAnArchive)
  const field = cString(bytes, from, length).trim()
  if (!/^[0-7]*$/.test(field)) refuse(notAnArchive)
  return field === "" ? 0 : Number.parseInt(field, 8)
}

/** The pax extended header's `path`, if it gives one. */
function paxPath(bytes: Uint8Array): string | undefined {
  let path: string | undefined
  for (const record of text.decode(bytes).split("\n")) {
    const match = /^\d+ path=(.*)$/s.exec(record)
    if (match?.[1] !== undefined) path = match[1]
  }
  return path
}

function* tarEntries(tar: Uint8Array): Generator<Entry> {
  let offset = 0
  let longName: string | undefined
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512)
    if (header.every((byte) => byte === 0)) return
    const stored = header.reduce(
      (total, byte, index) => total + (index >= 148 && index < 156 ? 32 : byte),
      0,
    )
    if (octal(header, 148, 8) !== stored) refuse(notAnArchive)
    const size = octal(header, 124, 12)
    const type = String.fromCharCode(header[156] ?? 0)
    const start = offset + 512
    if (start + size > tar.length) refuse(notAnArchive)
    const body = tar.subarray(start, start + size)
    offset = start + Math.ceil(size / 512) * 512
    if (type === "x" || type === "L") {
      longName = type === "L" ? cString(body, 0, body.length) : paxPath(body)
      continue
    }
    if (type === "g") continue
    const prefix =
      text.decode(header.subarray(257, 262)) === "ustar" ? cString(header, 345, 155) : ""
    const name = cString(header, 0, 100)
    const path = longName ?? (prefix === "" ? name : `${prefix}/${name}`)
    longName = undefined
    if (type === "5") continue
    yield { path, file: type === "0" || type === "\0", bytes: () => body }
  }
}

function* zipEntries(zip: Uint8Array): Generator<Entry> {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength)
  let end = -1
  for (let at = zip.length - 22; at >= Math.max(0, zip.length - 22 - 0xffff); at--) {
    if (view.getUint32(at, true) === 0x06054b50) {
      end = at
      break
    }
  }
  if (end === -1) return refuse(notAnArchive)
  const count = view.getUint16(end + 10, true)
  const directoryOffset = view.getUint32(end + 16, true)
  if (count === 0xffff || directoryOffset === 0xffffffff) {
    return refuse("The .zip archive is a Zip64 one, which the Hub doesn't read.")
  }
  let at = directoryOffset
  for (let index = 0; index < count; index++) {
    if (at + 46 > zip.length || view.getUint32(at, true) !== 0x02014b50) refuse(notAnArchive)
    const flags = view.getUint16(at + 8, true)
    const method = view.getUint16(at + 10, true)
    const packed = view.getUint32(at + 20, true)
    const size = view.getUint32(at + 24, true)
    const nameLength = view.getUint16(at + 28, true)
    const extraLength = view.getUint16(at + 30, true)
    const commentLength = view.getUint16(at + 32, true)
    const mode = view.getUint32(at + 38, true) >>> 16
    const local = view.getUint32(at + 42, true)
    const path = text.decode(zip.subarray(at + 46, at + 46 + nameLength))
    at += 46 + nameLength + extraLength + commentLength
    if (path.endsWith("/")) continue
    // Unix modes, when the zip records them: only a regular file counts.
    const regular = mode === 0 || (mode & 0o170000) === 0o100000
    yield {
      path,
      file: regular && (flags & 1) === 0 && (method === 0 || method === 8),
      bytes: () => {
        if (local + 30 > zip.length || view.getUint32(local, true) !== 0x04034b50)
          refuse(notAnArchive)
        const start =
          local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true)
        if (start + packed > zip.length) refuse(notAnArchive)
        const data = zip.subarray(start, start + packed)
        if (method === 0) return data
        try {
          return inflateRawSync(data, {
            maxOutputLength: Math.min(size, MaxPluginPackageFileBytes) + 1,
          })
        } catch {
          return refuse(notAnArchive)
        }
      },
    }
  }
}

const isGzip = (bytes: Uint8Array) => bytes[0] === 0x1f && bytes[1] === 0x8b
const isZip = (bytes: Uint8Array) =>
  bytes[0] === 0x50 && bytes[1] === 0x4b && (bytes[2] === 3 || bytes[2] === 5)

/** The archive's entries, unpacked in memory to at most {@link MaxUnpackedBytes}. */
function entriesOf(bytes: Uint8Array): Iterable<Entry> {
  if (isZip(bytes)) return zipEntries(bytes)
  if (!isGzip(bytes)) return refuse(notAnArchive)
  let tar: Uint8Array
  try {
    tar = gunzipSync(bytes, { maxOutputLength: MaxUnpackedBytes })
  } catch (error) {
    return refuse(
      error instanceof RangeError || (error as { code?: string }).code === "ERR_BUFFER_TOO_LARGE"
        ? `The archive unpacks to more than ${MaxUnpackedBytes / 1024 / 1024} MiB.`
        : notAnArchive,
    )
  }
  return tarEntries(tar)
}

/** What macOS adds to the archives it makes, which is no part of the package: `._x`, `__MACOSX/`. */
const macOsMetadata = /(?:^|\/)\._[^/]*$|^__MACOSX(?:\/|$)/

/** The package's two files from an uploaded archive, or why it is refused. */
export function readPackageArchive(bytes: Uint8Array): Result.Result<PackageFiles, string> {
  try {
    const entries = new Map<string, Entry>()
    let count = 0
    for (const entry of entriesOf(bytes)) {
      if (++count > MaxEntries) refuse(`The archive holds more than ${MaxEntries} files.`)
      const path = entryPath(entry.path)
      if (path === "" || macOsMetadata.test(path)) continue
      if (entries.has(path)) refuse(`The archive holds ${entry.path} twice.`)
      entries.set(path, entry)
    }
    const tops = new Set([...entries.keys()].map((path) => path.split("/")[0]))
    const [top] = tops
    const root = entries.has("package.json")
      ? ""
      : tops.size === 1 && top !== undefined && entries.has(`${top}/package.json`)
        ? `${top}/`
        : refuse("The archive has no package.json at its root or in its one top-level folder.")
    const manifestEntry = entries.get(`${root}${PluginManifestFile}`)
    if (manifestEntry === undefined) {
      return refuse(`The archive has no ${PluginManifestFile} beside its package.json.`)
    }
    const fileText = (entry: Entry, name: string) => {
      if (!entry.file) refuse(`The archive's ${name} isn't a file.`)
      const content = entry.bytes()
      if (content.length > MaxPluginPackageFileBytes) {
        refuse(`The archive's ${name} is larger than ${MaxPluginPackageFileBytes / 1024} KiB.`)
      }
      return typeof content === "string" ? content : text.decode(content)
    }
    return Result.succeed({
      packageJson: fileText(entries.get(`${root}package.json`) as Entry, "package.json"),
      manifest: fileText(manifestEntry, PluginManifestFile),
    })
  } catch (error) {
    if (error instanceof Refusal) return Result.fail(error.message)
    return Result.fail(notAnArchive)
  }
}
