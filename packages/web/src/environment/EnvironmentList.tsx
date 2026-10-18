import { sameRepo } from "@kndl/protocol"
import * as stylex from "@stylexjs/stylex"
import { Link } from "@tanstack/react-router"
import { useMemo } from "react"
import { plural, repoParams } from "../app/format.ts"
import { useHubState } from "../app/hub.tsx"
import { isListed } from "../hub/store.ts"
import { knownRepos } from "../sessions/groups.ts"
import {
  BoxIcon,
  ChevronRightIcon,
  SettingsEmpty,
  SettingsList,
  SettingsLoading,
  SettingsPage,
  SettingsRow,
} from "../ui/index.ts"
import { color } from "../ui/tokens.stylex.ts"

const styles = stylex.create({
  // It points to the inline end, whichever way the page reads.
  chevron: {
    flexShrink: 0,
    color: color.textTertiary,
    transform: { default: "none", ":dir(rtl)": "scaleX(-1)" },
  },
})

/**
 * `/environments`: a way to each Repo's Environment. The Repos are the ones the web knows of from
 * their Sessions, Archived ones included.
 */
export function EnvironmentList() {
  const sessions = useHubState((state) => state.sessions)
  const repos = useMemo(
    () =>
      sessions === null
        ? null
        : knownRepos(sessions).map((repo) => ({
            repo,
            listed: sessions.filter((session) => sameRepo(session.repo, repo) && isListed(session))
              .length,
          })),
    [sessions],
  )

  return (
    <SettingsPage title="Environments" description="What each Repo's Sandboxes are built from.">
      {repos === null ? (
        <SettingsLoading label="Loading Repos" />
      ) : repos.length === 0 ? (
        <SettingsEmpty
          title="No Repos yet"
          description="A Repo shows here once it has a Session. Start one to set up a new Repo and its Environment."
        />
      ) : (
        <SettingsList label="Environments">
          {repos.map(({ repo, listed }) => (
            <SettingsRow
              key={repo}
              label={repo}
              link={<Link to="/repos/$owner/$repo/environment" params={repoParams(repo)} />}
              icon={<BoxIcon />}
              name={repo}
              meta={`${listed === 0 ? "No" : listed} ${plural(listed, { one: "Session", other: "Sessions" })}`}
              action={<ChevronRightIcon {...stylex.props(styles.chevron)} />}
            />
          ))}
        </SettingsList>
      )}
    </SettingsPage>
  )
}
