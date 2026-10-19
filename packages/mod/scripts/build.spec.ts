// The Sandbox gets only this bundle and the Runner's pinned Pi Durable installation. Keep the
// Claude bridge's libraries inside it, without requiring Claude Code during the build.

import { expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { builtinModules } from "node:module"
import { join } from "node:path"

const root = join(import.meta.dir, "..")
const agent = join(root, "durable/dist/agent.js")

test("the durable bundle imports only Node and its pinned Pi Durable packages", async () => {
  const built = Bun.spawnSync([process.execPath, "scripts/build.ts"], {
    cwd: root,
    stdout: "ignore",
  })
  if (built.exitCode !== 0 || !existsSync(agent))
    throw new Error("couldn't build the durable agent")
  const code = await Bun.file(agent).text()
  const imported = new Set(
    new Bun.Transpiler({ loader: "js" }).scanImports(code).map((entry) => entry.path),
  )
  const builtins = new Set(builtinModules)
  const foreign = [...imported].filter(
    (path) =>
      !path.startsWith("node:") &&
      !builtins.has(path) &&
      !/^@earendil-works\/(chord|pi-(ai|durable|codemode|mcp))(\/|$)/.test(path),
  )
  expect(foreign).toEqual([])
  expect(code).toContain("kndl-claude-code")
  expect(code).toContain("pathToClaudeCodeExecutable")
}, 60_000)
