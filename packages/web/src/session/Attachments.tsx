import type { AttachmentId } from "@kndl/protocol"
import * as stylex from "@stylexjs/stylex"
import { useEffect, useRef, useState } from "react"
import type { UploadOptions } from "../hub/transport.ts"
import { CloseIcon, IconButton } from "../ui/index.ts"
import { color, radius, space, text } from "../ui/tokens.stylex.ts"
import { admitImages } from "./attachments.ts"

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
  failed: { color: color.dangerSubtleText },
  thumbnail: {
    flexShrink: 0,
    width: "2rem",
    height: "2rem",
    objectFit: "cover",
    borderRadius: radius.sm,
  },
  label: {
    display: "flex",
    flexDirection: "column",
    minWidth: 0,
    fontSize: text.xs,
  },
  name: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  note: { color: color.textSubtle, overflow: "hidden", textOverflow: "ellipsis" },
  refused: { margin: 0, color: color.dangerSubtleText, fontSize: text.xs },
})

/** Uploads a file to attach to the prompt: the Hub's id for it. */
export type Attach = (file: File, options: UploadOptions) => Promise<AttachmentId>

/** A file added to the draft, as its chip shows it. */
export interface AttachmentChip {
  readonly key: number
  readonly name: string
  /** The browser's own copy of the image, for the thumbnail. */
  readonly preview: string
  readonly size: number
  /** The bytes sent so far. */
  readonly sent: number
  readonly upload:
    | { readonly _tag: "Uploading" }
    | { readonly _tag: "Uploaded"; readonly id: AttachmentId }
    | { readonly _tag: "Failed"; readonly reason: string }
}

/**
 * The files attached to a Composer's draft (#276). Each is uploaded as soon as it is added; a
 * prompt goes once every one has, carrying their ids. A file Claude can't read is refused before
 * it is uploaded, saying why.
 */
export function useAttachments(attach: Attach | undefined) {
  const next = useRef(1)
  const [chips, setChips] = useState<ReadonlyArray<AttachmentChip>>([])
  const [refused, setRefused] = useState<ReadonlyArray<string>>([])
  const uploads = useRef(
    new Map<number, { readonly abort: AbortController; readonly preview: string }>(),
  )

  // A draft left behind gives up its uploads.
  useEffect(() => {
    const open = uploads.current
    return () => {
      for (const { abort, preview } of open.values()) {
        abort.abort()
        URL.revokeObjectURL(preview)
      }
      open.clear()
    }
  }, [])

  const change = (key: number, update: (chip: AttachmentChip) => AttachmentChip) =>
    setChips((all) => all.map((chip) => (chip.key === key ? update(chip) : chip)))

  const add = (files: ReadonlyArray<File>) => {
    if (attach === undefined) return
    const admitted = admitImages(files, chips.length)
    setRefused(admitted.refused)
    const added = admitted.accepted.map((file): AttachmentChip => {
      const key = next.current++
      const preview = URL.createObjectURL(file)
      const abort = new AbortController()
      uploads.current.set(key, { abort, preview })
      attach(file, {
        onProgress: (sent) => change(key, (chip) => ({ ...chip, sent })),
        signal: abort.signal,
      }).then(
        (id) =>
          change(key, (chip) => ({ ...chip, sent: chip.size, upload: { _tag: "Uploaded", id } })),
        (error: unknown) => {
          if (abort.signal.aborted) return
          const reason =
            error instanceof Error && error.message !== "" ? error.message : "It failed."
          change(key, (chip) => ({ ...chip, upload: { _tag: "Failed", reason } }))
        },
      )
      return {
        key,
        name: file.name,
        preview,
        size: file.size,
        sent: 0,
        upload: { _tag: "Uploading" },
      }
    })
    setChips((all) => [...all, ...added])
  }

  const forget = (key: number) => {
    const upload = uploads.current.get(key)
    if (upload === undefined) return
    upload.abort.abort()
    URL.revokeObjectURL(upload.preview)
    uploads.current.delete(key)
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
    /** Whether the prompt must wait: a file is still uploading, or failed and is still there. */
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
function chipNote(chip: AttachmentChip): string | undefined {
  switch (chip.upload._tag) {
    case "Uploading":
      return `Uploading ${chip.size === 0 ? 0 : Math.floor((chip.sent / chip.size) * 100)}%`
    case "Failed":
      return chip.upload.reason
    case "Uploaded":
      return undefined
  }
}

/** A chip for each file attached to the draft, with its thumbnail and remove; and any refused. */
export function AttachmentChips({
  chips,
  refused,
  onRemove,
}: {
  chips: ReadonlyArray<AttachmentChip>
  refused: ReadonlyArray<string>
  onRemove: (chip: AttachmentChip) => void
}) {
  return (
    <>
      {refused.length > 0 && (
        <p aria-label="Attachments refused" role="status" {...stylex.props(styles.refused)}>
          {refused.join(" ")}
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
                <img src={chip.preview} alt="" {...stylex.props(styles.thumbnail)} />
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
