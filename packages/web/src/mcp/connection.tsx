// An OAuth Installation's account (#217), as the MCP page and a Session's banner show it. The
// Hub connects it: Connect sends the browser to the server's authorization server to sign in and
// consent, which sends it back through the Hub to the MCP page. The tokens stay on the Hub, so
// the page shows only whose account it is, who connected it and when, or that it needs connecting.
// The account is shared: every Session in the Installation's Repos acts as it.
//
// An authorization server without Dynamic Client Registration (#218) can't be given a client by
// the Hub: Connect asks for one registered there by hand instead, showing the callback URL to
// register it with, and connects with it. The Hub keeps the client with the tokens; the page sees
// only its ID, whether it has a secret, and who entered it when. Change client asks for another.

import {
  clearsConnections,
  type Installation,
  type InstallationNeedsClient,
  oauthClientProblem,
  type McpServer,
  type McpServerAuth,
} from "@kndl/protocol"
import * as stylex from "@stylexjs/stylex"
import { useRouter } from "@tanstack/react-router"
import { type FormEvent, type ReactNode, useEffect, useState } from "react"
import { andList, timeAgo } from "../app/format.ts"
import { useHub } from "../app/hub.tsx"
import {
  Badge,
  Banner,
  Button,
  CopyIcon,
  Dialog,
  DialogClose,
  Field,
  IconButton,
  Input,
  toast,
  WarningIcon,
} from "../ui/index.ts"
import { color, font, leading, radius, space, text } from "../ui/tokens.stylex.ts"
import { messageOf, useLastOpened } from "./shared.ts"

const styles = stylex.create({
  line: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: space.s1_5,
    color: color.textSecondary,
    fontSize: text.sm,
  },
  mono: { fontFamily: font.mono },
  form: { display: "flex", flexDirection: "column", gap: space.s4 },
  callback: {
    display: "flex",
    alignItems: "flex-start",
    gap: space.s2,
    paddingBlock: space.s2,
    paddingInlineStart: space.s3,
    paddingInlineEnd: space.s1,
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: color.border,
    borderRadius: radius.md,
    backgroundColor: color.surfaceMuted,
  },
  callbackText: {
    flex: 1,
    minWidth: 0,
    paddingBlock: space.s1,
    fontFamily: font.mono,
    fontSize: text.sm,
    lineHeight: leading.snug,
    overflowWrap: "anywhere",
    userSelect: "all",
  },
  callbackField: { display: "flex", flexDirection: "column", gap: space.s1_5 },
  label: { fontSize: text.base, color: color.text },
  error: { margin: 0, color: color.dangerText, fontSize: text.sm, lineHeight: leading.snug },
})

/** An Installation whose authorization server asked for a client entered by hand (#218). */
interface NeedingClient {
  readonly installation: Installation
  readonly needs: InstallationNeedsClient
}

/** How to connect an Installation, and the dialog asking for a client, to render with it. */
export interface Connecting {
  /**
   * Begins connecting an Installation: sends the browser to its authorization server, or, where
   * that offers no Dynamic Client Registration, asks for a client first. With `changeClient`, asks
   * for another client. The fake Hub has no authorization server, and sends the browser straight
   * back within the web UI.
   */
  readonly connect: (
    installation: Installation,
    options?: { readonly changeClient?: boolean },
  ) => Promise<void>
  /** The dialog asking for a client, while one is asked for. */
  readonly clientDialog: ReactNode
}

export function useConnect(): Connecting {
  const hub = useHub()
  const router = useRouter()
  const [needing, setNeeding] = useState<NeedingClient | null>(null)
  const go = (url: string) => {
    if (url.startsWith("/")) router.history.push(url)
    else window.location.assign(url)
  }
  const connect: Connecting["connect"] = async (installation, options = {}) => {
    const answer = await hub.connectInstallation(installation.id, options)
    if (answer._tag === "InstallationNeedsClient") setNeeding({ installation, needs: answer })
    else go(answer.url)
  }
  return {
    connect,
    clientDialog: (
      <ClientDialog
        needing={needing}
        onClose={() => setNeeding(null)}
        onConnect={async (installation, client) => {
          const answer = await hub.connectInstallation(installation.id, { client })
          if (answer._tag === "InstallationNeedsClient") {
            setNeeding({ installation, needs: answer })
            return
          }
          setNeeding(null)
          go(answer.url)
        }}
      />
    ),
  }
}

/**
 * Asks for the client registered by hand with an authorization server that offers no Dynamic
 * Client Registration (#218), and shows the callback URL to register it with. The secret is
 * write-only: the Hub keeps it encrypted, and never shows it again.
 */
function ClientDialog({
  needing,
  onClose,
  onConnect,
}: {
  needing: NeedingClient | null
  onClose: () => void
  onConnect: (
    installation: Installation,
    client: { readonly clientId: string; readonly clientSecret?: string },
  ) => Promise<void>
}) {
  const shown = useLastOpened(needing)
  const [clientId, setClientId] = useState("")
  const [clientSecret, setClientSecret] = useState("")
  const [touched, setTouched] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (needing === null) return
    setClientId("")
    setClientSecret("")
    setTouched(false)
    setBusy(false)
    setError(null)
  }, [needing])

  const publicClient = shown?.needs.publicClient === true
  const secret = clientSecret === "" ? undefined : clientSecret
  const idProblem = oauthClientProblem(clientId.trim())
  const secretProblem =
    secret !== undefined
      ? oauthClientProblem("id", secret)
      : publicClient
        ? undefined
        : "Enter the client secret: the authorization server takes no public client."

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setTouched(true)
    if (shown === null || idProblem !== undefined || secretProblem !== undefined) return
    setBusy(true)
    setError(null)
    try {
      await onConnect(shown.installation, {
        clientId: clientId.trim(),
        ...(secret !== undefined && { clientSecret: secret }),
      })
    } catch (cause) {
      setError(messageOf(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      open={needing !== null}
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
      title={`Enter a client for ${shown?.installation.name ?? "the Installation"}`}
      description={`The authorization server ${shown?.needs.issuer ?? ""} doesn't register clients itself, so the Hub needs one registered there by hand. Register an OAuth app with this callback URL, and enter its client ID${publicClient ? ", and its secret if it has one" : " and secret"}. The secret is write-only: the Hub keeps it, and no one sees it again.`}
      footer={
        <>
          <DialogClose>Cancel</DialogClose>
          <Button intent="primary" type="submit" form="oauth-client" loading={busy}>
            Connect
          </Button>
        </>
      }
    >
      <form id="oauth-client" onSubmit={submit} noValidate {...stylex.props(styles.form)}>
        {shown?.needs.reason !== undefined && (
          <Banner intent="warning" icon={<WarningIcon />} title="A client is needed again">
            {shown.needs.reason}
          </Banner>
        )}
        <div {...stylex.props(styles.callbackField)}>
          <span {...stylex.props(styles.label)}>Callback URL</span>
          <div {...stylex.props(styles.callback)}>
            <code aria-label="Callback URL" {...stylex.props(styles.callbackText)}>
              {shown?.needs.callbackUrl}
            </code>
            <IconButton
              label="Copy the callback URL"
              size="sm"
              onClick={() => void copyCallback(shown?.needs.callbackUrl ?? "")}
            >
              <CopyIcon />
            </IconButton>
          </div>
        </div>
        <Field
          label="Client ID"
          invalid={touched && idProblem !== undefined}
          error={touched ? idProblem : undefined}
        >
          <Input
            value={clientId}
            onValueChange={(next: string) => setClientId(next)}
            autoComplete="off"
            spellCheck={false}
            autoCapitalize="off"
            autoFocus
            sx={styles.mono}
          />
        </Field>
        <Field
          label={publicClient ? "Client secret (optional)" : "Client secret"}
          description={
            publicClient
              ? "Leave it empty for a public client, which has none."
              : "Generated for the client where you registered it."
          }
          invalid={touched && secretProblem !== undefined}
          error={touched ? secretProblem : undefined}
        >
          <Input
            type="password"
            value={clientSecret}
            onValueChange={(next: string) => setClientSecret(next)}
            autoComplete="off"
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

/** Copies the callback URL to register a client with, and says whether it could. */
async function copyCallback(url: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(url)
    toast.show({ title: "Callback URL copied" })
  } catch {
    toast.show({
      title: "Couldn't copy",
      description: "Select the callback URL and copy it yourself.",
      intent: "warning",
    })
  }
}

/** The client entered by hand for an OAuth Installation (#218): its ID, and who entered it when. */
export function ClientLine({ installation }: { installation: Installation }) {
  const { client } = installation
  if (client === undefined) return null
  return (
    <div aria-label={`Client of ${installation.name}`} {...stylex.props(styles.line)}>
      <span>Client</span>
      <Badge sx={styles.mono}>{client.clientId}</Badge>
      <span title={new Date(client.setAt).toLocaleString()}>
        {client.secret ? "with a secret" : "public, without a secret"}, entered by{" "}
        {client.setBy.name} {timeAgo(client.setAt)}
      </span>
    </div>
  )
}

/** An OAuth Installation's account: whose, who connected it and when, or why it needs connecting. */
export function ConnectionLine({
  mcpServer,
  installation,
}: {
  mcpServer: McpServer
  installation: Installation
}) {
  if (mcpServer.auth._tag !== "OAuth") return null
  const { connection } = installation
  return (
    <div aria-label={`Account of ${installation.name}`} {...stylex.props(styles.line)}>
      {connection === undefined ? (
        <>
          <Badge intent="danger">not connected</Badge>
          <span>Its Repos' Sessions don't start until someone connects it to an account.</span>
        </>
      ) : connection.lostAt !== undefined ? (
        <>
          <Badge intent="danger">connection lost</Badge>
          <span title={new Date(connection.lostAt).toLocaleString()}>
            The authorization server stopped taking it {timeAgo(connection.lostAt)}: reconnect it.
          </span>
        </>
      ) : (
        <>
          <Badge intent="success">connected</Badge>
          <span title={new Date(connection.connectedAt).toLocaleString()}>
            as {connection.account ?? "an account the server didn't name"}, by{" "}
            {connection.connectedBy.name} {timeAgo(connection.connectedAt)}. Every Session in its
            Repos acts as this account.
          </span>
        </>
      )}
    </div>
  )
}

/** The connected Installations of `mcpServer` that saving it as `after` disconnects, by name. */
export function disconnected(
  mcpServer: McpServer,
  installations: ReadonlyArray<Installation>,
  after: { readonly url: string; readonly auth: McpServerAuth },
): ReadonlyArray<string> {
  if (!clearsConnections(mcpServer, after)) return []
  return installations
    .filter((one) => one.mcpServerId === mcpServer.id && one.connection !== undefined)
    .map((one) => one.name)
}

/** Says which Installations a change to their MCP server disconnects, before it does. */
export function DisconnectsBanner({
  names,
  verb,
}: {
  names: ReadonlyArray<string>
  verb: "Saving" | "Upgrading"
}) {
  if (names.length === 0) return null
  return (
    <Banner intent="warning" icon={<WarningIcon />} title={`${verb} disconnects ${andList(names)}`}>
      The Hub drops the tokens and the client, whether it registered it or someone entered it: they
      were granted for the server as it is, and must not reach another. Each needs connecting again,
      and until it is, its Repos' Sessions don't start.
    </Banner>
  )
}
