import { Schema } from "effect"
import { BuildVersion } from "./Build.ts"

/**
 * The protocol version every peer speaks. Bump it on any change a peer built against the old
 * version could not decode or would misread.
 *
 * Each channel opens with a hello from the Runner, mod or web client carrying its version, and
 * the Hub answers with a welcome or a {@link HandshakeRejected}. Peers check the welcome the same
 * way, so a mismatch is caught on whichever side is newer.
 */
export const ProtocolVersion = 1 as const
export type ProtocolVersion = typeof ProtocolVersion

/** The `protocolVersion` field of every hello and welcome: only this build's version decodes. */
export const CurrentProtocolVersion = Schema.Literal(ProtocolVersion)

/**
 * Reads only the version from a peer's first message, whatever else a different version put in
 * it, so the version can be checked before the full hello is decoded. Prefer
 * {@link checkHandshake}.
 */
export const VersionProbe = Schema.Struct({ protocolVersion: Schema.Int })
export type VersionProbe = typeof VersionProbe.Type

/**
 * Sent instead of a welcome when a peer's hello can't be accepted; the connection then closes.
 *
 * This shape must stay the same in every protocol version, so that a peer of any version can read
 * why it was turned away.
 */
export const HandshakeRejected = Schema.TaggedStruct("HandshakeRejected", {
  reason: Schema.Literals(["ProtocolVersionMismatch", "MalformedHandshake"]),
  /** The rejecting side's protocol version. */
  protocolVersion: Schema.Int,
  /** Says what went wrong and which side to update, for logs and the UI. */
  message: Schema.String,
  /**
   * The commit the Hub runs, when it is the Hub rejecting a Runner: a Runner turned away for its
   * protocol version can still update to it (ADR 0011). Optional, so the shape stays one every
   * version reads.
   */
  hubVersion: Schema.optionalKey(BuildVersion),
})
export type HandshakeRejected = typeof HandshakeRejected.Type

/**
 * Checks a peer's hello (or the Hub's welcome) before it is decoded in full. Returns the
 * {@link HandshakeRejected} to send, or `undefined` when the versions match.
 */
export function checkHandshake(
  message: unknown,
  /** The Hub's commit, to tell a Runner it turns away (see {@link HandshakeRejected}). */
  hubVersion?: BuildVersion,
): HandshakeRejected | undefined {
  const version = hubVersion === undefined ? {} : { hubVersion }
  if (!Schema.is(VersionProbe)(message)) {
    return HandshakeRejected.make({
      reason: "MalformedHandshake",
      protocolVersion: ProtocolVersion,
      message: `Expected a handshake with a protocolVersion; this side speaks protocol version ${ProtocolVersion}.`,
      ...version,
    })
  }
  if (message.protocolVersion !== ProtocolVersion) {
    const older = message.protocolVersion < ProtocolVersion ? "the peer" : "this side"
    return HandshakeRejected.make({
      reason: "ProtocolVersionMismatch",
      protocolVersion: ProtocolVersion,
      message: `Protocol version mismatch: the peer speaks version ${message.protocolVersion}, this side speaks version ${ProtocolVersion}. Update ${older}.`,
      ...version,
    })
  }
  return undefined
}
