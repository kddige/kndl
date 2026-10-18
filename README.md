<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="brand/lockup-dark.svg">
    <img src="brand/lockup-light.svg" alt="kndl" width="180">
  </picture>
</p>

# kndl

**Multiplayer agentic sessions.**

> [!NOTE]
> Issues and pull requests are open to maintainers only for now, while we set the baseline kndl grows from. Please use [Discussions](https://github.com/kddige/kndl/discussions) for bugs, ideas and questions in the meantime.

kndl (said "kindle") is a self-hosted Hub where a team runs coding-agent Sessions in Sandboxes on any number of Runners, on the Models of any Provider they connect, and watches them together from the web. Each Session is driven by the person who started it.

**Documentation: <https://kddige.github.io/kndl/>**

kndl is early: v1 is being built, and things change quickly.

## How it works

- The **Hub** keeps the Sessions, signs people in with GitHub, and serves the web UI. It is invite-only: its **Owner** invites everyone else.
- A **Runner**, on each machine that runs Sessions, starts each Session's agent in its own **Sandbox**, a microVM built from its Repo's **Environment**, so nothing the agent runs touches the host. The agent is [pi](https://pi.dev) or Claude Code, whichever runs the Session's model, and a Session switches between them when its model does, handing the other what it hasn't seen.
- Each Session runs on its **Creator**'s own accounts: the **Providers** they connected on the Hub, with a subscription sign-in or an API key, and their Claude setup token for Claude's Models. The Hub keeps the Providers' credentials and adds them to model calls on the way out, so they never enter a Sandbox. Claude's token is the exception: Claude Code holds it in the Sandbox and talks to Anthropic directly.
- Only the Creator drives a Session: prompts it, answers it, stops it, controls it and uses its terminal. Everyone else with access to its Repo watches it live, subagents included.

Terms are defined in [`GLOSSARY.md`](GLOSSARY.md), and design decisions are in [`docs/adr/`](docs/adr/).

## Quick start

To install a Hub, a Runner or both as services, on macOS or Linux with git:

```sh
curl -fsSL https://raw.githubusercontent.com/kddige/kndl/main/install.sh | sh
```

It installs into `~/.kndl`. Then run `kndl onboard` to set up a Hub, a Runner, or both. See [Install kndl](https://kddige.github.io/kndl/self-hosting/install/). To get only the `kndl` command from a Hub, see [Install the CLI from a Hub](https://kddige.github.io/kndl/guides/install-the-cli-from-a-hub/).

To run it from this checkout on one machine, without GitHub, you need [Bun](https://bun.sh) 1.4 or newer, `git`, an account at a Provider (a subscription or an API key, or a Claude subscription for a `claude setup-token` token), which you connect on your Account page, and a Mac with Apple Silicon or Linux with KVM.

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

Open <http://127.0.0.1:7777>, sign in with dev login, give a Repo its Environment, and start a Session on it. The [tutorial](https://kddige.github.io/kndl/start/quickstart/) walks through it.

## Development

One Bun workspace in TypeScript, with [Effect](https://effect.website).

| Package | What it is |
|---|---|
| [`packages/protocol`](packages/protocol) | The messages the Hub, Runners, the mod and the web UI exchange, as Effect Schemas. |
| [`packages/hub`](packages/hub) | The Hub: an Effect HTTP server on Bun, with SQLite. |
| [`packages/runner`](packages/runner) | A Runner: pi or Claude Code in tmux in a microsandbox Sandbox, and the mod relay to the Hub. |
| [`packages/cli`](packages/cli) | The `kndl` command: installs, runs and looks after a Hub and Runner as services. |
| [`packages/mod`](packages/mod) | The mod each Session loads: a pi extension, with the Claude bridge, and for Claude Code two plugins, `hub-link`, which reports to the Hub, and `hub-link-commands`, which runs its commands. |
| [`packages/web`](packages/web) | The web UI: React on Vite, Base UI and StyleX. |
| [`packages/docs`](packages/docs) | The documentation site: Astro Starlight. |
| [`brand/`](brand) | The logo's sources. `bun run --filter @kndl/docs brand` makes the PNG and ICO files from them. |

From the repo root:

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

See [Develop kndl](https://kddige.github.io/kndl/contributing/develop-kndl/) and the [commands reference](https://kddige.github.io/kndl/reference/commands/).

## Not affiliated with Anthropic

kndl is an independent project, not affiliated with, endorsed by or sponsored by Anthropic. Claude and Claude Code are Anthropic's trademarks; kndl runs Claude Code as Anthropic publishes it, on your own Claude account.

## License

kndl is released under the [MIT License](LICENSE). The skills vendored in `.agents/skills` are MIT-licensed by their author; see [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).
