import * as stylex from "@stylexjs/stylex"
import { getRouteApi } from "@tanstack/react-router"
import { type ComponentProps, type ReactNode, useEffect, useState } from "react"
import {
  AgentStatus,
  ArchiveIcon,
  Avatar,
  AvatarStack,
  Badge,
  Banner,
  BoxIcon,
  BranchIcon,
  CopyIcon,
  ChevronDownIcon,
  Button,
  Checkbox,
  Combobox,
  Dialog,
  DialogClose,
  Disclosure,
  Drawer,
  EmptyState,
  ExternalLinkIcon,
  Field,
  IconButton,
  InboxIcon,
  InfoIcon,
  InlineEdit,
  Input,
  KeyIcon,
  LogView,
  Markdown,
  Menu,
  MenuGroup,
  MenuItem,
  MenuIcon,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuSubmenu,
  MoreIcon,
  NavItem,
  NavSection,
  NavSlot,
  PageHeader,
  PencilIcon,
  PeopleIcon,
  PlugIcon,
  PlusIcon,
  Popover,
  RestartIcon,
  ServerIcon,
  UpdateIcon,
  SunIcon,
  SearchIcon,
  SearchSelect,
  type SearchSelectGroup,
  SegmentedControl,
  Select,
  SessionStatus,
  setTheme,
  Sidebar,
  Slider,
  Spinner,
  SteerIcon,
  StopIcon,
  Switch,
  Tab,
  TabList,
  TabPanel,
  Tabs,
  Textarea,
  toast,
  Tooltip,
  TrashIcon,
  WarningIcon,
  textRole,
} from "../ui/index.ts"
import { color, font, radius, space, text, weight } from "../ui/tokens.stylex.ts"

const route = getRouteApi("/kit")

const styles = stylex.create({
  page: {
    maxWidth: "64rem",
    marginInline: "auto",
    paddingBlock: space.s8,
    paddingInline: space.s6,
    display: "flex",
    flexDirection: "column",
    gap: space.s10,
  },
  section: {
    display: "flex",
    flexDirection: "column",
    gap: space.s3,
  },
  sectionTitle: { textWrap: "balance" },
  stack: { display: "flex", flexDirection: "column", gap: space.s3 },
  sectionNote: { color: color.textMuted, fontSize: text.sm },
  card: {
    display: "flex",
    flexDirection: "column",
    gap: space.s4,
    padding: space.s5,
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: color.border,
    borderRadius: radius.lg,
    backgroundColor: color.surface,
  },
  row: {
    display: "flex",
    alignItems: "center",
    flexWrap: "wrap",
    gap: space.s2,
  },
  rowLabel: {
    width: "6rem",
    flexShrink: 0,
    color: color.textSubtle,
    fontSize: text.sm,
  },
  grid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fill, minmax(15rem, 1fr))",
    gap: space.s4,
  },
  slider: {
    width: "12rem",
  },
  swatches: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fill, minmax(8.5rem, 1fr))",
    gap: space.s2,
  },
  swatch: {
    display: "flex",
    alignItems: "center",
    gap: space.s2,
    fontSize: text.sm,
    color: color.textMuted,
  },
  chip: {
    width: "1.5rem",
    height: "1.5rem",
    flexShrink: 0,
    borderRadius: radius.sm,
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: color.border,
  },
  chipColor: (value: string) => ({ backgroundColor: value }),
  panel: { paddingTop: space.s3, color: color.textMuted },
  detail: { padding: space.s3, color: color.textMuted },
  mono: { fontFamily: font.mono, fontSize: text.sm, color: color.textMuted },
  pre: { margin: 0, padding: space.s3, fontFamily: font.mono, fontSize: text.sm },
  popoverList: {
    display: "flex",
    flexDirection: "column",
    gap: space.s2,
    margin: 0,
    padding: 0,
    listStyle: "none",
  },
  popoverPerson: { display: "flex", alignItems: "center", gap: space.s2 },
  composer: { maxHeight: "12rem" },
  sidebarFrame: {
    width: "16rem",
    maxWidth: "100%",
    height: "30rem",
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: color.border,
    borderRadius: radius.md,
    overflow: "hidden",
  },
  // A page's top, framed like the page it heads; the narrow one is a phone's width. The header
  // draws its own bottom border, so the frame leaves that edge to it.
  pageFrame: {
    borderWidth: "1px",
    borderBottomWidth: 0,
    borderStyle: "solid",
    borderColor: color.border,
    borderRadius: radius.md,
    overflow: "hidden",
    backgroundColor: color.bg,
  },
  phoneFrame: { maxWidth: "24rem" },
  brand: { flex: 1, fontWeight: weight.semibold },
  footerNote: { paddingInline: space.s2, color: color.textMuted, fontSize: text.sm },
  warningIcon: { display: "inline-flex", color: color.warning },
  themeSelect: { minWidth: "7rem" },
})

const SWATCHES = [
  ["bg", color.bg],
  ["surface", color.surface],
  ["surfaceMuted", color.surfaceMuted],
  ["border", color.border],
  ["text", color.text],
  ["textMuted", color.textMuted],
  ["accent", color.accent],
  ["danger", color.danger],
  ["warning", color.warning],
  ["success", color.success],
  ["sessionActive", color.sessionActive],
  ["sessionAsleep", color.sessionAsleep],
  ["sessionFrozen", color.sessionFrozen],
  ["sessionArchived", color.sessionArchived],
] as const

const PEOPLE = [
  { id: "1", name: "Ada Lovelace" },
  { id: "2", name: "Grace Hopper" },
  { id: "3", name: "Linus" },
  { id: "4", name: "Margaret Hamilton" },
  { id: "5", name: "Ken Thompson" },
  { id: "6", name: "Barbara Liskov" },
  { id: "7", name: "Dennis Ritchie" },
]

// An inline picture, so the kit needs no network to show a loaded avatar.
const PICTURE = `data:image/svg+xml;utf8,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" fill="#c7d2fe"/><circle cx="16" cy="13" r="6" fill="#4f46e5"/><rect x="6" y="22" width="20" height="12" rx="6" fill="#4f46e5"/></svg>',
)}`

const BRANCHES = [
  { value: "main", label: "main" },
  { value: "develop", label: "develop" },
  { value: "release/1.0", label: "release/1.0" },
  { value: "legacy", label: "legacy (protected)", disabled: true },
] as const

function Section({ title, note, children }: { title: string; note?: string; children: ReactNode }) {
  return (
    <section {...stylex.props(styles.section)}>
      <div>
        <h2 {...stylex.props(textRole.heading, styles.sectionTitle)}>{title}</h2>
        {note && <p {...stylex.props(styles.sectionNote)}>{note}</p>}
      </div>
      <div {...stylex.props(styles.card)}>{children}</div>
    </section>
  )
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div {...stylex.props(styles.row)}>
      <span {...stylex.props(styles.rowLabel)}>{label}</span>
      {children}
    </div>
  )
}

function ThemeSwitch() {
  const { theme } = route.useSearch()
  const navigate = route.useNavigate()

  useEffect(() => {
    setTheme(theme ?? "system")
    return () => setTheme("system")
  }, [theme])

  return (
    <Select
      aria-label="Theme"
      size="sm"
      sx={styles.themeSelect}
      value={theme ?? "system"}
      onValueChange={(next) => {
        void navigate({ search: next === "system" ? {} : { theme: next } })
      }}
      options={[
        { value: "system", label: "System" },
        { value: "light", label: "Light" },
        { value: "dark", label: "Dark" },
      ]}
    />
  )
}

function Buttons() {
  const [saving, setSaving] = useState(false)
  return (
    <Section
      title="Button"
      note="intent says what the action is; size fits the density. Loading keeps focus and width."
    >
      {(["primary", "secondary", "ghost", "danger"] as const).map((intent) => (
        <Row key={intent} label={intent}>
          <Button intent={intent} size="sm">
            Small
          </Button>
          <Button intent={intent}>Medium</Button>
          <Button intent={intent} size="lg">
            Large
          </Button>
          <Button intent={intent} icon={<PlusIcon />}>
            With icon
          </Button>
          <Button intent={intent} loading>
            Loading
          </Button>
          <Button intent={intent} disabled>
            Disabled
          </Button>
        </Row>
      ))}
      <Row label="icon only">
        <IconButton label="New Session" size="sm">
          <PlusIcon />
        </IconButton>
        <IconButton label="New Session">
          <PlusIcon />
        </IconButton>
        <IconButton label="Stop" intent="secondary">
          <StopIcon />
        </IconButton>
        <IconButton label="Delete" intent="danger">
          <TrashIcon />
        </IconButton>
      </Row>
      <Row label="try it">
        <Button
          intent="primary"
          loading={saving}
          onClick={() => {
            setSaving(true)
            setTimeout(() => setSaving(false), 1500)
          }}
        >
          Save changes
        </Button>
      </Row>
    </Section>
  )
}

function Fields() {
  const [prompt, setPrompt] = useState("")
  return (
    <Section title="Field, Input, Textarea" note="Every control has a visible label.">
      <div {...stylex.props(styles.grid)}>
        <Field label="Session name">
          <Input placeholder="e.g. Fix flaky login test" />
        </Field>
        <Field label="Repo" description="owner/name of a GitHub repository.">
          <Input defaultValue="kddige/kndl" />
        </Field>
        <Field label="Secret name" invalid error="Use letters, digits and underscores only.">
          <Input defaultValue="API-KEY" />
        </Field>
        <Field label="Runner" disabled description="Chosen automatically.">
          <Input defaultValue="runner-eu-1" />
        </Field>
        <Field label="Small input">
          <Input size="sm" placeholder="Filter…" />
        </Field>
        <Field label="Required" description="Submit the form empty to see the browser's message.">
          <Input required />
        </Field>
      </div>
      <div {...stylex.props(styles.grid)}>
        <Field label="Secret value" description="Stored encrypted; never shown again.">
          <Textarea rows={3} placeholder="Paste the value" />
        </Field>
        <Field label="Prompt" description="Grows as you type.">
          <Textarea
            autoResize
            rows={1}
            value={prompt}
            onValueChange={setPrompt}
            placeholder="Ask Claude…"
            sx={styles.composer}
          />
        </Field>
      </div>
    </Section>
  )
}

function Selects() {
  const [branch, setBranch] = useState<string>("main")
  return (
    <Section title="Select">
      <div {...stylex.props(styles.grid)}>
        <Field label="Base branch">
          <Select options={BRANCHES} value={branch} onValueChange={setBranch} />
        </Field>
        <Field label="Runner">
          <Select
            placeholder="Choose a Runner"
            options={[
              { value: "eu", label: "runner-eu-1" },
              { value: "us", label: "runner-us-1" },
            ]}
          />
        </Field>
        <Field label="Disabled" disabled>
          <Select options={BRANCHES} defaultValue="main" disabled />
        </Field>
      </div>
      <Row label="small">
        <Select
          size="sm"
          aria-label="Sort"
          defaultValue="recent"
          options={[
            { value: "recent", label: "Most recent" },
            { value: "name", label: "Name" },
          ]}
        />
      </Row>
    </Section>
  )
}

const BRANCH_OPTIONS = [{ value: "main" }, { value: "develop" }, { value: "release/1.0" }]

function Comboboxes() {
  const [repo, setRepo] = useState("")
  const [branch, setBranch] = useState("main")
  const [created, setCreated] = useState<string | null>(null)
  return (
    <Section
      title="Combobox"
      note="A text field with suggestions: free entry, narrowed as you type, optionally in groups and with an entry that creates what was typed."
    >
      <div {...stylex.props(styles.grid)}>
        <Field label="Repo" description="Grouped suggestions; any text is fine.">
          <Combobox
            value={repo}
            onValueChange={setRepo}
            placeholder="kddige/kndl"
            options={[
              { value: "kddige/kndl", group: "Recent" },
              { value: "kddige/dotfiles", group: "Recent" },
              { value: "kddige/website", group: "Repositories" },
              { value: "someone/else", group: "Repositories" },
            ]}
          />
        </Field>
        <Field
          label="Branch"
          description={created === null ? "Type a name nothing matches." : `Created ${created}.`}
        >
          <Combobox
            value={branch}
            onValueChange={(next) => {
              setBranch(next)
              setCreated(null)
            }}
            options={BRANCH_OPTIONS}
            create={{
              label: (name) => `Create branch '${name}'`,
              onCreate: (name) => setCreated(name),
            }}
          />
        </Field>
        <Field label="Disabled" disabled>
          <Combobox value="main" onValueChange={() => {}} options={BRANCH_OPTIONS} disabled />
        </Field>
        <Field label="Invalid" invalid error="Pick one of the Repo's branches.">
          <Combobox value="nowhere" onValueChange={() => {}} options={BRANCH_OPTIONS} />
        </Field>
      </div>
    </Section>
  )
}

/** A long list in groups, as a gateway's Models are. */
const SEARCH_GROUPS: ReadonlyArray<SearchSelectGroup> = [
  "Anthropic",
  "OpenAI",
  "Google",
  "Mistral",
].map((vendor) => ({
  label: vendor,
  options: ["Large", "Medium", "Small", "Mini", "Nano"].map((size) => ({
    value: `${vendor.toLowerCase()}/${size.toLowerCase()}`,
    label: `${vendor} ${size}`,
  })),
}))

function SearchSelects() {
  const [value, setValue] = useState("openai/mini")
  const label = SEARCH_GROUPS.flatMap((group) => group.options).find(
    (option) => option.value === value,
  )?.label
  return (
    <Section
      title="SearchSelect"
      note="One choice among a long list, in groups, behind a button: it opens with a search that narrows the list by every word typed; arrow keys, Enter and Escape as in a menu."
    >
      <Row label="models">
        <SearchSelect
          trigger={
            <Button aria-label={`Model: ${label}`}>
              {label}
              <ChevronDownIcon />
            </Button>
          }
          groups={SEARCH_GROUPS}
          value={value}
          onValueChange={setValue}
          searchLabel="Search Models"
          noMatch={(query) => `No Models match "${query}".`}
        />
        <SearchSelect
          trigger={<Button>Empty</Button>}
          groups={[]}
          value={undefined}
          onValueChange={() => {}}
          searchLabel="Search Models"
          noMatch={(query) => `No Models match "${query}".`}
          empty="No Models yet. Connect a Provider on your Account page."
        />
      </Row>
    </Section>
  )
}

/** The radio menu's demo choices: a name and a line on each, as the model picker shows them. */
const sizes: Record<string, { label: string; description: string }> = {
  small: { label: "Small", description: "Quick, for light work" },
  medium: { label: "Medium", description: "Balanced for everyday work" },
  large: { label: "Large", description: "For the hardest, longest work" },
}

function Overlays() {
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [size, setSize] = useState("medium")
  const [speed, setSpeed] = useState("Steady")
  return (
    <Section title="Tooltip, Menu, Popover, Dialog">
      <Row label="tooltip">
        <Tooltip content="Starts a Session on the chosen Repo">
          <Button>Hover or focus me</Button>
        </Tooltip>
        <Tooltip content="Shown below" side="bottom">
          <Button intent="ghost">Below</Button>
        </Tooltip>
      </Row>
      <Row label="menu">
        <Menu
          trigger={
            <IconButton label="Session actions" intent="secondary">
              <MoreIcon />
            </IconButton>
          }
        >
          <MenuItem icon={<PlusIcon />} onClick={() => toast.show({ title: "Renamed" })}>
            Rename
          </MenuItem>
          <MenuItem icon={<StopIcon />} disabled>
            Stop Turn
          </MenuItem>
          <MenuSeparator />
          <MenuGroup label="Danger zone">
            <MenuItem intent="danger" icon={<TrashIcon />} onClick={() => setConfirmOpen(true)}>
              Delete Session…
            </MenuItem>
          </MenuGroup>
        </Menu>
        <Menu trigger={<Button>Open menu</Button>} align="end">
          <MenuItem>Copy link</MenuItem>
          <MenuItem>Open in new tab</MenuItem>
        </Menu>
      </Row>
      <Row label="radio, submenu">
        <Menu
          trigger={
            <Button intent="ghost" size="sm">
              {sizes[size]?.label} · {speed}
            </Button>
          }
        >
          <MenuRadioGroup value={size} onValueChange={setSize} label="Size">
            {Object.entries(sizes).map(([value, option]) => (
              <MenuRadioItem
                key={value}
                value={value}
                label={option.label}
                description={option.description}
              />
            ))}
          </MenuRadioGroup>
          <MenuSeparator />
          <MenuSubmenu label="Speed" value={speed}>
            <MenuRadioGroup value={speed} onValueChange={setSpeed}>
              <MenuRadioItem value="Slow" label="Slow" />
              <MenuRadioItem value="Steady" label="Steady" description="Recommended" />
              <MenuRadioItem value="Fast" label="Fast" description="Uses more" />
            </MenuRadioGroup>
          </MenuSubmenu>
        </Menu>
      </Row>
      <Row label="popover">
        <Popover
          trigger={<Button icon={<InfoIcon />}>Participants</Button>}
          title="4 Participants"
          description="Everyone here can prompt, stop and delete this Session."
        >
          <ul {...stylex.props(styles.popoverList)}>
            {PEOPLE.slice(0, 4).map((person) => (
              <li key={person.id} {...stylex.props(styles.popoverPerson)}>
                <Avatar name={person.name} size="sm" />
                {person.name}
              </li>
            ))}
          </ul>
        </Popover>
      </Row>
      <Row label="dialog">
        <Dialog
          trigger={<Button>New Session</Button>}
          title="New Session"
          description="Claude starts on its own Work branch, created from the base branch."
          footer={
            <>
              <DialogClose>Cancel</DialogClose>
              <Button intent="primary">Start Session</Button>
            </>
          }
        >
          <Field label="Repo">
            <Input defaultValue="kddige/kndl" />
          </Field>
          <Field label="Base branch">
            <Select options={BRANCHES} defaultValue="main" />
          </Field>
        </Dialog>
        <Button intent="danger" onClick={() => setConfirmOpen(true)}>
          Delete Session…
        </Button>
        <Dialog
          open={confirmOpen}
          onOpenChange={setConfirmOpen}
          size="sm"
          title="Delete this Session?"
          description="It is Archived for 30 days and can be restored until then."
          footer={
            <>
              <DialogClose>Cancel</DialogClose>
              <Button
                intent="danger"
                onClick={() => {
                  setConfirmOpen(false)
                  toast.show({
                    title: "Session archived",
                    description: "Fix flaky login test",
                    action: { label: "Undo", onAction: () => toast.show({ title: "Restored" }) },
                  })
                }}
              >
                Delete
              </Button>
            </>
          }
        />
      </Row>
    </Section>
  )
}

function Toasts() {
  return (
    <Section title="Toast" note="F6 moves focus to the toasts. Hover or focus pauses them.">
      <Row label="intents">
        <Button onClick={() => toast.show({ title: "Link copied" })}>Neutral</Button>
        <Button
          onClick={() =>
            toast.show({
              title: "Runner connected",
              description: "runner-eu-1 is back online.",
              intent: "success",
            })
          }
        >
          Success
        </Button>
        <Button
          onClick={() =>
            toast.show({
              title: "Session is Frozen",
              description: "Its Runner went offline. It stays readable.",
              intent: "warning",
            })
          }
        >
          Warning
        </Button>
        <Button
          onClick={() =>
            toast.show({
              title: "Couldn't wake the Session",
              description: "Its Runner is offline. Try again once it's back.",
              intent: "danger",
            })
          }
        >
          Danger
        </Button>
      </Row>
      <Row label="with action">
        <Button
          onClick={() =>
            toast.show({
              title: "Session archived",
              description: "Restore it within 30 days.",
              action: { label: "Undo", onAction: () => toast.show({ title: "Session restored" }) },
            })
          }
        >
          Archive with Undo
        </Button>
      </Row>
    </Section>
  )
}

const MARKDOWN = `## Plan

The flaky test is **\`waitFor\` racing the debounce**. Two changes:

1. Fake the timers in \`search.test.ts\`, so the debounce fires at once.
2. Drop the \`retry: 3\` that hid it. See [the docs](https://example.com).

> Partial answers render too, while they stream.

\`\`\`ts
vi.useFakeTimers()
await user.type(input, "hub")
vi.runAllTimers()
\`\`\`

| File | Change |
| --- | ---: |
| search.test.ts | +4 |
| vitest.config.ts | -1 |
`

const BUILD_LOG = `Pulling debian:bookworm-slim on studio-mac
$ apt-get update && apt-get install -y curl git
Setting up git (1:2.39.5-0+deb12u1) ...
Snapshotting the bootstrap's result
Test build passed in 41s`

function Toggles() {
  const [atBuild, setAtBuild] = useState(true)
  const [docker, setDocker] = useState(false)
  const [lines, setLines] = useState(2)
  const [harness, setHarness] = useState<"ClaudeCode" | "Pi">("ClaudeCode")
  const log = BUILD_LOG.split("\n").slice(0, lines).join("\n")
  return (
    <Section
      title="Checkbox, Switch, SegmentedControl, LogView"
      note="A Switch turns a setting on at once, as a SegmentedControl picks one of a few; a Checkbox is a choice in a form."
    >
      <Row label="segmented">
        <SegmentedControl
          label="Run Claude's Models with"
          options={[
            { value: "ClaudeCode", label: "Claude Code" },
            { value: "Pi", label: "pi" },
          ]}
          value={harness}
          onValueChange={setHarness}
        />
        <SegmentedControl
          label="Disabled"
          options={[
            { value: "a", label: "Disabled" },
            { value: "b", label: "Off" },
          ]}
          value="a"
          onValueChange={() => {}}
          disabled
        />
      </Row>
      <div {...stylex.props(styles.grid)}>
        <Checkbox label="At build" checked={atBuild} onCheckedChange={setAtBuild} />
        <Checkbox label="Disabled, ticked" checked disabled />
        <Switch
          label="Docker in every Sandbox"
          description="Each Session's Docker keeps its data on a disk of its own."
          checked={docker}
          onCheckedChange={setDocker}
        />
        <Switch label="Disabled, off" checked={false} disabled />
      </div>
      <LogView label="Test build log" placeholder="Waiting for the Runner…">
        {log}
      </LogView>
      <LogView label="Empty log" placeholder="Waiting for the Runner…">
        {""}
      </LogView>
      <Row label="log">
        <Button size="sm" onClick={() => setLines((n) => (n >= 5 ? 0 : n + 1))}>
          Add a line
        </Button>
      </Row>
      <Row label="icons">
        <KeyIcon aria-label="Key" />
        <BoxIcon aria-label="Box" />
        <RestartIcon aria-label="Restart" />
        <ExternalLinkIcon aria-label="External link" />
        <MenuIcon aria-label="Menu" />
        <ArchiveIcon aria-label="Archive" />
        <ServerIcon aria-label="Server" />
        <PeopleIcon aria-label="People" />
        <UpdateIcon aria-label="Update" />
        <CopyIcon aria-label="Copy" />
        <PlugIcon aria-label="Plug" />
        <SunIcon aria-label="Sun" />
        <SteerIcon aria-label="Steer" />
        <SearchIcon aria-label="Search" />
      </Row>
    </Section>
  )
}

const LEVELS = [
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
] as const

type Level = (typeof LEVELS)[number]["value"]

function Sliders() {
  const [shown, setShown] = useState<Level | undefined>("medium")
  const [committed, setCommitted] = useState<Level | undefined>("medium")
  const [unset, setUnset] = useState<Level | undefined>(undefined)
  return (
    <Section
      title="Slider"
      note="One of a few ordered stops. Arrow keys move it; a click, letting go, or Enter sets it."
    >
      <div {...stylex.props(styles.grid)}>
        <Row label={`set: ${committed ?? "none"}`}>
          <Slider
            label="Level"
            steps={LEVELS}
            value={shown}
            onValueChange={setShown}
            onValueCommitted={setCommitted}
            sx={styles.slider}
          />
        </Row>
        <Row label="none yet">
          <Slider
            label="Level, none set"
            steps={LEVELS}
            value={unset}
            onValueChange={setUnset}
            sx={styles.slider}
          />
        </Row>
        <Row label="disabled">
          <Slider label="Level, disabled" steps={LEVELS} value="high" disabled sx={styles.slider} />
        </Row>
      </div>
    </Section>
  )
}

// Kit-only links: they mark themselves current instead of going anywhere.
function KitLink({ onPick, ...props }: ComponentProps<"a"> & { onPick: () => void }) {
  return (
    <a
      {...props}
      href="#sidebar"
      onClick={(event) => {
        event.preventDefault()
        onPick()
      }}
    />
  )
}

function SidebarKit() {
  const [current, setCurrent] = useState("fix")
  const [drawer, setDrawer] = useState(false)
  const item = (id: string) => ({
    render: <KitLink onPick={() => setCurrent(id)} />,
    current: current === id,
  })
  // Only the first row's name is kept; the others' Rename buttons just show where they sit.
  const [names, setNames] = useState<{ fix?: string | undefined }>({})
  const [renaming, setRenaming] = useState<string | null>(null)
  const rename = (id: string, title: string) => (
    <IconButton label={`Rename ${title}`} size="sm" onClick={() => setRenaming(id)}>
      <PencilIcon />
    </IconButton>
  )
  const sidebar = (
    <Sidebar
      label="Kit navigation"
      header={
        <>
          <span {...stylex.props(styles.brand)}>kndl</span>
          <IconButton label="New Session" size="sm">
            <PlusIcon />
          </IconButton>
        </>
      }
      footer={<p {...stylex.props(styles.footerNote)}>2 of 3 Runners online</p>}
    >
      <NavSection>
        <NavItem {...item("environments")} icon={<BoxIcon />}>
          Environments
        </NavItem>
        <NavItem {...item("variables")} icon={<KeyIcon />}>
          Shared variables
        </NavItem>
        <NavItem {...item("archive")} icon={<ArchiveIcon />}>
          Archived Sessions
        </NavItem>
      </NavSection>
      <NavSection label="kddige/kndl">
        <NavItem
          {...item("fix")}
          icon={<SessionStatus state="active" variant="dot" />}
          action={rename("fix", "73-sandbox-token")}
          {...(renaming === "fix" && {
            editor: (
              <InlineEdit
                label="Session name"
                defaultValue={names.fix ?? "73-sandbox-token"}
                placeholder="73-sandbox-token"
                onCommit={(typed) => {
                  setNames({ ...names, fix: typed.trim() || undefined })
                  setRenaming(null)
                }}
                onCancel={() => setRenaming(null)}
              />
            ),
          })}
        >
          {names.fix ?? "73-sandbox-token"}
        </NavItem>
        <NavItem
          {...item("working")}
          icon={<SessionStatus state="active" variant="dot" />}
          action={rename("working", "feat/sidebar")}
          trailing={
            <NavSlot>
              <Spinner size="sm" label="Working" />
            </NavSlot>
          }
        >
          feat/sidebar
        </NavItem>
        <NavItem
          {...item("long")}
          icon={<SessionStatus state="asleep" variant="dot" />}
          title="claude/a-very-long-work-branch-name-that-does-not-fit"
          action={rename("long", "claude/a-very-long-work-branch-name-that-does-not-fit")}
          trailing={
            <NavSlot>
              <span
                role="img"
                aria-label="Environment changed"
                {...stylex.props(styles.warningIcon)}
              >
                <WarningIcon />
              </span>
            </NavSlot>
          }
        >
          claude/a-very-long-work-branch-name-that-does-not-fit
        </NavItem>
        <NavItem {...item("frozen")} icon={<SessionStatus state="frozen" variant="dot" />}>
          fix-flaky-search
        </NavItem>
      </NavSection>
      <NavSection label="an-organisation-with-a-long-name/and-a-long-repo">
        <NavItem {...item("other")} icon={<SessionStatus state="active" variant="dot" />}>
          main
        </NavItem>
      </NavSection>
    </Sidebar>
  )
  return (
    <Section
      title="Sidebar, NavSection, NavItem, InlineEdit, Drawer"
      note="Each Repo is a NavSection. The current item has a bar, weight and fill, and aria-current. Hover a row for its Rename action, shown always on the current one; the first row renames in place."
    >
      <div id="sidebar" {...stylex.props(styles.sidebarFrame)}>
        {sidebar}
      </div>
      <Row label="drawer">
        <IconButton label="Open navigation" onClick={() => setDrawer(true)}>
          <MenuIcon />
        </IconButton>
        <Drawer label="Kit navigation" open={drawer} onOpenChange={setDrawer}>
          {sidebar}
        </Drawer>
      </Row>
    </Section>
  )
}

function PageHeaders() {
  return (
    <Section
      title="PageHeader"
      note="The top of every page beside the sidebar. Its title row is as tall as the sidebar's header, with the same gutter and type, so the title sits level with the brand."
    >
      <div {...stylex.props(styles.pageFrame)}>
        <PageHeader title="Environments" />
      </div>
      <div {...stylex.props(styles.pageFrame)}>
        <PageHeader
          title="Shared variables"
          description="Hub-wide values, such as an API key, that Environments link under a name of their own."
          actions={
            <Button intent="primary" size="sm" icon={<PlusIcon />}>
              Add shared variable
            </Button>
          }
        />
      </div>
      <div {...stylex.props(styles.pageFrame)}>
        <PageHeader
          title="kddige/kndl"
          badge={<Badge intent="warning">Not set up</Badge>}
          description="Environment: what every Sandbox of this Repo is built from."
          actions={<Button size="sm">Shared variables</Button>}
        />
      </div>
      <Row label="phone">
        <div {...stylex.props(styles.pageFrame, styles.phoneFrame)}>
          <PageHeader
            title="claude/a-very-long-work-branch-name-that-does-not-fit"
            badge={<SessionStatus state="active" />}
            description="kddige/kndl · from main · on ada@example.com"
            actions={
              <>
                <IconButton label="Delete Session" size="sm">
                  <TrashIcon />
                </IconButton>
                <AvatarStack label="Here now" people={PEOPLE.slice(0, 2)} size="sm" />
              </>
            }
          />
        </div>
      </Row>
    </Section>
  )
}

function Disclosures() {
  return (
    <Section title="Disclosure" note="Closed by default: tool calls and subagents in the chat.">
      <Disclosure
        summary={
          <>
            <Badge>Bash</Badge>
            <span {...stylex.props(styles.mono)}>bun test search</span>
          </>
        }
      >
        <pre {...stylex.props(styles.pre)}>3 pass, 0 fail</pre>
      </Disclosure>
      <Disclosure defaultOpen summary="Open at first">
        <p {...stylex.props(styles.detail)}>The detail under the summary.</p>
      </Disclosure>
      <Disclosure variant="plain" summary="Plain, inside something framed">
        <p {...stylex.props(styles.detail)}>No border of its own.</p>
      </Disclosure>
    </Section>
  )
}

function Banners() {
  return (
    <Section title="Banner" note="A strip across a view saying what state it's in.">
      <Banner
        intent="frozen"
        icon={<InfoIcon />}
        title="This Session is Frozen"
        action={<Button size="sm">Unfreeze</Button>}
      >
        Its Sandbox is stopped, so it can't run. Unfreeze it to carry on.
      </Banner>
      <Banner intent="asleep" icon={<InfoIcon />} title="This Session is Asleep">
        Sending a prompt wakes it.
      </Banner>
      <Banner intent="warning" icon={<WarningIcon />} title="Reconnecting to the Hub" />
      <Banner intent="danger" icon={<WarningIcon />} title="The Runner went offline">
        The Session carries on when it's back.
      </Banner>
      <Banner
        intent="accent"
        icon={<Spinner size="sm" />}
        title="Starting…"
        detail={
          <Disclosure variant="plain" summary="Show log">
            <LogView label="Start log">
              {"#1 [internal] load build definition\n#2 DONE 0.4s\n"}
            </LogView>
          </Disclosure>
        }
      >
        Building the Environment, then running its start script.
      </Banner>
      <Banner intent="accent" icon={<BranchIcon />} title="On claude/fix-flaky-search" />
      <Banner title="Neutral, with nothing else" />
    </Section>
  )
}

export function KitPage() {
  return (
    <main>
      <PageHeader
        title="UI kit"
        description="Every component in its states. Switch the theme to check both palettes."
        actions={<ThemeSwitch />}
      />
      <div {...stylex.props(styles.page)}>
        <Section title="Colour tokens" note="Semantic roles; the values change with the theme.">
          <div {...stylex.props(styles.swatches)}>
            {SWATCHES.map(([name, value]) => (
              <div key={name} {...stylex.props(styles.swatch)}>
                <span {...stylex.props(styles.chip, styles.chipColor(value))} />
                {name}
              </div>
            ))}
          </div>
        </Section>

        <Section
          title="Type roles"
          note="Inter Variable. Each role pairs a size with its weight and line height; headings descend."
        >
          <div {...stylex.props(styles.stack)}>
            <p {...stylex.props(textRole.title)}>Title: a page or a dialog</p>
            <p {...stylex.props(textRole.heading)}>Heading: a section of a page</p>
            <p {...stylex.props(textRole.subheading)}>Subheading: a part of a section, or a card</p>
            <p {...stylex.props(textRole.overline)}>Overline: a group's label</p>
            <p {...stylex.props(textRole.body)}>
              Body: running text and controls, 13px, at about 75 characters a line at most.
            </p>
            <p {...stylex.props(textRole.meta)}>
              Meta: 2 of 3 Runners online · 12m ago · 2026.10.2
            </p>
          </div>
        </Section>

        <Buttons />

        <Section title="Badge, SessionStatus, AgentStatus">
          <Row label="badge">
            <Badge>12</Badge>
            <Badge intent="accent">New</Badge>
            <Badge intent="success">Merged</Badge>
            <Badge intent="warning">Behind main</Badge>
            <Badge intent="danger">Failed</Badge>
          </Row>
          <Row label="session">
            <SessionStatus state="active" />
            <SessionStatus state="asleep" />
            <SessionStatus state="frozen" />
            <SessionStatus state="archived" />
          </Row>
          <Row label="dot only">
            <SessionStatus state="active" variant="dot" />
            <SessionStatus state="asleep" variant="dot" />
            <SessionStatus state="frozen" variant="dot" />
            <SessionStatus state="archived" variant="dot" />
          </Row>
          <Row label="agent">
            <AgentStatus status="Running" />
            <AgentStatus status="Done" />
            <AgentStatus status="Stopped" />
            <AgentStatus status="Interrupted" />
          </Row>
          <Row label="agent dot">
            <AgentStatus status="Running" variant="dot" />
            <AgentStatus status="Done" variant="dot" />
            <AgentStatus status="Stopped" variant="dot" />
            <AgentStatus status="Interrupted" variant="dot" />
          </Row>
        </Section>

        <Section title="Avatar, AvatarStack">
          <Row label="sizes">
            <Avatar name="Ada Lovelace" size="sm" />
            <Avatar name="Ada Lovelace" />
            <Avatar name="Ada Lovelace" size="lg" />
            <Avatar name="Picture" src={PICTURE} size="lg" />
          </Row>
          <Row label="hues">
            {PEOPLE.map((person) => (
              <Avatar key={person.id} name={person.name} />
            ))}
          </Row>
          <Row label="stack">
            <AvatarStack label="Participants" people={PEOPLE.slice(0, 3)} />
            <AvatarStack label="Participants" people={PEOPLE} />
            <AvatarStack label="Participants" people={PEOPLE} size="sm" max={3} />
          </Row>
        </Section>

        <Fields />
        <Toggles />
        <Sliders />
        <Selects />
        <Comboboxes />
        <SearchSelects />

        <Section title="Tabs">
          <Tabs defaultValue="chat">
            <TabList label="Session views">
              <Tab value="chat">Chat</Tab>
              <Tab value="terminal">Terminal</Tab>
              <Tab value="previews">
                Previews <Badge>2</Badge>
              </Tab>
              <Tab value="settings" disabled>
                Settings
              </Tab>
            </TabList>
            <TabPanel value="chat" sx={styles.panel}>
              The conversation, Turn by Turn.
            </TabPanel>
            <TabPanel value="terminal" sx={styles.panel}>
              Claude Code's terminal, live, to watch and type into.
            </TabPanel>
            <TabPanel value="previews" sx={styles.panel}>
              Ports served from the Sandbox.
            </TabPanel>
          </Tabs>
        </Section>

        <Overlays />
        <Toasts />
        <Banners />
        <Disclosures />
        <SidebarKit />
        <PageHeaders />

        <Section title="Markdown" note="Claude's answers. A small, safe subset: no raw HTML.">
          <div {...stylex.props(styles.panel)}>
            <Markdown text={MARKDOWN} />
          </div>
        </Section>

        <Section title="EmptyState, Spinner">
          <EmptyState
            icon={<InboxIcon />}
            title="No Sessions yet"
            description="Start one on any Repo you can access. Everyone with access can join it."
            action={
              <Button intent="primary" icon={<PlusIcon />}>
                New Session
              </Button>
            }
          />
          <EmptyState
            title="No Archived Sessions"
            description="Deleted Sessions stay here for 30 days."
          />
          <Row label="spinner">
            <Spinner size="sm" />
            <Spinner />
            <Spinner size="lg" label="Loading Sessions" />
          </Row>
        </Section>
      </div>
    </main>
  )
}
