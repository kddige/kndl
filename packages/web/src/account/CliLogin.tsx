// The pages `claude-hub login` opens (issue #179). `/cli-login` asks the signed-in person to approve
// the CLI on a machine, and gets a Login code for it. With the CLI's `port`, the browser then goes
// back to the CLI on `localhost` with the code, and the CLI trades it for its token; when the
// browser can't reach it, as when the CLI runs over SSH, going back a page shows the code to paste.
// Without a port (`--no-browser`) the page shows the code at once. `/cli-login/done` is where the
// CLI sends the browser once it is signed in.

import {
  type CliLoginApproved,
  CliLoginChallenge,
  formatCliLoginCode,
  MachineName,
  type Participant,
} from "@claude-hub/protocol"
import * as stylex from "@stylexjs/stylex"
import { Link } from "@tanstack/react-router"
import { Schema } from "effect"
import { useCallback, useEffect, useState } from "react"
import { useHub } from "../app/hub.tsx"
import { AuthCard, SignIn } from "../app/SignIn.tsx"
import type { SignInOptions } from "../hub/config.ts"
import {
  Banner,
  Button,
  CheckIcon,
  CopyIcon,
  IconButton,
  Spinner,
  toast,
  WarningIcon,
} from "../ui/index.ts"
import { color, font, leading, radius, space, text, weight } from "../ui/tokens.stylex.ts"

const styles = stylex.create({
  actions: { display: "flex", flexWrap: "wrap", gap: space.s2 },
  grow: { flex: 1 },
  note: { margin: 0, color: color.textMuted, fontSize: text.sm, lineHeight: leading.snug },
  strong: { color: color.text, fontWeight: weight.semibold, overflowWrap: "anywhere" },
  codeRow: {
    display: "flex",
    alignItems: "center",
    gap: space.s2,
    paddingBlock: space.s3,
    paddingInline: space.s4,
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: color.border,
    borderRadius: radius.md,
    backgroundColor: color.surfaceMuted,
  },
  code: {
    flex: 1,
    minWidth: 0,
    fontFamily: font.mono,
    fontSize: text.lg,
    fontWeight: weight.semibold,
    letterSpacing: "0.06em",
    textAlign: "center",
    overflowWrap: "anywhere",
    userSelect: "all",
  },
  status: {
    display: "flex",
    alignItems: "center",
    gap: space.s2,
    margin: 0,
    color: color.textMuted,
    fontSize: text.sm,
  },
  loading: { display: "grid", placeItems: "center", minHeight: "100dvh" },
  error: { margin: 0, color: color.dangerSubtleText, fontSize: text.sm, lineHeight: leading.snug },
})

/** What `claude-hub login` put in the page's address. */
export interface CliLoginSearch {
  machine?: string
  challenge?: string
  /** The CLI's port on `localhost`, to send the browser back to; none with `--no-browser`. */
  port?: number
  state?: string
}

const isMachine = Schema.is(MachineName)
const isChallenge = Schema.is(CliLoginChallenge)

/** The search as the route reads it: anything else is dropped, so the page says it isn't whole. */
export function readCliLoginSearch(search: Record<string, unknown>): CliLoginSearch {
  const { machine, challenge, port, state } = search
  const portNumber = typeof port === "string" ? Number(port) : port
  return {
    ...(typeof machine === "string" && { machine }),
    ...(typeof challenge === "string" && { challenge }),
    ...(typeof portNumber === "number" &&
      Number.isInteger(portNumber) &&
      portNumber > 0 &&
      portNumber < 65_536 && { port: portNumber }),
    ...(typeof state === "string" && /^[0-9A-Za-z_-]{1,128}$/.test(state) && { state }),
  }
}

/** A request the page can approve: the machine and challenge, and the port and state together. */
type CliLoginRequest = {
  readonly machine: string
  readonly challenge: string
  readonly callback?: { readonly port: number; readonly state: string }
}

function requestOf(search: CliLoginSearch): CliLoginRequest | undefined {
  const { machine, challenge, port, state } = search
  if (!isMachine(machine) || !isChallenge(challenge)) return undefined
  if ((port === undefined) !== (state === undefined)) return undefined
  return port !== undefined && state !== undefined
    ? { machine, challenge, callback: { port, state } }
    : { machine, challenge }
}

/** Where the browser goes back to the CLI with the code. */
export function callbackUrl(callback: { port: number; state: string }, code: string): string {
  const url = new URL(`http://127.0.0.1:${callback.port}/callback`)
  url.searchParams.set("code", code)
  url.searchParams.set("state", callback.state)
  return url.href
}

// The code is kept in this tab while it is good, keyed by the CLI's challenge: going back a page
// after the browser couldn't reach the CLI shows it again, rather than approving a second time.
const storedPrefix = "claude-hub:cli-login:"

function storedCode(challenge: string): CliLoginApproved | undefined {
  try {
    const raw = sessionStorage.getItem(storedPrefix + challenge)
    if (raw === null) return undefined
    const stored = JSON.parse(raw) as Partial<CliLoginApproved>
    if (typeof stored.code !== "string" || typeof stored.expiresAt !== "number") return undefined
    if (stored.expiresAt <= Date.now()) return undefined
    return { code: stored.code, expiresAt: stored.expiresAt }
  } catch {
    return undefined
  }
}

function storeCode(challenge: string, approved: CliLoginApproved): void {
  try {
    sessionStorage.setItem(storedPrefix + challenge, JSON.stringify(approved))
  } catch {
    // Without storage, going back a page asks again: approving again gives a new code.
  }
}

/** Forgets every code kept in this tab, once the CLI is signed in. */
function forgetCodes(): void {
  try {
    for (const key of Object.keys(sessionStorage)) {
      if (key.startsWith(storedPrefix)) sessionStorage.removeItem(key)
    }
  } catch {
    // Nothing kept.
  }
}

type SignedIn =
  | { readonly status: "checking" }
  | { readonly status: "signedIn"; readonly you: Participant }
  | { readonly status: "signedOut"; readonly options: SignInOptions }
  | { readonly status: "unreachable"; readonly message: string }

type Step =
  | { readonly step: "asking" }
  | { readonly step: "declined" }
  | {
      readonly step: "approved"
      readonly approved: CliLoginApproved
      readonly sending: boolean
    }

/** `/cli-login`: approve `claude-hub login` on a machine. */
export function CliLoginPage({
  search,
  goTo = (url) => window.location.assign(url),
}: {
  search: CliLoginSearch
  /** Sends the browser to the CLI; a test stands in for it. */
  goTo?: (url: string) => void
}) {
  const hub = useHub()
  const request = requestOf(search)
  const [signedIn, setSignedIn] = useState<SignedIn>({ status: "checking" })
  const [step, setStep] = useState<Step>(() => {
    const kept = request === undefined ? undefined : storedCode(request.challenge)
    return kept === undefined
      ? { step: "asking" }
      : { step: "approved", approved: kept, sending: false }
  })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

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

  if (request === undefined) {
    return (
      <AuthCard
        title="This sign-in link isn't whole"
        lede="Run claude-hub login again, and open the link it prints as it is."
      />
    )
  }
  const { machine } = request
  const machineName = <span {...stylex.props(styles.strong)}>{machine}</span>

  if (step.step === "approved") {
    return <ApprovedCard machine={machine} approved={step.approved} sending={step.sending} />
  }
  if (step.step === "declined") {
    return (
      <AuthCard
        title="Not approved"
        lede={
          <>
            claude-hub on {machineName} isn't signed in. Stop claude-hub login there with Ctrl-C,
            and close this tab.
          </>
        }
      />
    )
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
    case "signedOut":
      return (
        <SignIn
          options={signedIn.options}
          lede={`Sign in to approve claude-hub on ${machine}.`}
          returnTo={`${window.location.pathname}${window.location.search}`}
          onSignedIn={check}
        />
      )
    case "signedIn":
      break
  }
  const { you } = signedIn

  const approve = async () => {
    setBusy(true)
    setError(null)
    try {
      const approved = await hub.transport.approveCli({
        machine: request.machine,
        challenge: request.challenge,
      })
      storeCode(request.challenge, approved)
      const { callback } = request
      setStep({ step: "approved", approved, sending: callback !== undefined })
      if (callback !== undefined) goTo(callbackUrl(callback, approved.code))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      setBusy(false)
    }
  }

  return (
    <AuthCard
      wide
      title={<>Sign in claude-hub on {machine}?</>}
      lede={
        <>
          claude-hub login on {machineName} asks to act on this Hub as you,{" "}
          <span {...stylex.props(styles.strong)}>
            {you.name === you.login ? `@${you.login}` : `${you.name} (@${you.login})`}
          </span>
          . It gets a CLI token that lasts until you sign it out there, or revoke it on your Account
          page.
        </>
      }
    >
      <Banner intent="warning" icon={<WarningIcon />} title="Only if you ran it yourself">
        Approve only if you just ran claude-hub login on {machine}. Someone who sent you this link
        could act as you.
      </Banner>
      {error && (
        <p role="alert" {...stylex.props(styles.error)}>
          {error}
        </p>
      )}
      <div {...stylex.props(styles.actions)}>
        <Button intent="primary" loading={busy} onClick={() => void approve()} sx={styles.grow}>
          Approve
        </Button>
        <Button
          intent="ghost"
          disabled={busy}
          onClick={() => setStep({ step: "declined" })}
          sx={styles.grow}
        >
          Cancel
        </Button>
      </div>
    </AuthCard>
  )
}

/** The code, once approved: to paste, or while the browser goes back to the CLI. */
function ApprovedCard({
  machine,
  approved,
  sending,
}: {
  machine: string
  approved: CliLoginApproved
  sending: boolean
}) {
  const code = formatCliLoginCode(approved.code)
  const minutes = Math.max(1, Math.ceil((approved.expiresAt - Date.now()) / 60_000))
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code)
      toast.show({ title: "Copied the code" })
    } catch {
      toast.show({
        title: "Couldn't copy",
        description: "Select the code and copy it yourself.",
        intent: "warning",
      })
    }
  }
  return (
    <AuthCard
      wide
      title={sending ? "Approved" : "Paste this code in the terminal"}
      lede={
        sending ? (
          <>Sending you back to claude-hub on {machine}…</>
        ) : (
          <>
            claude-hub login on <span {...stylex.props(styles.strong)}>{machine}</span> is waiting
            for it.
          </>
        )
      }
    >
      {sending && (
        <p {...stylex.props(styles.note)}>
          If the browser can't reach it, as when claude-hub runs over SSH, paste this code in the
          terminal instead:
        </p>
      )}
      <div {...stylex.props(styles.codeRow)}>
        <code aria-label="Login code" {...stylex.props(styles.code)}>
          {code}
        </code>
        <IconButton label="Copy code" size="sm" onClick={() => void copy()}>
          <CopyIcon />
        </IconButton>
      </div>
      <p {...stylex.props(styles.note)}>
        It works once, for the next {minutes === 1 ? "minute" : `${minutes} minutes`}, and only for
        the claude-hub login that asked for it. Then close this tab.
      </p>
    </AuthCard>
  )
}

/** `/cli-login/done`: where the CLI sends the browser once it is signed in. */
export function CliLoginDonePage({ machine }: { machine?: string }) {
  useEffect(forgetCodes, [])
  return (
    <AuthCard
      title="claude-hub is signed in"
      lede={
        <>
          claude-hub
          {machine !== undefined && (
            <>
              {" "}
              on <span {...stylex.props(styles.strong)}>{machine}</span>
            </>
          )}{" "}
          is signed in to this Hub. You can close this tab, and go back to the terminal.
        </>
      }
    >
      <p {...stylex.props(styles.status)}>
        <CheckIcon /> Revoke it any time under CLI tokens on your Account page.
      </p>
      <Button nativeButton={false} render={<Link to="/account" />}>
        Open your Account page
      </Button>
    </AuthCard>
  )
}
