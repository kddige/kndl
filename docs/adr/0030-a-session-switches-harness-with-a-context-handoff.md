---
status: accepted
amends: 0029
---

# A Session switches Harness with a context handoff

ADR 0029 fixed a Session's Harness for life, so Claude's Models through Claude Code and every other Model through pi couldn't meet in one Session. People want to pick, at any time, any Model they have, Claude's through Claude Code or through pi included. T3 Code shows a way that holds up: a switch to another backend starts or resumes that backend's own session, and hands it what it hasn't seen of the conversation, as text, within a budget, rather than translating one backend's transcript into another's.

So:

- **The picker lists every Model a Session can run, grouped by what runs it.** That means "Anthropic · Claude Code" (the Runner's Claude Code models, on the Creator's setup token), "Anthropic · pi" (Claude's Models through the Claude bridge), and each Connected provider's. A model name says its Harness (`harnessOfModel`): a Provider's Model, `provider/id`, is pi's, and anything else is Claude Code's.
- **Within a Harness, a switch is as before:** Claude Code relaunches, and pi switches in place.
- **A switch to the other Harness** happens between Turns:
  - The Runner stops one Harness and starts the other in the same Sandbox (`RelaunchSession.harness`). It resumes that Harness's own conversation when the Session ran on it before, or starts a new one when it didn't.
  - The Hub keeps each Harness's conversation id, and how far into the Session's history it has seen.
- **The handoff.** Before the next prompt, the mod is sent a `DeliverHandoff`: the Turns that Harness hasn't seen, or all of them for a Harness new to the Session. It's built by the Hub from the Session's history, as prompts, the tools called and the answers, oldest first, kept within a budget. The agent reads it as context for that prompt. Reasoning, tool state and Attachments don't carry over. The agent can read further back with a tool (`GET /mod/history`).
- **The Account page's Anthropic card** says which Harness runs Claude's Models in a new Session (`SetClaudeHarness`). Claude Code is the default, as Claude's subscription is spent most plainly there (ADR 0026). The picker can still choose the other.

## Considered options

- **Harness fixed per Session (ADR 0029).** Simplest, but the Creator can't move a conversation between Claude Code and any other Provider.
- **Translating transcripts between Claude Code's and pi's formats.** Faithful, but each Harness's format is its own and changes with its releases. Rejected in the grilling for ADR 0029, and T3 Code doesn't do it either.
- **A summary written by the model.** Costs a call and can lose what matters. The Hub's own history is already there to hand over.

## Consequences

- **A handoff is lossy.** The other Harness sees what was said and done, not how, and can read more on request.
- **The Sandbox runs either Harness.** Both are mounted already. A switch costs a relaunch of the agent, not of the Sandbox.
- **A Session's Harness can change.** `SessionSummary.harness` is what runs it now.
