import { expect, test } from "bun:test"
import {
  firstArea,
  nextVersion,
  parseTag,
  previousRelease,
  releaseNotes,
  tagProblem,
} from "./release.ts"

test("a Release tag is vYEAR.MONTH.N with no zero-padding", () => {
  expect(parseTag("v2026.10.1")).toEqual({ year: 2026, month: 10, n: 1 })
  expect(parseTag("v2026.1.12")).toEqual({ year: 2026, month: 1, n: 12 })
  for (const tag of [
    "2026.10.1",
    "v2026.01.1",
    "v2026.10.01",
    "v2026.13.1",
    "v2026.10.0",
    "v2026.10.1-beta.1",
  ])
    expect(parseTag(tag)).toBeUndefined()
})

test("the next version counts the month's Releases from 1", () => {
  const now = new Date("2026-10-12T12:00:00Z")
  expect(nextVersion([], now)).toEqual({ year: 2026, month: 10, n: 1 })
  expect(nextVersion(["v2026.9.4", "v2026.10.1", "v2026.10.2", "old-tag"], now)).toEqual({
    year: 2026,
    month: 10,
    n: 3,
  })
  expect(nextVersion(["v2026.9.4"], now)).toEqual({ year: 2026, month: 10, n: 1 })
})

test("a tag is refused unless it is a Release tag newer than every Release", () => {
  expect(tagProblem("v2026.10.2", ["v2026.10.1", "v2026.10.2"])).toBeUndefined()
  expect(tagProblem("v2026.10.1", [])).toBeUndefined()
  expect(tagProblem("v2026.10.01", [])).toContain("not a Release tag")
  expect(tagProblem("v2026.10.1", ["v2026.10.2"])).toContain(
    "not newer than the Release v2026.10.2",
  )
  expect(tagProblem("v2026.9.9", ["v2026.10.1"])).toContain("v2026.10.1")
})

test("notes start at the Release before the tag", () => {
  const tags = ["v2026.9.1", "v2026.10.1", "v2026.10.2"]
  expect(previousRelease("v2026.10.2", tags)).toBe("v2026.10.1")
  expect(previousRelease("v2026.10.3", tags)).toBe("v2026.10.2")
  expect(previousRelease("v2026.9.1", tags)).toBeUndefined()
})

test("a title's first area is the one its notes list it under", () => {
  expect(firstArea("web, hub: attachments 3, in steered prompts (#278)")).toBe("web")
  expect(firstArea("ci: a release workflow (#293)")).toBe("ci")
  expect(firstArea("feat(hub): something")).toBeUndefined()
  expect(firstArea("Keep awake: a toggle")).toBeUndefined()
  expect(firstArea("hub, sessions: not an area")).toBeUndefined()
  expect(firstArea("Merge pull request #213 from kddige/x")).toBeUndefined()
})

test("notes group subjects by first area, in the areas' order, with Other last", () => {
  const notes = releaseNotes(
    [
      "web: long pastes show as a chip (#279)",
      "chore: bump things",
      "hub, web: Plugin icons (#230)",
      "web, hub: attachments 3 (#278)",
    ],
    "v2026.10.1",
  )
  expect(notes).toBe(
    [
      "## Highlights",
      "",
      "<!-- A few lines, by hand, on what matters most. -->",
      "",
      "## hub",
      "",
      "- hub, web: Plugin icons (#230)",
      "",
      "## web",
      "",
      "- web: long pastes show as a chip (#279)",
      "- web, hub: attachments 3 (#278)",
      "",
      "## Other",
      "",
      "- chore: bump things",
      "",
      "**Changes since v2026.10.1**",
      "",
    ].join("\n"),
  )
})

test("the first Release lists no history", () => {
  expect(releaseNotes(["hub: anything"], undefined)).toContain("The first Release of kndl.")
  expect(releaseNotes(["hub: anything"], undefined)).not.toContain("## hub")
})
