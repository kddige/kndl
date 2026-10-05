---
status: accepted
supersedes: 0002
---

# Each person brings their Claude credential; a Session runs on its Creator's

Each person pastes their own Claude credential into the Hub once, on their account page: a `claude setup-token` token for their subscription, or an Anthropic API key. The Hub stores it encrypted, and a Session runs on its Creator's credential, whichever Runner it is on. Credentials belong to people, not machines, so any Runner can run anyone's Session, and nobody needs to sign in to Claude on a Runner.

Other Participants prompting a Session use its Creator's credential. This is the pair-prompting of ADR 0002, now with the person who started the Session rather than the Runner's owner.

## How it works

- **Storing.** The credential is encrypted at rest with the Hub's secrets key, like Sensitive Variables (ADR 0009). It is write-only once saved: the web shows its kind, the last four characters, when it was added, and for a token the plan its owner picked (Pro, Max), which Claude Code needs (ADR 0013). On save, the Hub checks it with one `count_tokens` request and refuses a credential Anthropic rejects. A person can replace or remove it at any time. Removing it stops their Sessions' Turns at the next request.
- **Delivering.** When a Session starts or wakes, the Runner asks the Hub for its credential over the Runner's WebSocket. The Hub answers only for a Session on that Runner. The Runner holds the credential in memory, bound to the Session's proxy token (ADR 0013), and drops it when that token is revoked. It never reaches the Runner's disk or the Sandbox, and it is masked from transcripts and logs like the Session's other secrets.
- **Kinds.** For a token, the proxy swaps the bearer and the launch sets the subscription variables. For an API key, the proxy sends `x-api-key` in place of the bearer and drops the OAuth beta flag, and the launch leaves the subscription variables out.
- **Without one.** If the Creator has none, the Session uses the Runner's own credential when its owner has configured one (ADR 0013), and the UI says whose account it is on. If neither exists, New Session asks the person to add theirs first.

## Considered options

- **The Runner's login (ADR 0002).** Nothing stored on the Hub, but it ties accounts to machines: each Runner needs a login, and everyone's Sessions on it spend its owner's plan.
- **Whoever prompts pays.** The proxy could switch credentials per request with no restart. It is left for later: queued prompts, Reports and background subagents blur whose request a given API call is.
- **Proxy at the Hub,** so the credential never leaves it. It hides people's tokens from Runner owners, but every model stream would pass through the Hub. A Runner owner can already read the Workspaces of the Sessions it runs, so they are trusted with the Sessions they run anyway.

## Consequences

- **Anthropic's terms.** Anthropic does not permit third-party developers to offer Claude.ai login, or to route requests through Free, Pro or Max credentials on behalf of their users. claude-hub is self-hosted, each person uses their own credential, and the official Claude Code client makes every request. Whether that is acceptable is each deployment's call. API keys are always allowed, and switching a person from one to the other is a paste.
- **The Hub holds credentials.** A compromised Hub, or a lost secrets key, exposes or loses them. The key's handling is ADR 0009's. A lost key clears credentials as it clears Sensitive values, and people paste theirs again.
- **Runner owners are trusted with the credentials of the Sessions they run.** While a Session is awake, its credential is in its Runner's memory.
