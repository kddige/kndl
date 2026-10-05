// The credential proxy (#145, ADR 0013) as a Sandbox reaches it, on a real microsandbox VM, so it
// is skipped unless CLAUDE_HUB_SANDBOX_IT=1. A Sandbox on buildpack-deps:bookworm (which has curl)
// calls the proxy at host.microsandbox.internal with a Session token, the way Claude Code and its
// mod will; the proxy forwards to a fake Anthropic and a fake Hub on this host's loopback, so
// nothing here reaches Anthropic. It needs `msb` installed for the current user and network
// access to Docker Hub. Everything it creates is named it-145-… and removed at the end.
//
//   CLAUDE_HUB_SANDBOX_IT=1 bun test packages/runner/src/proxy/CredentialProxy.integration.test.ts

import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type ClaudeCredential, credentialFromSecret, type SessionId } from "@claude-hub/protocol"
import { Cause, Effect, Exit, Layer, Redacted } from "effect"
import { Sandbox, Volume } from "microsandbox"
import * as MicrosandboxBackend from "../sandbox/MicrosandboxBackend.ts"
import { SandboxBackend, shell } from "../sandbox/SandboxBackend.ts"
import { sessionSandboxSpec } from "../sandbox/SessionLayout.ts"
import { makeCredentialProxy, serveCredentialProxy } from "./CredentialProxy.ts"
import { RunnerCredential } from "./RunnerCredential.ts"
import { makeSessionTokens, SessionTokens } from "./SessionTokens.ts"

const enabled = process.env.CLAUDE_HUB_SANDBOX_IT === "1"

const namePrefix = "it-145-"

// Made up: shaped like the real ones, valid nowhere.
const runnerToken = "sk-ant-oat01-it145-runner-FAKE"
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
  "a Sandbox reaches Anthropic and the Hub through the proxy with its Session token alone",
  async () => {
    await sweep()
    const sessionId = `s${Date.now().toString(36)}` as SessionId
    const workspace = await mkdtemp(join(tmpdir(), "claude-hub-it-145-"))

    const toAnthropic: Array<{ path: string; authorization: string | null }> = []
    const anthropic = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      idleTimeout: 0,
      fetch: (request) => {
        const url = new URL(request.url)
        toAnthropic.push({
          path: url.pathname,
          authorization: request.headers.get("authorization"),
        })
        if (url.pathname !== "/v1/messages") return Response.json({ data: [] })
        // A Turn: one event, a pause, and the next.
        const encoder = new TextEncoder()
        return new Response(
          new ReadableStream({
            async start(controller) {
              controller.enqueue(encoder.encode("event: message_start\n\n"))
              await Bun.sleep(1_500)
              controller.enqueue(encoder.encode("event: message_stop\n\n"))
              controller.close()
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        )
      },
    })
    const toHub: Array<{ path: string; authorization: string | null }> = []
    const hub = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      idleTimeout: 0,
      fetch: async (request) => {
        const url = new URL(request.url)
        toHub.push({ path: url.pathname, authorization: request.headers.get("authorization") })
        await Bun.sleep(Number(url.searchParams.get("waitMs") ?? 0))
        return Response.json({ messages: [] })
      },
    })

    const tokens = makeSessionTokens()
    const credential = credentialFromSecret(runnerToken) as ClaudeCredential
    const runnerCredential = RunnerCredential.of({
      current: Effect.succeed(credential),
      reread: Effect.succeed(credential),
      describe: Effect.succeed({ credential, from: "a test" }),
    })

    const program = Effect.gen(function* () {
      const port = yield* serveCredentialProxy({
        port: 0,
        hubUrl: hub.url,
        upstream: anthropic.url.href,
      })
      const proxy = makeCredentialProxy({ port, tokens, runnerCredential })
      const pass = yield* proxy.admit({ sessionId, modToken: Redacted.make(modToken) })
      expect(pass.credential).toBe("Runner")

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
      // The Session's environment, as Claude Code and its mod will have it.
      const sh = (script: string) => backend.exec(sessionId, shell(script, { env: pass.env }))
      const status = (args: string) =>
        sh(`curl -s -o /dev/null -w '%{http_code}' ${args}`).pipe(Effect.map((r) => r.stdout))

      expect(pass.env.ANTHROPIC_BASE_URL).toBe(proxy.guestUrl)
      expect(yield* status(`-I "$ANTHROPIC_BASE_URL/api/hello"`)).toBe("200")
      expect(yield* status(`"$ANTHROPIC_BASE_URL/v1/models"`)).toBe("401")
      expect(
        yield* status(`-H "authorization: Bearer chp_guessed" "$ANTHROPIC_BASE_URL/v1/models"`),
      ).toBe("401")
      const bearer = `-H "authorization: Bearer $CLAUDE_CODE_OAUTH_TOKEN"`
      expect(yield* status(`${bearer} "$ANTHROPIC_BASE_URL/v1/models?limit=1000"`)).toBe("200")
      expect(yield* status(`${bearer} "$ANTHROPIC_BASE_URL/api/oauth/profile"`)).toBe("404")
      expect(
        yield* status(
          `${bearer} --path-as-is "$ANTHROPIC_BASE_URL/v1/models/../../api/oauth/usage"`,
        ),
      ).toBe("404")

      // A Turn streams through as it comes: the first event long before the second.
      const turn = yield* sh(
        `curl -sN -X POST ${bearer} -d '{}' "$ANTHROPIC_BASE_URL/v1/messages" | while IFS= read -r line; do [ -n "$line" ] && echo "$(date +%s%3N) $line"; done`,
      )
      const events = turn.stdout
        .trim()
        .split("\n")
        .map((line) => line.split(" "))
      expect(events.map(([, , event]) => event)).toEqual(["message_start", "message_stop"])
      const [[first], [second]] = events as [[string], [string]]
      expect(Number(second) - Number(first)).toBeGreaterThan(1_000)

      // The mod's command poll, relayed to the Hub with the mod token.
      const poll = yield* sh(
        `curl -s -H "authorization: Bearer $CLAUDE_HUB_MOD_TOKEN" "$CLAUDE_HUB_URL/mod/commands?after=0&waitMs=1000"`,
      )
      expect(poll.stdout).toBe('{"messages":[]}')

      // Revoked, as when the Session sleeps: refused at once.
      yield* proxy.revoke(sessionId)
      expect(yield* status(`${bearer} "$ANTHROPIC_BASE_URL/v1/models"`)).toBe("401")

      // Anthropic and the Hub saw the Runner's credentials, never the Session token.
      expect(toAnthropic.map((seen) => seen.path)).toEqual(["/v1/models", "/v1/messages"])
      for (const seen of toAnthropic) expect(seen.authorization).toBe(`Bearer ${runnerToken}`)
      expect(toHub).toEqual([{ path: "/mod/commands", authorization: `Bearer ${modToken}` }])
      // The guest held only its Session token.
      expect(JSON.stringify(pass.env)).not.toContain(runnerToken)
      expect(JSON.stringify(pass.env)).not.toContain(modToken)

      yield* backend.destroy(sessionId)
    }).pipe(
      Effect.provideService(SessionTokens, tokens),
      Effect.provideService(RunnerCredential, runnerCredential),
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
    await anthropic.stop(true)
    await hub.stop(true)
    await rm(workspace, { recursive: true, force: true })
    if (Exit.isFailure(exit)) throw Cause.squash(exit.cause)
    expect(left).toEqual([])
  },
  { timeout: 10 * 60_000 },
)
