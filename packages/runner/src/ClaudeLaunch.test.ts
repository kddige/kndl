import { expect, test } from "bun:test"
import { ModEnvironment } from "./ClaudeLaunch.ts"

test("the mod reads every variable the Runner sets for it, by the same name", async () => {
  // The loader lists a hooks module's variables from its literal `$.env.get` calls, so the mod
  // can't share these names as constants.
  const glue = await Bun.file(new URL("../../mod/hooks/register.ts", import.meta.url)).text()
  for (const name of Object.values(ModEnvironment)) expect(glue).toContain(`$.env.get("${name}")`)
})
