// The MCP page (ADR 0020): remote MCP servers the Hub adds to Sessions, each with the Installations
// that put it on in Repos. Any Member adds an MCP server; an Installation needs access to every
// Repo it lists, as a Session does, and a Repo has at most one Installation of each MCP server.
// Claude Code in a Session reaches each through the Hub's Gateway, so no MCP server's address or
// credential is ever in a Sandbox. A change applies to a Session at its next wake or Restart.
//
// An MCP server can declare header secrets (#215): a header, and a template its value goes in. Each
// Installation enters its own values, write-only: the page shows only who set each and when, or
// that it needs a value. Before an edit to the MCP server clears values (a URL on another server,
// or a header secret's key or header changed), the dialog says whose.
//
// A packaged MCP server (#220) is pinned to the version it was added at: only an Upgrade changes
// it, its name included, and it clears values as an edit does.
//
// The Owner can make an Installation global (#219): on in every Repo, listing none, but where a
// Repo-scoped one of its MCP server takes its place, or the Repo turned it off on its Repo page.
// Only the Owner creates, edits or deletes one, or edits, upgrades or deletes its MCP server; for
// anyone else, the page says so.
//
// An MCP server can use OAuth instead (#217): each Installation connects to one account, which
// every Session in its Repos then acts as. Connect sends the browser to the server's authorization
// server and back, through the Hub, to this page; the Hub alone holds the tokens. Moving the
// MCP server to another origin disconnects its Installations, and the dialog says so first. Only
// the Owner connects or disconnects a global one: every Session on the Hub acts as its account.

import {
  type HeaderSecret,
  type HeaderValueInput,
  headerSecretsOf,
  headerValueProblem,
  type Installation,
  installationReposProblem,
  MaxHeaderSecrets,
  packageVersion,
  type McpServer,
  type McpServerAuth,
  mcpServerAuthProblem,
  mcpServerNameProblem,
  mcpServerUrlProblem,
  mcpServerUrlUnencrypted,
  ValuePlaceholder,
  sourceText,
} from "@kndl/protocol"
import * as stylex from "@stylexjs/stylex"
import { Link, useNavigate } from "@tanstack/react-router"
import { Redacted } from "effect"
import { type FormEvent, useEffect, useState } from "react"
import { andList, counted, repoParams, timeAgo } from "../app/format.ts"
import { useHub, useHubState } from "../app/hub.tsx"
import { repoPattern } from "../app/repoAccess.tsx"
import {
  Badge,
  Banner,
  Button,
  Checkbox,
  Dialog,
  DialogClose,
  Field,
  IconButton,
  Input,
  Menu,
  MenuItem,
  MenuSeparator,
  MoreIcon,
  PlusIcon,
  Select,
  SettingsEmpty,
  SettingsItem,
  SettingsList,
  SettingsLoading,
  SettingsPage,
  SettingsRow,
  Textarea,
  toast,
  TrashIcon,
  WarningIcon,
  textRole,
} from "../ui/index.ts"
import { focus } from "../ui/shared.ts"
import { color, font, leading, radius, space, text } from "../ui/tokens.stylex.ts"
import {
  ClientLine,
  ConnectionLine,
  disconnected,
  DisconnectsBanner,
  useConnect,
} from "./connection.tsx"
import { type ClearedValues, clearedValues, keyFromTitle } from "./headerSecrets.ts"
import { McpServerAvatar } from "./McpServerAvatar.tsx"
import { PackageDialog, type PackageOpening } from "./PackageDialog.tsx"
import { messageOf, useLastOpened } from "./shared.ts"
import { UnencryptedCredentialsBanner, UnencryptedUrlBanner } from "./unencrypted.tsx"

const styles = stylex.create({
  // The MCP server's tile, at a row's icon size.
  avatar: { width: "1.25rem", height: "1.25rem", fontSize: text.xs, borderRadius: radius.sm },
  muted: { color: color.textSecondary, fontSize: text.sm },
  meta: {
    display: "flex",
    alignItems: "center",
    gap: space.s1_5,
    color: color.textSecondary,
    fontSize: text.sm,
  },
  url: {
    display: "inline-block",
    maxWidth: "100%",
    verticalAlign: "bottom",
    fontFamily: font.mono,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  repos: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    columnGap: space.s1_5,
  },
  link: {
    color: color.accentText,
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
  sectionTitle: { margin: 0 },
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
  error: { color: color.dangerText, fontSize: text.sm, lineHeight: leading.snug },
})

/** What a delete dialog asks about, and does once confirmed. */
interface Deleting {
  readonly name: string
  readonly description: string
  readonly run: () => Promise<unknown>
  /** What it does, when not deleting: Disconnect (#217). */
  readonly verb?: { readonly action: string; readonly done: string }
}

/** How connecting an Installation came out, as the Hub sends the browser back (#217). */
export interface ConnectReturn {
  readonly installation?: string | undefined
  readonly connected?: boolean | undefined
  readonly connectError?: string | undefined
}

/**
 * The MCP page; `opening` names an Installation whose dialog opens once it loads (#216), and
 * `returned` how connecting one came out (#217).
 */
export function McpServersView({
  opening,
  returned,
}: { opening?: string | undefined; returned?: ConnectReturn | undefined } = {}) {
  const hub = useHub()
  const navigate = useNavigate()
  const state = useHubState((hubState) => hubState.mcpServers)
  const owner = useHubState((hubState) => hubState.owner)
  const online = useHubState((hubState) => hubState.connection.status === "online")
  const [loadError, setLoadError] = useState<string | null>(null)
  const [editing, setEditing] = useState<McpServer | "new" | null>(null)
  const [installing, setInstalling] = useState<InstallationTarget | null>(null)
  const [deleting, setDeleting] = useState<Deleting | null>(null)
  const [packaging, setPackaging] = useState<PackageOpening | null>(null)
  const [opened, setOpened] = useState<string | null>(null)

  // Said once, then dropped from the address, so a reload doesn't say it again.
  useEffect(() => {
    if (returned === undefined || state === null) return
    const name =
      state.installations.find((one) => one.id === returned.installation)?.name ??
      "the Installation"
    if (returned.connectError !== undefined) {
      toast.show({
        title: `Couldn't connect ${name}`,
        description: returned.connectError,
        intent: "danger",
      })
    } else if (returned.connected === true) {
      toast.show({ title: `Connected ${name}` })
    }
    void navigate({ to: "/mcp", search: {}, replace: true })
  }, [returned, state, navigate])

  // Opened once for each Installation asked for, and only one the person can change.
  useEffect(() => {
    if (opening === undefined || opening === opened || state === null) return
    setOpened(opening)
    const installation = state.installations.find((one) => one.id === opening)
    const mcpServer = state.mcpServers.find((one) => one.id === installation?.mcpServerId)
    if (installation === undefined || mcpServer === undefined) return
    if (installation.otherRepos !== undefined || (installation.global === true && !owner)) return
    setInstalling({ mcpServer, installation })
  }, [opening, opened, state, owner])

  // Bumped by Try again, after a failed load.
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    if (!online) return
    hub.getMcpServers().then(
      () => setLoadError(null),
      (error: unknown) => setLoadError(messageOf(error)),
    )
  }, [hub, online, attempt])
  const retry = () => {
    setLoadError(null)
    setAttempt((n) => n + 1)
  }

  const add = (
    <>
      <Button intent="primary" size="sm" icon={<PlusIcon />} onClick={() => setEditing("new")}>
        Add MCP server
      </Button>
      <Menu
        align="end"
        trigger={
          <IconButton label="More ways to add an MCP server" size="sm">
            <MoreIcon />
          </IconButton>
        }
      >
        <MenuItem onClick={() => setPackaging({})}>Add package</MenuItem>
      </Menu>
    </>
  )
  return (
    <SettingsPage
      title="MCP servers"
      description="MCP servers whose tools Sessions can use."
      action={add}
    >
      {state === null ? (
        loadError ? (
          <Banner
            intent="danger"
            icon={<WarningIcon />}
            title="Couldn't load the MCP servers"
            action={
              <Button size="sm" onClick={retry}>
                Try again
              </Button>
            }
          >
            {loadError}
          </Banner>
        ) : (
          <SettingsLoading label="Loading MCP servers" />
        )
      ) : state.mcpServers.length === 0 ? (
        <SettingsEmpty
          title="No MCP servers yet"
          description="Add a remote MCP server by its URL, or a package from git or an upload, from the menu beside it. An Installation puts it on in Repos."
          action={
            <Button size="sm" icon={<PlusIcon />} onClick={() => setEditing("new")}>
              Add MCP server
            </Button>
          }
        />
      ) : (
        <SettingsList label="MCP servers">
          {state.mcpServers.map((mcpServer) => (
            <McpServerRow
              key={mcpServer.id}
              mcpServer={mcpServer}
              installations={state.installations.filter(
                (installation) => installation.mcpServerId === mcpServer.id,
              )}
              owner={owner}
              onEdit={() => setEditing(mcpServer)}
              onUpgrade={() => setPackaging({ upgrading: mcpServer })}
              onInstall={(installation) => setInstalling({ mcpServer, installation })}
              onDelete={setDeleting}
            />
          ))}
        </SettingsList>
      )}
      <McpServerDialog
        editing={editing}
        installations={state?.installations ?? []}
        onClose={() => setEditing(null)}
      />
      <InstallationDialog target={installing} owner={owner} onClose={() => setInstalling(null)} />
      <DeleteDialog deleting={deleting} onClose={() => setDeleting(null)} />
      <PackageDialog opening={packaging} onClose={() => setPackaging(null)} />
    </SettingsPage>
  )
}

/**
 * An MCP server, as a row: what it is and where, Install inline and the rest in its menu, and its
 * Installations under it, indented.
 */
function McpServerRow({
  mcpServer,
  installations,
  owner,
  onEdit,
  onUpgrade,
  onInstall,
  onDelete,
}: {
  mcpServer: McpServer
  installations: ReadonlyArray<Installation>
  owner: boolean
  onEdit: () => void
  onUpgrade: () => void
  onInstall: (installation: Installation | null) => void
  onDelete: (deleting: Deleting) => void
}) {
  const hub = useHub()
  const { connect, clientDialog } = useConnect()
  // Editing or upgrading an MCP server changes what the Sessions of every Repo it is on in run
  // with.
  const hidden = installations.some((installation) => installation.otherRepos !== undefined)
  // With a global Installation, that is every Repo's: only the Owner may (#219).
  const ownerOnly = !owner && installations.some((installation) => installation.global === true)
  const pinned = mcpServer.package
  const { name } = mcpServer
  return (
    <>
      <SettingsRow
        label={`MCP server ${name}`}
        icon={<McpServerAvatar mcpServer={mcpServer} sx={styles.avatar} />}
        name={name}
        meta={[
          <span key="id" {...stylex.props(styles.mono)}>
            {mcpServer.id}
          </span>,
          <span key="url" title={mcpServer.url} {...stylex.props(styles.url)}>
            {mcpServer.url}
          </span>,
          `Added by ${mcpServer.createdBy.name} ${timeAgo(mcpServer.createdAt)}`,
        ]}
        notes={
          <>
            {mcpServer.description && (
              <span {...stylex.props(styles.muted)}>{mcpServer.description}</span>
            )}
            {pinned && <span {...stylex.props(styles.muted)}>{sourceText(pinned.source)}</span>}
            {ownerOnly && (
              <span {...stylex.props(styles.muted)}>
                It has a global Installation, on in every Repo: only the Hub's Owner can{" "}
                {pinned ? "upgrade" : "edit"} or delete it.
              </span>
            )}
          </>
        }
        badges={
          (pinned || mcpServerUrlUnencrypted(mcpServer.url)) && (
            <>
              {pinned && <Badge sx={styles.mono}>{packageVersion(pinned)}</Badge>}
              {mcpServerUrlUnencrypted(mcpServer.url) && (
                <Badge intent="warning">Unencrypted http</Badge>
              )}
            </>
          )
        }
        action={
          <Button
            size="sm"
            icon={<PlusIcon />}
            aria-label={`Add Installation of ${name}`}
            onClick={() => onInstall(null)}
          >
            Install
          </Button>
        }
        menu={
          <>
            {pinned ? (
              <MenuItem disabled={hidden || ownerOnly} onClick={onUpgrade}>
                Upgrade {name}
              </MenuItem>
            ) : (
              <MenuItem disabled={hidden || ownerOnly} onClick={onEdit}>
                Edit {name}
              </MenuItem>
            )}
            <MenuSeparator />
            <MenuItem
              intent="danger"
              disabled={ownerOnly}
              onClick={() =>
                onDelete({
                  name,
                  description:
                    installations.length > 0
                      ? "The Hub refuses to delete an MCP server while it has Installations."
                      : "It has no Installations. It can't be brought back.",
                  run: () => hub.deleteMcpServer(mcpServer.id),
                })
              }
            >
              Delete {name}
            </MenuItem>
          </>
        }
        rowsLabel={`Installations of ${name}`}
        rows={
          installations.length === 0 ? (
            <SettingsItem>
              <span {...stylex.props(styles.muted)}>
                No Installations: install it to put it on in Repos.
              </span>
            </SettingsItem>
          ) : (
            installations.map((installation) => (
              <InstallationRow
                key={installation.id}
                mcpServer={mcpServer}
                installation={installation}
                owner={owner}
                onEdit={() => onInstall(installation)}
                onDelete={() =>
                  onDelete({
                    name: installation.name,
                    description: `Takes it off ${reposText(installation)}. Their Sessions lose its tools at once, and show that a Restart applies the change.`,
                    run: () => hub.deleteInstallation(installation.id),
                  })
                }
                onConnect={(changeClient) =>
                  connect(installation, { changeClient }).catch((error: unknown) =>
                    toast.show({
                      title: `Couldn't connect ${installation.name}`,
                      description: messageOf(error),
                      intent: "danger",
                    }),
                  )
                }
                onDisconnect={() =>
                  onDelete({
                    name: installation.name,
                    description: `The Hub forgets its tokens. Sessions in ${reposText(installation)} lose its tools at once, and new ones don't start until it is connected again.`,
                    run: () => hub.disconnectInstallation(installation.id),
                    verb: { action: "Disconnect", done: "Disconnected" },
                  })
                }
              />
            ))
          )
        }
      />
      {clientDialog}
    </>
  )
}

/** Links to each Repo, separated by commas. */
function RepoLinks({ repos }: { repos: ReadonlyArray<string> }) {
  return repos.map((repo, index) => (
    <span key={repo}>
      <Link
        to="/repos/$owner/$repo/environment"
        params={repoParams(repo)}
        {...stylex.props(styles.link, focus.ring)}
      >
        {repo}
      </Link>
      {index < repos.length - 1 && ","}
    </span>
  ))
}

function InstallationRow({
  mcpServer,
  installation,
  owner,
  onEdit,
  onDelete,
  onConnect,
  onDisconnect,
}: {
  mcpServer: McpServer
  installation: Installation
  owner: boolean
  onEdit: () => void
  onDelete: () => void
  /** Connects it; with `changeClient`, asking for another client entered by hand (#218). */
  onConnect: (changeClient: boolean) => void
  onDisconnect: () => void
}) {
  // Changing it needs access to every Repo it is on in, which the Hub doesn't name. So does
  // connecting it: its account acts in each.
  const hidden = installation.otherRepos !== undefined
  // A global one is on in every Repo: only the Owner changes it (#219), or connects it (#217).
  const global = installation.global === true
  const ownerOnly = global && !owner
  const off = installation.off ?? []
  const oauth = mcpServer.auth._tag === "OAuth"
  const connected = installation.connection !== undefined
  const locked = hidden || ownerOnly
  const { name } = installation
  return (
    <SettingsRow
      label={`Installation ${name}`}
      name={name}
      meta={
        global ? (
          <span {...stylex.props(styles.repos)}>
            <span>
              On in every Repo, but where another Installation of {mcpServer.name} is on
              {off.length > 0 ? "; turned off for" : "."}
            </span>
            {off.length > 0 && <RepoLinks repos={off} />}
          </span>
        ) : (
          <span {...stylex.props(styles.repos)}>
            <span>On in</span>
            <RepoLinks repos={installation.repos} />
            {hidden && (
              <span>
                {installation.repos.length > 0 && "and "}
                {counted(installation.otherRepos, { one: "Repo", other: "Repos" })} you have no
                access to
              </span>
            )}
          </span>
        )
      }
      notes={
        <>
          <SecretValues mcpServer={mcpServer} installation={installation} />
          {ownerOnly && (
            <span {...stylex.props(styles.muted)}>
              Only the Hub's Owner can{" "}
              {oauth ? "edit, delete, connect or disconnect" : "edit or delete"} it. Turn it off for
              a Repo on the Repo's page.
            </span>
          )}
          <ConnectionLine mcpServer={mcpServer} installation={installation} />
          {oauth && <ClientLine installation={installation} />}
        </>
      }
      badges={global && <Badge>Global</Badge>}
      action={
        oauth &&
        !connected && (
          <Button
            size="sm"
            intent="primary"
            aria-label={`Connect ${name}`}
            disabled={locked}
            onClick={() => onConnect(false)}
          >
            Connect
          </Button>
        )
      }
      menu={
        <>
          {oauth && connected && (
            <MenuItem disabled={locked} onClick={() => onConnect(false)}>
              Reconnect {name}
            </MenuItem>
          )}
          {oauth && installation.client !== undefined && (
            <MenuItem disabled={locked} onClick={() => onConnect(true)}>
              Change {name}'s client
            </MenuItem>
          )}
          <MenuItem disabled={locked} onClick={onEdit}>
            Edit {name}
          </MenuItem>
          <MenuSeparator />
          {oauth && connected && (
            <MenuItem intent="danger" disabled={locked} onClick={onDisconnect}>
              Disconnect {name}
            </MenuItem>
          )}
          <MenuItem intent="danger" disabled={locked} onClick={onDelete}>
            Delete {name}
          </MenuItem>
        </>
      }
    />
  )
}

/**
 * Each header secret of an Installation's MCP server: who set its value and when, or that it needs
 * one.
 */
function SecretValues({
  mcpServer,
  installation,
}: {
  mcpServer: McpServer
  installation: Installation
}) {
  const declared = headerSecretsOf(mcpServer.auth)
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

/** A header secret as the MCP server dialog edits it. */
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

/** How an MCP server takes credentials, as the dialog chooses it. */
type AuthKind = "Headers" | "OAuth"

/** The scopes typed, separated by spaces or commas. */
const scopesOf = (typed: string) => typed.split(/[\s,]+/).filter((scope) => scope !== "")

const authOf = (kind: AuthKind, rows: ReadonlyArray<SecretRow>, scopes: string): McpServerAuth => {
  if (kind === "OAuth") {
    const listed = scopesOf(scopes)
    return listed.length === 0 ? { _tag: "OAuth" } : { _tag: "OAuth", scopes: listed }
  }
  return rows.length === 0
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
}

/** Adds a Hub-only MCP server, or edits one's name, URL and header secrets. */
function McpServerDialog({
  editing,
  installations,
  onClose,
}: {
  editing: McpServer | "new" | null
  installations: ReadonlyArray<Installation>
  onClose: () => void
}) {
  const hub = useHub()
  const shown = useLastOpened(editing)
  const saved = shown === "new" ? null : shown
  const [name, setName] = useState("")
  const [url, setUrl] = useState("")
  const [rows, setRows] = useState<ReadonlyArray<SecretRow>>([])
  const [kind, setKind] = useState<AuthKind>("Headers")
  const [scopes, setScopes] = useState("")
  const [touched, setTouched] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (editing === null) return
    setName(saved?.name ?? "")
    setUrl(saved?.url ?? "")
    setRows(saved === null ? [] : headerSecretsOf(saved.auth).map(rowOf))
    setKind(saved?.auth._tag === "OAuth" ? "OAuth" : "Headers")
    setScopes(saved?.auth._tag === "OAuth" ? (saved.auth.scopes ?? []).join(" ") : "")
    setTouched(false)
    setBusy(false)
    setError(null)
  }, [editing, saved])

  const nameProblem = mcpServerNameProblem(name)
  const urlProblem =
    url.trim() === "" ? "Enter the MCP server's URL." : mcpServerUrlProblem(url.trim())
  const auth = authOf(kind, rows, scopes)
  const authProblem = mcpServerAuthProblem(auth)
  // What saving clears, said before it does.
  const cleared =
    saved === null || urlProblem !== undefined
      ? []
      : clearedValues(
          saved,
          installations.filter((installation) => installation.mcpServerId === saved.id),
          { url: url.trim(), auth },
        )
  const disconnects =
    saved === null || urlProblem !== undefined
      ? []
      : disconnected(saved, installations, { url: url.trim(), auth })
  const destructive = cleared.length > 0 || disconnects.length > 0

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
      if (saved === null) await hub.createMcpServer(name.trim(), url.trim(), auth)
      else await hub.editMcpServer(saved.id, name.trim(), url.trim(), auth)
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
      title={saved === null ? "Add MCP server" : `Edit ${saved.name}`}
      description={
        saved === null
          ? "A remote MCP server, over Streamable HTTP. Only the Hub reaches it: Sessions reach it through the Hub."
          : "The Hub sends its Sessions' requests to the new URL, with the header secrets as declared, at once; they show a new name from their next wake or restart."
      }
      footer={
        <>
          <DialogClose>Cancel</DialogClose>
          <Button
            intent={destructive ? "danger" : "primary"}
            type="submit"
            form="mcpServer"
            loading={busy}
          >
            {saved === null
              ? "Add"
              : disconnects.length > 0
                ? "Save and disconnect"
                : cleared.length > 0
                  ? "Save and clear values"
                  : "Save"}
          </Button>
        </>
      }
    >
      <form id="mcpServer" onSubmit={submit} noValidate {...stylex.props(styles.form)}>
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
        <UnencryptedUrlBanner url={url.trim()} />
        <Field
          label="Sign-in"
          description={
            kind === "OAuth"
              ? "Each Installation connects to one account, through the server's authorization server. Where that offers no dynamic client registration, connecting asks for a client registered there by hand. Only the Hub holds the tokens and the client."
              : "None, or a key each Installation enters, sent in a header."
          }
        >
          <Select<AuthKind>
            options={[
              { value: "Headers", label: "None or header secrets" },
              { value: "OAuth", label: "OAuth" },
            ]}
            value={kind}
            onValueChange={setKind}
          />
        </Field>
        {kind === "OAuth" ? (
          <Field
            label="Scopes"
            description="Optional, separated by spaces: else those the server asks for."
            invalid={touched && authProblem !== undefined}
            error={touched ? authProblem : undefined}
          >
            <Input
              value={scopes}
              onValueChange={(next: string) => setScopes(next)}
              placeholder="read write"
              spellCheck={false}
              autoCapitalize="off"
              sx={styles.mono}
            />
          </Field>
        ) : (
          <fieldset aria-label="Header secrets" {...stylex.props(styles.section)}>
            <div {...stylex.props(styles.sectionHead)}>
              <h3 {...stylex.props(textRole.subheading, styles.sectionTitle)}>Header secrets</h3>
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
        )}
        {cleared.length > 0 && <ClearedBanner cleared={cleared} />}
        <DisconnectsBanner names={disconnects} verb="Saving" />
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

/** An MCP server to install, or one of its Installations to edit. */
interface InstallationTarget {
  readonly mcpServer: McpServer
  readonly installation: Installation | null
}

/** The Repos typed, one per line or separated by commas or spaces. */
const reposOf = (typed: string) => typed.split(/[\s,]+/).filter((repo) => repo !== "")

/**
 * Creates an Installation of an MCP server on Repos, or renames one, changes its Repos, and
 * replaces values of its header secrets; a value left empty stays as it is. The Owner can make it
 * global (#219), on in every Repo, instead.
 */
function InstallationDialog({
  target,
  owner,
  onClose,
}: {
  target: InstallationTarget | null
  owner: boolean
  onClose: () => void
}) {
  const hub = useHub()
  const shown = useLastOpened(target)
  const saved = shown?.installation ?? null
  const [name, setName] = useState("")
  const [global, setGlobal] = useState(false)
  const [repos, setRepos] = useState("")
  const [values, setValues] = useState<Readonly<Record<string, string>>>({})
  const [touched, setTouched] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (target === null) return
    setName(target.installation?.name ?? target.mcpServer.name)
    setGlobal(target.installation?.global === true)
    setRepos(target.installation?.repos.join("\n") ?? "")
    setValues({})
    setTouched(false)
    setBusy(false)
    setConnecting(false)
    setError(null)
  }, [target])

  const connectSaved = async () => {
    if (saved === null) return
    setConnecting(true)
    setError(null)
    try {
      await connect(saved)
    } catch (cause) {
      setError(messageOf(cause))
    }
    // Still here while a client is asked for (#218), or after a refusal.
    setConnecting(false)
  }

  // A global one lists no Repos.
  const listed = global ? [] : reposOf(repos)
  const nameProblem = mcpServerNameProblem(name, "An Installation")
  const malformed = listed.find((repo) => !repoPattern.test(repo))
  const reposProblem = global
    ? undefined
    : malformed !== undefined
      ? `${malformed} isn't a Repo: enter each as owner/name.`
      : installationReposProblem(listed)
  const { connect, clientDialog } = useConnect()
  const [connecting, setConnecting] = useState(false)
  const declared = shown === null ? [] : headerSecretsOf(shown.mcpServer.auth)
  // An Installation saved can be connected from here too, as a Session's banner sends people; a
  // global one only by the Owner (#219).
  const connectable =
    shown?.mcpServer.auth._tag === "OAuth" &&
    saved !== null &&
    saved.otherRepos === undefined &&
    (saved.global !== true || owner)
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
        await hub.createInstallation(shown.mcpServer.id, name.trim(), listed, entered, global)
      } else await hub.editInstallation(saved.id, name.trim(), listed, entered, global)
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
        saved === null
          ? `Add an Installation of ${shown?.mcpServer.name ?? ""}`
          : `Edit ${saved.name}`
      }
      description={`Each listed Repo's Sessions get its tools from their next wake or restart. A Repo has at most one Installation of each MCP server, and you need access to every Repo listed.${owner ? " A global one is on in every Repo but those with their own Installation of the MCP server, or that turned it off." : ""}${declared.length > 0 ? " Header secret values are write-only: once saved, no one sees them again." : ""}${shown?.mcpServer.auth._tag === "OAuth" ? " Once added, connect it to the account its Sessions act as." : ""}`}
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
        {owner && (
          <Checkbox
            label="Global"
            description="On in every Repo, now and to come, for every Sandbox on the Hub. A Repo can turn it off; one with its own Installation of the MCP server has that instead. Only the Owner can change it."
            checked={global}
            onCheckedChange={setGlobal}
          />
        )}
        {!global && (
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
        )}
        {shown !== null && <UnencryptedCredentialsBanner mcpServer={shown.mcpServer} />}
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
        {connectable && shown !== null && (
          <div {...stylex.props(styles.section)}>
            <ConnectionLine mcpServer={shown.mcpServer} installation={saved} />
            <ClientLine installation={saved} />
            <div>
              <Button size="sm" loading={connecting} onClick={() => void connectSaved()}>
                {saved.connection === undefined ? "Connect" : "Reconnect"}
              </Button>
            </div>
          </div>
        )}
        {error && (
          <p role="alert" {...stylex.props(styles.error)}>
            {error}
          </p>
        )}
      </form>
      {clientDialog}
    </Dialog>
  )
}

/** Deletes an MCP server or an Installation once confirmed; shows the Hub's refusal, if any. */
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
      toast.show({ title: `${deleting.verb?.done ?? "Deleted"} ${deleting.name}` })
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
      title={`${shown?.verb?.action ?? "Delete"} ${shown?.name ?? ""}?`}
      description={shown?.description}
      footer={
        <>
          <DialogClose>Cancel</DialogClose>
          <Button intent="danger" loading={busy} onClick={() => void remove()}>
            {shown?.verb?.action ?? "Delete"}
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
  if (installation.global === true) return "every Repo"
  const { repos } = installation
  return repos.length === 1 ? (repos[0] ?? "") : `its ${repos.length} Repos`
}
