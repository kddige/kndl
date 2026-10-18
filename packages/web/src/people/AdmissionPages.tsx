// The pages a Setup link and an Invite open, and the one the Hub sends anyone it turns away
// (issue #209, ADR 0019). Each stands on its own, without the sidebar, signed in or not.
//
// `/setup` and `/invite` find the link's secret in the address's fragment, which never reaches a
// server. Continuing hands it to the Hub (`POST /auth/github/admission`), which keeps it in a
// cookie, takes it out of the address, and sends the browser to GitHub to sign in: the Hub checks
// it once GitHub sends the browser back. The page can't tell whether the secret is any good, so it
// says nothing about that: the Hub turns away a bad one as it does anyone else, at `/invite-only`.

import { InviteOnlyMessage, type Participant } from "@kndl/protocol"
import * as stylex from "@stylexjs/stylex"
import { Link } from "@tanstack/react-router"
import { useCallback, useEffect, useState } from "react"
import { useHub } from "../app/hub.tsx"
import { AuthCard } from "../app/SignIn.tsx"
import { hubPaths, type SignInOptions } from "../hub/config.ts"
import { Button, Spinner } from "../ui/index.ts"
import { color, leading, space, text, weight } from "../ui/tokens.stylex.ts"
import { ticketFrom } from "./people.ts"

const styles = stylex.create({
  full: { width: "100%" },
  note: { margin: 0, color: color.textSecondary, fontSize: text.sm, lineHeight: leading.snug },
  strong: { color: color.text, fontWeight: weight.semibold },
  loading: { display: "grid", placeItems: "center", minHeight: "100dvh" },
  error: { margin: 0, color: color.dangerText, fontSize: text.sm, lineHeight: leading.snug },
  actions: { display: "flex", flexDirection: "column", gap: space.s2 },
})

/** Which link opened the page. */
export type AdmissionKind = "setup" | "invite"

type SignedIn =
  | { readonly status: "checking" }
  | { readonly status: "signedIn"; readonly you: Participant }
  | { readonly status: "signedOut"; readonly options: SignInOptions }
  | { readonly status: "unreachable"; readonly message: string }

const copy = {
  setup: {
    title: "Become this Hub's Owner",
    lede: "Sign in with GitHub to become the Owner of this kndl Hub. Its Owner invites everyone else, on the People page.",
    broken:
      "Open the Setup link as kndl printed it, all of it, or run kndl hub setup-link on the Hub's machine for a new one.",
    signedIn:
      "This Setup link is for whoever signs in first, as the Hub's Owner. It is still unused.",
  },
  invite: {
    title: "You're invited to kndl",
    lede: "Sign in with GitHub to join this Hub, where people watch and drive Claude Code Sessions together.",
    broken:
      "Open the Invite as it was sent to you, all of it: the part after # is what lets you in.",
    signedIn: "This Invite is for someone who isn't a Member yet. It is still unused.",
  },
} as const

/** `/setup` and `/invite`: sign in with GitHub, bringing the link's secret. */
export function AdmissionPage({
  kind,
  hash = window.location.hash,
  goTo = (url) => window.location.assign(url),
}: {
  kind: AdmissionKind
  /** The address's fragment, with the secret; a test stands in for it. */
  hash?: string
  /** Sends the browser to GitHub sign-in; a test stands in for it. */
  goTo?: (url: string) => void
}) {
  const hub = useHub()
  const [ticket] = useState(() => ticketFrom(hash))
  const [signedIn, setSignedIn] = useState<SignedIn>({ status: "checking" })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const words = copy[kind]

  const check = useCallback(() => {
    setSignedIn({ status: "checking" })
    hub.transport.signInStatus().then(
      (status) =>
        setSignedIn(
          status.signedIn
            ? { status: "signedIn", you: status.you }
            : { status: "signedOut", options: status.options },
        ),
      (cause: unknown) =>
        setSignedIn({
          status: "unreachable",
          message: cause instanceof Error ? cause.message : String(cause),
        }),
    )
  }, [hub])
  useEffect(check, [check])

  if (ticket === undefined) {
    return <AuthCard title="This link isn't whole" lede={words.broken} />
  }
  switch (signedIn.status) {
    case "checking":
      return (
        <div {...stylex.props(styles.loading)}>
          <Spinner label="Checking who's signed in" />
        </div>
      )
    case "unreachable":
      return (
        <AuthCard title="Couldn't reach the Hub" lede={signedIn.message}>
          <Button onClick={check}>Try again</Button>
        </AuthCard>
      )
    case "signedIn": {
      const { you } = signedIn
      return (
        <AuthCard
          title="You're signed in already"
          lede={
            <>
              As <span {...stylex.props(styles.strong)}>@{you.login}</span>. {words.signedIn}
            </>
          }
        >
          <Button intent="primary" nativeButton={false} render={<Link to="/" />}>
            Open kndl
          </Button>
        </AuthCard>
      )
    }
    case "signedOut":
      break
  }
  if (!signedIn.options.github) {
    return (
      <AuthCard
        title="GitHub sign-in is off"
        lede="This Hub lets people in with GitHub sign-in, which isn't set up on it yet. Ask whoever runs it to set it up, then open this link again."
      />
    )
  }

  const signIn = async () => {
    setBusy(true)
    setError(null)
    try {
      await hub.transport.admit(ticket)
      // The secret is the Hub's now: out of the address, and so out of this tab's history.
      window.history.replaceState(window.history.state, "", window.location.pathname)
      goTo(hubPaths.githubSignIn)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      setBusy(false)
    }
  }

  return (
    <AuthCard title={words.title} lede={words.lede}>
      <div {...stylex.props(styles.actions)}>
        <Button
          intent="primary"
          size="lg"
          loading={busy}
          onClick={() => void signIn()}
          sx={styles.full}
        >
          Continue with GitHub
        </Button>
        {error && (
          <p role="alert" {...stylex.props(styles.error)}>
            {error}
          </p>
        )}
      </div>
      <p {...stylex.props(styles.note)}>The link works once: keep it to yourself.</p>
    </AuthCard>
  )
}

/** `/invite-only`: where the Hub sends anyone it didn't let in, whatever link they came with. */
export function InviteOnlyPage() {
  return (
    <AuthCard title="You weren't let in" lede={InviteOnlyMessage}>
      <p {...stylex.props(styles.note)}>
        An invite works once, for one person, and for a week. If you were signed in to GitHub as
        someone else, sign out there and open the invite again.
      </p>
      <Button nativeButton={false} render={<Link to="/" />}>
        Back to sign-in
      </Button>
    </AuthCard>
  )
}
