import { afterEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, posix } from "node:path"
import { InstallationId } from "@kndl/protocol"
import { Effect } from "effect"
import { gatewayMcpServers } from "./ClaudeLaunch.ts"
import { gatewayPlugin, modGuestPath, modPlugins } from "./sandbox/SessionLayout.ts"
import { copySessionMod } from "./SessionMod.ts"
import { sessionDirectories } from "./SessionNames.ts"
import { sessionId } from "./testSupport.ts"

const dirs: Array<string> = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** A Runner's built mod, and a Session's directories. */
function scene() {
  const root = mkdtempSync(join(tmpdir(), "kndl-mod-"))
  dirs.push(root)
  const modDir = join(root, "runner-mod")
  for (const plugin of modPlugins) {
    mkdirSync(join(modDir, "plugins", plugin, ".claude-plugin"), { recursive: true })
    writeFileSync(join(modDir, "plugins", plugin, ".claude-plugin", "plugin.json"), "{}")
  }
  return { modDir, directories: sessionDirectories(join(root, "sessions"), sessionId("s-1")) }
}

/** Where the copy is on the host, from where the Sandbox sees it. */
const onHost = (mod: string, guest: string) => join(mod, posix.relative(modGuestPath, guest))

test("copies the mod's plugins, with a kndl plugin of each Installation's MCP server, nothing secret (ADR 0020)", async () => {
  const { modDir, directories } = scene()
  const servers = [{ installationId: InstallationId.make("inst-1"), server: "docs" }]
  const guest = await Effect.runPromise(copySessionMod(modDir, directories, servers))
  expect(readdirSync(onHost(directories.mod, guest)).toSorted()).toEqual(
    [...modPlugins, gatewayPlugin].toSorted(),
  )
  const plugin = join(onHost(directories.mod, guest), gatewayPlugin)
  expect(
    JSON.parse(readFileSync(join(plugin, ".claude-plugin", "plugin.json"), "utf8")),
  ).toMatchObject({
    name: gatewayPlugin,
  })
  expect(JSON.parse(readFileSync(join(plugin, ".mcp.json"), "utf8"))).toEqual(
    gatewayMcpServers(servers),
  )

  // The next start without Installations leaves none behind.
  const next = await Effect.runPromise(copySessionMod(modDir, directories))
  expect(readdirSync(directories.mod)).toEqual([posix.basename(next)])
  expect(readdirSync(onHost(directories.mod, next)).toSorted()).toEqual([...modPlugins])
})
