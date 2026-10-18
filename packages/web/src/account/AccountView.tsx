// The signed-in person's own settings: their Providers (Providers.tsx), first among them their
// Claude credential (Claude.tsx), and their CLI tokens (issue #179): a machine each that
// `kndl login` signed in, to revoke.

import type { CliTokenInfo } from "@kndl/protocol"
import * as stylex from "@stylexjs/stylex"
import { useState } from "react"
import { copyCommand } from "../app/copy.ts"
import { day, timeAgo } from "../app/format.ts"
import { useHub, useHubState } from "../app/hub.tsx"
import {
  Button,
  CopyIcon,
  Dialog,
  DialogClose,
  IconButton,
  MenuItem,
  ServerIcon,
  SettingsEmpty,
  SettingsList,
  SettingsLoading,
  SettingsPage,
  SettingsRow,
  SettingsSection,
  toast,
} from "../ui/index.ts"
import { color, font, leading, radius, space, text } from "../ui/tokens.stylex.ts"
import { ProvidersSection } from "./Providers.tsx"

const styles = stylex.create({
  machine: { fontFamily: font.mono },
  error: { margin: 0, color: color.dangerText, fontSize: text.sm, lineHeight: leading.snug },
  commandRow: {
    display: "flex",
    alignItems: "center",
    gap: space.s2,
    paddingBlock: space.s1,
    paddingInlineStart: space.s3,
    paddingInlineEnd: space.s1,
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: color.border,
    borderRadius: radius.md,
    backgroundColor: color.surfaceMuted,
  },
  commandText: {
    flex: 1,
    minWidth: 0,
    fontFamily: font.mono,
    fontSize: text.sm,
    lineHeight: leading.snug,
    overflowWrap: "anywhere",
    userSelect: "all",
  },
})

export function AccountView() {
  const you = useHubState((state) => state.you)
  return (
    <SettingsPage
      title="Account"
      description={
        you ? `Signed in as ${you.name} (@${you.login}).` : "Your own settings on this Hub."
      }
    >
      <ProvidersSection />
      <CliTokensSection />
    </SettingsPage>
  )
}

/** The machines `kndl login` signed in as this person, newest first, to revoke. */
function CliTokensSection() {
  const tokens = useHubState((state) => state.cliTokens)
  const [revoking, setRevoking] = useState<CliTokenInfo | null>(null)
  const command = `kndl login ${window.location.origin}`

  return (
    <SettingsSection
      title="CLI tokens"
      note="Each machine where you signed the kndl CLI in to this Hub, to act as you. Revoking one signs that machine out at once."
    >
      {tokens === null ? (
        <SettingsLoading label="Loading your CLI tokens" rows={2} />
      ) : tokens.length === 0 ? (
        <SettingsEmpty
          title="No CLI tokens yet"
          description="To sign the CLI in on a machine, run this there and approve it in the browser:"
        >
          <div {...stylex.props(styles.commandRow)}>
            <code aria-label="Sign-in command" {...stylex.props(styles.commandText)}>
              {command}
            </code>
            <IconButton label="Copy command" size="sm" onClick={() => void copyCommand(command)}>
              <CopyIcon />
            </IconButton>
          </div>
        </SettingsEmpty>
      ) : (
        <SettingsList label="Your CLI tokens">
          {tokens.map((token) => (
            <SettingsRow
              key={token.id}
              label={token.machine}
              icon={<ServerIcon />}
              name={
                <span title={token.machine} {...stylex.props(styles.machine)}>
                  {token.machine}
                </span>
              }
              meta={[
                `Signed in ${day(token.createdAt)}`,
                token.lastUsedAt === undefined
                  ? "never used"
                  : `last used ${timeAgo(token.lastUsedAt)}`,
              ]}
              menu={
                <MenuItem intent="danger" onClick={() => setRevoking(token)}>
                  Revoke {token.machine}'s token
                </MenuItem>
              }
            />
          ))}
        </SettingsList>
      )}
      <RevokeCliTokenDialog token={revoking} onClose={() => setRevoking(null)} />
    </SettingsSection>
  )
}

function RevokeCliTokenDialog({
  token,
  onClose,
}: {
  token: CliTokenInfo | null
  onClose: () => void
}) {
  const hub = useHub()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Kept while the dialog closes, so its text doesn't empty as it fades.
  const [shown, setShown] = useState<CliTokenInfo | null>(token)
  if (token !== null && token !== shown) setShown(token)

  const revoke = async () => {
    if (token === null) return
    setBusy(true)
    setError(null)
    try {
      await hub.revokeCliToken(token.id)
      toast.show({ title: `Revoked the CLI token for ${token.machine}` })
      onClose()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      size="sm"
      open={token !== null}
      onOpenChange={(next) => {
        if (!next) {
          setError(null)
          onClose()
        }
      }}
      title={`Revoke the CLI token for ${shown?.machine ?? "this machine"}?`}
      description="kndl there is signed out at once: its next request is refused, a forwarded port's next connection too. Run kndl login there to sign it in again."
      footer={
        <>
          <DialogClose>Cancel</DialogClose>
          <Button intent="danger" loading={busy} onClick={() => void revoke()}>
            Revoke
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
