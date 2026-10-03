// WebSocket peers for the Hub's tests: web clients and a fake Runner that keep what they
// receive, so a test can take the messages it expects. Not part of the Hub.

import type { HubToRunner, HubToWeb } from "@claude-hub/protocol"
import { ProtocolVersion } from "@claude-hub/protocol"
import { Effect } from "effect"
import { RunnerTokens } from "./RunnerTokens.ts"
import { bearer, cookieFrom, devSignIn, stopHubs, type TestHub, webOrigin } from "./testSupport.ts"

/** Shuts down every Hub, after closing the WebSockets to it, which its shutdown waits for. */
export async function stopAll() {
  await Promise.all([...Connection.live].map((connection) => connection.close()))
  await stopHubs()
}

export type Tagged = { readonly _tag: string }
export type Web = typeof HubToWeb.Encoded
export type ToRunner = typeof HubToRunner.Encoded

/**
 * A WebSocket to the Hub that keeps what it receives, so a test can take the messages it
 * expects, in any order, and check that others never came.
 */
export class Connection<In extends Tagged> {
  /** Every connection not closed yet. */
  static readonly live = new Set<Connection<Tagged>>()
  private readonly received: Array<In> = []
  /** Every message received, taken or not, as the text that came over the socket. */
  readonly texts: Array<string> = []
  private wake: Array<() => void> = []
  readonly closed: Promise<void>

  private constructor(private readonly socket: WebSocket) {
    socket.addEventListener("message", (event) => {
      this.texts.push(String(event.data))
      this.received.push(JSON.parse(String(event.data)) as In)
      for (const wake of this.wake.splice(0)) wake()
    })
    this.closed = new Promise((resolve) =>
      socket.addEventListener("close", () => {
        Connection.live.delete(this as Connection<Tagged>)
        resolve()
      }),
    )
    Connection.live.add(this as Connection<Tagged>)
  }

  static open<In extends Tagged>(
    hub: TestHub,
    path: string,
    headers: Record<string, string>,
    hello: unknown,
  ): Promise<Connection<In>> {
    const socket = new WebSocket(`${hub.url.replace(/^http/, "ws")}${path}`, { headers })
    const connection = new Connection<In>(socket)
    return new Promise((resolve, reject) => {
      socket.addEventListener("open", () => {
        socket.send(JSON.stringify(hello))
        resolve(connection)
      })
      socket.addEventListener("error", () => reject(new Error(`could not open ${path}`)))
    })
  }

  send(message: Tagged & Record<string, unknown>) {
    this.socket.send(JSON.stringify(message))
  }

  /** The first message of this kind, and matching `where`, that hasn't been taken yet. */
  take<Tag extends In["_tag"]>(
    tag: Tag,
    where: (message: Extract<In, { _tag: Tag }>) => boolean = () => true,
  ): Promise<Extract<In, { _tag: Tag }>> {
    return this.takeWhere(
      (message): message is Extract<In, { _tag: Tag }> =>
        message._tag === tag && where(message as Extract<In, { _tag: Tag }>),
      tag,
    )
  }

  /** The first message matching `where`, of any kind, that hasn't been taken yet. */
  async takeWhere<Out extends In>(
    where: (message: In) => message is Out,
    what = "message",
  ): Promise<Out> {
    const deadline = Date.now() + 2_000
    for (;;) {
      const index = this.received.findIndex(where)
      if (index >= 0) return this.received.splice(index, 1)[0] as Out
      const left = deadline - Date.now()
      if (left <= 0) {
        throw new Error(
          `No matching ${what} came; got ${JSON.stringify(this.received, undefined, 2)}`,
        )
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, left)
        this.wake.push(() => {
          clearTimeout(timer)
          resolve()
        })
      })
    }
  }

  /** The messages of this kind not taken yet, after waiting a moment for stragglers. */
  async untaken<Tag extends In["_tag"]>(tag: Tag): Promise<Array<Extract<In, { _tag: Tag }>>> {
    await Bun.sleep(150)
    return this.received.filter((message) => message._tag === tag) as Array<
      Extract<In, { _tag: Tag }>
    >
  }

  async close() {
    if (this.socket.readyState === WebSocket.CLOSED) return
    this.socket.close(1000)
    await this.closed
  }
}

export const runnerLogin = { account: "alice@example.com" }

/** A web client signed in as `login`, welcomed and handed the lists. */
export async function openWeb(hub: TestHub, login: string, cookie?: string) {
  const signIn = cookie ?? cookieFrom(await devSignIn(hub, login))
  const web = await Connection.open<Web>(
    hub,
    "/ws/web",
    { cookie: signIn, origin: webOrigin },
    { _tag: "WebHello", protocolVersion: ProtocolVersion },
  )
  await web.take("WebWelcome")
  const runners = await web.take("RunnerList")
  const sessions = await web.take("SessionList")
  return Object.assign(web, { cookie: signIn, runners, sessions })
}

export const issueRunnerToken = (hub: TestHub, name = "mac") =>
  hub.run(Effect.flatMap(RunnerTokens, (runners) => runners.issue(name)))

/** The fake Runner, welcomed, saying it runs `sessions`. */
export async function openRunner(
  hub: TestHub,
  token: string,
  sessions: ReadonlyArray<string> = [],
) {
  const runner = await Connection.open<ToRunner>(hub, "/ws/runner", bearer(token), {
    _tag: "RunnerHello",
    protocolVersion: ProtocolVersion,
    name: "mac",
    login: runnerLogin,
    sessions,
  })
  await runner.take("RunnerWelcome")
  return runner
}
