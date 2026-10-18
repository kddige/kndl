// The smoke test for upgrading the pinned Claude Code (PinnedClaudeVersion): a Session's Claude
// Code in a real microsandbox VM, launched as the Runner launches it, in tmux, on a setup token
// and talking to Anthropic directly (ADR 0026), with the mod loaded. Its banner shows a
// subscription, `/status` opens, a Turn runs Bash in the Sandbox, a background subagent's run and
// its task notification are where hub-link and the Hub expect them (ADR 0014), and the models and
// thinking levels it takes are those PinnedClaudeModels says. So it is skipped unless
// KNDL_SANDBOX_IT=1, and makes model calls (a few, on haiku) with your own setup token: the one
// in `CLAUDE_CODE_OAUTH_TOKEN`, or else, on macOS, in the Keychain item `kndl-setup-token`. It
// needs `msb` installed for the current user, and network access to Docker Hub and to npm the
// first time a Claude Code version is cached. No Hub runs: the mod's link stays down. Everything
// it creates is named kndl-it-… and destroyed at the end, pass or fail.
//
//   KNDL_SANDBOX_IT=1 bun test packages/runner/src/SandboxClaude.integration.test.ts

import { expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  type ClaudeCredential,
  credentialFromSecret,
  type RepoName,
  type SessionId,
} from "@kndl/protocol"
import { devHome } from "@kndl/protocol/home"
import { Effect, Layer, Redacted } from "effect"
import { claudeLaunch } from "./ClaudeLaunch.ts"
import { modelProbeFlags, PinnedClaudeModels, probeModels } from "./ClaudeModels.ts"
import { harnessEnvironment } from "./HarnessEnvironment.ts"
import { HubLink } from "./HubLink.ts"
import { makeModRelay, serveModRelay } from "./relay/ModRelay.ts"
import { makeSessionTokens, SessionTokens } from "./relay/SessionTokens.ts"
import { Sandboxes } from "./Sandbox.ts"
import * as MicrosandboxBackend from "./sandbox/MicrosandboxBackend.ts"
import { SandboxBackend } from "./sandbox/SandboxBackend.ts"
import { ensureSandboxClaude, PinnedClaudeVersion } from "./sandbox/SandboxClaude.ts"
import { claudeStateGuestPath, workspaceGuestPath } from "./sandbox/SessionLayout.ts"
import { copySessionMod } from "./SessionMod.ts"
import { sessionDirectories } from "./SessionNames.ts"
import { makeSessionSandboxes } from "./SessionSandboxes.ts"
import { FakeHubVariables, sandboxesDefaults } from "./testSupport.ts"
import { makeTmux } from "./Tmux.ts"

const enabled = process.env.KNDL_SANDBOX_IT === "1"

/** The mod in this checkout, which the Session's Claude Code loads a copy of. */
const modDir = join(import.meta.dir, "..", "..", "mod")

/** The Keychain item the setup token is looked for in on macOS, without `CLAUDE_CODE_OAUTH_TOKEN`. */
const keychainService = "kndl-setup-token"

/** Your own setup token, which the test's Claude Code runs on as a Session runs on its Creator's. */
const setupToken = (): ClaudeCredential => {
  const fromKeychain = () =>
    process.platform === "darwin"
      ? Bun.spawnSync(["security", "find-generic-password", "-s", keychainService, "-w"])
          .stdout.toString()
          .trim()
      : ""
  const credential = credentialFromSecret(process.env.CLAUDE_CODE_OAUTH_TOKEN ?? fromKeychain())
  if (credential === undefined)
    throw new Error(
      `Put a setup token from \`claude setup-token\` in CLAUDE_CODE_OAUTH_TOKEN, or on macOS in the Keychain item ${keychainService}.`,
    )
  return credential
}

/** Waits for `read` to show what `seen` looks for, failing with what it read last. */
const waitFor = (
  what: string,
  read: Effect.Effect<string, unknown>,
  seen: (text: string) => boolean,
  seconds: number,
) =>
  Effect.gen(function* () {
    let last = ""
    for (let waited = 0; waited < seconds * 2; waited++) {
      last = yield* Effect.orDie(read)
      if (seen(last)) return last
      yield* Effect.sleep("500 millis")
    }
    return yield* Effect.die(new Error(`no ${what} in ${seconds}s; it read:\n${last}`))
  })

test.skipIf(!enabled)(
  `Claude Code ${PinnedClaudeVersion} runs in a Sandbox: its banner shows a subscription, /status opens, a Turn runs Bash, a subagent runs, and it takes the models PinnedClaudeModels says`,
  async () => {
    const sessionId = `it-${Date.now().toString(36)}` as SessionId
    const root = await mkdtemp(join(tmpdir(), "kndl-it-"))
    const directories = sessionDirectories(root, sessionId)
    await mkdir(directories.workspace, { recursive: true })
    const cacheDir = process.env.RUNNER_SANDBOX_CLAUDE_CACHE ?? join(devHome.dir, "claude-code")
    const conversation = randomUUID()
    const credential = setupToken()

    const program = Effect.gen(function* () {
      const sandboxes = yield* Sandboxes
      const backend = yield* SandboxBackend
      const tokens = yield* SessionTokens
      const tmux = makeTmux(backend)

      // No Hub: the relay relays the mod's requests to a port nothing listens on.
      const port = yield* serveModRelay({ port: 0, hubUrl: new URL("http://127.0.0.1:9") })
      const relay = makeModRelay({ port, tokens })
      const started = yield* sandboxes.start(sessionId, directories, {
        repo: "acme/app" as RepoName,
      })
      const sessionToken = yield* relay.admit({ sessionId, modToken: Redacted.make("chm_it.FAKE") })
      const launch = claudeLaunch({
        claudePath: started.claude.path,
        sessionId,
        mod: yield* copySessionMod(modDir, directories),
        conversation: { _tag: "New", id: conversation },
        model: "haiku",
      })
      const { env, unset } = harnessEnvironment({
        base: { ...started.claude.env, ...launch.env },
        relayUrl: relay.guestUrl,
        sessionToken,
        credential,
      })
      yield* tmux.launch({
        sessionId,
        cwd: workspaceGuestPath,
        argv: launch.argv,
        env,
        unset,
        size: { cols: 120, rows: 40 },
      })

      const conversationDir = `${claudeStateGuestPath}/projects/-workspace`
      const transcriptPath = `${conversationDir}/${conversation}.jsonl`
      /**
       * What of a file in the Sandbox matches `pattern` (grep's extended syntax, no `'`), or "":
       * a transcript is read in matches, as a long one comes back empty whole.
       */
      const guestGrep = (pattern: string, path: string) =>
        backend
          .exec(sessionId, { command: "sh", args: ["-c", `grep -oE '${pattern}' ${path}; true`] })
          .pipe(Effect.map((result) => result.stdout))
      // A task notification about an agent: the Agent tool's result mentions them too.
      const notified = "<task-notification>.{0,4}<task-id>a[0-9a-f]+"

      let screen = ""
      /** Waits for the screen to show what `seen` looks for. */
      const until = (what: string, seen: (screen: string) => boolean, seconds = 60) =>
        waitFor(what, tmux.lastOutput(sessionId), seen, seconds).pipe(
          Effect.map((shown) => {
            screen = shown
          }),
        )

      yield* Effect.scoped(
        Effect.gen(function* () {
          const pane = yield* tmux.attach(sessionId)
          const type = (text: string) =>
            Effect.andThen(pane.input(text), Effect.sleep("300 millis"))

          // Straight to the prompt: no onboarding, trust or bypass-permissions question.
          yield* until("prompt", (s) => s.includes("bypass permissions"))
          expect(screen).toContain(`Claude Code v${PinnedClaudeVersion}`)
          // The plan comes from Anthropic, as nothing states it any more.
          expect(screen).toMatch(/Claude (Pro|Max|Team|Enterprise)/)
          expect(screen).not.toContain("API Usage Billing")

          yield* type("/status")
          yield* type("\r")
          yield* until("/status", (s) => /Version:\s/.test(s) && s.includes("/workspace"))
          yield* type("\u001b")

          yield* type(
            "Run `echo smoke-$((6*7)) && uname -s` with your Bash tool, then reply with its output only.",
          )
          yield* type("\r")
          yield* until(
            "Turn's answer",
            (s) => /smoke-42\s+Linux/.test(s.replace(/[⎿│]/g, " ")),
            120,
          )

          // A background agent: its run is a sidechain beside the conversation, and once it's
          // done, Claude Code prompts the main loop with a task notification naming it. Asked once
          // the Turn has ended, with its answer in the transcript.
          yield* waitFor(
            "Turn's end",
            guestGrep('"type":"text","text":"[^"]*smoke-42', transcriptPath),
            (text) => text !== "",
            30,
          )
          yield* type(
            'Use the Agent tool to start one general-purpose subagent in the background, described "smoke agent". Tell it to run `echo agent-$((6*8))` with its Bash tool and reply with the output only. Then end your turn.',
          )
          yield* type("\r")
          yield* waitFor(
            "task notification",
            guestGrep(notified, transcriptPath),
            (text) => text !== "",
            120,
          ).pipe(
            Effect.tapCause(() =>
              Effect.andThen(tmux.lastOutput(sessionId), (shown) =>
                Effect.sync(() => console.error(`the screen:\n${shown}`)),
              ),
            ),
          )
        }),
      )

      // The Turn ran Bash in the Sandbox, and the transcript is on Claude Code's volume.
      expect(yield* guestGrep('"name":"Bash"', transcriptPath)).not.toBe("")
      // The notification names the agent by the id its run's file has, as hub-link reads it.
      const agentId = /<task-id>(a[0-9a-f]+)/.exec(yield* guestGrep(notified, transcriptPath))?.[1]
      expect(agentId).toBeDefined()
      const run = `${conversationDir}/${conversation}/subagents/agent-${agentId}.jsonl`
      expect(yield* guestGrep("agent-48", run)).toContain("agent-48")
      yield* tmux.kill(sessionId)

      // The models and thinking levels the build takes are those PinnedClaudeModels says, which
      // the Runner offers its Sessions. Asked in the Sandbox as a Session's Claude Code runs.
      const probe = (args: ReadonlyArray<string>) =>
        backend
          .exec(sessionId, {
            command: started.claude.path,
            args: [...modelProbeFlags, ...args],
            cwd: workspaceGuestPath,
            env,
          })
          .pipe(Effect.map((result) => result.stdout))
      const models = yield* probeModels(probe)
      if (!Bun.deepEquals(models, PinnedClaudeModels)) {
        console.error(
          `Claude Code ${PinnedClaudeVersion} takes, for PinnedClaudeModels:\n${JSON.stringify(models, null, 2)}`,
        )
      }
      expect(models).toEqual(PinnedClaudeModels)
    })

    const cleanup = Effect.gen(function* () {
      const backend = yield* SandboxBackend
      yield* backend.destroy(sessionId)
      expect((yield* backend.list).filter((l) => l.sessionId === sessionId)).toEqual([])
    })

    const hub = Layer.succeed(
      HubLink,
      HubLink.of({ send: () => Effect.void, connect: () => Effect.void, disconnect: Effect.void }),
    )
    const sandboxes = Layer.effect(
      Sandboxes,
      makeSessionSandboxes({
        image: "docker:dind",
        claudeCacheDir: cacheDir,
        sandboxClaude: () =>
          ensureSandboxClaude({ cacheDir, version: PinnedClaudeVersion }).pipe(
            Effect.as(PinnedClaudeVersion),
          ),
        ...sandboxesDefaults,
        layout: {
          cpus: 2,
          memoryMib: 2048,
          rootDiskMib: 4096,
          workspaceQuotaMib: 1024,
          dependencySizeMib: 256,
          cacheSizeMib: 256,
          dockerSizeMib: 1024,
        },
      }),
    )
    try {
      await Effect.runPromise(
        program.pipe(
          Effect.timeoutOrElse({
            duration: "8 minutes",
            orElse: () => Effect.die(new Error("timed out")),
          }),
          Effect.ensuring(cleanup.pipe(Effect.orDie)),
          Effect.provide(sandboxes),
          Effect.provide(
            Layer.mergeAll(
              MicrosandboxBackend.layerFor(`it-${sessionId}`),
              hub,
              new FakeHubVariables().layer,
              Layer.sync(SessionTokens, makeSessionTokens),
            ),
          ),
          Effect.scoped,
        ),
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  },
  600_000,
)
