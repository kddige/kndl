import { MaxCommandWaitMs } from "@claude-hub/protocol"
import { Layer } from "effect"
import { AuthRoutes } from "./AuthRoutes.ts"
import { ChannelRoutes } from "./Channels.ts"
import { Environments } from "./Environments.ts"
import { HealthRoute } from "./Health.ts"
import { HubShutdown } from "./HubShutdown.ts"
import { ModOutbox } from "./ModOutbox.ts"
import { ModRoutes } from "./ModRoutes.ts"
import { ModTokens } from "./ModTokens.ts"
import { PermissionDrift } from "./PermissionDrift.ts"
import { PromptQueue } from "./PromptQueue.ts"
import { RepoAccess } from "./RepoAccess.ts"
import { Runners } from "./Runners.ts"
import { RunnerTokens } from "./RunnerTokens.ts"
import { Secrets } from "./Secrets.ts"
import { SessionGit } from "./SessionGit.ts"
import { SessionLog } from "./SessionLog.ts"
import { SessionRelay } from "./SessionRelay.ts"
import { Sessions } from "./Sessions.ts"
import { SignIns } from "./SignIns.ts"
import { WebUiRoutes } from "./WebUi.ts"

/** Every route the Hub serves: its own, and the web UI's build on every other GET path. */
export const HubRoutes = Layer.mergeAll(
  HealthRoute,
  AuthRoutes,
  ChannelRoutes,
  ModRoutes,
  WebUiRoutes,
)

/**
 * The credential stores, the mod outbox, Environments, Repo access, the GitHub App's permission
 * check, the Session relay and the shutdown signal the routes use, given a database and the GitHub
 * App (GitHubApp.ts).
 */
export const HubServices = SessionRelay.layer.pipe(
  Layer.provideMerge(Layer.mergeAll(SessionGit.layer, RepoAccess.layer, PermissionDrift.layer)),
  Layer.provideMerge(
    Layer.mergeAll(
      SignIns.layer,
      RunnerTokens.layer,
      ModTokens.layer,
      ModOutbox.layer,
      Sessions.layer,
      SessionLog.layer,
      PromptQueue.layer,
      Runners.layer,
      HubShutdown.layer,
      Environments.layer,
    ),
  ),
  // Checks HUB_SECRETS_KEY against the Sensitive values stored, so a Hub with the wrong key
  // refuses to start.
  Layer.provideMerge(Secrets.layer),
)

/**
 * How long Bun keeps a quiet connection open, in seconds. Bun's default of 10 would cut off the
 * mod's long poll of `GET /mod/commands`, which can be quiet for MaxCommandWaitMs.
 */
export const idleTimeoutSeconds = Math.ceil(MaxCommandWaitMs / 1000) + 10
