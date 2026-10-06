// The Sandbox's GitHub token (#73, ADR 0010): plain `git` and `gh` in a Session's Sandbox reach
// its Repo with a GitHub App installation token the Hub mints for that Session alone, scoped to
// the Repo with every permission the App's installation has.
//
// The Runner asks the Hub for one when the Sandbox starts or wakes, and again every 45 minutes
// while it runs, as each lasts an hour. The token goes into a file in the Sandbox, on a tmpfs the
// Runner mounts at /run/kndl, so it is only ever in the VM's memory: never in the VM's
// settings (spike #46: microsandbox keeps those in its database), never on its root filesystem
// (an image on the Runner's disk), never on the Runner's disk. A git credential helper in the
// system gitconfig reads the file, and gh's hosts.yml is a link to a file beside it.
//
// The Hub redacts the token, and the Session's previous one, from what the Session prints. When
// there is none, as without a GitHub App, the Session runs without; that is logged once.
//
// Commits made there are by the Session's Creator (#110), set in the same system gitconfig when
// the Sandbox starts, unless the Environment set an identity of its own.

import type { GitAnswer, GitIdentity, SessionId } from "@kndl/protocol"
import { Cause, Duration, Effect, Redacted } from "effect"
import type { Scope } from "effect"
import { SandboxError } from "./Sandbox.ts"
import type { SandboxBackend } from "./sandbox/SandboxBackend.ts"

/** The tmpfs in the Sandbox that holds its credentials. */
export const credentialsDir = "/run/kndl"
/** The token, alone. */
export const tokenPath = `${credentialsDir}/github-token`
/** gh's hosts.yml, which `~/.config/gh/hosts.yml` links to. */
export const ghHostsPath = `${credentialsDir}/gh-hosts.yml`

/** The host the token is for. */
export const githubHost = "github.com"

/** How often a running Sandbox gets a fresh token. Each lasts an hour. */
export const TokenRefreshInterval = Duration.minutes(45)
/** How soon a Sandbox that didn't get one asks again. */
export const TokenRetryInterval = Duration.minutes(5)

/**
 * The git credential helper, in the system gitconfig: answers `get` with the token, once there
 * is one. git sends it only requests for {@link githubHost}.
 */
export const credentialHelper = `!f() { if [ "$1" = get ] && [ -r ${tokenPath} ]; then echo username=x-access-token; echo "password=$(cat ${tokenPath})"; fi; }; f`

/**
 * Readies the Sandbox for a token, again before each one: mounts the tmpfs unless it is there,
 * sets the credential helper (`$1`) if git is installed, and links gh's hosts.yml. Holds no
 * secret. Fails, so no token is written, if the tmpfs can't be mounted.
 */
export const prepareScript = `set -e
dir=${credentialsDir}
mkdir -p "$dir"
if ! grep -qs " $dir tmpfs " /proc/mounts; then
  mount -t tmpfs -o mode=0700,size=1m kndl "$dir"
fi
grep -qs " $dir tmpfs " /proc/mounts
chmod 0700 "$dir"
if command -v git >/dev/null 2>&1; then
  git config --system --replace-all credential.https://${githubHost}.helper "$1"
fi
gh="\${HOME:-/root}/.config/gh"
mkdir -p "$gh"
ln -sfn ${ghHostsPath} "$gh/hosts.yml"
`

/** gh's hosts.yml for the token. */
export const ghHosts = (token: string) =>
  `${githubHost}:\n    oauth_token: ${JSON.stringify(token)}\n    user: x-access-token\n    git_protocol: https\n`

/** Puts the token in the running Sandbox, for git and gh. */
export const installSandboxToken = (
  backend: SandboxBackend["Service"],
  sessionId: SessionId,
  token: Redacted.Redacted<string>,
) =>
  Effect.gen(function* () {
    const prepared = yield* backend.exec(sessionId, {
      command: "sh",
      args: ["-c", prepareScript, "sh", credentialHelper],
    })
    if (prepared.exitCode !== 0)
      return yield* new SandboxError({
        message: `could not ready the Sandbox for a GitHub token: ${prepared.stderr.trim() || `exit ${prepared.exitCode}`}`,
      })
    yield* backend.writeFile(sessionId, tokenPath, Redacted.value(token))
    yield* backend.writeFile(sessionId, ghHostsPath, ghHosts(Redacted.value(token)))
    const locked = yield* backend.exec(sessionId, {
      command: "chmod",
      args: ["0600", tokenPath, ghHostsPath],
    })
    if (locked.exitCode !== 0)
      return yield* new SandboxError({
        message: `could not lock the GitHub token's files: ${locked.stderr.trim()}`,
      })
  })

/**
 * Sets git's identity (`$1`, `$2`) in the system gitconfig, where it has none, if git is
 * installed. So one the Environment's image, Bootstrap or Start script set in the system
 * gitconfig is kept, and one set globally, in the Repo's `.git/config` or in `GIT_AUTHOR_*` and
 * `GIT_COMMITTER_*` wins over it, as git reads those after the system gitconfig.
 */
export const identityScript = `command -v git >/dev/null 2>&1 || exit 0
git config --system --get user.name >/dev/null || git config --system user.name "$1"
git config --system --get user.email >/dev/null || git config --system user.email "$2"
`

/**
 * Makes `identity` the author and committer of commits in the running Sandbox, unless it has one
 * (see {@link identityScript}). A failure is logged: commits then fail as they did before.
 */
export const setSandboxIdentity = (
  backend: SandboxBackend["Service"],
  sessionId: SessionId,
  identity: GitIdentity,
) =>
  backend
    .exec(sessionId, {
      command: "sh",
      args: ["-c", identityScript, "sh", identity.name, identity.email],
    })
    .pipe(
      Effect.flatMap((result) =>
        result.exitCode === 0
          ? Effect.void
          : Effect.fail(
              new SandboxError({ message: result.stderr.trim() || `exit ${result.exitCode}` }),
            ),
      ),
      Effect.catchCause((cause) => {
        const error = Cause.squash(cause)
        const message = error instanceof Error ? error.message : String(error)
        return Effect.logWarning(
          `Session ${sessionId}: could not set git's identity in its Sandbox: ${message}`,
        )
      }),
    )

/** A fresh token for the Session's Sandbox, from the Hub. */
export type SandboxTokenSource = (sessionId: SessionId) => Effect.Effect<GitAnswer>

/**
 * Gets the Session's Sandbox a token now, in the background, and a fresh one every
 * {@link TokenRefreshInterval} until the scope closes, as when the Sandbox stops. A failure is
 * logged once, until a token is installed again, and tried again sooner.
 */
export const keepSandboxToken = (options: {
  readonly backend: SandboxBackend["Service"]
  readonly sessionId: SessionId
  readonly source: SandboxTokenSource
}): Effect.Effect<void, never, Scope.Scope> => {
  const { backend, sessionId } = options
  let failing = false

  const refresh = Effect.gen(function* () {
    const answer = yield* options.source(sessionId)
    if (answer._tag !== "SandboxToken")
      return yield* new SandboxError({
        message: answer._tag === "GitFailed" ? answer.message : "the Hub sent no token",
      })
    yield* installSandboxToken(backend, sessionId, answer.token)
  }).pipe(
    Effect.matchCauseEffect({
      onSuccess: () => {
        const recovered = failing
        failing = false
        return Effect.as(
          recovered
            ? Effect.logInfo(`Session ${sessionId}: its Sandbox has a GitHub token again`)
            : Effect.void,
          TokenRefreshInterval,
        )
      },
      onFailure: (cause) => {
        const first = !failing
        failing = true
        const error = Cause.squash(cause)
        const message = error instanceof Error ? error.message : String(error)
        return Effect.as(
          first
            ? Effect.logWarning(
                `Session ${sessionId}: its Sandbox has no GitHub token, so git and gh there can't reach GitHub: ${message}`,
              )
            : Effect.void,
          TokenRetryInterval,
        )
      },
    }),
  )

  return refresh.pipe(
    Effect.flatMap(Effect.sleep),
    Effect.forever,
    Effect.forkScoped,
    Effect.asVoid,
  )
}
