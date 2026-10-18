# @kndl/protocol

The messages the Hub, Runners, the mod and the web UI exchange, as [Effect](https://effect.website) Schemas (Effect 4). Terms are those of [`GLOSSARY.md`](../../GLOSSARY.md).

This package defines message shapes only. Transports, servers and what each side does with a message live in the other packages.

## Channels

Every peer talks to the Hub; peers never talk to each other. The Runner and web channels are WebSockets; the mod's is plain HTTP (see [The mod](#the-mod)). Each channel has one tagged union per direction, discriminated by `_tag`:

| Channel | Peer to Hub | Hub to peer | Peer authenticates with |
|---|---|---|---|
| Runner ↔ Hub ([`Runner.ts`](src/Runner.ts)) | `RunnerToHub`: hello with its own Claude credential, if any, and re-adopted Sessions, Session started/failed/stopped, Sandbox state, terminal frames | `HubToRunner`: start a Session (new, or waking with `resume`), stop it (`Sleep` or `Archive`), terminal keystrokes, resize, snapshot request | its Runner token |
| mod ↔ Hub ([`Mod.ts`](src/Mod.ts)) | `ModToHub`: hello with its Harness's conversation id, Turn events, failed prompt deliveries | `HubToMod`: the next prompt from the Prompt queue, stop the Turn, presence | the Session's mod token |
| web ↔ Hub ([`Web.ts`](src/Web.ts)) | `WebToHub`: create, join and leave Sessions, send and cancel prompts, stop the Turn, put a Session to sleep or wake it, open the terminal, keystrokes, resize | `HubToWeb`: Runner and Session lists and updates, history replay then live events, presence, the Prompt queue, terminal frames, refused commands | the sign-in cookie |

Authentication itself is the transport's job (issue #7), so no message carries a token, except `StartSession`, which hands the Runner the Session's mod token to pass to Claude Code. Tokens go in `Authorization: Bearer`; the web UI uses its sign-in cookie.

### Turn events and the Session event log

The mod reports each Turn as `TurnEvent`s ([`Turn.ts`](src/Turn.ts)): `TurnStarted` (prompt text and sender), `TextDelta`, `ToolCallStarted` and `ToolCallEnded` (tool name, input and output clipped to `MaxToolSummaryLength`), and `TurnEnded` (reason and token usage). Events from a subagent carry its `agentId`.

The Hub appends them, along with what it sees itself (`SessionStateChanged`, `TurnStopRequested`), to the Session's event log as `SessionLogEntry`s numbered by `EventSeq`. A web client that joins gets `SessionHistory`, then each new entry as `SessionEventLogged`; on reconnect it asks for entries after the last `seq` it has.

Presence, the Prompt queue and the Runner and Session lists are sent in full whenever they change, not as deltas.

## Handshake and versioning

`ProtocolVersion` is the version this build speaks. A peer's first message is its hello (`RunnerHello`, `ModHello`, `WebHello`), carrying `protocolVersion`; the Hub answers with a welcome or `HandshakeRejected` and closes.

Check the first message with `checkHandshake(message)` before decoding it in full: it reads only `protocolVersion`, whatever else a different version put in the hello, and returns the `HandshakeRejected` to send, with a message that says which side to update. Peers check the Hub's welcome the same way. Hellos and welcomes only decode at the current version, and `HandshakeRejected` keeps the same shape in every version.

Bump `ProtocolVersion` on any change an older peer would fail to decode or misread.

## Conventions

- Every schema has a type of the same name: `typeof X.Type`.
- Ids are branded (`SessionId`, `RunnerId`, `ParticipantId`, `TurnId`, `PromptId`, ...): plain strings on the wire, distinct types once decoded.
- Literals are PascalCase (`"Active"`, `"Asleep"`), except pi-ai's, which keep pi-ai's spelling (`"stop"`, `"xhigh"`).
- To add a message, add a `TaggedStruct` to the right union and a sample to the channel's test, which checks that every member round-trips.

## The mod

The mod runs in Claude Code's mod runtime, which can `fetch` with request headers but has no WebSockets and no streaming. So the mod's channel is three HTTP endpoints, each carrying the Session's mod token as `Authorization: Bearer`:

| Request | Body or query | Answer |
|---|---|---|
| `POST /mod/hello` | `ModHello` | `ModHelloReply`: 200 with `ModWelcome`, or 400 with `HandshakeRejected`. 403 if the token is for another Session. |
| `POST /mod/events` | `ModEvents`: `{ messages }`, a batch of Turn events and `PromptFailed`, oldest first | 204 |
| `GET /mod/commands?after=<seq>&waitMs=<ms>` | `ModCommandsQuery` | `ModCommands`: `{ messages: [{ seq, message }] }`, the Session's commands (`DeliverPrompt`, `StopTurn`, `PresenceChanged`) numbered above `after` |

`GET /mod/commands` is a long poll: the Hub answers as soon as it has a command numbered above `after`, or with an empty list after `waitMs` (capped at `MaxCommandWaitMs`, 25 s). Commands are numbered 1, 2, ... per Session (`ModCommandSeq`) and stay queued until the mod polls with a later `after`, so the mod passes the seq of the last command it handled and a failed poll neither loses a command nor runs one twice.

`POST /mod/events` and `GET /mod/commands` answer 409 when the Hub hasn't heard this Session's hello since it started. The mod then says hello again and polls from `after=0`, since a restarted Hub numbers commands from 1 again.

The mod may not be able to run Effect: spike #4 will tell. Until then, the mod imports types only and does no runtime validation of its own; the Hub validates everything the mod sends.

```ts
import type { ModCommandsEncoded, ModEventsEncoded, ModToHubEncoded } from "@kndl/protocol"
```

The `...Encoded` types (`ModToHubEncoded`, `HubToModEncoded`, `ModEventsEncoded`, `ModHelloReplyEncoded`, `ModCommandsEncoded`, `ModCommandsQueryEncoded`) are the JSON shapes on the wire, without brands. For the import to resolve, the mod needs `@kndl/protocol` as a workspace dependency and `"allowImportingTsExtensions": true` in its `tsconfig.json`, because this package is imported from source.
