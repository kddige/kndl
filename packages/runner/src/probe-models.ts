// Rewrites PinnedClaudeModels (ClaudeModels.ts) from what a Claude Code build says it takes, for
// upgrading PinnedClaudeVersion: the probes the smoke test checks the table with, run here on the
// host against that build from npm. They make no API call and need no Claude login.
//
//   bun run --filter @kndl/runner probe-models             the pinned version
//   bun run --filter @kndl/runner probe-models 2.1.296     another
//
// The probes don't print the line under each model, which only Claude Code's own `/model` picker
// has. The table's lines are kept by alias; a new alias gets none, and is named so one is added.
// Then run the smoke test (SandboxClaude.ts says how), which checks the table in a real Sandbox.

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  type ModelProbe,
  modelProbeFlags,
  parseEfforts,
  parseModelProbe,
  PinnedClaudeModels,
  runnerModels,
} from "./ClaudeModels.ts"
import { PinnedClaudeVersion } from "./sandbox/SandboxClaude.ts"

const version = process.argv[2] ?? PinnedClaudeVersion

const run = async (command: ReadonlyArray<string>, cwd?: string) => {
  const proc = Bun.spawn([...command], {
    ...(cwd !== undefined && { cwd }),
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  if (code !== 0) throw new Error(`${command.join(" ")} exited ${code}: ${stderr.trim()}`)
  return stdout
}

const dir = await mkdtemp(join(tmpdir(), "kndl-probe-models-"))
try {
  await writeFile(join(dir, "package.json"), "{}")
  console.error(`Getting Claude Code ${version}…`)
  await run(["bun", "add", `@anthropic-ai/claude-code@${version}`], dir)
  const claude = join(dir, "node_modules", ".bin", "claude")
  const said = (await run([claude, "--version"])).trim()
  if (!said.startsWith(version)) throw new Error(`asked for ${version}, got ${said}`)

  const probe = (args: ReadonlyArray<string>) => run([claude, ...modelProbeFlags, ...args], dir)
  const bare = parseModelProbe(await probe(["-p", "/model"]))
  if (bare === undefined) throw new Error("claude -p /model said no model")
  const efforts = parseEfforts(await probe(["-p", "/effort"]))
  const probes = new Map<string, ModelProbe>()
  await Promise.all(
    bare.aliases.map(async (alias) => {
      const found = parseModelProbe(await probe(["--model", alias, "-p", "/model"]))
      if (found !== undefined) probes.set(alias, found)
    }),
  )
  const models = runnerModels(bare, probes, efforts)

  if (Bun.deepEquals(models, PinnedClaudeModels)) {
    console.error(`PinnedClaudeModels is what Claude Code ${version} takes already.`)
  } else {
    const file = join(import.meta.dir, "ClaudeModels.ts")
    const source = await readFile(file, "utf8")
    const table = /(export const PinnedClaudeModels: RunnerModels = )\{[\s\S]*?\n\}\n/
    if (!table.test(source)) throw new Error(`no PinnedClaudeModels table in ${file}`)
    await writeFile(
      file,
      source.replace(table, (_, head: string) => `${head}${JSON.stringify(models, null, 2)}\n`),
    )
    await run(["bunx", "oxfmt", "--write", file])
    console.error(`Rewrote PinnedClaudeModels in ${file} for Claude Code ${version}.`)
    const unlined = models.models.filter((model) => model.description === undefined)
    if (unlined.length > 0) {
      console.error(
        `New aliases with no line, to add from Claude Code's /model picker: ${unlined.map((model) => model.alias).join(", ")}`,
      )
    }
  }
} finally {
  await rm(dir, { recursive: true, force: true })
}
