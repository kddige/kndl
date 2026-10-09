// `kndl forward` end to end (#180): a real Hub and Runner, whose Session's Sandbox is faked
// with servers on this machine standing in for the guest's (testTunnels.ts), and the CLI on a
// terminal played as one (testTerminal.ts). They run the Session in real tmux, so they are skipped
// when tmux isn't installed.

import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { createServer, type Server } from "node:net"
import type { SessionId } from "@kndl/protocol"
import {
  type GuestPort,
  removeTunnelScenes,
  stopTunnelScenes,
  tmuxMissing,
  tunnelScene,
  type TunnelScene,
  Web,
} from "@kndl/runner/src/testTunnels.ts"
import { type ForwardIo, type ForwardOutcome, type ForwardRequest, runForward } from "./Forward.ts"
import { keyboard, terminal } from "./testTerminal.ts"

if (tmuxMissing) console.warn("Skipping the forward end-to-end tests: tmux isn't installed")

const servers: Array<{ stop: () => void }> = []
afterEach(async () => {
  for (const server of servers.splice(0)) server.stop()
  await stopTunnelScenes()
})
afterAll(removeTunnelScenes)

const listen = (server: Server, port: number, host: string) =>
  new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen({ port, host, exclusive: true }, () => resolve())
  })

const close = (server: Server) => new Promise<void>((resolve) => server.close(() => resolve()))

/** A port free here on both 127.0.0.1 and ::1, where the forward listens. */
async function freePort(): Promise<number> {
  for (;;) {
    const v4 = createServer()
    await listen(v4, 0, "127.0.0.1")
    const address = v4.address()
    if (address === null || typeof address === "string") throw new Error("expected a TCP address")
    const v6 = createServer()
    const free = await listen(v6, address.port, "::1").then(
      () => true,
      () => false,
    )
    await close(v4)
    if (free) await close(v6)
    if (free) return address.port
  }
}

/**
 * A server standing in for one in the Sandbox on guest port `port`: it answers with its name, and
 * `/login` redirects to `/callback` on localhost, as an OAuth sign-in does.
 */
async function guest(name: string): Promise<GuestPort> {
  const port = await freePort()
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url)
      if (url.pathname === "/login") {
        return Response.redirect(`http://localhost:${port}/callback?code=c-42`, 302)
      }
      if (url.pathname === "/callback") {
        return new Response(`${name}: signed in with ${url.searchParams.get("code")}`)
      }
      return new Response(`${name} at ${url.pathname}`)
    },
  })
  servers.push({ stop: () => void server.stop(true) })
  return { port, addresses: ["127.0.0.1"], hostPort: server.port ?? 0 }
}

/** Waits for `check` to hold, saying what was last seen if it doesn't. */
async function until<A>(
  check: () => A | undefined | false | Promise<A | undefined | false>,
  what: () => string,
  timeoutMs = 10_000,
): Promise<A> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const found = await check()
    if (found !== undefined && found !== false) return found
    if (Date.now() > deadline) throw new Error(`Timed out: ${what()}`)
    await Bun.sleep(20)
  }
}

/** What localhost answers at `path` on `port`, or undefined if nothing listens there. */
const get = (port: number, path = "/") =>
  fetch(`http://localhost:${port}${path}`, { keepalive: false }).then(
    (response) => response.text(),
    () => undefined,
  )

const refused = (port: number) =>
  new Promise<boolean>((resolve) => {
    const socket = Bun.connect({
      hostname: "127.0.0.1",
      port,
      socket: { data() {}, open: (s) => void s.end() },
    })
    socket.then(
      () => resolve(false),
      () => resolve(true),
    )
  })

/** `kndl forward`, run on a terminal (or not), signed in as alice on `machine`. */
async function run(
  scene: TunnelScene,
  request: Partial<ForwardRequest>,
  options: { readonly tty?: boolean; readonly machine?: string } & Partial<ForwardIo> = {},
) {
  const tty = options.tty ?? true
  const term = terminal(200, tty)
  const keys = keyboard(tty)
  const abort = new AbortController()
  const token = await scene.cliToken("alice", options.machine ?? "macbook")
  const outcome: Promise<ForwardOutcome> = runForward(
    { session: undefined, ports: [], bind: undefined, ...request },
    { hub: scene.hub.url, token },
    { input: keys, output: term.output, retryMs: 50, ...options },
    abort.signal,
  )
  const text = () => (tty ? term.screen() : term.writes.join("").split("\n")).join("\n")
  return {
    term,
    keys,
    abort,
    outcome,
    text,
    /** Waits for the screen to show `pattern`. */
    shows: (pattern: string | RegExp) =>
      until(
        () => (typeof pattern === "string" ? text().includes(pattern) : pattern.test(text())),
        () => `the screen to show ${pattern}; it shows:\n${text()}`,
      ),
  }
}

/** The second Session of alice's, Active with the same ports. */
async function anotherSession(scene: TunnelScene): Promise<SessionId> {
  scene.web.send({
    _tag: "CreateSession",
    requestId: "r-2",
    repo: "acme/app",
    branch: { _tag: "Existing", name: "main", newWorkBranch: true },
  })
  const created = await scene.web.next("SessionCreated")
  const id = (created["session"] as { id: SessionId }).id
  await scene.web.next(
    "SessionUpdated",
    (message) => {
      const session = message["session"] as { id: string; state: string; openPorts?: unknown }
      return session.id === id && session.state === "Active" && session.openPorts !== undefined
    },
    10_000,
  )
  return id
}

/** The machines a presence message shows forwarding. */
const forwarding = (message: Record<string, unknown>) =>
  (message["participants"] as Array<{ forwardingFrom?: Array<string> }>).map(
    (person) => person.forwardingFrom ?? [],
  )

/** A web client in the Session, seeing its presence. */
async function watching(scene: TunnelScene, sessionId: SessionId) {
  const web = await Web.open(scene.hub, scene.cookie)
  servers.push({ stop: () => web.close() })
  web.send({ _tag: "JoinSession", sessionId })
  return {
    web,
    /** Waits for presence to show these machines forwarding. */
    forwarding: (machines: ReadonlyArray<string>) =>
      web.next(
        "PresenceChanged",
        (message) =>
          message["sessionId"] === sessionId &&
          JSON.stringify(forwarding(message).flat()) === JSON.stringify(machines),
      ),
  }
}

const sleepFromWeb = async (scene: TunnelScene, sessionId: SessionId) => {
  scene.web.send({ _tag: "SleepSession", sessionId })
  await scene.web.next("SessionUpdated", (message) => {
    const session = message["session"] as { id: string; state: string }
    return session.id === sessionId && session.state === "Asleep"
  })
}

describe.skipIf(tmuxMissing)("kndl forward", () => {
  test("forwards each Open port at localhost, an OAuth redirect too, following them as they open and close", async () => {
    const vite = await guest("vite")
    const api = await guest("api")
    const scene = await tunnelScene({ ports: [vite, api] })
    const cli = await run(scene, { session: scene.sessionId.slice(0, 6) })

    await cli.shows(`http://localhost:${vite.port}`)
    await cli.shows(new RegExp(`http://localhost:${api.port} +bun server`))
    expect(
      await until(
        () => get(vite.port, "/src/main.ts"),
        () => "vite",
      ),
    ).toBe("vite at /src/main.ts")
    expect(await get(api.port, "/login")).toBe("api: signed in with c-42")
    expect(cli.text()).toMatch(/^Forwarding [0-9a-f]{6} .* · acme\/app · Active$/m)
    expect(cli.text()).toContain("Esc: forward another Session · Ctrl-C: stop")

    // A port opens later, and one closes: no reconnecting.
    const docs = await guest("docs")
    await scene.setPorts([api, docs])
    await cli.shows(`http://localhost:${docs.port}`)
    expect(await get(docs.port)).toBe("docs at /")
    await until(
      () => !cli.text().includes(`localhost:${vite.port}`),
      () => `port ${vite.port} to be gone:\n${cli.text()}`,
    )
    expect(await refused(vite.port)).toBe(true)

    cli.keys.type("\x03")
    expect(await cli.outcome).toEqual({ _tag: "Stopped" })
    expect(cli.text()).toContain("Stopped forwarding")
    expect(await refused(api.port)).toBe(true)
    // The terminal is put back as it was.
    expect(cli.keys.raw.at(-1)).toBe(false)
    expect(cli.term.writes.at(-1)).toBe("\x1b[?25h")
  })

  test("names the process a taken port is taken by, and forwards it once it is free", async () => {
    const api = await guest("api")
    const scene = await tunnelScene({ ports: [api] })
    const squatter = createServer()
    await listen(squatter, api.port, "127.0.0.1")
    const cli = await run(
      scene,
      { session: scene.sessionId },
      {
        whoHolds: async (port) => (port === api.port ? "node (pid 4242)" : undefined),
      },
    )

    await cli.shows(`taken here by node (pid 4242): trying again until it's free`)
    await cli.shows(`kndl forward ${scene.sessionId.slice(0, 6)} ${api.port}:${api.port + 100}`)
    await close(squatter)
    await cli.shows(new RegExp(`http://localhost:${api.port} +bun server`))
    expect(await get(api.port)).toBe("api at /")
    cli.abort.abort()
    expect(await cli.outcome).toEqual({ _tag: "Stopped" })
  })

  test("forwards only the ports named, to another port here as remote:local", async () => {
    const vite = await guest("vite")
    const api = await guest("api")
    const scene = await tunnelScene({ ports: [vite, api] })
    const local = await freePort()
    const cli = await run(scene, { session: scene.sessionId, ports: [`${api.port}:${local}`] })

    await cli.shows(`http://localhost:${local}`)
    expect(cli.text()).toContain(`(port ${api.port} in the Session)`)
    expect(cli.text()).not.toContain(`localhost:${vite.port}`)
    expect(await get(local)).toBe("api at /")
    cli.abort.abort()
    await cli.outcome
  })

  test("is presence from this machine, keeps the Session awake, and ends when it's put to sleep", async () => {
    const api = await guest("api")
    const scene = await tunnelScene({ ports: [api], sleepAfterMs: 1_000 })
    const cli = await run(scene, { session: scene.sessionId })
    await cli.shows(`http://localhost:${api.port}`)

    // Idle well past the Hub's sleepAfter, with only the forward in it.
    await Bun.sleep(2_500)
    expect(cli.text()).toContain("· Active")
    expect(await get(api.port)).toBe("api at /")

    const watcher = await watching(scene, scene.sessionId)
    await watcher.forwarding(["macbook"])

    await sleepFromWeb(scene, scene.sessionId)
    expect(await cli.outcome).toEqual({
      _tag: "Failed",
      message: "The Session went asleep (Put to sleep by alice).",
    })
    expect(await refused(api.port)).toBe(true)
    await watcher.forwarding([])
  })

  test("wakes an Asleep Session", async () => {
    const api = await guest("api")
    const scene = await tunnelScene({ ports: [api] })
    await sleepFromWeb(scene, scene.sessionId)
    const cli = await run(scene, { session: scene.sessionId })
    await cli.shows(/· (Asleep|starting)/)
    await cli.shows(new RegExp(`http://localhost:${api.port} +bun server`))
    await cli.shows("· Active")
    expect(await get(api.port)).toBe("api at /")
    cli.abort.abort()
    await cli.outcome
  })

  test("Esc goes back to the picker, and the next pick forwards that Session instead", async () => {
    const api = await guest("api")
    const scene = await tunnelScene({ ports: [api] })
    const second = await anotherSession(scene)
    const cli = await run(scene, {})

    await cli.shows("Forward which Session?")
    // The Session the picker has chosen first, and the other.
    const chosen = /^> ([0-9a-f]{6})/m.exec(cli.text())?.[1]
    const [first, other] = scene.sessionId.startsWith(chosen ?? "-")
      ? [scene.sessionId, second]
      : [second, scene.sessionId]
    const inFirst = await watching(scene, first)
    cli.keys.type("\r")
    await cli.shows(`Forwarding ${first.slice(0, 6)}`)
    await cli.shows(`http://localhost:${api.port}`)
    await inFirst.forwarding(["macbook"])

    cli.keys.type("\x1b")
    await cli.shows("Forward which Session?")
    expect(cli.text()).not.toContain("Forwarding")
    expect(await refused(api.port)).toBe(true)
    await inFirst.forwarding([])

    const inOther = await watching(scene, other)
    cli.keys.type("\x1b[B\r")
    await cli.shows(`Forwarding ${other.slice(0, 6)}`)
    await cli.shows(`http://localhost:${api.port}`)
    await inOther.forwarding(["macbook"])
    expect(await get(api.port)).toBe("api at /")

    cli.keys.type("\x03")
    expect(await cli.outcome).toEqual({ _tag: "Stopped" })
  })

  test("without a terminal: lists the Active Sessions, and prints each change as a line", async () => {
    const api = await guest("api")
    const scene = await tunnelScene({ ports: [api] })
    const listed = await run(scene, {}, { tty: false })
    expect(await listed.outcome).toEqual({ _tag: "Listed" })
    expect(listed.text()).toMatch(
      new RegExp(`^${scene.sessionId.slice(0, 6)}  .*  acme/app  ${api.port}\\n$`),
    )

    const cli = await run(scene, { session: scene.sessionId }, { tty: false })
    await cli.shows(new RegExp(`http://localhost:${api.port} +bun server`))
    // Esc means nothing without a terminal.
    cli.keys.type("\x1b")
    await Bun.sleep(100)
    expect(cli.keys.raw).toEqual([])
    await scene.setPorts([])
    await cli.shows(`Port ${api.port} closed in the Session: no longer forwarded.`)
    cli.abort.abort()
    expect(await cli.outcome).toEqual({ _tag: "Stopped" })
    expect(cli.text()).not.toContain("\x1b")
    // A port open in the Session isn't said to be closed there while it opens here.
    expect(cli.text()).not.toMatch(/nothing listens|opening here/)
  })

  test("says which Sessions a prefix could mean, and when it means none", async () => {
    const api = await guest("api")
    const scene = await tunnelScene({ ports: [api] })
    const none = await run(scene, { session: "zz" }, { tty: false })
    expect(await none.outcome).toEqual({
      _tag: "Failed",
      message:
        "None of your Sessions has the id zz, or one starting with it: kndl forward with no Session lists those you can forward.",
    })
    const elsewhere = await run(
      scene,
      { session: `https://hub.example.com/sessions/${scene.sessionId}` },
      { tty: false },
    )
    expect(await elsewhere.outcome).toEqual({
      _tag: "Failed",
      message: `That Session is on https://hub.example.com, and the CLI is signed in to ${scene.hub.url}: run kndl login https://hub.example.com first.`,
    })
    const byUrl = await run(scene, { session: `${scene.hub.url}/sessions/${scene.sessionId}` })
    await byUrl.shows(`Forwarding ${scene.sessionId.slice(0, 6)}`)
    byUrl.abort.abort()
    await byUrl.outcome
  })
})
