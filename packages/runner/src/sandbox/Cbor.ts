// The little CBOR (RFC 8949) agentd's messages take (AgentTcp.ts): maps with text keys, integers,
// text, bytes, arrays, booleans and null, and floats and tags as far as reading them. Not a
// general codec: enough for the envelope `{v, t, p}` and the `core.tcp.*` payloads.

export type CborValue =
  | number
  | string
  | Uint8Array
  | boolean
  | null
  | undefined
  | ReadonlyArray<CborValue>
  | { readonly [key: string]: CborValue }

const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder()

/** The head of an item: its major type and its argument, as short as it fits. */
const head = (major: number, n: number): Array<number> => {
  const m = major << 5
  if (n < 24) return [m | n]
  if (n < 0x100) return [m | 24, n]
  if (n < 0x10000) return [m | 25, n >> 8, n & 0xff]
  if (n < 0x100000000) {
    return [m | 26, (n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]
  }
  const bytes = [m | 27]
  for (let shift = 7; shift >= 0; shift--) bytes.push(Math.floor(n / 2 ** (8 * shift)) & 0xff)
  return bytes
}

/** Encodes a value; a key whose value is `undefined` is left out. */
export const encodeCbor = (value: CborValue): Uint8Array => {
  const parts: Array<ArrayLike<number>> = []
  let length = 0
  const push = (part: ArrayLike<number>) => {
    parts.push(part)
    length += part.length
  }
  const item = (x: CborValue): void => {
    if (x === null || x === undefined) return push([0xf6])
    if (x === true) return push([0xf5])
    if (x === false) return push([0xf4])
    if (typeof x === "number") {
      if (!Number.isSafeInteger(x)) throw new Error(`cbor: ${x} is not an integer`)
      return push(x >= 0 ? head(0, x) : head(1, -1 - x))
    }
    if (typeof x === "string") {
      const bytes = textEncoder.encode(x)
      push(head(3, bytes.length))
      return push(bytes)
    }
    if (x instanceof Uint8Array) {
      push(head(2, x.length))
      return push(x)
    }
    if (Array.isArray(x)) {
      push(head(4, x.length))
      for (const element of x as ReadonlyArray<CborValue>) item(element)
      return
    }
    const entries = Object.entries(x).filter(([, v]) => v !== undefined)
    push(head(5, entries.length))
    for (const [key, v] of entries) {
      item(key)
      item(v)
    }
  }
  item(value)
  const out = new Uint8Array(length)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

/** Decodes one item. Byte strings are views into `bytes`. */
export const decodeCbor = (bytes: Uint8Array): CborValue => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let i = 0
  const need = (n: number) => {
    if (i + n > bytes.length) throw new Error("cbor: the item runs past the end")
  }
  const argument = (info: number): number => {
    if (info < 24) return info
    const size = info === 24 ? 1 : info === 25 ? 2 : info === 26 ? 4 : info === 27 ? 8 : 0
    if (size === 0) throw new Error(`cbor: unsupported argument ${info}`)
    need(size)
    let n = 0
    for (let k = 0; k < size; k++) n = n * 256 + (bytes[i++] ?? 0)
    return n
  }
  const item = (): CborValue => {
    need(1)
    const initial = bytes[i++] ?? 0
    const major = initial >> 5
    const info = initial & 31
    switch (major) {
      case 0:
        return argument(info)
      case 1:
        return -1 - argument(info)
      case 2: {
        const n = argument(info)
        need(n)
        const out = bytes.subarray(i, i + n)
        i += n
        return out
      }
      case 3: {
        const n = argument(info)
        need(n)
        const out = textDecoder.decode(bytes.subarray(i, i + n))
        i += n
        return out
      }
      case 4:
        return Array.from({ length: argument(info) }, item)
      case 5: {
        const n = argument(info)
        const out: Record<string, CborValue> = {}
        for (let k = 0; k < n; k++) {
          const key = item()
          out[String(key)] = item()
        }
        return out
      }
      case 6:
        argument(info)
        return item()
      case 7: {
        if (info === 20) return false
        if (info === 21) return true
        if (info === 22 || info === 23) return null
        if (info === 25) {
          need(2)
          const half = view.getUint16(i)
          i += 2
          return halfToNumber(half)
        }
        if (info === 26) {
          need(4)
          const out = view.getFloat32(i)
          i += 4
          return out
        }
        if (info === 27) {
          need(8)
          const out = view.getFloat64(i)
          i += 8
          return out
        }
        throw new Error(`cbor: unsupported simple value ${info}`)
      }
    }
    throw new Error(`cbor: unsupported major type ${major}`)
  }
  return item()
}

const halfToNumber = (half: number) => {
  const exponent = (half >> 10) & 0x1f
  const fraction = half & 0x3ff
  const sign = half & 0x8000 ? -1 : 1
  if (exponent === 0) return sign * 2 ** -14 * (fraction / 1024)
  if (exponent === 31) return fraction === 0 ? sign * Infinity : Number.NaN
  return sign * 2 ** (exponent - 15) * (1 + fraction / 1024)
}
