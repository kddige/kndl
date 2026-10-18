import { type AttachmentId, attachmentKind, AttachmentKinds, megabytes } from "@kndl/protocol"
import * as stylex from "@stylexjs/stylex"
import { useEffect, useRef, useState } from "react"
import type { UploadOptions } from "../hub/transport.ts"
import { CloseIcon, IconButton } from "../ui/index.ts"
import { color, radius, space, text, weight } from "../ui/tokens.stylex.ts"
import { admitAttachments, fileSize } from "./attachments.ts"
import { browserCodec, downscale } from "./downscale.ts"

const styles = stylex.create({
  chips: {
    display: "flex",
    flexWrap: "wrap",
    gap: space.s1_5,
    margin: 0,
    padding: 0,
    listStyle: "none",
  },
  chip: {
    display: "inline-flex",
    alignItems: "center",
    gap: space.s1_5,
    minWidth: 0,
    maxWidth: "16rem",
    paddingInlineStart: space.s1,
    borderRadius: radius.md,
    backgroundColor: color.surfaceMuted,
  },
  failed: { color: color.dangerText },
  thumbnail: {
    flexShrink: 0,
    width: "2rem",
    height: "2rem",
    objectFit: "cover",
    borderRadius: radius.sm,
  },
  document: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
    width: "2rem",
    height: "2rem",
    borderRadius: radius.sm,
    backgroundColor: color.surface,
    color: color.textTertiary,
    fontSize: text.xs,
    fontWeight: weight.semibold,
  },
  label: {
    display: "flex",
    flexDirection: "column",
    minWidth: 0,
    fontSize: text.xs,
  },
  name: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  note: { color: color.textTertiary, overflow: "hidden", textOverflow: "ellipsis" },
  refused: { margin: 0, color: color.dangerText, fontSize: text.xs },
})

/** Uploads a file to attach to the prompt: the Hub's id for it. */
export type Attach = (file: File, options: UploadOptions) => Promise<AttachmentId>

/** A file added to the draft, as its chip shows it. */
export interface AttachmentChip {
  readonly key: number
  readonly name: string
  /** The browser's own copy of an image, for the thumbnail; none for a PDF (#277). */
  readonly preview?: string | undefined
  readonly size: number
  /** The bytes sent so far. */
  readonly sent: number
  readonly upload:
    | { readonly _tag: "Scaling" }
    | { readonly _tag: "Uploading" }
    | { readonly _tag: "Uploaded"; readonly id: AttachmentId }
    | { readonly _tag: "Failed"; readonly reason: string }
}

/** The browser's codec, once: none where it can't draw, as in tests. */
const codec = browserCodec()

/** Scales an image down as Claude Code does a pasted one (downscale.ts). */
const scaleDown = (file: File) =>
  codec === undefined
    ? Promise.resolve(file)
    : downscale(file, codec, AttachmentKinds.image.maxBytes)

/**
 * The files attached to a Composer's draft (#276, #277), pasted, dropped or picked. Each is
 * uploaded as soon as it is added, an image scaled down first; a prompt goes once every one has,
 * carrying their ids. A file Claude can't read is refused before it is uploaded, saying why.
 * Without `attach` the draft takes none, and files added say `cantAttach`; files it took before
 * stay for the next prompt that can.
 */
export function useAttachments(
  attach: Attach | undefined,
  cantAttach: string,
  prepare: (file: File) => Promise<File> = scaleDown,
) {
  const next = useRef(1)
  const [chips, setChips] = useState<ReadonlyArray<AttachmentChip>>([])
  const [refused, setRefused] = useState<ReadonlyArray<string>>([])
  // Counted as files are added, not from the last render: two pastes before it still hold 20.
  const held = useRef(0)
  const uploads = useRef(
    new Map<number, { readonly abort: AbortController; readonly preview?: string | undefined }>(),
  )

  // A draft left behind gives up its uploads.
  useEffect(() => {
    const open = uploads.current
    return () => {
      for (const { abort, preview } of open.values()) {
        abort.abort()
        if (preview !== undefined) URL.revokeObjectURL(preview)
      }
      open.clear()
    }
  }, [])

  const change = (key: number, update: (chip: AttachmentChip) => AttachmentChip) =>
    setChips((all) => all.map((chip) => (chip.key === key ? update(chip) : chip)))

  const send = async (key: number, file: File, abort: AbortController, upload: Attach) => {
    const failed = (reason: string) =>
      change(key, (chip) => ({ ...chip, upload: { _tag: "Failed", reason } }))
    // A PDF goes as it is: its size was checked as it was added.
    const image = attachmentKind(file.type) === "image"
    const scaled = image ? await prepare(file) : file
    if (abort.signal.aborted) return
    // The Hub refuses it all the same; said here, before it is sent.
    const { maxBytes } = AttachmentKinds.image
    if (image && scaled.size > maxBytes)
      return failed(`It is over ${megabytes(maxBytes)}, even scaled down.`)
    change(key, (chip) => ({
      ...chip,
      name: scaled.name,
      size: scaled.size,
      upload: { _tag: "Uploading" },
    }))
    try {
      const id = await upload(scaled, {
        onProgress: (sent) => change(key, (chip) => ({ ...chip, sent })),
        signal: abort.signal,
      })
      change(key, (chip) => ({ ...chip, sent: chip.size, upload: { _tag: "Uploaded", id } }))
    } catch (error) {
      if (abort.signal.aborted) return
      failed(error instanceof Error && error.message !== "" ? error.message : "It failed.")
    }
  }

  const add = (files: ReadonlyArray<File>) => {
    if (attach === undefined) return setRefused([cantAttach])
    const admitted = admitAttachments(files, held.current)
    held.current += admitted.accepted.length
    setRefused(admitted.refused)
    const added = admitted.accepted.map((file): AttachmentChip => {
      const key = next.current++
      const image = attachmentKind(file.type) === "image"
      const preview = image ? URL.createObjectURL(file) : undefined
      const abort = new AbortController()
      uploads.current.set(key, { abort, preview })
      void send(key, file, abort, attach)
      return {
        key,
        name: file.name,
        preview,
        size: file.size,
        sent: 0,
        upload: image ? { _tag: "Scaling" } : { _tag: "Uploading" },
      }
    })
    setChips((all) => [...all, ...added])
  }

  const forget = (key: number) => {
    const upload = uploads.current.get(key)
    if (upload === undefined) return
    upload.abort.abort()
    if (upload.preview !== undefined) URL.revokeObjectURL(upload.preview)
    uploads.current.delete(key)
    held.current--
  }

  const uploaded = chips.flatMap((chip) =>
    chip.upload._tag === "Uploaded" ? [chip.upload.id] : [],
  )
  return {
    chips,
    refused,
    add,
    /** Takes the file out of the draft, giving up its upload. */
    remove: (chip: AttachmentChip) => {
      forget(chip.key)
      setChips((all) => all.filter((other) => other.key !== chip.key))
    },
    /** The ids of the files uploaded, in the order they were added. */
    ids: uploaded,
    /** Whether the prompt must wait: a file is still on its way, or failed and is still there. */
    holding: uploaded.length !== chips.length,
    /** Forgets every file, once the prompt with them is sent. */
    clear: () => {
      for (const chip of chips) forget(chip.key)
      setChips([])
      setRefused([])
    },
  }
}

/** What a chip says under its file's name: how far its upload is, or why it failed. */
function uploadNote(chip: AttachmentChip): string | undefined {
  switch (chip.upload._tag) {
    case "Scaling":
      return "Scaling down"
    case "Uploading":
      return `Uploading ${chip.size === 0 ? 0 : Math.floor((chip.sent / chip.size) * 100)}%`
    case "Failed":
      return chip.upload.reason
    case "Uploaded":
      return undefined
  }
}

/** The note under a chip's name: a PDF, which has no thumbnail, says its size too (#277). */
function chipNote(chip: AttachmentChip): string | undefined {
  const note = uploadNote(chip)
  if (chip.preview !== undefined) return note
  return note === undefined ? fileSize(chip.size) : `${fileSize(chip.size)} · ${note}`
}

/** A chip for each file attached to the draft, with its thumbnail and remove; and any refused. */
export function AttachmentChips({
  chips,
  refused,
  waiting,
  onRemove,
}: {
  chips: ReadonlyArray<AttachmentChip>
  refused: ReadonlyArray<string>
  /** Why the chips aren't sent with what is written now, as a reply. */
  waiting?: string | undefined
  onRemove: (chip: AttachmentChip) => void
}) {
  // A refusal of what was pasted just now says it, and nothing else need.
  const said =
    refused.length > 0 ? refused : waiting !== undefined && chips.length > 0 ? [waiting] : []
  return (
    <>
      {said.length > 0 && (
        <p aria-label="Attachments refused" role="status" {...stylex.props(styles.refused)}>
          {said.join(" ")}
        </p>
      )}
      {chips.length > 0 && (
        <ul aria-label="Attachments" {...stylex.props(styles.chips)}>
          {chips.map((chip) => {
            const note = chipNote(chip)
            return (
              <li
                key={chip.key}
                {...stylex.props(styles.chip, chip.upload._tag === "Failed" && styles.failed)}
              >
                {chip.preview === undefined ? (
                  <span aria-hidden="true" {...stylex.props(styles.document)}>
                    PDF
                  </span>
                ) : (
                  <img src={chip.preview} alt="" {...stylex.props(styles.thumbnail)} />
                )}
                <span {...stylex.props(styles.label)}>
                  <span {...stylex.props(styles.name)} title={chip.name}>
                    {chip.name}
                  </span>
                  {note !== undefined && <span {...stylex.props(styles.note)}>{note}</span>}
                </span>
                <IconButton size="sm" label={`Remove ${chip.name}`} onClick={() => onRemove(chip)}>
                  <CloseIcon />
                </IconButton>
              </li>
            )
          })}
        </ul>
      )}
    </>
  )
}
