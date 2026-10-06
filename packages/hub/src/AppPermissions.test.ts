// The GitHub App's permissions against those the Hub needs: what counts as enough, what the App
// and each installation lack, and where on GitHub to fix it.

import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import { accessLabel } from "@claude-hub/protocol"
import {
  type AppFacts,
  checkAppPermissions,
  describeDrift,
  grants,
  type InstallationFacts,
  manifestPermissions,
  missingPermissions,
  RequiredPermissions,
  requiredOn,
} from "./AppPermissions.ts"

const all = manifestPermissions()
/** All a personal account's installation can have: no organization permissions. */
const personal = manifestPermissions(requiredOn(false))

const app: AppFacts = {
  slug: "claude-hub-ada",
  htmlUrl: "https://github.com/apps/claude-hub-ada",
  owner: { login: "ada", type: "User" },
  permissions: all,
  events: [],
}

const installation = (overrides: Partial<InstallationFacts> = {}): InstallationFacts => ({
  id: 7,
  account: "ada",
  htmlUrl: "https://github.com/settings/installations/7",
  permissions: personal,
  events: [],
  suspended: false,
  organization: false,
  ...overrides,
})

describe("the required permissions", () => {
  test("are what Runners, Sessions and Repo access need, each with why", () => {
    expect(manifestPermissions()).toEqual({
      contents: "write",
      pull_requests: "write",
      issues: "write",
      metadata: "read",
      members: "read",
    })
    for (const permission of RequiredPermissions) expect(permission.why).not.toBe("")
  })

  test("on a personal account leave out the organization's", () => {
    expect(requiredOn(false).map((permission) => permission.name)).toEqual([
      "contents",
      "pull_requests",
      "issues",
      "metadata",
    ])
    expect(requiredOn(true)).toEqual(RequiredPermissions)
  })
})

describe("grants", () => {
  test("more access than asked is enough; less, or none, isn't", () => {
    expect(grants("write", "read")).toBe(true)
    expect(grants("admin", "write")).toBe(true)
    expect(grants("write", "write")).toBe(true)
    expect(grants("read", "write")).toBe(false)
    expect(grants(undefined, "read")).toBe(false)
    expect(grants("something-new", "read")).toBe(false)
  })
})

describe("missingPermissions", () => {
  test("lists those absent or too weak, and ignores extra ones", () => {
    expect(
      missingPermissions({ contents: "read", metadata: "read", issues: "write", actions: "write" }),
    ).toEqual([
      { name: "contents", title: "Contents", access: "write" },
      { name: "pull_requests", title: "Pull requests", access: "write" },
      { name: "members", title: "Members", access: "read" },
    ])
  })
})

describe("checkAppPermissions", () => {
  test("finds nothing when the App and its installations have it all", () => {
    const check = checkAppPermissions(app, [installation()], 1000)
    expect(check).toEqual({
      slug: "claude-hub-ada",
      settingsUrl: "https://github.com/settings/apps/claude-hub-ada/permissions",
      installUrl: "https://github.com/apps/claude-hub-ada/installations/new",
      missing: [],
      missingEvents: [],
      installed: 1,
      installations: [],
      checkedAt: 1000,
    })
    expect(describeDrift(check)).toEqual([])
  })

  test("finds what the App lacks, linking to its settings: an organization's under it", () => {
    const check = checkAppPermissions(
      {
        ...app,
        owner: { login: "octo", type: "Organization" },
        permissions: { ...all, issues: "read" },
      },
      [],
      1000,
    )
    expect(check.missing).toEqual([{ name: "issues", title: "Issues", access: "write" }])
    expect(check.settingsUrl).toBe(
      "https://github.com/organizations/octo/settings/apps/claude-hub-ada/permissions",
    )
    expect(describeDrift(check)).toEqual([
      "The App claude-hub-ada lacks Issues: read and write. Add it at https://github.com/organizations/octo/settings/apps/claude-hub-ada/permissions",
    ])
  })

  test("finds an installation that hasn't accepted them yet, linking to its review", () => {
    const check = checkAppPermissions(
      app,
      [
        installation(),
        installation({
          id: 8,
          account: "octo",
          htmlUrl: "https://github.com/organizations/octo/settings/installations/8",
          permissions: { contents: "write", metadata: "read" },
        }),
      ],
      1000,
    )
    expect(check.installed).toBe(2)
    expect(check.installations).toEqual([
      {
        id: 8,
        account: "octo",
        reviewUrl:
          "https://github.com/organizations/octo/settings/installations/8/permissions/update",
        missing: [
          { name: "pull_requests", title: "Pull requests", access: "write" },
          { name: "issues", title: "Issues", access: "write" },
        ],
        missingEvents: [],
      },
    ])
    expect(describeDrift(check)).toEqual([
      "Its installation on octo lacks Pull requests: read and write, Issues: read and write. Accept it at https://github.com/organizations/octo/settings/installations/8/permissions/update",
    ])
  })

  test("asks Members of an installation on an organization, and of the App once it has one", () => {
    // On personal accounts only, neither needs it.
    const personalOnly = checkAppPermissions(
      { ...app, permissions: personal },
      [installation()],
      1000,
    )
    expect(personalOnly.missing).toEqual([])
    expect(personalOnly.installations).toEqual([])

    const members = { name: "members", title: "Members", access: "read" } as const
    const check = checkAppPermissions(
      { ...app, permissions: personal },
      [
        installation(),
        installation({
          id: 8,
          account: "octo",
          htmlUrl: "https://github.com/organizations/octo/settings/installations/8",
          organization: true,
        }),
      ],
      1000,
    )
    expect(check.missing).toEqual([members])
    expect(check.installations).toEqual([
      {
        id: 8,
        account: "octo",
        reviewUrl:
          "https://github.com/organizations/octo/settings/installations/8/permissions/update",
        missing: [members],
        missingEvents: [],
      },
    ])
  })

  test("leaves out a suspended installation: it gets no tokens either way", () => {
    const check = checkAppPermissions(
      app,
      [installation({ suspended: true, permissions: { metadata: "read" } })],
      1000,
    )
    expect(check.installed).toBe(0)
    expect(check.installations).toEqual([])
  })
})

test("the docs list the permissions the Hub needs", async () => {
  // The docs page has RequiredPermissions as a table between two markers: when the list changes,
  // put the table this expects there.
  const page = await Bun.file(
    join(import.meta.dir, "../../docs/src/content/docs/how-to/set-up-the-github-app.md"),
  ).text()
  const table = /<!-- permissions:start -->\n([\s\S]*?)<!-- permissions:end -->/.exec(page)?.[1]
  expect(table).toBe(
    [
      "| Permission | Access | Why |",
      "|---|---|---|",
      ...RequiredPermissions.map(
        (permission) =>
          `| ${permission.title} | ${accessLabel(permission.access)} | ${permission.why} |`,
      ),
      "",
    ].join("\n"),
  )
})
