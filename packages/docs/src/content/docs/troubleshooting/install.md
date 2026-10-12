---
title: Install and the CLI
description: install.sh fails, the kndl command isn't found, a service won't stay up, or update and uninstall refuse.
sidebar:
  order: 1
---

Fixes for installing, updating and uninstalling kndl. Run `kndl doctor` first: most of these show up there.

## `kndl: command not found` right after installing

**What you see.** The installer finished, but the shell can't find `kndl`.

**Why.** install.sh adds `~/.local/bin` to `PATH` in your shell's startup file, and only new shells read it.

**Fix.** Open a new terminal, or run the command by its path:

```sh
~/.local/bin/kndl onboard
```

## Another `kndl` runs instead

**What you see.** `kndl doctor` warns:

```
!!  kndl command    ~/.local/bin/kndl isn't what `kndl` runs: put its directory first on PATH.
```

**Why.** Another `kndl` comes before `~/.local/bin` on `PATH`.

**Fix.** Remove the other one, or put `~/.local/bin` first on `PATH` in your shell's startup file.

## install.sh: Could not clone

**What you see.**

```
kndl install: Could not clone https://github.com/kddige/kndl.git.
```

git prints why just above it.

**Why.** git can't reach GitHub from this machine, or `KNDL_REPO` names a repository that doesn't exist.

**Fix.** Check that `git clone https://github.com/kddige/kndl.git` works here. Unset or correct `KNDL_REPO`, then run the installer again.

## kndl is not installed

**What you see.** `kndl status`, `doctor`, `update` or `onboard` says there's no install in the home, and exits 1.

**Why.** The CLI manages one home, `KNDL_HOME` or else `~/.kndl`, and that home has no install.

**Fix.** [Install kndl](/self-hosting/install/), or set `KNDL_HOME` to the home you installed into.

## Onboard can't ask, so it needs a flag

**What you see.**

```
onboard can't ask, so it needs --role hub|runner|both.
```

**Why.** Onboard has no terminal to ask in, or you passed `--non-interactive`, and no flag answered the question.

**Fix.** Run `kndl onboard` in a terminal, or pass the flag it names. Every flag is in [Commands](/reference/commands/#kndl-onboard).

## Onboard can't create the GitHub App

**What you see.** One of:

- The page onboard printed, such as `http://127.0.0.1:41234/`, doesn't load.
- GitHub sends you back after creating the App, the page doesn't load, and onboard keeps waiting.
- `GitHub didn't hand over the new App's credentials: …`

**Why.** Onboard serves that page on `127.0.0.1` on the Hub's machine only. GitHub's code for the App's credentials works once, for an hour.

**Fix.**

- **Over SSH:** forward the port from your laptop, then reload the page:

  ```sh
  ssh -L 41234:127.0.0.1:41234 hub-box
  ```

- **Stuck after GitHub:** copy the address the browser was sent to, with `code=` in it, and paste it at onboard's prompt.
- **The code was used or expired:** delete the App on GitHub (its settings, **Advanced**, **Delete GitHub App**) and run `kndl onboard --github-app create` again. Or generate a client secret and a private key in the App's settings and run `kndl onboard --github-app manual`.

## A service won't stay up

**What you see.** `kndl status` shows the Hub's or the Runner's service as not running, or `kndl doctor` fails with `… its log: kndl logs hub`.

**Why.** The Hub or Runner exits at startup, and its service keeps restarting it. The reason is at the end of its log.

**Fix.**

1. Read the log:

   ```sh
   kndl logs hub      # or: kndl logs runner
   ```

2. Find the message on [Hub](/troubleshooting/hub/) or [Runners](/troubleshooting/runners/), and change the setting in `~/.kndl/hub.env` or `~/.kndl/runner.env`.
3. Restart it with the new settings:

   ```sh
   kndl hub install   # or: kndl runner install
   ```

## The services stop when you log out

**What you see.** On Linux, the Hub or Runner is down after you log out or reboot, until you log in. `kndl doctor` warns `The services stop when you log out, and don't start at boot until you log in.`

**Why.** The services are systemd user units, and systemd stops them when your last login session ends.

**Fix.**

```sh
kndl doctor --fix
```

It turns on lingering for your user with `loginctl enable-linger`.

## KVM access: can't open /dev/kvm

**What you see.** On Linux, `kndl doctor` reports `KVM access: <user> can't open /dev/kvm.`, or Sandboxes fail to start right after onboard added you to the `kvm` group.

**Why.** A new group applies only to processes started after it was added, and the systemd user manager keeps the groups it started with.

**Fix.** Reboot, then run `kndl doctor`. If doctor says there's no `/dev/kvm` at all, turn on virtualization (VT-x or AMD-V) in the firmware, or nested virtualization in a VM.

## An env file is readable by others

**What you see.**

```
XX  hub.env    ~/.kndl/hub.env is readable by others (mode 644); it holds secrets and should be 600.
```

**Why.** `hub.env` holds `HUB_SECRETS_KEY`, and `runner.env` the Runner's token. Something changed the mode onboard wrote.

**Fix.**

```sh
chmod 600 ~/.kndl/hub.env
```

Or run `kndl doctor --fix`.

## `kndl update` stays where it is

**What you see.** One of:

```
The install is pinned at 1a2b3c4d5e6f, so update stays there. To follow the latest Release: kndl update --channel stable. To follow main: kndl update --channel dev
```

```
On the stable Channel: the latest Release, v2026.10.1, doesn't include this checkout's commit, so update stays here until a Release does.
```

```
On the stable Channel, but origin has no Release yet: update stays here, and moves to the first Release.
```

**Why.** `--ref` with a tag or commit pins the install. On the stable [Channel](/reference/glossary/), update never moves an install back to an older commit, since its Hub may already have changed its database for the newer code.

**Fix.** To follow the latest Release or `main` again:

```sh
kndl update --channel stable
kndl update --channel dev
```

On stable and ahead of the latest Release, nothing is wrong: the next Release that includes your commit moves it.

## Update can't find the ref

**What you see.**

```
origin has no branch or tag named v2, and it isn't a commit id.
```

**Why.** `kndl update --ref` looks the name up on the install's origin.

**Fix.** Check the name. Push a commit to origin before you update to it.

## `kndl uninstall` refuses the home

**What you see.** `kndl uninstall` removes nothing and says one of:

```
The home is your home directory (/home/ada), which is never removed. Set KNDL_HOME to the kndl home, such as /home/ada/.kndl.
The home is /, which is never removed.
/srv/stuff doesn't look like a kndl home: it holds none of app, hub.env, runner.env, hub.db, sessions, claude-code, logs.
```

**Why.** So that a wrong `KNDL_HOME` can't delete the wrong thing, uninstall refuses `/`, your home directory, and a directory that holds nothing of kndl's.

**Fix.** Unset `KNDL_HOME` to uninstall `~/.kndl`, or set it to the home you installed into.
