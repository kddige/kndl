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
| [`packages/runner`](packages/runner) | A Runner: an Effect program that connects to the Hub and runs each Session's Claude Code in its own tmux session on its host, streaming the terminal, and each Session's tools in its own [microsandbox](https://github.com/microsandbox/microsandbox) Sandbox through a tool bridge. |
| [`packages/mod`](packages/mod) | `hub-link`, the Claude Code mod a Runner loads into each Session. Sends the Session's turns to the Hub, delivers prompts from the web UI, shows the Participants above the prompt, and runs the file and command tools in the Sandbox, denying every other tool. Its logic is bundled with Effect and the protocol into one ES module (`bun run mod:build`). |
| [`packages/web`](packages/web) | The web UI: React on Vite, built from [Base UI](https://base-ui.com) primitives and styled with StyleX. The Session list and the Session view, on a typed client for the web channel (`src/hub`). The UI kit is at `/kit`. |
| [`prototype/`](prototype) | The first prototype (hub, runner, mod, `start.sh`). Reference material only: not part of the workspace, typecheck or lint. |

## Setup

Needs [Bun](https://bun.sh) 1.4 or newer, and Claude Code (`claude`) on `PATH` for the mod's checks. A Runner also needs `tmux`, `git` and [microsandbox](https://github.com/microsandbox/microsandbox) with its server running.

```sh
bun install
```

## Checks

All run from the repo root:

| Command | What it does |
|---|---|
| `bun test` | Bun's test runner over every package, including the mod's pure modules (`packages/mod/src/*.spec.ts`). `CLAUDE_HUB_SANDBOX_IT=1` adds the tests that boot real microsandbox Sandboxes. |
| `bun run typecheck` | `tsc --noEmit` in every package (TypeScript 7). The mod's first loads it into a throwaway Claude Code print session (`claude -p /cost`, no model call), which lays the plugin API's types in `packages/mod/.claude-plugin/types/`. |
| `bun run lint` | [oxlint](https://oxc.rs/docs/guide/usage/linter): ESLint-style rules for TypeScript, React, imports and unicorn. Configured in `.oxlintrc.json`. |
| `bun run format:check` | [oxfmt](https://oxc.rs/docs/guide/usage/formatter): checks formatting and import order. `bun run format` applies it. Configured in `.oxfmtrc.json`. |
| `bun run mod:build` | Bundles the mod's logic into `packages/mod/hooks/hub-link-lib.js` (git-ignored). |
| `bun run mod:check` | Builds the mod, then runs `claude plugin validate` and `claude plugin test` on it. |

## Run

| Command | What it starts | Env (default) |
|---|---|---|
| `bun run hub` | The Hub on <http://127.0.0.1:7777>; try `/health`. | `HOST` (`127.0.0.1`), `PORT` (`7777`), `HUB_DATABASE` (`hub.db` in `packages/hub`), and the sign-in settings below |
| `bun run runner-token <name>` | Issues a token for the Runner called `<name>` and prints it. | `HUB_DATABASE`, as for the Hub |
| `bun run runner` | A Runner for this machine; see [Running a Runner](#running-a-runner). | `HUB_URL` (`http://127.0.0.1:7777`), `RUNNER_TOKEN` (required), `RUNNER_NAME` (short hostname) |
| `bun run web` | The web UI's Vite dev server on <http://localhost:5173>. It passes `/auth`, `/health` and `/ws` through to the Hub, so the web UI and the Hub share one origin. | `HUB_URL` (`http://127.0.0.1:7777`); `VITE_FAKE_HUB=1` runs it against an in-process fake Hub that plays a scripted Session instead, and `VITE_FAKE_HUB=signed-out` starts that signed out |
| `claude --plugin-dir packages/mod` | Claude Code with the `hub-link` mod loaded. Build it first with `bun run mod:build`. | |

Each package's own scripts (`start`, `dev`, `build`, `typecheck`) also run from inside it with `bun run <script>`.

## Signing in

Every Hub route but `GET /health` and the sign-in routes needs a credential, because code in a Sandbox can reach the Hub ([ADR 0004](docs/adr/0004-the-sandbox-is-the-security-boundary.md)):

| Who | Credential | Routes |
|---|---|---|
| People | A sign-in cookie, set by GitHub sign-in or dev login. HttpOnly, SameSite=Lax, host-only, and Secure unless the web UI is on `localhost` over HTTP. Requests that use it must come from the web UI's origin (`HUB_PUBLIC_URL`). | `GET /auth/me`, `POST /auth/sign-out`, `/ws/web` |
| Runners | A Runner token, `Authorization: Bearer chr_…`. It names the Runner's RunnerId. | `/ws/runner` |
| A Session's mod | A mod token, `Authorization: Bearer chm_…`, scoped to one Session. The Hub issues it in `StartSession.modToken`; the Runner hands it to Claude Code on the host, never to the Sandbox. | `POST /mod/hello`, `POST /mod/events`, `GET /mod/commands` |

The Hub keeps only SHA-256 hashes of these tokens.

The Hub reads its sign-in and lifecycle settings from the environment:

| Env | Default | What it does |
|---|---|---|
| `HUB_PUBLIC_URL` | `http://localhost:5173` | Where browsers reach the web UI and, through it, the Hub. GitHub sends people back here, and cookie-authenticated requests must come from this origin. |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | unset | The GitHub App's client id and secret (issue #1). Unset, GitHub sign-in is off. Set the App's callback URL to `<HUB_PUBLIC_URL>/auth/github/callback`. |
| `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY_PATH` | unset | The App's id and the path to its private key, for the git tools (#13), which make short-lived installation tokens from them ([ADR 0005](docs/adr/0005-git-remote-operations-are-host-tools.md)). Nothing reads them yet. |
| `CLAUDE_HUB_DEV_LOGIN` | off | `1` turns on dev login: `POST /auth/dev` signs you in as a local Participant without GitHub. The Hub refuses to start with it unless `HOST` and `HUB_PUBLIC_URL` are both loopback, and only answers it for loopback callers. |
| `CLAUDE_HUB_DEV_USER` | `$USER` | Who dev login signs you in as, when the request names no `login`. |
| `HUB_SLEEP_AFTER_MS` | `900000` (15 minutes) | How long an Active Session goes with no Turn running, no prompt queued and no Participant present before the Hub puts it to sleep. See [The Session lifecycle](#the-session-lifecycle). |

### Setting up the GitHub App

Create the App once, at <https://github.com/settings/apps/new>:

| Setting | Value |
|---|---|
| Callback URLs | `<HUB_PUBLIC_URL>/auth/github/callback`: add one per URL the Hub is reached at, such as `http://localhost:5173/auth/github/callback` and `https://hub.dige.dev/auth/github/callback` |
| Request user authorization (OAuth) during installation | unticked |
| Expire user authorization tokens | ticked |
| Webhook, Active | unticked |
| Repository permissions | Contents: read and write. Pull requests: read and write. Metadata: read-only, which GitHub adds on its own. |
| Where can this GitHub App be installed? | Only on this account |

After creating it:

1. Note the **App ID** and the **Client ID**.
2. Generate a **client secret** and a **private key**; GitHub downloads the key as a `.pem` file.
3. Install the App on your account, choosing only the repos you want Sessions to work on.

Store the credentials on the Hub's host:

| What | Where |
|---|---|
| The private key | `~/.claude-hub/github-app.pem`, with `chmod 600` |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY_PATH` | `.env.local` in the repo root, which git ignores (as it does `.env*` and `*.pem`) |

```sh
# .env.local
GITHUB_CLIENT_ID=Iv1.…
GITHUB_CLIENT_SECRET=…
GITHUB_APP_ID=…
GITHUB_APP_PRIVATE_KEY_PATH=/Users/you/.claude-hub/github-app.pem
```

`bun run hub` and `bun run runner-token` read `.env.local` when it exists (Bun loads it from the repo root, where those scripts run), so no flag is needed. Values already in the environment win.

Only the Hub's host needs these. Runners never hold App credentials: per [ADR 0005](docs/adr/0005-git-remote-operations-are-host-tools.md) they get short-lived tokens from the Hub. Sign-in uses only the client id and secret; the git tools (#13) will read `GITHUB_APP_ID` and `GITHUB_APP_PRIVATE_KEY_PATH`, and until then those two are unused.

### Trying it on one machine, without GitHub

```sh
CLAUDE_HUB_DEV_LOGIN=1 bun run hub      # the Hub, with dev login
bun run runner-token "$(hostname -s)"   # prints this machine's Runner token, once
bun run web                             # the web UI on http://localhost:5173
```

Open <http://localhost:5173> and sign in with dev login. (With the GitHub App set up, drop `CLAUDE_HUB_DEV_LOGIN=1` and sign in with GitHub.)

Running `runner-token` again for the same name keeps the RunnerId and replaces the token, so the old one stops working. Pass it to the Runner as `RUNNER_TOKEN`:

```sh
RUNNER_TOKEN=chr_… bun run runner
```

### Running a Runner

A Runner connects to the Hub's `/ws/runner` WebSocket with its Runner token as `Authorization: Bearer <RUNNER_TOKEN>`, says hello, and then starts and stops Sessions as the Hub asks. Get a token from the Hub with `bun run runner-token <name>`. If the Hub goes away, the Runner reconnects with backoff (0.5 s, doubling up to 30 s).

Each Session's Claude Code runs in a tmux session named `hub-<session id>`, on the Runner's own tmux server (`tmux -L claude-hub`), so Sessions keep running when the Runner restarts, and the Runner re-adopts them when it comes back. To look at one by hand: `tmux -L claude-hub attach -t hub-<session id>`.

A Session's files live in `<sessions root>/<session id>/`: `claude/`, the empty directory Claude Code runs in, and `workspace/`, the Repo cloned onto the Session's Work branch with the host's own git credentials. Claude Code inherits workspace trust from parent directories, so the Runner trusts the sessions root itself, at startup and before each launch: it sets `projects[<sessions root>].hasTrustDialogAccepted` in Claude Code's config file (`~/.claude.json`, or `$CLAUDE_CONFIG_DIR/.claude.json`), keyed by the root's real path. That is one entry for the root, never one per Session. It never creates the file: if Claude Code has never run on the host, the Runner warns and each Session asks.

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
| `RUNNER_SANDBOX_IMAGE` | `docker:dind` | The Sandbox image. |
| `RUNNER_SANDBOX_CLAUDE_VERSION` | the host's `claude --version` | The Claude Code version Sandboxes run `claude mcp serve` from. |
| `RUNNER_SANDBOX_CLAUDE_CACHE` | `~/.claude-hub/claude-code` | Where the Runner keeps Linux builds of Claude Code for Sandboxes. |

Claude Code starts with the hardened flags of [ADR 0001](docs/adr/0001-claude-on-host-tools-in-sandbox.md) (`--setting-sources ""`, `--strict-mcp-config`, a fixed `--tools` list), with `--session-id` for a new Session or `--resume` to wake one, and with these variables, which the mod uses to talk HTTP to the Hub:

| Env | What it is |
|---|---|
| `CLAUDE_HUB_URL` | The Hub's URL: the Runner's `HUB_URL`. |
| `CLAUDE_HUB_MOD_TOKEN` | The Session's mod token, from the Hub's `StartSession`. |
| `CLAUDE_HUB_SESSION_ID` | The Session's id. |
| `CLAUDE_HUB_TOOLS_SOCKET` | The Session's tool bridge: `<sessions root>/<session id>/tools.sock`. |

It also sets `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1`, because a background command's output would stay in the Sandbox.

### Sandboxes and the tool bridge

Claude Code runs on the host, with the host's credentials. Its tools run in the Session's Sandbox, which never sees those credentials ([ADR 0001](docs/adr/0001-claude-on-host-tools-in-sandbox.md)). When a Session starts, the Runner creates or restarts its Sandbox, a microsandbox VM named `claude-hub-<session id>` with the Workspace mounted at `/workspace`, and reports the Sandbox's state to the Hub.

The Runner then keeps one `claude mcp serve` running inside the Sandbox, restarting it when it exits, and serves it as HTTP on the Session's Unix socket: `tools.sock` in the Session's directory, which only the Runner's user can enter, with the socket itself at mode 0600. The mod answers Bash, Read, Write, Edit, NotebookEdit, Glob and Grep by posting them there (`POST /tools/call`, see `packages/protocol/src/ToolBridge.ts`). Claude Code's working directory, `<session>/claude`, is linked to `/workspace` inside the Sandbox, so paths need no rewriting. If the bridge fails or can't be reached, the mod refuses the call, so a tool never falls back to the host. Every other tool is denied, and so is the `!` shell shortcut in the prompt box, which would run on the host.

**How the Sandbox gets `claude`.** `claude mcp serve` needs a Claude Code binary in the Sandbox. The Runner downloads the Linux musl build of the host's own Claude Code version from the npm registry (`@anthropic-ai/claude-code-linux-<arm64|x64>-musl`) once, checks it against the registry's integrity hash, keeps it in `RUNNER_SANDBOX_CLAUDE_CACHE/<version>/`, and mounts that directory read-only into every Sandbox at `/opt/claude-hub/claude-code`. The musl build is self-contained, so it runs on the default Alpine image (`docker:dind`) and on glibc images alike. Matching the host's version keeps tool results in the shapes the host's Claude Code expects. Claude Code's Bash tool needs `bash`, which `docker:dind` lacks, so the bridge installs it with `apk` when the Sandbox first starts (about half a second). The Sandbox gets no Claude credentials: `mcp serve` makes no model call and needs none.

### The Session lifecycle

A Session is Active, Asleep, Frozen or Archived (see [GLOSSARY.md](GLOSSARY.md)). The Hub decides which; the Runner does what it asks.

- **Going to sleep.** An Active Session with no Turn running, no prompt queued and no Participant present for `HUB_SLEEP_AFTER_MS` (15 minutes) is put to sleep; so is one where someone presses **Sleep now**. The Hub sends `StopSession` `Sleep`, and the Runner stops Claude Code, runs `docker stop` on the Sandbox's containers, stops the Sandbox keeping its volumes, keeps the Workspace, and reports `SessionStopped`. Only then does the Hub record the Session Asleep. Prompts sent meanwhile wait, and wake it once it is.
- **Waking.** A prompt to an Asleep Session wakes it, as does **Wake now** on its banner. The Hub records it Active and sends `StartSession` with `resume`, the Claude Code session id from the mod's last hello. The Runner restarts the Sandbox on the same volumes, so `node_modules`, the package cache and Docker's data are as they were, and starts Claude Code with `--resume`, which keeps the conversation. Prompts are delivered once the new mod has said hello.
- **A failed start.** If Claude Code can't start, whether for a new Session or a wake, the Session is Asleep, with the Runner's reason in its history as the `SessionStateChanged` message. Its queued prompts stay queued and nothing retries on its own: the next prompt or **Wake now** tries again. A Claude Code that exits on its own leaves the Session Asleep too.
- **Frozen.** While its Runner is offline a Session is Frozen. Prompts sent to it wait in its queue. When the Runner is back, the Session is Active if its Claude Code is still running in tmux, and otherwise Asleep, and woken at once if prompts are waiting.
