---
title: Install kndl
description: Install a Hub, a Runner or both as services with the kndl CLI, or run them from a checkout.
sidebar:
  order: 1
---

At the end of this page, a machine runs a Hub, a Runner or both as services that start at login and restart if they crash, with everything in one home, `~/.kndl`.

To work on kndl itself, run it [from a checkout](#from-a-checkout) instead. A checkout keeps its state in `~/.kndl-dev`, so the two can share a machine.

## What each machine needs

| | Hub | Runner |
|---|---|---|
| macOS or Linux, with git | Yes | Yes |
| [Bun](https://bun.sh) 1.4 or newer | Yes: the installer adds it if it's missing | Yes |
| A Mac with Apple Silicon, or Linux with KVM | | Yes: each Session's Sandbox is a [microsandbox](https://github.com/microsandbox/microsandbox) microVM |
| A port browsers and Runners can reach | Yes, `7777` by default | |

The Hub is one Bun process with a SQLite database. Runners run one microVM per Active Session, so give them the CPU, memory and disk.

`kndl onboard` offers to install what's missing (git, curl, and microsandbox's runtime) with Homebrew, apt or dnf. A Runner needs no Claude Code and no Claude sign-in: see [Add a Runner](/self-hosting/add-a-runner/).

## Install

```sh
curl -fsSL https://raw.githubusercontent.com/kddige/kndl/main/install.sh | sh
```

It installs Bun if it's missing, clones kndl into `~/.kndl/app`, writes the `kndl` command to `~/.local/bin` (adding it to `PATH` if needed), then starts `kndl onboard`. To install another branch, tag or commit, or to skip onboard:

```sh
curl -fsSL … | sh -s -- --ref <branch|tag|sha> --no-onboard
```

Run again on an installed machine, it updates the install and runs `kndl doctor --fix`. `KNDL_HOME` installs somewhere other than `~/.kndl`.

## Set the machine up

```sh
kndl onboard
```

Onboard asks:

1. **What the machine runs**: a Hub, a Runner for a Hub elsewhere, or both.
2. Whether to **install what's missing**, showing the commands first. Some use `sudo`.
3. For a Hub, **who reaches it**:
   - `local`: only this machine, on `127.0.0.1`. It offers dev login, so you can sign in before the GitHub App is set up.
   - `lan`: your local network over plain HTTP, on `0.0.0.0`. It offers `HUB_INSECURE_COOKIES=1`, which sign-in needs over plain HTTP; see [Reach the Hub from other machines](/self-hosting/reach-the-hub-from-other-machines/) for what that costs.
   - `https`: anyone, through an HTTPS proxy or tunnel in front of it. It asks for the public URL.
4. For a Hub, **the GitHub App**, for GitHub sign-in and Repos' tokens: create it now, paste the settings of one you made yourself, or not now. See [Set up the GitHub App](/self-hosting/set-up-the-github-app/).
5. For a Runner on its own, **a pairing link** or **the Hub's URL and a Runner token**. See [Add a Runner](/self-hosting/add-a-runner/).

Then it writes `hub.env` and `runner.env` in the home, readable only by you, installs and starts the services, and checks that the Hub answers and the Runner connects.

For a Hub with GitHub sign-in, onboard ends with its Setup link: open it to become the Hub's Owner. See [Let people in](/self-hosting/let-people-in/).

:::danger[Back up `hub.env` with `hub.db`]
The `HUB_SECRETS_KEY` in `hub.env` is the only way to read the Sensitive values in the database.
:::

To change something, run onboard again. It asks only what `hub.env` and `runner.env` don't already answer; `--reset` asks everything again, and `--github-app create` creates a GitHub App. Every flag is in [Commands](/reference/commands/#kndl-onboard).

### Without questions

With `--non-interactive`, or with no terminal, onboard never asks: flags answer the questions, yes-or-no questions take their default, and a missing answer fails naming the flag it needs. For example, a Runner:

```sh
kndl onboard --non-interactive --role runner \
  --hub-url https://hub.example.com --token chr_… --install-prerequisites
```

### On Linux

The services are systemd user units, which systemd stops when you log out. Onboard offers to run `loginctl enable-linger` (`--linger`), which keeps them running and starts them at boot.

The Runner's user also needs `/dev/kvm`, so onboard adds it to the `kvm` group. Reboot afterwards: the services keep the groups they started with.

## Check on it

```sh
kndl status     # what's installed, the services, the Hub's URL, whether the Runner is connected
kndl doctor     # checks everything, and says how to fix what's wrong
kndl logs hub   # or runner; -f follows
```

`kndl doctor --fix` repairs what it can. Every command is in [Commands](/reference/commands/#the-kndl-command), and what goes wrong in [Troubleshooting](/troubleshooting/install/).

## Update

```sh
kndl update
```

It moves to the latest commit of the branch the install follows (`main` unless you chose another), rebuilds, restarts the services and runs doctor.

`--ref` moves the install: a branch is followed from then on, and a tag or commit pins it until you `update --ref main`.

On the Hub's machine, the Hub's Runners follow it to the new commit; `--no-update-runners` leaves Runners on other machines where they are. See [Keep Runners on the Hub's commit](/self-hosting/add-a-runner/#keep-runners-on-the-hubs-commit).

## Uninstall

```sh
kndl uninstall
```

It removes the services, the `kndl` command and the install (`~/.kndl/app`), and keeps the home's data: `hub.env`, `runner.env`, the database, the Runner's Sessions and the logs. Install and onboard again, and the Hub and Runner pick up where they left off.

The `PATH` line install.sh added to your shell's startup file, marked `# kndl: PATH`, stays; delete it by hand.

`--purge` removes the whole home too: the database, its secrets key and every Session's Workspace. It can't be undone. Archive running Sessions first, since their Sandboxes are left running.

## From a checkout

To work on kndl, clone it and run the Hub and Runner with `bun run` instead:

```sh
git clone https://github.com/kddige/kndl.git
cd kndl
bun install
bun test
```

Then prepare the machine by hand:

1. Install git with your package manager, for example `brew install git` or `apt-get install -y git`.
2. On Linux, give the user that runs the Runner access to `/dev/kvm`, for example by adding it to the `kvm` group.

`bun install` brings microsandbox's runtime for your platform. To look at Sandboxes by hand, run its CLI from the Runner's package:

```sh
cd packages/runner
bun x msb list
```

Next:

- [Run the Hub](/self-hosting/run-the-hub/#from-a-checkout).
- [Add a Runner](/self-hosting/add-a-runner/#from-a-checkout).
- [Set up the GitHub App](/self-hosting/set-up-the-github-app/).

`bun run cli <command>` runs the CLI from a checkout. It manages the installed home (`KNDL_HOME`, or `~/.kndl`), never `~/.kndl-dev`.
