// Renders the repo's own GLOSSARY.md and docs/adr/*.md into the docs collection, beside the
// pages in src/content/docs. The files stay the single source: nothing is copied by hand, and in
// dev a change to one of them reloads its page.
import { readdirSync, readFileSync } from "node:fs"
import { basename, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { docsLoader } from "@astrojs/starlight/loaders"
import type { Loader, LoaderContext } from "astro/loaders"

/** The repository root, two levels above this package. */
const repoRoot = resolve(fileURLToPath(new URL("../../../..", import.meta.url)))
const glossaryFile = join(repoRoot, "GLOSSARY.md")
const adrDirectory = join(repoRoot, "docs", "adr")

/** Where the rendered files live on the site, under the base path. */
export const glossaryId = "reference/glossary"
export const decisionsId = "reference/decisions"

interface Source {
  readonly id: string
  readonly filePath: string
  readonly data: Record<string, unknown>
  readonly body: string
}

/** Splits a `---` frontmatter block of plain `key: value` lines off the top of a Markdown file. */
export function splitFrontmatter(raw: string): {
  attributes: Record<string, string>
  body: string
} {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw)
  if (!match) return { attributes: {}, body: raw }
  const [block, lines = ""] = match
  const attributes: Record<string, string> = {}
  for (const line of lines.split(/\r?\n/)) {
    const [, key, value = ""] = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line) ?? []
    if (key) attributes[key] = value.trim()
  }
  return { attributes, body: raw.slice(block.length) }
}

/** Takes the first `# ` heading out of a Markdown body, returning it as the title. */
export function takeTitle(body: string): { title: string | undefined; body: string } {
  const match = /^# (.+)$/m.exec(body)
  if (!match) return { title: undefined, body }
  const [line, title = ""] = match
  return {
    title: title.trim(),
    body: body.slice(0, match.index) + body.slice(match.index + line.length),
  }
}

/** An ADR's sidebar label: its number and the part of its title before the first `;` or `:`. */
export function adrLabel(number: string, title: string): string {
  const [short = title] = title.split(/[;:]/)
  return `${number} · ${short.trim()}`
}

/** The site path of an ADR, from its file name. */
const adrPath = (file: string) => `/${decisionsId}/${basename(file, ".md")}/`

/** Links between the repo's Markdown files become links between their pages. */
export function rewriteLinks(body: string): string {
  return body
    .replaceAll(/\]\((?:\.\/)?(\d{4}-[a-z0-9-]+)\.md(#[^)]*)?\)/g, (_, slug, hash = "") => {
      return `](/${decisionsId}/${slug}/${hash})`
    })
    .replaceAll(
      /\]\((?:\.\.\/)*GLOSSARY\.md(#[^)]*)?\)/g,
      (_, hash = "") => `](/${glossaryId}/${hash})`,
    )
}

/** The glossary's bold `**Term**:` lines become headings, so each term has an anchor. */
export function glossaryBody(body: string): string {
  return body.replaceAll(/^\*\*([^*]+)\*\*:[ \t]*$/gm, "### $1")
}

function glossarySource(): Source {
  const raw = readFileSync(glossaryFile, "utf8")
  const { body } = takeTitle(raw)
  return {
    id: glossaryId,
    filePath: glossaryFile,
    data: {
      title: "Glossary",
      description:
        "The words claude-hub uses, what each one means, and the words to avoid. Rendered from GLOSSARY.md.",
      sidebar: { order: 90 },
      tableOfContents: { minHeadingLevel: 2, maxHeadingLevel: 3 },
    },
    body:
      glossaryBody(rewriteLinks(body)) +
      `\n\n---\n\n<p class="source-note">Rendered from <code>GLOSSARY.md</code> at the root of the repository.</p>\n`,
  }
}

interface Adr {
  readonly file: string
  readonly number: string
  readonly title: string
  readonly status: string
  readonly body: string
}

function readAdrs(): ReadonlyArray<Adr> {
  return readdirSync(adrDirectory)
    .filter((name) => /^\d{4}-.+\.md$/.test(name))
    .toSorted()
    .map((name) => {
      const file = join(adrDirectory, name)
      const { attributes, body } = splitFrontmatter(readFileSync(file, "utf8"))
      const { title, body: rest } = takeTitle(body)
      return {
        file,
        number: name.slice(0, 4),
        title: title ?? name,
        status: attributes["status"] ?? "accepted",
        body: rest,
      }
    })
}

function adrSource(adr: Adr): Source {
  const superseded = adr.status.startsWith("superseded")
  const status = `<p class="adr-status"><span class="adr-badge${superseded ? " adr-badge--superseded" : ""}">${adr.status}</span> Architecture decision record ${adr.number}</p>\n\n`
  return {
    id: `${decisionsId}/${basename(adr.file, ".md")}`,
    filePath: adr.file,
    data: {
      title: adr.title,
      description: `ADR ${adr.number} (${adr.status}): ${adr.title}.`,
      sidebar: {
        label: adrLabel(adr.number, adr.title),
        order: Number(adr.number),
        ...(superseded ? { badge: { text: "Superseded", variant: "caution" } } : {}),
      },
    },
    body:
      status +
      rewriteLinks(adr.body) +
      `\n\n---\n\n<p class="source-note">Rendered from <code>docs/adr/${basename(adr.file)}</code> in the repository.</p>\n`,
  }
}

function decisionsIndex(adrs: ReadonlyArray<Adr>): Source {
  const rows = adrs
    .map(
      (adr) =>
        `| [${adr.number}](${adrPath(adr.file)}) | [${adr.title}](${adrPath(adr.file)}) | ${adr.status} |`,
    )
    .join("\n")
  return {
    id: decisionsId,
    filePath: adrDirectory,
    data: {
      title: "Decisions",
      description:
        "The architecture decision records behind claude-hub: what was decided, and why. Rendered from docs/adr.",
      sidebar: { label: "All decisions", order: 0 },
    },
    body: [
      "Each architecture decision record (ADR) captures one decision that shapes claude-hub: the context, what was decided and what it costs. They are kept in `docs/adr/` in the repository and rendered here unchanged. A decision that was replaced stays, marked superseded, so the history reads in order.",
      "",
      "| ADR | Decision | Status |",
      "|---|---|---|",
      rows,
    ].join("\n"),
  }
}

function sources(): ReadonlyArray<Source> {
  const adrs = readAdrs()
  return [glossarySource(), decisionsIndex(adrs), ...adrs.map(adrSource)]
}

/**
 * Where the entry would sit if it were a file in src/content/docs. Starlight builds the sidebar,
 * `autogenerate` groups included, from each entry's path inside the collection, so the rendered
 * files get one there; the real file is still named in errors and on the page.
 */
const entryPath = (id: string) =>
  id === decisionsId ? `src/content/docs/${id}/index.md` : `src/content/docs/${id}.md`

async function store(context: LoaderContext, source: Source) {
  const data = await context.parseData({
    id: source.id,
    data: source.data,
    filePath: source.filePath,
  })
  const digest = context.generateDigest(source.body + JSON.stringify(source.data))
  const existing = context.store.get(source.id)
  if (existing?.digest === digest && existing.rendered) return
  const rendered = await context.renderMarkdown(source.body)
  context.store.set({
    id: source.id,
    data,
    body: source.body,
    digest,
    rendered,
    filePath: entryPath(source.id),
  })
}

/**
 * Starlight's own docs loader, plus GLOSSARY.md as `reference/glossary`, and docs/adr as
 * `reference/decisions` and one page per ADR.
 */
export function docsWithRepoFiles(): Loader {
  const docs = docsLoader()
  return {
    name: "claude-hub-docs",
    load: async (context) => {
      await docs.load(context)
      for (const source of sources()) await store(context, source)
      const watched = [glossaryFile, adrDirectory]
      context.watcher?.add(watched)
      context.watcher?.on("all", async (_event, path) => {
        if (path !== glossaryFile && !path.startsWith(adrDirectory)) return
        context.logger.info(`Reloading ${path.slice(repoRoot.length + 1)}`)
        const current = sources()
        const ids = new Set(current.map((source) => source.id))
        for (const id of context.store.keys()) {
          if (id.startsWith(`${decisionsId}/`) && !ids.has(id)) context.store.delete(id)
        }
        for (const source of current) await store(context, source)
      })
    },
  }
}
