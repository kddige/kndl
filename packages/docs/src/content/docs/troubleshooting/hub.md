---
title: The Hub
description: The Hub won't start, refuses its configuration, or serves no web UI.
sidebar:
  order: 2
---

The Hub checks its configuration before it listens. When it refuses, it logs one `ERROR` line saying what to change, and exits.

## The port is taken

**What you see.** The Hub exits at startup with:

```
ERROR (#2): Error: Failed to start server. Is port 7777 in use?
```

**Why.** Another process listens on that port, often a Hub you started earlier in another terminal.

**Fix.** Stop the other process, or start this Hub with another `PORT`. Remember that Runners and, in development, Vite's dev server name the port in `HUB_URL`.

## The web UI isn't built

**What you see.** The browser shows a plain page:

```
The Hub's web UI isn't built.

Run `bun run web:build` in the claude-hub checkout, then reload this page.
In development, run `bun run web` instead and open http://localhost:5173.
```

At startup the Hub warned: `The web UI isn't built: there is no index.html in … (HUB_WEB_DIR).`

**Why.** The Hub serves the web UI's build from `HUB_WEB_DIR`, by default `packages/web/dist`, and nothing has built it. A fresh checkout has none.

**Fix.** Run `bun run web:build`, then reload. You don't need to restart the Hub. In development, run `bun run web` and open <http://localhost:5173> instead, with `HUB_PUBLIC_URL` left at its default. See [Run the Hub](/how-to/run-the-hub/).

## Dev login is refused

**What you see.** The Hub exits at startup with one of:

```
HubConfigError: Dev login (CLAUDE_HUB_DEV_LOGIN) is refused: the Hub is bound to 0.0.0.0, not a loopback address. Unset CLAUDE_HUB_DEV_LOGIN, or set HOST=127.0.0.1.
```

```
HubConfigError: Dev login (CLAUDE_HUB_DEV_LOGIN) is refused: browsers reach the Hub at http://192.168.1.10:7777, not a loopback address. Unset CLAUDE_HUB_DEV_LOGIN, or set HUB_PUBLIC_URL to a localhost URL.
```

**Why.** Dev login signs anyone in as anyone, without GitHub. The Hub only allows it when both the address it listens on (`HOST`) and the URL browsers use (`HUB_PUBLIC_URL`) are loopback, so nobody else can reach it.

**Fix.** For a Hub others reach, [set up the GitHub App](/how-to/set-up-the-github-app/) and unset `CLAUDE_HUB_DEV_LOGIN`. To try claude-hub alone on one machine, keep `HOST` at `127.0.0.1` and use a `localhost` or `127.0.0.1` URL.

## The secrets key is wrong or missing

**What you see.** The Hub exits at startup with one of:

```
HubConfigError: HUB_SECRETS_KEY must be 32 random bytes in base64, as `bun run secrets-key` prints.
```

```
HubConfigError: The Hub stores 3 Sensitive variable values, encrypted, but HUB_SECRETS_KEY is not set. Set it to the key they were saved with. If that key is lost, `bun run secrets-reset` (or `claude-hub secrets reset`) clears those values, keeping their variables, so a new key can be used.
```

```
HubConfigError: HUB_SECRETS_KEY is not the key the Hub's 3 Sensitive variable values were saved with. Set it to that key. If that key is lost, `bun run secrets-reset` (or `claude-hub secrets reset`) clears those values, keeping their variables, so a new key can be used.
```

**Why.** Sensitive values are encrypted with `HUB_SECRETS_KEY`. Once any are saved, the Hub won't start without the same key, because it couldn't decrypt them for Sessions.

**Fix.**

- For the first message, make a key with `bun run secrets-key` and use what it prints, whole.
- For the others, find the key the values were saved with, usually in `packages/hub/.env.local` (an install's `hub.env`), and set it. If it is lost, see [the next section](#the-secrets-key-is-lost).

## The secrets key is lost

**What you see.** The Hub refuses to start as in [the section above](#the-secrets-key-is-wrong-or-missing), and no copy of the key the values were saved with is left: not in `.env.local` or `hub.env`, nor in a backup.

**Why.** The values are lost with the key: nothing can decrypt them. The Hub won't start while it stores values it can't decrypt.

**Fix.** Stop the Hub, then clear the values and keep their variables:

```sh
bun run secrets-reset          # in a checkout
claude-hub secrets reset       # on an installed Hub
```

Make a new key with `bun run secrets-key` (or `claude-hub secrets key`), set `HUB_SECRETS_KEY` to it and start the Hub. Each cleared variable shows **needs a value**: enter the values again on each Repo's Environment and on **Shared variables**. Until then the Repo's Sessions don't start. See [If the key is lost](/how-to/use-variables-and-secrets/#if-the-key-is-lost).

## A Hub is already running on the database

**What you see.** The Hub, or `secrets-reset`, exits with:

```
HubLockRefused: The Hub can't start: a Hub is running on /path/to/hub.db. Stop it first.
```

```
The Sensitive values can't be reset: a Hub is running on /path/to/hub.db. Stop it first.
```

**Why.** A running Hub holds a lock on `hub.db.lock`, beside its database, so a second Hub on the same database, or a reset under a live Hub, is refused. The operating system drops the lock when the Hub ends, even if it crashed, so a stale lock can't be the cause.

**Fix.** Stop the other Hub: `claude-hub hub stop` for an installed one, or the terminal running `bun run hub`. `claude-hub status` shows whether the installed one runs. To run two Hubs side by side, give each its own `HUB_DATABASE`.

## The GitHub settings are incomplete

**What you see.** The Hub exits at startup with one of:

```
HubConfigError: GitHub sign-in needs both GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET; only one is set.
HubConfigError: The GitHub App needs both GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY_PATH; only one is set.
HubConfigError: Could not read the GitHub App's private key at /path/to/key.pem (GITHUB_APP_PRIVATE_KEY_PATH).
HubConfigError: The GitHub App's private key is not a PEM key.
HubConfigError: The GitHub App's private key is not an RSA key.
```

**Why.** Each pair turns on one feature, so half of one is a mistake. The private key must be the `.pem` file GitHub downloaded for the App.

**Fix.** Set both of the pair, or neither. Point `GITHUB_APP_PRIVATE_KEY_PATH` at the App's private key, as an absolute path the Hub's user can read: `~` isn't expanded. If you've lost the file, generate a new private key on the App's settings page. See [Set up the GitHub App](/how-to/set-up-the-github-app/).

## The settings in `.env.local` are ignored

**What you see.** You put settings in a `.env.local`, yet the Hub still warns `GitHub sign-in is off`, or acts as if they aren't there.

**Why.** `bun run hub` runs the Hub in `packages/hub`, and Bun loads `.env.local` from there. A `.env.local` at the root of the checkout isn't read. Values already in your shell's environment also win over the file's.

**Fix.** Move the file to `packages/hub/.env.local`, check your shell doesn't export the same names, and restart the Hub.

## Startup warnings

These don't stop the Hub. Each says what is off and how to turn it on.

| Warning | What it means |
|---|---|
| `GitHub sign-in is off: GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET are not set.` | Only dev login can sign people in. |
| `` The GitHub App is not configured (GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY_PATH): Runners use their host's own git credentials, Sandboxes get no GitHub token so Claude can't push or open pull requests, and people signed in with GitHub can't see any Session. Run `claude-hub onboard --github-app create` to set one up. `` | Runners clone and push with their own credentials, Sandboxes get no GitHub token, and GitHub sign-ins have access to no Repo. See [Set up the GitHub App](/how-to/set-up-the-github-app/) and [Git from Sessions](/explanation/git-from-sessions/). |
| `` HUB_SECRETS_KEY is not set: Environments can't hold Sensitive values. Run `bun run secrets-key` to make one. `` | Plain variables still work. |
| `Dev login is on (CLAUDE_HUB_DEV_LOGIN): anyone reaching http://127.0.0.1:7777 can sign in without GitHub.` | Expected while you try claude-hub alone. |
| `Browsers reach the Hub over plain HTTP at … (HUB_PUBLIC_URL), so they will drop its Secure cookies and sign-in will fail. …` | See [Sign-in doesn't stick](/troubleshooting/sign-in/#sign-in-doesnt-stick). |
| `INSECURE COOKIES (HUB_INSECURE_COOKIES): the Hub's cookies are not Secure, so sign-in tokens travel in cleartext to …` | You set `HUB_INSECURE_COOKIES=1` over plain HTTP. It warns at every start while it's on. |
| `HUB_INSECURE_COOKIES is set but does nothing: browsers reach the Hub over HTTPS (…), so its cookies stay Secure. Unset it.` | It only matters over plain HTTP. |
