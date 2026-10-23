// The Account page's Live voice (ADR 0033): the live voice connection, the Codex CLI's ChatGPT
// sign-in, kept apart from the Connected providers above since GPT-Live refuses kndl's own ChatGPT
// sign-in; and which live voice Model the person talks to their Sessions with, and its voice.

import {
  type LiveVoiceCredential,
  type LiveVoiceSetting,
  LiveVoiceModels,
  liveVoiceModelFor,
  liveVoiceOf,
} from "@kndl/protocol"
import { useState } from "react"
import { useHub, useHubState } from "../app/hub.tsx"
import {
  Button,
  MenuItem,
  PropertyRow,
  Select,
  SettingsList,
  SettingsRow,
  SettingsSection,
  toast,
} from "../ui/index.ts"
import { SignInSteps } from "./Providers.tsx"

const messageOf = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause))

/** What each live voice Model needs, in words. */
const needs: Record<LiveVoiceCredential, string> = {
  Codex: "the ChatGPT (Codex) sign-in above",
  ApiKey: "an OpenAI API key, connected under Providers",
}

const day = (at: number) => new Date(at).toLocaleDateString(undefined, { dateStyle: "medium" })

export function LiveVoiceSection() {
  const hub = useHub()
  const providers = useHubState((state) => state.providers)
  const signIn = useHubState((state) => (state.signIn?.for === "LiveVoice" ? state.signIn : null))
  // Shown as chosen until the Hub answers; a refusal shows what is saved again.
  const [choosing, setChoosing] = useState<LiveVoiceSetting | null>(null)
  if (providers === null || providers === undefined) return null
  const connection = providers.liveVoiceConnection
  const keyed = providers.connected.some((c) => c.provider === "openai" && c.kind === "ApiKey")
  const has: Array<LiveVoiceCredential> = [
    ...(connection !== undefined ? (["Codex"] as const) : []),
    ...(keyed ? (["ApiKey"] as const) : []),
  ]
  const setting = choosing ?? providers.liveVoice
  // Until they choose, the first they have.
  const model = liveVoiceModelFor(setting, has)
  const running = signIn !== null && signIn.ended === null

  const choose = (next: LiveVoiceSetting) => {
    setChoosing(next)
    hub.setLiveVoice(next).then(
      () => setChoosing(null),
      (cause: unknown) => {
        setChoosing(null)
        toast.show({
          title: "Couldn't change your live voice",
          description: messageOf(cause),
          intent: "warning",
        })
      },
    )
  }
  const signInWithCodex = () => {
    hub.clearSignIn()
    hub.startSignIn("openai", "LiveVoice").then(
      (ended) => {
        if (ended.outcome !== "Connected") return
        hub.clearSignIn(ended.requestId)
        toast.show({ title: "Live voice connected" })
      },
      (cause: unknown) =>
        toast.show({ title: "Couldn't sign in", description: messageOf(cause), intent: "warning" }),
    )
  }
  const disconnect = () => {
    hub.disconnectLiveVoice().catch((cause: unknown) =>
      toast.show({
        title: "Couldn't disconnect live voice",
        description: messageOf(cause),
        intent: "warning",
      }),
    )
  }

  return (
    <SettingsSection
      title="Live voice"
      note={
        has.includes(model.connection)
          ? "Press Talk in a Session you drive to talk with it. The voice passes what you ask to the Session's agent, and says what it did."
          : `${model.label} needs ${needs[model.connection]}.`
      }
    >
      <SettingsList label="Live voice settings">
        <SettingsRow
          label="ChatGPT (Codex)"
          name="ChatGPT (Codex)"
          meta={
            connection === undefined
              ? "GPT-Live on your ChatGPT plan. Your OpenAI sign-in above can't start it, so this signs in the way the Codex CLI does, for live voice alone. Unofficial: OpenAI may stop it."
              : [connection.label, `Connected ${day(connection.connectedAt)}`]
          }
          action={
            connection === undefined && !running ? (
              <Button size="sm" onClick={signInWithCodex}>
                Sign in with ChatGPT
              </Button>
            ) : undefined
          }
          {...(connection !== undefined && {
            menu: (
              <>
                <MenuItem onClick={signInWithCodex}>Sign in again</MenuItem>
                <MenuItem intent="danger" onClick={disconnect}>
                  Disconnect live voice
                </MenuItem>
              </>
            ),
          })}
          notes={
            signIn?.ended?.outcome === "Failed" && (
              <p role="status">Sign-in failed: {signIn.ended.message}</p>
            )
          }
          detail={running && <SignInSteps name="ChatGPT" signIn={signIn} />}
        />
        <PropertyRow
          label="Model"
          description="What holds the spoken conversation. Your Session's own Model does the work."
        >
          <Select
            aria-label="Live voice Model"
            size="sm"
            options={LiveVoiceModels.map((option) => ({
              value: option.name,
              label: option.label,
            }))}
            value={model.name}
            onValueChange={(name) => choose({ model: name })}
          />
        </PropertyRow>
        <PropertyRow label="Voice" description="Changes apply from your next call.">
          <Select
            aria-label="Live voice"
            size="sm"
            options={model.voices.map((voice) => ({
              value: voice,
              label: voice === model.voices[0] ? `${voice} (default)` : voice,
            }))}
            value={liveVoiceOf(model, setting)}
            onValueChange={(voice) => choose({ model: model.name, voice })}
          />
        </PropertyRow>
      </SettingsList>
    </SettingsSection>
  )
}
