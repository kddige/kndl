import * as stylex from "@stylexjs/stylex"
import { Link } from "@tanstack/react-router"
import { useMemo } from "react"
import { repoParams } from "../app/format.ts"
import { useHubState } from "../app/hub.tsx"
import { isListed } from "../hub/store.ts"
import { knownRepos } from "../sessions/groups.ts"
import { BoxIcon, ChevronRightIcon, EmptyState, Spinner } from "../ui/index.ts"
import { focus } from "../ui/shared.ts"
import { color, leading, radius, space, text, tracking, weight } from "../ui/tokens.stylex.ts"

const styles = stylex.create({
  scroll: { flex: 1, overflowY: "auto" },
  page: {
    display: "flex",
    flexDirection: "column",
    gap: space.s4,
    maxWidth: "56rem",
    marginInline: "auto",
    paddingBlock: space.s6,
    paddingInline: space.s4,
  },
  title: {
    fontSize: text.xl,
    fontWeight: weight.semibold,
    letterSpacing: tracking.tight,
    lineHeight: leading.tight,
  },
  note: { color: color.textMuted, fontSize: text.sm },
  list: {
    display: "flex",
    flexDirection: "column",
    margin: 0,
    padding: 0,
    listStyle: "none",
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: color.border,
    borderRadius: radius.lg,
    backgroundColor: color.surface,
    overflow: "hidden",
  },
  item: {
    borderTopWidth: "1px",
    borderTopStyle: "solid",
    borderTopColor: color.border,
  },
  firstItem: { borderTopWidth: 0 },
  row: {
    display: "flex",
    alignItems: "center",
    gap: space.s3,
    paddingBlock: space.s3,
    paddingInline: space.s4,
    color: color.text,
    textDecoration: "none",
    backgroundColor: { default: "transparent", ":hover": color.surfaceHover },
  },
  icon: { flexShrink: 0, color: color.textMuted },
  main: { display: "flex", flexDirection: "column", gap: space.s0_5, flex: 1, minWidth: 0 },
  repo: {
    fontWeight: weight.medium,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  count: { color: color.textMuted, fontSize: text.sm },
  chevron: { flexShrink: 0, color: color.textSubtle },
  loading: { display: "grid", placeItems: "center", paddingBlock: space.s16 },
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
            listed: sessions.filter((session) => session.repo === repo && isListed(session)).length,
          })),
    [sessions],
  )

  return (
    <div {...stylex.props(styles.scroll)}>
      <main {...stylex.props(styles.page)}>
        <div>
          <h1 {...stylex.props(styles.title)}>Environments</h1>
          <p {...stylex.props(styles.note)}>
            What every Sandbox of a Repo is built from: one Environment per Repo. A Repo shows here
            once it has a Session; start one to set up a new Repo.
          </p>
        </div>
        {repos === null ? (
          <div {...stylex.props(styles.loading)}>
            <Spinner size="lg" label="Loading Repos" />
          </div>
        ) : repos.length === 0 ? (
          <EmptyState
            size="page"
            icon={<BoxIcon />}
            title="No Repos yet"
            description="A Repo's Environment is set up with its first Session."
          />
        ) : (
          <ul aria-label="Environments" {...stylex.props(styles.list)}>
            {repos.map(({ repo, listed }, index) => (
              <li key={repo} {...stylex.props(styles.item, index === 0 && styles.firstItem)}>
                <Link
                  to="/repos/$owner/$repo/environment"
                  params={repoParams(repo)}
                  {...stylex.props(styles.row, focus.ringInset)}
                >
                  <BoxIcon {...stylex.props(styles.icon)} />
                  <span {...stylex.props(styles.main)}>
                    <span {...stylex.props(styles.repo)}>{repo}</span>
                    <span {...stylex.props(styles.count)}>
                      {listed === 0 ? "No" : listed} {listed === 1 ? "Session" : "Sessions"}
                    </span>
                  </span>
                  <ChevronRightIcon {...stylex.props(styles.chevron)} />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </main>
    </div>
  )
}
