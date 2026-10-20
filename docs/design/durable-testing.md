# Testing the durable-agent spike locally

This is an experimental full replacement, not a release. It deliberately departs from ADRs 0026, 0029 and 0030: everyone with Repo access drives a Session on its Creator's accounts, and every Model uses one durable agent. The [design](durable-harness.md) describes the architecture.

## Use disposable data

Use a separate checkout and a fresh Hub/Runner data directory, or back up both before switching branches. Protocol v5 requires the Hub, Runner, web and agent to come from this checkout. The Hub adds thread tables, and each Session's persistent volume gains `durable/session.sqlite`; an older agent cannot read that conversation. Checking out the old code does not translate new conversation state back to the old Harnesses.

For a developer install, keep the Hub's existing secrets key with its database if you copy it: accounts encrypted with another key cannot be read. Avoid pointing a test Runner at the production Hub. Everyone with shell access to a Sandbox can inspect its processes and files; keeping the agent's tokens out of the shell's inherited environment is not a separate security boundary.

## Build and start

The host needs Bun 1.4+, git, tmux and a working microsandbox installation (Apple Silicon on macOS, or KVM on Linux). The Runner obtains the pinned Node.js, Claude Code and Pi Durable packages for Sandboxes. Installing the old pi CLI or Claude Code plugins is no longer part of development.

```sh
bun install --frozen-lockfile
bun run mod:build
bun run web:build
bun run typecheck
bun run lint
bun run format:check
```

For example, use a fresh home for the experiment. Generate a secrets key once, keep it outside the repository, and give the same key to this Hub on every start; connecting accounts requires it:

```sh
export KNDL_HOME="$HOME/.kndl-durable-spike"
bun run secrets-key
# Set HUB_SECRETS_KEY to the value printed above, then:
HUB_PUBLIC_URL=http://127.0.0.1:7777 KNDL_DEV_LOGIN=1 bun run hub
```

In another terminal, use the same test home, issue a token for this test Runner and start it:

```sh
export KNDL_HOME="$HOME/.kndl-durable-spike"
bun run runner-token "durable-spike"
# Set RUNNER_TOKEN to the printed token, then:
bun run runner
```

Open <http://127.0.0.1:7777>, sign in, connect a Provider on Account, configure a Repo's Environment, and start a Session. Claude subscription Models still need a Claude setup token connected on Account; OpenAI and other Providers use their own connected accounts. The Session's Model picker lists its **Creator's** Models for everyone, not the viewing Member's accounts.

## Exercise the differences

| Try | Check |
| --- | --- |
| Ask for a change with several steps and a Plan. | Text and tools stream; the Plan updates live; usage appears after a Turn. |
| Sign in as another Member with access to the same Repo. | They can prompt, steer, stop, answer, switch Models and use the terminal. The Session still identifies whose accounts pay. |
| Reply in a thread from an answer; choose another Model if available. | The thread opens beside the main transcript on desktop. Both can run at once; thread work never turns the main composer busy. |
| Post while a thread is running. | The prompt steers that thread, appears once and does not enter the main Prompt queue. |
| Start background subagents, including one inside a thread. | Their transcripts and results belong to the right conversation; messaging and stopping work. |
| Ask a synchronous question, then an asynchronous one. | Anyone can answer; synchronous waits, asynchronous works on and receives the answer later. Questions are intentionally main-conversation only. |
| Use an MCP Installation with several tools. | `tool_search` finds deferred tools; `codemode` can call them without loading every tool into the Model's initial context. |
| Attach an image or PDF. | The attachment tool opens it and the Model can use it. |
| Compact the main conversation, then a thread, with optional instructions. | A summary divider appears in the right transcript and the conversation continues. |
| Switch GPT → Claude → GPT, if both accounts are connected. | No Harness switch or second agent launches; tools and conversation context still work. |
| Open the terminal and type `pwd`, then `exit`. | It is a shared shell in the Workspace, not an agent TUI. The shell returns after exit and the agent keeps working. |

Threads and Subagents have independent conversations, not independent checkouts. They share the Session's Workspace and shell processes; coordinate edits and commands just as you would with several people in one checkout.

## Recovery and lifecycle

Use a disposable Session for process-kill tests. The agent's tmux session is `<name>-agent`; the terminal's is `<name>`, on the Sandbox's `kndl` tmux server. Inspect the session list first rather than assuming a name. Do not kill the tmux server: that kills both sessions and tests a different failure.

1. **Graceful sleep/wake:** let a Turn end, put the Session to sleep and wake it. Its conversation, files, Plan and threads should remain.
2. **Runner restart/adoption:** restart only the Runner while a Turn is working. The Sandbox agent can outlive the Runner; reconnecting should adopt it, not start a second process. Going Frozen alone must not end its Turn.
3. **Agent crash:** kill only the agent process during a long tool call. The Hub should show the Turn as Stopped, with useful crash output when available. Wake the Session. Work that Pi Durable recovers should appear under a new Turn marked as resumed.
4. **Crash with a thread/subagent running:** repeat with concurrent work. Each recovered conversation should report to its own transcript; a thread must not replace the main current Turn.
5. **Hub restart:** restart only the Hub while a prompt to a thread is being admitted. The agent should say hello again; undelivered commands are re-sent, and a prompt id is submitted only once.

Durable admission is not exactly-once execution of external side effects. A shell command or remote service request cut off after doing its work may have an uncertain outcome; unsafe tools must not blindly replay. The existing bundle test specifically checks that a killed bash call is reported as interrupted, rather than silently executing it again.

## Automated evidence

From the root, `bun test` runs the packages' tests. On memory-constrained machines, run packages in separate processes to avoid retaining every package's test runtime in one Bun process:

```sh
(cd packages/protocol && bun test)
(cd packages/hub && bun test)
(cd packages/runner && bun test)
(cd packages/mod && bun test)
(cd packages/web && bun test)
(cd packages/cli && bun test)
```

The root typecheck runs packages concurrently. If the OS kills a compiler for memory pressure, the equivalent serial check is:

```sh
bun run --sequential --filter '*' typecheck
bunx tsc -p scripts
```

The durable agent's tests include real Pi Durable Harnesses with scripted Models, SQLite close/reopen, concurrent forks, tools and a built Node bundle over HTTP. They do not substitute for a real Sandbox launch on your machine.

- Real Sandbox tests are opt-in with `KNDL_SANDBOX_IT=1` and require the host's hypervisor/microsandbox setup.
- The live Claude bridge test is opt-in with `KNDL_CLAUDE_IT=1` and uses a real Claude credential. It can spend the account's allowance.
- UI fake-Hub scenes exercise the new states without model calls; they are visual fixtures, not evidence that the Runner booted a Sandbox.

## Current boundaries

- A thread and its Subagents share files and processes with the main conversation; forks isolate context, not the Workspace.
- Questions are offered only in the main conversation.
- PDF attachments are downloaded outside the Workspace and their path is returned to the Model. Native PDF tool results are not supported; extracting their contents needs a tool such as `pdftotext` in the Sandbox.
- The Claude bridge rebuilds its mirror after a restart or compaction. Durable conversation state survives, but a provider-side prompt-cache hit is not guaranteed.
- Live repository-instruction changes reach the next fresh Claude query, not a Claude query already held open across tool calls.

## Diagnose a failure

The agent writes `$KNDL_STATE_DIR/durable/agent.log` (normally under `/var/lib/kndl/claude`) beside its SQLite database. Tokens are redacted. The Runner captures the agent pane for crash reports, independently of the shared shell.

Record which component restarted, the Session id, whether the main conversation or a thread was working, and the first error in the agent/Runner/Hub logs. Preserve the SQLite database for a recovery bug; deleting it also deletes the evidence. Do not attach credentials or unredacted environment dumps to the PR.
