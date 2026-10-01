import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Link } from '../types'

// Links one Claude Code session to a claude-hub server.
//   out: every prompt, streamed text, tool call and turn end, POSTed in batches
//   in:  prompts and aborts from the web UI, long-polled
// Configured by env: HUB_URL, HUB_TOKEN, HUB_SESSION and HUB_MACHINE (the runner sets them).

const PLUGIN = 'hub-link'
const link = atom({ plugin: 'hub-link', key: 'link' } as const, {
  isConnected: false,
  viewers: [],
  queued: 0,
} as Link)

const FLUSH_MS = 150
const POLL_WAIT_MS = 15_000
const RETRY_MS = 3_000
const MAX_OUTBOX = 5_000
const MAX_TEXT = 4_000

type HubEvent = { type: string; ts: number; [key: string]: unknown }
type HubCommand =
  | { type: 'prompt'; text: string; author: string }
  | { type: 'abort' }
type PollReply = { commands: HubCommand[]; viewers: string[] }

const MULTIPLAYER_NOTE = [
  'This session is shared through claude-hub: several people may watch it and send prompts.',
  'A prompt that starts with "[name]" came from that person through the web UI; a prompt without one was typed at the terminal.',
  'When it matters who asked for what, address people by name.',
].join(' ')

// The module's own state; a reload of the module starts it over.
const hub = {
  url: 'http://127.0.0.1:7777',
  headers: { 'content-type': 'application/json' } as Record<string, string>,
  sessionKey: '',
  currentTurn: null as string | null,
  outbox: [] as HubEvent[],
  isFlushing: false,
  isLinked: false,
  thinkingIn: '', // the turn step whose thinking was already reported
}

function clip(text: string, max = MAX_TEXT) {
  return text.length > max ? `${text.slice(0, max)}… (${text.length - max} more chars)` : text
}

function push(event: { type: string; [key: string]: unknown }) {
  const last = hub.outbox[hub.outbox.length - 1]
  // Text arrives a few characters at a time: fold consecutive pieces together.
  if (
    event.type === 'text' &&
    last?.type === 'text' &&
    last.turnId === event.turnId &&
    last.agentId === event.agentId
  ) {
    last.text = `${last.text as string}${event.text as string}`
    return
  }
  hub.outbox.push({ ...event, ts: Date.now() })
  if (hub.outbox.length > MAX_OUTBOX) hub.outbox = hub.outbox.slice(-MAX_OUTBOX)
}

async function setConnected($: EngineInterface, isConnected: boolean) {
  await update($, link, value => (value.isConnected === isConnected ? value : { ...value, isConnected }))
}

async function adjustQueued($: EngineInterface, by: number) {
  await update($, link, value => ({ ...value, queued: Math.max(0, value.queued + by) }))
}

async function flush($: EngineInterface) {
  if (hub.isFlushing || hub.outbox.length === 0 || !hub.sessionKey) return
  hub.isFlushing = true
  const batch = hub.outbox
  hub.outbox = []
  try {
    const res = await $.http.fetch(`${hub.url}/agent/events`, {
      method: 'POST',
      headers: hub.headers,
      body: JSON.stringify({ session: hub.sessionKey, events: batch }),
    })
    if (!res.ok) throw new Error(`hub answered ${res.status}`)
    await setConnected($, true)
  } catch {
    hub.outbox = [...batch, ...hub.outbox].slice(-MAX_OUTBOX)
    await setConnected($, false)
  } finally {
    hub.isFlushing = false
  }
}

async function submitPrompt($: EngineInterface, author: string, text: string) {
  await adjustQueued($, 1)
  try {
    // Queued by the engine until the session is idle; the prompt.submit hook
    // reports it to the hub once it actually enters.
    const result = await $.prompt.submit({ text: `[${author}] ${text}`, asUser: true })
    // The mod's own submit passes beneath its prompt.submit hook, so report it here.
    if (result.drop !== undefined) push({ type: 'error', text: `prompt dropped: ${result.drop}` })
    else push({ type: 'prompt', text: clip(result.text), origin: 'hub', author })
  } catch (error) {
    push({ type: 'error', text: `prompt failed: ${String(error)}` })
  } finally {
    await adjustQueued($, -1)
  }
}

async function abortTurn($: EngineInterface) {
  if (hub.currentTurn) await $.turn.abort({ turnId: hub.currentTurn })
}

async function poll($: EngineInterface) {
  let delay = 1
  try {
    const res = await $.http.fetch(
      `${hub.url}/agent/commands?session=${encodeURIComponent(hub.sessionKey)}&wait=${POLL_WAIT_MS}`,
      { headers: hub.headers },
    )
    if (!res.ok) throw new Error(`hub answered ${res.status}`)
    const reply = JSON.parse(res.text) as PollReply
    await update($, link, value => ({ ...value, isConnected: true, viewers: reply.viewers }))
    for (const command of reply.commands) {
      if (command.type === 'prompt') void submitPrompt($, command.author, command.text)
      if (command.type === 'abort') void abortTurn($)
    }
  } catch {
    await setConnected($, false)
    delay = RETRY_MS
  }
  $.clock.after(delay, () => void poll($))
}

async function start($: EngineInterface, cwd: string, isInteractive: boolean) {
  hub.url = ((await $.env.get('HUB_URL')) ?? hub.url).replace(/\/$/, '')
  const token = await $.env.get('HUB_TOKEN')
  if (token) hub.headers = { ...hub.headers, authorization: `Bearer ${token}` }
  const runnerKey = await $.env.get('HUB_SESSION')
  const claudeSessionId = await $.session.id()
  hub.sessionKey = runnerKey ?? claudeSessionId

  const host = await $.process.run(['hostname', '-s']).catch(() => null)
  push({
    type: 'hello',
    machine: (await $.env.get('HUB_MACHINE')) ?? host?.stdout.trim() ?? 'unknown',
    cwd,
    model: await $.session.model(),
    claudeSessionId,
    isInteractive,
    isRunnerManaged: runnerKey !== undefined,
  })

  // A reload fires session.start again with the old module's timers gone,
  // so starting them here never doubles up.
  hub.isLinked = true
  $.clock.every(FLUSH_MS, () => void flush($))
  void poll($)
}

async function reportTurnEnd(
  $: EngineInterface,
  e: { turnId: string; agentId?: string; reason: string; durationMs: number; usage?: unknown },
) {
  const usage = e.agentId === undefined ? await $.session.usage().catch(() => null) : null
  push({
    type: 'turn_end',
    turnId: e.turnId,
    agentId: e.agentId,
    reason: e.reason,
    durationMs: e.durationMs,
    usage: e.usage,
    contextPercent: usage?.context.percent,
    costUsd: usage?.cost?.usd,
  })
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await start($, e.cwd, e.isInteractive)
    return started
  })

  on('session.end', async ($, e, next) => {
    const ended = await next(e)
    // A /clear keeps the process, and so the hub session, going.
    if (e.reason !== 'clear' && hub.isLinked) {
      push({ type: 'bye', reason: e.reason })
      await flush($)
    }
    return ended
  })

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    return {
      sections: [
        ...composed.sections,
        { id: `${PLUGIN}:multiplayer`, text: MULTIPLAYER_NOTE, scope: 'session' },
      ],
    }
  })

  on('prompt.submit', async ($, e, next) => {
    const entered = await next(e)
    if (entered.drop === undefined) {
      push({ type: 'prompt', text: clip(entered.text), origin: e.origin?.kind ?? 'composer' })
    }
    return entered
  })

  on('turn.start', async ($, e, next) => {
    hub.currentTurn = e.turnId
    push({ type: 'turn_start', turnId: e.turnId })
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    const stream = next(e)
    while (true) {
      const piece = await stream.next()
      if (piece.done) return piece.value
      const chunk = piece.value
      if (chunk.kind === 'text') {
        push({ type: 'text', turnId: e.turnId, agentId: e.agentId, text: chunk.text })
      } else if (chunk.kind === 'thinking' && hub.thinkingIn !== `${e.turnId}:${e.index}`) {
        hub.thinkingIn = `${e.turnId}:${e.index}`
        push({ type: 'thinking', turnId: e.turnId, agentId: e.agentId })
      }
      yield chunk
    }
  })

  on('tool.call', async ($, e, next) => {
    const { tool, tool_use_id, agentId, ...input } = e
    push({ type: 'tool_start', id: tool_use_id, tool, agentId, input: clip(JSON.stringify(input), 1_000) })
    const ran = await next(e)
    push({
      type: 'tool_end',
      id: tool_use_id,
      tool,
      agentId,
      deny: ran.deny,
      isError: ran.isError === true,
      text: clip(ran.text ?? ''),
    })
    return ran
  })

  on('turn.complete', async ($, e, next) => {
    const completed = await next(e)
    if (e.agentId === undefined) hub.currentTurn = null
    await reportTurnEnd($, e)
    return completed
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const value = await read($, link)
    if (!hub.isLinked || e.props.hasSurvey) return next(e)

    const { Box, Text } = $.ui.resolve(e)
    return (
      <Box>
        <Text color={value.isConnected ? 'green' : 'red'}>{value.isConnected ? '● ' : '○ '}</Text>
        <Text dimColor>
          {value.isConnected ? 'hub' : 'hub offline'}
          {value.viewers.length > 0 ? ` · 👥 ${value.viewers.join(', ')}` : ''}
          {value.queued > 0 ? ` · ${value.queued} queued from web` : ''}
        </Text>
      </Box>
    )
  })
}
