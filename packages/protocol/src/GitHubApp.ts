import { Schema } from "effect"
import { EpochMillis } from "./Session.ts"

// The GitHub App's permissions, as the Hub checks them against what it needs (issue #86). The
// Hub reads the App's permissions and each installation's from GitHub, compares them with its
// list of required ones, and sends the web UI what is missing, with links to fix it on GitHub:
// GitHub has no API to change an App's permissions.

/** How much of a permission: GitHub's `read`, `write` or `admin`. */
export const PermissionAccess = Schema.Literals(["read", "write", "admin"])
export type PermissionAccess = typeof PermissionAccess.Type

/** A permission the App needs and lacks. */
export const AppPermission = Schema.Struct({
  /** GitHub's name for it, such as `pull_requests`. */
  name: Schema.NonEmptyString,
  /** As GitHub's settings page names it, such as "Pull requests". */
  title: Schema.String,
  access: PermissionAccess,
})
export type AppPermission = typeof AppPermission.Type

/**
 * An installation of the App that lacks a required permission or event. An installation has only
 * what its account accepted: when the App asks for more, each account is asked to review it.
 */
export const InstallationDrift = Schema.Struct({
  id: Schema.Int,
  /** The account it is installed on. */
  account: Schema.String,
  /** The installation's page that reviews the App's request for more permissions. */
  reviewUrl: Schema.String,
  missing: Schema.Array(AppPermission),
  missingEvents: Schema.Array(Schema.String),
})
export type InstallationDrift = typeof InstallationDrift.Type

/** What the Hub found when it last compared the App's permissions with those it needs. */
export const AppPermissionsCheck = Schema.Struct({
  /** The App's slug, as in `github.com/apps/<slug>`. */
  slug: Schema.String,
  /** The App's "Permissions & events" settings page, where its owner changes them. */
  settingsUrl: Schema.String,
  /** Where to install the App on another account. */
  installUrl: Schema.String,
  /** What the App itself lacks. */
  missing: Schema.Array(AppPermission),
  missingEvents: Schema.Array(Schema.String),
  /** How many accounts the App is installed on, suspended ones left out. */
  installed: Schema.Int,
  /** The installations that lack something; the others are left out. */
  installations: Schema.Array(InstallationDrift),
  checkedAt: EpochMillis,
})
export type AppPermissionsCheck = typeof AppPermissionsCheck.Type

/** An access in words: "read-only", "read and write" or "admin". */
export function accessLabel(access: PermissionAccess): string {
  switch (access) {
    case "read":
      return "read-only"
    case "write":
      return "read and write"
    case "admin":
      return "admin"
  }
}

/**
 * What is missing, in the words the Hub's log, doctor and the web UI all use: "Pull requests:
 * read and write, Issues: read and write, the push event".
 */
export const describeMissing = (
  missing: ReadonlyArray<AppPermission>,
  events: ReadonlyArray<string>,
): string =>
  [
    ...missing.map((permission) => `${permission.title}: ${accessLabel(permission.access)}`),
    ...events.map((event) => `the ${event} event`),
  ].join(", ")

/** Whether the check found anything missing, on the App or any installation. */
export const hasPermissionDrift = (check: AppPermissionsCheck): boolean =>
  check.missing.length > 0 || check.missingEvents.length > 0 || check.installations.length > 0
