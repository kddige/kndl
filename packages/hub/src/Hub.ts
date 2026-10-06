import { MaxCommandWaitMs } from "@claude-hub/protocol"
import { Layer } from "effect"
import { AuthRoutes } from "./AuthRoutes.ts"
import { ChannelRoutes } from "./Channels.ts"
import { ClaudeCredentials } from "./ClaudeCredentials.ts"
import { CliRoutes } from "./CliRoutes.ts"
import { Environments } from "./Environments.ts"
import { HealthRoute } from "./Health.ts"
import { HubShutdown } from "./HubShutdown.ts"
import { ModOutbox } from "./ModOutbox.ts"
import { ModRoutes } from "./ModRoutes.ts"
import { ModTokens } from "./ModTokens.ts"
import { PairingCodes } from "./PairingCodes.ts"
import { PairingRoutes } from "./PairingRoutes.ts"
import { PermissionDrift } from "./PermissionDrift.ts"
import { PromptQueue } from "./PromptQueue.ts"
import { RepoAccess } from "./RepoAccess.ts"
import { Runners } from "./Runners.ts"
import { RunnerTokens } from "./RunnerTokens.ts"
import { RunnerUpdatePush } from "./RunnerUpdatePush.ts"
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
  CliRoutes,
  ModRoutes,
  PairingRoutes,
  WebUiRoutes,
)

/**
 * The credential stores, each person's Claude credential, the mod outbox, Environments, Repo
 * access, the GitHub App's permission check, the Pairing codes, the Session relay and the
 * shutdown signal the routes use, given a database, the GitHub App (GitHubApp.ts), the check of
 * Claude credentials (ClaudeCheck) and the Hub's version (HubVersion.ts).
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
      PairingCodes.layer,
      HubShutdown.layer,
      Environments.layer,
      RunnerUpdatePush.layer,
      ClaudeCredentials.layer,
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
