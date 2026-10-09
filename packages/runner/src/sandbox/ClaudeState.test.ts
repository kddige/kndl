import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, relative } from "node:path"
import type { SessionId } from "@kndl/protocol"
import { Effect } from "effect"
import { ensureTranscript } from "./ClaudeState.ts"
import { FakeSandboxBackend } from "./FakeSandboxBackend.ts"
import { SandboxBackend } from "./SandboxBackend.ts"
import { sessionSandboxSpec } from "./SessionLayout.ts"

const s1 = "s-1" as SessionId
const conversation = "0b6d6c1e-2f4a-4c3b-9d8e-7a6b5c4d3e2f"

const file = async (path: string, content: string) => {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, content)
}

let root = ""
/** The host Session directory Claude Code ran in, before it moved into the Sandbox. */
let cwd = ""
/** Claude Code's projects directory on the host. */
let projectsDir = ""
/** Where Claude Code on the host kept what it had of `cwd`. */
let project = ""
/** A file on the host the Sandbox must never see, such as Claude Code's login. */
let secret = ""
/** A directory on the host the Sandbox must never see, such as the Runner's. */
let secrets = ""

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "kndl-claude-state-")))
  cwd = join(root, "sessions", "s-1", "claude")
  projectsDir = join(root, "home", ".claude", "projects")
  project = join(projectsDir, cwd.replace(/[^a-zA-Z0-9]/g, "-"))
  secret = join(root, "home", ".claude", ".credentials.json")
  await mkdir(cwd, { recursive: true })
  await mkdir(project, { recursive: true })
  await writeFile(secret, "sk-ant-oat01-secret")
  secrets = join(root, "home", ".kndl")
  await file(join(secrets, "runner.env"), "KNDL_RUNNER_TOKEN=secret")
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

/**
 * Runs `ensureTranscript` for conversation `id` in a running Sandbox that has no transcript of
 * its own, giving whether there is one to resume and the files on Claude Code's state volume.
 */
const ensure = (id: string) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const backend = yield* SandboxBackend
      const world = yield* FakeSandboxBackend
      yield* backend.create(
        sessionSandboxSpec({ sessionId: s1, image: "alpine", workspaceHostPath: cwd, env: {} }),
      )
      const found = yield* ensureTranscript(backend, s1, id, { cwd, projectsDir })
      const volume = world.volumes.get("kndl-s-1.claude") ?? new Map<string, Uint8Array>()
      return {
        found,
        files: Object.fromEntries(
          [...volume].map(([path, data]) => [path, new TextDecoder().decode(data)]),
        ),
      }
    }).pipe(
      Effect.provide(FakeSandboxBackend.layer({ onExec: () => Effect.succeed({ exitCode: 1 }) })),
    ),
  )

describe("ensureTranscript", () => {
  test("copies a transcript Claude Code had on the host into the Sandbox, with its directory", async () => {
    await file(join(project, `${conversation}.jsonl`), "{}\n")
    await file(join(project, conversation, "subagents", "agent-a1.jsonl"), "{}\n")

    expect(await ensure(conversation)).toEqual({
      found: true,
      files: {
        [`/projects/-workspace/${conversation}.jsonl`]: "{}\n",
        [`/projects/-workspace/${conversation}/subagents/agent-a1.jsonl`]: "{}\n",
      },
    })
  })

  test("refuses an id that isn't a Claude Code session id, copying nothing", async () => {
    // Code in the Sandbox writes to the Workspace, on the host, and names it as its conversation.
    const workspace = join(root, "sessions", "s-1", "workspace")
    await file(join(workspace, "x.jsonl"), "{}\n")
    await symlink(secrets, join(workspace, "x"))
    const id = relative(project, join(workspace, "x"))

    expect(await ensure(id)).toEqual({ found: false, files: {} })
  })

  test("refuses a transcript that is a symlink, copying nothing", async () => {
    await symlink(secret, join(project, `${conversation}.jsonl`))

    expect(await ensure(conversation)).toEqual({ found: false, files: {} })
  })

  test("copies none of the transcript's directory that is a symlink", async () => {
    await file(join(project, `${conversation}.jsonl`), "{}\n")
    await file(join(project, conversation, "tool-results", "r1.txt"), "ok")
    await symlink(secret, join(project, conversation, "tool-results", "r2.txt"))
    await symlink(secrets, join(project, conversation, "linked"))

    expect(await ensure(conversation)).toEqual({
      found: true,
      files: {
        [`/projects/-workspace/${conversation}.jsonl`]: "{}\n",
        [`/projects/-workspace/${conversation}/tool-results/r1.txt`]: "ok",
      },
    })
  })

  test("copies nothing of a transcript's directory that is itself a symlink", async () => {
    await file(join(project, `${conversation}.jsonl`), "{}\n")
    await symlink(secrets, join(project, conversation))

    expect(await ensure(conversation)).toEqual({
      found: true,
      files: { [`/projects/-workspace/${conversation}.jsonl`]: "{}\n" },
    })
  })
})
