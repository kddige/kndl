---
status: accepted
---

# Attachments reach Claude through a tool the mod registers

People paste screenshots into Claude Code's terminal, and Claude sees them. kndl's web UI should let people do the same (#275), but every way a plugin puts a prompt into Claude Code is text only. Claude Code 2.1.296, run against a stub model server, showed it: `$.prompt.submit` doesn't expand pasted images for a plugin's prompt, `$.session.append` takes text blocks alone, and `$.session.send` and `$.fs.write` take text. What a plugin can hand the model unchanged is a tool's result: a `tool.call` hook for a tool the plugin registered may answer with an array of Messages API blocks, images and documents included, and they reach the API request as the `tool_result`'s content.

So an attachment is a file the Hub keeps, and Claude opens it with a tool.

## How it works

- **Upload.** The Composer uploads each file as soon as it is added, one `POST /sessions/<id>/attachments` per file: the raw body, its name URI-encoded in `x-kndl-filename`. It sits behind the sign-in cookie and the web UI's origin, for anyone with access to the Session who may prompt it (not Archived). The Hub reads at most 5 MB, the most the Messages API takes of an image, and keeps the file as the image type its bytes are, JPEG, PNG, GIF or WebP, whatever `Content-Type` says: the Messages API refuses an image whose type doesn't match its data. The upload's type is only a hint. It answers with a random 128-bit id. The web channel's WebSocket stays at Bun's default message size.
- **Storage.** An SQLite table of blobs, each row the Session's: purging the Session deletes them. A name is kept as one line without brackets, at most 100 characters, since it goes into the prompt.
- **Prompt.** `SendPrompt` carries the ids, which must be files its sender uploaded to that Session. The queued prompt, `DeliverPrompt` and the Turn's `TurnStarted` carry the attachments (id, name, type, size). The Hub fills `TurnStarted`'s in from the queued prompt, so the transcript shows them on replay, whatever the mod says. An image alone is a prompt.
- **Reference.** hub-link-commands submits the prompt with a marker per file after its text, in the terminal's style with the id: `[Image #1: shot.png (attachment <id>)]`. hub-link adds hidden `context` to that prompt, through `prompt.submit`, telling Claude to open each file before answering: a plugin's own hooks don't see the prompt it submits, so hub-link-commands says the context in its `delivered` state. The system prompt says what a marker is, which later paths that carry the marker alone (#278) rely on.
- **Tool.** `mcp__hub-link-commands__attachment({ id })`, registered at `session.start` with `isDeferred: false`, so it is in the tool list from the first request, not behind ToolSearch. It fetches `GET /mod/attachments/<id>?offset=<n>` through the Runner's `/mod/*` relay, which serves only the mod's own Session's files, as JSON with the bytes in base64: the mod runtime's `$.http.fetch` reads a body as text, and refuses one over 4 MiB (Claude Code 2.1.296), which a 5 MB image's base64 is. So the Hub answers in parts of 2.4 MB, 3.2 MB of base64, each saying where the next starts, and the tool joins them. It answers with a text block naming the file and an image block. hub-link reports the call like any other, its result summarised as text and `[image/png]`, never the bytes.
- **Display.** `GET /sessions/<id>/attachments/<attId>` serves a file to anyone who can see the Session, as its sniffed type, with `nosniff`, `Content-Security-Policy: sandbox` and `Cross-Origin-Resource-Policy: same-origin`. The Turn shows a thumbnail of each, which opens full size; the queue says how many images a prompt carries.
- **Steering.** A prompt with attachments can't be steered yet: it waits for the Turn to end, and the Hub says so (#278).

## Considered options

- **Write the file into the Workspace and ask Claude to Read it.** Read shows Claude an image, and no tool is needed. But the file lands in the Repo's checkout, where `git add -A` commits it, every file needs a path no one else's clashes with, and Claude must be trusted to Read it.
- **Wait for Claude Code to take images in a plugin's prompt.** The simplest for kndl, but nothing says when, and people paste screenshots now.
- **One tool call for several ids.** Fewer round trips, but a Messages API request is capped at 32 MB, and twenty 5 MB images in one result would pass it. One file per call keeps each result under the cap.

## Consequences

- **One tool call per file.** Claude spends a step on each file, and a prompt with many files is slower to start.
- **Subagent types that list their own tools can't open attachments.** General-purpose subagents get the tool; one whose definition lists its tools doesn't, unless it lists this one.
- **The terminal shows the markers.** Anyone at the Session's terminal sees `[Image #1: …]` lines, not the image.
- **The Hub holds people's files** for as long as the Session lives. Files uploaded and never sent are cleaned up later (#280).
- **base64 costs a third.** A 5 MB image is about 6.7 MB of JSON from the Hub to the mod, in three requests.
