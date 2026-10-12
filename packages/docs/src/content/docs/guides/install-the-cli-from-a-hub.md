---
title: Install the CLI from a Hub
description: Install the kndl command from a Hub with one line, on a machine that runs no Hub or Runner, and keep it on the Hub's commit.
sidebar:
  order: 10
---

A Hub serves the `kndl` command, built from the commit the Hub runs. At the end of this page you have `kndl` in `~/.local/bin`, and it keeps itself on the Hub's commit.

It doesn't set up or run a Hub or a Runner. To make a machine one, [install kndl](/self-hosting/install/) instead.

## Before you start

- The Hub's URL, as your machine reaches it: its `HUB_PUBLIC_URL`, such as `https://hub.example.com`. See [Reach the Hub from other machines](/self-hosting/reach-the-hub-from-other-machines/).
- macOS or Linux, on arm64 or x64. On Windows, install it in WSL.
- `curl` or `wget`.

You don't need to sign in to install it.

## Install

1. Run the Hub's install script:

   ```sh
   curl -fsSL https://hub.example.com/cli | sh
   ```

   The first install for a platform can take a minute while the Hub builds it.

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

On a machine with a kndl install, the script leaves the install's `~/.local/bin/kndl` alone and stops: set `KNDL_BIN_DIR` to install this one elsewhere.

## Updates

Each time you run it, `kndl` checks the Hub it was installed from. When the Hub runs another commit, `kndl` updates itself and runs your command with the new version:

```
kndl: updating to 1e9cf127d5c2 from https://hub.example.com...
kndl: updated to 1e9cf127d5c2.
```

If the Hub doesn't answer within two seconds, or the update fails, it runs your command as it is. To turn updates off, set `KNDL_NO_SELF_UPDATE=1`. To move to another Hub, run that Hub's install script.

## Commands that need an install

The commands that set up and look after a Hub or a Runner, such as `onboard`, `status`, `update` and `runner join`, need a kndl install. The command from a Hub says so, and exits 1:

```
`kndl status` needs a kndl install, and there is none in /home/ada/.kndl.
…
```

## Remove it

If you [signed it in](/guides/sign-in-the-cli/), sign it out first, so the Hub revokes its CLI token:

```sh
kndl logout
rm ~/.local/bin/kndl ~/.config/kndl/cli.json
```

## Next steps

- [Sign in the CLI](/guides/sign-in-the-cli/): sign it in to the Hub as you.
- [Commands](/reference/commands/#the-kndl-command-from-a-hub): what the command from a Hub does, and the Hub's `/cli` routes.
- [Install](/self-hosting/install/): make a machine a Hub or a Runner.
