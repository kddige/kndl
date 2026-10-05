// Checks every internal link in the built site: that the page or file it names exists, and that
// its #anchor is an id on that page. Astro's build checks neither. Run after `astro build`, as the
// package's `build` script does: `bun scripts/check-links.ts [dist]`. Exits 1 on a broken link.
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative, sep } from "node:path"

/** The site's base path, as astro.config.mjs sets it. */
export const base = "/claude-hub/"

/** A link that doesn't resolve: on which page, to where, and why. */
export interface BrokenLink {
  readonly page: string
  readonly href: string
  readonly reason: string
}

const decode = (text: string) =>
  text
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")

/** The ids a page's HTML defines. */
export const idsOf = (html: string): ReadonlySet<string> =>
  new Set(Array.from(html.matchAll(/\sid="([^"]*)"/g), (m) => decode(m[1] ?? "")))

/** The hrefs of a page's links. */
export const hrefsOf = (html: string): ReadonlyArray<string> =>
  Array.from(html.matchAll(/<a\s[^>]*?href="([^"]*)"/g), (m) => decode(m[1] ?? ""))

/**
 * The broken internal links among `pages`, keyed by their path under the site's base, such as
 * `how-to/install/index.html`. `files` lists every other file the site has, such as images.
 */
export function brokenLinks(
  pages: ReadonlyMap<string, string>,
  files: ReadonlySet<string> = new Set(),
): ReadonlyArray<BrokenLink> {
  const ids = new Map(Array.from(pages, ([path, html]) => [path, idsOf(html)] as const))
  const broken: Array<BrokenLink> = []
  for (const [page, html] of pages) {
    for (const href of hrefsOf(html)) {
      const fail = (reason: string) => broken.push({ page, href, reason })
      if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("//")) continue
      const [pathPart = "", fragment] = href.split("#", 2)
      const path = pathPart.split("?", 1)[0] ?? ""
      let target: string
      if (path === "") {
        target = page
      } else if (path.startsWith(base)) {
        const rest = decodeURIComponent(path.slice(base.length))
        target = rest === "" || rest.endsWith("/") ? `${rest}index.html` : rest
      } else if (path.startsWith("/")) {
        fail(`outside the site's base path ${base}`)
        continue
      } else {
        fail("relative; link root-relative instead")
        continue
      }
      if (!pages.has(target) && !files.has(target)) {
        fail(path.endsWith("/") || !/\.[a-z0-9]+$/i.test(path) ? "no such page" : "no such file")
        continue
      }
      if (fragment === undefined || fragment === "" || fragment === "_top") continue
      const targetIds = ids.get(target)
      if (targetIds === undefined) continue
      if (!targetIds.has(decodeURIComponent(fragment))) fail(`no #${fragment} on ${target}`)
    }
  }
  return broken
}

/** Every file under `dir`, as paths relative to it with `/` separators. */
function filesUnder(dir: string): ReadonlyArray<string> {
  return readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((entry) => statSync(join(dir, entry)).isFile())
    .map((entry) => relative(dir, join(dir, entry)).split(sep).join("/"))
}

if (import.meta.main) {
  const dist = process.argv[2] ?? join(import.meta.dir, "..", "dist")
  const all = filesUnder(dist)
  const pages = new Map(
    all.filter((f) => f.endsWith(".html")).map((f) => [f, readFileSync(join(dist, f), "utf8")]),
  )
  const broken = brokenLinks(pages, new Set(all))
  const links = Array.from(pages.values()).reduce((n, html) => n + hrefsOf(html).length, 0)
  if (broken.length === 0) {
    console.log(`Links: ${links} links on ${pages.size} pages, none broken.`)
  } else {
    for (const { page, href, reason } of broken) console.error(`${page}: ${href}: ${reason}`)
    console.error(`Links: ${broken.length} broken, of ${links} links on ${pages.size} pages.`)
    process.exit(1)
  }
}
