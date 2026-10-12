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

**Why.** Another process listens on that port, often a Hub started earlier in another terminal.

**Fix.** Stop the other process, or start this Hub with another `PORT` and change `HUB_URL` to match where it's set.

## The web UI isn't built

**What you see.** The browser shows a plain page:

```
The Hub's web UI isn't built.

Run `bun run web:build` in the kndl checkout, then reload this page.
In development, run `bun run web` instead and open http://localhost:5173.
```

At startup the Hub warned: `The web UI isn't built: there is no index.html in … (HUB_WEB_DIR).`

**Why.** Nothing has built the web UI into `HUB_WEB_DIR`, by default `packages/web/dist`.

**Fix.** Run `bun run web:build`, then reload; the Hub needs no restart. In development, run `bun run web` and open <http://localhost:5173> instead. See [Run the Hub](/self-hosting/run-the-hub/).

## Dev login is refused

**What you see.** The Hub exits at startup with one of:

```
HubConfigError: Dev login (KNDL_DEV_LOGIN) is refused: the Hub is bound to 0.0.0.0, not a loopback address. Unset KNDL_DEV_LOGIN, or set HOST=127.0.0.1.
```

```
HubConfigError: Dev login (KNDL_DEV_LOGIN) is refused: browsers reach the Hub at http://192.168.1.10:7777, not a loopback address. Unset KNDL_DEV_LOGIN, or set HUB_PUBLIC_URL to a localhost URL.
```

**Why.** Dev login signs anyone in as anyone, so the Hub allows it only when both `HOST` and `HUB_PUBLIC_URL` are loopback.

**Fix.** For a Hub others reach, [set up the GitHub App](/self-hosting/set-up-the-github-app/) and unset `KNDL_DEV_LOGIN`. To try kndl alone, keep `HOST` at `127.0.0.1` and use a `localhost` or `127.0.0.1` URL.

## The secrets key is wrong or missing

**What you see.** The Hub exits at startup with one of:

```
HubConfigError: HUB_SECRETS_KEY must be 32 random bytes in base64, as `bun run secrets-key` prints.
```

```
HubConfigError: The Hub stores 3 secret values (Sensitive variable values, Claude credentials, Installation values and OAuth tokens), encrypted, but HUB_SECRETS_KEY is not set. Set it to the key they were saved with. If that key is lost, `bun run secrets-reset` (or `kndl secrets reset`) clears those values, keeping their variables and Installations, so a new key can be used.
```

```
HubConfigError: HUB_SECRETS_KEY is not the key the Hub's 3 secret values were (Sensitive variable values, Claude credentials, Installation values and OAuth tokens) saved with. Set it to that key. If that key is lost, `bun run secrets-reset` (or `kndl secrets reset`) clears those values, keeping their variables and Installations, so a new key can be used.
```

**Why.** Sensitive values, Claude credentials and Installations' header secret values are encrypted with `HUB_SECRETS_KEY`. Once any are saved, the Hub won't start without the same key.

**Fix.**

- For the first, make a key with `bun run secrets-key` and use all of what it prints.
- For the others, set the key the values were saved with, usually in `packages/hub/.env.local` (an install's `hub.env`). If it is lost, see [the next section](#the-secrets-key-is-lost).

## The secrets key is lost

**What you see.** The Hub refuses to start as in [the section above](#the-secrets-key-is-wrong-or-missing), and no copy of the key is left.

**Why.** Nothing can decrypt the values without the key, and the Hub won't start while it stores values it can't decrypt.

**Fix.** Stop the Hub, then clear the values and keep their variables:

```sh
bun run secrets-reset          # in a checkout
kndl secrets reset             # on an installed Hub
```

Make a new key with `bun run secrets-key` (or `kndl secrets key`), set `HUB_SECRETS_KEY` to it and start the Hub. Enter each cleared variable's value again, on each Repo's Environment and on **Shared variables**; until then the Repo's Sessions don't start. Everyone who stored a Claude credential pastes it again on their **Account** page. Each Installation keeps its header secrets, which show **needs a value** on **MCP**: enter them again there; until then its Repos' Sessions don't start (see [A Session can't start for an Installation](#a-session-cant-start-for-an-installation)). Each OAuth Installation is disconnected: press **Connect** on it there. See [If the key is lost](/guides/use-variables-and-secrets/#if-the-key-is-lost).

## A Session can't start for an Installation

**What you see.** A Session that was woken or started shows **This Session can't start** and stays Asleep, with one of:

```
Claude Code could not start: Docs needs a value for API key. Fix the Installation on the MCP page, or take owner/name off it, then wake the Session.
```

```
Claude Code could not start: Docs's MCP server refused its credential (401). Fix the Installation on the MCP page, or take owner/name off it, then wake the Session.
```

```
Claude Code could not start: The Hub could not read Docs's header secret values: check HUB_SECRETS_KEY. Fix the Installation on the MCP page, or take owner/name off it, then wake the Session.
```

```
Claude Code could not start: Docs isn't connected to its account. Fix the Installation on the MCP page, or take owner/name off it, then wake the Session.
```

For a [global Installation](/guides/add-a-remote-mcp-server/#turn-it-on-for-every-repo), the way out reads `or turn it off for owner/name, then wake the Session.`

**Why.** The Hub checks each Installation on for the Session's Repo as the Session starts, and doesn't start it with one that surely can't work: one without a value for a header secret, one whose MCP server refuses its value with `401` or `403`, or one whose values the Hub can't decrypt, or an OAuth Installation that isn't connected to its account. See [When an Installation fails a Session](/guides/add-a-remote-mcp-server/#when-an-installation-fails-a-session).

**Fix.** Press **Fix** beside the Installation, enter the value its server takes, and save; then press **Retry**. Or, with access to every Repo the Installation lists, press **Take owner/name off Docs**, which wakes the Session at once. A global Installation only the Hub's Owner can fix; anyone in the Session can press **Turn it off for owner/name**, which turns it off for the Repo alone and wakes the Session, and turn it back on later on the Repo's page. For the third, set `HUB_SECRETS_KEY` to the key the values were saved with, or see [The secrets key is lost](#the-secrets-key-is-lost). For the fourth, press **Reconnect** and sign in at its authorization server (see [An OAuth Installation won't connect](#an-oauth-installation-wont-connect)); only the Owner can reconnect a global one. Prompts sent meanwhile wait in the Session's queue, and run once it starts.

## An MCP server fails in a Session

**What you see.** A running Session's conversation shows, in red, one of:

```
Docs's MCP server could not be reached. Claude Code started all the same: its tools fail until it answers.
```

```
Docs's MCP server refused its credential (403). Its tools fail until the Installation is fixed and the Session restarted.
```

```
Docs needs a value for API key. Its tools fail until the Installation is fixed and the Session restarted.
```

**Why.** The first is from the Session's start: the server didn't answer within `HUB_MCP_SERVER_CHECK_TIMEOUT_MS`, couldn't be reached from the Hub, or answered with an error such as `503`. A server that may only be down doesn't keep a Session from starting. The others are from the Gateway, while the Session ran: the server refused the Installation's value, or an edit to its MCP server cleared the value. The Session runs on, with its other servers, and says so once until the Installation works again.

**Fix.** For the first, check that the Hub can reach the MCP server's URL; a slow server may need a higher `HUB_MCP_SERVER_CHECK_TIMEOUT_MS`. Its tools work as soon as it answers. For the others, press **Fix**, enter a value the server takes, and save; then **Restart** the Session, which starts it with the new value.

## An OAuth Installation won't connect

**What you see.** Pressing **Connect** or **Reconnect** on **MCP**, or **Reconnect** in a Session, shows **Couldn't connect Docs**, with one of:

```
The Hub connects only to an MCP server on https.
```

```
The MCP server names no authorization server the Hub can reach.
```

```
That connection expired or came from elsewhere: connect again.
```

```
Connecting an Installation needs HUB_SECRETS_KEY in the Hub's configuration, to keep its tokens encrypted: run `bun run secrets-key`, put the key in packages/hub/.env.local, and restart the Hub.
```

Or an MCP server's Installation shows **connection lost**, and its Sessions say `Docs isn't connected to its account.`

**Why.** The Hub connects only as the MCP authorization spec describes: it finds the authorization server from the MCP server's Protected Resource Metadata, registers itself there with Dynamic Client Registration or uses a client entered by hand, and signs you in with PKCE, all over `https`. A server not on `https` can't be connected. A sign-in must come back within 10 minutes, to the browser that began it, signed in to kndl as the person who pressed **Connect**, and is used once. **connection lost** means the authorization server refused to refresh the token, as when the grant was revoked there or the account was removed.

**Fix.** For the first two, check the MCP server's URL. For an expired or stray sign-in, press **Connect** again, and finish it in the same browser. Set `HUB_SECRETS_KEY` as the last one says. For **connection lost**, press **Reconnect**. Only someone with access to every Repo the Installation lists can connect it, and only the Owner a global one. See [Connect it to an account with OAuth](/guides/add-a-remote-mcp-server/#connect-it-to-an-account-with-oauth).

## An OAuth Installation asks for a client, or refuses the one entered

**What you see.** **Connect** opens **Enter a client for Docs** instead of the authorization server's sign-in, sometimes under **A client is needed again** with one of:

```
The client entered before was registered with another callback URL: register this one with it, or enter another client.
```

```
The MCP server's authorization server is now https://auth.example.com: enter a client registered with it.
```

```
The authorization server no longer takes the client entered before as it was: enter it again.
```

Or connecting with the client entered is refused in the dialog, or with **Couldn't connect Docs** once back on **MCP**, with one of:

```
The authorization server https://github.com/login/oauth takes no public client: enter the client's secret too.
```

```
The authorization server https://auth.example.com takes only public clients: leave the client secret empty.
```

```
The authorization server refused the connection: invalid_client.
```

**Why.** The authorization server offers no Dynamic Client Registration, as GitHub's doesn't, so the Hub needs a client you registered there by hand. One entered before is asked for again when it can't be used as it was: `HUB_PUBLIC_URL` changed, so the Hub's callback URL did; the MCP server names another authorization server; or the server no longer authenticates clients as it did. `invalid_client`, or `redirect_uri` in GitHub's error page, means the authorization server doesn't know the client, its secret, or its callback URL: the secret was mistyped or rotated, or the client was registered with another callback URL.

**Fix.** Register the client with the callback URL the dialog shows, `<HUB_PUBLIC_URL>/auth/mcp/callback`, copied with its button, and enter its client ID and secret as the authorization server issued them. For a rotated secret, press **Change client** on the Installation and enter the client with its new secret. The Hub keeps the client it had until a connection with the new one completes. See [Connect a server without Dynamic Client Registration](/guides/connect-an-mcp-server-with-oauth/#connect-a-server-without-dynamic-client-registration).

## A global Installation, or its MCP server, can't be changed

**What you see.** On **MCP**, **Edit** and **Delete** are disabled on an Installation marked **Global**, or on its MCP server, or saving is refused with one of:

```
Only the Hub's Owner can create, edit or delete a global Installation: every Sandbox on the Hub can use it.
```

```
Docs search has a global Installation, on in every Repo: only the Hub's Owner can edit, upgrade or delete it.
```

**Why.** A global Installation is on in every Repo, so every Sandbox on the Hub can use its credentials. Only the Hub's Owner creates, edits or deletes one, or edits, upgrades or deletes its MCP server.

**Fix.** Ask the Owner. Meanwhile, anyone with access to a Repo can press **Turn off for this Repo** on the Repo's page, or create the Repo's own Installation of the MCP server, which takes the global one's place there. See [Turn it on for every Repo](/guides/add-a-remote-mcp-server/#turn-it-on-for-every-repo).

## A Hub is already running on the database

**What you see.** The Hub, or `secrets-reset`, exits with:

```
HubLockRefused: The Hub can't start: a Hub is running on /path/to/hub.db. Stop it first.
```

```
The Sensitive values can't be reset: a Hub is running on /path/to/hub.db. Stop it first.
```

**Why.** A running Hub holds a lock on `hub.db.lock`. The lock goes when the Hub ends, even by a crash, so it is never stale.

**Fix.** Stop the other Hub: `kndl hub stop`, or the terminal running `bun run hub`. To run two Hubs side by side, give each its own `HUB_DATABASE`.

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

**Fix.** Set both of the pair, or neither. Point `GITHUB_APP_PRIVATE_KEY_PATH` at the App's private key as an absolute path the Hub's user can read: `~` isn't expanded. If the file is lost, generate a new private key on the App's settings page. See [Set up the GitHub App](/self-hosting/set-up-the-github-app/).

## The settings in `.env.local` are ignored

**What you see.** You put settings in a `.env.local`, yet the Hub still warns `GitHub sign-in is off`, or acts as if they aren't there.

**Why.** `bun run hub` runs in `packages/hub`, and Bun reads `.env.local` from there, not from the checkout's root. Values in your shell's environment also win over the file's.

**Fix.** Move the file to `packages/hub/.env.local`, check your shell doesn't export the same names, and restart the Hub.

## Startup warnings

These don't stop the Hub.

| Warning | What it means |
|---|---|
| `GitHub sign-in is off: GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET are not set.` | Only dev login can sign people in. |
| `` The GitHub App is not configured (GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY_PATH): Runners use their host's own git credentials, Sandboxes get no GitHub token so Claude can't push or open pull requests, and people signed in with GitHub can't see any Session. Run `kndl onboard --github-app create` to set one up. `` | See [Set up the GitHub App](/self-hosting/set-up-the-github-app/). |
| `` HUB_SECRETS_KEY is not set: Environments can't hold Sensitive values. Run `bun run secrets-key` to make one. `` | Plain variables still work. |
| `Dev login is on (KNDL_DEV_LOGIN): anyone reaching http://127.0.0.1:7777 can sign in without GitHub.` | Expected while you try kndl alone. |
| `Browsers reach the Hub over plain HTTP at … (HUB_PUBLIC_URL), so they will drop its Secure cookies and sign-in will fail. …` | See [Sign-in doesn't stick](/troubleshooting/sign-in/#sign-in-doesnt-stick). |
| `INSECURE COOKIES (HUB_INSECURE_COOKIES): the Hub's cookies are not Secure, so sign-in tokens travel in cleartext to …` | You set `HUB_INSECURE_COOKIES=1` over plain HTTP. |
| `HUB_INSECURE_COOKIES is set but does nothing: browsers reach the Hub over HTTPS (…), so its cookies stay Secure. Unset it.` | It only matters over plain HTTP. |
