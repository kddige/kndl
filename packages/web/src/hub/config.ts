// Where the web UI reaches the Hub. The Hub is same-origin: in development Vite passes these
// paths through to it, so the sign-in cookie stays host-only and the Hub's Origin check passes.
// Keep every Hub path here, so they stay in one place to align with the Hub's routes (issue #7).

export const hubPaths = {
  /** The web channel: a WebSocket authenticated by the sign-in cookie. */
  webSocket: "/ws/web",
  /** `GET`: the signed-in Participant, or 401 with the {@link SignInOptions} that are on. */
  me: "/auth/me",
  /** `GET`: redirects to GitHub to sign in, and back to `/` afterwards. */
  githubSignIn: "/auth/github",
  /** `POST` with `{ login? }`: dev login, only when the Hub runs on loopback with it turned on. */
  devSignIn: "/auth/dev",
  /** `POST`: signs out and clears the cookie. */
  signOut: "/auth/sign-out",
} as const

/** The ways to sign in that the Hub has turned on, from its 401 answer to `GET /auth/me`. */
export interface SignInOptions {
  readonly github: boolean
  readonly dev: boolean
}

/** The web channel's URL on the page's own origin, `ws:` or `wss:` to match the page. */
export function webSocketUrl(location: Pick<Location, "protocol" | "host">): string {
  const scheme = location.protocol === "https:" ? "wss:" : "ws:"
  return `${scheme}//${location.host}${hubPaths.webSocket}`
}

/**
 * `VITE_FAKE_HUB=1` runs the web UI against the in-process fake Hub instead of the real one, with
 * a scripted Session to watch; `VITE_FAKE_HUB=signed-out` starts it signed out.
 */
export type FakeHubMode = "off" | "signed-in" | "signed-out"

export function fakeHubMode(flag: string | undefined): FakeHubMode {
  if (flag === undefined || flag === "" || flag === "0") return "off"
  return flag === "signed-out" ? "signed-out" : "signed-in"
}
