import { type Attachment, attachmentKind, type SessionId } from "@kndl/protocol"
import * as stylex from "@stylexjs/stylex"
import { createContext, useContext } from "react"
import { useHub } from "../app/hub.tsx"
import { focus } from "../ui/shared.ts"
import { color, radius, space, text } from "../ui/tokens.stylex.ts"
import { fileSize } from "./attachments.ts"

/** The Session a transcript is of: for links to its agents, and to the files people sent. */
export const SessionContext = createContext<SessionId | null>(null)

const styles = stylex.create({
  list: {
    display: "flex",
    flexWrap: "wrap",
    gap: space.s2,
    margin: 0,
    padding: 0,
    listStyle: "none",
  },
  thumbnailLink: { display: "block", borderRadius: radius.md },
  thumbnail: {
    display: "block",
    maxWidth: "12rem",
    maxHeight: "8rem",
    objectFit: "contain",
    borderRadius: radius.md,
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: color.border,
    backgroundColor: color.surfaceMuted,
  },
  file: {
    display: "inline-flex",
    flexDirection: "column",
    maxWidth: "16rem",
    paddingBlock: space.s1_5,
    paddingInline: space.s2,
    borderRadius: radius.md,
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: color.border,
    backgroundColor: color.surfaceMuted,
    color: "inherit",
    fontSize: text.xs,
    textDecoration: { default: "none", ":hover": "underline" },
  },
  fileName: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  fileSize: { color: color.textTertiary },
})

/**
 * The files someone sent with a prompt (#276), a steered prompt, a message to a subagent or a
 * reply (#278): each image as a thumbnail that opens full size in a tab of its own, each PDF as a
 * chip, its name and size, that downloads it (#277). Nothing outside a Session's transcript.
 */
export function SentAttachments({
  attachments,
  label,
  sx,
}: {
  attachments: ReadonlyArray<Attachment> | undefined
  /** What the list is called, as "The prompt's attachments". */
  label: string
  sx?: stylex.StyleXStyles
}) {
  const hub = useHub()
  const sessionId = useContext(SessionContext)
  if (sessionId === null || attachments === undefined || attachments.length === 0) return null
  return (
    <ul aria-label={label} {...stylex.props(styles.list, sx)}>
      {attachments.map((attachment) => {
        const url = hub.attachmentUrl(sessionId, attachment.id)
        if (attachmentKind(attachment.mediaType) === "pdf")
          return (
            <li key={attachment.id}>
              <a
                href={url}
                download={attachment.name}
                title={`Download ${attachment.name}`}
                {...stylex.props(styles.file, focus.ring)}
              >
                <span {...stylex.props(styles.fileName)}>{attachment.name}</span>
                <span {...stylex.props(styles.fileSize)}>PDF · {fileSize(attachment.size)}</span>
              </a>
            </li>
          )
        return (
          <li key={attachment.id}>
            <a
              href={url}
              target="_blank"
              rel="noreferrer"
              title={attachment.name}
              {...stylex.props(styles.thumbnailLink, focus.ring)}
            >
              <img
                src={url}
                alt={attachment.name}
                loading="lazy"
                {...stylex.props(styles.thumbnail)}
              />
            </a>
          </li>
        )
      })}
    </ul>
  )
}
