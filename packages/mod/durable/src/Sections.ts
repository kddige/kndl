// The durable agent's system prompt, as Pi Durable sections: rebuilt before every request, and
// sent again only where they changed, which keeps Providers' prompt caches warm. So the Repo's
// AGENTS.md, CLAUDE.md and skills are read live, through the conversation's environment: an edit
// reaches the next request. Files are read again only when their mtime moves.
//
// Nothing here changes from one request to the next by itself: a prompt that changes within a run
// reaches a Claude query the bridge holds open only at its next query. Tools are named as the
// model sees them under any harness: "the read tool", never a prefixed name.

import type { Context } from "@earendil-works/chord"
import { section } from "@earendil-works/pi-durable"
import type { PromptInput, PromptSection } from "@earendil-works/pi-durable"
import type { ExecutionEnv } from "@earendil-works/pi-durable/env"
import { attachmentTool } from "./Attachments.ts"
import { AgentsDoc, ThreadsDoc } from "./Docs.ts"

/** Whose a conversation is, as its preamble tells it: the main loop, one of its threads, or a subagent. */
export type ConversationKind = "main" | "thread" | "agent"

/** The section that says what kndl is, and how people talk to the conversation's agent through it. */
export const preambleFor = (kind: ConversationKind): string =>
  [
    kind === "agent"
      ? "This session is shared through kndl: several people may be watching it live in a web UI, and any of them can message you or stop you. The agent that started you is the one you answer."
      : `This session is shared through kndl: several people may be watching it and talking to you, live, in a web UI, and any of them can prompt you, steer you while you work, ${kind === "main" ? "stop you, or answer your questions" : "or stop you"}.`,
    "A prompt from the web UI starts with its sender's name in brackets, such as \"[Ada Lovelace] ...\": answer the person who asked, and keep in mind that the others read along. A prompt without one came from the session itself, such as a subagent's result.",
    `A line such as "[Image #1: name (attachment id)]" or "[PDF #1: name (attachment id)]" in a message stands for a file its sender attached: to see it, call the ${attachmentTool} tool with its id.`,
    "You run in a sandbox VM where the repository is checked out, and your work there survives the VM sleeping and your process restarting: a turn cut off by a restart continues where it stopped.",
    ...(kind === "main"
      ? [
          "People can also reply in threads: a thread is a fork of this conversation at one of your answers, which runs beside it with its own context.",
        ]
      : []),
    "For work of several steps, keep a plan with the update_plan tool: everyone in the session sees it live.",
    "Your context is summarized automatically when it grows long; everything before stays searchable with the search_history tool. For very long work you can also hand off to yourself with the handoff tool: write down everything the next stretch needs, and you carry on from that note with a fresh context, in the same turn.",
  ].join("\n\n")

/** Whose a conversation is: a subagent's or a thread's if the Session says so, else the main loop's. */
const conversationKind = async (
  input: PromptInput,
  context: Context,
): Promise<ConversationKind> => {
  const agents = (await input.read.snapshot(AgentsDoc, context))?.agents ?? {}
  if (Object.values(agents).some((agent) => agent.conversationId === input.conversationId))
    return "agent"
  const threads = (await input.read.snapshot(ThreadsDoc, context))?.threads ?? {}
  return Object.values(threads).some((thread) => thread.conversationId === input.conversationId)
    ? "thread"
    : "main"
}

/** A file's text and the mtime it was read at. */
interface Cached {
  readonly mtimeMs: number
  readonly text: string | undefined
}

/** Reads files through an environment, again only when their mtime changed. */
export class FileCache {
  private readonly files = new Map<string, Cached>()

  /** The file's text; undefined when it isn't there or can't be read. */
  async read(env: ExecutionEnv, path: string, context: Context): Promise<string | undefined> {
    const info = await env.fileInfo(path, context)
    if (!info.ok || info.value.kind === "directory") {
      this.files.delete(path)
      return undefined
    }
    const known = this.files.get(path)
    if (known?.mtimeMs === info.value.mtimeMs) return known.text
    const read = await env.readTextFile(path, context)
    const text = read.ok ? read.value : undefined
    this.files.set(path, { mtimeMs: info.value.mtimeMs, text })
    return text
  }
}

/** `<dir>/<name>`, for an environment's paths. */
const join = (dir: string, name: string) => `${dir.replace(/\/+$/, "")}/${name}`

/** The context files the agent reads whole, at the Workspace's root. */
const contextFileNames = ["AGENTS.md", "CLAUDE.md"] as const

/** How long a listing of the Workspace's nested context files is kept. */
const nestedTtlMs = 60_000

/**
 * The Repo's AGENTS.md and CLAUDE.md at the Workspace's root, whole, and the paths of nested
 * ones, which the agent reads itself when it works there.
 */
const contextFilesSection = (): PromptSection => {
  const cache = new FileCache()
  let nested:
    | { readonly at: number; readonly cwd: string; readonly paths: Array<string> }
    | undefined
  const listNested = async (env: ExecutionEnv, cwd: string, context: Context) => {
    if (nested !== undefined && nested.cwd === cwd && Date.now() - nested.at < nestedTtlMs)
      return nested.paths
    let output = ""
    const listed = await env
      .exec(
        ["git", "ls-files", "-z", "--", ...contextFileNames.map((name) => `*${name}`)],
        {
          cwd,
          timeout: 5,
          onOutput: (text, _context, info) => void (info.stream === "stdout" && (output += text)),
        },
        context,
      )
      .catch(() => undefined)
    const paths =
      listed?.ok === true && listed.value.exitCode === 0
        ? output
            .split("\0")
            .filter((path) => path.includes("/"))
            .toSorted()
            .slice(0, 50)
        : []
    nested = { at: Date.now(), cwd, paths }
    return paths
  }
  return section("context_files", async (input, context) => {
    const env = input.env
    if (env === undefined) return undefined
    const parts: Array<string> = []
    for (const name of contextFileNames) {
      const text = await cache.read(env, join(env.cwd, name), context)
      if (text !== undefined && text.trim() !== "")
        parts.push(`<file path="${name}">\n${text.trim()}\n</file>`)
    }
    const more = await listNested(env, env.cwd, context)
    if (more.length > 0)
      parts.push(
        `Directories have their own instructions too; read the one for where you work before you change anything there:\n${more.map((path) => `- ${path}`).join("\n")}`,
      )
    if (parts.length === 0) return undefined
    return [
      "The repository's instructions for agents. Follow them; where they conflict with the people's requests, the people win.",
      ...parts,
    ].join("\n\n")
  })
}

/** Where a Repo keeps its skills, in the order they are listed. */
const skillDirectories = [".agents/skills", ".claude/skills", ".pi/skills"] as const

/** A skill as its SKILL.md's front matter says. */
export interface Skill {
  readonly name: string
  readonly description: string
  readonly path: string
}

/** A value of front matter: unquoted, on one line. */
const unquote = (value: string) => {
  const text = value.trim()
  return (text.startsWith('"') && text.endsWith('"')) ||
    (text.startsWith("'") && text.endsWith("'"))
    ? text.slice(1, -1)
    : text
}

/** The name and description a SKILL.md's front matter gives; undefined without a description. */
const skillFrontMatter = (
  text: string,
): { readonly name?: string; readonly description: string } | undefined => {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)
  if (match?.[1] === undefined) return undefined
  const fields = new Map<string, string>()
  const lines = match[1].split(/\r?\n/)
  for (let at = 0; at < lines.length; at++) {
    const field = /^([A-Za-z_-]+):\s*(.*)$/.exec(lines[at] ?? "")
    if (field?.[1] === undefined) continue
    let value = field[2] ?? ""
    // A folded or literal block, or a value continued on indented lines.
    if (value === ">" || value === "|" || value === ">-" || value === "|-") value = ""
    while (at + 1 < lines.length && /^\s+\S/.test(lines[at + 1] ?? ""))
      value = `${value} ${(lines[++at] ?? "").trim()}`.trim()
    fields.set(field[1], unquote(value))
  }
  const description = fields.get("description")
  if (description === undefined || description === "") return undefined
  const name = fields.get("name")
  return name === undefined || name === "" ? { description } : { name, description }
}

/** The skills in the Workspace, as their front matter says, in directory order. */
const findSkills = async (
  env: ExecutionEnv,
  cache: FileCache,
  context: Context,
): Promise<Array<Skill>> => {
  const skills: Array<Skill> = []
  const seen = new Set<string>()
  for (const dir of skillDirectories) {
    const listed = await env.listDir(join(env.cwd, dir), context)
    if (!listed.ok) continue
    const entries = listed.value.toSorted((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      if (entry.kind === "file") continue
      const path = join(join(join(env.cwd, dir), entry.name), "SKILL.md")
      const text = await cache.read(env, path, context)
      const front = text === undefined ? undefined : skillFrontMatter(text)
      if (front === undefined) continue
      const name = front.name ?? entry.name
      if (seen.has(name)) continue
      seen.add(name)
      skills.push({ name, description: front.description, path })
    }
  }
  return skills
}

/** XML's special characters, escaped. */
const escape = (text: string) =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")

/** The Repo's skills: each one's name and description, and where its file is. */
const skillsSection = (): PromptSection => {
  const cache = new FileCache()
  return section(
    "skills",
    async (input, context) => {
      if (input.env === undefined) return undefined
      const skills = await findSkills(input.env, cache, context)
      if (skills.length === 0) return undefined
      return [
        "The repository's skills: instructions for particular tasks. When a task matches a skill's description, read its file with the read tool first, and follow it; a relative path in it is relative to the skill's directory.",
        "<available_skills>",
        ...skills.map((skill) =>
          [
            "  <skill>",
            `    <name>${escape(skill.name)}</name>`,
            `    <description>${escape(skill.description)}</description>`,
            `    <location>${escape(skill.path)}</location>`,
            "  </skill>",
          ].join("\n"),
        ),
        "</available_skills>",
      ].join("\n")
    },
    { tag: false },
  )
}

/** The kndl sections every conversation has: the preamble, its directory, the Repo's guidance. */
export const kndlSections = (): Array<PromptSection> => [
  section("kndl", async (input, context) => preambleFor(await conversationKind(input, context)), {
    tag: false,
  }),
  section("cwd", (input) => input.env?.cwd),
  contextFilesSection(),
  skillsSection(),
]
