// The Plugins (ADR 0020): remote MCP servers the Hub adds to Sessions, each with the Installations
// that put it on in Repos. Any Member adds a Plugin; an Installation needs access to every Repo it
// lists, as a Session does, and a Repo has at most one Installation of each Plugin. Claude Code in
// a Session reaches each through the Hub's Gateway, so no Plugin's address or credential is ever
// in a Sandbox. A change applies to a Session at its next wake or Restart.

import {
  type Installation,
  installationReposProblem,
  type Plugin,
  pluginNameProblem,
  pluginUrlProblem,
} from "@kndl/protocol"
import * as stylex from "@stylexjs/stylex"
import { Link } from "@tanstack/react-router"
import { type FormEvent, useEffect, useState } from "react"
import { repoParams, timeAgo } from "../app/format.ts"
import { useHub, useHubState } from "../app/hub.tsx"
import { repoPattern } from "../app/repoAccess.tsx"
import {
  Avatar,
  Badge,
  Button,
  Dialog,
  DialogClose,
  EmptyState,
  Field,
  Input,
  PageHeader,
  PluginIcon,
  PlusIcon,
  Spinner,
  Textarea,
  toast,
  WarningIcon,
} from "../ui/index.ts"
import { focus } from "../ui/shared.ts"
import { color, font, leading, radius, space, text, weight } from "../ui/tokens.stylex.ts"

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
  error: { color: color.dangerSubtleText, fontSize: text.sm, lineHeight: leading.snug },
  loading: { display: "grid", placeItems: "center", paddingBlock: space.s16 },
})

/** What a delete dialog asks about, and does once confirmed. */
interface Deleting {
  readonly name: string
  readonly description: string
  readonly run: () => Promise<unknown>
}

export function PluginsView() {
  const hub = useHub()
  const state = useHubState((hubState) => hubState.plugins)
  const online = useHubState((hubState) => hubState.connection.status === "online")
  const [loadError, setLoadError] = useState<string | null>(null)
  const [editing, setEditing] = useState<Plugin | "new" | null>(null)
  const [installing, setInstalling] = useState<InstallationTarget | null>(null)
  const [deleting, setDeleting] = useState<Deleting | null>(null)

  useEffect(() => {
    if (!online) return
    hub.getPlugins().then(
      () => setLoadError(null),
      (error: unknown) => setLoadError(messageOf(error)),
    )
  }, [hub, online])

  const add = (
    <Button intent="primary" size="sm" icon={<PlusIcon />} onClick={() => setEditing("new")}>
      Add Plugin
    </Button>
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
              description="Add a remote MCP server by its URL, then install it on the Repos whose Sessions should have its tools."
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
                  onInstall={(installation) => setInstalling({ plugin, installation })}
                  onDelete={setDeleting}
                />
              ))}
            </ul>
          )}
        </div>
      </div>
      <PluginDialog editing={editing} onClose={() => setEditing(null)} />
      <InstallationDialog target={installing} onClose={() => setInstalling(null)} />
      <DeleteDialog deleting={deleting} onClose={() => setDeleting(null)} />
    </main>
  )
}

function PluginCard({
  plugin,
  installations,
  onEdit,
  onInstall,
  onDelete,
}: {
  plugin: Plugin
  installations: ReadonlyArray<Installation>
  onEdit: () => void
  onInstall: (installation: Installation | null) => void
  onDelete: (deleting: Deleting) => void
}) {
  const hub = useHub()
  // Editing a Plugin changes what the Sessions of every Repo it is on in run with.
  const hidden = installations.some((installation) => installation.otherRepos !== undefined)
  return (
    <li aria-label={`Plugin ${plugin.name}`} {...stylex.props(styles.card)}>
      <div {...stylex.props(styles.head)}>
        <div {...stylex.props(styles.main)}>
          <div {...stylex.props(styles.nameLine)}>
            <span {...stylex.props(styles.name)}>{plugin.name}</span>
            <Badge sx={styles.mono}>{plugin.id}</Badge>
          </div>
          <span title={plugin.url} {...stylex.props(styles.url)}>
            {plugin.url}
          </span>
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
          <Button
            size="sm"
            aria-label={`Edit Plugin ${plugin.name}`}
            disabled={hidden}
            onClick={onEdit}
          >
            Edit
          </Button>
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
  installation,
  first,
  onEdit,
  onDelete,
}: {
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

/** Adds a Hub-only Plugin, or edits one's name and URL. */
function PluginDialog({
  editing,
  onClose,
}: {
  editing: Plugin | "new" | null
  onClose: () => void
}) {
  const hub = useHub()
  const shown = useLastOpened(editing)
  const saved = shown === "new" ? null : shown
  const [name, setName] = useState("")
  const [url, setUrl] = useState("")
  const [touched, setTouched] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (editing === null) return
    setName(saved?.name ?? "")
    setUrl(saved?.url ?? "")
    setTouched(false)
    setBusy(false)
    setError(null)
  }, [editing, saved])

  const nameProblem = pluginNameProblem(name)
  const urlProblem =
    url.trim() === "" ? "Enter the MCP server's URL." : pluginUrlProblem(url.trim())

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setTouched(true)
    if (nameProblem !== undefined || urlProblem !== undefined) return
    setBusy(true)
    setError(null)
    try {
      if (saved === null) await hub.createPlugin(name.trim(), url.trim())
      else await hub.editPlugin(saved.id, name.trim(), url.trim())
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
          ? "A remote MCP server, over Streamable HTTP, that needs no sign-in. Only the Hub reaches it: Sessions reach it through the Hub."
          : "The Hub sends its Sessions' requests to the new URL at once; they show a new name from their next wake or Restart."
      }
      footer={
        <>
          <DialogClose>Cancel</DialogClose>
          <Button intent="primary" type="submit" form="plugin" loading={busy}>
            {saved === null ? "Add" : "Save"}
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
        {error && (
          <p role="alert" {...stylex.props(styles.error)}>
            {error}
          </p>
        )}
      </form>
    </Dialog>
  )
}

/** A Plugin to install, or one of its Installations to edit. */
interface InstallationTarget {
  readonly plugin: Plugin
  readonly installation: Installation | null
}

/** The Repos typed, one per line or separated by commas or spaces. */
const reposOf = (typed: string) => typed.split(/[\s,]+/).filter((repo) => repo !== "")

/** Creates an Installation of a Plugin on Repos, or renames one and changes its Repos. */
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
  const [touched, setTouched] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (target === null) return
    setName(target.installation?.name ?? target.plugin.name)
    setRepos(target.installation?.repos.join("\n") ?? "")
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

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setTouched(true)
    if (shown === null || nameProblem !== undefined || reposProblem !== undefined) return
    setBusy(true)
    setError(null)
    try {
      if (saved === null) await hub.createInstallation(shown.plugin.id, name.trim(), listed)
      else await hub.editInstallation(saved.id, name.trim(), listed)
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
      description="Claude Code in each listed Repo's Sessions gets its tools from their next wake or Restart. A Repo has at most one Installation of each Plugin, and you need access to every Repo listed."
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

/** `value`, or while it is null (a dialog closing), the last value it wasn't. */
function useLastOpened<T>(value: T | null): T | null {
  const [last, setLast] = useState(value)
  if (value !== null && value !== last) setLast(value)
  return value ?? last
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
