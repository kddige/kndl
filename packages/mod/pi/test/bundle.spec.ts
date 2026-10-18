// The pi extension's bundle is all a Sandbox has of it (/opt/kndl/mod/<copy>/pi/kndl.js): it may
// import nothing but Node's own modules and the pi packages pi hands an extension. The Claude
// bridge's dependencies (the Agent SDK, the MCP SDK, cc-session-io) are inside it, and the Agent
// SDK's bundled Claude Code is never wanted: the bridge runs the pinned one.

import { expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { builtinModules } from "node:module"
import { join } from "node:path"

const root = join(import.meta.dir, "../..")
const extension = join(root, "pi/dist/kndl.js")

test("the built extension imports only Node's modules and pi's packages", async () => {
  const built = Bun.spawnSync(["bun", "scripts/build.ts"], { cwd: root, stdout: "ignore" })
  if (built.exitCode !== 0 || !existsSync(extension))
    throw new Error("couldn't build the pi extension")
  const code = await Bun.file(extension).text()
  const imported = new Set(
    new Bun.Transpiler({ loader: "js" }).scanImports(code).map((entry) => entry.path),
  )
  const builtins = new Set(builtinModules)
  const foreign = [...imported].filter(
    (path) =>
      !path.startsWith("node:") &&
      !builtins.has(path) &&
      !/^@earendil-works\/pi-(ai|coding-agent)(\/|$)/.test(path),
  )
  expect(foreign).toEqual([])
  // The Claude bridge is in it.
  expect(code).toContain("kndl-claude-code")
  expect(code).toContain("pathToClaudeCodeExecutable")
}, 60_000)
