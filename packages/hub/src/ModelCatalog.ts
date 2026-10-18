// The Models a Member's pi Sessions can run (ADR 0029): what the Hub last found under each of
// their Connected providers, and Claude's when they have a Claude credential. ConnectedProviders
// keeps it; SessionRelay checks a pi Session's model against it.

import type { ParticipantId, ProviderId, ProviderModel } from "@kndl/protocol"
import { Context, Effect, Layer } from "effect"

export class ModelCatalog extends Context.Service<
  ModelCatalog,
  {
    /**
     * Every Model the Member's pi Sessions can run now, most capable first within each Provider,
     * as the Hub last found them: never asks a Provider, so it answers at once.
     */
    readonly modelsFor: (
      participantId: ParticipantId,
    ) => Effect.Effect<ReadonlyArray<ProviderModel>>
    /**
     * The Member's Connected providers connected by a sign-in, whose APIs refuse some request
     * fields an API key's take: a pi Session's extension leaves those out (`ModProviders`).
     */
    readonly signedIn: (participantId: ParticipantId) => Effect.Effect<ReadonlyArray<ProviderId>>
  }
>()("@kndl/hub/ModelCatalog") {
  /** The same Models for every Member, for tests. */
  static readonly fixed = (models: ReadonlyArray<ProviderModel>) =>
    Layer.succeed(ModelCatalog, {
      modelsFor: () => Effect.succeed(models),
      signedIn: () => Effect.succeed([]),
    })
}
