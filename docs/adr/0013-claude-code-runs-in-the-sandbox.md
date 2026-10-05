---
status: accepted
supersedes: 0001
---

# Claude Code runs in the Sandbox; a Runner proxy holds the Claude credential

Each Session's Claude Code process runs inside its Sandbox, in tmux in the VM, from the Runner's read-only Claude Code mount. Its tools run where it runs, so nothing is routed: Bash, Read, Edit, WebFetch, hooks, the Repo's `settings.json`, skills, nested `CLAUDE.md` files, MCP servers and plugins all behave as they do on a laptop. The Claude credential never enters the Sandbox. Claude Code talks to a credential proxy on the Runner host with a dummy token for its Session only, and the proxy puts the real credential in its place on the way to Anthropic. Claude Code itself still makes every request, unchanged; only the `Authorization` header differs.

ADR 0001 kept Claude Code on the host to keep the login out of the VM. The price was that everything Claude Code does outside a tool call ran on the host too, so each feature that reads the project or runs something had to be turned off or rebuilt to read through the Sandbox: Repo skills and `CLAUDE.md` (#125), WebFetch (#126), the `!` shortcut (#136), with `settings.json`, hooks, nested `CLAUDE.md` and `.claude/rules/` still missing. The proxy keeps the login out of the VM without that price. Spike #142 measured it.

## How it works

- **In the VM.** The Runner starts tmux and `claude` in the Sandbox through the backend's SDK exec. `CLAUDE_CONFIG_DIR` is on a per-Session disk volume, so the conversation, `--resume` and Claude Code's own state survive sleep. The Runner seeds that config with onboarding, trust and bypass permissions accepted, and sets `IS_SANDBOX=1`, since Claude runs as root in the VM. tmux is part of every Environment build. The working directory is `/workspace`, with Claude Code's normal setting sources.
- **Terminal.** The terminal mirror and control mode attach with `tmux -C attach` through the SDK's exec. The `msb exec` command line can't be used: it returns output only when the command exits. In #142, first output arrived 54 ms after attaching and keys echoed in 12 ms.
- **Sleep and wake.** Sleep stops the VM with Claude Code in it. Wake starts the VM, then tmux and `claude --resume <id>`: about 1 s to the prompt in #142, with history intact even after a stop mid-Turn. Changing the model or effort (#128) restarts Claude Code the same way, in the VM.
- **The credential proxy.** One process per Runner, on the host's loopback, reached from guests at `host.microsandbox.internal`. Each Session gets a random token, passed per process (`exec -e`, `tmux -e`) and never written to the VM's config, as `CLAUDE_CODE_OAUTH_TOKEN`. It is revoked when the Session sleeps or is archived, and a new one is issued on wake. The proxy refuses requests without a live Session token, forwards only `POST /v1/messages`, `POST /v1/messages/count_tokens` and `GET /v1/models`, swaps the bearer, and streams the response back untouched. It logs per Session and never logs a credential.
- **Claude Code's environment.** `ANTHROPIC_BASE_URL` points at the proxy. `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` and `DISABLE_AUTOUPDATER=1` turn off the requests that skip the base URL (telemetry, feature flags, the MCP registry, the marketplace, the updater). With a custom base URL, Claude Code treats the account as "Claude API": no ToolSearch, no plan limits, no remote managed settings. `_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL=1` with `CLAUDE_CODE_SUBSCRIPTION_TYPE`, `CLAUDE_CODE_RATE_LIMIT_TIER` and `CLAUDE_CODE_OAUTH_SCOPES` restore that. The first is an undocumented internal variable, so Runners pin the Claude Code version they mount, and an upgrade passes a smoke test first: banner, `/status`, and a Turn with a tool.
- **The credential.** Normally the Session's Creator's, from the Hub (ADR 0015). As a fallback, a Runner holds a `claude setup-token` token: it lasts a year, is scoped to inference, and the Runner never refreshes it. On macOS it lives in the Keychain, elsewhere in a file only the Runner's user can read. Reading Claude Code's own login (the Keychain item `Claude Code-credentials` or `~/.claude/.credentials.json`) also works, read-only, but its access token lasts about 8 hours and only Claude Code on the host refreshes it. The Runner must not refresh it itself: refresh tokens rotate, so that would sign one side out. A setup-token carries no plan, so the Runner owner states it (Pro, Max) in the Runner's config, for `CLAUDE_CODE_SUBSCRIPTION_TYPE`.
- **The mod.** hub-link loads read-only with `--plugin-dir`. It no longer answers tool calls; it keeps the Hub link (events, commands, the band) and the Child Session tools (ADR 0012). It reaches the Hub through a relay for `/mod/*` on the Runner, authenticated by the same per-Session token as the proxy, and the Runner adds the Session's mod token on the way. So the Sandbox holds one secret, which is revocable, and mod tokens still never enter a Sandbox (ADR 0004).

## What goes away

The tool bridge (`claude mcp serve` in the VM, the tool socket and the mod's routing), the hardened launch (`--tools`, `--setting-sources ""`, `disableSkillShellExecution`, the empty host directory), the Repo files copy of #125, the WebFetch denial of #126, and the `!` note of #136. Claude Code's own subagents can run in the Sandbox too; whether they replace Child Sessions is ADR 0014's question (#148).

## Considered options

- **Keep ADR 0001.** No new moving parts, but every Claude Code feature that touches the project needs a port or a denial, and some (hooks, `settings.json`) can't be had safely at all.
- **Claude Code in the VM with the real credential.** Simplest, but anything the agent runs, or a prompt injection, could read a year-long token from `/proc` and use it anywhere.
- **The Hub holds each user's Claude login and hands it out.** Ties accounts to people rather than Runners, but ADR 0002 rules out storing or relaying Claude logins, and copies of a rotating refresh token sign each other out.
- **An Anthropic API key.** Allowed and simple, and the proxy makes it a configuration change later (ADR 0002), but it isn't the owner's subscription.

## Consequences

- **The agent can spend the owner's subscription directly.** It can read its own Session token and call the proxy outside Claude Code. That is limited to one Session, while it is awake, and to three paths, and it is logged per Session. The real credential never enters the VM. The proxy could add per-Session rate or concurrency limits.
- **The Session token is the only identity.** Every guest reaches the host as 127.0.0.1, so the proxy can't tell VMs apart by address. vsock per VM or `ANTHROPIC_UNIX_SOCKET` could tie identity to a channel; not tried yet.
- **What a Repo can do is what the Sandbox can do.** Hooks, `settings.json` and MCP servers from the Repo run in the VM. A Repo's `settings.json` that changes `ANTHROPIC_BASE_URL` sends the Session token elsewhere, where it is useless: the proxy is only reachable from the Runner's own guests.
- **Lost with the proxy:** fast mode (its status check goes direct and fails), refreshing usage in `/status` (limits still show, from response headers), and remote managed settings for Team and Enterprise owners, which is unverified.
- **Memory:** Claude Code adds about 250–300 MiB to each running VM.
- **Terms.** Several Participants drive the owner's subscription through the proxy. This is the pair-prompting ADR 0002 describes, but check it against Anthropic's terms before shipping.
- **Moving existing Sessions.** Their transcripts are on the host, under the host Session directory's project path. The first wake in a VM copies them to the state volume under `/workspace`'s project path, so `--resume` finds them.
