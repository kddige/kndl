# claude-hub

Multiplayer Claude Code: a self-hosted Hub where a team runs Claude Code Sessions in Sandboxes on any number of Runners, and watches and drives them together from the web.

The words used here (Hub, Runner, Session, Sandbox, Participant, ...) are defined in [`GLOSSARY.md`](GLOSSARY.md). The design decisions are recorded in [`docs/adr/`](docs/adr/), starting with [0001: Claude on the host, tools in the Sandbox](docs/adr/0001-claude-on-host-tools-in-sandbox.md) and [0008: the stack](docs/adr/0008-stack.md).

This is v1's scaffold: each package starts and does almost nothing yet.

## Layout

One Bun workspace in TypeScript.

| Package | What it is |
|---|---|
| [`packages/protocol`](packages/protocol) | The messages the Hub, Runners, the mod and the web UI exchange, as [Effect](https://effect.website) Schemas. Imported from source by the other packages. |
| [`packages/hub`](packages/hub) | The Hub: Effect HTTP server on Bun, storing its data in SQLite through `@effect/sql-sqlite-bun`. Signs people in, issues Runner and mod tokens, accepts the Runner and web WebSocket channels, and serves the mod's HTTP endpoints (handshake only, for now). |
| [`packages/runner`](packages/runner) | A Runner: an Effect program that connects to the Hub and runs each Session's Claude Code in its own tmux session on its host, streaming the terminal. The Sandbox backend is in `src/sandbox` (#9), not yet wired into Session start. |
| [`packages/mod`](packages/mod) | `hub-link`, the Claude Code mod a Runner loads into each Session. Notes in the debug log that it loaded. Runs in Claude Code's own mod runtime, so it is plain TypeScript without Effect for now. |
| [`packages/web`](packages/web) | The web UI: React on Vite, built from [Base UI](https://base-ui.com) primitives. |
| [`prototype/`](prototype) | The first prototype (hub, runner, mod, `start.sh`). Reference material only: not part of the workspace, typecheck or lint. |

## Setup

Needs [Bun](https://bun.sh) 1.4 or newer, and Claude Code (`claude`) on `PATH` for the mod's checks. A Runner also needs `tmux` and `git`.

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
| `bun run runner` | A Runner for this machine; see [Running a Runner](#running-a-runner). | `HUB_URL` (`http://127.0.0.1:7777`), `RUNNER_TOKEN` (required), `RUNNER_NAME` (short hostname) |
| `bun run web` | The web UI's Vite dev server on <http://localhost:5173>. It passes `/auth`, `/health` and `/ws` through to the Hub, so the web UI and the Hub share one origin. | `HUB_URL` (`http://127.0.0.1:7777`) |
| `claude --plugin-dir packages/mod` | Claude Code with the `hub-link` mod loaded. | |

Each package's own scripts (`start`, `dev`, `build`, `typecheck`) also run from inside it with `bun run <script>`.

## Signing in

Every Hub route but `GET /health` and the sign-in routes needs a credential, because code in a Sandbox can reach the Hub ([ADR 0004](docs/adr/0004-the-sandbox-is-the-security-boundary.md)):

| Who | Credential | Routes |
|---|---|---|
| People | A sign-in cookie, set by GitHub sign-in or dev login. HttpOnly, SameSite=Lax, host-only, and Secure unless the web UI is on `localhost` over HTTP. Requests that use it must come from the web UI's origin (`HUB_PUBLIC_URL`). | `GET /auth/me`, `POST /auth/sign-out`, `/ws/web` |
| Runners | A Runner token, `Authorization: Bearer chr_…`. It names the Runner's RunnerId. | `/ws/runner` |
| A Session's mod | A mod token, `Authorization: Bearer chm_…`, scoped to one Session. The Hub issues it in `StartSession.modToken`; the Runner hands it to Claude Code on the host, never to the Sandbox. | `POST /mod/hello`, `POST /mod/events`, `GET /mod/commands` |

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

Running `runner-token` again for the same name keeps the RunnerId and replaces the token, so the old one stops working. Pass it to the Runner as `RUNNER_TOKEN`:

```sh
RUNNER_TOKEN=chr_… bun run runner
```

### Running a Runner

A Runner connects to the Hub's `/ws/runner` WebSocket with its Runner token as `Authorization: Bearer <RUNNER_TOKEN>`, says hello, and then starts and stops Sessions as the Hub asks. Get a token from the Hub with `bun run runner-token <name>`. If the Hub goes away, the Runner reconnects with backoff (0.5 s, doubling up to 30 s).

Each Session's Claude Code runs in a tmux session named `hub-<session id>`, on the Runner's own tmux server (`tmux -L claude-hub`), so Sessions keep running when the Runner restarts, and the Runner re-adopts them when it comes back. To look at one by hand: `tmux -L claude-hub attach -t hub-<session id>`.

A Session's files live in `<sessions root>/<session id>/`: `claude/`, the empty directory Claude Code runs in, and `workspace/`, the Repo cloned onto the Session's Work branch with the host's own git credentials. Claude Code inherits workspace trust from parent directories, so trust the sessions root once: run `claude` in it and accept the trust prompt. Until you do, the Runner warns at startup.

| Env | Default | What it is |
|---|---|---|
| `HUB_URL` | `http://127.0.0.1:7777` | The Hub. |
| `RUNNER_TOKEN` | required | The Runner token. Kept out of tmux and Claude Code's environment. |
| `RUNNER_NAME` | the short hostname | The name the UI shows. |
| `RUNNER_LOGIN` | the account Claude Code is signed in with (`oauthAccount.emailAddress` in `~/.claude.json`) | The Runner login, as the UI shows it. |
| `RUNNER_SESSIONS_ROOT` | `~/.claude-hub/sessions` | Where Sessions' directories go. |
| `RUNNER_MOD_DIR` | `packages/mod` in this checkout | The `hub-link` mod, loaded with `--plugin-dir`. |
| `CLAUDE_BIN` | `claude` | The Claude Code executable. |
| `RUNNER_TMUX_SOCKET` | `claude-hub` | The tmux server's socket name. |
| `RUNNER_REPO_URL` | `https://github.com/{repo}.git` | Where Repos are cloned from; `{repo}` is `owner/name`. |

Claude Code starts with the hardened flags of [ADR 0001](docs/adr/0001-claude-on-host-tools-in-sandbox.md) (`--setting-sources ""`, `--strict-mcp-config`, a fixed `--tools` list), with `--session-id` for a new Session or `--resume` to wake one, and with these variables, which the mod uses to talk HTTP to the Hub:

| Env | What it is |
|---|---|
| `CLAUDE_HUB_URL` | The Hub's URL: the Runner's `HUB_URL`. |
| `CLAUDE_HUB_MOD_TOKEN` | The Session's mod token, from the Hub's `StartSession`. |
| `CLAUDE_HUB_SESSION_ID` | The Session's id. |
