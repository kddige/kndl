---
title: Develop claude-hub
description: The repository's layout, its checks, and how to work on the web UI, the mod and this site.
sidebar:
  order: 10
---

claude-hub is one Bun workspace in TypeScript, on [Effect](https://effect.website). Every command here runs from the repository's root.

## Layout

| Package | What it is |
|---|---|
| `packages/protocol` | The messages the Hub, Runners, the mod and the web UI exchange, as Effect Schemas; and, as `@claude-hub/protocol/home`, which home a Hub or Runner keeps its state in. Imported from source by the other packages. |
| `packages/hub` | The Hub: an Effect HTTP server on Bun, with its data in SQLite. Signs people in, issues Runner and mod tokens, accepts the Runner and web WebSockets, serves the mod's HTTP endpoints and the web UI's build. |
| `packages/runner` | A Runner: connects to the Hub, runs each Session's Claude Code in tmux on its host and its tools in a microsandbox Sandbox, through the tool bridge. |
| `packages/mod` | `hub-link`, the Claude Code mod a Runner loads into each Session. Sends the Session's Turns to the Hub, delivers prompts from the web UI, shows the Participants above the prompt, and runs the file and command tools in the Sandbox, denying every other tool. |
| `packages/cli` | The `claude-hub` command, on Effect's `effect/cli` for its commands and flags, and [`@clack/prompts`](https://github.com/bombshell-dev/clack) for its questions and spinners, behind a small `Ui` service with a scripted test layer: onboard, the launchd and systemd services, status, doctor, update and uninstall. Its decisions (the prerequisite plan, the service files, onboard's answers, the update target, the guards on what uninstall may delete) are pure modules with tests; `Host.ts` and `Shell.ts` are the I/O. `CLAUDE_HUB_DRY_RUN=1` prints the commands that change the system (package managers, `sudo`, `launchctl`, `systemctl`, `loginctl`) instead of running them. `install.sh`, at the repository's root, installs it. |
| `packages/web` | The web UI: React on Vite, built from [Base UI](https://base-ui.com) primitives and styled with StyleX, on a typed client for the web channel (`src/hub`). |
| `packages/docs` | This site: Astro Starlight. |
| `prototype/` | The first prototype. Reference material only: not part of the workspace, typecheck or lint. |

The words are defined in the [glossary](/reference/glossary/), and the design decisions are in the [ADRs](/reference/decisions/).

## Install

```sh
bun install
```

You need Bun 1.4 or newer, and Claude Code (`claude`) on `PATH` for the mod's checks: `bun run typecheck` fails without it, since the mod is checked against the plugin API's types that Claude Code writes when it loads the mod. Install it with `curl -fsSL https://claude.ai/install.sh | bash` (see [Claude Code's setup](https://docs.anthropic.com/en/docs/claude-code)). Without tmux, `bun test` skips the Runner's tmux tests and says so.

## Checks

| Command | What it does |
|---|---|
| `bun test` | Bun's test runner over every package, including the mod's pure modules (`packages/mod/src/*.spec.ts`). `CLAUDE_HUB_SANDBOX_IT=1` adds the tests that boot real microsandbox Sandboxes. |
| `bun run typecheck` | Each package's `typecheck` script: `tsc --noEmit` (TypeScript 7) in the code packages, and `astro check` in `packages/docs`. The mod's first loads it into a throwaway Claude Code print session (`claude -p /cost`, no model call), which writes the plugin API's types to `packages/mod/.claude-plugin/types/`. |
| `bun run lint` | [oxlint](https://oxc.rs/docs/guide/usage/linter), configured in `.oxlintrc.json`. |
| `bun run format:check` | [oxfmt](https://oxc.rs/docs/guide/usage/formatter): formatting and import order. `bun run format` applies it. Configured in `.oxfmtrc.json`. |

## Work on the web UI

```sh
CLAUDE_HUB_DEV_LOGIN=1 bun run hub    # the Hub, with dev login
bun run web                           # Vite on http://localhost:5173, with hot reload
```

Or with no Hub at all, against an in-process fake Hub that plays a scripted Session:

```sh
VITE_FAKE_HUB=1 bun run web             # signed in
VITE_FAKE_HUB=signed-out bun run web    # starting signed out
```

The UI kit, every component in its states, is at `/kit`.

## Work on the mod

| Command | What it does |
|---|---|
| `bun run mod:build` | Bundles the mod's logic, with Effect and the protocol, into `packages/mod/hooks/hub-link-lib.js` (git-ignored). `bun run runner` runs it first. |
| `bun run mod:check` | Builds the mod, then runs `claude plugin validate` and `claude plugin test` on it. |
| `claude --plugin-dir packages/mod` | Claude Code with the mod loaded, after `bun run mod:build`. |

## Work on this site

```sh
bun run docs:dev      # http://localhost:4321/claude-hub/
bun run docs:build    # into packages/docs/dist
```

Pages are Markdown in `packages/docs/src/content/docs`, sorted by [Diátaxis](https://diataxis.fr): tutorials, how-to guides, reference and explanation, plus troubleshooting. The [glossary](/reference/glossary/) and the [decisions](/reference/decisions/) are rendered from `GLOSSARY.md` and `docs/adr/` at build time, so edit those files, never a copy. The logo's source files are in `brand/`; after changing one, `bun run --filter @claude-hub/docs brand` remakes the PNG and ICO files and copies the favicons into the site's and the web UI's `public/` folders.

Pushes to `main` that touch the site deploy it to GitHub Pages; pull requests that touch it build it.

## Each package's own scripts

Each package's scripts (`start`, `dev`, `build`, `typecheck`) also run from inside it with `bun run <script>`.
