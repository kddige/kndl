import { Avatar as BaseAvatar } from "@base-ui/react/avatar"
import type { McpServer } from "@kndl/protocol"
import * as stylex from "@stylexjs/stylex"
import { hueFor } from "../ui/Avatar.tsx"
import { color, radius, text, weight } from "../ui/tokens.stylex.ts"

const styles = stylex.create({
  tile: {
    position: "relative",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
    overflow: "hidden",
    width: "2rem",
    height: "2rem",
    borderRadius: radius.md,
    fontSize: text.sm,
    fontWeight: weight.semibold,
    lineHeight: 1,
    userSelect: "none",
  },
  image: { width: "100%", height: "100%", objectFit: "contain" },
  // An MCP server keeps one hue, from its id; the theme decides how light and saturated it is.
  tint: (hue: number) => ({
    backgroundColor: `oklch(${color.avatarBgLightness} ${color.avatarBgChroma} ${hue})`,
    color: `oklch(${color.avatarFgLightness} ${color.avatarFgChroma} ${hue})`,
  }),
})

/**
 * Where the Hub serves the MCP server's icon (#230), or none while it has none. The Hub's own
 * origin, so the browser never contacts a third party; the hash busts the cache when the icon
 * changes.
 */
export function mcpServerIconUrl(
  mcpServer: Pick<McpServer, "id" | "iconHash">,
): string | undefined {
  return mcpServer.iconHash === undefined
    ? undefined
    : `/mcp/${encodeURIComponent(mcpServer.id)}/icon?v=${encodeURIComponent(mcpServer.iconHash)}`
}

/** The first letter of the name, in capitals. */
const letterOf = (name: string) => Array.from(name.trim())[0]?.toUpperCase() ?? "?"

/**
 * An MCP server's icon, or, while it has none or until (and if) it fails to load, the first letter
 * of its name on a tile colored by its id. The card names the MCP server, so this is decoration.
 */
export function McpServerAvatar({
  mcpServer,
  sx,
}: {
  mcpServer: Pick<McpServer, "id" | "name" | "iconHash">
  sx?: stylex.StyleXStyles
}) {
  const src = mcpServerIconUrl(mcpServer)
  return (
    <BaseAvatar.Root
      aria-hidden="true"
      {...stylex.props(styles.tile, styles.tint(hueFor(mcpServer.id)), sx)}
    >
      {src && <BaseAvatar.Image src={src} alt="" {...stylex.props(styles.image)} />}
      <BaseAvatar.Fallback {...(src && { delay: 300 })}>
        {letterOf(mcpServer.name)}
      </BaseAvatar.Fallback>
    </BaseAvatar.Root>
  )
}
