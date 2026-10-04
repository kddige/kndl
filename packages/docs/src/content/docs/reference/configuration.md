---
title: Configuration
description: Every environment variable the Hub, a Runner and the web UI's dev server read, with its default.
sidebar:
  order: 1
---

The Hub and Runners are configured with environment variables. `bun run hub` and `bun run runner-token` also read `packages/hub/.env.local` when it exists; values already in the environment win.

## Hub

| Variable | Default | What it does |
|---|---|---|
| `HOST` | `127.0.0.1` | The address the Hub listens on. |
| `PORT` | `7777` | The port the Hub listens on. |
| `HUB_PUBLIC_URL` | `http://localhost:5173` | Where browsers reach the web UI and, through it, the Hub: the Hub's own URL when it serves the web UI's build, or Vite's in development. GitHub sends people back here after sign-in, and cookie-authenticated requests must come from this origin. |
| `HUB_DATABASE` | `hub.db` in `packages/hub` | The SQLite database. With `CLAUDE_HUB_HOME` set, `hub.db` in that home. |
| `HUB_WEB_DIR` | `packages/web/dist` | The web UI's build, which the Hub serves. Without one, the Hub warns at startup and its pages answer 503. |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | unset | The GitHub App's client id and secret. Set both, or neither; unset, GitHub sign-in is off. |
| `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY_PATH` | unset | The GitHub App's id and the path to its private key (an RSA PEM). The Hub mints installation tokens from them for Runners' clones and WIP pushes, for `git` and `gh` in Sandboxes, and to check who has access to a Repo. Set both, or neither; unset, Runners use their host's git credentials, Sandboxes get no GitHub token, and GitHub sign-ins have access to no Repo. With them, the Hub also checks the App's permissions against [the ones it needs](/how-to/set-up-the-github-app/#the-permissions) as it starts and every hour. `claude-hub onboard --github-app create` writes all four of the App's settings. |
| `GITHUB_WEBHOOK_SECRET` | unset | The GitHub App's webhook secret. Onboard saves it only for an App GitHub gave a webhook; the Hub doesn't use one yet. |
| `CLAUDE_HUB_DEV_LOGIN` | off | `1` turns on dev login, which signs anyone in as any name without GitHub. The Hub refuses to start with it unless `HOST` and `HUB_PUBLIC_URL` are both loopback, and only answers it for loopback callers. |
| `CLAUDE_HUB_DEV_USER` | `$USER`, else `dev` | Who dev login signs you in as when you give no name. |
| `HUB_INSECURE_COOKIES` | off | `1` drops `Secure` from the Hub's cookies when `HUB_PUBLIC_URL` is plain HTTP. Sign-in tokens then travel in cleartext. See [Reach the Hub from other machines](/how-to/reach-the-hub-from-other-machines/#last-resort-plain-http-on-a-network-you-trust). |
| `HUB_SLEEP_AFTER_MS` | `900000` (15 minutes) | How long an Active Session goes with no Turn running, no prompt queued and no Participant present before the Hub puts it to sleep. |
| `HUB_ARCHIVE_RETENTION_MS` | `2592000000` (30 days) | How long an Archived Session can be restored before the Hub purges it. |
| `HUB_REPO_ACCESS_TTL_MS` | `300000` (5 minutes) | How long the Hub trusts what GitHub said about a person's access to a Repo, and how often it checks everyone connected again. Someone who loses access is out of the Repo's Sessions within twice this. See [Who can do what](/explanation/security-model/#who-can-do-what). |
| `HUB_SECRETS_KEY` | unset | 32 random bytes in base64, from `bun run secrets-key`, that Sensitive values are encrypted with. Unset, Sensitive values can't be saved; once any are saved, the Hub refuses to start without the same key. |
| `CLAUDE_HUB_HOME` | unset | See [Homes](#homes). |

## Runner

| Variable | Default | What it does |
|---|---|---|
| `HUB_URL` | `http://127.0.0.1:7777` | The Hub. The Runner connects to `/ws/runner` on it, over `wss:` for an `https:` URL. |
| `RUNNER_TOKEN` | required | The Runner token from `bun run runner-token`. Kept out of tmux's and Claude Code's environment. |
| `RUNNER_NAME` | the short hostname | The name the web UI shows. |
| `RUNNER_LOGIN` | the account Claude Code is signed in with | How the Runner login is shown. Read from `oauthAccount.emailAddress` in Claude Code's config file when unset; the Runner refuses to start if it finds none. |
| `RUNNER_SESSIONS_ROOT` | `~/.claude-hub-dev/sessions` | Where each Session's directory goes. |
| `RUNNER_TMUX_SOCKET` | `claude-hub-dev` | The tmux server (`tmux -L <name>`) the Sessions run on. |
| `RUNNER_MOD_DIR` | `packages/mod` in the checkout | The `hub-link` mod, loaded into Claude Code with `--plugin-dir`. The Runner refuses to start if it isn't built. |
| `CLAUDE_BIN` | `claude` | The Claude Code executable. |
| `RUNNER_REPO_URL` | `https://github.com/{repo}.git` | Where Repos are cloned from; `{repo}` is `owner/name`. |
| `RUNNER_SANDBOX_IMAGE` | `docker:dind` | The image of a Session whose Repo has no Environment. Every new Session needs one today, so this only matters for older Sessions. |
| `RUNNER_SANDBOX_CLAUDE_VERSION` | the host's `claude --version` | The Claude Code version Sandboxes run `claude mcp serve` from. |
| `RUNNER_SANDBOX_CLAUDE_CACHE` | `~/.claude-hub-dev/claude-code` | Where the Runner keeps Linux builds of Claude Code for Sandboxes. |
| `RUNNER_SANDBOX_MAX_CPUS` | the host's CPU count | The most CPUs a Sandbox gets, whatever its Environment asks for. |
| `RUNNER_SANDBOX_MAX_MEMORY_MIB` | half the host's memory | The most memory, in MiB, a Sandbox gets. |
| `RUNNER_SANDBOX_KEEP_BUILDS` | `3` | How many builds of each Repo's Environment the Runner keeps. |
| `CLAUDE_CONFIG_DIR` | unset | Read as Claude Code reads it: the Runner looks for Claude Code's config file at `$CLAUDE_CONFIG_DIR/.claude.json` instead of `~/.claude.json`. |
| `CLAUDE_HUB_HOME` | unset | See [Homes](#homes). |

## Homes

A Hub or Runner keeps its state in a home. From a checkout, that is the dev home, `~/.claude-hub-dev`, with tmux socket `claude-hub-dev`. `CLAUDE_HUB_HOME` names another, with tmux socket `claude-hub`; the [`claude-hub` command](/reference/commands/#the-claude-hub-command) sets it to `~/.claude-hub` for the services it installs, so a dev Runner and an installed one can share a machine. An installed Hub and Runner read their settings from `<home>/hub.env` and `<home>/runner.env`; see [An installed home](/reference/files-and-paths/#an-installed-home). A variable that names a path still wins over the home's.

| Setting | From a checkout | With `CLAUDE_HUB_HOME=<home>` |
|---|---|---|
| `RUNNER_SESSIONS_ROOT` | `~/.claude-hub-dev/sessions` | `<home>/sessions` |
| `RUNNER_SANDBOX_CLAUDE_CACHE` | `~/.claude-hub-dev/claude-code` | `<home>/claude-code` |
| `RUNNER_TMUX_SOCKET` | `claude-hub-dev` | `claude-hub` |
| `HUB_DATABASE` | `hub.db` in `packages/hub`, beside the `.env.local` holding its `HUB_SECRETS_KEY` | `<home>/hub.db` |

## What a Runner gives Claude Code

Each Session's Claude Code starts with the hardened flags of [ADR 0001](/reference/decisions/0001-claude-on-host-tools-in-sandbox/) (`--setting-sources ""`, `--strict-mcp-config`, a fixed `--tools` list), with `--session-id` for a new Session or `--resume` to wake one, and these variables, which the mod uses:

| Variable | What it is |
|---|---|
| `CLAUDE_HUB_URL` | The Hub's URL: the Runner's `HUB_URL`. |
| `CLAUDE_HUB_MOD_TOKEN` | The Session's mod token. |
| `CLAUDE_HUB_SESSION_ID` | The Session's id. |
| `CLAUDE_HUB_TOOLS_SOCKET` | The Session's tool bridge: `<sessions root>/<session id>/tools.sock`. |
| `CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS` | `1`, since git runs in the Sandbox rather than beside Claude Code. |
| `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS` | `1`, because a background command's output would stay in the Sandbox. |

## Web UI dev server

| Variable | Default | What it does |
|---|---|---|
| `HUB_URL` | `http://127.0.0.1:7777` | The Hub Vite passes `/auth`, `/health` and `/ws` through to. |
| `VITE_FAKE_HUB` | unset | `1` runs the web UI against an in-process fake Hub that plays a scripted Session; `signed-out` starts it signed out. |

## Tests

| Variable | What it does |
|---|---|
| `CLAUDE_HUB_SANDBOX_IT` | `1` adds the tests that boot real microsandbox Sandboxes to `bun test`. |
