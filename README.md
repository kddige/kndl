# claude-hub

Multiplayer Claude Code: a self-hosted Hub where a team runs Claude Code Sessions in Sandboxes on any number of Runners, and watches and drives them together from the web.

The words used here (Hub, Runner, Session, Sandbox, Participant, ...) are defined in [`GLOSSARY.md`](GLOSSARY.md). The design decisions are recorded in [`docs/adr/`](docs/adr/), starting with [0001: Claude on the host, tools in the Sandbox](docs/adr/0001-claude-on-host-tools-in-sandbox.md) and [0008: the stack](docs/adr/0008-stack.md).

This is v1's scaffold: each package starts and does almost nothing yet.

## Layout

One Bun workspace in TypeScript.

| Package | What it is |
|---|---|
| [`packages/protocol`](packages/protocol) | The messages the Hub, Runners, the mod and the web UI exchange, as [Effect](https://effect.website) Schemas. Imported from source by the other packages. |
| [`packages/hub`](packages/hub) | The Hub: Effect HTTP server on Bun, storing its data in SQLite through `@effect/sql-sqlite-bun`. Serves `GET /health`. |
| [`packages/runner`](packages/runner) | A Runner: an Effect program that will start Sessions and their Sandboxes on its host. Logs its configuration and waits. |
| [`packages/mod`](packages/mod) | `hub-link`, the Claude Code mod a Runner loads into each Session. Notes in the debug log that it loaded. Runs in Claude Code's own mod runtime, so it is plain TypeScript without Effect for now. |
| [`packages/web`](packages/web) | The web UI: React on Vite, built from [Base UI](https://base-ui.com) primitives. |
| [`prototype/`](prototype) | The first prototype (hub, runner, mod, `start.sh`). Reference material only: not part of the workspace, typecheck or lint. |

## Setup

Needs [Bun](https://bun.sh) 1.4 or newer, and Claude Code (`claude`) on `PATH` for the mod's checks.

```sh
bun install
```

## Checks

All run from the repo root:

| Command | What it does |
|---|---|
| `bun test` | Bun's test runner over every package but the mod. |
| `bun run typecheck` | `tsc --noEmit` in every package (TypeScript 7). The mod's first loads it into a throwaway Claude Code print session (`claude -p /cost`, no model call), which lays the plugin API's types in `packages/mod/.claude-plugin/types/`. |
| `bun run lint` | [oxlint](https://oxc.rs/docs/guide/usage/linter): ESLint-style rules for TypeScript, React, imports and unicorn. Configured in `.oxlintrc.json`. |
| `bun run format:check` | [oxfmt](https://oxc.rs/docs/guide/usage/formatter): checks formatting and import order. `bun run format` applies it. Configured in `.oxfmtrc.json`. |
| `bun run mod:check` | `claude plugin validate` and `claude plugin test` on the mod. |

## Run

| Command | What it starts | Env (default) |
|---|---|---|
| `bun run hub` | The Hub on <http://127.0.0.1:7777>; try `/health`. | `HOST` (`127.0.0.1`), `PORT` (`7777`), `HUB_DATABASE` (`hub.db` in `packages/hub`) |
| `bun run runner` | A Runner for this machine. | `HUB_URL` (`http://127.0.0.1:7777`), `RUNNER_NAME` (short hostname) |
| `bun run web` | The web UI's Vite dev server on <http://localhost:5173>. | |
| `claude --plugin-dir packages/mod` | Claude Code with the `hub-link` mod loaded. | |

Each package's own scripts (`start`, `dev`, `build`, `typecheck`) also run from inside it with `bun run <script>`.
