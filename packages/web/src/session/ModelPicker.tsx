import {
  type ConnectableProvider,
  findModel,
  findProviderModel,
  harnessOfModel,
  type ProviderModel,
  providerModelName,
  type RunnerModels,
  takesThinkingLevel,
  type ThinkingLevel,
} from "@kndl/protocol"
import * as stylex from "@stylexjs/stylex"
import { useState } from "react"
import {
  Button,
  ChevronDownIcon,
  type MenuSide,
  Popover,
  SearchSelect,
  type SearchSelectGroup,
  Slider,
} from "../ui/index.ts"
import { color, space, text, weight } from "../ui/tokens.stylex.ts"
import {
  groupByProvider,
  harnessNames,
  type ModelSetting,
  modelName,
  modelOf,
  providerGroupLabel,
  providerModelLabel,
  providerModelOf,
  thinkingLevelNames,
  thinkingLevelNotes,
  thinkingLevelsOf,
} from "./models.ts"

const styles = stylex.create({
  pickers: {
    display: "inline-flex",
    alignItems: "center",
    gap: space.s1,
    minWidth: 0,
  },
  fieldPickers: {
    alignSelf: "flex-start",
    gap: space.s2,
  },
  popup: {
    width: "15rem",
    maxWidth: "calc(100vw - 2rem)",
  },
  reset: {
    alignSelf: "flex-start",
  },
  label: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  trigger: {
    minWidth: 0,
    maxWidth: "100%",
    gap: space.s1,
  },
  thinkingTrigger: {
    flexShrink: 0,
  },
  // The setting as someone watching sees it: the pickers' labels, as text.
  shown: {
    display: "inline-flex",
    alignItems: "center",
    gap: space.s1,
    minWidth: 0,
    paddingInline: space.s2,
    color: color.textMuted,
    fontSize: text.sm,
    fontWeight: weight.medium,
  },
})

/**
 * The value of Claude Code's `Default` row: no model set, Claude Code's default. Parentheses are
 * in no model name, so it is no alias's.
 */
const defaultRow = "(default)"

/** `bar`: quiet buttons in the composer's bar. `field`: bordered ones, in a form. */
type Appearance = "bar" | "field"

/** A picker button's size and intent, for where it is. */
const look = (appearance: Appearance) =>
  appearance === "bar"
    ? ({ size: "sm", intent: "ghost" } as const)
    : ({ size: "md", intent: "secondary" } as const)

export interface ModelPickerProps {
  /**
   * Claude Code's models, when the Session can run on it: its Runner runs Claude Code, and its
   * Creator has a Claude credential. `models` is undefined until the Runner has said them, when
   * only Claude Code's default is offered.
   */
  readonly claudeCode?: { readonly models: RunnerModels | undefined }
  /**
   * The Creator's Models through pi, when its Runner runs pi (ADR 0029), from their
   * ProvidersState: undefined until the Hub has sent it. Each Provider's group is headed by the
   * name the Hub gives it in `connectable`.
   */
  readonly pi?: {
    readonly models: ReadonlyArray<ProviderModel> | undefined
    readonly connectable?: ReadonlyArray<ConnectableProvider> | undefined
  }
  /** The setting: a `provider/id` model is pi's, anything else Claude Code's (ADR 0030). */
  value: ModelSetting
  onChange: (setting: ModelSetting) => void
  disabled?: boolean
  /** Which way the lists open: up, from the composer at the bottom of the page. */
  side?: MenuSide
  appearance?: Appearance
}

/**
 * The model a Session runs and its thinking level, as two small buttons side by side, as claude.ai
 * and ChatGPT pick them (#128): one named by the model opens the models, the other named by the
 * level opens a slider over the levels it takes, and is left out for a model that takes none.
 *
 * One list for every Session (ADR 0030), grouped by what runs each model: Claude Code's, from its
 * Runner, then Claude's through pi, then each other Provider's, valued as `openai/gpt-6-sol`. A
 * Provider can list hundreds (OpenRouter), so it opens with a search. Picking another Harness's
 * model is allowed: the Session switches Harness with a handoff, which its caller says first.
 */
export function ModelPicker({
  claudeCode,
  pi,
  value,
  onChange,
  disabled = false,
  side = "bottom",
  appearance = "bar",
}: ModelPickerProps) {
  const runnerModels = claudeCode?.models
  const providerModels = pi?.models
  const harness = harnessOfModel(value.model)
  const onPi = harness === "Pi"
  const runnerModel = onPi ? undefined : modelOf(runnerModels, value)
  const providerModel = onPi ? providerModelOf(providerModels, value) : undefined
  // A model that isn't listed takes no level here: the Hub would refuse one for it.
  const levels = onPi
    ? (providerModel?.thinkingLevels ?? [])
    : runnerModel?.reasoning === true
      ? thinkingLevelsOf(runnerModels)
      : []
  const name = onPi ? providerModelLabel(providerModels, value) : modelName(runnerModels, value)

  const groups: Array<SearchSelectGroup> = [
    ...(claudeCode === undefined
      ? []
      : [
          {
            label: providerGroupLabel("anthropic", "ClaudeCode"),
            options: [
              {
                value: defaultRow,
                label:
                  runnerModels === undefined
                    ? "Default"
                    : `Default · ${runnerModels.default.label}`,
              },
              ...(runnerModels?.models ?? []).map((option) => ({
                value: option.alias,
                label: option.label,
                keywords: `${option.alias} ${option.id}`,
              })),
            ],
          },
        ]),
    ...groupByProvider(providerModels ?? []).map((group) => ({
      label: providerGroupLabel(group.provider, "Pi", pi?.connectable),
      options: group.models.map((model) => ({
        value: providerModelName(model),
        label: model.label,
        keywords: model.id,
      })),
    })),
  ]
  const picked = onPi
    ? providerModel && providerModelName(providerModel)
    : value.model === undefined
      ? defaultRow
      : (runnerModel?.alias ?? value.model)

  // A level the model picked doesn't take is dropped: the Hub refuses it with one.
  const chooseModel = (row: string) => {
    const level = value.thinkingLevel
    let takesLevel: boolean
    if (row !== defaultRow && harnessOfModel(row) === "Pi") {
      const model = providerModels && findProviderModel(providerModels, row)
      takesLevel = level !== undefined && model !== undefined && takesThinkingLevel(model, level)
    } else {
      const model =
        row === defaultRow ? runnerModels?.default : runnerModels && findModel(runnerModels, row)
      takesLevel =
        level !== undefined &&
        model?.reasoning === true &&
        thinkingLevelsOf(runnerModels).includes(level)
    }
    onChange({
      ...(row !== defaultRow && { model: row }),
      ...(takesLevel && level !== undefined && { thinkingLevel: level }),
    })
  }
  const chooseLevel = (thinkingLevel: ThinkingLevel | undefined) =>
    onChange({
      ...(value.model !== undefined && { model: value.model }),
      ...(thinkingLevel !== undefined && { thinkingLevel }),
    })

  return (
    <div {...stylex.props(styles.pickers, appearance === "field" && styles.fieldPickers)}>
      <SearchSelect
        side={side}
        align="start"
        label={`Model: ${name}`}
        trigger={
          <Button
            {...look(appearance)}
            disabled={disabled}
            title={`${name}, on ${harnessNames[harness]}`}
            sx={styles.trigger}
          >
            <span {...stylex.props(styles.label)}>{name}</span>
            <ChevronDownIcon />
          </Button>
        }
        groups={groups}
        value={picked}
        onValueChange={chooseModel}
        searchLabel="Search Models"
        noMatch={(query) => `No Models match "${query}".`}
        empty={
          pi !== undefined && providerModels === undefined
            ? "Loading your Models…"
            : "No Models yet. Connect a Provider on your Account page."
        }
      />
      {levels.length > 0 && (
        <ThinkingPicker
          levels={levels}
          value={value.thinkingLevel}
          onChange={chooseLevel}
          disabled={disabled}
          side={side}
          appearance={appearance}
        />
      )}
    </div>
  )
}

/**
 * The model a Session runs and its thinking level, named as the picker names them, from the same
 * models, for someone who can't change them: watching a Session they didn't start (ADR 0026). For a
 * pi Model, whose Creator's Models only they are sent, `knownLabel` is its name as the transcript
 * last gave it.
 */
export function ModelSettingLabel({
  claudeCode,
  pi,
  value,
  knownLabel,
}: Pick<ModelPickerProps, "claudeCode" | "pi" | "value"> & { knownLabel?: string | undefined }) {
  let name: string
  let takesLevel: boolean
  if (harnessOfModel(value.model) === "Pi") {
    const current = providerModelOf(pi?.models, value)
    name = providerModelLabel(pi?.models, value, knownLabel)
    // A Model not known here is shown with the level set: the Hub checked it.
    takesLevel = current === undefined || current.thinkingLevels.length > 0
  } else {
    const models = claudeCode?.models
    name = modelName(models, value)
    // As the picker: a level only for a model that takes one.
    takesLevel = modelOf(models, value)?.reasoning === true && thinkingLevelsOf(models).length > 0
  }
  const level =
    takesLevel && value.thinkingLevel !== undefined
      ? thinkingLevelNames[value.thinkingLevel]
      : undefined
  return (
    <span title="The model and thinking level this Session runs on" {...stylex.props(styles.shown)}>
      <span {...stylex.props(styles.label)}>{name}</span>
      {level !== undefined && (
        <>
          <span aria-hidden="true">·</span>
          <span>{level}</span>
        </>
      )}
    </span>
  )
}

/**
 * The thinking button and its slider. The slider shows where it is dragged or stepped to, and sets
 * the level where it is let go or clicked, on Enter, or when it closes other than by Escape on a
 * level other than the one set; Escape takes it back. Each change goes to the Hub, and between
 * Turns pi switches to it and Claude Code restarts, which asks first while agents run, so stepping
 * through the levels doesn't set each.
 */
function ThinkingPicker({
  levels,
  value,
  onChange,
  disabled,
  side,
  appearance,
}: {
  levels: ReadonlyArray<ThinkingLevel>
  /** The level set; undefined when none is, and the Model thinks at its usual level. */
  value: ThinkingLevel | undefined
  onChange: (level: ThinkingLevel | undefined) => void
  disabled: boolean
  side: MenuSide
  appearance: Appearance
}) {
  const [moved, setMoved] = useState<ThinkingLevel | undefined>(undefined)
  const shown = moved ?? value
  const setName = value === undefined ? "Default" : thinkingLevelNames[value]
  const commit = (level: ThinkingLevel) => {
    setMoved(undefined)
    if (level !== value) onChange(level)
  }

  return (
    <Popover
      side={side}
      align="start"
      label="Thinking"
      title={shown === undefined ? "Default" : thinkingLevelNames[shown]}
      description={shown === undefined ? "The Model's usual level." : thinkingLevelNotes[shown]}
      onOpenChange={(open, reason) => {
        if (open || moved === undefined) return
        // Escape takes back what was moved; any other way out sets it.
        if (reason === "escape-key") setMoved(undefined)
        else commit(moved)
      }}
      sx={styles.popup}
      trigger={
        <Button
          {...look(appearance)}
          disabled={disabled}
          aria-label={`Thinking: ${setName}`}
          sx={[styles.trigger, styles.thinkingTrigger]}
        >
          <span {...stylex.props(styles.label)}>{value === undefined ? "Thinking" : setName}</span>
          <ChevronDownIcon />
        </Button>
      }
    >
      <Slider
        label="Thinking"
        unsetLabel="Default"
        steps={levels.map((level) => ({ value: level, label: thinkingLevelNames[level] }))}
        value={shown}
        onValueChange={setMoved}
        onValueCommitted={commit}
      />
      {value !== undefined && (
        <Button
          size="sm"
          intent="ghost"
          onClick={() => {
            setMoved(undefined)
            onChange(undefined)
          }}
          sx={styles.reset}
        >
          Use the default
        </Button>
      )}
    </Popover>
  )
}
