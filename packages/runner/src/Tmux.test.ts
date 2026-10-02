// Runs a harmless shell script in real tmux. Skipped when tmux isn't installed.
import { afterAll, describe, expect, test } from "bun:test"
import { tmpdir } from "node:os"
import { BunServices } from "@effect/platform-bun"
import { Effect, Fiber, Layer, Redacted, Stream } from "effect"
import { RunnerConfig } from "./RunnerConfig.ts"
import { sessionId, waitFor } from "./testSupport.ts"
import { type PaneEvent, Tmux, TmuxLive } from "./Tmux.ts"

const socket = `claude-hub-test-${process.pid}`

const TestTmux = TmuxLive.pipe(
  Layer.provide(
    Layer.succeed(
      RunnerConfig,
      RunnerConfig.of({
        hubUrl: new URL("http://hub.test"),
        name: "test",
        token: Redacted.make("token"),
        login: undefined,
        sessionsRoot: tmpdir(),
        modDir: tmpdir(),
        claudeBin: "claude",
        tmuxSocket: socket,
        repoUrlTemplate: "{repo}",
      }),
    ),
  ),
  Layer.provide(BunServices.layer),
)

afterAll(() => {
  Bun.spawnSync(["tmux", "-L", socket, "kill-server"])
})

describe.skipIf(Bun.which("tmux") === null)("TmuxLive", () => {
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
      expect(yield* tmux.list).toContain(id)

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

      yield* pane.resize({ cols: 70, rows: 12 })
      yield* pane.input("hé\r")
      yield* waitFor(Effect.sync(() => output(events).includes("got:hé")))
      expect(events.at(-1)).toMatchObject({ _tag: "Output", size: { cols: 70, rows: 12 } })

      yield* Fiber.join(pump)
      expect(events.at(-1)).toEqual({ _tag: "Exited", exitCode: 7 })

      yield* tmux.kill(id)
      expect(yield* tmux.list).not.toContain(id)
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
      // The dead pane is kept, so a restarted Runner still finds the Session and its exit status.
      expect(yield* tmux.list).toContain(id)
      const pane = yield* tmux.attach(id)
      const events = yield* pane.events.pipe(Stream.runCollect)
      expect(events.at(-1)).toEqual({ _tag: "Exited", exitCode: 3 })
      yield* tmux.kill(id)
    })

    await Effect.runPromise(program.pipe(Effect.scoped, Effect.provide(TestTmux)))
  }, 15_000)
})

function snapshots(events: ReadonlyArray<PaneEvent>): Array<string> {
  return events.flatMap((event) => (event._tag === "Snapshot" ? [event.data] : []))
}

function output(events: ReadonlyArray<PaneEvent>): string {
  return events.map((event) => (event._tag === "Output" ? event.data : "")).join("")
}
