import { SqliteClient } from "@effect/sql-sqlite-bun"
import { Config } from "effect"

/** The Hub's SQLite database, at `HUB_DATABASE` (default `hub.db` in the working directory). */
export const DatabaseLive = SqliteClient.layerConfig({
  filename: Config.String("HUB_DATABASE").pipe(Config.withDefault("hub.db")),
})
