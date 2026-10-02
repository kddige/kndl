// The tool bridge on a real microsandbox VM, so it is skipped unless CLAUDE_HUB_SANDBOX_IT=1. It
// needs `msb` installed for the current user, the `docker:dind` image, and network access to
// npm the first time a Claude Code version is cached (to RUNNER_SANDBOX_CLAUDE_CACHE, by default
// ~/.claude-hub/claude-code, as the Runner does). It runs only `claude mcp serve` in the VM: no
// model calls, no credentials. Everything it creates is named claude-hub-it-… and destroyed at
// the end, pass or fail.
//
//   CLAUDE_HUB_SANDBOX_IT=1 bun test packages/runner/src/ToolBridge.integration.test.ts

import { expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import type { RunnerToHub, SessionId, ToolBridgeReply } from "@claude-hub/protocol"
import { Duration, Effect, Layer } from "effect"
import { Sandbox } from "microsandbox"
import { HubLink } from "./HubLink.ts"
import { Sandboxes } from "./Sandbox.ts"
import * as MicrosandboxBackend from "./sandbox/MicrosandboxBackend.ts"
import { SandboxBackend, shell } from "./sandbox/SandboxBackend.ts"
import { ensureSandboxClaude, hostClaudeVersion } from "./sandbox/SandboxClaude.ts"
import { sessionDirectories } from "./SessionNames.ts"
import { makeSessionSandboxes } from "./SessionSandboxes.ts"

const enabled = process.env.CLAUDE_HUB_SANDBOX_IT === "1"

const timings: Array<[string, number]> = []
const timed = <A, E, R>(label: string, effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.timed,
    Effect.map(([duration, value]) => {
      timings.push([label, Duration.toMillis(duration)])
      console.log(`${label}: ${Duration.toMillis(duration).toFixed(0)} ms`)
      return value
    }),
  )

const call = (socket: string, tool: string, input: Record<string, unknown>) =>
  Effect.promise(async () => {
    const response = await fetch("http://bridge/tools/call", {
      method: "POST",
      unix: socket,
      body: JSON.stringify({ tool, input }),
    })
    return (await response.json()) as ToolBridgeReply
  })

const resultOf = (reply: ToolBridgeReply) => {
  if (reply._tag !== "ToolRan") throw new Error(`expected ToolRan, got ${JSON.stringify(reply)}`)
  return JSON.stringify(reply.result)
}

test.skipIf(!enabled)(
  "a Session's tools run in its Sandbox through the bridge's socket",
  async () => {
    const sessionId = `it-${Date.now().toString(36)}` as SessionId
    const root = await mkdtemp(join(tmpdir(), "claude-hub-it-"))
    const directories = sessionDirectories(root, sessionId)
    await mkdir(directories.workspace, { recursive: true })
    await mkdir(directories.claude, { recursive: true })
    await writeFile(join(directories.workspace, "greeting.txt"), "hello from the host\n")
    const cacheDir =
      process.env.RUNNER_SANDBOX_CLAUDE_CACHE ?? join(homedir(), ".claude-hub", "claude-code")
    const sent: Array<RunnerToHub> = []

    const foreignBefore = await Sandbox.list().then((page) =>
      page.sandboxes
        .filter((s) => !s.name.startsWith("claude-hub-"))
        .map((s) => [s.name, s.status]),
    )

    const program = Effect.gen(function* () {
      const sandboxes = yield* Sandboxes
      const backend = yield* SandboxBackend
      const { toolsSocket: socket } = directories

      yield* timed("start: boot + bridge", sandboxes.start(sessionId, directories))
      const read = yield* timed(
        "first Read (waits for mcp serve)",
        // The path the model uses: under the host directory Claude Code runs in.
        call(socket, "Read", { file_path: join(directories.claude, "greeting.txt") }),
      )
      expect(resultOf(read)).toContain("hello from the host")

      const bash = yield* timed(
        "Bash round trip",
        call(socket, "Bash", { command: "cat greeting.txt; pwd; uname -s; id -u" }),
      )
      const ran = resultOf(bash)
      expect(ran).toContain("hello from the host")
      expect(ran).toContain("/workspace")
      expect(ran).toContain("Linux")

      // The VM has no Claude credentials and none of the host's configuration.
      const secrets = yield* call(socket, "Bash", {
        command: "ls -a ~ ; env | grep -ci anthropic || true",
      })
      expect(resultOf(secrets)).not.toContain(".credentials")

      const write = yield* timed(
        "Write round trip",
        call(socket, "Write", {
          file_path: join(directories.claude, "from-vm.txt"),
          content: "written in the VM\n",
        }),
      )
      expect(write._tag).toBe("ToolRan")
      expect(
        yield* Effect.promise(() => readFile(join(directories.workspace, "from-vm.txt"), "utf8")),
      ).toBe("written in the VM\n")

      const failed = yield* call(socket, "Bash", { command: "exit 3" })
      expect(failed._tag).toBe("ToolFailed")

      // The server dies; the bridge starts it again.
      yield* backend.exec(sessionId, shell("pkill -f 'mcp serve' || true"))
      const again = yield* timed(
        "Bash after mcp serve was killed",
        Effect.gen(function* () {
          for (let attempt = 0; attempt < 50; attempt++) {
            const reply = yield* call(socket, "Bash", { command: "echo back" })
            if (reply._tag === "ToolRan") return reply
            yield* Effect.sleep("200 millis")
          }
          return yield* Effect.die(new Error("the tool server did not come back"))
        }),
      )
      expect(resultOf(again)).toContain("back")

      yield* timed("stop (Sleep)", sandboxes.stop(sessionId, "Sleep"))
      const asleep = yield* Effect.promise(() =>
        fetch("http://bridge/tools/call", {
          method: "POST",
          unix: socket,
          body: "{}",
        }).then(
          () => "answered",
          () => "refused",
        ),
      )
      expect(asleep).toBe("refused")
    })

    const cleanup = Effect.gen(function* () {
      const backend = yield* SandboxBackend
      yield* timed("destroy", backend.destroy(sessionId))
      const left = (yield* backend.list).filter((listing) => listing.sessionId === sessionId)
      expect(left).toEqual([])
    })

    const hub = Layer.succeed(
      HubLink,
      HubLink.of({
        send: (message) => Effect.sync(() => void sent.push(message)),
        connect: () => Effect.void,
        disconnect: Effect.void,
      }),
    )
    const sandboxes = Layer.effect(
      Sandboxes,
      makeSessionSandboxes({
        image: "docker:dind",
        claudeCacheDir: cacheDir,
        sandboxClaude: timed(
          "find or cache Claude Code",
          hostClaudeVersion("claude").pipe(
            Effect.tap((version) => ensureSandboxClaude({ cacheDir, version })),
          ),
        ),
        layout: {
          cpus: 2,
          memoryMib: 1024,
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
          // Fails before the test times out, so the clean-up always runs.
          Effect.timeoutOrElse({
            duration: "5 minutes",
            orElse: () => Effect.die(new Error("timed out")),
          }),
          Effect.ensuring(cleanup.pipe(Effect.orDie)),
          Effect.provide(sandboxes),
          Effect.provide(Layer.mergeAll(MicrosandboxBackend.layer, hub)),
          Effect.scoped,
        ),
      )
    } finally {
      await rm(root, { recursive: true, force: true })
      console.log(
        timings
          .map(([label, ms]) => `${label.padEnd(40)} ${ms.toFixed(0).padStart(6)} ms`)
          .join("\n"),
      )
    }
    const foreignAfter = await Sandbox.list().then((page) =>
      page.sandboxes
        .filter((s) => !s.name.startsWith("claude-hub-"))
        .map((s) => [s.name, s.status]),
    )
    expect(foreignAfter).toEqual(foreignBefore)
  },
  600_000,
)
