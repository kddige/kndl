---
title: Install the CLI from a Hub
description: Install the kndl command from a Hub with one line, on a machine that runs no Hub or Runner, and keep it on the Hub's commit.
sidebar:
  order: 10
---

A Hub serves the `kndl` command, built from the commit the Hub runs, to anyone who can reach it. At the end of this page you have `kndl` in `~/.local/bin`, and it keeps itself on the Hub's commit.

:::note
The command from a Hub doesn't set up or run a Hub or a Runner. To make a machine one, [install kndl](/how-to/install/) instead: that install's `kndl` has every command.
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
   Installed kndl v1e9cf127d5c2 in /home/ada/.local/bin/kndl.
   ```

   `v1e9cf127d5c2` is the Hub's commit.

3. If the script says `~/.local/bin` isn't on your `PATH`, add the line it prints to your shell's startup file, such as `~/.zshrc` or `~/.bashrc`, and open a new terminal:

   ```sh
   export PATH="/home/ada/.local/bin:$PATH"
   ```

4. Check that it runs:

   ```sh
   kndl --version
   ```

### Install it somewhere else

To install it in another directory, set `KNDL_BIN_DIR`:

```sh
curl -fsSL https://hub.example.com/cli | KNDL_BIN_DIR="$HOME/bin" sh
```

On a machine with a kndl install, `~/.local/bin/kndl` is that install's command, and the script leaves it alone:

```
kndl install: /home/ada/.local/bin/kndl is the command of the kndl install on this machine, which has every command this one has and updates with the install. To install this one elsewhere, set KNDL_BIN_DIR.
```

## Updates

Each time you run it, `kndl` asks the Hub it was installed from for its commit, and waits up to two seconds for an answer. When the Hub runs another commit, `kndl` downloads that commit's binary, puts it in its own place, and runs your command again with it:

```
kndl: updating to 1e9cf127d5c2 from https://hub.example.com...
kndl: updated to 1e9cf127d5c2.
```

If the Hub doesn't answer, or the update fails, it runs your command as it is. To turn updates off, set `KNDL_NO_SELF_UPDATE=1`.

The Hub it updates from is in `~/.config/kndl/cli.json`. To move to another Hub, run that Hub's install script.

## Commands that need an install

The commands that set up and look after a Hub or a Runner, such as `onboard`, `status`, `update` and `runner join`, need a kndl install. The command from a Hub says so, and exits 1:

```
`kndl status` needs a kndl install, and there is none in /home/ada/.kndl.
This kndl, installed from a Hub, doesn't set up or run a Hub or a Runner itself. To make this machine one, install kndl with:
…
```

On a machine with an install, it names the install's own command to run instead.

## Remove it

If you [signed it in](/how-to/sign-in-the-cli/), sign it out first, so the Hub revokes its CLI token:

```sh
kndl logout
rm ~/.local/bin/kndl ~/.config/kndl/cli.json
```

## Next steps

- [Sign in the CLI](/how-to/sign-in-the-cli/): sign it in to the Hub as you.
- [Commands](/reference/commands/#the-kndl-command-from-a-hub): what the command from a Hub does, and the Hub's `/cli` routes.
- [Install](/how-to/install/): make a machine a Hub or a Runner.
