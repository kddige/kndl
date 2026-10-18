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

**What you see.** On Linux, `kndl doctor` reports one of:

```
XX  Prerequisites    ada can't open /dev/kvm.
XX  Prerequisites    ada is in the kvm group, but this login started before they were added: reboot …
```

or Sandboxes fail to start right after onboard added you to the `kvm` group.

**Why.** The Runner needs `/dev/kvm`, which belongs to the `kvm` group. Onboard and `kndl doctor --fix` add you to it with `sudo usermod -aG kvm <user>`. A new group only reaches processes started afterwards, and your services' systemd user manager keeps the groups it started with, even across logins while the services linger.

**Fix.**

- **You're not in the group yet:** run `kndl doctor --fix`, or `sudo usermod -aG kvm $USER` yourself, then reboot.
- **You're in the group already:** reboot. Logging out and in isn't enough.

Then run `kndl doctor`. If it says there's no `/dev/kvm` at all, turn on virtualization (VT-x or AMD-V) in the firmware, or nested virtualization in a VM.

## sudo: a terminal is required to read the password

**What you see.** Onboard or `kndl doctor --fix` asks to run commands with sudo, you answer Yes, and then:

```
sudo: a terminal is required to read the password; either use the -S option to read from standard input or configure an askpass helper
sudo -v exited with 1
```

Turning on lingering can fail the same way, with `Error creating textual authentication agent: Error opening current controlling terminal`.

**Why.** kndl up to v2026.10.3 ran commands away from your terminal, so sudo and polkit had nowhere to ask for your password. Later versions run them in your terminal.

**Fix.** Update with `kndl update`. Until a Release with the fix is out, answer No when kndl offers to run the commands, run the ones it printed yourself, and then run `kndl doctor --fix` again:

```sh
sudo usermod -aG kvm $USER
sudo loginctl enable-linger $USER
```

## Build the web UI or the hub-link mod: bun: command not found

**What you see.** Onboard, `kndl doctor --fix` or `kndl update` fails to build, and `kndl doctor` says the web UI or the hub-link mod isn't built:

```
▲ Build the hub-link mod: failed
/usr/bin/bash: line 1: bun: command not found
```

The Hub's pages answer 503, and the Runner's service keeps restarting.

**Why.** install.sh installed Bun into `~/.bun/bin`, which your shell's `PATH` doesn't include yet, and kndl up to v2026.10.3 needed `bun` on `PATH` for the builds. Later versions use the Bun they run with.

**Fix.** Update with `kndl update`. Until a Release with the fix is out, put Bun on `PATH` and fix it again:

```sh
export PATH="$HOME/.bun/bin:$PATH"
kndl doctor --fix
```

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

## An update is already running

**What you see.**

```
An update is already running (pid 4242, started 2026-10-17T14:03:12.000Z).
```

**Why.** Another `kndl update` holds the home's `update/lock`. It may be one the Hub started.

**Fix.** Wait for it to end, and follow it in the log:

```sh
tail -f ~/.kndl/update/update.log
```

A lock whose process is gone, or from before the machine booted, is taken over by the next update.

## The Updates page can't start an update

**What you see.** On the **Updates** page, **Update** fails with `Couldn't start the update: …`, or the toast **The update didn't start**.

**Why.** The Hub starts `kndl update` with `systemd-run --user` on Linux, or as a launchd job on macOS. That failed, or the update exited before it wrote its status, as when the CLI in `app/` doesn't run.

**Fix.** Read what the update printed, then run it on the Hub's machine:

```sh
cat ~/.kndl/logs/update.log
kndl update
```

## The update failed and went back

**What you see.**

```
The update failed, so the install went back to 824de4a1f0c3, on stable at v2026.10.1: …
```

**Why.** A step failed after the install moved, such as a build, or the Hub didn't answer `/health` within 30 seconds of restarting. The install runs the commit it ran before, rebuilt and restarted.

**Fix.** Read what failed in the error and the log, fix it, and update again:

```sh
cat ~/.kndl/update/update.log
kndl logs hub
kndl update
```

When going back fails too, the message ends with `failed too: …`, and `update/status.json` says `Failed`. Run `kndl doctor` to see where the install is, and `kndl doctor --fix` to rebuild it.

## `kndl uninstall` refuses the home

**What you see.** `kndl uninstall` removes nothing and says one of:

```
The home is your home directory (/home/ada), which is never removed. Set KNDL_HOME to the kndl home, such as /home/ada/.kndl.
The home is /, which is never removed.
/srv/stuff doesn't look like a kndl home: it holds none of app, hub.env, runner.env, hub.db, sessions, claude-code, logs.
```

**Why.** So that a wrong `KNDL_HOME` can't delete the wrong thing, uninstall refuses `/`, your home directory, and a directory that holds nothing of kndl's.

**Fix.** Unset `KNDL_HOME` to uninstall `~/.kndl`, or set it to the home you installed into.
