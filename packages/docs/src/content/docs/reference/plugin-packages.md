---
title: Plugin packages
description: The kndl.json manifest and package.json fields a Plugin package needs, and the limits the Hub reads them with.
---

A Plugin package is a folder with a `package.json` and, beside it, a kndl manifest, `kndl.json`. The Hub reads only these two files, from a git repo or an upload, and runs nothing in the package. To publish one and add it to a Hub, see [Publish and add a Plugin package](/how-to/publish-and-add-a-plugin-package/).

```text
linear-mcp/
├── package.json
└── kndl.json
```

## `package.json`

The Hub reads two fields, and ignores the rest.

| Field | Required | What it is |
|---|---|---|
| `name` | Yes | The Plugin's id. It must be a valid npm package name: lowercase letters, digits, `-`, `.` and `_`, at most 214 characters, with an optional `@scope/`, such as `@acme/linear-mcp`. A Hub-only Plugin's id starts with `hub:`, so the two never clash. |
| `version` | Yes | The version the Plugin is pinned to: a [semantic version](https://semver.org/), such as `1.2.0`. |

A package from git is also pinned to the commit it was read at. Sessions and the change log show both, such as `1.2.0 (9b41e07)`.

## `kndl.json`

```json
{
  "displayName": "Linear",
  "description": "Linear's issues and projects.",
  "mcp": { "url": "https://mcp.linear.example/mcp" },
  "auth": {
    "type": "headers",
    "headers": [
      { "key": "apiKey", "title": "API key", "header": "Authorization", "template": "Bearer {value}" }
    ]
  }
}
```

The Hub reads it strictly: a field it doesn't know refuses the package, and the refusal lists every problem, one per line, such as `kndl.json: mcp.url is missing.` or `kndl.json: auth.headers[0]: The Gateway sets Host itself: use another header.`

| Field | Required | What it is |
|---|---|---|
| `$schema` | No | Ignored, for editors that validate the file. |
| `displayName` | Yes | The Plugin's name, as the Plugins page and Sessions show it. One line of 1 to 80 characters. |
| `description` | No | One line of 1 to 500 characters, shown on the Plugin. |
| `mcp.url` | Yes | The remote MCP server's URL, over [Streamable HTTP](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports#streamable-http). It must start with `https://` (or `http://`), and can't hold a user name, password or `#fragment`. |
| `auth` | No | What the MCP server needs to be reached: `{ "type": "none" }`, the default, [header secrets](#header-secrets), or [OAuth](#oauth). |

### Header secrets

`{ "type": "headers", "headers": [...] }` lists the HTTP headers the Gateway sends the MCP server, each with a value an Installation supplies. They become the Plugin's header secrets, one for one, under the same rules as a Hub-only Plugin's. Each header is:

| Field | Required | What it is |
|---|---|---|
| `key` | Yes | Its identifier, unique in the Plugin: a letter, then at most 63 letters, digits or underscores, such as `apiKey`. Installations' values are kept by it. |
| `title` | Yes | What the web UI asks for, such as `API key`. One line of 1 to 80 characters. |
| `header` | Yes | The HTTP header's name, such as `Authorization`: at most 128 characters an HTTP token allows, each name once, ignoring case. It can't be one the Gateway sets itself or MCP uses: `Accept`, `Connection`, `Content-Encoding`, `Content-Length`, `Content-Type`, `Host`, `Keep-Alive`, `Last-Event-ID`, `Mcp-Protocol-Version`, `Mcp-Session-Id`, `Proxy-Authorization`, `Proxy-Connection`, `TE`, `Trailer`, `Transfer-Encoding` or `Upgrade`. |
| `template` | No | The header's value, with `{value}` exactly once where the Installation's value goes, such as `Bearer {value}`. One line of plain characters, at most 1024. `{value}` by default. |

A Plugin lists 1 to 10 headers, each key and each header name once.

### OAuth

`{ "type": "oauth" }` is for an MCP server that signs people in with OAuth, as the [MCP authorization spec](https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization) describes, through an authorization server that offers Dynamic Client Registration (RFC 7591). Each Installation of the Plugin is connected to one account there, from the Plugins page, and only the Hub holds its tokens: see [Connect it to an account with OAuth](/how-to/add-a-remote-mcp-server-as-a-plugin/#connect-it-to-an-account-with-oauth).

```json
"auth": { "type": "oauth", "scopes": ["read", "write"] }
```

| Field | Required | What it is |
|---|---|---|
| `scopes` | No | The OAuth scopes to ask for, at most 20, each one word of printable ASCII without `"` or `\`. Without it, the Hub asks for those the server names in its challenge or metadata. |

## Where the Hub reads it from

| From | What the Hub reads | Limits |
|---|---|---|
| A git repo | The two files at the repo's root, or in the folder given, at one ref: a branch, tag or commit, or the default branch. | Only `https://` URLs of public repos. One shallow fetch of the ref, with no checkout, hooks, submodules or credentials, of at most 20 MB, in at most 60 s. The folder must be inside the repo: no `..` or absolute path. Neither file may be a symlink. |
| A `.tgz` or `.zip` archive | The two files at the archive's root, or in its one top-level folder, such as npm's `package/` or GitHub's `<repo>-<ref>/`. | At most 4 MiB, unpacking to at most 32 MiB. An entry outside the archive, absolute or with a `..`, refuses it, as does either file twice, or as a link. |
| A folder | The two files at the folder's top, picked in the browser. Nothing else in the folder is sent. | |

Each file is at most 64 KiB.

## Pinning and Upgrades

A packaged Plugin stays as it was read: its name, description, URL and auth change only with an Upgrade, which shows what it changes, and whose values it clears, and applies only once confirmed. It can't be edited on the Plugins page. Only a package from the same source upgrades it: the same git repo and folder, at any ref, or another upload. A package whose name a Plugin from another source has is refused.

An Upgrade clears Installations' header secret values as editing a Hub-only Plugin does: all of them when the URL moves to another origin (scheme, host or port), and a secret's when it is gone from the package or has another key or header. Each value was entered for the server and header it had, so it goes nowhere else. Likewise, an Upgrade of an OAuth Plugin to another origin, or to another `auth` type, disconnects its Installations, dropping their tokens and their client, the one the Hub registered or the one entered by hand; the Upgrade dialog says which first.

An Upgrade logs `upgraded <plugin>, the Plugin of <installation>, to <version>` in each Repo with an Installation of it, and `cleared <titles> of <installation>` where it cleared values. Sessions keep running what they started with, and show that a Restart applies the change; an Asleep one gets it as it wakes.
