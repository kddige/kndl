// Live, never committed: a real Hub with alice's real Claude credential and ChatGPT sign-in, a
// pi Runner played by the test, and the real pi with kndl's extension: Claude (bridge) → GPT
// (Gateway) → Claude in one pi Session, switched from the web. Run from packages/hub.
import { readFileSync } from "node:fs"
import { spawn } from "node:child_process"
import type { OAuthCredential } from "@earendil-works/pi-ai"
import { Option, Redacted } from "effect"
import { ClaudeCheck } from "./ClaudeCredentials.ts"
import { ProviderApis } from "./ConnectedProviders.ts"
import { generateSecretsKey } from "./Secrets.ts"
import { issueRunnerToken, openRunner, openWeb, stopAll } from "./testChannels.ts"
import { seedEnvironment, startHub } from "./testSupport.ts"

const pid = process.env.CLAUDE_PID!
const claudeToken = readFileSync(`/proc/${pid}/environ`, "utf8").split("\0").find((l) => l.startsWith("CLAUDE_CODE_OAUTH_TOKEN="))!.slice("CLAUDE_CODE_OAUTH_TOKEN=".length)
const chatgpt = JSON.parse(readFileSync("/workspace/.spike/auth/auth.json", "utf8")).openai as OAuthCredential
const hub = await startHub({
  config: { devLogin: true, secretsKey: Option.some(Redacted.make(generateSecretsKey())) },
  providerApis: ProviderApis.layerTest({
    fetch: (request) => fetch(request),
    signIn: async () => chatgpt,
    refresh: async (_p, c, signal) => {
      const { openaiChatGPTOAuth } = await import("/workspace/.spike/node_modules/@earendil-works/pi-ai/dist/auth/oauth/openai-chatgpt.js" as string)
      return openaiChatGPTOAuth.refresh(c, signal)
    },
  }),
})
const runner = await openRunner(hub, (await issueRunnerToken(hub)).token, [], undefined, true, { harnesses: ["ClaudeCode", "Pi"] })
const web = await openWeb(hub, "alice")
await seedEnvironment(hub, "kddige/kndl", "dev:alice")
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
web.send({ _tag: "SetClaudeCredential", requestId: "k-1", secret: claudeToken })
web.send({ _tag: "StartSignIn", requestId: "s-1", provider: "openai" })
await wait(4000)
const state = (await web.untaken("ProvidersState")).reverse().find((m: any) => m.models?.length > 0) as any
const claude = state.models.find((m: any) => m.provider === "anthropic" && /haiku/.test(m.id))
const gpt = state.models.find((m: any) => m.provider === "openai" && m.id === "gpt-5.6-luna") ?? state.models.find((m: any) => m.provider === "openai")
console.log("models:", state.models.length, "claude:", claude?.id, "gpt:", gpt?.id)
const openai = state.connected.find((c: any) => c.provider === "openai")
console.log("openai:", openai?.kind, openai?.models.map((m: any) => m.id).join(" "), "| problem:", openai?.modelsProblem)
web.send({ _tag: "CreateSession", requestId: "c-1", repo: "kddige/kndl", branch: { _tag: "Existing", name: "main", newWorkBranch: true }, model: `anthropic/${claude.id}` })
const start = await runner.take("StartSession")
console.log("StartSession harness:", start.harness, "model:", start.model)
runner.send({ _tag: "SessionStarted", sessionId: start.sessionId, environmentVersion: 1 })
web.send({ _tag: "JoinSession", sessionId: start.sessionId })

const env: Record<string, string> = {
  PATH: process.env.PATH!, HOME: process.env.HOME!, KNDL_URL: hub.url, KNDL_MOD_TOKEN: start.modToken,
  KNDL_SESSION_ID: start.sessionId, KNDL_CONVERSATION_ID: "0b6d6c1e-2f4a-4c3b-9d8e-7a6b5c4d3e2f",
  PI_CODING_AGENT_DIR: "/tmp/mixed-pi", PI_OFFLINE: "1", PI_TELEMETRY: "0",
  CLAUDE_CODE_OAUTH_TOKEN: claudeToken, IS_SANDBOX: "1", CLAUDE_CONFIG_DIR: "/tmp/mixed-claude",
  KNDL_CLAUDE_CODE: "/opt/kndl/claude-code/2.1.296-glibc/claude", KNDL_CLAUDE_DEBUG: "1",
}
const pi = spawn("node", ["/workspace/packages/mod/node_modules/@earendil-works/pi-coding-agent/dist/cli.js",
  "--mode", "rpc", "-e", "/workspace/packages/mod/pi/dist/kndl.js", "--session-id", env.KNDL_CONVERSATION_ID!, "--model", start.model!],
  { cwd: "/tmp/spike-work", env, stdio: ["pipe", "pipe", "pipe"] })
pi.stderr.on("data", (d) => process.stderr.write(`[pi] ${d}`))
await wait(6000)

async function turn(text: string) {
  const before = (await web.untaken("SessionEventLogged")).length
  web.send({ _tag: "SendPrompt", requestId: `p-${Math.random()}`, sessionId: start.sessionId, text })
  const deadline = Date.now() + 90_000
  while (Date.now() < deadline) {
    const all = (await web.untaken("SessionEventLogged")).map((m: any) => m.entry.event)
    const mine = all.slice(before)
    const end = mine.find((e: any) => e._tag === "TurnEnded" && e.agentId === undefined)
    if (end) {
      console.log(`[${text.slice(0, 40)}] tools=${mine.filter((e: any) => e._tag === "ToolCallStarted").map((e: any) => e.tool).join(",") || "-"} text="${mine.filter((e: any) => e._tag === "TextDelta").map((e: any) => e.text).join("").slice(0, 120)}" end=${JSON.stringify(end.usage ? { reason: end.reason, model: end.usage.model, cacheRead: end.usage.cacheRead, cost: end.usage.cost } : end.reason)}`)
      return
    }
    await wait(1000)
  }
  console.log("timed out:", text)
}
await turn("Read note.txt with your read tool and tell me the secret word, in one short sentence.")
web.send({ _tag: "SetSessionModel", sessionId: start.sessionId, model: `openai/${gpt.id}` })
await wait(2000)
await turn("Without tools: what was the secret word? Then use bash to run `echo from-gpt > gpt.txt`.")
web.send({ _tag: "SetSessionModel", sessionId: start.sessionId, model: `anthropic/${claude.id}` })
await wait(2000)
await turn("Read gpt.txt and tell me what it says, and the secret word, in one short sentence.")
pi.kill()
await stopAll()
process.exit(0)
