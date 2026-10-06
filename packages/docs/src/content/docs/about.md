---
title: About kndl
description: What kndl is, where it stands, how these docs are organised, and its relationship to Anthropic.
---

kndl (said "kindle") runs multiplayer agentic sessions that you host yourself, with Claude Code as the agent. One Hub keeps the Sessions; Runners on your own machines run them, each Session's tools inside a Sandbox; and everyone on the team watches and drives them from the web UI.

## Status

kndl is young and moving fast: expect its setup and settings to change between versions. The `kndl` command installs a Hub, a Runner or both as services, and keeps them up to date: see [Install kndl](/how-to/install/). To work on kndl itself, run it from a checkout with `bun run`: see [Develop kndl](/how-to/develop-kndl/).

## Not affiliated with Anthropic

kndl is an independent project. It is not affiliated with, endorsed by or sponsored by Anthropic. Claude and Claude Code are trademarks of Anthropic, PBC; kndl uses the names only to say what it works with.

kndl runs Claude Code, as Anthropic publishes it, on your own Claude account, under Anthropic's terms for that account. Each Runner downloads Claude Code from Anthropic into its Sandboxes; kndl doesn't change or redistribute it.

## How these docs are organised

The docs follow [Diátaxis](https://diataxis.fr), with troubleshooting alongside:

| Section | Read it to |
|---|---|
| [Tutorials](/tutorials/first-session/) | Learn by doing: run kndl end to end once. |
| [How-to guides](/how-to/install/) | Get one job done, such as adding a Runner or setting up an Environment. |
| [Reference](/reference/configuration/) | Look up a setting, a command, a path or a word. |
| [Explanation](/explanation/architecture/) | Understand how kndl works and why. |
| [Troubleshooting](/troubleshooting/) | Fix something, starting from what you see. |

The [glossary](/reference/glossary/) and the [decision records](/reference/decisions/0001-claude-on-host-tools-in-sandbox/) are rendered from `GLOSSARY.md` and `docs/adr/` in the repository at build time, so they always match it.

## The name

kndl is said "kindle" and always written lowercase, even at the start of a sentence; the command is `kndl` too. It is short for kindling, the small things that get a fire going. It was called claude-hub until it was renamed, as a product's name can't use "Claude": see [ADR 0017](/reference/decisions/0017-the-name-is-kndl/). An install made under the old name moves to the new one with its next update: see [Update from claude-hub](/how-to/install/#from-claude-hub).

## The mark

The kndl mark is a terminal prompt whose two strokes meet at a node, followed by a cursor: several lines of work joining at one Hub, ready for the next prompt. It is drawn from scratch for this project, set in the indigo of the web UI's accent, and the wordmark is set in JetBrains Mono. The source files are in `brand/` in the repository.

## Contributing

Issues and decisions live in [GitHub Issues](https://github.com/kddige/kndl/issues). To work on kndl itself, see [Develop kndl](/how-to/develop-kndl/).
