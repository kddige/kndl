---
status: accepted
---

# Sessions use the Runner login; the Hub never handles Claude credentials

Every Session on a Runner runs on the Claude account signed in on that Runner, and the UI shows which account on every Session. Anthropic's terms require each user to use their own credentials, and forbid developers from collecting, storing or intermediating Claude.ai credentials or session tokens. So the Hub must never store or relay Claude logins, which rules out a per-user token vault.

This is pair-prompting, not shared accounts: other Participants are prompting a session that visibly runs on someone's login, with their consent, as if looking at the same screen. The credential source stays a Runner setting, so it can switch to an Anthropic API key or a Team/Enterprise seat without redesign.

## Considered options

- **Hub stores each user's `setup-token`**: rejected, because it conflicts with the credential terms.
- **Whoever prompts pays (restart under their login each Turn)**: needs the same token storage.
- **Org API key**: explicitly allowed and simplest; deferred, not rejected.

## Amendment: the login reaches Claude Code through the Runner's proxy (ADR 0013)

Claude Code now runs in the Sandbox, so the Runner no longer hands it the login. The Runner holds the credential, preferably a `claude setup-token` token, and its credential proxy puts it on each request in place of a per-Session token. Sessions still run on the Runner owner's account. The credential still stays on the Runner, and the Hub still never sees it.
