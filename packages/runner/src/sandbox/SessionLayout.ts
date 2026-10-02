// The usual shape of a Session's Sandbox (ADR 0006, as amended after spike #3):
//
// - The Workspace is the host directory mounted at /workspace, so the Runner can reach it while
//   the Sandbox is stopped or gone.
// - Dependency directories (node_modules) and package caches sit on the Session's own disk
//   volumes mounted over those paths, because many small files are 3-12x slower on the host
//   mount than on a disk.
// - Docker's data has its own disk volume.

import { posix } from "node:path"
import type { SessionId } from "@claude-hub/protocol"
import type { Mount, SandboxSpec } from "./SandboxBackend.ts"

export const workspaceGuestPath = "/workspace"

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
export const cacheGuestPath = "/var/cache/claude-hub"

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
  ]

  return {
    sessionId: options.sessionId,
    image: options.image,
    cpus: options.cpus ?? defaults.cpus,
    memoryMib: options.memoryMib ?? defaults.memoryMib,
    rootDiskMib: options.rootDiskMib ?? defaults.rootDiskMib,
    mounts,
    ...(dockerSizeMib === false ? {} : { docker: { sizeMib: dockerSizeMib } }),
    env: {
      XDG_CACHE_HOME: cache,
      BUN_INSTALL_CACHE_DIR: posix.join(cache, "bun"),
      npm_config_cache: posix.join(cache, "npm"),
      ...options.env,
    },
    workdir: workspaceGuestPath,
  }
}
