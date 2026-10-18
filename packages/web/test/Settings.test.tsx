// The settings page template (#401): a row's ⋯ menu runs its items, a click on the row toggles its
// detail but a click on its controls doesn't, and the apply bar offers Discard only with a draft
// to drop.

import { afterEach, expect, mock, test } from "bun:test"
import { useState } from "react"
import { installDom } from "./dom.ts"
import { button, menuItem, render, settle, step } from "./render.ts"

installDom()
const {
  Button,
  MenuItem,
  SettingsList,
  SettingsPage,
  SettingsRow,
  SettingsSection,
  StickyApplyBar,
} = await import("../src/ui/index.ts")

let cleanup: (() => Promise<void>) | undefined
afterEach(async () => {
  await cleanup?.()
  cleanup = undefined
})

function Page({ onRemove, onUpdate }: { onRemove: () => void; onUpdate: () => void }) {
  const [open, setOpen] = useState(false)
  return (
    <SettingsPage title="Runners" description="The machines Sessions run on.">
      <SettingsSection title="Runners">
        <SettingsList label="Runners">
          <SettingsRow
            label="studio"
            name="studio"
            meta={["2026.10.2", false, "4 Sessions"]}
            action={
              <Button size="sm" onClick={onUpdate}>
                Update
              </Button>
            }
            menu={
              <>
                <MenuItem onClick={() => setOpen((was) => !was)}>Monitor studio</MenuItem>
                <MenuItem intent="danger" onClick={onRemove}>
                  Remove studio
                </MenuItem>
              </>
            }
            onToggle={() => setOpen((was) => !was)}
            detail={open && <p>studio's monitor</p>}
          />
        </SettingsList>
      </SettingsSection>
    </SettingsPage>
  )
}

const row = () => document.querySelector<HTMLElement>('li[aria-label="studio"]')
const head = () => row()?.firstElementChild as HTMLElement

test("puts the title, sections and rows in one column, the facts joined by dots", async () => {
  const view = await render(<Page onRemove={() => {}} onUpdate={() => {}} />)
  cleanup = view.unmount
  expect(document.querySelector("main h1")?.textContent).toBe("Runners")
  expect(document.querySelector("main section h2")?.textContent).toBe("Runners")
  expect(head().textContent).toContain("2026.10.2·4 Sessions")
  expect(document.title).toBe("Runners · kndl")
})

test("runs a row's menu items, and toggles its detail on a click on the row, not its controls", async () => {
  const onRemove = mock(() => {})
  const onUpdate = mock(() => {})
  const view = await render(<Page onRemove={onRemove} onUpdate={onUpdate} />)
  cleanup = view.unmount

  await menuItem("Actions for studio", "Remove studio")
  expect(onRemove).toHaveBeenCalledTimes(1)
  expect(row()?.textContent).not.toContain("studio's monitor")

  await menuItem("Actions for studio", "Monitor studio")
  expect(row()?.textContent).toContain("studio's monitor")

  await step(() => head().click())
  expect(row()?.textContent).not.toContain("studio's monitor")
  await step(() => head().querySelector("span")?.click())
  expect(row()?.textContent).toContain("studio's monitor")

  await step(() => button("Update").click())
  expect(onUpdate).toHaveBeenCalledTimes(1)
  expect(row()?.textContent).toContain("studio's monitor")
  await settle()
})

test("the apply bar offers Discard only when there's a draft to drop", async () => {
  const onDiscard = mock(() => {})
  const view = await render(
    <>
      <StickyApplyBar apply={<Button intent="primary">Apply</Button>} onDiscard={onDiscard} />
      <StickyApplyBar title="Not applied yet" apply={<Button intent="primary">Apply</Button>} />
    </>,
  )
  cleanup = view.unmount
  const [withDraft, fresh] = [...document.querySelectorAll<HTMLElement>('[role="group"]')]
  expect(withDraft?.getAttribute("aria-labelledby")).toBeTruthy()
  expect(withDraft?.textContent).toContain("Unsaved changes")
  await step(() => button("Discard", withDraft).click())
  expect(onDiscard).toHaveBeenCalledTimes(1)
  expect(fresh?.textContent).toBe("Not applied yetApply")
})
