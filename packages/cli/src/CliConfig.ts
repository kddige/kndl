// The CLI's own config, for a `claude-hub` installed from a Hub (issue #178):
// `${XDG_CONFIG_HOME:-~/.config}/claude-hub/cli.json`, 0600. The install script the Hub serves
// writes it, `{"hub":"<the Hub's URL>"}`, and the CLI updates itself from that Hub (SelfUpdate.ts).
// It is not an install's: an install's home holds what the Hub and Runner read.
import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { Option, Schema } from "effect"

export const CliConfig = Schema.Struct({
  /** The Hub the CLI was installed from, as its origin: `https://hub.example.com`. */
  hub: Schema.optional(Schema.String),
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
