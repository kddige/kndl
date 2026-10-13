// The mod relay (ADR 0026) as a Sandbox reaches it, on a real microsandbox VM, so it is skipped
// unless KNDL_SANDBOX_IT=1. A Sandbox on buildpack-deps:bookworm (which has curl) calls the relay
// at host.microsandbox.internal with a Session token, the way the mod and Claude Code's MCP
// traffic do; the relay forwards to a fake Hub on this host's loopback. It needs `msb` installed
// for the current user and network access to Docker Hub. Everything it creates is named it-145-…
// and removed at the end.
//
//   KNDL_SANDBOX_IT=1 bun test packages/runner/src/relay/ModRelay.integration.test.ts

import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { SessionId } from "@kndl/protocol"
import { Cause, Effect, Exit, Layer, Redacted } from "effect"
import { Sandbox, Volume } from "microsandbox"
import * as MicrosandboxBackend from "../sandbox/MicrosandboxBackend.ts"
import { SandboxBackend, shell } from "../sandbox/SandboxBackend.ts"
import { sessionSandboxSpec } from "../sandbox/SessionLayout.ts"
import { makeModRelay, serveModRelay } from "./ModRelay.ts"
import { makeSessionTokens, SessionTokens } from "./SessionTokens.ts"

const enabled = process.env.KNDL_SANDBOX_IT === "1"

const namePrefix = "it-145-"

// Made up: shaped like a real one, valid nowhere.
const modToken = "chm_it145.FAKE"

const ours = <A extends { readonly name: string | null }>(items: ReadonlyArray<A>) =>
  items.filter((item) => item.name?.startsWith(namePrefix) === true)

const sweep = async () => {
  const left: Array<string> = []
  for (const sandbox of ours((await Sandbox.list()).sandboxes)) {
    left.push(`sandbox ${sandbox.name}`)
    const handle = await Sandbox.get(sandbox.name).catch(() => undefined)
    await handle?.destroy({ force: true }).catch(() => undefined)
    await Sandbox.remove(sandbox.name).catch(() => undefined)
  }
  for (const volume of ours(await Volume.list())) {
    left.push(`volume ${volume.name}`)
    await Volume.remove(volume.name).catch(() => undefined)
  }
  return left
}

test.skipIf(!enabled)(
  "a Sandbox reaches the Hub through the relay with its Session token alone",
  async () => {
    await sweep()
    const sessionId = `s${Date.now().toString(36)}` as SessionId
    const workspace = await mkdtemp(join(tmpdir(), "kndl-it-145-"))

    const toHub: Array<{ path: string; authorization: string | null }> = []
    const hub = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      idleTimeout: 0,
      fetch: async (request) => {
        const url = new URL(request.url)
        toHub.push({ path: url.pathname, authorization: request.headers.get("authorization") })
        if (url.pathname.startsWith("/gateway/")) {
          // An MCP answer: one event, a pause, and the next.
          const encoder = new TextEncoder()
          return new Response(
            new ReadableStream({
              async start(controller) {
                controller.enqueue(encoder.encode("event: first\n\n"))
                await Bun.sleep(1_500)
                controller.enqueue(encoder.encode("event: second\n\n"))
                controller.close()
              },
            }),
            { headers: { "content-type": "text/event-stream" } },
          )
        }
        await Bun.sleep(Number(url.searchParams.get("waitMs") ?? 0))
        return Response.json({ messages: [] })
      },
    })

    const tokens = makeSessionTokens()

    const program = Effect.gen(function* () {
      const port = yield* serveModRelay({ port: 0, hubUrl: hub.url })
      const relay = makeModRelay({ port, tokens })
      const token = yield* relay.admit({ sessionId, modToken: Redacted.make(modToken) })
      // The mod's environment, as Claude Code's launch sets it.
      const env = { KNDL_URL: relay.guestUrl, KNDL_MOD_TOKEN: Redacted.value(token) }

      const backend = yield* SandboxBackend
      yield* backend.create(
        sessionSandboxSpec({
          sessionId,
          image: "buildpack-deps:bookworm",
          workspaceHostPath: workspace,
          env: {},
          cpus: 1,
          memoryMib: 1024,
          rootDiskMib: 2048,
          workspaceQuotaMib: 256,
          dependencySizeMib: 256,
          cacheSizeMib: 256,
          dockerSizeMib: false,
        }),
      )
      const sh = (script: string) => backend.exec(sessionId, shell(script, { env }))
      const status = (args: string) =>
        sh(`curl -s -o /dev/null -w '%{http_code}' ${args}`).pipe(Effect.map((r) => r.stdout))

      const bearer = `-H "authorization: Bearer $KNDL_MOD_TOKEN"`
      expect(yield* status(`"$KNDL_URL/mod/commands"`)).toBe("401")
      expect(yield* status(`-H "authorization: Bearer chp_guessed" "$KNDL_URL/mod/commands"`)).toBe(
        "401",
      )
      // Nothing for Anthropic goes this way: Claude Code talks to it directly.
      expect(yield* status(`${bearer} "$KNDL_URL/v1/models"`)).toBe("404")
      expect(yield* status(`${bearer} --path-as-is "$KNDL_URL/mod/../v1/models"`)).toBe("404")

      // The mod's command poll, relayed to the Hub with the mod token.
      const poll = yield* sh(`curl -s ${bearer} "$KNDL_URL/mod/commands?after=0&waitMs=1000"`)
      expect(poll.stdout).toBe('{"messages":[]}')

      // MCP traffic streams through as it comes: the first event long before the second.
      const mcp = yield* sh(
        `curl -sN -X POST ${bearer} -d '{}' "$KNDL_URL/gateway/inst-1" | while IFS= read -r line; do [ -n "$line" ] && echo "$(date +%s%3N) $line"; done`,
      )
      const events = mcp.stdout
        .trim()
        .split("\n")
        .map((line) => line.split(" "))
      expect(events.map(([, , event]) => event)).toEqual(["first", "second"])
      const [[first], [second]] = events as [[string], [string]]
      expect(Number(second) - Number(first)).toBeGreaterThan(1_000)

      // Revoked, as when the Session sleeps: refused at once.
      yield* relay.revoke(sessionId)
      expect(yield* status(`${bearer} "$KNDL_URL/mod/commands"`)).toBe("401")

      // The Hub saw the mod token, never the Session token, and the guest held only the latter.
      expect(toHub).toEqual([
        { path: "/mod/commands", authorization: `Bearer ${modToken}` },
        { path: "/gateway/inst-1", authorization: `Bearer ${modToken}` },
      ])
      expect(JSON.stringify(env)).not.toContain(modToken)

      yield* backend.destroy(sessionId)
    }).pipe(
      Effect.provideService(SessionTokens, tokens),
      Effect.provide(
        Layer.effect(
          SandboxBackend,
          MicrosandboxBackend.make({ runner: "it-145-runner", namePrefix }),
        ),
      ),
      Effect.scoped,
    )

    const exit = await Effect.runPromiseExit(program)
    const left = await sweep()
    await hub.stop(true)
    await rm(workspace, { recursive: true, force: true })
    if (Exit.isFailure(exit)) throw Cause.squash(exit.cause)
    expect(left).toEqual([])
  },
  { timeout: 10 * 60_000 },
)
