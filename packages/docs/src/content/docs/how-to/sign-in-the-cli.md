---
title: Sign in the CLI
description: Sign the claude-hub command in to a Hub as you with claude-hub login, from a laptop or over SSH, and sign it out again.
sidebar:
  order: 11
---

`claude-hub login` signs the `claude-hub` command on a machine in to a Hub as you, so it can act on the Hub in your name. You approve it in a browser, and the CLI gets a CLI token: it lasts until you sign it out, and it is listed under **CLI tokens** on your **Account** page, where you can revoke it. At the end of this page, `claude-hub whoami` names the Hub and your account.

## Before you start

- The `claude-hub` command on the machine: [installed from a Hub](/how-to/install-the-cli-from-a-hub/), or from a [claude-hub install](/how-to/install/).
- The Hub's URL, its `HUB_PUBLIC_URL`, such as `https://hub.example.com`. The page you approve on must be at that address for the Hub to accept the approval. See [Reach the Hub from other machines](/how-to/reach-the-hub-from-other-machines/).
- An account on the Hub: anyone who can sign in to its web UI can sign the CLI in. It needn't be the account that set the Hub up.

## Sign in on a machine with a browser

1. On the machine, run:

   ```sh
   claude-hub login https://hub.example.com
   ```

   For a `claude-hub` installed from a Hub, you can leave the URL out: it signs in to the Hub it was installed from.

2. The CLI opens the Hub's sign-in page in your browser. If you aren't signed in to the Hub there, sign in first; the page comes back after.
3. Check that the page names the machine you ran it on, then press **Approve**. Approve only a sign-in you started yourself: someone who sends you such a link could act as you.
4. The browser goes back to the CLI, and then shows **claude-hub is signed in**. The terminal says:

   ```
   Signed in to https://hub.example.com as ada, on laptop. The CLI token is in /home/ada/.config/claude-hub/cli.json, readable only by you.
   ```

You type nothing after **Approve**. The CLI waits up to 10 minutes for it.

If the browser can't go back to the CLI, as when it runs on another machine, it shows an error page. Go back a page: the sign-in page shows a Login code. Paste it where the CLI asks `Waiting for the browser. Or paste the code the page shows`.

## Sign in over SSH

Over SSH, a browser that opens would be on the other machine, so the CLI doesn't open one. It does the same with `--no-browser`:

```sh
claude-hub login https://hub.example.com --no-browser
```

1. In the terminal, the CLI prints the sign-in page's address. Open it in a browser on any machine where you can sign in to the Hub.
2. Check the machine's name on the page, then press **Approve**. The page shows **Paste this code in the terminal**, and a code such as `ABCD-EFGH-JKMN-PQRS`.
3. In the terminal, paste the code where it asks `Paste the code the page shows`, and press Enter.

The code works once, for 10 minutes, and only for the `claude-hub login` that opened the page. A mistyped code can be pasted again, up to three times in all.

Pasting needs a terminal. Without one, `--no-browser` and SSH stop with:

```
claude-hub login needs a terminal to paste the code into. Run it in one, or without --no-browser on a machine with a browser.
```

## Check who you are

```sh
claude-hub whoami
```

```
Hub:     https://hub.example.com
Account: ada (Ada Lovelace)
Machine: laptop, signed in 2026-10-06
```

The CLI is signed in to one Hub at a time. Running `claude-hub login` for another Hub, or again for the same one, replaces the sign-in and revokes the CLI token it had.

## Sign out

On the machine:

```sh
claude-hub logout
```

The Hub revokes the CLI token, and the CLI removes it from `cli.json`. It keeps the Hub's URL there, which a `claude-hub` installed from a Hub updates itself from.

To sign out a machine you can't reach, or one you no longer have, open your **Account** page, find the machine under **CLI tokens**, and press **Revoke**. The Hub refuses the token from its next request on.

## Next steps

- [Commands](/reference/commands/#claude-hub-login): `login`, `logout` and `whoami`.
- [Protocol](/reference/protocol/#signing-in-the-cli): the routes the CLI and the sign-in page use, and the CLI token.
- [Files and paths](/reference/files-and-paths/): where `cli.json` is.
