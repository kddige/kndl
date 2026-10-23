---
status: proposed
---

# Talking with a Session: a live voice drives the Session underneath

A spike. Talking is a good way to drive an agent: say what you want, hear what it did, answer its question, without typing. OpenAI's GPT-Live holds a spoken conversation over WebRTC, and in its _client delegation_ mode it hands every piece of work to the application. A Session's agent is that work. So the voice talks, and the Session does what it is asked, as it does a typed prompt.

- **Any Session its Creator drives.** Talk sits beside Keep awake and Terminal in the Composer, for the Creator alone, since what they say prompts the Session (ADR 0026). A Hearth (ADR 0032) is talked with the same way, and drives the others.
- **The Hub starts it, and then stays out.** The browser makes a WebRTC offer, with its microphone and the `oai-events` data channel, and posts it to `POST /sessions/<id>/voice`. The Hub starts the voice session (`POST /v1/live/sessions`) with the Creator's own Connected provider for OpenAI, a ChatGPT sign-in or an API key, refreshed as the Gateway does, and answers with OpenAI's SDP. The credential never reaches the browser. Audio and events then go between the browser and OpenAI.
- **The voice is told what it is.** Its instructions say it does no work itself and delegates anything to be done, checked or changed. They carry the Session's latest Turns, as `session_history` gives them, so it knows what has happened.
- **The bridge, in the browser.** What the person says arrives as transcript deltas. When GPT-Live delegates, what they said since the last delegation goes to the Session as their prompt, or as their reply to its Open question while it asks one. The bridge follows the Turn that prompt started. While it runs, GPT-Live is told quietly what the agent is doing, every 20 seconds at most (`session.thinking.append`). When it ends, it is given the agent's answer, its text after its last tool call, to say (`session.commentary.append`). A question the agent asks is given to it to ask. Each append is at most about 500 tokens.
- **A live voice setting per Member.** On the Account page, a Member picks the live voice Model they talk with, and its voice. A list of Models kndl knows, each with its Provider, holds GPT-Live 1 alone for now, the default. Another Provider's Model, such as xAI's, joins the list with its own way of starting a session.

## Considered options

- **Responses delegation,** GPT-Live's other mode, with kndl's actions as function tools. A second model would think about the work on OpenAI's side before passing it on, and the browser would run the tools anyway. The Session's agent is already the brain.
- **The Realtime API's GA models** (`/v1/realtime/calls`) in place of GPT-Live. They speak another event protocol, with tools rather than delegation. A second protocol for the same thing, later if wanted.
- **Audio through the Hub.** Every word would pass through the Hub for no gain: only starting the session needs the credential.

## Consequences

- **What is said is a prompt from the Creator.** It shows in the transcript as their prompt, in their words as transcribed, not marked as spoken.
- **ChatGPT sign-ins may not be accepted.** OpenAI documents GPT-Live with an API key. Others report that a ChatGPT sign-in starts browser voice sessions, but this is unconfirmed here. A refusal is shown as OpenAI's reason, and an API key works either way.
- **The Session must be open.** The bridge follows the Session through the web UI's transcript of it, so leaving the Session hangs up.
- **It costs the Creator.** GPT-Live is billed per minute of the call, on their OpenAI account or plan.
