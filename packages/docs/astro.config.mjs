// The kndl docs site: Astro Starlight, published to GitHub Pages under /kndl/.
import { unified } from "@astrojs/markdown-remark"
import starlight from "@astrojs/starlight"
import { defineConfig } from "astro/config"
import { moved } from "./redirects.mjs"
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
  // Pages that moved keep their old URLs, as redirects to the new ones.
  redirects: Object.fromEntries(
    Object.entries(moved).map(([from, to]) => [from, `${base.slice(0, -1)}${to}`]),
  ),
  // Pages link to each other root-relative (`/guides/...`); this prefixes the base path. MDX
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
      social: [{ icon: "github", label: "GitHub", href: "https://github.com/kddige/kndl" }],
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
        {
          label: "Get started",
          items: [
            { slug: "start/introduction" },
            { slug: "start/quickstart" },
            { slug: "start/deploy-for-a-team" },
          ],
        },
        {
          label: "Guides",
          items: [
            { slug: "guides/work-in-a-session" },
            { slug: "guides/manage-a-session" },
            { slug: "guides/work-with-subagents" },
            { slug: "guides/forward-a-sessions-ports" },
            { slug: "guides/set-up-an-environment" },
            { slug: "guides/use-variables-and-secrets" },
            { slug: "guides/add-your-claude-credential" },
            { slug: "guides/add-a-remote-mcp-server" },
            { slug: "guides/connect-an-mcp-server-with-oauth" },
            { slug: "guides/publish-and-add-an-mcp-server-package" },
            { slug: "guides/install-the-cli-from-a-hub" },
            { slug: "guides/sign-in-the-cli" },
          ],
        },
        {
          label: "Self-hosting",
          items: [
            { slug: "self-hosting/install" },
            { slug: "self-hosting/run-the-hub" },
            { slug: "self-hosting/reach-the-hub-from-other-machines" },
            { slug: "self-hosting/set-up-the-github-app" },
            { slug: "self-hosting/let-people-in" },
            { slug: "self-hosting/add-a-runner" },
            { slug: "self-hosting/update" },
            { slug: "self-hosting/uninstall" },
          ],
        },
        {
          label: "Concepts",
          items: [
            { slug: "concepts/architecture" },
            { slug: "concepts/session-lifecycle" },
            { slug: "concepts/environments" },
            { slug: "concepts/git-from-sessions" },
            { slug: "concepts/security-model" },
          ],
        },
        {
          label: "Reference",
          items: [
            { slug: "reference/commands" },
            { slug: "reference/configuration" },
            { slug: "reference/files-and-paths" },
            { slug: "reference/mcp-servers" },
            { slug: "reference/mcp-server-packages" },
            { slug: "reference/glossary" },
          ],
        },
        {
          label: "Troubleshooting",
          collapsed: true,
          items: [{ autogenerate: { directory: "troubleshooting" } }],
        },
        {
          label: "Contributing",
          collapsed: true,
          items: [
            { slug: "contributing/develop-kndl" },
            { slug: "contributing/protocol" },
            { slug: "contributing/internals" },
            {
              label: "Decisions (ADRs)",
              collapsed: true,
              items: [{ autogenerate: { directory: "contributing/decisions" } }],
            },
          ],
        },
      ],
    }),
  ],
})
