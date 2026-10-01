// claude-hub runner: one per machine. Starts Claude Code sessions in tmux when
// the hub asks, mirrors their screens, types keys into them, and reports exits.
//
// Env: HUB_URL (http://127.0.0.1:7777), HUB_TOKEN, HUB_MACHINE (hostname),
//      HUB_ROOTS (comma-separated folders offered in the UI, default $HOME),
//      CLAUDE_BIN (claude)

import { existsSync, statSync } from 'node:fs'
import { hostname, homedir } from 'node:os'
import { resolve } from 'node:path'

const HUB_URL = (process.env.HUB_URL ?? 'http://127.0.0.1:7777').replace(/\/$/, '')
const TOKEN = process.env.HUB_TOKEN ?? ''
const MACHINE = process.env.HUB_MACHINE ?? hostname().split('.')[0]!
const ROOTS = (process.env.HUB_ROOTS ?? homedir()).split(',').map(r => resolve(r.trim().replace(/^~/, homedir())))
const CLAUDE = process.env.CLAUDE_BIN ?? 'claude'
const MOD_DIR = resolve(import.meta.dir, '../mod')
const PREFIX = 'hub-'
const SCREEN_MS = 700

const PERMISSION_MODES = new Set(['default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions'])
const NAMED_KEYS = new Set(['Enter', 'Escape', 'Up', 'Down', 'Left', 'Right', 'Tab', 'BTab', 'BSpace', 'C-c', 'C-d', 'Space'])

let ws: WebSocket | null = null
const tracked = new Map<string, { tmux: string; lastScreen: string }>() // hub session id → tmux session

const send = (msg: unknown) => ws?.readyState === WebSocket.OPEN && ws.send(JSON.stringify(msg))

async function tmux(...args: string[]) {
  const proc = Bun.spawn(['tmux', ...args], { stdout: 'pipe', stderr: 'pipe' })
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
  return { out, err, code }
}

const tmuxName = (session: string) => `${PREFIX}${session.slice(0, 8)}`

async function adoptExisting() {
  // Sessions started before this runner (re)started keep running in tmux.
  const { out } = await tmux('list-sessions', '-F', '#{session_name} #{HUB_SESSION}')
  for (const line of out.split('\n')) {
    const [name] = line.split(' ')
    if (!name?.startsWith(PREFIX)) continue
    const env = await tmux('show-environment', '-t', name, 'HUB_SESSION')
    const id = env.out.trim().split('=')[1]
    if (id) tracked.set(id, { tmux: name, lastScreen: '' })
  }
  if (tracked.size) console.log(`adopted ${tracked.size} running session(s)`)
}

function insideRoots(dir: string) {
  return ROOTS.some(root => dir === root || dir.startsWith(`${root}/`))
}

async function spawn(session: string, cwdRaw: string, permissionMode?: string) {
  const cwd = resolve(cwdRaw.replace(/^~/, homedir()))
  if (!insideRoots(cwd)) return send({ type: 'error', session, text: `${cwd} is outside this runner's roots (${ROOTS.join(', ')})` })
  if (!existsSync(cwd) || !statSync(cwd).isDirectory()) return send({ type: 'error', session, text: `${cwd} is not a folder on ${MACHINE}` })

  const name = tmuxName(session)
  const claudeArgs = [CLAUDE, '--plugin-dir', MOD_DIR]
  if (permissionMode && PERMISSION_MODES.has(permissionMode)) claudeArgs.push('--permission-mode', permissionMode)

  const env = { HUB_URL, HUB_SESSION: session, HUB_MACHINE: MACHINE, ...(TOKEN ? { HUB_TOKEN: TOKEN } : {}) }
  const envArgs = Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`])
  const started = await tmux('new-session', '-d', '-s', name, '-x', '160', '-y', '48', '-c', cwd, ...envArgs, ...claudeArgs)
  if (started.code !== 0) return send({ type: 'error', session, text: `tmux failed: ${started.err.trim()}` })

  tracked.set(session, { tmux: name, lastScreen: '' })
  console.log(`started ${name} in ${cwd}`)
  send({ type: 'started', session, tmux: name })
}

async function kill(session: string) {
  const t = tracked.get(session)
  if (!t) return
  await tmux('kill-session', '-t', t.tmux)
}

async function sendKeys(session: string, keys: { text?: string; key?: string }[]) {
  const t = tracked.get(session)
  if (!t) return
  for (const k of keys) {
    if (k.key && NAMED_KEYS.has(k.key)) await tmux('send-keys', '-t', t.tmux, k.key)
    else if (typeof k.text === 'string' && k.text) await tmux('send-keys', '-t', t.tmux, '-l', k.text)
  }
  void mirror() // show the effect promptly
}

async function mirror() {
  for (const [session, t] of tracked) {
    const shot = await tmux('capture-pane', '-p', '-e', '-t', t.tmux)
    if (shot.code !== 0) {
      tracked.delete(session)
      send({ type: 'exited', session })
      console.log(`${t.tmux} exited`)
      continue
    }
    if (shot.out !== t.lastScreen) {
      t.lastScreen = shot.out
      send({ type: 'screen', session, text: shot.out })
    }
  }
}

function connect() {
  const url = `${HUB_URL.replace(/^http/, 'ws')}/runner${TOKEN ? `?token=${encodeURIComponent(TOKEN)}` : ''}`
  ws = new WebSocket(url)
  ws.onopen = () => {
    console.log(`connected to ${HUB_URL} as ${MACHINE}`)
    send({ type: 'register', machine: MACHINE, roots: ROOTS })
    for (const t of tracked.values()) t.lastScreen = '' // resend screens
  }
  ws.onmessage = ev => {
    const msg = JSON.parse(String(ev.data))
    if (msg.type === 'spawn') void spawn(msg.session, msg.cwd, msg.permissionMode)
    else if (msg.type === 'kill') void kill(msg.session)
    else if (msg.type === 'keys') void sendKeys(msg.session, msg.keys ?? [])
  }
  ws.onclose = () => {
    ws = null
    setTimeout(connect, 2_000)
  }
  ws.onerror = () => ws?.close()
}

const which = Bun.spawnSync(['which', 'tmux'])
if (which.exitCode !== 0) {
  console.error('tmux is required: brew install tmux')
  process.exit(1)
}

await adoptExisting()
connect()
setInterval(() => void mirror(), SCREEN_MS)
console.log(`runner ${MACHINE}: roots ${ROOTS.join(', ')}; mod ${MOD_DIR}`)
