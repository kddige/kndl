// Drives real microsandbox VMs, so it is skipped unless CLAUDE_HUB_SANDBOX_IT=1. It needs `msb`
// installed for the current user, the `docker:dind` image (pulled on first run) and network
// access for one small Docker Hub pull. Everything it creates is named claude-hub-it-… and
// destroyed at the end, pass or fail.
//
//   CLAUDE_HUB_SANDBOX_IT=1 bun test packages/runner/src/sandbox/MicrosandboxBackend.integration.test.ts

import { expect, test } from "bun:test"
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { SessionId } from "@claude-hub/protocol"
import { Deferred, Duration, Effect, Fiber, Option, Schedule, Stream } from "effect"
import { Sandbox } from "microsandbox"
import * as MicrosandboxBackend from "./MicrosandboxBackend.ts"
import { reconcileSandboxes } from "./Reconcile.ts"
import { SandboxBackend, shell } from "./SandboxBackend.ts"
import { sessionSandboxSpec } from "./SessionLayout.ts"

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

test.skipIf(!enabled)(
  "a Session's Sandbox boots, runs commands, and keeps its data across stop, start and re-create",
  async () => {
    const sessionId = `it-${Date.now().toString(36)}` as SessionId
    const workspace = await mkdtemp(join(tmpdir(), "claude-hub-it-"))
    const spec = sessionSandboxSpec({
      sessionId,
      image: "docker:dind",
      workspaceHostPath: workspace,
      env: { REPO_SECRET: "s3cret" },
      cpus: 2,
      memoryMib: 1024,
      rootDiskMib: 4096,
      workspaceQuotaMib: 8192,
      dependencySizeMib: 1024,
      cacheSizeMib: 1024,
      dockerSizeMib: 4096,
    })
    // Every other Sandbox on this machine, other Runners' included; we must leave them exactly
    // as they were.
    const others = () =>
      Sandbox.list().then((page) =>
        page.sandboxes
          .filter((s) => s.name !== `claude-hub-${sessionId}`)
          .map((s) => [s.name, s.status]),
      )
    const othersBefore = await others()

    const program = Effect.gen(function* () {
      const backend = yield* SandboxBackend
      const sh = (script: string) => backend.exec(sessionId, shell(script))

      yield* timed("create (boot + dockerd)", backend.create(spec))
      expect(yield* backend.state(sessionId)).toBe("Running")

      // Commands: exit code, both streams, env, working directory.
      const result = yield* timed(
        "exec round trip",
        sh("echo out; echo err >&2; echo $REPO_SECRET; pwd; exit 3"),
      )
      expect(result).toEqual({ exitCode: 3, stdout: "out\ns3cret\n/workspace\n", stderr: "err\n" })

      // Streaming: output arrives while the command is still running.
      const first = yield* timed(
        "first streamed chunk of a 2 s command",
        backend
          .execStream(sessionId, shell("echo one; sleep 2; echo two"))
          .pipe(Stream.take(1), Stream.runCollect),
      )
      expect(first.map((e) => e._tag)).toEqual(["Stdout"])

      // Spawning: a command answers what is written to its stdin while it keeps running.
      const echoed = yield* timed(
        "spawn: write and read back over stdin",
        Effect.scoped(
          Effect.gen(function* () {
            const command = yield* backend.spawn(sessionId, { command: "cat" })
            const firstChunk = yield* Deferred.make<string>()
            const collecting = yield* command.events.pipe(
              Stream.tap((e) =>
                e._tag === "Stdout" ? Deferred.succeed(firstChunk, text(e.data)) : Effect.void,
              ),
              Stream.runCollect,
              Effect.forkChild,
            )
            yield* command.write("ping\n")
            expect(yield* Deferred.await(firstChunk)).toBe("ping\n")
            yield* command.write("pong\n")
            yield* command.closeStdin
            return yield* Fiber.join(collecting)
          }),
        ),
      )
      expect(
        echoed.map((e) => (e._tag === "Exit" ? `exit ${e.exitCode}` : text(e.data))).join(""),
      ).toBe("ping\npong\nexit 0")

      // Files: the rootfs, the Workspace, a dependency volume, the cache volume.
      yield* backend.writeFile(sessionId, "/root/marker", "rootfs")
      yield* timed("writeFile", backend.writeFile(sessionId, "/workspace/README.md", "workspace"))
      yield* backend.writeFile(sessionId, "/workspace/node_modules/dep.js", "dependency")
      yield* backend.writeFile(sessionId, "/var/cache/claude-hub/bun/pkg", "cached")
      yield* backend.writeFile(sessionId, "/workspace/a/b/deep.txt", "deep")
      expect(text(yield* backend.readFile(sessionId, "/workspace/a/b/deep.txt"))).toBe("deep")
      expect(
        text(yield* timed("readFile", backend.readFile(sessionId, "/workspace/README.md"))),
      ).toBe("workspace")
      expect((yield* Effect.flip(backend.readFile(sessionId, "/nope")))._tag).toBe(
        "SandboxBackendError",
      )
      yield* sh("printf '#!/bin/sh\\n' > /workspace/run.sh && chmod 755 /workspace/run.sh")

      // The Workspace is on the host, with modes kept; node_modules is not.
      expect(yield* Effect.promise(() => readFile(join(workspace, "README.md"), "utf8"))).toBe(
        "workspace",
      )
      expect((yield* Effect.promise(() => stat(join(workspace, "run.sh")))).mode & 0o777).toBe(
        0o755,
      )
      expect(yield* Effect.promise(() => readdir(join(workspace, "node_modules")))).toEqual([])

      // Docker, with a container that should come back after a clean stop.
      const run = yield* timed(
        "docker run (pull alpine)",
        // --init so the container exits on SIGTERM instead of waiting out docker stop's timeout.
        sh("docker run -d --init --name keep alpine sleep 3600"),
      )
      expect(run.exitCode).toBe(0)

      // Metrics come once the VM has settled.
      const metrics = yield* backend.metrics(sessionId).pipe(
        Effect.flatMap((m) => (Option.isSome(m) ? Effect.succeed(m.value) : Effect.fail("none"))),
        Effect.retry({ times: 40, schedule: Schedule.spaced("250 millis") }),
        Effect.orDie,
      )
      expect(metrics.memoryLimitBytes).toBeGreaterThan(0)

      yield* timed("stop (docker stop + VM stop)", backend.stop(sessionId))
      expect(yield* backend.state(sessionId)).toBe("Stopped")
      expect(yield* backend.metrics(sessionId)).toEqual(Option.none())
      expect((yield* Effect.flip(sh("true")))._tag).toBe("SandboxNotRunning")

      yield* timed("start (boot + dockerd + containers)", backend.start(sessionId))
      expect(text(yield* backend.readFile(sessionId, "/root/marker"))).toBe("rootfs")
      expect(text(yield* backend.readFile(sessionId, "/workspace/node_modules/dep.js"))).toBe(
        "dependency",
      )
      expect(text(yield* backend.readFile(sessionId, "/var/cache/claude-hub/bun/pkg"))).toBe(
        "cached",
      )
      expect((yield* sh("echo $REPO_SECRET")).stdout).toBe("s3cret\n")
      expect((yield* sh("docker ps --format '{{.Names}}'")).stdout).toBe("keep\n")

      // A new Sandbox on the same volumes: the rootfs is fresh, the volumes are not.
      yield* timed("destroy keeping volumes", backend.destroy(sessionId, { keepVolumes: true }))
      expect(yield* backend.state(sessionId)).toBe("Destroyed")
      yield* timed("create on existing volumes", backend.create(spec))
      expect((yield* Effect.flip(backend.readFile(sessionId, "/root/marker")))._tag).toBe(
        "SandboxBackendError",
      )
      expect(text(yield* backend.readFile(sessionId, "/workspace/node_modules/dep.js"))).toBe(
        "dependency",
      )
      expect((yield* sh("docker ps -a --format '{{.Names}}'")).stdout).toBe("keep\n")

      // Reconciling with no Session known: only this Runner's Sandbox gets stopped.
      const report = yield* timed("reconcile", reconcileSandboxes([]))
      expect(report.unknown.map((u) => [u.sessionId, u.runner, u.state, u.stopped])).toEqual([
        [sessionId, `it-${sessionId}`, "Stopped", true],
      ])
      expect(report.others.map((o) => o.sessionId)).not.toContain(sessionId)
      expect(report.unknown[0]?.volumes.length).toBe(3)
      expect(yield* backend.state(sessionId)).toBe("Stopped")
    })

    const cleanup = Effect.gen(function* () {
      const backend = yield* SandboxBackend
      yield* timed("destroy", backend.destroy(sessionId))
      const left = (yield* backend.list).filter((listing) => listing.sessionId === sessionId)
      expect(left).toEqual([])
    })

    try {
      await Effect.runPromise(
        program.pipe(
          Effect.ensuring(cleanup.pipe(Effect.orDie)),
          Effect.scoped,
          Effect.provide(MicrosandboxBackend.layerFor(`it-${sessionId}`)),
        ),
      )
    } finally {
      await rm(workspace, { recursive: true, force: true })
      console.log(
        timings
          .map(([label, ms]) => `${label.padEnd(40)} ${ms.toFixed(0).padStart(6)} ms`)
          .join("\n"),
      )
    }
    expect(await others()).toEqual(othersBefore)
  },
  600_000,
)
