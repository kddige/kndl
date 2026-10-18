// Adding a packaged MCP server (#220), or upgrading one: the Hub reads a package, a `package.json`
// and a `kndl.json` beside it, from a public git repo or an upload, and changes nothing until the
// person has seen what it read and confirms. An Upgrade shows what it changes first; the Hub
// applies exactly what was shown, and refuses if the MCP server changed in between. An Upgrade
// clears header secret values as an edit does (a URL on another server, or a secret's key or header
// changed), and says whose first.

import {
  addedHeaderSecrets,
  authText,
  gitRefProblem,
  gitUrlProblem,
  MaxMcpServerArchiveBytes,
  MaxMcpServerPackageFileBytes,
  packageChanges,
  type PackageChange,
  packagePathProblem,
  packageVersion,
  type McpServer,
  McpServerManifestFile,
  type McpServerPackageFrom,
  type McpServerPackageRead,
  sourceText,
} from "@kndl/protocol"
import * as stylex from "@stylexjs/stylex"
import { type ChangeEvent, type FormEvent, Fragment, useEffect, useState } from "react"
import { andList } from "../app/format.ts"
import { useHub, useHubState } from "../app/hub.tsx"
import {
  Banner,
  Button,
  Dialog,
  DialogClose,
  Field,
  Input,
  Spinner,
  Tab,
  TabList,
  TabPanel,
  Tabs,
  toast,
  WarningIcon,
} from "../ui/index.ts"
import { color, font, leading, radius, space, text, weight } from "../ui/tokens.stylex.ts"
import { disconnected, DisconnectsBanner } from "./connection.tsx"
import { clearedValues } from "./headerSecrets.ts"
import { messageOf, useLastOpened } from "./shared.ts"
import { UnencryptedUrlBanner } from "./unencrypted.tsx"

const styles = stylex.create({
  form: { display: "flex", flexDirection: "column", gap: space.s4 },
  panel: { display: "flex", flexDirection: "column", gap: space.s4, paddingTop: space.s4 },
  mono: { fontFamily: font.mono },
  muted: { color: color.textSecondary, fontSize: text.sm, lineHeight: leading.snug, margin: 0 },
  error: {
    color: color.dangerText,
    fontSize: text.sm,
    lineHeight: leading.snug,
    whiteSpace: "pre-line",
    margin: 0,
  },
  upload: { display: "flex", flexDirection: "column", gap: space.s1_5 },
  label: { fontSize: text.sm, fontWeight: weight.medium },
  file: { fontSize: text.sm, color: color.textSecondary },
  chosen: { fontSize: text.sm, lineHeight: leading.snug, margin: 0 },
  clearedList: { margin: 0, paddingInlineStart: space.s4 },
  reading: { display: "grid", placeItems: "center", paddingBlock: space.s8 },
  facts: {
    display: "grid",
    gridTemplateColumns: "max-content minmax(0, 1fr)",
    columnGap: space.s4,
    rowGap: space.s2,
    margin: 0,
    fontSize: text.sm,
    lineHeight: leading.snug,
  },
  term: { color: color.textSecondary },
  fact: { margin: 0, overflowWrap: "anywhere" },
  changes: {
    width: "100%",
    borderCollapse: "collapse",
    fontSize: text.sm,
    lineHeight: leading.snug,
  },
  cell: {
    textAlign: "start",
    verticalAlign: "top",
    paddingBlock: space.s1_5,
    paddingInlineEnd: space.s3,
    borderBottomWidth: "1px",
    borderBottomStyle: "solid",
    borderBottomColor: color.border,
    overflowWrap: "anywhere",
  },
  head: { color: color.textSecondary, fontWeight: weight.medium },
  before: { color: color.textSecondary, textDecoration: "line-through" },
  scroll: { overflowX: "auto", borderRadius: radius.md },
})

/** Opens the dialog to add a package, or to upgrade a packaged MCP server. */
export interface PackageOpening {
  readonly upgrading?: McpServer
}

/** A file the person chose, to read as the package; or why it can't be. */
type Chosen =
  | { readonly from: McpServerPackageFrom; readonly label: string }
  | { readonly problem: string }

const archive = /\.(?:tgz|tar\.gz|zip)$/i

/** An archive's bytes, as base64, a chunk at a time so no call gets too many arguments. */
function base64(bytes: Uint8Array): string {
  let binary = ""
  for (let at = 0; at < bytes.length; at += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000))
  }
  return btoa(binary)
}

/**
 * What the person chose, as the Hub reads it: one `.tgz` or `.zip` archive, or a package's folder,
 * of which only the `package.json` and manifest at its top are sent.
 */
async function choose(files: ReadonlyArray<File>): Promise<Chosen> {
  const [first] = files
  if (first === undefined) return { problem: "Choose a package's folder or archive." }
  if (files.length === 1 && archive.test(first.name)) {
    if (first.size > MaxMcpServerArchiveBytes) {
      return {
        problem: `${first.name} is larger than ${MaxMcpServerArchiveBytes / 1024 / 1024} MiB.`,
      }
    }
    const data = base64(new Uint8Array(await first.arrayBuffer()))
    return { from: { _tag: "Archive", fileName: first.name, data }, label: first.name }
  }
  // A folder's files are named from it, as `linear/package.json`; picked files, by name alone.
  const top = (name: string) =>
    files.find((file) => {
      const path = file.webkitRelativePath || file.name
      const parts = path.split("/")
      return parts.length <= 2 && parts.at(-1) === name
    })
  const packageJson = top("package.json")
  const manifest = top(McpServerManifestFile)
  if (packageJson === undefined || manifest === undefined) {
    return {
      problem: `A package's folder has a package.json and a ${McpServerManifestFile} at its top.`,
    }
  }
  const large = [packageJson, manifest].find((file) => file.size > MaxMcpServerPackageFileBytes)
  if (large !== undefined) {
    return { problem: `${large.name} is larger than ${MaxMcpServerPackageFileBytes / 1024} KiB.` }
  }
  const folderName = packageJson.webkitRelativePath.split("/")[0] || "package"
  return {
    from: {
      _tag: "Folder",
      folderName,
      packageJson: await packageJson.text(),
      manifest: await manifest.text(),
    },
    label: `${folderName}: package.json and ${McpServerManifestFile}`,
  }
}

/**
 * Reads a package, from git or an upload, and adds it, or upgrades the MCP server from the same
 * source to it, once the person confirms what was read. Upgrading an MCP server from git reads its
 * ref again.
 */
export function PackageDialog({
  opening,
  onClose,
}: {
  opening: PackageOpening | null
  onClose: () => void
}) {
  const hub = useHub()
  const mcpServers = useHubState((state) => state.mcpServers?.mcpServers)
  const installations = useHubState((state) => state.mcpServers?.installations) ?? []
  const shown = useLastOpened(opening)
  const upgrading = shown?.upgrading
  const fromGit = upgrading?.package?.source._tag === "Git"
  const [tab, setTab] = useState("git")
  const [url, setUrl] = useState("")
  const [ref, setRef] = useState("")
  const [path, setPath] = useState("")
  const [chosen, setChosen] = useState<Chosen | null>(null)
  const [touched, setTouched] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [answer, setAnswer] = useState<McpServerPackageRead | null>(null)

  useEffect(() => {
    if (opening === null) return
    setTab(opening.upgrading ? "upload" : "git")
    setUrl("")
    setRef("")
    setPath("")
    setChosen(null)
    setTouched(false)
    setError(null)
    setAnswer(null)
    const mcpServer = opening.upgrading
    if (mcpServer?.package?.source._tag !== "Git") {
      setBusy(false)
      return
    }
    // An MCP server from git is upgraded from its ref: read it again at once. Only this opening's
    // answer counts; a closed or reopened dialog ignores it.
    let current = true
    setBusy(true)
    hub.checkMcpServerUpgrade(mcpServer.id).then(
      (read) => {
        if (!current) return
        setAnswer(read)
        setBusy(false)
      },
      (cause: unknown) => {
        if (!current) return
        setError(messageOf(cause))
        setBusy(false)
      },
    )
    return () => {
      current = false
    }
  }, [hub, opening])

  const urlProblem = url.trim() === "" ? "Enter the git repo's URL." : gitUrlProblem(url.trim())
  const refProblem = ref.trim() === "" ? undefined : gitRefProblem(ref.trim())
  const pathProblem = path.trim() === "" ? undefined : packagePathProblem(path.trim())
  const uploadProblem =
    chosen === null
      ? "Choose a package's folder or archive."
      : "problem" in chosen
        ? chosen.problem
        : undefined

  const read = async (event: FormEvent) => {
    event.preventDefault()
    setTouched(true)
    let from: McpServerPackageFrom
    if (tab === "git") {
      if (urlProblem !== undefined || refProblem !== undefined || pathProblem !== undefined) return
      from = {
        _tag: "Git",
        url: url.trim(),
        ...(ref.trim() !== "" && { ref: ref.trim() }),
        ...(path.trim() !== "" && { path: path.trim() }),
      }
    } else {
      if (chosen === null || "problem" in chosen) return
      from = chosen.from
    }
    setBusy(true)
    setError(null)
    try {
      setAnswer(await hub.readMcpServerPackage(from))
    } catch (cause) {
      setError(messageOf(cause))
    } finally {
      setBusy(false)
    }
  }

  const current =
    answer?.upgrades === undefined
      ? undefined
      : mcpServers?.find((mcpServer) => mcpServer.id === answer.upgrades)
  const changes = answer && current ? packageChanges(current, answer.read) : []
  const upToDate = answer?.upgrades !== undefined && changes.length === 0

  const confirm = async () => {
    if (answer === null) return
    setBusy(true)
    setError(null)
    try {
      if (answer.upgrades === undefined) {
        await hub.addMcpServerPackage(answer.readId)
        toast.show({ title: `Added ${answer.read.name}` })
      } else {
        await hub.upgradeMcpServer(answer.upgrades, answer.readId)
        toast.show({
          title: `Upgraded ${answer.read.name} to ${packageVersion(answer.read.package)}`,
          description: "Its Sessions pick it up on their next wake or restart.",
        })
      }
      onClose()
    } catch (cause) {
      setError(messageOf(cause))
      setBusy(false)
    }
  }

  const chooseFiles = (event: ChangeEvent<HTMLInputElement>) => {
    const files = [...(event.currentTarget.files ?? [])]
    setError(null)
    void choose(files).then(setChosen)
  }

  const title = upgrading ? `Upgrade ${upgrading.name}` : "Add an MCP server package"
  const description = upgrading
    ? fromGit
      ? `Reads ${upgrading.package ? sourceText(upgrading.package.source) : "its source"} again. Nothing changes until you confirm.`
      : "It was uploaded: upload its new version. Nothing changes until you confirm."
    : "A package.json and a kndl.json beside it, from a public git repo or an upload. The Hub only reads them: nothing in the package runs. Nothing is added until you confirm."

  const action =
    answer === null ? (
      fromGit ? null : (
        <Button intent="primary" type="submit" form="mcpServer-package" loading={busy}>
          Read package
        </Button>
      )
    ) : upToDate ? null : (
      <Button intent="primary" loading={busy} onClick={() => void confirm()}>
        {answer.upgrades === undefined ? "Add" : "Upgrade"}
      </Button>
    )

  return (
    <Dialog
      open={opening !== null}
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
      title={title}
      description={description}
      footer={
        <>
          {answer !== null && !fromGit && (
            <Button intent="ghost" onClick={() => setAnswer(null)}>
              Back
            </Button>
          )}
          <DialogClose>{upToDate ? "Close" : "Cancel"}</DialogClose>
          {action}
        </>
      }
    >
      {answer !== null ? (
        <div {...stylex.props(styles.form)}>
          {upToDate ? (
            <p {...stylex.props(styles.muted)}>
              {answer.read.name} is up to date: {packageVersion(answer.read.package)}.
            </p>
          ) : (
            <>
              <PackageFacts read={answer} />
              <UnencryptedUrlBanner url={answer.read.url} />
              {current && <Changes changes={changes} />}
              {current && <AddedSecrets mcpServer={current} read={answer} />}
              {current && <ClearedSecrets mcpServer={current} read={answer} />}
              {current && (
                <DisconnectsBanner
                  names={disconnected(current, installations, answer.read)}
                  verb="Upgrading"
                />
              )}
            </>
          )}
          {error && (
            <p role="alert" {...stylex.props(styles.error)}>
              {error}
            </p>
          )}
        </div>
      ) : fromGit ? (
        error ? (
          <p role="alert" {...stylex.props(styles.error)}>
            {error}
          </p>
        ) : (
          <div {...stylex.props(styles.reading)}>
            <Spinner size="lg" label="Reading the package" />
          </div>
        )
      ) : (
        <form id="mcpServer-package" onSubmit={read} noValidate {...stylex.props(styles.form)}>
          <Tabs value={tab} onValueChange={setTab}>
            {!upgrading && (
              <TabList label="Where the package is">
                <Tab value="git">From git</Tab>
                <Tab value="upload">Upload</Tab>
              </TabList>
            )}
            <TabPanel value="git" sx={styles.panel}>
              <Field
                label="Git repo URL"
                description="A public repo, over https."
                invalid={touched && urlProblem !== undefined}
                error={touched ? urlProblem : undefined}
              >
                <Input
                  value={url}
                  onValueChange={(next: string) => setUrl(next)}
                  placeholder="https://github.com/acme/linear-mcp"
                  spellCheck={false}
                  autoCapitalize="off"
                  sx={styles.mono}
                />
              </Field>
              <Field
                label="Ref"
                description="A branch, tag or commit; the default branch if empty. Upgrades read it again."
                invalid={touched && refProblem !== undefined}
                error={touched ? refProblem : undefined}
              >
                <Input
                  value={ref}
                  onValueChange={(next: string) => setRef(next)}
                  placeholder="main"
                  spellCheck={false}
                  autoCapitalize="off"
                  sx={styles.mono}
                />
              </Field>
              <Field
                label="Folder"
                description="Where the package is in the repo; its root if empty."
                invalid={touched && pathProblem !== undefined}
                error={touched ? pathProblem : undefined}
              >
                <Input
                  value={path}
                  onValueChange={(next: string) => setPath(next)}
                  placeholder="packages/linear"
                  spellCheck={false}
                  autoCapitalize="off"
                  sx={styles.mono}
                />
              </Field>
            </TabPanel>
            <TabPanel value="upload" sx={styles.panel}>
              <label {...stylex.props(styles.upload)}>
                <span {...stylex.props(styles.label)}>The package&apos;s folder</span>
                <input
                  type="file"
                  aria-label="The package's folder"
                  ref={(input) => input?.setAttribute("webkitdirectory", "")}
                  onChange={chooseFiles}
                  {...stylex.props(styles.file)}
                />
              </label>
              <label {...stylex.props(styles.upload)}>
                <span {...stylex.props(styles.label)}>Or an archive of it</span>
                <input
                  type="file"
                  aria-label="An archive of the package"
                  accept=".tgz,.tar.gz,.zip"
                  onChange={chooseFiles}
                  {...stylex.props(styles.file)}
                />
              </label>
              <p {...stylex.props(styles.muted)}>
                A .tgz, as npm pack makes, or a .zip, of at most{" "}
                {MaxMcpServerArchiveBytes / 1024 / 1024} MiB. Only its package.json and{" "}
                {McpServerManifestFile} are read.
              </p>
              {chosen && "label" in chosen && (
                <p {...stylex.props(styles.chosen)}>Chosen: {chosen.label}</p>
              )}
              {touched && uploadProblem !== undefined && (
                <p {...stylex.props(styles.error)}>{uploadProblem}</p>
              )}
            </TabPanel>
          </Tabs>
          {error && (
            <p role="alert" {...stylex.props(styles.error)}>
              {error}
            </p>
          )}
        </form>
      )}
    </Dialog>
  )
}

/** What the Hub read: the MCP server the package makes. */
function PackageFacts({ read: { read } }: { read: McpServerPackageRead }) {
  const facts: Array<[string, string]> = [
    ["Name", read.name],
    ["Package", read.id],
    ["Version", packageVersion(read.package)],
    ["Source", sourceText(read.package.source)],
    ["MCP server URL", read.url],
    ["Auth", authText(read.auth)],
    ...(read.description !== undefined
      ? [["Description", read.description] as [string, string]]
      : []),
  ]
  return (
    <dl aria-label="The package" {...stylex.props(styles.facts)}>
      {facts.map(([term, fact]) => (
        <Fragment key={term}>
          <dt {...stylex.props(styles.term)}>{term}</dt>
          <dd {...stylex.props(styles.fact, term === "MCP server URL" && styles.mono)}>{fact}</dd>
        </Fragment>
      ))}
    </dl>
  )
}

/** What an Upgrade changes, before and after. */
function Changes({ changes }: { changes: ReadonlyArray<PackageChange> }) {
  return (
    <div {...stylex.props(styles.scroll)}>
      <table aria-label="What upgrading changes" {...stylex.props(styles.changes)}>
        <thead>
          <tr>
            <th scope="col" {...stylex.props(styles.cell, styles.head)}>
              Changes
            </th>
            <th scope="col" {...stylex.props(styles.cell, styles.head)}>
              Now
            </th>
            <th scope="col" {...stylex.props(styles.cell, styles.head)}>
              After
            </th>
          </tr>
        </thead>
        <tbody>
          {changes.map((change) => (
            <tr key={change.what}>
              <th scope="row" {...stylex.props(styles.cell, styles.head)}>
                {change.what}
              </th>
              <td {...stylex.props(styles.cell, styles.before)}>{change.before || "None"}</td>
              <td {...stylex.props(styles.cell)}>{change.after || "None"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/** A warning when an Upgrade asks for header secrets the MCP server didn't before. */
function AddedSecrets({ mcpServer, read }: { mcpServer: McpServer; read: McpServerPackageRead }) {
  const added = addedHeaderSecrets(mcpServer.auth, read.read.auth)
  if (added.length === 0) return null
  return (
    <Banner intent="warning" icon={<WarningIcon />} title="It asks for new header secrets">
      {added.map(({ title }) => title).join(", ")}: each Installation needs a value for{" "}
      {added.length === 1 ? "it" : "them"}, or its Sessions reach the MCP server without.
    </Banner>
  )
}

/** A warning naming the header secret values an Upgrade clears, as an edit would, before it does. */
function ClearedSecrets({ mcpServer, read }: { mcpServer: McpServer; read: McpServerPackageRead }) {
  const installations = useHubState((state) => state.mcpServers?.installations) ?? []
  const cleared = clearedValues(
    mcpServer,
    installations.filter((installation) => installation.mcpServerId === mcpServer.id),
    read.read,
  )
  if (cleared.length === 0) return null
  return (
    <Banner
      intent="warning"
      icon={<WarningIcon />}
      title="Upgrading clears header secret values"
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
