---
title: Installing and the CLI
description: install.sh fails, the claude-hub command isn't found, a service won't stay up, or update and uninstall refuse.
sidebar:
  order: 1
---

Start with `claude-hub doctor`. It checks the install, the settings, the services and the Hub's health, prints `ok`, `!!` (a warning) or `XX` (a failure) for each with what to do, and `claude-hub doctor --fix` repairs what it can. A service's own log is `claude-hub logs hub` or `claude-hub logs runner`.

## install.sh can't clone

**What you see.**

```
claude-hub install: Could not clone kddige/claude-hub: it's private, so install gh and run  gh auth login  first.
```

**Why.** The repository is private. install.sh clones with the GitHub CLI's sign-in when `gh` is signed in, and otherwise with plain `git`, which has no access.

**Fix.** Install the [GitHub CLI](https://cli.github.com), run `gh auth login` with an account that can read the repository, and run the installer again. The install keeps using `gh`'s sign-in to fetch updates.

## `claude-hub: command not found`

**What you see.** After installing, the shell can't find `claude-hub`, or `claude-hub doctor` warns:

```
!!  claude-hub command    ~/.local/bin/claude-hub isn't what `claude-hub` runs: put its directory first on PATH.
```

**Why.** install.sh writes the command to `~/.local/bin` and adds that to `PATH` in your shell's startup file (`~/.zshrc`, `~/.bashrc` or `~/.profile`), which only shells started afterwards read. Or another `claude-hub` comes first on `PATH`.

**Fix.** Open a new terminal, or run `export PATH="$HOME/.local/bin:$PATH"`. If another `claude-hub` comes first, remove it or put `~/.local/bin` before it.

## `claude-hub is not installed in …`

**What you see.** `status`, `doctor`, `update` or `onboard` says there's no install in the home, and exits 1.

**Why.** The CLI manages one home: `CLAUDE_HUB_HOME`, or else `~/.claude-hub`. That home has no `app/` checkout. It never manages a checkout's dev home, `~/.claude-hub-dev`, even when run from a checkout with `bun run cli`.

**Fix.** Install with [install.sh](/how-to/install/#install), or set `CLAUDE_HUB_HOME` to the home you installed into.

## Onboard needs a flag

**What you see.**

```
onboard can't ask, so it needs --role hub|runner|both.
```

**Why.** Onboard never asks without a terminal, or with `--non-interactive`, and nothing else answered this question: no flag, and nothing in `hub.env` or `runner.env`.

**Fix.** Give the flag it names, or run onboard in a terminal. Every flag is in [Commands](/reference/commands/#claude-hub-onboard).

## The home holds old claude-hub data

**What you see.** Onboard stops before it writes anything:

```
/Users/ada/.claude-hub holds claude-hub data that wasn't set up here by `claude-hub onboard`: sessions, claude-code, with no runner.env. It is likely a checkout's, from before checkouts kept theirs in ~/.claude-hub-dev. …
```

and `claude-hub doctor` warns `!!  Old data`.

**Why.** Before checkouts got the dev home `~/.claude-hub-dev`, a checkout's Runner kept its Session Workspaces in `~/.claude-hub/sessions` and used tmux server `claude-hub`: exactly what an installed Runner uses. A Runner installed over that data would carry the old Runner's mark, so it would take over the old Sessions' tmux sessions and Sandboxes, while its new Hub database knows none of those Sessions. A Hub's `hub.db` without `hub.env` is old data in the same way. Once onboard has written a role's env file, that role's data is the install's own, and none of this applies.

**Fix.** Choose one:

- **Move it aside.** In a terminal, onboard offers it and asks you to confirm; `claude-hub onboard --move-old-data` does it without asking, and `claude-hub doctor --fix` asks before it does. Each entry is renamed within the home, `sessions` to `sessions.old-<YYYYMMDD>` and `claude-code` to `claude-code.old-<YYYYMMDD>`; nothing is deleted. Delete them yourself once you're sure you don't need those Sessions' work.
- **Install somewhere else.** Set `CLAUDE_HUB_HOME` to another directory, and install and onboard there.

Other files in the home, such as a `github-app.pem`, stay where they are.

If onboard also says that tmux server `claude-hub` has sessions, those would be re-adopted however the data is named: archive those Sessions on the Hub that started them, or stop the server with `tmux -L claude-hub kill-server`, then onboard again.

## A service won't stay up

**What you see.** `claude-hub status` or `doctor` shows the Hub's or Runner's service as not running, or `XX  Hub service … its log: claude-hub logs hub`.

**Why.** The Hub or Runner exits, and its service starts it again a few seconds later, and again. The reason is at the end of its log, as it would be in a terminal: a setting it refuses, a port in use, no Claude sign-in, a mod that isn't built.

**Fix.** Read the log with `claude-hub logs hub` (or `runner`), then find the message on [The Hub](/troubleshooting/hub/) or [Runners](/troubleshooting/runners/). Change the setting in `~/.claude-hub/hub.env` or `runner.env`, then `claude-hub hub start` (or `runner start`). `claude-hub doctor` also checks each env file with the Hub's and Runner's own configuration checks, without starting them.

## The services stop when you log out

**What you see.** On Linux, the Hub or Runner is down after you log out or after a reboot, until you log in. doctor warns `Linger: The services stop when you log out, and don't start at boot until you log in.`

**Why.** The services are systemd user units, which run in your user's systemd manager. Without lingering, systemd stops that manager when your last session ends.

**Fix.** `claude-hub doctor --fix` runs `loginctl enable-linger` for you, as onboard's `--linger` does.

## The Runner can't use KVM

**What you see.** On Linux, doctor reports `KVM access: <user> can't open /dev/kvm.`, or Sandboxes fail to start right after onboard added you to the `kvm` group.

**Why.** A new group applies only to processes started after it was added. The Runner's service runs in your systemd user manager, which keeps the groups it started with; while the services linger, it keeps running across logins.

**Fix.** Reboot, then run `claude-hub doctor`. If there's no `/dev/kvm` at all, turn on virtualization (VT-x or AMD-V) in the firmware, or nested virtualization for a VM.

## An env file is readable by others

**What you see.**

```
XX  hub.env    ~/.claude-hub/hub.env is readable by others (mode 644); it holds secrets and should be 600.
```

**Why.** `hub.env` holds `HUB_SECRETS_KEY`, and `runner.env` the Runner's token. Onboard writes them as `600`, but an editor or a copy may have changed that.

**Fix.** `claude-hub doctor --fix`, or `chmod 600 ~/.claude-hub/hub.env`.

## Update can't find the ref

**What you see.**

```
origin has no branch or tag named v2, and it isn't a commit id.
```

**Why.** `claude-hub update --ref` looks the name up on the install's origin: a branch is followed, a tag or commit pinned.

**Fix.** Check the name. A commit needs to be on origin already: push it first.

## Update stays where it is

**What you see.**

```
The install is pinned at 1a2b3c4d5e6f, so update stays there. To follow main again: claude-hub update --ref main
```

**Why.** An install moved to a tag or commit with `--ref` is pinned, so a plain `update` doesn't move it.

**Fix.** `claude-hub update --ref main`, or another branch, to follow it again.

## Uninstall refuses the home

**What you see.** `claude-hub uninstall` exits without removing anything, with one of:

```
The home is your home directory (/home/ada), which is never removed. Set CLAUDE_HUB_HOME to the claude-hub home, such as /home/ada/.claude-hub.
The home is /, which is never removed.
/srv/stuff doesn't look like a claude-hub home: it holds none of app, hub.env, runner.env, hub.db, sessions, claude-code, logs.
```

**Why.** Uninstall, and `--purge` most of all, deletes the home's contents. It refuses a home that is `/`, your home directory, or a directory with none of a claude-hub home's entries, so a wrong `CLAUDE_HUB_HOME` can't delete the wrong thing. Onboard refuses the same homes, since it writes there.

**Fix.** Check `CLAUDE_HUB_HOME`: unset it for `~/.claude-hub`, or set it to the home you installed into.
