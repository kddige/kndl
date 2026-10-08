// The Plugins (ADR 0020): remote MCP servers the Hub adds to Sessions, each with the Installations
// that put it on in Repos. Any Member adds a Plugin; an Installation needs access to every Repo it
// lists, as a Session does, and a Repo has at most one Installation of each Plugin. Claude Code in
// a Session reaches each through the Hub's Gateway, so no Plugin's address or credential is ever
// in a Sandbox. A change applies to a Session at its next wake or Restart.
//
// A Plugin can declare header secrets (#215): a header, and a template its value goes in. Each
// Installation enters its own values, write-only: the page shows only who set each and when, or
// that it needs a value. Before an edit to the Plugin clears values (a URL on another server, or a
// header secret's key or header changed), the dialog says whose.
//
// A packaged Plugin (#220) is pinned to the version it was added at: only an Upgrade changes it,
// its name included, and it clears values as an edit does.

import {
  type HeaderSecret,
  type HeaderValueInput,
  headerSecretsOf,
  headerValueProblem,
  type Installation,
  installationReposProblem,
  MaxHeaderSecrets,
  packageVersion,
  type Plugin,
  type PluginAuth,
  pluginAuthProblem,
  pluginNameProblem,
  pluginUrlProblem,
  ValuePlaceholder,
  sourceText,
} from "@kndl/protocol"
import * as stylex from "@stylexjs/stylex"
import { Link } from "@tanstack/react-router"
import { Redacted } from "effect"
import { type FormEvent, useEffect, useState } from "react"
import { andList, repoParams, timeAgo } from "../app/format.ts"
import { useHub, useHubState } from "../app/hub.tsx"
import { repoPattern } from "../app/repoAccess.tsx"
import {
  Avatar,
  Badge,
  Banner,
  Button,
  Dialog,
  DialogClose,
  EmptyState,
  Field,
  IconButton,
  Input,
  PageHeader,
  PluginIcon,
  PlusIcon,
  Spinner,
  Textarea,
  toast,
  TrashIcon,
  WarningIcon,
} from "../ui/index.ts"
import { focus } from "../ui/shared.ts"
import { color, font, leading, radius, space, text, weight } from "../ui/tokens.stylex.ts"
import { type ClearedValues, clearedValues, keyFromTitle } from "./headerSecrets.ts"
import { PackageDialog, type PackageOpening } from "./PackageDialog.tsx"
import { messageOf, useLastOpened } from "./shared.ts"

const styles = stylex.create({
  view: { display: "flex", flexDirection: "column", flex: 1, minHeight: 0 },
  scroll: { flex: 1, overflowY: "auto" },
  page: {
    display: "flex",
    flexDirection: "column",
    gap: space.s4,
    maxWidth: "56rem",
    marginInline: "auto",
    paddingBlock: space.s6,
    paddingInline: space.s4,
  },
  plugins: {
    display: "flex",
    flexDirection: "column",
    gap: space.s4,
    margin: 0,
    padding: 0,
    listStyle: "none",
  },
  card: {
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: color.border,
    borderRadius: radius.lg,
    backgroundColor: color.surface,
    overflow: "hidden",
  },
  head: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: space.s3,
    paddingBlock: space.s3,
    paddingInline: space.s4,
  },
  main: { display: "flex", flexDirection: "column", gap: space.s1, flex: 1, minWidth: "12rem" },
  nameLine: { display: "flex", alignItems: "center", gap: space.s2, flexWrap: "wrap" },
  name: { fontSize: text.sm, fontWeight: weight.semibold },
  muted: { color: color.textMuted, fontSize: text.sm },
  meta: {
    display: "flex",
    alignItems: "center",
    gap: space.s1_5,
    color: color.textMuted,
    fontSize: text.sm,
  },
  url: {
    fontFamily: font.mono,
    fontSize: text.sm,
    color: color.textMuted,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    maxWidth: "100%",
  },
  installations: {
    margin: 0,
    padding: 0,
    listStyle: "none",
    borderTopWidth: "1px",
    borderTopStyle: "solid",
    borderTopColor: color.border,
  },
  installation: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: space.s3,
    paddingBlock: space.s2_5,
    paddingInline: space.s4,
    paddingInlineStart: space.s8,
    borderTopWidth: "1px",
    borderTopStyle: "solid",
    borderTopColor: color.border,
  },
  firstInstallation: { borderTopWidth: 0 },
  none: { paddingBlock: space.s2_5, paddingInline: space.s4, paddingInlineStart: space.s8 },
  repos: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: space.s1_5,
    color: color.textMuted,
    fontSize: text.sm,
  },
  link: {
    color: color.accentSubtleText,
    textDecoration: { default: "none", ":hover": "underline" },
    borderRadius: radius.sm,
  },
  mono: { fontFamily: font.mono },
  actions: { display: "flex", flexWrap: "wrap", gap: space.s2 },
  form: { display: "flex", flexDirection: "column", gap: space.s4 },
  secretValues: {
    display: "flex",
    flexWrap: "wrap",
    columnGap: space.s3,
    rowGap: space.s1,
    margin: 0,
    padding: 0,
    listStyle: "none",
  },
  section: { display: "flex", flexDirection: "column", gap: space.s3, margin: 0, padding: 0 },
  sectionHead: { display: "flex", flexDirection: "column", gap: space.s1 },
  sectionTitle: { margin: 0, fontSize: text.sm, fontWeight: weight.semibold },
  secret: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(10rem, 1fr)) auto",
    alignItems: "start",
    gap: space.s3,
    padding: space.s3,
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: color.border,
    borderRadius: radius.md,
  },
  remove: { alignSelf: "end" },
  clearedList: { margin: 0, paddingInlineStart: space.s4 },
  valueLine: { display: "inline-flex", alignItems: "center", gap: space.s2 },
  error: { color: color.dangerSubtleText, fontSize: text.sm, lineHeight: leading.snug },
  loading: { display: "grid", placeItems: "center", paddingBlock: space.s16 },
})

/** What a delete dialog asks about, and does once confirmed. */
interface Deleting {
  readonly name: string
  readonly description: string
  readonly run: () => Promise<unknown>
}

/** The Plugins page; `opening` names an Installation whose dialog opens once it loads (#216). */
export function PluginsView({ opening }: { opening?: string | undefined } = {}) {
  const hub = useHub()
  const state = useHubState((hubState) => hubState.plugins)
  const online = useHubState((hubState) => hubState.connection.status === "online")
  const [loadError, setLoadError] = useState<string | null>(null)
  const [editing, setEditing] = useState<Plugin | "new" | null>(null)
  const [installing, setInstalling] = useState<InstallationTarget | null>(null)
  const [deleting, setDeleting] = useState<Deleting | null>(null)
  const [packaging, setPackaging] = useState<PackageOpening | null>(null)
  const [opened, setOpened] = useState<string | null>(null)

  // Opened once for each Installation asked for, and only one the person can change.
  useEffect(() => {
    if (opening === undefined || opening === opened || state === null) return
    setOpened(opening)
    const installation = state.installations.find((one) => one.id === opening)
    const plugin = state.plugins.find((one) => one.id === installation?.pluginId)
    if (installation === undefined || plugin === undefined) return
    if (installation.otherRepos !== undefined) return
    setInstalling({ plugin, installation })
  }, [opening, opened, state])

  useEffect(() => {
    if (!online) return
    hub.getPlugins().then(
      () => setLoadError(null),
      (error: unknown) => setLoadError(messageOf(error)),
    )
  }, [hub, online])

  const add = (
    <div {...stylex.props(styles.actions)}>
      <Button size="sm" icon={<PlusIcon />} onClick={() => setPackaging({})}>
        Add package
      </Button>
      <Button intent="primary" size="sm" icon={<PlusIcon />} onClick={() => setEditing("new")}>
        Add Plugin
      </Button>
    </div>
  )
  return (
    <main {...stylex.props(styles.view)}>
      <PageHeader
        title="Plugins"
        description="Remote MCP servers the Hub adds to Sessions. An Installation puts one on in the Repos it lists: Claude Code in their Sessions gets its tools, through the Hub, from their next wake or Restart."
        actions={add}
      />
      <div {...stylex.props(styles.scroll)}>
        <div {...stylex.props(styles.page)}>
          {state === null ? (
            loadError ? (
              <EmptyState
                size="page"
                icon={<WarningIcon />}
                title="Can't load the Plugins"
                description={loadError}
              />
            ) : (
              <div {...stylex.props(styles.loading)}>
                <Spinner size="lg" label="Loading Plugins" />
              </div>
            )
          ) : state.plugins.length === 0 ? (
            <EmptyState
              size="page"
              icon={<PluginIcon />}
              title="No Plugins yet"
              description="Add a remote MCP server by its URL, or a Plugin package from git or an upload, then install it on the Repos whose Sessions should have its tools."
              action={add}
            />
          ) : (
            <ul aria-label="Plugins" {...stylex.props(styles.plugins)}>
              {state.plugins.map((plugin) => (
                <PluginCard
                  key={plugin.id}
                  plugin={plugin}
                  installations={state.installations.filter(
                    (installation) => installation.pluginId === plugin.id,
                  )}
                  onEdit={() => setEditing(plugin)}
                  onUpgrade={() => setPackaging({ upgrading: plugin })}
                  onInstall={(installation) => setInstalling({ plugin, installation })}
                  onDelete={setDeleting}
                />
              ))}
            </ul>
          )}
        </div>
      </div>
      <PluginDialog
        editing={editing}
        installations={state?.installations ?? []}
        onClose={() => setEditing(null)}
      />
      <InstallationDialog target={installing} onClose={() => setInstalling(null)} />
      <DeleteDialog deleting={deleting} onClose={() => setDeleting(null)} />
      <PackageDialog opening={packaging} onClose={() => setPackaging(null)} />
    </main>
  )
}

function PluginCard({
  plugin,
  installations,
  onEdit,
  onUpgrade,
  onInstall,
  onDelete,
}: {
  plugin: Plugin
  installations: ReadonlyArray<Installation>
  onEdit: () => void
  onUpgrade: () => void
  onInstall: (installation: Installation | null) => void
  onDelete: (deleting: Deleting) => void
}) {
  const hub = useHub()
  // Editing or upgrading a Plugin changes what the Sessions of every Repo it is on in run with.
  const hidden = installations.some((installation) => installation.otherRepos !== undefined)
  const pinned = plugin.package
  return (
    <li aria-label={`Plugin ${plugin.name}`} {...stylex.props(styles.card)}>
      <div {...stylex.props(styles.head)}>
        <div {...stylex.props(styles.main)}>
          <div {...stylex.props(styles.nameLine)}>
            <span {...stylex.props(styles.name)}>{plugin.name}</span>
            <Badge sx={styles.mono}>{plugin.id}</Badge>
            {pinned && <Badge sx={styles.mono}>{packageVersion(pinned)}</Badge>}
          </div>
          {plugin.description && <span {...stylex.props(styles.muted)}>{plugin.description}</span>}
          <span title={plugin.url} {...stylex.props(styles.url)}>
            {plugin.url}
          </span>
          {pinned && <span {...stylex.props(styles.muted)}>{sourceText(pinned.source)}</span>}
          <span {...stylex.props(styles.meta)}>
            <Avatar name={plugin.createdBy.name} src={plugin.createdBy.avatarUrl} size="sm" />
            Added by {plugin.createdBy.name} {timeAgo(plugin.createdAt)}
          </span>
        </div>
        <div {...stylex.props(styles.actions)}>
          <Button
            size="sm"
            icon={<PlusIcon />}
            aria-label={`Add Installation of ${plugin.name}`}
            onClick={() => onInstall(null)}
          >
            Install
          </Button>
          {pinned ? (
            <Button
              size="sm"
              aria-label={`Upgrade Plugin ${plugin.name}`}
              disabled={hidden}
              onClick={onUpgrade}
            >
              Upgrade
            </Button>
          ) : (
            <Button
              size="sm"
              aria-label={`Edit Plugin ${plugin.name}`}
              disabled={hidden}
              onClick={onEdit}
            >
              Edit
            </Button>
          )}
          <Button
            size="sm"
            intent="ghost"
            aria-label={`Delete Plugin ${plugin.name}`}
            onClick={() =>
              onDelete({
                name: plugin.name,
                description:
                  installations.length > 0
                    ? "The Hub refuses to delete a Plugin while it has Installations."
                    : "It has no Installations. It can't be brought back.",
                run: () => hub.deletePlugin(plugin.id),
              })
            }
          >
            Delete
          </Button>
        </div>
      </div>
      <ul aria-label={`Installations of ${plugin.name}`} {...stylex.props(styles.installations)}>
        {installations.length === 0 ? (
          <li {...stylex.props(styles.none, styles.muted)}>
            No Installations: install it to put it on in Repos.
          </li>
        ) : (
          installations.map((installation, index) => (
            <InstallationRow
              key={installation.id}
              plugin={plugin}
              installation={installation}
              first={index === 0}
              onEdit={() => onInstall(installation)}
              onDelete={() =>
                onDelete({
                  name: installation.name,
                  description: `Takes it off ${reposText(installation)}. Their Sessions lose its tools at once, and show that a Restart applies the change.`,
                  run: () => hub.deleteInstallation(installation.id),
                })
              }
            />
          ))
        )}
      </ul>
    </li>
  )
}

function InstallationRow({
  plugin,
  installation,
  first,
  onEdit,
  onDelete,
}: {
  plugin: Plugin
  installation: Installation
  first: boolean
  onEdit: () => void
  onDelete: () => void
}) {
  // Changing it needs access to every Repo it is on in, which the Hub doesn't name.
  const hidden = installation.otherRepos !== undefined
  return (
    <li
      aria-label={`Installation ${installation.name}`}
      {...stylex.props(styles.installation, first && styles.firstInstallation)}
    >
      <div {...stylex.props(styles.main)}>
        <span {...stylex.props(styles.name)}>{installation.name}</span>
        <div {...stylex.props(styles.repos)}>
          <span>On in</span>
          {installation.repos.map((repo, index) => (
            <span key={repo}>
              <Link
                to="/repos/$owner/$repo/environment"
                params={repoParams(repo)}
                {...stylex.props(styles.link, focus.ring)}
              >
                {repo}
              </Link>
              {index < installation.repos.length - 1 && ","}
            </span>
          ))}
          {hidden && (
            <span>
              {installation.repos.length > 0 && "and "}
              {installation.otherRepos} {installation.otherRepos === 1 ? "Repo" : "Repos"} you have
              no access to
            </span>
          )}
        </div>
        <SecretValues plugin={plugin} installation={installation} />
      </div>
      <div {...stylex.props(styles.actions)}>
        <Button
          size="sm"
          aria-label={`Edit Installation ${installation.name}`}
          disabled={hidden}
          onClick={onEdit}
        >
          Edit
        </Button>
        <Button
          size="sm"
          intent="ghost"
          aria-label={`Delete Installation ${installation.name}`}
          disabled={hidden}
          onClick={onDelete}
        >
          Delete
        </Button>
      </div>
    </li>
  )
}

/** Each header secret of an Installation's Plugin: who set its value and when, or that it needs one. */
function SecretValues({ plugin, installation }: { plugin: Plugin; installation: Installation }) {
  const declared = headerSecretsOf(plugin.auth)
  if (declared.length === 0) return null
  return (
    <ul
      aria-label={`Header secrets of ${installation.name}`}
      {...stylex.props(styles.secretValues)}
    >
      {declared.map((secret) => {
        const set = installation.values.find((value) => value.key === secret.key)
        return (
          <li key={secret.key} {...stylex.props(styles.meta)}>
            <span>{secret.title}</span>
            {set === undefined ? (
              <Badge intent="danger">needs a value</Badge>
            ) : (
              <span title={new Date(set.setAt).toLocaleString()}>
                set by {set.setBy.name} {timeAgo(set.setAt)}
              </span>
            )}
          </li>
        )
      })}
    </ul>
  )
}

/** A header secret as the Plugin dialog edits it. */
interface SecretRow {
  readonly id: number
  readonly key: string
  readonly title: string
  readonly header: string
  readonly template: string
  /** Whether its key was typed, or was saved: until then it follows the title. */
  readonly keyTyped: boolean
}

let secretRows = 0

const rowOf = (secret: HeaderSecret): SecretRow => ({
  id: ++secretRows,
  ...secret,
  keyTyped: true,
})

const authOf = (rows: ReadonlyArray<SecretRow>): PluginAuth =>
  rows.length === 0
    ? { _tag: "None" }
    : {
        _tag: "Headers",
        headers: rows.map(({ key, title, header, template }) => ({
          key,
          title: title.trim(),
          header: header.trim(),
          template,
        })),
      }

/** Adds a Hub-only Plugin, or edits one's name, URL and header secrets. */
function PluginDialog({
  editing,
  installations,
  onClose,
}: {
  editing: Plugin | "new" | null
  installations: ReadonlyArray<Installation>
  onClose: () => void
}) {
  const hub = useHub()
  const shown = useLastOpened(editing)
  const saved = shown === "new" ? null : shown
  const [name, setName] = useState("")
  const [url, setUrl] = useState("")
  const [rows, setRows] = useState<ReadonlyArray<SecretRow>>([])
  const [touched, setTouched] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (editing === null) return
    setName(saved?.name ?? "")
    setUrl(saved?.url ?? "")
    setRows(saved === null ? [] : headerSecretsOf(saved.auth).map(rowOf))
    setTouched(false)
    setBusy(false)
    setError(null)
  }, [editing, saved])

  const nameProblem = pluginNameProblem(name)
  const urlProblem =
    url.trim() === "" ? "Enter the MCP server's URL." : pluginUrlProblem(url.trim())
  const auth = authOf(rows)
  const authProblem = pluginAuthProblem(auth)
  // What saving clears, said before it does.
  const cleared =
    saved === null || urlProblem !== undefined
      ? []
      : clearedValues(
          saved,
          installations.filter((installation) => installation.pluginId === saved.id),
          { url: url.trim(), auth },
        )

  const change = (id: number, edit: Partial<Omit<SecretRow, "id">>) =>
    setRows((current) =>
      current.map((row) => {
        if (row.id !== id) return row
        const next = { ...row, ...edit }
        return edit.title !== undefined && !row.keyTyped
          ? { ...next, key: keyFromTitle(edit.title) }
          : next
      }),
    )
  const addSecret = () =>
    setRows((current) => [
      ...current,
      {
        id: ++secretRows,
        key: "",
        title: "",
        header: "Authorization",
        template: `Bearer ${ValuePlaceholder}`,
        keyTyped: false,
      },
    ])

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setTouched(true)
    if (nameProblem !== undefined || urlProblem !== undefined || authProblem !== undefined) return
    setBusy(true)
    setError(null)
    try {
      if (saved === null) await hub.createPlugin(name.trim(), url.trim(), auth)
      else await hub.editPlugin(saved.id, name.trim(), url.trim(), auth)
      toast.show({ title: saved === null ? `Added ${name.trim()}` : `Saved ${name.trim()}` })
      onClose()
    } catch (cause) {
      setError(messageOf(cause))
      setBusy(false)
    }
  }

  return (
    <Dialog
      open={editing !== null}
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
      title={saved === null ? "Add Plugin" : `Edit ${saved.name}`}
      description={
        saved === null
          ? "A remote MCP server, over Streamable HTTP. Only the Hub reaches it: Sessions reach it through the Hub."
          : "The Hub sends its Sessions' requests to the new URL, with the header secrets as declared, at once; they show a new name from their next wake or Restart."
      }
      footer={
        <>
          <DialogClose>Cancel</DialogClose>
          <Button
            intent={cleared.length > 0 ? "danger" : "primary"}
            type="submit"
            form="plugin"
            loading={busy}
          >
            {saved === null ? "Add" : cleared.length > 0 ? "Save and clear values" : "Save"}
          </Button>
        </>
      }
    >
      <form id="plugin" onSubmit={submit} noValidate {...stylex.props(styles.form)}>
        <Field
          label="Name"
          invalid={touched && nameProblem !== undefined}
          error={touched ? nameProblem : undefined}
        >
          <Input
            value={name}
            onValueChange={(next: string) => setName(next)}
            placeholder="Docs search"
            autoFocus
          />
        </Field>
        <Field
          label="MCP server URL"
          invalid={touched && urlProblem !== undefined}
          error={touched ? urlProblem : undefined}
        >
          <Input
            value={url}
            onValueChange={(next: string) => setUrl(next)}
            placeholder="https://mcp.example.com/mcp"
            spellCheck={false}
            autoCapitalize="off"
            sx={styles.mono}
          />
        </Field>
        <fieldset aria-label="Header secrets" {...stylex.props(styles.section)}>
          <div {...stylex.props(styles.sectionHead)}>
            <h3 {...stylex.props(styles.sectionTitle)}>Header secrets</h3>
            <p {...stylex.props(styles.muted)}>
              For a server that takes a key in a header. Each Installation enters its own value,
              which only the Hub holds: it adds the header to every request it sends this server.
            </p>
          </div>
          {rows.map((row, index) => (
            <div
              key={row.id}
              aria-label={`Header secret ${index + 1}`}
              {...stylex.props(styles.secret)}
            >
              <Field label="Title">
                <Input
                  size="sm"
                  value={row.title}
                  onValueChange={(title: string) => change(row.id, { title })}
                  placeholder="API key"
                />
              </Field>
              <Field label="Header">
                <Input
                  size="sm"
                  value={row.header}
                  onValueChange={(header: string) => change(row.id, { header })}
                  spellCheck={false}
                  autoCapitalize="off"
                  sx={styles.mono}
                />
              </Field>
              <Field label="Value template" description={`${ValuePlaceholder} is the value.`}>
                <Input
                  size="sm"
                  value={row.template}
                  onValueChange={(template: string) => change(row.id, { template })}
                  spellCheck={false}
                  autoCapitalize="off"
                  sx={styles.mono}
                />
              </Field>
              <Field label="Key" description="Names its values.">
                <Input
                  size="sm"
                  value={row.key}
                  onValueChange={(key: string) => change(row.id, { key, keyTyped: true })}
                  placeholder="api_key"
                  spellCheck={false}
                  autoCapitalize="off"
                  sx={styles.mono}
                />
              </Field>
              <IconButton
                label={`Remove ${row.title.trim() === "" ? `header secret ${index + 1}` : row.title.trim()}`}
                size="sm"
                sx={styles.remove}
                onClick={() => setRows((current) => current.filter((one) => one.id !== row.id))}
              >
                <TrashIcon />
              </IconButton>
            </div>
          ))}
          {touched && authProblem !== undefined && (
            <p role="alert" {...stylex.props(styles.error)}>
              {authProblem}
            </p>
          )}
          <div>
            <Button
              size="sm"
              icon={<PlusIcon />}
              disabled={rows.length >= MaxHeaderSecrets}
              onClick={addSecret}
            >
              Add header secret
            </Button>
          </div>
        </fieldset>
        {cleared.length > 0 && <ClearedBanner cleared={cleared} />}
        {error && (
          <p role="alert" {...stylex.props(styles.error)}>
            {error}
          </p>
        )}
      </form>
    </Dialog>
  )
}

/** Says whose header secret values saving clears, before it does. */
function ClearedBanner({ cleared }: { cleared: ReadonlyArray<ClearedValues> }) {
  return (
    <Banner
      intent="warning"
      icon={<WarningIcon />}
      title="Saving clears header secret values"
      detail={
        <ul {...stylex.props(styles.clearedList)}>
          {cleared.map(({ installation, secrets }) => (
            <li key={installation}>
              {installation}: {andList(secrets)}
            </li>
          ))}
        </ul>
      }
    >
      They were entered for the server and header as they are, so they don't go anywhere else. Each
      needs a value again: until it gets one, the Hub refuses its Sessions' requests to this server.
    </Banner>
  )
}

/** A Plugin to install, or one of its Installations to edit. */
interface InstallationTarget {
  readonly plugin: Plugin
  readonly installation: Installation | null
}

/** The Repos typed, one per line or separated by commas or spaces. */
const reposOf = (typed: string) => typed.split(/[\s,]+/).filter((repo) => repo !== "")

/**
 * Creates an Installation of a Plugin on Repos, or renames one, changes its Repos, and replaces
 * values of its header secrets; a value left empty stays as it is.
 */
function InstallationDialog({
  target,
  onClose,
}: {
  target: InstallationTarget | null
  onClose: () => void
}) {
  const hub = useHub()
  const shown = useLastOpened(target)
  const saved = shown?.installation ?? null
  const [name, setName] = useState("")
  const [repos, setRepos] = useState("")
  const [values, setValues] = useState<Readonly<Record<string, string>>>({})
  const [touched, setTouched] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (target === null) return
    setName(target.installation?.name ?? target.plugin.name)
    setRepos(target.installation?.repos.join("\n") ?? "")
    setValues({})
    setTouched(false)
    setBusy(false)
    setError(null)
  }, [target])

  const listed = reposOf(repos)
  const nameProblem = pluginNameProblem(name, "An Installation")
  const malformed = listed.find((repo) => !repoPattern.test(repo))
  const reposProblem =
    malformed !== undefined
      ? `${malformed} isn't a Repo: enter each as owner/name.`
      : installationReposProblem(listed)
  const declared = shown === null ? [] : headerSecretsOf(shown.plugin.auth)
  const typed = (secret: HeaderSecret) => values[secret.key] ?? ""
  const valueProblem = (secret: HeaderSecret) =>
    typed(secret) === "" ? undefined : headerValueProblem(secret.title, typed(secret))
  const valuesProblem = declared.some((secret) => valueProblem(secret) !== undefined)

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setTouched(true)
    if (shown === null || nameProblem !== undefined || reposProblem !== undefined) return
    if (valuesProblem) return
    setBusy(true)
    setError(null)
    const entered: ReadonlyArray<HeaderValueInput> = declared
      .filter((secret) => typed(secret) !== "")
      .map((secret) => ({ key: secret.key, value: Redacted.make(typed(secret)) }))
    try {
      if (saved === null) {
        await hub.createInstallation(shown.plugin.id, name.trim(), listed, entered)
      } else await hub.editInstallation(saved.id, name.trim(), listed, entered)
      toast.show({ title: saved === null ? `Installed ${name.trim()}` : `Saved ${name.trim()}` })
      onClose()
    } catch (cause) {
      setError(messageOf(cause))
      setBusy(false)
    }
  }

  return (
    <Dialog
      open={target !== null}
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
      title={
        saved === null ? `Add an Installation of ${shown?.plugin.name ?? ""}` : `Edit ${saved.name}`
      }
      description={`Claude Code in each listed Repo's Sessions gets its tools from their next wake or Restart. A Repo has at most one Installation of each Plugin, and you need access to every Repo listed.${declared.length > 0 ? " Header secret values are write-only: once saved, no one sees them again." : ""}`}
      footer={
        <>
          <DialogClose>Cancel</DialogClose>
          <Button intent="primary" type="submit" form="installation" loading={busy}>
            {saved === null ? "Add" : "Save"}
          </Button>
        </>
      }
    >
      <form id="installation" onSubmit={submit} noValidate {...stylex.props(styles.form)}>
        <Field
          label="Name"
          description="Claude Code names its MCP server after it."
          invalid={touched && nameProblem !== undefined}
          error={touched ? nameProblem : undefined}
        >
          <Input value={name} onValueChange={(next: string) => setName(next)} />
        </Field>
        <Field
          label="Repos"
          description="One per line, as owner/name."
          invalid={touched && reposProblem !== undefined}
          error={touched ? reposProblem : undefined}
        >
          <Textarea
            value={repos}
            onValueChange={(next: string) => setRepos(next)}
            placeholder="kddige/kndl"
            rows={4}
            autoFocus
            sx={styles.mono}
          />
        </Field>
        {declared.map((secret) => {
          const set = saved?.values.find((value) => value.key === secret.key)
          const problem = valueProblem(secret)
          return (
            <Field
              key={secret.key}
              label={
                <span {...stylex.props(styles.valueLine)}>
                  {secret.title}
                  {saved !== null && typed(secret) === "" && set !== undefined && (
                    <Badge intent="success">set</Badge>
                  )}
                  {typed(secret) === "" && set === undefined && (
                    <Badge intent="danger">needs a value</Badge>
                  )}
                </span>
              }
              description={`Sent as ${secret.header}: ${secret.template}`}
              invalid={touched && problem !== undefined}
              error={touched ? problem : undefined}
            >
              <Input
                type="password"
                value={typed(secret)}
                onValueChange={(value: string) =>
                  setValues((current) => ({ ...current, [secret.key]: value }))
                }
                placeholder={
                  set === undefined
                    ? "Enter a value"
                    : `Set by ${set.setBy.name} ${timeAgo(set.setAt)}: type to replace it`
                }
                autoComplete="off"
                sx={styles.mono}
              />
            </Field>
          )
        })}
        {error && (
          <p role="alert" {...stylex.props(styles.error)}>
            {error}
          </p>
        )}
      </form>
    </Dialog>
  )
}

/** Deletes a Plugin or an Installation once confirmed; shows the Hub's refusal, if any. */
function DeleteDialog({ deleting, onClose }: { deleting: Deleting | null; onClose: () => void }) {
  const shown = useLastOpened(deleting)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    setBusy(false)
    setError(null)
  }, [deleting])

  const remove = async () => {
    if (!deleting) return
    setBusy(true)
    setError(null)
    try {
      await deleting.run()
      toast.show({ title: `Deleted ${deleting.name}` })
      onClose()
    } catch (cause) {
      setError(messageOf(cause))
      setBusy(false)
    }
  }

  return (
    <Dialog
      size="sm"
      open={deleting !== null}
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
      title={`Delete ${shown?.name ?? ""}?`}
      description={shown?.description}
      footer={
        <>
          <DialogClose>Cancel</DialogClose>
          <Button intent="danger" loading={busy} onClick={() => void remove()}>
            Delete
          </Button>
        </>
      }
    >
      {error && (
        <p role="alert" {...stylex.props(styles.error)}>
          {error}
        </p>
      )}
    </Dialog>
  )
}

/** The Repos an Installation is on in, as a phrase. */
function reposText(installation: Installation): string {
  const { repos } = installation
  return repos.length === 1 ? (repos[0] ?? "") : `its ${repos.length} Repos`
}
