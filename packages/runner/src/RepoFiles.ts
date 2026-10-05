// The Repo's skills and CLAUDE.md, copied out of the Sandbox for the Claude Code on the host
// (#125, ADR 0001's amendment).
//
// Claude Code runs with `--setting-sources ""`, which loads no project file at all: the project
// source that would load skills and CLAUDE.md also loads `.claude/settings.json`, hooks and all.
// So when a Session starts or wakes, the Runner reads them from the Workspace through the Sandbox,
// never from the host's copy of it, and writes what it read to the Session's Repo files directory:
//
//   <session>/repo/instructions.json            CLAUDE.md and `.claude/CLAUDE.md`, with their
//                                               `@` imports, which the mod adds to the context
//   <session>/repo/.claude/.claude-plugin/...    a plugin, loaded with `--plugin-dir`, whose
//   <session>/repo/.claude/skills/<name>/SKILL.md  skills are the Repo's
//
// Only regular files are read: a path with a symbolic link anywhere along it is skipped, and so is
// a file too large, not UTF-8 text, or past a limit. `@` imports are resolved here, inside the
// Workspace, and the `@`s left in the instructions' prose are defused, so Claude Code never
// resolves one against the host. A skill's whole text is defused, `@`s and inline shell commands,
// since Claude Code looks for both everywhere in it, and it keeps only its name and the frontmatter
// fields that describe it: never `hooks`, `allowed-tools`, `model` or any other.

import { mkdir, rm, writeFile } from "node:fs/promises"
import { join, posix } from "node:path"
import type { SessionId } from "@claude-hub/protocol"
import { Effect } from "effect"
import { type InstructionFile, type RepoFiles, SandboxError, type Skill } from "./Sandbox.ts"
import type { SandboxBackendShape } from "./sandbox/SandboxBackend.ts"
import { workspaceGuestPath } from "./sandbox/SessionLayout.ts"

/** How much of the Repo is copied. */
export const RepoFileLimits = {
  /** The largest file read: a CLAUDE.md, an import, or a SKILL.md. */
  fileBytes: 64 * 1024,
  /** All the instruction files together, imports included. */
  instructionBytes: 256 * 1024,
  /** How deep imports go, as in Claude Code. */
  importDepth: 5,
  /** Imported files in all. */
  imports: 32,
  /** Skills, by name. */
  skills: 64,
} as const

/** A file read from the Workspace. */
export type FileRead =
  | { readonly _tag: "Read"; readonly text: string }
  | { readonly _tag: "Missing" }
  | { readonly _tag: "Skipped"; readonly reason: string }

/** The Workspace as the Sandbox sees it. Paths are relative to it and normal. */
export interface WorkspaceFiles {
  /**
   * The names of the directories in a directory, leaving out symbolic links and hidden entries;
   * none when the directory is missing or a symbolic link is along its path.
   */
  readonly directories: (path: string) => Effect.Effect<ReadonlyArray<string>, SandboxError>
  /** Each file as text, when it is a regular file, no link is along its path, and it fits. */
  readonly read: (
    paths: ReadonlyArray<string>,
    maxBytes: number,
  ) => Effect.Effect<ReadonlyArray<FileRead>, SandboxError>
}

// --- Defusing --------------------------------------------------------------------------------

const zeroWidthSpace = "\u200B"

/**
 * `text` with nothing Claude Code acts on: a zero-width space goes before every `@`, which ends
 * both its CLAUDE.md import and its `@` file mention (each needs the `@` at the start or after
 * whitespace, and a zero-width space is not whitespace to them), and between `!` and a backtick
 * either way round, which ends an inline shell command (`` !`cmd` ``) and a shell block
 * (```` ```! ````). The text reads the same.
 */
export function defuse(text: string): string {
  return text
    .replaceAll("@", `${zeroWidthSpace}@`)
    .replaceAll("!`", `!${zeroWidthSpace}\``)
    .replaceAll("`!", `\`${zeroWidthSpace}!`)
}

const fence = /^ {0,3}(`{3,}|~{3,})/
const codeSpan = /(`+)[\s\S]*?\1/g

/**
 * `markdown` with `change` made to its prose: each line's text outside code blocks and code spans,
 * one stretch between code spans at a time. Code is left as written.
 */
function inProse(markdown: string, change: (prose: string) => string): string {
  let open: string | undefined
  return markdown
    .split("\n")
    .map((line) => {
      const fenced = fence.exec(line)?.[1]
      if (open !== undefined) {
        if (fenced !== undefined && fenced[0] === open[0] && fenced.length >= open.length)
          open = undefined
        return line
      }
      if (fenced !== undefined) {
        open = fenced
        return line
      }
      let changed = ""
      let last = 0
      for (const span of line.matchAll(codeSpan)) {
        changed += change(line.slice(last, span.index)) + span[0]
        last = span.index + span[0].length
      }
      return changed + change(line.slice(last))
    })
    .join("\n")
}

/**
 * An instruction file's text with every `@` in its prose defused, where Claude Code looks for
 * imports; its code, where it doesn't, reads as written (`bun add @scope/package`).
 */
export function defuseProse(markdown: string): string {
  return inProse(markdown, (prose) => prose.replaceAll("@", `${zeroWidthSpace}@`))
}

// --- Paths -----------------------------------------------------------------------------------

const unsafePath = /[\0\n\r]/

/**
 * The Workspace path an import names, relative to the Workspace, from the file at `from`; none
 * for one outside the Workspace (`..` out of it, `~/`, or an absolute path elsewhere).
 */
export function resolveImport(from: string, reference: string): string | undefined {
  if (reference === "" || unsafePath.test(reference) || reference.startsWith("~")) return undefined
  const joined = reference.startsWith("/")
    ? posix.relative(workspaceGuestPath, posix.normalize(reference))
    : posix.normalize(posix.join(posix.dirname(from), reference))
  if (joined === "" || joined === "." || joined === ".." || joined.startsWith("../"))
    return undefined
  if (posix.isAbsolute(joined)) return undefined
  return joined.replace(/\/+$/, "")
}

// --- Imports ---------------------------------------------------------------------------------

/**
 * Claude Code's import syntax: `@path` at the start or after whitespace, `\ ` for a space. It
 * looks in each run of Markdown text, so one that starts after emphasis counts too (`**x**@a.md`).
 */
const importPattern = /(?:^|[\s*_~])@((?:[^\s\\]|\\ )+)/g
const importStart = /^(?:\.\/|~\/|\/|[a-zA-Z0-9._-])/

/**
 * The paths a CLAUDE.md imports, in order, as Claude Code finds them: not in code blocks, code
 * spans or HTML comments, and up to a `#`.
 */
export function importReferences(markdown: string): ReadonlyArray<string> {
  const references: Array<string> = []
  inProse(markdown.replace(/<!--[\s\S]*?-->/g, " "), (prose) => {
    for (const match of prose.matchAll(importPattern)) {
      const path = (match[1] ?? "").split("#")[0]?.replaceAll("\\ ", " ") ?? ""
      if (importStart.test(path)) references.push(path)
    }
    return prose
  })
  return references
}

// --- Skills ----------------------------------------------------------------------------------

const skillName = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

/** The frontmatter fields a skill keeps: what describes it, and nothing that changes what runs. */
const skillFields = {
  description: "string",
  when_to_use: "string",
  "argument-hint": "string",
  "disable-model-invocation": "boolean",
  "user-invocable": "boolean",
} as const

const frontmatter = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/

const parseYaml = (text: string): unknown => {
  try {
    return Bun.YAML.parse(text)
  } catch {
    return undefined
  }
}

/**
 * The SKILL.md Claude Code is given for the Repo's: named after its directory, its frontmatter
 * cut down to {@link skillFields}, and every value and its text defused.
 */
export function sanitizeSkill(name: string, markdown: string): string {
  const found = frontmatter.exec(markdown)
  const body = found === null ? markdown : markdown.slice(found[0].length)
  const parsed = found === null ? undefined : parseYaml(found[1] ?? "")
  const fields =
    typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {}
  const lines = [`name: ${JSON.stringify(name)}`]
  for (const [field, type] of Object.entries(skillFields)) {
    const value = fields[field]
    if (typeof value !== type) continue
    lines.push(
      `${field}: ${typeof value === "string" ? JSON.stringify(defuse(value)) : String(value)}`,
    )
  }
  return `---\n${lines.join("\n")}\n---\n${defuse(body)}`
}

// --- Collecting ------------------------------------------------------------------------------

const instructionRoots = ["CLAUDE.md", ".claude/CLAUDE.md"]
const skillsDirectory = ".claude/skills"

const describe = (path: string, read: FileRead) =>
  read._tag === "Skipped" ? `${path}: ${read.reason}` : `${path}: missing`

/**
 * Reads the Repo's CLAUDE.md, `.claude/CLAUDE.md`, the files they import, and its skills, from
 * the Workspace, within {@link RepoFileLimits}. A missing file is no file; anything not copied is
 * in `skipped`.
 */
export const collectRepoFiles = (workspace: WorkspaceFiles) =>
  Effect.gen(function* () {
    const skipped: Array<string> = []
    const instructions: Array<InstructionFile> = []
    const included = new Set<string>()
    let bytes = 0
    let imports = 0

    /** Adds the file if it fits, then what it imports, depth first, as Claude Code orders them. */
    const include = (
      path: string,
      read: FileRead,
      parent: string | undefined,
      depth: number,
    ): Effect.Effect<void, SandboxError> =>
      Effect.gen(function* () {
        if (read._tag !== "Read") {
          if (read._tag === "Skipped" || parent !== undefined) skipped.push(describe(path, read))
          return
        }
        const size = Buffer.byteLength(read.text)
        if (bytes + size > RepoFileLimits.instructionBytes) {
          skipped.push(
            `${path}: past the ${RepoFileLimits.instructionBytes}-byte instruction limit`,
          )
          return
        }
        bytes += size
        included.add(path)
        instructions.push({
          path,
          content: defuseProse(read.text),
          ...(parent === undefined ? {} : { parent }),
        })
        const references: Array<string> = []
        for (const reference of importReferences(read.text)) {
          const target = resolveImport(path, reference)
          if (target === undefined) skipped.push(`${path}: @${reference} is outside the Workspace`)
          else if (!included.has(target) && !references.includes(target)) references.push(target)
        }
        if (references.length === 0) return
        if (depth >= RepoFileLimits.importDepth) {
          skipped.push(`${path}: imports past depth ${RepoFileLimits.importDepth}`)
          return
        }
        const room = Math.max(0, RepoFileLimits.imports - imports)
        for (const over of references.slice(room))
          skipped.push(`${over}: past the limit of ${RepoFileLimits.imports} imports`)
        const wanted = references.slice(0, room)
        imports += wanted.length
        const reads = yield* workspace.read(wanted, RepoFileLimits.fileBytes)
        for (const [index, target] of wanted.entries()) {
          if (included.has(target)) continue
          yield* include(target, reads[index] ?? { _tag: "Missing" }, path, depth + 1)
        }
      })

    const roots = yield* workspace.read(instructionRoots, RepoFileLimits.fileBytes)
    for (const [index, path] of instructionRoots.entries())
      if (!included.has(path))
        yield* include(path, roots[index] ?? { _tag: "Missing" }, undefined, 0)

    const found = yield* workspace.directories(skillsDirectory)
    const names = found.filter((name) => skillName.test(name)).toSorted()
    for (const name of found)
      if (!skillName.test(name)) skipped.push(`${skillsDirectory}/${name}: not a skill name`)
    for (const name of names.slice(RepoFileLimits.skills))
      skipped.push(`${skillsDirectory}/${name}: past the limit of ${RepoFileLimits.skills} skills`)
    const kept = names.slice(0, RepoFileLimits.skills)
    const paths = kept.map((name) => `${skillsDirectory}/${name}/SKILL.md`)
    const reads = yield* workspace.read(paths, RepoFileLimits.fileBytes)
    const skills: Array<Skill> = []
    for (const [index, name] of kept.entries()) {
      const read = reads[index] ?? { _tag: "Missing" }
      if (read._tag === "Read") skills.push({ name, content: sanitizeSkill(name, read.text) })
      else skipped.push(describe(paths[index] ?? name, read))
    }
    return { instructions, skills, skipped } satisfies RepoFiles
  })

// --- Through the Sandbox ---------------------------------------------------------------------

/**
 * Looks at the Workspace in the Sandbox without following a symbolic link: `inspect` reads paths
 * from stdin and prints, for each, `file <bytes>`, `link` (a link along its path), `other` or
 * `missing`; `directories <path>` prints the directories in one. Its first argument is the
 * Workspace's root.
 */
export const workspaceScript = `
root=$1
mode=$2
set -f
walk() {
  target=$root
  linked=
  saved=$IFS
  IFS=/
  set -- $1
  IFS=$saved
  for part do
    target=$target/$part
    if [ -L "$target" ]; then
      linked=1
      return 0
    fi
  done
}
case $mode in
inspect)
  while IFS= read -r path; do
    walk "$path"
    if [ -n "$linked" ]; then
      echo link
    elif [ -f "$target" ]; then
      size=$(wc -c < "$target" 2>/dev/null | tr -d ' ')
      if [ -n "$size" ]; then echo "file $size"; else echo other; fi
    elif [ -e "$target" ]; then
      echo other
    else
      echo missing
    fi
  done
  ;;
directories)
  walk "$3"
  [ -z "$linked" ] && [ -d "$target" ] || exit 0
  set +f
  for entry in "$target"/*; do
    if [ -d "$entry" ] && [ ! -L "$entry" ]; then printf '%s\\n' "\${entry##*/}"; fi
  done
  ;;
esac
`

const utf8 = new TextDecoder("utf-8", { fatal: true })

/** The bytes as text, unless they are too many or not UTF-8 text. */
export function textOf(bytes: Uint8Array, maxBytes: number): FileRead {
  if (bytes.byteLength > maxBytes)
    return { _tag: "Skipped", reason: `larger than ${maxBytes} bytes` }
  try {
    const text = utf8.decode(bytes)
    return text.includes("\0") ? { _tag: "Skipped", reason: "not text" } : { _tag: "Read", text }
  } catch {
    return { _tag: "Skipped", reason: "not UTF-8 text" }
  }
}

/** What one line of `inspect` says about a path. */
export function inspected(line: string | undefined, maxBytes: number): FileRead | "file" {
  const [kind, size] = (line ?? "").split(" ")
  switch (kind) {
    case "missing":
      return { _tag: "Missing" }
    case "link":
      return { _tag: "Skipped", reason: "a symbolic link is along its path" }
    case "file":
      return Number(size) > maxBytes
        ? { _tag: "Skipped", reason: `larger than ${maxBytes} bytes` }
        : "file"
    default:
      return { _tag: "Skipped", reason: "not a regular file" }
  }
}

/** The Workspace of a Session's running Sandbox. */
export const sandboxWorkspace = (
  backend: SandboxBackendShape,
  sessionId: SessionId,
): WorkspaceFiles => {
  const run = (args: ReadonlyArray<string>, stdin?: string) =>
    backend
      .exec(sessionId, {
        command: "sh",
        args: ["-c", workspaceScript, "sh", workspaceGuestPath, ...args],
        ...(stdin === undefined ? {} : { stdin }),
      })
      .pipe(
        Effect.mapError(
          (error) => new SandboxError({ message: `reading the Repo's files: ${error.message}` }),
        ),
        Effect.flatMap((result) =>
          result.exitCode === 0
            ? Effect.succeed(result.stdout)
            : Effect.fail(
                new SandboxError({
                  message: `reading the Repo's files: ${result.stderr.trim() || `exit ${result.exitCode}`}`,
                }),
              ),
        ),
      )

  return {
    directories: (path) =>
      Effect.map(run(["directories", path]), (stdout) => stdout.split("\n").filter(Boolean)),
    read: (paths, maxBytes) =>
      Effect.gen(function* () {
        if (paths.length === 0) return []
        if (paths.some((path) => unsafePath.test(path)))
          return yield* new SandboxError({ message: "a path to read has a line break in it" })
        const lines = (yield* run(["inspect"], `${paths.join("\n")}\n`)).split("\n")
        return yield* Effect.forEach(paths, (path, index) => {
          const found = inspected(lines[index], maxBytes)
          if (found !== "file") return Effect.succeed(found)
          return backend.readFile(sessionId, posix.join(workspaceGuestPath, path)).pipe(
            Effect.map((bytes) => textOf(bytes, maxBytes)),
            Effect.catch(() =>
              Effect.succeed<FileRead>({ _tag: "Skipped", reason: "could not be read" }),
            ),
          )
        })
      }),
  }
}

// --- On the host -----------------------------------------------------------------------------

/** The plugin the Repo's skills are loaded as: `/repo:<name>`, or `/<name>`. */
export const repoPluginName = "repo"

/** The plugin directory under the Session's Repo files directory, for `--plugin-dir`. */
export const repoPluginDirectory = (repoFilesDirectory: string) =>
  join(repoFilesDirectory, ".claude")

/** What the mod reads to add the Repo's instruction files to the context. */
export const instructionsFile = "instructions.json"

/**
 * Replaces the Session's Repo files directory with `files`: whatever was there before, as from an
 * earlier start, is removed first, so only what the Runner wrote is ever loaded.
 */
export const writeRepoFiles = (directory: string, files: RepoFiles) =>
  Effect.tryPromise({
    try: async () => {
      await rm(directory, { recursive: true, force: true })
      const plugin = repoPluginDirectory(directory)
      await mkdir(join(plugin, ".claude-plugin"), { recursive: true, mode: 0o700 })
      await writeFile(
        join(plugin, ".claude-plugin", "plugin.json"),
        `${JSON.stringify({ name: repoPluginName, description: "The Repo's own skills, copied by Claude Hub." }, null, 2)}\n`,
      )
      for (const skill of files.skills) {
        const skillDirectory = join(plugin, "skills", skill.name)
        await mkdir(skillDirectory, { recursive: true, mode: 0o700 })
        await writeFile(join(skillDirectory, "SKILL.md"), skill.content)
      }
      const instructions = files.instructions.map((file) => ({
        path: posix.join(workspaceGuestPath, file.path),
        content: file.content,
        ...(file.parent === undefined
          ? {}
          : { parent: posix.join(workspaceGuestPath, file.parent) }),
      }))
      await writeFile(join(directory, instructionsFile), `${JSON.stringify({ instructions })}\n`)
    },
    catch: (cause) =>
      new Error(
        `the Repo's skills and CLAUDE.md could not be written to ${directory}: ${cause instanceof Error ? cause.message : String(cause)}`,
      ),
  })
