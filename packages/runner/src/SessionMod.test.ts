import { afterEach, expect, test } from "bun:test"
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join, posix } from "node:path"
import { Effect } from "effect"
import { durableAgent, modGuestPath } from "./sandbox/SessionLayout.ts"
import { copySessionMod, durableAgentBuild } from "./SessionMod.ts"
import { sessionDirectories } from "./SessionNames.ts"
import { sessionId } from "./testSupport.ts"

const dirs: Array<string> = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** The pi bundle's `node_modules`, as a Sandbox sees it. */
const nodeModules = "/opt/kndl/pi/pi-1.3.0-abc/node_modules"

/** A Runner's built mod, holding `agent` as its durable agent, and a Session's directories. */
function scene(agent = "// the durable agent\n") {
  const root = mkdtempSync(join(tmpdir(), "kndl-mod-"))
  dirs.push(root)
  const modDir = join(root, "runner-mod")
  mkdirSync(join(modDir, "durable", "dist"), { recursive: true })
  writeFileSync(join(modDir, durableAgentBuild), agent)
  // The agent's sources and the rest of the mod package, which stay out of the copy.
  mkdirSync(join(modDir, "durable", "src"), { recursive: true })
  writeFileSync(join(modDir, "durable", "src", "index.ts"), "")
  return { root, modDir, directories: sessionDirectories(join(root, "sessions"), sessionId("s-1")) }
}

/** Writes `text` to `path`, making its directory. */
const write = (path: string, text: string) => {
  mkdirSync(join(path, ".."), { recursive: true })
  writeFileSync(path, text)
}

/** Where the copy is on the host, from where the Sandbox sees it. */
const onHost = (mod: string, guest: string) => join(mod, posix.relative(modGuestPath, guest))

test("copies the durable agent, an ES module, linking its node_modules to the pi bundle's in the Sandbox", async () => {
  const { modDir, directories } = scene()
  const guest = await Effect.runPromise(copySessionMod(modDir, directories, nodeModules))

  expect(guest).toMatch(new RegExp(`^${modGuestPath}/[0-9a-f]{8}$`))
  const copy = join(onHost(directories.mod, guest), "durable")
  expect(readdirSync(copy).toSorted()).toEqual(["agent.js", "node_modules", "package.json"])
  expect(readFileSync(join(onHost(directories.mod, guest), durableAgent), "utf8")).toBe(
    "// the durable agent\n",
  )
  expect(JSON.parse(readFileSync(join(copy, "package.json"), "utf8"))).toEqual({ type: "module" })
  expect(readlinkSync(join(copy, "node_modules"))).toBe(nodeModules)

  // The next start replaces the copy with one of another name.
  const next = await Effect.runPromise(copySessionMod(modDir, directories, nodeModules))
  expect(next).not.toBe(guest)
  expect(readdirSync(directories.mod)).toEqual([posix.basename(next)])
})

test("lets Node resolve the agent's @earendil-works imports, and theirs, in the Sandbox's layout", async () => {
  // The agent imports a pi package by name, which imports a dependency of its own.
  const { root, modDir, directories } = scene(
    'import { hello } from "@earendil-works/fake"\nconsole.log(hello())\n',
  )
  // The Sandbox, on the host: the pi bundle's install where it is mounted, and the Session's copy
  // of the mod linked where the mount puts it.
  const guestRoot = join(root, "guest")
  const install = join(guestRoot, "opt", "kndl", "pi", "pi-1.3.0-abc", "node_modules")

  write(
    join(install, "@earendil-works", "fake", "package.json"),
    JSON.stringify({ name: "@earendil-works/fake", type: "module", exports: "./index.js" }),
  )
  write(
    join(install, "@earendil-works", "fake", "index.js"),
    'import { word } from "fake-dependency"\nexport const hello = () => `hello ${word}`\n',
  )
  write(
    join(install, "fake-dependency", "package.json"),
    JSON.stringify({ name: "fake-dependency", type: "module", exports: "./index.js" }),
  )
  write(join(install, "fake-dependency", "index.js"), 'export const word = "from the bundle"\n')
  mkdirSync(join(guestRoot, "opt", "kndl"), { recursive: true })
  symlinkSync(directories.mod, join(guestRoot, "opt", "kndl", "mod"))

  const guest = await Effect.runPromise(copySessionMod(modDir, directories, install))
  const node = Bun.which("node")
  if (node === null) throw new Error("this test needs Node.js")
  const run = Bun.spawnSync(
    [node, join(guestRoot, guest, durableAgent)],
    // Nowhere near a node_modules of the repository's, nor any NODE_PATH.
    { cwd: tmpdir(), env: { PATH: process.env.PATH ?? "" }, stderr: "pipe" },
  )
  expect(run.stderr.toString()).toBe("")
  expect(run.stdout.toString()).toBe("hello from the bundle\n")
})

test("fails, saying where, when the mod's durable agent isn't built", async () => {
  const { modDir, directories } = scene()
  rmSync(join(modDir, durableAgentBuild))
  const failed = await Effect.runPromise(
    Effect.flip(copySessionMod(modDir, directories, nodeModules)),
  )
  expect(failed.message).toContain(`could not copy the mod into ${directories.mod}`)
})
