---
title: About kndl
description: What kndl is, where it stands, how these docs are organised, and its relationship to Anthropic.
---

kndl (said "kindle") runs multiplayer agentic sessions that you host yourself, with Claude Code as the agent. One Hub keeps the Sessions; Runners on your own machines run them, each Session's tools inside a Sandbox; and everyone on the team watches and drives them from the web UI.

## Status

kndl is in early development: expect its setup and settings to change between versions. To install it, see [Install kndl](/how-to/install/); to work on it, see [Develop kndl](/how-to/develop-kndl/).

## Not affiliated with Anthropic

kndl is an independent project, not affiliated with, endorsed by or sponsored by Anthropic. Claude and Claude Code are trademarks of Anthropic, PBC; kndl uses the names only to say what it works with.

kndl runs Claude Code as Anthropic publishes it, on your own Claude account and under Anthropic's terms for it. kndl doesn't change or redistribute Claude Code.

## How these docs are organised

The docs follow [Diátaxis](https://diataxis.fr), plus Troubleshooting:

| Section | Read it to |
|---|---|
| [Tutorials](/tutorials/first-session/) | Learn by doing: run kndl end to end once. |
| [How-to guides](/how-to/install/) | Get one job done, such as adding a Runner or setting up an Environment. |
| [Reference](/reference/configuration/) | Look up a setting, a command, a path or a word. |
| [Explanation](/explanation/architecture/) | Understand how kndl works and why. |
| [Troubleshooting](/troubleshooting/) | Fix something, starting from what you see. |

The [glossary](/reference/glossary/) and the [decision records](/reference/decisions/0001-claude-on-host-tools-in-sandbox/) are rendered from `GLOSSARY.md` and `docs/adr/` in the repository.

## The name

kndl is said "kindle" and always written lowercase, even at the start of a sentence; the command is `kndl` too. It is short for kindling, the small things that get a fire going. See [ADR 0017](/reference/decisions/0017-the-name-is-kndl/).

## The mark

The kndl mark is Kip, a friendly flame on two crossed logs: the fire everyone gathers around. The wordmark is set in Fraunces. Kip's friend Mallow, a marshmallow, joins on the social card. The source files are in `brand/` in the repository.

## Contributing

Issues and decisions live in [GitHub Issues](https://github.com/kddige/kndl/issues). To work on kndl itself, see [Develop kndl](/how-to/develop-kndl/).
