// Checks a pull request title against ADR 0025: `<areas>: <change> (#<issue>)`, where <areas> is
// one or more of `Areas`, comma-separated, main area first. The issue is optional. Squashing
// makes the title main's commit title, and the release notes group by its first area.
// Run in CI as `PR_TITLE=... bun scripts/pr-title.ts`.

export const Areas = [
  "hub",
  "runner",
  "web",
  "cli",
  "mod",
  "protocol",
  "docs",
  "brand",
  "ci",
  "repo",
] as const

export const Shape = "<areas>: <change> (#<issue>)"

/** Why `title` breaks the rule, or undefined when it follows it. */
export const checkTitle = (title: string): string | undefined => {
  const colon = title.indexOf(": ")
  if (colon < 0) return `It doesn't start with its areas and ": ".`
  const areas = title.slice(0, colon).split(", ")
  const unknown = areas.filter((area) => !(Areas as ReadonlyArray<string>).includes(area))
  if (unknown.length > 0) return `${unknown.map((area) => `"${area}"`).join(", ")} is not an area.`
  if (new Set(areas).size !== areas.length) return "An area is listed twice."
  if (title.slice(colon + 2).trim() === "") return "It says no change after the areas."
  return undefined
}

if (import.meta.main) {
  const title = process.env.PR_TITLE ?? ""
  const problem = checkTitle(title)
  if (problem !== undefined) {
    console.error(`The pull request title "${title}" doesn't follow ADR 0025. ${problem}`)
    console.error(`Expected: ${Shape}, like "web, hub: attachments 3, in steered prompts (#278)".`)
    console.error(
      `Areas, comma-separated, main area first: ${Areas.join(", ")}. The issue is optional.`,
    )
    process.exit(1)
  }
  console.log(`"${title}" follows ADR 0025.`)
}
