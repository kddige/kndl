import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { RepoName, RunnerToHub, SandboxStateReport, SessionId } from "@claude-hub/protocol"
import { Effect, Layer, Schedule } from "effect"
import { HubGit } from "./HubGit.ts"
import { HubLink } from "./HubLink.ts"
import { Sandboxes } from "./Sandbox.ts"
import type { SandboxTarget } from "./Sandbox.ts"
import { FakeSandboxBackend } from "./sandbox/FakeSandboxBackend.ts"
import type { FakeOptions } from "./sandbox/FakeSandboxBackend.ts"
import { volumeName } from "./sandbox/Naming.ts"
import { SandboxBackend } from "./sandbox/SandboxBackend.ts"
import {
  SandboxClaudeError,
  sandboxClaudeGuestDir,
  sandboxClaudePath,
} from "./sandbox/SandboxClaude.ts"
import {
  claudeStateGuestPath,
  claudeStateVolumeKey,
  modGuestPath,
  workspaceGuestPath,
} from "./sandbox/SessionLayout.ts"
import { ghHostsPath, identityScript, tokenPath } from "./SandboxGitHub.ts"
import type { SandboxTokenSource } from "./SandboxGitHub.ts"
import { sessionDirectories } from "./SessionNames.ts"
import { makeSessionSandboxes } from "./SessionSandboxes.ts"
import { FakeHubGit, FakeHubVariables, sandboxesDefaults, sessionId } from "./testSupport.ts"

const s1 = sessionId("s-1")

/** What a Session of a Repo without an Environment starts its Sandbox for. */
const target: SandboxTarget = { repo: "acme/app" as RepoName }

/** Runs `body` with live Sandboxes on the fake backend, recording what goes to the Hub. */
const withSandboxes = async (
  body: (
    root: string,
    sent: Array<RunnerToHub>,
  ) => Effect.Effect<void, unknown, Sandboxes | FakeSandboxBackend | SandboxBackend>,
  options: FakeOptions & {
    readonly sandboxClaude?: Effect.Effect<string, SandboxClaudeError>
    readonly githubToken?: SandboxTokenSource
  } = {},
) => {
  const root = await mkdtemp(join(tmpdir(), "claude-hub-sandboxes-"))
  await mkdir(join(root, "mod"))
  const sent: Array<RunnerToHub> = []
  const hub = Layer.succeed(
    HubLink,
    HubLink.of({
      send: (message) => Effect.sync(() => void sent.push(message)),
      connect: () => Effect.void,
      disconnect: Effect.void,
    }),
  )
  const sandboxes = Layer.effect(
    Sandboxes,
    makeSessionSandboxes({
      image: "docker:dind",
      claudeCacheDir: join(root, "claude-code"),
      sandboxClaude: () => options.sandboxClaude ?? Effect.succeed("2.1.287"),
      modDir: join(root, "mod"),
      ...sandboxesDefaults,
      ...(options.githubToken === undefined ? {} : { githubToken: options.githubToken }),
    }),
  )
  try {
    await body(root, sent).pipe(
      Effect.provide(
        sandboxes.pipe(
          Layer.provideMerge(FakeSandboxBackend.layer({ checkHostPaths: true, ...options })),
        ),
      ),
      Effect.provide(hub),
      Effect.provide(new FakeHubVariables().layer),
      Effect.scoped,
      Effect.runPromise,
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

const states = (sent: ReadonlyArray<RunnerToHub>) =>
  sent.filter((m): m is SandboxStateReport => m._tag === "SandboxStateReport").map((m) => m.state)

const directoriesIn = (root: string) =>
  Effect.promise(async () => {
    const directories = sessionDirectories(root, s1)
    await mkdir(directories.workspace, { recursive: true })
    await mkdir(directories.claude, { recursive: true })
    return directories
  })

/** Asks the Hub for a Sandbox token. */
const hubGitAsk = (id: SessionId) =>
  Effect.flatMap(HubGit, (hubGit) => hubGit.ask(id, { _tag: "SandboxToken" }))

/** Waits, polling, until `check` holds; fails the test after a second. */
const eventually = (check: Effect.Effect<boolean, unknown>) =>
  check.pipe(
    Effect.flatMap((held) => (held ? Effect.void : Effect.fail("not yet" as const))),
    Effect.retry({ schedule: Schedule.spaced("5 millis"), times: 200 }),
  )

describe("SessionSandboxes", () => {
  test("boots the Session's Sandbox around its Workspace, readies Claude Code there, then stops it", () =>
    withSandboxes((root, sent) =>
      Effect.gen(function* () {
        const sandboxes = yield* Sandboxes
        const world = yield* FakeSandboxBackend
        const backend = yield* SandboxBackend
        const directories = yield* directoriesIn(root)

        const started = yield* sandboxes.start(s1, directories, target)
        const spec = world.sandboxes.get(s1)?.spec
        expect(spec?.mounts).toContainEqual(
          expect.objectContaining({
            _tag: "Host",
            hostPath: directories.workspace,
            guestPath: workspaceGuestPath,
          }),
        )
        // Claude Code and the mod, read-only; its state on a volume of the Session's; and nothing
        // of the host's Claude configuration.
        expect(spec?.mounts).toContainEqual(
          expect.objectContaining({
            hostPath: join(root, "claude-code"),
            guestPath: sandboxClaudeGuestDir,
            readOnly: true,
          }),
        )
        expect(spec?.mounts).toContainEqual(
          expect.objectContaining({
            hostPath: join(root, "mod"),
            guestPath: modGuestPath,
            readOnly: true,
          }),
        )
        expect(spec?.mounts).toContainEqual(
          expect.objectContaining({
            _tag: "Volume",
            key: "claude",
            guestPath: claudeStateGuestPath,
          }),
        )
        expect(JSON.stringify(spec)).not.toContain(".claude.json")
        expect(states(sent)).toEqual(["Starting", "Running"])
        expect((yield* Effect.promise(() => stat(directories.session))).mode & 0o777).toBe(0o700)

        // What Claude Code runs as in it, and with.
        expect(started.claude).toEqual({
          path: sandboxClaudePath("2.1.287", "musl"),
          env: expect.objectContaining({
            HOME: "/root",
            LANG: "C.UTF-8",
            CLAUDE_CONFIG_DIR: claudeStateGuestPath,
            IS_SANDBOX: "1",
          }),
        })
        // tmux and bash, installed if the image lacks them, and Claude Code's state seeded.
        const needs = new TextDecoder().decode(
          yield* backend.readFile(s1, "/tmp/claude-hub-claude-needs.sh"),
        )
        expect(needs).toContain("command -v tmux")
        expect(needs).toContain("command -v bash")
        const config = JSON.parse(
          new TextDecoder().decode(
            yield* backend.readFile(s1, `${claudeStateGuestPath}/.claude.json`),
          ),
        ) as unknown
        expect(config).toMatchObject({
          hasCompletedOnboarding: true,
          projects: { [workspaceGuestPath]: { hasTrustDialogAccepted: true } },
        })

        yield* sandboxes.stop(s1, "Sleep")
        expect(world.sandboxes.get(s1)?.state).toBe("Stopped")

        // Waking starts the same Sandbox again rather than creating another.
        yield* sandboxes.start(s1, directories, target)
        expect(world.sandboxes.get(s1)?.state).toBe("Running")
        // Starting a running one changes nothing.
        yield* sandboxes.start(s1, directories, target)

        yield* sandboxes.stop(s1, "Archive")
        expect(world.sandboxes.has(s1)).toBe(false)
        expect(states(sent)).toEqual([
          "Starting",
          "Running",
          "Stopping",
          "Stopped",
          "Starting",
          "Running",
          "Stopping",
          "Destroyed",
        ])
      }),
    ))

  test("makes a Sandbox from before Claude Code ran in Sandboxes anew, keeping its volumes", () => {
    let probes = 0
    return withSandboxes(
      (root) =>
        Effect.gen(function* () {
          const sandboxes = yield* Sandboxes
          const world = yield* FakeSandboxBackend
          const directories = yield* directoriesIn(root)
          yield* sandboxes.start(s1, directories, target)
          yield* sandboxes.stop(s1, "Sleep")
          for (const files of world.volumes.values()) files.set("/kept", new Uint8Array([1]))

          // Its next start finds it without the mod's mount, as an older Runner made it.
          yield* sandboxes.start(s1, directories, target)
          expect(probes).toBe(1)
          expect(world.sandboxes.get(s1)?.state).toBe("Running")
          expect([...world.volumes.values()].every((files) => files.has("/kept"))).toBe(true)
        }),
      {
        onExec: ({ request }) => {
          if (request.args?.[1]?.startsWith("test -d") !== true) return Effect.succeed({})
          probes += 1
          return Effect.succeed({ exitCode: 1 })
        },
      },
    )
  })

  test("a Sandbox whose image can't get tmux or bash fails to start, saying why", () =>
    withSandboxes(
      (root, sent) =>
        Effect.gen(function* () {
          const sandboxes = yield* Sandboxes
          const directories = yield* directoriesIn(root)
          const failed = yield* Effect.flip(sandboxes.start(s1, directories, target))
          expect(failed.message).toContain("no package manager")
          expect(sent).toContainEqual(
            expect.objectContaining({ _tag: "SandboxStateReport", state: "Failed" }),
          )
        }),
      {
        onExec: ({ request }) =>
          Effect.succeed(
            request.args?.at(-1) === "/tmp/claude-hub-claude-needs.sh"
              ? {
                  exitCode: 1,
                  stderr:
                    "The image has no tmux bash, and no package manager to install it with.\n",
                }
              : {},
          ),
      },
    ))

  test("a Sandbox that can't get Claude Code fails to start, and the next start tries again", () => {
    let attempts = 0
    return withSandboxes(
      (root, sent) =>
        Effect.gen(function* () {
          const sandboxes = yield* Sandboxes
          const world = yield* FakeSandboxBackend
          const directories = yield* directoriesIn(root)

          const failed = yield* Effect.flip(sandboxes.start(s1, directories, target))
          expect(failed.message).toContain("registry said 404")
          expect(sent).toContainEqual(
            expect.objectContaining({ _tag: "SandboxStateReport", state: "Failed" }),
          )
          expect(world.sandboxes.size).toBe(0)

          yield* sandboxes.start(s1, directories, target)
          expect(attempts).toBe(2)
          expect(world.sandboxes.get(s1)?.state).toBe("Running")
        }),
      {
        sandboxClaude: Effect.suspend(() => {
          attempts += 1
          return attempts === 1
            ? Effect.fail(new SandboxClaudeError({ message: "registry said 404" }))
            : Effect.succeed("2.1.287")
        }),
      },
    )
  })

  test("archiving destroys the Sandbox and its volumes but Claude Code's state; a restored Session wakes on it", () =>
    withSandboxes((root) =>
      Effect.gen(function* () {
        const sandboxes = yield* Sandboxes
        const world = yield* FakeSandboxBackend
        const directories = yield* directoriesIn(root)
        yield* sandboxes.start(s1, directories, target)
        const volumes = [...world.volumes.keys()]
        expect(volumes.length).toBeGreaterThan(1)
        for (const name of volumes) world.volumes.get(name)?.set("/kept", new Uint8Array([1]))
        const claudeVolume = volumeName(s1, claudeStateVolumeKey)

        yield* sandboxes.stop(s1, "Archive")
        expect(world.sandboxes.has(s1)).toBe(false)
        expect([...world.volumes.keys()]).toEqual([claudeVolume])

        // Woken after a restore: a new Sandbox on the kept Workspace and Claude Code's state, with
        // its other volumes empty.
        yield* sandboxes.start(s1, directories, target)
        expect(world.sandboxes.get(s1)?.state).toBe("Running")
        expect(world.sandboxes.get(s1)?.spec.mounts).toContainEqual(
          expect.objectContaining({ _tag: "Host", hostPath: directories.workspace }),
        )
        expect([...world.volumes.keys()].toSorted()).toEqual([...volumes].toSorted())
        for (const [name, files] of world.volumes) {
          expect(files.has("/kept")).toBe(name === claudeVolume)
        }
      }),
    ))

  test("purging destroys whatever is left: the Sandbox, or only its volumes", () =>
    withSandboxes((root, sent) =>
      Effect.gen(function* () {
        const sandboxes = yield* Sandboxes
        const world = yield* FakeSandboxBackend
        const directories = yield* directoriesIn(root)
        yield* sandboxes.start(s1, directories, target)
        yield* sandboxes.purge(s1)
        expect(world.sandboxes.has(s1)).toBe(false)
        expect(world.volumes.size).toBe(0)

        // Volumes left over from a Sandbox destroyed while keeping them.
        yield* sandboxes.start(s1, directories, target)
        const backend = yield* SandboxBackend
        yield* backend.destroy(s1, { keepVolumes: true })
        expect(world.volumes.size).toBeGreaterThan(0)
        yield* sandboxes.purge(s1)
        expect(world.volumes.size).toBe(0)

        // Nothing left is fine.
        const before = sent.length
        yield* sandboxes.purge(s1)
        expect(sent.length).toBe(before)
      }),
    ))

  test("reconciling stops Sandboxes of Sessions that aren't running", () =>
    withSandboxes((root) =>
      Effect.gen(function* () {
        const sandboxes = yield* Sandboxes
        const world = yield* FakeSandboxBackend
        yield* sandboxes.start(s1, yield* directoriesIn(root), target)
        yield* sandboxes.reconcile([])
        expect(world.sandboxes.get(s1)?.state).toBe("Stopped")
      }),
    ))

  test("lists the Sandboxes running, and takes one back as it runs, after a restart (#157)", () =>
    withSandboxes((root) =>
      Effect.gen(function* () {
        const sandboxes = yield* Sandboxes
        const world = yield* FakeSandboxBackend
        const directories = yield* directoriesIn(root)
        expect(yield* sandboxes.running).toEqual([])

        const started = yield* sandboxes.start(s1, directories, target)
        expect(yield* sandboxes.running).toEqual([s1])
        const sandbox = world.sandboxes.get(s1)

        // What Claude Code runs as, the same as at its start; the Sandbox is left as it is.
        expect(yield* sandboxes.keep(s1, directories)).toEqual(started)
        expect(started.claude.env).toMatchObject({
          TZ: Intl.DateTimeFormat().resolvedOptions().timeZone,
        })
        expect(world.sandboxes.get(s1)).toBe(sandbox)
        expect(sandbox?.state).toBe("Running")

        yield* sandboxes.stop(s1, "Sleep")
        expect(yield* sandboxes.running).toEqual([])
      }),
    ))

  test("keeps a running Sandbox with its own GitHub token, fresh at each start and wake", () => {
    const hubGit = new FakeHubGit("acme/app")
    hubGit.useToken("ghs_HOSTonly", {
      name: "app[bot]",
      email: "9+app[bot]@users.noreply.github.com",
    })
    return withSandboxes(
      (root) =>
        Effect.gen(function* () {
          const sandboxes = yield* Sandboxes
          const world = yield* FakeSandboxBackend
          const backend = yield* SandboxBackend
          const tokenFile = Effect.suspend(() => backend.readFile(s1, tokenPath)).pipe(
            Effect.map((bytes) => new TextDecoder().decode(bytes)),
            Effect.orElseSucceed(() => undefined),
          )
          const directories = yield* directoriesIn(root)

          yield* sandboxes.start(s1, directories, target)
          yield* eventually(Effect.map(tokenFile, (token) => token === "sandbox-1"))
          expect(new TextDecoder().decode(yield* backend.readFile(s1, ghHostsPath))).toContain(
            'oauth_token: "sandbox-1"',
          )

          yield* sandboxes.stop(s1, "Sleep")
          yield* sandboxes.start(s1, directories, target)
          yield* eventually(Effect.map(tokenFile, (token) => token === "sandbox-2"))
          expect(hubGit.asked.map((asked) => asked.ask._tag)).toEqual([
            "SandboxToken",
            "SandboxToken",
          ])

          // Neither its settings nor any command it ran were given a token.
          const seen = JSON.stringify({
            specs: [...world.sandboxes.values()].map((sandbox) => sandbox.spec),
            exec: world.execCalls,
            spawn: world.spawnCalls,
          })
          for (const token of ["ghs_HOSTonly", ...hubGit.sandboxTokens]) {
            expect(seen).not.toContain(token)
          }
        }),
      {
        githubToken: (id) => Effect.provide(hubGitAsk(id), hubGit.layer),
      },
    )
  })

  test("sets git's identity in the Sandbox at each start, to the Session's Creator", () =>
    withSandboxes((root) =>
      Effect.gen(function* () {
        const sandboxes = yield* Sandboxes
        const world = yield* FakeSandboxBackend
        const directories = yield* directoriesIn(root)
        const gitIdentity = { name: "Ada Lovelace", email: "1+ada@users.noreply.github.com" }
        const identitySets = () =>
          world.execCalls.filter((call) => call.request.args?.[1] === identityScript)

        yield* sandboxes.start(s1, directories, { ...target, gitIdentity })
        expect(identitySets().map((call) => call.request.args?.slice(3))).toEqual([
          ["Ada Lovelace", "1+ada@users.noreply.github.com"],
        ])

        // From an older Hub there is none.
        yield* sandboxes.stop(s1, "Sleep")
        yield* sandboxes.start(s1, directories, target)
        expect(identitySets()).toHaveLength(1)
      }),
    ))

  test("a Sandbox that gets no GitHub token, as without a GitHub App, starts all the same", () => {
    const hubGit = new FakeHubGit("acme/app")
    return withSandboxes(
      (root, sent) =>
        Effect.gen(function* () {
          const sandboxes = yield* Sandboxes
          const backend = yield* SandboxBackend
          yield* sandboxes.start(s1, yield* directoriesIn(root), target)
          yield* eventually(Effect.sync(() => hubGit.asked.length === 1))
          expect(states(sent)).toEqual(["Starting", "Running"])
          expect(
            yield* backend.readFile(s1, tokenPath).pipe(
              Effect.as(true),
              Effect.orElseSucceed(() => false),
            ),
          ).toBe(false)
        }),
      {
        githubToken: (id) => Effect.provide(hubGitAsk(id), hubGit.layer),
      },
    )
  })
})
