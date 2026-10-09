// An MCP server's icon (#230, ADR 0021): `GET /mcp/<id>/icon`, with the id URL-encoded (a package's
// name may hold `@` and `/`). Only the Hub fetches icons, from wherever an MCP server's manifest or
// URL points; the browser asks the Hub, signed in as for everything else.
//
// What the Hub found is untrusted, so it is served as an image of the type its bytes were
// sniffed as, which the browser must not second-guess (`nosniff`), and sandboxed: an SVG opened
// on its own runs no script, and can't reach the Hub's origin.

import { McpServerId } from "@kndl/protocol"
import { Effect, Option } from "effect"
import { HttpRouter, HttpServerResponse } from "effect/http"
import { authenticateParticipant } from "./Auth.ts"
import { McpServers } from "./McpServers.ts"

export const McpServerIconRoutes = HttpRouter.use(
  Effect.fn(function* (router) {
    const mcpServers = yield* McpServers

    yield* router.add(
      "GET",
      "/mcp/:id/icon",
      Effect.gen(function* () {
        yield* authenticateParticipant
        const { id } = yield* HttpRouter.params
        const decoded = (() => {
          try {
            return id === undefined ? undefined : decodeURIComponent(id)
          } catch {
            return undefined
          }
        })()
        const icon =
          decoded === undefined
            ? Option.none()
            : yield* mcpServers.icon(McpServerId.make(decoded)).pipe(Effect.orDie)
        if (Option.isNone(icon)) return HttpServerResponse.text("no icon", { status: 404 })
        return HttpServerResponse.uint8Array(icon.value.bytes, {
          contentType: icon.value.contentType,
          headers: {
            "content-security-policy": "sandbox",
            "x-content-type-options": "nosniff",
            // The web puts the icon's hash in the URL, so a new icon is a new URL.
            "cache-control": "private, max-age=31536000, immutable",
          },
        })
      }),
    )
  }),
)
