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
| `POST /runner/pair` | `claude-hub runner join` | none: the [Pairing code](#pairing) in the body is the credential. |
| `GET /runner/connection` | `claude-hub runner join`, onboard | `Authorization: Bearer <Runner token>` |
| `POST /mod/hello`, `POST /mod/events`, `GET /mod/commands` | one Session's mod | `Authorization: Bearer <mod token>` |
| anything else | a browser | none: the web UI's build. |

Sandboxes can reach the Hub's address ([ADR 0004](/reference/decisions/0004-the-sandbox-is-the-security-boundary/)), so every route but sign-in, `/health`, `/runner/pair` and the web UI needs a credential. A missing or wrong credential gets `401`; a cookie-authenticated request from another origin gets `403`.

The Hub mints three kinds of token, each `<kind>_<id>.<secret>`, and stores only a SHA-256 of the secret:

| Prefix | Token | Issued |
|---|---|---|
| `chr_` | Runner token | when a Pairing code is redeemed, or by `claude-hub runner token`; one per Runner |
| `chm_` | mod token | by the Hub for each run of a Session's Claude Code, and passed to it as `CLAUDE_HUB_MOD_TOKEN` |
| `chs_` | sign-in token | at sign-in, in the `claude_hub_sign_in` cookie |

## Handshake

Each channel opens with a hello carrying the peer's `protocolVersion` (now `1`). The Hub answers with a welcome, or with `HandshakeRejected` and a message naming the side to update, then closes the connection. The welcome is checked the same way, so a mismatch is caught on whichever side is newer.

`HandshakeRejected` has the same shape in every protocol version, so any peer can read why it was turned away: `reason` (`ProtocolVersionMismatch` or `MalformedHandshake`), the rejecting side's `protocolVersion`, `message`, and, when the Hub turns a Runner away, `hubVersion`, the commit the Hub runs. A Runner that updates itself moves to that commit and restarts, so a protocol change doesn't strand it; one that doesn't logs what to do. Either way it never exits on a rejection: it tries again every minute.

## Pairing

A Pairing code is minted on the web channel (`CreatePairingCode`) by anyone signed in, and shown once, in `PairingCodeCreated`, as a link: the Hub's `HUB_PUBLIC_URL` origin with the code as its fragment, `https://hub.example.com#7K2QD-M9XRT-4VBNC-H8PWE`. The code is 20 characters of Crockford base32 (100 random bits), shown in groups of five; the Hub stores only its SHA-256, and it expires after 15 minutes.

`POST /runner/pair` with `{"code": "…", "name": "build-box"}` redeems it, once:

- `200` with `{"runnerId", "name", "token", "repaired"}`: a new Runner by that name, or, for a code made by **Re-pair**, the same Runner with a new token (`repaired: true`; the name asked for is ignored). Its old token stops working, and a connection made with it is closed with code `4411`.
- `403` with `{"error"}` for any code that can't be used: never made, mistyped, expired, used or revoked all get the same answer, so a guess learns nothing. 100 bits can't be guessed in 15 minutes, so there's no rate limit to lock others out with.
- `400` for a name that can't be a Runner's (up to 63 letters, digits, dots, dashes and underscores), and `409` for the name of a Runner the Hub already has. Neither uses up the code. A removed Runner's name is free: the new Runner takes the removed one's place, with its Archived Sessions.

`GET /runner/connection` with a Runner token answers `{"runnerId", "name", "online"}`, so `runner join` can tell when its service has connected; a token that no longer works gets `401`.

Removing a Runner (`RemoveRunner`) revokes its token and closes its connection with code `4410`. The Hub refuses it while the Runner has Sessions that aren't Archived.

## Runner channel: `/ws/runner`

A WebSocket that the Runner opens and keeps open, reconnecting with backoff.

| Direction | Messages |
|---|---|
| Runner to Hub | `RunnerHello`; `SessionStarted`, `SessionStartFailed`, `SessionStopped`, `SessionPurged`; `SandboxStateReport`, `SandboxNote`; terminal frames; git requests and `WipPushFailed`; `FetchVariables`, `FetchCloneAccess`; Test build logs and results; `UpdateChecked`, `UpdateProgress`, `UpdateFailed` |
| Hub to Runner | `RunnerWelcome` or `HandshakeRejected`; `StartSession`, `StopSession`, `PurgeSession`; terminal input, resizes and snapshot requests; git replies; `SessionTurnEnded`; `RunTestBuild`; `VariablesFetched` or `VariablesRefused`; `CheckUpdate`, `ApplyUpdate` |

`RunnerHello` carries the Runner's name, its Runner login, the Sessions it still runs, and `version`: the commit its checkout is on and the branch, if any ([ADR 0011](/reference/decisions/0011-runners-follow-the-hubs-commit/)). `version` is optional, so a Runner from before it still connects, listed with its version unknown. The Hub compares it with its own commit: it starts and wakes no Session on a Runner behind it, which keeps the Sessions it runs.

### Updates

A Runner says in `RunnerHello` whether it updates itself: `updater` is `{"self": true}` for one installed as the claude-hub service, or `{"self": false, "reason": "…"}`, and carries `"anyCommit": true` when `RUNNER_UPDATE_ANY_COMMIT=1`. `lastUpdate` is its last update when that failed (`target`, `message`, `rolledBack`, `at`), so a Hub that restarted meanwhile still shows it. Both are optional: the Hub never asks a Runner that doesn't send `updater` to update.

| Step | Message | |
|---|---|---|
| 1 | `CheckUpdate { target }` | Hub to Runner: may it move to `target`, the Hub's commit? |
| 2 | `UpdateChecked { target, refusal? }` | Runner to Hub, after fetching from origin. `refusal.reason` is `NotOnMain`, `NotFound` (origin has no such commit), `Manual` (it doesn't update itself) or `Failed` (it couldn't tell). |
| 3 | | The Hub drains the Runner: no Session starts or wakes, running Turns get ten minutes (or are stopped at once), and its Active Sessions are put to sleep with `StopSession`. |
| 4 | `ApplyUpdate { target }` | Hub to Runner, once none is Active. The Runner checks the commit again. |
| 5 | `UpdateProgress { target, step }` | Runner to Hub: `Fetching`, `CheckingOut`, `Installing`, `Restarting`. Then it exits, and its service starts it on the new commit. |
| 5′ | `UpdateFailed { failure }` | Runner to Hub instead, after rolling back without a restart. |

`claude-hub update` on the Hub's machine leaves the Hub a note of the commit it moved to, in its database, before restarting it; the restarted Hub sends `CheckUpdate` to each Runner the note covers as it says hello, unless the Runner already runs the commit or last failed to update to it.

`StartSession` carries what the Runner needs to start or wake a Session: its Repo, Work branch and Environment, a fresh mod token, and `gitIdentity`, the Creator's name and address for commits in the Sandbox ([Git from Sessions](/explanation/git-from-sessions/#in-the-sandbox)). `gitIdentity` is optional, so a Runner still starts Sessions for a Hub from before it, without setting an identity.

`SessionStopped` says why Claude Code stopped: `Requested`, after a `StopSession`, or `Exited` on its own, with its exit code. For `Exited` it may carry `output`, the last lines Claude Code's terminal showed, as plain text of at most 4,000 characters. `output` is optional, so a Runner from before it still connects. The Hub redacts it as it does terminal frames and shows it on the Session while it is Asleep.

Before it clones a Test build's Repo, the Runner asks how with `FetchCloneAccess`. The git reply is a `CloneToken`, a read-only installation token for that one Repo that the Runner hands to git for the clone and never stores; `HostCredentials` when the Hub has no GitHub App, to clone with the host's own; or `GitFailed` with why, such as the App not being installed on the Repo, which fails the Test build before cloning. A Runner that asks says so with `asksCloneAccess` in `RunnerHello`. A Hub with the GitHub App refuses a Test build on a Runner that doesn't, since it would clone with its host's credentials.

## Web channel: `/ws/web`

A WebSocket per browser tab.

| Direction | Messages |
|---|---|
| Browser to Hub | `WebHello`; `CreatePairingCode`, `RevokePairingCode`, `RemoveRunner`, `UpdateRunner`; `CreateSession`; `JoinSession`, `LeaveSession`; `SendPrompt`, `CancelPrompt`; `SleepSession`, `WakeSession`, `RestartSession`; `ArchiveSession`, `RestoreSession`; `OpenTerminal`, `CloseTerminal`, terminal input; Environment and Variable changes, and Test builds; `CheckAppPermissions`; `CheckRepo` |
| Hub to browser | `WebWelcome` (with the Hub's own commit) or `HandshakeRejected`; `RunnerList`, `PairingCodeList`, `PairingCodeCreated`, `PairingCodeRedeemed`, `RunnerRemoved`, `RunnerUpdateRequested`, `SessionList`, `SessionCreated`, `SessionUpdated`, `SessionRemoved`; `SessionHistory`, `SessionEventLogged`, `SessionStartLogged`; `PromptQueueChanged`; `SessionStateChanged`; `TurnStopRequested`; `WipNotPushed`; `SandboxNoted`; `AppPermissionsChecked`; `RepoChecked`, `RepoAccessLost`; terminal frames; `CommandFailed` |

`UpdateRunner { runnerId, now }` updates a Runner from the Runners page; sent again with `now: true` while it waits for Turns, it stops them. Each Runner in `RunnerList` carries its `updater` and, while one is under way or after it ended badly, `update`: `Checking`, `Draining` (with `waitingFor`, the Sessions still Active, and `deadline`), `Applying` (with `step`), `Restarting`, `Refused` (with `refusal`) or `Failed` (with `failure`).

Every Session and Environment command is checked against the person's access to its Repo ([ADR 0003](/reference/decisions/0003-sessions-belong-to-the-repo/), [ADR 0009](/reference/decisions/0009-environments/)). A refusal is a `CommandFailed` that reads the same whether the Repo exists or not. `CheckRepo` asks about a Repo up front, as it is entered: `RepoChecked` says `Allowed`, `NotInstalled` (the GitHub App isn't installed on it, or there is no such Repo, with the App's install link) or `NoAccess`. `fresh: true` asks GitHub again rather than the Hub's cache. `RepoAccessLost` tells a client that has lost access to a Repo to drop its Environment, as `SessionRemoved` does each of its Sessions.

## Mod channel: `/mod/*`

Plain HTTP from the `hub-link` mod inside each Session's Claude Code:

- `POST /mod/hello` once at start, answered with `ModWelcome`.
- `POST /mod/events` with the Session's Events as they happen: prompts, tool calls and results, Turn starts and ends.
- `GET /mod/commands`, a long poll: the Hub answers with commands such as `DeliverPrompt` when it has some, or with none after a while. The mod answers a prompt it can't deliver with `PromptFailed`.

## Tool bridge

Claude Code runs on the Runner's host; its tools run in the Sandbox ([ADR 0001](/reference/decisions/0001-claude-on-host-tools-in-sandbox/)). The mod sends each tool call over the Session's Unix socket, `CLAUDE_HUB_TOOLS_SOCKET`, to the Runner, which runs it in the Sandbox through `claude mcp serve` started there. This channel never touches the Hub.

A call can outlast one request (Claude Code's fetch gives up after 30 seconds), so the mod starts it under its own `callId` and then waits for it in steps:

| Request | Answer |
|---|---|
| `POST /tools/calls?waitMs=<ms>` with `{"callId", "tool", "input"}` | Starts the call, then waits up to `waitMs` (at most 20000) for it to end. Starting a `callId` the bridge already knows starts nothing and waits for that call, so the mod can send it again after a failed request. |
| `GET /tools/calls/<callId>?waitMs=<ms>` | Waits up to `waitMs` for the call to end. |
| `DELETE /tools/calls/<callId>` | Cancels the call: the bridge sends the tool server `notifications/cancelled`, and it kills the command. Answers the result if the call had already ended. |
| `POST /tools/call` with `{"tool", "input"}` | The one request mods used before these, kept so a mod loaded before its Runner was updated still works. It waits for the call to end, so a call over 30 seconds still fails for that mod. |

Each answers one of:

| Reply | Status | Meaning |
|---|---|---|
| `ToolRan` | 200 | It ran; `result` is the tool's own output. |
| `ToolFailed` | 200 | It ran and reported an error, such as a command that exited non-zero. |
| `ToolRunning` | 202 | Still running: ask again with `GET`. |
| `ToolLost` | 200, or 404 for a `callId` the bridge doesn't know | It was sent to the Sandbox but has no result and never will: cancelled, or the tool server or Sandbox stopped. It may have run, wholly or in part. `POST /tools/call` answers this as `ToolFailed`, saying it may have run. |
| `BridgeUnavailable` | 503 | The Sandbox or its tool server is down, so the call didn't run. |

`callId` is 1 to 128 letters, digits, `_`, `.` and `-`; the mod makes it from Claude Code's tool use id. The bridge cancels a call that nothing has asked about for 30 seconds, and every running call when the Sandbox stops. A Runner from before these answers `404` to `POST /tools/calls`, and the mod then falls back to `POST /tools/call`.

The mod refuses the tool call whenever it doesn't get `ToolRan` or `ToolFailed`, so a tool never runs on the host. It says the call did not run only on `BridgeUnavailable`, or when it never reached the bridge; otherwise it says the call may have run.
