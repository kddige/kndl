// A Member's Hearth (spike, ADR 0032): their one persistent Session, whose Workspace lives on its
// Runner's disk rather than on GitHub, and whose agent drives their other Sessions with the kndl
// MCP server the Hub serves it.
//
// It is a Session on a Repo of its own, `~/<login>`, a name GitHub can never have, since no
// GitHub login is `~`. So everything a Repo has, a Hearth has too: an Environment, Installations
// on for it alone, a Sandbox, sleep and wake, and its history.

import type { InstallationId } from "./Ids.ts"
import type { GatewayServer } from "./McpServer.ts"
import type { BranchChoice, RepoName } from "./Session.ts"

/** The owner part of every Hearth's Repo name: no GitHub account can be called this. */
export const HearthOwner = "~"

/** The Repo a Member's Hearth is on: `~/<login>`, by their login in lowercase. */
export const hearthRepoOf = (login: string): RepoName => `${HearthOwner}/${login.toLowerCase()}`

/** Whether the Repo is a Hearth's rather than one on GitHub. */
export const isHearthRepo = (repo: string): boolean => repo.startsWith(`${HearthOwner}/`)

/** The login whose Hearth the Repo is, in lowercase; undefined for a Repo on GitHub. */
export const hearthLoginOf = (repo: string): string | undefined =>
  isHearthRepo(repo) ? repo.slice(HearthOwner.length + 1).toLowerCase() : undefined

/** Whether the Repo is the Hearth of the person with this login. */
export const isHearthOf = (repo: string, login: string): boolean =>
  hearthLoginOf(repo) === login.toLowerCase()

/** The branch a Hearth's Workspace is on: it has only the one, made on the Runner. */
export const HearthBranch = "main"

/** What a new Hearth is created with: its one branch, worked on directly. */
export const hearthBranch: BranchChoice = {
  _tag: "Existing",
  name: HearthBranch,
  newWorkBranch: false,
}

/**
 * The Hub's own MCP server for a Hearth, at `/gateway/kndl`: an Installation's id is 24 random hex
 * characters, so it is never `kndl`. Claude Code knows it as `plugin:kndl:kndl`.
 */
export const HearthServerId = "kndl" as InstallationId

/** The kndl MCP server, as StartSession gives it to a Hearth. */
export const hearthGatewayServer: GatewayServer = { installationId: HearthServerId, server: "kndl" }
