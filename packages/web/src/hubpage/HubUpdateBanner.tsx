// A newer kndl is out (ADR 0028): a small banner across the app, for the Hub's Owner alone, that
// leads to the Hub page. Dismissing it hides it until the check finds another update. It isn't
// shown on the Hub page itself, which says it all.

import * as stylex from "@stylexjs/stylex"
import { Link, useRouterState } from "@tanstack/react-router"
import { useHubState } from "../app/hub.tsx"
import { Banner, Button, CloseIcon, IconButton, UpdateIcon } from "../ui/index.ts"
import { space } from "../ui/tokens.stylex.ts"
import { bannerTarget, bannerText, dismissUpdate, useDismissedUpdate } from "./hubUpdate.ts"

const styles = stylex.create({
  actions: { display: "flex", alignItems: "center", gap: space.s1 },
})

export function HubUpdateBanner() {
  const update = useHubState((state) => state.hubUpdate)
  const version = useHubState((state) => state.hubVersion)
  const owner = useHubState((state) => state.owner)
  const dismissed = useDismissedUpdate()
  const pathname = useRouterState({ select: (state) => state.location.pathname })
  const target = bannerTarget(update, dismissed)
  if (!owner || update === null || target === null || pathname === "/hub") return null
  const text = bannerText(update, version)
  if (text === null) return null

  return (
    <Banner
      slim
      intent="neutral"
      icon={<UpdateIcon />}
      title={text.title}
      action={
        <div {...stylex.props(styles.actions)}>
          <Button size="sm" nativeButton={false} render={<Link to="/hub" />}>
            See what changed
          </Button>
          <IconButton label="Dismiss update notice" size="sm" onClick={() => dismissUpdate(target)}>
            <CloseIcon />
          </IconButton>
        </div>
      }
    >
      {text.description}
    </Banner>
  )
}
