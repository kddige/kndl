---
status: accepted
amends: 0029
---

# The agent can ask a question and go on

An Open question held its agent: the tool call waited for the answer, and the Turn ended with the question, cancelled if it was still open. But an agent often can work on while it waits, and the people it asks may not be there for an hour. The question tool should let the agent choose.

So:

- **`ask_user_question` takes `async`.** The agent sets it when it can make progress without the answer. The call returns at once, saying so, and the agent goes on. Left out, the call waits, as before. The tool's description and the parameter's say which it is, and the choice is the agent's.
- **The answer is a message.** When the Creator answers (or replies, or dismisses), the agent is given it in the shape of the waited answer, saying these are the questions it asked earlier. Mid-Turn, it goes in before the Turn's next request, as a steered prompt does (ADR 0018). With no Turn running, it starts a Turn of its own, from whoever answered. Nothing is queued in the Hub: the mod holds the answer until the agent can read it.
- **The question outlives its Turn.** `QuestionAsked` and `OpenQuestion` carry `async`. The Hub doesn't cancel an async question when its Turn ends, only when its agent's process does, or its Session is archived. While one is open the Session doesn't sleep, as with any Open question.
- **One at a time.** The Session has one Open question. While an async one is open the tool refuses another, sync or async, telling the agent to carry on and ask again once the answer comes.
- **Claude Code gets the same tool.** Its AskUserQuestion can't take a flag, so the Runner turns it off (`--disallowedTools AskUserQuestion`) and the hub-link-commands plugin registers `ask_user_question` in its place (`mcp__hub-link-commands__ask_user_question`), with the same questions and `async`. Claude Code's own dialog can't be opened with the tool off (`$.ui.ask` rejects with `no tool named "AskUserQuestion"`, checked against 2.1.296), so a Claude Code question is answered from the web UI alone.

## Considered options

- **A second tool for async.** Keeps the native dialog untouched in Claude Code, but makes the agent pick between two tools that ask the same thing, and pi would need both too.
- **Several async questions at once.** `openQuestion` would become a list through the protocol, the database and the web UI. One at a time covers an agent asking and working on; it can ask again when the answer comes.
- **The Hub holds the answer for the agent.** The Hub can't tell when a Turn is about to read it. The mod can.

## Consequences

- **A late answer can wait.** An answer steered into a Turn that ends before reading it stays in the conversation for the next prompt, as a steered prompt does (ADR 0018).
- **Claude Code loses its terminal dialog for questions.** Someone at its terminal reads the question in the web UI or its terminal mirror, and answers there. A kndl dialog drawn by the plugin could bring it back.
- **A subagent can't ask.** In Claude Code the tool is the plugin's, which subagents see; the plugin refuses them, as pi's extension leaves it out of subagents.
