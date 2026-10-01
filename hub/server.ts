// claude-hub: the server every Claude Code session, runner and browser talks to.
//
//   sessions (hub-link mod)  POST /agent/events, GET /agent/commands (long-poll)
//   runners                  WebSocket /runner
//   browsers                 WebSocket /ws, plus the UI at /
//
// Env: PORT (7777), HOST (127.0.0.1), HUB_TOKEN (required by everyone when set).

import { Database } from 'bun:sqlite'
import type { ServerWebSocket } from 'bun'

const PORT = Number(process.env.PORT ?? 7777)
const HOST = process.env.HOST ?? '127.0.0.1'
const TOKEN = process.env.HUB_TOKEN ?? ''
const OFFLINE_AFTER_MS = 45_000
const HISTORY_LIMIT = 5_000
const MAX_POLL_WAIT_MS = 25_000

if (HOST !== '127.0.0.1' && HOST !== 'localhost' && !TOKEN) {
  console.warn('⚠  listening beyond localhost without HUB_TOKEN: anyone who can reach this port can run code on your sessions')
}

// ── storage ────────────────────────────────────────────────────────────────

const db = new Database(`${import.meta.dir}/hub.db`)
db.run('pragma journal_mode = wal')
db.run(`create table if not exists sessions (
  id text primary key, machine text, cwd text, model text, status text,
  created integer, last_seen integer, cost_usd real, context_percent real, managed integer
)`)
db.run(`create table if not exists events (
  seq integer primary key autoincrement, session text, ts integer, type text, data text
)`)
db.run('create index if not exists events_session on events (session, seq)')

type Status = 'starting' | 'idle' | 'busy' | 'offline' | 'ended'
type Session = {
  id: string
  machine: string
  cwd: string
  model: string
  status: Status
  created: number
  lastSeen: number
  costUsd: number | null
  contextPercent: number | null
  managed: boolean
}
type HubEvent = { type: string; ts: number; author?: string; [key: string]: unknown }
type Command = { type: 'prompt'; text: string; author: string } | { type: 'abort' }

const sessions = new Map<string, Session>()
for (const row of db.query('select * from sessions').all() as any[]) {
  sessions.set(row.id, {
    id: row.id,
    machine: row.machine,
    cwd: row.cwd,
    model: row.model,
    status: row.status === 'ended' ? 'ended' : 'offline',
    created: row.created,
    lastSeen: row.last_seen,
    costUsd: row.cost_usd,
    contextPercent: row.context_percent,
    managed: !!row.managed,
  })
}

const saveSession = db.prepare(`insert or replace into sessions
  (id, machine, cwd, model, status, created, last_seen, cost_usd, context_percent, managed)
  values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
const persist = (s: Session) =>
  saveSession.run(s.id, s.machine, s.cwd, s.model, s.status, s.created, s.lastSeen, s.costUsd, s.contextPercent, s.managed ? 1 : 0)

const insertEvent = db.prepare('insert into events (session, ts, type, data) values (?, ?, ?, ?)')
const readHistory = db.prepare(
  'select data from (select seq, data from events where session = ? order by seq desc limit ?) order by seq',
)

function ensureSession(id: string): Session {
  let s = sessions.get(id)
  if (!s) {
    s = {
      id, machine: '?', cwd: '?', model: '?', status: 'starting', created: Date.now(), lastSeen: Date.now(),
      costUsd: null, contextPercent: null, managed: false,
    }
    sessions.set(id, s)
  }
  return s
}

// ── live connections ───────────────────────────────────────────────────────

type BrowserData = { kind: 'browser'; name: string; watching: string | null }
type RunnerData = { kind: 'runner'; machine: string; roots: string[] }
type SocketData = BrowserData | RunnerData

const browsers = new Set<ServerWebSocket<BrowserData>>()
const runners = new Map<string, ServerWebSocket<RunnerData>>()
const queues = new Map<string, Command[]>()
const waiters = new Map<string, () => void>()
const screens = new Map<string, string>() // latest tmux screen per runner-managed session; live only

const send = (ws: ServerWebSocket<any>, msg: unknown) => ws.send(JSON.stringify(msg))

function viewersOf(sessionId: string) {
  return [...new Set([...browsers].filter(b => b.data.watching === sessionId).map(b => b.data.name))]
}

function snapshot() {
  return {
    type: 'state',
    sessions: [...sessions.values()].sort((a, b) => b.lastSeen - a.lastSeen).map(s => ({ ...s, viewers: viewersOf(s.id) })),
    machines: [...runners.values()].map(r => ({ machine: r.data.machine, roots: r.data.roots })),
    online: [...new Set([...browsers].map(b => b.data.name))],
  }
}

let broadcastPending = false
function broadcastState() {
  if (broadcastPending) return
  broadcastPending = true
  queueMicrotask(() => {
    broadcastPending = false
    const msg = JSON.stringify(snapshot())
    for (const b of browsers) b.send(msg)
  })
}

function toWatchers(sessionId: string, msg: unknown) {
  const text = JSON.stringify(msg)
  for (const b of browsers) if (b.data.watching === sessionId) b.send(text)
}

function record(sessionId: string, event: HubEvent) {
  insertEvent.run(sessionId, event.ts, event.type, JSON.stringify(event))
  toWatchers(sessionId, { type: 'event', session: sessionId, event })
}

function enqueue(sessionId: string, command: Command) {
  const queue = queues.get(sessionId) ?? []
  queue.push(command)
  queues.set(sessionId, queue)
  waiters.get(sessionId)?.()
}

// ── session events (from the mod) ──────────────────────────────────────────

function applyEvent(s: Session, event: HubEvent) {
  switch (event.type) {
    case 'hello':
      s.machine = String(event.machine ?? s.machine)
      s.cwd = String(event.cwd ?? s.cwd)
      s.model = String(event.model ?? s.model)
      s.managed = event.isRunnerManaged === true
      s.status = 'idle'
      break
    case 'turn_start':
      s.status = 'busy'
      break
    case 'turn_end':
      if (event.agentId == null) s.status = 'idle'
      if (typeof event.costUsd === 'number') s.costUsd = event.costUsd
      if (typeof event.contextPercent === 'number') s.contextPercent = event.contextPercent
      break
    case 'bye':
      s.status = 'ended'
      break
  }
}

async function handleAgentEvents(req: Request) {
  const body = (await req.json()) as { session: string; events: HubEvent[] }
  if (!body?.session || !Array.isArray(body.events)) return new Response('bad request', { status: 400 })
  const s = ensureSession(body.session)
  s.lastSeen = Date.now()
  if (s.status === 'offline') s.status = 'idle'
  for (const event of body.events) {
    applyEvent(s, event)
    record(s.id, event)
  }
  persist(s)
  broadcastState()
  return Response.json({ ok: true })
}

async function handleAgentCommands(url: URL) {
  const sessionId = url.searchParams.get('session')
  if (!sessionId) return new Response('missing session', { status: 400 })
  const wait = Math.min(Number(url.searchParams.get('wait') ?? 0), MAX_POLL_WAIT_MS)

  const s = ensureSession(sessionId)
  const wasOffline = s.status === 'offline' || s.status === 'starting'
  s.lastSeen = Date.now()
  if (s.status === 'offline') s.status = 'idle'
  if (wasOffline) broadcastState()

  if (!(queues.get(sessionId)?.length) && wait > 0) {
    waiters.get(sessionId)?.() // a newer poll replaces an older one
    await new Promise<void>(resolve => {
      const timer = setTimeout(done, wait)
      function done() {
        clearTimeout(timer)
        if (waiters.get(sessionId) === done) waiters.delete(sessionId)
        resolve()
      }
      waiters.set(sessionId, done)
    })
  }
  const commands = queues.get(sessionId) ?? []
  queues.delete(sessionId)
  s.lastSeen = Date.now()
  return Response.json({ commands, viewers: viewersOf(sessionId) })
}

// ── browser messages ───────────────────────────────────────────────────────

type BrowserMsg =
  | { type: 'hello'; name: string }
  | { type: 'watch'; session: string | null }
  | { type: 'prompt'; session: string; text: string }
  | { type: 'abort'; session: string }
  | { type: 'chat'; session: string; text: string }
  | { type: 'spawn'; machine: string; cwd: string; permissionMode?: string }
  | { type: 'kill'; session: string }
  | { type: 'keys'; session: string; keys: { text?: string; key?: string }[] }

function onBrowserMessage(ws: ServerWebSocket<BrowserData>, msg: BrowserMsg) {
  switch (msg.type) {
    case 'hello':
      ws.data.name = String(msg.name).slice(0, 40) || 'anon'
      broadcastState()
      return
    case 'watch': {
      ws.data.watching = msg.session
      if (msg.session) {
        const rows = readHistory.all(msg.session, HISTORY_LIMIT) as { data: string }[]
        send(ws, { type: 'history', session: msg.session, events: rows.map(r => JSON.parse(r.data)) })
        const screen = screens.get(msg.session)
        if (screen !== undefined) send(ws, { type: 'screen', session: msg.session, text: screen })
      }
      broadcastState()
      return
    }
    case 'prompt': {
      const text = String(msg.text).trim()
      if (!text || !sessions.has(msg.session)) return
      enqueue(msg.session, { type: 'prompt', text, author: ws.data.name })
      record(msg.session, { type: 'queued', ts: Date.now(), author: ws.data.name, text })
      return
    }
    case 'abort':
      enqueue(msg.session, { type: 'abort' })
      record(msg.session, { type: 'abort_requested', ts: Date.now(), author: ws.data.name })
      return
    case 'chat': {
      const text = String(msg.text).trim()
      if (text) record(msg.session, { type: 'chat', ts: Date.now(), author: ws.data.name, text })
      return
    }
    case 'spawn': {
      const runner = runners.get(msg.machine)
      if (!runner) return send(ws, { type: 'error', text: `machine ${msg.machine} is not connected` })
      const id = crypto.randomUUID()
      const s = ensureSession(id)
      Object.assign(s, { machine: msg.machine, cwd: msg.cwd, managed: true, status: 'starting' })
      persist(s)
      record(id, { type: 'spawned', ts: Date.now(), author: ws.data.name, cwd: msg.cwd })
      send(runner, { type: 'spawn', session: id, cwd: msg.cwd, permissionMode: msg.permissionMode })
      send(ws, { type: 'spawned', session: id })
      broadcastState()
      return
    }
    case 'kill':
    case 'keys': {
      const s = sessions.get(msg.session)
      const runner = s && runners.get(s.machine)
      if (runner) send(runner, msg)
      return
    }
  }
}

function onRunnerMessage(ws: ServerWebSocket<RunnerData>, msg: any) {
  if (msg.type === 'register') {
    ws.data.machine = String(msg.machine)
    ws.data.roots = Array.isArray(msg.roots) ? msg.roots.map(String) : []
    runners.set(ws.data.machine, ws)
    console.log(`runner online: ${ws.data.machine}`)
    broadcastState()
  } else if (msg.type === 'screen') {
    screens.set(String(msg.session), String(msg.text))
    toWatchers(String(msg.session), { type: 'screen', session: msg.session, text: msg.text })
  } else if (msg.type === 'started') {
    record(String(msg.session), { type: 'started', ts: Date.now(), tmux: String(msg.tmux), machine: ws.data.machine })
  } else if (msg.type === 'error') {
    record(String(msg.session), { type: 'error', ts: Date.now(), text: String(msg.text) })
  } else if (msg.type === 'exited') {
    const s = sessions.get(String(msg.session))
    screens.delete(String(msg.session))
    toWatchers(String(msg.session), { type: 'screen', session: msg.session, text: null })
    if (s && s.status !== 'ended') {
      s.status = 'ended'
      persist(s)
      record(s.id, { type: 'bye', ts: Date.now(), reason: 'process exited' })
      broadcastState()
    }
  }
}

// ── housekeeping ───────────────────────────────────────────────────────────

setInterval(() => {
  const now = Date.now()
  let changed = false
  for (const s of sessions.values()) {
    if ((s.status === 'idle' || s.status === 'busy') && now - s.lastSeen > OFFLINE_AFTER_MS) {
      s.status = 'offline'
      persist(s)
      changed = true
    }
  }
  if (changed) broadcastState()
}, 5_000)

// ── server ─────────────────────────────────────────────────────────────────

function authorized(req: Request, url: URL) {
  if (!TOKEN) return true
  const header = req.headers.get('authorization')
  return header === `Bearer ${TOKEN}` || url.searchParams.get('token') === TOKEN
}

const server = Bun.serve<SocketData, {}>({
  port: PORT,
  hostname: HOST,
  idleTimeout: 60,
  async fetch(req, server) {
    const url = new URL(req.url)

    if (url.pathname === '/' || url.pathname === '/index.html') {
      return new Response(Bun.file(`${import.meta.dir}/public/index.html`))
    }
    if (!authorized(req, url)) return new Response('unauthorized', { status: 401 })

    if (url.pathname === '/ws') {
      const data: BrowserData = { kind: 'browser', name: 'anon', watching: null }
      return server.upgrade(req, { data }) ? undefined : new Response('upgrade failed', { status: 400 })
    }
    if (url.pathname === '/runner') {
      const data: RunnerData = { kind: 'runner', machine: '', roots: [] }
      return server.upgrade(req, { data }) ? undefined : new Response('upgrade failed', { status: 400 })
    }
    if (url.pathname === '/agent/events' && req.method === 'POST') return handleAgentEvents(req)
    if (url.pathname === '/agent/commands') return handleAgentCommands(url)
    if (url.pathname === '/api/state') return Response.json(snapshot())
    return new Response('not found', { status: 404 })
  },
  websocket: {
    open(ws) {
      if (ws.data.kind === 'browser') {
        browsers.add(ws as ServerWebSocket<BrowserData>)
        send(ws, snapshot())
      }
    },
    message(ws, raw) {
      let msg: any
      try {
        msg = JSON.parse(String(raw))
      } catch {
        return
      }
      if (ws.data.kind === 'browser') onBrowserMessage(ws as ServerWebSocket<BrowserData>, msg)
      else onRunnerMessage(ws as ServerWebSocket<RunnerData>, msg)
    },
    close(ws) {
      if (ws.data.kind === 'browser') browsers.delete(ws as ServerWebSocket<BrowserData>)
      else if (runners.get(ws.data.machine) === ws) {
        runners.delete(ws.data.machine)
        console.log(`runner offline: ${ws.data.machine}`)
      }
      broadcastState()
    },
  },
})

console.log(`claude-hub listening on http://${server.hostname}:${server.port}`)
