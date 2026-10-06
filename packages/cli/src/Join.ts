// `kndl runner join '<hub-url>#<code>'`, and `onboard --pair`: what the Hub's answers to a
// redemption and to a connection check mean, decided apart from asking (HubClient.ts asks). The
// link itself is read by the protocol's parsePairing, which the Runners page writes it for.
import { Paired, RunnerConnection } from "@kndl/protocol"
import { Schema } from "effect"

/** The Runner name a join asks for when none is given: the host name up to its first dot. */
export function shortHostname(host: string): string {
  return host.split(".")[0] || "runner"
}

/** What became of a redemption. */
export type PairOutcome =
  | { readonly _tag: "Paired"; readonly paired: Paired }
  | { readonly _tag: "Refused"; readonly message: string }

const decodePaired = Schema.decodeUnknownOption(Paired)
const decodeConnection = Schema.decodeUnknownOption(RunnerConnection)

/** The Hub's `{ error }`, or `undefined` when it didn't answer one. */
function hubError(body: unknown): string | undefined {
  if (typeof body !== "object" || body === null || !("error" in body)) return undefined
  return typeof body.error === "string" ? body.error : undefined
}

/** A Hub's answer to `POST /runner/pair`, read: the token, or why there is none. */
export function readPairAnswer(hubUrl: string, status: number, body: unknown): PairOutcome {
  if (status === 200) {
    const paired = decodePaired(body)
    if (paired._tag === "Some") return { _tag: "Paired", paired: paired.value }
    return refused(`${hubUrl} answered, but not with a Runner token: is it a kndl Hub?`)
  }
  if (status === 404) {
    return refused(
      `${hubUrl} doesn't pair Runners with codes: it runs a kndl from before them. Update the Hub (\`kndl update\` on its machine), or issue a token there with \`kndl runner token <name>\` and run \`kndl onboard --role runner --hub-url ${hubUrl} --token <token>\` here.`,
    )
  }
  const error = hubError(body)
  if (error !== undefined) return refused(error)
  return refused(`${hubUrl} answered ${status} to the pairing request.`)
}

const refused = (message: string) => ({ _tag: "Refused", message }) as const

/** Whether the Hub has the Runner connected, by its token. */
export type ConnectionCheck =
  | { readonly _tag: "Online"; readonly name: string; readonly runnerId: string }
  | { readonly _tag: "Offline" }
  /** The Hub doesn't take the token: the Runner was removed, or paired again. */
  | { readonly _tag: "TokenRefused" }
  /** A Hub from before `GET /runner/connection`: its log says instead. */
  | { readonly _tag: "Unsupported" }
  | { readonly _tag: "Unreachable"; readonly detail: string }

/** A Hub's answer to `GET /runner/connection`, read. */
export function readConnectionAnswer(status: number, body: unknown): ConnectionCheck {
  if (status === 401) return { _tag: "TokenRefused" }
  if (status === 404) return { _tag: "Unsupported" }
  const connection = status === 200 ? decodeConnection(body) : undefined
  if (connection === undefined || connection._tag === "None") {
    return { _tag: "Unreachable", detail: `it answered ${status}` }
  }
  const { online, name, runnerId } = connection.value
  return online ? { _tag: "Online", name, runnerId } : { _tag: "Offline" }
}

/** Whether a connection check is final, or worth asking again in a moment. */
export const connectionSettled = (check: ConnectionCheck) =>
  check._tag === "Online" || check._tag === "TokenRefused" || check._tag === "Unsupported"

/** What `runner join`, onboard and status say about the connection, after `seconds` of asking. */
export function describeConnectionCheck(check: ConnectionCheck, seconds?: number): string {
  switch (check._tag) {
    case "Online":
      return `connected to the Hub as ${check.name} (${check.runnerId})`
    case "Offline":
      return `not connected to the Hub${seconds === undefined ? "" : ` after ${seconds} seconds`}: see \`kndl logs runner\``
    case "TokenRefused":
      return "the Hub doesn't accept this Runner's token: it was removed, or paired again elsewhere. Pair it again with a new code."
    case "Unsupported":
      return "the Hub is too old to say whether the Runner connected"
    case "Unreachable":
      return `couldn't ask the Hub whether the Runner connected (${check.detail})`
  }
}

/** What a join with a code for a new Runner, or a Re-pair, did. */
export function describePaired(paired: Paired, hubUrl: string): string {
  return paired.repaired
    ? `Paired again with ${hubUrl} as Runner ${paired.name} (${paired.runnerId}), keeping its Sessions; its old token no longer works.`
    : `Paired with ${hubUrl} as Runner ${paired.name} (${paired.runnerId}).`
}
