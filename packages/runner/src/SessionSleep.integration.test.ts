// A Session's Sandbox going to sleep and waking (#12) on a real microsandbox VM, so it is skipped
// unless CLAUDE_HUB_SANDBOX_IT=1. It needs what ToolBridge.integration.test.ts needs: `msb`
// installed for the current user, the `docker:dind` image, and network access to npm the first
// time a Claude Code version is cached, and to Docker Hub for `alpine`. It runs only
// `claude mcp serve` in the VM: no model calls, no credentials. Everything it creates is named
// claude-hub-it-… and destroyed at the end, pass or fail.
//
//   CLAUDE_HUB_SANDBOX_IT=1 bun test packages/runner/src/SessionSleep.integration.test.ts

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
import { FakeHubVariables, sandboxesDefaults } from "./testSupport.ts"

const enabled = process.env.CLAUDE_HUB_SANDBOX_IT === "1"

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes)

const timings: Array<[string, number]> = []
const timed = <A, E, R>(label: string, effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.timed,
    Effect.map(([duration, value]) => {
      timings.push([label, Duration.toMillis(duration)])
      return value
    }),
  )

/** Runs `command` with the Session's Bash tool, through its bridge, as Claude Code would. */
const bash = (socket: string, command: string) =>
  Effect.gen(function* () {
    // The bridge waits for `mcp serve` on its first call after a boot.
    for (let attempt = 0; attempt < 50; attempt++) {
      const reply = yield* Effect.promise(async () => {
        const response = await fetch("http://bridge/tools/call", {
          method: "POST",
          unix: socket,
          body: JSON.stringify({ tool: "Bash", input: { command } }),
        })
        return (await response.json()) as ToolBridgeReply
      })
      if (reply._tag === "ToolRan") return JSON.stringify(reply.result)
      yield* Effect.sleep("200 millis")
    }
    return yield* Effect.die(new Error(`Bash never ran: ${command}`))
  })

test.skipIf(!enabled)(
  "a Session's Sandbox sleeps and wakes on its volumes, keeping node_modules and the Workspace",
  async () => {
    const sessionId = `it-${Date.now().toString(36)}` as SessionId
    const root = await mkdtemp(join(tmpdir(), "claude-hub-it-"))
    const directories = sessionDirectories(root, sessionId)
    await mkdir(directories.workspace, { recursive: true })
    await mkdir(directories.claude, { recursive: true })
    await writeFile(join(directories.workspace, "package.json"), '{"name":"app"}\n')
    const cacheDir =
      process.env.RUNNER_SANDBOX_CLAUDE_CACHE ?? join(homedir(), ".claude-hub", "claude-code")
    const sent: Array<RunnerToHub> = []

    // Sandboxes not the Runner's on this machine, such as a spike's: we must leave them be.
    const othersBefore = await Sandbox.list().then((page) =>
      page.sandboxes
        .filter((s) => !s.name.startsWith("claude-hub-"))
        .map((s) => [s.name, s.status]),
    )

    const program = Effect.gen(function* () {
      const sandboxes = yield* Sandboxes
      const backend = yield* SandboxBackend
      const socket = directories.toolsSocket

      yield* timed("start (create + bridge)", sandboxes.start(sessionId, directories))
      // Work done before sleeping: a dependency on its volume, a file in the Workspace, and a
      // Docker container, as a dev server would be.
      expect(
        yield* timed(
          "Bash: install, write, docker run",
          bash(
            socket,
            "mkdir -p node_modules/dep && echo dependency > node_modules/dep/index.js && " +
              "echo work > notes.txt && " +
              "docker run -d --init --name devserver alpine sleep 3600 >/dev/null && echo done",
          ),
        ),
      ).toContain("done")
      // node_modules is on the Sandbox's volume, not in the host's Workspace.
      expect(
        yield* Effect.promise(() =>
          readFile(join(directories.workspace, "node_modules", "dep", "index.js")).then(
            () => "on the host",
            () => "not on the host",
          ),
        ),
      ).toBe("not on the host")

      yield* timed("sleep (docker stop + VM stop)", sandboxes.stop(sessionId, "Sleep"))
      expect(yield* backend.state(sessionId)).toBe("Stopped")
      // Stopped, not destroyed: the volumes are there, and so is the Workspace.
      const volumes = (yield* backend.list).find((l) => l.sessionId === sessionId)?.volumes ?? []
      expect(volumes.length).toBe(3)
      expect(
        yield* Effect.promise(() => readFile(join(directories.workspace, "notes.txt"), "utf8")),
      ).toBe("work\n")

      yield* timed("wake (VM start + dockerd + bridge)", sandboxes.start(sessionId, directories))
      expect(yield* backend.state(sessionId)).toBe("Running")
      const after = yield* timed(
        "Bash after waking",
        bash(
          socket,
          "cat node_modules/dep/index.js notes.txt package.json; " +
            "docker ps --format '{{.Names}}'",
        ),
      )
      expect(after).toContain("dependency")
      expect(after).toContain("work")
      expect(after).toContain('{\\"name\\":\\"app\\"}')
      // The container was stopped cleanly and started again.
      expect(after).toContain("devserver")
      expect(text(yield* backend.readFile(sessionId, "/workspace/node_modules/dep/index.js"))).toBe(
        "dependency\n",
      )

      expect(sent.flatMap((m) => (m._tag === "SandboxStateReport" ? [m.state] : []))).toEqual([
        "Starting",
        "Running",
        "Stopping",
        "Stopped",
        "Starting",
        "Running",
      ])

      yield* sandboxes.stop(sessionId, "Sleep")
      yield* backend.exec(sessionId, shell("true")).pipe(Effect.flip)
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
        sandboxClaude: () =>
          hostClaudeVersion("claude").pipe(
            Effect.tap((version) => ensureSandboxClaude({ cacheDir, version })),
          ),
        ...sandboxesDefaults,
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
            ),
          ),
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
    const othersAfter = await Sandbox.list().then((page) =>
      page.sandboxes
        .filter((s) => !s.name.startsWith("claude-hub-"))
        .map((s) => [s.name, s.status]),
    )
    expect(othersAfter).toEqual(othersBefore)
  },
  600_000,
)
