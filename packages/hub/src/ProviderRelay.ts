// The web's commands about Connected providers (ADR 0029): a Claude credential's are SessionRelay's,
// the rest this relay's.

import { ProviderCommand, type WebToHub } from "@kndl/protocol"
import { Schema } from "effect"

const isProviderMessage = Schema.is(ProviderCommand)

/** A web command about Connected providers other than a Claude credential's. */
export const isProviderCommand = (
  message: WebToHub,
): message is Exclude<
  ProviderCommand,
  { readonly _tag: "SetClaudeCredential" | "RemoveClaudeCredential" }
> =>
  message._tag !== "SetClaudeCredential" &&
  message._tag !== "RemoveClaudeCredential" &&
  isProviderMessage(message)
