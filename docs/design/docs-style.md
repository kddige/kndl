# Docs style

How the docs site (`packages/docs`, published at <https://kddige.github.io/kndl/>) is written, and the web UI's copy too: its Voice and Glossary terms sections, and [UI copy](#ui-copy), govern both. Follow it in every PR that changes the site or the UI's words, and change this file when a convention changes.

The bar is [Bun's docs](https://bun.sh/docs) and [Astro's](https://docs.astro.build): short pages, code first, one path through each task, and a clear next step. A reader should be able to skim a page's headings and commands and get the job done without reading a paragraph.

## Who reads the docs

Two readers come first. Write for both on every page in Get started and Self-hosting.

- **The developer trying kndl.** They install it on one machine, start a Session, and uninstall it if it isn't for them. They want the shortest path to something working, and a clean way out.
- **The team lead self-hosting it.** They put a Hub on a server, add Runners and invite people. They want to know what each machine needs, what's exposed, and what it costs to operate.

People using a Hub someone else runs read Guides. People working on kndl itself read Contributing.

## The rule above the rules

The site describes the code on `main`, not other docs. Check every command, flag, setting, default, path, UI label and quoted message against the code before you write it. Grep for a message before you quote it, and grep `packages/web/src` for a label before you name it. A wrong page is worse than a missing one.

- Document what exists. No "coming soon" and no docs for designs that only have an ADR. The issue tracker holds plans.
- A PR that changes behaviour updates the pages that describe it, in the same PR: the guide, the reference row, and the Troubleshooting entry that quotes its message.
- Describe kndl as it is, never how it got there. No "now", "new", "no longer" or "since #NN", and no migration notes. What changed belongs in release notes and PRs, and why in an ADR.

## Sections

The sidebar (`packages/docs/astro.config.mjs`) has these sections, in this order. Each page lives in exactly one, and links to the others instead of repeating them.

| Section | What goes in it | What doesn't |
|---|---|---|
| **Get started** | Introduction (what kndl is, who it's for, how it fits together), Quickstart (one machine, start to finish, then uninstall), Deploy for a team (the path from one machine to a team's Hub, as links). | Options, edge cases, settings. |
| **Guides** | One task for someone using a Hub: work in a Session, set up an Environment, add an MCP server. | Running the Hub or its machines. |
| **Self-hosting** | One task for whoever runs the Hub and Runners: install, expose the Hub, set up the GitHub App, add Runners, let people in, update. | Background: link to Concepts. |
| **Concepts** | How kndl works and why: the architecture, a Session's lifecycle, the security model. Diagrams and prose. | Steps to follow. |
| **Reference** | Commands, settings, paths and words, as tables, in the product's order. | Instructions or opinions. |
| **Troubleshooting** | Entries reached from what the reader sees: a message, a stuck state. | Background beyond what the fix needs. |
| **Contributing** | Developing kndl, the protocol, the ADRs. | Anything a user or operator needs. |

Moving or renaming a page: add the old path to `packages/docs/redirects.mjs`, so old links keep working, and fix the links in the repo.

## Voice

- **Second person, imperative, present tense.** "Install kndl", "Run `kndl onboard`", "The Runner clones the Repo". Say who does it.
- **Short sentences.** Aim for 10 to 20 words. One idea per sentence, two or three sentences per paragraph.
- **Lead with the action.** Put the command before the explanation, and the condition before the action: "To follow `main`, pass `--channel dev`."
- **No filler.** Cut "This page explains", "In this section", "simply", "just", "easy", "note that", "please", and any sentence that restates the heading. Don't end a section with a summary of it.
- **No marketing.** No "powerful", "seamless", "blazing", "effortless". Say what it does and let the reader judge.
- **Don't hedge, don't narrate the implementation.** Say what the reader sees and does. Link to Concepts or an ADR for how it works.
- **Sentence case** for titles and headings, except glossary terms, which keep their capitals ("Set up an Environment").
- **Name machines plainly:** **the Hub's machine**, **the Runner's machine**, **your laptop**.

## Page template

Every page in Get started, Guides and Self-hosting has this shape:

1. **Title:** the task, as an imperative ("Add a Runner"), or the thing for Introduction and Concepts.
2. **One sentence** saying what you'll have at the end. No heading above it.
3. **What you need:** a short list, only when there's something to have first. Link to where to get each thing.
4. **Steps**, in Starlight's `<Steps>`, or as `##` sections when each step has several parts. Each step is one action, says where it happens when that matters ("On the Runner's machine"), and has a command, a code block or a screenshot.
5. **What you should see:** after a step whose result isn't obvious, say what success looks like: the output, the page, the badge.
6. **Next steps:** two to four links, as a `<CardGrid>` of `<LinkCard>`s at the end.

Reference pages are tables with the same columns throughout the page, examples over prose, and defaults stated in their own column. A troubleshooting entry is a `##` heading naming the symptom as the reader would put it, then **What you see.** (the message, quoted exactly), **Why.** and **Fix.**

## Length

- A Get started, Guides or Self-hosting page stays under about **600 words**, code excluded. If it grows past that, split it into two tasks, or move the edge cases to Troubleshooting and the tables to Reference.
- Lead with what most readers need. An edge case most readers never meet goes in Troubleshooting or behind a link, not inline.
- Say a thing once. If two pages explain the same behaviour, keep it in one and link from the other.

## Glossary terms

`GLOSSARY.md` is the vocabulary. Use its terms with its capitals wherever they mean the domain thing: Hub, Runner, Session, Sandbox, Workspace, Repo, Environment, Build, Test build, Bootstrap script, Start script, Variable, Shared variable, Turn, Prompt queue, Participant, Creator, Session name, Work branch, Base branch, Pairing code, Claude credential, Harness, Handoff, Provider, Connected provider, Model, Thinking level, Release, Channel, and the states Active, Asleep, Frozen, Archived. Lowercase is for the ordinary word: a tmux session, an environment variable, a build of the web UI.

- Link a term to its glossary entry or its page on first use in a page, when the reader may not know it.
- Don't stack terms. "The Runner boots the Session's Sandbox from the Repo's Environment's Build" is four definitions in one sentence. Introduce one at a time, or say it plainly first and name it after.
- Don't invent synonyms: a Sandbox is never a "VM" or "container" in prose that means the Sandbox.

## UI copy

The web UI follows the Voice and Glossary terms above, and these:

- **Buttons and menu items** are a verb and its object: "Delete Session", "Copy link". A lone verb is fine where the object is plain from the surroundings.
- **Errors** say what failed, then the next step. Titles are "Couldn't {verb} {object}", or "{action} not sent" when the Hub isn't reachable.
- **Toast titles** are the object and a past participle: "Link copied", "Invite revoked". Add a description only when there's a next step.
- **Page descriptions** are one sentence of under 15 words, saying what the page holds.
- **States** use one word, the same everywhere: the glossary's Active, Asleep, Frozen and Archived, and "Working" and "Waiting on you".
- **The agent** is "the agent", unless the Harness is known. A Session may run on pi or Claude Code.
- **Plurals and lists** come from the helpers in `packages/web/src/app/format.ts` (`plural`, `counted`, `andList`), never `n === 1 ?`.
- **Shared strings** live in `packages/web/src/app/copy.ts`.

## Components

Starlight's components, imported in `.mdx` pages from `@astrojs/starlight/components`:

- **`<Steps>`** for any numbered procedure.
- **`<Tabs>` with `syncKey`** for variants the reader picks once: macOS or Linux, install or checkout.
- **`<CardGrid>` and `<LinkCard>`** for next steps at the end of a page, and for routing on Introduction. Not for features or decoration. A `LinkCard`'s `href` is a component prop, which the build doesn't prefix: write the base into it, `href="/kndl/start/quickstart/"`.
- **Asides**, sparingly, for what the reader must not miss: `:::danger` for data loss (the secrets key), `:::caution` for a security cost, `:::tip` for a shortcut. At most two per page. Ordinary detail goes in the text.
- **Diagrams** are Astro components with inline SVG in the theme's colours (`packages/docs/src/components/`), so they follow light and dark. No Mermaid: it renders as code.

## Screenshots

- **Where:** `packages/docs/src/assets/screenshots/`, as PNG at 2x of a 1280 × 800 window. Reference them with a relative Markdown image, `![…](../../../assets/screenshots/session.png)`, so Astro optimises them.
- **Light theme**, from the real web UI against the fake Hub (`VITE_FAKE_HUB=1 bun run web`), so they show made-up Sessions, Repos and people, and no real data. Crop to what the step is about when the whole window is noise.
- **Alt text** says what the screenshot shows that the reader needs, in a sentence: "The Runners page, with studio online and ci-box offline and behind the Hub."
- **One per step at most**, and only when it shows something words can't: a layout, where a button is, what success looks like.
- Retake a screenshot in the PR that changes what it shows.

## Commands, settings and messages

- Code font for commands, flags, settings, paths, file names, HTTP routes and anything typed verbatim: `kndl runner join`, `HUB_PUBLIC_URL`, `~/.kndl/hub.env`.
- **Bold** for UI labels, spelled exactly as the web UI spells them: **Add a Runner**, **Re-pair**, **Test build**.
- Placeholders in angle brackets inside code: `<name>`, `<session id>`. Example values look real and are the same across the site: `build-box` for a Runner, `hub.example.com` for a Hub, `owner/name` for a Repo, `chr_…` for a token.
- Command blocks are `sh` and contain only what to type. A comment says which machine or file when it matters. Output goes in its own block with no language.
- A quoted message is copied from the code; `…` stands for an interpolated or trailing part. Don't paraphrase a message in code font.
- Name both forms where they differ: `kndl …` for an install, `bun run …` for a checkout. The install is the main path; a checkout is for working on kndl (Contributing).
- Homes: `~/.kndl` for an install, `~/.kndl-dev` for a checkout. Say "the home" when it applies to both.

## Links

- Link with root-relative paths and a trailing slash: `/self-hosting/add-a-runner/#pairing-codes`. The build adds the `/kndl/` base. Link text says where it goes; never "here".
- `bun run docs:build` checks every internal link and `#anchor` in the built site (`packages/docs/scripts/check-links.ts`) and fails on a broken one. Renaming a heading changes its anchor: fix the links it breaks.
- The glossary and the ADRs are rendered from `GLOSSARY.md` and `docs/adr/`. Edit those, never a copy.

## Landing page

The landing page is `packages/docs/src/pages/index.astro`: one standalone page with its own markup and CSS, not the Starlight layout, so it repeats the `<head>` tags `astro.config.mjs` gives the other pages.

- **Shape.** One screen of hero: the tagline, one sentence on what kndl is, the install command with a copy button, **Get started** and **GitHub**, the campsite and a real screenshot. Then four short points, each one sentence with a link. Then "Try it, then remove it": the three commands from install to uninstall. Then the footer. Nothing else: everything else is in the docs.
- **Voice.** The same plain voice as the pages. The headline is the product's own tagline. A point says what a thing is and one detail the reader can check. Tells to cut: "not X but Y", one-line closers, a triad that exists only to be three, dashes as connectors.
- **Brand.** Night `#1D1733`, flame `#F6C445`, core `#FFEDB5`, logs `#8C5F47` and `#6B4A3A`, cheeks `#F59C8B` (`brand/drafts/README.md`); one accent, at most three hues. Fraunces (soft) for headings, JetBrains Mono for code. Motion is the flame, the sparks and the marshmallows' lean, all off under `prefers-reduced-motion`.
- **Real product.** The pictures of the web UI are real screenshots in `packages/docs/public/landing/`, of made-up Sessions, Repos and people, and the footer says so.
- **Leave out.** Feature icon sets, gradients and glows, stock indigo, testimonials, a centered template hero.

## Theme

The docs pages use the palette "Paper", in `packages/docs/src/styles/theme.css`: cream paper first, a muted night second, in the brand's colours. Light is `:root[data-theme="light"]`, dark is Starlight's `:root`, and a first visit follows `prefers-color-scheme`.

| Token                     | Light     | Dark      |
| ------------------------- | --------- | --------- |
| Page (`--sl-color-black`) | `#fbf6ea` | `#1b1823` |
| Sidebar                   | `#f6eedd` | `#1f1b27` |
| Code block                | `#f6eedd` | `#221e2a` |
| Body text (`gray-2`)      | `#3f332d` | `#d8cfc2` |
| Headings (`white`)        | `#271d18` | `#f6eee0` |
| Link text                 | `#7a4f38` | `#e3b48f` |
| Link underline            | `#e3b032` | `#b98a2c` |
| Current page fill         | `#6b4a3a` | `#4a362b` |
| Aside fill (every kind)   | `#f5ecda` | `#231f2b` |

- **Contrast.** Every text colour is at least 4.5:1 on its background, and code at least 5.5:1. Flame is never text on cream: it is only a fill or a rule (link underlines, focus rings, the tip aside's rule).
- **Fonts.** Fraunces (variable, `SOFT` 100, weight 600 to 800) on every heading, the sidebar's group labels and "On this page"; JetBrains Mono for code; the system sans for body text. They load from Google Fonts with `display=swap`, and a size-adjusted Times fallback keeps the headings from jumping.
- **Code.** Expressive Code themes in `packages/docs/src/styles/expressiveCodeThemes.ts`. A change to them leaves stale colours in Markdown pages Astro has cached: delete `node_modules/.astro/data-store.json` before a build.

## Sources

- [Bun's docs](https://bun.sh/docs): [Installation](https://bun.sh/docs/installation) and [Quickstart](https://bun.sh/docs/quickstart): one sentence of intro, then a command; tabs for platforms; uninstall on the install page.
- [Astro's docs](https://docs.astro.build): [Install and set up](https://docs.astro.build/en/install-and-setup/): prerequisites as a short list, numbered steps, "Next steps" at the end; [Getting started](https://docs.astro.build/en/getting-started/): routing readers with cards.
- [Diátaxis](https://diataxis.fr), which the sections still follow underneath: tasks, concepts and reference kept apart.
- [Google developer documentation style guide](https://developers.google.com/style): [procedures](https://developers.google.com/style/procedures), [code in text](https://developers.google.com/style/code-in-text), [timeless documentation](https://developers.google.com/style/timeless-documentation).
- [Starlight's components](https://starlight.astro.build/components/using-components/) and [sidebar guide](https://starlight.astro.build/guides/sidebar/).
