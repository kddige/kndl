// The Account page's Live voice (ADR 0033): which live voice Model the person talks to their
// Sessions with, and its voice. It runs on their own Connected provider for its Provider.

import {
  defaultLiveVoice,
  type LiveVoiceSetting,
  LiveVoiceModels,
  liveVoiceModel,
  liveVoiceOf,
} from "@kndl/protocol"
import { useState } from "react"
import { useHub, useHubState } from "../app/hub.tsx"
import { PropertyRow, Select, SettingsList, SettingsSection, toast } from "../ui/index.ts"

const providerNames = { openai: "OpenAI" } as const

export function LiveVoiceSection() {
  const hub = useHub()
  const providers = useHubState((state) => state.providers)
  // Shown as chosen until the Hub answers; a refusal shows what is saved again.
  const [choosing, setChoosing] = useState<LiveVoiceSetting | null>(null)
  if (providers === null || providers === undefined) return null
  const saved = providers.liveVoice ?? defaultLiveVoice
  const shown = choosing ?? saved
  const model = liveVoiceModel(shown.model) ?? LiveVoiceModels[0]
  const connected =
    model !== undefined && providers.connected.some((c) => c.provider === model.provider)
  const choose = (setting: LiveVoiceSetting) => {
    setChoosing(setting)
    hub.setLiveVoice(setting).then(
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
  return (
    <SettingsSection
      title="Live voice"
      note={
        model === undefined
          ? undefined
          : connected
            ? `Press Talk in a Session you drive to talk with it. The voice runs on your ${providerNames[model.provider]} connection, and passes what you ask to the Session's agent.`
            : `Connect ${providerNames[model.provider]} above to talk with your Sessions.`
      }
    >
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
              label: `${option.label} (${providerNames[option.provider]})`,
            }))}
            value={shown.model}
            onValueChange={(name) => choose({ model: name })}
          />
        </PropertyRow>
        {model !== undefined && (
          <PropertyRow label="Voice" description="Changes apply from your next call.">
            <Select
              aria-label="Live voice"
              size="sm"
              options={model.voices.map((voice) => ({
                value: voice,
                label: voice === model.voices[0] ? `${voice} (default)` : voice,
              }))}
              value={liveVoiceOf(shown)}
              onValueChange={(voice) => choose({ model: model.name, voice })}
            />
          </PropertyRow>
        )}
      </SettingsList>
    </SettingsSection>
  )
}
