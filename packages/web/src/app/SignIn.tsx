import * as stylex from "@stylexjs/stylex"
import { type FormEvent, type ReactNode, useState } from "react"
import { githubSignInUrl, type SignInOptions } from "../hub/config.ts"
import { Button, Field, Input, useDocumentTitle } from "../ui/index.ts"
import { focus, textLink } from "../ui/shared.ts"
import {
  color,
  leading,
  radius,
  shadow,
  space,
  text,
  tracking,
  weight,
} from "../ui/tokens.stylex.ts"
import { useHub } from "./hub.tsx"

const styles = stylex.create({
  page: {
    display: "grid",
    placeItems: "center",
    minHeight: "100dvh",
    padding: space.s4,
  },
  card: {
    display: "flex",
    flexDirection: "column",
    gap: space.s4,
    width: "min(22rem, 100%)",
    padding: space.s6,
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: color.border,
    borderRadius: radius.lg,
    backgroundColor: color.surface,
    boxShadow: shadow.sm,
  },
  wide: { width: "min(26rem, 100%)" },
  heading: { display: "flex", flexDirection: "column", gap: space.s1 },
  title: {
    outline: "none",
    margin: 0,
    fontSize: text.lg,
    fontWeight: weight.semibold,
    letterSpacing: tracking.tight,
    lineHeight: leading.tight,
    overflowWrap: "anywhere",
  },
  lede: { margin: 0, color: color.textMuted, lineHeight: leading.snug },
  divider: {
    display: "flex",
    alignItems: "center",
    gap: space.s2,
    color: color.textSubtle,
    fontSize: text.xs,
    "::before": { content: '""', flex: 1, height: "1px", backgroundColor: color.border },
    "::after": { content: '""', flex: 1, height: "1px", backgroundColor: color.border },
  },
  form: { display: "flex", flexDirection: "column", gap: space.s3 },
  full: { width: "100%" },
  note: { margin: 0, color: color.textMuted, fontSize: text.sm, lineHeight: leading.snug },
  error: { margin: 0, color: color.dangerSubtleText, fontSize: text.sm },
})

/** A card alone in the middle of the page: signing in, and approving the CLI. */
export function AuthCard({
  title,
  pageTitle,
  lede,
  wide = false,
  children,
}: {
  title: ReactNode
  /** The browser tab's name, where `title` isn't plain text. */
  pageTitle?: string
  lede?: ReactNode
  /** A little wider, for a card with a code or a warning in it. */
  wide?: boolean
  children?: ReactNode
}) {
  useDocumentTitle(`${pageTitle ?? (typeof title === "string" ? title : "")} · kndl`)
  return (
    <main {...stylex.props(styles.page)}>
      <div {...stylex.props(styles.card, wide && styles.wide)}>
        <div {...stylex.props(styles.heading)}>
          <h1 tabIndex={-1} {...stylex.props(styles.title)}>
            {title}
          </h1>
          {lede !== undefined && <p {...stylex.props(styles.lede)}>{lede}</p>}
        </div>
        {children}
      </div>
    </main>
  )
}

/**
 * What the web UI shows when no one is signed in. GitHub sign-in comes back to `returnTo`, a path
 * on the Hub (`/` by default); a dev sign-in calls `onSignedIn`, which connects again by default.
 */
export function SignIn({
  options,
  lede,
  returnTo,
  onSignedIn,
}: {
  options: SignInOptions
  lede?: string
  returnTo?: string
  onSignedIn?: () => void
}) {
  const hub = useHub()
  const [login, setLogin] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const devSignIn = async (event: FormEvent) => {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await hub.transport.devSignIn(login.trim() || undefined)
      if (onSignedIn) onSignedIn()
      else hub.retry()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      setBusy(false)
    }
  }

  return (
    <AuthCard
      title="Sign in to kndl"
      lede={
        options.github || options.dev ? (
          (lede ?? "Sign in to see the Sessions on the Repos you can access.")
        ) : (
          <>
            No sign-in method is set up on this Hub.{" "}
            <a
              href="https://kddige.github.io/kndl/self-hosting/set-up-the-github-app/"
              target="_blank"
              rel="noreferrer noopener"
              {...stylex.props(textLink.underline, focus.ring)}
            >
              Set up GitHub sign-in
            </a>
          </>
        )
      }
    >
      {options.github && (
        <Button
          intent="primary"
          size="lg"
          nativeButton={false}
          render={<a href={githubSignInUrl(returnTo)} />}
          sx={styles.full}
        >
          Sign in with GitHub
        </Button>
      )}
      {options.github && (
        <p {...stylex.props(styles.note)}>
          This Hub is invite-only. New here? Open the Invite its Owner sent you.
        </p>
      )}
      {options.github && options.dev && <div {...stylex.props(styles.divider)}>or</div>}
      {options.dev && (
        <form onSubmit={devSignIn} {...stylex.props(styles.form)}>
          <Field label="Dev login" description="Any login; only on a Hub running locally.">
            <Input
              value={login}
              onValueChange={(value: string) => setLogin(value)}
              placeholder="alice"
              autoComplete="username"
            />
          </Field>
          <Button
            type="submit"
            intent={options.github ? "secondary" : "primary"}
            loading={busy}
            sx={styles.full}
          >
            Sign in as dev
          </Button>
          {error && (
            <p role="alert" {...stylex.props(styles.error)}>
              {error}
            </p>
          )}
        </form>
      )}
    </AuthCard>
  )
}
