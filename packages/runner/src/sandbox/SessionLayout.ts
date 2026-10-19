// The usual shape of a Session's Sandbox (ADR 0006, as amended after spike #3):
//
// - The Workspace is the host directory mounted at /workspace, so the Runner can reach it while
//   the Sandbox is stopped or gone.
// - Dependency directories (node_modules) and package caches sit on the Session's own disk
//   volumes mounted over those paths, because many small files are 3-12x slower on the host
//   mount than on a disk.
// - Docker's data has its own disk volume.
// - Claude Code's state, its `CLAUDE_CONFIG_DIR` with the Session's transcripts, has its own disk
//   volume too (ADR 0013), so it survives the Sandbox being made anew.

import { posix } from "node:path"
import type { SessionId } from "@kndl/protocol"
import type { Mount, SandboxSpec } from "./SandboxBackend.ts"

export const workspaceGuestPath = "/workspace"

/**
 * The name a guest reaches its host's loopback by, as the mod relay (ADR 0026): every
 * guest's connection arrives there from 127.0.0.1.
 */
export const hostFromGuest = "host.microsandbox.internal"

/**
 * Claude Code's state in the Sandbox, its `CLAUDE_CONFIG_DIR`, on the Session's `claude` volume:
 * its config, settings and transcripts. Not under ~/.claude, as microsandbox can't put a volume at
 * a path with a dot in it.
 */
export const claudeStateGuestPath = "/var/lib/kndl/claude"

/**
 * The durable agent's state directory in the Sandbox, its `KNDL_STATE_DIR`: the `claude` volume,
 * beside Claude Code's state, so it survives sleep, and an Archived Session keeps it. The agent
 * keeps its storage, `durable/session.sqlite`, and its log, `durable/agent.log`, under it.
 */
export const agentStateGuestPath = claudeStateGuestPath

/**
 * The key of the volume holding Claude Code's state. Archiving keeps it, as it keeps the
 * Workspace, so a restored Session resumes its conversation; purging removes it.
 */
export const claudeStateVolumeKey = "claude"

/**
 * Where the Session's copy of the mod is mounted read-only in the Sandbox, the durable agent
 * under `<copy>/` (SessionMod.ts). Not where a Sandbox made before #159 mounted the Runner's own
 * mod, so such a Sandbox is made anew at its next start.
 */
export const modGuestPath = "/opt/kndl/mod"

/**
 * The durable agent in the Session's copy of the mod, which the pinned Node.js runs: one file,
 * which `bun run mod:build` writes to `durable/dist/agent.js` in the mod package (SessionMod.ts).
 */
export const durableAgent = "durable/agent.js"

export interface SessionLayoutOptions {
  readonly sessionId: SessionId
  readonly image: string
  /** The Workspace on the Runner's host. */
  readonly workspaceHostPath: string
  /** Repo secrets and any other environment for every command. */
  readonly env?: Readonly<Record<string, string>>
  readonly cpus?: number
  /** Also the hard cap: freed guest memory isn't returned to the host while the Sandbox runs. */
  readonly memoryMib?: number
  readonly rootDiskMib?: number
  /** Without an explicit quota the host mount caps guest writes at 4 GiB. */
  readonly workspaceQuotaMib?: number
  /** Dependency directories, relative to the Workspace, each on its own volume. */
  readonly dependencyDirs?: ReadonlyArray<string>
  readonly dependencySizeMib?: number
  readonly cacheSizeMib?: number
  readonly claudeSizeMib?: number
  /** Docker's data volume, or `false` for a Sandbox without Docker. */
  readonly dockerSizeMib?: number | false
}

export const defaults = {
  cpus: 2,
  memoryMib: 4096,
  rootDiskMib: 16384,
  workspaceQuotaMib: 65536,
  dependencyDirs: ["node_modules"],
  dependencySizeMib: 16384,
  cacheSizeMib: 16384,
  claudeSizeMib: 8192,
  dockerSizeMib: 32768,
} as const

/** The volume key for a dependency directory: `deps-` and the path, made safe. */
export const dependencyVolumeKey = (dir: string) =>
  `deps-${dir
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")}`.slice(0, 32)

/**
 * Where the package caches live. Not ~/.cache: microsandbox can't put a volume at a path with a
 * dot in it, so tools are pointed here through the environment instead.
 */
export const cacheGuestPath = "/var/cache/kndl"

/**
 * Points Bun and npm into the cache volume; most other tools follow XDG_CACHE_HOME. Stored with a
 * Sandbox without an Environment, and passed to each process in one with an Environment, whose
 * Sandboxes keep no environment of their own (ADR 0009).
 */
export const cacheEnv: Readonly<Record<string, string>> = {
  XDG_CACHE_HOME: cacheGuestPath,
  BUN_INSTALL_CACHE_DIR: posix.join(cacheGuestPath, "bun"),
  npm_config_cache: posix.join(cacheGuestPath, "npm"),
}

export const sessionSandboxSpec = (options: SessionLayoutOptions): SandboxSpec => {
  const cache = cacheGuestPath
  const dependencyDirs = options.dependencyDirs ?? defaults.dependencyDirs
  const dockerSizeMib = options.dockerSizeMib ?? defaults.dockerSizeMib

  const mounts: Array<Mount> = [
    {
      _tag: "Host",
      hostPath: options.workspaceHostPath,
      guestPath: workspaceGuestPath,
      quotaMib: options.workspaceQuotaMib ?? defaults.workspaceQuotaMib,
    },
    ...dependencyDirs.map((dir): Mount => ({
      _tag: "Volume",
      key: dependencyVolumeKey(dir),
      guestPath: posix.join(workspaceGuestPath, dir),
      sizeMib: options.dependencySizeMib ?? defaults.dependencySizeMib,
    })),
    // One volume for every package manager's cache: Bun and npm are pointed into it below, and
    // most other tools follow XDG_CACHE_HOME. Mounting over ~/.bun would hide a Bun installed there.
    {
      _tag: "Volume",
      key: "cache",
      guestPath: cache,
      sizeMib: options.cacheSizeMib ?? defaults.cacheSizeMib,
    },
    {
      _tag: "Volume",
      key: claudeStateVolumeKey,
      guestPath: claudeStateGuestPath,
      sizeMib: options.claudeSizeMib ?? defaults.claudeSizeMib,
    },
  ]

  return {
    sessionId: options.sessionId,
    image: options.image,
    cpus: options.cpus ?? defaults.cpus,
    memoryMib: options.memoryMib ?? defaults.memoryMib,
    rootDiskMib: options.rootDiskMib ?? defaults.rootDiskMib,
    mounts,
    ...(dockerSizeMib === false ? {} : { docker: { sizeMib: dockerSizeMib } }),
    env: { ...cacheEnv, ...options.env },
    workdir: workspaceGuestPath,
  }
}
