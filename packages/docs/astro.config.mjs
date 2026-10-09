// The kndl docs site: Astro Starlight, published to GitHub Pages under /kndl/.
import { unified } from "@astrojs/markdown-remark"
import starlight from "@astrojs/starlight"
import { defineConfig } from "astro/config"
import { rehypeBaseLinks } from "./src/plugins/rehypeBaseLinks.ts"
import { paperDark, paperLight } from "./src/styles/expressiveCodeThemes.ts"

const site = "https://kddige.github.io"
const base = "/kndl/"

// Fraunces (variable, with the SOFT axis) and JetBrains Mono, the landing page's families, from
// Google Fonts. Self-hosting them needs a new dependency (or vendored files), which is an open
// decision; theme.css carries a size-adjusted local fallback so headings don't jump on swap.
const fontsCss =
  "https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght,SOFT@9..144,600..800,0..100&family=JetBrains+Mono:wght@400;600&display=swap"

export default defineConfig({
  site,
  base,
  trailingSlash: "always",
  // Pages link to each other root-relative (`/how-to/...`); this prefixes the base path. MDX
  // inherits the processor.
  markdown: { processor: unified({ rehypePlugins: [[rehypeBaseLinks, { base }]] }) },
  integrations: [
    starlight({
      title: "kndl",
      description:
        "Multiplayer agentic sessions, self-hosted: run Claude Code Sessions in Sandboxes on your own machines, and watch and drive them together from the web.",
      logo: {
        light: "../../brand/lockup-light.svg",
        dark: "../../brand/lockup-dark.svg",
        alt: "kndl",
        replacesTitle: true,
      },
      favicon: "/favicon.svg",
      head: [
        { tag: "link", attrs: { rel: "icon", href: `${base}favicon.ico`, sizes: "32x32" } },
        { tag: "link", attrs: { rel: "apple-touch-icon", href: `${base}apple-touch-icon.png` } },
        { tag: "meta", attrs: { property: "og:image", content: `${site}${base}og.png` } },
        { tag: "meta", attrs: { property: "og:image:width", content: "1200" } },
        { tag: "meta", attrs: { property: "og:image:height", content: "630" } },
        {
          tag: "meta",
          attrs: {
            property: "og:image:alt",
            content: "kndl: multiplayer agentic sessions, self-hosted.",
          },
        },
        { tag: "meta", attrs: { name: "twitter:card", content: "summary_large_image" } },
        { tag: "meta", attrs: { name: "twitter:image", content: `${site}${base}og.png` } },
        { tag: "meta", attrs: { name: "theme-color", content: "#1D1733" } },
        { tag: "link", attrs: { rel: "preconnect", href: "https://fonts.googleapis.com" } },
        {
          tag: "link",
          attrs: { rel: "preconnect", href: "https://fonts.gstatic.com", crossorigin: true },
        },
        { tag: "link", attrs: { rel: "stylesheet", href: fontsCss } },
      ],
      customCss: ["./src/styles/theme.css"],
      // The Paper palette's code themes; the first is the base (dark), the second follows
      // Starlight's light theme.
      expressiveCode: { themes: [paperDark, paperLight] },
      components: {
        Footer: "./src/components/Footer.astro",
      },
      credits: false,
      lastUpdated: false,
      pagination: true,
      tableOfContents: { minHeadingLevel: 2, maxHeadingLevel: 3 },
      sidebar: [
        { label: "Tutorials", items: [{ autogenerate: { directory: "tutorials" } }] },
        {
          label: "How-to guides",
          items: [
            { slug: "how-to/install" },
            { slug: "how-to/run-the-hub" },
            { slug: "how-to/add-a-runner" },
            { slug: "how-to/add-your-claude-credential" },
            { slug: "how-to/reach-the-hub-from-other-machines" },
            { slug: "how-to/set-up-the-github-app" },
            { slug: "how-to/set-up-an-environment" },
            { slug: "how-to/use-variables-and-secrets" },
            { slug: "how-to/work-in-a-session" },
            { slug: "how-to/work-with-subagents" },
            { slug: "how-to/add-a-remote-mcp-server" },
            { slug: "how-to/publish-and-add-an-mcp-server-package" },
            { slug: "how-to/install-the-cli-from-a-hub" },
            { slug: "how-to/sign-in-the-cli" },
            { slug: "how-to/forward-a-sessions-ports" },
            { slug: "how-to/develop-kndl" },
          ],
        },
        { label: "Explanation", items: [{ autogenerate: { directory: "explanation" } }] },
        {
          label: "Reference",
          items: [
            { slug: "reference/commands" },
            { slug: "reference/configuration" },
            { slug: "reference/files-and-paths" },
            { slug: "reference/glossary" },
            { slug: "reference/mcp-server-packages" },
            { slug: "reference/protocol" },
            {
              label: "Decisions (ADRs)",
              collapsed: true,
              items: [{ autogenerate: { directory: "reference/decisions" } }],
            },
          ],
        },
        { label: "Troubleshooting", items: [{ autogenerate: { directory: "troubleshooting" } }] },
        { label: "About", slug: "about" },
      ],
    }),
  ],
})
