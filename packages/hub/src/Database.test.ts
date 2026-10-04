import { describe, expect, test } from "bun:test"
import { ConfigProvider, Effect } from "effect"
import { DatabaseFile } from "./Database.ts"

const databaseIn = (env: Record<string, string>) =>
  Effect.runSync(DatabaseFile.parse(ConfigProvider.fromEnv({ env })))

describe("the Hub's database", () => {
  test("from a checkout is hub.db in packages/hub, not in the dev home", () => {
    expect(databaseIn({})).toBe(new URL("../hub.db", import.meta.url).pathname)
  })

  test("is hub.db in the home CLAUDE_HUB_HOME names", () => {
    expect(databaseIn({ CLAUDE_HUB_HOME: "/srv/claude-hub" })).toBe("/srv/claude-hub/hub.db")
  })

  test("is HUB_DATABASE when set, whatever the home", () => {
    expect(databaseIn({ HUB_DATABASE: "/tmp/a.db" })).toBe("/tmp/a.db")
    expect(databaseIn({ HUB_DATABASE: "/tmp/a.db", CLAUDE_HUB_HOME: "/srv/claude-hub" })).toBe(
      "/tmp/a.db",
    )
  })
})
