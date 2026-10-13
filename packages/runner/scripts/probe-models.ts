// Rewrites PinnedClaudeModels (ClaudeModels.ts) from what a Claude Code build says it takes, for
// upgrading PinnedClaudeVersion: the probes the smoke test checks the table with, run here on the
// host against that build from npm. They make no API call and need no Claude login.
//
//   bun run --filter @kndl/runner probe-models             the pinned version
//   bun run --filter @kndl/runner probe-models 2.1.296     another
//
// The probes don't print the line under each model, which only Claude Code's own `/model` picker
// has. The table's lines are kept by alias; a new alias gets none, and is named so one is added.
// The host's build stands in for the Sandbox's Linux one, so run the smoke test after (see
// PinnedClaudeVersion), which asks the build in a real Sandbox.

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { modelProbeFlags, PinnedClaudeModels, probeModels } from "../src/ClaudeModels.ts"
import { PinnedClaudeVersion } from "../src/sandbox/SandboxClaude.ts"

const version = process.argv[2] ?? PinnedClaudeVersion
const repo = join(import.meta.dir, "..", "..", "..")
const tableFile = join(import.meta.dir, "..", "src", "ClaudeModels.ts")

/** Runs a command to its end, and gives back its output; killed if `signal` aborts. */
const run = async (command: ReadonlyArray<string>, cwd: string, signal?: AbortSignal) => {
  const proc = Bun.spawn([...command], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    ...(signal !== undefined && { signal }),
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
  const said = (await run([claude, "--version"], dir)).trim().split(" ")[0]
  if (said !== version) throw new Error(`asked for Claude Code ${version}, got ${said}`)

  const models = await Effect.runPromise(
    probeModels((args) =>
      Effect.tryPromise((signal) => run([claude, ...modelProbeFlags, ...args], dir, signal)),
    ),
  )

  if (Bun.deepEquals(models, PinnedClaudeModels)) {
    console.error(`PinnedClaudeModels is what Claude Code ${version} takes already.`)
  } else {
    const source = await readFile(tableFile, "utf8")
    const table = /(export const PinnedClaudeModels: RunnerModels = )\{[\s\S]*?\n\}\n/
    if (!table.test(source)) throw new Error(`no PinnedClaudeModels table in ${tableFile}`)
    await writeFile(
      tableFile,
      source.replace(table, (_, head: string) => `${head}${JSON.stringify(models, null, 2)}\n`),
    )
    await run(["bun", "run", "format", tableFile], repo)
    console.error(`Rewrote PinnedClaudeModels in ${tableFile} for Claude Code ${version}.`)
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
