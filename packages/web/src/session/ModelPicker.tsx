import { type EffortLevel, findModel, type RunnerModels } from "@kndl/protocol"
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
  Slider,
} from "../ui/index.ts"
import { color, space, text, weight } from "../ui/tokens.stylex.ts"
import {
  effortNames,
  effortNotes,
  effortsOf,
  type ModelSetting,
  modelName,
  modelOf,
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
  effortTrigger: {
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

export interface ModelPickerProps {
  /** What the Session's Runner said its Claude Code has; undefined before it has said. */
  models: RunnerModels | undefined
  value: ModelSetting
  onChange: (setting: ModelSetting) => void
  disabled?: boolean
  /** Which way the menus open: up, from the composer at the bottom of the page. */
  side?: MenuSide
  appearance?: Appearance
}

/**
 * The model a Session runs and its effort level, as two small buttons side by side, as claude.ai
 * and ChatGPT pick them (#128): one named by the model opens the Runner's models, the other named
 * by the level opens a slider over the levels its Claude Code takes. The effort button is left
 * out for a model that takes no level.
 */
export function ModelPicker({
  models,
  value,
  onChange,
  disabled = false,
  side = "bottom",
  appearance = "bar",
}: ModelPickerProps) {
  const current = modelOf(models, value)
  const efforts = effortsOf(models)
  // A model the Runner doesn't list takes no level here: the Hub would refuse one for it.
  const takesEffort = current?.effort === true && efforts.length > 0
  const name = modelName(models, value)

  const chooseModel = (row: string) => {
    const model = row === defaultRow ? models?.default : models && findModel(models, row)
    onChange({
      ...(row !== defaultRow && { model: row }),
      // A model that takes no level drops the one set; the Hub refuses it with one.
      ...(value.effort !== undefined && model?.effort === true && { effort: value.effort }),
    })
  }
  const chooseEffort = (effort: EffortLevel | undefined) =>
    onChange({
      ...(value.model !== undefined && { model: value.model }),
      ...(effort !== undefined && { effort }),
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
      {takesEffort && (
        <EffortPicker
          efforts={efforts}
          value={value.effort}
          onChange={chooseEffort}
          disabled={disabled}
          side={side}
          appearance={appearance}
        />
      )}
    </div>
  )
}

/**
 * The model a Session runs and its effort level, named as the picker names them, for someone who
 * can't change them: watching a Session they didn't start (ADR 0026).
 */
export function ModelSettingLabel({
  models,
  value,
}: {
  models: RunnerModels | undefined
  value: ModelSetting
}) {
  const name = modelName(models, value)
  // As the picker: a level only for a model that takes one.
  const effort =
    modelOf(models, value)?.effort === true &&
    effortsOf(models).length > 0 &&
    value.effort !== undefined
      ? effortNames[value.effort]
      : undefined
  return (
    <span title="The model and effort this Session runs on" {...stylex.props(styles.shown)}>
      <span {...stylex.props(styles.label)}>{name}</span>
      {effort !== undefined && (
        <>
          <span aria-hidden="true">·</span>
          <span>{effort}</span>
        </>
      )}
    </span>
  )
}

/**
 * The effort button and its slider. The slider shows where it is dragged or stepped to, and sets
 * the level where it is let go or clicked, on Enter, or when it closes other than by Escape on a
 * level other than the one set; Escape takes it back. A change between Turns restarts Claude Code, and while agents run asks first, so
 * stepping through the levels doesn't set each.
 */
function EffortPicker({
  efforts,
  value,
  onChange,
  disabled,
  side,
  appearance,
}: {
  efforts: ReadonlyArray<EffortLevel>
  /** The level set; undefined when none is, and Claude Code picks. */
  value: EffortLevel | undefined
  onChange: (effort: EffortLevel | undefined) => void
  disabled: boolean
  side: MenuSide
  appearance: Appearance
}) {
  const [moved, setMoved] = useState<EffortLevel | undefined>(undefined)
  const shown = moved ?? value
  const setName = value === undefined ? "Default" : effortNames[value]
  const commit = (level: EffortLevel) => {
    setMoved(undefined)
    if (level !== value) onChange(level)
  }

  return (
    <Popover
      side={side}
      align="start"
      label="Effort"
      title={shown === undefined ? "Default" : effortNames[shown]}
      description={shown === undefined ? "Claude Code picks the level." : effortNotes[shown]}
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
          aria-label={`Effort: ${setName}`}
          sx={[styles.trigger, styles.effortTrigger]}
        >
          <span {...stylex.props(styles.label)}>{value === undefined ? "Effort" : setName}</span>
          <ChevronDownIcon />
        </Button>
      }
    >
      <Slider
        label="Effort"
        unsetLabel="Default"
        steps={efforts.map((level) => ({ value: level, label: effortNames[level] }))}
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
