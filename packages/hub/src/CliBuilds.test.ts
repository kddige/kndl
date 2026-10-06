// The Hub's real build of the kndl CLI, `bun build --compile` of this checkout, for this
// machine's platform: the binary runs, knows its commit, and refuses the commands that need an
// install. Other platforms' builds download their Bun, so they are left to the Hub.

import { afterEach, expect, test } from "bun:test"
import { join } from "node:path"
import { type CliTarget, isCliTarget } from "@kndl/protocol"
import { thisCheckout } from "@kndl/protocol/checkout"
import { Effect } from "effect"
import { compileCli } from "./CliBuilds.ts"
import { commit, removeTempDirs, tempDir } from "./cliTestSupport.ts"

afterEach(removeTempDirs)

const host = `${process.platform}-${process.arch}`

async function run(argv: ReadonlyArray<string>, env: Record<string, string>) {
  const child = Bun.spawn([...argv], { stdout: "pipe", stderr: "pipe", env })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  return { stdout, stderr, exitCode }
}

test.skipIf(!isCliTarget(host))(
  `builds a CLI for ${host} that knows its commit, and needs an install to run one`,
  async () => {
    const dir = await tempDir("cli-build-")
    const binary = join(dir, "kndl")
    await Effect.runPromise(
      compileCli(thisCheckout)({ target: host as CliTarget, commit, outfile: binary }),
    )
    if (process.platform === "darwin") {
      expect((await run(["codesign", "--force", "--sign", "-", binary], {})).exitCode).toBe(0)
    }
    // A home with no install, a config with no Hub: nothing to update from.
    const env = {
      HOME: dir,
      KNDL_HOME: join(dir, ".kndl"),
      XDG_CONFIG_HOME: join(dir, ".config"),
    }
    expect(await run([binary, "--version"], env)).toEqual({
      stdout: `kndl v${commit.slice(0, 12)}\n`,
      stderr: "",
      exitCode: 0,
    })
    const status = await run([binary, "status"], env)
    expect(status.exitCode).toBe(1)
    expect(status.stderr).toContain(
      `\`kndl status\` needs a kndl install, and there is none in ${env.KNDL_HOME}.`,
    )
  },
  120_000,
)
