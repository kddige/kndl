// Checks on a SandboxSpec that every backend applies before creating anything.

import { posix } from "node:path"
import { Effect } from "effect"
import { checkSessionId, isVolumeKey } from "./Naming.ts"
import { InvalidSandboxSpec } from "./SandboxBackend.ts"
import type { SandboxSpec, VolumeMount } from "./SandboxBackend.ts"

/** Where Docker keeps its data in the guest, on the Session's `docker` volume. */
export const dockerDataPath = "/var/lib/docker"

/** The smallest disk volume the backend can format. */
export const minVolumeMib = 256

/** The spec's Session volumes, including Docker's. */
export const specVolumes = (spec: SandboxSpec): ReadonlyArray<VolumeMount> => [
  ...spec.mounts.filter((mount): mount is VolumeMount => mount._tag === "Volume"),
  ...(spec.docker === undefined
    ? []
    : [
        {
          _tag: "Volume" as const,
          key: "docker",
          guestPath: dockerDataPath,
          sizeMib: spec.docker.sizeMib,
        },
      ]),
]

const invalid = (message: string) => Effect.fail(new InvalidSandboxSpec({ message }))

export const checkSpec = Effect.fn(function* (spec: SandboxSpec) {
  yield* checkSessionId(spec.sessionId)
  if (spec.image.trim() === "") return yield* invalid("image is empty")
  if (!Number.isInteger(spec.cpus) || spec.cpus < 1) return yield* invalid("cpus must be 1 or more")
  if (!Number.isInteger(spec.memoryMib) || spec.memoryMib < 256)
    return yield* invalid("memoryMib must be 256 or more")

  const guestPaths = new Set<string>()
  const keys = new Set<string>()
  const mounts = [...spec.mounts.filter((mount) => mount._tag === "Host"), ...specVolumes(spec)]
  for (const mount of mounts) {
    if (!posix.isAbsolute(mount.guestPath) || posix.normalize(mount.guestPath) !== mount.guestPath)
      return yield* invalid(`guest path ${mount.guestPath} must be absolute and normalised`)
    if (guestPaths.has(mount.guestPath)) return yield* invalid(`two mounts at ${mount.guestPath}`)
    guestPaths.add(mount.guestPath)

    if (mount._tag === "Host") {
      if (!posix.isAbsolute(mount.hostPath))
        return yield* invalid(`host path ${mount.hostPath} must be absolute`)
      if (!Number.isInteger(mount.quotaMib) || mount.quotaMib < 1)
        return yield* invalid(`quota for ${mount.guestPath} must be 1 MiB or more`)
    } else {
      // microsandbox 0.7.6 can't boot a disk volume whose guest path has a dot in it ("invalid or
      // reserved device id"), and the failed Sandbox is recorded again as crashed when the
      // process exits, even after it was removed. So it is refused before anything is made.
      if (mount.guestPath.includes("."))
        return yield* invalid(`volume guest path ${mount.guestPath} must not contain "."`)
      if (!isVolumeKey(mount.key))
        return yield* invalid(
          `volume key ${JSON.stringify(mount.key)} must match [a-z0-9][a-z0-9_-]*`,
        )
      if (keys.has(mount.key)) return yield* invalid(`two volumes with key ${mount.key}`)
      keys.add(mount.key)
      if (!Number.isInteger(mount.sizeMib) || mount.sizeMib < minVolumeMib)
        return yield* invalid(`volume ${mount.key} must be ${minVolumeMib} MiB or more`)
    }
  }
})
