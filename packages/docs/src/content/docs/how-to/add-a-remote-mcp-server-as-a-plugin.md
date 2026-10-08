---
title: Add a remote MCP server as a Plugin
description: Add a remote MCP server to the Hub as a Plugin, give it the keys it needs as header secrets or connect it to an account with OAuth, turn it on for Repos, or every Repo, with an Installation, and call its tools from a Session.
sidebar:
  order: 10
---

A [Plugin](/reference/glossary/#plugin) is a remote MCP server the Hub can add to Sessions. An [Installation](/reference/glossary/#installation) turns a Plugin on for the Repos it lists, or for every Repo, and Claude Code in each Session on those Repos gets its MCP server. Claude Code reaches the server through the Hub's [Gateway](/reference/glossary/#gateway), never directly. At the end of this page, Claude in a Session calls a tool of your MCP server.

## Before you start

- A remote MCP server that speaks [Streamable HTTP](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports#streamable-http) at an `https://` URL the Hub can reach, such as `https://mcp.example.com/mcp`. The Hub calls it from its own address, not from the Runner's.
- If the server needs a key, it must take it in an HTTP header, such as `Authorization: Bearer <key>`. If it needs a sign-in instead, its authorization server must speak OAuth as MCP specifies it, with [Dynamic Client Registration](https://datatracker.ietf.org/doc/html/rfc7591) or a client you register there by hand: see [Connect it to an account with OAuth](#connect-it-to-an-account-with-oauth). Either way, its Installations hold the credentials, encrypted, so the Hub needs a `HUB_SECRETS_KEY` ([Use variables and secrets](/how-to/use-variables-and-secrets/)).
- Access on GitHub to every Repo you turn it on for, as for starting a Session there.
- A Runner that relays Plugins: one updated since Plugins came. A Session on an older Runner starts without its Repo's Installations.

## Add the Plugin

Any Member can add a Plugin.

1. Open **Plugins** in the sidebar.
2. Press **Add Plugin**.
3. Enter a **Name**, such as `Docs search`, and the **MCP server URL**, such as `https://mcp.example.com/mcp`. The URL must start with `https://` (or `http://`), and can't hold a user name, password or `#fragment`.
4. If the server needs a key, declare it under **Header secrets**: press **Add header secret**, then enter
   - a **Title**, such as `API key`, which is how the Installations' value fields show it;
   - the **Header** to send it in, such as `Authorization`;
   - the **Value template**: the header's value, holding `{value}` exactly once, where the key goes. `Bearer {value}` sends `Authorization: Bearer <key>`; `{value}` sends the key alone;
   - its **Key**, which follows the title until you type one: letters, digits and underscores, starting with a letter. The Installations' values are kept under it.

   A Plugin declares at most 10. The Gateway sets some headers itself, such as `Host`, `Content-Type` and `Mcp-Session-Id`, and refuses them as header secrets: `The Gateway sets Host itself: use another header.`

   If the server signs people in with OAuth instead, set **Sign-in** to **OAuth**, and leave **Scopes** empty to ask for those the server names, or list them, such as `read write`. See [Connect it to an account with OAuth](#connect-it-to-an-account-with-oauth).
5. Press **Add**.

The Plugin is listed with its id: `hub:` and its name in lowercase with dashes, such as `hub:docs-search`. A Plugin made on this Hub alone always has a `hub:` id, so it can't clash with a Plugin from a package, which is named after its package. To add a server described once for any Hub, see [Publish and add a Plugin package](/how-to/publish-and-add-a-plugin-package/).

To change its name, URL or header secrets, press **Edit** on the Plugin. A new URL reaches running Sessions at once.

A value is entered for one server and header, so an edit that would send it elsewhere clears it on every Installation of the Plugin:

- a URL on another origin, another scheme, host or port, clears all of them. Another path on the same server, such as `/v2/mcp`, keeps them;
- a header secret removed, its key changed, or its header changed, clears its values. A new title or template keeps them.

Before it does, the dialog lists whose values saving clears, and its button says **Save and clear values**. Each Repo's change log records it, and each of those Installations needs its values again.

## Turn it on for Repos

1. On the Plugin, press **Install**.
2. Leave the **Name** as the Plugin's, or name this Installation, such as `Docs (staging)`. The name is how Sessions and the change log show it.
3. Enter the **Repos**, one `owner/name` per line.
4. Enter a value for each header secret the Plugin declares. The field says how it is sent, such as `Sent as Authorization: Bearer {value}`.
5. Press **Add**.

You need access to every Repo you list. A Repo you have no access to, or that doesn't exist, is refused with `You have no access to owner/name on GitHub, or the GitHub App isn't installed on it.`, without saying which.

A Repo has at most one Installation of each Plugin. A second one is refused, naming the first: `owner/name already has Docs, an Installation of Docs search: a Repo has at most one Installation of each Plugin.` To change which Repos an Installation is on in, press **Edit** on it and change its Repos.

An Installation on in a Repo you have no access to shows `and 1 Repo you have no access to`, and only someone with access to all its Repos can change or delete it.

## Turn it on for every Repo

The Hub's [Owner](/reference/glossary/#owner) can make an Installation global: on in every Repo on the Hub, existing and new, without listing them. Every Sandbox on the Hub can then use its credentials, so only the Owner can create, edit or delete a global Installation, or edit, upgrade or delete its Plugin. Anyone else is refused: `Only the Hub's Owner can create, edit or delete a global Installation: every Sandbox on the Hub can use it.`

1. On the Plugin, press **Install**, or press **Edit** on an Installation of it.
2. Check **Global**: on in every Repo. The **Repos** field goes, as a global Installation lists none.
3. Enter the values and press **Add**, or **Save**.

The Installation shows **Global** and `On in every Repo`. A Plugin has at most one global Installation. To make it Repo-scoped again, edit it, uncheck **Global** and list its Repos.

A Repo can still have its own Installation of the Plugin, such as one with the team's own key: anyone with access to the Repo creates it as usual, and on that Repo it takes the global one's place. A Repo still has at most one Installation of each Plugin it lists.

### Turn a global Installation off for a Repo

Anyone with access to a Repo can turn a global Installation off for it, and back on, without the Owner:

1. Open the Repo's page.
2. Under **Plugins**, press **Turn off for this Repo** beside the Installation. It shows **Off**.
3. To turn it on again, press **Turn back on**.

Each is logged in that Repo's change log. Sessions on the Repo pick it up on their next wake or **Restart**; the Gateway stops a running Session's requests to it at once.

### Header secret values

A value is write-only, like a [Sensitive variable](/how-to/use-variables-and-secrets/)'s. The Hub encrypts it with `HUB_SECRETS_KEY` and never sends it back: the Plugin shows, for each header secret of an Installation, who set its value and when, or **needs a value**. To replace one, press **Edit** on the Installation and type the new value; a field left empty keeps the value it has. A value must be one line of plain characters, at least 4 long, so it can be redacted from output.

Only the Hub holds the values. It adds the header to each request a Session sends through the Gateway, and they never reach the web UI, a Runner or a Sandbox. A Session runs with the values it started with: a new value applies at its next wake or Restart.

An Installation can be saved without a value, so you can make it before you have the key. A Repo's page shows such an Installation with **API key needs a value**, and its Repos' Sessions don't start until it has one: see [When an Installation fails a Session](#when-an-installation-fails-a-session).

## Connect it to an account with OAuth

A Plugin whose **Sign-in** is **OAuth** has no header secrets. Instead, each of its Installations is connected to one account at the MCP server's authorization server, and every Session on its Repos acts as that account: what Claude does through it, it does as whoever connected it. A global Installation's account is used by every Session on the Hub.

The Hub connects it as the [MCP authorization spec](https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization) describes. It asks the MCP server for its Protected Resource Metadata (RFC 9728), then its authorization server for its metadata (RFC 8414, or OpenID Connect discovery), registers itself there as a client with Dynamic Client Registration (RFC 7591), or else uses a client you registered there by hand, and signs you in with PKCE (`S256`), asking for a token for the server's URL alone (RFC 8707). The server, and every address it names, must be on `https://`, or plain `http://` to `localhost` or a loopback address, as for a server on the Hub's own machine: nothing sent there leaves it. The Hub follows no redirect from any of them. Where the authorization server offers no Dynamic Client Registration, as GitHub's doesn't, **Connect** asks for a client first: see [Connect a server without Dynamic Client Registration](#connect-a-server-without-dynamic-client-registration).

1. Add the Installation as above, then press **Connect** on it on **Plugins**.
2. Your browser goes to the authorization server. Sign in there, and allow kndl access.
3. It comes back to **Plugins**, which shows `Connected Docs`. The Installation shows **connected**, the account the server names, such as `as you@example.com`, and who connected it and when.

Connecting needs access to every Repo the Installation lists, as editing it does; only the Hub's [Owner](/reference/glossary/#owner) connects or disconnects a global Installation: `Only the Hub's Owner can connect or disconnect a global Installation: every Session on the Hub acts as its account.` A sign-in you begin must finish within 10 minutes, in the same browser, signed in to kndl as you: else it is refused with `That connection expired or came from elsewhere: connect again.`

The authorization server sends the browser back to the Hub at `<HUB_PUBLIC_URL>/auth/plugins/callback`, which it registered with. If you change `HUB_PUBLIC_URL`, the Hub registers again at the next **Connect**; a client entered by hand is asked for again, registered with the new URL.

Only the Hub holds the tokens, and the client, the one it registered or the one entered by hand, encrypted with `HUB_SECRETS_KEY`. They never reach the web UI, a Runner or a Sandbox. The Gateway adds `Authorization: Bearer <token>` to each request a Session sends to the server, with the token as the Hub holds it then: a refresh or a reconnect reaches running Sessions at once, and a disconnect stops their requests at once. The Hub refreshes the token itself, before it expires or when the server refuses it, and keeps the new refresh token if the server sends one. To send a request again after a refresh, the Gateway holds its body, at most 4 MiB, which MCP's messages are far below: a larger one is refused with `413`. Claude Code never signs in itself: the Gateway answers it without `WWW-Authenticate`, and never sends on a request for the server's OAuth discovery.

- **Reconnect** connects it again, to the same account or another, as when the connection was lost.
- **Disconnect** makes the Hub forget the tokens. A client entered by hand stays, for the next **Connect**. Its Repos' Sessions don't start until it is connected again, and their requests to the server are refused at once.
- When the authorization server refuses to refresh the token, as when the grant was revoked there, the Installation shows **connection lost**, and its Repos' Sessions don't start until someone presses **Reconnect**.

Each connect, reconnect and disconnect is in the change log of each Repo the Installation lists, or of every Repo for a global one, as `connected Docs to its account at Docs search`.

The tokens are for the server's origin alone. An edit that moves the Plugin's URL to another origin (scheme, host or port), or sets its **Sign-in** to something else, disconnects every Installation of it, and drops its client, the one the Hub registered or the one entered by hand, so no token or client secret is ever sent to another server. Before it does, the dialog says which it disconnects, and its button says **Save and disconnect**. A packaged Plugin's Upgrade does the same. Another path on the same server keeps them connected.

### Connect a server without Dynamic Client Registration

Some authorization servers register no clients themselves: you register one with them by hand, as an OAuth app, and the Hub connects with it. GitHub's is one. Its remote MCP server, `https://api.githubcopilot.com/mcp/`, names `https://github.com/login/oauth` as its authorization server, which takes OAuth Apps registered on GitHub.

1. Add the Plugin, such as **Name** `GitHub` and **MCP server URL** `https://api.githubcopilot.com/mcp/`, with **Sign-in** set to **OAuth**. Leave **Scopes** empty for those the server names, or list the ones you want, such as `repo read:org`.
2. Add its Installation, then press **Connect** on it. The Hub finds no registration at the authorization server, and asks for a client instead: **Enter a client for GitHub** shows the **Callback URL**, `<HUB_PUBLIC_URL>/auth/plugins/callback`. Press the copy button beside it.
3. Register the client. On GitHub, open **Settings** → **Developer settings** → **OAuth Apps** → **New OAuth App** (an organization's settings have the same page). Name it, such as `kndl`, set **Homepage URL** to your `HUB_PUBLIC_URL`, paste the callback URL into **Authorization callback URL**, and press **Register application**. Then press **Generate a new client secret**, and copy it: GitHub shows it once.
4. Back in kndl, enter the app's **Client ID** and the **Client secret**, and press **Connect**. The browser goes to GitHub: sign in, and authorize the app.

It comes back connected, and the Installation shows the client: its ID, `with a secret`, and who entered it when. Connecting and refreshing then work as with a registered client. Each Installation has its own client; one OAuth app can serve several Installations, as they share the Hub's callback URL.

The secret is write-only, like a header secret value: the Hub keeps it encrypted with `HUB_SECRETS_KEY`, sends it only to the authorization server's token endpoint, and never shows it again. The client must be one word of plain characters, and a secret at least 4 long, so it can be redacted from output. Leave the secret empty for a public client, one without a secret, where the authorization server takes those; where it takes none, the dialog asks for the secret. The Hub authenticates the client as the authorization server's metadata allows: with HTTP Basic, else in the request's form, or as a public client.

- **Change client** on the Installation asks for another client, as when the secret was rotated. The Hub keeps the client it has until a connection with the new one completes, so a wrong client never breaks a working connection.
- The client is asked for again when it can't be used as it was: when the authorization server, or the Hub's callback URL, changed since, or the server no longer takes the client as it authenticates. The dialog says why.
- A client entered by hand stays the Installation's, even if the authorization server comes to offer registration: only **Change client** replaces it.

Who may enter a client is who may connect: someone with access to every Repo the Installation lists, and only the Owner for a global one. Entering one, or another, is in the change log as `entered the OAuth client GitHub connects to GitHub with`, logged as the connection completes, never with the secret.

## Use it in a Session

New Sessions on the Repo, and Sessions that wake, start with the Installation. Claude Code gets one MCP server for each Installation on for the Repo, named after it, such as `docs` for `Docs`. It shows them as `plugin:kndl:docs`, so they never clash with the servers in the Repo's own `.mcp.json`, and their tools as `mcp__plugin_kndl_docs__<tool>`.

1. Open a Session on the Repo, or start one.
2. Press **Plugins** in the Session's header (**1 Installation**) to see the Installations it runs with, each with its Plugin and server.
3. Ask Claude to use the server, such as `Search the docs for "rate limits"`. Claude calls its tools like any other MCP tool.

A Session that was Active when the Installation was made keeps running without it, and shows a **Plugins changed** banner: **Restart** applies the change, with the Workspace and conversation as they are. A header secret value set since it started shows the same banner. An Asleep Session gets it as it wakes. Participants can't turn an Installation on or off for one Session: they are the Repo's.

## When an Installation fails a Session

As a Session starts or wakes, the Hub checks each Installation on for its Repo before Claude Code starts. It sends each MCP server an MCP `initialize` request, with the header secrets, as the Gateway would, and waits on it up to `HUB_PLUGIN_CHECK_TIMEOUT_MS` (5 seconds by default). The Session shows as starting meanwhile.

The Session doesn't start, and stays Asleep, when an Installation surely can't work:

| The Session says | Why |
| --- | --- |
| `Docs needs a value for API key.` | The Installation has no value for a header secret its Plugin declares. The Hub asks no server then. |
| `Docs's MCP server refused its credential (401).` | The server answered `401` or `403`: the value is wrong, expired or revoked. |
| `The Hub could not read Docs's header secret values: check HUB_SECRETS_KEY.` | The values can't be decrypted with the Hub's key. |
| `Docs isn't connected to its account.` | An OAuth Installation was never connected, was disconnected, or lost its connection. The Hub asks no server then. |

It shows **This Session can't start**, with each Installation and why. Prompts sent meanwhile wait in its queue, and run once it starts. For each Installation:

- **Fix** opens it on the **Plugins** page: enter the value, then save.
- For an OAuth Installation that isn't connected, **Reconnect** replaces **Fix**: it signs you in at its authorization server, as **Connect** does.
- **Take owner/name off Docs** takes the Session's Repo off the Installation and wakes the Session. It shows only for someone who can change the Installation: with access to every Repo it lists. If the Session's Repo is the only one, that deletes the Installation, so it asks first.
- For a global Installation, **Turn it off for owner/name** turns it off for the Session's Repo and wakes the Session. Anyone in the Session can. Only the Owner can **Fix** it: the others see `It is global: only the Hub's Owner can fix it.`

Then press **Retry**, or send a prompt: the Session is checked again as it wakes.

A server that is only down, or slow, doesn't stop the work: it may be back in a moment. When it doesn't answer in time, can't be reached, or answers with another error, such as `503`, the Session starts all the same, with a warning in its conversation, such as `Docs's MCP server could not be reached. Claude Code started all the same: its tools fail until it answers.`

The check runs once, as the Session starts. While the Session runs, an Installation that fails shows as an error in its conversation, with **Fix**, and the Session runs on, with its other servers: when the server answers the Gateway with `401` or `403`, or an edit to its Plugin left it needing a value, which the Gateway answers with `409`. It says so once, until the Installation works again. A new value applies at the Session's next wake or **Restart**.

No message, in the Session or in the Hub's log, holds a header secret's value.

## See who changed what

A Repo's page lists the Installations for it under **Plugins**, each saying where it comes from: listing the Repo, **Global**, **Overridden** by the Repo's own Installation of its Plugin, or **Off** for the Repo. Below is its **Change log**: who created, edited, added or removed an Installation there, who set its header secret values, and when an edit to the Plugin cleared them, and who connected, reconnected or disconnected an OAuth Installation, or entered its client. A change to a global Installation is in every Repo's log, a Repo new to the Hub's too, as `a global Installation`; turning it off or on is in that Repo's log alone. The log names the header secrets by title, never their values. A change to Installations makes no new version of the Repo's [Environment](/how-to/set-up-an-environment/).

## Delete it

1. Delete each of the Plugin's Installations: press **Delete** on it, then **Delete** in the dialog. Sessions on its Repos lose its tools at once, and show that a Restart applies the change.
2. Press **Delete** on the Plugin, then **Delete** in the dialog.

A Plugin with Installations can't be deleted: `Docs search has an Installation: delete it first.`

## Next steps

- [Security model](/explanation/security-model/#the-gateway): what the Gateway lets through, where header secret values and OAuth tokens go, and what it logs.
- [Protocol](/reference/protocol/#plugins): the Plugin messages and the Gateway's endpoint.
- [ADR 0020](/reference/decisions/0020-plugins-are-remote-mcp-servers-behind-the-hub/): why Plugins are remote MCP servers behind the Hub.
