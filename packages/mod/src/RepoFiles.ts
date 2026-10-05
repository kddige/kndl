// The Repo's skills and CLAUDE.md, as the Runner copied them out of the Sandbox (the Runner's
// RepoFiles.ts, ADR 0001 as amended in #125). The Runner writes them, already read inside the
// Workspace and defused, to a directory it names in CLAUDE_HUB_REPO_FILES:
//
// - `instructions.json`: the Repo's instruction files, `@` imports resolved, by their paths in the
//   Sandbox. The mod puts them in Claude Code's context in place of any from the host.
// - `.claude/`: a plugin of the Repo's skills, which Claude Code loads with `--plugin-dir`. Their
//   base directory is the copy on the host; the mod points the model at the Workspace instead.

/** The file in the Repo files directory that lists the Repo's instruction files. */
export const repoInstructionsFile = "instructions.json"

/** One of the Repo's instruction files: its path in the Sandbox, and its text. */
export interface RepoInstruction {
  readonly path: string
  readonly content: string
  /** The file whose `@` import brought this one in. */
  readonly parent?: string
}

/** The fields of Claude Code's InstructionFile the mod looks at. */
interface InstructionFileLike {
  readonly path: string
  readonly kind: string
  readonly content: string
  readonly parent?: string
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const isInstruction = (value: unknown): value is RepoInstruction =>
  isRecord(value) &&
  typeof value.path === "string" &&
  value.path.startsWith("/") &&
  typeof value.content === "string" &&
  (value.parent === undefined || typeof value.parent === "string")

/**
 * The instruction files in the Runner's `instructions.json`. Any that isn't one, or a file that
 * isn't the list, is left out: the Session goes on without the Repo's instructions.
 */
export const parseRepoInstructions = (text: string): ReadonlyArray<RepoInstruction> => {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return []
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.instructions)) return []
  return parsed.instructions.filter(isInstruction).map((file) => ({
    path: file.path,
    content: file.content,
    ...(file.parent === undefined ? {} : { parent: file.parent }),
  }))
}

/**
 * The instruction files the Session's context carries: the organization's managed policy, which
 * Claude Code loads from the host, then the Repo's. Any other file Claude Code found on the host
 * (the person's own, a project's beside an added directory, memory) is left out: the Session's
 * project is the Repo in the Sandbox.
 */
export const withRepoInstructions = <F extends InstructionFileLike>(
  loaded: ReadonlyArray<F>,
  repo: ReadonlyArray<RepoInstruction>,
): Array<F | (RepoInstruction & { readonly kind: "project" })> => [
  ...loaded.filter((file) => file.kind === "managed"),
  ...repo.map((file) => ({ ...file, kind: "project" as const })),
]

const zeroWidthSpace = "\u200B"

/** Said after a Repo skill the Runner defused, so the model doesn't copy what it put in. */
export const defusedSkillNote =
  "(Claude Hub put a zero-width space (U+200B) before each @ sign and between each ! and backtick in this skill, so that nothing in it runs or is read on the host. Leave those out of any command or file you write from it.)"

/**
 * A Repo skill's prompt, pointing at the skill in the Workspace rather than at the copy on the host
 * Claude Code loaded it from: its base directory, and `${CLAUDE_SKILL_DIR}` as Claude Code
 * expanded it. The model's tools run in the Sandbox, where the skill's other files are. Any other
 * skill's prompt is left as it is.
 */
export const skillInWorkspace = (text: string, repoFiles: string, workspace: string): string => {
  const copy = `${repoFiles.replace(/\/+$/, "")}/`
  if (!text.includes(copy)) return text
  const moved = text.replaceAll(copy, `${workspace.replace(/\/+$/, "")}/`)
  return moved.includes(zeroWidthSpace) ? `${moved}\n\n${defusedSkillNote}` : moved
}
