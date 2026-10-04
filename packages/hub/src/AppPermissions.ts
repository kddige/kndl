// The GitHub App's permissions (issue #86): the one list of what the App needs, which makes the
// manifest `claude-hub onboard` creates the App from, and the check of the App and each of its
// installations against it. The docs' list is tested against this one.
//
// An App's permissions and its installations' drift apart: changing the App's permissions on
// GitHub asks each account it is installed on to accept them, and until one does, its
// installation keeps the old ones. GitHub has no API to change either, so the check only says what
// is missing and where on GitHub to fix it.

import type {
  AppPermission,
  AppPermissionsCheck,
  InstallationDrift,
  PermissionAccess,
} from "@claude-hub/protocol"

/** A permission the App needs, and why. */
export interface RequiredPermission extends AppPermission {
  readonly why: string
}

/**
 * Every permission the App needs. Each Session's Sandbox gets a token with all the installation's
 * permissions (ADR 0010), so this is also what Claude can do on a Repo: add a permission only for
 * something claude-hub or a Session needs.
 */
export const RequiredPermissions: ReadonlyArray<RequiredPermission> = [
  {
    name: "contents",
    title: "Contents",
    access: "write",
    why: "Runners clone Repos and push WIP refs; Sessions push branches.",
  },
  {
    name: "pull_requests",
    title: "Pull requests",
    access: "write",
    why: "Sessions open, review and merge pull requests with gh.",
  },
  {
    name: "issues",
    title: "Issues",
    access: "write",
    why: "Sessions read and comment on the issues they work on with gh.",
  },
  {
    name: "metadata",
    title: "Metadata",
    access: "read",
    why: "The Hub checks who is a Repo's collaborator. GitHub gives every App this one.",
  },
]

/**
 * The webhook events the App subscribes to: none, since the Hub has no webhook. Listed so that one
 * the Hub comes to need is checked like the permissions.
 */
export const RequiredEvents: ReadonlyArray<string> = []

const AccessRank: Record<PermissionAccess, number> = { read: 1, write: 2, admin: 3 }

/** Whether `granted`, GitHub's name for an access, gives at least `required`. */
export function grants(granted: string | undefined, required: PermissionAccess): boolean {
  const rank = granted === undefined ? 0 : (AccessRank[granted as PermissionAccess] ?? 0)
  return rank >= AccessRank[required]
}

/** The required permissions `granted` lacks, or has with too little access. */
export function missingPermissions(
  granted: Readonly<Record<string, string>>,
  required: ReadonlyArray<AppPermission> = RequiredPermissions,
): ReadonlyArray<AppPermission> {
  return required
    .filter((permission) => !grants(granted[permission.name], permission.access))
    .map(({ name, title, access }) => ({ name, title, access }))
}

/** The required events `subscribed` lacks. */
export const missingEvents = (
  subscribed: ReadonlyArray<string>,
  required: ReadonlyArray<string> = RequiredEvents,
): ReadonlyArray<string> => required.filter((event) => !subscribed.includes(event))

/** The App, as `GET /app` describes it. */
export interface AppFacts {
  readonly slug: string
  /** `https://github.com/apps/<slug>`. */
  readonly htmlUrl: string
  readonly owner: { readonly login: string; readonly type: string }
  readonly permissions: Readonly<Record<string, string>>
  readonly events: ReadonlyArray<string>
}

/** One installation, as `GET /app/installations` describes it. */
export interface InstallationFacts {
  readonly id: number
  readonly account: string
  /** Its settings page: `https://github.com/settings/installations/<id>`, or an organization's. */
  readonly htmlUrl: string
  readonly permissions: Readonly<Record<string, string>>
  readonly events: ReadonlyArray<string>
  readonly suspended: boolean
}

/** The App's "Permissions & events" settings page, on its owner's settings. */
export function appSettingsUrl(app: Pick<AppFacts, "slug" | "htmlUrl" | "owner">): string {
  const web = new URL(app.htmlUrl).origin
  const owner =
    app.owner.type === "Organization" ? `/organizations/${encodeURIComponent(app.owner.login)}` : ""
  return `${web}${owner}/settings/apps/${encodeURIComponent(app.slug)}/permissions`
}

/** Where to install the App on an account. */
export const appInstallUrl = (app: Pick<AppFacts, "htmlUrl">): string =>
  `${app.htmlUrl.replace(/\/$/, "")}/installations/new`

/** The installation's page that reviews a request for more permissions. */
export const installationReviewUrl = (installation: Pick<InstallationFacts, "htmlUrl">): string =>
  `${installation.htmlUrl.replace(/\/$/, "")}/permissions/update`

/**
 * What the App and its installations lack of the required permissions and events. A suspended
 * installation is left out: it gets no tokens either way.
 */
export function checkAppPermissions(
  app: AppFacts,
  installations: ReadonlyArray<InstallationFacts>,
  checkedAt: number,
): AppPermissionsCheck {
  const active = installations.filter((installation) => !installation.suspended)
  const drifted: Array<InstallationDrift> = []
  for (const installation of active) {
    const missing = missingPermissions(installation.permissions)
    const events = missingEvents(installation.events)
    if (missing.length === 0 && events.length === 0) continue
    drifted.push({
      id: installation.id,
      account: installation.account,
      reviewUrl: installationReviewUrl(installation),
      missing,
      missingEvents: events,
    })
  }
  return {
    slug: app.slug,
    settingsUrl: appSettingsUrl(app),
    installUrl: appInstallUrl(app),
    missing: missingPermissions(app.permissions),
    missingEvents: missingEvents(app.events),
    installed: active.length,
    installations: drifted,
    checkedAt,
  }
}

/** What a check found, in a few lines of plain text: for doctor and the Hub's log. */
export function describeDrift(check: AppPermissionsCheck): ReadonlyArray<string> {
  const lines: Array<string> = []
  if (check.missing.length > 0 || check.missingEvents.length > 0) {
    lines.push(
      `The App ${check.slug} lacks ${describeMissing(check.missing, check.missingEvents)}. Add it at ${check.settingsUrl}`,
    )
  }
  for (const installation of check.installations) {
    lines.push(
      `Its installation on ${installation.account} lacks ${describeMissing(installation.missing, installation.missingEvents)}. ${check.missing.length > 0 ? "Once the App has it, accept" : "Accept"} it at ${installation.reviewUrl}`,
    )
  }
  return lines
}

/** What is missing, as "Issues: Read and write, the push event". */
export const describeMissing = (
  missing: ReadonlyArray<AppPermission>,
  events: ReadonlyArray<string>,
): string =>
  [
    ...missing.map((permission) => `${permission.title}: ${accessTitle(permission.access)}`),
    ...events.map((event) => `the ${event} event`),
  ].join(", ")

/** As GitHub's settings page says it: "Read-only", "Read and write", "Admin". */
export function accessTitle(access: PermissionAccess): string {
  switch (access) {
    case "read":
      return "Read-only"
    case "write":
      return "Read and write"
    case "admin":
      return "Admin"
  }
}

/** The manifest's `default_permissions`: each required permission and its access. */
export const manifestPermissions = (
  required: ReadonlyArray<AppPermission> = RequiredPermissions,
): Readonly<Record<string, PermissionAccess>> =>
  Object.fromEntries(required.map((permission) => [permission.name, permission.access]))
