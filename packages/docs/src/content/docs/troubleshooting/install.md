---
title: Installing and the CLI
description: install.sh fails, the kndl command isn't found, a service won't stay up, or update and uninstall refuse.
sidebar:
  order: 1
---

Start with `kndl doctor`. It prints `ok`, `!!` (a warning) or `XX` (a failure) for the install, the settings, the services and the Hub's health, with what to do. `kndl doctor --fix` repairs what it can. A service's log is `kndl logs hub` or `kndl logs runner`.

## install.sh can't clone

**What you see.**

```
kndl install: Could not clone https://github.com/kddige/kndl.git.
```

git prints why just above it.

**Why.** git couldn't reach GitHub, or `KNDL_REPO` names a URL or checkout that doesn't exist.

**Fix.** Check that `git clone https://github.com/kddige/kndl.git` works from this machine (a proxy or firewall may be in the way), unset `KNDL_REPO` or correct it, and run the installer again.

## `kndl: command not found`

**What you see.** After installing, the shell can't find `kndl`, or `kndl doctor` warns:

```
!!  kndl command    ~/.local/bin/kndl isn't what `kndl` runs: put its directory first on PATH.
```

**Why.** install.sh adds `~/.local/bin` to `PATH` in your shell's startup file, which only new shells read. Or another `kndl` comes first on `PATH`.

**Fix.** Open a new terminal, or run `export PATH="$HOME/.local/bin:$PATH"`. If another `kndl` comes first, remove it or put `~/.local/bin` before it.

## `kndl is not installed in …`

**What you see.** `status`, `doctor`, `update` or `onboard` says there's no install in the home, and exits 1.

**Why.** The CLI manages one home, `KNDL_HOME` or else `~/.kndl`, and that home has no `app/` checkout. It never manages a checkout's `~/.kndl-dev`.

**Fix.** Install with [install.sh](/how-to/install/#install), or set `KNDL_HOME` to the home you installed into.

## Onboard needs a flag

**What you see.**

```
onboard can't ask, so it needs --role hub|runner|both.
```

**Why.** Without a terminal, or with `--non-interactive`, onboard never asks, and no flag or env file answered this question.

**Fix.** Give the flag it names, or run onboard in a terminal. Every flag is in [Commands](/reference/commands/#kndl-onboard).

## Onboard can't create the GitHub App

**What you see.** One of:

- The page onboard printed, such as `http://127.0.0.1:41234/`, doesn't load.
- After creating the App on GitHub, the page GitHub sends you back to doesn't load, and onboard keeps waiting.
- Onboard says `GitHub didn't hand over the new App's credentials: …`.

**Why.** The page is served on the Hub's machine, on `127.0.0.1` only, so a browser on another machine can't reach it without a tunnel. GitHub's code for the App's credentials works once, for an hour.

**Fix.**

- **Over SSH**, forward the port from your own machine (`ssh -L 41234:127.0.0.1:41234 hub-box`) and reload the page.
- **Stuck after GitHub**, copy the address the browser was sent back to, with `code=` in it, and paste it at onboard's prompt.
- **The code was used or expired**: the App exists on GitHub without its settings saved. Delete it (its settings, **Advanced**, **Delete GitHub App**) and run `kndl onboard --github-app create` again; or generate a client secret and a private key in its settings and run `kndl onboard --github-app manual`.

## A service won't stay up

**What you see.** `kndl status` or `doctor` shows the Hub's or Runner's service as not running, or `XX  Hub service … its log: kndl logs hub`.

**Why.** The Hub or Runner exits, and its service restarts it, again and again. The reason is at the end of its log.

**Fix.** Read `kndl logs hub` (or `runner`) and find the message on [The Hub](/troubleshooting/hub/) or [Runners](/troubleshooting/runners/). Change the setting in `~/.kndl/hub.env` or `runner.env`, then run `kndl hub start` (or `runner start`).

## The services stop when you log out

**What you see.** On Linux, the Hub or Runner is down after you log out or reboot, until you log in. doctor warns `Linger: The services stop when you log out, and don't start at boot until you log in.`

**Why.** The services are systemd user units, and without lingering systemd stops them when your last session ends.

**Fix.** `kndl doctor --fix` runs `loginctl enable-linger` for you.

## The Runner can't use KVM

**What you see.** On Linux, doctor reports `KVM access: <user> can't open /dev/kvm.`, or Sandboxes fail to start right after onboard added you to the `kvm` group.

**Why.** A new group applies only to processes started after it was added, and the systemd user manager running the Runner keeps the groups it started with.

**Fix.** Reboot, then run `kndl doctor`. If there's no `/dev/kvm` at all, turn on virtualization (VT-x or AMD-V) in the firmware, or nested virtualization for a VM.

## An env file is readable by others

**What you see.**

```
XX  hub.env    ~/.kndl/hub.env is readable by others (mode 644); it holds secrets and should be 600.
```

**Why.** `hub.env` holds `HUB_SECRETS_KEY`, and `runner.env` the Runner's token. Something changed the mode onboard wrote.

**Fix.** `kndl doctor --fix`, or `chmod 600 ~/.kndl/hub.env`.

## Update can't find the ref

**What you see.**

```
origin has no branch or tag named v2, and it isn't a commit id.
```

**Why.** `kndl update --ref` looks the name up on the install's origin.

**Fix.** Check the name. A commit must be pushed to origin first.

## Update stays where it is

**What you see.**

```
The install is pinned at 1a2b3c4d5e6f, so update stays there. To follow the latest Release: kndl update --channel stable. To follow main: kndl update --channel dev
```

**Why.** `--ref` with a tag or commit pins the install, so a plain `update` doesn't move it.

**Fix.** `kndl update --channel stable`, `kndl update --channel dev`, or `--ref` with a branch.

## Update on stable stays where it is

**What you see.**

```
On the stable Channel: the latest Release, v2026.10.1, doesn't include this checkout's commit, so update stays here until a Release does.
```

or, before kndl's first Release:

```
On the stable Channel, but origin has no Release yet: update stays here, and moves to the first Release.
```

**Why.** The stable Channel never moves an install back to an older commit, because its Hub may already have changed its database for the newer code. An install that followed `main` and switched to `stable` is usually ahead of the latest Release.

**Fix.** Nothing: the next Release that includes the commit moves it. To keep following `main` instead: `kndl update --channel dev`.

## Uninstall refuses the home

**What you see.** `kndl uninstall` exits without removing anything, with one of:

```
The home is your home directory (/home/ada), which is never removed. Set KNDL_HOME to the kndl home, such as /home/ada/.kndl.
The home is /, which is never removed.
/srv/stuff doesn't look like a kndl home: it holds none of app, hub.env, runner.env, hub.db, sessions, claude-code, logs.
```

**Why.** So that a wrong `KNDL_HOME` can't delete the wrong thing, uninstall refuses `/`, your home directory, and a directory with none of a kndl home's entries. Onboard refuses the same homes.

**Fix.** Check `KNDL_HOME`: unset it for `~/.kndl`, or set it to the home you installed into.
