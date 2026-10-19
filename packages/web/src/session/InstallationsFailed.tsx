// A Session that didn't start for its Repo's Installations (#216): which failed and why, each with
// a way out. Fix opens the Installation on the MCP page; whoever may change it (access to every
// Repo it lists, as the Hub requires) can take the Session's Repo off it here instead, and the
// Session is woken at once. A global one (#219) anyone in the Session can turn off for its Repo
// instead, but only the Owner can fix. Retry wakes it, which checks the Installations again: anyone
// in the Session can. Its queued prompts wait meanwhile, and run once it
// starts. An OAuth Installation not connected
// (#217) has Reconnect instead of Fix: through its authorization server and back to the MCP page,
// or first asking for a client entered by hand, where that offers no registration (#218).

import {
  type Installation,
  type InstallationFailure,
  installationFailureText,
  leaveText,
  sameRepo,
  type SessionSummary,
} from "@kndl/protocol"
import * as stylex from "@stylexjs/stylex"
import { Link } from "@tanstack/react-router"
import { useEffect, useState } from "react"
import { useHub, useHubState } from "../app/hub.tsx"
import { useConnect } from "../mcp/connection.tsx"
import { Banner, Button, Dialog, DialogClose, InfoIcon, toast } from "../ui/index.ts"
import { focus } from "../ui/shared.ts"
import { color, radius, space, text, weight } from "../ui/tokens.stylex.ts"

const styles = stylex.create({
  list: {
    display: "flex",
    flexDirection: "column",
    gap: space.s2,
    margin: 0,
    padding: 0,
    listStyle: "none",
  },
  row: { display: "flex", flexWrap: "wrap", alignItems: "center", gap: space.s2 },
  why: { flex: "1 1 14rem", minWidth: 0, fontSize: text.sm },
  muted: { color: color.textSecondary, fontSize: text.sm },
  name: { fontWeight: weight.semibold },
  link: {
    color: color.accentText,
    fontSize: text.sm,
    textDecoration: { default: "none", ":hover": "underline" },
    borderRadius: radius.sm,
  },
})

/** Taking the Session's Repo off an Installation that lists no other: that deletes it. */
interface Deleting {
  readonly installation: Installation
}

export function InstallationsFailedBanner({
  summary,
  failures,
  onRetry,
}: {
  summary: SessionSummary
  failures: ReadonlyArray<InstallationFailure>
  /** Wakes the Session again; absent where it can't be woken. */
  onRetry?: (() => void) | undefined
}) {
  const hub = useHub()
  const online = useHubState((state) => state.connection.status === "online")
  const mcpServers = useHubState((state) => state.mcpServers)
  const owner = useHubState((state) => state.owner)
  const [busy, setBusy] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<Deleting | null>(null)
  const { connect, clientDialog } = useConnect()

  const reconnect = async (installation: Installation) => {
    setBusy(installation.id)
    try {
      await connect(installation)
    } catch (error) {
      toast.show({
        title: `Couldn't connect ${installation.name}`,
        description: error instanceof Error ? error.message : String(error),
        intent: "danger",
      })
    }
    // Still here while a client is asked for, or after a refusal.
    setBusy(null)
  }

  useEffect(() => {
    if (!online) return
    // Without them, only Fix and Retry show.
    hub.getMcpServers().catch(() => undefined)
  }, [hub, online])

  /** The Installation, if the person may take the Session's Repo off it. */
  const changeable = (failure: InstallationFailure) => {
    const installation = mcpServers?.installations.find((one) => one.id === failure.installationId)
    if (installation === undefined) return undefined
    // Anyone with access to the Repo turns a global one off for it.
    if (installation.global === true) return installation
    if (installation.otherRepos !== undefined) return undefined
    return installation.repos.some((repo) => sameRepo(repo, summary.repo))
      ? installation
      : undefined
  }

  const turnOff = async (installation: Installation) => {
    setBusy(installation.id)
    try {
      await hub.turnGlobalInstallation(installation.id, summary.repo, false)
      onRetry?.()
    } catch (error) {
      toast.show({
        title: `Couldn't turn ${installation.name} off for ${summary.repo}`,
        description: error instanceof Error ? error.message : String(error),
        intent: "danger",
      })
    } finally {
      setBusy(null)
    }
  }

  const takeOff = async (installation: Installation, remove: boolean) => {
    setBusy(installation.id)
    try {
      const others = installation.repos.filter((repo) => !sameRepo(repo, summary.repo))
      await (remove
        ? hub.deleteInstallation(installation.id)
        : hub.editInstallation(installation.id, installation.name, others))
      onRetry?.()
    } catch (error) {
      toast.show({
        title: `Couldn't take ${summary.repo} off ${installation.name}`,
        description: error instanceof Error ? error.message : String(error),
        intent: "danger",
      })
    } finally {
      setBusy(null)
    }
  }

  const one = failures.length === 1
  return (
    <>
      <Banner
        intent="danger"
        icon={<InfoIcon />}
        title="This Session can't start"
        action={
          onRetry && (
            <Button size="sm" onClick={onRetry}>
              Retry
            </Button>
          )
        }
        detail={
          <ul
            aria-label="Installations that keep this Session from starting"
            {...stylex.props(styles.list)}
          >
            {failures.map((failure) => {
              const installation = changeable(failure)
              return (
                <li key={failure.installationId} {...stylex.props(styles.row)}>
                  <span {...stylex.props(styles.why)}>{installationFailureText(failure)}</span>
                  {failure.global === true && !owner ? (
                    <span {...stylex.props(styles.muted)}>
                      It is global: only the Hub's Owner can fix it.
                    </span>
                  ) : failure.reason === "NotConnected" && installation !== undefined ? (
                    <Button
                      size="sm"
                      aria-label={`Reconnect ${failure.installation}`}
                      loading={busy === installation.id}
                      onClick={() => void reconnect(installation)}
                    >
                      Reconnect
                    </Button>
                  ) : (
                    <Link
                      to="/mcp"
                      search={{ installation: failure.installationId }}
                      aria-label={`Fix ${failure.installation}`}
                      {...stylex.props(styles.link, focus.ring)}
                    >
                      Fix
                    </Link>
                  )}
                  {installation?.global === true ? (
                    <Button
                      size="sm"
                      intent="ghost"
                      aria-label={`Turn ${installation.name} off for ${summary.repo}`}
                      loading={busy === installation.id}
                      onClick={() => void turnOff(installation)}
                    >
                      Turn it off for {summary.repo}
                    </Button>
                  ) : (
                    installation !== undefined && (
                      <Button
                        size="sm"
                        intent="ghost"
                        loading={busy === installation.id}
                        onClick={() => {
                          if (installation.repos.length > 1) void takeOff(installation, false)
                          else setDeleting({ installation })
                        }}
                      >
                        Take {summary.repo} off {installation.name}
                      </Button>
                    )
                  )}
                </li>
              )
            })}
          </ul>
        }
      >
        {one ? "An Installation" : "Installations"} on for {summary.repo} can't work. Fix{" "}
        {one ? "it" : "them"}, or {leaveText(summary.repo, failures)}
        {onRetry
          ? ", then retry. Prompts sent now wait in the queue until it starts."
          : ". Then wake it."}
      </Banner>
      <Dialog
        size="sm"
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open) setDeleting(null)
        }}
        title={`Delete ${deleting?.installation.name ?? "the Installation"}?`}
        description={`${summary.repo} is the only Repo it is on in, so taking it off deletes the Installation, with its header secret values. Its MCP server stays.`}
        footer={
          <>
            <DialogClose>Cancel</DialogClose>
            <Button
              intent="danger"
              onClick={() => {
                if (deleting !== null) void takeOff(deleting.installation, true)
                setDeleting(null)
              }}
            >
              Delete Installation
            </Button>
          </>
        }
      />
      {clientDialog}
    </>
  )
}
