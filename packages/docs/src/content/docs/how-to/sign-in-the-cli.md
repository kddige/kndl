---
title: Sign in the CLI
description: Sign the kndl command in to a Hub as you with kndl login, from a laptop or over SSH, and sign it out again.
sidebar:
  order: 11
---

`kndl login` signs the `kndl` command on a machine in to a Hub as you, so it can act on the Hub in your name. You approve it in a browser. At the end of this page, `kndl whoami` names the Hub and your account.

## Before you start

- The `kndl` command on the machine: [installed from a Hub](/how-to/install-the-cli-from-a-hub/), or from a [kndl install](/how-to/install/).
- The Hub's URL, its `HUB_PUBLIC_URL`, such as `https://hub.example.com`. See [Reach the Hub from other machines](/how-to/reach-the-hub-from-other-machines/).
- An account you can sign in to the Hub's web UI with.

## Sign in on a machine with a browser

1. On the machine, run:

   ```sh
   kndl login https://hub.example.com
   ```

   A `kndl` installed from a Hub can leave the URL out.

2. The CLI opens the Hub's sign-in page in your browser. If you aren't signed in to the Hub there, sign in first; the page comes back after.
3. Check that the page names the machine you ran it on, then press **Approve**. Approve only a sign-in you started yourself: someone who sends you such a link could act as you.
4. The browser goes back to the CLI, and then shows **kndl is signed in**. The terminal says:

   ```
   Signed in to https://hub.example.com as ada, on laptop. The CLI token is in /home/ada/.config/kndl/cli.json, readable only by you.
   ```

The CLI waits up to 10 minutes for **Approve**.

If the browser can't go back to the CLI, it shows an error page. Go back a page, and paste the Login code the sign-in page shows where the CLI asks `Waiting for the browser. Or paste the code the page shows`.

## Sign in over SSH

Over SSH, the CLI doesn't open a browser. To get the same anywhere, add `--no-browser`:

```sh
kndl login https://hub.example.com --no-browser
```

1. In the terminal, the CLI prints the sign-in page's address. Open it in a browser on any machine where you can sign in to the Hub.
2. Check the machine's name on the page, then press **Approve**. The page shows **Paste this code in the terminal**, and a code such as `ABCD-EFGH-JKMN-PQRS`.
3. In the terminal, paste the code where it asks `Paste the code the page shows`, and press Enter.

The code works once, for 10 minutes. You get three tries to paste it.

## Check who you are

```sh
kndl whoami
```

```
Hub:     https://hub.example.com
Account: ada (Ada Lovelace)
Machine: laptop, signed in 2026-10-06
```

The CLI is signed in to one Hub at a time. Running `kndl login` for another Hub, or again for the same one, replaces the sign-in and revokes the CLI token it had.

## Sign out

On the machine:

```sh
kndl logout
```

The Hub revokes the machine's CLI token.

To sign out a machine you can't reach, open your **Account** page, find the machine under **CLI tokens**, and press **Revoke**.

## Next steps

- [Commands](/reference/commands/#kndl-login): `login`, `logout` and `whoami`.
- [Protocol](/reference/protocol/#signing-in-the-cli): the routes the CLI and the sign-in page use, and the CLI token.
- [Files and paths](/reference/files-and-paths/): where `cli.json` is.
