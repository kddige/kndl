---
status: accepted
supersedes: 0003, 0013, 0015
---

# A Session runs on its Creator's setup token, in the Sandbox, and only its Creator drives it

Anthropic's terms let a person use their Claude subscription through Claude Code themselves. They don't permit sharing it, and they don't permit routing requests through Free, Pro or Max credentials for other people. Three things kndl did went against that:

- **A Runner's own login.** Sessions whose Creator had none ran on it (ADR 0015).
- **The credential proxy.** It swapped the real credential into Claude Code's requests on the Runner host (ADR 0013).
- **Equal Participants.** Every Participant prompted on the Creator's credential (ADR 0003).

So:

- **Every Session runs on its Creator's own setup token**, a `claude setup-token` token. There's no fallback: a Session whose Creator has none can't start or wake. API keys aren't accepted for now (#334).
- **The token goes into the Sandbox, and Claude Code talks to Anthropic directly.** When a Session starts or wakes, the Runner fetches its Creator's token from the Hub, as before. It sets `CLAUDE_CODE_OAUTH_TOKEN` on Claude Code's own process through `tmux -e`. The launch's value wins over a Variable of the same name, and the token is never written to the VM's disk. `ANTHROPIC_BASE_URL` and the subscription variables go: Claude Code is signed in as itself, and learns the plan from Anthropic, so nobody picks one any more. Variables that would sign Claude Code in some other way, such as `ANTHROPIC_API_KEY`, are kept out of its environment.
- **Only the Creator drives a Session.** That means:
  - prompting, steering and cancelling queued prompts, answering Open questions, and stopping Turns;
  - messaging and stopping Subagents;
  - the terminal, which Participants can't see either: raw terminal frames are where the token is easiest to leak;
  - every Session control: sleep, wake, keep awake, restart, model and effort, rename, archive and restore.

  Other Participants watch: they read the Session live or Archived, see Attachments, and Forward its ports while it's awake. Only the Creator's Forward wakes an Asleep Session. Everything still needs Repo access on top.

## How it works

- **The mod relay.** What's left of the proxy on the Runner host relays `/mod/*` and `/gateway/*` to the Hub. It's authenticated by the Session's per-Session token, and the Runner adds the Session's mod token on the way. The Sandbox never needs to reach the Hub, and the mod token stays out of it. Its port is `RUNNER_RELAY_PORT`, and the old `RUNNER_PROXY_PORT` still works. `RUNNER_CLAUDE_CREDENTIAL` is no longer read.
- **Revoking.** When a Creator removes or replaces their token, or is removed as a Member, the Hub puts their awake Sessions to sleep, and each one says why. The Hub won't hand a removed Member's token to a Runner. A replaced token reaches a Session at its next wake.
- **Upgrading.** A Hub on this version puts to sleep the Sessions whose Creator has no token, and says why. It also cancels prompts queued by anyone but the Creator, and the chat shows them as cancelled. The protocol version goes up, so the Hub turns away an older Runner, and that Runner updates to the Hub's commit (ADR 0011).
- **Redaction.** The Hub masks the Creator's token in transcripts and terminal frames, as it does Sensitive values. A transformed copy (base64, split up) isn't caught. But only the Creator can ask Claude for one.

## Considered options

- **Keep the proxy, only the Creator driving.** The real token would stay out of the VM. But the proxy's undocumented first-party switches, its stripped headers and its lost features (fast mode, `/status` usage, managed settings) are all there to route a subscription through something that isn't Claude Code. Claude Code talking to Anthropic directly is the plain, supported use.
- **Take ownership.** Another Participant adopts a Session whose Creator is gone onto their own token. Fork (#332) covers that without rewriting who the Creator is: any Participant copies the Session and runs the copy on their own token.
- **Prompt suggestions in this change.** Participants suggest, and the Creator sends (#333). Later.
- **API keys with several people driving.** Allowed by the terms, since API keys can be shared (#334). Later.
- **The Sandbox talks to the Hub directly.** No relay on the Runner, but every VM then needs a route to the Hub, and the mod token sits in the Sandbox.

## Consequences

- **The token is readable inside the Sandbox.** Claude runs as root in the VM, so Claude, and anything it runs (the Repo's hooks, plugins and dependencies), can read the Creator's token from its environment. The token lasts a year and can be used anywhere. The Creator is the only one who prompts that Claude, so this is the risk of running your own Claude Code on your own token on a Repo you trust. Runner owners can read it too, as they already could (ADR 0015).
- **A Session whose Creator is gone can't be driven.** It stays readable until it's purged. Fork (#332) is the way to carry it on.
- **Participants can't help drive.** That was the point of pair-prompting. Prompt suggestions (#333) and API-key Sessions (#334) bring some of it back.
- **Back with direct traffic:** fast mode and remote managed settings. Claude Code no longer needs undocumented variables to treat its account as a subscription, so a Claude Code upgrade no longer depends on them. A setup token only makes model requests, so `/status` still shows no usage.

## Amendment: anyone who sees an Archived Session can purge it (ADR 0027)

Purging an Archived Session to free its Runner's disk isn't driving it, so it's the one Session control the Creator doesn't hold alone. Any Member with Repo access can purge it, as soon as it is Archived.
