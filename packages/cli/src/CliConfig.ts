// The CLI's own config, for a `claude-hub` installed from a Hub (issue #178):
// `${XDG_CONFIG_HOME:-~/.config}/claude-hub/cli.json`, 0600. The install script the Hub serves
// writes it, `{"hub":"<the Hub's URL>"}`, and the CLI updates itself from that Hub (SelfUpdate.ts).
// It is not an install's: an install's home holds what the Hub and Runner read.
//
// `claude-hub login` (issue #179, Login.ts) records the Hub it signs in to there too, with the CLI
// token it got: the CLI is signed in to one Hub at a time, the one it updates itself from, and
// logging in to another replaces it. The file is written whole, 0600 in a 0700 directory, as
// compact JSON, so the install script still finds `"hub":"<url>"` in it and keeps it.
import { readFileSync } from "node:fs"
import { chmod, mkdir, rename, rm, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { Effect, Option, Schema } from "effect"

export const CliConfig = Schema.Struct({
  /** The Hub the CLI was installed from, or signed in to, as its origin: `https://hub.example.com`. */
  hub: Schema.optional(Schema.String),
  /** The CLI token `claude-hub login` got from that Hub. Never printed. */
  token: Schema.optional(Schema.String),
})
export type CliConfig = typeof CliConfig.Type

/** Where the CLI's config is. */
export function cliConfigPath(
  env: Record<string, string | undefined> = process.env,
  userHome: string = homedir(),
): string {
  return join(env.XDG_CONFIG_HOME || join(userHome, ".config"), "claude-hub", "cli.json")
}

const decode = Schema.decodeUnknownOption(Schema.fromJsonString(CliConfig))

/** The CLI's config: empty when there is none, or it isn't JSON the CLI reads. */
export function readCliConfig(path: string = cliConfigPath()): CliConfig {
  let text: string
  try {
    text = readFileSync(path, "utf8")
  } catch {
    return {}
  }
  return Option.getOrElse(decode(text), () => ({}))
}

/**
 * Writes the CLI's config whole: to a file beside it that only this user can read, then renamed
 * over it, so the token is never in a file anyone else can read, nor in half a file.
 */
export const writeCliConfig = (path: string, config: CliConfig) =>
  Effect.promise(async () => {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    const partial = `${path}.partial-${process.pid}`
    try {
      await rm(partial, { force: true })
      await writeFile(partial, `${JSON.stringify(config)}\n`, { mode: 0o600, flag: "wx" })
      await chmod(partial, 0o600)
      await rename(partial, path)
    } finally {
      await rm(partial, { force: true })
    }
  }).pipe(Effect.uninterruptible)
