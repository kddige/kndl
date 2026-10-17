import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import {
  chmodSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs"
import * as fsPromises from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { allocatedBytes, DiskUsageConcurrency } from "./DiskUsage.ts"

const MiB = 1024 * 1024

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "kndl-disk-usage-"))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

/** Bytes that don't compress or dedupe away, so the file really takes its blocks. */
const filled = (bytes: number) => Buffer.alloc(bytes, 0xab)

describe("allocatedBytes", () => {
  test("is 0 for a path that isn't there", async () => {
    expect(await allocatedBytes(join(root, "gone"))).toBe(0)
  })

  test("counts a file's allocated blocks, at least its length", async () => {
    writeFileSync(join(root, "a"), filled(MiB))
    const bytes = await allocatedBytes(join(root, "a"))
    expect(bytes).toBeGreaterThanOrEqual(MiB)
    expect(bytes).toBeLessThan(MiB + 64 * 1024)
  })

  test("counts what a sparse file has allocated, not its length", async () => {
    const path = join(root, "disk.raw")
    writeFileSync(path, filled(4096))
    truncateSync(path, 512 * MiB)
    expect(await allocatedBytes(path)).toBeLessThan(MiB)
  })

  test("adds up a whole tree, directories included", async () => {
    mkdirSync(join(root, "a", "b"), { recursive: true })
    writeFileSync(join(root, "one"), filled(MiB))
    writeFileSync(join(root, "a", "two"), filled(MiB))
    writeFileSync(join(root, "a", "b", "three"), filled(MiB))
    const bytes = await allocatedBytes(root)
    expect(bytes).toBeGreaterThanOrEqual(3 * MiB)
    expect(bytes).toBeLessThan(3 * MiB + 256 * 1024)
  })

  test("counts a file hard-linked twice once", async () => {
    writeFileSync(join(root, "a"), filled(MiB))
    linkSync(join(root, "a"), join(root, "b"))
    expect(await allocatedBytes(root)).toBeLessThan(2 * MiB)
  })

  test("doesn't follow a symlink out of the tree", async () => {
    const outside = mkdtempSync(join(tmpdir(), "kndl-disk-usage-outside-"))
    try {
      writeFileSync(join(outside, "big"), filled(4 * MiB))
      symlinkSync(outside, join(root, "link"))
      symlinkSync(join(outside, "big"), join(root, "linked-file"))
      expect(await allocatedBytes(root)).toBeLessThan(MiB)
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })

  test("skips what it can't read instead of failing", async () => {
    mkdirSync(join(root, "locked"))
    writeFileSync(join(root, "locked", "x"), filled(MiB))
    writeFileSync(join(root, "open"), filled(MiB))
    chmodSync(join(root, "locked"), 0o000)
    try {
      // Running as root reads it anyway; either way it doesn't throw.
      expect(await allocatedBytes(root)).toBeGreaterThanOrEqual(MiB)
    } finally {
      chmodSync(join(root, "locked"), 0o700)
    }
  })

  test("looks at only so many paths at once in the whole tree, however deep and wide", async () => {
    // Wide and three deep: walked a directory's entries at a time at each level, it would look at
    // hundreds at once.
    for (let a = 0; a < 10; a++) {
      for (let b = 0; b < 10; b++) {
        mkdirSync(join(root, `a${a}`, `b${b}`), { recursive: true })
        for (let c = 0; c < 10; c++) writeFileSync(join(root, `a${a}`, `b${b}`, `c${c}`), "x")
      }
    }
    const { lstat } = fsPromises
    let looking = 0
    let most = 0
    let looked = 0
    const spy = spyOn(fsPromises, "lstat").mockImplementation((async (path: string) => {
      looking++
      looked++
      most = Math.max(most, looking)
      try {
        // A slow disk, so the walk has the chance to pile up.
        await new Promise((resolve) => setTimeout(resolve, 1))
        return await lstat(path)
      } finally {
        looking--
      }
    }) as typeof lstat)
    try {
      const bytes = await allocatedBytes(root)
      // The root, 10 + 100 directories and 1000 files, each counted.
      expect(looked).toBe(1 + 10 + 100 + 1000)
      expect(bytes).toBeGreaterThan(0)
      expect(most).toBeLessThanOrEqual(DiskUsageConcurrency)
    } finally {
      spy.mockRestore()
    }
  })
})
