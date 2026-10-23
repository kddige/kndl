// The Account page's Live voice (ADR 0033): which live voice Model the person talks to their
// Sessions with, and its voice. It runs on their own Connected provider for its Provider.

import {
  type LiveVoiceSetting,
  LiveVoiceModels,
  liveVoiceModelFor,
  liveVoiceOf,
} from "@kndl/protocol"
import { useState } from "react"
import { useHub, useHubState } from "../app/hub.tsx"
import { PropertyRow, Select, SettingsList, SettingsSection, toast } from "../ui/index.ts"

/** How each live voice Model is reached, as the person connects OpenAI. */
const connectionNames = { SignIn: "a ChatGPT sign-in", ApiKey: "an OpenAI API key" } as const

export function LiveVoiceSection() {
  const hub = useHub()
  const providers = useHubState((state) => state.providers)
  // Shown as chosen until the Hub answers; a refusal shows what is saved again.
  const [choosing, setChoosing] = useState<LiveVoiceSetting | null>(null)
  if (providers === null || providers === undefined) return null
  const connection = providers.connected.find((c) => c.provider === "openai")?.kind
  const setting = choosing ?? providers.liveVoice
  // Until they choose, the one for how they connected OpenAI.
  const model = liveVoiceModelFor(setting, connection)
  const choose = (next: LiveVoiceSetting) => {
    setChoosing(next)
    hub.setLiveVoice(next).then(
      () => setChoosing(null),
      (cause: unknown) => {
        setChoosing(null)
        toast.show({
          title: "Couldn't change your live voice",
          description: cause instanceof Error ? cause.message : String(cause),
          intent: "warning",
        })
      },
    )
  }
  const note =
    connection === undefined
      ? "Connect OpenAI above, with ChatGPT or an API key, to talk with your Sessions."
      : model.connection !== connection
        ? `${model.label} needs ${connectionNames[model.connection]}, and you connected OpenAI with ${connectionNames[connection]}: pick the other Model.`
        : "Press Talk in a Session you drive to talk with it. The voice passes what you ask to the Session's agent, and says what it did."
  return (
    <SettingsSection title="Live voice" note={note}>
      <SettingsList label="Live voice settings">
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
