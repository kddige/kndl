import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { deflateRawSync, gzipSync } from "node:zlib"
import { Result } from "effect"
import { readPackageArchive } from "./PluginArchive.ts"

const packageJson = JSON.stringify({ name: "linear-mcp", version: "1.0.0" })
const manifest = JSON.stringify({
  displayName: "Linear",
  mcp: { url: "https://mcp.linear.app/mcp" },
})

interface Entry {
  readonly name: string
  readonly content?: string | Uint8Array
  /** The tar typeflag: `0` a file, `5` a folder, `2` a symlink. */
  readonly type?: string
  readonly link?: string
}

/** A tar archive of the entries, as `npm pack` writes one, without the gzip. */
function tar(entries: ReadonlyArray<Entry>): Uint8Array {
  const blocks: Array<Uint8Array> = []
  const encoder = new TextEncoder()
  for (const entry of entries) {
    const content =
      typeof entry.content === "string"
        ? encoder.encode(entry.content)
        : (entry.content ?? new Uint8Array())
    const header = new Uint8Array(512)
    const put = (offset: number, text: string) => header.set(encoder.encode(text), offset)
    put(0, entry.name)
    put(100, "0000644\0")
    put(108, "0000000\0")
    put(116, "0000000\0")
    put(124, `${content.length.toString(8).padStart(11, "0")}\0`)
    put(136, "00000000000\0")
    put(148, "        ")
    put(156, entry.type ?? "0")
    if (entry.link !== undefined) put(157, entry.link)
    put(257, "ustar\0")
    put(263, "00")
    const sum = header.reduce((total, byte) => total + byte, 0)
    put(148, `${sum.toString(8).padStart(6, "0")}\0 `)
    blocks.push(header, content, new Uint8Array((512 - (content.length % 512)) % 512))
  }
  blocks.push(new Uint8Array(1024))
  return Buffer.concat(blocks)
}

const tgz = (entries: ReadonlyArray<Entry>) => gzipSync(tar(entries))

/** A zip archive of the entries, deflated, as GitHub's "Download ZIP" writes one. */
function zip(
  entries: ReadonlyArray<{
    readonly name: string
    readonly content: string
    readonly stored?: boolean
  }>,
): Uint8Array {
  const locals: Array<Buffer> = []
  const centrals: Array<Buffer> = []
  let offset = 0
  for (const entry of entries) {
    const name = Buffer.from(entry.name)
    const raw = Buffer.from(entry.content)
    const data = entry.stored === true ? raw : deflateRawSync(raw)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(entry.stored === true ? 0 : 8, 8)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(raw.length, 22)
    local.writeUInt16LE(name.length, 26)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(entry.stored === true ? 0 : 8, 10)
    central.writeUInt32LE(data.length, 20)
    central.writeUInt32LE(raw.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE(offset, 42)
    locals.push(local, name, data)
    centrals.push(central, name)
    offset += local.length + name.length + data.length
  }
  const directory = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(directory.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, directory, end])
}

const read = (bytes: Uint8Array) => readPackageArchive(bytes)

const refusal = (bytes: Uint8Array) => {
  const result = read(bytes)
  if (Result.isSuccess(result)) throw new Error("expected a refusal")
  return result.failure
}

const archiveWith = (icon: string, extra: ReadonlyArray<Entry> = []) =>
  readPackageArchive(
    tgz([
      { name: "package.json", content: packageJson },
      {
        name: "kndl.json",
        content: JSON.stringify({ displayName: "L", mcp: { url: "https://a.test/" }, icon }),
      },
      ...extra,
    ]),
  )

describe("a package's icon file (#230)", () => {
  const withIcon = JSON.stringify({
    displayName: "Linear",
    mcp: { url: "https://mcp.linear.app/mcp" },
    icon: "assets/logo.svg",
  })
  const logo = new TextEncoder().encode("<svg/>")

  test("is read from the archive's package folder, in a .tgz and a .zip", () => {
    const fromTgz = Result.getOrThrow(
      readPackageArchive(
        tgz([
          { name: "package/package.json", content: packageJson },
          { name: "package/kndl.json", content: withIcon },
          { name: "package/assets/logo.svg", content: logo },
        ]),
      ),
    )
    expect(fromTgz.iconFile).toEqual(logo)
    const fromZip = Result.getOrThrow(
      readPackageArchive(
        zip([
          { name: "repo-main/package.json", content: packageJson },
          { name: "repo-main/kndl.json", content: withIcon },
          { name: "repo-main/assets/logo.svg", content: "<svg/>" },
        ]),
      ),
    )
    expect(fromZip.iconFile).toEqual(logo)
  })

  test("is left out, never refusing the archive, when missing, too large or outside it", () => {
    for (const result of [
      archiveWith("assets/logo.svg"),
      archiveWith("../logo.svg"),
      archiveWith("big.png", [{ name: "big.png", content: new Uint8Array(512 * 1024 + 1) }]),
    ]) {
      expect(Result.getOrThrow(result).iconFile).toBeUndefined()
    }
  })
})

describe("a .tgz", () => {
  test("is read for its package.json and kndl.json in npm pack's package folder", () => {
    expect(
      Result.getOrThrow(
        read(
          tgz([
            { name: "package/", type: "5" },
            { name: "package/package.json", content: packageJson },
            { name: "package/kndl.json", content: manifest },
            { name: "package/dist/index.js", content: "process.exit(1)" },
          ]),
        ),
      ),
    ).toEqual({ packageJson, manifest })
  })

  test("is read at its root, too", () => {
    expect(
      Result.getOrThrow(
        read(
          tgz([
            { name: "./package.json", content: packageJson },
            { name: "./kndl.json", content: manifest },
          ]),
        ),
      ),
    ).toEqual({ packageJson, manifest })
  })

  test("is refused a path outside it, or an absolute one", () => {
    expect(
      refusal(
        tgz([
          { name: "package/package.json", content: packageJson },
          { name: "package/../../etc/kndl.json", content: manifest },
        ]),
      ),
    ).toBe("The archive holds package/../../etc/kndl.json, a path outside it.")
    expect(refusal(tgz([{ name: "/etc/passwd", content: "x" }]))).toBe(
      "The archive holds /etc/passwd, a path outside it.",
    )
  })

  test("never follows a symlink to the files", () => {
    expect(
      refusal(
        tgz([
          { name: "package/package.json", content: packageJson },
          { name: "package/kndl.json", type: "2", link: "/etc/passwd" },
        ]),
      ),
    ).toBe("The archive's kndl.json isn't a file.")
  })

  test("is refused without both files, or with either twice", () => {
    expect(refusal(tgz([{ name: "package/kndl.json", content: manifest }]))).toBe(
      "The archive has no package.json at its root or in its one top-level folder.",
    )
    expect(refusal(tgz([{ name: "package/package.json", content: packageJson }]))).toBe(
      "The archive has no kndl.json beside its package.json.",
    )
    expect(
      refusal(
        tgz([
          { name: "package/package.json", content: packageJson },
          { name: "package/kndl.json", content: manifest },
          { name: "package/kndl.json", content: "{}" },
        ]),
      ),
    ).toBe("The archive holds package/kndl.json twice.")
  })

  test("is refused a file over 64 KiB", () => {
    expect(
      refusal(
        tgz([
          { name: "package/package.json", content: packageJson },
          { name: "package/kndl.json", content: " ".repeat(64 * 1024 + 1) },
        ]),
      ),
    ).toBe("The archive's kndl.json is larger than 64 KiB.")
  })

  test("is refused when it unpacks to more than the limit, however small it is packed", () => {
    expect(
      refusal(
        tgz([
          { name: "package/big", content: new Uint8Array(40 * 1024 * 1024) },
          { name: "package/package.json", content: packageJson },
          { name: "package/kndl.json", content: manifest },
        ]),
      ),
    ).toBe("The archive unpacks to more than 32 MiB.")
  })
})

describe("a .zip", () => {
  test("is read in GitHub's one top-level folder, deflated or stored", () => {
    expect(
      Result.getOrThrow(
        read(
          zip([
            { name: "linear-mcp-main/", content: "", stored: true },
            { name: "linear-mcp-main/package.json", content: packageJson },
            { name: "linear-mcp-main/kndl.json", content: manifest, stored: true },
          ]),
        ),
      ),
    ).toEqual({ packageJson, manifest })
  })

  test("is refused a path outside it", () => {
    expect(
      refusal(
        zip([
          { name: "package.json", content: packageJson },
          { name: "..\\kndl.json", content: manifest },
        ]),
      ),
    ).toBe("The archive holds ..\\kndl.json, a path outside it.")
  })
})

test("archives tar and zip make are read", () => {
  const dir = mkdtempSync(join(tmpdir(), "kndl-archive-"))
  try {
    mkdirSync(join(dir, "linear-mcp", "src"), { recursive: true })
    writeFileSync(join(dir, "linear-mcp", "package.json"), packageJson)
    writeFileSync(join(dir, "linear-mcp", "kndl.json"), manifest)
    writeFileSync(join(dir, "linear-mcp", "src", "index.js"), "export {}")
    for (const command of [
      ["tar", "-czf", "linear.tgz", "linear-mcp"],
      ["zip", "-qr", "linear.zip", "linear-mcp"],
    ]) {
      expect(Bun.spawnSync(command, { cwd: dir }).exitCode).toBe(0)
    }
    for (const archive of ["linear.tgz", "linear.zip"]) {
      expect(Result.getOrThrow(read(readFileSync(join(dir, archive))))).toEqual({
        packageJson,
        manifest,
      })
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("anything else is refused", () => {
  expect(refusal(new TextEncoder().encode("hello"))).toBe(
    "That isn't a .tgz or .zip archive, such as npm pack or GitHub's Download ZIP makes.",
  )
  expect(refusal(zip([]).subarray(0, 10))).toBe(
    "That isn't a .tgz or .zip archive, such as npm pack or GitHub's Download ZIP makes.",
  )
})
