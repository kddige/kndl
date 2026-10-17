---
status: accepted
amends: 0014, 0024, 0026
---

# pi is kndl's Harness, and the Hub is the Gateway to every Provider

Everything in a Session is built on Claude Code today: the mod hooks its in-process engine, Subagents are its Agent tool, Open questions are its AskUserQuestion, and a Model is one of its `--model` aliases. kndl should be the interface whatever model drives a Session, and the Creator should be able to switch a Session to any Model of any Provider they connected, at any time, with the conversation carried over.

So, once a spike shows the Claude bridge holds up:

- **pi is the Harness.** A pinned pi, mounted read-only like Claude Code is, runs its TUI in tmux in the Sandbox, so the terminal keeps working. kndl's mod for it is a pi extension that speaks the same mod protocol to the Hub as the Claude Code plugins do, so the Hub and web barely know which Harness a Session has.
- **pi has one provider, `kndl`, and it is the Hub.** The provider sends pi-ai's own context to the Gateway and streams back pi-ai's events. The Hub calls pi-ai with the Creator's Connected provider. It's lossless (thinking signatures, cache control, images), and kndl writes no per-Provider translation.
- **The Hub holds every Connected provider.** It runs the OAuth sign-ins itself, keeps refresh tokens, encrypted, and refreshes them. API keys are pasted on the same page. None of them enter a Sandbox. pi authenticates to the Gateway with a per-Session token, and the Hub only ever uses that Session's Creator's Connected providers. It records usage and cost per Turn. There are no spending caps for now.
- **Claude goes through our own bridge.** A kndl pi provider runs Claude Code in the Sandbox, on the Creator's Claude credential as today, as a model only: none of its own tools, every tool served from pi. Claude Code is the supported way to spend a Claude subscription, and through pi-ai directly it would bill as extra usage. This is the one credential still in the Sandbox.
- **Models come from the Providers.** The Hub asks each Connected provider's models API, under the Creator's account, caches the list, and refreshes it when asked. The picker shows only the Creator's.
- **Switching a Model is pi's.** pi carries the conversation across Providers: messages, tool calls and results pass through. Thinking blocks are dropped on a switch, which kndl doesn't show anyway.
- **kndl writes what pi leaves out.** Its extension adds Subagents, as child pi sessions in the same process on any of the Creator's Models, reported as today. It adds a question tool with the same shape as today's Question, so Open questions don't change. It adds the Attachment tool (ADR 0024).
- **A Repo's setup still loads.** CLAUDE.md, AGENTS.md, `.claude/skills`, pi's own `.pi/` and the Session's MCP servers through the Gateway. Claude Code hooks and plugins don't.
- **The protocol speaks pi-ai.** Effort becomes pi's thinking level, Turn usage is pi-ai's (with cost), a Turn's end is its stop reason, and the conversation id is the Harness's own.
- **Only the Creator drives, whatever the Provider.** ADR 0026's rule stays for every Session. A Session spends its Creator's accounts.

## Rollout

1. A throwaway spike of the Claude bridge.
2. Connected providers, the Gateway's model calls and the pi Harness, beside Claude Code, without Claude.
3. The Claude bridge.
4. Subagents and the question tool.
5. New Sessions are pi. Sessions already on Claude Code keep it until they're purged, and a later Release removes it.

## The spike decides

The bridge must show, against a real subscription:

- a Claude turn through Claude Code that uses only pi's tools;
- usage counted against the plan's limits, not as extra usage;
- prompt cache hits on consecutive turns;
- abort and steering working;
- GPT → Claude → GPT in one Session.

If it fails, Claude Code and pi are peer Harnesses instead, chosen when a Session starts. A Claude Code Session keeps the full Claude experience, and a pi Session switches among the other Providers. This ADR is then rewritten to say so.

**It passed on 2026-10-18** (`docs/research/claude-bridge-spike.md`). Its one failure was a bug in `pi-claude-bridge`: it rewrote a message pi already held after an abort, which broke the next switch to GPT. Our bridge never changes a message once pi has it.

## Considered options

- **Claude Code and pi as peers, fixed per Session.** No bridge to own, but no switching between Claude and the rest in one Session. It's the fallback.
- **Switching Harness mid-session.** kndl would translate Claude Code transcripts to and from pi's and swap the TUI, with two toolsets. It's the most fragile.
- **pi-claude-bridge.** It does what our bridge would, but it has one maintainer, it depends on Claude Code internals, and it has open bugs in abort, steering and the cache. We take its approach, not the package.
- **An OpenAI-compatible Gateway.** Any client could use it, but it's lossy for Anthropic's thinking and caching, and the Hub would translate it to every Provider.
- **Credentials in the Sandbox, refreshed by pi.** It's simpler, but long-lived secrets sit in the VM, and concurrent Sessions race on rotating tokens.
- **Driving by Participants on API-key Providers.** Allowed by the terms, but who may drive would change with the Model. Later, if wanted.

## Consequences

- **The Hub is on every model call.** A Hub that's down or slow stalls every pi Session, and the Hub carries the streams. Claude's calls don't pass through it.
- **kndl tracks pi.** pi ships every few days and breaks extensions. kndl pins it and upgrades it on purpose, as it does Claude Code.
- **The bridge is ours to keep working** across Claude Code releases, and it depends on how Anthropic bills Claude Code's headless use.
- **The Claude Code mod goes**, with its spike-found tricks (ADR 0018), once the last Claude Code Session is purged.
