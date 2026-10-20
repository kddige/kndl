---
title: Protocol
description: The Hub's endpoints, who may call each, and the messages the Hub, Runners, browsers and the mod exchange.
sidebar:
  order: 5
---

How the Hub, Runners, browsers, the CLI and each Session's mod talk to each other. Everything goes through the Hub: the others connect to it, never to each other. The messages are [Effect Schemas](https://effect.website/docs/schema/introduction/) in `packages/protocol`, which every package builds against, so a change to a message is a change there.

## At a glance

| Channel | Between | Transport | Credential | Section |
|---|---|---|---|---|
| Web | a browser tab and the Hub | WebSocket `/ws/web` | the sign-in cookie | [Web channel](#web-channel-wsweb) |
| Runner | a Runner and the Hub | WebSocket `/ws/runner` | Runner token | [Runner channel](#runner-channel-wsrunner) |
| Mod | a Session's mod and the Hub, through its Runner's mod relay | HTTP `/mod/*` | mod token | [Mod channel](#mod-channel-mod) |
| Forward | `kndl forward` and the Hub | WebSocket `/ws/forward/<session id>` | CLI token | [Forwards](#forwards) |
| Tunnel | a client and a Session's Open port, through the Hub and the Runner | a WebSocket pair per connection | CLI token or sign-in cookie | [Tunnels](#tunnels) |
| CLI | `kndl login`, `whoami`, `logout`, `runner join` | HTTP `/auth/cli/*`, `/runner/*` | Login code, CLI token or Pairing code | [Signing in the CLI](#signing-in-the-cli), [Pairing](#pairing) |

The web, Runner and forward channels and the mod's hello open with the same [handshake](#handshake). Each channel's section lists its messages by direction, then the rules that aren't obvious from the schemas.

## Endpoints

| Endpoint | Caller | Credential |
|---|---|---|
| `GET /health` | anyone | none. Answers `{"status":"ok"}` once the database does. |
| `GET /auth/github`, `GET /auth/github/callback` | a browser | none: GitHub sign-in. `?return=<path>` comes back to that path on the Hub once signed in, rather than to the web UI's start. The callback lets in only Members, the Owner with the Setup link, and people with an Invite ([People](#people)); anyone else is sent to `/invite-only`. |
| `POST /auth/github/admission` | the web UI's `/setup` and `/invite` pages, from `HUB_PUBLIC_URL`'s origin | none: `{ ticket }`, the Setup link's or Invite's secret, which the Hub keeps in a cookie for the GitHub sign-in that follows, and checks only then. Answers `204`. |
| `POST /auth/dev` | a browser on loopback | none: dev login, only with `KNDL_DEV_LOGIN`. |
| `GET /auth/me`, `POST /auth/sign-out` | a browser | the sign-in cookie |
| `POST /auth/cli/approve` | the `/cli-login` page | the sign-in cookie, from `HUB_PUBLIC_URL`'s origin |
| `POST /auth/cli/token` | `kndl login` | none: the Login code and its PKCE verifier in the body are the credential ([Signing in the CLI](#signing-in-the-cli)). |
| `GET /auth/cli/me`, `POST /auth/cli/sign-out` | `kndl whoami`, `kndl logout` | `Authorization: Bearer <CLI token>` |
| `GET /auth/cli/sessions` | `kndl forward`, to pick a Session ([Forwards](#forwards)) | `Authorization: Bearer <CLI token>` |
| `GET /ws/forward/<session id>` | `kndl forward` ([Forwards](#forwards)) | `Authorization: Bearer <CLI token>` |
| `GET /mcp/<id>/icon` | a browser | the sign-in cookie. An MCP server's icon, the `<id>` URL-encoded; 404 if it has none. |
| `POST /sessions/<session id>/attachments` | a browser, attaching a file to a prompt | the sign-in cookie, from `HUB_PUBLIC_URL`'s origin. The raw file is the body, named in `x-kndl-filename`; it must be an image or a PDF ([ADR 0024](/contributing/decisions/0024-attachments-reach-claude-through-a-mod-tool/)). |
| `GET /sessions/<session id>/attachments/<attachment id>` | a browser | the sign-in cookie. The file, to anyone who can see the Session. |
| `GET /ws/web` | a browser | the sign-in cookie, from `HUB_PUBLIC_URL`'s origin |
| `GET /ws/runner` | a Runner | `Authorization: Bearer <Runner token>` |
| `POST /runner/pair` | `kndl runner join` | none: the [Pairing code](#pairing) in the body is the credential. |
| `GET /runner/connection` | `kndl runner join`, onboard | `Authorization: Bearer <Runner token>` |
| `GET /tunnel/<session id>/<port>` | a client reaching an Open port ([Tunnels](#tunnels)) | `Authorization: Bearer <CLI token>`, or the sign-in cookie from `HUB_PUBLIC_URL`'s origin |
| `GET /runner/tunnel/<tunnel id>` | a Runner, dialing back for a tunnel | `Authorization: Bearer <Runner token>` |
| `POST /mod/hello`, `POST /mod/events`, `GET /mod/commands`, `GET /mod/attachments/<attachment id>`, `GET /mod/providers`, `GET /mod/history` | one Session's mod | `Authorization: Bearer <mod token>` |
| `/gateway/<installation id>`, any method | one Session's agent, to an Installation's MCP server ([MCP servers](#mcp-servers)) | `Authorization: Bearer <mod token>`, put in by the Runner's mod relay |
| `GET /cli`, `GET /cli/version`, `GET /cli/<os>-<arch>` | `curl … \| sh`, the [`kndl` command from a Hub](/reference/commands/#the-kndl-command-from-a-hub) | none: the install script, the Hub's commit, and the binary built from it. |
| anything else | a browser | none: the web UI's build. |

Sandboxes can reach the Hub's address ([ADR 0004](/contributing/decisions/0004-the-sandbox-is-the-security-boundary/)), so every route but sign-in, `/health`, `/runner/pair`, `/auth/cli/token`, `/cli` and the web UI needs a credential. A missing or wrong credential gets `401`; a cookie-authenticated request from another origin gets `403`.

The Hub mints six kinds of token, each `<kind>_<id>.<secret>`, and stores only a SHA-256 of the secret:

| Prefix | Token | Issued |
|---|---|---|
| `chr_` | Runner token | when a Pairing code is redeemed, or by `kndl runner token`; one per Runner |
| `chm_` | mod token | by the Hub for each run of a Session's agent, and kept by its Runner's [mod relay](/concepts/security-model/#the-mod-relay), which relays the mod's calls with it |
| `chs_` | sign-in token | at sign-in, in the `kndl_sign_in` cookie |
| `chc_` | CLI token | by `kndl login`, one per sign-in, named after the machine; it lasts until it is revoked |
| `cho_` | Setup link | by `kndl onboard`, `kndl hub setup-link` or `bun run setup-link`, while the Hub has no Owner; one at a time, used once ([People](#people)) |
| `chi_` | Invite | by the Owner's `CreateInvite`; used once, within 7 days ([People](#people)) |

## Signing in the CLI

`kndl login` ([Sign in the CLI](/guides/sign-in-the-cli/)) gets a CLI token with a Login code, approved by a signed-in person in the browser, and PKCE ([RFC 7636](https://www.rfc-editor.org/rfc/rfc7636), `S256`):

1. The CLI makes a random verifier, and opens the web UI's `/cli-login` page with its SHA-256, the challenge: `/cli-login?machine=<machine>&challenge=<challenge>`, and `&port=<port>&state=<state>` when it waits for the browser on `127.0.0.1:<port>`.
2. The person approves it there. The page sends `POST /auth/cli/approve { machine, challenge }` with the sign-in cookie, and the Hub answers `{ code, expiresAt }`: a Login code of 16 characters of [Crockford's base 32](https://www.crockford.com/base32.html), shown as `ABCD-EFGH-JKMN-PQRS`. Any account may approve.
3. With a `port`, the page sends the browser to `http://127.0.0.1:<port>/callback?code=<code>&state=<state>`. The CLI checks the `state` and the `Host`, and once signed in answers with a redirect to `/cli-login/done?machine=<machine>`. Without a `port`, or when the browser can't reach the CLI, the page shows the code to paste.
4. The CLI sends `POST /auth/cli/token { code, verifier }`, and the Hub answers `{ you, id, machine, createdAt, token }`.

A Login code is held in the Hub's memory for 10 minutes, and spent by its first trade, right or wrong. Only the verifier whose SHA-256 is the challenge it was approved with can trade it. A code that is unknown, expired, already spent, or traded with the wrong verifier gets the same `400`: `That code isn't valid: it may have expired or been used. Run kndl login again.`

The Hub keeps each CLI token's machine, when it was made, and when it was last used, to the minute. `GET /auth/cli/me` answers `{ you, id, machine, createdAt }`, and `POST /auth/cli/sign-out` revokes the token it is sent with, answering `204`. A revoked token, by sign-out or on the Account page, gets `401` from the next request on. CLI tokens act only on the CLI's own endpoints, [forwards](#forwards) and [tunnels](#tunnels), not on the web, Runner or mod channels. No token is logged, only its id and machine.

## Handshake

Each channel opens with a hello carrying the peer's `protocolVersion`, `ProtocolVersion` in `packages/protocol/src/Version.ts` (`5`). The Hub answers with a welcome, or with `HandshakeRejected` and a message naming the side to update, then closes the connection. The peer checks the welcome's version the same way.

`HandshakeRejected` has the same shape in every protocol version: `reason` (`ProtocolVersionMismatch` or `MalformedHandshake`), the rejecting side's `protocolVersion`, `message`, and, when the Hub turns a Runner away, `hubVersion`, the commit the Hub runs. A Runner that updates itself moves to that commit and restarts; one that doesn't logs what to do. Neither exits: it tries again every minute.

Version 5 added Threads, the Plan, compaction, running cost and `Resumed` Turns: see [Threads, the Plan and compaction](#threads-the-plan-and-compaction).

## Pairing

A Pairing code is minted on the web channel (`CreatePairingCode`) by anyone signed in, and shown once, in `PairingCodeCreated`, as a link: the Hub's `HUB_PUBLIC_URL` origin with the code as its fragment, `https://hub.example.com#7K2QD-M9XRT-4VBNC-H8PWE`. The code is 20 characters of Crockford base32 (100 random bits), shown in groups of five; the Hub stores only its SHA-256, and it expires after 15 minutes.

`POST /runner/pair` with `{"code": "…", "name": "build-box"}` redeems it, once:

- `200` with `{"runnerId", "name", "token", "repaired"}`: a new Runner by that name, or, for a code made by **Re-pair**, the same Runner with a new token (`repaired: true`; the name asked for is ignored). Its old token stops working, and a connection made with it is closed with code `4411`.
- `403` with `{"error"}` for any code that can't be used: never made, mistyped, expired, used or revoked all get the same answer.
- `400` for a name that can't be a Runner's (up to 63 letters, digits, dots, dashes and underscores), and `409` for the name of a Runner the Hub already has. Neither uses up the code. A removed Runner's name is free: the new Runner takes the removed one's place, with its Archived Sessions.

`GET /runner/connection` with a Runner token answers `{"runnerId", "name", "online"}`, so `runner join` can tell when its service has connected; a revoked token gets `401`.

Removing a Runner (`RemoveRunner`) revokes its token and closes its connection with code `4410`. The Hub refuses it while the Runner has Sessions that aren't Archived.

## Runner channel: `/ws/runner`

A WebSocket that the Runner opens and keeps open, reconnecting with backoff.

| Direction | Messages |
|---|---|
| Runner to Hub | `RunnerHello`; `SessionStarted`, `SessionStartFailed`, `SessionStopped`, `SessionPurged`; `SandboxStateReport`, `SandboxNote`; `SessionPorts`, `TunnelFailed`; `RunnerSysinfo`; `SessionDisksMeasured`; terminal frames; git requests; `FetchVariables`, `FetchCloneAccess`, `FetchClaudeCredential`; Test build logs and results; `UpdateChecked`, `UpdateProgress`, `UpdateFailed` |
| Hub to Runner | `RunnerWelcome` or `HandshakeRejected`; `StartSession`, `RelaunchSession`, `ModTokenReissued`, `StopSession`, `PurgeSession`, `MeasureSessionDisks`; `OpenTunnel`; terminal input, resizes and snapshot requests; git replies; `RunTestBuild`; `VariablesFetched` or `VariablesRefused`; `ClaudeCredentialFetched` or `ClaudeCredentialRefused`; `CheckUpdate`, `ApplyUpdate` |

A side drops a message it can't decode and carries on.

`RunnerHello` carries the Runner's name, the Sessions it runs, `runsAgent`, true for a Runner that prepared the durable agent's runtime and false for one that couldn't (the Hub starts and wakes no Session on it, and says its bundle isn't ready), and `version`: the commit its checkout is on, the branch, if any ([ADR 0011](/contributing/decisions/0011-runners-follow-the-hubs-commit/)), and `release`, the Release tagged on that commit, if any, such as `2026.10.1` ([ADR 0025](/contributing/decisions/0025-releases-and-channels/)). Every `version`, `target` and `hubVersion` carries `release` the same way. It is optional, and a peer from before it ignores it, so it needed no new protocol version. The Hub starts and wakes no Session on a Runner behind its own commit, and leaves the Sessions it runs alone.

After a restart, a Runner lists in `withoutModToken` the Sessions it kept running: their mod tokens went with the old process. For each one the Hub issues a new mod token, revoking the old, and sends it in `ModTokenReissued { sessionId, modToken }` before marking the Session Active. Until it arrives the Runner's mod relay answers that Session's requests `503` with `retry-after`, which the agent retries. A Runner that loses the message lists the Session again in its next hello.

A Runner has no Claude credential of its own ([ADR 0026](/contributing/decisions/0026-a-session-runs-on-and-is-driven-by-its-creator/)). As each Session starts or wakes, the Runner sends `FetchClaudeCredential` for it. The Hub answers `ClaudeCredentialFetched` with the Creator's setup token, for a Session on that Runner whose Creator has one and is a Member. Otherwise it answers `ClaudeCredentialRefused` with why, and the Runner starts the agent without Claude's Models. The Runner sets the token as `CLAUDE_CODE_OAUTH_TOKEN` on the agent's process alone, and never writes it down.

Every commit in a message, in `version`, `target`, `hubVersion` or an update's failure, is a full lowercase commit id: 40 hex digits, or 64 in a SHA-256 repository. A message carrying anything else, such as a short id or text git would read as an option, doesn't decode. The Runner also puts `--end-of-options` before every commit it passes to git.

### Updates

A Runner says in `RunnerHello` whether it updates itself: `updater` is `{"self": true}` for one installed as the kndl service, or `{"self": false, "reason": "…"}`, and carries `"anyCommit": true` when `RUNNER_UPDATE_ANY_COMMIT=1`. `lastUpdate` is its last update when that failed (`target`, `message`, `rolledBack`, `at`). The Hub asks only a Runner that sends `updater` to update.

| Step | Message | |
|---|---|---|
| 1 | `CheckUpdate { target }` | Hub to Runner: may it move to `target`, the Hub's commit? |
| 2 | `UpdateChecked { target, refusal? }` | Runner to Hub, after fetching from origin. `refusal.reason` is `NotOnMain`, `NotFound` (origin has no such commit), `Manual` (it doesn't update itself) or `Failed` (it couldn't tell). |
| 3 | | The Hub drains the Runner: no Session starts or wakes, running Turns get ten minutes (or are stopped at once), and its Active Sessions are put to sleep with `StopSession`. |
| 4 | `ApplyUpdate { target }` | Hub to Runner, once none is Active. The Runner checks the commit again. |
| 5 | `UpdateProgress { target, step }` | Runner to Hub: `Fetching`, `CheckingOut`, `Installing`, `Restarting`. Then it exits, and its service starts it on the new commit. |
| 5′ | `UpdateFailed { failure }` | Runner to Hub instead, after rolling back without a restart. |

`kndl update` on the Hub's machine leaves the Hub a note of the commit it moved to, in its database, before restarting it; the restarted Hub sends `CheckUpdate` to each Runner the note covers as it says hello, unless the Runner already runs the commit or last failed to update to it. An update that rolls back puts back the note it replaced.

`kndl update` keeps its lock, status and log in the home's `update/` directory. `UpdateStatus.ts` defines their paths and shapes, `UpdateLock` and `UpdateStatus`, with their decoders, for the CLI that writes them and the Hub that reads them ([Files and paths](/reference/files-and-paths/#an-installed-home)).

`StartSession` carries what the Runner needs to start or wake a Session: its Repo, base and Work branches (the same, for a Session working on its branch directly) and Environment, a fresh mod token, and `gitIdentity`, the Creator's name and address for commits in the Sandbox ([Git from Sessions](/concepts/git-from-sessions/#in-the-sandbox)).

`SessionStopped` says why the agent stopped: `Requested`, after a `StopSession`, or `Exited` on its own, with its exit code. For `Exited` it may carry `output`, the last lines the agent's terminal session showed, as plain text of at most 4,000 characters. The Hub redacts it as it does terminal frames and shows it on the Session while it is Asleep.

`SessionPorts { sessionId, ports }` is the Session's whole list of Open ports, sent while it is Active whenever the list changes, and an empty one when the agent stops after it sent any. Each port has `port`, `addresses` (as written: `0.0.0.0`, `::`, `127.0.0.1`, `::1`) and `process` when the Runner could name the process holding it: a runtime with its script (`node vite`), or the program (`docker-proxy` for a port Docker publishes). The Runner sends its lists again after reconnecting. The Hub keeps only the latest list, in memory, drops one for a Session that isn't Active, and redacts process names like terminal frames ([Session lifecycle](/contributing/internals/#open-ports)).

`RunnerSysinfo` is a Runner's host, sampled: `diskFreeBytes` and `diskTotalBytes` of the volume holding its data (`RUNNER_SESSIONS_ROOT`), `memoryTotalBytes` and `memoryAvailableBytes`, `cpuCores`, `loadAverage` (the 1, 5 and 15 minute averages), `os`, `arch` and `uptimeSeconds`. The Runner sends one right after it is welcomed and then every 30 seconds, and does not queue one while disconnected. The Hub keeps each Runner's latest in memory, and lists it as `sysinfo`, with `at`, when the Hub got it, on the Runner in `RunnerList`. It also keeps `diskFreeBytes`, `memoryAvailableBytes` and the 1-minute load in its database as one point per 5 minutes for 7 days, which the browser reads with `GetRunnerHistory { runnerId }` when a Runner's Monitor opens, answered by `RunnerHistory { runnerId, points }`, oldest first. Each point is `{ at, diskFreeBytes, memoryAvailableBytes?, load1? }`: a point kept before the Hub kept memory and load has neither. A Runner from before sends none, and is listed without `sysinfo`.

A Session's disk use isn't sampled: the Hub asks when the archive list wants it. The browser sends `GetSessionDiskUsage { requestId, sessionIds }` (at most 500), and the Hub answers `SessionDiskUsage { requestId, sizes }`, one `{ sessionId, bytes? }` for each Session asked, in the order asked. For the Archived Sessions the person can see, the Hub sends each Runner that says `measuresDisk` in its `RunnerHello` a `MeasureSessionDisks { requestId, sessionIds }`, and the Runner answers `SessionDisksMeasured { requestId, sizes }`. `bytes` is what is allocated on the Runner's disk, as `du` counts it (the blocks a sparse file has, not its length), for the Session's directory with its Workspace and for its microsandbox disk volumes, not the sizes their caps allow. It is absent when it isn't known: the Session isn't Archived or the person can't see it, its Runner is offline, too old to say `measuresDisk`, silent for 30 seconds, or couldn't measure it. The Hub keeps what a Runner says for a minute, and waits on a Session it is already measuring rather than asking again, so several clients opening the list ask the Runner once. A Runner walks one Session's files a few dozen at a time, so measuring a large Workspace doesn't flood its disk.

A Runner that says `asksCloneAccess` in `RunnerHello` asks how to clone a Test build's Repo with `FetchCloneAccess`. The git reply is a `CloneToken`, a read-only installation token for that one Repo that the Runner hands to git for the clone and never stores; `HostCredentials` when the Hub has no GitHub App, to clone with the host's own; or `GitFailed` with why, such as the App not being installed on the Repo, which fails the Test build. A Hub with the GitHub App sends Test builds only to a Runner that says `asksCloneAccess`.

### Models and thinking levels

A Session's Models are its Creator's: `<provider>/<id>` names, such as `openai/gpt-6-sol`, from their Connected providers, and Claude's with a Claude credential. The Hub sends them in `ProvidersState`, to their owner, and in `SessionModels { sessionId, models }` to everyone who joins a Session ([Model and thinking level](#model-and-thinking-level)). A model name without a `/`, such as Claude Code's `sonnet`, is refused: `'sonnet' is Claude Code's name for a model, and Sessions no longer run on Claude Code: pick one of your Models, named <provider>/<id>, such as anthropic/claude-opus-5-5.`

`StartSession` carries the Session's `model` and `thinkingLevel` when they are set, which the Runner gives the agent as `KNDL_MODEL` and `KNDL_THINKING`. Its `resume`, when it wakes a Session, is the `conversationId` the mod's last `ModHello` gave. The agent resumes from its storage either way. A Runner that says `"relaunches": true` in `RunnerHello` also takes `RelaunchSession`, which starts the agent again in the same Sandbox with a fresh mod token; the Hub sends it only to a mod that doesn't say `switchesModels`, which the durable agent does.

## Forwards

`kndl forward` ([Forward a Session's ports](/guides/forward-a-sessions-ports/)) keeps one WebSocket to the Hub for the Session it forwards, at `/ws/forward/<session id>`. It carries no traffic: each connection to a forwarded port is a [tunnel](#tunnels) of its own.

1. The CLI opens it with a CLI token as `Authorization: Bearer`; the sign-in cookie won't do. A request that isn't a WebSocket upgrade gets `426`, and a missing or wrong token `401`, before the upgrade.
2. The Hub checks the caller's access to the Session's Repo, as for a tunnel. A refusal comes after the upgrade, as a close with a code and a message.
3. The CLI sends `ForwardHello { protocolVersion }`. The Hub answers `ForwardWelcome { protocolVersion }`, or `HandshakeRejected` ([Handshake](#handshake)).
4. The Hub wakes an Asleep Session for the caller, then sends `ForwardSession { session }`, the Session as the web channel has it, and another whenever it changes. Its `openPorts` are the ports to forward. A Frozen Session's forward stays open, and is sent the Session again once its Runner is back. The CLI sends nothing more.

While it is connected, a forward is presence: the Hub doesn't put the Session to sleep for being idle, and lists the forward's person in the Session's `PresenceChanged`, to the web UI and the mod, even without the Session open in a browser. `forwardingFrom` on that person lists the machines their forwards come from, each named after its CLI token. Closing the forward takes it out.

The Hub closes a forward with one of these codes, and a message saying why. The CLI reconnects after `1001` or a dropped connection, and stops after the rest.

| Code | Meaning |
|---|---|
| `1001` | The Hub is shutting down. |
| `4401` | The CLI token was revoked, on the **Account** page or by `kndl logout`: `This machine's CLI token was revoked: run kndl login to sign in again.` |
| `4404` | No such Session, or one the caller has no access to: the two get the same answer. Also when the caller loses access to the Session's Repo: `You no longer have access to <repo>.` |
| `4409` | The Session went asleep, the message saying why, such as `Put to sleep by <login>`; or it was Asleep and couldn't be woken, the message saying why not, such as `alice, who started this Session, has no Models to run it on: they can connect a Provider on the Account page.` |
| `4410` | The Session was archived. |
| `4424` | GitHub couldn't say whether the caller has access to the Session's Repo; try again. |

`GET /auth/cli/sessions`, with a CLI token, answers `{ sessions }`: the Sessions that aren't Archived in the Repos the caller has access to, newest first, each as the web channel has it. `kndl forward` picks a Session from it.

## Tunnels

A tunnel carries one TCP connection to an Open port of a Session: from a client, through the Hub and the Session's Runner, to the port in the Session's Sandbox ([ADR 0016](/contributing/decisions/0016-forwarding-a-sessions-ports/)). Each connection is a pair of WebSockets of its own, never the Runner channel, so a large download doesn't hold up terminal frames or Turns.

1. The client opens a WebSocket at `/tunnel/<session id>/<port>`, with a CLI token as `Authorization: Bearer`, or with the sign-in cookie from `HUB_PUBLIC_URL`'s origin. A missing or wrong credential gets `401` and a cookie from another origin `403`, before the upgrade; a request that isn't a WebSocket upgrade gets `426`.
2. The Hub checks the caller's access to the Session's Repo, as for joining the Session ([ADR 0003](/contributing/decisions/0003-sessions-belong-to-the-repo/)), and checks the credential against its database. It does both on every connection, so a revoked CLI token, or access taken away on GitHub, is refused from the next connection on. Someone without access is refused before the Runner is asked anything.
3. The Hub sends the Session's Runner `OpenTunnel { tunnelId, sessionId, port, address }`. `address` is `127.0.0.1` when the port listens on any IPv4 address, `0.0.0.0` included, and `::1` otherwise. Only a Runner that says `"forwardsPorts": true` in `RunnerHello` is sent one.
4. The Runner connects to `address`:`port` from inside the Sandbox, then dials the Hub back at `/runner/tunnel/<tunnel id>` with its Runner token. It connects to `127.0.0.1` or `::1` only, and only in a Sandbox of a Session it runs. When it can't connect it answers `TunnelFailed { tunnelId, message }` instead, such as `Could not connect to port 3000: …`. A tunnel id is claimed once, by the Runner it was sent to: any other dial-back gets `404`.
5. The Hub waits 10 seconds for the dial-back, then pipes the two sockets together.

Every other refusal comes after the upgrade, as a close with a code and a message, so any WebSocket client can read why.

### Framing

The same on both sockets of a tunnel:

- A binary message is the connection's bytes, at most 64 KiB.
- A text message is JSON: `{"_tag":"Ack","bytes":<n>}` once a side has delivered `<n>` bytes it received, and `{"_tag":"Eof"}` when it sends no more, a TCP half-close. It still reads after an `Eof`.
- Neither side has more than 1 MiB sent and not acknowledged. The Hub counts what it passes toward each side, and closes both sockets with `4400` for a side past that, a binary message over 64 KiB, or text that isn't an `Ack` or `Eof`. So the Hub holds at most 1 MiB for each direction of a tunnel, and a slow reader slows its own sender alone.
- The Hub pings tunnel sockets, and closes one only after 120 seconds without a message or an answer to a ping, so an idle connection, such as a quiet WebSocket, stays open.
- When one side closes, the Hub closes the other with the same code: `1000`, `1001` and `1005` as `1000`, `3000` to `4999` as they are, and any other as `4500`.

### Close codes

| Code | Meaning |
|---|---|
| `1000` | The connection ended: the server or the client closed it. |
| `1001` | The Hub or the Runner is shutting down. |
| `4400` | A side broke the framing above. |
| `4404` | No such Session, or one the caller has no access to: the two get the same answer. |
| `4409` | The Session isn't Active: it is Asleep, Archived, or going to sleep. |
| `4410` | Nothing listens on the port in the Session's Sandbox, or the path's port isn't a port. |
| `4424` | GitHub couldn't say whether the caller has access to the Session's Repo; try again. |
| `4426` | The Session's Runner doesn't say `forwardsPorts`. |
| `4429` | The client read too slowly ([below](#on-the-runner)). |
| `4500` | The other side went away without closing, such as the connection into the Sandbox being lost. |
| `4502` | The Runner couldn't connect to the port: the close's message is its `TunnelFailed` message. |
| `4503` | The Session's Runner is offline, or went offline before dialing back. |
| `4504` | The Runner didn't dial back within 10 seconds. |

### On the Runner

The Runner connects into the Sandbox through microsandbox's guest agent, agentd, so it reaches a server bound to loopback with nothing installed in the guest. A Sandbox has at most 128 connections at once.

The Runner reads every connection as fast as the guest's server writes, and keeps what the client hasn't taken yet, past the 1 MiB in flight. It closes a connection with `4429` once it keeps more than 8 MiB for it, `The client read too slowly: the Runner held too much for it.`, or once the client has taken nothing for 30 seconds while bytes wait for it, `The client took nothing for 30 s.` Other connections, and the Session's terminal and Turns, don't wait on it.

## Web channel: `/ws/web`

A WebSocket per browser tab.

| Direction | Messages |
|---|---|
| Browser to Hub | `WebHello`; `CreatePairingCode`, `RevokePairingCode`, `RemoveRunner`, `UpdateRunner`, `GetRunnerHistory`; `CreateSession`; `JoinSession`, `LeaveSession`; `SendPrompt`, `CancelPrompt`, `SteerPrompt`; `MessageAgent`, `StopAgent`; `CreateThread`, `PromptThread`, `StopThread`, `SetThreadModel`, `CompactConversation`; `AnswerQuestion`, `PickAnswer`; `SleepSession`, `WakeSession`, `RestartSession`, `SetKeepAwake`; `ArchiveSession`, `RestoreSession`, `PurgeArchivedSession`, `GetSessionDiskUsage`; `RenameSession`; `SetSessionModel`; `OpenTerminal`, `CloseTerminal`, terminal input; Environment and Variable changes, and Test builds; `CheckAppPermissions`; `CheckHubUpdate`, `UpdateHub`; `CheckRepo`, `ListRepos`, `ListBranches`; `SetClaudeCredential`, `RemoveClaudeCredential`; `RevokeCliToken`; `CreateInvite`, `ListInvites`, `RevokeInvite`, `ListMembers`, `RemoveMember`; `GetMcpServers`, `CreateMcpServer`, `EditMcpServer`, `DeleteMcpServer`, `CreateInstallation`, `EditInstallation`, `DeleteInstallation`, `GetMcpServerLog` |
| Hub to browser | `WebWelcome` (with the Hub's own commit) or `HandshakeRejected`; `RunnerList`, `PairingCodeList`, `PairingCodeCreated`, `PairingCodeRedeemed`, `RunnerRemoved`, `RunnerUpdateRequested`, `RunnerHistory`, `SessionList`, `SessionCreated`, `SessionUpdated`, `SessionRemoved`, `ArchivedSessionPurged`, `SessionDiskUsage`; `SessionHistory`, `SessionEventLogged`, `SessionStartLogged`; `PromptQueueChanged`; `ThreadCreated`, `SessionModels`; `QuestionPicks`; `SessionStateChanged`; `TurnStopRequested`; `SandboxNoted`; `ModelSwitched`; `AppPermissionsChecked`; `HubUpdateChecked`, `HubUpdateStarted`, `HubUpdateRunChanged`; `RepoChecked`, `RepoAccessLost`; `ClaudeCredentialState`; `CliTokenList`; `InviteCreated`, `InviteList`, `MemberList`; `McpServersState`, `McpServerLog`; terminal frames; `CommandFailed` |

Each Session in `SessionList`, `SessionCreated` and `SessionUpdated` carries `agents` when it has subagents that are Running or Interrupted: each one's `id`, `description` and `status` ([Subagents](#subagents)). An Active Session carries `openPorts` while anything listens in its Sandbox: the list from its Runner's last `SessionPorts`.

### Runners, Repos and Sessions

`UpdateRunner { runnerId, now }` updates a Runner from the Runners page; sent again with `now: true` while it waits for Turns, it stops them. Only the Hub's Owner may send it ([ADR 0028](/contributing/decisions/0028-the-owner-updates-the-hub-from-the-web/)); anyone else gets `Only the Hub's Owner can do that.` Each Runner in `RunnerList` carries its `updater` and, while one is under way or after it ended badly, `update`: `Checking`, `Draining` (with `waitingFor`, the Sessions still Active, and `deadline`), `Applying` (with `step`), `Restarting`, `Refused` (with `refusal`) or `Failed` (with `failure`).

Every Session and Environment command is checked against the person's access to its Repo ([ADR 0003](/contributing/decisions/0003-sessions-belong-to-the-repo/), [ADR 0009](/contributing/decisions/0009-environments/)). A refusal is a `CommandFailed` that reads the same whether the Repo exists or not. `CheckRepo` asks about a Repo up front, as it is entered: `RepoChecked` says `Allowed`, `NotInstalled` (the GitHub App isn't installed on it, or there is no such Repo, with the App's install link) or `NoAccess`. `fresh: true` asks GitHub again rather than the Hub's cache. `ListRepos` and `ListBranches { repo }` fill in New Session's combo boxes: `ReposListed` holds the Repos the GitHub App is installed on that the person has access to, kept for a few minutes per person, and `BranchesListed` a Repo's branches and its default branch. Both answer `ListingUnavailable` when the Hub has no GitHub App, and are refused with a `CommandFailed` when GitHub can't answer; `ListBranches` also when the person has no access to the Repo.

`CreateSession.branch` says which branch the Session works on ([ADR 0023](/contributing/decisions/0023-sessions-can-work-directly-on-a-branch/)): `Existing { name, newWorkBranch }` or `Create { name, from }`. The Hub resolves it to the base and Work branches `StartSession` carries, and checks no branch exists; the Runner refuses a `Create` name the Repo already has. Every branch name must be one `git check-ref-format --branch` accepts, at most 255 characters; a `Create` name can't be under `claude/` or equal `from`.

`RepoAccessLost` tells a client that has lost access to a Repo to drop its Environment, as `SessionRemoved` does each of its Sessions.

### Who drives

Everyone with access to a Session's Repo drives it. The Session still runs on its Creator's accounts ([ADR 0026](/contributing/decisions/0026-a-session-runs-on-and-is-driven-by-its-creator/)'s billing half; the spike lifts its driving half, as [the design](https://github.com/kddige/kndl/blob/main/docs/design/durable-harness.md#departures-from-adrs) lists). `driveRefusal` in `packages/protocol/src/SessionRules.ts` is the one place to put the rule back: it never refuses, and `drivingCommands` in the Session relay lists what it would cover:

- `SendPrompt`, `CancelPrompt`, `SteerPrompt`, `StopTurn`, `MessageAgent`, `StopAgent`, `AnswerQuestion` and `PickAnswer`;
- `SleepSession`, `WakeSession`, `SetKeepAwake`, `RestartSession`, `ArchiveSession`, `RestoreSession`, `RenameSession` and `SetSessionModel`;
- `OpenTerminal`, `TerminalInput` and `TerminalResize`;
- `CreateThread`, `PromptThread`, `StopThread`, `SetThreadModel` and `CompactConversation`;
- uploading an Attachment with `POST /sessions/<session id>/attachments`.

`JoinSession`, reading Attachments, Forwards of an Active Session and `PurgeArchivedSession` take Repo access alone, and so does a forward's wake of an Asleep Session ([Forwards](#forwards)). Terminal frames go to every connection that opened the terminal.

A Session whose Creator is no longer a Member, or who has no Models, can't wake. When a Runner is back after the Hub starts, it puts to sleep each Session that is running without either, saying why.

### Purging an Archived Session

`PurgeArchivedSession { requestId, sessionId }` purges an Archived Session now, rather than at the end of its retention, to free its Runner's disk ([ADR 0027](/contributing/decisions/0027-anyone-who-sees-an-archived-session-can-purge-it/)). Anyone with access to its Repo can send it; it isn't driving. The Hub deletes the Session, as the retention sweep does, sends every client that could see it `SessionRemoved`, and answers `ArchivedSessionPurged { requestId, sessionId, runnerOnline }`. It sends the Runner `PurgeSession` now when `runnerOnline`, and otherwise on each connection until the Runner answers `SessionPurged`. A Session that isn't Archived is refused with `Only an Archived Session can be purged: delete it first.`

### Steering

`SteerPrompt { sessionId, promptId }` asks to feed a queued prompt into the running Turn ([ADR 0018](/contributing/decisions/0018-steering-a-prompt-into-the-running-turn/)). Anyone who drives the Session can send it ([Who drives](#who-drives)). The Hub sends the mod `DeliverIntoTurn`, and the prompt keeps its place in the queue until the mod answers. It leaves the queue when the Turn logs `PromptSteered { turnId, promptId, text, sender }`. Once the agent has read it, `SteeredPromptRead { turnId, promptId }` follows. A Turn that ends before that leaves the prompt unread, and the agent reads it with the next prompt. The Hub refuses with a `CommandFailed`:

| Refused | Message |
|---|---|
| No Turn running, or the running one is being stopped | `No Turn is running to steer the prompt into: it goes next.` |
| The prompt is out for delivery as the next Turn | `The prompt was already delivered to the agent.` |
| A prompt that isn't queued | `The prompt is not in the Prompt queue.` |

A Thread has no Prompt queue: a prompt posted into a busy Thread steers it directly, and `ThreadPromptSent` shows it as sent until the agent's `TurnStarted` or `PromptSteered` with the same `promptId`. If the mod can't add the prompt to the Turn, the prompt stays in its place, and the person who steered it gets `The prompt could not join the running Turn, so it waits in the queue: …`. A `CancelPrompt` for a prompt that is being handed over is refused with `The prompt is being handed to the running Turn.`

### Keep awake

`SetKeepAwake { sessionId, on }` turns a Session's Keep awake on or off ([ADR 0016](/contributing/decisions/0016-forwarding-a-sessions-ports/)). Anyone who drives the Session can send it ([Who drives](#who-drives)). Each Session carries `keepAwake: { by, at }` while it is on: the Participant who turned it on, and when. Turned on for an Asleep Session, it wakes it, and a refused wake comes back as a `CommandFailed` with Keep awake left on. `SetKeepAwake` on an Archived Session is refused with `The Session is archived.` `SleepSession` and `ArchiveSession` turn it off.

### Claude credentials

`SetClaudeCredential { secret }` stores the signed-in person's Claude credential, a setup token (`sk-ant-oat…`), after the Hub checks it with Anthropic. One Anthropic rejects, or an API key (`sk-ant-api…`, [#334](https://github.com/kddige/kndl/issues/334)), is refused with a `CommandFailed`. `RemoveClaudeCredential` removes it. Both are answered with `ClaudeCredentialState { credential, warning? }`, which also follows `WebWelcome` and goes to the person's other tabs when it changes, to them alone. `credential` is `null` or `{ kind, last4, addedAt }`, never the secret, and `kind` is always `OAuthToken`. `warning` says it was stored without Anthropic confirming it.

Replacing or removing a credential puts its owner's Active Sessions to sleep, even mid-Turn, and so does `RemoveMember`. Each one's `SessionStateChanged` says why.

### CLI tokens

`CliTokenList { requestId?, tokens }` lists the signed-in person's [CLI tokens](#signing-in-the-cli), newest first, each `{ id, machine, createdAt, lastUsedAt? }`, never the token. It follows `WebWelcome`, and goes to the person's tabs, to them alone, whenever one is made or revoked. `RevokeCliToken { requestId, cliTokenId }` revokes one of their own, and is answered with a `CliTokenList` carrying its `requestId`; any other id gets a `CommandFailed`.

### People

The Hub is invite-only ([ADR 0019](/contributing/decisions/0019-invites-decide-who-gets-in/), [Let people in](/self-hosting/let-people-in/)). `WebWelcome` carries `owner: true` for the Hub's Owner, and only the Owner may send these; anyone else gets a `CommandFailed`, `Only the Hub's Owner can do that.`

- `CreateInvite { requestId, login? }` makes an Invite, for anyone with its link or, with `login`, only that GitHub login, ignoring case. It is answered with `InviteCreated { requestId, id, link, login?, expiresAt }`, the only message that carries the link: the web UI's `/invite` page with the `chi_` token as its fragment.
- `ListInvites { requestId }` and `RevokeInvite { requestId, inviteId }` are answered with `InviteList { requestId?, invites }`: the Invites not yet used, revoked or expired, oldest first, each `{ id, login?, createdBy, createdAt, expiresAt }`, never the link.
- `ListMembers { requestId }` and `RemoveMember { requestId, participantId }` are answered with `MemberList { requestId?, members }`: the Owner first, then by when each was admitted, each `{ participant, owner, admittedAt }`. Removing the Owner is refused with `The Hub's Owner can't be removed.`, and anyone who isn't a Member with `There is no such Member.`
- `InviteList` and `MemberList` go to the Owner's tabs alone, without a `requestId`, whenever an Invite is made, used or revoked, or someone is admitted or removed.

A removed Member's sign-ins and CLI tokens are revoked at once. The Hub closes their web connections with `4401` and their Forwards, and refuses their next request. A Setup link's or Invite's `/setup` or `/invite` page sends `POST /auth/github/admission { ticket }`, then goes to `GET /auth/github`; the callback lets the person in as a Member already, else with the Setup link while there is no Owner, else with an Invite. Anyone else, whatever ticket they brought, is sent to `/invite-only`, with no Participant or sign-in created.

### The Hub's updates

Only a Hub the kndl service runs from its install checks for a newer kndl and updates from the web ([ADR 0028](/contributing/decisions/0028-the-owner-updates-the-hub-from-the-web/)). On one, the Owner's `WebWelcome` carries `hubUpdate`, the last check, and `hubUpdateRun`, the latest update, if there was one. Every message here is the Owner's alone: anyone else's is refused with `Only the Hub's Owner can do that.`, and any on another Hub with `This Hub doesn't check for updates: …`.

- `CheckHubUpdate { requestId }` checks GitHub now. It is answered with `HubUpdateChecked { requestId?, update }`, which also follows every check.
- `UpdateHub { requestId, now, channel? }` runs `kndl update --source hub` on the Hub's machine, with `--now` and `--channel` as asked, outside the Hub's service. It is answered with `HubUpdateStarted { requestId }` once launched. It is refused while an update holds the lock, with `An update is already running (pid …, started …).`, and on a pinned Hub without `channel`.
- `HubUpdateRunChanged { run }` follows each change of the home's `update/status.json`: `run` is `{ status, logTail? }`, the status as `kndl update` writes it, and, once it ended, the end of `update/update.log`. An update the Hub finds `Running` with no process holding the lock is sent as `Failed`.

### MCP servers

MCP servers are remote, and Sessions reach them through the Hub's Gateway ([ADR 0020](/contributing/decisions/0020-plugins-are-remote-mcp-servers-behind-the-hub/), [Add a remote MCP server](/guides/add-a-remote-mcp-server/)). Any Member may send these.

- `GetMcpServers { requestId }` and every change below are answered with `McpServersState { requestId?, mcpServers, installations }`, which also goes, without a `requestId`, to every other tab that asked for MCP servers whenever an MCP server or Installation changes.
  - Each MCP server is `{ id, name, description?, url, auth, iconHash?, package?, createdBy, createdAt }`. `iconHash` says the Hub has an icon for it, which `GET /mcp/<id>/icon` serves; the web puts it in that URL as `?v=<iconHash>`. `auth` is `{ _tag: "None" }`, or `{ _tag: "Headers", headers }` for a server that takes keys in headers: each header secret is `{ key, title, header, template }`, its `template` holding `{value}` exactly once, such as `Bearer {value}`. A packaged MCP server carries `package: { version, commit?, source }`, its `source` `{ _tag: "Git", url, ref?, path? }` or `{ _tag: "Upload", fileName }`.
  - Each Installation is `{ id, mcpServerId, name, global?, repos, otherRepos?, off?, values, createdBy, createdAt }`. `global: true` marks one on in every Repo, existing and new, which lists no `repos`; `off` lists the Repos, of those the person has access to, that turned it off. `repos` lists only the Repos the person has access to; `otherRepos` counts the rest, without naming them. `values` says which header secrets it holds a value for, each `{ key, setBy, setAt }`: never the value.
- `CreateMcpServer { requestId, name, url, auth }` makes a Hub-only MCP server. Its id is `hub:` and the slug of its name, with a number added if that is taken, so it never clashes with a package name. `EditMcpServer { requestId, mcpServerId, name, url, auth }` changes it, and `DeleteMcpServer { requestId, mcpServerId }` deletes it, as it does a packaged MCP server. An edit that moves the URL to another origin (scheme, host or port) clears every Installation's values; one that removes a header secret, or changes its key or header, clears that secret's values.
- `ReadMcpServerPackage { requestId, from }` reads a [MCP server package](/reference/mcp-server-packages/) and changes nothing. `from` is `{ _tag: "Git", url, ref?, path? }`, `{ _tag: "Archive", fileName, data }` with the `.tgz` or `.zip` in base64, or `{ _tag: "Folder", folderName, packageJson, manifest }`. `CheckMcpServerUpgrade { requestId, mcpServerId }` reads a packaged MCP server's git source again, at the ref it was added from. Both are answered with `McpServerPackageRead { requestId, readId, read, upgrades? }`: `read` is the MCP server the package makes, and `upgrades` the id of the MCP server from the same source it would upgrade. The Hub keeps the read for its person for 30 minutes.
- `AddMcpServerPackage { requestId, readId }` adds a read package as an MCP server, its id the package's name. `UpgradeMcpServer { requestId, mcpServerId, readId }` upgrades the MCP server to it, and logs `McpServerUpgraded` in each Repo with an Installation of it. It clears values as an edit does, logging `ValuesCleared`.
- `CreateInstallation { requestId, mcpServerId, name, repos, values?, global? }` turns an MCP server on for the Repos it lists, `EditInstallation { requestId, installationId, name, repos, values?, global? }` renames it, changes its Repos and replaces the values it lists, and `DeleteInstallation { requestId, installationId }` deletes it. Each value is `{ key, value }`, for a header secret of its MCP server; one left out keeps the value it has. Installations make no Environment version.
  - `global: true`, with no `repos`, makes the Installation global, on in every Repo; only the Hub's Owner may send it, or change or delete a global Installation. `EditInstallation` without it makes the Installation Repo-scoped. An MCP server has at most one global Installation. On a Repo with a Repo-scoped Installation of the same MCP server, that one is on instead.
  - `TurnGlobalInstallation { requestId, installationId, repo, on }` turns a global Installation off for one Repo, or back on. Anyone with access to the Repo may. Sessions on the Repo pick up any of these changes on their next wake or Restart.
- `GetMcpServerLog { requestId, repo }` is answered with `McpServerLog { requestId?, repo, entries }`: the Repo's MCP server change log, newest first, each `{ change, by, at, installationId, installationName, mcpServerId, mcpServerName, secrets?, mcpServerVersion? }`. `change` is `Created`, `Added`, `Renamed`, `Removed`, `Deleted`, `McpServerEdited`, `McpServerUpgraded`, `ValuesSet`, `ValuesCleared`, `MadeGlobal`, `MadeRepoScoped`, `TurnedOff` or `TurnedOn`. A change to a global Installation is in every Repo's log, marked `global: true`; `TurnedOff` and `TurnedOn` are in the one Repo's. `McpServerUpgraded` carries the `mcpServerVersion` it upgraded to, such as `1.2.0 (9b41e07)`; the last two carry `secrets`, the titles of the header secrets whose values were set, or cleared by an edit or Upgrade of the MCP server. A `McpServerLog` without a `requestId` goes to every tab with access to the Repo whenever its log grows.

The Hub refuses with a `CommandFailed`:

| Refused | Message |
|---|---|
| A Repo the person has no access to, whether it exists or not | `You have no access to <repo> on GitHub, or the GitHub App isn't installed on it.` |
| Changing or deleting an Installation on in a Repo the person has no access to | `This Installation is on in Repos you have no access to, so you can't change it.` |
| Editing an MCP server with an Installation on in such a Repo | `This MCP server has Installations on Repos you have no access to, so you can't edit it.` |
| A second Installation of an MCP server on a Repo | `<repo> already has <name>, an Installation of <MCP server>: a Repo has at most one Installation of each MCP server.` |
| Deleting an MCP server with Installations | `<MCP server> has an Installation: delete it first.` |
| Anyone but the Owner creating, changing or deleting a global Installation, or making one global | `Only the Hub's Owner can create, edit or delete a global Installation: every Sandbox on the Hub can use it.` |
| Anyone but the Owner editing, upgrading or deleting an MCP server with a global Installation | `<MCP server> has a global Installation, on in every Repo: only the Hub's Owner can edit, upgrade or delete it.` |
| A second global Installation of an MCP server | `<name> is already a global Installation of <MCP server>: an MCP server has at most one global Installation.` |
| A global Installation that lists Repos | `A global Installation is on in every Repo: it lists none.` |
| Turning a Repo-scoped Installation off for a Repo | `<name> isn't global: take the Repo off it instead.` |
| A URL that isn't `https://` or `http://`, or holds a user name, password or `#fragment` | `The URL must start with https:// (or http://).`, or what else is wrong |
| Header secrets that break a rule: a key that isn't letters, digits and underscores starting with a letter, a key or header declared twice, a header the Gateway sets itself, a template without `{value}` exactly once, or more than 10 | `<title>'s template must hold {value} exactly once, as in Bearer {value}.`, or what else is wrong |
| A value for a header secret the MCP server doesn't declare | `<MCP server> has no header secret <key>.` |
| A value under 4 characters, or not one line of plain characters | `The value of <title> is under 4 characters: too short to redact from output.`, or what else is wrong |
| A value while the Hub has no `HUB_SECRETS_KEY` | `` Sensitive values need HUB_SECRETS_KEY in the Hub's configuration: run `bun run secrets-key`, put the key in packages/hub/.env.local, and restart the Hub. `` |
| Editing a packaged MCP server | `<MCP server> is a packaged MCP server, pinned to its version: upgrade it to change it.` |
| A package whose name an MCP server from another source has | `An MCP server named <id> is already on the Hub, from another source: only a package from the same source can upgrade it.` |
| Adding a package an MCP server from the same source has the name of | `An MCP server named <id> is already on the Hub, from this source: upgrade it instead.` |
| A package that isn't valid | Each problem, one per line, such as `kndl.json: mcp.url is missing.` |
| A git URL that isn't `https://`, a ref or folder git could misread, or a fetch past 20 MB or 60 s | What is wrong, such as `The git URL must start with https://.` |
| Checking an uploaded MCP server for an Upgrade | `<MCP server> was uploaded: upload its new version to upgrade it.` |
| A git source whose package now has another name | `The package there is now named <id>, not <id>: add it as an MCP server of its own.` |
| A read past 30 minutes, or someone else's | `That package read has expired; read it again.` |
| Upgrading an MCP server changed since the read | `<MCP server> changed since that read; check for an upgrade again.` |
| Upgrading an MCP server with an Installation on in a Repo the person has no access to | `This MCP server has Installations on Repos you have no access to, so you can't upgrade it.` |

Each Session carries `mcpServers` when it runs with Installations: each `{ id, name, mcpServerId, mcpServerName, mcpServerVersion?, global?, server, values? }`, as its agent last started; `mcpServerVersion` is a packaged MCP server's, `global` marks one that was on as a global Installation, and `values` says which header secret values it started with and when each was set. `server` is the name of its MCP server, a slug of the Installation's name, in the agent's tool names, `mcp__<server>__<tool>`. A Session that isn't Archived carries `mcpServersChanged: true` when its Repo's Installations, or their MCP servers' names, changed since, or their MCP servers were upgraded: a wake or `RestartSession` applies the change.

`StartSession` carries `mcpServers`, each `{ installationId, server }`, to a Runner whose `RunnerHello` says `relaysMcpServers`: never a header secret value, which stays on the Hub. The Runner names them to the agent in `KNDL_MCP_SERVERS`. The agent connects to each at `/gateway/<installation id>` through the mod relay, with the Session token as its bearer, and the relay passes the request to the Hub with the Session's mod token in its place. The tools are deferred: the model finds them with `tool_search`.

The Gateway answers:

| Status | When |
|---|---|
| `401` | No mod token of an Active Session. |
| `403` | An Installation the Session didn't start with, or that is no longer on for its Repo: taken off it, or global and turned off for it or overridden by a Repo-scoped one; the same whether it exists or not. |
| `409` | The Session started without a value for one of the Installation's header secrets, or the value was cleared since: `<installation> needs a value for <title>: enter it on the MCP page, then Restart the Session.` |
| `500` | The Hub can't decrypt the values: `The Hub could not read this Installation's header secret values: check HUB_SECRETS_KEY.` |
| `502` | The MCP server couldn't be reached, or answered with a redirect, which the Gateway doesn't follow. |
| anything else | The MCP server's answer, streamed back as it comes. |

The request goes to the MCP server's URL as it is now, its body streaming on untouched. The Session's token, cookies, `Host`, `Origin`, forwarding and hop-by-hop headers stay at the Gateway, and the server's cookies don't come back. The Gateway adds each header secret as its `header`, its value the `template` with the value the Session started with in place of `{value}`, replacing a header of the same name from the Session, by any case. Each request is logged with its Session, Installation, method, status and time taken, never what it carries.

### Model and thinking level

`CreateSession` takes an optional `model` and `thinkingLevel`, and `SetSessionModel { sessionId, model?, thinkingLevel? }` sets both at once, for anyone who drives the Session. The Hub checks them against the Creator's Models, and without a `model` takes the Creator's default: Claude's first Model when they have Claude's, else their first. It refuses with a `CommandFailed`:

| Refused | Message |
|---|---|
| A Creator without Models | `You have no Models to run a Session on: connect a Provider on the Account page.` |
| A model that isn't one of theirs | `Model '<model>' not found` |
| A thinking level for a model that takes none | `<label> takes no thinking level.` |
| A level the model doesn't have | `<label> has no thinking level '<level>'.` |
| A model named as Claude Code names it, with no `/` | `'<model>' is Claude Code's name for a model, and Sessions no longer run on Claude Code: …` |
| `SetSessionModel` on an Archived Session | `The Session is archived: restore it to change its model.` |

Each Session carries its `model` and `thinkingLevel` when set. Each change is logged as `ModelSwitched { by, model?, modelLabel?, thinkingLevel?, harness? }`, where `modelLabel` is the Model's label among its Creator's. Once no Turn runs, the Hub sends the mod `SwitchModel`, and the agent runs its next request on the new Model with its conversation intact. A `TurnEnded.usage.model` is the model a Turn ran. `harness` and `modelPending` remain on the schemas for Sessions from before the durable agent, which move onto it as they next start.

A Thread has its own model: new `ThreadStarted` events always carry `model`, the Hub resolving the Session's when the web asks for none, and a fork keeps its parent's model rather than following the Session. Older stored events can lack `model`; history replay accepts those unchanged, while `StartThread.model` and `ThreadSummary.model` remain required. `SetThreadModel` switches one ([Threads, the Plan and compaction](#threads-the-plan-and-compaction)).

### Questions

When the agent asks with the question tool on the main loop (`ask_user_question`), the mod reports `QuestionAsked { turnId, toolCallId, questions, async? }`, each question with its `question`, `header`, `options` (`label`, `description?`) and `multiSelect`. Until it closes, the Session carries it as `openQuestion: { turnId, toolCallId, questions, askedAt, async? }`, and it doesn't go to sleep. A Thread or a subagent can't ask.

Anyone in the Session can answer, and the first answer to reach the mod is the one the agent reads. The mod reports `QuestionClosed { turnId, toolCallId, outcome, by? }`. `by` is the Participant who answered. A Stop is `Cancelled`. The Hub closes the question as `Cancelled` itself when its Turn or its agent's process ends with it open.

`AnswerQuestion { sessionId, toolCallId, answer }` answers the Open question, with one of these, and the Hub sends the mod `DeliverAnswer { sessionId, toolCallId, answer, sender }`:

| `answer` | What the agent reads |
|---|---|
| `Answered { answers }` | `answers`, keyed by question text, as lines of text. A multi-select question's labels are joined with `", "`; a label holding `", "` or `"` is written as a JSON string. A question left out was skipped. |
| `Replied { text }` | No answers: `text`, the person's own words, with their name, in place of a pick. What the prompt box sends while a question is open. |
| `Dismissed {}` | Dismissed: the agent is told to stop and wait for the person to say how to proceed (a waited question), or to carry on without (an `async` one). |

An `AnswerQuestion` for a question that isn't the Session's Open question is refused with a `CommandFailed` that says how it closed, such as `Bob Lee answered first: Luxon.` So is an answer that reaches the mod after another: the mod reports `AnswerFailed { toolCallId, senderId, message }`, and the Hub tells the sender.

`PickAnswer { sessionId, toolCallId, question, answer }` shares what someone has picked so far for one question, as an answer would carry it; `""` takes it back. The Hub keeps the Open question's picks in memory and sends them to everyone in the Session as `QuestionPicks { sessionId, toolCallId, picks }`, each pick `{ participant, question, answer }`, and after `SessionHistory` to someone joining. A pick for a question that has closed is dropped.

### Subagents

A Session's subagents are the agent's own, started with its `agent` tool ([ADR 0014](/contributing/decisions/0014-subagents-replace-child-sessions/), amended by the spike). The mod reports them as Events, which the Hub logs and sends in `SessionEventLogged` like the rest:

| Event | What it says |
|---|---|
| `AgentStarted { turnId, agentId, toolCallId, agentType, description, model, background }` | The `agent` call `toolCallId`, in the Turn `turnId` of the main loop or a Thread, started the agent `agentId`. The Hub drops the status of any agent it never saw start. |
| `AgentStatusChanged { agentId, status, worktree? }` | `Running`, `Done`, `Stopped` or `Interrupted`. `worktree` is left from Claude Code's agents; the durable agent starts none. |
| `AgentMessaged { agentId, sender, text }` | A Participant messaged it. Logged by the Hub. |
| `TextDelta`, `ToolCallStarted`, `ToolCallEnded`, `TurnEnded` with `agentId` | The agent's own work. Their `turnId` is the agent's run, new each time it resumes, so the web UI groups them by `agentId`. |

A `TurnStarted` whose `sender` is `FromAgent { agentId }` is the Turn the agent starts when a background agent is done or stopped. Its `text` is a `<task-notification>` about it, in the shape Claude Code's were; the web UI shows its summary and result. An agent's result goes to the conversation that started it, a Thread's included.

The Hub marks a Session's Running agents `Interrupted` when its agent stops: on sleep, a restart, an exit, or a Runner that comes back without it. The agent's restart picks them up where they were, and they report `Running` again. A Frozen Session's agents stay as they were. A background agent outlives its parent's stop; a foreground `wait: true` call stops with it ([the mod's README](https://github.com/kddige/kndl/blob/main/packages/mod/durable/README.md#other-draft-limitations)).

`MessageAgent { sessionId, agentId, text }` messages an agent, and `StopAgent { sessionId, agentId }` stops a running one. The Hub sends the mod `DeliverAgentMessage { sessionId, agentId, text, sender }` or `StopAgent`. A `MessageAgent` to an Asleep Session wakes it first. The Hub refuses with a `CommandFailed`:

| Refused | Message |
|---|---|
| An agent the Session has none of | `The Session has no such agent.` |
| `MessageAgent` to an Archived Session | `The Session is archived: restore it to message agents.` |
| `MessageAgent` to a Frozen Session | `The Session's Runner is offline: message the agent once it is back.` |
| `MessageAgent` while the Session goes to sleep | `The Session is going to sleep: message the agent once it is Asleep.` |
| `StopAgent` for an agent that isn't Running, or a Session that isn't Active | `The agent isn't running.` |

When the mod can't carry out a command, it reports `AgentCommandFailed { agentId, command, senderId?, message }`, and the Hub passes it on as a `CommandFailed` to whoever sent it: `Your message could not be delivered to the agent: …` or `The agent could not be stopped: …`.

## Mod channel: `/mod/*`

Plain HTTP from the Session's durable agent, in its Sandbox: one headless process, `packages/mod/durable`. It sends each call to its Runner's mod relay with the Session token, and the relay passes it to the Hub with the mod token:

- `POST /mod/hello` once at start, answered with `ModWelcome`.
- `POST /mod/events` with the Session's Events as they happen: prompts, tool calls and results, Turn starts and ends, [subagents](#subagents) and [Threads](#threads-the-plan-and-compaction).
- `GET /mod/commands`, a long poll: the Hub answers with commands such as `DeliverPrompt` when it has some, or with none after a while. The mod answers a prompt it can't deliver with `PromptFailed`, and one it already has with `PromptAlreadySubmitted`.
- `GET /mod/attachments/<attachment id>?offset=<n>`: a file attached to a prompt, base64, in parts, for the agent's `attachment` tool ([ADR 0024](/contributing/decisions/0024-attachments-reach-claude-through-a-mod-tool/)). An image comes back as an image; a PDF is saved to a path outside the Workspace, which the tool names.
- `GET /mod/providers`: the Models the agent can use, from the Hub's Gateway.
- `GET /mod/history?before=<seq>&limit=<n>`: the Session's earlier Turns, for the agent's `session_history` tool ([Handoffs](#handoffs)).

| Direction | Messages |
|---|---|
| Mod to Hub | `ModHello`; Turn events (`TurnStarted`, `TextDelta`, `ToolCallStarted`, `ToolCallEnded`, `TurnEnded`, `AgentStarted`, `AgentStatusChanged`, `QuestionAsked`, `QuestionClosed`, `PromptSteered`, `SteeredPromptRead`, `CompactionStarted`, `CompactionEnded`, `PlanChanged`, `UsageChanged`); `PromptFailed`, `ThreadPromptFailed`, `AgentCommandFailed`, `AnswerFailed`, `ModelSwitchFailed` |
| Hub to mod | `ModWelcome` or `HandshakeRejected`; `DeliverPrompt`, `DeliverIntoTurn`, `StopTurn`, `DeliverAgentMessage`, `StopAgent`, `DeliverAnswer`, `PresenceChanged`, `SwitchModel`, `DeliverHandoff`; `StartThread`, `DeliverThreadPrompt`, `StopThread`, `SwitchThreadModel`, `Compact` |

The hello carries no capability flags: every mod of this protocol version is the durable agent, which takes every command. A thread command or `Compact` sent before the Hub has heard the mod's hello is kept, and sent after it. The Hub sends `DeliverIntoTurn { sessionId, promptId, text, sender }` only while a Turn runs, for [steering](#steering). The agent appends the prompt to the running Turn's conversation, with its sender's name. If no Turn is running or the append is refused, it answers `PromptFailed`. It reports `PromptSteered` when the prompt joins the Turn, and `SteeredPromptRead` at the Turn's next step, which is the model request that reads it.

`/mod/events` and `/mod/commands` answer `409` until the mod has said hello.

### Threads, the Plan and compaction

Version 5 adds what the durable agent does beside the main loop. The messages are in `packages/protocol/src/Thread.ts`, and the agent's design is in [the spike's design](https://github.com/kddige/kndl/blob/main/docs/design/durable-harness.md#the-protocol-version-5); this is the shape of it.

- **Threads.** A Thread is a fork of the main loop at one Turn's answer. The web sends `CreateThread` (answered by `ThreadCreated`, with the same `requestId`), then `PromptThread`, `StopThread`, `SetThreadModel` and `CompactConversation`. The Hub mints a `ThreadId`, logs `ThreadStarted`, `ThreadPromptSent` and `ThreadModelChanged` itself, and sends the mod `StartThread`, `DeliverThreadPrompt`, `StopThread`, `SwitchThreadModel` and `Compact`. The Hub sets the `turnId` that was running on a `StopThread` and mints a `requestId` for each `Compact`, because it sends them again after the agent's hello until the agent has polled past them: the agent ignores a stop for a Turn that is no longer running, and keeps the `Compact` request ids it has handled, in storage, so a repeat is acknowledged rather than run again. The agent's Turn events carry the `threadId`, and a Thread's Turns never touch the Session's `currentTurn`. `SessionSummary.threads` lists each Thread with its title, running state and model.
- **A failed Thread prompt.** The agent answers with `ThreadPromptFailed { threadId, promptId, message, threadDropped? }`; a Thread whose first prompt failed is dropped.
- **Delivery.** A prompt's id is its request id, so a prompt delivered twice runs once. A command not yet delivered when the agent restarts is delivered again after its hello.
- **The Plan.** `PlanChanged { threadId?, agentId?, plan }` carries a conversation's whole checklist: `steps` of `{ text, status }` with `pending`, `in_progress` or `done`, and an optional `explanation`.
- **Compaction.** `CompactionStarted` and `CompactionEnded` mark a summary of a conversation's older messages: `reason` is `threshold`, `overflow` or `manual`, and `outcome` is `compacted`, `skipped` or `failed`.
- **Cost.** `UsageChanged { threadId?, agentId?, usage }` is a conversation's running total in tokens and US dollars, sent once a Turn ends.
- **Resumed Turns.** A `TurnStarted` with `sender: Resumed {}` is a run the agent continued after it restarted. The Hub ended the original Turn as `aborted` when the agent stopped.

Web events reach the Hub through a volatile outbox, so a hard kill can lose some: see the [recovery contract](https://github.com/kddige/kndl/blob/main/packages/mod/durable/README.md#recovery-contract).

### Handoffs

A Session from before the durable agent moves onto it as it next starts, and its new mod is handed what Claude Code saw of the Session ([ADR 0030](/contributing/decisions/0030-a-session-switches-harness-with-a-context-handoff/)). No Session switches Harness otherwise.

- **`DeliverHandoff { sessionId, from, text, earlierBefore? }`** is queued once, after the new mod's hello, before the next prompt. `from` is the Harness the Session ran on before, `ClaudeCode`. `text` is the Hub's account of the Turns that Harness hasn't seen, all of them for one new to the Session: each Turn's sender, prompt, tool calls (`<tool>: <input>`) and answer, and the model switches among them, oldest first, clipped, and within 64,000 characters, the newest kept. `earlierBefore` is the `seq` of the earliest Turn it kept, when it left some out. The mod gives it to its agent as context for the next prompt, not as a prompt, and starts no Turn.
- **`GET /mod/history?before=<seq>&limit=<n>`** answers `ModHistory { turns, earlierBefore? }`: the main loop's Turns before `before`, or the latest without it, oldest first, at most `limit`, 20 by default and 50 at most. Each is a `HistoryTurn { seq, by, prompt, tools, answer, model? }`, clipped as the handoff's. `earlierBefore` is there when earlier Turns are left, to pass as the next `before`. The agent serves it to itself as the `session_history` tool.

