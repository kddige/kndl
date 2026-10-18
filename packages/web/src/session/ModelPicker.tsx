import {
  findModel,
  type ProviderModel,
  providerModelName,
  type RunnerModels,
  type ThinkingLevel,
} from "@kndl/protocol"
import * as stylex from "@stylexjs/stylex"
import { useState } from "react"
import {
  Button,
  ChevronDownIcon,
  Menu,
  MenuRadioGroup,
  MenuRadioItem,
  type MenuSide,
  Popover,
  SearchSelect,
  Slider,
} from "../ui/index.ts"
import { color, space, text, weight } from "../ui/tokens.stylex.ts"
import {
  groupByProvider,
  type ModelSetting,
  modelName,
  modelOf,
  providerModelLabel,
  providerModelOf,
  providerNames,
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

/** The radio value of the `default` row: no model set, Claude Code's default. */
const defaultRow = "default"

/** `bar`: quiet buttons in the composer's bar. `field`: bordered ones, in a form. */
type Appearance = "bar" | "field"

/** A picker button's size and intent, for where it is. */
const look = (appearance: Appearance) =>
  appearance === "bar"
    ? ({ size: "sm", intent: "ghost" } as const)
    : ({ size: "md", intent: "secondary" } as const)

/** What a Session's model can be set to, by its Harness (ADR 0029). */
export type HarnessModels =
  | {
      /** Claude Code, as a Session from before pi says by saying nothing. */
      readonly harness?: "ClaudeCode"
      /** What the Session's Runner said its Claude Code has; undefined before it has said. */
      readonly models: RunnerModels | undefined
    }
  | {
      readonly harness: "Pi"
      /** Its Creator's Models, from their ProvidersState; undefined before the Hub sent it. */
      readonly models: ReadonlyArray<ProviderModel> | undefined
    }

interface PickerProps {
  value: ModelSetting
  onChange: (setting: ModelSetting) => void
  disabled?: boolean
  /** Which way the menus open: up, from the composer at the bottom of the page. */
  side?: MenuSide
  appearance?: Appearance
}

export type ModelPickerProps = PickerProps & HarnessModels

/**
 * The model a Session runs and its thinking level, as two small buttons side by side, as claude.ai
 * and ChatGPT pick them (#128): one named by the model opens the models, the other named by the
 * level opens a slider over the levels it takes. The thinking button is left out for a model that
 * takes no level. A Claude Code Session's are its Runner's; a pi Session's, its Creator's Models,
 * by Provider, each with its own levels.
 */
export function ModelPicker(props: ModelPickerProps) {
  return props.harness === "Pi" ? (
    <PiModelPicker {...props} models={props.models} />
  ) : (
    <ClaudeCodeModelPicker {...props} models={props.models} />
  )
}

function ClaudeCodeModelPicker({
  models,
  value,
  onChange,
  disabled = false,
  side = "bottom",
  appearance = "bar",
}: PickerProps & { models: RunnerModels | undefined }) {
  const current = modelOf(models, value)
  const levels = thinkingLevelsOf(models)
  // A model the Runner doesn't list takes no level here: the Hub would refuse one for it.
  const takesLevel = current?.reasoning === true && levels.length > 0
  const name = modelName(models, value)

  const chooseModel = (row: string) => {
    const model = row === defaultRow ? models?.default : models && findModel(models, row)
    onChange({
      ...(row !== defaultRow && { model: row }),
      // A model that takes no level drops the one set; the Hub refuses it with one.
      ...(value.thinkingLevel !== undefined &&
        model?.reasoning === true && { thinkingLevel: value.thinkingLevel }),
    })
  }
  const chooseLevel = (thinkingLevel: ThinkingLevel | undefined) =>
    onChange({
      ...(value.model !== undefined && { model: value.model }),
      ...(thinkingLevel !== undefined && { thinkingLevel }),
    })

  return (
    <div {...stylex.props(styles.pickers, appearance === "field" && styles.fieldPickers)}>
      <Menu
        side={side}
        align="start"
        sx={styles.popup}
        trigger={
          <Button
            {...look(appearance)}
            disabled={disabled}
            aria-label={`Model: ${name}`}
            sx={styles.trigger}
          >
            <span {...stylex.props(styles.label)}>{name}</span>
            <ChevronDownIcon />
          </Button>
        }
      >
        <MenuRadioGroup
          value={value.model === undefined ? defaultRow : (current?.alias ?? value.model)}
          onValueChange={chooseModel}
          label="Model"
        >
          <MenuRadioItem
            value={defaultRow}
            label={models === undefined ? "Default" : `Default · ${models.default.label}`}
          />
          {models?.models.map((option) => (
            <MenuRadioItem key={option.alias} value={option.alias} label={option.label} />
          ))}
        </MenuRadioGroup>
      </Menu>
      {takesLevel && (
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
 * A pi Session's picker (ADR 0029): its Creator's Models, a group for each Provider, valued as
 * `openai/gpt-6-sol`, with no default row, since a pi Session always runs a Model it names. A
 * Provider can list hundreds (OpenRouter), so it opens with a search. A Model that doesn't take
 * the level set drops it.
 */
function PiModelPicker({
  models,
  value,
  onChange,
  disabled = false,
  side = "bottom",
  appearance = "bar",
}: PickerProps & { models: ReadonlyArray<ProviderModel> | undefined }) {
  const current = providerModelOf(models, value)
  const levels = current?.thinkingLevels ?? []
  const name = providerModelLabel(models, value)

  const chooseModel = (row: string) => {
    const model = models?.find((each) => providerModelName(each) === row)
    onChange({
      model: row,
      ...(value.thinkingLevel !== undefined &&
        model?.thinkingLevels.includes(value.thinkingLevel) === true && {
          thinkingLevel: value.thinkingLevel,
        }),
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
        trigger={
          <Button
            {...look(appearance)}
            disabled={disabled}
            aria-label={`Model: ${name}`}
            sx={styles.trigger}
          >
            <span {...stylex.props(styles.label)}>{name}</span>
            <ChevronDownIcon />
          </Button>
        }
        groups={groupByProvider(models ?? []).map((group) => ({
          label: providerNames[group.provider],
          options: group.models.map((model) => ({
            value: providerModelName(model),
            label: model.label,
            keywords: model.id,
          })),
        }))}
        value={current === undefined ? undefined : providerModelName(current)}
        onValueChange={chooseModel}
        searchLabel="Search Models"
        noMatch={(query) => `No Models match "${query}".`}
        empty={
          models === undefined
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
 * The model a Session runs and its thinking level, named as the picker names them, for someone
 * who can't change them: watching a Session they didn't start (ADR 0026). For a pi Session, whose
 * Creator's Models only they are sent, `knownLabel` is its Model's name as the transcript last gave
 * it.
 */
export function ModelSettingLabel(
  props: HarnessModels & { value: ModelSetting; knownLabel?: string | undefined },
) {
  const { value } = props
  let name: string
  let takesLevel: boolean
  if (props.harness === "Pi") {
    const current = providerModelOf(props.models, value)
    name = providerModelLabel(props.models, value, props.knownLabel)
    // A Model not known here is shown with the level set: the Hub checked it.
    takesLevel = current === undefined || current.thinkingLevels.length > 0
  } else {
    name = modelName(props.models, value)
    // As the picker: a level only for a model that takes one.
    takesLevel =
      modelOf(props.models, value)?.reasoning === true && thinkingLevelsOf(props.models).length > 0
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
 * level other than the one set; Escape takes it back. A change between Turns restarts Claude Code, and while agents run asks first, so
 * stepping through the levels doesn't set each.
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
