// Prefixes the site's base path to root-relative links in Markdown, so pages link to
// `/how-to/add-a-runner/` and the built site points at `/kndl/how-to/add-a-runner/`.

interface Node {
  type: string
  tagName?: string
  properties?: Record<string, unknown>
  children?: Node[]
}

/** The rehype plugin, used as `[rehypeBaseLinks, { base }]`: `base` is Astro's, such as `/kndl/`. */
export function rehypeBaseLinks({ base }: { base: string }) {
  const prefix = base.replace(/\/$/, "")
  const visit = (node: Node) => {
    if (node.type === "element" && node.tagName === "a" && node.properties) {
      const href = node.properties["href"]
      if (
        typeof href === "string" &&
        href.startsWith("/") &&
        !href.startsWith("//") &&
        !href.startsWith(`${prefix}/`)
      ) {
        node.properties["href"] = prefix + href
      }
    }
    for (const child of node.children ?? []) visit(child)
  }
  return (tree: Node) => visit(tree)
}
