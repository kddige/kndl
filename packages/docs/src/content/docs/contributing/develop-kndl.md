---
title: Develop kndl
description: Run kndl from a checkout, run the checks, and work on the Hub, the Runner, the web UI, the mod and this site.
sidebar:
  order: 1
---

Clone kndl, run it from the checkout, and make a change that passes the checks. How to open a pull request is in [`CONTRIBUTING.md`](https://github.com/kddige/kndl/blob/main/CONTRIBUTING.md).

## What you need

- macOS or Linux, with git.
- [Bun](https://bun.sh) 1.4 or newer.
- tmux, for the Runner's tmux tests. Without it, `bun test` skips them.
- To run Sessions: a Mac with Apple Silicon, or Linux with KVM your user can open (add it to the `kvm` group), and at least one Model: a Provider connected on your **Account** page, or a Claude setup token from `claude setup-token` saved there.

## Get the code

```sh
git clone https://github.com/kddige/kndl.git
cd kndl
bun install
```

`bun install` also brings microsandbox's runtime for your platform. Every command on this page runs from the checkout's root.

## Run the checks

CI runs these on every pull request:

```sh
bun run typecheck
bun run lint
bun run format:check    # `bun run format` fixes it
bun test
```

| Command | What it does |
|---|---|
| `bun run typecheck` | `tsc --noEmit` in each code package and in `scripts/`, and `astro check` in `packages/docs`. |
| `bun run lint` | [oxlint](https://oxc.rs/docs/guide/usage/linter), configured in `.oxlintrc.json`. |
| `bun run format:check` | [oxfmt](https://oxc.rs/docs/guide/usage/formatter), configured in `.oxfmtrc.json`: formatting and import order. |
| `bun test` | Every package's tests, including the mod's pure modules (`packages/mod/src/*.spec.ts`). `KNDL_SANDBOX_IT=1` adds the tests that boot real Sandboxes. |
| `bun run mod:check` | Builds and type-checks the durable agent and runs the mod's shared and runtime tests. No Claude Code binary or sign-in is needed. |

## Find your way around

kndl is one Bun workspace in TypeScript, on [Effect](https://effect.website).

| Path | What it is |
|---|---|
| `packages/protocol` | The messages the Hub, Runners, the mod and the web UI exchange, as Effect Schemas, and which home a process keeps its state in. See [Protocol](/contributing/protocol/). |
| `packages/hub` | The Hub: an HTTP and WebSocket server with its data in SQLite. |
| `packages/runner` | A Runner: runs each Session's durable agent and a shell in tmux in a microsandbox Sandbox, and relays its mod's calls to the Hub. |
| `packages/mod` | The headless Pi Durable agent, its Claude model bridge, and the shared Hub link and message helpers. |
| `packages/cli` | The `kndl` command. Its decisions are pure modules with tests; `Host.ts` and `Shell.ts` do the I/O. `KNDL_DRY_RUN=1` prints the commands that change the system instead of running them. |
| `packages/web` | The web UI: React on Vite, with [Base UI](https://base-ui.com) and StyleX. |
| `packages/docs` | This site: Astro Starlight. |
| `install.sh` | The installer `curl … \| sh` runs. |
| `scripts/` | The PR title check and the release tooling. |
| `GLOSSARY.md`, `docs/adr/` | The [glossary](/reference/glossary/) and the [decisions](/contributing/decisions/). |

## Run the Hub

A checkout keeps its state apart from an install: the Hub's database is `packages/hub/hub.db`, and everything else is in `~/.kndl-dev`, so a checkout and an install can share a machine.

Put the Hub's settings in `packages/hub/.env.local`, which `bun run hub` reads. Settings in your shell's environment win over the file's. git ignores `.env*` and `*.pem` files.

```sh
# packages/hub/.env.local
KNDL_DEV_LOGIN=1
HUB_SECRETS_KEY=…   # from `bun run secrets-key`
```

Make a secrets key once, and back it up with `hub.db`:

```sh
bun run secrets-key
```

Then run the Hub one of two ways:

| To | Run | Open |
|---|---|---|
| Work on the web UI, with hot reload | `bun run hub` and, in another terminal, `bun run web` | <http://localhost:5173> |
| Serve the built web UI, as an install does | `bun run web:build`, then `HUB_PUBLIC_URL=http://127.0.0.1:7777 bun run hub` | <http://127.0.0.1:7777> |

`HUB_PUBLIC_URL` must be the address you open: it defaults to Vite's `http://localhost:5173`. Vite passes the Hub's routes through to the Hub at `HUB_URL`, by default `http://127.0.0.1:7777`.

To sign in with GitHub instead of dev login, add the App's settings to `.env.local`, as [Set up the GitHub App](/self-hosting/set-up-the-github-app/) describes, and make a Setup link to become the Owner:

```sh
bun run setup-link
```

Every setting is in the [configuration reference](/reference/configuration/#hub).

## Run a Runner

On the same machine as the Hub, issue a Runner token, then start the Runner with it:

```sh
bun run runner-token build-box
RUNNER_TOKEN=chr_… bun run runner
```

`bun run runner` builds the mod first. The token is shown once; running `runner-token` again for the same name replaces it. For a Hub on another machine, also set `HUB_URL`.

To keep the token out of your shell history, put the settings in an env file:

```sh
# ~/.kndl-dev/runner.env (chmod 600)
HUB_URL=https://hub.example.com
RUNNER_TOKEN=chr_…
```

```sh
bun --env-file="$HOME/.kndl-dev/runner.env" run runner
```

A checkout's Runner uses tmux socket `kndl-dev` and keeps Sessions in `~/.kndl-dev/sessions`, so it can run beside an installed one. It never updates itself: pull the checkout to the Hub's commit and restart it. Every setting is in the [configuration reference](/reference/configuration/#runner).

To look at Sandboxes by hand, run microsandbox's CLI from the Runner's package:

```sh
cd packages/runner && bun x msb list
```

## Work on the web UI without a Hub

The web UI runs against an in-process fake Hub that plays scripted Sessions:

```sh
VITE_FAKE_HUB=1 bun run web             # signed in
VITE_FAKE_HUB=signed-out bun run web    # starting signed out
```

Every component in its states is at `/kit`. The docs' screenshots are taken against the fake Hub.

## Work on the mod

```sh
bun run mod:build
bun run mod:check
```

`mod:build` bundles the headless agent into `packages/mod/durable/dist/agent.js`. A Session picks up a new build when its agent next starts. The Runner supplies the pinned Pi Durable packages and, for Claude model calls, the pinned Claude Code binary. Building, type-checking and running offline tests need neither that binary nor a Claude sign-in.

## Work on this site

```sh
bun run docs:dev      # http://localhost:4321/kndl/
bun run docs:build    # checks every link, too
```

Pages are Markdown in `packages/docs/src/content/docs`, written to `docs/design/docs-style.md`. The glossary and the decisions are rendered from `GLOSSARY.md` and `docs/adr/`: edit those. Pushes to `main` that touch the site deploy it to GitHub Pages.

## Run the CLI from a checkout

```sh
bun run cli status
```

It manages the installed home (`KNDL_HOME`, or `~/.kndl`), never `~/.kndl-dev`.

## Releases

A Release is a dated tag on `main`, like `v2026.10.1`, cut by hand. Pushing the tag runs CI and creates the GitHub Release, with notes built from the merged pull request titles. The steps are in [`docs/agents/releasing.md`](https://github.com/kddige/kndl/blob/main/docs/agents/releasing.md), and the reasons in [ADR 0025](/contributing/decisions/0025-releases-and-channels/).

## Agents in the repo

Coding agents write much of kndl, often in kndl Sessions. [`AGENTS.md`](https://github.com/kddige/kndl/blob/main/AGENTS.md) (also `CLAUDE.md`) is their instructions, `docs/agents/` holds the workflows they follow, and `.claude/skills/` the skills they use. Pull requests written with an agent are welcome; you're responsible for what you submit.

## Checkout problems

| What you see | Fix |
|---|---|
| The Runner exits with a `ConfigError` naming `RUNNER_TOKEN` | Set `RUNNER_TOKEN`: [Run a Runner](#run-a-runner). The Runner doesn't read the Hub's `.env.local`. |
| `The mod isn't built: …` | Start the Runner with `bun run runner`, or run `bun run mod:build` first. |
| `The Hub's web UI isn't built.` | Run `bun run web:build` and reload, or use `bun run web` and open <http://localhost:5173>. |
| Settings in `.env.local` are ignored | The file goes in `packages/hub/`, not the checkout's root. Check your shell doesn't export the same names. |
| `Only the web UI at http://localhost:5173 may make this request` | Open the address `HUB_PUBLIC_URL` names, or change it. |

Everything else is in [Troubleshooting](/troubleshooting/).
