---
title: Install kndl
description: Install a Hub, a Runner or both as services with the kndl CLI, or run them from a checkout.
sidebar:
  order: 1
---

The `kndl` command installs kndl on a machine, sets it up as a Hub, a Runner or both, and runs them as services that start at login and restart if they crash. It keeps everything in one home, `~/.kndl`.

To work on kndl itself, run it from a checkout instead: see [From a checkout](#from-a-checkout). A checkout keeps its state in `~/.kndl-dev`, so the two can share a machine.

## What each machine needs

| | Hub | Runner |
|---|---|---|
| macOS or Linux, with git | Yes | Yes |
| [Bun](https://bun.sh) 1.4 or newer | Yes: the installer adds it if it's missing | Yes |
| A Mac with Apple Silicon, or Linux with KVM | | Yes: each Session's Sandbox is a [microsandbox](https://github.com/microsandbox/microsandbox) microVM |
| A port browsers and Runners can reach | Yes, `7777` by default | |

The Hub is light: one Bun process with a SQLite database. Runners do the heavy work, one microVM per Active Session, so give them the CPU, memory and disk.

`kndl onboard` installs what's missing that a package manager can (git, gh, curl with Homebrew, apt or dnf, and microsandbox's runtime), after asking once. A Runner needs no Claude Code and no Claude sign-in: its Sessions run Claude Code in their Sandboxes, on their Creator's [Claude credential](/how-to/add-your-claude-credential/). To let it run Sessions for people without one, give it [a credential of its own](/reference/configuration/#the-runners-claude-credential).

## Install

The repository is private, so the installer comes through the GitHub CLI, signed in with access:

```sh
gh api repos/kddige/kndl/contents/install.sh -H 'Accept: application/vnd.github.raw' | sh
```

It installs Bun if it's missing, clones kndl into `~/.kndl/app`, runs `bun install`, writes the `kndl` command to `~/.local/bin` (and adds that to `PATH` in your shell's startup file if it isn't there), then starts `kndl onboard`. To install a branch, tag or commit other than `main`, or to skip onboard:

```sh
gh api … | sh -s -- --ref <branch|tag|sha> --no-onboard
```

Running it again on an installed machine updates the install, as `kndl update` does, then runs `kndl doctor --fix`. `KNDL_HOME` installs somewhere other than `~/.kndl`.

## Set the machine up

```sh
kndl onboard
```

Onboard asks:

1. **What the machine runs**: a Hub, a Runner for a Hub elsewhere, or both.
2. Whether to **install what's missing**, showing the commands first. Some use `sudo`.
3. For a Hub, **who reaches it**:
   - `local`: only this machine, on `127.0.0.1`. It offers dev login, so you can sign in before the GitHub App is set up.
   - `lan`: your local network over plain HTTP, on `0.0.0.0`, with a URL from this machine's network address. It offers `HUB_INSECURE_COOKIES=1`, without which browsers drop sign-in cookies over plain HTTP; see [Reach the Hub from other machines](/how-to/reach-the-hub-from-other-machines/) for what that costs.
   - `https`: anyone, through an HTTPS proxy or tunnel in front of it. It asks for the public URL.
4. For a Hub, **the GitHub App**, for GitHub sign-in and Repos' tokens: create it on GitHub now from kndl's manifest, in a browser; paste the settings of one you made yourself; or not now. See [Set up the GitHub App](/how-to/set-up-the-github-app/).
5. For a Runner on its own, **a pairing link**, from **Add a Runner** on the Hub's Runners page, or **the Hub's URL and a Runner token**, issued on the Hub's machine with `kndl runner token <name>`. With both on one machine, onboard issues the token itself. `kndl runner join '<link>'` skips the questions; see [Add a Runner](/how-to/add-a-runner/).

If the home already holds kndl data that onboard didn't set up there, such as a checkout's `sessions/` from before checkouts kept theirs in `~/.kndl-dev`, onboard stops first and offers to move it aside: see [The home holds old kndl data](/troubleshooting/install/#the-home-holds-old-kndl-data).

Then it writes `hub.env` and `runner.env` in the home (each readable only by you), makes a `HUB_SECRETS_KEY` if there is none, builds the web UI and the `hub-link` mod, installs and starts the services, and checks that the Hub answers and the Runner connects.

Back up `hub.env` together with `hub.db`: the key in it is the only way to read the Sensitive values in the database.

Run onboard again to change something. It keeps what `hub.env` and `runner.env` already answer and asks only the rest; `--reset` asks everything again. Flags answer questions too: see [Commands](/reference/commands/#kndl-onboard).

### Without questions

With `--non-interactive`, or with no terminal, onboard never asks: a flag answers each question, a yes-or-no question takes its default, and a missing answer fails with the flag it needs. For example, a Runner:

```sh
kndl onboard --non-interactive --role runner \
  --hub-url https://hub.example.com --token chr_… --install-prerequisites
```

### On Linux

The services are systemd user units. Without lingering, systemd stops them when you log out, and starts them only when you log in. Onboard offers to run `loginctl enable-linger` (`--linger`), which keeps them running and starts them at boot.

On Linux, the Runner's user also needs `/dev/kvm`. Onboard adds it to the `kvm` group. Reboot afterwards: the services keep the groups they started with, and while they linger, logging out and in doesn't restart them.

Onboard on a home it set up before keeps the GitHub App `hub.env` has, or its lack of one. `kndl onboard --github-app create` creates one then.

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

It fetches, moves to the latest commit of the branch the install follows (`main` unless you chose another), runs `bun install`, rebuilds the web UI and the mod, restarts the services, and runs doctor. The Hub migrates its database when it starts.

`--ref` moves the install: a branch is followed from then on, and a tag or commit pins it, so a plain `update` stays put until you `update --ref main`. `upgrade` is the same command, and `--branch` the same flag.

On the Hub's machine, the Hub's Runners follow it to the new commit: each stops taking Sessions, lets running Turns end (up to ten minutes; `--now` stops them at once), puts its Sessions to sleep, updates and restarts. `--no-update-runners` leaves Runners on other machines where they are, to update one at a time from the Runners page. See [Keep Runners on the Hub's commit](/how-to/add-a-runner/#keep-runners-on-the-hubs-commit).

### From claude-hub

kndl was called claude-hub ([ADR 0017](/reference/decisions/0017-the-name-is-kndl/)). An install made under that name moves to kndl's names with its next update, which you run with the old command:

```sh
claude-hub update
```

The update restarts the services on kndl's code. Instead of starting, they move the install, once the update has finished:

1. The services of the old name stop, and the Runner's Sessions go to sleep: their Sandboxes stop, and their Workspaces stay on disk.
2. The home moves from `~/.claude-hub` to `~/.kndl`. A home `CLAUDE_HUB_HOME` put somewhere of its own stays where it is; set `KNDL_HOME` in your shell instead.
3. The `CLAUDE_HUB_*` variables in `hub.env` and `runner.env` become `KNDL_*`, and paths in the old home point to the new one. Nothing else in them changes.
4. The services start under kndl's names, `io.github.kddige.kndl.<role>` on macOS and `kndl-<role>.service` on Linux, and the `claude-hub` command becomes `kndl`.

The update's own checks at the end run before the move, so they may say the Runner isn't connected. Run `kndl doctor` a minute later. Sessions wake under kndl's names when someone opens them. Claude Code in them starts afresh, with the conversation from the Hub's history, since their Sandboxes and volumes of the old name stay behind, stopped. Remove those once you don't need them: see [Troubleshooting](/troubleshooting/install/#sandboxes-of-the-old-name-are-left).

Runners on other machines move the same way, when they follow the Hub to the new commit. An install without services moves when you run `claude-hub update` a second time, which runs kndl's update. Everyone signs in to the web UI again once, and a `kndl` command installed from a Hub renames itself from `claude-hub` when it next updates itself. GitHub Apps keep their names; onboard names new ones `kndl-<machine>`.

If both `~/.claude-hub` and `~/.kndl` hold something, the move leaves both alone and says so. Move one of them away, or set `KNDL_HOME` to the one to keep, and run `claude-hub update` again.

## Uninstall

```sh
kndl uninstall
```

It stops and removes the services, the `kndl` command and the install (`~/.kndl/app`), and keeps the home's data: `hub.env`, `runner.env`, the database, the Runner's Sessions and the logs. Install again and onboard, and the Hub and Runner pick up where they left off.

The line install.sh added to your shell's startup file (`~/.zshrc`, `~/.bashrc` or `~/.profile`, marked `# kndl: PATH`) stays. Delete it by hand if you don't install again.

`--purge` removes the whole home too. That deletes the database, its secrets key and every Session's Workspace, and can't be undone. Sessions still running keep their Sandboxes, so archive or finish them first.

## From a checkout

To work on kndl, clone it and run the Hub and Runner with `bun run` instead:

```sh
gh repo clone kddige/kndl
cd kndl
bun install
bun test
```

Then prepare the machine by hand:

1. Install git with your package manager, for example `brew install git` or `apt-get install -y git`.
2. On Linux, give the user that runs the Runner access to `/dev/kvm`, for example by adding it to the `kvm` group.

microsandbox needs no separate install: `bun install` brings its SDK, with the runtime (`msb` and `libkrunfw`) for your platform. A complete runtime in `~/.microsandbox` (or `MSB_HOME`), from [microsandbox's own installer](https://docs.microsandbox.dev/getting-started/quickstart), takes precedence over the bundled one. To look at Sandboxes by hand, run its CLI from the Runner's package:

```sh
cd packages/runner
bun x msb list
```

Next:

- [Run the Hub](/how-to/run-the-hub/), with the web UI built or with Vite.
- [Add a Runner](/how-to/add-a-runner/), on the Hub's machine or another.
- [Set up the GitHub App](/how-to/set-up-the-github-app/), for GitHub sign-in and tokens.

The CLI works from a checkout too, as `bun run cli <command>`. It always manages the installed home (`KNDL_HOME`, or `~/.kndl`), never the checkout's `~/.kndl-dev`.
