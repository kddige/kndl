# Navigation UX: the app sidebar

Research behind issue #76, which replaces the home-page Session list with an app sidebar. It records what comparable products do, what the usability and accessibility guidance says, and what claude-hub takes from each. It is a redesign of how existing pages are reached, not new features: the sidebar only shows data the web UI already has.

## Sources

### OpenClaw's Control UI

OpenClaw is the closest comparison: an open-source agent whose web Control UI is a list of long-running sessions you switch between.

- [Control UI docs](https://docs.openclaw.ai/web/control-ui): the sidebar's item is a session. In team mode, sessions sit under collapsible agent headers "in configured roster order, which stays stable as activity changes". Narrow screens get a slide-over drawer, opened from a compact header row that holds the drawer toggle and the brand.
- [PR #99289, session-first sidebar](https://github.com/openclaw/openclaw/pull/99289): session switching used to be buried under a 14-tab page nav and a dropdown. The rebuild puts "+ New session" at the top, then one-line session rows with a live-run dot, with a "tighter nav below".
- [PR #126713, simpler session indicators](https://github.com/openclaw/openclaw/pull/126713): two-line rows were noisy because "the same semantic position could land on a different visual axis from row to row". Rows became one line, with indicators in "one right-aligned rail with 16px slots", muted for normal states, coloured only for warnings and failures.
- [PR #160366](https://github.com/openclaw/openclaw/pull/160366) and [PR #153735](https://github.com/openclaw/openclaw/pull/153735): the mobile drawer was widened because titles truncated too early at 320px, and gutters were evened out (16px list gutter on desktop).

### Comparable apps

- **ChatGPT projects** ([forum: projects sidebar regression](https://community.openai.com/t/chatgpt-web-ui-projects-sidebar-ux-regression/1400030), [forum: project page view](https://community.openai.com/t/chatgpt-projects-no-longer-opens-the-same-project-page-view-as-before-chats-now-only-appear-in-the-sidebar/1381332)): when project chats moved into an expandable sidebar list, users said the folder-style grouping, with chats clearly under their project, scanned better than labels beside each chat. They also missed the project as a destination, now that its name only expands and collapses.
- **Claude.ai** ([help: projects](https://support.claude.com/en/articles/9519177-how-can-i-create-and-manage-projects)): "New chat" at the top, then Starred and Recents. A test puts Projects in the sidebar above recents.
- **Conductor** ([0.35.2: group workspaces by repo](https://www.conductor.build/changelog/0.35.2-group-workspaces-by-repo-gpt-5-3-codex-spark), [0.44.0: new sidebar](https://www.conductor.build/changelog/0.44.0-new-sidebar-rebuilt-composer-codex-checkpoints)): an agent manager for Claude Code worktrees. It added grouping workspaces by repository, and later a simpler sidebar that shows each workspace's git state at a glance.
- **Linear** ([How we redesigned the Linear UI](https://linear.app/now/how-we-redesigned-the-linear-ui), [personalized sidebar](https://linear.app/changelog/2024-12-18-personalized-sidebar)): the redesign set out "to reduce visual noise, maintain visual alignment, and increase the hierarchy and density of navigation elements", aligning labels, icons and buttons in the sidebar. Workspace-wide destinations sit in their own section, apart from the per-team groups.
- **Vercel** ([new dashboard navigation](https://vercel.com/changelog/new-dashboard-navigation-available)): moved from horizontal tabs to a sidebar with the same links at team and project level, ordered by how often they're used.

### Guidance

- NN/g, [Left-side vertical navigation](https://www.nngroup.com/articles/vertical-nav/): left-aligned, keyword-front-loaded, visible. Text labels, not icons alone. Less important items lower down. Don't keep two navigation systems for the same thing ("unnecessary and confusing").
- NN/g, [Hamburger menus and hidden navigation](https://www.nngroup.com/articles/hamburger-menus/) and [Is the hamburger icon recognizable?](https://www.nngroup.com/articles/hamburger-menu-icon-recognizability/): hiding navigation roughly halves its discoverability, and more so on desktop, so hide it only where space forces it. Where it's hidden, use the standard three-line icon in the top-left corner.
- NN/g, [Accordions on desktop](https://www.nngroup.com/articles/accordions-on-desktop/) and [accordion icons](https://www.nngroup.com/articles/accordion-icons/): let several sections stay open at once, keep each open or closed until the person changes it, and use a caret to signal that it expands in place.
- NN/g, [Navigation: you are here](https://www.nngroup.com/articles/navigation-you-are-here/): navigation should show where you are, not only where you can go.
- GitLab Pajamas, [navigation sidebar](https://design.gitlab.com/patterns/navigation-sidebar/): two levels at most, labels of one or two words, the sidebar hidden by default on narrow viewports.
- W3C APG, [disclosure navigation](https://w3.org/WAI/ARIA/apg/patterns/disclosure/examples/disclosure-navigation): a `nav` with an accessible name around plain lists of links; toggles are `button`s with `aria-expanded` and `aria-controls`; the current page's link has `aria-current="page"`. No `role="menu"`, so links keep their meaning and Tab works as usual.
- Primer, [NavList accessibility](https://primer.style/product/components/nav-list/accessibility/): the current item must not be shown by colour alone; collapsed and expanded groups must say so programmatically; a tree view is not a substitute for navigation.

## Recommendations for claude-hub

| # | Recommendation | Source | In claude-hub |
|---|---|---|---|
| 1 | One persistent left sidebar on desktop, never hidden behind a menu there. | NN/g vertical nav, hamburger study | The sidebar replaces the top header and the list on `/`. It's always visible from 48rem up. |
| 2 | Hub-wide destinations first, as a short labelled list with icons; Sessions under them. | Linear, Vercel, NN/g | **Environments**, **Shared variables** and **Archived Sessions**, then a **Sessions** heading. Three items keep the Sessions in view without scrolling. |
| 3 | Group Sessions by Repo in folder style: the Repo header, its Sessions indented under it. At most two levels. | ChatGPT feedback, Conductor, Pajamas | One group per Repo, sorted alphabetically, Sessions newest first. Sorting stays stable as activity changes (OpenClaw), so rows don't jump under the pointer. |
| 4 | Group toggles are disclosure buttons with a caret, `aria-expanded` and `aria-controls`; several can be open; each keeps its state. | APG, NN/g accordions, Primer | Collapse state is per viewer, in `localStorage` (wrapped in try/catch). Opening a Session in a collapsed group opens that group, so the current item is never hidden. |
| 5 | A destination inside a group header is its own control, separate from the toggle. | APG hybrid, ChatGPT feedback | The Repo header's toggle is the name; a trailing icon link opens the Repo on GitHub in a new tab, labelled "Open owner/repo on GitHub". The Repo's Environment stays one click away in the Environments index. |
| 6 | One-line rows with a fixed trailing rail for indicators; colour only for what needs attention. | OpenClaw #126713, Linear | A Session row: status dot, work branch (truncated, full name in the title), then a rail for the spinner (Working, Starting, Restarting) and a warning icon for "Environment changed". |
| 7 | Show where you are, not by colour alone, and say so to screen readers. | NN/g you-are-here, Primer, APG | The current item gets `aria-current="page"`, a filled background, medium weight and an accent bar at its start. General nav items are current on their pages too. |
| 8 | Text labels, one or two words, using the product's own terms. | NN/g, Pajamas | Glossary terms only: Session, Repo, Environment, Runner, Shared variables, Archived. |
| 9 | On narrow screens, a drawer behind the standard menu icon at the top left, in a slim top bar. | NN/g hamburger icon, OpenClaw, Pajamas | Below 48rem: a top bar with the menu button, the brand and New Session. The drawer is a modal dialog (focus trapped, Escape and the backdrop close it) and closes on navigation. It's 18rem wide, leaving room for branch names (OpenClaw #160366). |
| 10 | Don't keep a second navigation for the same destinations. | NN/g vertical nav | The "All Sessions" back buttons in page headers go: the sidebar, or the menu button on a phone, does that job (#77). |
| 11 | Dense but even: one row height, one gutter, aligned icons and labels. | Linear, OpenClaw #153735 | Rows are 28px tall (36px on touch screens), with a 16px icon slot and the kit's tokens for every space, size and colour. |
| 12 | The footer carries ambient status and the account. | OpenClaw, Linear | "2 of 2 Runners online" and the signed-in person's avatar menu with Sign out. |

## What changes in #76 because of this

- **The current item is marked with more than colour** (an accent bar and weight, not only a background), per Primer's accessibility rule.
- **A collapsed group opens when one of its Sessions becomes current**, so the "you are here" marker is never hidden.
- **The Repo header is a toggle with a separate GitHub link**, not a link that also toggles.
- **Repos sort alphabetically and stay put**; activity doesn't reorder them.
- **The redundant "All Sessions" back buttons go** (#77), since the sidebar is always one click or one tap away.
- **The Session view's heading leads with the work branch**, the name the sidebar uses for a Session, with the Repo as context (#78).
- **The nav label is "Archived Sessions"**, the glossary term, rather than "Archive"; its route is `/archive`.
- **The Environments index lists Repos from the Sessions the web knows**, Archived ones included. The web channel has no message that lists the Repos with an Environment, and adding one would be a new Hub feature, so a Repo whose Environment exists but has no Sessions isn't listed. It's still reachable by URL and from New Session.

## Left for later

- Page headers are styled separately in each view; a shared page header is #79.
- Session titles, search and filtering in the sidebar, and pinning are out of scope in #76.
