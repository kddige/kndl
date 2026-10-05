<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="brand/lockup-dark.svg">
    <img src="brand/lockup-light.svg" alt="claude-hub" width="280">
  </picture>
</p>

# claude-hub

Multiplayer Claude Code: a self-hosted Hub where a team runs Claude Code Sessions in Sandboxes on any number of Runners, and watches and drives them together from the web.

**Documentation: <https://kddige.github.io/claude-hub/>**: the [tutorial](https://kddige.github.io/claude-hub/tutorials/first-session/), how-to guides, reference, explanations and [troubleshooting](https://kddige.github.io/claude-hub/troubleshooting/).

claude-hub is early: v1 is being built, and things change quickly.

## How it works

- The **Hub** keeps the Sessions, signs people in with GitHub, and serves the web UI.
- A **Runner**, on each machine that runs Sessions, starts each Session's Claude Code in tmux, signed in with that machine's own Claude account.
- Claude's tools run in the Session's **Sandbox**, a microsandbox microVM built from its Repo's **Environment**, so nothing Claude runs touches the host.
- Everyone signed in sees each Session live, prompts it, and can type into its terminal.

The words used here are defined in [`GLOSSARY.md`](GLOSSARY.md), and the design decisions are recorded in [`docs/adr/`](docs/adr/). Both are also on the site.

## Quick start

To install a Hub, a Runner or both as services, with the GitHub CLI signed in (the repository is private):

```sh
gh api repos/kddige/claude-hub/contents/install.sh -H 'Accept: application/vnd.github.raw' | sh
```

It installs into `~/.claude-hub` and starts `claude-hub onboard`; then `claude-hub status`, `doctor`, `logs` and `update` look after it. See [Install claude-hub](https://kddige.github.io/claude-hub/how-to/install/).

To run it from this checkout instead, on one machine and without GitHub, you need [Bun](https://bun.sh) 1.4 or newer, Claude Code (`claude`) signed in, `tmux` and `git`, and a Mac with Apple Silicon or Linux with KVM for the Sandboxes.

```sh
bun install
bun run web:build
HUB_PUBLIC_URL=http://127.0.0.1:7777 CLAUDE_HUB_DEV_LOGIN=1 bun run hub
```

In a second terminal:

```sh
bun run runner-token "$(hostname -s)"   # prints a Runner token, chr_…
RUNNER_TOKEN=chr_… bun run runner
```

Open <http://127.0.0.1:7777>, sign in with dev login, give a Repo its Environment, and start a Session on it. The [tutorial](https://kddige.github.io/claude-hub/tutorials/first-session/) walks through it, and the [how-to guides](https://kddige.github.io/claude-hub/how-to/install/) cover GitHub sign-in, more Runners and reaching the Hub from other machines.

## Development

One Bun workspace in TypeScript, with [Effect](https://effect.website):

| Package | What it is |
|---|---|
| [`packages/protocol`](packages/protocol) | The messages the Hub, Runners, the mod and the web UI exchange, as Effect Schemas. |
| [`packages/hub`](packages/hub) | The Hub: an Effect HTTP server on Bun, with SQLite. |
| [`packages/runner`](packages/runner) | A Runner: Claude Code in tmux, its tools in a microsandbox Sandbox. |
| [`packages/cli`](packages/cli) | The `claude-hub` command: installs, runs and looks after a Hub and Runner as services. |
| [`packages/mod`](packages/mod) | `hub-link`, the Claude Code mod each Session loads. |
| [`packages/web`](packages/web) | The web UI: React on Vite, Base UI and StyleX. |
| [`packages/docs`](packages/docs) | The documentation site: Astro Starlight. |
| [`brand/`](brand) | The logo's sources. `bun run --filter @claude-hub/docs brand` makes the PNG and ICO files from them. |

All from the repo root:

| Command | What it does |
|---|---|
| `bun test` | Runs every package's tests. |
| `bun run typecheck` | Typechecks every package. |
| `bun run lint` | Lints with oxlint. |
| `bun run format:check` | Checks formatting with oxfmt; `bun run format` applies it. |
| `bun run web` | The web UI's Vite dev server on <http://localhost:5173>, beside `bun run hub`. |
| `bun run mod:check` | Builds the mod and validates it with Claude Code. |
| `bun run docs:dev` | The documentation site on <http://localhost:4321/claude-hub/>. |
| `bun run docs:build` | Builds the site into `packages/docs/dist`. |

See [Develop claude-hub](https://kddige.github.io/claude-hub/how-to/develop-claude-hub/) and the [commands reference](https://kddige.github.io/claude-hub/reference/commands/) for the rest.

## Not affiliated with Anthropic

claude-hub is an independent project. It is not affiliated with, endorsed by or sponsored by Anthropic. Claude and Claude Code are Anthropic's trademarks; claude-hub runs the Claude Code you install, signed in with your own account.
