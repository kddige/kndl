// The install script the Hub serves at GET /cli (cli-install.sh), run by sh against a test Hub
// with real curl, in a temp HOME, with `uname`, `sysctl` and `codesign` stubbed so one machine
// can play every platform.

import { afterEach, describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises"
import { join } from "node:path"
import type { CliTarget } from "@claude-hub/protocol"
import { commit, fakeBinary, fakeBuilds, removeTempDirs, tempDir } from "./cliTestSupport.ts"
import { startHub, stopHubs } from "./testSupport.ts"

afterEach(async () => {
  await stopHubs()
  await removeTempDirs()
})

const version = `claude-hub v${commit.slice(0, 12)}`

interface Machine {
  /** What `uname -s` and `uname -m` say. */
  readonly os: string
  readonly arch: string
  /** What `sysctl -n sysctl.proc_translated` says: 1 under Rosetta. */
  readonly translated?: string
}

/** A machine: a temp HOME, and a dir of stand-ins for `uname`, `sysctl` and `codesign`. */
async function machine({ os, arch, translated }: Machine) {
  const home = await tempDir("cli-home-")
  const stubs = join(home, "stubs")
  await mkdir(stubs)
  const stub = async (name: string, body: string) => {
    await writeFile(join(stubs, name), `#!/bin/sh\n${body}\n`)
    await chmod(join(stubs, name), 0o755)
  }
  await stub("uname", `case $1 in -s) echo '${os}' ;; -m) echo '${arch}' ;; esac`)
  await stub("sysctl", translated === undefined ? "exit 1" : `echo ${translated}`)
  await stub("codesign", `echo "$@" >>'${join(home, "codesigned")}'`)
  return { home, stubs, bin: join(home, "bin") }
}

/** Fetches the Hub's install script and runs it as `curl <hub>/cli | sh` would. */
async function install(
  hubUrl: string,
  at: Awaited<ReturnType<typeof machine>>,
  options: { readonly path?: string; readonly env?: Record<string, string> } = {},
) {
  const script = await (await fetch(`${hubUrl}/cli`)).text()
  const child = Bun.spawn(["/bin/sh"], {
    stdin: new Blob([script]),
    stdout: "pipe",
    stderr: "pipe",
    env: {
      HOME: at.home,
      PATH: options.path ?? `${at.stubs}:/usr/bin:/bin`,
      CLAUDE_HUB_URL: hubUrl,
      CLAUDE_HUB_BIN_DIR: at.bin,
      ...options.env,
    },
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  return { stdout, stderr, exitCode }
}

async function hubWithBuilds() {
  const builds = fakeBuilds({ dir: await tempDir("cli-") })
  const hub = await startHub({ cliBuilds: builds.layer })
  return { hub, builds }
}

describe("the install script", () => {
  const platforms: ReadonlyArray<[Machine, CliTarget]> = [
    [{ os: "Darwin", arch: "arm64" }, "darwin-arm64"],
    [{ os: "Darwin", arch: "x86_64" }, "darwin-x64"],
    [{ os: "Darwin", arch: "x86_64", translated: "1" }, "darwin-arm64"],
    [{ os: "Darwin", arch: "x86_64", translated: "0" }, "darwin-x64"],
    [{ os: "Linux", arch: "x86_64" }, "linux-x64"],
    [{ os: "Linux", arch: "amd64" }, "linux-x64"],
    [{ os: "Linux", arch: "aarch64" }, "linux-arm64"],
    [{ os: "Linux", arch: "arm64" }, "linux-arm64"],
  ]
  for (const [platform, target] of platforms) {
    const rosetta = platform.translated === "1" ? " under Rosetta" : ""
    test(`installs the ${target} binary on ${platform.os} ${platform.arch}${rosetta}`, async () => {
      const { hub, builds } = await hubWithBuilds()
      const at = await machine(platform)
      const result = await install(hub.url, at)
      expect(result.stderr).toBe("")
      expect(result.exitCode).toBe(0)
      const dest = join(at.bin, "claude-hub")
      expect(result.stdout).toContain(`Installed ${version} in ${dest}.`)
      expect(await readFile(dest, "utf8")).toBe(fakeBinary(target, commit))
      expect((await stat(dest)).mode & 0o777).toBe(0o755)
      expect(builds.built).toEqual([target])
      // Signed again, ad hoc, on a Mac only.
      expect(existsSync(join(at.home, "codesigned"))).toBe(target.startsWith("darwin-"))
    })
  }

  for (const os of ["MINGW64_NT-10.0-19045", "MSYS_NT-10.0", "CYGWIN_NT-10.0", "Windows_NT"]) {
    test(`refuses Windows (${os}), downloading nothing`, async () => {
      const { hub, builds } = await hubWithBuilds()
      const at = await machine({ os, arch: "x86_64" })
      const result = await install(hub.url, at)
      expect(result.exitCode).toBe(1)
      expect(result.stderr).toBe(
        "claude-hub install: claude-hub doesn't run on Windows. Install it in WSL, or on a Mac or Linux machine.\n",
      )
      expect(builds.built).toEqual([])
      expect(existsSync(at.bin)).toBe(false)
    })
  }

  test("refuses an OS or an architecture the Hub doesn't build for", async () => {
    const { hub, builds } = await hubWithBuilds()
    const bsd = await install(hub.url, await machine({ os: "FreeBSD", arch: "amd64" }))
    expect(bsd.exitCode).toBe(1)
    expect(bsd.stderr).toBe(
      "claude-hub install: claude-hub runs on macOS and Linux, not FreeBSD.\n",
    )
    const arm32 = await install(hub.url, await machine({ os: "Linux", arch: "armv7l" }))
    expect(arm32.exitCode).toBe(1)
    expect(arm32.stderr).toBe("claude-hub install: claude-hub runs on arm64 and x64, not armv7l.\n")
    expect(builds.built).toEqual([])
  })

  test("records the Hub in the CLI's config, readable by its owner only", async () => {
    const { hub } = await hubWithBuilds()
    const at = await machine({ os: "Linux", arch: "x86_64" })
    expect((await install(hub.url, at)).exitCode).toBe(0)
    const config = join(at.home, ".config", "claude-hub", "cli.json")
    expect(JSON.parse(await readFile(config, "utf8"))).toEqual({ hub: hub.url })
    expect((await stat(config)).mode & 0o777).toBe(0o600)

    // Installing again from the same Hub keeps what else the file says about it.
    await writeFile(config, `{"hub":"${hub.url}","more":true}\n`)
    expect((await install(hub.url, at)).exitCode).toBe(0)
    expect(JSON.parse(await readFile(config, "utf8"))).toEqual({ hub: hub.url, more: true })

    // XDG_CONFIG_HOME moves it.
    const xdg = join(at.home, "xdg")
    expect((await install(hub.url, at, { env: { XDG_CONFIG_HOME: xdg } })).exitCode).toBe(0)
    expect(JSON.parse(await readFile(join(xdg, "claude-hub", "cli.json"), "utf8"))).toEqual({
      hub: hub.url,
    })
  })

  test("says how to put the bin dir on PATH when it isn't", async () => {
    const { hub } = await hubWithBuilds()
    const at = await machine({ os: "Linux", arch: "x86_64" })
    const off = await install(hub.url, at)
    expect(off.stdout).toContain(`${at.bin} isn't on your PATH.`)
    expect(off.stdout).toContain(`  export PATH="${at.bin}:$PATH"`)
    const on = await install(hub.url, at, { path: `${at.stubs}:${at.bin}:/usr/bin:/bin` })
    expect(on.exitCode).toBe(0)
    expect(on.stdout).not.toContain("isn't on your PATH")
  })

  test("installs into ~/.local/bin by default", async () => {
    const { hub } = await hubWithBuilds()
    const at = await machine({ os: "Linux", arch: "x86_64" })
    const result = await install(hub.url, at, { env: { CLAUDE_HUB_BIN_DIR: "" } })
    expect(result.exitCode).toBe(0)
    expect(existsSync(join(at.home, ".local", "bin", "claude-hub"))).toBe(true)
  })

  test("leaves the command of a claude-hub install alone", async () => {
    const { hub, builds } = await hubWithBuilds()
    const at = await machine({ os: "Linux", arch: "x86_64" })
    await mkdir(at.bin)
    const wrapper = "#!/bin/sh\n# claude-hub: written by install.sh. Runs the installed CLI.\n"
    await writeFile(join(at.bin, "claude-hub"), wrapper)
    const result = await install(hub.url, at)
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain("is the command of the claude-hub install on this machine")
    expect(await readFile(join(at.bin, "claude-hub"), "utf8")).toBe(wrapper)
    expect(builds.built).toEqual([])
  })

  test("says what the Hub said when it can't serve the binary", async () => {
    const builds = fakeBuilds({ dir: await tempDir("cli-"), fail: "no network" })
    const hub = await startHub({ cliBuilds: builds.layer })
    const at = await machine({ os: "Linux", arch: "aarch64" })
    const result = await install(hub.url, at)
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toBe(
      `claude-hub install: The Hub answered 500 for ${hub.url}/cli/linux-arm64: The Hub couldn't build the claude-hub CLI for linux-arm64: no network\n`,
    )
    expect(existsSync(join(at.bin, "claude-hub"))).toBe(false)
  })
})
