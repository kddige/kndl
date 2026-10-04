import { describe, expect, test } from "bun:test"
import { envValues, parseEnv, renderEnv, updateEnv } from "./EnvFile.ts"

describe("env files", () => {
  test("read variables, quoted or not, and skip comments", () => {
    const file = parseEnv(
      [
        "# The Hub",
        "HOST=127.0.0.1",
        "export PORT=7777",
        "HUB_PUBLIC_URL='http://127.0.0.1:7777'",
        'NAME="a \\"quoted\\" name"',
        "PLAIN=value # a comment",
        "",
      ].join("\n"),
    )

    expect(envValues(file)).toEqual({
      HOST: "127.0.0.1",
      PORT: "7777",
      HUB_PUBLIC_URL: "http://127.0.0.1:7777",
      NAME: 'a "quoted" name',
      PLAIN: "value",
    })
  })

  test("a later assignment wins", () => {
    expect(envValues(parseEnv("A=1\nA=2\n"))).toEqual({ A: "2" })
  })

  test("updating keeps comments and other variables where they are", () => {
    const file = parseEnv("# mine\nGITHUB_APP_ID=123\nPORT=7777\n")
    const updated = updateEnv(file, { PORT: "8080", HOST: "0.0.0.0" })

    expect(renderEnv(updated)).toBe("# mine\nGITHUB_APP_ID=123\nPORT=8080\nHOST=0.0.0.0\n")
  })

  test("updating removes what's set to undefined, and repeated assignments", () => {
    const file = parseEnv("HUB_INSECURE_COOKIES=1\nPORT=1\nPORT=2\n")
    const updated = updateEnv(file, { HUB_INSECURE_COOKIES: undefined, PORT: "3" })

    expect(renderEnv(updated)).toBe("PORT=3\n")
  })

  test("values are quoted only where needed, and read back the same", () => {
    const values = { A: "plain-value_1.2:3/x", B: "has space", C: "it's", D: "a#b" }
    const text = renderEnv(updateEnv([], values))

    expect(text).toContain("A=plain-value_1.2:3/x\n")
    expect(text).toContain("B='has space'\n")
    expect(envValues(parseEnv(text))).toEqual(values)
  })

  test("an empty file renders empty", () => {
    expect(renderEnv([])).toBe("")
  })
})
