import { type EffortLevel, findModel, type RunnerModels } from "@claude-hub/protocol"
import * as stylex from "@stylexjs/stylex"
import { useState } from "react"
import {
  ArrowLeftIcon,
  Button,
  ChevronDownIcon,
  ChevronRightIcon,
  Menu,
  MenuItem,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  type MenuSide,
  MenuSubmenu,
  useMediaQuery,
  WIDE,
} from "../ui/index.ts"
import { space } from "../ui/tokens.stylex.ts"
import {
  effortNames,
  effortNotes,
  effortsOf,
  type ModelSetting,
  modelOf,
  settingLabel,
} from "./models.ts"

const styles = stylex.create({
  menu: {
    width: "19rem",
    maxWidth: "calc(100vw - 2rem)",
  },
  submenu: {
    width: "13rem",
  },
  label: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  trigger: {
    maxWidth: "100%",
    gap: space.s1,
  },
  fieldTrigger: {
    alignSelf: "flex-start",
  },
})

/** The radio value of the `default` row: no model set, Claude Code's default. */
const defaultRow = "default"

export interface ModelPickerProps {
  /** What the Session's Runner said its Claude Code has; undefined before it has said. */
  models: RunnerModels | undefined
  value: ModelSetting
  onChange: (setting: ModelSetting) => void
  disabled?: boolean
  /** Which way the menu opens: up, from the composer at the bottom of the page. */
  side?: MenuSide
  /** `bar`: a quiet button in the composer's bar. `field`: a bordered one, in a form. */
  appearance?: "bar" | "field"
}

/**
 * The model a Session runs and its effort level, as claude.ai's composer picks them (#128): a
 * button named by the setting opens the Runner's models, each with a line on what it is good for,
 * and an Effort submenu with the levels its Claude Code takes. On a phone, the levels are a second
 * panel in the menu rather than a submenu beside it, which wouldn't fit.
 */
export function ModelPicker({
  models,
  value,
  onChange,
  disabled = false,
  side = "bottom",
  appearance = "bar",
}: ModelPickerProps) {
  const wide = useMediaQuery(WIDE)
  const [panel, setPanel] = useState<"models" | "effort">("models")
  const current = modelOf(models, value)
  const efforts = effortsOf(models)
  // A model the Runner doesn't list takes no level here: the Hub would refuse one for it.
  const takesEffort = current?.effort === true
  const label = settingLabel(models, value)

  const chooseModel = (row: string) => {
    const model = row === defaultRow ? models?.default : models && findModel(models, row)
    onChange({
      ...(row !== defaultRow && { model: row }),
      // A model that takes no level drops the one set; the Hub refuses it with one.
      ...(value.effort !== undefined && model?.effort === true && { effort: value.effort }),
    })
  }
  const chooseEffort = (effort: EffortLevel) =>
    onChange({ ...(value.model !== undefined && { model: value.model }), effort })

  const effortValue = !takesEffort
    ? "None"
    : value.effort === undefined
      ? "Default"
      : effortNames[value.effort]

  const effortRows = (
    <MenuRadioGroup value={value.effort} onValueChange={chooseEffort} label="Effort">
      {efforts.map((level) => (
        <MenuRadioItem
          key={level}
          value={level}
          label={effortNames[level]}
          description={effortNotes[level]}
        />
      ))}
    </MenuRadioGroup>
  )

  return (
    <Menu
      side={side}
      align="start"
      onOpenChange={(open) => {
        if (!open) setPanel("models")
      }}
      sx={styles.menu}
      trigger={
        <Button
          size={appearance === "bar" ? "sm" : "md"}
          intent={appearance === "bar" ? "ghost" : "secondary"}
          disabled={disabled}
          aria-label={`Model and effort: ${label}`}
          sx={[styles.trigger, appearance === "field" && styles.fieldTrigger]}
        >
          <span {...stylex.props(styles.label)}>{label}</span>
          <ChevronDownIcon />
        </Button>
      }
    >
      {panel === "effort" ? (
        <>
          <MenuItem keepOpen icon={<ArrowLeftIcon />} onClick={() => setPanel("models")}>
            Back to models
          </MenuItem>
          <MenuSeparator />
          {effortRows}
        </>
      ) : (
        <>
          <MenuRadioGroup
            value={value.model === undefined ? defaultRow : (current?.alias ?? value.model)}
            onValueChange={chooseModel}
            label="Model"
          >
            <MenuRadioItem
              value={defaultRow}
              label="Default (recommended)"
              description={
                models === undefined
                  ? "Claude Code's own default"
                  : [models.default.label, models.default.description].filter(Boolean).join(" · ")
              }
            />
            {models?.models.map((option) => (
              <MenuRadioItem
                key={option.alias}
                value={option.alias}
                label={option.label}
                description={option.description}
              />
            ))}
          </MenuRadioGroup>
          {efforts.length > 0 && <MenuSeparator />}
          {efforts.length > 0 &&
            (wide ? (
              <MenuSubmenu
                label="Effort"
                value={effortValue}
                disabled={!takesEffort}
                sx={styles.submenu}
              >
                {effortRows}
              </MenuSubmenu>
            ) : (
              <MenuItem
                keepOpen
                disabled={!takesEffort}
                onClick={() => setPanel("effort")}
                end={
                  <>
                    {effortValue}
                    <ChevronRightIcon />
                  </>
                }
              >
                Effort
              </MenuItem>
            ))}
        </>
      )}
    </Menu>
  )
}
