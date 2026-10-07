---
status: accepted
---

# Steering a prompt into the running Turn

A prompt sent while a Turn runs waits in the Prompt queue for that Turn to end. Anyone who may change the queue can now **steer** a queued prompt instead (#195): it leaves the queue and joins the running Turn, the way Claude Code takes a prompt typed while it works. Waiting stays the default.

Claude Code adds a prompt typed while it works to the running Turn at the Turn's next tool result. kndl's prompts don't come from the terminal, though. The mod delivers them with `prompt.submit`, which waits for the Turn to end and then starts a Turn of its own. A spike against Claude Code 2.1.289 (the findings are on #195) tried each way into a running Turn that the plugin API has. Only `session.append` works. A user message appended during a Turn is stored at once as an `isMeta` row, under the `note` door. The model reads it in that Turn's next request, and no new Turn starts.

So a steered prompt is appended:

- **The web asks.** `SteerPrompt { sessionId, promptId }` is sent from the queued prompt's **Steer** button. That button shows only while a Turn runs and nobody has asked to stop it. The Hub sends the mod `DeliverIntoTurn { sessionId, promptId, text, sender }`, and the prompt keeps its place in the queue until the mod answers.
- **The mod appends it.** hub-link-commands appends the prompt to the conversation with its sender's name, as `DeliverPrompt` names the sender. It answers `PromptFailed` if no Turn is running or the append is refused.
- **hub-link reports it.** It sees the appended row as a `session.append` hook event and reports `PromptSteered { turnId, promptId, text, sender }`. The Hub then takes the prompt out of the queue. The Turn's `from` stays whoever started it. At the Turn's next step, the model request that reads the row, hub-link reports `SteeredPromptRead { turnId, promptId }`. The web shows the prompt there, under its sender's name.
- **A failed steer.** The prompt never left its place in the queue, and the Hub sends the person who steered it a `CommandFailed` with the reason. It then waits for the Turn to end, like any other queued prompt.
- **Versions.** A mod that can steer says `steers: true` in its `ModHello`. The Hub refuses a steer to a mod without it with a `CommandFailed`, and the prompt stays queued. An older Hub ignores the field, and an older web never sends `SteerPrompt`. The protocol version doesn't change.

## Considered options

- **Typing it into Claude Code's terminal with tmux `send-keys`.** This would use Claude Code's own queue. But keys can't be told apart from what a person is typing in the Terminal, nothing reports whether they arrived, and nothing ties them back to the queued prompt. The issue rules it out.
- **`prompt.submit` during the Turn.** This is how `DeliverPrompt` works today. It waits for the Turn to end and starts a Turn of its own, so it doesn't steer.
- **`session.send` to the Session itself.** Claude Code refuses this: "main" and the Session's own id both address the sender.

## Consequences

- **A prompt the Turn ends before reading** stays in the conversation unread, and Claude reads it with the next prompt, ahead of that prompt. This is what happens to a row appended to a Turn that is stopped, or that ends while its last answer streams. Claude Code's own queue behaves differently: it would run such a prompt as a Turn of its own. kndl doesn't change Claude Code here. The web shows such a prompt as not read yet, and says Claude reads it with the next prompt.
- **The terminal doesn't show a steered prompt.** Claude Code shows an `isMeta` row only to the model, so it appears in the web UI's transcript and not in the Terminal.
- **Only the main loop.** A subagent's loop can't be steered into. A subagent is messaged instead (ADR 0014).
- **The hand-over lives in the Hub's memory**, like the mod's outbox and a delivered prompt that hasn't started yet. After a Hub restart there are two cases. A steer the mod hadn't fetched is lost, and the prompt waits in the queue as before. A steer the mod had already appended still reports `PromptSteered`, and the prompt leaves the queue then.
- **`claude plugin test` can't answer `session.append`.** The mod's tests cover the paths around it, and the append itself was checked in the spike.
