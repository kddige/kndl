---
title: About claude-hub
description: What claude-hub is, where it stands, how these docs are organised, and its relationship to Anthropic.
---

claude-hub is multiplayer Claude Code that you host yourself. One Hub keeps the Sessions; Runners on your own machines run them, each Session's tools inside a Sandbox; and everyone on the team watches and drives them from the web UI.

## Status

claude-hub is young and moving fast: expect its setup and settings to change between versions. The `claude-hub` command installs a Hub, a Runner or both as services, and keeps them up to date: see [Install claude-hub](/how-to/install/). To work on claude-hub itself, run it from a checkout with `bun run`: see [Develop claude-hub](/how-to/develop-claude-hub/).

## Not affiliated with Anthropic

claude-hub is an independent project. It is not affiliated with, endorsed by or sponsored by Anthropic. Claude and Claude Code are trademarks of Anthropic, PBC; claude-hub uses the names only to say what it works with.

claude-hub runs Claude Code, as Anthropic publishes it, on your own Claude account, under Anthropic's terms for that account. Each Runner downloads Claude Code from Anthropic into its Sandboxes; claude-hub doesn't change or redistribute it.

## How these docs are organised

The docs follow [Diátaxis](https://diataxis.fr), with troubleshooting alongside:

| Section | Read it to |
|---|---|
| [Tutorials](/tutorials/first-session/) | Learn by doing: run claude-hub end to end once. |
| [How-to guides](/how-to/install/) | Get one job done, such as adding a Runner or setting up an Environment. |
| [Reference](/reference/configuration/) | Look up a setting, a command, a path or a word. |
| [Explanation](/explanation/architecture/) | Understand how claude-hub works and why. |
| [Troubleshooting](/troubleshooting/) | Fix something, starting from what you see. |

The [glossary](/reference/glossary/) and the [decision records](/reference/decisions/0001-claude-on-host-tools-in-sandbox/) are rendered from `GLOSSARY.md` and `docs/adr/` in the repository at build time, so they always match it.

## The mark

The claude-hub mark is a terminal prompt whose two strokes meet at a node, followed by a cursor: several lines of work joining at one Hub, ready for the next prompt. It is drawn from scratch for this project, set in the indigo of the web UI's accent, and the wordmark is set in JetBrains Mono. The source files are in `brand/` in the repository.

## Contributing

Issues and decisions live in [GitHub Issues](https://github.com/kddige/claude-hub/issues). To work on claude-hub itself, see [Develop claude-hub](/how-to/develop-claude-hub/).
