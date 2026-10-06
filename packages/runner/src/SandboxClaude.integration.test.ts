// The smoke test for upgrading the pinned Claude Code (PinnedClaudeVersion): a Session's Claude
// Code in a real microsandbox VM, launched as the Runner launches it, in tmux, through the
// credential proxy, with the mod loaded. Its banner shows the plan, `/status` opens, and a Turn
// runs Bash in the Sandbox. So it is skipped unless CLAUDE_HUB_SANDBOX_IT=1, and makes model
// calls (a few, on haiku) with this machine's Runner credential, read as the Runner reads it
// (`RUNNER_CLAUDE_CREDENTIAL`, by default the Keychain item `claude-hub-setup-token`). It needs
// `msb` installed for the current user, and network access to Docker Hub and to npm the first
// time a Claude Code version is cached. No Hub runs: the mod's link stays down. Everything it
// creates is named claude-hub-it-… and destroyed at the end, pass or fail.
//
//   CLAUDE_HUB_SANDBOX_IT=1 bun test packages/runner/src/SandboxClaude.integration.test.ts

import { expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { RepoName, SessionId } from "@claude-hub/protocol"
import { devHome } from "@claude-hub/protocol/home"
import { BunServices } from "@effect/platform-bun"
import { Effect, Layer, Redacted } from "effect"
import { ChildProcessSpawner } from "effect/process"
import { claudeLaunch } from "./ClaudeLaunch.ts"
import { HubLink } from "./HubLink.ts"
import { makeCredentialProxy, serveCredentialProxy } from "./proxy/CredentialProxy.ts"
import { DefaultKeychainService, parseCredentialSource } from "./proxy/ProxyConfig.ts"
import {
  hostSecretReaders,
  makeRunnerCredential,
  RunnerCredential,
} from "./proxy/RunnerCredential.ts"
import { makeSessionTokens, SessionTokens } from "./proxy/SessionTokens.ts"
import { Sandboxes } from "./Sandbox.ts"
import * as MicrosandboxBackend from "./sandbox/MicrosandboxBackend.ts"
import { SandboxBackend } from "./sandbox/SandboxBackend.ts"
import { ensureSandboxClaude, PinnedClaudeVersion } from "./sandbox/SandboxClaude.ts"
import { claudeStateGuestPath, workspaceGuestPath } from "./sandbox/SessionLayout.ts"
import { sessionDirectories } from "./SessionNames.ts"
import { makeSessionSandboxes } from "./SessionSandboxes.ts"
import { FakeHubVariables, sandboxesDefaults } from "./testSupport.ts"
import { makeTmux } from "./Tmux.ts"

const enabled = process.env.CLAUDE_HUB_SANDBOX_IT === "1"

/** The mod in this checkout, which every Sandbox mounts. */
const modDir = join(import.meta.dir, "..", "..", "mod")

/** How the banner names each plan. */
const planNames: Record<string, string> = {
  pro: "Claude Pro",
  max: "Claude Max",
  team: "Claude Team",
  enterprise: "Claude Enterprise",
}

test.skipIf(!enabled)(
  `Claude Code ${PinnedClaudeVersion} runs in a Sandbox: its banner shows the plan, /status opens, and a Turn runs Bash`,
  async () => {
    const sessionId = `it-${Date.now().toString(36)}` as SessionId
    const root = await mkdtemp(join(tmpdir(), "claude-hub-it-"))
    const directories = sessionDirectories(root, sessionId)
    await mkdir(directories.workspace, { recursive: true })
    const cacheDir = process.env.RUNNER_SANDBOX_CLAUDE_CACHE ?? join(devHome.dir, "claude-code")
    const conversation = randomUUID()

    const program = Effect.gen(function* () {
      const sandboxes = yield* Sandboxes
      const backend = yield* SandboxBackend
      const tokens = yield* SessionTokens
      const runnerCredential = yield* RunnerCredential
      const tmux = makeTmux(backend)

      // No Hub: the proxy relays the mod's requests to a port nothing listens on.
      const port = yield* serveCredentialProxy({ port: 0, hubUrl: new URL("http://127.0.0.1:9") })
      const proxy = makeCredentialProxy({ port, tokens, runnerCredential })
      const credential = yield* runnerCredential.current
      const started = yield* sandboxes.start(sessionId, directories, {
        repo: "acme/app" as RepoName,
      })
      const pass = yield* proxy.admit({ sessionId, modToken: Redacted.make("chm_it.FAKE") })
      expect(pass.credential).toBe("Runner")
      const launch = claudeLaunch({
        claudePath: started.claude.path,
        sessionId,
        conversation: { _tag: "New", id: conversation },
        model: "haiku",
      })
      yield* tmux.launch({
        sessionId,
        cwd: workspaceGuestPath,
        argv: launch.argv,
        env: { ...started.claude.env, ...launch.env, ...pass.env },
        size: { cols: 120, rows: 40 },
      })

      let screen = ""
      /** Waits for the screen to show what `seen` looks for, failing with the screen. */
      const until = (what: string, seen: (screen: string) => boolean, seconds = 60) =>
        Effect.gen(function* () {
          for (let waited = 0; waited < seconds * 2; waited++) {
            screen = yield* tmux.lastOutput(sessionId)
            if (seen(screen)) return
            yield* Effect.sleep("500 millis")
          }
          return yield* Effect.die(new Error(`no ${what} in ${seconds}s; the screen:\n${screen}`))
        })

      yield* Effect.scoped(
        Effect.gen(function* () {
          const pane = yield* tmux.attach(sessionId)
          const type = (text: string) =>
            Effect.andThen(pane.input(text), Effect.sleep("300 millis"))

          // Straight to the prompt: no onboarding, trust or bypass-permissions question.
          yield* until("prompt", (s) => s.includes("bypass permissions"))
          expect(screen).toContain(`Claude Code v${PinnedClaudeVersion}`)
          if (credential._tag === "OAuthToken" && credential.plan !== undefined) {
            expect(screen).toContain(planNames[credential.plan.subscriptionType] ?? "")
          }
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
        }),
      )

      // The Turn ran Bash in the Sandbox, and the transcript is on Claude Code's volume.
      const transcript = yield* backend.exec(sessionId, {
        command: "cat",
        args: [`${claudeStateGuestPath}/projects/-workspace/${conversation}.jsonl`],
      })
      expect(transcript.stdout).toContain('"name":"Bash"')
      expect(transcript.stdout).toContain("smoke-42")
      yield* tmux.kill(sessionId)
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
        modDir,
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
    const credential = Layer.effect(
      RunnerCredential,
      Effect.gen(function* () {
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
        return yield* makeRunnerCredential({
          source: parseCredentialSource(process.env.RUNNER_CLAUDE_CREDENTIAL ?? "auto") ?? {
            _tag: "Keychain",
            service: DefaultKeychainService,
          },
          plan: undefined,
          home: devHome.dir,
          readers: hostSecretReaders(spawner),
        })
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
              credential.pipe(Layer.provide(BunServices.layer)),
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
