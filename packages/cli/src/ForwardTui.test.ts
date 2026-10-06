import { describe, expect, test } from "bun:test"
import type { SessionSummary } from "@kndl/protocol"
import type { ForwardedPort } from "./ForwardPorts.ts"
import {
  Keys,
  keysOf,
  liveLines,
  type LiveView,
  type Picker,
  pickerKey,
  pickerLines,
  plain,
  Screen,
} from "./ForwardTui.ts"
import { keyboard, terminal } from "./testTerminal.ts"

const summary = (fields: Partial<Omit<SessionSummary, "id">> & { readonly id: string }) =>
  ({
    repo: "kddige/kndl",
    workBranch: "claude/fix-login",
    state: "Active",
    ...fields,
  }) as SessionSummary

const one = summary({
  id: "0b9256b9c0609f5a73defb11",
  openPorts: [{ port: 3000, addresses: ["127.0.0.1"], process: "bun server" }],
})
const two = summary({ id: "77ab12ffc0609f5a73defb33", name: "Docs" })

describe("keys", () => {
  test("arrows, Enter, Esc, Ctrl-C and q, as raw-mode stdin gives them", () => {
    expect(keysOf("\x1b[A")).toEqual(["up"])
    expect(keysOf("\x1bOB")).toEqual(["down"])
    expect(keysOf("\r")).toEqual(["enter"])
    expect(keysOf("\x1b")).toEqual(["escape"])
    expect(keysOf("\x03")).toEqual(["interrupt"])
    expect(keysOf("q")).toEqual(["quit"])
    expect(keysOf("kj")).toEqual(["up", "down"])
    // Several at once, as when keys are pressed faster than they are read.
    expect(keysOf("\x1b[B\x1b[B\r")).toEqual(["down", "down", "enter"])
  })

  test("other keys and sequences mean nothing", () => {
    expect(keysOf("x")).toEqual([])
    expect(keysOf("\x1b[C")).toEqual([])
    expect(keysOf("\x1b[1;5D")).toEqual([])
  })
})

describe("the picker", () => {
  const picker: Picker = { sessions: [one, two], selected: 0 }

  test("up and down move round it, Enter picks", () => {
    const down = pickerKey(picker, "down")
    expect(down).toEqual({ _tag: "Move", picker: { ...picker, selected: 1 } })
    expect(pickerKey({ ...picker, selected: 1 }, "down")).toEqual({
      _tag: "Move",
      picker: { ...picker, selected: 0 },
    })
    expect(pickerKey(picker, "up")).toEqual({ _tag: "Move", picker: { ...picker, selected: 1 } })
    expect(pickerKey({ ...picker, selected: 1 }, "enter")).toEqual({ _tag: "Pick", session: two })
  })

  test("Esc, q and Ctrl-C leave it", () => {
    for (const key of ["escape", "quit", "interrupt"] as const) {
      expect(pickerKey(picker, key)).toEqual({ _tag: "Cancel" })
    }
  })

  test("lists each Session with its short id, name, Repo and ports, the chosen one marked", () => {
    expect(pickerLines({ ...picker, selected: 1 }).map(plain)).toEqual([
      "Forward which Session?",
      "  0b9256  claude/fix-login  kddige/kndl  3000",
      "> 77ab12  Docs  kddige/kndl  no open ports",
      "Up and down to choose, Enter to forward, Esc to quit",
    ])
  })
})

/** A port of the live list's, forwarded unless said otherwise. */
const port = (fields: Partial<ForwardedPort> & Pick<ForwardedPort, "remote">): ForwardedPort => ({
  local: fields.remote,
  open: { port: fields.remote, addresses: ["127.0.0.1"] },
  state: { _tag: "Forwarding" },
  connections: 0,
  ...fields,
})

describe("the live list", () => {
  const view: LiveView = {
    session: one,
    addresses: ["127.0.0.1", "::1"],
    connected: true,
    status: undefined,
    canPick: true,
    ports: [
      port({
        remote: 3000,
        open: { port: 3000, addresses: ["127.0.0.1"], process: "bun server" },
        connections: 2,
      }),
      port({ remote: 3001, state: { _tag: "Taken", holder: "node (pid 4242)" } }),
      port({
        remote: 5173,
        local: 5174,
        open: { port: 5173, addresses: ["::1"], process: "node vite" },
      }),
      port({
        remote: 5432,
        open: { port: 5432, addresses: ["0.0.0.0"], process: "docker-proxy" },
      }),
      port({
        remote: 80,
        state: {
          _tag: "Refused",
          message: "Port 80 needs privileges here: forward it to a higher port, as 80:8080.",
        },
      }),
      port({ remote: 4000, open: undefined, state: { _tag: "NotOpen" } }),
      port({ remote: 4001, state: { _tag: "NotOpen" } }),
    ],
  }

  test("each port's local URL, process and Docker label, and the Session's state", () => {
    expect(liveLines(view).map(plain)).toEqual([
      "Forwarding 0b9256 claude/fix-login · kddige/kndl · Active",
      "  http://localhost:3000    bun server · 2 connections",
      "  3001                     taken here by node (pid 4242): trying again until it's free. Or forward it to another port: kndl forward 0b9256 3001:3101",
      "  http://localhost:5174    node vite (port 5173 in the Session)",
      "  http://localhost:5432    docker-proxy · Docker",
      "  80                       Port 80 needs privileges here: forward it to a higher port, as 80:8080.",
      "  4000                     nothing listens on port 4000 in the Session yet",
      "  4001                     opening here...",
      "Esc: forward another Session · Ctrl-C: stop",
    ])
  })

  test("waking, reconnecting, or no ports yet; and without a terminal, no Esc", () => {
    const waking = liveLines({
      ...view,
      session: { ...one, starting: {} as never },
      ports: [],
      status: "Waking the Session...",
      canPick: false,
    }).map(plain)
    expect(waking).toEqual([
      "Forwarding 0b9256 claude/fix-login · kddige/kndl · starting",
      "  Nothing listens in the Session yet: a port appears here once something does.",
      "Waking the Session...",
      "Ctrl-C: stop",
    ])
  })
})

describe("the screen", () => {
  test("redraws a frame in place, and prints lines above it", () => {
    const term = terminal()
    const screen = new Screen(term.output)
    screen.draw(["one", "two", "three"])
    screen.draw(["uno", "dos"])
    expect(term.screen()).toEqual(["uno", "dos"])
    screen.print("a message")
    expect(term.screen()).toEqual(["a message", "uno", "dos"])
    screen.clear()
    expect(term.screen()).toEqual(["a message"])
    screen.release()
    expect(term.writes.join("")).toContain("\x1b[?25l")
    expect(term.writes.at(-1)).toBe("\x1b[?25h")
  })

  test("cuts a line to the terminal's width, so a redraw knows its height", () => {
    const term = terminal(20)
    new Screen(term.output).draw([`\x1b[1m${"x".repeat(30)}\x1b[22m`])
    expect(term.screen()).toEqual([`${"x".repeat(19)}…`])
  })

  test("without a terminal, draws nothing and prints lines as they are", () => {
    const writes: Array<string> = []
    const screen = new Screen({ write: (text) => void writes.push(text) })
    screen.draw(["frame"])
    screen.print("\x1b[1mhello\x1b[22m")
    expect(writes).toEqual(["hello\n"])
  })
})

describe("raw mode", () => {
  test("reads keys in raw mode while started, and puts the terminal back when stopped", () => {
    const stdin = keyboard()
    const keys = new Keys(stdin)
    const pressed: Array<string> = []
    keys.start((key) => pressed.push(key))
    stdin.type("\x1b[B\r")
    keys.stop()
    stdin.type("\x1b")
    expect(pressed).toEqual(["down", "enter"])
    expect(stdin.raw).toEqual([true, false])
  })

  test("reads nothing without a terminal", () => {
    const stdin = keyboard(false)
    const keys = new Keys(stdin)
    expect(keys.available).toBe(false)
    keys.start(() => {
      throw new Error("no keys without a terminal")
    })
    stdin.type("\x1b")
    expect(stdin.raw).toEqual([])
  })
})
