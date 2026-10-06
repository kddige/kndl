<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="brand/lockup-dark.svg">
    <img src="brand/lockup-light.svg" alt="kndl" width="180">
  </picture>
</p>

# kndl

**Multiplayer agentic sessions.**

kndl (said "kindle") is a self-hosted Hub where a team runs Claude Code Sessions in Sandboxes on any number of Runners, and watches and drives them together from the web.

**Documentation: <https://kddige.github.io/kndl/>**: the [tutorial](https://kddige.github.io/kndl/tutorials/first-session/), how-to guides, reference, explanations and [troubleshooting](https://kddige.github.io/kndl/troubleshooting/).

kndl is early: v1 is being built, and things change quickly.

## How it works

- The **Hub** keeps the Sessions, signs people in with GitHub, and serves the web UI.
- A **Runner**, on each machine that runs Sessions, starts each Session's Claude Code in tmux in the Session's **Sandbox**, a microsandbox microVM built from its Repo's **Environment**, so nothing Claude runs touches the host.
- The Sandbox never holds a Claude credential: the Runner's credential proxy adds its Creator's, or else the Runner's own, to each request on its way to Anthropic.
- Everyone signed in sees each Session live, prompts it, and can type into its terminal.
- A Session delegates with Claude Code's own subagents, in its Sandbox; each shows under its Session, live, and anyone can message, stop or resume it.

The words used here are defined in [`GLOSSARY.md`](GLOSSARY.md), and the design decisions are recorded in [`docs/adr/`](docs/adr/). Both are also on the site.

## Quick start

To install a Hub, a Runner or both as services, with the GitHub CLI signed in (the repository is private):

```sh
gh api repos/kddige/kndl/contents/install.sh -H 'Accept: application/vnd.github.raw' | sh
```

It installs into `~/.kndl` and starts `kndl onboard`; then `kndl status`, `doctor`, `logs` and `update` look after it. See [Install kndl](https://kddige.github.io/kndl/how-to/install/).

kndl was called claude-hub. An install made under that name moves to kndl's names when you run `claude-hub update`: see [From claude-hub](https://kddige.github.io/kndl/how-to/install/#from-claude-hub).

On a machine that runs no Hub or Runner, `curl -fsSL https://<your Hub>/cli | sh` installs the `kndl` command from a Hub, and it keeps itself on the Hub's commit. See [Install the CLI from a Hub](https://kddige.github.io/kndl/how-to/install-the-cli-from-a-hub/).

To run it from this checkout instead, on one machine and without GitHub, you need [Bun](https://bun.sh) 1.4 or newer, `git`, a Claude account (Claude Code signed in here, which the Runner then uses, or your own token on your Account page), and a Mac with Apple Silicon or Linux with KVM for the Sandboxes.

```sh
bun install
bun run web:build
HUB_PUBLIC_URL=http://127.0.0.1:7777 KNDL_DEV_LOGIN=1 bun run hub
```

In a second terminal:

```sh
bun run runner-token "$(hostname -s)"   # prints a Runner token, chr_…
RUNNER_TOKEN=chr_… bun run runner
```

Open <http://127.0.0.1:7777>, sign in with dev login, give a Repo its Environment, and start a Session on it. The [tutorial](https://kddige.github.io/kndl/tutorials/first-session/) walks through it, and the [how-to guides](https://kddige.github.io/kndl/how-to/install/) cover GitHub sign-in, more Runners and reaching the Hub from other machines.

## Development

One Bun workspace in TypeScript, with [Effect](https://effect.website):

| Package | What it is |
|---|---|
| [`packages/protocol`](packages/protocol) | The messages the Hub, Runners, the mod and the web UI exchange, as Effect Schemas. |
| [`packages/hub`](packages/hub) | The Hub: an Effect HTTP server on Bun, with SQLite. |
| [`packages/runner`](packages/runner) | A Runner: Claude Code in tmux in a microsandbox Sandbox, behind a credential proxy. |
| [`packages/cli`](packages/cli) | The `kndl` command: installs, runs and looks after a Hub and Runner as services. |
| [`packages/mod`](packages/mod) | The Claude Code mod each Session loads, as two plugins: `hub-link` reports to the Hub, `hub-link-commands` runs its commands. |
| [`packages/web`](packages/web) | The web UI: React on Vite, Base UI and StyleX. |
| [`packages/docs`](packages/docs) | The documentation site: Astro Starlight. |
| [`brand/`](brand) | The logo's sources. `bun run --filter @kndl/docs brand` makes the PNG and ICO files from them. |

All from the repo root:

| Command | What it does |
|---|---|
| `bun test` | Runs every package's tests. |
| `bun run typecheck` | Typechecks every package. |
| `bun run lint` | Lints with oxlint. |
| `bun run format:check` | Checks formatting with oxfmt; `bun run format` applies it. |
| `bun run web` | The web UI's Vite dev server on <http://localhost:5173>, beside `bun run hub`. |
| `bun run mod:check` | Builds the mod and validates its plugins with Claude Code. |
| `bun run docs:dev` | The documentation site on <http://localhost:4321/kndl/>. |
| `bun run docs:build` | Builds the site into `packages/docs/dist`. |

See [Develop kndl](https://kddige.github.io/kndl/how-to/develop-kndl/) and the [commands reference](https://kddige.github.io/kndl/reference/commands/) for the rest.

## Not affiliated with Anthropic

kndl is an independent project. It is not affiliated with, endorsed by or sponsored by Anthropic. Claude and Claude Code are Anthropic's trademarks; kndl runs Claude Code as Anthropic publishes it, on your own Claude account.
