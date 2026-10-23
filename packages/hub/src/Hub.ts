import { MaxCommandWaitMs } from "@kndl/protocol"
import { Layer } from "effect"
import { AttachmentRoutes } from "./AttachmentRoutes.ts"
import { Attachments } from "./Attachments.ts"
import { AuthRoutes } from "./AuthRoutes.ts"
import { ChannelRoutes } from "./Channels.ts"
import { ClaudeCredentials } from "./ClaudeCredentials.ts"
import { CliLoginRoutes } from "./CliLoginRoutes.ts"
import { CliRoutes } from "./CliRoutes.ts"
import { CliTokens } from "./CliTokens.ts"
import { ConnectedProviders } from "./ConnectedProviders.ts"
import { Environments } from "./Environments.ts"
import { ForwardRoutes } from "./ForwardRoutes.ts"
import { Gateway } from "./Gateway.ts"
import { GatewayRoutes } from "./GatewayRoutes.ts"
import { HealthRoute } from "./Health.ts"
import { HearthRoutes } from "./HearthRoutes.ts"
import { HubShutdown } from "./HubShutdown.ts"
import { LiveVoiceRoutes } from "./LiveVoiceRoutes.ts"
import { McpServerIconRoutes } from "./McpServerIconRoutes.ts"
import { McpServerOAuth } from "./McpServerOAuth.ts"
import { McpServerOAuthRoutes } from "./McpServerOAuthRoutes.ts"
import { McpServers } from "./McpServers.ts"
import { Members } from "./Members.ts"
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
import { TunnelRoutes } from "./TunnelRoutes.ts"
import { Tunnels } from "./Tunnels.ts"
import { WebUiRoutes } from "./WebUi.ts"

/** Every route the Hub serves: its own, and the web UI's build on every other GET path. */
export const HubRoutes = Layer.mergeAll(
  HealthRoute,
  AttachmentRoutes,
  AuthRoutes,
  CliLoginRoutes,
  ChannelRoutes,
  CliRoutes,
  ForwardRoutes,
  GatewayRoutes,
  HearthRoutes,
  LiveVoiceRoutes,
  ModRoutes,
  PairingRoutes,
  McpServerIconRoutes,
  McpServerOAuthRoutes,
  TunnelRoutes,
  WebUiRoutes,
)

/**
 * The credential stores, each person's Claude credential, the mod outbox, Environments, Repo
 * access, the GitHub App's permission check, the Pairing codes, the Session relay, the tunnels
 * waiting for their Runner and the shutdown signal the routes use, given a database, the GitHub
 * App (GitHubApp.ts), the check of Claude credentials (ClaudeCheck), the Providers' APIs and
 * sign-ins (ProviderApis), where MCP server packages are read from (McpServerSources.ts), the
 * Hub's version (HubVersion.ts), its check for a newer kndl (HubUpdates.ts) and the updates its
 * Owner starts from the web (HubUpdateRuns.ts). The Models each Member's pi Sessions can run (ADR
 * 0029) are their Connected providers', unless a test gives others.
 */
export const hubServices = (
  modelCatalog: typeof ConnectedProviders.modelCatalog = ConnectedProviders.modelCatalog,
) =>
  SessionRelay.layer.pipe(
    // How a request reaches an Installation's MCP server (#254): for a Session's start, and the
    // Gateway.
    Layer.provideMerge(Layer.mergeAll(Gateway.layer, modelCatalog)),
    Layer.provideMerge(
      Layer.mergeAll(
        SessionGit.layer,
        RepoAccess.layer,
        PermissionDrift.layer,
        Members.layer,
        // Above McpServers, which says which Installations a Session's Repo has on now.
        Sessions.layer,
        // Above ClaudeCredentials: Claude's Models are listed under a Member's Claude credential.
        ConnectedProviders.layer,
      ),
    ),
    Layer.provideMerge(
      Layer.mergeAll(
        SignIns.layer,
        RunnerTokens.layer,
        ModTokens.layer,
        CliTokens.layer,
        ModOutbox.layer,
        SessionLog.layer,
        PromptQueue.layer,
        Attachments.layer,
        Runners.layer,
        PairingCodes.layer,
        HubShutdown.layer,
        Environments.layer,
        McpServers.layer,
        RunnerUpdatePush.layer,
        ClaudeCredentials.layer,
        Tunnels.layer,
      ),
    ),
    // The OAuth Installations' tokens (#217), which McpServers sends the Gateway.
    Layer.provideMerge(McpServerOAuth.layer),
    // Checks HUB_SECRETS_KEY against the Sensitive values stored, so a Hub with the wrong key
    // refuses to start.
    Layer.provideMerge(Secrets.layer),
  )

/** The Hub's services, on the Models of each Member's Connected providers. */
export const HubServices = hubServices()

/**
 * How long Bun keeps a quiet connection open, in seconds. Bun's default of 10 would cut off the
 * mod's long poll of `GET /mod/commands`, which can be quiet for MaxCommandWaitMs.
 */
export const idleTimeoutSeconds = Math.ceil(MaxCommandWaitMs / 1000) + 10

/**
 * The Hub's WebSockets, its channels and tunnels (#177): one quiet for `idleTimeout` seconds is
 * pinged, and closed only if the peer doesn't answer, so a tunnel to a quiet connection, such as
 * a WebSocket served in the Sandbox, stays up. Said here, not left to Bun's defaults.
 */
export const websocketOptions = { idleTimeout: 120, sendPings: true } as const
