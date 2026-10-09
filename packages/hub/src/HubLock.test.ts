// The database's lock (HubLock.ts): held by a running Hub, refused to anything else meanwhile,
// and free again once the holder is gone, however it went.

import { afterEach, describe, expect, test } from "bun:test"
import { readdirSync, rmSync } from "node:fs"
import { dirname, join } from "node:path"
import { Effect, Exit, Scope } from "effect"
import { holdHubLock } from "./HubLock.ts"
import { startHubProcess, testDatabaseDir } from "./testSupport.ts"

const dirs: Array<string> = []
const children: Array<Bun.Subprocess> = []

afterEach(() => {
  for (const child of children.splice(0)) child.kill("SIGKILL")
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const databaseFile = () => {
  const dir = testDatabaseDir("kndl-lock-")
  dirs.push(dir)
  return join(dir, "hub.db")
}

/** Takes the lock, held until the returned scope is closed; or the refusal's message. */
async function take(database: string) {
  const scope = Scope.makeUnsafe()
  const exit = await Effect.runPromiseExit(
    Scope.provide(holdHubLock(database, "Can't do it"), scope),
  )
  if (Exit.isSuccess(exit))
    return { scope, release: () => Effect.runPromise(Scope.close(scope, Exit.void)) }
  await Effect.runPromise(Scope.close(scope, Exit.void))
  return { refused: String(exit.cause) }
}

describe("The Hub's lock", () => {
  test("is held by one at a time, and free again once released", async () => {
    const database = databaseFile()
    const first = await take(database)
    expect("release" in first).toBe(true)
    const second = await take(database)
    expect("refused" in second && second.refused).toContain(
      `Can't do it: a Hub is running on ${database}. Stop it first.`,
    )
    if ("release" in first) await first.release()
    const third = await take(database)
    expect("release" in third).toBe(true)
    if ("release" in third) await third.release()
  })

  test("an in-memory database has none to take", async () => {
    const first = await take(":memory:")
    const second = await take(":memory:")
    expect("release" in first && "release" in second).toBe(true)
  })

  test("a running Hub holds it, and drops it when it ends, even killed", async () => {
    const database = databaseFile()
    const hub = await startHubProcess(database)
    children.push(hub.child)
    expect("refused" in (await take(database))).toBe(true)

    // A second Hub on the same database doesn't start.
    const second = await startHubProcess(database).then(
      () => "started",
      (cause: unknown) => String(cause),
    )
    expect(second).toContain("The Hub can't start: a Hub is running on")

    hub.child.kill("SIGKILL")
    await hub.child.exited
    // Nothing of the lock's is left beside it but the lock file, which the home expects.
    expect(readdirSync(dirname(database)).filter((name) => name.startsWith("hub.db.lock"))).toEqual(
      ["hub.db.lock"],
    )
    const after = await take(database)
    expect("release" in after).toBe(true)
    if ("release" in after) await after.release()
  }, 15_000)
})
