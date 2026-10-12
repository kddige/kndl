# Contributing to kndl

Thanks for helping. kndl is early and changes quickly, so open an issue before you start on anything big: a short discussion saves a rewrite.

## Set up

[Develop kndl](https://kddige.github.io/kndl/how-to/develop-kndl/) covers the repository's layout, what to install, and how to work on the web UI, the mod and the docs site.

## Checks

Run these from the repository's root before you open a pull request:

```sh
bun test
bun run typecheck
bun run lint
bun run format:check    # `bun run format` fixes it
```

## How the repo works

- **Words.** [`GLOSSARY.md`](GLOSSARY.md) defines the domain terms: Hub, Runner, Session, Sandbox and the rest. Use them, with their capitals, in code, docs and issues. Add a term there when you introduce one.
- **Decisions.** Design decisions are ADRs in [`docs/adr/`](docs/adr/). Read the ones near your change. If your change makes a new decision or reverses one, add an ADR or amend the old one in the same pull request.
- **Docs.** A change in behaviour updates the docs pages that describe it, in the same pull request. Pages follow [`docs/design/docs-style.md`](docs/design/docs-style.md).
- **Issues.** Maintainers triage with the labels in [`docs/agents/triage-labels.md`](docs/agents/triage-labels.md). `ready-for-agent` and `ready-for-human` issues are specified well enough to pick up.
- **Pull request titles** are `<areas>: <change> (#<issue>)`, like `web: long pastes show as a chip in the Composer (#279)`. The areas are one or more of `hub`, `runner`, `web`, `cli`, `mod`, `protocol`, `docs`, `brand`, `ci` and `repo`, comma-separated, main area first, and the issue is optional. Pull requests are squash-merged with their title as the commit title, and the release notes group them by their first area, so a check enforces this ([ADR 0025](docs/adr/0025-releases-and-channels.md)). Commits inside a pull request have no convention.
- **Agents.** Much of kndl is written by coding agents in kndl Sessions. [`AGENTS.md`](AGENTS.md) and [`CLAUDE.md`](CLAUDE.md) are their instructions, and `.claude/skills/` holds the skills they use. Contributions written with an agent are welcome; you are responsible for what you submit.

## Security

Never report a vulnerability in a public issue. See [`SECURITY.md`](SECURITY.md).
