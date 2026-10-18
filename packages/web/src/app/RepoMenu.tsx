// A Repo's own places, from its row in the sidebar (#398): its Environment, its Archived Sessions,
// and the Repo on GitHub (navigation-ux.md #5).

import { Link } from "@tanstack/react-router"
import {
  ArchiveIcon,
  BoxIcon,
  ExternalLinkIcon,
  IconButton,
  Menu,
  MenuItem,
  MenuSeparator,
  MoreIcon,
} from "../ui/index.ts"
import { repoParams } from "./format.ts"

export function RepoMenu({ repo }: { repo: string }) {
  return (
    <Menu
      align="end"
      trigger={
        <IconButton label={`${repo} actions`} size="sm">
          <MoreIcon />
        </IconButton>
      }
    >
      <MenuItem
        icon={<BoxIcon />}
        render={<Link to="/repos/$owner/$repo/environment" params={repoParams(repo)} />}
      >
        Environment
      </MenuItem>
      <MenuItem
        icon={<ArchiveIcon />}
        render={<Link to="/repos/$owner/$repo/archived" params={repoParams(repo)} />}
      >
        Archived Sessions
      </MenuItem>
      <MenuSeparator />
      <MenuItem
        icon={<ExternalLinkIcon />}
        render={
          // oxlint-disable-next-line react/jsx-no-target-blank -- noopener is set
          <a href={`https://github.com/${repo}`} target="_blank" rel="noreferrer noopener" />
        }
      >
        Open on GitHub
      </MenuItem>
    </Menu>
  )
}
