// kndl's own repository on GitHub, kddige/kndl, as the Hub reads it to learn of a newer kndl
// (ADR 0028): its Releases with their notes, main's head, and the commits between two of its
// commits. All of it is public, so the Hub asks unauthenticated. GitHub allows that 60 calls an
// hour from an address; a check makes one or two, every 6 hours or when the Owner asks.
//
// Behind a seam, so tests never reach GitHub: `Upstream.make` talks to any API URL, such as a
// stand-in's, and `Upstream.fixed` answers from what a test gives it.

import { CommitId, KndlRepo } from "@kndl/protocol"
import { Context, Duration, Effect, Layer, Schema } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http"
import { GitHubApiUrl } from "./HubConfig.ts"

/** A Release of kndl as GitHub lists it: drafts left out. */
export interface UpstreamRelease {
  /** Its tag, such as `v2026.10.1`; any other tag GitHub has a Release for too. */
  readonly tag: string
  /** Its notes, markdown; empty for none. */
  readonly notes: string
  /** Its page on GitHub. */
  readonly url: string
  readonly publishedAt: number | undefined
  readonly prerelease: boolean
}

/** What GitHub says of the commits from `base` to `head`. */
export interface Comparison {
  /** `ahead` when `head` comes after `base`, `diverged` when neither is in the other's history. */
  readonly status: "ahead" | "behind" | "identical" | "diverged"
  /** How many commits `head` has that `base` doesn't. */
  readonly aheadBy: number
  /** Those commits, oldest first, as many as GitHub lists: up to 250. */
  readonly commits: ReadonlyArray<{ readonly commit: CommitId; readonly title: string }>
}

// oxlint-disable-next-line unicorn/throw-new-error -- Effect makes error classes with a factory call
export class UpstreamError extends Schema.TaggedError<UpstreamError>()("UpstreamError", {
  message: Schema.String,
}) {}

/** How long one call waits on GitHub. */
const callTimeout = Duration.seconds(10)

/** One page of Releases holds this many: more than a year of them. */
const releasesPerPage = 100

const ReleasePage = Schema.Array(
  Schema.Struct({
    tag_name: Schema.String,
    body: Schema.optional(Schema.NullOr(Schema.String)),
    html_url: Schema.String,
    published_at: Schema.optional(Schema.NullOr(Schema.String)),
    draft: Schema.Boolean,
    prerelease: Schema.Boolean,
  }),
)

const CompareAnswer = Schema.Struct({
  status: Schema.Literals(["ahead", "behind", "identical", "diverged"]),
  ahead_by: Schema.Int,
  commits: Schema.Array(
    Schema.Struct({ sha: CommitId, commit: Schema.Struct({ message: Schema.String }) }),
  ),
})

const ApiError = Schema.Struct({ message: Schema.String })

/** Decodes JSON text with `schema`. */
const json =
  <A, I>(schema: Schema.Codec<A, I>) =>
  (text: string) =>
    Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(text)

export class Upstream extends Context.Service<
  Upstream,
  {
    /** kndl's Releases, newest first as GitHub lists them, from its first page of them. */
    readonly releases: Effect.Effect<ReadonlyArray<UpstreamRelease>, UpstreamError>
    /** The commit a branch is at. */
    readonly head: (branch: string) => Effect.Effect<CommitId, UpstreamError>
    /** The commits from `base` to `head`, each a commit or a tag. */
    readonly compare: (base: string, head: string) => Effect.Effect<Comparison, UpstreamError>
  }
>()("@kndl/hub/Upstream") {
  /** GitHub's own API. */
  static readonly layer = Layer.effect(
    Upstream,
    Effect.suspend(() => Upstream.make(GitHubApiUrl)),
  ).pipe(Layer.provide(FetchHttpClient.layer))

  /** kndl's repository on the GitHub API at `apiUrl`: GitHub's, or a stand-in's in tests. */
  static readonly make = Effect.fnUntraced(function* (apiUrl: URL) {
    const http = yield* HttpClient.HttpClient
    const base = apiUrl.href.endsWith("/") ? apiUrl.href : `${apiUrl.href}/`

    /** GETs `path` under the repository, and decodes a 2xx answer with `decode`. */
    const get = <A>(
      what: string,
      path: string,
      accept: string,
      decode: (text: string) => Effect.Effect<A, Schema.SchemaError>,
    ) =>
      Effect.gen(function* () {
        const response = yield* http.execute(
          HttpClientRequest.get(new URL(`repos/${KndlRepo}/${path}`, base)).pipe(
            HttpClientRequest.accept(accept),
            HttpClientRequest.setHeader("x-github-api-version", "2022-11-28"),
            HttpClientRequest.setHeader("user-agent", "kndl"),
          ),
        )
        const text = yield* response.text
        if (response.status < 200 || response.status >= 300) {
          return yield* new UpstreamError({
            message: `${what}: GitHub answered ${response.status}${apiMessage(text)}`,
          })
        }
        return yield* decode(text)
      }).pipe(
        Effect.timeoutOrElse({
          duration: callTimeout,
          orElse: () =>
            Effect.fail(
              new UpstreamError({
                message: `${what}: GitHub didn't answer within ${Duration.format(callTimeout)}`,
              }),
            ),
        }),
        Effect.catchTags({
          HttpClientError: (error) =>
            Effect.fail(new UpstreamError({ message: `${what}: ${error.message}` })),
          SchemaError: () =>
            Effect.fail(
              new UpstreamError({ message: `${what}: GitHub sent an unexpected answer` }),
            ),
        }),
      )
    const releases = get(
      "Could not list kndl's Releases",
      `releases?per_page=${releasesPerPage}`,
      "application/vnd.github+json",
      json(ReleasePage),
    ).pipe(
      Effect.map((page) =>
        page
          .filter((release) => !release.draft)
          .map((release): UpstreamRelease => {
            const published = Date.parse(release.published_at ?? "")
            return {
              tag: release.tag_name,
              notes: release.body ?? "",
              url: release.html_url,
              publishedAt: Number.isNaN(published) ? undefined : published,
              prerelease: release.prerelease,
            }
          }),
      ),
    )

    // Asked for the commit id alone, which GitHub answers as plain text.
    const head = (branch: string) =>
      get(
        `Could not look up kndl's ${branch}`,
        `commits/${encodeURIComponent(branch)}`,
        "application/vnd.github.sha",
        (text) => Schema.decodeUnknownEffect(CommitId)(text.trim()),
      )

    const compare = (from: string, to: string) =>
      get(
        `Could not compare ${from.slice(0, 12)} with ${to.slice(0, 12)} on GitHub`,
        `compare/${encodeURIComponent(from)}...${encodeURIComponent(to)}`,
        "application/vnd.github+json",
        json(CompareAnswer),
      ).pipe(
        Effect.map((answer): Comparison => ({
          status: answer.status,
          aheadBy: answer.ahead_by,
          commits: answer.commits.map((listed) => ({
            commit: listed.sha,
            title: listed.commit.message.split("\n", 1)[0] ?? "",
          })),
        })),
      )

    return Upstream.of({ releases, head, compare })
  })

  /**
   * For tests: kndl's repository holding `releases`, with each branch at the commit `heads` says,
   * and comparisons as `compare` makes them. Anything else fails, as GitHub's 404 does.
   */
  static readonly fixed = (options: {
    readonly releases?: ReadonlyArray<UpstreamRelease>
    readonly heads?: Readonly<Record<string, CommitId>>
    readonly compare?: (base: string, head: string) => Comparison | undefined
    /** While it says so, every call fails with this message, as when GitHub is down. */
    readonly down?: () => string | undefined
  }) => {
    const failing = <A>(answer: () => A | undefined, what: string) =>
      Effect.suspend(() => {
        const down = options.down?.()
        if (down !== undefined) return Effect.fail(new UpstreamError({ message: down }))
        const value = answer()
        return value === undefined
          ? Effect.fail(new UpstreamError({ message: `${what}: GitHub answered 404` }))
          : Effect.succeed(value)
      })
    return Layer.succeed(
      Upstream,
      Upstream.of({
        releases: failing(() => options.releases ?? [], "Could not list kndl's Releases"),
        head: (branch) => failing(() => options.heads?.[branch], `Could not look up ${branch}`),
        compare: (from, to) =>
          failing(() => options.compare?.(from, to), `Could not compare ${from} with ${to}`),
      }),
    )
  }
}

/** GitHub's own explanation from an error body, as `: …`, or nothing. */
function apiMessage(text: string): string {
  try {
    const body = Schema.decodeUnknownSync(ApiError)(JSON.parse(text))
    return `: ${body.message}`
  } catch {
    return ""
  }
}
