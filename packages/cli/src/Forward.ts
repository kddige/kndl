// `claude-hub forward [session] [ports...]` (#180, ADR 0016): a Session's Open ports on localhost
// here, as the CLI token's person (Login.ts).
//
// - Which Session: its id, the start of it (the short id the web shows) or its URL; with none, a
//   picker of the Active Sessions on a terminal, or their list without one.
// - Which ports: every Open port, to the same port here, as they open and close; or only those
//   named, `3000:3100` for the Session's 3000 at 3100 here (ForwardPorts.ts).
// - The forward to the Hub (ForwardHub.ts) is presence: it keeps the Session awake and shows in
//   it as forwarding from this machine, and forwarding an Asleep Session wakes it. If the Session
//   goes to sleep anyway, the forward ends, saying so. A Hub that restarts or drops is reconnected
//   to, the listeners staying up meanwhile.
// - On a terminal the list is redrawn as it changes (ForwardTui.ts): Esc stops forwarding the
//   Session and goes back to the picker, Ctrl-C stops. Without one, each change is a line.
import { ForwardCloseCode, type SessionSummary } from "@claude-hub/protocol"
import { Effect } from "effect"
import { readCliConfig } from "./CliConfig.ts"
import { fail } from "./Failure.ts"
import {
  bindAddresses,
  type PortMapping,
  parsePorts,
  parseTarget,
  resolveTarget,
  sessionLine,
  shortId,
} from "./ForwardArgs.ts"
import { ForwardLink, listSessions, type SessionListing } from "./ForwardHub.ts"
import { Forwarder, type WhoHolds } from "./ForwardPorts.ts"
import {
  type Key,
  type KeyInput,
  Keys,
  liveLines,
  type LiveView,
  pickerKey,
  pickerLines,
  plain,
  portLine,
  Screen,
  type ScreenOutput,
} from "./ForwardTui.ts"
import type { LoginContext } from "./Login.ts"
import { Cancelled } from "./Ui.ts"

/** What `forward` was given. */
export interface ForwardRequest {
  readonly session: string | undefined
  readonly ports: ReadonlyArray<string>
  readonly bind: string | undefined
}

/** Where `forward` reads keys and draws, and what tests change about it. */
export interface ForwardIo {
  readonly input: KeyInput
  readonly output: ScreenOutput
  readonly whoHolds?: WhoHolds
  /** How often a taken port is tried again. */
  readonly retryMs?: number
  /** How long to wait before reconnecting to the Hub, the nth time in a row. */
  readonly reconnectMs?: (attempt: number) => number
}

/** How `forward` ended. */
export type ForwardOutcome =
  /** Stopped with Ctrl-C. */
  | { readonly _tag: "Stopped" }
  /** The picker was left. */
  | { readonly _tag: "Cancelled" }
  /** There was no terminal to pick on: the Sessions were listed. */
  | { readonly _tag: "Listed" }
  | { readonly _tag: "Failed"; readonly message: string }

const failed = (message: string): ForwardOutcome => ({ _tag: "Failed", message })

const signedOutText =
  "This machine's CLI token isn't accepted any more: run claude-hub login to sign in again."

const notListed = (listing: Exclude<SessionListing, { _tag: "Listed" }>) =>
  failed(listing._tag === "SignedOut" ? signedOutText : listing.message)

/** 1s, 2s, 4s, ... up to 15s. */
const backoff = (attempt: number) => Math.min(1_000 * 2 ** (attempt - 1), 15_000)

interface Context {
  readonly hub: string
  readonly token: string
  readonly addresses: ReadonlyArray<string>
  readonly io: ForwardIo
  readonly screen: Screen
  readonly keys: Keys
  /** Whether there is a terminal to pick on and read keys from. */
  readonly interactive: boolean
  readonly signal: AbortSignal
}

export async function runForward(
  request: ForwardRequest,
  signIn: { readonly hub: string; readonly token: string },
  io: ForwardIo,
  signal: AbortSignal,
): Promise<ForwardOutcome> {
  const ports = parsePorts(request.ports)
  if (typeof ports === "string") return failed(ports)
  const addresses = bindAddresses(request.bind)
  if (typeof addresses === "string") return failed(addresses)
  const screen = new Screen(io.output)
  const keys = new Keys(io.input)
  const context: Context = {
    ...signIn,
    addresses,
    io,
    screen,
    keys,
    interactive: screen.live && keys.available,
    signal,
  }
  try {
    let next: SessionSummary | undefined
    let named: ReadonlyArray<PortMapping> | undefined = ports.length > 0 ? ports : undefined
    if (request.session !== undefined) {
      const found = await findSession(request.session, signIn)
      if ("_tag" in found) return found
      next = found
    }
    for (;;) {
      if (signal.aborted) return { _tag: "Stopped" }
      if (next === undefined) {
        const listing = await listSessions(signIn.hub, signIn.token)
        if (listing._tag !== "Listed") return notListed(listing)
        const active = listing.sessions.filter((session) => session.state === "Active")
        if (!context.interactive) {
          io.output.write(
            active.length === 0
              ? "None of your Sessions is Active. Name one to wake it and forward its ports: claude-hub forward <id>\n"
              : `${active.map(sessionLine).join("\n")}\n`,
          )
          return { _tag: "Listed" }
        }
        if (active.length === 0) {
          return failed(
            "None of your Sessions is Active. Name one to wake it and forward its ports: claude-hub forward <id>",
          )
        }
        const picked = await pick(active, context)
        if (picked === undefined)
          return signal.aborted ? { _tag: "Stopped" } : { _tag: "Cancelled" }
        next = picked
      }
      const ended = await forwardSession(next, named, context)
      if (ended._tag !== "Escape") return ended
      // Ports named were the first Session's: another's are all forwarded.
      next = undefined
      named = undefined
    }
  } finally {
    keys.stop()
    screen.release()
  }
}

/** The Session a `session` argument names, or why there's none. */
async function findSession(
  text: string,
  signIn: { readonly hub: string; readonly token: string },
): Promise<SessionSummary | ForwardOutcome> {
  const target = parseTarget(text)
  if (typeof target === "string") return failed(target)
  if (target._tag === "Url" && target.origin !== new URL(signIn.hub).origin) {
    return failed(
      `That Session is on ${target.origin}, and the CLI is signed in to ${signIn.hub}: run claude-hub login ${target.origin} first.`,
    )
  }
  const listing = await listSessions(signIn.hub, signIn.token)
  if (listing._tag !== "Listed") return notListed(listing)
  const resolved = resolveTarget(target.id, listing.sessions)
  switch (resolved._tag) {
    case "Found":
      return resolved.session
    case "Ambiguous":
      return failed(
        [
          `More than one Session's id starts with ${target.id}:`,
          ...resolved.matches.map((session) => `  ${sessionLine(session)}`),
          "Give more of the one to forward.",
        ].join("\n"),
      )
    case "None":
      return failed(
        `None of your Sessions has the id ${target.id}, or one starting with it: claude-hub forward with no Session lists those you can forward.`,
      )
  }
}

/** Shows the picker until a Session is picked, or it is left. */
function pick(
  sessions: ReadonlyArray<SessionSummary>,
  { screen, keys, signal }: Context,
): Promise<SessionSummary | undefined> {
  return new Promise((resolve) => {
    let picker = { sessions, selected: 0 }
    const done = (session: SessionSummary | undefined) => {
      keys.stop()
      signal.removeEventListener("abort", onAbort)
      screen.clear()
      resolve(session)
    }
    const onAbort = () => done(undefined)
    signal.addEventListener("abort", onAbort)
    screen.draw(pickerLines(picker))
    keys.start((key) => {
      const step = pickerKey(picker, key)
      switch (step._tag) {
        case "Move":
          picker = step.picker
          screen.draw(pickerLines(picker))
          return
        case "Pick":
          return done(step.session)
        case "Cancel":
          return done(undefined)
      }
    })
  })
}

type SessionEnd = ForwardOutcome | { readonly _tag: "Escape" }

/** Forwards one Session until it ends: with Esc, Ctrl-C, or the Hub ending the forward. */
function forwardSession(
  initial: SessionSummary,
  named: ReadonlyArray<PortMapping> | undefined,
  context: Context,
): Promise<SessionEnd> {
  const { hub, token, addresses, io, screen, keys, signal } = context
  return new Promise((resolve) => {
    let session = initial
    let connected = false
    /** Whether the Hub accepted this forward: a WentAsleep before that means it couldn't wake. */
    let heard = false
    let status: string | undefined =
      initial.state === "Asleep" ? "Waking the Session..." : "Connecting to the Hub..."
    let attempt = 0
    let link: ForwardLink | undefined
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined
    let finished = false
    /** Without a terminal: what was printed last, by what it was about. */
    const printed = new Map<string, string>()

    const view = (): LiveView => ({
      session,
      ports: forwarder.ports,
      addresses,
      connected,
      status,
      canPick: context.interactive,
    })

    const render = () => {
      if (finished) return
      const now = view()
      if (screen.live) return screen.draw(liveLines(now))
      // Without a terminal, a line for each change; a connection coming or going is none.
      const lines = new Map<string, string>([["session", plain(liveLines(now)[0] ?? "")]])
      if (status !== undefined) lines.set("status", status)
      for (const port of now.ports) {
        const about = `port ${port.remote}`
        // Opening here: its line comes once it is forwarded, or can't be.
        if (port.state._tag === "NotOpen" && port.open !== undefined) {
          lines.set(about, printed.get(about) ?? "")
          continue
        }
        lines.set(about, portLine({ ...port, connections: 0 }, now))
      }
      for (const [about, line] of lines) {
        if (line === "" || printed.get(about) === line) continue
        printed.set(about, line)
        screen.print(line)
      }
      for (const about of printed.keys()) {
        if (lines.has(about)) continue
        printed.delete(about)
        if (about.startsWith("port ")) {
          screen.print(`Port ${about.slice(5)} closed in the Session: no longer forwarded.`)
        }
      }
    }

    const forwarder = new Forwarder({
      hub,
      token,
      sessionId: initial.id,
      addresses,
      named,
      changed: render,
      ...(io.whoHolds !== undefined && { whoHolds: io.whoHolds }),
      ...(io.retryMs !== undefined && { retryMs: io.retryMs }),
    })

    const finish = (end: SessionEnd) => {
      if (finished) return
      finished = true
      clearTimeout(reconnectTimer)
      keys.stop()
      signal.removeEventListener("abort", onAbort)
      link?.close()
      forwarder.close()
      screen.clear()
      if (end._tag === "Stopped") screen.print(`Stopped forwarding ${shortId(initial)}.`)
      resolve(end)
    }
    const onAbort = () => finish({ _tag: "Stopped" })

    const reconnect = (why: string) => {
      attempt++
      const delay = (io.reconnectMs ?? backoff)(attempt)
      status = `${why}: reconnecting in ${Math.ceil(delay / 1000)}s...`
      render()
      reconnectTimer = setTimeout(connect, delay)
    }

    const closed = async (code: number, reason: string, rejected: string | undefined) => {
      if (finished) return
      connected = false
      if (rejected !== undefined) return finish(failed(rejected))
      switch (code) {
        case ForwardCloseCode.WentAsleep:
          return finish(
            failed(
              heard
                ? `The Session went asleep${reason === "" ? "." : ` (${reason}).`}`
                : `The Session is Asleep, and couldn't be woken${reason === "" ? "." : `: ${reason}`}`,
            ),
          )
        case ForwardCloseCode.SignedOut:
          return finish(failed(reason === "" ? signedOutText : reason))
        case ForwardCloseCode.NoSuchSession:
        case ForwardCloseCode.Archived:
        case ForwardCloseCode.AccessUnknown:
          return finish(failed(reason === "" ? `The Hub ended the forward (${code}).` : reason))
        case 1002: {
          // The Hub answered the upgrade with something other than 101: the token, or a Hub that
          // has no forwards, or none there.
          const listing = await listSessions(hub, token)
          if (finished) return
          if (listing._tag === "SignedOut") return finish(failed(signedOutText))
          if (listing._tag === "Listed") {
            return finish(failed(`${hub} refused the forward: is it older than this CLI?`))
          }
          return reconnect("Can't reach the Hub")
        }
        case ForwardCloseCode.GoingAway:
          return reconnect("The Hub restarted")
        default:
          return reconnect(heard ? "Lost the Hub" : "Can't reach the Hub")
      }
    }

    const connect = () => {
      if (finished) return
      link = new ForwardLink(hub, token, initial.id, {
        session: (changed) => {
          session = changed
          connected = true
          heard = true
          attempt = 0
          status = undefined
          forwarder.update(changed.state === "Active" ? (changed.openPorts ?? []) : [])
        },
        closed: (code, reason, rejected) => void closed(code, reason, rejected),
      })
    }

    signal.addEventListener("abort", onAbort)
    if (context.interactive) {
      keys.start((key: Key) => {
        if (key === "escape") finish({ _tag: "Escape" })
        else if (key === "interrupt" || key === "quit") finish({ _tag: "Stopped" })
      })
    }
    render()
    connect()
  })
}

/** `claude-hub forward`, as the CLI is signed in. */
export const forward = (request: ForwardRequest, on: LoginContext) =>
  Effect.gen(function* () {
    const config = readCliConfig(on.configPath)
    if (config.token === undefined || config.hub === undefined) {
      return yield* fail("The CLI isn't signed in to a Hub: run claude-hub login <hub-url>")
    }
    const signIn = { hub: config.hub, token: config.token }
    const outcome = yield* Effect.callback<ForwardOutcome>((resume) => {
      const abort = new AbortController()
      runForward(
        request,
        signIn,
        { input: process.stdin, output: process.stdout },
        abort.signal,
      ).then(
        (ended) => resume(Effect.succeed(ended)),
        (error: unknown) => resume(Effect.die(error)),
      )
      // Interrupted, as by Ctrl-C without a terminal: everything closes, and the terminal is put back.
      return Effect.sync(() => abort.abort())
    })
    if (outcome._tag === "Failed") return yield* fail(outcome.message)
    if (outcome._tag === "Cancelled") return yield* Effect.fail(new Cancelled())
  })
