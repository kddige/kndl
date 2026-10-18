# pi as kndl's Harness: the design

How ADR 0029 is built. The contracts are code: `packages/protocol/src/Provider.ts`, `Harness` in `Model.ts`, `SwitchModel` and `switchesModels` in `Mod.ts`, `harness`/`harnesses` on `StartSession`, `RunnerHello`, `RunnerSummary`, `SessionSummary` and `CreateSession`, and the Hub's `ModelCatalog` service. Read those before this.

Pinned versions: pi and pi-ai **1.3.0** (`@earendil-works/pi-coding-agent`, `@earendil-works/pi-ai`), everywhere they're used: the Hub, the Runner's pi bundle, the mod's pi extension. The Claude Code binary stays the one kndl pins (`PinnedClaudeVersion`).

## The pieces

```
web ──ProviderCommand──▶ Hub ──OAuth / API keys──▶ Providers (OpenAI, xAI)
                          │  keeps Connected providers, refreshes tokens, lists Models
                          │
Sandbox: pi (TUI in tmux) + kndl extension (/opt/kndl/mod/pi/kndl.js)
   │  /mod/*                  hello, Turn events, commands (as hub-link does)
   │  /mod/providers          the Creator's Models, at start
   │  /gateway/models/<p>/…   a Provider's own API, with the Session token as its key
   ▼
Runner relay ──(Session token → mod token)──▶ Hub Gateway ──(Creator's credential)──▶ Provider
   │
   └─ Claude Models: Claude Code as a model only, in the Sandbox, on the Claude credential
```

## The Gateway forwards, it doesn't translate

ADR 0029 said the `kndl` provider would send pi-ai's context to the Hub, which would call pi-ai. The forwarding design below keeps the same properties: it's lossless, there's no per-Provider translation, and the credentials stay on the Hub. It's also less code, and pi's own message conversion, caching and usage accounting stay native. ADR 0029 has an amendment saying so.

- **In the Sandbox,** the kndl extension re-points each of the Creator's Connected providers at the Gateway:
  - It calls `pi.registerProvider("<provider>", { baseUrl, apiKey, headers, models })` for the built-in provider, keeping pi's own provider name, so pi-ai's per-Provider behaviour still applies.
  - `baseUrl` is `${KNDL_URL}${modelGatewayPath(provider)}`.
  - The key is the Session token (`KNDL_MOD_TOKEN`), and the headers carry `Authorization: Bearer <Session token>`, because the relay accepts only that.
  - `models` is the built-in catalogue filtered to the ids `/mod/providers` lists.
- **The relay** already relays `/gateway/*`, swapping the Session token for the mod token.
- **The Hub Gateway** routes `/gateway/models/<provider>/<rest>`:
  - **Authentication:** the mod token, as the MCP Gateway does. That gives the Session, and from it the Creator.
  - **Refusal:** a Provider the Creator hasn't connected gets a 403 with a clear message in the Provider's error shape (`{"error":{"message":…}}`).
  - **Upstream:** the URL is the built-in pi-ai provider's `baseUrl` (OpenAI `https://api.openai.com/v1`, xAI `https://api.x.ai/v1`) plus `/<rest>` plus the query.
  - **Headers:** `authorization`, `x-api-key` and `x-goog-api-key` are dropped, and `Authorization: Bearer <access token or API key>` is added. Both OpenAI and xAI take a bearer.
  - **Body:** the request body is buffered, since requests are small JSON, so the request can be retried once after a refresh when the Provider answers 401. The response streams back as it comes.
- **Refresh:** a sign-in's token is refreshed before a call when it expires within 5 minutes, and once after a 401. Refreshes are serialized per credential, and the rotated credential is stored.

## Connected providers

- **Providers in this version:** OpenAI ("Sign in with ChatGPT", or an API key) and xAI ("Sign in with SuperGrok or X Premium", or an API key). Both sign-ins are pi-ai's: `provider.auth.oauth.login(interaction, { getDeviceId })`.
  - The ChatGPT flow listens on `127.0.0.1:1455` on the Hub's machine and also takes the final redirect URL pasted. The Member's browser can't reach the Hub's loopback, so in practice they paste it, and the web says so.
  - xAI is a device-code flow.
  - `getDeviceId` is one UUID per Hub, kept in the database.
- **Storage:** one row per Member and Provider. The credential is pi-ai's `Credential` JSON, sealed like a Claude credential. The row also holds the label (the account from the sign-in, or an API key's last 4 characters) and the Models last found, when, and any problem.
- **Models:** the Hub asks the Provider under the account, keeps the ones pi-ai's built-in catalogue knows, and orders them as the catalogue does.
  - OpenAI with a sign-in answers `GET /v1/models` with `{models:[{slug, display_name, visibility, context_window, supported_reasoning_levels:[{effort}]}]}`. Only `visibility: "list"` ones are kept.
  - With an API key it answers `{data:[{id}]}`, and xAI the same.
  - Thinking levels are the Provider's `supported_reasoning_levels` that are kndl `ThinkingLevel`s, else pi-ai's `getSupportedThinkingLevels(model)`. A Model that doesn't reason has none.
  - The Hub asks on connect, when a Member asks (`RefreshProviderModels`), and when its copy is a day old.
- **Claude's Models**, in `ProvidersState.models` and `/mod/providers`, appear when the Member has a Claude credential. They come from `GET https://api.anthropic.com/v1/models` under the setup token (with the OAuth beta header, as `ClaudeCredentials` checks it), kept to the pi-ai `anthropic` catalogue. If that call fails, the catalogue's current models are used.

## Sessions and the Harness

- **Which Harness:** `CreateSession.harness` absent means pi when the Runner's hello lists `"Pi"` in `harnesses`, else Claude Code. This is issue 5: new Sessions are pi. The web has no picker, and only `?harness=claude-code` in the URL forces Claude Code. The Session keeps its Harness for life.
- **Models:** a pi Session's model is `<provider>/<id>` (`providerModelName`), checked against `ModelCatalog.modelsFor(creator)`. A Claude Code Session's model is checked against the Runner's models, as before.
  - A new pi Session without a model gets the first of the Creator's Models, Claude's first when they have a Claude credential.
  - A Creator with no Models can't start a pi Session. The refusal says to connect a Provider on the Account page.
- **Switching:** when a pi Session's model changes, the Hub sends `SwitchModel` once no Turn runs, to a mod that `switchesModels`. Claude Code Sessions relaunch as before.
- **The Claude credential:** a pi Session's Runner still fetches it. A refusal doesn't fail the start: Claude's Models just aren't available in that Session.

## The Runner

- **The bundle:** a pinned Node.js (pi needs 22.19 or newer: glibc builds from nodejs.org, and musl ones from unofficial-builds) and a pinned pi install. pi's install comes from a committed `package.json` and `bun.lock`, installed with `bun install --frozen-lockfile --ignore-scripts`.
  - Both are cached on the host and mounted read-only at `/opt/kndl/pi`.
  - A Runner whose bundle is ready says `harnesses: ["ClaudeCode", "Pi"]`.
- **Starting pi:** the Runner runs pi's TUI in tmux, like Claude Code, with the kndl extension: `node …/pi-coding-agent/dist/cli.js --approve -e /opt/kndl/mod/pi/kndl.js --session-id <conversationId> --model <provider>/<id> [--thinking <level>]`.
  - `--approve` makes the Repo's `.pi/` load.
  - pi's state lives in `PI_CODING_AGENT_DIR=/var/lib/kndl/claude/pi`, on the Session's `claude` volume, so it survives sleep.
  - `PI_OFFLINE=1` skips pi's startup network calls. pi's own telemetry is off.
- **pi's environment:** `KNDL_URL`, `KNDL_MOD_TOKEN`, `KNDL_SESSION_ID`, `KNDL_CONVERSATION_ID` (as the mod's), and `KNDL_HARNESS=Pi`. When the Creator has a Claude credential, also `CLAUDE_CODE_OAUTH_TOKEN`, `IS_SANDBOX=1`, `CLAUDE_CONFIG_DIR` and `KNDL_CLAUDE_CODE` (the guest path of the pinned `claude`), for the Claude bridge.
- **Resuming:** `--session-id` creates the conversation or resumes it. A new pi Session's conversation id is a UUID the Runner picks, as for Claude Code.

## The pi extension (`packages/mod/pi/`)

- **Packaging:** TypeScript, bundled by `bun run mod:build` into `packages/mod/pi/dist/kndl.js` (one ESM file for Node, with Effect, the protocol and the Claude bridge's dependencies inside). The Runner copies it with the mod, so it's at `/opt/kndl/mod/pi/kndl.js` in the Sandbox. It reuses `HubLink` and `HubMessages` from `packages/mod/src`.
- **At load:**
  - `GET /mod/providers`, then register the Gateway providers.
  - For Claude's Models, the Claude bridge provider (`anthropic`), when the credential is there.
  - Say hello: `conversationId` is pi's session id, `model` is `<provider>/<id>`, and the flags are `steers`, `attaches` and `switchesModels`.
- **Events** (as hub-link reports them for Claude Code):
  - `TurnStarted` and `TurnEnded`, the latter with pi-ai's stop reason and the Turn's usage summed with its cost.
  - `TextDelta`, and `ToolCallStarted`/`ToolCallEnded`.
  - Subagents' and questions' events.
- **Commands:**
  - `DeliverPrompt`: a user message with the sender's name and the attachment markers, as hub-link words it.
  - `DeliverIntoTurn`: a steer. `StopTurn`: abort. `SwitchModel`: `setModel` and `setThinkingLevel`.
  - `DeliverAgentMessage`, `StopAgent` and `DeliverAnswer`: the subagent and question tools.
  - `PresenceChanged`: a widget line.
- **Tools:**
  - `attachment(id)` returns the image or PDF (ADR 0024).
  - `ask_user_question` has the Question schema, and becomes an Open question.
  - `agent` starts a subagent: a child pi `AgentSession` in-process, on any of the Creator's Models, the parent's by default.
- **The Claude bridge:** our own provider for `anthropic`, ported from `pi-claude-bridge` 0.9.3 (MIT, credited), in `pi/src/claude/`.
  - It runs the pinned Claude Code through the Agent SDK with `tools: []` and serves pi's tools over in-process MCP.
  - It registers only when pi has `CLAUDE_CODE_OAUTH_TOKEN` and `KNDL_CLAUDE_CODE`, and only the Claude Models `/mod/providers` lists, from pi-ai's `anthropic` catalogue, at a price of 0.
  - Claude Code runs in the Workspace with `bypassPermissions`, `--strict-mcp-config` and no settings files, so a Repo's Claude Code hooks and plugins don't run. Its sessions, pi's history mirrored for `resume`, live in `CLAUDE_CONFIG_DIR`. `ANTHROPIC_*` and the mod's variables are kept out of its environment.
  - The plan can't be read from a setup token, so it takes Pro: Opus 4.6 and Sonnet 4.6 run at 200K context, the other measured Models at 1M.
  - It never changes a message once pi has it: the spike's bug. A turn's end hands pi a copy of its message, and an abort with no turn open ends no message.
