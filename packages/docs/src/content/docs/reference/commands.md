---
title: Commands
description: The kndl command for installed Hubs and Runners, and the bun run scripts at a checkout's root.
sidebar:
  order: 1
---

An installed Hub or Runner is run with the [`kndl` command](#the-kndl-command). A Hub also serves the command, as one binary, to [install from it](#the-kndl-command-from-a-hub) on machines that run neither. A checkout, for working on kndl itself, is run with the [`bun run` scripts](#scripts-in-a-checkout) at its root.

## The `kndl` command

[install.sh](/how-to/install/#install) writes it to `~/.local/bin/kndl`. It runs the CLI from the install, `~/.kndl/app`. From a checkout, `bun run cli <command>` runs the same CLI.

Either way it manages the installed home: `KNDL_HOME`, or else `~/.kndl`. It never touches a checkout's dev home. Where there's no install in that home, `status`, `doctor`, `update`, `onboard`, `logs` and `hub|runner install` say so and how to install, and exit 1, without creating anything.

| Command | What it does |
|---|---|
| `kndl onboard` | Sets the machine up as a Hub, a Runner or both: prerequisites, `hub.env` and `runner.env`, builds, services. For a Hub with GitHub sign-in and no Owner yet, it ends with the Hub's [Setup link](/how-to/let-people-in/#become-the-owner). See [below](#kndl-onboard). |
| `kndl status` | What's installed (commit, and the branch it follows or that it's pinned), each service's state, the Hub's URL and `/health`, and whether the Runner is connected. Exits 1 only when there's no install; `doctor` is the check. |
| `kndl logs [hub\|runner] [-f] [-n <lines>]` | Prints the last 100 lines (`-n`) of the service's log, and with `-f` follows it. The role can be left out when the machine has only one. |
| `kndl doctor [--fix] [--yes]` | Checks the prerequisites, the env files and their permissions, that the Hub and Runner accept their configuration, the web UI and mod builds, kndl data in the home without its env file, the services, the Hub's health, whether the Runner reaches the Hub, and, with a GitHub App in `hub.env`, that the App and each installation have [the permissions the Hub needs](/how-to/set-up-the-github-app/#keep-the-permissions-in-step), or, with GitHub sign-in on and no App, fails, since no one signed in with GitHub can then see a Session. Prints `ok`, `!!` (a warning) or `XX` (a failure) for each, and exits 1 on a failure. `--fix` repairs what it can, after asking (`--yes` doesn't ask), then checks again. It moves old data aside only when you confirm it in a terminal, even with `--yes`. |
| `kndl update [--ref <ref>] [--no-update-runners] [--now]` | Updates the install: fetches, moves to the target, runs `bun install`, rebuilds the web UI and the mod, rewrites and restarts the installed services, and runs `doctor`. On the Hub's machine, its Runners follow. `upgrade` is the same command. See [below](#kndl-update). |
| `kndl uninstall [--purge] [--yes]` | Stops and removes the services, removes the `kndl` command and the install, and keeps the home's data. `--purge` removes the whole home. Asks first; without a terminal it needs `--yes`. |
| `kndl hub install\|start\|stop\|status` | The Hub's service. `install` writes the service file and (re)starts it; `stop` stops it until the next `start` or login; `status` exits 1 unless it runs. |
| `kndl hub setup-link` | Prints the Hub's Setup link, as [`bun run setup-link`](#bun-run-setup-link) does, in the installed Hub's database: whoever signs in with it becomes the Hub's Owner. It replaces any earlier link, and is refused once the Hub has an Owner. Run it on the Hub's machine. See [Let people in](/how-to/let-people-in/). |
| `kndl runner join '<link>'` | Makes the machine a Runner with a pairing link from the Hub's Runners page, without touching the Hub's machine. See [below](#kndl-runner-join). |
| `kndl runner install\|start\|stop\|status` | The same for the Runner's service. |
| `kndl runner token <name>` | Issues a token for the Runner named `<name>`, as [`bun run runner-token`](#bun-run-runner-token-name) does, in the installed Hub's database. For a Runner the Hub has, it replaces that Runner's token. Run it on the Hub's machine. A [pairing link](#kndl-runner-join) needs no access to it. |
| `kndl secrets key` | Prints a new `HUB_SECRETS_KEY`, as [`bun run secrets-key`](#bun-run-secrets-key) does. It changes nothing. |
| `kndl login [<hub>] [--no-browser]` | Signs the CLI in to a Hub as you, approving it in a browser. See [below](#kndl-login). |
| `kndl logout` | Signs the CLI out: the Hub revokes its CLI token, and the CLI forgets it. |
| `kndl whoami` | Which Hub the CLI is signed in to, as whom, and on which machine. Exits 1 when it isn't signed in, or the Hub refuses or doesn't answer. |
| `kndl forward [<session>] [<port>...] [--bind <address>]` | Opens a Session's Open ports on `localhost` here, as they open and close, until stopped. See [below](#kndl-forward). |
| `kndl secrets reset [--yes]` | After losing `HUB_SECRETS_KEY`, clears the Sensitive values it encrypted in the installed Hub's database, as [`bun run secrets-reset`](#bun-run-secrets-reset---yes) does. Refused while the Hub runs: stop it with `kndl hub stop` first. Asks first; without a terminal it needs `--yes`. |

`--help` on any command lists its flags, and `--version` prints the commit the CLI runs from, as `kndl v<commit>`.

### `kndl onboard`

Each question has a flag, and a flag that's given isn't asked. Onboard also keeps what `hub.env` and `runner.env` already answer, unless `--reset`.

| Flag | Answers |
|---|---|
| `--role hub\|runner\|both` | What the machine runs. |
| `--reach local\|lan\|https` | Who reaches the Hub: this machine only (`HOST=127.0.0.1`), the local network over plain HTTP (`HOST=0.0.0.0`), or anyone through an HTTPS proxy or tunnel. |
| `--port <port>` | The Hub's `PORT`, `7777` by default. |
| `--public-url <url>` | The Hub's `HUB_PUBLIC_URL`. `local` uses `http://127.0.0.1:<port>`; `lan` suggests this machine's network address; `https` needs an `https:` URL. |
| `--insecure-cookies` | `lan` only: sets `HUB_INSECURE_COOKIES=1`. Off by default. |
| `--dev-login` | `local` only: sets `KNDL_DEV_LOGIN=1`. |
| `--github-app create\|manual\|skip` | The GitHub App. `create` creates it on GitHub from kndl's manifest, in a browser, and saves its settings and private key; `manual` asks for the settings of an App you made yourself; `skip` leaves `hub.env`'s as they are. Both `create` and `manual` need a terminal. See [Set up the GitHub App](/how-to/set-up-the-github-app/). |
| `--pair '<link>'` | A Runner's pairing link, from **Add a Runner** or **Re-pair** on the Hub's Runners page: onboard redeems it for the Runner's token and `HUB_URL`, as [`runner join`](#kndl-runner-join) does. Instead of `--hub-url` and `--token`; with `--hub-url`, the code alone is enough. Runner only. |
| `--hub-url <url>` | A Runner's `HUB_URL`, for a Hub on another machine. With `--role both` it's the Hub's loopback URL. |
| `--token <chr_…>` | A Runner's `RUNNER_TOKEN`, from `kndl runner token <name>` on the Hub's machine. With `--role both`, onboard issues one when it's left out. |
| `--runner-name <name>` | The Runner's `RUNNER_NAME`, by default the short hostname. |
| `--install-prerequisites` | Install what's missing without asking. Some steps use `sudo`. |
| `--no-services` | Write the settings and build, but don't install or start the services. |
| `--linger`, `--no-linger` | Linux: run `loginctl enable-linger`, so the services run while you're logged out and start at boot. |
| `--non-interactive` | Never ask. A yes-or-no question takes its default, and any other missing answer fails with the flag it needs. Onboard also never asks without a terminal. |
| `--reset` | Ask again instead of keeping the existing settings. Keeps `HUB_SECRETS_KEY`. |
| `--move-old-data` | When the home holds kndl data without its env file, such as a checkout's old `sessions/`, rename each entry to `<name>.old-<YYYYMMDD>` without asking. Nothing is deleted. See [Troubleshooting](/troubleshooting/install/#the-home-holds-old-kndl-data). |

Every yes-or-no flag has a `--no-` form, such as `--no-install-prerequisites`.

Onboard asks every question before it writes anything, and writes each file whole, so Esc or Ctrl-C at a question leaves the home as it was, and exits 130. Ctrl-C during a long step (an install, a build, starting a service) stops that step's command and exits 130 too.

### `kndl runner join`

```sh
kndl runner join 'https://hub.example.com#7K2QD-M9XRT-4VBNC-H8PWE'
```

Makes this machine a Runner with a pairing link: **Add a Runner** on the Hub's Runners page makes one, and **Re-pair** one for a Runner that's already there. It's [onboard](#kndl-onboard) with `--role runner --pair '<link>'`: it checks the prerequisites, redeems the code with the Hub (`POST /runner/pair`) for the Runner's token, writes `runner.env` whole, installs and starts the Runner's service, and asks the Hub (`GET /runner/connection`) until it says the Runner is connected, for up to 30 seconds.

| Flag | Answers |
|---|---|
| `--name <name>` | The new Runner's name, by default the short hostname: up to 63 letters, digits, dots, dashes and underscores, starting with a letter or digit. The name is the Runner's identity: one the Hub has is refused, and a removed Runner's name takes over that Runner's record and Archived Sessions, so use a new name for a clean slate ([Runner names](/how-to/add-a-runner/#runner-names)). A Re-pair keeps the Runner's own name. |
| `--hub-url <url>` | The Hub's URL, when what's given is only the code. |
| `--install-prerequisites` | Install what's missing without asking. Some steps use `sudo`. |
| `--no-services` | Write `runner.env` and build, but don't install or start the service. |
| `--linger`, `--no-linger` | Linux: keep the service running while you're logged out. |
| `--non-interactive` | Never ask. |
| `--move-old-data` | As for [onboard](#kndl-onboard). |

The code is redeemed before anything is installed or built, so a later step that fails doesn't waste it: `kndl onboard` finishes the job with the token `runner.env` already holds. A code that can't be used fails before anything is written. See [Troubleshooting](/troubleshooting/runners/#the-pairing-code-cant-be-used).

### `kndl update`

| Command | What it does |
|---|---|
| `kndl update` | Moves to the latest commit of the branch the install follows, `main` by default. A pinned install stays where it is, and says how to follow `main` again. |
| `kndl update --ref <branch>` | Moves to that branch, and follows it from then on. `--branch` is the same flag. |
| `kndl update --ref <tag or commit>` | Moves to it, and pins the install there. |
| `--no-update-runners` | On the Hub's machine: leaves Runners on other machines on their commit. The Runner on this machine follows anyway, as it shares the install. |
| `--now` | Runners following the Hub stop their running Turns at once, rather than giving them up to ten minutes to end. |

The install's checkout belongs to the CLI: `update` discards changes made in it.

On the Hub's machine, `update` leaves the Hub a note of its new commit before restarting it, and the restarted Hub asks each connected Runner that updates itself to follow ([Keep Runners on the Hub's commit](/how-to/add-a-runner/#keep-runners-on-the-hubs-commit)): the Runner checks the commit is on `origin/main`, the Hub puts its Sessions to sleep, and it moves, builds and restarts. The Runner on the Hub's machine is drained the same way rather than restarted under its Sessions; `update` restarts it at once instead when it can't follow (it's from before Runners followed the Hub, or its service file changed). Its running Sessions keep the copy of the mod each started with, so the mod `update` has already rebuilt in the checkout doesn't reach a Turn still running. On a machine with only a Runner, `update` moves that Runner and restarts it.

### `kndl login`

Signs the CLI in to a Hub, as the person who approves it there; see [Sign in the CLI](/how-to/sign-in-the-cli/). It works on any machine, with or without an install, and for any account on the Hub.

| Argument or flag | What it does |
|---|---|
| `<hub>` | The Hub's URL, its `HUB_PUBLIC_URL`. A URL without a scheme is read as `https://`. Default: the Hub in `cli.json`, the one a `kndl` [installed from a Hub](#the-kndl-command-from-a-hub) came from. |
| `--no-browser` | Doesn't wait for a browser on this machine: prints the sign-in page's address, and asks for the code the page shows. Needs a terminal. Over SSH (`SSH_CONNECTION`, `SSH_CLIENT` or `SSH_TTY` set), it does this anyway. |

Without `--no-browser`, it opens the Hub's `/cli-login` page in the browser (`open` on macOS, `xdg-open` on Linux with a display) and waits on a free port on `127.0.0.1` for the page to send the browser back with a Login code. In a terminal, it also asks for the code, in case the browser can't come back. It waits up to 10 minutes, as long as a Login code lasts.

It trades the code for a CLI token, named after the machine's short hostname, and writes the Hub's URL and the token to [`cli.json`](/reference/files-and-paths/), readable only by you. The CLI is signed in to one Hub at a time: signing in again replaces the token, and the Hub revokes the one before. The token is never printed.

`kndl logout` asks the Hub to revoke the token, and removes it from `cli.json`, keeping the Hub's URL. When the Hub can't be reached, it removes the token anyway and says to revoke the machine under **CLI tokens** on your **Account** page.

### `kndl forward`

Forwards a Session's Open ports to this machine, as the person the CLI is signed in as; see [Forward a Session's ports](/how-to/forward-a-sessions-ports/). It runs in the foreground until stopped. It works on any machine where the CLI is signed in, with or without an install.

| Argument or flag | What it does |
|---|---|
| `<session>` | The Session: its id, the start of it, such as the 6-character short id the web UI shows, or its URL, `https://hub.example.com/sessions/<session id>`. The start of more than one Session's id is refused, listing them. Default: a picker of your Active Sessions in a terminal; without one, it prints that list and exits. |
| `<port>...` | Only these of the Session's ports, each to the same port here, or `<port>:<local port>` to another. Default: every Open port, as they open and close. |
| `--bind <address>` | The IP address to listen on, such as `0.0.0.0` for every interface. Default: `127.0.0.1` and `::1`, which `localhost` resolves to. |

Each connection to a forwarded port is a [tunnel](/reference/protocol/#tunnels) of its own, through the Hub. A port taken here is skipped, naming the process `lsof` says holds it, and tried again every 2 seconds. A port the system refuses, below 1024 without privileges, is skipped. The CLI keeps one connection to the Hub for the Session, [a forward](/reference/protocol/#forwards), which counts as presence: it keeps the Session awake and wakes it if it is Asleep.

In a terminal, it redraws the list as it changes. Esc closes the Session's forward and goes back to the picker, and Ctrl-C stops, exiting 0. Without a terminal it prints a line for each change. It exits 1, saying why, when the Session goes to sleep, is archived or can't be woken, when the CLI token is revoked, or when you lose access to the Session's Repo. When the Hub restarts or can't be reached, it keeps the ports open and reconnects.

## The `kndl` command from a Hub

A Hub serves the same CLI, built from the commit it runs with `bun build --compile` into one binary, for macOS and Linux on arm64 and x64. Install it with the Hub's install script; see [Install the CLI from a Hub](/how-to/install-the-cli-from-a-hub/).

```sh
curl -fsSL https://hub.example.com/cli | sh
```

It has the same commands, but runs none of the ones above that set up and run a Hub or a Runner from an install's checkout: only `login`, `logout`, `whoami` and `forward`. Each says it needs a kndl install and how to get one, or, on a machine with an install, which command runs it, and exits 1. `--help` and `--version` work.

Each run first asks the Hub it was installed from for its commit, waiting up to two seconds. When the Hub runs another commit, it downloads that commit's binary, checks that it runs, renames it over itself and runs the command again. [`KNDL_NO_SELF_UPDATE`](/reference/configuration/#the-kndl-command-from-a-hub) turns that off. The CLI from an install never updates itself: `kndl update` updates it with the install.

The Hub serves it on these routes, with no sign-in:

| Route | What it answers |
|---|---|
| `GET /cli` | The install script, with the Hub's `HUB_PUBLIC_URL` origin in it. |
| `GET /cli/version` | `{"commit":"<commit>"}`: the commit the Hub serves the CLI at, its own. `503` when the Hub doesn't run from a git checkout. |
| `GET /cli/<os>-<arch>` | The binary, for `darwin-arm64`, `darwin-x64`, `linux-x64` or `linux-arm64`, with its commit in the `x-kndl-commit` header. Any other platform is a `404`. The Hub builds a platform's binary the first time it's asked for, one build at a time, and keeps it in `<home>/cli/<commit>/`. |

The install script and the binary read [their own variables](/reference/configuration/#the-kndl-command-from-a-hub).

## Scripts in a checkout

Every script runs from the root of a kndl checkout. They keep their state in the dev home, `~/.kndl-dev`, and the Hub's settings in `packages/hub/.env.local`.

### Running kndl

| Command | What it does |
|---|---|
| `bun run hub` | Starts the Hub on `HOST:PORT` (`127.0.0.1:7777`). Reads `packages/hub/.env.local`. |
| `bun run runner` | Builds the mod, then starts a Runner. Needs `RUNNER_TOKEN`. |
| `bun run web` | Starts Vite's dev server for the web UI on <http://localhost:5173>, passing `/auth`, `/health`, `/runner/` and `/ws` through to the Hub. |
| `bun run web:build` | Builds the web UI into `packages/web/dist`, which the Hub serves. |
| `bun run cli <command>` | Runs the [`kndl` command](#the-kndl-command) from the checkout. It manages the installed home, not the dev home. |

### Setting up

#### `bun run runner-token <name>`

Issues a token for the Runner named `<name>` and prints it, once:

```
Runner build-box (…). Its token, shown only now:

  chr_…

Any earlier token for this Runner no longer works. Give the token to the Runner as RUNNER_TOKEN.
```

The Hub stores only a hash. Issuing again for the same name keeps the Runner's id and its Sessions, and replaces its token; for a removed Runner's name, it brings that Runner back, with its Archived Sessions ([Runner names](/how-to/add-a-runner/#runner-names)). Run it on the Hub's machine: it writes to the Hub's database.

#### `bun run setup-link`

Prints the Hub's Setup link, once, for a Hub with no Owner yet:

```
The Hub has no Owner yet. Its Setup link, shown only now:

  http://127.0.0.1:7777/setup#cho_…

Open it and sign in with GitHub to become the Hub's Owner, then invite everyone else from the People page. It works once, and only until the Hub has an Owner; a new one replaces it.
```

The link is on `HUB_PUBLIC_URL`, and the Hub stores only a hash of its secret. Any earlier link stops working. Once the Hub has an Owner, it makes none and exits 1. Run it on the Hub's machine: it writes to the Hub's database. See [Let people in](/how-to/let-people-in/).

#### `bun run secrets-key`

Prints a new `HUB_SECRETS_KEY`, 32 random bytes in base64, for encrypting Sensitive values. It changes nothing: put the key in `packages/hub/.env.local` yourself, and back it up with the database.

#### `bun run secrets-reset [--yes]`

For when `HUB_SECRETS_KEY` is lost, and the Hub refuses to start without it. Clears every Sensitive value the key encrypted, own and shared, and keeps the variables, which then need a value. It also drops what else the key protects: the replaced values kept for redaction, and the record of Test builds. It needs no key. It lists what it clears, by name, and asks:

```
This clears 3 Sensitive values, keeping each variable, its "available at build" and its Links:
  - kddige/kndl: NPM_TOKEN, ANTHROPIC_API_KEY
  - shared variables: GITHUB_TOKEN
Each then needs a value: the Sessions of a Repo that has, or links, one don't start until it gets one.
It also drops the record of 1 Test build: the lost key protects them.
Plain variables, Environments, Sessions and the builds on Runners stay.
Type yes to clear them:
```

`--yes` doesn't ask, and without a terminal it's needed. It's refused while a Hub runs on the database, `HUB_DATABASE` or `packages/hub/hub.db`:

```
The Sensitive values can't be reset: a Hub is running on /path/to/hub.db. Stop it first.
```

A running Hub holds `hub.db.lock`, beside the database, so the reset knows it runs; the lock goes when the Hub ends, however it ends. Then make a new key with `bun run secrets-key`, set it, start the Hub, and enter the values again. See [If the key is lost](/how-to/use-variables-and-secrets/#if-the-key-is-lost).

### Checks

| Command | What it does |
|---|---|
| `bun test` | Runs every package's tests. `KNDL_SANDBOX_IT=1` adds the ones that boot real Sandboxes. |
| `bun run typecheck` | Runs each package's `typecheck` script: `tsc --noEmit` for the Hub, Runner, CLI, protocol and web UI, a script for the mod, and `astro check` for this site. |
| `bun run lint` | Lints with oxlint; a warning fails it. |
| `bun run format` | Formats with oxfmt. `bun run format:check` only checks. |
| `bun run mod:build` | Builds the mod's hook library into each plugin's `hooks/hub-link-lib.js`, under `packages/mod/plugins/`. |
| `bun run mod:check` | Builds the mod, then runs `claude plugin validate` and `claude plugin test` on each of its plugins. |

### This site

| Command | What it does |
|---|---|
| `bun run docs:dev` | Serves this site with hot reload on <http://localhost:4321/kndl/>. |
| `bun run docs:build` | Builds it into `packages/docs/dist`. |
| `bun run --filter @kndl/docs brand` | Makes the logo's PNG and ICO files from the SVGs in `brand/`, and copies the favicons into the site's and the web UI's `public/` folders. |
