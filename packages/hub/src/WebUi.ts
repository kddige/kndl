// The web UI, built: the Hub serves packages/web's Vite build on its own origin, so a production
// Hub is one process on one port. In development Vite serves the web UI instead (`bun run web`)
// and passes the Hub's paths through to it (packages/web/vite.config.ts).
//
// Every GET path no other route answers lands here. A file in the build is served as it is; any
// other path without a file extension is one of the web UI's own routes, which TanStack Router
// resolves in the browser, so it gets `index.html`.

import { join, posix } from "node:path"
import { Effect, FileSystem, Layer } from "effect"
import {
  type HttpServerError,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
  HttpStaticServer,
} from "effect/http"
import { HubConfig } from "./HubConfig.ts"

/**
 * The Hub's own path prefixes. A path under one that no route answers is a 404, never the web UI,
 * so a mistyped call to the Hub fails as one. Keep in step with the routes in Hub.ts.
 */
const hubPrefixes = ["/auth", "/cli", "/health", "/mod", "/ws"]

/** Where Vite puts the files it names by a hash of their contents, so they never change. */
const assetsPrefix = "/assets/"

/** For hashed assets: kept a year, never checked again. */
export const assetCacheControl = "public, max-age=31536000, immutable"

/** For everything else, `index.html` above all: checked on every load, so a new build shows. */
export const pageCacheControl = "no-cache"

/** The page in place of the web UI while it isn't built. */
export const notBuiltMessage = [
  "The Hub's web UI isn't built.",
  "",
  "Run `bun run web:build` in the claude-hub checkout, then reload this page.",
  "In development, run `bun run web` instead and open http://localhost:5173.",
].join("\n")

const notFound = HttpServerResponse.text("not found", { status: 404 })

const isHubPath = (path: string) =>
  hubPrefixes.some((prefix) => path === prefix || path.startsWith(`${prefix}/`))

const isRouteNotFound = (error: HttpServerError.HttpServerError) =>
  error.reason._tag === "RouteNotFound"

/** A request's path, without its query. */
function pathOf(url: string): string {
  const query = url.indexOf("?")
  return query === -1 ? url : url.slice(0, query)
}

export const WebUiRoutes = HttpRouter.use(
  Effect.fn(function* (router) {
    const { webDir } = yield* HubConfig
    // Content types, ETags, conditional requests and ranges, and no path out of webDir.
    const files = yield* HttpStaticServer.make({ root: webDir })

    // Checks the build on every request, so building while the Hub runs needs no restart.
    const serveIndex = (request: HttpServerRequest.HttpServerRequest) =>
      files.pipe(
        Effect.provideService(
          HttpServerRequest.HttpServerRequest,
          request.modify({ url: "/index.html" }),
        ),
        Effect.catchIf(isRouteNotFound, () =>
          Effect.succeed(HttpServerResponse.text(notBuiltMessage, { status: 503 })),
        ),
      )

    yield* router.add(
      "GET",
      "/*",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const path = pathOf(request.url)
        if (isHubPath(path)) return notFound
        const response = yield* files.pipe(
          Effect.map((found) =>
            path.startsWith(assetsPrefix)
              ? HttpServerResponse.setHeader(found, "Cache-Control", assetCacheControl)
              : found,
          ),
          Effect.catchIf(isRouteNotFound, () =>
            posix.extname(path) === "" ? serveIndex(request) : Effect.succeed(notFound),
          ),
        )
        return response.headers["cache-control"] === undefined
          ? HttpServerResponse.setHeader(response, "Cache-Control", pageCacheControl)
          : response
      }),
    )
  }),
)

/** Logs where the web UI is served from, or that it isn't built: the Hub starts either way. */
export const announceWebUi = Layer.effectDiscard(
  Effect.gen(function* () {
    const { webDir } = yield* HubConfig
    const fs = yield* FileSystem.FileSystem
    const built = yield* fs
      .exists(join(webDir, "index.html"))
      .pipe(Effect.orElseSucceed(() => false))
    if (built) {
      yield* Effect.logInfo(`Serving the web UI from ${webDir}.`)
    } else {
      yield* Effect.logWarning(
        `The web UI isn't built: there is no index.html in ${webDir} (HUB_WEB_DIR). Run \`bun run web:build\` to serve it here, or \`bun run web\` for Vite's dev server.`,
      )
    }
  }),
)
