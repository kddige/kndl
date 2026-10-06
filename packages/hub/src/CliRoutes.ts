// The `claude-hub` CLI, served by the Hub (issue #178, ADR 0016):
//
// - `GET /cli` is the install script, for `curl https://<hub>/cli | sh` (cli-install.sh), with
//   the Hub's public URL filled in.
// - `GET /cli/version` says the commit the Hub serves the CLI at: its own.
// - `GET /cli/<os>-<arch>` is the binary for that platform, built at that commit (CliBuilds.ts),
//   with the commit in its `x-claude-hub-commit` header.
//
// All three are open, with no sign-in: the binary is claude-hub's own code at the Hub's commit,
// and holds no setting, token or key of the Hub's. What the CLI does with a Hub afterwards is
// signed in.

import { readFileSync } from "node:fs"
import { CliCommitHeader, CliTargets, CliVersion, isCliTarget } from "@claude-hub/protocol"
import { Effect } from "effect"
import { HttpRouter, HttpServerResponse } from "effect/http"
import { CliBuilds } from "./CliBuilds.ts"
import { HubConfig } from "./HubConfig.ts"

const scriptTemplate = readFileSync(new URL("./cli-install.sh", import.meta.url), "utf8")

/** The placeholder in cli-install.sh that the Hub's URL replaces. */
const HubUrlPlaceholder = "@HUB_URL@"

/** The install script, installing from the Hub at `hubUrl`. */
export function installScript(hubUrl: URL): string {
  return scriptTemplate.replace(HubUrlPlaceholder, quote(hubUrl.origin))
}

/** Single-quotes a word for sh. */
const quote = (word: string) => `'${word.replaceAll("'", `'\\''`)}'`

const text = (body: string, status: number) =>
  HttpServerResponse.text(body, { status, headers: { "cache-control": "no-store" } })

export const CliRoutes = HttpRouter.use(
  Effect.fn(function* (router) {
    const { publicUrl } = yield* HubConfig
    const builds = yield* CliBuilds
    const script = installScript(publicUrl)

    yield* router.add(
      "GET",
      "/cli",
      Effect.succeed(
        HttpServerResponse.text(script, {
          contentType: "text/x-shellscript; charset=utf-8",
          headers: { "cache-control": "no-cache" },
        }),
      ),
    )

    yield* router.add(
      "GET",
      "/cli/version",
      builds.commit === undefined
        ? Effect.succeed(
            text(
              "This Hub doesn't run from a git checkout, so it has no commit to serve the claude-hub CLI at.",
              503,
            ),
          )
        : HttpServerResponse.schemaJson(CliVersion)(
            { commit: builds.commit },
            { headers: { "cache-control": "no-store" } },
          ).pipe(Effect.orDie),
    )

    yield* router.add(
      "GET",
      "/cli/:target",
      Effect.gen(function* () {
        const { target } = yield* HttpRouter.params
        if (target === undefined || !isCliTarget(target)) {
          return text(
            `The Hub builds the claude-hub CLI for ${CliTargets.join(", ")}, not ${target}.`,
            404,
          )
        }
        const path = yield* builds.binary(target)
        return yield* HttpServerResponse.file(path, {
          contentType: "application/octet-stream",
          headers: {
            [CliCommitHeader]: builds.commit ?? "",
            "cache-control": "no-store",
          },
        }).pipe(Effect.orDie)
      }).pipe(
        Effect.catchTag("CliBuildError", (error) =>
          Effect.succeed(text(error.message, error.status)),
        ),
      ),
    )
  }),
)
