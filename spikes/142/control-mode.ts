// Spike #142: can the Runner keep its terminal mirror when tmux runs *inside* the Sandbox? This
// attaches tmux control mode (`tmux -C attach`) inside the VM through the microsandbox SDK, the way
// the Runner's backend spawns `claude mcp serve` (execStreamWith + stdinPipe), types into the pane
// through the control channel and times the %output notifications that come back.
//
// (The `msb exec` CLI is no good for this: piped, with or without -t, it hands back stdout only
// when the command exits.)
//
//   bun spikes/142/control-mode.ts <vm> [text to type]

import { Sandbox } from "../../packages/runner/node_modules/microsandbox/dist/index.js"

const [vm, text = "/cost"] = Bun.argv.slice(2)
if (vm === undefined) throw new Error("usage: control-mode.ts <vm> [text]")

const started = performance.now()
const ms = () => Math.round(performance.now() - started)
const sandbox = await (await Sandbox.get(vm)).connect()
const running = await sandbox.execStreamWith("tmux", (b) =>
  b.args(["-C", "attach", "-t", "claude"]).stdinPipe(),
)
const stdin = await running.takeStdin()
if (stdin === null) throw new Error("stdin taken")

const outputs: Array<number> = []
let sample = ""
const decoder = new TextDecoder()
const reading = (async () => {
  for await (const event of running) {
    if (event.kind !== "stdout") continue
    for (const line of decoder.decode(event.data).split("\n")) {
      if (line.startsWith("%output")) outputs.push(ms())
      if (sample.length < 500) sample += `${line.slice(0, 110)}\n`
    }
  }
})()

await Bun.sleep(1500)
const typedAt = ms()
await stdin.write(`send-keys -t claude -l ${JSON.stringify(text)}\n`)
await Bun.sleep(1500)
// Leave the prompt as it was, and detach.
await stdin.write("send-keys -t claude C-u\n")
await stdin.write("detach-client\n")
await Promise.race([reading, Bun.sleep(3000)])

const firstAfterTyping = outputs.find((t) => t > typedAt)
console.log(
  JSON.stringify({
    typedAt,
    outputs,
    echoMs: firstAfterTyping === undefined ? null : firstAfterTyping - typedAt,
  }),
)
console.log(sample)
process.exit(0)
