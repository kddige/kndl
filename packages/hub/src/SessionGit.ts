import {
  GitAnswer,
  type GitAsk,
  GitCredentials,
  type RepoName,
  type SessionSummary,
} from "@claude-hub/protocol"
import { Context, Effect, Layer } from "effect"
import { GitHubApp } from "./GitHubApp.ts"

/**
 * What the Hub answers a Runner's git requests with, for one of its Sessions (ADR 0010): how the
 * Runner's host git reaches the Repo, and a token for the Session's Sandbox; and for one of its
 * Test builds (#104), how to clone the Repo. Every failure is a GitFailed saying why.
 */
export class SessionGit extends Context.Service<
  SessionGit,
  {
    readonly answer: (session: SessionSummary, ask: GitAsk) => Effect.Effect<GitAnswer>
    /**
     * How a Test build clones the Repo: with a fresh `contents:read` token for it, or, only when
     * the Hub has no GitHub App, with the host's own credentials, as a Session's Workspace is.
     */
    readonly cloneAccess: (repo: RepoName) => Effect.Effect<GitAnswer>
  }
>()("@claude-hub/hub/SessionGit") {
  static readonly layer = Layer.effect(
    SessionGit,
    Effect.gen(function* () {
      const app = yield* GitHubApp

      const answer = Effect.fn("SessionGit.answer")(
        function* (session: SessionSummary, ask: GitAsk) {
          switch (ask._tag) {
            case "GitAccess": {
              if (!app.isConfigured) {
                return GitAnswer.cases.GitAccess.make({
                  repo: session.repo,
                  credentials: GitCredentials.cases.HostCredentials.make({}),
                })
              }
              const { token, expiresAt } = yield* app.repoToken(session.repo)
              const author = yield* app.botIdentity(session.repo)
              return GitAnswer.cases.GitAccess.make({
                repo: session.repo,
                credentials: GitCredentials.cases.AppToken.make({ token, expiresAt, author }),
              })
            }
            case "SandboxToken": {
              const { token, expiresAt } = yield* app.sandboxToken(session.repo)
              return GitAnswer.cases.SandboxToken.make({ token, expiresAt })
            }
          }
        },
        Effect.catchTag("GitHubAppError", (error) =>
          Effect.succeed(GitAnswer.cases.GitFailed.make({ message: error.message })),
        ),
      )

      const cloneAccess = Effect.fn("SessionGit.cloneAccess")(
        function* (repo: RepoName) {
          if (!app.isConfigured) {
            return GitAnswer.cases.CloneAccess.make({
              credentials: { _tag: "HostCredentials" },
            })
          }
          const { token, expiresAt } = yield* app.cloneToken(repo)
          return GitAnswer.cases.CloneAccess.make({
            credentials: { _tag: "CloneToken", token, expiresAt },
          })
        },
        Effect.catchTag("GitHubAppError", (error) =>
          Effect.succeed(GitAnswer.cases.GitFailed.make({ message: error.message })),
        ),
      )

      return SessionGit.of({ answer, cloneAccess })
    }),
  )
}
