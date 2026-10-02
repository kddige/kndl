import * as stylex from "@stylexjs/stylex"
import { type FormEvent, useState } from "react"
import { hubPaths, type SignInOptions } from "../hub/config.ts"
import { Button, Field, Input } from "../ui/index.ts"
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
  heading: { display: "flex", flexDirection: "column", gap: space.s1 },
  title: {
    fontSize: text.lg,
    fontWeight: weight.semibold,
    letterSpacing: tracking.tight,
    lineHeight: leading.tight,
  },
  lede: { color: color.textMuted, lineHeight: leading.snug },
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
  error: { color: color.dangerSubtleText, fontSize: text.sm },
})

/** What the web UI shows when the Hub turned the socket away because no one is signed in. */
export function SignIn({ options }: { options: SignInOptions }) {
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
      hub.retry()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      setBusy(false)
    }
  }

  return (
    <main {...stylex.props(styles.page)}>
      <div {...stylex.props(styles.card)}>
        <div {...stylex.props(styles.heading)}>
          <h1 {...stylex.props(styles.title)}>Sign in to Claude Hub</h1>
          <p {...stylex.props(styles.lede)}>
            {options.github || options.dev
              ? "Sign in to see the Sessions on the Repos you can access."
              : "This Hub has no way to sign in turned on. Set up GitHub sign-in, or start it on loopback with CLAUDE_HUB_DEV_LOGIN=1."}
          </p>
        </div>
        {options.github && (
          <Button
            intent="primary"
            size="lg"
            nativeButton={false}
            render={<a href={hubPaths.githubSignIn} />}
            sx={styles.full}
          >
            Sign in with GitHub
          </Button>
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
      </div>
    </main>
  )
}
