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

## Amendment: the Gateway forwards each Provider's own API (2026-10-18)

The `kndl` provider was to send pi-ai's context to the Hub, which would call pi-ai. Instead, kndl's pi extension re-points pi's own providers, such as `openai` and `xai`, at the Gateway. pi still speaks each Provider's API itself, using the Session token as its key, and the Gateway sends each request on with the Creator's credential in its place, refreshing a sign-in's when needed. It keeps what the decision was for: nothing lost on the way, no translation for each Provider, and no credential in the Sandbox. It also takes less code than streaming pi-ai's events through the Hub, and pi's own message conversion, caching and usage accounting stay as they are. `docs/design/pi-harness.md` has the details.

The first Providers were OpenAI (Sign in with ChatGPT, or an API key) and xAI (Sign in with SuperGrok or X Premium, or an API key). Now they are every one pi-ai serves whose requests the Gateway can send on faithfully: an API at a fixed address, with a key it can put where pi put the Session's, or a sign-in whose `toAuth` says what to send. That adds sign-ins with GitHub Copilot, OpenRouter, Kimi Code and Meta, and API keys for OpenRouter, Google's Gemini, Mistral, DeepSeek, Groq, Cerebras, Kimi, Moonshot AI, Z.AI, MiniMax, Meta, Together, Fireworks, Hugging Face, NVIDIA, Vercel AI Gateway, OpenCode Zen and Go, Baseten, Qwen's and Xiaomi's Token Plans, Xiaomi, Ant Ling, and the Chinese regions of Moonshot AI, Z.AI, MiniMax, Qwen and Xiaomi. Not Anthropic, whose Models run through Claude Code (and whose API keys stay deferred, #334); not Amazon Bedrock or Google Vertex AI, which need cloud credentials and signed requests; not Azure or Cloudflare, whose address is per account; not Radius, whose catalogue is per account; not pi-ai's legacy `openai-codex`, which OpenAI's sign-in replaces. `docs/design/pi-harness.md` lists them, with how each signs in, sends its key and lists its Models.

## Amendment: what the first version leaves out (2026-10-18)

- **Disconnecting a Provider doesn't put Sessions to sleep.** A Claude credential removed does, as it sits in the Sandbox (ADR 0026). A Connected provider never enters one, so its Sessions stay awake, and a Turn on its Models fails, saying why, until it is connected again or the Model is switched.
- **pi's Subagents run in the background, without worktrees, kept on disk.** The `agent` call returns at once, and the agent's result starts a Turn of its own, reported from the agent (`FromAgent`), as Claude Code's task notifications are; the model can still wait for one. The model messages, resumes and stops them with `message_agent` and `stop_agent`, as the Creator does. Each agent's pi session is a file on the Session's volume, so sleep or a restart interrupts a running one, and a message resumes any of them on its saved conversation.
- **A Hub can turn Claude's Models off** for pi Sessions (`HUB_CLAUDE_MODELS=off`), in case Anthropic bills Claude Code's headless use differently: the bridge's one dependence on terms kndl doesn't set.

## Amendment: a Session can switch Harness (ADR 0030)

A Session's Harness is no longer fixed for life: picking a Model of the other Harness switches it between Turns, with a context handoff.
