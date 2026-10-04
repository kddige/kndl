---
title: Install claude-hub
description: What a Hub and a Runner need on their machines, and how to get claude-hub onto them from a checkout.
sidebar:
  order: 1
---

claude-hub runs from a checkout of its repository today. The same checkout can run the Hub, a Runner or both.

:::caution[Coming: the `claude-hub` CLI]
A `claude-hub` command is planned ([#84](https://github.com/kddige/claude-hub/issues/84)): one install script, an `onboard` wizard that sets up a Hub, a Runner or both as services, and `status`, `logs`, `doctor`, `update` and `uninstall`. Until it lands, follow this page. Installed processes will keep their state in `~/.claude-hub`; a checkout keeps it in `~/.claude-hub-dev`, so the two can share a machine. See [Files and paths](/reference/files-and-paths/).
:::

## What each machine needs

| | Hub | Runner |
|---|---|---|
| [Bun](https://bun.sh) 1.4 or newer | Yes | Yes |
| git | To clone claude-hub | Yes: it clones each Session's Repo |
| tmux | | Yes: each Session's Claude Code runs in it |
| Claude Code (`claude`), signed in | | Yes: every Session on the Runner uses its login |
| A Mac with Apple Silicon, or Linux with KVM | | Yes: each Session's Sandbox is a [microsandbox](https://github.com/microsandbox/microsandbox) microVM |
| A port browsers and Runners can reach | Yes, `7777` by default | |

The Hub is light: one Bun process with a SQLite database. Runners do the heavy work, one microVM per Active Session, so give them the CPU, memory and disk.

## Get the code

The repository is private. With access, and the GitHub CLI signed in:

```sh
gh repo clone kddige/claude-hub
cd claude-hub
bun install
```

To check the checkout works, run the tests from its root:

```sh
bun test
```

## Prepare a Runner's machine

1. Install [Claude Code](https://docs.anthropic.com/en/docs/claude-code) and run `claude` once to sign in. The Runner shows that account on every Session as its Runner login, and refuses to start if none is signed in, unless you set `RUNNER_LOGIN`.
2. Install tmux and git with your package manager, for example `brew install tmux git` or `apt-get install -y tmux git`.
3. On Linux, give the user that runs the Runner access to `/dev/kvm`, for example by adding it to the `kvm` group.

microsandbox needs no separate install: `bun install` brings its SDK, with the runtime (`msb` and `libkrunfw`) for your platform. A complete runtime in `~/.microsandbox` (or `MSB_HOME`), from [microsandbox's own installer](https://docs.microsandbox.dev/getting-started/quickstart), takes precedence over the bundled one. To look at Sandboxes by hand, run its CLI from the Runner's package:

```sh
cd packages/runner
bun x msb list
```

## Next

- [Run the Hub](/how-to/run-the-hub/), with the web UI built or with Vite.
- [Add a Runner](/how-to/add-a-runner/), on the Hub's machine or another.
- [Set up the GitHub App](/how-to/set-up-the-github-app/), for GitHub sign-in and tokens.
