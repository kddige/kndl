// The fake Hub's Plugins (ADR 0020): Hub-only Plugins, their Repo-scoped Installations, and each
// Repo's Plugin change log. It refuses what the real Hub refuses, with its words: a second
// Installation of a Plugin on a Repo, deleting a Plugin with Installations, and any change that
// needs access to a Repo the person lacks. A Repo is the same however its name is spelled (#197).
// Header secret values (#215) are taken as the Hub takes them, and kept as the Hub shows them:
// who set each and when, never the value.

import {
  clearedHeaderSecrets,
  type HeaderValueInput,
  headerSecretsOf,
  headerValueProblem,
  hubPluginId,
  installationReposProblem,
  mcpServerNames,
  type PluginAuth,
  pluginAuthProblem,
  type PluginCommand,
  pluginInUseRefusal,
  pluginNameProblem,
  pluginSlug,
  pluginUrlProblem,
  repoKey,
  sameRepo,
  secondInstallationRefusal,
} from "@kndl/protocol"
import { Redacted } from "effect"
import { bob, you } from "./script.ts"
import type {
  HeaderValueSetWire,
  HubMessage,
  ParticipantWire,
  PluginLogEntryWire,
  PluginWire,
  SessionInstallationWire,
} from "./wire.ts"

/** An Installation as the fake keeps it: every Repo it lists, whoever asks. */
interface FakeInstallation {
  readonly id: string
  readonly pluginId: string
  name: string
  repos: Array<string>
  /** Who set each header secret value, and when; the values themselves the fake drops. */
  values: Array<HeaderValueSetWire>
  readonly createdBy: ParticipantWire
  readonly createdAt: number
}

type PluginChangeWire = PluginLogEntryWire["change"]

/** A header secret a change sets a value for. */
interface SetValue {
  readonly key: string
  readonly title: string
}

/** What a change did: the Repos whose Installations changed, or why it was refused. */
export type PluginOutcome = { readonly refused: string } | { readonly repos: ReadonlyArray<string> }

const noRepoAccess = (repo: string) =>
  `You have no access to ${repo} on GitHub, or the GitHub App isn't installed on it.`
const hiddenRepos =
  "This Installation is on in Repos you have no access to, so you can't change it."

/** The Repos of `repos` that `from` doesn't list. */
const missingFrom = (from: ReadonlyArray<string>, repos: ReadonlyArray<string>) =>
  repos.filter((repo) => !from.some((other) => sameRepo(other, repo)))

/** A Plugin's auth as the Hub keeps it: titles trimmed. */
const normalizedAuth = (auth: PluginAuth): PluginAuth =>
  auth._tag === "None"
    ? auth
    : {
        _tag: "Headers",
        headers: auth.headers.map((secret) => ({ ...secret, title: secret.title.trim() })),
      }

const sameAuth = (a: PluginAuth, b: PluginAuth) => JSON.stringify(a) === JSON.stringify(b)

const minute = 60_000
const day = 24 * 60 * minute

export class FakePlugins {
  readonly #plugins: Array<PluginWire> = []
  readonly #installations: Array<FakeInstallation> = []
  /** Each Repo's log, newest first, by repoKey. */
  readonly #logs = new Map<string, Array<PluginLogEntryWire>>()
  #ids = 0

  constructor(now = Date.now()) {
    const docs = this.#plugin("Docs search", "https://docs-mcp.example.com/mcp", bob, now - 9 * day)
    // With a header secret, and no Installations yet.
    this.#plugin("Linear", "https://mcp.linear.example/mcp", you, now - 2 * day, {
      _tag: "Headers",
      headers: [
        { key: "api_key", title: "API key", header: "Authorization", template: "Bearer {value}" },
      ],
    })
    const sentry = this.#plugin("Sentry", "https://mcp.sentry.example/mcp", bob, now - 6 * day, {
      _tag: "Headers",
      headers: [
        { key: "token", title: "Auth token", header: "X-Sentry-Token", template: "{value}" },
      ],
    })
    this.#install(docs, "Docs", ["kddige/kndl"], bob, now - 8 * day)
    // On a Repo Alice can't see too: she sees it, but can't change it.
    const team = this.#install(
      sentry,
      "Sentry",
      ["kddige/kndl", "kddige/secret"],
      bob,
      now - 5 * day,
    )
    team.values = [{ key: "token", setBy: bob, setAt: now - 5 * day }]
  }

  /** Every Plugin and Installation, each Installation with only the Repos `allowed` lets through. */
  state(allowed: (repo: string) => boolean): Extract<HubMessage, { _tag: "PluginsState" }> {
    return {
      _tag: "PluginsState",
      plugins: [...this.#plugins],
      installations: this.#installations.map((installation) => {
        const repos = installation.repos.filter(allowed)
        const otherRepos = installation.repos.length - repos.length
        return { ...installation, repos, ...(otherRepos > 0 && { otherRepos }) }
      }),
    }
  }

  /** A Repo's Plugin change log, newest first. */
  log(repo: string): ReadonlyArray<PluginLogEntryWire> {
    return this.#logs.get(repoKey(repo)) ?? []
  }

  /** The Installations on for a Repo, as a Session starting there runs with them. */
  forSession(repo: string): Array<SessionInstallationWire> {
    const on = this.#installations.filter((installation) =>
      installation.repos.some((listed) => sameRepo(listed, repo)),
    )
    const servers = mcpServerNames(on.map((installation) => installation.name))
    return on.map((installation, index) => ({
      id: installation.id,
      name: installation.name,
      pluginId: installation.pluginId,
      pluginName: this.#find(installation.pluginId)?.name ?? "",
      server: servers[index] ?? "",
      ...(installation.values.length > 0 && {
        values: installation.values.map(({ key, setAt }) => ({ key, setAt })),
      }),
    }))
  }

  /** Applies a change by `by`, who has access to the Repos `allowed` lets through. */
  change(
    command: Exclude<PluginCommand, { _tag: "GetPlugins" | "GetPluginLog" }>,
    by: ParticipantWire,
    allowed: (repo: string) => boolean,
  ): PluginOutcome {
    const at = Date.now()
    switch (command._tag) {
      case "CreatePlugin": {
        const problem =
          pluginNameProblem(command.name) ??
          pluginUrlProblem(command.url) ??
          pluginAuthProblem(command.auth)
        if (problem !== undefined) return { refused: problem }
        this.#plugin(command.name.trim(), command.url, by, at, normalizedAuth(command.auth))
        return { repos: [] }
      }
      case "EditPlugin": {
        const plugin = this.#find(command.pluginId)
        if (plugin === undefined) return { refused: "There is no such Plugin." }
        const installed = this.#installations.filter((one) => one.pluginId === plugin.id)
        if (installed.some((one) => !one.repos.every(allowed))) {
          return {
            refused:
              "This Plugin has Installations on Repos you have no access to, so you can't edit it.",
          }
        }
        const problem =
          pluginNameProblem(command.name) ??
          pluginUrlProblem(command.url) ??
          pluginAuthProblem(command.auth)
        if (problem !== undefined) return { refused: problem }
        const name = command.name.trim()
        const auth = normalizedAuth(command.auth)
        if (name === plugin.name && command.url === plugin.url && sameAuth(auth, plugin.auth)) {
          return { repos: [] }
        }
        const cleared = clearedHeaderSecrets(plugin, { url: command.url, auth })
        this.#plugins[this.#plugins.indexOf(plugin)] = { ...plugin, name, url: command.url, auth }
        for (const one of installed) {
          const lost = cleared.filter((secret) => one.values.some(({ key }) => key === secret.key))
          one.values = one.values.filter(({ key }) => !lost.some((secret) => secret.key === key))
          this.#record(one.repos, "PluginEdited", one, by, at)
          if (lost.length > 0) {
            const titles = lost.map((secret) => secret.title)
            this.#record(one.repos, "ValuesCleared", one, by, at, titles)
          }
        }
        return { repos: installed.flatMap((one) => one.repos) }
      }
      case "DeletePlugin": {
        const plugin = this.#find(command.pluginId)
        if (plugin === undefined) return { refused: "There is no such Plugin." }
        const count = this.#installations.filter((one) => one.pluginId === plugin.id).length
        if (count > 0) return { refused: pluginInUseRefusal(plugin.name, count) }
        this.#plugins.splice(this.#plugins.indexOf(plugin), 1)
        return { repos: [] }
      }
      case "CreateInstallation": {
        const refusedRepo = command.repos.find((repo) => !allowed(repo))
        if (refusedRepo !== undefined) return { refused: noRepoAccess(refusedRepo) }
        const plugin = this.#find(command.pluginId)
        if (plugin === undefined) return { refused: "There is no such Plugin." }
        const problem =
          pluginNameProblem(command.name, "An Installation") ??
          installationReposProblem(command.repos)
        if (problem !== undefined) return { refused: problem }
        const values = this.#values(plugin, command.values ?? [])
        if ("refused" in values) return values
        const second = this.#second(plugin, command.repos, null)
        if (second !== undefined) return { refused: second }
        const installation = this.#install(plugin, command.name.trim(), command.repos, by, at)
        this.#set(installation, values.set, command.repos, by, at)
        return { repos: installation.repos }
      }
      case "EditInstallation":
      case "DeleteInstallation": {
        const named = command._tag === "EditInstallation" ? command.repos : []
        const refusedRepo = named.find((repo) => !allowed(repo))
        if (refusedRepo !== undefined) return { refused: noRepoAccess(refusedRepo) }
        const installation = this.#installations.find((one) => one.id === command.installationId)
        if (installation === undefined) return { refused: "There is no such Installation." }
        if (!installation.repos.every(allowed)) return { refused: hiddenRepos }
        if (command._tag === "DeleteInstallation") {
          this.#installations.splice(this.#installations.indexOf(installation), 1)
          this.#record(installation.repos, "Deleted", installation, by, at)
          return { repos: installation.repos }
        }
        const problem =
          pluginNameProblem(command.name, "An Installation") ??
          installationReposProblem(command.repos)
        if (problem !== undefined) return { refused: problem }
        const plugin = this.#find(installation.pluginId)
        const values = plugin ? this.#values(plugin, command.values ?? []) : { set: [] }
        if ("refused" in values) return values
        const added = missingFrom(installation.repos, command.repos)
        const removed = missingFrom(command.repos, installation.repos)
        const kept = installation.repos.filter((repo) => !removed.includes(repo))
        const name = command.name.trim()
        const renamed = name !== installation.name
        const second = plugin && this.#second(plugin, added, installation.id)
        if (second !== undefined) return { refused: second }
        installation.name = name
        installation.repos = [...kept, ...added]
        if (renamed) this.#record(kept, "Renamed", installation, by, at)
        this.#record(added, "Added", installation, by, at)
        this.#record(removed, "Removed", installation, by, at)
        // A Repo it was added to has its values from the start: Added says so.
        this.#set(installation, values.set, kept, by, at)
        return {
          repos:
            renamed || values.set.length > 0
              ? [...kept, ...added, ...removed]
              : [...added, ...removed],
        }
      }
    }
  }

  #find(id: string): PluginWire | undefined {
    return this.#plugins.find((plugin) => plugin.id === id)
  }

  /** The header secrets `values` set, by title, or why one is refused, as the Hub says it. */
  #values(
    plugin: PluginWire,
    values: ReadonlyArray<HeaderValueInput>,
  ): { readonly refused: string } | { readonly set: ReadonlyArray<SetValue> } {
    const declared = headerSecretsOf(plugin.auth)
    const set = new Map<string, SetValue>()
    for (const input of values) {
      const secret = declared.find((one) => one.key === input.key)
      if (secret === undefined) {
        return { refused: `${plugin.name} has no header secret ${input.key}.` }
      }
      const problem = headerValueProblem(secret.title, Redacted.value(input.value))
      if (problem !== undefined) return { refused: problem }
      set.set(secret.key, { key: secret.key, title: secret.title })
    }
    return { set: [...set.values()] }
  }

  /** Stamps the values set on `installation`, and logs them on `repos` by title. */
  #set(
    installation: FakeInstallation,
    set: ReadonlyArray<SetValue>,
    repos: ReadonlyArray<string>,
    by: ParticipantWire,
    at: number,
  ): void {
    if (set.length === 0) return
    installation.values = [
      ...installation.values.filter(({ key }) => !set.some((one) => one.key === key)),
      ...set.map(({ key }) => ({ key, setBy: by, setAt: at })),
    ]
    const titles = set.map(({ title }) => title)
    this.#record(repos, "ValuesSet", installation, by, at, titles)
  }

  #plugin(
    name: string,
    url: string,
    by: ParticipantWire,
    at: number,
    auth: PluginAuth = { _tag: "None" },
  ): PluginWire {
    const slug = pluginSlug(name)
    let id: string = hubPluginId(slug)
    for (let n = 2; this.#find(id) !== undefined; n++) id = hubPluginId(`${slug}-${n}`)
    const plugin: PluginWire = { id, name, url, auth, createdBy: by, createdAt: at }
    this.#plugins.push(plugin)
    return plugin
  }

  #install(
    plugin: PluginWire,
    name: string,
    repos: ReadonlyArray<string>,
    by: ParticipantWire,
    at: number,
  ): FakeInstallation {
    const installation: FakeInstallation = {
      id: `inst-${++this.#ids}`,
      pluginId: plugin.id,
      name,
      repos: [...repos],
      values: [],
      createdBy: by,
      createdAt: at,
    }
    this.#installations.push(installation)
    this.#record(repos, "Created", installation, by, at)
    return installation
  }

  /** Why an Installation of `plugin` on one of `repos` is refused: another is on there. */
  #second(
    plugin: PluginWire,
    repos: ReadonlyArray<string>,
    except: string | null,
  ): string | undefined {
    for (const repo of repos) {
      const existing = this.#installations.find(
        (one) =>
          one.pluginId === plugin.id &&
          one.id !== except &&
          one.repos.some((listed) => sameRepo(listed, repo)),
      )
      if (existing) return secondInstallationRefusal(repo, existing.name, plugin.name)
    }
    return undefined
  }

  #record(
    repos: ReadonlyArray<string>,
    change: PluginChangeWire,
    installation: FakeInstallation,
    by: ParticipantWire,
    at: number,
    secrets?: ReadonlyArray<string>,
  ): void {
    const plugin = this.#find(installation.pluginId)
    for (const repo of repos) {
      const log = this.#logs.get(repoKey(repo)) ?? []
      log.unshift({
        at,
        by,
        change,
        pluginId: installation.pluginId,
        pluginName: plugin?.name ?? "",
        installationId: installation.id,
        installationName: installation.name,
        ...(secrets !== undefined && { secrets: [...secrets] }),
      })
      this.#logs.set(repoKey(repo), log)
    }
  }
}
