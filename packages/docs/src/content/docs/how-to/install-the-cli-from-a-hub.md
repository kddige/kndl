---
title: Install the CLI from a Hub
description: Install the claude-hub command from a Hub with one line, on a machine that runs no Hub or Runner, and keep it on the Hub's commit.
sidebar:
  order: 10
---

A Hub serves the `claude-hub` command, built from the commit the Hub runs, to anyone who can reach it. At the end of this page you have `claude-hub` in `~/.local/bin`, and it keeps itself on the Hub's commit.

:::note
The command from a Hub doesn't set up or run a Hub or a Runner. To make a machine one, [install claude-hub](/how-to/install/) instead: that install's `claude-hub` has every command.
:::

## Before you start

- The Hub's URL, as your machine reaches it: its `HUB_PUBLIC_URL`, such as `https://hub.example.com`. See [Reach the Hub from other machines](/how-to/reach-the-hub-from-other-machines/).
- macOS or Linux, on arm64 or x64. On Windows, install it in WSL.
- `curl` or `wget`.

Nothing needs setting up on the Hub's machine: a Hub serves the command as long as it runs from a git checkout, as an install does. You don't need to sign in to install it.

## Install

1. Run the Hub's install script:

   ```sh
   curl -fsSL https://hub.example.com/cli | sh
   ```

   The script asks the Hub for the binary for your platform. The first time anyone asks for a platform, the Hub builds it, which can take a minute.

2. Check what it says at the end:

   ```
   Installed claude-hub v1e9cf127d5c2 in /home/ada/.local/bin/claude-hub.
   ```

   `v1e9cf127d5c2` is the Hub's commit.

3. If the script says `~/.local/bin` isn't on your `PATH`, add the line it prints to your shell's startup file, such as `~/.zshrc` or `~/.bashrc`, and open a new terminal:

   ```sh
   export PATH="/home/ada/.local/bin:$PATH"
   ```

4. Check that it runs:

   ```sh
   claude-hub --version
   ```

### Install it somewhere else

To install it in another directory, set `CLAUDE_HUB_BIN_DIR`:

```sh
curl -fsSL https://hub.example.com/cli | CLAUDE_HUB_BIN_DIR="$HOME/bin" sh
```

On a machine with a claude-hub install, `~/.local/bin/claude-hub` is that install's command, and the script leaves it alone:

```
claude-hub install: /home/ada/.local/bin/claude-hub is the command of the claude-hub install on this machine, which has every command this one has and updates with the install. To install this one elsewhere, set CLAUDE_HUB_BIN_DIR.
```

## Updates

Each time you run it, `claude-hub` asks the Hub it was installed from for its commit, and waits up to two seconds for an answer. When the Hub runs another commit, `claude-hub` downloads that commit's binary, puts it in its own place, and runs your command again with it:

```
claude-hub: updating to 1e9cf127d5c2 from https://hub.example.com...
claude-hub: updated to 1e9cf127d5c2.
```

If the Hub doesn't answer, or the update fails, it runs your command as it is. To turn updates off, set `CLAUDE_HUB_NO_SELF_UPDATE=1`.

The Hub it updates from is in `~/.config/claude-hub/cli.json`. To move to another Hub, run that Hub's install script.

## Commands that need an install

The commands that set up and look after a Hub or a Runner, such as `onboard`, `status`, `update` and `runner join`, need a claude-hub install. The command from a Hub says so, and exits 1:

```
`claude-hub status` needs a claude-hub install, and there is none in /home/ada/.claude-hub.
This claude-hub, installed from a Hub, doesn't set up or run a Hub or a Runner itself. To make this machine one, install claude-hub with:
…
```

On a machine with an install, it names the install's own command to run instead.

## Remove it

```sh
rm ~/.local/bin/claude-hub ~/.config/claude-hub/cli.json
```

## Next steps

- [Commands](/reference/commands/#the-claude-hub-command-from-a-hub): what the command from a Hub does, and the Hub's `/cli` routes.
- [Install](/how-to/install/): make a machine a Hub or a Runner.
