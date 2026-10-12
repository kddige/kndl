// Release tooling (ADR 0025): checks a Release tag, names the next one, and builds its notes from
// the squash-merged PR titles since the last Release.
//
//   bun scripts/release.ts next           the next version, from today's date and the tags
//   bun scripts/release.ts check <tag>    fails unless <tag> may be released
//   bun scripts/release.ts notes <tag>    the notes for <tag> (or for HEAD, if <tag> isn't made yet)

import { Areas, checkTitle } from "./pr-title.ts"

export interface Version {
  readonly year: number
  readonly month: number
  readonly n: number
}

/** `v2026.10.1` to its parts; undefined for anything else, zero-padded parts included. */
export const parseTag = (tag: string): Version | undefined => {
  const match = /^v([1-9]\d{3})\.([1-9]|1[0-2])\.([1-9]\d*)$/.exec(tag)
  if (!match) return undefined
  return { year: Number(match[1]), month: Number(match[2]), n: Number(match[3]) }
}

export const formatTag = (v: Version): string => `v${v.year}.${v.month}.${v.n}`

export const compareVersions = (a: Version, b: Version): number =>
  a.year - b.year || a.month - b.month || a.n - b.n

const releases = (tags: ReadonlyArray<string>): Array<{ tag: string; version: Version }> =>
  tags
    .flatMap((tag) => {
      const version = parseTag(tag)
      return version ? [{ tag, version }] : []
    })
    .toSorted((a, b) => compareVersions(a.version, b.version))

/** The next version in `now`'s month: n counts the month's Releases, starting at 1. */
export const nextVersion = (tags: ReadonlyArray<string>, now: Date): Version => {
  const year = now.getUTCFullYear()
  const month = now.getUTCMonth() + 1
  const inMonth = releases(tags).filter((r) => r.version.year === year && r.version.month === month)
  return { year, month, n: (inMonth.at(-1)?.version.n ?? 0) + 1 }
}

/** Why `tag` can't be released next to the existing `tags`, or undefined if it can. */
export const tagProblem = (tag: string, tags: ReadonlyArray<string>): string | undefined => {
  const version = parseTag(tag)
  if (!version)
    return `${tag} is not a Release tag: it must look like v2026.10.1, with no zero-padding.`
  const newer = releases(tags).find(
    (r) => r.tag !== tag && compareVersions(r.version, version) >= 0,
  )
  if (newer) return `${tag} is not newer than the Release ${newer.tag}.`
  return undefined
}

/** The Release before `tag`, which its notes start from. */
export const previousRelease = (tag: string, tags: ReadonlyArray<string>): string | undefined => {
  const version = parseTag(tag)
  return releases(tags)
    .filter((r) => !version || compareVersions(r.version, version) < 0)
    .at(-1)?.tag
}

/** The first area of a title that follows the PR title rule, or undefined. */
export const firstArea = (subject: string): (typeof Areas)[number] | undefined => {
  if (checkTitle(subject) !== undefined) return undefined
  return subject.slice(0, subject.indexOf(": ")).split(", ")[0] as (typeof Areas)[number]
}

/**
 * The notes for a Release: a Highlights placeholder, then each commit subject under its first
 * area, in `Areas`' order, and the ones that follow no convention under Other. With no previous
 * Release there is nothing to list: history before the first one is never grouped.
 */
export const releaseNotes = (
  subjects: ReadonlyArray<string>,
  previous: string | undefined,
): string => {
  const lines = ["## Highlights", "", "<!-- A few lines, by hand, on what matters most. -->", ""]
  if (previous === undefined) return [...lines, "The first Release of kndl.", ""].join("\n")
  const groups = new Map<string, Array<string>>()
  for (const subject of subjects) {
    const group = firstArea(subject) ?? "Other"
    groups.set(group, [...(groups.get(group) ?? []), subject])
  }
  for (const group of [...Areas, "Other"]) {
    const items = groups.get(group)
    if (!items) continue
    lines.push(`## ${group}`, "", ...items.map((subject) => `- ${subject}`), "")
  }
  if (groups.size === 0) lines.push("No changes since the last Release.", "")
  lines.push(`**Changes since ${previous}**`, "")
  return lines.join("\n")
}

const git = (...args: Array<string>): string => {
  const result = Bun.spawnSync(["git", ...args], { stderr: "pipe" })
  if (!result.success) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString().trim()}`)
  return result.stdout.toString().trim()
}

const lines = (text: string): Array<string> => text.split("\n").filter((line) => line !== "")

const main = (args: ReadonlyArray<string>): number => {
  const [command, tag] = args
  const tags = lines(git("tag", "--list", "v*"))
  if (command === "next") {
    console.log(formatTag(nextVersion(tags, new Date())))
    return 0
  }
  if (command === "check" && tag) {
    const problem = tagProblem(tag, tags)
    if (problem) {
      console.error(problem)
      return 1
    }
    return 0
  }
  if (command === "notes" && tag) {
    const to = tags.includes(tag) ? tag : "HEAD"
    const previous = previousRelease(tag, tags)
    const subjects = previous
      ? lines(git("log", "--first-parent", "--format=%s", `${previous}..${to}`))
      : []
    process.stdout.write(releaseNotes(subjects, previous))
    return 0
  }
  console.error("Usage: bun scripts/release.ts next | check <tag> | notes <tag>")
  return 2
}

if (import.meta.main) process.exit(main(process.argv.slice(2)))
