---
title: Hub
description: The Hub won't start, refuses its settings, serves no web UI, or an MCP server Installation fails.
sidebar:
  order: 2
---

Fixes for a Hub that won't start, and for MCP server Installations. When the Hub refuses its settings, it logs one line saying what to change, and exits: read it with `kndl logs hub`.

The Hub's settings are in `~/.kndl/hub.env`. After you change it, restart the Hub with them:

```sh
kndl hub install
```

## Failed to start server. Is port 7777 in use?

**What you see.** The Hub exits at startup with:

```
Failed to start server. Is port 7777 in use?
```

**Why.** Another process listens on the port, often another Hub.

**Fix.** Stop the other process, or set another `PORT` in `hub.env`.

## The Hub's web UI isn't built

**What you see.** The browser shows:

```
The Hub's web UI isn't built.
```

**Why.** Nothing built the web UI where the Hub serves it from.

**Fix.**

```sh
kndl doctor --fix
```

It builds the web UI. Reload the page; the Hub needs no restart.

## Dev login (KNDL_DEV_LOGIN) is refused

**What you see.** The Hub exits at startup with one of:

```
HubConfigError: Dev login (KNDL_DEV_LOGIN) is refused: the Hub is bound to 0.0.0.0, not a loopback address. Unset KNDL_DEV_LOGIN, or set HOST=127.0.0.1.
```

```
HubConfigError: Dev login (KNDL_DEV_LOGIN) is refused: browsers reach the Hub at http://192.168.1.10:7777, not a loopback address. Unset KNDL_DEV_LOGIN, or set HUB_PUBLIC_URL to a localhost URL.
```

**Why.** Dev login signs anyone in as anyone, so the Hub allows it only when both `HOST` and `HUB_PUBLIC_URL` are loopback.

**Fix.** For a Hub other people reach, [set up the GitHub App](/self-hosting/set-up-the-github-app/) and remove `KNDL_DEV_LOGIN` from `hub.env`. To try kndl alone, keep `HOST=127.0.0.1` and a `localhost` URL.

## The Hub refuses HUB_SECRETS_KEY

**What you see.** The Hub exits at startup with one of:

```
HubConfigError: HUB_SECRETS_KEY must be 32 random bytes in base64, as `bun run secrets-key` prints.
```

```
HubConfigError: The Hub stores 3 secret values (…), encrypted, but HUB_SECRETS_KEY is not set. …
```

```
HubConfigError: HUB_SECRETS_KEY is not the key the Hub's 3 secret values were (…) saved with. …
```

**Why.** The Hub encrypts Sensitive values, Claude credentials, Connected providers and Installations' secrets with `HUB_SECRETS_KEY`. Once any are saved, it won't start without the same key.

**Fix.**

- **Not 32 bytes:** make a key and put all of it in `hub.env`:

  ```sh
  kndl secrets key
  ```

- **Not set, or not the key:** set `HUB_SECRETS_KEY` to the key the values were saved with. If it's lost, see [the next entry](#the-secrets-key-is-lost).

## The secrets key is lost

**What you see.** The Hub refuses to start as in [the entry above](#the-hub-refuses-hub_secrets_key), and no copy of the key is left.

**Why.** Nothing can decrypt the values without the key.

**Fix.**

1. Stop the Hub, and clear the encrypted values, keeping the variables they belong to:

   ```sh
   kndl hub stop
   kndl secrets reset
   ```

2. Make a new key, put it in `hub.env` as `HUB_SECRETS_KEY`, and start the Hub:

   ```sh
   kndl secrets key
   kndl hub install
   ```

3. Enter the cleared values again:
   - each Sensitive variable, on its Repo's **Environment** and on **Shared variables**;
   - each Claude credential and Connected provider, by its owner on their **Account** page;
   - each Installation's header secrets, on **MCP**, where they show **needs a value**;
   - each OAuth Installation, with **Connect** on **MCP**.

Until then, the Sessions of the Repos that need them don't start. See [If the key is lost](/guides/use-variables-and-secrets/#if-the-key-is-lost).

## A Hub is running on hub.db

**What you see.** The Hub, or `kndl secrets reset`, exits with one of:

```
HubLockRefused: The Hub can't start: a Hub is running on /home/ada/.kndl/hub.db. Stop it first.
```

```
The Sensitive values can't be reset: a Hub is running on /home/ada/.kndl/hub.db. Stop it first.
```

**Why.** A running Hub holds a lock on its database. The lock goes when the Hub ends, even by a crash.

**Fix.** Stop the other Hub:

```sh
kndl hub stop
```

To run two Hubs on one machine, give each its own `HUB_DATABASE`.

## HubConfigError about the GitHub settings

**What you see.** The Hub exits at startup with one of:

```
HubConfigError: GitHub sign-in needs both GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET; only one is set.
HubConfigError: The GitHub App needs both GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY_PATH; only one is set.
HubConfigError: Could not read the GitHub App's private key at /home/ada/.kndl/github-app.pem (GITHUB_APP_PRIVATE_KEY_PATH).
HubConfigError: The GitHub App's private key is not a PEM key.
HubConfigError: The GitHub App's private key is not an RSA key.
```

**Why.** Each pair turns on one feature, so half of one is a mistake. The private key must be the `.pem` file GitHub downloaded for the App.

**Fix.** Set both of a pair, or neither. Point `GITHUB_APP_PRIVATE_KEY_PATH` at the key as an absolute path the Hub's user can read: `~` isn't expanded. If the file is lost, generate a new private key on the App's settings page. See [Set up the GitHub App](/self-hosting/set-up-the-github-app/).

## A Session can't start because of an Installation

**What you see.** A Session shows **This Session can't start** and stays Asleep, with one of:

```
Claude Code could not start: Docs needs a value for API key. Fix the Installation on the MCP page, or take owner/name off it, then wake the Session.
Claude Code could not start: Docs's MCP server refused its credential (401). Fix the Installation on the MCP page, …
Claude Code could not start: The Hub could not read Docs's header secret values: check HUB_SECRETS_KEY. …
Claude Code could not start: Docs isn't connected to its account. …
```

**Why.** As a Session starts, the Hub checks each MCP server Installation on for its Repo, and won't start the Session with one that can't work.

**Fix.** Press **Fix** beside the Installation, enter the value its server takes, save, and press **Retry**. For the others:

- **Can't read the values:** set `HUB_SECRETS_KEY` to the key they were saved with, or see [The secrets key is lost](#the-secrets-key-is-lost).
- **Not connected:** press **Reconnect** and sign in.
- **To start without it:** press **Take owner/name off Docs**, or, for a global Installation, **Turn it off for owner/name**.

Prompts sent meanwhile wait, and run once the Session starts. See [When an Installation fails a Session](/guides/add-a-remote-mcp-server/#when-an-installation-fails-a-session).

## An MCP server's tools fail in a Session

**What you see.** A running Session's conversation shows, in red, one of:

```
Docs's MCP server could not be reached. Claude Code started all the same: its tools fail until it answers.
Docs's MCP server refused its credential (403). Its tools fail until the Installation is fixed and the Session restarted.
Docs needs a value for API key. Its tools fail until the Installation is fixed and the Session restarted.
```

**Why.** The first: the server didn't answer the Hub in time as the Session started. The others: the server refused the Installation's value, or an edit cleared it, while the Session ran.

**Fix.**

- **Could not be reached:** check the Hub can reach the server's URL. A slow server may need a higher `HUB_MCP_SERVER_CHECK_TIMEOUT_MS`. Its tools work once it answers.
- **Refused, or needs a value:** press **Fix**, enter a value the server takes, save, then **Restart** the Session.

## Couldn't connect an OAuth Installation

**What you see.** **Connect** or **Reconnect** shows **Couldn't connect Docs**, with one of:

```
The Hub connects only to an MCP server on https.
The MCP server names no authorization server the Hub can reach.
That connection expired or came from elsewhere: connect again.
Connecting an Installation needs HUB_SECRETS_KEY in the Hub's configuration, …
```

Or the Installation shows **connection lost**.

**Why.** The Hub connects only over `https`, to an authorization server the MCP server names. A sign-in must finish within 10 minutes, in the browser that began it. **connection lost** means the authorization server refused to refresh the token, as when the grant was revoked.

**Fix.**

- **Not https, or no authorization server:** check the MCP server's URL.
- **Expired:** press **Connect** again and finish in the same browser.
- **Needs HUB_SECRETS_KEY:** make one with `kndl secrets key`, put it in `hub.env`, and run `kndl hub install`.
- **connection lost:** press **Reconnect**.

Only someone with access to every Repo the Installation lists can connect it, and only the Hub's Owner a global one. See [Connect it to an account with OAuth](/guides/add-a-remote-mcp-server/#connect-it-to-an-account-with-oauth).

## An OAuth Installation asks for a client

**What you see.** **Connect** opens **Enter a client for Docs**, or connecting with the client you entered is refused with one of:

```
The authorization server https://github.com/login/oauth takes no public client: enter the client's secret too.
The authorization server https://auth.example.com takes only public clients: leave the client secret empty.
The authorization server refused the connection: invalid_client.
```

**Why.** The authorization server has no Dynamic Client Registration, as GitHub's doesn't, so the Hub needs a client you register there yourself. `invalid_client` means the server doesn't know the client, its secret or its callback URL.

**Fix.** Register a client at the authorization server with the callback URL the dialog shows, `<HUB_PUBLIC_URL>/auth/mcp/callback`, and enter its client ID and secret. For a rotated secret, press **Change client** and enter the new one. See [Connect a server without Dynamic Client Registration](/guides/connect-an-mcp-server-with-oauth/#connect-a-server-without-dynamic-client-registration).

## A global Installation can't be changed

**What you see.** On **MCP**, **Edit** and **Delete** are off for an Installation marked **Global**, or for its MCP server, or saving says:

```
Only the Hub's Owner can create, edit or delete a global Installation: every Sandbox on the Hub can use it.
```

**Why.** A global Installation is on in every Repo, so only the Hub's Owner may change it or its MCP server.

**Fix.** Ask the Owner. Meanwhile, anyone with access to a Repo can press **Turn off for this Repo** on the Repo's page, or add the Repo's own Installation, which takes the global one's place there.
