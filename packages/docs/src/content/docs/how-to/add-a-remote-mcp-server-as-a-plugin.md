---
title: Add a remote MCP server as a Plugin
description: Add a remote MCP server to the Hub as a Plugin, turn it on for Repos with an Installation, and call its tools from a Session.
sidebar:
  order: 10
---

A [Plugin](/reference/glossary/#plugin) is a remote MCP server the Hub can add to Sessions. An [Installation](/reference/glossary/#installation) turns a Plugin on for the Repos it lists, and Claude Code in each Session on those Repos gets its MCP server. Claude Code reaches the server through the Hub's [Gateway](/reference/glossary/#gateway), never directly. At the end of this page, Claude in a Session calls a tool of your MCP server.

## Before you start

- A remote MCP server that speaks [Streamable HTTP](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports#streamable-http) at an `https://` URL the Hub can reach, such as `https://mcp.example.com/mcp`. The Hub calls it from its own address, not from the Runner's.
- The server must answer without credentials for now: the Hub has no way yet to hold a Plugin's credentials.
- Access on GitHub to every Repo you turn it on for, as for starting a Session there.
- A Runner that relays Plugins: one updated since Plugins came. A Session on an older Runner starts without its Repo's Installations.

## Add the Plugin

Any Member can add a Plugin.

1. Open **Plugins** in the sidebar.
2. Press **Add Plugin**.
3. Enter a **Name**, such as `Docs search`, and the **MCP server URL**, such as `https://mcp.example.com/mcp`. The URL must start with `https://` (or `http://`), and can't hold a user name, password or `#fragment`.
4. Press **Add**.

The Plugin is listed with its id: `hub:` and its name in lowercase with dashes, such as `hub:docs-search`. A Plugin made on this Hub alone always has a `hub:` id, so it can't clash with a Plugin from a package, which is named after its package.

To change its name or URL, press **Edit** on the Plugin. A new URL reaches running Sessions at once.

## Turn it on for Repos

1. On the Plugin, press **Install**.
2. Leave the **Name** as the Plugin's, or name this Installation, such as `Docs (staging)`. The name is how Sessions and the change log show it.
3. Enter the **Repos**, one `owner/name` per line.
4. Press **Add**.

You need access to every Repo you list. A Repo you have no access to, or that doesn't exist, is refused with `You have no access to owner/name on GitHub, or the GitHub App isn't installed on it.`, without saying which.

A Repo has at most one Installation of each Plugin. A second one is refused, naming the first: `owner/name already has Docs, an Installation of Docs search: a Repo has at most one Installation of each Plugin.` To change which Repos an Installation is on in, press **Edit** on it and change its Repos.

An Installation on in a Repo you have no access to shows `and 1 Repo you have no access to`, and only someone with access to all its Repos can change or delete it.

## Use it in a Session

New Sessions on the Repo, and Sessions that wake, start with the Installation. Claude Code gets one MCP server for each Installation on for the Repo, named after it, such as `docs` for `Docs`. It shows them as `plugin:kndl:docs`, so they never clash with the servers in the Repo's own `.mcp.json`, and their tools as `mcp__plugin_kndl_docs__<tool>`.

1. Open a Session on the Repo, or start one.
2. Press **Plugins** in the Session's header (**1 Installation**) to see the Installations it runs with, each with its Plugin and server.
3. Ask Claude to use the server, such as `Search the docs for "rate limits"`. Claude calls its tools like any other MCP tool.

A Session that was Active when the Installation was made keeps running without it, and shows a **Plugins changed** banner: **Restart** applies the change, with the Workspace and conversation as they are. An Asleep Session gets it as it wakes. Participants can't turn an Installation on or off for one Session: they are the Repo's.

## See who changed what

A Repo's page lists the Installations on for it under **Plugins**, and its **Change log**: who created, edited, added or removed an Installation there, and when. A change to Installations makes no new version of the Repo's [Environment](/how-to/set-up-an-environment/).

## Delete it

1. Delete each of the Plugin's Installations: press **Delete** on it, then **Delete** in the dialog. Sessions on its Repos lose its tools at once, and show that a Restart applies the change.
2. Press **Delete** on the Plugin, then **Delete** in the dialog.

A Plugin with Installations can't be deleted: `Docs search has an Installation: delete it first.`

## Next steps

- [Security model](/explanation/security-model/#the-gateway): what the Gateway lets through, and what it logs.
- [Protocol](/reference/protocol/#plugins): the Plugin messages and the Gateway's endpoint.
- [ADR 0020](/reference/decisions/0020-plugins-are-remote-mcp-servers-behind-the-hub/): why Plugins are remote MCP servers behind the Hub.
