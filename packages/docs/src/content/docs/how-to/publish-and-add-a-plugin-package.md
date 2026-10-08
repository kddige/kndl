---
title: Publish and add a Plugin package
description: Describe a remote MCP server in a Plugin package, publish it in a git repo or as an archive, add it to a Hub, and upgrade it to a new version.
sidebar:
  order: 11
---

A Plugin package describes a remote MCP server once, so any Hub can add it as a [Plugin](/reference/glossary/#plugin) by its git URL or an upload, and upgrade it when it changes. The package is two files: the Hub reads them, and runs nothing in it. At the end of this page, your package is a Plugin on the Hub, pinned to its version, and you know how to upgrade it.

## Before you start

- A remote MCP server, as for [a Hub-only Plugin](/how-to/add-a-remote-mcp-server-as-a-plugin/#before-you-start).
- To publish from git: a public repo the Hub can fetch over `https://`, such as one on GitHub.

## Write the package

1. Make a folder, such as `linear-mcp/`, or use the root of the MCP server's own repo.
2. Add a `package.json` with the package's `name`, its Plugin's id, and its `version`:

   ```json
   { "name": "@acme/linear-mcp", "version": "1.0.0" }
   ```

   The name must be a valid npm package name. Choose one you own on npm, or under your own scope, so no other package takes it.

3. Beside it, add a `kndl.json` with the name people see and the MCP server's URL:

   ```json
   {
     "displayName": "Linear",
     "description": "Linear's issues and projects.",
     "mcp": { "url": "https://mcp.linear.example/mcp" }
   }
   ```

   If the server needs a header, such as an API key, add `auth` with [header secrets](/reference/plugin-packages/#header-secrets).

The [Plugin packages reference](/reference/plugin-packages/) lists every field and its rules.

## Publish it

Publish it in either of these ways:

- **In git:** commit both files and push. Tag each version you release, such as `v1.0.0`, so a Hub can pin to it.
- **As an archive:** run `npm pack` in the folder, which makes a `.tgz` such as `acme-linear-mcp-1.0.0.tgz`, or zip the folder. The archive must be at most 4 MiB.

## Add it to the Hub

Any Member can add a package.

1. Open **Plugins** in the sidebar.
2. Press **Add package**.
3. Choose where it is:
   - **From git:** enter the **Git repo URL**, such as `https://github.com/acme/linear-mcp`. Enter a **Ref**, a branch, tag or commit, or leave it empty for the default branch. If the package isn't at the repo's root, enter its **Folder**, such as `packages/linear`.
   - **Upload:** choose **The package's folder**, or an archive of it.
4. Press **Read package**. The Hub fetches it and shows what it read: the name, the package and its version, where it came from, the MCP server URL and the auth. Nothing is added yet.
5. Check what it read, then press **Add**.

The Plugin is listed with its package's name as its id, such as `@acme/linear-mcp`, and its version, such as `1.0.0 (3f2c9a1)`. Install it on Repos [as any Plugin](/how-to/add-a-remote-mcp-server-as-a-plugin/#turn-it-on-for-repos).

The Hub keeps what it read for 30 minutes. Past that, **Add** is refused with `That package read has expired; read it again.`

A name a Plugin on the Hub already has is refused: `A Plugin named @acme/linear-mcp is already on the Hub, from another source: only a package from the same source can upgrade it.` From the same source, the Hub offers an Upgrade of that Plugin instead.

## Upgrade it

A packaged Plugin is pinned to the version it was added at: its name, URL and auth change only with an Upgrade. It has no **Edit**.

1. Publish the new version.
2. On the Plugin, press **Upgrade**.
   - From git, the Hub fetches the same ref again at once: a branch's new head, or the commit a tag now names.
   - From an upload, choose the new version's folder or archive, then press **Read package**.
3. Check what upgrading changes: each field, as it is now and after. If the new version asks for new header secrets, a warning lists them; if it clears values Installations hold, another lists whose.
4. Press **Upgrade**.

If nothing changed, the dialog says the Plugin is up to date. To pin a Plugin from git to another ref, such as a new tag, press **Add package** and read the same repo at that ref: the Hub offers it as an Upgrade.

An Upgrade clears header secret values as [editing a Hub-only Plugin](/how-to/add-a-remote-mcp-server-as-a-plugin/) does: every value when the new URL is on another server, and a secret's values when the new version drops it or changes its key or header. Each Installation shows **needs a value** until someone enters it again.

Upgrading a Plugin with Installations needs access to every Repo they list, as editing a Hub-only Plugin does. Each of those Repos' change logs says who upgraded it, to what, and whose values it cleared. Running Sessions keep what they started with, and show a **Plugins changed** banner: **Restart** applies the Upgrade. An Asleep Session gets it as it wakes.

If someone else upgraded the Plugin after you read the package, **Upgrade** is refused: `Linear changed since that read; check for an upgrade again.`

## Delete it

Delete a packaged Plugin [as any Plugin](/how-to/add-a-remote-mcp-server-as-a-plugin/#delete-it): delete its Installations first.

## Next steps

- [Plugin packages](/reference/plugin-packages/): every field of `kndl.json`, and the limits the Hub reads packages with.
- [Protocol](/reference/protocol/#plugins): the messages that read, add and upgrade a package.
