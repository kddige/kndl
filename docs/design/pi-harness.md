# pi as kndl's Harness: the design

How ADR 0029 is built. The contracts are code: `packages/protocol/src/Provider.ts`, `Harness` in `Model.ts`, `SwitchModel` and `switchesModels` in `Mod.ts`, `harness`/`harnesses` on `StartSession`, `RunnerHello`, `RunnerSummary`, `SessionSummary` and `CreateSession`, and the Hub's `ModelCatalog` service. Read those before this.

Pinned versions: pi and pi-ai **1.3.0** (`@earendil-works/pi-coding-agent`, `@earendil-works/pi-ai`), everywhere they're used: the Hub, the Runner's pi bundle, the mod's pi extension. The Claude Code binary stays the one kndl pins (`PinnedClaudeVersion`).

## The pieces

```
web ──ProviderCommand──▶ Hub ──OAuth / API keys──▶ Providers (OpenAI, xAI, GitHub Copilot, …)
                          │  keeps Connected providers, refreshes tokens, lists Models
                          │
Sandbox: pi (TUI in tmux) + kndl extension (/opt/kndl/mod/<copy>/pi/kndl.js)
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
  - It calls `pi.registerProvider("<provider>", { baseUrl, apiKey, headers, models })` for the built-in provider, keeping pi's own provider name, so pi-ai's per-Provider behaviour still applies. pi-ai keys that behaviour on the provider's name, or on the name or the address, never the address alone, except `isChatGPTSignIn`, below.
  - Each Model's `baseUrl` is `${KNDL_URL}${modelGatewayPath(provider)}` plus the path of its own catalogue address: OpenAI's `https://api.openai.com/v1` becomes `…/gateway/models/openai/v1`. A Provider's Models can be at different paths of one origin: OpenRouter's Claude is at `/api`, for Anthropic's Messages API, and the rest at `/api/v1`. The provider's own `baseUrl` is its first Model's.
  - The key is the Session token (`KNDL_MOD_TOKEN`), which pi puts where its client for the Model's API does: `Authorization: Bearer` for OpenAI's APIs and Mistral's, `x-api-key` for Anthropic's Messages API (GitHub Copilot's aside, which takes a bearer), `x-goog-api-key` for Google's. The headers also carry `Authorization: Bearer <Session token>`, always, because the relay accepts only that.
  - `models` is the built-in catalogue filtered to the ids `/mod/providers` lists, with their own headers, such as Copilot's integration headers.
  - ChatGPT's sign-in refuses some request fields an API key's take, which pi-ai leaves out only for a request it sees going to `https://api.openai.com/v1` directly. `/mod/providers` says which Providers are signed in (`signedIn`), and the extension turns those fields off in OpenAI's models' `compat` when OpenAI is. pi-ai sends other sign-ins' requests as it sends their keys'.
- **The relay** already relays `/gateway/*`, swapping the Session token for the mod token.
- **The Hub Gateway** routes `/gateway/models/<provider>/<rest>`:
  - **Authentication:** the mod token, as the MCP Gateway does. That gives the Session, and from it the Creator.
  - **Refusals,** each in the Provider's error shape (`{"error":{"message":…}}`):
    - a Session that isn't pi's: 403. A Claude Code Session's Sandbox spends no Connected provider;
    - a Provider the Creator hasn't connected: 403;
    - a path or method its APIs' clients don't call: 403. Only inference and listing Models are allowed, as pi-ai 1.3.0's clients call them (`modelCallAllowed` in `PiProviders.ts`), so a Sandbox can't use the Creator's key for files, batches or fine-tuning;
    - a 9th call at once from one Session: 429. Over 256 MiB of request bodies held across the Hub: 503. A request over 32 MiB: 413.
  - **What the credential sends:** an API key is itself the key. A sign-in's is what pi-ai's `toAuth(credential)` says: a key (most), headers of its own (Kimi's `Authorization: Bearer`), and maybe another address for the Provider's API (GitHub Copilot's, for each account: `https://api.business.githubcopilot.com` for a Business seat).
  - **Upstream:** the origin of the Provider's API, the sign-in's address when `toAuth` names one, else pi-ai's for the Provider, plus `/<rest>` plus the query, built with `new URL` and checked to stay on that origin. Dot segments, encoded slashes and dots, backslashes and anything not starting with one `/` are refused. A GitHub Copilot sign-in's address must be HTTPS on `githubcopilot.com` or its own Enterprise domain, which must be `<name>.ghe.com`.
  - **Headers:** `authorization`, `x-api-key` and `x-goog-api-key` are dropped. The Creator's key goes in the one pi sent the Session token in as its key: `x-goog-api-key`, else `x-api-key`, else `Authorization: Bearer`. A sign-in's own headers are set over them.
  - **Body:** a sign-in's request is buffered, so it can be sent again once after a refresh when the Provider answers 401; an API key's streams through. The response streams back as it comes, with neither the Hub's idle timeout nor fetch's own cutting a quiet stream, and the call is logged when its stream ends.
- **Refresh:** a sign-in's token is refreshed before a call when it expires within 5 minutes, and after a 401 only if it wasn't refreshed in the last minute, so a Sandbox can't hammer the Provider's token endpoint. Refreshes are serialized per credential; the rotated credential is stored only if the connection is still the one refreshed (`connected_at`), so a reconnect meanwhile wins. Every call, and listing Models, goes through `ConnectedProviders.call`.
- **Claude's Models** can be turned off on a Hub with `HUB_CLAUDE_MODELS=off`: the Hub lists none, so no pi Session runs the Claude bridge.

## Connected providers

- **The Providers:** every pi-ai provider whose requests pi sends with a key the Gateway can swap, to an API at a fixed address, listed in `ProviderIds` in the Account page's order. `PiProviders.ts` on the Hub has what kndl adds to each.

  | Provider (pi-ai's id) | Signs in with | API key | Its API | Models listed at |
  | --- | --- | --- | --- | --- |
  | OpenAI (`openai`) | ChatGPT | yes | OpenAI Responses | `/v1/models` |
  | xAI (`xai`) | SuperGrok or X Premium | yes | OpenAI Responses | `/v1/models` |
  | GitHub Copilot (`github-copilot`) | GitHub Copilot | no | OpenAI Responses and Chat Completions, Anthropic Messages, all with a bearer | `/models` at the account's address |
  | OpenRouter (`openrouter`) | OpenRouter (gets a key) | yes | OpenAI Chat Completions, Anthropic Messages | `/api/v1/models` |
  | Google (`google`) | | Gemini API key | Google Generative AI | `/v1beta/models` |
  | Mistral (`mistral`) | | yes | Mistral Conversations | `/v1/models` |
  | DeepSeek, Groq, Cerebras | | yes | OpenAI Chat Completions | `{base}/models` |
  | Kimi For Coding (`kimi-coding`) | Kimi Code | yes | OpenAI Chat Completions | `/coding/v1/models` |
  | Moonshot AI, Z.AI (coding plan), Together, Fireworks, Hugging Face, NVIDIA, Baseten, Qwen Token Plan (and Individual), Xiaomi (and its Token Plans AMS and SGP), Ant Ling | | yes | OpenAI Chat Completions (Fireworks' also Anthropic Messages) | `{base}/models` |
  | MiniMax (`minimax`), Vercel AI Gateway (`vercel-ai-gateway`) | | yes | Anthropic Messages | `/v1/models` |
  | Meta (`meta`) | Meta (Muse) | yes | OpenAI Responses | `/v1/models` |
  | OpenCode Zen (`opencode`), OpenCode Go (`opencode-go`) | | yes | OpenAI's, Anthropic's and Google's, by Model | `/inference(/go)/v1/models` |
  | Moonshot AI CN, Z.AI Coding CN, MiniMax CN, Qwen Token Plan CN, Xiaomi Token Plan CN | | yes | as their global ones | as their global ones |

- **Not connected:** `anthropic`, whose Models run through Claude Code on the Claude credential (ADR 0026, 0029), and whose API keys stay deferred (#334); Amazon Bedrock and Google Vertex AI, which need cloud credentials and request signing; Azure and Cloudflare's AI Gateway and Workers AI, whose address is per account or resource, which the Gateway doesn't hold; Radius, pi's own gateway, whose catalogue comes per account from the service; TypeSafe, which has no chat Models; and `openai-codex`, pi-ai's legacy ChatGPT sign-in, which OpenAI's sign-in is.
- **Sign-ins:** pi-ai's, `provider.auth.oauth.login(interaction, { getDeviceId })`, run on the Hub.
  - ChatGPT's and OpenRouter's listen on `127.0.0.1` on the Hub's machine and also take the final redirect URL pasted. The Member's browser can't reach the Hub's loopback, so in practice they paste it, and the web says so.
  - xAI's, GitHub Copilot's, Kimi's and Meta's are device-code flows. Copilot's asks first which GitHub, as a domain, blank for github.com: the Hub asks it as a choice, GitHub.com or GitHub Enterprise, then the domain for Enterprise.
  - `getDeviceId` is one UUID per Hub, kept in the database.
  - A refresh is refused, rather than unavailable, when pi-ai's error says the token endpoint answered 400, 401 or 403, or to sign in again.
- **Storage:** one row per Member and Provider. The credential is pi-ai's `Credential` JSON, sealed like a Claude credential, with whatever else the sign-in keeps (Copilot's Enterprise domain). The row also holds the label (the account from the sign-in, or an API key's last 4 characters) and the Models last found, when, and any problem.
- **Models:** the Hub asks the Provider under the account, with the credential as the Gateway sends it, and keeps the ones pi-ai's built-in catalogue knows: newest first when the Provider says when each was made, else the most capable first, as near as the catalogue's output cost says, then the highest id.
  - OpenAI with a sign-in answers `GET /v1/models` with `{models:[{slug, display_name, visibility, context_window, supported_reasoning_levels:[{effort}]}]}`. Only `visibility: "list"` ones are kept, in its order.
  - Most answer OpenAI's way, `{data:[{id, created}]}`, or the list alone (Together).
  - Google answers `{models:[{name: "models/<id>", displayName, inputTokenLimit, supportedGenerationMethods}]}`, with the key in `x-goog-api-key`. Those that generate content are kept. A 400 that says the API key is wrong is a rejection, as 401 and 403 are.
  - GitHub Copilot answers at the account's address, with its integration headers (from pi-ai's catalogue) and `X-GitHub-Api-Version`, `{data:[{id, model_picker_enabled, policy:{state}, capabilities}]}`. As pi-ai's sign-in reads it, those the picker offers whose policy isn't disabled, and that call tools, are kept; with none, those whose policy is enabled.
  - A Provider that doesn't list them, or can't now, keeps those it listed before, or, with none, offers every one of pi-ai's catalogue for it, and its `modelsProblem` says which. An API key is refused only when the Provider rejects it.
  - Thinking levels are the Provider's `supported_reasoning_levels` that are kndl `ThinkingLevel`s, else pi-ai's `getSupportedThinkingLevels(model)`. A Model that doesn't reason has none.
  - The Hub asks on connect, when a Member asks (`RefreshProviderModels`), and when its copy is a day old.
- **The Account page:** each Connected provider first, a card each with the account, its Models and when they were checked. Then the rest, a line each, under "Subscriptions" (those with a sign-in) and "API keys", the first six and "Show more". A line opens in place for its sign-in's steps or the key's field, which is named as pi-ai names the key (`Gemini API key`).
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

- **Packaging:** TypeScript, bundled by `bun run mod:build` into `packages/mod/pi/dist/kndl.js` (one ESM file for Node, with Effect, the protocol and the Claude bridge's dependencies inside). The Runner copies it with the mod, so it's at `/opt/kndl/mod/<copy>/pi/kndl.js` in the Sandbox, given to pi with `-e`. It reuses `HubLink` and `HubMessages` from `packages/mod/src`.
- **At load:**
  - `GET /mod/providers`, then register the Gateway providers.
  - For Claude's Models, the Claude bridge provider (`anthropic`), when the credential is there.
  - Register the Session's MCP servers, which the Runner names in `KNDL_MCP_SERVERS` (Installation ids and server names, nothing secret), as `kndl-<server>` at `${KNDL_URL}/gateway/<installationId>`. Their `Authorization` header is `Bearer ${KNDL_MOD_TOKEN}`, which pi fills in from its environment as it connects, so the token is never written down.
  - Add the Repo's `.claude/skills` to pi's skills (`resources_discover`), beside `.pi/skills` and `.agents/skills`.
  - Say hello: `conversationId` is pi's session id, `model` is `<provider>/<id>`, and the flags are `steers`, `attaches` and `switchesModels`.
- **Events** (as hub-link reports them for Claude Code):
  - `TurnStarted` and `TurnEnded`, the latter with pi-ai's stop reason, the Turn's usage summed with its cost, and, for an error, the Provider's reason (`errorMessage`, one line, at most 500 characters, with tokens and key-shaped strings redacted).
  - `TextDelta`, and `ToolCallStarted`/`ToolCallEnded`.
  - Subagents' and questions' events.
- **Commands:**
  - `DeliverPrompt`: a user message with the sender's name and the attachment markers, as hub-link words it.
  - `DeliverIntoTurn`: a steer. `StopTurn`: abort.
  - `SwitchModel`: `setModel` and `setThinkingLevel`. A model it doesn't have, as one of a Provider connected after pi started, makes it ask `/mod/providers` again and register the Gateway providers again, once. Only Models that go through kndl (the Gateway's or the Claude bridge's) are taken: never pi's built-in ones, which would call a Provider directly. One it still can't run is reported as `ModelSwitchFailed`, and the Hub puts the Session's model back, with a note in its history.
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
