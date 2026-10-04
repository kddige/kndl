---
title: Commands
description: The claude-hub command for installed Hubs and Runners, and the bun run scripts at a checkout's root.
sidebar:
  order: 2
---

An installed Hub or Runner is run with the [`claude-hub` command](#the-claude-hub-command). A checkout, for working on claude-hub itself, is run with the [`bun run` scripts](#scripts-in-a-checkout) at its root.

## The `claude-hub` command

[install.sh](/how-to/install/#install) writes it to `~/.local/bin/claude-hub`. It runs the CLI from the install, `~/.claude-hub/app`. From a checkout, `bun run cli <command>` runs the same CLI.

Either way it manages the installed home: `CLAUDE_HUB_HOME`, or else `~/.claude-hub`. It never touches a checkout's dev home. Where there's no install in that home, `status`, `doctor`, `update`, `onboard` and `hub|runner install` say so and how to install, and exit 1, without creating anything.

| Command | What it does |
|---|---|
| `claude-hub onboard` | Sets the machine up as a Hub, a Runner or both: prerequisites, `hub.env` and `runner.env`, builds, services. See [below](#claude-hub-onboard). |
| `claude-hub status` | What's installed (commit, and the branch it follows or that it's pinned), each service's state, the Hub's URL and `/health`, and whether the Runner is connected. Exits 1 only when there's no install; `doctor` is the check. |
| `claude-hub logs [hub\|runner] [-f] [-n <lines>]` | Prints the last 100 lines (`-n`) of the service's log, and with `-f` follows it. The role can be left out when the machine has only one. |
| `claude-hub doctor [--fix] [--yes]` | Checks the prerequisites, the env files and their permissions, that the Hub and Runner accept their configuration, the web UI and mod builds, the trust entry in `~/.claude.json`, claude-hub data in the home without its env file, the services, the Hub's health, whether the Runner reaches the Hub, and, with a GitHub App in `hub.env`, that the App and each installation have [the permissions the Hub needs](/how-to/set-up-the-github-app/#keep-the-permissions-in-step), or, with GitHub sign-in on and no App, fails, since no one signed in with GitHub can then see a Session. Prints `ok`, `!!` (a warning) or `XX` (a failure) for each, and exits 1 on a failure. `--fix` repairs what it can, after asking (`--yes` doesn't ask), then checks again. It moves old data aside only when you confirm it in a terminal, even with `--yes`. |
| `claude-hub update [--ref <ref>]` | Updates the install: fetches, moves to the target, runs `bun install`, rebuilds the web UI and the mod, rewrites and restarts the installed services, and runs `doctor`. `upgrade` is the same command. See [below](#claude-hub-update). |
| `claude-hub uninstall [--purge] [--yes]` | Stops and removes the services, removes the `claude-hub` command and the install, and keeps the home's data. `--purge` removes the whole home. Asks first; without a terminal it needs `--yes`. |
| `claude-hub hub install\|start\|stop\|status` | The Hub's service. `install` writes the service file and (re)starts it; `stop` stops it until the next `start` or login; `status` exits 1 unless it runs. |
| `claude-hub runner install\|start\|stop\|status` | The same for the Runner's service. |
| `claude-hub runner token <name>` | Issues a token for the Runner named `<name>`, as [`bun run runner-token`](#bun-run-runner-token-name) does, in the installed Hub's database. Run it on the Hub's machine. |
| `claude-hub secrets key` | Prints a new `HUB_SECRETS_KEY`, as [`bun run secrets-key`](#bun-run-secrets-key) does. It changes nothing. |

`--help` on any command lists its flags, and `--version` prints the commit the CLI runs from.

### `claude-hub onboard`

Each question has a flag, and a flag that's given isn't asked. Onboard also keeps what `hub.env` and `runner.env` already answer, unless `--reset`.

| Flag | Answers |
|---|---|
| `--role hub\|runner\|both` | What the machine runs. |
| `--reach local\|lan\|https` | Who reaches the Hub: this machine only (`HOST=127.0.0.1`), the local network over plain HTTP (`HOST=0.0.0.0`), or anyone through an HTTPS proxy or tunnel. |
| `--port <port>` | The Hub's `PORT`, `7777` by default. |
| `--public-url <url>` | The Hub's `HUB_PUBLIC_URL`. `local` uses `http://127.0.0.1:<port>`; `lan` suggests this machine's network address; `https` needs an `https:` URL. |
| `--insecure-cookies` | `lan` only: sets `HUB_INSECURE_COOKIES=1`. Off by default. |
| `--dev-login` | `local` only: sets `CLAUDE_HUB_DEV_LOGIN=1`. |
| `--github-app create\|manual\|skip` | The GitHub App. `create` creates it on GitHub from claude-hub's manifest, in a browser, and saves its settings and private key; `manual` asks for the settings of an App you made yourself; `skip` leaves `hub.env`'s as they are. Both `create` and `manual` need a terminal. See [Set up the GitHub App](/how-to/set-up-the-github-app/). |
| `--hub-url <url>` | A Runner's `HUB_URL`, for a Hub on another machine. With `--role both` it's the Hub's loopback URL. |
| `--token <chr_…>` | A Runner's `RUNNER_TOKEN`, from `claude-hub runner token <name>` on the Hub's machine. With `--role both`, onboard issues one when it's left out. |
| `--runner-name <name>` | The Runner's `RUNNER_NAME`, by default the short hostname. |
| `--install-prerequisites` | Install what's missing without asking. Some steps use `sudo`. |
| `--no-services` | Write the settings and build, but don't install or start the services. |
| `--linger`, `--no-linger` | Linux: run `loginctl enable-linger`, so the services run while you're logged out and start at boot. |
| `--non-interactive` | Never ask. A yes-or-no question takes its default, and any other missing answer fails with the flag it needs. Onboard also never asks without a terminal. |
| `--reset` | Ask again instead of keeping the existing settings. Keeps `HUB_SECRETS_KEY`. |
| `--move-old-data` | When the home holds claude-hub data without its env file, such as a checkout's old `sessions/`, rename each entry to `<name>.old-<YYYYMMDD>` without asking. Nothing is deleted. See [Troubleshooting](/troubleshooting/install/#the-home-holds-old-claude-hub-data). |

Every yes-or-no flag has a `--no-` form, such as `--no-install-prerequisites`.

Onboard asks every question before it writes anything, and writes each file whole, so Esc or Ctrl-C at a question leaves the home as it was, and exits 130. Ctrl-C during a long step (an install, a build, starting a service) stops that step's command and exits 130 too.

### `claude-hub update`

| Command | What it does |
|---|---|
| `claude-hub update` | Moves to the latest commit of the branch the install follows, `main` by default. A pinned install stays where it is, and says how to follow `main` again. |
| `claude-hub update --ref <branch>` | Moves to that branch, and follows it from then on. `--branch` is the same flag. |
| `claude-hub update --ref <tag or commit>` | Moves to it, and pins the install there. |

The install's checkout belongs to the CLI: `update` discards changes made in it.

## Scripts in a checkout

Every script runs from the root of a claude-hub checkout. They keep their state in the dev home, `~/.claude-hub-dev`, and the Hub's settings in `packages/hub/.env.local`.

### Running claude-hub

| Command | What it does |
|---|---|
| `bun run hub` | Starts the Hub on `HOST:PORT` (`127.0.0.1:7777`). Reads `packages/hub/.env.local`. |
| `bun run runner` | Builds the `hub-link` mod, then starts a Runner. Needs `RUNNER_TOKEN`. |
| `bun run web` | Starts Vite's dev server for the web UI on <http://localhost:5173>, passing `/auth`, `/health` and `/ws` through to the Hub. |
| `bun run web:build` | Builds the web UI into `packages/web/dist`, which the Hub serves. |
| `bun run cli <command>` | Runs the [`claude-hub` command](#the-claude-hub-command) from the checkout. It manages the installed home, not the dev home. |

### Setting up

#### `bun run runner-token <name>`

Issues a token for the Runner named `<name>` and prints it, once:

```
Runner build-box (…). Its token, shown only now:

  chr_…

Any earlier token for this Runner no longer works. Give the token to the Runner as RUNNER_TOKEN.
```

The Hub stores only a hash. Issuing again for the same name keeps the Runner's id and its Sessions, and replaces its token. Run it on the Hub's machine: it writes to the Hub's database.

#### `bun run secrets-key`

Prints a new `HUB_SECRETS_KEY`, 32 random bytes in base64, for encrypting Sensitive values. It changes nothing: put the key in `packages/hub/.env.local` yourself, and back it up with the database.

### Checks

| Command | What it does |
|---|---|
| `bun test` | Runs every package's tests. `CLAUDE_HUB_SANDBOX_IT=1` adds the ones that boot real Sandboxes. |
| `bun run typecheck` | Runs each package's `typecheck` script: `tsc --noEmit` for the Hub, Runner, CLI, protocol and web UI, a script for the mod, and `astro check` for this site. |
| `bun run lint` | Lints with oxlint; a warning fails it. |
| `bun run format` | Formats with oxfmt. `bun run format:check` only checks. |
| `bun run mod:build` | Builds the mod's hook library into `packages/mod/hooks/hub-link-lib.js`. |
| `bun run mod:check` | Builds the mod, then runs `claude plugin validate` and `claude plugin test` on it. |

### This site

| Command | What it does |
|---|---|
| `bun run docs:dev` | Serves this site with hot reload on <http://localhost:4321/claude-hub/>. |
| `bun run docs:build` | Builds it into `packages/docs/dist`. |
| `bun run --filter @claude-hub/docs brand` | Makes the logo's PNG and ICO files from the SVGs in `brand/`, and copies the favicons into the site's and the web UI's `public/` folders. |
