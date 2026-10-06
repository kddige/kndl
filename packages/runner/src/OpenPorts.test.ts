import { describe, expect, test } from "bun:test"
import type { RunnerToHub, SessionPorts } from "@claude-hub/protocol"
import { Effect, Layer } from "effect"
import { HubLink } from "./HubLink.ts"
import {
  ipv4FromHex,
  ipv6FromHex,
  isClaudeCode,
  makeOpenPorts,
  MaxProcessNameLength,
  OpenPorts,
  openPortsOf,
  parseProcNetTcp,
  parseSocketOwners,
  processName,
  type SocketOwner,
  samePorts,
} from "./OpenPorts.ts"
import type { FakeExecCall, FakeExecReply } from "./sandbox/FakeSandboxBackend.ts"
import { FakeSandboxBackend } from "./sandbox/FakeSandboxBackend.ts"
import { SandboxBackend } from "./sandbox/SandboxBackend.ts"
import { sandboxClaudePath } from "./sandbox/SandboxClaude.ts"
import { sessionSandboxSpec } from "./sandbox/SessionLayout.ts"
import { sessionId, waitFor } from "./testSupport.ts"

// Read from scratch Sandboxes: node:22-bookworm-slim with Node servers, and docker:dind with
// busybox nc and a container published with `-p 8081:80 -p 127.0.0.1:5432:80`.
const header =
  "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n"
const header6 =
  "  sl  local_address                         remote_address                        st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n"

const nodeTcp =
  header +
  "   0: 00000000:1F40 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 299 1 000000005bbf5d81 100 0 0 10 0\n" +
  "   1: 0100007F:0BB8 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 301 1 00000000980e0a18 100 0 0 10 0\n" +
  "   2: 0100007F:864D 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 309 1 000000005f19e709 100 0 0 10 0\n"
const nodeTcp6 =
  header6 +
  "   0: 00000000000000000000000000000000:0BB9 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 298 1 00000000cb9ada83 100 0 0 10 0\n" +
  "   1: 00000000000000000000000000000000:0FA0 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 321 1 000000008eb64be2 100 0 0 10 0\n" +
  "   2: 00000000000000000000000001000000:1435 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 308 1 00000000f420b7e4 100 0 0 10 0\n"
const nodeOwners =
  "301\t215\t/usr/local/bin/node\tnode\tnode\tserve.js\t\n" +
  "298\t216\t/usr/local/bin/node\tnode\tnode\tserve.js\t\n" +
  "308\t217\t/usr/local/bin/node\tnode\tnode\tserve.js\t\n" +
  "299\t218\t/usr/local/bin/node\tnode\tnode\tserve.js\t\n" +
  // Claude Code's /login callback, and a server its Bash tool started.
  `309\t219\t${sandboxClaudePath("2.1.289")}\tclaude\t${sandboxClaudePath("2.1.289")}\t\n` +
  "321\t255\t/usr/local/bin/node\tnode\tnode\t/srv/serve.js\t\n"

const dindTcp =
  header +
  "   0: 0100007F:0BB8 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 241 1 000000004f29ab83 100 0 0 10 0\n" +
  "   1: 0100007F:1538 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 2102 1 000000009101d3c1 100 0 0 10 0\n" +
  "   2: 00000000:1F91 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 2147 1 00000000aa0155a3 100 0 0 10 0\n" +
  "   3: 0A0010AC:BD5C D0865634:01BB 01 00000000:00000000 02:00000ADA 00000000     0        0 1916 2 00000000d286facf 21 4 28 10 -1\n" +
  "   4: 0A0010AC:BD56 D0865634:01BB 06 00000000:00000000 03:00001688 00000000     0        0 0 3 000000000295adbf\n"
const dindTcp6 =
  header6 +
  "   0: 00000000000000000000000000000000:1F91 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 2148 1 00000000c6992126 100 0 0 10 0\n"
const dindOwners =
  "241\t211\t/bin/busybox\tnc\tnc\t-lk\t\n" +
  "2102\t746\t/usr/local/bin/docker-proxy\tdocker-proxy\t/usr/local/bin/docker-proxy\t-proto\t\n" +
  "2147\t758\t/usr/local/bin/docker-proxy\tdocker-proxy\t/usr/local/bin/docker-proxy\t-proto\t\n" +
  "2148\t761\t/usr/local/bin/docker-proxy\tdocker-proxy\t/usr/local/bin/docker-proxy\t-proto\t\n"

const owner = (patch: Partial<SocketOwner>): SocketOwner => ({
  pid: 100,
  exe: "",
  comm: "",
  argv0: "",
  argv1: "",
  ...patch,
})

describe("reading /proc/net/tcp", () => {
  test("decodes IPv4 addresses, little-endian", () => {
    expect(ipv4FromHex("0100007F")).toBe("127.0.0.1")
    expect(ipv4FromHex("00000000")).toBe("0.0.0.0")
    expect(ipv4FromHex("0A0010AC")).toBe("172.16.0.10")
  })

  test("decodes IPv6 addresses, collapsing the longest run of zeros", () => {
    expect(ipv6FromHex("00000000000000000000000000000000")).toBe("::")
    expect(ipv6FromHex("00000000000000000000000001000000")).toBe("::1")
    expect(ipv6FromHex("0000000000000000FFFF00000100007F")).toBe("::ffff:127.0.0.1")
    // fd42:6d73:62::10, as the kernel writes it: four little-endian words.
    expect(ipv6FromHex("736D42FD000062000000000010000000")).toBe("fd42:6d73:62::10")
    expect(ipv6FromHex("B80D0120000000000000000001000000")).toBe("2001:db8::1")
    // A single zero group isn't collapsed.
    expect(ipv6FromHex("B80D0120000001000300020005000400")).toBe("2001:db8:1:0:2:3:4:5")
  })

  test("keeps LISTEN rows only, with their port and inode", () => {
    expect(parseProcNetTcp(dindTcp, 4)).toEqual([
      { port: 3000, address: "127.0.0.1", inode: "241" },
      { port: 5432, address: "127.0.0.1", inode: "2102" },
      { port: 8081, address: "0.0.0.0", inode: "2147" },
    ])
    expect(parseProcNetTcp(nodeTcp6, 6)).toEqual([
      { port: 3001, address: "::", inode: "298" },
      { port: 4000, address: "::", inode: "321" },
      { port: 5173, address: "::1", inode: "308" },
    ])
  })

  test("skips headers, blank lines and rows it can't read", () => {
    expect(parseProcNetTcp("", 4)).toEqual([])
    expect(parseProcNetTcp(header, 4)).toEqual([])
    expect(
      parseProcNetTcp(`${header}   0: 0100007F:zz 00000000:0000 0A 0 0 0 0 0 7\n\n`, 4),
    ).toEqual([])
    // An IPv4 row isn't read as IPv6.
    expect(parseProcNetTcp(nodeTcp, 6)).toEqual([])
  })
})

describe("naming owners", () => {
  test("parses the owners script's output, lowest pid first", () => {
    const owners = parseSocketOwners(
      "7\t30\t/usr/bin/python3\tpython3\tpython3\t-m\t\n7\t12\t/usr/bin/python3\tpython3\tpython3\t\n\ngarbage\n",
    )
    expect(owners.get("7")?.map((o) => o.pid)).toEqual([12, 30])
    expect(owners.get("7")?.[0]).toEqual({
      pid: 12,
      exe: "/usr/bin/python3",
      comm: "python3",
      argv0: "python3",
      argv1: "",
    })
    expect(owners.size).toBe(1)
  })

  test("names a process by its program, and a runtime by its script", () => {
    expect(processName(owner({ argv0: "node", argv1: "/srv/serve.js" }))).toBe("node serve")
    expect(
      processName(owner({ argv0: "/usr/local/bin/node", argv1: "node_modules/.bin/vite" })),
    ).toBe("node vite")
    expect(processName(owner({ argv0: "bun", argv1: "run" }))).toBe("bun run")
    expect(processName(owner({ argv0: "python3", argv1: "app.py" }))).toBe("python3 app")
    expect(processName(owner({ argv0: "python3", argv1: "-m" }))).toBe("python3")
    expect(processName(owner({ argv0: "/usr/local/bin/docker-proxy", argv1: "-proto" }))).toBe(
      "docker-proxy",
    )
    expect(processName(owner({ exe: "/usr/sbin/nginx" }))).toBe("nginx")
    expect(processName(owner({ comm: "MainThread" }))).toBe("MainThread")
    expect(processName(owner({}))).toBeUndefined()
    expect(processName(owner({ argv0: "x".repeat(200) }))?.length).toBe(MaxProcessNameLength)
  })

  test("tells Claude Code by where the Runner installs it", () => {
    const claude = sandboxClaudePath("2.1.289")
    expect(isClaudeCode(owner({ exe: claude, argv0: claude }))).toBe(true)
    expect(isClaudeCode(owner({ exe: claude, argv0: "claude" }))).toBe(true)
    expect(isClaudeCode(owner({ exe: "/usr/local/bin/claude", argv0: "claude" }))).toBe(false)
    expect(isClaudeCode(owner({ exe: "/usr/local/bin/node", argv0: "node" }))).toBe(false)
  })
})

describe("openPortsOf", () => {
  const report = (tcp: string, tcp6: string, owners: string) =>
    openPortsOf(
      [...parseProcNetTcp(tcp, 4), ...parseProcNetTcp(tcp6, 6)],
      parseSocketOwners(owners),
    )

  test("lists each port once, by port, with all its addresses", () => {
    expect(report(dindTcp, dindTcp6, dindOwners)).toEqual([
      { port: 3000, addresses: ["127.0.0.1"], process: "nc" },
      { port: 5432, addresses: ["127.0.0.1"], process: "docker-proxy" },
      { port: 8081, addresses: ["0.0.0.0", "::"], process: "docker-proxy" },
    ])
  })

  test("leaves out Claude Code's own port, but not one a process it started listens on", () => {
    expect(report(nodeTcp, nodeTcp6, nodeOwners)).toEqual([
      { port: 3000, addresses: ["127.0.0.1"], process: "node serve" },
      { port: 3001, addresses: ["::"], process: "node serve" },
      { port: 4000, addresses: ["::"], process: "node serve" },
      { port: 5173, addresses: ["::1"], process: "node serve" },
      { port: 8000, addresses: ["0.0.0.0"], process: "node serve" },
    ])
  })

  test("leaves out a socket Claude Code shares with another process", () => {
    const claude = sandboxClaudePath("2.1.289")
    const sockets = [{ port: 34381, address: "127.0.0.1", inode: "9" }]
    const owners = new Map([
      [
        "9",
        [
          owner({ pid: 5, argv0: "node", argv1: "x.js" }),
          owner({ pid: 9, exe: claude, argv0: claude }),
        ],
      ],
    ])
    expect(openPortsOf(sockets, owners)).toEqual([])
  })

  test("leaves out the Sandbox's own processes, and keeps a port whose owner is unknown", () => {
    const sockets = [
      { port: 2375, address: "0.0.0.0", inode: "1" },
      { port: 9000, address: "::1", inode: "2" },
    ]
    const owners = new Map([["1", [owner({ argv0: "dockerd" })]]])
    expect(openPortsOf(sockets, owners)).toEqual([{ port: 9000, addresses: ["::1"] }])
  })

  test("compares reports by their content", () => {
    const ports = report(dindTcp, dindTcp6, dindOwners)
    expect(samePorts(ports, report(dindTcp, dindTcp6, dindOwners))).toBe(true)
    expect(samePorts(ports, ports.slice(1))).toBe(false)
    expect(samePorts([], [])).toBe(true)
  })
})

describe("OpenPorts", () => {
  const s1 = sessionId("s-1")

  /** A fake Sandbox for s-1, its /proc set by the test, and what the Hub was sent. */
  const setup = (onExec: (call: FakeExecCall) => FakeExecReply) => {
    const sent: Array<RunnerToHub> = []
    const hub = Layer.succeed(
      HubLink,
      HubLink.of({
        send: (message) => Effect.sync(() => void sent.push(message)),
        connect: () => Effect.void,
        disconnect: Effect.void,
      }),
    )
    const layer = Layer.effect(OpenPorts, makeOpenPorts("20 millis")).pipe(
      Layer.provideMerge(
        FakeSandboxBackend.layer({ onExec: (call) => Effect.succeed(onExec(call)) }),
      ),
      Layer.provide(hub),
    )
    const reports = () =>
      sent.filter((m): m is SessionPorts => m._tag === "SessionPorts").map((m) => m.ports)
    const proc = (tcp: string, tcp6: string) =>
      Effect.gen(function* () {
        const backend = yield* SandboxBackend
        yield* backend.writeFile(s1, "/proc/net/tcp", tcp)
        yield* backend.writeFile(s1, "/proc/net/tcp6", tcp6)
      })
    const boot = Effect.gen(function* () {
      const backend = yield* SandboxBackend
      yield* backend.create(
        sessionSandboxSpec({
          sessionId: s1,
          image: "docker:dind",
          workspaceHostPath: "/host/s-1",
          env: {},
        }),
      )
    })
    const run = <A, E>(
      effect: Effect.Effect<A, E, OpenPorts | SandboxBackend | FakeSandboxBackend>,
    ) => Effect.runPromise(Effect.scoped(effect.pipe(Effect.provide(layer))))
    return { sent, reports, proc, boot, run }
  }

  const ownersCalls = (world: { execCalls: ReadonlyArray<FakeExecCall> }) =>
    world.execCalls.filter((call) => call.request.args?.[2] === "owners")

  test("reports the ports, names owners only when the sockets change, and sends only changes", async () => {
    const { reports, proc, boot, run } = setup(({ request }) => ({
      stdout: request.args?.includes("2148")
        ? dindOwners
        : dindOwners.split("\n").slice(0, 3).join("\n"),
    }))
    await run(
      Effect.gen(function* () {
        const world = yield* FakeSandboxBackend
        const ports = yield* OpenPorts
        yield* boot
        yield* proc(dindTcp, "")
        yield* ports.watch(s1)
        yield* waitFor(Effect.sync(() => reports().length === 1))
        expect(reports()[0]).toEqual([
          { port: 3000, addresses: ["127.0.0.1"], process: "nc" },
          { port: 5432, addresses: ["127.0.0.1"], process: "docker-proxy" },
          { port: 8081, addresses: ["0.0.0.0"], process: "docker-proxy" },
        ])
        expect(ownersCalls(world).map((call) => call.request.args?.slice(3))).toEqual([
          ["241", "2102", "2147"],
        ])

        // Nothing changes over several polls: nothing is sent, and no owner asked for again.
        const reads = world.execCalls.length
        yield* Effect.sleep("100 millis")
        expect(reports()).toHaveLength(1)
        expect(world.execCalls.length).toBe(reads)

        // A new socket: only its owner is asked for.
        yield* proc(dindTcp, dindTcp6)
        yield* waitFor(Effect.sync(() => reports().length === 2))
        expect(reports()[1]?.find((p) => p.port === 8081)?.addresses).toEqual(["0.0.0.0", "::"])
        expect(ownersCalls(world).map((call) => call.request.args?.slice(3))).toEqual([
          ["241", "2102", "2147"],
          ["2148"],
        ])

        // One goes away: no owner to ask for, and the shorter list is sent.
        yield* proc(header, dindTcp6)
        yield* waitFor(Effect.sync(() => reports().length === 3))
        expect(reports()[2]).toEqual([{ port: 8081, addresses: ["::"], process: "docker-proxy" }])
        expect(ownersCalls(world)).toHaveLength(2)
      }),
    )
  })

  test("never reports Claude Code's own port", async () => {
    const { reports, proc, boot, run } = setup(() => ({ stdout: nodeOwners }))
    await run(
      Effect.gen(function* () {
        const ports = yield* OpenPorts
        yield* boot
        yield* proc(nodeTcp, nodeTcp6)
        yield* ports.watch(s1)
        yield* waitFor(Effect.sync(() => reports().length === 1))
        expect(reports()[0]?.map((p) => p.port)).toEqual([3000, 3001, 4000, 5173, 8000])
      }),
    )
  })

  test("sends nothing while it can't tell who owns the sockets", async () => {
    const { reports, proc, boot, run } = setup(() => ({ exitCode: 1, stderr: "ls: not found" }))
    await run(
      Effect.gen(function* () {
        const world = yield* FakeSandboxBackend
        const ports = yield* OpenPorts
        yield* boot
        yield* proc(nodeTcp, nodeTcp6)
        yield* ports.watch(s1)
        yield* waitFor(Effect.sync(() => ownersCalls(world).length >= 2))
        expect(reports()).toEqual([])
      }),
    )
  })

  test("an empty Sandbox reports no ports once; unwatching says so only if it had some", async () => {
    const { reports, proc, boot, run } = setup(() => ({ stdout: dindOwners }))
    await run(
      Effect.gen(function* () {
        const world = yield* FakeSandboxBackend
        const ports = yield* OpenPorts
        yield* boot
        yield* proc(header, header6)
        yield* ports.watch(s1)
        yield* ports.watch(s1)
        yield* waitFor(Effect.sync(() => reports().length === 1))
        expect(reports()[0]).toEqual([])
        expect(ownersCalls(world)).toHaveLength(0)
        yield* ports.unwatch(s1)
        expect(reports()).toHaveLength(1)

        yield* proc(dindTcp, dindTcp6)
        yield* ports.watch(s1)
        yield* waitFor(Effect.sync(() => reports().length === 2))
        yield* ports.unwatch(s1)
        expect(reports()).toHaveLength(3)
        expect(reports()[2]).toEqual([])

        // Unwatched: no more polls, and nothing more to send.
        const execs = world.execCalls.length
        yield* proc(nodeTcp, header6)
        yield* Effect.sleep("100 millis")
        expect(reports()).toHaveLength(3)
        expect(world.execCalls.length).toBe(execs)
        yield* ports.unwatch(s1)
        expect(reports()).toHaveLength(3)
      }),
    )
  })

  test("resends what each watched Session last reported", async () => {
    const { reports, proc, boot, run } = setup(() => ({ stdout: dindOwners }))
    await run(
      Effect.gen(function* () {
        const ports = yield* OpenPorts
        yield* ports.resendAll
        expect(reports()).toEqual([])
        yield* boot
        yield* proc(dindTcp, dindTcp6)
        yield* ports.watch(s1)
        yield* waitFor(Effect.sync(() => reports().length === 1))
        yield* ports.resendAll
        expect(reports()).toHaveLength(2)
        expect(reports()[1]).toEqual(reports()[0]!)
      }),
    )
  })
})
