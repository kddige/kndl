---
title: Protocol
description: The Hub's endpoints, who may call each, and the messages the Hub, Runners, browsers and the mod exchange.
sidebar:
  order: 4
---

Everything goes through the Hub: Runners, browsers and each Session's mod all connect to it, and never to each other. The messages are [Effect Schemas](https://effect.website/docs/schema/introduction/) in `packages/protocol`, which every package builds against.

## Endpoints

| Endpoint | Caller | Credential |
|---|---|---|
| `GET /health` | anyone | none. Answers `{"status":"ok"}` once the database does. |
| `GET /auth/github`, `GET /auth/github/callback` | a browser | none: GitHub sign-in. |
| `POST /auth/dev` | a browser on loopback | none: dev login, only with `CLAUDE_HUB_DEV_LOGIN`. |
| `GET /auth/me`, `POST /auth/sign-out` | a browser | the sign-in cookie |
| `GET /ws/web` | a browser | the sign-in cookie, from `HUB_PUBLIC_URL`'s origin |
| `GET /ws/runner` | a Runner | `Authorization: Bearer <Runner token>` |
| `POST /mod/hello`, `POST /mod/events`, `GET /mod/commands` | one Session's mod | `Authorization: Bearer <mod token>` |
| anything else | a browser | none: the web UI's build. |

Sandboxes can reach the Hub's address ([ADR 0004](/reference/decisions/0004-the-sandbox-is-the-security-boundary/)), so every route but sign-in, `/health` and the web UI needs a credential. A missing or wrong credential gets `401`; a cookie-authenticated request from another origin gets `403`.

The Hub mints three kinds of token, each `<kind>_<id>.<secret>`, and stores only a SHA-256 of the secret:

| Prefix | Token | Issued |
|---|---|---|
| `chr_` | Runner token | by `bun run runner-token`, one per Runner |
| `chm_` | mod token | by the Hub for each run of a Session's Claude Code, and passed to it as `CLAUDE_HUB_MOD_TOKEN` |
| `chs_` | sign-in token | at sign-in, in the `claude_hub_sign_in` cookie |

## Handshake

Each channel opens with a hello carrying the peer's `protocolVersion` (now `1`). The Hub answers with a welcome, or with `HandshakeRejected` and a message naming the side to update, then closes the connection. The welcome is checked the same way, so a mismatch is caught on whichever side is newer.

## Runner channel: `/ws/runner`

A WebSocket that the Runner opens and keeps open, reconnecting with backoff.

| Direction | Messages |
|---|---|
| Runner to Hub | `RunnerHello`; `SessionStarted`, `SessionStartFailed`, `SessionStopped`, `SessionPurged`; `SandboxStateReport`, `SandboxNote`; terminal frames; git requests and `WipPushFailed`; `FetchVariables`; Test build logs and results |
| Hub to Runner | `RunnerWelcome` or `HandshakeRejected`; `StartSession`, `StopSession`, `PurgeSession`; terminal input, resizes and snapshot requests; git replies; `SessionTurnEnded`; `RunTestBuild`; `VariablesFetched` or `VariablesRefused` |

`StartSession` carries what the Runner needs to start or wake a Session: its Repo, Work branch and Environment, and a fresh mod token.

## Web channel: `/ws/web`

A WebSocket per browser tab.

| Direction | Messages |
|---|---|
| Browser to Hub | `WebHello`; `CreateSession`; `JoinSession`, `LeaveSession`; `SendPrompt`, `CancelPrompt`; `SleepSession`, `WakeSession`, `RestartSession`; `ArchiveSession`, `RestoreSession`; `OpenTerminal`, `CloseTerminal`, terminal input; Environment and Variable changes, and Test builds; `CheckAppPermissions` |
| Hub to browser | `WebWelcome` or `HandshakeRejected`; `RunnerList`, `SessionList`, `SessionCreated`, `SessionUpdated`, `SessionRemoved`; `SessionHistory`, `SessionEventLogged`, `SessionStartLogged`; `PromptQueueChanged`; `SessionStateChanged`; `TurnStopRequested`; `WipNotPushed`; `SandboxNoted`; `AppPermissionsChecked`; terminal frames; `CommandFailed` |

## Mod channel: `/mod/*`

Plain HTTP from the `hub-link` mod inside each Session's Claude Code:

- `POST /mod/hello` once at start, answered with `ModWelcome`.
- `POST /mod/events` with the Session's Events as they happen: prompts, tool calls and results, Turn starts and ends.
- `GET /mod/commands`, a long poll: the Hub answers with commands such as `DeliverPrompt` when it has some, or with none after a while. The mod answers a prompt it can't deliver with `PromptFailed`.

## Tool bridge

Claude Code runs on the Runner's host; its tools run in the Sandbox ([ADR 0001](/reference/decisions/0001-claude-on-host-tools-in-sandbox/)). The mod sends each tool call over the Session's Unix socket, `CLAUDE_HUB_TOOLS_SOCKET`, to the Runner, which runs it in the Sandbox through `claude mcp serve` started there. This channel never touches the Hub.
