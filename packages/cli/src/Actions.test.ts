import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { databaseAt } from "@kndl/hub/src/Database.ts"
import { holdHubLock } from "@kndl/hub/src/HubLock.ts"
import { Effect, Exit, Option } from "effect"
import { SqlClient } from "effect/sql"
import { newSetupLink, resetHubSecrets } from "./Actions.ts"
import { type Layout, resolveLayout } from "./Layout.ts"
import { scriptedUi, Ui } from "./Ui.ts"

let scratch: string
let layout: Layout
let database: string

/** A home with a Hub set up, built once and copied for each test. */
let template: string

beforeAll(async () => {
  template = mkdtempSync(join(tmpdir(), "kndl-actions-template-"))
  writeFileSync(join(template, "hub.env"), "PORT=7777\n")
  // A database whose key is lost: a Sensitive shared variable, encrypted under it.
  await Effect.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* sql`
        INSERT INTO participants (id, login, name, created_at, updated_at)
        VALUES ('p1', 'alice', 'Alice', 0, 0)
      `
      yield* sql`
        INSERT INTO shared_variables (name, kind, value, updated_by, updated_at)
        VALUES ('GITHUB_TOKEN', 'Sensitive', 'v1:sealed', 'p1', 0)
      `
    }).pipe(Effect.provide(databaseAt(join(template, "hub.db")))),
  )
})

afterAll(() => {
  rmSync(template, { recursive: true, force: true })
})

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "kndl-actions-"))
  layout = resolveLayout({ KNDL_HOME: join(scratch, ".kndl") }, scratch)
  database = join(layout.home.dir, "hub.db")
  cpSync(template, layout.home.dir, { recursive: true })
})

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true })
})

const sharedValue = () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const [row] = yield* sql<{ readonly value: string | null }>`
        SELECT value FROM shared_variables WHERE name = 'GITHUB_TOKEN'
      `
      return row?.value
    }).pipe(Effect.provide(databaseAt(database))),
  )

const reset = (
  options: { readonly yes: boolean },
  answers: ReadonlyArray<unknown>,
  settings: { readonly interactive?: boolean } = {},
) => {
  const { ui, transcript } = scriptedUi(answers, settings)
  return Effect.runPromise(
    resetHubSecrets(layout, options).pipe(Effect.provideService(Ui, ui), Effect.exit),
  ).then((exit) => ({ exit, transcript }))
}

const failure = (exit: Exit.Exit<unknown, { readonly message: string }>) =>
  Exit.isFailure(exit) ? exit.cause.toString() : undefined

describe("kndl secrets reset", () => {
  test("asks first, and clears the Sensitive values in the home's database when told to", async () => {
    const { exit, transcript } = await reset({ yes: false }, [true])

    expect(Exit.isSuccess(exit)).toBe(true)
    expect(transcript).toEqual(["? confirm: Clear these values?"])
    expect(await sharedValue()).toBeNull()
  })

  test("clears nothing when told not to, nor without a terminal unless given --yes", async () => {
    const declined = await reset({ yes: false }, [false])

    expect(failure(declined.exit)).toContain("Nothing was cleared.")
    expect(await sharedValue()).toBe("v1:sealed")

    const refused = await reset({ yes: false }, [], { interactive: false })

    expect(failure(refused.exit)).toContain("pass --yes")
    expect(await sharedValue()).toBe("v1:sealed")

    const confirmed = await reset({ yes: true }, [], { interactive: false })

    expect(Exit.isSuccess(confirmed.exit)).toBe(true)
    expect(await sharedValue()).toBeNull()
  })

  test("is refused while a Hub runs on the database, saying how to stop it", async () => {
    const { exit } = await Effect.runPromise(
      Effect.scoped(
        Effect.andThen(holdHubLock(database, "The Hub can't start"), () =>
          Effect.promise(() => reset({ yes: true }, [])),
        ),
      ),
    )

    expect(failure(exit)).toContain(`a Hub is running on ${database}`)
    expect(failure(exit)).toContain("kndl hub stop")
    expect(await sharedValue()).toBe("v1:sealed")
  })
})

/** How many Setup links the home's database keeps. */
const setupLinkCount = () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const rows = yield* sql<{ readonly count: number }>`SELECT count(*) AS count FROM setup_links`
      return rows[0]?.count
    }).pipe(Effect.provide(databaseAt(database))),
  )

const setupLink = () => Effect.runPromise(Effect.exit(newSetupLink(layout)))

describe("kndl hub setup-link", () => {
  test("makes a link to the Hub's Setup page, which a new one replaces", async () => {
    writeFileSync(layout.envFile("hub"), "PORT=7777\nHUB_PUBLIC_URL=https://hub.example.com\n")

    const first = await setupLink()
    const second = await setupLink()

    for (const exit of [first, second]) {
      expect(Exit.isSuccess(exit) && Option.getOrUndefined(exit.value)).toMatch(
        /^https:\/\/hub\.example\.com\/setup#cho_/,
      )
    }
    expect(await setupLinkCount()).toBe(1)
  })

  test("makes none once the Hub has an Owner", async () => {
    await Effect.runPromise(
      Effect.flatMap(
        SqlClient.SqlClient,
        (sql) => sql`UPDATE participants SET owner = 1, admitted_at = 0 WHERE id = 'p1'`,
      ).pipe(Effect.provide(databaseAt(database))),
    )

    const exit = await setupLink()

    expect(Exit.isSuccess(exit) && exit.value).toEqual(Option.none())
    expect(await setupLinkCount()).toBe(0)
  })
})

test("kndl secrets reset and kndl hub setup-link are refused where no Hub is set up", async () => {
  rmSync(layout.envFile("hub"))

  expect(failure((await reset({ yes: true }, [])).exit)).toContain("No Hub is set up")
  expect(failure(await setupLink())).toContain("No Hub is set up")
})
