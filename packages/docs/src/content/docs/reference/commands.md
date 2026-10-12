---
title: Commands
description: Every kndl command and flag, the kndl command a Hub serves, and the bun run scripts at a checkout's root.
sidebar:
  order: 1
---

## The `kndl` command

[install.sh](/self-hosting/install/) writes it to `~/.local/bin/kndl`, and it runs the CLI from the install, `~/.kndl/app`. It manages the installed home, `KNDL_HOME` or else `~/.kndl`. From a checkout, `bun run cli <command>` runs the same CLI, on the same installed home.

| Command | What it does |
|---|---|
| [`kndl onboard`](#kndl-onboard) | Set up a Hub, a Runner or both on this machine, as services. |
| [`kndl status`](#kndl-status) | Show what's installed and which services run. |
| [`kndl logs`](#kndl-logs) | Print the Hub's or Runner's log. |
| [`kndl doctor`](#kndl-doctor) | Check the install, its configuration and its services. |
| [`kndl update`](#kndl-update) | Update the install, rebuild, and restart its services. |
| [`kndl uninstall`](#kndl-uninstall) | Remove the services, the command and the install. |
| [`kndl hub`](#kndl-hub) | Control the Hub's service, and print its Setup link. |
| [`kndl runner`](#kndl-runner) | Join a Hub as a Runner, control the Runner's service, and issue Runner tokens. |
| [`kndl secrets`](#kndl-secrets) | Make a `HUB_SECRETS_KEY`, or start over without it. |
| [`kndl login`](#kndl-login) | Sign the CLI in to a Hub. |
| [`kndl logout`](#kndl-logout) | Sign the CLI out. |
| [`kndl whoami`](#kndl-whoami) | Show which Hub the CLI is signed in to, and as whom. |
| [`kndl forward`](#kndl-forward) | Forward a Session's Open ports to this machine. |

Every command takes `--help`. `--version` prints the commit the CLI runs from. Without an install in the home, `onboard`, `status`, `logs`, `doctor`, `update` and `hub|runner install` say how to install, and exit 1.

### `kndl onboard`

```sh
kndl onboard [flags]
```

Sets the machine up as a Hub, a Runner or both: prerequisites, `hub.env` and `runner.env`, builds and services. Each question has a flag, and a flag that's given isn't asked. Onboard keeps what `hub.env` and `runner.env` already answer, unless `--reset`.

| Flag | Default | What it does |
|---|---|---|
| `--role hub\|runner\|both` | asks | What the machine runs. |
| `--reach local\|lan\|https` | asks | Who reaches the Hub: this machine (`HOST=127.0.0.1`), the local network over plain HTTP (`HOST=0.0.0.0`), or anyone through an HTTPS proxy or tunnel. |
| `--port <port>` | `7777` | The Hub's `PORT`. |
| `--public-url <url>` | from `--reach` | The Hub's `HUB_PUBLIC_URL`. `local` uses `http://127.0.0.1:<port>`, `lan` suggests this machine's address, and `https` asks for an `https:` URL. |
| `--insecure-cookies` | asks, for `lan` | `lan` only: sets `HUB_INSECURE_COOKIES=1`, so sign-in works over plain HTTP. |
| `--dev-login` | asks | `local` only: sets `KNDL_DEV_LOGIN=1`, to sign in without GitHub. |
| `--github-app create\|manual\|skip` | asks | `create` makes the GitHub App from kndl's manifest, in a browser. `manual` asks for the settings of an App you made. `skip` leaves `hub.env` as it is. `create` and `manual` need a terminal. See [Set up the GitHub App](/self-hosting/set-up-the-github-app/). |
| `--pair '<link>'` | | A Runner's pairing link, from **Add a Runner** or **Re-pair** on the Runners page. Replaces `--hub-url` and `--token`. |
| `--hub-url <url>` | | A Runner's `HUB_URL`, for a Hub on another machine. |
| `--token <chr_…>` | issued, with `--role both` | A Runner's `RUNNER_TOKEN`, from [`kndl runner token`](#kndl-runner). |
| `--runner-name <name>` | the short hostname | The Runner's `RUNNER_NAME`. |
| `--install-prerequisites` | asks | Install what's missing without asking. Some steps use `sudo`. |
| `--no-services` | off | Write the settings and build, but don't install or start the services. |
| `--linger`, `--no-linger` | asks | Linux: run `loginctl enable-linger`, so the services run while you're logged out and start at boot. |
| `--non-interactive` | off | Never ask. A yes-or-no question takes its default, and any other missing answer fails, naming its flag. |
| `--reset` | off | Ask every question again. Keeps `HUB_SECRETS_KEY`. |
| `--move-old-data` | off | Rename kndl data the home holds without its env file to `<name>.old-<YYYYMMDD>`, without asking. Nothing is deleted. |

Every yes-or-no flag has a `--no-` form. Onboard never asks without a terminal. It asks every question before it writes anything, so Esc or Ctrl-C at a question changes nothing, and exits 130. For a Hub with GitHub sign-in and no Owner, it ends with the [Setup link](/self-hosting/let-people-in/).

```sh
kndl onboard --role both --reach local --dev-login --github-app skip
```

### `kndl status`

```sh
kndl status
```

Shows the commit installed, the branch it follows or that it's pinned, each service's state, the Hub's URL and `/health`, and whether the Runner is connected. Exits 1 only when there's no install: `kndl doctor` is the check.

### `kndl logs`

```sh
kndl logs [hub|runner] [-f] [-n <lines>]
```

Prints the end of a service's log, from `<home>/logs/`. The role can be left out when the machine runs only one.

| Flag | Default | What it does |
|---|---|---|
| `-f`, `--follow` | off | Keep printing as it logs. |
| `-n`, `--lines <lines>` | `100` | How many of the last lines to print. |

```sh
kndl logs runner -f
```

### `kndl doctor`

```sh
kndl doctor [--fix] [--yes]
```

Checks the prerequisites, the env files and their permissions, the Hub's and Runner's configuration, the web UI and mod builds, the services, the Hub's health, whether the Runner reaches the Hub, and the GitHub App's [permissions](/self-hosting/set-up-the-github-app/#keep-the-permissions-in-step). Prints `ok`, `!!` (a warning) or `XX` (a failure) for each, and exits 1 on a failure.

| Flag | Default | What it does |
|---|---|---|
| `--fix` | off | Repair what it can, after asking, then check again. It moves data aside only when you confirm in a terminal. |
| `-y`, `--yes` | off | Don't ask before each repair. |

```sh
kndl doctor --fix
```

### `kndl update`

```sh
kndl update [--channel stable|dev] [--ref <ref>] [--no-update-runners] [--now]
```

Updates the install: fetches, moves it, runs `bun install`, rebuilds the web UI and the mod, restarts the services and runs `doctor`. `kndl upgrade` is the same command. The install's checkout belongs to the CLI: `update` discards changes made in it.

| Flag | Default | What it does |
|---|---|---|
| `--channel stable\|dev` | the install's [Channel](/reference/glossary/#channel) | Follow `stable`, the latest Release, or `dev`, the head of `main`, from now on. `stable` never moves back: it waits for a Release that includes the commit checked out. |
| `--ref <ref>`, `--branch <ref>` | | A branch to follow from now on, or a tag or commit to pin the install to. Can't be given with `--channel`. |
| `--no-update-runners` | off | On the Hub's machine: leave Runners on other machines on their commit. The Runner on this machine follows anyway. |
| `--now` | off | Runners updating stop their running Turns at once, rather than giving them up to ten minutes. |

With neither flag, it moves along what the install follows: the latest Release on `stable`, the head of `main` on `dev`, or the head of the branch it follows. A pinned install stays where it is.

On the Hub's machine, the restarted Hub asks each connected Runner to follow it to the new commit. See [Keep Runners on the Hub's commit](/self-hosting/add-a-runner/#keep-runners-on-the-hubs-commit).

```sh
kndl update --channel stable
```

### `kndl uninstall`

```sh
kndl uninstall [--purge] [--yes]
```

Stops and removes the services, the `kndl` command and the install, and keeps the home's data. Asks first. Without a terminal it needs `--yes`.

| Flag | Default | What it does |
|---|---|---|
| `--purge` | off | Remove the whole home too: the Hub's database, its key, and the Runner's Sessions. |
| `-y`, `--yes` | off | Don't ask for confirmation. |

```sh
kndl uninstall --purge
```

### `kndl hub`

```sh
kndl hub install|start|stop|status
kndl hub setup-link
```

| Subcommand | What it does |
|---|---|
| `install` | Write the Hub's service file, and start it. |
| `start` | Start the Hub's service. |
| `stop` | Stop it until the next `start` or login. |
| `status` | Say whether it runs. Exits 1 unless it does. |
| `setup-link` | Print the Hub's [Setup link](/self-hosting/let-people-in/#become-the-owner), replacing any earlier one. Refused once the Hub has an Owner. Run it on the Hub's machine. |

```sh
kndl hub setup-link
```

### `kndl runner`

```sh
kndl runner join '<link>' [flags]
kndl runner install|start|stop|status
kndl runner token <name>
```

| Subcommand | What it does |
|---|---|
| `join '<link>'` | Make this machine a Runner with a pairing link from the Hub's Runners page. See [below](#kndl-runner-join). |
| `install`, `start`, `stop`, `status` | Control the Runner's service, as for [`kndl hub`](#kndl-hub). |
| `token <name>` | Issue a token for the Runner named `<name>`, replacing any token it had. Run it on the Hub's machine. A pairing link doesn't need it. |

#### `kndl runner join`

```sh
kndl runner join 'https://hub.example.com#7K2QD-M9XRT-4VBNC-H8PWE'
```

It's [`kndl onboard`](#kndl-onboard) with `--role runner --pair '<link>'`. It redeems the code for the Runner's token, writes `runner.env`, installs and starts the service, and waits up to 30 seconds for the Hub to see the Runner connect. The code is redeemed before anything is built, so if a later step fails, `kndl onboard` finishes the job.

| Flag | Default | What it does |
|---|---|---|
| `--name <name>` | the short hostname | The new Runner's name: up to 63 letters, digits, dots, dashes and underscores. A Re-pair keeps the Runner's name. See [Runner names](/self-hosting/add-a-runner/#runner-names). |
| `--hub-url <url>` | from the link | The Hub's URL, when what you give is only the code. |
| `--install-prerequisites` | asks | Install what's missing without asking. Some steps use `sudo`. |
| `--no-services` | off | Write `runner.env` and build, but don't install or start the service. |
| `--linger`, `--no-linger` | asks | Linux: keep the service running while you're logged out. |
| `--non-interactive` | off | Never ask. |
| `--move-old-data` | off | As for [`kndl onboard`](#kndl-onboard). |

A code that can't be used fails before anything is written. See [Troubleshooting](/troubleshooting/runners/#the-pairing-code-cant-be-used).

### `kndl secrets`

```sh
kndl secrets key
kndl secrets reset [--yes]
```

| Subcommand | What it does |
|---|---|
| `key` | Print a new `HUB_SECRETS_KEY`: 32 random bytes in base64. Changes nothing. |
| `reset` | After losing `HUB_SECRETS_KEY`, clear what it encrypted in the Hub's database, as [`bun run secrets-reset`](#bun-run-secrets-reset---yes) does. Refused while the Hub runs: run `kndl hub stop` first. Asks first; without a terminal it needs `--yes`. |

### `kndl login`

```sh
kndl login [<hub>] [--no-browser]
```

Signs the CLI in to a Hub as you, approving it in a browser. Works on any machine, with or without an install. See [Sign in the CLI](/guides/sign-in-the-cli/).

| Argument or flag | Default | What it does |
|---|---|---|
| `<hub>` | the Hub in `cli.json` | The Hub's URL. A URL without a scheme is read as `https://`. |
| `--no-browser` | on over SSH | Print the sign-in page's address, and ask for the code it shows, instead of waiting for a browser on this machine. |

Without `--no-browser`, it opens the Hub's sign-in page and waits up to 10 minutes for the browser to come back. It saves a CLI token, named after the machine's short hostname, in [`cli.json`](/reference/files-and-paths/#outside-the-home), readable only by you. Signing in again replaces the token.

```sh
kndl login https://hub.example.com
```

### `kndl logout`

```sh
kndl logout
```

Asks the Hub to revoke the CLI token, and forgets it. When the Hub can't be reached, it forgets the token anyway and says to revoke the machine under **CLI tokens** on your **Account** page.

### `kndl whoami`

```sh
kndl whoami
```

Shows which Hub the CLI is signed in to, as whom, and on which machine. Exits 1 when it isn't signed in, or the Hub refuses or doesn't answer.

### `kndl forward`

```sh
kndl forward [<session>] [<port>...] [--bind <address>]
```

Opens a Session's Open ports on `localhost` here, as they open and close, until you stop it. It wakes an Asleep Session and keeps it awake. See [Forward a Session's ports](/guides/forward-a-sessions-ports/).

| Argument or flag | Default | What it does |
|---|---|---|
| `<session>` | a picker of your Active Sessions | The Session: its id, the start of it (the short id the web UI shows), or its URL. |
| `<port>...` | every Open port | Only these ports, each to the same port here, or `<port>:<local port>` to another. |
| `--bind <address>` | `127.0.0.1` and `::1` | The address to listen on, such as `0.0.0.0` for every interface. |

A port taken here is skipped, naming the process that holds it, and tried again every 2 seconds. Ctrl-C stops it, exiting 0. It exits 1, saying why, when the Session goes to sleep, is archived or can't be woken, when the CLI token is revoked, or when you lose access to the Repo. It reconnects when the Hub restarts.

```sh
kndl forward 3f96a2 3000 5173:8080
```

## The `kndl` command from a Hub

A Hub serves the same CLI as one binary, for macOS and Linux on arm64 and x64. See [Install the CLI from a Hub](/guides/install-the-cli-from-a-hub/).

```sh
curl -fsSL https://hub.example.com/cli | sh
```

It runs only `login`, `logout`, `whoami` and `forward`. The other commands say they need a kndl install, and exit 1.

Each run asks the Hub for its commit, waiting up to two seconds. When the Hub runs another commit, the binary replaces itself with that commit's and runs the command again. [`KNDL_NO_SELF_UPDATE`](/reference/configuration/#the-kndl-command-from-a-hub) turns that off.

The Hub serves it with no sign-in:

| Route | What it answers |
|---|---|
| `GET /cli` | The install script, with the Hub's `HUB_PUBLIC_URL` origin in it. |
| `GET /cli/version` | `{"commit":"<commit>"}`, the Hub's commit. `503` when the Hub doesn't run from a git checkout. |
| `GET /cli/<os>-<arch>` | The binary, for `darwin-arm64`, `darwin-x64`, `linux-x64` or `linux-arm64`, with its commit in the `x-kndl-commit` header. The Hub builds each the first time it's asked for. |

## Scripts in a checkout

Run these from the root of a kndl checkout. They keep state in the dev home, `~/.kndl-dev`, and the Hub's settings in `packages/hub/.env.local`. See [Develop kndl](/contributing/develop-kndl/).

| Command | What it does |
|---|---|
| `bun run hub` | Start the Hub on `HOST:PORT`, `127.0.0.1:7777`. |
| `bun run runner` | Build the mod, then start a Runner. Needs `RUNNER_TOKEN`. |
| `bun run web` | Start the web UI's dev server on <http://localhost:5173>, passing `/auth`, `/health`, `/runner/` and `/ws` to the Hub. |
| `bun run web:build` | Build the web UI into `packages/web/dist`, which the Hub serves. |
| `bun run cli <command>` | Run the [`kndl` command](#the-kndl-command) from the checkout. |
| `bun run runner-token <name>` | Issue a token for the Runner named `<name>`, as [`kndl runner token`](#kndl-runner) does. |
| `bun run setup-link` | Print the Hub's Setup link, as [`kndl hub setup-link`](#kndl-hub) does. |
| `bun run secrets-key` | Print a new `HUB_SECRETS_KEY`. Put it in `packages/hub/.env.local`, and back it up with the database. |
| `bun run secrets-reset [--yes]` | Clear what a lost `HUB_SECRETS_KEY` encrypted. See [below](#bun-run-secrets-reset---yes). |
| `bun test` | Run every package's tests. `KNDL_SANDBOX_IT=1` adds the ones that boot real Sandboxes. |
| `bun run typecheck` | Type-check every package. |
| `bun run lint` | Lint with oxlint. A warning fails it. |
| `bun run format` | Format with oxfmt. `bun run format:check` only checks. |
| `bun run mod:build` | Build the mod's hook library into each plugin under `packages/mod/plugins/`. |
| `bun run mod:check` | Build the mod, then validate and test each of its plugins with `claude plugin`. |
| `bun run docs:dev` | Serve this site with hot reload on <http://localhost:4321/kndl/>. |
| `bun run docs:build` | Build this site into `packages/docs/dist`, and check its links. |

### `bun run secrets-reset [--yes]`

For when `HUB_SECRETS_KEY` is lost, and the Hub refuses to start without it. It needs no key.

It clears everything the key encrypted, and keeps the things that held it:

- every Sensitive value, own and shared, keeping each Variable, which then needs a value;
- people's Claude credentials;
- Installations' header secret values, keeping each Installation;
- OAuth Installations' tokens and clients, so each needs connecting again;
- the record of Test builds, and replaced values kept for redaction.

It lists what it clears, by name and never by value, and asks you to type `yes`. `--yes` doesn't ask, and without a terminal it's needed. It's refused while a Hub runs on the database:

```
The Sensitive values can't be reset: a Hub is running on /path/to/hub.db. Stop it first.
```

Afterwards, make a new key with `bun run secrets-key`, set it, start the Hub, and enter the values again: on each Environment, on **Shared variables**, and on **MCP**. See [If the key is lost](/guides/use-variables-and-secrets/#if-the-key-is-lost).
