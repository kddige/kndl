// The kndl docs site: Astro Starlight, published to GitHub Pages under /kndl/.
import { unified } from "@astrojs/markdown-remark"
import starlight from "@astrojs/starlight"
import { defineConfig } from "astro/config"
import { rehypeBaseLinks } from "./src/plugins/rehypeBaseLinks.ts"

const site = "https://kddige.github.io"
const base = "/kndl/"

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
        { tag: "meta", attrs: { name: "theme-color", content: "#3D5DCF" } },
      ],
      customCss: ["./src/styles/theme.css"],
      components: {
        Hero: "./src/components/Hero.astro",
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
