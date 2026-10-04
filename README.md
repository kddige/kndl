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
| [`packages/web`](packages/web) | The web UI: React on Vite, built from [Base UI](https://base-ui.com) primitives and styled with StyleX. The sidebar (Sessions grouped by Repo, plus Environments, Shared variables and Archived Sessions) and the Session view, on a typed client for the web channel (`src/hub`). The UI kit is at `/kit`. |
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
| `bun run secrets-key` | Prints a new random `HUB_SECRETS_KEY`, for encrypting Sensitive variable values. See [Environments](#environments). | |
| `bun run runner` | A Runner for this machine; see [Running a Runner](#running-a-runner). | `HUB_URL` (`http://127.0.0.1:7777`), `RUNNER_TOKEN` (required), `RUNNER_NAME` (short hostname) |
| `bun run web` | The web UI's Vite dev server on <http://localhost:5173>. It passes `/auth`, `/health` and `/ws` through to the Hub, so the web UI and the Hub share one origin. | `HUB_URL` (`http://127.0.0.1:7777`); `VITE_FAKE_HUB=1` runs it against an in-process fake Hub that plays a scripted Session instead, and `VITE_FAKE_HUB=signed-out` starts that signed out |
| `claude --plugin-dir packages/mod` | Claude Code with the `hub-link` mod loaded. Build it first with `bun run mod:build`. | |

Each package's own scripts (`start`, `dev`, `build`, `typecheck`) also run from inside it with `bun run <script>`.

## Signing in

Every Hub route but `GET /health` and the sign-in routes needs a credential, because code in a Sandbox can reach the Hub ([ADR 0004](docs/adr/0004-the-sandbox-is-the-security-boundary.md)):

| Who | Credential | Routes |
|---|---|---|
| People | A sign-in cookie, set by GitHub sign-in or dev login. HttpOnly, SameSite=Lax, host-only, and Secure unless the web UI is on `localhost` over HTTP (or `HUB_INSECURE_COOKIES` is set). Requests that use it must come from the web UI's origin (`HUB_PUBLIC_URL`). | `GET /auth/me`, `POST /auth/sign-out`, `/ws/web` |
| Runners | A Runner token, `Authorization: Bearer chr_…`. It names the Runner's RunnerId. | `/ws/runner` |
| A Session's mod | A mod token, `Authorization: Bearer chm_…`, scoped to one Session. The Hub issues it in `StartSession.modToken`; the Runner hands it to Claude Code on the host, never to the Sandbox. | `POST /mod/hello`, `POST /mod/events`, `GET /mod/commands` |

The Hub keeps only SHA-256 hashes of these tokens.

The Hub reads its sign-in and lifecycle settings from the environment:

| Env | Default | What it does |
|---|---|---|
| `HUB_PUBLIC_URL` | `http://localhost:5173` | Where browsers reach the web UI and, through it, the Hub. GitHub sends people back here, and cookie-authenticated requests must come from this origin. |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | unset | The GitHub App's client id and secret (issue #1). Unset, GitHub sign-in is off. Set the App's callback URL to `<HUB_PUBLIC_URL>/auth/github/callback`. |
| `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY_PATH` | unset | The App's id and the path to its private key. The Hub mints short-lived installation tokens from them for the Runners' clones and WIP pushes, and for `git` and `gh` in each Session's Sandbox ([ADR 0010](docs/adr/0010-the-sandbox-gets-a-github-token.md)). Unset, Runners use their host's own git credentials and Sandboxes get no GitHub token: see [Git from Sessions](#git-from-sessions). |
| `CLAUDE_HUB_DEV_LOGIN` | off | `1` turns on dev login: `POST /auth/dev` signs you in as a local Participant without GitHub. The Hub refuses to start with it unless `HOST` and `HUB_PUBLIC_URL` are both loopback, and only answers it for loopback callers. |
| `CLAUDE_HUB_DEV_USER` | `$USER` | Who dev login signs you in as, when the request names no `login`. |
| `HUB_INSECURE_COOKIES` | off | `1` drops `Secure` from the Hub's cookies when `HUB_PUBLIC_URL` is plain HTTP, such as `http://192.168.1.10:5173`. Browsers drop Secure cookies set over HTTP anywhere but `localhost`, so sign-in there fails without it, and the Hub warns at startup. The trade-off: sign-in tokens then travel in cleartext, so anyone who can watch the network can take over a sign-in. Prefer HTTPS, an SSH tunnel (`ssh -L 5173:localhost:5173 <host>`, then <http://localhost:5173>) or Tailscale Serve, which gives the Hub an HTTPS URL; use this only on a network you trust. The Hub warns at every startup while it's on. It does nothing over HTTPS. |
| `HUB_SLEEP_AFTER_MS` | `900000` (15 minutes) | How long an Active Session goes with no Turn running, no prompt queued and no Participant present before the Hub puts it to sleep. See [The Session lifecycle](#the-session-lifecycle). |
| `HUB_ARCHIVE_RETENTION_MS` | `2592000000` (30 days) | How long a deleted (Archived) Session can be restored before the Hub purges it. See [The Session lifecycle](#the-session-lifecycle). |
| `HUB_SECRETS_KEY` | unset | 32 random bytes, base64 (`bun run secrets-key` makes one), that Sensitive variable values are encrypted with at rest. Unset, Sensitive values can't be saved. Once any are saved, the Hub refuses to start without the same key: keep it with the database's backups, as the values can't be read without it. See [Environments](#environments). |

### Setting up the GitHub App

Create the App once, at <https://github.com/settings/apps/new>:

| Setting | Value |
|---|---|
| Callback URLs | `<HUB_PUBLIC_URL>/auth/github/callback`: add one per URL the Hub is reached at, such as `http://localhost:5173/auth/github/callback` and `https://hub.dige.dev/auth/github/callback` |
| Request user authorization (OAuth) during installation | unticked |
| Expire user authorization tokens | ticked |
| Webhook, Active | unticked |
| Repository permissions | Contents: read and write. Pull requests: read and write. Metadata: read-only, which GitHub adds on its own. Each Session's Sandbox gets a token with every permission you grant here, on its own Repo, so grant only what you want Claude to have; add Workflows: read and write if Sessions should change `.github/workflows`. |
| Where can this GitHub App be installed? | Only on this account |

After creating it:

1. Note the **App ID** and the **Client ID**.
2. Generate a **client secret** and a **private key**; GitHub downloads the key as a `.pem` file.
3. Install the App on your account, choosing only the repos you want Sessions to work on.

Store the credentials on the Hub's host:

| What | Where |
|---|---|
| The private key | `~/.claude-hub/github-app.pem`, with `chmod 600` |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY_PATH` | `packages/hub/.env.local`, which git ignores (as it does `.env*` and `*.pem` anywhere) |

```sh
# packages/hub/.env.local
GITHUB_CLIENT_ID=Iv1.…
GITHUB_CLIENT_SECRET=…
GITHUB_APP_ID=…
GITHUB_APP_PRIVATE_KEY_PATH=/Users/you/.claude-hub/github-app.pem
HUB_SECRETS_KEY=…   # from `bun run secrets-key`
```

`bun run hub` and `bun run runner-token` read `packages/hub/.env.local` when it exists (both run in `packages/hub`, where Bun looks for it), so no flag is needed. Values already in the environment win.

Only the Hub's host needs these. Sign-in uses the client id and secret; installation tokens use `GITHUB_APP_ID` and `GITHUB_APP_PRIVATE_KEY_PATH`. Only the Hub holds the App's credentials: Runners never see the private key, and get short-lived installation tokens from the Hub when they need one ([ADR 0010](docs/adr/0010-the-sandbox-gets-a-github-token.md)).

**Protect the default branch.** Anything running in a Session's Sandbox can push any branch of its Repo and merge its pull requests (see [Git from Sessions](#git-from-sessions)). The guardrail is a GitHub ruleset on each Repo's default branch, under the Repo's Settings, Rules, Rulesets: require a pull request before merging, with at least one approval, and block force pushes. Leave the App off the ruleset's bypass list.

### Trying it on one machine, without GitHub

```sh
CLAUDE_HUB_DEV_LOGIN=1 bun run hub      # the Hub, with dev login
bun run runner-token "$(hostname -s)"   # prints this machine's Runner token, once
bun run web                             # the web UI on http://localhost:5173
```

On SIGTERM or SIGINT the Hub answers any waiting mod long poll with no commands, closes the Runner and web WebSockets with 1001 (going away), and exits within a second. Runners reconnect when it comes back.

Open <http://localhost:5173> and sign in with dev login. (With the GitHub App set up, drop `CLAUDE_HUB_DEV_LOGIN=1` and sign in with GitHub.)

Running `runner-token` again for the same name keeps the RunnerId and replaces the token, so the old one stops working. Pass it to the Runner as `RUNNER_TOKEN`:

```sh
RUNNER_TOKEN=chr_… bun run runner
```

### Running a Runner

A Runner connects to the Hub's `/ws/runner` WebSocket with its Runner token as `Authorization: Bearer <RUNNER_TOKEN>`, says hello, and then starts and stops Sessions as the Hub asks. Get a token from the Hub with `bun run runner-token <name>`. If the Hub goes away, the Runner reconnects with backoff (0.5 s, doubling up to 30 s).

Each Session's Claude Code runs in a tmux session named `hub-<session id>`, on the Runner's own tmux server (`tmux -L claude-hub`), so Sessions keep running when the Runner restarts, and the Runner re-adopts them when it comes back, restarting each one's Sandbox if it stopped and bringing its tool bridge back up. On SIGTERM or SIGINT the Runner exits at once and leaves those tmux sessions running. To look at one by hand: `tmux -L claude-hub attach -t hub-<session id>`.

A Session's files live in `<sessions root>/<session id>/`: `claude/`, the empty directory Claude Code runs in, and `workspace/`, the Repo cloned onto the Session's Work branch, with an installation token from the Hub when it has the GitHub App, and otherwise with the host's own git credentials. Claude Code inherits workspace trust from parent directories, so the Runner trusts the sessions root itself, at startup and before each launch: it sets `projects[<sessions root>].hasTrustDialogAccepted` in Claude Code's config file (`~/.claude.json`, or `$CLAUDE_CONFIG_DIR/.claude.json`), keyed by the root's real path. That is one entry for the root, never one per Session. It never creates the file: if Claude Code has never run on the host, the Runner warns and each Session asks.

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
| `RUNNER_SANDBOX_IMAGE` | `docker:dind` | The Sandbox image of a Session whose Repo has no Environment. |
| `RUNNER_SANDBOX_CLAUDE_VERSION` | the host's `claude --version` | The Claude Code version Sandboxes run `claude mcp serve` from. |
| `RUNNER_SANDBOX_CLAUDE_CACHE` | `~/.claude-hub/claude-code` | Where the Runner keeps Linux builds of Claude Code for Sandboxes. |
| `RUNNER_SANDBOX_MAX_CPUS` | the host's CPU count | The most CPUs an Environment's Sandbox gets, whatever its Environment asks for. |
| `RUNNER_SANDBOX_MAX_MEMORY_MIB` | half the host's memory | The most memory, in MiB, an Environment's Sandbox gets. |
| `RUNNER_SANDBOX_KEEP_BUILDS` | `3` | How many builds of each Repo's Environment the Runner keeps. |

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

Several Runners can share one host, and so one microsandbox. Each labels the Sandboxes and volumes it makes with `claude-hub.runner=<Runner mark>`, where the mark is a digest of its tmux socket name (`RUNNER_TMUX_SOCKET`) and sessions root (`RUNNER_SESSIONS_ROOT`). Both are fixed by its configuration, so the mark survives restarts and is known before the Runner reaches the Hub. They are also what decides which Sessions it re-adopts. At startup the Runner reconciles only its own Sandboxes: one for a Session it isn't running is stopped (never destroyed) and logged. Other Runners' Sandboxes, and unlabelled ones made before Runners labelled theirs, are left alone and only logged. Changing either setting gives the Runner a new mark, so it no longer reconciles the Sandboxes it made before.

The Runner then keeps one `claude mcp serve` running inside the Sandbox, restarting it when it exits, and serves it as HTTP on the Session's Unix socket: `tools.sock` in the Session's directory, which only the Runner's user can enter, with the socket itself at mode 0600. The mod answers Bash, Read, Write, Edit, NotebookEdit, Glob and Grep by posting them there (`POST /tools/call`, see `packages/protocol/src/ToolBridge.ts`). Claude Code's working directory, `<session>/claude`, is linked to `/workspace` inside the Sandbox, so paths need no rewriting. If the bridge fails or can't be reached, the mod refuses the call, so a tool never falls back to the host. Every other tool is denied, and so is the `!` shell shortcut in the prompt box, which would run on the host.

**How the Sandbox gets `claude`.** `claude mcp serve` needs a Claude Code binary in the Sandbox. The Runner downloads the Linux build of the host's own Claude Code version from the npm registry once, checks it against the registry's integrity hash, keeps it in `RUNNER_SANDBOX_CLAUDE_CACHE`, and mounts that directory read-only into every Sandbox at `/opt/claude-hub/claude-code`. There are two builds, and an image runs only one: the musl build (`@anthropic-ai/claude-code-linux-<arm64|x64>-musl`, kept in `<version>/`) needs musl's loader, as on Alpine and the default `docker:dind`, and the glibc build (`@anthropic-ai/claude-code-linux-<arm64|x64>`, kept in `<version>-glibc/`) runs on Debian, Ubuntu and the like. An Environment's build checks its image for `/lib/ld-musl-*` and records which one its Sandboxes use. Matching the host's version keeps tool results in the shapes the host's Claude Code expects. Claude Code's Bash tool needs `bash`, which `docker:dind` lacks, so the bridge installs it with `apk` when the Sandbox first starts (about half a second). The Sandbox gets no Claude credentials: `mcp serve` makes no model call and needs none.

### The Session lifecycle

A Session is Active, Asleep, Frozen or Archived (see [GLOSSARY.md](GLOSSARY.md)). The Hub decides which; the Runner does what it asks.

- **Going to sleep.** An Active Session with no Turn running, no prompt queued and no Participant present for `HUB_SLEEP_AFTER_MS` (15 minutes) is put to sleep; so is one where someone presses **Sleep now**. The Hub sends `StopSession` `Sleep`, and the Runner stops Claude Code, runs `docker stop` on the Sandbox's containers, stops the Sandbox keeping its volumes, keeps the Workspace, and reports `SessionStopped`. Only then does the Hub record the Session Asleep. Prompts sent meanwhile wait, and wake it once it is.
- **Waking.** A prompt to an Asleep Session wakes it, as does **Wake now** on its banner. The Hub records it Active and sends `StartSession` with `resume`, the Claude Code session id from the mod's last hello. The Runner restarts the Sandbox on the same volumes, so `node_modules`, the package cache and Docker's data are as they were, and starts Claude Code with `--resume`, which keeps the conversation. Prompts are delivered once the new mod has said hello.
- **A failed start.** If Claude Code can't start, whether for a new Session or a wake, the Session is Asleep, with the Runner's reason in its history as the `SessionStateChanged` message. Its queued prompts stay queued and nothing retries on its own: the next prompt or **Wake now** tries again. A Claude Code that exits on its own leaves the Session Asleep too.
- **Frozen.** While its Runner is offline a Session is Frozen. Prompts sent to it wait in its queue. When the Runner is back, the Session is Active if its Claude Code is still running in tmux, and otherwise Asleep, and woken at once if prompts are waiting.
- **Deleting.** Any Participant can delete a Session, from the trash button in its header. Deleting archives it at once ([ADR 0003](docs/adr/0003-sessions-belong-to-the-repo.md)): the Hub records it Archived and sends `StopSession` `Archive`, and the Runner stops Claude Code, pushes the WIP ref, and destroys the Sandbox with its volumes, keeping the Workspace and Claude Code's state. If the WIP push fails the archive still completes, and the failure is in the Session's history. An Archived Session is hidden from the sidebar, refuses prompts, and its terminal can't be opened; its queued prompts wait for a restore.
- **Restoring.** The toast after a delete has an **Undo**, and **Archived Sessions** in the sidebar lists every Repo's Archived Sessions with who deleted them and when, each with **Restore**. A restored Session is Asleep (Frozen while its Runner is offline), and the next prompt wakes it. Its Sandbox was destroyed, so the wake creates a fresh one on the kept Workspace, and `--resume` keeps the conversation; `node_modules` and Docker's data are gone with the old volumes.
- **Purging.** `HUB_ARCHIVE_RETENTION_MS` (30 days) after it was archived, a Session is purged. A periodic sweep on the Hub deletes the Session's log, Prompt queue and rows, tells the web clients `SessionRemoved`, and keeps a note to purge it on its Runner. It sends the Runner `PurgeSession`, and the Runner deletes the Session's directory (the Workspace, Claude Code's state and the host git directory) and any Sandbox or volumes left, then answers `SessionPurged`, which clears the note. A Runner that is offline gets `PurgeSession` when it is back, on every connection until it answers.
- **History.** Every delete, restore, sleep and stop is in the Session's history with who did it, and shows in the transcript.

### Environments

Each Repo has one Environment, the recipe its Sessions' Sandboxes are built from ([ADR 0009](docs/adr/0009-environments.md), and see [GLOSSARY.md](GLOSSARY.md)). Any signed-in user can change it. The Hub keeps it, the Runner builds it, and the web UI sets it up: each Repo's Environment screen (from the Sessions list, or `/repos/<owner>/<name>/environment`) and the Hub-wide shared variables screen (`/variables`).

- **The recipe.** A base image (`buildpack-deps:bookworm` by default: Debian with curl, git, a compiler and the usual `-dev` libraries), a bootstrap script run once per build, an optional start script run at each Session start in the Workspace, whether Docker runs in the Sandbox, dependency folders, and CPUs and memory. A dependency-folder pattern such as `**/node_modules` matches folders in the Workspace that get their own volume; with a "next to" file such as `package.json`, only those beside that file. The defaults are `node_modules` next to `package.json`, `.venv` next to `pyproject.toml` and `target` next to `Cargo.toml`.
- **Variables.** A variable is Plain, its value shown to everyone, or Sensitive, write-only: the Hub encrypts its value with AES-256-GCM under `HUB_SECRETS_KEY` and never sends it to the web. A Sensitive variable reaches the bootstrap only when marked available at build; Plain ones always do. Names are environment-variable names, unique in an Environment, and `CLAUDE_HUB_*` is the Runner's.
- **Shared variables.** Hub-wide variables, Plain or Sensitive, that an Environment links under a name of its own, with its own available-at-build. A linked shared variable can't be deleted, nor its value changed while a link makes it available at build.
- **Applying.** Changes are a draft, applied as a whole as a new version, recorded with who applied it and when (never values). A draft that changes the build (image, scripts, Docker, dependency folders, or the variables available at build, values included) needs a passing Test build of exactly that draft on a Runner you pick: the Hub records each result against a keyed digest of the draft's build inputs. Other changes, such as resources or rotating a Sensitive value not available at build, apply at once.
- **Runners and values.** `StartSession` carries the Environment's recipe and version, with variable names but no values. A Runner fetches values over its WebSocket (`FetchVariables`), only for a Session of its own that is Active or a Test build it was sent, and keeps them in memory. It reports the version a Session runs on, so the Hub shows Sessions on an older version.
- **On the Runner.** The first time a Session needs a build version the Runner hasn't built, it builds it, showing the output in the Session's terminal: a Sandbox on the Environment's image, without the Workspace, installs Docker if toggled and runs the bootstrap with the variables available at build, reads its login shell's environment (below), then its disk is saved as a microsandbox snapshot, one group per Repo, and the Sandbox removed. A failed build fails the Session's start with the end of its output. Each Session's Sandbox boots from the build, with the Workspace and its own disks: one for all its dependency folders, bound at each boot to the folders the patterns match (and to where they would be beside each "next to" file, so a first install lands there), one for caches, and one for Docker's data when toggled. A new Sandbox then runs the start script in `/workspace`. A Session on an older version keeps its Sandbox until its next wake, when the Sandbox is made again from the new version's build, keeping the Workspace and the disks. CPUs and memory are the Environment's, capped by `RUNNER_SANDBOX_MAX_CPUS` and `RUNNER_SANDBOX_MAX_MEMORY_MIB`, with a note in the Session when capped. The Runner keeps the last `RUNNER_SANDBOX_KEEP_BUILDS` builds of each Repo. A Test build runs the bootstrap, then the start script on a fresh clone of the Repo's default branch, made with the host's own git credentials, streaming the log to the web, and leaves nothing behind.
- **The Sandbox's environment.** Each process the Runner starts in a Sandbox (the bootstrap, the start script, `claude mcp serve` and through it every tool Claude runs) gets the same environment a terminal on your own machine would, the way VS Code dev containers' `userEnvProbe` does it. Installers such as mise, rustup, nvm and bun's put themselves on `PATH` through `~/.bashrc` or `~/.profile`, which nothing the Runner starts would read on its own. So after the bootstrap the build runs one interactive login shell, `bash -lic` (`sh -lc` on an image without bash), which reads `/etc/profile`, `~/.profile` or `~/.bash_profile`, and on Debian's `~/.profile`, `~/.bashrc`. The environment it ends with is kept in the build at `/var/lib/claude-hub/login-env.json`. Each new Sandbox probes again in `/workspace` once its start script has run, so the tools also get what that set up (a `mise.toml` in the Repo, say). The start script and `claude mcp serve` get that environment, with the Environment's variables over it. The probe runs with no variable in its environment, so it captures no value, and leaves out entries named as one of the Environment's variables and what the shell sets for itself (`PWD`, `SHLVL` and the like). A login shell that fails or takes more than 60 seconds fails the build with the end of its output. Scripts without a `#!` line run with `bash -e` where the image has bash, `sh -e` otherwise. Claude Code's Bash tool reads `~/.bashrc` itself, for its functions and aliases, but takes `PATH` from `claude mcp serve`'s environment, which is why the Runner passes the probed one there. For example, to give every Session bun through mise:

  ```sh
  # Bootstrap
  curl -fsSL https://mise.run | sh
  echo 'eval "$(~/.local/bin/mise activate bash)"' >> ~/.bashrc
  ~/.local/bin/mise use -g bun@latest
  ```

  ```sh
  # Start script: bun is on PATH here, and in Claude's Bash tool.
  bun install
  ```

  What a Session itself changes in its login environment, such as a line added to `~/.bashrc` or a tool `mise` installs on a `PATH` entry of its own, reaches the tools when the Sandbox is next made from a build, on a new version of the Environment, not at a wake on the same version. The variables are in the environment of each command, so a `~/.bashrc` that uses one sees its value there, though not in the probe.
- **Values on the Runner.** Values are passed in the environment of each process the Runner starts in a Sandbox (the bootstrap, the start script, `claude mcp serve` and so through it every tool), never set on the VM, whose settings microsandbox stores on disk. microsandbox's log of what commands print is linked to `/dev/null` before a Sandbox's first command. What a script writes to the disk, such as a token in an `.npmrc`, stays there: a bootstrap's in the build, on the Runner's disk.
- **Redaction.** The Hub masks Sensitive values, each character with `*`, in everything it stores or shows: a Session's events (prompts, Claude's text, tool input and output, subagents included), its terminal frames, and Test build logs and results. A Session's are its Repo's Sensitive values and linked Sensitive shared variables, plus any value they replaced while a Session that started with it still runs (kept encrypted until then); a Test build's are its draft's. Besides the value itself, it looks for it trimmed, JSON-escaped, URL-encoded and, for a multi-line value such as a key, each of its long lines. Matching skips terminal colour codes and line breaks, so a value wrapped on screen is still found. Claude's text and terminal output stream in pieces: the end of a piece that could start a value is held back until the next piece, at most 100 ms, and then let go masked (or as it is, if under 4 characters). A Sensitive value must be at least 4 characters. Not covered: a value transformed before it's printed (base64, hashed, split up by the program printing it), and one Claude Code's own TUI wraps with indentation in the terminal (its transcript is still redacted). See `packages/hub/src/Redaction.ts`.
- **In the web UI.** The draft stays in your browser until applied, kept across reloads per Repo in `localStorage`, without the values of Sensitive variables. The screen checks it with the protocol's own validators, shows name clashes, says whether it needs a Test build, and streams the Test build's log from the Runner you pick; Apply stays disabled until that exact draft has passed. If someone applied meanwhile, the Hub refuses the stale draft and the screen offers to reload. Saved Sensitive values show as "set" and can only be replaced. The version history lists who applied each version, when, and whether it changed the build.
- **Without an Environment.** A Repo needs an Environment before its first Session: the Hub refuses to create one otherwise. Creating a Session on such a Repo in the web UI goes to its Environment screen, starting from the default draft, and back to creating the Session once applied.
- **Restart.** A Session on an older version shows "Environment changed" with a Restart button. `RestartSession` puts an Active Session with no Turn running to sleep and wakes it as soon as it is Asleep, so its Sandbox is recreated from the latest version; an Asleep one is just woken.

### The terminal mirror

The Session view's **Terminal** tab shows the Session's Claude Code terminal, live, in [xterm.js](https://xtermjs.org). Everyone watching sees the same screen and can type into it. It is the escape hatch for anything the chat doesn't handle: answering Claude Code's dialogs, Esc, Ctrl-C, arrow keys.

- **Frames.** Opening the tab sends `OpenTerminal`. The Hub asks the Runner for a `Snapshot` of the tmux pane, which is the whole screen with its colours and cursor, and then relays the pane's `Output` to everyone watching. The web client draws `Output` only after a `Snapshot`, and each `Snapshot` redraws from scratch, so nothing is drawn twice. After a dropped socket or a Hub restart the client opens the terminal again and waits for a fresh `Snapshot`. A Runner that reconnects sends one too.
- **Size.** A terminal has one size, the tmux pane's. Whoever last typed into it or pressed **Fit to my window** sets that size, fitted to their panel. While the size is still theirs, resizing their window refits it. Everyone else draws the terminal at that size, scaled down when it is bigger than their panel. After every resize the Runner sends everyone a new `Snapshot`, because tmux re-wraps its screen in its own way, which a viewer resizing locally wouldn't match. A resize to the current size does nothing.
- **Who can type.** The Hub relays `TerminalInput` and `TerminalResize` only from a connection that has opened that Session's terminal, and only while the Session is Active. A Session that is Asleep, Frozen or Archived has no running terminal, so keystrokes are refused, and the tab says why. Otherwise typing follows the same rule as sending a prompt: whoever can see the Session can type into it, and today that is every signed-in Participant. Output is only ever written to xterm, which draws it as text, never as HTML.

### Git from Sessions

Claude, and anything else running in a Session's Sandbox, uses plain `git` and `gh` to commit, push, open pull requests and review ([ADR 0010](docs/adr/0010-the-sandbox-gets-a-github-token.md)). There are no git tools in the mod, and nothing refuses `git commit` or `git push` in Bash.

**What a Session can do.** The Sandbox holds a GitHub App installation token for the Session's Repo with every permission the App's installation has. So anything in the Sandbox can push any branch of that Repo and merge its pull requests, for as long as the Session runs. claude-hub doesn't stop it: the guardrail is a GitHub ruleset on the Repo's default branch (see [Setting up the GitHub App](#setting-up-the-github-app)). The token reaches no other Repo.

**The token.** Only the Hub holds the GitHub App's private key. It signs an App JWT (RS256), finds the Repo's installation, and mints an installation token restricted to the Session's one Repo, with no permissions list. Each Session gets its own; none is cached. The Runner asks for one over its WebSocket, for a Session of its own, when the Sandbox starts or wakes, and every 45 minutes while it runs, as each lasts an hour. If there is none (no GitHub App, as in dev mode, or GitHub failing), the Session still starts without it: the Runner logs that once and asks again every five minutes.

**In the Sandbox.** The Runner mounts a tmpfs at `/run/claude-hub` (mode 0700) and writes the token to `/run/claude-hub/github-token` (mode 0600) with the backend's file write, so it is only ever in the VM's memory: never in the VM's environment, which microsandbox stores in its database, never in the VM's root filesystem image, and never on the Runner's disk. Then:

- **git**: a credential helper for `https://github.com` in the system gitconfig (`git config --system`) reads that file, with username `x-access-token`, so `git push` and `git fetch` work in `/workspace` and anywhere else. It is set only if git is in the image when the token arrives, and again at each refresh.
- **gh**: `~/.config/gh/hosts.yml` links to `/run/claude-hub/gh-hosts.yml`, which names the token as `github.com`'s `oauth_token`, with `user: x-access-token` and `git_protocol: https`. `gh auth token` prints it; `gh auth login` isn't needed.

**Installing gh.** claude-hub doesn't install gh. Install it in the Environment's bootstrap script, for example from GitHub's apt repository on the default Debian image:

```sh
# Bootstrap
install -d -m 0755 /etc/apt/keyrings
curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /etc/apt/keyrings/githubcli-archive-keyring.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list
apt-get update && apt-get install -y gh
```

Debian's own `gh` package (`apt-get install -y gh`) works too, but is older.

**Redaction.** The Hub minted the token, so it knows it. It masks the Session's current token and the one before it from the Session's transcript, terminal frames and logs, the same way as Sensitive values (see [Environments](#environments)).

**Commits.** They are authored by whatever identity the Sandbox's git has; set `user.name` and `user.email` in the bootstrap, or let Claude set them. There are no automatic `Co-authored-by` trailers.

**Without the GitHub App** (dev mode), the Sandbox gets no token, so `git push` and `gh` there have nothing to authenticate with, and the Runner clones and pushes the WIP ref with its host's own git credentials.

**Host git.** The Runner still runs git on its host for two things: cloning the Repo into the Workspace, and pushing the WIP ref. With the GitHub App, it uses a separate token minted with `contents:write` only, cached until five minutes before it expires, for one command at a time. That token reaches git only in that command's environment, as an `http.extraHeader` passed through `GIT_CONFIG_COUNT`. It is never written to disk, to a remote URL or to `.git/config`, and never logged.

**Host git and the shared `.git`.** The Workspace, `.git` included, is mounted read-write into the Sandbox, so `.git/config` and `.git/hooks` may hold whatever the Sandbox put there. Host git must never run any of it with a token in its environment. So the Runner runs its git commands with a git directory of its own for the Session (`<sessions root>/<session id>/host-git`), which the Sandbox can't reach, reading the Workspace's objects, index and files as data. Hooks and fsmonitor are off, and it pushes to the URL it builds from `RUNNER_REPO_URL`, never to `remote.origin.url`.

**The WIP ref.** The Runner pushes the Workspace's whole state, uncommitted and untracked files included (ignored ones aren't), to `refs/claude-hub/wip/<session id>` on origin. It force-pushes that one ref only. It builds the commit in a temporary index file (`add -A`, `write-tree`, then `commit-tree` with HEAD as parent), so the Workspace's own index and the Work branch are untouched. It pushes:

- after a Turn ends, when the Hub tells it, if the Workspace changed since the last WIP push;
- before the Session goes to sleep;
- before the Session is archived. Archiving is #18, and today the Runner pushes when the Hub stops a Session with reason `Archive`.

A failed WIP push is logged, and recorded in the Session's history, where the web UI shows it as a notice. It never holds up sleep or anything else. To recover a Session's work: `git fetch origin refs/claude-hub/wip/<session id>`.
