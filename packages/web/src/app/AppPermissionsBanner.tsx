// What the GitHub App's permissions lack, as the Hub last found (issue #86), with links to where
// on GitHub to fix it: kndl can't change an App's permissions, nor accept them for an
// account. First the App's own settings; then each account it's installed on, which has to accept
// what the App asks for.

import type { AppPermissionsCheck } from "@kndl/protocol"
import { describeMissing, hasPermissionDrift } from "@kndl/protocol"
import * as stylex from "@stylexjs/stylex"
import { useState } from "react"
import { Banner, Button, Disclosure, ExternalLinkIcon, toast, WarningIcon } from "../ui/index.ts"
import { focus, textLink } from "../ui/shared.ts"
import { space, weight } from "../ui/tokens.stylex.ts"
import { useHub, useHubState } from "./hub.tsx"

const styles = stylex.create({
  list: {
    display: "flex",
    flexDirection: "column",
    gap: space.s1_5,
    margin: 0,
    paddingInlineStart: space.s4,
  },
  item: { paddingInlineStart: space.s0_5 },
  name: { fontWeight: weight.semibold },
  link: {
    display: "inline-flex",
    alignItems: "center",
    gap: space.s1,
    color: "inherit",
    fontWeight: weight.medium,
    whiteSpace: "nowrap",
  },
})

/** The Hub's last permission check, as a warning across the app while it found anything. */
export function AppPermissionsBanner() {
  const hub = useHub()
  const check = useHubState((state) => state.appPermissions)
  const [checking, setChecking] = useState(false)
  if (check === null || !hasPermissionDrift(check)) return null

  const checkAgain = async () => {
    setChecking(true)
    try {
      const found = await hub.checkAppPermissions()
      if (!hasPermissionDrift(found)) {
        toast.show({ title: "The GitHub App has all it needs", intent: "success" })
      }
    } catch (error) {
      toast.show({
        title: "Could not check the GitHub App",
        description: error instanceof Error ? error.message : String(error),
        intent: "danger",
      })
    } finally {
      setChecking(false)
    }
  }

  return (
    <Banner
      intent="warning"
      icon={<WarningIcon />}
      title="The GitHub App is missing permissions"
      action={
        <Button size="sm" loading={checking} onClick={() => void checkAgain()}>
          Check again
        </Button>
      }
      detail={
        <Disclosure variant="plain" summary={`Show ${stepCount(check)} to fix it`}>
          <Steps check={check} />
        </Disclosure>
      }
    >
      Until it has them, Sessions can fail on GitHub. Only someone who manages the App on GitHub can
      fix this.
    </Banner>
  )
}

function stepCount(check: AppPermissionsCheck): string {
  const count =
    (check.missing.length > 0 || check.missingEvents.length > 0 ? 1 : 0) +
    check.installations.length
  return count === 1 ? "the step" : `${count} steps`
}

function Steps({ check }: { check: AppPermissionsCheck }) {
  const appLacks = check.missing.length > 0 || check.missingEvents.length > 0
  return (
    <ol {...stylex.props(styles.list)}>
      {appLacks && (
        <li {...stylex.props(styles.item)}>
          The App <span {...stylex.props(styles.name)}>{check.slug}</span> lacks{" "}
          {describeMissing(check.missing, check.missingEvents)}.{" "}
          <ExternalLink href={check.settingsUrl}>Edit its permissions</ExternalLink>
        </li>
      )}
      {check.installations.map((installation) => (
        <li key={installation.id} {...stylex.props(styles.item)}>
          {appLacks ? "Then, on " : "On "}
          <span {...stylex.props(styles.name)}>{installation.account}</span>, accept{" "}
          {describeMissing(installation.missing, installation.missingEvents)}.{" "}
          <ExternalLink href={installation.reviewUrl}>Review the request</ExternalLink>
        </li>
      ))}
    </ol>
  )
}

function ExternalLink({ href, children }: { href: string; children: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      {...stylex.props(textLink.underline, styles.link, focus.ring)}
    >
      {children}
      <ExternalLinkIcon aria-hidden="true" />
    </a>
  )
}
