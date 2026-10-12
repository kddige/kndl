import { expect, test } from "bun:test"
import { checkTitle } from "./pr-title.ts"

test.each([
  "web: long pastes show as a chip in the Composer (#279)",
  "protocol, hub, web: Plugins are MCP servers (#232)",
  "web, hub: attachments 3, in steered prompts (#278) (#285)",
  "repo: CONTRIBUTING.md and SECURITY.md, for going open source",
  "docs: ADR 0025, Releases and Channels (#291)",
])("accepts %p", (title) => expect(checkTitle(title)).toBeUndefined())

test.each([
  ["feat(hub): something", "not an area"],
  ["chore: bump deps", "not an area"],
  ["Keep awake: a toggle", "not an area"],
  ["Runner: capitalised area", "not an area"],
  ["attachments 3: in steered prompts (#278)", "not an area"],
  ["hub,web: no space after the comma", "not an area"],
  ["hub, hub: twice", "listed twice"],
  ["hub: ", "no change"],
  ["New Session says up front when nobody's credential can run it", "areas"],
  ["", "areas"],
])("refuses %p", (title, why) => expect(checkTitle(title)).toContain(why))
