# Spike: Claude through Claude Code as a pi provider, with pi's tools only

The spike that ADR 0029 waits on. It asks: can a pi Session reach Claude on its Creator's subscription, through Claude Code used as a model only, and switch to and from GPT in one conversation? Run on 2026-10-18 in a kndl Sandbox (linux-arm64, running as root).

**Versions:**
- pi `@earendil-works/pi-coding-agent` 1.3.0, pi-ai 1.3.0;
- `pi-claude-bridge` 0.9.3, with its Agent SDK `@anthropic-ai/claude-agent-sdk` 0.3.x;
- Claude Code 2.1.296, kndl's pinned binary at `/opt/kndl/claude-code/2.1.296-glibc/claude`.

**Credentials:** the Creator's `claude setup-token` token as `CLAUDE_CODE_OAUTH_TOKEN`, and a "Sign in with ChatGPT" login made with pi-ai's OAuth flow, its callback reached through a Forward.

**Models:** Claude `claude-haiku-5-5`, and GPT `gpt-5.6-luna`.

The spike drove `pi --mode rpc` from a script, using `pi-claude-bridge` itself rather than our own bridge. Our bridge would take its approach, so its behaviour is the evidence. The scenario:

1. Claude: read a file.
2. Claude: run bash.
3. Switch to GPT: recall the secret word from Claude's turn, then write a file.
4. Switch to Claude: read GPT's file and recall the word.
5. A Claude turn with no tools.
6. Claude: abort mid-`bash`.
7. A Claude turn after the abort.
8. Claude: a steered message while `bash` runs.
9. Switch to GPT: recall everything.

## Short answer

**Go: the approach holds.** Four criteria passed outright. The fifth, GPT → Claude → GPT, passed except in one case, and the failure was a bug in `pi-claude-bridge` itself, not in the approach. Our own bridge has to avoid it.

| Criterion | Result |
|---|---|
| Claude uses only pi's tools | **Pass.** Every Claude Code `init` offered exactly `mcp__custom-tools__{bash,edit,read,write}`, pi's four tools over the bridge's in-process MCP server, and none of its own. The tool calls ran in pi, and pi's session file holds them as ordinary pi tool calls. |
| Usage counts against the plan, not extra usage | **Pass.** Every turn's `rate_limit_event` read `status: allowed`, `rateLimitType: five_hour`, `isUsingOverage: false`. Overage is turned off on this account (`overageStatus: rejected`), so a request billed as extra usage would have been refused. |
| Prompt cache hits across turns | **Pass.** Consecutive Claude turns read 97–98% of the prompt from the cache. After a switch back from GPT, and after an abort, the first Claude request rewrote part of the prefix (600–800 tokens written), and the next one was back to ~98%. |
| Abort and steer | **Pass.** An abort mid-`bash` ended the turn ("Command aborted"), and the next Claude turn answered normally. A steer sent while `bash` ran was queued and read at the next step: "The colour you gave is blue." |
| GPT → Claude → GPT | **Pass, with one bridge bug.** GPT recalled the word Claude had read. Claude read GPT's file and recalled the word. Switching back to GPT failed only after a Claude turn had been aborted earlier in the same process (see below). The same session, resumed in a fresh process, switched to GPT and recalled everything. |

## The bug: the bridge changes a message pi already holds

Run 9 failed with `OpenAI API error (400): No tool call found for function call output with call_id toolu_…`, naming the `bash` call that had been aborted in run 6.

- Right after the abort, pi's in-memory copy of that assistant message had `stopReason: toolUse`, with its tool result after it. Switching to GPT at that point worked.
- After the next Claude turn (run 7), the same message in memory read `stopReason: aborted`. The session file still said `toolUse`.
- pi-ai's cross-provider transform skips `aborted` assistant messages when replaying history (`transformMessages` in `pi-ai/src/api/transform-messages.ts`). So the call was dropped and its result was left orphaned, which OpenAI rejects. Anthropic's path never noticed, because the bridge rebuilds Claude Code's own session from its mirror.
- The bridge sets `turnOutput.stopReason = "aborted"` in place on its abort paths (`src/index.ts`, around lines 2116 and 2174). An output object it had already handed to pi is the likely target. This is the class of bug its open issues #181 and #199 describe.

**For our bridge:** a message handed to pi is never modified again. An abort ends with a new error message, never by rewriting an earlier one.

## Other findings

- **pi's model catalogue isn't what an account can use.** pi lists models from a static catalogue. Through "Sign in with ChatGPT", `gpt-5.5`, `gpt-5.4`, `gpt-5.x-codex` and `gpt-5.4-mini` were refused ("not supported when using Codex with a ChatGPT account"), and only `gpt-5.6-{luna,sol,terra}` worked. This confirms ADR 0029's choice that the Hub asks each Provider for its models under the Creator's account.
- **Cost is at list price, even on subscriptions.** pi-ai prices GPT turns at API list prices, even through a ChatGPT subscription. That's wanted: a Turn's cost shows what it would have cost, and someone on a subscription knows they weren't billed. Claude turns through the bridge cost 0, so our bridge must price them from the catalogue too.
- **Claude Code as root needs `IS_SANDBOX=1`** for `bypassPermissions`, as kndl already sets. Without it, every Claude turn fails at once.
- **pi loads `AGENTS.md` and `CLAUDE.md` natively** (`--no-context-files` turns off both). Repo context needs no adapting.
- **The bridge keeps its own Claude Code session** in `CLAUDE_CONFIG_DIR`, a mirror of pi's history. It rebuilds it from pi's history (`cc-session-io`) when the two diverge, which is the partial cache rewrite seen after a switch or an abort. In kndl that directory belongs on the Session's `claude` volume, so it survives sleep.
- **Exported `ANTHROPIC_*` variables break it** (bridge issue #107). kndl already keeps them out of Claude Code's environment.
- **The ChatGPT login works headless through a Forward.** pi-ai's flow listens on `127.0.0.1:1455`, and binding it with `PI_OAUTH_CALLBACK_HOST=0.0.0.0` let the Creator's browser redirect reach the Sandbox. The Hub's own flow won't need this: the Hub runs it and owns the callback.

## Not covered

- **Latency:** each Claude turn starts a Claude Code process with `resume`, and the time that adds wasn't measured.
- **Long sessions:** compaction, images, and Opus or Fable models (only Haiku was used).
- **Terms:** Anthropic's support page counts Agent SDK and `claude -p` use against plan limits today, but a billing change for SDK use was announced and then paused. One bridge user reports an account ban with no known cause (issue #118). That risk sits outside anything a spike can show.
