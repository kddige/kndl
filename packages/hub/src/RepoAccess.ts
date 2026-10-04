// Repo access (ADR 0003): a Session belongs to its Repo, so whoever has access to the Repo on
// GitHub may see and work on its Sessions, and no one else. SessionRelay.ts asks here before
// every Session read and write from the web, and asks again for everyone connected, every
// `HubConfig.repoAccessTtl`, to notice access lost.
//
// - A dev login has access to every Repo, while dev login is on. A dev sign-in left over from
//   when it was on has none.
// - A GitHub sign-in has access to a Repo the GitHub App is installed on if GitHub says the
//   account is a collaborator on it, asked as the Repo's installation (GitHubApp.isCollaborator).
//   The person's own GitHub token is used once at sign-in and never kept (GitHub.ts), so it isn't
//   asked. Without the App, a GitHub sign-in's access can't be checked, so it has none; the Hub
//   says so once, as it starts.
// - Answers are cached for `HubConfig.repoAccessTtl`. A failure to ask isn't, nor an answer slower
//   than `lookupTimeout`: the next check asks again.

import type { Participant, RepoName } from "@claude-hub/protocol"
import { Cache, Context, Duration, Effect, Exit, Layer, Option, Schema } from "effect"
import { GitHubApp } from "./GitHubApp.ts"
import { HubConfig } from "./HubConfig.ts"

/** GitHub couldn't say whether the person has access, such as in an outage. */
// oxlint-disable-next-line unicorn/throw-new-error -- Effect makes error classes with a factory call
export class RepoAccessUnknown extends Schema.TaggedError<RepoAccessUnknown>()(
  "RepoAccessUnknown",
  { message: Schema.String },
) {}

/** How many answers the cache keeps: a person and a Repo each. */
const cacheCapacity = 10_000

/** How long a check waits on GitHub: a command waits on it too. */
const lookupTimeout = Duration.seconds(10)

export class RepoAccess extends Context.Service<
  RepoAccess,
  {
    /** Whether the person has access to the Repo, as GitHub said within the last TTL. */
    readonly check: (
      participant: Participant,
      repo: RepoName,
    ) => Effect.Effect<boolean, RepoAccessUnknown>
  }
>()("@claude-hub/hub/RepoAccess") {
  static readonly layer = Layer.effect(
    RepoAccess,
    Effect.gen(function* () {
      const config = yield* HubConfig
      const app = yield* GitHubApp
      if (Option.isSome(config.github) && !app.isConfigured) {
        yield* Effect.logWarning(
          "GitHub sign-in is on without the GitHub App, so no one signed in with GitHub has access to any Repo: set GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY_PATH on the Hub.",
        )
      }

      // By login and Repo, as GitHub answers: a login is kept current at each sign-in.
      const answers = yield* Cache.makeWith(
        (key: string) => {
          const [login = "", repo = ""] = key.split("\n")
          return app.isCollaborator(repo, login).pipe(
            Effect.catchTag("GitHubAppError", (error) =>
              // Not installed on the Repo: not one of the platform's.
              error.status === 404
                ? Effect.succeed(false)
                : Effect.fail(new RepoAccessUnknown({ message: error.message })),
            ),
            Effect.timeoutOrElse({
              duration: lookupTimeout,
              orElse: () =>
                Effect.fail(
                  new RepoAccessUnknown({
                    message: `GitHub didn't answer within ${Duration.format(lookupTimeout)}`,
                  }),
                ),
            }),
          )
        },
        {
          capacity: cacheCapacity,
          timeToLive: (exit) => (Exit.isSuccess(exit) ? config.repoAccessTtl : Duration.zero),
        },
      )

      const check = Effect.fn("RepoAccess.check")(function* (
        participant: Participant,
        repo: RepoName,
      ) {
        if (participant.id.startsWith("dev:")) return Option.isSome(config.devLogin)
        if (!participant.id.startsWith("github:") || !app.isConfigured) return false
        return yield* Cache.get(answers, `${participant.login}\n${repo}`)
      })

      return RepoAccess.of({ check })
    }),
  )
}
