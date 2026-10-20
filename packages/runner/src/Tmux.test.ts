// Runs harmless shell scripts, and a login shell, in real tmux, on the host standing in for a
// Sandbox. Skipped when tmux isn't installed.
import { afterAll, describe, expect, test } from "bun:test"
import { readFileSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { BunServices } from "@effect/platform-bun"
import type { SessionId } from "@kndl/protocol"
import { Effect, Fiber, Layer, Queue, Redacted, Stream } from "effect"
import { RunnerConfig } from "./RunnerConfig.ts"
import { FakeSandboxBackend } from "./sandbox/FakeSandboxBackend.ts"
import type { ExecEvent } from "./sandbox/SandboxBackend.ts"
import { hostTmuxBackend, sessionId, waitFor } from "./testSupport.ts"
import {
  agentSessionName,
  lastOutputOf,
  makeTmux,
  type Terminal,
  type TerminalEvent,
  Tmux,
  TmuxLive,
} from "./Tmux.ts"

const socket = `kndl-test-${process.pid}`
const hostSocket = `kndl-test-${process.pid}-host`

const tmuxMissing = Bun.which("tmux") === null
// Bun doesn't say why a test was skipped, so this does.
if (tmuxMissing) console.warn("Skipping the tmux tests: tmux isn't installed")

afterAll(() => {
  if (tmuxMissing) return
  for (const name of [socket, hostSocket, psSocket])
    Bun.spawnSync(["tmux", "-L", name, "kill-server"])
})

const hostBackend = hostTmuxBackend({ socket })

const TestTmux = Layer.succeed(
  Tmux,
  Tmux.of({ ...makeTmux(hostBackend), retireHostServer: Effect.void }),
)

/** A tmux server of the process's own, for a test that starts it. */
const psSocket = `kndl-test-${process.pid}-ps`
const psBackend = hostTmuxBackend({ socket: psSocket })
const PsTmux = Layer.succeed(
  Tmux,
  Tmux.of({ ...makeTmux(psBackend), retireHostServer: Effect.void }),
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

/** What `LEAKED` and `KEPT` an agent launched in `id` with `unset` had, as it printed them. */
const leakedIn = (id: SessionId, unset?: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const tmux = yield* Tmux
    yield* tmux.launchAgent({
      sessionId: id,
      cwd: tmpdir(),
      argv: ["sh", "-c", 'printf "[%s][%s]\\n" "${LEAKED-unset}" "$KEPT"; sleep 0.3'],
      env: { KEPT: "yes" },
      ...(unset === undefined ? {} : { unset }),
    })
    yield* (yield* tmux.attachAgent(id)).exited
    const shown = yield* tmux.lastOutput(id)
    yield* tmux.kill(id)
    return shown
  }).pipe(Effect.scoped)

/** Runs `argv` as the agent of Session `id`, with `env`. */
const launchAgent = (id: SessionId, argv: ReadonlyArray<string>, env = {}) =>
  Effect.gen(function* () {
    const tmux = yield* Tmux
    yield* tmux.launchAgent({ sessionId: id, cwd: tmpdir(), argv, env })
  })

/** The terminal of Session `id`, attached, and everything it does from now on. */
const attachTerminal = (id: SessionId) =>
  Effect.gen(function* () {
    const terminal = yield* (yield* Tmux).attachTerminal(id)
    const events: Array<TerminalEvent> = []
    const pump = yield* terminal.events.pipe(
      Stream.runForEach((event) => Effect.sync(() => events.push(event))),
      Effect.forkChild,
    )
    return { terminal, events, pump }
  })

/** Types `line` and Enter into `terminal`, and waits for its output to show `seen`. */
const run = (
  terminal: Terminal,
  events: ReadonlyArray<TerminalEvent>,
  line: string,
  seen: string,
) =>
  Effect.andThen(
    terminal.input(`${line}\r`),
    waitFor(Effect.sync(() => output(events).includes(seen))),
  )

describe.skipIf(tmuxMissing)("the agent's tmux session", () => {
  test("runs the agent with its arguments and environment, and reports its exit", async () => {
    const id = sessionId("agent-1")
    // Prints its arguments (an empty one, and one ending in `;`) and an env var, then exits 7.
    const script = 'printf "ready %s [%s][%s]\\n" "$GREETING" "$1" "$2"; sleep 0.3; exit 7'
    const program = Effect.gen(function* () {
      const tmux = yield* Tmux
      yield* launchAgent(id, ["sh", "-c", script, "sh", "", "e;"], { GREETING: "hello" })
      const agent = yield* tmux.attachAgent(id)
      expect(yield* agent.exited).toBe(7)
      expect(yield* tmux.lastOutput(id)).toBe("ready hello [][e;]")
      yield* tmux.kill(id)
    })

    await Effect.runPromise(program.pipe(Effect.scoped, Effect.provide(TestTmux)))
  }, 15_000)

  test("reports the exit of an agent that ended before anything attached", async () => {
    const id = sessionId("agent-2")
    const program = Effect.gen(function* () {
      const tmux = yield* Tmux
      yield* launchAgent(id, ["sh", "-c", "exit 3"])
      yield* Effect.sleep("300 millis")
      // The dead pane is kept, so its exit status can still be read.
      expect(yield* (yield* tmux.attachAgent(id)).exited).toBe(3)
      yield* tmux.kill(id)
    })

    await Effect.runPromise(program.pipe(Effect.scoped, Effect.provide(TestTmux)))
  }, 15_000)

  test("waits for attachment before subscribing, even with another control client active", async () => {
    const program = Effect.gen(function* () {
      const stdout = yield* Queue.unbounded<ExecEvent>()
      const commands: Array<string> = []
      // tmux can read stdin before the initial attach-session completes. Before attachment,
      // refresh-client defaults to the most active client, which can be the terminal's.
      const tmux = makeTmux({
        exec: () => Effect.succeed({ exitCode: 0, stdout: "160 50", stderr: "" }),
        spawn: () =>
          Effect.succeed({
            events: Stream.fromQueue(stdout),
            write: (command) =>
              Effect.sync(
                () =>
                  void commands.push(
                    typeof command === "string" ? command : new TextDecoder().decode(command),
                  ),
              ),
            closeStdin: Effect.void,
          }),
      })
      const agent = yield* tmux.attachAgent(sessionId("agent-attach-race"))
      const exited = yield* agent.exited.pipe(Effect.forkChild)
      yield* Effect.sleep("50 millis")
      expect(commands).toEqual([])
      yield* Queue.offer(stdout, {
        _tag: "Stdout",
        data: new TextEncoder().encode(
          "%begin 1 1 0\n%end 1 1 0\n%session-changed $0 hub-agent-attach-race-agent\n",
        ),
      })
      yield* waitFor(Effect.sync(() => commands.length === 1))
      expect(commands[0]).toContain("refresh-client -B")
      yield* Queue.offer(stdout, {
        _tag: "Stdout",
        data: new TextEncoder().encode("%subscription-changed kndl-exit $0 : 1 7 \n"),
      })
      expect(yield* Fiber.join(exited)).toBe(7)
    })

    await Effect.runPromise(program.pipe(Effect.scoped))
  }, 10_000)

  test("gives the agent the launch's PATH, which tmux takes from its client", async () => {
    const id = sessionId("agent-path")
    const path = `/kndl-test-bin:${process.env.PATH ?? "/usr/bin:/bin"}`
    const program = Effect.gen(function* () {
      const tmux = yield* Tmux
      yield* launchAgent(id, ["sh", "-c", 'echo "path=$PATH"'], { PATH: path })
      yield* Effect.sleep("300 millis")
      expect(yield* tmux.lastOutput(id)).toContain(`path=${path}`)
      yield* tmux.kill(id)
    })

    await Effect.runPromise(program.pipe(Effect.provide(TestTmux)))
  }, 15_000)

  test("terminates the agent with SIGTERM, in its own Sandbox", async () => {
    const id = sessionId("agent-3")
    const program = Effect.gen(function* () {
      const tmux = yield* Tmux
      yield* launchAgent(id, [
        "sh",
        "-c",
        'trap "exit 5" TERM; echo up; while :; do sleep 0.1; done',
      ])
      const agent = yield* tmux.attachAgent(id)
      // The trap is set once it has printed.
      yield* waitFor(Effect.map(tmux.lastOutput(id), (shown) => shown.includes("up")))
      yield* agent.terminate
      expect(yield* agent.exited).toBe(5)
      // A dead pane is left alone.
      yield* agent.terminate
      yield* tmux.kill(id)
    })

    await Effect.runPromise(program.pipe(Effect.scoped, Effect.provide(TestTmux)))
  }, 15_000)

  test("keeps what the agent printed before it exited, for after it is gone", async () => {
    const id = sessionId("agent-4")
    const program = Effect.gen(function* () {
      const tmux = yield* Tmux
      yield* launchAgent(id, [
        "sh",
        "-c",
        'printf "\\033[31mError:\\033[0m something broke\\n"; exit 1',
      ])
      expect(yield* (yield* tmux.attachAgent(id)).exited).toBe(1)

      expect(yield* tmux.lastOutput(id)).toBe("Error: something broke")
      yield* tmux.kill(id)
      expect(yield* tmux.lastOutput(id)).toBe("")
    })

    await Effect.runPromise(program.pipe(Effect.scoped, Effect.provide(TestTmux)))
  }, 15_000)

  test("reads back a variable the agent was launched with, while it runs (#157)", async () => {
    const id = sessionId("agent-6")
    const program = Effect.gen(function* () {
      const tmux = yield* Tmux
      yield* launchAgent(id, ["sh", "-c", "sleep 0.5; exit 0"], { KNDL_MOD_TOKEN: "chp_kept=1" })
      expect(yield* tmux.variable(id, "KNDL_MOD_TOKEN")).toBe("chp_kept=1")
      expect(yield* tmux.variable(id, "KNDL_MOD")).toBeUndefined()
      expect(yield* tmux.variable(sessionId("agent-none"), "KNDL_MOD_TOKEN")).toBeUndefined()

      // Not once the agent has exited.
      expect(yield* (yield* tmux.attachAgent(id)).exited).toBe(0)
      expect(yield* tmux.variable(id, "KNDL_MOD_TOKEN")).toBeUndefined()
      yield* tmux.kill(id)
    })

    await Effect.runPromise(program.pipe(Effect.scoped, Effect.provide(TestTmux)))
  }, 15_000)

  test("keeps the variables it is told to out of the agent, even ones the server has", async () => {
    const program = Effect.gen(function* () {
      // The server has a variable, as from the Sandbox's image, which a process gets by default.
      // It stays up with no session, as the launch has it.
      const server = "start-server ; set-option -g exit-empty off ; set-environment -g LEAKED image"
      yield* hostBackend.exec(sessionId("agent-env-1"), {
        command: "tmux",
        args: ["-L", socket, "-f", "/dev/null", ...server.split(" ")],
      })
      expect(yield* leakedIn(sessionId("agent-env-1"))).toBe("[image][yes]")
      expect(yield* leakedIn(sessionId("agent-env-2"), ["LEAKED"])).toBe("[unset][yes]")
    })

    await Effect.runPromise(program.pipe(Effect.scoped, Effect.provide(TestTmux)))
  }, 15_000)

  // tmux marks a pane dead when its terminal closes, and has its exit status only once it reaps
  // the process, which may be later (#296).
  test("reports the exit status of an agent that closed its terminal before it exited", async () => {
    const id = sessionId("agent-7")
    const program = Effect.gen(function* () {
      const tmux = yield* Tmux
      // Ignores the SIGHUP tmux's closing the pane sends, so it lives on past it, and exits.
      yield* launchAgent(id, [
        "sh",
        "-c",
        'trap "" HUP; exec </dev/null >/dev/null 2>&1; sleep 1.5; exit 3',
      ])
      expect(yield* (yield* tmux.attachAgent(id)).exited).toBe(3)
      yield* tmux.kill(id)
    })

    await Effect.runPromise(program.pipe(Effect.scoped, Effect.provide(TestTmux)))
  }, 15_000)

  test("reports an agent killed by a signal as exited, with no exit status", async () => {
    const id = sessionId("agent-8")
    const program = Effect.gen(function* () {
      const tmux = yield* Tmux
      yield* launchAgent(id, ["sh", "-c", "echo up; kill -KILL $$"])
      expect(yield* (yield* tmux.attachAgent(id)).exited).toBeUndefined()
      yield* tmux.kill(id)
    })

    await Effect.runPromise(program.pipe(Effect.scoped, Effect.provide(TestTmux)))
  }, 15_000)

  test("kills an agent that ignores SIGHUP and SIGTERM along with its tmux session", async () => {
    const id = sessionId("agent-stuck")
    const program = Effect.gen(function* () {
      const tmux = yield* Tmux
      // Shutting down slowly: ignoring both signals is all a stuck agent needs to outlive its tmux
      // session, and with it a relaunch's new agent would share its storage.
      yield* launchAgent(id, [
        "sh",
        "-c",
        'trap "" HUP TERM; echo "pid $$"; while :; do sleep 0.1; done',
      ])
      yield* waitFor(Effect.map(tmux.lastOutput(id), (shown) => shown.includes("pid ")))
      const pid = Number((yield* tmux.lastOutput(id)).replace("pid ", ""))
      expect(isAlive(pid)).toBe(true)

      yield* tmux.killAgent(id)
      // Gone by the time it returns, not merely told to go.
      expect(isAlive(pid)).toBe(false)
      expect(yield* tmux.lastOutput(id)).toBe("")
      // An agent already gone is no trouble.
      yield* tmux.killAgent(id)
    })

    await Effect.runPromise(program.pipe(Effect.provide(TestTmux)))
  }, 15_000)

  test.skipIf(process.platform !== "linux")(
    "never leaves the agent's secrets in the command line of the tmux server it starts",
    async () => {
      const id = sessionId("agent-ps")
      const program = Effect.gen(function* () {
        const tmux = yield* Tmux
        // A server of its own, so this launch is the one that starts it.
        yield* psBackend.exec(id, { command: "tmux", args: ["-L", psSocket, "kill-server"] })
        yield* (yield* Tmux).launchAgent({
          sessionId: id,
          cwd: tmpdir(),
          argv: ["sleep", "5"],
          env: { KNDL_MOD_TOKEN: "chp_not_in_ps" },
          unset: ["LEAKED"],
        })
        const pid = yield* psBackend.exec(id, {
          command: "tmux",
          args: [
            "-L",
            psSocket,
            "display-message",
            "-p",
            "-t",
            `=${agentSessionName(id)}:`,
            "#{pid}",
          ],
        })
        expect(pid.stdout.trim()).toMatch(/^[0-9]+$/)
        const commandLine = readFileSync(`/proc/${pid.stdout.trim()}/cmdline`, "utf8")
        expect(commandLine).toContain("start-server")
        expect(commandLine).not.toContain("chp_not_in_ps")
        expect(yield* tmux.variable(id, "KNDL_MOD_TOKEN")).toBe("chp_not_in_ps")
        yield* tmux.kill(id)
      })

      await Effect.runPromise(program.pipe(Effect.provide(PsTmux)))
    },
    15_000,
  )

  test("says what tmux said when a launch fails, never what it was given", async () => {
    const id = sessionId("agent-5")
    const launch = (secret: string) => launchAgent(id, ["sleep", "5"], { KNDL_MOD_TOKEN: secret })
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

describe.skipIf(tmuxMissing)("the terminal's tmux session", () => {
  test("runs a login shell in the Workspace, streams it, takes keystrokes and resizes", async () => {
    const id = sessionId("terminal-1")
    const program = Effect.gen(function* () {
      const tmux = yield* Tmux
      yield* tmux.launchTerminal({
        sessionId: id,
        cwd: tmpdir(),
        env: { GREETING: "hello" },
        size: { cols: 60, rows: 10 },
      })
      const { terminal, events } = yield* attachTerminal(id)
      yield* run(
        terminal,
        events,
        'echo "$GREETING-$((6*7)) $(pwd -P)"',
        `hello-42 ${realpathSync(tmpdir())}`,
      )
      expect(events.at(-1)).toMatchObject({ _tag: "Output", size: { cols: 60, rows: 10 } })

      // A snapshot draws the whole screen.
      yield* terminal.snapshot
      yield* waitFor(
        Effect.sync(() =>
          events.some((event) => event._tag === "Snapshot" && event.data.includes("hello-42")),
        ),
      )

      // A resize redraws every viewer from a snapshot at the new size; the same size again is
      // a no-op. The shell sees it.
      yield* terminal.resize({ cols: 70, rows: 12 })
      yield* terminal.resize({ cols: 70, rows: 12 })
      yield* waitFor(
        Effect.sync(() =>
          events.some((event) => event._tag === "Snapshot" && event.size.cols === 70),
        ),
      )
      yield* Effect.sleep("100 millis")
      expect(
        events.filter((event) => event._tag === "Snapshot" && event.size.cols === 70),
      ).toHaveLength(1)
      yield* run(terminal, events, "stty size", "12 70")
      // Bytes beyond ASCII arrive whole.
      yield* run(terminal, events, "echo got:hé", "got:hé\r\n")
      yield* tmux.kill(id)
    })

    await Effect.runPromise(program.pipe(Effect.scoped, Effect.provide(TestTmux)))
  }, 15_000)

  test("comes back whenever its shell exits, or the sh that runs it is killed", async () => {
    const id = sessionId("terminal-2")
    const program = Effect.gen(function* () {
      const tmux = yield* Tmux
      yield* tmux.launchTerminal({
        sessionId: id,
        cwd: tmpdir(),
        env: {},
        size: { cols: 60, rows: 10 },
      })
      const { terminal, events, pump } = yield* attachTerminal(id)
      yield* run(terminal, events, "echo one-$((0+1))", "one-1")

      // A shell that exits at once is started again only after a second.
      yield* terminal.input("exit\r")
      yield* Effect.sleep("1500 millis")
      yield* run(terminal, events, "echo two-$((1+1))", "two-2")

      // The sh that runs it, killed: tmux starts the pane again.
      yield* terminal.input("kill -KILL $PPID\r")
      yield* Effect.sleep("500 millis")
      yield* run(terminal, events, "echo three-$((1+2))", "three-3")
      expect(output(events)).not.toContain("Pane is dead")

      // Its events never ended for it.
      expect(pump.pollUnsafe()).toBeUndefined()
      yield* tmux.kill(id)
      // Once its tmux session is gone, they do.
      yield* Fiber.join(pump)
    })

    await Effect.runPromise(program.pipe(Effect.scoped, Effect.provide(TestTmux)))
  }, 15_000)

  test("comes back when bash itself is killed, with a terminal that takes input", async () => {
    const id = sessionId("terminal-4")
    const program = Effect.gen(function* () {
      const tmux = yield* Tmux
      yield* tmux.launchTerminal({
        sessionId: id,
        cwd: tmpdir(),
        env: {},
        size: { cols: 60, rows: 10 },
      })
      const { terminal, events } = yield* attachTerminal(id)
      yield* run(terminal, events, "echo one-$((0+1))", "one-1")

      // As the kernel's OOM killer would: the shell dies, and the terminal must not stay wedged on
      // a process group that is gone, where the next shell would start in the background.
      yield* terminal.input("kill -KILL $$\r")
      yield* Effect.sleep("1500 millis")
      yield* run(terminal, events, "echo two-$((1+1))", "two-2")
      expect(output(events)).not.toContain("no job control")
      yield* tmux.kill(id)
    })

    await Effect.runPromise(program.pipe(Effect.scoped, Effect.provide(TestTmux)))
  }, 15_000)

  test("hides the tmux server from the terminal, as TMUX would point a plain tmux at it", async () => {
    const id = sessionId("terminal-5")
    const program = Effect.gen(function* () {
      const tmux = yield* Tmux
      yield* tmux.launchTerminal({
        sessionId: id,
        cwd: tmpdir(),
        env: {},
        size: { cols: 60, rows: 10 },
      })
      const { terminal, events } = yield* attachTerminal(id)
      yield* run(terminal, events, 'echo "[${TMUX-none}][${TMUX_PANE-none}]"', "[none][none]")
      yield* tmux.kill(id)
    })

    await Effect.runPromise(program.pipe(Effect.scoped, Effect.provide(TestTmux)))
  }, 15_000)

  test("keeps a variable out of the agent alone, as the terminal still gets it", async () => {
    const id = sessionId("terminal-6")
    const program = Effect.gen(function* () {
      const tmux = yield* Tmux
      const server = "start-server ; set-option -g exit-empty off ; set-environment -g LEAKED image"
      yield* hostBackend.exec(id, {
        command: "tmux",
        args: ["-L", socket, "-f", "/dev/null", ...server.split(" ")],
      })
      yield* tmux.launchAgent({
        sessionId: id,
        cwd: tmpdir(),
        argv: ["sh", "-c", 'echo "agent [${LEAKED-unset}]"; sleep 5'],
        env: {},
        unset: ["LEAKED"],
      })
      yield* tmux.launchTerminal({
        sessionId: id,
        cwd: tmpdir(),
        env: {},
        size: { cols: 60, rows: 10 },
      })
      const { terminal, events } = yield* attachTerminal(id)
      yield* run(terminal, events, 'echo "terminal [${LEAKED-unset}]"', "terminal [image]")
      expect(yield* tmux.lastOutput(id)).toBe("agent [unset]")
      yield* tmux.kill(id)
    })

    await Effect.runPromise(program.pipe(Effect.scoped, Effect.provide(TestTmux)))
  }, 15_000)

  test("shows none of the agent's output, and has none of its secrets, beside it", async () => {
    const id = sessionId("terminal-3")
    const program = Effect.gen(function* () {
      const tmux = yield* Tmux
      yield* launchAgent(
        id,
        ["sh", "-c", 'while :; do echo "agent-says $AGENT_SECRET"; sleep 0.1; done'],
        { AGENT_SECRET: "chp_secret" },
      )
      yield* tmux.launchTerminal({
        sessionId: id,
        cwd: tmpdir(),
        env: {},
        size: { cols: 60, rows: 10 },
      })
      const { terminal, events } = yield* attachTerminal(id)
      yield* run(terminal, events, 'echo "[${AGENT_SECRET-none}]"', "[none]")
      yield* Effect.sleep("300 millis")
      yield* terminal.snapshot
      yield* waitFor(Effect.sync(() => events.some((event) => event._tag === "Snapshot")))
      expect(JSON.stringify(events)).not.toContain("agent-says")
      expect(JSON.stringify(events)).not.toContain("chp_secret")
      // And the agent's own screen shows nothing of the terminal's.
      const agentScreen = yield* tmux.lastOutput(id)
      expect(agentScreen).toContain("agent-says chp_secret")
      expect(agentScreen).not.toContain("[none]")

      // Its agent is killed alone, as on a relaunch: the terminal stays.
      yield* tmux.killAgent(id)
      expect(yield* tmux.variable(id, "AGENT_SECRET")).toBeUndefined()
      yield* run(terminal, events, "echo still-$((2*2))", "still-4")
      yield* tmux.kill(id)
      const sessions = yield* hostBackend.exec(id, {
        command: "tmux",
        args: ["-L", socket, "list-sessions", "-F", "#{session_name}"],
      })
      expect(sessions.stdout).not.toContain(`hub-${id}`)
      expect(sessions.stdout).not.toContain(agentSessionName(id))
    })

    await Effect.runPromise(program.pipe(Effect.scoped, Effect.provide(TestTmux)))
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

/** Whether process `pid` runs. */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Everything the terminal printed in `events`. */
function output(events: ReadonlyArray<TerminalEvent>): string {
  return events.map((event) => (event._tag === "Output" ? event.data : "")).join("")
}
