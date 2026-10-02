import { GitAnswer, type GitAsk, GitCredentials, type SessionSummary } from "@claude-hub/protocol"
import { Context, Effect, Layer } from "effect"
import { CoAuthors } from "./CoAuthors.ts"
import { GitHubApp } from "./GitHubApp.ts"
import { HubConfig } from "./HubConfig.ts"

/** Where the web UI shows a Session. */
export const sessionUrl = (publicUrl: URL, sessionId: string) =>
  new URL(`/sessions/${sessionId}`, publicUrl).href

/** A pull request's body, with a line linking back to the Session it came from. */
export const pullRequestBody = (body: string, link: string) => {
  const line = `Opened from claude-hub Session ${link}`
  return body.trim() === "" ? line : `${body.trimEnd()}\n\n---\n${line}`
}

/** The answer to a request only the GitHub App can do. */
const needsApp = (what: string) =>
  GitAnswer.cases.GitFailed.make({
    message: `${what} needs the GitHub App, and the Hub has none configured (GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY_PATH). Commits and pushes still work, with the Runner host's own git credentials.`,
  })

/**
 * What the Hub answers a Runner's git requests with, for one of its Sessions (issue #13): Repo
 * access, the co-authors since the last commit, and pull requests through the GitHub App. Every
 * failure is a GitFailed whose message is for the model.
 */
export class SessionGit extends Context.Service<
  SessionGit,
  {
    readonly answer: (session: SessionSummary, ask: GitAsk) => Effect.Effect<GitAnswer>
  }
>()("@claude-hub/hub/SessionGit") {
  static readonly layer = Layer.effect(
    SessionGit,
    Effect.gen(function* () {
      const app = yield* GitHubApp
      const coAuthors = yield* CoAuthors
      const config = yield* HubConfig

      const answer = Effect.fn("SessionGit.answer")(
        function* (session: SessionSummary, ask: GitAsk) {
          switch (ask._tag) {
            case "GitAccess": {
              const access = {
                repo: session.repo,
                baseBranch: session.baseBranch,
                workBranch: session.workBranch,
              }
              if (!app.isConfigured) {
                return GitAnswer.cases.GitAccess.make({
                  ...access,
                  credentials: GitCredentials.cases.HostCredentials.make({}),
                })
              }
              const { token, expiresAt } = yield* app.repoToken(session.repo)
              const author = yield* app.botIdentity(session.repo)
              return GitAnswer.cases.GitAccess.make({
                ...access,
                credentials: GitCredentials.cases.AppToken.make({ token, expiresAt, author }),
              })
            }
            case "CoAuthors": {
              const list = yield* coAuthors.list(session.id)
              return GitAnswer.cases.CoAuthors.make({
                coAuthors: list.coAuthors,
                through: list.through,
              })
            }
            case "OpenPullRequest": {
              if (!app.isConfigured) return needsApp("Opening a pull request")
              const opened = yield* app.openPullRequest({
                repo: session.repo,
                head: session.workBranch,
                base: session.baseBranch,
                title: ask.title,
                body: pullRequestBody(ask.body, sessionUrl(config.publicUrl, session.id)),
                draft: ask.draft,
              })
              return GitAnswer.cases.PullRequest.make(opened)
            }
            case "ReviewPullRequest": {
              if (!app.isConfigured) return needsApp("Reviewing a pull request")
              const url = yield* app.reviewPullRequest({
                repo: session.repo,
                number: ask.number,
                body: ask.body,
                event: ask.event,
              })
              return GitAnswer.cases.ReviewPosted.make({ url })
            }
          }
        },
        Effect.catchTags({
          GitHubAppError: (error) =>
            Effect.succeed(GitAnswer.cases.GitFailed.make({ message: error.message })),
          SqlError: (error) =>
            Effect.logError("A git request failed", error).pipe(
              Effect.as(
                GitAnswer.cases.GitFailed.make({
                  message: "The Hub could not do that; try again.",
                }),
              ),
            ),
        }),
      )

      return SessionGit.of({ answer })
    }),
  )
}
