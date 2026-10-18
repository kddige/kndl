// The People page (issue #209, ADR 0019): who can sign in to the Hub, which is invite-only. Only its
// Owner has it, and the Hub refuses its commands from anyone else. The Owner invites someone here,
// for whoever they send the link to or for one GitHub login, copies the link while the dialog shows
// it (the only time it is shown), and revokes an Invite not used yet. They remove a Member here
// too: that signs them out everywhere at once, and they need a new Invite to get back in. Every
// confirmation is a Dialog on the page.

import type { InviteCreated, Member, PendingInvite } from "@kndl/protocol"
import * as stylex from "@stylexjs/stylex"
import { type FormEvent, useEffect, useState } from "react"
import { timeAgo } from "../app/format.ts"
import { useHub, useHubState } from "../app/hub.tsx"
import {
  Avatar,
  Badge,
  Button,
  CopyIcon,
  Dialog,
  DialogClose,
  EmptyState,
  Field,
  IconButton,
  Input,
  PageHeader,
  PeopleIcon,
  PlusIcon,
  Spinner,
  toast,
  textRole,
} from "../ui/index.ts"
import { color, font, leading, radius, space, text, weight } from "../ui/tokens.stylex.ts"
import { inviteFor, inviteTimeLeft, readLogin, usableInvites } from "./people.ts"

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
  sectionTitle: { margin: 0 },
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
  row: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: space.s3,
    paddingBlock: space.s3,
    paddingInline: space.s4,
    borderTopWidth: "1px",
    borderTopStyle: "solid",
    borderTopColor: color.border,
  },
  firstRow: { borderTopWidth: 0 },
  main: { display: "flex", flexDirection: "column", gap: space.s1, flex: 1, minWidth: "12rem" },
  nameLine: { display: "flex", alignItems: "center", gap: space.s2, flexWrap: "wrap" },
  name: { fontSize: text.md, fontWeight: weight.semibold, overflowWrap: "anywhere" },
  facts: {
    display: "flex",
    flexWrap: "wrap",
    columnGap: space.s3,
    rowGap: space.s1,
    margin: 0,
    color: color.textMuted,
    fontSize: text.sm,
  },
  note: { margin: 0, color: color.textMuted, fontSize: text.sm, lineHeight: leading.snug },
  form: { display: "flex", flexDirection: "column", gap: space.s3 },
  link: {
    display: "flex",
    alignItems: "flex-start",
    gap: space.s2,
    paddingBlock: space.s2,
    paddingInlineStart: space.s3,
    paddingInlineEnd: space.s1,
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: color.border,
    borderRadius: radius.md,
    backgroundColor: color.surfaceMuted,
  },
  linkText: {
    flex: 1,
    minWidth: 0,
    paddingBlock: space.s1,
    fontFamily: font.mono,
    fontSize: text.sm,
    lineHeight: leading.snug,
    overflowWrap: "anywhere",
    userSelect: "all",
  },
  error: { margin: 0, color: color.dangerSubtleText, fontSize: text.sm, lineHeight: leading.snug },
  loading: { display: "grid", placeItems: "center", paddingBlock: space.s16 },
})

export function PeopleView() {
  const owner = useHubState((state) => state.owner)
  return (
    <main {...stylex.props(styles.view)}>
      {owner ? (
        <People />
      ) : (
        <>
          <PageHeader title="People" />
          <EmptyState
            size="page"
            icon={<PeopleIcon />}
            title="Only the Hub's Owner manages people"
            description="This Hub is invite-only, and its Owner invites everyone who signs in. Ask them to invite someone."
          />
        </>
      )}
    </main>
  )
}

/** The Owner's page: asks the Hub for the Members and Invites, which it keeps sending as they change. */
function People() {
  const hub = useHub()
  const members = useHubState((state) => state.members)
  const invites = useHubState((state) => state.invites)
  const you = useHubState((state) => state.you)
  const now = useNow(60_000)
  const [inviting, setInviting] = useState(false)
  const [removing, setRemoving] = useState<Member | null>(null)

  useEffect(() => {
    const failed = (error: unknown) =>
      toast.show({
        title: "Couldn't load the People page",
        description: messageOf(error),
        intent: "danger",
      })
    hub.listMembers().catch(failed)
    hub.listInvites().catch(failed)
  }, [hub])

  const pending = usableInvites(invites, now)
  return (
    <>
      <PageHeader
        title="People"
        description="Who can sign in to this Hub. It is invite-only: GitHub sign-in turns away anyone who isn't a Member and brings no Invite."
        actions={
          <Button intent="primary" size="sm" icon={<PlusIcon />} onClick={() => setInviting(true)}>
            Invite someone
          </Button>
        }
      />
      <div {...stylex.props(styles.scroll)}>
        <div {...stylex.props(styles.page)}>
          {members === null ? (
            <div {...stylex.props(styles.loading)}>
              <Spinner size="lg" label="Loading Members" />
            </div>
          ) : (
            <section aria-labelledby="members" {...stylex.props(styles.section)}>
              <h2 id="members" {...stylex.props(textRole.overline, styles.sectionTitle)}>
                Members
              </h2>
              <ul aria-label="Members" {...stylex.props(styles.list)}>
                {members.map((member, index) => (
                  <MemberRow
                    key={member.participant.id}
                    member={member}
                    you={member.participant.id === you?.id}
                    first={index === 0}
                    now={now}
                    onRemove={() => setRemoving(member)}
                  />
                ))}
              </ul>
            </section>
          )}
          {pending.length > 0 && (
            <section aria-labelledby="invites" {...stylex.props(styles.section)}>
              <h2 id="invites" {...stylex.props(textRole.overline, styles.sectionTitle)}>
                Invites not used yet
              </h2>
              <ul aria-label="Invites not used yet" {...stylex.props(styles.list)}>
                {pending.map((invite, index) => (
                  <InviteRow key={invite.id} invite={invite} first={index === 0} now={now} />
                ))}
              </ul>
            </section>
          )}
        </div>
      </div>
      <InviteDialog open={inviting} onClose={() => setInviting(false)} />
      <RemoveDialog member={removing} onClose={() => setRemoving(null)} />
    </>
  )
}

function MemberRow({
  member,
  you,
  first,
  now,
  onRemove,
}: {
  member: Member
  you: boolean
  first: boolean
  now: number
  onRemove: () => void
}) {
  const { participant } = member
  return (
    <li aria-label={participant.name} {...stylex.props(styles.row, first && styles.firstRow)}>
      <Avatar name={participant.name} src={participant.avatarUrl} size="md" />
      <div {...stylex.props(styles.main)}>
        <div {...stylex.props(styles.nameLine)}>
          <span {...stylex.props(styles.name)}>{participant.name}</span>
          {member.owner && <Badge intent="accent">Owner</Badge>}
          {you && <Badge>You</Badge>}
        </div>
        <p {...stylex.props(styles.facts)}>
          <span>@{participant.login}</span>
          <span>Admitted {timeAgo(member.admittedAt, now)}</span>
        </p>
      </div>
      {!member.owner && (
        <Button
          size="sm"
          intent="ghost"
          aria-label={`Remove ${participant.name}`}
          onClick={onRemove}
        >
          Remove
        </Button>
      )}
    </li>
  )
}

function InviteRow({ invite, first, now }: { invite: PendingInvite; first: boolean; now: number }) {
  const hub = useHub()
  const [busy, setBusy] = useState(false)
  const what = inviteFor(invite)
  const revoke = async () => {
    setBusy(true)
    try {
      await hub.revokeInvite(invite.id)
      toast.show({ title: "Invite revoked" })
    } catch (error) {
      toast.show({
        title: "Couldn't revoke the Invite",
        description: messageOf(error),
        intent: "danger",
      })
      setBusy(false)
    }
  }
  return (
    <li aria-label={what} {...stylex.props(styles.row, first && styles.firstRow)}>
      <div {...stylex.props(styles.main)}>
        <span {...stylex.props(styles.name)}>{what}</span>
        <p {...stylex.props(styles.facts)}>
          <span>
            Made by {invite.createdBy.name} {timeAgo(invite.createdAt, now)}
          </span>
          <span>Expires in {inviteTimeLeft(invite.expiresAt, now)}</span>
        </p>
      </div>
      <Button
        size="sm"
        intent="ghost"
        loading={busy}
        aria-label={`Revoke the Invite for ${what === "Anyone with the link" ? "anyone with the link" : what}`}
        onClick={() => void revoke()}
      >
        Revoke
      </Button>
    </li>
  )
}

/**
 * Makes an Invite: for whoever gets the link, or for one GitHub login. Then it shows the link, the
 * only time it is shown; closing it leaves the Invite listed on the page, to revoke.
 */
function InviteDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const hub = useHub()
  const [login, setLogin] = useState("")
  const [created, setCreated] = useState<InviteCreated | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    if (!open) return
    setLogin("")
    setCreated(null)
    setBusy(false)
    setError(null)
  }, [open])

  const read = readLogin(login)
  const invalid = "error" in read
  const create = async (event?: FormEvent) => {
    event?.preventDefault()
    if ("error" in read) return
    setBusy(true)
    setError(null)
    try {
      setCreated(await hub.createInvite(read.login))
    } catch (cause) {
      setError(messageOf(cause))
    }
    setBusy(false)
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose()
      }}
      title={created ? "Send this link" : "Invite someone"}
      description={
        created
          ? `${created.login === undefined ? "Whoever opens it" : `Only @${created.login}`} signs in with GitHub and becomes a Member.`
          : "A link that lets one person in, once, within a week. Send it to them yourself."
      }
      footer={
        created ? (
          <DialogClose>Done</DialogClose>
        ) : (
          <>
            <DialogClose>Cancel</DialogClose>
            <Button
              intent="primary"
              loading={busy}
              disabled={"error" in read}
              onClick={() => void create()}
            >
              Make the link
            </Button>
          </>
        )
      }
    >
      {created ? (
        <div {...stylex.props(styles.form)}>
          <div {...stylex.props(styles.link)}>
            <code aria-label="Invite link" {...stylex.props(styles.linkText)}>
              {created.link}
            </code>
            <IconButton label="Copy link" size="sm" onClick={() => void copyLink(created.link)}>
              <CopyIcon />
            </IconButton>
          </div>
          <p {...stylex.props(styles.note)}>
            The link is shown only here. Anyone with it can use it
            {created.login === undefined ? "" : ` while signed in to GitHub as @${created.login}`},
            so send it only to whoever you're inviting.
          </p>
        </div>
      ) : (
        <form onSubmit={(event) => void create(event)} {...stylex.props(styles.form)}>
          <Field
            label="GitHub login (optional)"
            description="Only this GitHub account can use the link. Leave it empty for whoever you send it to."
            invalid={invalid}
            error={"error" in read ? read.error : undefined}
          >
            <Input
              value={login}
              onValueChange={(value: string) => setLogin(value)}
              placeholder="octocat"
              autoComplete="off"
              spellCheck={false}
            />
          </Field>
          {error && (
            <p role="alert" {...stylex.props(styles.error)}>
              {error}
            </p>
          )}
        </form>
      )}
    </Dialog>
  )
}

/** Copies an Invite's link, and says whether it could. */
async function copyLink(link: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(link)
    toast.show({ title: "Copied the link" })
  } catch {
    toast.show({
      title: "Couldn't copy",
      description: "Select the link and copy it yourself.",
      intent: "warning",
    })
  }
}

/** Removes a Member once it's confirmed. */
function RemoveDialog({ member, onClose }: { member: Member | null; onClose: () => void }) {
  const hub = useHub()
  const shown = useLastOpened(member)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    setBusy(false)
    setError(null)
  }, [member])

  const name = shown?.participant.name ?? ""
  const remove = async () => {
    if (!shown) return
    setBusy(true)
    setError(null)
    try {
      await hub.removeMember(shown.participant.id)
      toast.show({ title: `Removed ${name}` })
      onClose()
    } catch (cause) {
      setError(messageOf(cause))
      setBusy(false)
    }
  }

  return (
    <Dialog
      size="sm"
      open={member !== null}
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
      title={`Remove ${name}?`}
      description="They're signed out everywhere at once, and their CLI tokens stop working. They can't sign in again without a new Invite. Their Sessions, and the Claude credential they stored, stay."
      footer={
        <>
          <DialogClose>Cancel</DialogClose>
          <Button intent="danger" loading={busy} onClick={() => void remove()}>
            Remove
          </Button>
        </>
      }
    >
      {error && (
        <p role="alert" {...stylex.props(styles.error)}>
          {error}
        </p>
      )}
    </Dialog>
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

/** `value`, or while it is null (a dialog closing), the last value it wasn't. */
function useLastOpened<T>(value: T | null): T | null {
  const [last, setLast] = useState(value)
  if (value !== null && value !== last) setLast(value)
  return value ?? last
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
