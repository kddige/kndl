---
title: Configuration
description: Every environment variable the Hub, a Runner, the kndl command from a Hub and the web UI's dev server read, with its default.
sidebar:
  order: 2
---

The Hub and Runners read environment variables. Where you set them:

| How kndl runs | Hub | Runner |
|---|---|---|
| An install | `~/.kndl/hub.env` | `~/.kndl/runner.env` |
| A checkout | `packages/hub/.env.local`, or the environment | the environment |

`kndl onboard` writes the env files. After changing one, restart its service with `kndl hub install` or `kndl runner install`. A value already in the environment wins over `.env.local`.

## Hub

| Variable | Default | What it does |
|---|---|---|
| `HOST` | `127.0.0.1` | The address the Hub listens on. |
| `PORT` | `7777` | The port the Hub listens on. |
| `HUB_PUBLIC_URL` | `http://localhost:5173` | Where browsers reach the Hub. GitHub sends people back here after sign-in, cookie-authenticated requests must come from this origin, and pairing links carry it. |
| `HUB_DATABASE` | `<home>/hub.db`; `packages/hub/hub.db` in a checkout | The SQLite database. |
| `HUB_WEB_DIR` | `packages/web/dist` | The web UI's build, which the Hub serves. Without one, the Hub warns at startup and its pages answer 503. |
| `HUB_SECRETS_KEY` | unset | 32 random bytes in base64, from `kndl secrets key`. Encrypts Sensitive values, people's Claude credentials and MCP servers' keys. Unset, none can be saved. Once any are saved, the Hub refuses to start without the same key. If it's lost, see [`secrets-reset`](/reference/commands/#bun-run-secrets-reset---yes). |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | unset | The GitHub App's client ID and secret, for GitHub sign-in. Set both or neither. |
| `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY_PATH` | unset | The GitHub App's ID and the path to its private key, for Repo access, clones and Sandbox tokens. Set both or neither. Unset, GitHub sign-ins have access to no Repo. The Hub checks the App's [permissions](/self-hosting/set-up-the-github-app/#the-permissions) as it starts and every hour. |
| `GITHUB_WEBHOOK_SECRET` | unset | The App's webhook secret, which onboard saves. The Hub doesn't read it. |
| `KNDL_DEV_LOGIN` | off | `1` turns on dev login, which signs anyone in as any name without GitHub. The Hub refuses to start with it unless `HOST` and `HUB_PUBLIC_URL` are both loopback. |
| `KNDL_DEV_USER` | `$USER`, else `dev` | Who dev login signs you in as when you give no name. |
| `HUB_INSECURE_COOKIES` | off | `1` drops `Secure` from the Hub's cookies when `HUB_PUBLIC_URL` is plain HTTP. Sign-in tokens then travel in cleartext. See [Reach the Hub from other machines](/self-hosting/reach-the-hub-from-other-machines/#last-resort-plain-http-on-a-network-you-trust). |
| `HUB_SLEEP_AFTER_MS` | `900000` (15 minutes) | How long an idle Session stays Active before the Hub puts it to sleep. See [Going to sleep](/concepts/session-lifecycle/#going-to-sleep). |
| `HUB_ARCHIVE_RETENTION_MS` | `2592000000` (30 days) | How long an Archived Session can be restored before the Hub purges it. |
| `HUB_REPO_ACCESS_TTL_MS` | `300000` (5 minutes) | How long the Hub trusts GitHub's answer about someone's access to a Repo, and how often it checks again. See [Who can do what](/concepts/security-model/#who-can-do-what). |
| `HUB_MCP_SERVER_CHECK_TIMEOUT_MS` | `5000` (5 seconds) | How long a Session's start waits on each MCP server's check. One that doesn't answer in time doesn't stop the start. |
| `KNDL_HOME` | unset | The home. See [Homes](#homes). |

## Runner

| Variable | Default | What it does |
|---|---|---|
| `HUB_URL` | `http://127.0.0.1:7777` | The Hub. The Runner connects to `/ws/runner` on it, over `wss:` for an `https:` URL. |
| `RUNNER_TOKEN` | required | The Runner's token. `kndl runner join` writes it. Never reaches a Sandbox. |
| `RUNNER_NAME` | the short hostname | The name the Runner says hello with. |
| `RUNNER_SESSIONS_ROOT` | `<home>/sessions` | Where each Session's directory goes. |
| `RUNNER_TMUX_SOCKET` | `kndl`; `kndl-dev` in a checkout | With `RUNNER_SESSIONS_ROOT`, marks the Sandboxes this Runner makes, so Runners sharing a machine keep to their own. |
| `RUNNER_MOD_DIR` | `packages/mod` in the checkout | The mod Claude Code loads. The Runner refuses to start if it isn't built. |
| `RUNNER_REPO_URL` | `https://github.com/{repo}.git` | Where Repos are cloned from. `{repo}` is `owner/name`. |
| `RUNNER_SANDBOX_IMAGE` | `docker:dind` | The image of a Session whose Repo has no Environment. |
| `RUNNER_SANDBOX_CLAUDE_VERSION` | the version this kndl is tested with | The Claude Code version Sandboxes run. Another may not work with the mod. |
| `RUNNER_SANDBOX_CLAUDE_CACHE` | `<home>/claude-code` | Where the Runner keeps Linux builds of Claude Code. |
| `RUNNER_SANDBOX_MAX_CPUS` | the host's CPU count | The most CPUs a Sandbox gets, whatever its Environment asks for. |
| `RUNNER_SANDBOX_MAX_MEMORY_MIB` | half the host's memory | The most memory, in MiB, a Sandbox gets. |
| `RUNNER_SANDBOX_KEEP_BUILDS` | `3` | How many Builds of each Repo's Environment the Runner keeps. |
| `RUNNER_RELAY_PORT` | `RUNNER_PROXY_PORT` if set, else `7778`; `7779` in a checkout | The port of the Runner's [mod relay](/concepts/security-model/#the-mod-relay) on the host's loopback. If it's taken, the Runner logs an error and runs without the relay. |
| `RUNNER_UPDATE_ANY_COMMIT` | unset | `1`: follow the Hub to a commit that isn't on `origin/main`, such as a Hub on a branch. See [Keep Runners on the Hub's commit](/self-hosting/add-a-runner/#keep-runners-on-the-hubs-commit). |
| `KNDL_SERVICE` | unset | Set to `runner` or `hub` by the service files `kndl` installs. A Runner updates itself only when it's set and the Runner runs from `<home>/app`. |
| `CLAUDE_CONFIG_DIR` | unset | Read as Claude Code reads it: the Runner looks there for what Claude Code on this machine kept of Sessions from before they ran in Sandboxes. |
| `KNDL_HOME` | unset | The home. See [Homes](#homes). |

## Homes

An install keeps its state in its home, `~/.kndl`. A checkout uses the dev home, `~/.kndl-dev`, so the two can share a machine. `KNDL_HOME` names another home. A variable that names a path wins over the home's.

| Setting | An install | A checkout |
|---|---|---|
| `RUNNER_SESSIONS_ROOT` | `~/.kndl/sessions` | `~/.kndl-dev/sessions` |
| `RUNNER_SANDBOX_CLAUDE_CACHE` | `~/.kndl/claude-code` | `~/.kndl-dev/claude-code` |
| `RUNNER_TMUX_SOCKET` | `kndl` | `kndl-dev` |
| `RUNNER_RELAY_PORT` | `7778` | `7779` |
| `HUB_DATABASE` | `~/.kndl/hub.db` | `packages/hub/hub.db` |

See [Files and paths](/reference/files-and-paths/) for everything in a home.

## The `kndl` command from a Hub

The install script a Hub serves at `/cli`, and the binary it installs, read these. See [Install the CLI from a Hub](/guides/install-the-cli-from-a-hub/).

| Variable | Default | What it does |
|---|---|---|
| `KNDL_BIN_DIR` | `~/.local/bin` | Where the install script puts `kndl`. |
| `KNDL_URL` | the Hub's `HUB_PUBLIC_URL` origin | The Hub to download from and record, when your machine reaches it at another URL. |
| `XDG_CONFIG_HOME` | `~/.config` | Where the CLI keeps `kndl/cli.json`, with the Hub and its CLI token. |
| `KNDL_NO_SELF_UPDATE` | unset | Set to anything, the binary never updates itself to the Hub's commit. |

## Web UI dev server

| Variable | Default | What it does |
|---|---|---|
| `HUB_URL` | `http://127.0.0.1:7777` | The Hub that Vite passes `/auth`, `/health`, `/runner/` and `/ws` to. |
| `VITE_FAKE_HUB` | unset | `1` runs the web UI against an in-process fake Hub with made-up Sessions. `signed-out` starts it signed out. |

## Tests

| Variable | Default | What it does |
|---|---|---|
| `KNDL_SANDBOX_IT` | unset | `1` adds the tests that boot real microsandbox Sandboxes to `bun test`. |

The variables a Runner gives Claude Code in a Sandbox are in [Inside kndl](/contributing/internals/#what-a-runner-gives-claude-code).
