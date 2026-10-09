// Runs a harmless shell script in real tmux, on the host standing in for a Sandbox. Skipped when
// tmux isn't installed.
import { afterAll, describe, expect, test } from "bun:test"
import { tmpdir } from "node:os"
import { BunServices } from "@effect/platform-bun"
import { Effect, Fiber, Layer, Redacted, Stream } from "effect"
import { RunnerConfig } from "./RunnerConfig.ts"
import { FakeSandboxBackend } from "./sandbox/FakeSandboxBackend.ts"
import { hostTmuxBackend, sessionId, waitFor } from "./testSupport.ts"
import { lastOutputOf, makeTmux, type PaneEvent, Tmux, TmuxLive } from "./Tmux.ts"

const socket = `kndl-test-${process.pid}`
const hostSocket = `kndl-test-${process.pid}-host`

const tmuxMissing = Bun.which("tmux") === null
// Bun doesn't say why a test was skipped, so this does.
if (tmuxMissing) console.warn("Skipping the tmux tests: tmux isn't installed")

afterAll(() => {
  if (tmuxMissing) return
  for (const name of [socket, hostSocket]) Bun.spawnSync(["tmux", "-L", name, "kill-server"])
})

const hostBackend = hostTmuxBackend({ socket })

const TestTmux = Layer.succeed(
  Tmux,
  Tmux.of({ ...makeTmux(hostBackend), retireHostServer: Effect.void }),
)

describe("lastOutputOf", () => {
  test("keeps the end of what the pane shows as plain text", () => {
    const screen =
      "\n\u001b[1m\u001b[31mError:\u001b[0m The current working directory was deleted   \n" +
      "\u001b]0;title\u0007bye\n\n\nPane is dead (status 1, Mon Oct  5 12:00:00 2026)\n\n"
    expect(lastOutputOf(screen)).toBe("Error: The current working directory was deleted\nbye")
    // Nothing, for a blank pane.
    expect(lastOutputOf("\n\n  \n")).toBe("")
  })

  test("keeps only the last lines, and at most so many characters of them", () => {
    const screen = Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n")
    expect(lastOutputOf(screen).split("\n")).toEqual(
      Array.from({ length: 40 }, (_, i) => `line ${60 + i}`),
    )
    expect(lastOutputOf(screen, 40, 12)).toBe("e 98\nline 99")
  })
})

describe.skipIf(tmuxMissing)("makeTmux", () => {
  test("runs a command in tmux, streams its terminal and reports its exit", async () => {
    const id = sessionId("tmux-1")
    // Prints its arguments (an empty one, and one ending in `;`) and an env var, echoes one line
    // back, then exits with 7.
    const script =
      'printf "ready %s [%s][%s]\\n" "$GREETING" "$1" "$2"; read line; printf "got:%s\\n" "$line"; exit 7'

    const program = Effect.gen(function* () {
      const tmux = yield* Tmux
      yield* tmux.launch({
        sessionId: id,
        cwd: tmpdir(),
        argv: ["sh", "-c", script, "sh", "", "e;"],
        env: { GREETING: "hello" },
        size: { cols: 60, rows: 10 },
      })

      const events: Array<PaneEvent> = []
      const pane = yield* tmux.attach(id)
      const pump = yield* pane.events.pipe(
        Stream.runForEach((event) => Effect.sync(() => events.push(event))),
        Effect.forkChild,
      )

      yield* waitFor(
        pane.snapshot.pipe(
          Effect.andThen(Effect.sleep("50 millis")),
          Effect.map(() => snapshots(events).some((data) => data.includes("ready"))),
        ),
      )
      const snapshot = events.find(
        (event) => event._tag === "Snapshot" && event.data.includes("ready"),
      )
      expect(snapshot).toMatchObject({ size: { cols: 60, rows: 10 } })
      expect(snapshot?._tag === "Snapshot" && snapshot.data).toContain("ready hello [][e;]")

      // A resize redraws every viewer from a snapshot at the new size; the same size again is
      // a no-op.
      yield* pane.resize({ cols: 70, rows: 12 })
      yield* pane.resize({ cols: 70, rows: 12 })
      yield* waitFor(
        Effect.sync(() =>
          events.some((event) => event._tag === "Snapshot" && event.size.cols === 70),
        ),
      )
      yield* Effect.sleep("100 millis")
      expect(events.filter((event) => event._tag === "Snapshot" && event.size.cols === 70)).toEqual(
        [
          expect.objectContaining({
            size: { cols: 70, rows: 12 },
            data: expect.stringContaining("ready"),
          }),
        ],
      )
      yield* pane.input("hé\r")
      yield* waitFor(Effect.sync(() => output(events).includes("got:hé")))
      expect(events.at(-1)).toMatchObject({ _tag: "Output", size: { cols: 70, rows: 12 } })

      yield* Fiber.join(pump)
      expect(events.at(-1)).toEqual({ _tag: "Exited", exitCode: 7 })
      yield* tmux.kill(id)
    })

    await Effect.runPromise(program.pipe(Effect.scoped, Effect.provide(TestTmux)))
  }, 15_000)

  test("reports the exit of a process that ended before anything attached", async () => {
    const id = sessionId("tmux-2")
    const program = Effect.gen(function* () {
      const tmux = yield* Tmux
      yield* tmux.launch({
        sessionId: id,
        cwd: tmpdir(),
        argv: ["sh", "-c", "exit 3"],
        env: {},
        size: { cols: 40, rows: 5 },
      })
      yield* Effect.sleep("300 millis")
      // The dead pane is kept, so its exit status can still be read.
      const pane = yield* tmux.attach(id)
      const events = yield* pane.events.pipe(Stream.runCollect)
      expect(events.at(-1)).toEqual({ _tag: "Exited", exitCode: 3 })
      yield* tmux.kill(id)
    })

    await Effect.runPromise(program.pipe(Effect.scoped, Effect.provide(TestTmux)))
  }, 15_000)

  test("gives the process the launch's PATH, which tmux takes from its client", async () => {
    const id = sessionId("tmux-path")
    const path = `/kndl-test-bin:${process.env.PATH ?? "/usr/bin:/bin"}`
    const program = Effect.gen(function* () {
      const tmux = yield* Tmux
      yield* tmux.launch({
        sessionId: id,
        cwd: tmpdir(),
        argv: ["sh", "-c", 'echo "path=$PATH"'],
        env: { PATH: path },
        size: { cols: 400, rows: 5 },
      })
      yield* Effect.sleep("300 millis")
      const printed = yield* tmux.lastOutput(id)
      expect(printed).toContain(`path=${path}`)
      yield* tmux.kill(id)
    })

    await Effect.runPromise(program.pipe(Effect.provide(TestTmux)))
  }, 15_000)

  test("terminates the process with SIGTERM, in the terminal's own Sandbox", async () => {
    const id = sessionId("tmux-3")
    const program = Effect.gen(function* () {
      const tmux = yield* Tmux
      yield* tmux.launch({
        sessionId: id,
        cwd: tmpdir(),
        argv: ["sh", "-c", 'trap "exit 5" TERM; echo up; while :; do sleep 0.1; done'],
        env: {},
        size: { cols: 40, rows: 5 },
      })
      const pane = yield* tmux.attach(id)
      const events: Array<PaneEvent> = []
      const pump = yield* pane.events.pipe(
        Stream.runForEach((event) => Effect.sync(() => events.push(event))),
        Effect.forkChild,
      )
      // The trap is set once it has printed.
      yield* waitFor(
        pane.snapshot.pipe(
          Effect.andThen(Effect.sleep("50 millis")),
          Effect.map(() => snapshots(events).some((data) => data.includes("up"))),
        ),
      )
      yield* pane.terminate
      yield* Fiber.join(pump)
      expect(events.at(-1)).toEqual({ _tag: "Exited", exitCode: 5 })
      // A dead pane is left alone.
      yield* pane.terminate
      yield* tmux.kill(id)
    })

    await Effect.runPromise(program.pipe(Effect.scoped, Effect.provide(TestTmux)))
  }, 15_000)

  test("keeps what a process printed before it exited, for after it is gone", async () => {
    const id = sessionId("tmux-4")
    const program = Effect.gen(function* () {
      const tmux = yield* Tmux
      yield* tmux.launch({
        sessionId: id,
        cwd: tmpdir(),
        argv: ["sh", "-c", 'printf "\\033[31mError:\\033[0m something broke\\n"; exit 1'],
        env: {},
        size: { cols: 60, rows: 10 },
      })
      const pane = yield* tmux.attach(id)
      const events = yield* pane.events.pipe(Stream.runCollect)
      expect(events.at(-1)).toEqual({ _tag: "Exited", exitCode: 1 })

      expect(yield* tmux.lastOutput(id)).toBe("Error: something broke")
      yield* tmux.kill(id)
      expect(yield* tmux.lastOutput(id)).toBe("")
    })

    await Effect.runPromise(program.pipe(Effect.scoped, Effect.provide(TestTmux)))
  }, 15_000)

  test("reads back a variable the process was launched with, while it runs (#157)", async () => {
    const id = sessionId("tmux-6")
    const program = Effect.gen(function* () {
      const tmux = yield* Tmux
      yield* tmux.launch({
        sessionId: id,
        cwd: tmpdir(),
        argv: ["sh", "-c", "read line; exit 0"],
        env: { KNDL_MOD_TOKEN: "chp_kept=1" },
        size: { cols: 40, rows: 5 },
      })
      expect(yield* tmux.variable(id, "KNDL_MOD_TOKEN")).toBe("chp_kept=1")
      expect(yield* tmux.variable(id, "KNDL_MOD")).toBeUndefined()
      expect(yield* tmux.variable(sessionId("tmux-none"), "KNDL_MOD_TOKEN")).toBeUndefined()

      // Not once the process has exited.
      const pane = yield* tmux.attach(id)
      yield* pane.input("\r")
      const events = yield* pane.events.pipe(Stream.runCollect)
      expect(events.at(-1)).toEqual({ _tag: "Exited", exitCode: 0 })
      expect(yield* tmux.variable(id, "KNDL_MOD_TOKEN")).toBeUndefined()
      yield* tmux.kill(id)
    })

    await Effect.runPromise(program.pipe(Effect.scoped, Effect.provide(TestTmux)))
  }, 15_000)

  test("says what tmux said when a launch fails, never what it was given", async () => {
    const id = sessionId("tmux-5")
    const launch = (secret: string) =>
      Effect.gen(function* () {
        const tmux = yield* Tmux
        yield* tmux.launch({
          sessionId: id,
          cwd: tmpdir(),
          argv: ["sleep", "5"],
          env: { KNDL_MOD_TOKEN: secret },
          size: { cols: 40, rows: 5 },
        })
      })
    const program = Effect.gen(function* () {
      yield* launch("first")
      // The tmux session exists already.
      const error = yield* Effect.flip(launch("s3cret"))
      expect(error.message).toContain("duplicate session")
      expect(error.message).not.toContain("s3cret")
      yield* (yield* Tmux).kill(id)
    })

    await Effect.runPromise(program.pipe(Effect.provide(TestTmux)))
  }, 15_000)
})

describe.skipIf(tmuxMissing)("TmuxLive", () => {
  test("stops the tmux server Sessions ran on before they moved into their Sandboxes", async () => {
    const started = Bun.spawnSync(["tmux", "-L", hostSocket, "new-session", "-d", "sleep 600"], {
      env: { ...process.env, TMUX: undefined },
    })
    expect(started.exitCode).toBe(0)

    const layer = TmuxLive.pipe(
      Layer.provide(FakeSandboxBackend.layer()),
      Layer.provide(
        Layer.succeed(
          RunnerConfig,
          RunnerConfig.of({
            hubUrl: new URL("http://hub.test"),
            name: "test",
            token: Redacted.make("token"),
            sessionsRoot: tmpdir(),
            modDir: tmpdir(),
            tmuxSocket: hostSocket,
            repoUrlTemplate: "{repo}",
          }),
        ),
      ),
      Layer.provide(BunServices.layer),
    )
    const program = Effect.gen(function* () {
      const tmux = yield* Tmux
      yield* tmux.retireHostServer
      // Nothing is left to stop the second time.
      yield* tmux.retireHostServer
    })
    await Effect.runPromise(program.pipe(Effect.provide(layer)))

    expect(Bun.spawnSync(["tmux", "-L", hostSocket, "list-sessions"]).exitCode).not.toBe(0)
  }, 15_000)
})

function snapshots(events: ReadonlyArray<PaneEvent>): Array<string> {
  return events.flatMap((event) => (event._tag === "Snapshot" ? [event.data] : []))
}

function output(events: ReadonlyArray<PaneEvent>): string {
  return events.map((event) => (event._tag === "Output" ? event.data : "")).join("")
}
