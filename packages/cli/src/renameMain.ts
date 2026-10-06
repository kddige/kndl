// Moves an install made under kndl's former name to kndl's names (Rename.ts, ADR 0017), for a Hub
// or Runner a service of the former name started: `bun renameMain.ts --service hub|runner`, run
// by the Hub's or Runner's main.ts in place of starting (FormerName.ts in the protocol).
//
// Such a service is started by the former name's own `update`, on the new code, and that update
// then waits for the Hub's `/health` and checks on the services. So the move waits for it to end
// first, answering `/health` in the Hub's place meanwhile, rather than move the home from under
// it. It exits 0 when the install has moved (or there was nothing to move), and 1 when it couldn't
// move it, for the former service to start it again and try once more.
import { createServer } from "node:http"
import { BunRuntime, BunServices } from "@effect/platform-bun"
import { formerHomeDir } from "@kndl/protocol/former-name"
import { Console, Effect, Layer } from "effect"
import type { Role } from "./Layout.ts"
import { cliProcesses, machineEdges, moveFromFormerName, thisMachine } from "./Rename.ts"
import { Shell } from "./Shell.ts"
import { Ui } from "./Ui.ts"

const roleArg = process.argv.indexOf("--service")
const service = roleArg < 0 ? undefined : process.argv[roleArg + 1]
if (service !== undefined && service !== "hub" && service !== "runner") {
  console.error(`Usage: renameMain.ts [--service hub|runner], not ${service}`)
  process.exit(2)
}

const setting = thisMachine()
if (setting === undefined) {
  console.error(`kndl runs on macOS and Linux, not ${process.platform}.`)
  process.exit(1)
}

/** How long the move waits for the former name's `update` to end. */
const CliWaitMs = 10 * 60_000

/** Waits for the former name's CLI to end, up to {@link CliWaitMs}. */
async function waitForFormerCli(home: string): Promise<void> {
  const until = Date.now() + CliWaitMs
  let said = false
  while (Date.now() < until) {
    const ps = Bun.spawnSync(["ps", "-A", "-o", "pid=,args="], { stdout: "pipe", stderr: "ignore" })
    if (ps.exitCode !== 0) return
    if (cliProcesses(ps.stdout.toString(), home, process.pid).length === 0) return
    if (!said) console.log("Waiting for the update that started this to finish...")
    said = true
    await Bun.sleep(1000)
  }
}

/**
 * Answers the Hub's `/health` on its port while the Hub waits to move, for the update that
 * restarted it, which waits for it. Nothing else is served. `undefined` when the port is taken.
 */
async function standInForHub(): Promise<(() => Promise<void>) | undefined> {
  const port = Number(process.env.PORT ?? 7777)
  if (!Number.isSafeInteger(port)) return undefined
  const server = createServer((request, response) => {
    response.statusCode = request.url === "/health" ? 200 : 503
    response.end(request.url === "/health" ? "ok" : "The Hub is moving to kndl's names.")
  })
  const listening = await new Promise<boolean>((resolve) => {
    server.once("error", () => resolve(false))
    server.listen(port, "127.0.0.1", () => resolve(true))
  })
  if (!listening) return undefined
  return () =>
    new Promise<void>((resolve) => {
      server.close(() => resolve())
      server.closeAllConnections()
    })
}

if (service !== undefined) {
  const stop = service === "hub" ? await standInForHub() : undefined
  await waitForFormerCli(formerHomeDir(process.env, setting.userHome))
  await stop?.()
}

moveFromFormerName(setting, machineEdges(setting), { service: service as Role | undefined }).pipe(
  Effect.flatMap((outcome) =>
    outcome.plan._tag === "Nothing"
      ? Console.log("Nothing to move: no install of the former name was found.")
      : Effect.void,
  ),
  Effect.catchTag("CliFailure", (error) =>
    Effect.andThen(
      Console.error(error.message),
      Effect.sync(() => (process.exitCode = 1)),
    ),
  ),
  Effect.provide(Layer.mergeAll(Shell.layer, Ui.layer).pipe(Layer.provideMerge(BunServices.layer))),
  BunRuntime.runMain,
)
