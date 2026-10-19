import {
  type ConnectableProvider,
  findProviderModel,
  type ProviderModel,
  providerModelName,
  takesThinkingLevel,
  type ThinkingLevel,
} from "@kndl/protocol"
import * as stylex from "@stylexjs/stylex"
import { type ReactNode, useState } from "react"
import {
  Button,
  ChevronDownIcon,
  type MenuSide,
  Popover,
  SearchSelect,
  type SearchSelectGroup,
  Slider,
} from "../ui/index.ts"
import { space } from "../ui/tokens.stylex.ts"
import {
  groupByProvider,
  type ModelSetting,
  providerModelLabel,
  providerModelOf,
  providerName,
  thinkingLevelNames,
  thinkingLevelNotes,
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
})

/**
 * The value of the row that follows another's model, as a thread does the Session's. Parentheses
 * are in no model name, so it is no Model's.
 */
const inheritRow = "(inherit)"

/** `bar`: quiet buttons in the composer's bar. `field`: bordered ones, in a form. */
type Appearance = "bar" | "field"

/** A picker button's size and intent, for where it is. */
const look = (appearance: Appearance) =>
  appearance === "bar"
    ? ({ size: "sm", intent: "ghost" } as const)
    : ({ size: "md", intent: "secondary" } as const)

export interface ModelPickerProps {
  /**
   * The Models to pick from: a Session's Creator's, as SessionModels sent them, or, for a new
   * Session, the signed-in person's own; undefined until the Hub has sent them.
   */
  readonly models: ReadonlyArray<ProviderModel> | undefined
  /** The Hub's names for the Providers, which head each group (ProvidersState). */
  readonly connectable?: ReadonlyArray<ConnectableProvider> | undefined
  /** The setting: a `provider/id` model, or none, for the Hub's pick (or `inherit`'s). */
  value: ModelSetting
  onChange: (setting: ModelSetting) => void
  /**
   * A first row for no model, which follows another's, named as that: a thread's "Session's
   * model". Without it, no model is the Hub's pick, its first Model.
   */
  inherit?: { readonly label: string; readonly name: string }
  /** A note under the list, such as whose accounts the Models are. */
  footer?: ReactNode
  disabled?: boolean
  /** Which way the lists open: up, from the composer at the bottom of the page. */
  side?: MenuSide
  appearance?: Appearance
}

/**
 * The model a Session or thread runs and its thinking level, as two small buttons side by side,
 * as claude.ai and ChatGPT pick them (#128): one named by the model opens the models, the other
 * named by the level opens a slider over the levels it takes, and is left out for a model that
 * takes none.
 *
 * One list, grouped by Provider, Claude's under Anthropic, valued as `openai/gpt-6-sol`. A
 * Provider can list hundreds (OpenRouter), so it opens with a search.
 */
export function ModelPicker({
  models,
  connectable,
  value,
  onChange,
  inherit,
  footer,
  disabled = false,
  side = "bottom",
  appearance = "bar",
}: ModelPickerProps) {
  const inheriting = inherit !== undefined && value.model === undefined
  const model = inheriting ? undefined : providerModelOf(models, value)
  // A model that isn't listed takes no level here: the Hub would refuse one for it.
  const levels = model?.thinkingLevels ?? []
  const name = inheriting ? inherit.name : providerModelLabel(models, value)

  const groups: Array<SearchSelectGroup> = [
    ...(inherit === undefined
      ? []
      : [{ label: "Follow", options: [{ value: inheritRow, label: inherit.label }] }]),
    ...groupByProvider(models ?? []).map((group) => ({
      label: providerName(group.provider, connectable),
      options: group.models.map((each) => ({
        value: providerModelName(each),
        label: each.label,
        keywords: each.id,
      })),
    })),
  ]
  const picked = inheriting ? inheritRow : model && providerModelName(model)

  // A level the model picked doesn't take is dropped: the Hub refuses it with one.
  const chooseModel = (row: string) => {
    if (row === inheritRow) {
      onChange({})
      return
    }
    const level = value.thinkingLevel
    const next = models && findProviderModel(models, row)
    const takesLevel = level !== undefined && next !== undefined && takesThinkingLevel(next, level)
    onChange({ model: row as never, ...(takesLevel && { thinkingLevel: level }) })
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
          <Button {...look(appearance)} disabled={disabled} title={name} sx={styles.trigger}>
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
          models === undefined
            ? "Loading the Models…"
            : "No Models yet. Connect a Provider on your Account page."
        }
        {...(footer !== undefined && { footer })}
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
 * The thinking button and its slider. The slider shows where it is dragged or stepped to, and sets
 * the level where it is let go or clicked, on Enter, or when it closes other than by Escape on a
 * level other than the one set; Escape takes it back. Each change goes to the Hub, and between
 * Turns the agent switches to it, so stepping through the levels doesn't set each.
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
