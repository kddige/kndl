import { expect, test } from "bun:test"
import type { SessionId } from "@kndl/protocol"
import { freedBy, freedText, sizeText } from "../src/sessions/diskSizes.ts"

const GiB = 1024 ** 3
const a = "s-a" as SessionId
const b = "s-b" as SessionId
const c = "s-c" as SessionId
const fresh = "s-new" as SessionId

test("adds up the sizes that are known, and counts those that aren't", () => {
  const sizes = new Map<SessionId, number | null>([
    [a, 2 * GiB],
    [b, null],
    [c, GiB],
  ])
  expect(freedBy([a, c], sizes)).toEqual({ bytes: 3 * GiB, unknown: 0, measuring: 0, count: 2 })
  expect(freedBy([a, b, c], sizes)).toEqual({ bytes: 3 * GiB, unknown: 1, measuring: 0, count: 3 })
  // One the Hub hasn't answered for yet is being measured, not unknown.
  expect(freedBy([a, fresh], sizes)).toEqual({
    bytes: 2 * GiB,
    unknown: 0,
    measuring: 1,
    count: 2,
  })
})

test("says what purging frees in words", () => {
  expect(freedText({ bytes: 3.4 * GiB, unknown: 0, measuring: 0, count: 2 })).toBe("Frees 3.4 GiB")
  expect(freedText({ bytes: 3.4 * GiB, unknown: 1, measuring: 0, count: 3 })).toBe(
    "Frees at least 3.4 GiB (1 size unknown)",
  )
  expect(freedText({ bytes: GiB, unknown: 2, measuring: 0, count: 3 })).toBe(
    "Frees at least 1.0 GiB (2 sizes unknown)",
  )
  expect(freedText({ bytes: 0, unknown: 2, measuring: 0, count: 2 })).toBe("Disk use unknown")
  expect(freedText({ bytes: GiB, unknown: 0, measuring: 1, count: 2 })).toBe("Measuring disk use…")
})

test("shows one Session's size, unknown, or being measured", () => {
  expect(sizeText(1536 * 1024 ** 2)).toBe("1.5 GiB")
  expect(sizeText(0)).toBe("0 B")
  expect(sizeText(null)).toBe("Size unknown")
  expect(sizeText(undefined)).toBe("Measuring…")
})
