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
import { space } from "../ui/tokens.stylex.ts"
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
  menu: {
    width: "15rem",
    maxWidth: "calc(100vw - 2rem)",
  },
  effort: {
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
})

/** The radio value of the `default` row: no model set, Claude Code's default. */
const defaultRow = "default"

/** The level Claude Code runs when none is set: its own pickers call it the default, Medium. */
const defaultEffort = (efforts: ReadonlyArray<EffortLevel>): EffortLevel | undefined =>
  efforts.includes("medium") ? "medium" : efforts[0]

export interface ModelPickerProps {
  /** What the Session's Runner said its Claude Code has; undefined before it has said. */
  models: RunnerModels | undefined
  value: ModelSetting
  onChange: (setting: ModelSetting) => void
  disabled?: boolean
  /** Which way the menus open: up, from the composer at the bottom of the page. */
  side?: MenuSide
  /** `bar`: quiet buttons in the composer's bar. `field`: bordered ones, in a form. */
  appearance?: "bar" | "field"
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
  const size = appearance === "bar" ? "sm" : "md"
  const intent = appearance === "bar" ? "ghost" : "secondary"

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
        sx={styles.menu}
        trigger={
          <Button
            size={size}
            intent={intent}
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
          size={size}
          intent={intent}
        />
      )}
    </div>
  )
}

function EffortPicker({
  efforts,
  value,
  onChange,
  disabled,
  side,
  size,
  intent,
}: {
  efforts: ReadonlyArray<EffortLevel>
  value: EffortLevel | undefined
  onChange: (effort: EffortLevel | undefined) => void
  disabled: boolean
  side: MenuSide
  size: "sm" | "md"
  intent: "ghost" | "secondary"
}) {
  // Where the thumb is while it is dragged: the level is only set where it is let go, as a
  // change between Turns restarts Claude Code, and in a Turn asks first.
  const [dragging, setDragging] = useState<EffortLevel | undefined>(undefined)
  const shown = dragging ?? value ?? defaultEffort(efforts)
  if (shown === undefined) return null
  const label = value === undefined ? "Effort" : effortNames[value]
  const note =
    value === undefined && dragging === undefined ? "Claude Code's default" : effortNotes[shown]

  return (
    <Popover
      side={side}
      align="start"
      title={effortNames[shown]}
      {...(note !== undefined && { description: note })}
      onOpenChange={() => setDragging(undefined)}
      sx={styles.effort}
      trigger={
        <Button
          size={size}
          intent={intent}
          disabled={disabled}
          aria-label={`Effort: ${value === undefined ? "Default" : effortNames[value]}`}
          sx={[styles.trigger, styles.effortTrigger]}
        >
          <span {...stylex.props(styles.label)}>{label}</span>
          <ChevronDownIcon />
        </Button>
      }
    >
      <Slider
        label="Effort"
        steps={efforts.map((level) => ({ value: level, label: effortNames[level] }))}
        value={shown}
        onValueChange={setDragging}
        onValueCommitted={(level) => {
          setDragging(undefined)
          onChange(level)
        }}
      />
      {value !== undefined && (
        <Button size="sm" intent="ghost" onClick={() => onChange(undefined)} sx={styles.reset}>
          Use the default
        </Button>
      )}
    </Popover>
  )
}
