// A Session that didn't start for its Repo's Installations (#216): which failed and why, each with
// a way out. Fix opens the Installation on the Plugins page; whoever may change it (access to every
// Repo it lists, as the Hub requires) can take the Session's Repo off it here instead, and the
// Session is woken at once. Retry wakes it, which checks the Installations again. Its queued
// prompts wait meanwhile, and run once it starts.

import {
  type Installation,
  type InstallationFailure,
  installationFailureText,
  sameRepo,
  type SessionSummary,
} from "@kndl/protocol"
import * as stylex from "@stylexjs/stylex"
import { Link } from "@tanstack/react-router"
import { useEffect, useState } from "react"
import { useHub, useHubState } from "../app/hub.tsx"
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
  name: { fontWeight: weight.semibold },
  link: {
    color: color.accentSubtleText,
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
  onRetry: () => void
}) {
  const hub = useHub()
  const online = useHubState((state) => state.connection.status === "online")
  const plugins = useHubState((state) => state.plugins)
  const [busy, setBusy] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<Deleting | null>(null)

  useEffect(() => {
    if (!online) return
    // Without them, only Fix and Retry show.
    hub.getPlugins().catch(() => undefined)
  }, [hub, online])

  /** The Installation, if the person may take the Session's Repo off it. */
  const changeable = (failure: InstallationFailure) => {
    const installation = plugins?.installations.find((one) => one.id === failure.installationId)
    if (installation === undefined || installation.otherRepos !== undefined) return undefined
    return installation.repos.some((repo) => sameRepo(repo, summary.repo))
      ? installation
      : undefined
  }

  const takeOff = async (installation: Installation, remove: boolean) => {
    setBusy(installation.id)
    try {
      const others = installation.repos.filter((repo) => !sameRepo(repo, summary.repo))
      await (remove
        ? hub.deleteInstallation(installation.id)
        : hub.editInstallation(installation.id, installation.name, others))
      onRetry()
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
          <Button size="sm" onClick={onRetry}>
            Retry
          </Button>
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
                  <Link
                    to="/plugins"
                    search={{ installation: failure.installationId }}
                    aria-label={`Fix ${failure.installation}`}
                    {...stylex.props(styles.link, focus.ring)}
                  >
                    Fix
                  </Link>
                  {installation !== undefined && (
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
                  )}
                </li>
              )
            })}
          </ul>
        }
      >
        {one ? "An Installation" : "Installations"} on for {summary.repo} can't work. Fix{" "}
        {one ? "it" : "them"}, or take {summary.repo} off {one ? "it" : "them"}, then retry. Prompts
        sent now wait in the queue until it starts.
      </Banner>
      <Dialog
        size="sm"
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open) setDeleting(null)
        }}
        title={`Delete ${deleting?.installation.name ?? "the Installation"}?`}
        description={`${summary.repo} is the only Repo it is on in, so taking it off deletes the Installation, with its header secret values. Its Plugin stays.`}
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
    </>
  )
}
