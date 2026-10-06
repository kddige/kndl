// Repo access (ADR 0003): a Session belongs to its Repo, and so does its Environment (ADR 0009),
// so whoever has access to the Repo on GitHub may see and work on its Sessions and its
// Environment, and no one else. SessionRelay.ts asks here before every Session and Environment
// read and write from the web, and asks again for everyone connected, every
// `HubConfig.repoAccessTtl`, to notice access lost.
//
// - A dev login has access to every Repo, while dev login is on. A dev sign-in left over from
//   when it was on has none.
// - A GitHub sign-in has access to a Repo the GitHub App is installed on if GitHub says the
//   account is a collaborator on it, asked as the Repo's installation (GitHubApp.isCollaborator).
//   The person's own GitHub token is used once at sign-in and never kept (GitHub.ts), so it isn't
//   asked. Without the App, a GitHub sign-in's access can't be checked, so it has none; the Hub
//   says so once, as it starts.
// - `status` also says why not, for the web UI's check of a Repo as it is entered (#104): the App
//   isn't installed on it (or there's no such Repo), or the person isn't a collaborator. Telling
//   the two apart says whether the App is installed on a Repo the person can't reach; commands
//   about the Repo are refused alike either way.
// - A yes is cached for `HubConfig.repoAccessTtl`, a no for `refusedAnswerTtl` only (or the TTL,
//   if that is shorter). A failure to ask isn't cached, nor an answer slower than
//   `lookupTimeout`: the next check asks again.
//   `forget` drops what is cached for a person and a Repo, for a check asked again by hand.
// - GitHub's names ignore case, so every spelling of a Repo's name gets the same answer, cached
//   once (#197); GitHub is asked by the spelling first asked about. `fullName` says how GitHub
//   spells it, for the Hub to keep that spelling.

import { type Participant, type RepoName, repoKey, sameRepo } from "@kndl/protocol"
import { Cache, Context, Duration, Effect, Equal, Exit, Hash, Layer, Option, Schema } from "effect"
import { GitHubApp, type GitHubAppError } from "./GitHubApp.ts"
import { HubConfig } from "./HubConfig.ts"

/** GitHub couldn't say whether the person has access, such as in an outage. */
// oxlint-disable-next-line unicorn/throw-new-error -- Effect makes error classes with a factory call
export class RepoAccessUnknown extends Schema.TaggedError<RepoAccessUnknown>()(
  "RepoAccessUnknown",
  { message: Schema.String },
) {}

/**
 * What GitHub says of a person and a Repo: they have access; the App isn't installed on the Repo
 * (or there is no such Repo, or the App can't see it); or it is, and they have no access.
 */
export type RepoStatus = "Allowed" | "NotInstalled" | "NoAccess"

/** How many answers each cache keeps: a person and a Repo each, or a Repo. */
const cacheCapacity = 10_000

/** How long a check waits on GitHub: a command waits on it too. */
const lookupTimeout = Duration.seconds(10)

/**
 * How long a no is cached: the App not installed on the Repo, or the person not a collaborator.
 * Short, so that installing the App or being given access on GitHub takes effect within about
 * this long, with no restart; long enough that a refused person trying again, or the web UI
 * checking a Repo as it is entered, doesn't ask GitHub every time.
 */
export const refusedAnswerTtl = Duration.seconds(30)

/** What GitHub answers, or why it couldn't, within `lookupTimeout`. */
const askGitHub = <A>(asked: Effect.Effect<A, GitHubAppError>) =>
  asked.pipe(
    Effect.mapError((error) => new RepoAccessUnknown({ message: error.message })),
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

/**
 * What a cache keeps an answer by: a Repo, for a login or for none. Equal to the same Repo by any
 * spelling, so all of them share the answer, which GitHub is asked for by the spelling it holds.
 */
class Asked implements Equal.Equal {
  constructor(
    readonly login: string,
    readonly repo: RepoName,
  ) {}

  [Equal.symbol](that: unknown): boolean {
    return that instanceof Asked && that.login === this.login && sameRepo(that.repo, this.repo)
  }

  [Hash.symbol](): number {
    return Hash.string(`${this.login}\n${repoKey(this.repo)}`)
  }
}

export class RepoAccess extends Context.Service<
  RepoAccess,
  {
    /** Whether the person has access to the Repo, as GitHub said within the last TTL. */
    readonly check: (
      participant: Participant,
      repo: RepoName,
    ) => Effect.Effect<boolean, RepoAccessUnknown>
    /**
     * Why the person has access to the Repo or not, as `check` says; and for a dev login, which
     * has access whatever GitHub says, whether the App is installed on it. Without the App, only
     * `Allowed` or `NoAccess`.
     */
    readonly status: (
      participant: Participant,
      repo: RepoName,
    ) => Effect.Effect<RepoStatus, RepoAccessUnknown>
    /** Forgets what GitHub said of the person and the Repo: the next check asks again. */
    readonly forget: (participant: Participant, repo: RepoName) => Effect.Effect<void>
    /**
     * The Repo's name as GitHub spells it, its `full_name` (#197); none without the App, where
     * it isn't installed, or when GitHub can't say. Kept for the TTL, as a yes is.
     */
    readonly fullName: (repo: RepoName) => Effect.Effect<Option.Option<RepoName>>
  }
>()("@kndl/hub/RepoAccess") {
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

      const timeToLive = (exit: Exit.Exit<RepoStatus | boolean, RepoAccessUnknown>) => {
        if (Exit.isFailure(exit)) return Duration.zero
        return exit.value === "Allowed" || exit.value === true
          ? config.repoAccessTtl
          : Duration.min(refusedAnswerTtl, config.repoAccessTtl)
      }

      // By login and Repo, as GitHub answers: a login is kept current at each sign-in.
      const answers = yield* Cache.makeWith(
        ({ login, repo }: Asked) =>
          askGitHub(
            app.isCollaborator(repo, login).pipe(
              Effect.map((allowed): RepoStatus => (allowed ? "Allowed" : "NoAccess")),
              Effect.catchTag("GitHubAppError", (error) =>
                // Not installed on the Repo: not one of the platform's.
                error.status === 404
                  ? Effect.succeed<RepoStatus>("NotInstalled")
                  : Effect.fail(error),
              ),
            ),
          ),
        { capacity: cacheCapacity, timeToLive },
      )

      // By Repo: whether the App is installed on it, for a dev login, which has no GitHub login.
      const installed = yield* Cache.makeWith(
        ({ repo }: Asked) => askGitHub(app.isInstalled(repo)),
        { capacity: cacheCapacity, timeToLive },
      )

      const status = Effect.fn("RepoAccess.status")(function* (
        participant: Participant,
        repo: RepoName,
      ): Effect.fn.Return<RepoStatus, RepoAccessUnknown> {
        if (participant.id.startsWith("dev:")) {
          if (Option.isNone(config.devLogin)) return "NoAccess"
          if (!app.isConfigured) return "Allowed"
          return (yield* Cache.get(installed, new Asked("", repo))) ? "Allowed" : "NotInstalled"
        }
        if (!participant.id.startsWith("github:") || !app.isConfigured) return "NoAccess"
        return yield* Cache.get(answers, new Asked(participant.login, repo))
      })

      const check = Effect.fn("RepoAccess.check")(function* (
        participant: Participant,
        repo: RepoName,
      ) {
        // Whatever GitHub says: a dev login isn't a collaborator anywhere.
        if (participant.id.startsWith("dev:")) return Option.isSome(config.devLogin)
        return (yield* status(participant, repo)) === "Allowed"
      })

      const forget = (participant: Participant, repo: RepoName) =>
        participant.id.startsWith("dev:")
          ? Cache.invalidate(installed, new Asked("", repo))
          : Cache.invalidate(answers, new Asked(participant.login, repo))

      // By Repo: how GitHub spells its name. Only an answer is kept.
      const fullNames = yield* Cache.makeWith(({ repo }: Asked) => askGitHub(app.fullName(repo)), {
        capacity: cacheCapacity,
        timeToLive: (exit) => (Exit.isSuccess(exit) ? config.repoAccessTtl : Duration.zero),
      })

      const fullName = (repo: RepoName) =>
        app.isConfigured
          ? Cache.get(fullNames, new Asked("", repo)).pipe(
              Effect.map(Option.some),
              Effect.catchTag("RepoAccessUnknown", (error) =>
                Effect.as(
                  Effect.logDebug(`Kept ${repo} as it was typed: ${error.message}`),
                  Option.none<RepoName>(),
                ),
              ),
            )
          : Effect.succeed(Option.none<RepoName>())

      return RepoAccess.of({ check, status, forget, fullName })
    }),
  )
}
