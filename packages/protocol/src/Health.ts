import { Schema } from "effect"

/** What the Hub answers on `GET /health` when it is up and its database answers. */
export const HubHealth = Schema.Struct({
  status: Schema.Literal("ok"),
})
export type HubHealth = typeof HubHealth.Type
