// An MCP server's icon (#230, ADR 0021). The Hub finds it and keeps it; the browser asks the Hub
// for it and never contacts a third party.
//
// In priority order, every failure dropping silently to the next step:
// 1. The manifest's `icon` (packaged MCP servers): an https URL the Hub fetches, or a file in the
//    package, whose bytes the caller read from it.
// 2. A favicon of the MCP server's URL, at its origin first, then at its registrable apex domain:
//    an SVG `<link rel=icon>`, else the largest of the other `<link rel=icon>`s,
//    `apple-touch-icon`s and web manifest icons, else `/favicon.ico`. Never an og:image.
// 3. None, for which the web shows a letter avatar.
//
// Fetching follows the rules of the Hub's other fetches of URLs it was given (`fetchable`): https,
// or http to a loopback host, no credentials. It follows at most 3 redirects, checking each hop
// again; gives each fetch 5 s; takes at most 512 KB of an icon and of the page it reads links
// from; and accepts only PNG, ICO, WebP, JPEG and SVG, which it tells by the bytes, never by
// `Content-Type`.

import { createHash } from "node:crypto"
import { Context, Effect, Layer, Option } from "effect"
import { getDomain } from "tldts"
import { fetchable } from "./McpServerOAuth.ts"
import { readAtMost } from "./ReadAtMost.ts"

/** An icon as the Hub keeps it. */
export interface Icon {
  readonly bytes: Uint8Array
  /** What the bytes are: one of {@link IconTypes}, by sniffing them. */
  readonly contentType: string
}

export const IconTypes = [
  "image/png",
  "image/x-icon",
  "image/webp",
  "image/jpeg",
  "image/svg+xml",
] as const

/** The most an icon, or the page its links are read from, may be, in bytes. */
export const MaxIconBytes = 512 * 1024

/** The redirects followed, at most, for one fetch. */
const maxRedirects = 3

/** How long one fetch may take, in all. */
const fetchTimeoutMs = 5_000

/** The links tried per origin, at most, past the SVG. */
const maxCandidates = 6

/** `fetch`, as the icon search uses it: it never follows a redirect itself. */
export type IconFetch = (url: string, init: RequestInit) => Promise<Response>

export interface IconOptions {
  readonly fetch?: IconFetch
  readonly timeoutMs?: number
}

const startsWith = (bytes: Uint8Array, prefix: ReadonlyArray<number>, at = 0) =>
  prefix.every((byte, index) => bytes[at + index] === byte)

/** What image the bytes are, if one the Hub accepts: it trusts them, not any header. */
export function sniffIcon(bytes: Uint8Array): (typeof IconTypes)[number] | undefined {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png"
  if (startsWith(bytes, [0x00, 0x00, 0x01, 0x00])) return "image/x-icon"
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg"
  if (
    startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) &&
    startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8)
  ) {
    return "image/webp"
  }
  const head = new TextDecoder().decode(bytes.subarray(0, 1024)).replace(/^﻿/, "").trimStart()
  if (/^<(?:\?xml|!--|!doctype svg|svg)/i.test(head) && /<svg[\s>]/i.test(head)) {
    return "image/svg+xml"
  }
  return undefined
}

/** A short hash of an icon's bytes, for the web to bust its cache with. */
export const iconHash = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex").slice(0, 16)

/** The first `max` bytes of a body, dropping the rest. */
async function readHead(body: ReadableStream<Uint8Array> | null, max: number) {
  if (body === null) return new Uint8Array(0)
  const reader = body.getReader()
  const chunks: Array<Uint8Array> = []
  let size = 0
  for (let read = await reader.read(); !read.done; read = await reader.read()) {
    const chunk = read.value.subarray(0, max - size)
    chunks.push(chunk)
    size += chunk.byteLength
    if (size >= max) {
      await reader.cancel().catch(() => undefined)
      break
    }
  }
  return Buffer.concat(chunks, size)
}

/**
 * The body at `url`, after at most 3 redirects, each checked as the first was; or none. A body
 * past 512 KB is none, unless `head` asks for its first 512 KB: a page's links are in its head.
 */
async function get(
  start: string,
  options: Required<IconOptions>,
  head = false,
): Promise<{ readonly bytes: Uint8Array; readonly url: string } | undefined> {
  let url = start
  for (let hop = 0; hop <= maxRedirects; hop++) {
    if (!fetchable(url)) return undefined
    try {
      const response = await options.fetch(url, {
        redirect: "manual",
        signal: AbortSignal.timeout(options.timeoutMs),
        headers: { accept: "image/*,text/html,application/json;q=0.9,*/*;q=0.5" },
      })
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location")
        await response.body?.cancel().catch(() => undefined)
        if (location === null) return undefined
        url = new URL(location, url).href
        continue
      }
      if (response.status !== 200) {
        await response.body?.cancel().catch(() => undefined)
        return undefined
      }
      const bytes = head
        ? await readHead(response.body, MaxIconBytes)
        : await readAtMost(response.body, MaxIconBytes)
      return bytes === undefined ? undefined : { bytes, url }
    } catch {
      return undefined
    }
  }
  return undefined
}

/** The image at `url`, if it is one. */
async function getIcon(url: string, options: Required<IconOptions>): Promise<Icon | undefined> {
  const got = await get(url, options)
  const contentType = got === undefined ? undefined : sniffIcon(got.bytes)
  return got === undefined || contentType === undefined
    ? undefined
    : { bytes: got.bytes, contentType }
}

interface Candidate {
  readonly url: string
  readonly size: number
  readonly svg: boolean
}

const attributes = (tag: string) => {
  const found = new Map<string, string>()
  for (const match of tag.matchAll(
    /([a-zA-Z][\w:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g,
  )) {
    const name = (match[1] ?? "").toLowerCase()
    if (!found.has(name)) found.set(name, match[2] ?? match[3] ?? match[4] ?? "")
  }
  return found
}

/** The largest side a `sizes` value names, or 0 for none, or `any`. */
const largest = (sizes: unknown) =>
  typeof sizes !== "string"
    ? 0
    : Math.max(0, ...[...sizes.matchAll(/(\d+)x(\d+)/gi)].map((match) => Number(match[1])))

const resolved = (href: string | undefined, base: string) => {
  if (href === undefined || href.trim() === "") return undefined
  try {
    return new URL(href.trim(), base).href
  } catch {
    return undefined
  }
}

const isSvg = (url: string, type: string | undefined) => {
  if (type?.toLowerCase().includes("svg")) return true
  try {
    return new URL(url).pathname.toLowerCase().endsWith(".svg")
  } catch {
    return false
  }
}

/** The icons a web manifest (JSON) lists. */
function manifestIcons(json: string, base: string): Array<Candidate> {
  try {
    const parsed: unknown = JSON.parse(json)
    const icons = (parsed as { readonly icons?: unknown } | null)?.icons
    if (!Array.isArray(icons)) return []
    return icons.flatMap((entry: { src?: unknown; sizes?: unknown; type?: unknown }) => {
      const url = typeof entry?.src === "string" ? resolved(entry.src, base) : undefined
      return url === undefined
        ? []
        : [
            {
              url,
              size: largest(entry.sizes),
              svg: isSvg(url, typeof entry.type === "string" ? entry.type : undefined),
            },
          ]
    })
  } catch {
    return []
  }
}

/** A favicon of the origin, in the order the page's links and /favicon.ico make it. */
async function faviconAt(
  origin: string,
  options: Required<IconOptions>,
): Promise<Icon | undefined> {
  const tried = new Set<string>()
  const attempt = (url: string) => {
    if (tried.has(url)) return Promise.resolve(undefined)
    tried.add(url)
    return getIcon(url, options)
  }
  const page = await get(`${origin}/`, options, true)
  const links: Array<Candidate> = []
  let manifest: string | undefined
  if (page !== undefined) {
    const html = new TextDecoder().decode(page.bytes)
    for (const [tag] of html.matchAll(/<link\b[^>]*>/gi)) {
      const attrs = attributes(tag)
      const rels = (attrs.get("rel") ?? "").toLowerCase().split(/\s+/)
      const url = resolved(attrs.get("href"), page.url)
      if (url === undefined) continue
      if (rels.includes("manifest")) manifest ??= url
      else if (
        rels.includes("icon") ||
        rels.includes("apple-touch-icon") ||
        rels.includes("apple-touch-icon-precomposed")
      ) {
        links.push({ url, size: largest(attrs.get("sizes")), svg: isSvg(url, attrs.get("type")) })
      }
    }
  }
  for (const candidate of links.filter((link) => link.svg)) {
    const icon = await attempt(candidate.url)
    if (icon !== undefined) return icon
  }
  const fromManifest =
    manifest === undefined
      ? []
      : await get(manifest, options).then((got) =>
          got === undefined ? [] : manifestIcons(new TextDecoder().decode(got.bytes), got.url),
        )
  const rest = [...links.filter((link) => !link.svg), ...fromManifest]
    .map((candidate, order) => ({ candidate, order }))
    .toSorted((a, b) => b.candidate.size - a.candidate.size || a.order - b.order)
    .slice(0, maxCandidates)
  for (const { candidate } of rest) {
    const icon = await attempt(candidate.url)
    if (icon !== undefined) return icon
  }
  return attempt(`${origin}/favicon.ico`)
}

/** The favicon of the URL's origin, else of its registrable apex domain. */
async function favicon(mcpServerUrl: string, options: Required<IconOptions>) {
  if (!fetchable(mcpServerUrl)) return undefined
  const url = new URL(mcpServerUrl)
  const own = await faviconAt(url.origin, options)
  if (own !== undefined) return own
  const apex = getDomain(url.hostname)
  if (apex === null || apex === url.hostname) return undefined
  return faviconAt(`${url.protocol}//${apex}`, options)
}

/** What to find an MCP server's icon from. */
export interface IconSearch {
  /** The MCP server's URL. */
  readonly url: string
  /** The manifest's `icon`: an https URL, or a path in the package. */
  readonly manifestIcon?: string
  /** The bytes of the package file `manifestIcon` names, if it is a path and the Hub read it. */
  readonly iconFile?: Uint8Array
}

/** The MCP server's icon: the manifest's, else its URL's favicon, else none. */
export async function findIcon(
  search: IconSearch,
  given: IconOptions = {},
): Promise<Icon | undefined> {
  const options = {
    fetch: given.fetch ?? ((url, init) => fetch(url, init)),
    timeoutMs: given.timeoutMs ?? fetchTimeoutMs,
  }
  if (search.manifestIcon !== undefined) {
    if (/^https?:\/\//i.test(search.manifestIcon)) {
      const icon = await getIcon(search.manifestIcon, options)
      if (icon !== undefined) return icon
    } else if (search.iconFile !== undefined && search.iconFile.length <= MaxIconBytes) {
      const contentType = sniffIcon(search.iconFile)
      if (contentType !== undefined) return { bytes: search.iconFile, contentType }
    }
  }
  return favicon(search.url, options)
}

/** Finds an MCP server's icon, off the lock and off the request that added the MCP server. */
export class McpServerIcons extends Context.Service<
  McpServerIcons,
  { readonly find: (search: IconSearch) => Effect.Effect<Option.Option<Icon>> }
>()("@kndl/hub/McpServerIcons") {
  static readonly layerWith = (options: IconOptions = {}) =>
    Layer.succeed(McpServerIcons, {
      find: (search) =>
        Effect.promise(() => findIcon(search, options).catch(() => undefined)).pipe(
          Effect.map(Option.fromUndefinedOr),
        ),
    })

  /** Fetches from the internet. */
  static readonly layer = McpServerIcons.layerWith()

  /** Finds none: for tests that mustn't reach the internet. */
  static readonly none = Layer.succeed(McpServerIcons, {
    find: () => Effect.succeed(Option.none()),
  })
}
