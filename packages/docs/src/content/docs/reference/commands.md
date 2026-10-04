---
title: Commands
description: The bun run scripts at the repository's root, what each one runs, and what it prints.
sidebar:
  order: 2
---

Every command runs from the root of a claude-hub checkout.

:::note[Coming: the `claude-hub` CLI]
A `claude-hub` command will replace most of these for installed Hubs and Runners: `onboard`, `status`, `logs`, `doctor`, `update` and `uninstall` ([#84](https://github.com/kddige/claude-hub/issues/84)). The scripts below stay for working on claude-hub itself.
:::

## Running claude-hub

| Command | What it does |
|---|---|
| `bun run hub` | Starts the Hub on `HOST:PORT` (`127.0.0.1:7777`). Reads `packages/hub/.env.local`. |
| `bun run runner` | Builds the `hub-link` mod, then starts a Runner. Needs `RUNNER_TOKEN`. |
| `bun run web` | Starts Vite's dev server for the web UI on <http://localhost:5173>, passing `/auth`, `/health` and `/ws` through to the Hub. |
| `bun run web:build` | Builds the web UI into `packages/web/dist`, which the Hub serves. |

## Setting up

### `bun run runner-token <name>`

Issues a token for the Runner named `<name>` and prints it, once:

```
Runner build-box (…). Its token, shown only now:

  chr_…

Any earlier token for this Runner no longer works. Give the token to the Runner as RUNNER_TOKEN.
```

The Hub stores only a hash. Issuing again for the same name keeps the Runner's id and its Sessions, and replaces its token. Run it on the Hub's machine: it writes to the Hub's database.

### `bun run secrets-key`

Prints a new `HUB_SECRETS_KEY`, 32 random bytes in base64, for encrypting Sensitive values. It changes nothing: put the key in `packages/hub/.env.local` yourself, and back it up with the database.

## Checks

| Command | What it does |
|---|---|
| `bun test` | Runs every package's tests. `CLAUDE_HUB_SANDBOX_IT=1` adds the ones that boot real Sandboxes. |
| `bun run typecheck` | Runs each package's `typecheck` script: `tsc --noEmit` for the Hub, Runner, protocol and web UI, a script for the mod, and `astro check` for this site. |
| `bun run lint` | Lints with oxlint; a warning fails it. |
| `bun run format` | Formats with oxfmt. `bun run format:check` only checks. |
| `bun run mod:build` | Builds the mod's hook library into `packages/mod/hooks/hub-link-lib.js`. |
| `bun run mod:check` | Builds the mod, then runs `claude plugin validate` and `claude plugin test` on it. |

## This site

| Command | What it does |
|---|---|
| `bun run docs:dev` | Serves this site with hot reload on <http://localhost:4321/claude-hub/>. |
| `bun run docs:build` | Builds it into `packages/docs/dist`. |
| `bun run --filter @claude-hub/docs brand` | Makes the logo's PNG and ICO files from the SVGs in `brand/`, and copies the favicons into the site's and the web UI's `public/` folders. |
