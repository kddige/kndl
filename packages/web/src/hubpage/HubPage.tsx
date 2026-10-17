// The Hub page (ADR 0028): the kndl this Hub runs, its Channel, and whether a newer kndl is out,
// with what changed: each newer Release's notes on stable, the titles of main's new commits on dev.
// Only the Owner has it, and only on a Hub the kndl service runs from its install, which is the
// one that checks GitHub: as it starts, every 6 hours, and when the Owner presses Check now.
// Updating the Hub from here, and picking its Channel, come next (#362), beside what's found.

import type { CommitTitle, HubUpdateFound, HubUpdateState, ReleaseNotes } from "@kndl/protocol"
import * as stylex from "@stylexjs/stylex"
import { useEffect, useState } from "react"
import { day, timeAgo } from "../app/format.ts"
import { useHub, useHubState } from "../app/hub.tsx"
import {
  Badge,
  Button,
  EmptyState,
  ExternalLinkIcon,
  Markdown,
  PageHeader,
  RestartIcon,
  Spinner,
  toast,
  UpdateIcon,
} from "../ui/index.ts"
import { focus } from "../ui/shared.ts"
import { color, font, leading, radius, space, text, weight } from "../ui/tokens.stylex.ts"
import { followsText, versionText } from "./hubUpdate.ts"

const styles = stylex.create({
  view: { display: "flex", flexDirection: "column", flex: 1, minHeight: 0 },
  scroll: { flex: 1, overflowY: "auto" },
  page: {
    display: "flex",
    flexDirection: "column",
    gap: space.s6,
    maxWidth: "56rem",
    marginInline: "auto",
    paddingBlock: space.s6,
    paddingInline: space.s4,
  },
  section: { display: "flex", flexDirection: "column", gap: space.s2 },
  sectionTitle: {
    margin: 0,
    color: color.textMuted,
    fontSize: text.sm,
    fontWeight: weight.semibold,
  },
  card: {
    display: "flex",
    flexDirection: "column",
    gap: space.s3,
    paddingBlock: space.s4,
    paddingInline: space.s4,
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: color.border,
    borderRadius: radius.lg,
    backgroundColor: color.surface,
  },
  facts: {
    display: "grid",
    gridTemplateColumns: "max-content 1fr",
    columnGap: space.s6,
    rowGap: space.s2,
    margin: 0,
    fontSize: text.sm,
  },
  term: { color: color.textMuted },
  value: { margin: 0, minWidth: 0, overflowWrap: "anywhere" },
  mono: { fontFamily: font.mono },
  error: { margin: 0, color: color.dangerSubtleText, fontSize: text.sm, lineHeight: leading.snug },
  headline: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    justifyContent: "space-between",
    gap: space.s3,
  },
  headlineText: { display: "flex", flexDirection: "column", gap: space.s1, minWidth: 0 },
  headlineTitle: { margin: 0, fontSize: text.md, fontWeight: weight.semibold },
  note: { margin: 0, color: color.textMuted, fontSize: text.sm, lineHeight: leading.snug },
  /** Where Update and Update now go (#362), beside the link to GitHub. */
  actions: { display: "flex", flexWrap: "wrap", alignItems: "center", gap: space.s2 },
  link: {
    display: "inline-flex",
    alignItems: "center",
    gap: space.s1,
    color: color.text,
    fontSize: text.sm,
    fontWeight: weight.medium,
    textDecorationLine: "underline",
    textUnderlineOffset: "2px",
    textDecorationColor: color.borderStrong,
    whiteSpace: "nowrap",
  },
  release: {
    display: "flex",
    flexDirection: "column",
    gap: space.s3,
    paddingTop: space.s4,
    borderTopWidth: "1px",
    borderTopStyle: "solid",
    borderTopColor: color.border,
  },
  releaseTitle: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "baseline",
    gap: space.s2,
    margin: 0,
    fontSize: text.base,
    fontWeight: weight.semibold,
  },
  releaseDate: { color: color.textMuted, fontSize: text.sm, fontWeight: weight.normal },
  commits: {
    display: "flex",
    flexDirection: "column",
    gap: space.s1_5,
    margin: 0,
    padding: 0,
    listStyle: "none",
    fontSize: text.sm,
  },
  commit: { display: "flex", gap: space.s3, minWidth: 0 },
  sha: { flexShrink: 0, color: color.textMuted, fontFamily: font.mono },
  title: { minWidth: 0, overflowWrap: "anywhere" },
  loading: { display: "flex", alignItems: "center", gap: space.s2 },
})

export function HubPage() {
  const owner = useHubState((state) => state.owner)
  const update = useHubState((state) => state.hubUpdate)
  return (
    <main {...stylex.props(styles.view)}>
      {owner && update !== null ? (
        <Hub update={update} />
      ) : (
        <>
          <PageHeader title="Hub" />
          <EmptyState
            size="page"
            icon={<UpdateIcon />}
            {...(owner
              ? {
                  title: "This Hub doesn't check for updates",
                  description:
                    "Only a Hub that kndl's service runs from its install checks GitHub for a newer kndl. Update this one where it runs.",
                }
              : {
                  title: "Only the Hub's Owner sees this page",
                  description: "It says which kndl the Hub runs, and whether a newer one is out.",
                })}
          />
        </>
      )}
    </main>
  )
}

function Hub({ update }: { update: HubUpdateState }) {
  const hub = useHub()
  const version = useHubState((state) => state.hubVersion)
  const now = useNow(60_000)
  const [checking, setChecking] = useState(false)
  const { follows, checked, failed } = update
  // A failure older than the last check that worked is over.
  const failure = failed !== undefined && failed.at >= (checked?.at ?? 0) ? failed : undefined

  const checkNow = async () => {
    setChecking(true)
    try {
      const after = await hub.checkHubUpdate()
      if (after.failed !== undefined && after.failed.at >= (after.checked?.at ?? 0)) {
        toast.show({
          title: "Couldn't check for a newer kndl",
          description: after.failed.message,
          intent: "danger",
        })
      } else if (after.checked?.found._tag === "UpToDate") {
        toast.show({ title: "kndl is up to date", intent: "success" })
      }
    } catch (error) {
      toast.show({
        title: "Couldn't check for a newer kndl",
        description: messageOf(error),
        intent: "danger",
      })
    } finally {
      setChecking(false)
    }
  }

  return (
    <>
      <PageHeader
        title="Hub"
        description="The kndl this Hub runs, and whether a newer one is out on its Channel. The Hub checks GitHub every 6 hours."
        actions={
          follows._tag === "Channel" && (
            <Button
              size="sm"
              icon={<RestartIcon />}
              loading={checking}
              onClick={() => void checkNow()}
            >
              Check now
            </Button>
          )
        }
      />
      <div {...stylex.props(styles.scroll)}>
        <div {...stylex.props(styles.page)}>
          <section aria-labelledby="this-hub" {...stylex.props(styles.section)}>
            <h2 id="this-hub" {...stylex.props(styles.sectionTitle)}>
              This Hub
            </h2>
            <div {...stylex.props(styles.card)}>
              <dl {...stylex.props(styles.facts)}>
                <dt {...stylex.props(styles.term)}>Version</dt>
                <dd {...stylex.props(styles.value, styles.mono)}>
                  {versionText(version, follows)}
                </dd>
                <dt {...stylex.props(styles.term)}>Channel</dt>
                <dd {...stylex.props(styles.value)}>{followsText(follows)}</dd>
                {follows._tag === "Channel" && (
                  <>
                    <dt {...stylex.props(styles.term)}>Last checked</dt>
                    <dd {...stylex.props(styles.value)}>
                      {checked === undefined ? "Not yet" : timeAgo(checked.at, now)}
                    </dd>
                  </>
                )}
              </dl>
              {failure !== undefined && (
                <p role="alert" {...stylex.props(styles.error)}>
                  The check {timeAgo(failure.at, now)} failed: {failure.message}
                </p>
              )}
            </div>
          </section>
          <section aria-labelledby="update" {...stylex.props(styles.section)}>
            <h2 id="update" {...stylex.props(styles.sectionTitle)}>
              Update
            </h2>
            <div {...stylex.props(styles.card)}>
              {follows._tag === "Pinned" ? (
                <p {...stylex.props(styles.note)}>
                  This Hub is pinned to {follows.ref}, so no update is offered. To follow a Channel
                  again, run <code>kndl update --channel stable</code> on its machine.
                </p>
              ) : checked === undefined ? (
                failure === undefined ? (
                  <div {...stylex.props(styles.loading, styles.note)}>
                    <Spinner size="sm" /> Checking GitHub for a newer kndl…
                  </div>
                ) : (
                  <p {...stylex.props(styles.note)}>
                    The Hub couldn't tell whether a newer kndl is out. See the{" "}
                    <ExternalLink href="https://github.com/kddige/kndl/releases">
                      Releases on GitHub
                    </ExternalLink>
                    .
                  </p>
                )
              ) : (
                <Found found={checked.found} channel={follows.channel} />
              )}
            </div>
          </section>
        </div>
      </div>
    </>
  )
}

/** What the last check that worked found, with what changed. */
function Found({ found, channel }: { found: HubUpdateFound; channel: "stable" | "dev" }) {
  switch (found._tag) {
    case "UpToDate":
      return (
        <div {...stylex.props(styles.headlineText)}>
          <p {...stylex.props(styles.headlineTitle)}>kndl is up to date</p>
          <p {...stylex.props(styles.note)}>
            {channel === "stable"
              ? "This Hub runs the newest Release, or a commit no Release has reached yet."
              : "This Hub runs the head of main."}
          </p>
        </div>
      )
    case "NewerRelease": {
      const [newest] = found.releases
      const count = found.releases.length
      return (
        <>
          <Headline
            title={`kndl ${newest.version} is out`}
            note={
              count === 1
                ? "One Release is newer than this Hub's."
                : `${count} Releases are newer than this Hub's, newest first.`
            }
            href={found.compareUrl}
            link="Compare on GitHub"
          />
          {found.releases.map((release) => (
            <Release key={release.version} release={release} />
          ))}
        </>
      )
    }
    case "NewerCommits":
      return (
        <>
          <Headline
            title={`main is ${found.behindBy === 1 ? "1 commit" : `${found.behindBy} commits`} ahead`}
            note={
              found.behindBy > found.commits.length
                ? `The newest ${found.commits.length}, newest first.`
                : "Newest first."
            }
            href={found.compareUrl}
            link="Compare on GitHub"
          />
          <ul aria-label="Commits since this Hub's" {...stylex.props(styles.commits)}>
            {found.commits.map((commit) => (
              <Commit key={commit.commit} commit={commit} />
            ))}
          </ul>
          {found.behindBy > found.commits.length && (
            <p {...stylex.props(styles.note)}>
              And {found.behindBy - found.commits.length} more on GitHub.
            </p>
          )}
        </>
      )
  }
}

function Headline({
  title,
  note,
  href,
  link,
}: {
  title: string
  note: string
  href: string
  link: string
}) {
  return (
    <div {...stylex.props(styles.headline)}>
      <div {...stylex.props(styles.headlineText)}>
        <p {...stylex.props(styles.headlineTitle)}>{title}</p>
        <p {...stylex.props(styles.note)}>{note}</p>
      </div>
      <div {...stylex.props(styles.actions)}>
        <ExternalLink href={href}>{link}</ExternalLink>
      </div>
    </div>
  )
}

function Release({ release }: { release: ReleaseNotes }) {
  return (
    <article aria-label={release.version} {...stylex.props(styles.release)}>
      <h3 {...stylex.props(styles.releaseTitle)}>
        {release.version}
        {release.publishedAt !== undefined && (
          <span {...stylex.props(styles.releaseDate)}>{day(release.publishedAt)}</span>
        )}
        <Badge>Release</Badge>
        <ExternalLink href={release.url}>On GitHub</ExternalLink>
      </h3>
      {release.notes.trim() === "" ? (
        <p {...stylex.props(styles.note)}>It has no notes.</p>
      ) : (
        <Markdown text={release.notes} />
      )}
    </article>
  )
}

function Commit({ commit }: { commit: CommitTitle }) {
  return (
    <li {...stylex.props(styles.commit)}>
      <span {...stylex.props(styles.sha)}>{commit.commit.slice(0, 9)}</span>
      <span {...stylex.props(styles.title)}>{commit.title}</span>
    </li>
  )
}

function ExternalLink({ href, children }: { href: string; children: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      {...stylex.props(styles.link, focus.ring)}
    >
      {children}
      <ExternalLinkIcon aria-hidden="true" />
    </a>
  )
}

/** The time, updated every `ms`. */
function useNow(ms: number): number {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), ms)
    return () => clearInterval(timer)
  }, [ms])
  return now
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
