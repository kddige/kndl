---
title: MCP servers
description: The rules for MCP servers, Installations and their values on a Hub, the OAuth flow, and the check a Session's start runs.
---

The rules the Hub applies to MCP servers and Installations. To add one, see [Add a remote MCP server](/guides/add-a-remote-mcp-server/). For packaged servers, see [MCP server packages](/reference/mcp-server-packages/).

## MCP servers

| Field | Rule |
|---|---|
| Id | `hub:` and the name in lowercase with dashes, such as `hub:docs-search`, for a server added on the Hub. A packaged server's id is its package name. |
| URL | Starts with `https://` or `http://`, with no user name, password or `#fragment`. Plain `http://` to a host other than `localhost` or a loopback address is marked **Unencrypted http**. |
| Header secrets | At most 10. Each has a title, a header, a value template holding `{value}` exactly once, and a key of letters, digits and underscores starting with a letter. |
| Refused headers | Those the Gateway sets itself, such as `Host`, `Content-Type` and `Mcp-Session-Id`: `The Gateway sets Host itself: use another header.` |

## Installations

| Rule | Detail |
|---|---|
| One per Repo | A Repo has at most one Installation of each MCP server. |
| Access | Creating, editing or deleting an Installation needs access on GitHub to every Repo it lists. |
| Global | On in every Repo, new ones included. Only the Hub's Owner can create, edit or delete a global Installation, or edit, upgrade or delete its MCP server. A server has at most one. |
| Override | A Repo's own Installation of a server takes the place of its global one on that Repo. |
| Turn off | Anyone with access to a Repo can turn a global Installation off and on for it. |
| Values | Write-only, one line of plain characters, at least 4 long. Saving with a field empty keeps its value. |

## Edits that clear values

A value is entered for one server and header, so an edit that would send it elsewhere clears it on every Installation. The dialog lists whose values it clears, and its button says **Save and clear values**.

| Edit | Values |
|---|---|
| URL to another scheme, host or port | All cleared. |
| URL to another path on the same server | Kept. |
| Header secret removed, or its key or header changed | That secret's values cleared. |
| Header secret's title or template changed | Kept. |

For an OAuth server, the same URL changes, or a change of **Sign-in**, disconnect every Installation and drop its client, with **Save and disconnect**.

## A Session's start check

As a Session starts or wakes, the Hub sends each of its Installations' servers an MCP `initialize` request, and waits up to `HUB_MCP_SERVER_CHECK_TIMEOUT_MS` (default 5 seconds).

| Result | The Session |
|---|---|
| A header secret has no value | Doesn't start: `Docs needs a value for API key.` |
| The server answers `401` or `403` | Doesn't start: `Docs's MCP server refused its credential (401).` |
| The Hub can't decrypt the values | Doesn't start: `The Hub could not read Docs's header secret values: check HUB_SECRETS_KEY.` |
| An OAuth Installation isn't connected | Doesn't start: `Docs isn't connected to its account.` |
| No answer in time, unreachable, or another error | Starts, with a warning in its conversation. |

While a Session runs, an Installation whose server refuses it shows as an error in the conversation, and the Session keeps its other servers. See [Troubleshooting](/troubleshooting/hub/#a-session-cant-start-for-an-installation).

## OAuth

The Hub connects an OAuth Installation as the [MCP authorization spec](https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization) describes:

| Step | Standard |
|---|---|
| Find the authorization server | Protected Resource Metadata (RFC 9728) |
| Read its metadata | RFC 8414, or OpenID Connect discovery |
| Register as a client | Dynamic Client Registration (RFC 7591), or a client entered by hand |
| Sign in | Authorization code with PKCE (`S256`) |
| Ask for a token for the server alone | Resource indicators (RFC 8707) |

- **Callback URL:** `<HUB_PUBLIC_URL>/auth/mcp/callback`. Changing `HUB_PUBLIC_URL` makes the Hub register again at the next **Connect**, and ask again for a client entered by hand.
- **Addresses:** the server and every address it names must be `https://`, or `http://` to `localhost` or a loopback address. The Hub follows no redirects.
- **Time limit:** a sign-in must finish within 10 minutes, in the same browser.
- **Tokens:** kept encrypted on the Hub, refreshed before they expire or when the server refuses one. The Gateway adds `Authorization: Bearer <token>` to each request, and holds request bodies up to 4 MiB so it can resend one after a refresh.
- **Client authentication:** HTTP Basic, else in the request form, or as a public client, as the authorization server's metadata allows.

## Change log

A Repo's page lists its Installations under **MCP servers**, and below them a **Change log**: who created, edited or deleted an Installation, who set its values, which edits cleared values, and who connected or disconnected an OAuth Installation. A change to a global Installation appears in every Repo's log. The log never holds a value.
