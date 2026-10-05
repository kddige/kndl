// Runs a harmless shell script in real tmux. Skipped when tmux isn't installed.
import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Effect, Fiber, Layer, Redacted, Stream } from "effect"
import { RunnerConfig } from "./RunnerConfig.ts"
import { sessionId, waitFor } from "./testSupport.ts"
import {
  environmentChanges,
  lastOutputOf,
  type PaneEvent,
  paneEnvironment,
  parseServerEnvironment,
  Tmux,
  TmuxLive,
} from "./Tmux.ts"

const socket = `claude-hub-test-${process.pid}`

const tmuxOn = (tmuxSocket: string) =>
  TmuxLive.pipe(
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
          tmuxSocket,
          repoUrlTemplate: "{repo}",
        }),
      ),
    ),
    Layer.provide(BunServices.layer),
  )

const TestTmux = tmuxOn(socket)

/** Sockets of servers a test started itself, as another process would have, to stop after. */
const foreignSockets: Array<string> = []

afterAll(() => {
  for (const name of [socket, ...foreignSockets]) Bun.spawnSync(["tmux", "-L", name, "kill-server"])
})

/**
 * Starts a tmux server on a socket of its own the way a Runner run from a checkout since deleted
 * left one (#105): its global environment has `PWD` set to a directory that no longer exists and
 * an old `PATH`. With `session`, it keeps a session that isn't a Session's.
 */
function foreignServer(options: { readonly session: boolean }): {
  readonly socket: string
  readonly deleted: string
} {
  const name = `claude-hub-test-${process.pid}-foreign-${foreignSockets.length}`
  foreignSockets.push(name)
  const deleted = realpathSync(mkdtempSync(join(tmpdir(), "claude-hub-deleted-checkout-")))
  const env: Record<string, string | undefined> = {
    ...process.env,
    PWD: deleted,
    OLDPWD: deleted,
    PATH: `${deleted}/bin:/usr/bin:/bin`,
  }
  delete env.TMUX
  const command = options.session
    ? ["new-session", "-d", "-s", "elsewhere", "sleep 600"]
    : ["start-server", ";", "set-option", "-g", "exit-empty", "off"]
  const started = Bun.spawnSync([Bun.which("tmux") ?? "tmux", "-L", name, ...command], {
    cwd: deleted,
    env,
  })
  if (started.exitCode !== 0) throw new Error(`tmux: ${started.stderr.toString()}`)
  rmSync(deleted, { recursive: true })
  return { socket: name, deleted }
}

function serverEnvironment(on: string): Record<string, string> {
  const shown = Bun.spawnSync(["tmux", "-L", on, "show-environment", "-g"])
  return parseServerEnvironment(shown.stdout.toString())
}

describe("paneEnvironment", () => {
  test("sets PWD to the directory it starts in and PATH to the Runner's", () => {
    expect(
      paneEnvironment({ cwd: "/sessions/s-1/claude", env: { GREETING: "hi" } }, "/runner/bin"),
    ).toEqual({ PATH: "/runner/bin", GREETING: "hi", PWD: "/sessions/s-1/claude" })
  })

  test("lets a launch's own PATH win, but never its PWD", () => {
    expect(
      paneEnvironment({ cwd: "/here", env: { PATH: "/own/bin", PWD: "/there" } }, "/runner/bin"),
    ).toEqual({ PATH: "/own/bin", PWD: "/here" })
  })
})

describe("the tmux server's environment", () => {
  test("is read from show-environment, without the variables it lists as unset", () => {
    expect(parseServerEnvironment("PATH=/usr/bin:/bin\n-OLDPWD\nPWD=/gone\nEMPTY=\n")).toEqual({
      PATH: "/usr/bin:/bin",
      PWD: "/gone",
      EMPTY: "",
    })
  })

  test("says what refreshing it to the Runner's changes", () => {
    expect(environmentChanges({ PATH: "/old/bin", PWD: "/gone" }, "/runner/bin")).toEqual([
      "PATH was /old/bin",
      "PWD was /gone",
    ])
    expect(environmentChanges({ PATH: "/runner/bin" }, "/runner/bin")).toEqual([])
  })
})

describe("lastOutputOf", () => {
  test("keeps the end of what the pane shows as plain text", () => {
    const screen =
      "\n\u001b[1m\u001b[31mError:\u001b[0m The current working directory was deleted   \n" +
      "\u001b]0;title\u0007bye\n\n\nPane is dead (status 1, Mon Oct  5 12:00:00 2026)\n\n"
    expect(lastOutputOf(screen)).toBe("Error: The current working directory was deleted\nbye")
  })

  test("keeps only the last lines, and at most so many characters of them", () => {
    const screen = Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n")
    expect(lastOutputOf(screen).split("\n")).toEqual(
      Array.from({ length: 40 }, (_, i) => `line ${60 + i}`),
    )
    expect(lastOutputOf(screen, 40, 12)).toBe("e 98\nline 99")
  })

  test("is empty for a blank pane", () => {
    expect(lastOutputOf("\n\n  \n")).toBe("")
  })
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

  test("keeps what a process printed before it exited, for after it is gone", async () => {
    const id = sessionId("tmux-3")
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

  test("starts a process in its own directory on a server whose PWD was deleted (#105)", async () => {
    const foreign = foreignServer({ session: true })
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), "claude-hub-session-")))
    const id = sessionId("tmux-4")
    const program = Effect.gen(function* () {
      const tmux = yield* Tmux
      // Claude Code reads PWD, not getcwd(), to tell its working directory: so does this.
      yield* tmux.launch({
        sessionId: id,
        cwd,
        argv: ["sh", "-c", 'printf "pwd=%s\\npath=%s\\n" "$PWD" "$PATH"; exit 1'],
        env: {},
        size: { cols: 200, rows: 10 },
      })
      const pane = yield* tmux.attach(id)
      yield* pane.events.pipe(Stream.runDrain)
      const printed = yield* tmux.lastOutput(id)
      yield* tmux.kill(id)
      return printed
    })

    const printed = await Effect.runPromise(
      program.pipe(Effect.scoped, Effect.provide(tmuxOn(foreign.socket))),
    )
    expect(printed).toContain(`pwd=${cwd}`)
    expect(printed).not.toContain(foreign.deleted)
    expect(printed).toContain(`path=${process.env.PATH}`)
    rmSync(cwd, { recursive: true })
  }, 15_000)

  test("replaces a server another process left with no sessions", async () => {
    const foreign = foreignServer({ session: false })
    expect(serverEnvironment(foreign.socket).PWD).toBe(foreign.deleted)

    const claim = await Effect.runPromise(
      Effect.gen(function* () {
        return yield* (yield* Tmux).claimServer
      }).pipe(Effect.provide(tmuxOn(foreign.socket))),
    )

    expect(claim).toEqual({
      _tag: "Replaced",
      changed: [
        `PATH was ${foreign.deleted}/bin:/usr/bin:/bin`,
        `PWD was ${foreign.deleted}`,
        `OLDPWD was ${foreign.deleted}`,
      ],
    })
    const gone = Bun.spawnSync(["tmux", "-L", foreign.socket, "list-sessions"])
    expect(gone.exitCode).not.toBe(0)
  }, 15_000)

  test("keeps a server with sessions, giving it the Runner's environment", async () => {
    const foreign = foreignServer({ session: true })

    const program = Effect.gen(function* () {
      const tmux = yield* Tmux
      const first = yield* tmux.claimServer
      // Nothing is left to change the second time.
      const second = yield* tmux.claimServer
      return [first, second]
    })
    const [first, second] = await Effect.runPromise(
      program.pipe(Effect.provide(tmuxOn(foreign.socket))),
    )

    expect(first).toMatchObject({ _tag: "Refreshed", sessions: 1 })
    expect(second).toEqual({ _tag: "Refreshed", sessions: 1, changed: [] })
    const environment = serverEnvironment(foreign.socket)
    expect(environment.PWD).toBeUndefined()
    expect(environment.OLDPWD).toBeUndefined()
    expect(environment.PATH).toBe(process.env.PATH)
    const kept = Bun.spawnSync(["tmux", "-L", foreign.socket, "list-sessions", "-F", "#S"])
    expect(kept.stdout.toString().trim()).toBe("elsewhere")
  }, 15_000)

  test("finds no server on a socket nothing runs on", async () => {
    const claim = await Effect.runPromise(
      Effect.gen(function* () {
        return yield* (yield* Tmux).claimServer
      }).pipe(Effect.provide(tmuxOn(`claude-hub-test-${process.pid}-none`))),
    )
    expect(claim).toEqual({ _tag: "NoServer" })
  })
})

function snapshots(events: ReadonlyArray<PaneEvent>): Array<string> {
  return events.flatMap((event) => (event._tag === "Snapshot" ? [event.data] : []))
}

function output(events: ReadonlyArray<PaneEvent>): string {
  return events.map((event) => (event._tag === "Output" ? event.data : "")).join("")
}
