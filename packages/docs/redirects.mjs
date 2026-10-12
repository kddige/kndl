// Where pages moved when the site was reorganised into Get started, Guides, Self-hosting,
// Concepts, Reference, Troubleshooting and Contributing: old path to new, under the base path.
// astro.config.mjs turns each into a redirect, so links to the old URLs keep working.
import { readdirSync } from "node:fs"

const howTo = {
  "self-hosting": [
    "install",
    "run-the-hub",
    "add-a-runner",
    "reach-the-hub-from-other-machines",
    "set-up-the-github-app",
    "let-people-in",
  ],
  guides: [
    "add-your-claude-credential",
    "set-up-an-environment",
    "use-variables-and-secrets",
    "work-in-a-session",
    "work-with-subagents",
    "forward-a-sessions-ports",
    "add-a-remote-mcp-server",
    "publish-and-add-an-mcp-server-package",
    "install-the-cli-from-a-hub",
    "sign-in-the-cli",
  ],
  contributing: ["develop-kndl"],
}

const explanation = [
  "architecture",
  "environments",
  "git-from-sessions",
  "security-model",
  "session-lifecycle",
]

const adrs = readdirSync(new URL("../../docs/adr/", import.meta.url))
  .filter((file) => file.endsWith(".md"))
  .map((file) => file.slice(0, -".md".length))

/** Old path to new path, both without the base, with a trailing slash. */
export const moved = {
  "/tutorials/first-session/": "/start/quickstart/",
  "/about/": "/start/introduction/",
  ...Object.fromEntries(
    Object.entries(howTo).flatMap(([section, pages]) =>
      pages.map((page) => [`/how-to/${page}/`, `/${section}/${page}/`]),
    ),
  ),
  ...Object.fromEntries(explanation.map((page) => [`/explanation/${page}/`, `/concepts/${page}/`])),
  "/reference/protocol/": "/contributing/protocol/",
  "/reference/decisions/": "/contributing/decisions/",
  ...Object.fromEntries(
    adrs.map((adr) => [`/reference/decisions/${adr}/`, `/contributing/decisions/${adr}/`]),
  ),
}
