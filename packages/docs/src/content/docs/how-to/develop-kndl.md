---
title: Develop kndl
description: The repository's layout, its checks, and how to work on the web UI, the mod and this site.
sidebar:
  order: 13
---

kndl is one Bun workspace in TypeScript, on [Effect](https://effect.website). Every command here runs from the repository's root.

## Layout

| Package | What it is |
|---|---|
| `packages/protocol` | The messages the Hub, Runners, the mod and the web UI exchange, as Effect Schemas; and, as `@kndl/protocol/home`, which home a Hub or Runner keeps its state in. Imported from source by the other packages. |
| `packages/hub` | The Hub: an Effect HTTP server on Bun, with its data in SQLite. Signs people in, issues Runner and mod tokens, accepts the Runner and web WebSockets, serves the mod's HTTP endpoints and the web UI's build. |
| `packages/runner` | A Runner: connects to the Hub, runs each Session's Claude Code in tmux in a microsandbox Sandbox, and the credential proxy it reaches Anthropic and the Hub through. |
| `packages/mod` | The Claude Code mod a Runner loads into each Session, as two plugins ([ADR 0014](/reference/decisions/0014-subagents-replace-child-sessions/)): `hub-link` sends the Session's Turns and subagents to the Hub; `hub-link-commands` delivers prompts, stops Turns and subagents, and shows the Participants. |
| `packages/cli` | The `kndl` command, on `effect/cli` and [`@clack/prompts`](https://github.com/bombshell-dev/clack). Its decisions are pure modules with tests; `Host.ts` and `Shell.ts` are the I/O. `KNDL_DRY_RUN=1` prints the commands that change the system instead of running them. `install.sh`, at the repository's root, installs it. |
| `packages/web` | The web UI: React on Vite, built from [Base UI](https://base-ui.com) primitives and styled with StyleX, on a typed client for the web channel (`src/hub`). |
| `packages/docs` | This site: Astro Starlight. |
| `prototype/` | The first prototype. Reference material only: not part of the workspace, typecheck or lint. |

The words are defined in the [glossary](/reference/glossary/), and the design decisions are in the [ADRs](/reference/decisions/).

## Install

```sh
bun install
```

You need Bun 1.4 or newer, and [Claude Code](https://docs.anthropic.com/en/docs/claude-code) (`claude`) on `PATH`: `bun run typecheck` needs it to check the mod. Without tmux, `bun test` skips the Runner's tmux tests.

## Checks

| Command | What it does |
|---|---|
| `bun test` | Bun's test runner over every package, including the mod's pure modules (`packages/mod/src/*.spec.ts`). `KNDL_SANDBOX_IT=1` adds the tests that boot real microsandbox Sandboxes. |
| `bun run typecheck` | Each package's `typecheck` script: `tsc --noEmit` in the code packages, and `astro check` in `packages/docs`. |
| `bun run lint` | [oxlint](https://oxc.rs/docs/guide/usage/linter), configured in `.oxlintrc.json`. |
| `bun run format:check` | [oxfmt](https://oxc.rs/docs/guide/usage/formatter): formatting and import order. `bun run format` applies it. Configured in `.oxfmtrc.json`. |

## Work on the web UI

```sh
KNDL_DEV_LOGIN=1 bun run hub    # the Hub, with dev login
bun run web                     # Vite on http://localhost:5173, with hot reload
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
| `bun run mod:build` | Bundles the mod into each plugin's `hooks/hub-link-lib.js` (git-ignored). `bun run runner` runs it first. A running Session picks up a new build at its next start, wake or change of model. |
| `bun run mod:check` | Builds the mod, then runs `claude plugin validate` and `claude plugin test` on each plugin. |
| `claude --plugin-dir packages/mod/plugins/hub-link --plugin-dir packages/mod/plugins/hub-link-commands` | Claude Code with the mod loaded, after `bun run mod:build`. |

## Work on this site

```sh
bun run docs:dev      # http://localhost:4321/kndl/
bun run docs:build    # into packages/docs/dist
```

Pages are Markdown in `packages/docs/src/content/docs`, written to `docs/design/docs-style.md`. The [glossary](/reference/glossary/) and the [decisions](/reference/decisions/) are rendered from `GLOSSARY.md` and `docs/adr/`: edit those, never a copy. After changing a logo source in `brand/`, `bun run --filter @kndl/docs brand` remakes the images and favicons.

Pushes to `main` that touch the site deploy it to GitHub Pages; pull requests that touch it build it.

## Each package's own scripts

Each package's scripts (`start`, `dev`, `build`, `typecheck`) also run from inside it with `bun run <script>`.
