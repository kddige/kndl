---
title: Use variables and secrets
description: Give a Repo's Sessions environment variables, keep secrets write-only and redacted, and share values across Repos.
sidebar:
  order: 6
---

An Environment's variables reach every process the Runner starts in its Sandboxes: the Bootstrap script (if available at build), the Start script, and every tool Claude runs.

## Before you start

Sensitive values are encrypted at rest with the Hub's `HUB_SECRETS_KEY`. Without it the Hub logs `HUB_SECRETS_KEY is not set: Environments can't hold Sensitive values.` and refuses to save one. Make a key and restart the Hub:

```sh
bun run secrets-key     # prints a new key
# then, in packages/hub/.env.local:
HUB_SECRETS_KEY=…
```

:::danger[Back up the key with the database]
Once any Sensitive value is saved, the Hub refuses to start without the same key, and the values can't be read without it. If the key is lost, [reset the Sensitive values](#if-the-key-is-lost) and enter them again.
:::

## Add a variable to an Environment

1. Open the Repo's Environment and, under **Variables**, press **Add variable**.
2. Give it a **Name**: letters, digits and underscores, not starting with a digit, unique in the Environment. Names starting `CLAUDE_HUB_` are the Runner's.
3. Pick its **Kind**:
   - **Plain**: everyone can see its value. For settings, such as `NODE_ENV`.
   - **Sensitive**: write-only. The Hub encrypts it and never sends it to the web UI, where it shows as set and can only be replaced. It must be at least 4 characters, so it can be found and masked in output. For tokens and keys.
4. Tick **At build** if the bootstrap needs it, for example a token for a private package registry. Plain variables always reach the bootstrap; Sensitive ones only with **At build**.
5. Apply the draft. A change to a variable available at build needs a Test build first; any other change applies at once.

## Share a value across Repos

**Shared variables**, in the sidebar, are Hub-wide variables, Plain or Sensitive, that any Environment can link:

1. On **Shared variables**, add the variable once, such as `NPM_TOKEN`.
2. In each Repo's Environment, press **Link shared variable**, pick it, and give it the name that Environment should see, with its own **At build**.

Changing a shared value changes it for every Environment that links it. While a link makes it available at build, its value can't be changed, because that would change the builds without a Test build; and a Shared variable can't be deleted while any Environment links it.

## If the key is lost

The values the key encrypted are lost with it: nothing can decrypt them. A reset clears them and keeps everything else, so the Hub starts with a new key and you enter the values again.

1. Stop the Hub. The reset is refused while a Hub runs on the database.
2. Reset:

   ```sh
   bun run secrets-reset          # in a checkout
   claude-hub secrets reset       # on an installed Hub
   ```

   It lists each Sensitive variable it clears, by Repo, and the shared ones, and asks before clearing them. Without a terminal it needs `--yes`.
3. Make a new key with `bun run secrets-key` (or `claude-hub secrets key`), set `HUB_SECRETS_KEY` to it, and start the Hub.
4. Enter the values again. Each cleared variable keeps its name, **At build** and Links, and shows **needs a value**:
   - On a Repo's Environment, type each value and apply. A value entered in place of a cleared one applies without a Test build, even at build.
   - On **Shared variables**, press **Enter value** on each.

Until each variable it has or links gets a value, a Repo's Sessions don't start: a new Session is refused, and one that wakes stays Asleep with a message naming the variables and its prompts queued. Its Test builds are refused too. Plain variables, Environments and their versions, and Sessions stay as they were. The reset also drops the replaced values kept to redact what older Sessions print, and the record of past Test builds, since the lost key protects both.

See [Commands](/reference/commands/#bun-run-secrets-reset---yes) for the reset's options.

## What protects a Sensitive value

- **Encrypted at rest** on the Hub with AES-256-GCM under `HUB_SECRETS_KEY`, and never sent to the web UI.
- **Only on Runners that need it.** A Runner fetches values over its WebSocket only for an Active Session of its own, or a Test build it was sent, and keeps them in memory. It passes them in the environment of each process it starts in the Sandbox, never in the VM's settings, which microsandbox stores on disk. microsandbox's log of what commands print is linked to `/dev/null` before a Sandbox's first command.
- **Masked in everything the Hub stores or shows**: prompts, Claude's text, tool input and output, terminal frames and Test build logs, with each character as `*`. It also finds the value trimmed, JSON-escaped, URL-encoded and, for a multi-line value such as a key, each of its long lines.

Masking has limits. It can't find a value that was changed before it was printed (base64, hashed, or split up by the program printing it), or one Claude Code's own screen wraps with indentation in the terminal; the transcript is still masked. And what a script writes to disk, such as a token in an `.npmrc`, stays on that disk: the Bootstrap script's on the Runner's disk, in the Build.

See [Security model](/explanation/security-model/#redaction) for more.
