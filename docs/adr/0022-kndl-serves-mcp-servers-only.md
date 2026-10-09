---
status: accepted
amends: 0020
---

# kndl serves MCP servers, and nothing else, as what a Plugin was

ADR 0020 named the thing a Repo's Sessions get from the Hub a Plugin, and left room for a Plugin to grow into skills, CLIs, hooks and setup scripts. It won't (#232). So it is named for what it is: an **MCP server**, and the page that manages them is **MCP**.

## How it works

- **MCP servers only.** What the Hub adds to Sessions is an MCP server: remote today, behind the Gateway. One the Hub hosts itself, over HTTP or stdio, may come later, since keeping a server's secrets off every Sandbox is something only the Hub can do.
- **No hooks, skills or setup scripts.** A Claude Code plugin committed to the Repo already brings those, and Claude Code in the Sandbox loads it. kndl doesn't make a format of its own for them.
- **"Plugin" means a Claude Code plugin.** kndl's mod is Claude Code plugins, and the Gateway's MCP servers reach Claude Code in one (`plugin:kndl:<server>`). The word is kept for those alone.
- **Renamed all the way down.** The protocol, the Hub's tables and routes, the web UI and the docs say MCP server. The OAuth callback moved to `/auth/mcp/callback`, `HUB_PLUGIN_CHECK_TIMEOUT_MS` is `HUB_MCP_SERVER_CHECK_TIMEOUT_MS`, and the web page is `/mcp`, with nothing kept under the old names.

## Considered options

- **Keep "Plugin"** for the room to grow. It made people expect skills and hooks kndl won't add, and it clashes with Claude Code's plugins.
- **Rename the web UI only.** The code would say one thing and the page another.
- **Keep the old OAuth callback, or both.** An OAuth Installation's client is registered with the old callback, so the switch disconnects it. Keeping a path named for a Plugin forever, for Installations reconnected in a minute, wasn't worth it.

## Consequences

- **OAuth Installations need connecting again,** and a client entered by hand needs `/auth/mcp/callback` added to its redirect URIs on the authorization server. Until then they fail the way any broken Installation does: the Session doesn't start, and says which one to fix.
- **A Hub run with `HUB_PLUGIN_CHECK_TIMEOUT_MS`** falls back to the default timeout until it's renamed.
- **Bookmarks of `/plugins` and links to the old docs pages** break.
- **ADR 0020's Deferred list** loses Plugins with files, values in the Sandbox, hooks and setup scripts. Hub-hosted stdio MCP servers stay possible, without the Runner cache it described.
