---
title: Use variables and secrets
description: Give a Repo's Sessions environment variables, keep secrets write-only and redacted, and share values across Repos.
sidebar:
  order: 7
---

An Environment's variables reach every process the Runner starts in its Sandboxes: the Bootstrap script (if available at build), the Start script, and every tool Claude runs.

## Before you start

Sensitive values are encrypted with the Hub's `HUB_SECRETS_KEY`. Without it the Hub logs `HUB_SECRETS_KEY is not set: Environments can't hold Sensitive values.` and refuses to save one. Make a key with `kndl secrets key` (`bun run secrets-key` in a checkout), set it in the Hub's env file, and restart the Hub:

```sh
# ~/.kndl/hub.env, or packages/hub/.env.local in a checkout
HUB_SECRETS_KEY=…
```

:::danger[Back up the key with the database]
Once any Sensitive value is saved, the Hub refuses to start without the same key, and the values can't be read without it. If the key is lost, [reset the Sensitive values](#if-the-key-is-lost) and enter them again.
:::

## Add a variable to an Environment

1. Open the Repo's Environment and, under **Variables**, press **Add variable**.
2. Give it a **Name**: letters, digits and underscores, not starting with a digit, unique in the Environment. Names starting `KNDL_` are the Runner's.
3. Pick its **Kind**:
   - **Plain**: everyone can see its value. For settings, such as `NODE_ENV`.
   - **Sensitive**: write-only, and masked in output. The web UI shows it as set and can only replace it. At least 4 characters. For tokens and keys.
4. Tick **At build** if the bootstrap needs it, for example a token for a private package registry. Plain variables always reach the bootstrap; Sensitive ones only with **At build**.
5. Apply the draft. A change to a variable available at build needs a Test build first; any other change applies at once.

## Share a value across Repos

**Shared variables**, in the sidebar, are Hub-wide variables, Plain or Sensitive, that any Environment can link:

1. On **Shared variables**, add the variable once, such as `NPM_TOKEN`.
2. In each Repo's Environment, press **Link shared variable**, pick it, and give it the name that Environment should see, with its own **At build**.

Changing a shared value changes it for every Environment that links it. Its value can't be changed while a link makes it available at build, and it can't be deleted while any Environment links it.

## If the key is lost

The values the key encrypted are lost with it. A reset clears them and keeps everything else, so the Hub starts with a new key and you enter the values again.

1. Stop the Hub. The reset is refused while a Hub runs on the database.
2. Reset:

   ```sh
   bun run secrets-reset          # in a checkout
   kndl secrets reset       # on an installed Hub
   ```

   It lists the Sensitive variables, and the Installations' header secrets, it clears and asks first. Without a terminal it needs `--yes`.
3. Make a new key with `bun run secrets-key` (or `kndl secrets key`), set `HUB_SECRETS_KEY` to it, and start the Hub.
4. Enter the values again. Each cleared variable keeps its name, **At build** and Links, and shows **needs a value**:
   - On a Repo's Environment, type each value and apply. No Test build is needed, even at build.
   - On **Shared variables**, press **Enter value** on each.
   - On **MCP**, edit each Installation whose header secrets show **needs a value**, and type each value. See [Header secret values](/how-to/add-a-remote-mcp-server/#header-secret-values).
   - On **MCP**, press **Connect** on each OAuth Installation: the reset dropped its tokens and its client. One whose client was entered by hand asks for its client ID and secret again. See [Connect it to an account with OAuth](/how-to/add-a-remote-mcp-server/#connect-it-to-an-account-with-oauth).

Until each variable it has or links gets a value, a Repo's Sessions and Test builds don't start: a Session that wakes stays Asleep with a message naming the variables, and its prompts stay queued. The reset also drops the record of past Test builds.

See [Commands](/reference/commands/#bun-run-secrets-reset---yes) for the reset's options.

## What protects a Sensitive value

- **Encrypted at rest** on the Hub with AES-256-GCM under `HUB_SECRETS_KEY`, and never sent to the web UI.
- **Only on Runners that need it.** A Runner fetches values only for its own Active Sessions and Test builds, keeps them in memory, and passes them only in the environment of the processes it starts in the Sandbox.
- **Masked in everything the Hub stores or shows**: prompts, Claude's text, tool calls, the terminal and Test build logs, with each character as `*`, including trimmed, JSON-escaped and URL-encoded forms.

Masking can't find a value changed before it was printed, such as base64 or split up, or one wrapped in the terminal; the transcript is still masked. What a script writes to disk, such as a token in an `.npmrc`, stays there: the Bootstrap script's in the Build, on the Runner's disk.

See [Security model](/explanation/security-model/#redaction) for more.
