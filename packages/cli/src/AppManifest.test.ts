import { describe, expect, test } from "bun:test"
import { RequiredPermissions } from "@kndl/hub/src/AppPermissions.ts"
import { Option, Redacted } from "effect"
import {
  appEnvUpdates,
  appKeyFile,
  appManifest,
  appName,
  checkLogin,
  GitHubDotCom,
  manifestPage,
  newAppUrl,
  readRedirect,
  settingsFromConversion,
} from "./AppManifest.ts"
import { browserOpener } from "./AppSetup.ts"

const manifest = appManifest({
  hubUrl: "https://hub.example.com/",
  redirectUrl: "http://127.0.0.1:50123/github-app/created",
  machine: "Studio.local",
})

describe("the App's manifest", () => {
  test("asks for every required permission, and for sign-in back to the Hub", () => {
    expect(manifest).toEqual({
      name: "kndl-studio",
      url: "https://hub.example.com",
      description: expect.stringContaining("https://hub.example.com"),
      redirect_url: "http://127.0.0.1:50123/github-app/created",
      callback_urls: ["https://hub.example.com/auth/github/callback"],
      public: false,
      request_oauth_on_install: false,
      default_permissions: {
        contents: "write",
        pull_requests: "write",
        issues: "write",
        metadata: "read",
        members: "read",
      },
      default_events: [],
    })
    expect(Object.keys(manifest.default_permissions)).toEqual(
      RequiredPermissions.map((permission) => permission.name),
    )
  })

  test("has no webhook, so GitHub makes the App without one", () => {
    expect(manifest).not.toHaveProperty("hook_attributes")
  })

  test("names the App after the machine, within GitHub's 34 characters", () => {
    expect(appName("mac")).toBe("kndl-mac")
    expect(appName("My_Box.lan")).toBe("kndl-my-box")
    expect(appName("")).toBe("kndl")
    expect(appName("a-very-long-machine-name-indeed")).toBe("kndl-a-very-long-machine-name-inde")
    // Cut at 34, it would end in a hyphen.
    expect(appName("abcdefghijklmnopqrstuvwxyzab-x")).toBe("kndl-abcdefghijklmnopqrstuvwxyzab")
  })
})

describe("GitHub's page that makes it", () => {
  test("is the person's own, or an organization's", () => {
    expect(newAppUrl(GitHubDotCom, { _tag: "Personal" }, "s1")).toBe(
      "https://github.com/settings/apps/new?state=s1",
    )
    expect(newAppUrl(GitHubDotCom, { _tag: "Organization", login: "acme" }, "s1")).toBe(
      "https://github.com/organizations/acme/settings/apps/new?state=s1",
    )
  })

  test("an organization is a GitHub login", () => {
    expect(checkLogin("acme-corp")).toBeUndefined()
    expect(checkLogin("acme/corp")).toBeString()
    expect(checkLogin("-acme")).toBeString()
  })

  test("the local page POSTs the manifest there, escaped", () => {
    const tricky = { ...manifest, name: `"><script>alert(1)</script>` }
    const page = manifestPage("https://github.com/settings/apps/new?state=s1", tricky, {
      _tag: "Personal",
    })
    expect(page).toContain(
      '<form id="manifest" method="post" action="https://github.com/settings/apps/new?state=s1">',
    )
    expect(page).not.toContain("<script>alert(1)")
    const value = /name="manifest" value="([^"]*)"/.exec(page)?.[1] ?? ""
    const decoded = value
      .replaceAll("&quot;", '"')
      .replaceAll("&#39;", "'")
      .replaceAll("&lt;", "<")
      .replaceAll("&gt;", ">")
      .replaceAll("&amp;", "&")
    expect(JSON.parse(decoded)).toEqual(tricky)
  })
})

describe("the redirect back", () => {
  test("its address gives the code, when its state is this attempt's", () => {
    expect(
      readRedirect("http://127.0.0.1:50123/github-app/created?code=abc123def&state=s1", "s1"),
    ).toEqual({ _tag: "Code", code: "abc123def" })
    expect(
      readRedirect("http://127.0.0.1:50123/github-app/created?code=abc123def&state=s2", "s1"),
    ).toMatchObject({ _tag: "Invalid", reason: expect.stringContaining("another attempt") })
    expect(readRedirect("http://127.0.0.1:50123/github-app/created?state=s1", "s1")).toMatchObject({
      _tag: "Invalid",
    })
  })

  test("the code alone will do; anything else won't", () => {
    expect(readRedirect("  a1b2c3d4e5f6a7b8c9d0 ", "s1")).toEqual({
      _tag: "Code",
      code: "a1b2c3d4e5f6a7b8c9d0",
    })
    expect(readRedirect("not a code", "s1")._tag).toBe("Invalid")
  })
})

describe("the new App's settings", () => {
  const conversion = {
    id: 1001,
    slug: "kndl-studio",
    htmlUrl: "https://github.com/apps/kndl-studio",
    owner: "kddige",
    clientId: "Iv23liabc",
    clientSecret: Redacted.make("secret"),
    webhookSecret: Option.none(),
    pem: Redacted.make("-----BEGIN RSA PRIVATE KEY-----"),
  }

  test("go into hub.env, the key by its path in the home", () => {
    const path = appKeyFile("/home/me/.kndl", 1001)
    expect(path).toBe("/home/me/.kndl/github-app-1001.pem")
    expect(appEnvUpdates(settingsFromConversion(conversion, path))).toEqual({
      GITHUB_APP_ID: "1001",
      GITHUB_APP_PRIVATE_KEY_PATH: path,
      GITHUB_CLIENT_ID: "Iv23liabc",
      GITHUB_CLIENT_SECRET: "secret",
      GITHUB_WEBHOOK_SECRET: undefined,
    })
  })

  test("with a webhook secret, when GitHub hands one out", () => {
    const updates = appEnvUpdates(
      settingsFromConversion(
        { ...conversion, webhookSecret: Option.some(Redacted.make("hook")) },
        "/k.pem",
      ),
    )
    expect(updates.GITHUB_WEBHOOK_SECRET).toBe("hook")
  })
})

describe("opening a browser", () => {
  test("on a desktop, not over SSH", () => {
    expect(browserOpener("darwin", {})).toBe("open")
    expect(browserOpener("linux", { DISPLAY: ":0" })).toBe("xdg-open")
    expect(browserOpener("linux", { WAYLAND_DISPLAY: "wayland-0" })).toBe("xdg-open")
    expect(browserOpener("linux", {})).toBeUndefined()
    expect(browserOpener("linux", { DISPLAY: ":0", SSH_CONNECTION: "1 2 3 4" })).toBeUndefined()
    expect(browserOpener("darwin", { SSH_TTY: "/dev/ttys001" })).toBeUndefined()
  })
})
