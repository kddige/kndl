# claude-hub

Multiplayer Claude Code: a self-hosted Hub where a team runs Claude Code Sessions in Sandboxes on any number of Runners, and watches and drives them together from the web.

The words used here (Hub, Runner, Session, Sandbox, Participant, ...) are defined in [`GLOSSARY.md`](GLOSSARY.md). The design decisions are recorded in [`docs/adr/`](docs/adr/), starting with [0001: Claude on the host, tools in the Sandbox](docs/adr/0001-claude-on-host-tools-in-sandbox.md) and [0008: the stack](docs/adr/0008-stack.md).

This is v1's scaffold: each package starts and does almost nothing yet.

## Layout

One Bun workspace in TypeScript.

| Package | What it is |
|---|---|
| [`packages/protocol`](packages/protocol) | The messages the Hub, Runners, the mod and the web UI exchange, as [Effect](https://effect.website) Schemas. Imported from source by the other packages. |
| [`packages/hub`](packages/hub) | The Hub: Effect HTTP server on Bun, storing its data in SQLite through `@effect/sql-sqlite-bun`. Signs people in, issues Runner and mod tokens, and accepts the Runner, mod and web WebSocket channels (handshake only, for now). |
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
| `bun run hub` | The Hub on <http://127.0.0.1:7777>; try `/health`. | `HOST` (`127.0.0.1`), `PORT` (`7777`), `HUB_DATABASE` (`hub.db` in `packages/hub`), and the sign-in settings below |
| `bun run runner-token <name>` | Issues a token for the Runner called `<name>` and prints it. | `HUB_DATABASE`, as for the Hub |
| `bun run runner` | A Runner for this machine. | `HUB_URL` (`http://127.0.0.1:7777`), `RUNNER_NAME` (short hostname) |
| `bun run web` | The web UI's Vite dev server on <http://localhost:5173>. It passes `/auth`, `/health` and `/ws` through to the Hub, so the web UI and the Hub share one origin. | `HUB_URL` (`http://127.0.0.1:7777`) |
| `claude --plugin-dir packages/mod` | Claude Code with the `hub-link` mod loaded. | |

Each package's own scripts (`start`, `dev`, `build`, `typecheck`) also run from inside it with `bun run <script>`.

## Signing in

Every Hub route but `GET /health` and the sign-in routes needs a credential, because code in a Sandbox can reach the Hub ([ADR 0004](docs/adr/0004-the-sandbox-is-the-security-boundary.md)):

| Who | Credential | Routes |
|---|---|---|
| People | A sign-in cookie, set by GitHub sign-in or dev login. HttpOnly, SameSite=Lax, host-only, and Secure unless the web UI is on `localhost` over HTTP. Requests that use it must come from the web UI's origin (`HUB_PUBLIC_URL`). | `GET /auth/me`, `POST /auth/sign-out`, `/ws/web` |
| Runners | A Runner token, `Authorization: Bearer chr_…`. It names the Runner's RunnerId. | `/ws/runner` |
| A Session's mod | A mod token, `Authorization: Bearer chm_…`, scoped to one Session. The Hub issues it in `StartSession.modToken`; the Runner hands it to Claude Code on the host, never to the Sandbox. | `/ws/mod` |

The Hub keeps only SHA-256 hashes of these tokens.

The Hub reads its sign-in settings from the environment:

| Env | Default | What it does |
|---|---|---|
| `HUB_PUBLIC_URL` | `http://localhost:5173` | Where browsers reach the web UI and, through it, the Hub. GitHub sends people back here, and cookie-authenticated requests must come from this origin. |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | unset | The GitHub App's client id and secret (issue #1). Unset, GitHub sign-in is off. Set the App's callback URL to `<HUB_PUBLIC_URL>/auth/github/callback`. |
| `CLAUDE_HUB_DEV_LOGIN` | off | `1` turns on dev login: `POST /auth/dev` signs you in as a local Participant without GitHub. The Hub refuses to start with it unless `HOST` and `HUB_PUBLIC_URL` are both loopback, and only answers it for loopback callers. |
| `CLAUDE_HUB_DEV_USER` | `$USER` | Who dev login signs you in as, when the request names no `login`. |

### Trying it on one machine, before the GitHub App exists

```sh
CLAUDE_HUB_DEV_LOGIN=1 bun run hub      # the Hub, with dev login
bun run runner-token "$(hostname -s)"   # prints this machine's Runner token, once
bun run web                             # the web UI on http://localhost:5173
```

Sign in from the web UI's origin, for example in the browser console at <http://localhost:5173>:

```js
await fetch("/auth/dev", { method: "POST", body: JSON.stringify({ login: "alice" }) })
```

Running `runner-token` again for the same name keeps the RunnerId and replaces the token, so the old one stops working. The Runner will connect with its token as `RUNNER_TOKEN` once it talks to the Hub (issue #10).
