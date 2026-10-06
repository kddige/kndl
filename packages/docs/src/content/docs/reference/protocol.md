---
title: Protocol
description: The Hub's endpoints, who may call each, and the messages the Hub, Runners, browsers and the mod exchange.
sidebar:
  order: 5
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
| `POST /mod/hello`, `POST /mod/events`, `GET /mod/commands`, `POST /mod/children` | one Session's mod | `Authorization: Bearer <mod token>` |
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
| Runner to Hub | `RunnerHello`; `SessionStarted`, `SessionStartFailed`, `SessionStopped`, `SessionPurged`; `SandboxStateReport`, `SandboxNote`; terminal frames; git requests and `WipPushFailed`; `FetchVariables`, `FetchCloneAccess`, `FetchClaudeCredential`; Test build logs and results; `UpdateChecked`, `UpdateProgress`, `UpdateFailed` |
| Hub to Runner | `RunnerWelcome` or `HandshakeRejected`; `StartSession`, `RelaunchSession`, `StopSession`, `PurgeSession`; terminal input, resizes and snapshot requests; git replies; `SessionTurnEnded`; `RunTestBuild`; `VariablesFetched` or `VariablesRefused`; `ClaudeCredentialFetched` or `ClaudeCredentialRefused`; `CheckUpdate`, `ApplyUpdate` |

`RunnerHello` carries the Runner's name, its Runner login, the Sessions it still runs, and `version`: the commit its checkout is on and the branch, if any ([ADR 0011](/reference/decisions/0011-runners-follow-the-hubs-commit/)). `version` is optional, so a Runner from before it still connects, listed with its version unknown. The Hub compares it with its own commit: it starts and wakes no Session on a Runner behind it, which keeps the Sessions it runs.

`RunnerHello` also says, in `ownClaudeCredential`, whether the Runner has a Claude credential of its own, never the credential. The Hub refuses to create a Session on a Runner without one for a Creator without one either. As each Session starts or wakes, the Runner sends `FetchClaudeCredential` for it; the Hub answers `ClaudeCredentialFetched` with the Session's Creator's credential, or none, only for a Session on that Runner, and `ClaudeCredentialRefused` otherwise ([ADR 0015](/reference/decisions/0015-each-person-brings-their-claude-credential/)).

Every commit in a message, in `version`, `target`, `hubVersion` or an update's failure, is a full commit id in lowercase: 40 hex digits, or 64 in a SHA-256 repository. A message carrying anything else, a short id or text git would read as an option, doesn't decode. A Runner hands the Hub's commit to git, so this keeps a Hub from making it run a command, and the Runner also puts `--end-of-options` before every commit it passes to git.

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

`StartSession` carries what the Runner needs to start or wake a Session: its Repo, Work branch and Environment, a fresh mod token, and `gitIdentity`, the Creator's name and address for commits in the Sandbox ([Git from Sessions](/explanation/git-from-sessions/#in-the-sandbox)). `gitIdentity` is optional, so a Runner still starts Sessions for a Hub from before it, without setting an identity. For a Child Session it also carries `parent`, its Parent Session's `id` and `title`: the Runner tells Claude Code whose child it is, and sets `CLAUDE_HUB_PARENT_SESSION_ID` ([What a Runner gives Claude Code](/reference/configuration/#what-a-runner-gives-claude-code)).

`SessionStopped` says why Claude Code stopped: `Requested`, after a `StopSession`, or `Exited` on its own, with its exit code. For `Exited` it may carry `output`, the last lines Claude Code's terminal showed, as plain text of at most 4,000 characters. `output` is optional, so a Runner from before it still connects. The Hub redacts it as it does terminal frames and shows it on the Session while it is Asleep.

Before it clones a Test build's Repo, the Runner asks how with `FetchCloneAccess`. The git reply is a `CloneToken`, a read-only installation token for that one Repo that the Runner hands to git for the clone and never stores; `HostCredentials` when the Hub has no GitHub App, to clone with the host's own; or `GitFailed` with why, such as the App not being installed on the Repo, which fails the Test build before cloning. A Runner that asks says so with `asksCloneAccess` in `RunnerHello`. A Hub with the GitHub App refuses a Test build on a Runner that doesn't, since it would clone with its host's credentials.

### Models and effort

`RunnerHello` carries `models`, what the Runner's Claude Code takes: `default`, the model it runs when given none; `models`, the other aliases `--model` takes, most capable first; and `efforts`, the effort levels `--effort` takes, lowest first. Each model has its `alias` (`sonnet`), the `id` Claude Code resolves it to now (`claude-sonnet-5-5`), its `label` (`Sonnet 5.5`), a one-line `description`, and `effort`, whether it takes an effort level. Both fields are optional: the Hub runs a Runner's Sessions on Claude Code's defaults only when it doesn't send `models`.

Claude Code has no command that lists its models. The Runner runs `claude -p /model` once without `--model`, for the default and the aliases, then once per alias with `--model`, and `claude -p /effort` for the levels. None of these calls the API or saves a conversation. It does this when it connects, and again after an hour. `-p /model` doesn't print the line Claude Code's own `/model` picker shows for each model, so the Runner keeps those lines in a table by alias (`ModelDescriptions` in `packages/runner/src/ClaudeModels.ts`, copied from Claude Code 2.1.289's picker). An alias missing from the table is still offered, without a line.

`StartSession` carries the Session's `model` and `effort` when they are set, which the Runner passes as `--model` and `--effort`. A Runner that says `"relaunches": true` in `RunnerHello` also takes `RelaunchSession`, which the Hub sends once the setting changed while Claude Code ran and no Turn runs: the Runner stops Claude Code and starts it again with `--resume` and the new flags, in the same Sandbox, with the fresh mod token the message carries. It answers as it does a `StartSession`, with `SessionStarted` or `SessionStartFailed`, and the Hub delivers the next prompt once the new mod has said hello. Restarting between Turns is the one way that is sure to switch: `--model` and `--effort` are fixed for the life of the process, and typing `/model` into a running Claude Code would write the choice to the host's `~/.claude/settings.json`, for every other Session on the Runner. A Runner without `relaunches` gets the setting when the Session next wakes.

## Web channel: `/ws/web`

A WebSocket per browser tab.

| Direction | Messages |
|---|---|
| Browser to Hub | `WebHello`; `CreatePairingCode`, `RevokePairingCode`, `RemoveRunner`, `UpdateRunner`; `CreateSession`; `JoinSession`, `LeaveSession`; `SendPrompt`, `CancelPrompt`; `SleepSession`, `WakeSession`, `RestartSession`; `ArchiveSession`, `RestoreSession`; `RenameSession`; `SetSessionModel`; `OpenTerminal`, `CloseTerminal`, terminal input; Environment and Variable changes, and Test builds; `CheckAppPermissions`; `CheckRepo`; `SetClaudeCredential`, `RemoveClaudeCredential` |
| Hub to browser | `WebWelcome` (with the Hub's own commit) or `HandshakeRejected`; `RunnerList`, `PairingCodeList`, `PairingCodeCreated`, `PairingCodeRedeemed`, `RunnerRemoved`, `RunnerUpdateRequested`, `SessionList`, `SessionCreated`, `SessionUpdated`, `SessionRemoved`; `SessionHistory`, `SessionEventLogged`, `SessionStartLogged`; `PromptQueueChanged`; `SessionStateChanged`; `TurnStopRequested`; `WipNotPushed`; `SandboxNoted`; `ModelSwitched`; `AppPermissionsChecked`; `RepoChecked`, `RepoAccessLost`; `ClaudeCredentialState`; terminal frames; `CommandFailed` |

Each Session in `SessionList`, `SessionCreated` and `SessionUpdated` carries `parentId` when it is a Child Session: its Parent Session's id. No message creates a Child Session from the browser.

### Claude credentials

`SetClaudeCredential { secret, plan? }` stores the signed-in person's Claude credential, a token on a `plan` (`pro`, `max5x`, `max20x`, `team` or `enterprise`) or an API key, after the Hub checks it with Anthropic; one Anthropic rejects is refused with a `CommandFailed`. `RemoveClaudeCredential` removes it. Both are answered with `ClaudeCredentialState { credential, warning? }`, which also follows `WebWelcome` and goes to the person's other tabs when it changes, to them alone. `credential` is `null` or `{ kind, last4, plan?, addedAt }`, never the secret; `warning` says it was stored without Anthropic confirming it. Each Session carries `claudeAccount`, `Creator` or `Runner`: whose credential it runs on ([ADR 0015](/reference/decisions/0015-each-person-brings-their-claude-credential/)).

### Model and effort

Each Runner in `RunnerList` carries the `models` its hello said ([Models and effort](#models-and-effort)). `CreateSession` takes an optional `model` and `effort`, and `SetSessionModel { sessionId, model?, effort? }` sets both at once; an absent one is Claude Code's default, and the `default` alias is stored as no model. The Hub checks them against the Session's Runner and refuses with a `CommandFailed`:

| Refused | Message |
|---|---|
| A model the Runner's Claude Code doesn't have | `Model '<model>' not found`, as Claude Code's `/model` says it |
| An effort level for a model that takes none | `<model> takes no effort level.` |
| A level the Runner's Claude Code doesn't have | `Claude Code on <runner> has no effort level '<level>'.` |
| A model or level on a Runner that sent no `models` | `<runner> hasn't said which models its Claude Code has: only Claude Code's default model can be used there.` |
| `SetSessionModel` on an Archived Session | `The Session is archived: restore it to change its model.` |

Each Session carries its `model` and `effort` when set, and `modelPending: true` while its Claude Code still runs the setting from before a change. Each change is logged as `ModelSwitched { by, model?, modelLabel?, effort? }`, where `modelLabel` is the Runner's name for the model then, such as `Sonnet 5.5`, or for no model the default's. A Turn's `TurnEnded.usage.model` is the model it ran.

### Prompts from other Sessions

A prompt one Session sends another, a Parent Session's message or a Child Session's Report or message ([ADR 0012](/reference/decisions/0012-parent-and-child-sessions/)), goes through the Prompt queue like a person's. Its `QueuedPrompt` carries `fromSession`: `FromParentSession`, `FromChildSession` (a Report) or `FromChildSessionMessage` (a Child Session's `message_parent`), whose `session` is the sending Session's `id` and `title`; its `sender` is the Creator the Sessions run for; and its `text` is what the model reads, a note from the Hub, then a blank line, then the message:

```
[Report from Child Session "API docs" (s-2)]
This is a Report, not a prompt from a person: the final message of a Turn your Child Session just ended. The people in this Session don't see Reports, so relay what matters to them. More Reports may follow while it works.

The reference covers every protocol message now.
```

A Parent Session's message starts `[Message from your Parent Session "<title>" (<id>)]` instead, with no note after it. A Child Session's message starts `[Message from Child Session "<title>" (<id>)]`, and its note says it isn't a Report, that the Report still comes when the child's Turn ends, and that `message_child` answers it. From the 20th Turn in a row a Child Session's Parent Session prompted, with no person's prompt to either Session in between, the Report's note has one more line, asking the parent to check that the work is still making progress. A Child Session's message neither counts toward those Turns nor resets them, and carries the same line while they're at 20 or more. The Turn the prompt starts has the same `fromSession` as its `sender` in `TurnStarted`, and the web UI shows the message without the note.

`UpdateRunner { runnerId, now }` updates a Runner from the Runners page; sent again with `now: true` while it waits for Turns, it stops them. Each Runner in `RunnerList` carries its `updater` and, while one is under way or after it ended badly, `update`: `Checking`, `Draining` (with `waitingFor`, the Sessions still Active, and `deadline`), `Applying` (with `step`), `Restarting`, `Refused` (with `refusal`) or `Failed` (with `failure`).

Every Session and Environment command is checked against the person's access to its Repo ([ADR 0003](/reference/decisions/0003-sessions-belong-to-the-repo/), [ADR 0009](/reference/decisions/0009-environments/)). A refusal is a `CommandFailed` that reads the same whether the Repo exists or not. `CheckRepo` asks about a Repo up front, as it is entered: `RepoChecked` says `Allowed`, `NotInstalled` (the GitHub App isn't installed on it, or there is no such Repo, with the App's install link) or `NoAccess`. `fresh: true` asks GitHub again rather than the Hub's cache. `RepoAccessLost` tells a client that has lost access to a Repo to drop its Environment, as `SessionRemoved` does each of its Sessions.

## Mod channel: `/mod/*`

Plain HTTP from the `hub-link` mod inside each Session's Claude Code:

- `POST /mod/hello` once at start, answered with `ModWelcome`.
- `POST /mod/events` with the Session's Events as they happen: prompts, tool calls and results, Turn starts and ends.
- `GET /mod/commands`, a long poll: the Hub answers with commands such as `DeliverPrompt` when it has some, or with none after a while. The mod answers a prompt it can't deliver with `PromptFailed`. A `DeliverPrompt` with `fromSession` is from another Session: the mod submits its `text` as it is, without the sender's name.
- `POST /mod/children` with a Child Session tool's request, answered `200` with the Hub's reply.

Each route answers `409` until the mod has said hello.

### Child Session tools

A Session's mod registers these tools for Claude, unless the Session is a Child Session, which gets `message_parent` alone. Claude Code names each `mcp__hub-link__<tool>`. The mod sends each call to the Hub as the body of `POST /mod/children`, and gives Claude the reply as text, or as the tool's error for `ChildRefused`.

| Tool | Input | Request | Reply |
|---|---|---|---|
| `create_child` | `task`; optional `name` (its Session name) and `base` (default: the Repo's default branch) | `CreateChild { prompt, name?, baseBranch? }` | `ChildCreated { child }`. The task is queued as the child's first prompt. |
| `message_child` | `child_id`, `message` | `MessageChild { childId, text }` | `ChildMessaged { child }`. Queued as a prompt; wakes the child if it is Asleep. |
| `list_children` | none | `ListChildren` | `ChildList { children }`: the caller's Child Sessions that aren't Archived, oldest first. |
| `read_child` | `child_id` | `ReadChild { childId }` | `ChildRead { child, conversation }`: its recent Turns as text, redacted as its history is, at most 24,000 characters. |
| `archive_child` | `child_id` | `ArchiveChild { childId }` | `ChildArchived { child }` |
| `message_parent` (a Child Session's only tool) | `message` | `MessageParent { text }` | `ParentMessaged { parent, working }`: `parent` is the Parent Session's `id` and `title`, and `working` says a Turn was running there. Queued as a prompt; wakes the parent if it is Asleep. |

Each `child` is a `ChildSummary`: `id`, `title`, `baseBranch`, `workBranch`, `state`, `working` (a Turn is running), `queued` (prompts in its Prompt queue) and, once a Turn has ended, `lastReport` with its `text` and `at`.

Any request can get `ChildRefused { message }` instead: from a Child Session ("A Child Session can't create Child Sessions of its own: Sessions nest one level deep. …"), for a Session that isn't one of the caller's Child Sessions, or for a Creator who can't use the Repo. `MessageParent` is refused from a Session that isn't a Child Session ("This Session isn't a Child Session: it has no Parent Session to message.") and when the Parent Session is Archived or gone. When the Parent Session is Asleep and can't wake, the message stays in its Prompt queue and the reply is a `ChildRefused` that says so. The Hub checks `create_child` against the Parent Session's Creator's access to the Repo.

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
