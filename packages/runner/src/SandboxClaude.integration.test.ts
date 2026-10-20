// The smoke test for upgrading the pinned Claude Code (PinnedClaudeVersion): Claude Code in a real
// microsandbox VM, run as the durable agent's Claude bridge runs it, headless, on a setup token and
// talking to Anthropic directly (ADR 0026). A Turn runs Bash in the Sandbox, and the models and
// thinking levels it takes are those PinnedClaudeModels says. So it is skipped unless
// KNDL_SANDBOX_IT=1, and makes model calls (a few, on haiku) with your own setup token: the one
// in `CLAUDE_CODE_OAUTH_TOKEN`, or else, on macOS, in the Keychain item `kndl-setup-token`. It
// needs `msb` installed for the current user, and network access to Docker Hub and to npm the
// first time a Claude Code version is cached. Everything it creates is named kndl-it-… and
// destroyed at the end, pass or fail.
//
//   KNDL_SANDBOX_IT=1 bun test packages/runner/src/SandboxClaude.integration.test.ts

import { expect, test } from "bun:test"
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
import { modelProbeFlags, PinnedClaudeModels, probeModels } from "./ClaudeModels.ts"
import { harnessEnvironment } from "./HarnessEnvironment.ts"
import { HubLink } from "./HubLink.ts"
import { makeSessionTokens, SessionTokens } from "./relay/SessionTokens.ts"
import { Sandboxes } from "./Sandbox.ts"
import { claudeStateEnv } from "./sandbox/ClaudeState.ts"
import * as MicrosandboxBackend from "./sandbox/MicrosandboxBackend.ts"
import { SandboxBackend } from "./sandbox/SandboxBackend.ts"
import { ensureSandboxClaude, PinnedClaudeVersion } from "./sandbox/SandboxClaude.ts"
import { workspaceGuestPath } from "./sandbox/SessionLayout.ts"
import { sessionDirectories } from "./SessionNames.ts"
import { makeSessionSandboxes } from "./SessionSandboxes.ts"
import { FakeHubVariables, sandboxesDefaults } from "./testSupport.ts"

const enabled = process.env.KNDL_SANDBOX_IT === "1"

/** The Keychain item the setup token is looked for in on macOS, without `CLAUDE_CODE_OAUTH_TOKEN`. */
const keychainService = "kndl-setup-token"

/** Your own setup token, which the test's Claude Code runs on as a Session's runs on its Creator's. */
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

test.skipIf(!enabled)(
  `Claude Code ${PinnedClaudeVersion} runs in a Sandbox as the Claude bridge runs it: a Turn runs Bash, and it takes the models PinnedClaudeModels says`,
  async () => {
    const sessionId = `it-${Date.now().toString(36)}` as SessionId
    const root = await mkdtemp(join(tmpdir(), "kndl-it-"))
    const directories = sessionDirectories(root, sessionId)
    await mkdir(directories.workspace, { recursive: true })
    const cacheDir = process.env.RUNNER_SANDBOX_CLAUDE_CACHE ?? join(devHome.dir, "claude-code")
    const credential = setupToken()

    const program = Effect.gen(function* () {
      const sandboxes = yield* Sandboxes
      const backend = yield* SandboxBackend
      const started = yield* sandboxes.start(sessionId, directories, {
        repo: "acme/app" as RepoName,
      })
      const { env } = harnessEnvironment({
        base: { ...started.pi.env, ...claudeStateEnv },
        relayUrl: "http://127.0.0.1:9",
        sessionToken: Redacted.make("chp_it.FAKE"),
        credential,
      })
      const claude = (args: ReadonlyArray<string>) =>
        backend
          .exec(sessionId, { command: started.claude.path, args, cwd: workspaceGuestPath, env })
          .pipe(Effect.map((result) => result.stdout))

      // A Turn, headless, that runs Bash in the Sandbox.
      const answer = yield* claude([
        "-p",
        "Run `echo smoke-$((6*7)) && uname -s` with your Bash tool, then reply with its output only.",
        "--model",
        "haiku",
        "--dangerously-skip-permissions",
        "--no-session-persistence",
      ])
      expect(answer.replace(/\s+/g, " ")).toContain("smoke-42 Linux")

      // The models and thinking levels the build takes are those PinnedClaudeModels says, which
      // the Runner offers its Sessions. Asked in the Sandbox as the Claude bridge runs it.
      const models = yield* probeModels((args) => claude([...modelProbeFlags, ...args]))
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
