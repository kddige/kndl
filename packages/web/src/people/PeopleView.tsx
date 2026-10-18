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
  MenuItem,
  PeopleIcon,
  PlusIcon,
  SettingsList,
  SettingsLoading,
  SettingsPage,
  SettingsRow,
  SettingsSection,
  toast,
} from "../ui/index.ts"
import { color, font, leading, radius, space, text } from "../ui/tokens.stylex.ts"
import { inviteFor, inviteTimeLeft, readLogin, usableInvites } from "./people.ts"

const styles = stylex.create({
  note: { margin: 0, color: color.textSecondary, fontSize: text.sm, lineHeight: leading.snug },
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
  error: { margin: 0, color: color.dangerText, fontSize: text.sm, lineHeight: leading.snug },
})

export function PeopleView() {
  const owner = useHubState((state) => state.owner)
  return owner ? (
    <People />
  ) : (
    <SettingsPage title="People">
      <EmptyState
        size="page"
        icon={<PeopleIcon />}
        title="Only the Hub's Owner manages people"
        description="This Hub is invite-only, and its Owner invites everyone who signs in. Ask them to invite someone."
      />
    </SettingsPage>
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
    <SettingsPage
      title="People"
      description="Members of this Hub, and open Invites."
      action={
        <Button intent="primary" size="sm" icon={<PlusIcon />} onClick={() => setInviting(true)}>
          Invite someone
        </Button>
      }
    >
      <SettingsSection title="Members">
        {members === null ? (
          <SettingsLoading label="Loading Members" />
        ) : (
          <SettingsList label="Members">
            {members.map((member) => (
              <MemberRow
                key={member.participant.id}
                member={member}
                you={member.participant.id === you?.id}
                now={now}
                onRemove={() => setRemoving(member)}
              />
            ))}
          </SettingsList>
        )}
      </SettingsSection>
      {pending.length > 0 && (
        <SettingsSection title="Invites not used yet">
          <SettingsList label="Invites not used yet">
            {pending.map((invite) => (
              <InviteRow key={invite.id} invite={invite} now={now} />
            ))}
          </SettingsList>
        </SettingsSection>
      )}
      <InviteDialog open={inviting} onClose={() => setInviting(false)} />
      <RemoveDialog member={removing} onClose={() => setRemoving(null)} />
    </SettingsPage>
  )
}

function MemberRow({
  member,
  you,
  now,
  onRemove,
}: {
  member: Member
  you: boolean
  now: number
  onRemove: () => void
}) {
  const { participant } = member
  return (
    <SettingsRow
      label={participant.name}
      icon={<Avatar name={participant.name} src={participant.avatarUrl} size="sm" />}
      name={participant.name}
      meta={[`@${participant.login}`, `Admitted ${timeAgo(member.admittedAt, now)}`]}
      badges={
        (member.owner || you) && (
          <>
            {member.owner && <Badge>Owner</Badge>}
            {you && <Badge>You</Badge>}
          </>
        )
      }
      // The Owner can't be removed.
      {...(!member.owner && {
        menu: (
          <MenuItem intent="danger" onClick={onRemove}>
            Remove {participant.name}
          </MenuItem>
        ),
      })}
    />
  )
}

function InviteRow({ invite, now }: { invite: PendingInvite; now: number }) {
  const hub = useHub()
  const what = inviteFor(invite)
  const revoke = async () => {
    try {
      await hub.revokeInvite(invite.id)
      toast.show({ title: "Invite revoked" })
    } catch (error) {
      toast.show({
        title: "Couldn't revoke the Invite",
        description: messageOf(error),
        intent: "danger",
      })
    }
  }
  return (
    <SettingsRow
      label={what}
      name={what}
      meta={[
        `Made by ${invite.createdBy.name} ${timeAgo(invite.createdAt, now)}`,
        `Expires in ${inviteTimeLeft(invite.expiresAt, now)}`,
      ]}
      menu={
        <MenuItem intent="danger" onClick={() => void revoke()}>
          Revoke the Invite
        </MenuItem>
      }
    />
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
    toast.show({ title: "Link copied" })
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
