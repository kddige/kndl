# pi as kndl's Harness: the design

How ADR 0029 is built, and ADR 0030, which switches a Session between pi and Claude Code. The contracts are code: `packages/protocol/src/Provider.ts`, `Harness` and `harnessOfModel` in `Model.ts`, `SwitchModel`, `switchesModels`, `ModelSwitchFailed`, `DeliverHandoff` and `ModHistory` in `Mod.ts` (`takesHandoffs` is deprecated: every protocol-4 mod takes handoffs, and the Hub no longer reads it), `harness`/`harnesses` on `StartSession`, `RelaunchSession`, `RunnerHello`, `RunnerSummary`, `SessionSummary`, `CreateSession` and `ModelSwitched`, and the Hub's `ModelCatalog` service. Read those before this.

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
  - **Upstream:** the origin of the Provider's API, the sign-in's address when `toAuth` names one, else pi-ai's for the Provider, plus `/<rest>` plus the query, built with `new URL` and checked to stay on that origin. Dot segments, encoded slashes and dots, backslashes and anything not starting with one `/` are refused. A GitHub Copilot sign-in's address, wherever pi-ai's sign-in found it (a GitHub Enterprise's own domain among them), must be HTTPS.
  - **Headers:** `authorization`, `x-api-key` and `x-goog-api-key` are dropped. The Creator's key goes in the one pi sent the Session token in as its key: `x-goog-api-key`, else `x-api-key`, else `Authorization: Bearer`. A sign-in's own headers are set over them.
  - **Body:** a sign-in's request is buffered, so it can be sent again once after a refresh when the Provider answers 401; an API key's streams through. A connection that can't take the call now (not connected, or to connect again) refuses it before its body is read. The response streams back as it comes, with neither the Hub's idle timeout nor fetch's own cutting a quiet stream, and the call is logged when its stream ends. A redirect isn't followed: it is answered 502, as the MCP Gateway's are.
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

- **A model names its Harness** (`harnessOfModel`, ADR 0030): a `<provider>/<id>` name (`providerModelName`) is pi's, and anything else is Claude Code's: an alias such as `opus`, or no model, which is Claude Code's default. A pi Session always names its model. `SessionSummary.harness` is what runs the Session now; one that says none runs Claude Code.
- **Which Harness a new Session gets** (`newSessionHarness` in `SessionRelay.ts`):
  - With a `model`, the model's. A `harness` that disagrees is refused: `<model> runs on pi, not Claude Code.`
  - Without one, the `harness` asked for, else Claude Code on a Runner whose hello doesn't list `"Pi"` in `harnesses`. pi asked for there is refused: `<runner> doesn't run pi: update it, or start a Claude Code Session there.`
  - Without either, on a Runner that runs pi: Claude Code when the Creator's default Model (`defaultProviderModel`: Claude's first) is Claude's and their `claudeHarness` is `ClaudeCode`; else pi, on that Model.
- **Models:** a pi Session's model is checked against `ModelCatalog.modelsFor(creator)`, and a Claude Code Session's against the Runner's models, as before.
  - A new pi Session without a model gets the first of the Creator's Models, Claude's first when they have a Claude credential.
  - A Creator with no Models can't start a pi Session. The refusal says to connect a Provider on the Account page.
- **Switching within a Harness:** when a pi Session's model changes to another of pi's, the Hub sends `SwitchModel` once no Turn runs, to a mod that `switchesModels`. A Claude Code Session relaunches as before. A model of the other Harness switches the Session's Harness: below.
- **The Claude credential:** a pi Session's Runner still fetches it. A refusal doesn't fail the start: Claude's Models just aren't available in that Session.

## Switching Harness (ADR 0030)

A Session moves between pi and Claude Code when its Creator picks a model of the other Harness. Each Harness keeps its own conversation, and is handed, as text, the Turns it hasn't seen. Nothing translates one Harness's transcript into the other's.

- **The picker** (`ModelPicker.tsx`) is one list, in a Session and in New Session, grouped by what runs each model (`providerGroupLabel`):
  - **Anthropic · Claude Code:** **Default · <label>**, then the Runner's Claude Code models. Offered where the Runner runs Claude Code and the Creator has a Claude credential, and always in a Session on Claude Code, or a New Session where pi isn't offered.
  - **Anthropic · pi:** Claude's Models through the Claude bridge, `anthropic/<id>`.
  - **Each other Provider's**, by its name, in the order of the Creator's Models. pi's groups are offered where the Runner runs pi (every candidate Runner, in New Session).
  - Picking the other Harness's model asks first, **Switch to pi?** or **Switch to Claude Code?**, with `Switching to <Harness> continues in its own conversation, with a handoff of this one. The next prompt waits until it's up.`, and `It interrupts the running agent.` while agents run. A switch within pi doesn't ask; one within Claude Code asks only while agents run, as before.
- **What the Hub keeps:**
  - `session_conversations (session_id, harness, conversation_id, seen_seq)`: each Harness's conversation, from its mod's last hello, and `seen_seq`, the last entry of the Session's log it ran through or was handed, null for none.
  - `sessions.harness`, the Harness it runs now, and `sessions.handoff_from`, the one it switched from, until the new one has been handed what it hasn't seen.
  - `participants.claude_harness`: which Harness runs Claude's Models in the Member's new Sessions, null for Claude Code.
- **The sequence:**
  1. **`SetSessionModel`.** The Hub checks the model with the Harness it names (`check`), and, for the other Harness, that the Runner runs it (`switchRefusal`: every Runner runs Claude Code, and pi one whose hello since the Hub started said so) and that the Creator has what it runs on (`whyNotRunnable`). It stores the setting, `modelPending` while the Session runs, and logs `ModelSwitched` with `harness`, the Harness it moves to.
  2. **Settling** (`settleHarness`), as the Session is relaunched or woken on the new Harness: the old Harness is recorded as having seen the log up to its last entry, unless it was still to be handed what it hadn't, and `harness` and `handoff_from` are set. An Asleep Session settles at once, and wakes on the new Harness.
  3. **`RelaunchSession`**, once no Turn runs (`deliverNext`), with `harness`, `resume` when the new Harness has a conversation, a fresh mod token, the model and thinking level, and the same MCP servers. The outbox is cleared, as the old mod's commands are stale.
  4. **The Runner** (`relaunch` in `Sessions.ts`) stops the running Harness, and readies the same Sandbox for the other as its start would (`Sandboxes.readyFor`): Claude Code's state seeded, and for pi, Node.js working and pi's state directory made. A Sandbox kept across a Runner restart from before pi's mount is refused: `the Sandbox could not be readied for pi: its Sandbox was made before pi, so it runs pi once it sleeps and wakes`. It launches the Harness on the conversation named, or a new UUID, and answers as a start does: `SessionStarted`, or `SessionStartFailed`, which puts the Session to sleep with `<Harness> could not start on <runner>: …`.
  5. **The new mod's hello.** The Hub records its conversation under the Harness, then hands off (`handOff`): it reads the log after that Harness's `seen_seq` (all of it, for a Harness new to the Session) and queues `DeliverHandoff { sessionId, from, text, earlierBefore? }`, then the next prompt. Once the mod polls past it, the Hub clears `handoff_from` and moves `seen_seq` to the last entry it covered; one its outbox dropped first (a relaunch, the Harness gone, a Hub restart) is handed again at the next hello.
- **Switching back** resumes that Harness's own conversation, and hands it only what happened after its `seen_seq`.
- **The handoff** (`buildHandoff` in the Hub's `Handoff.ts`) is built from the Session's log alone, oldest first:
  - Each main-loop Turn: `## Turn <seq>, <yyyy-mm-dd hh:mm> UTC: <who> prompted`; the prompt, with a steered prompt as `<name> added, while it ran: …` and Attachments as `(N attachments, not carried over)`; `Tools called:`, each `- <tool>: <input>`; `Answer (<model>):` and the answer; and how it ended, when not with its answer: stopped, at the output limit, or in an error, with its reason. Who is a Participant's name, `subagent <agentId>` for a Turn an agent's result started, or `someone at the terminal`.
  - Each model switch among them: `## <time>: <name> switched the model to <label>, on <Harness>.`
  - Left out: a subagent's own events, tool results, reasoning, and the Attachments themselves.
  - Clipped: a prompt or answer at 4,000 characters (`MaxTurnTextLength`), a tool call at 200 (`MaxToolCallLength`), and a Turn's tool calls at 30 (`MaxToolCalls`), each saying how much more there was.
  - **The budget:** 64,000 characters (`HandoffBudget`, about 16,000 tokens), filled with the newest items that fit. When Turns are left out, `earlierBefore` is the `seq` of the earliest one kept. With no Turn to hand over, nothing is sent.
- **The mod frames it** (`handoffNote` in `packages/mod/src/Handoff.ts`), alike in both Harnesses, as `<context-handoff>…</context-handoff>`: that the Session ran on the other Harness, maybe on another model; that this is what the agent hasn't seen, shortened; that reasoning, tool state and attached files didn't carry over; that it is context for the next prompt, not a request; and how to read the Turns it left out, with the history tool and `before=<earlierBefore>`.
  - **Claude Code** (`hub-link-commands`) appends it as a user note (`$.session.append`), which Claude reads ahead of the next prompt, starting no Turn. One Claude Code won't append waits, and goes as hidden context with the next prompt, the Hub's or one typed at the terminal (`prompt.submit`).
  - **pi** (`History.ts`) adds it as a custom message, `kndl-handoff` (`pi.sendMessage`), at once while idle, starting no run, so the next request carries it ahead of the prompt. pi's terminal draws it as one line, `kndl: context handoff from Claude Code, for the next prompt`, and the whole text when expanded.
- **`GET /mod/history?before=<seq>&limit=<n>`** (`ModRoutes.ts`), on the mod token, answers `ModHistory { turns, earlierBefore? }`: the main loop's Turns before `before` (the latest, without it), oldest first, at most `limit` (20 by default, 50 at most), each a `HistoryTurn { seq, by, prompt, tools, answer, model? }` clipped as the handoff's. `earlierBefore` is there when earlier Turns are left. A Session the Hub doesn't know is `404`.
- **The `session_history` tool**, in both mods, reads it as text: `before`, a Turn number, and `limit`, 10 by default and 50 at most, read leniently, as models pass numbers as strings. In Claude Code it is `mcp__hub-link-commands__session_history`, registered with `$.tool.register`, not deferred, so it is in the tool list from the first request.
- **What runs Claude's Models** in a Member's new Sessions is theirs to choose, in the Account page's Anthropic section once they have a Claude credential: **Run Claude's Models with**, **Claude Code** or **pi**. The web sends `SetClaudeHarness { requestId, harness }`, which the Hub answers with `ProvidersState`, whose `claudeHarness` is the choice: `ClaudeCode` unless they chose pi.
- **New Session** (`CreateSessionDialog.tsx`) preselects, until a model is picked, as the protocol's `harnessForNewSession` decides:
  - Claude Code's default, where a Runner it may start on doesn't run pi;
  - the Creator's first Model, on pi, where Claude Code isn't offered, as without a Claude credential;
  - Claude's first Model, on pi, when their `claudeHarness` is `Pi` and they have Claude's Models;
  - else Claude Code's default. `?harness=claude-code` in the address keeps it there, and offers Claude Code without a Claude credential, so the dialog says to add one.

  It sends `harness: ClaudeCode` only for Claude Code's default, where a Runner might run pi: any other model names its Harness.

## The Runner

- **The bundle:** a pinned Node.js (pi needs 22.19 or newer: glibc builds from nodejs.org, and musl ones from unofficial-builds) and a pinned pi install. pi's install comes from a committed `package.json` and `bun.lock`, installed with `bun install --frozen-lockfile --ignore-scripts`.
  - Both are cached on the host and mounted read-only at `/opt/kndl/pi`.
  - A Runner whose bundle is ready says `harnesses: ["ClaudeCode", "Pi"]`.
- **Starting pi:** the Runner runs pi's TUI in tmux, like Claude Code, with the kndl extension: `node …/pi-coding-agent/dist/cli.js --approve -e /opt/kndl/mod/pi/kndl.js --session-id <conversationId> --model <provider>/<id> [--thinking <level>]`.
  - `--approve` makes the Repo's `.pi/` load.
  - pi's state lives in `PI_CODING_AGENT_DIR=/var/lib/kndl/claude/pi`, on the Session's `claude` volume, so it survives sleep.
  - `PI_OFFLINE=1` skips pi's startup network calls. pi's own telemetry is off.
- **pi's environment:** `KNDL_URL`, `KNDL_MOD_TOKEN`, `KNDL_SESSION_ID`, `KNDL_CONVERSATION_ID` (as the mod's), and `KNDL_HARNESS=Pi`. When the Creator has a Claude credential, also `CLAUDE_CODE_OAUTH_TOKEN`, `IS_SANDBOX=1`, `CLAUDE_CONFIG_DIR` and `KNDL_CLAUDE_CODE` (the guest path of the pinned `claude`), for the Claude bridge.
- **Resuming:** `--session-id` creates the conversation or resumes it. A new pi Session's conversation id is a UUID the Runner picks, as for Claude Code, and so is pi's first conversation in a Session switched to it.
- **Switching:** a `RelaunchSession` whose `harness` isn't what the Session runs stops that Harness and starts the other in the same Sandbox ([Switching Harness](#switching-harness-adr-0030)). Both launches set `KNDL_HARNESS`, so a Runner that restarts reads back which one each kept Session runs.

## The pi extension (`packages/mod/pi/`)

- **Packaging:** TypeScript, bundled by `bun run mod:build` into `packages/mod/pi/dist/kndl.js` (one ESM file for Node, with Effect, the protocol and the Claude bridge's dependencies inside). The Runner copies it with the mod, so it's at `/opt/kndl/mod/<copy>/pi/kndl.js` in the Sandbox, given to pi with `-e`. It reuses `HubLink` and `HubMessages` from `packages/mod/src`.
- **At load:**
  - `GET /mod/providers`, then register the Gateway providers.
  - For Claude's Models, the Claude bridge provider (`anthropic`), when the credential is there.
  - Register the Session's MCP servers, which the Runner names in `KNDL_MCP_SERVERS` (Installation ids and server names, nothing secret), as `kndl-<server>` at `${KNDL_URL}/gateway/<installationId>`. Their `Authorization` header is `Bearer ${KNDL_MOD_TOKEN}`, which pi fills in from its environment as it connects, so the token is never written down.
  - Add the Repo's `.claude/skills` to pi's skills (`resources_discover`), beside `.pi/skills` and `.agents/skills`.
  - Say hello: `conversationId` is pi's session id, `model` is `<provider>/<id>`, and the flags are `steers`, `attaches` and `switchesModels` (and the deprecated `takesHandoffs`).
- **Events** (as hub-link reports them for Claude Code):
  - `TurnStarted` and `TurnEnded`, the latter with pi-ai's stop reason, the Turn's usage summed with its cost, its `model` named `<provider>/<id>` as `providerModelName` names it, and, for an error, the Provider's reason (`errorMessage`, one line, at most 500 characters, with tokens and key-shaped strings redacted).
  - `TextDelta`, and `ToolCallStarted`/`ToolCallEnded`.
  - Subagents' and questions' events.
- **Commands:**
  - `DeliverPrompt`: a user message with the sender's name and the attachment markers, as hub-link words it.
  - `DeliverIntoTurn`: a steer. `StopTurn`: abort.
  - `SwitchModel`: `setModel` and `setThinkingLevel`. A model it doesn't have, as one of a Provider connected after pi started, makes it ask `/mod/providers` again and register the Gateway providers again, once. Only Models that go through kndl (the Gateway's or the Claude bridge's) are taken: never pi's built-in ones, which would call a Provider directly. One it still can't run is reported as `ModelSwitchFailed`, and the Hub puts the Session's model back, with a note in its history.
  - `DeliverAgentMessage` and `StopAgent`: Subagents, below. `DeliverAnswer`: the question tool.
  - `DeliverHandoff`: the context handoff, as a `kndl-handoff` message ([Switching Harness](#switching-harness-adr-0030)).
  - `PresenceChanged`: a widget line.
- **Tools:**
  - `attachment(id)` returns the image or PDF (ADR 0024).
  - `ask_user_question` has the Question schema, and becomes an Open question.
  - `session_history({ before?, limit? })` reads the Session's earlier Turns from `GET /mod/history` ([Switching Harness](#switching-harness-adr-0030)).
  - `agent`, `message_agent` and `stop_agent`: Subagents, below.
- **Subagents** (`Subagents.ts`, ADR 0014's amendment): each is a child pi `AgentSession` in-process, on any of the Creator's Models, the parent's by default, with the parent's tools but `agent`, `message_agent`, `stop_agent` and `ask_user_question`.
  - **In the background.** `agent({ description, prompt, model?, wait? })` returns at once with the agent's id, reporting `AgentStarted` with `background: true`, then `AgentStatusChanged` Running. The parent's Turn can end while it runs. Its runs' events carry its `agentId`, with its own `turnId` and usage on its own `TurnEnded`. With `wait: true` it is a foreground agent: `background: false`, the call returns its final answer, and the Turn's stop stops it.
  - **Its result starts a Turn.** When a run the model didn't wait for ends (Done or Stopped; a failed run is Done), the main loop is given a custom message (`kndl-agent`) in the shape of Claude Code's task notification: `<task-notification>` with `<task-id>` (the agent's id), `<status>` (`completed`, `stopped` or `failed`), `<summary>`, `<note>` and `<result>`, which the web shows. It is sent with `triggerTurn`, so it starts a pi run, reported as a `TurnStarted` from `FromAgent { agentId }`, with the message as its text. One that comes while pi runs waits in the extension until pi settles, then goes, one run each, oldest first: never into a run, and not into pi's own follow-up queue, which its terminal empties when the person stops a run there, and which an aborted run leaves waiting.
  - **Messages and stops.** `message_agent({ agentId, message, wait? })` steers a running agent (read at its next step) or resumes one that has ended, a new run on its own session, whose result comes as above, or to the call with `wait`. `stop_agent({ agentId })` aborts a running one and returns what it had said, so its end isn't delivered again. The Creator's `DeliverAgentMessage` (with their name, as a prompt is) and `StopAgent` do the same, and a run they cause ends in a message to the main loop; one the extension can't do is `AgentCommandFailed`.
  - **Kept on disk.** Each agent's pi session is a file, `$PI_CODING_AGENT_DIR/kndl/agents/<agentId>.jsonl`, opened with `SessionManager.open`, beside `index.json`: `{ agents: [{ agentId, description, model, status, reported, undelivered? }] }`, written whole on each change, where `undelivered` keeps a result the main loop hadn't taken yet, given again when pi starts; keeping entries another pi on the directory wrote. At `session_shutdown`, a running agent is aborted and reported Interrupted, before the link stops; the index keeps it Running. At `session_start`, the index is read: an agent still Running there becomes Interrupted, and the main loop is given a note for it with its next prompt (`nextTurn`), a task notification with `<status>interrupted</status>`. Agents are opened lazily, on their saved conversation and model, when messaged. The Hub marks Running agents Interrupted itself when pi stops, as for Claude Code, so a hard kill is covered too. A switch to Claude Code stops pi the same way. The agents stay pi's: Claude Code's mod can't resume them, and a switch back to pi can.
  - **The parent's tools.** A child runs pi's built-in tools by name, and the others (the attachment tool, MCP servers') through the parent: the extension keeps the context of its tools' last call, whose `tools` are the parent's, live. Before any such call, as when the Creator resumes an agent right after pi starts, they are described as `getAllTools()` lists them, and found when the agent calls one.
  - **Claude.** `createChild` gives each child session, new or resumed, the Claude bridge's `followClaudeSession` as an extension factory, and binds it, so the bridge learns its directory and prompt.

- **The Claude bridge:** our own provider for `anthropic`, ported from `pi-claude-bridge` 0.9.3 (MIT, credited), in `pi/src/claude/`.
  - It runs the pinned Claude Code through the Agent SDK with `tools: []` and serves pi's tools over in-process MCP.
  - It registers only when pi has `CLAUDE_CODE_OAUTH_TOKEN` and `KNDL_CLAUDE_CODE`, and only the Claude Models `/mod/providers` lists, from pi-ai's `anthropic` catalogue, at a price of 0.
  - Claude Code runs in the Workspace with `bypassPermissions`, `--strict-mcp-config` and no settings files, so a Repo's Claude Code hooks and plugins don't run. Its sessions, pi's history mirrored for `resume`, live in `CLAUDE_CONFIG_DIR`. `ANTHROPIC_*` and the mod's variables are kept out of its environment.
  - The plan can't be read from a setup token, so it takes Pro: Opus 4.6 and Sonnet 4.6 run at 200K context, the other measured Models at 1M.
  - It never changes a message once pi has it: the spike's bug. A turn's end hands pi a copy of its message, and an abort with no turn open ends no message.
  - **A stopped turn keeps the prompt cache.** The next turn resumes the same Claude Code session, cut back to the stopped turn's prompt and the attachments Claude Code put on it. pi's messages since are written after it, the cut-off reply as pi holds it. Claude Code's own records from before the stop stay, and pi never sees them (its attachments, its fillers), so the next request starts as the stopped one did. A steer that never reached Claude Code is written in the same way.
    - The bridge spawns Claude Code itself, so it knows when a stopped one has exited, which can take a second. The session file is cut only after that. One that hasn't exited after 10 seconds leaves the session to be rebuilt under a new id.
    - A history pi changed before the stopped turn (a compaction, tree navigation) still rebuilds the session from pi's history, and so does another Provider's turn with no stop.
