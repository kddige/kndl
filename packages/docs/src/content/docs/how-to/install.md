---
title: Install claude-hub
description: Install a Hub, a Runner or both as services with the claude-hub CLI, or run them from a checkout.
sidebar:
  order: 1
---

The `claude-hub` command installs claude-hub on a machine, sets it up as a Hub, a Runner or both, and runs them as services that start at login and restart if they crash. It keeps everything in one home, `~/.claude-hub`.

To work on claude-hub itself, run it from a checkout instead: see [From a checkout](#from-a-checkout). A checkout keeps its state in `~/.claude-hub-dev`, so the two can share a machine.

## What each machine needs

| | Hub | Runner |
|---|---|---|
| macOS or Linux, with git | Yes | Yes |
| [Bun](https://bun.sh) 1.4 or newer | Yes: the installer adds it if it's missing | Yes |
| tmux | | Yes: each Session's Claude Code runs in it |
| Claude Code (`claude`), signed in | | Yes: every Session on the Runner uses its login |
| A Mac with Apple Silicon, or Linux with KVM | | Yes: each Session's Sandbox is a [microsandbox](https://github.com/microsandbox/microsandbox) microVM |
| A port browsers and Runners can reach | Yes, `7777` by default | |

The Hub is light: one Bun process with a SQLite database. Runners do the heavy work, one microVM per Active Session, so give them the CPU, memory and disk.

`claude-hub onboard` installs what's missing that a package manager can (tmux, git, gh, curl with Homebrew, apt or dnf, and microsandbox's runtime), after asking once. Claude Code and its sign-in are yours to do: install [Claude Code](https://docs.anthropic.com/en/docs/claude-code) and run `claude` once to sign in, as the user that runs the Runner.

## Install

The repository is private, so the installer comes through the GitHub CLI, signed in with access:

```sh
gh api repos/kddige/claude-hub/contents/install.sh -H 'Accept: application/vnd.github.raw' | sh
```

It installs Bun if it's missing, clones claude-hub into `~/.claude-hub/app`, runs `bun install`, writes the `claude-hub` command to `~/.local/bin` (and adds that to `PATH` in your shell's startup file if it isn't there), then starts `claude-hub onboard`. To install a branch, tag or commit other than `main`, or to skip onboard:

```sh
gh api … | sh -s -- --ref <branch|tag|sha> --no-onboard
```

Running it again on an installed machine updates the install, as `claude-hub update` does, then runs `claude-hub doctor --fix`. `CLAUDE_HUB_HOME` installs somewhere other than `~/.claude-hub`.

## Set the machine up

```sh
claude-hub onboard
```

Onboard asks:

1. **What the machine runs**: a Hub, a Runner for a Hub elsewhere, or both.
2. Whether to **install what's missing**, showing the commands first. Some use `sudo`.
3. For a Hub, **who reaches it**:
   - `local`: only this machine, on `127.0.0.1`. It offers dev login, so you can sign in before the GitHub App is set up.
   - `lan`: your local network over plain HTTP, on `0.0.0.0`, with a URL from this machine's network address. It offers `HUB_INSECURE_COOKIES=1`, without which browsers drop sign-in cookies over plain HTTP; see [Reach the Hub from other machines](/how-to/reach-the-hub-from-other-machines/) for what that costs.
   - `https`: anyone, through an HTTPS proxy or tunnel in front of it. It asks for the public URL.
4. For a Hub, **the GitHub App**, for GitHub sign-in and Repos' tokens: create it on GitHub now from claude-hub's manifest, in a browser; paste the settings of one you made yourself; or not now. See [Set up the GitHub App](/how-to/set-up-the-github-app/).
5. For a Runner on its own, **the Hub's URL and a Runner token**. Issue the token on the Hub's machine with `claude-hub runner token <name>`. With both on one machine, onboard issues the token itself.

If the home already holds claude-hub data that onboard didn't set up there, such as a checkout's `sessions/` from before checkouts kept theirs in `~/.claude-hub-dev`, onboard stops first and offers to move it aside: see [The home holds old claude-hub data](/troubleshooting/install/#the-home-holds-old-claude-hub-data).

Then it writes `hub.env` and `runner.env` in the home (each readable only by you), makes a `HUB_SECRETS_KEY` if there is none, builds the web UI and the `hub-link` mod, installs and starts the services, and checks that the Hub answers and the Runner connects.

Back up `hub.env` together with `hub.db`: the key in it is the only way to read the Sensitive values in the database.

Run onboard again to change something. It keeps what `hub.env` and `runner.env` already answer and asks only the rest; `--reset` asks everything again. Flags answer questions too: see [Commands](/reference/commands/#claude-hub-onboard).

### Without questions

With `--non-interactive`, or with no terminal, onboard never asks: a flag answers each question, a yes-or-no question takes its default, and a missing answer fails with the flag it needs. For example, a Runner:

```sh
claude-hub onboard --non-interactive --role runner \
  --hub-url https://hub.example.com --token chr_… --install-prerequisites
```

### On Linux

The services are systemd user units. Without lingering, systemd stops them when you log out, and starts them only when you log in. Onboard offers to run `loginctl enable-linger` (`--linger`), which keeps them running and starts them at boot.

On Linux, the Runner's user also needs `/dev/kvm`. Onboard adds it to the `kvm` group. Reboot afterwards: the services keep the groups they started with, and while they linger, logging out and in doesn't restart them.

Onboard on a home it set up before keeps the GitHub App `hub.env` has, or its lack of one. `claude-hub onboard --github-app create` creates one then.

## Check on it

```sh
claude-hub status     # what's installed, the services, the Hub's URL, whether the Runner is connected
claude-hub doctor     # checks everything, and says how to fix what's wrong
claude-hub logs hub   # or runner; -f follows
```

`claude-hub doctor --fix` repairs what it can. Every command is in [Commands](/reference/commands/#the-claude-hub-command), and what goes wrong in [Troubleshooting](/troubleshooting/install/).

## Update

```sh
claude-hub update
```

It fetches, moves to the latest commit of the branch the install follows (`main` unless you chose another), runs `bun install`, rebuilds the web UI and the mod, restarts the services, and runs doctor. The Hub migrates its database when it starts.

`--ref` moves the install: a branch is followed from then on, and a tag or commit pins it, so a plain `update` stays put until you `update --ref main`. `upgrade` is the same command, and `--branch` the same flag.

## Uninstall

```sh
claude-hub uninstall
```

It stops and removes the services, the `claude-hub` command and the install (`~/.claude-hub/app`), and keeps the home's data: `hub.env`, `runner.env`, the database, the Runner's Sessions and the logs. Install again and onboard, and the Hub and Runner pick up where they left off.

The line install.sh added to your shell's startup file (`~/.zshrc`, `~/.bashrc` or `~/.profile`, marked `# claude-hub: PATH`) stays. Delete it by hand if you don't install again.

`--purge` removes the whole home too. That deletes the database, its secrets key and every Session's Workspace, and can't be undone. Sessions still running keep their tmux sessions and Sandboxes, so archive or finish them first.

## From a checkout

To work on claude-hub, clone it and run the Hub and Runner with `bun run` instead:

```sh
gh repo clone kddige/claude-hub
cd claude-hub
bun install
bun test
```

Then prepare the machine by hand:

1. Install [Claude Code](https://docs.anthropic.com/en/docs/claude-code) and run `claude` once to sign in. The Runner shows that account on every Session as its Runner login, and refuses to start if none is signed in, unless you set `RUNNER_LOGIN`.
2. Install tmux and git with your package manager, for example `brew install tmux git` or `apt-get install -y tmux git`.
3. On Linux, give the user that runs the Runner access to `/dev/kvm`, for example by adding it to the `kvm` group.

microsandbox needs no separate install: `bun install` brings its SDK, with the runtime (`msb` and `libkrunfw`) for your platform. A complete runtime in `~/.microsandbox` (or `MSB_HOME`), from [microsandbox's own installer](https://docs.microsandbox.dev/getting-started/quickstart), takes precedence over the bundled one. To look at Sandboxes by hand, run its CLI from the Runner's package:

```sh
cd packages/runner
bun x msb list
```

Next:

- [Run the Hub](/how-to/run-the-hub/), with the web UI built or with Vite.
- [Add a Runner](/how-to/add-a-runner/), on the Hub's machine or another.
- [Set up the GitHub App](/how-to/set-up-the-github-app/), for GitHub sign-in and tokens.

The CLI works from a checkout too, as `bun run cli <command>`. It always manages the installed home (`CLAUDE_HUB_HOME`, or `~/.claude-hub`), never the checkout's `~/.claude-hub-dev`.
