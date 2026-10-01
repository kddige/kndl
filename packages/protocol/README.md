# @claude-hub/protocol

The messages the Hub, Runners, the mod and the web UI exchange, as [Effect](https://effect.website) Schemas (Effect 4). Terms are those of [`GLOSSARY.md`](../../GLOSSARY.md).

This package defines message shapes only. Transports, servers and what each side does with a message live in the other packages.

## Channels

Every peer talks to the Hub; peers never talk to each other. Each channel has one tagged union per direction, discriminated by `_tag`:

| Channel | Peer to Hub | Hub to peer | Peer authenticates with |
|---|---|---|---|
| Runner ↔ Hub ([`Runner.ts`](src/Runner.ts)) | `RunnerToHub`: hello with its Runner login and re-adopted Sessions, Session started/failed/stopped, Sandbox state, terminal frames | `HubToRunner`: start a Session (new, or waking with `resume`), stop it (`Sleep` or `Archive`), terminal keystrokes, resize, snapshot request | its Runner token |
| mod ↔ Hub ([`Mod.ts`](src/Mod.ts)) | `ModToHub`: hello with Claude Code's session id, Turn events, failed prompt deliveries | `HubToMod`: the next prompt from the Prompt queue, stop the Turn, presence | the Session's mod token |
| web ↔ Hub ([`Web.ts`](src/Web.ts)) | `WebToHub`: create, join and leave Sessions, send and cancel prompts, stop the Turn, open the terminal, keystrokes, resize | `HubToWeb`: Runner and Session lists and updates, history replay then live events, presence, the Prompt queue, terminal frames, refused commands | the sign-in cookie |

Authentication itself is the transport's job (issue #7), so no message carries a token, except `StartSession`, which hands the Runner the Session's mod token to pass to Claude Code.

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
- Literals are PascalCase (`"Active"`, `"Answered"`).
- To add a message, add a `TaggedStruct` to the right union and a sample to the channel's test, which checks that every member round-trips.

## The mod

The mod runs in Claude Code's mod runtime, which may not be able to run Effect: spike #4 will tell. Until then, the mod imports types only and does no runtime validation of its own; the Hub validates everything the mod sends.

```ts
import type { HubToMod, ModToHubEncoded } from "@claude-hub/protocol"
```

`ModToHubEncoded` and `HubToModEncoded` are the JSON shapes on the wire, without brands. For the import to resolve, the mod needs `@claude-hub/protocol` as a workspace dependency and `"allowImportingTsExtensions": true` in its `tsconfig.json`, because this package is imported from source.
