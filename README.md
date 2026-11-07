# Apple Notes Plugin 📝 - Your notes, in every AI assistant

<p align="center">
  <img src="docs/assets/banner.svg" alt="Apple Notes Plugin: search, read and write your notes from any AI assistant.">
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/apple-notes-plugin"><img src="https://img.shields.io/npm/v/apple-notes-plugin?style=flat-square&color=cb3837&logo=npm" alt="npm version"></a>
  <img src="https://img.shields.io/badge/platform-macOS-lightgrey?style=flat-square&logo=apple" alt="Platform: macOS">
  <img src="https://img.shields.io/badge/MCP-server-6E56CF?style=flat-square" alt="MCP server">
  <img src="https://img.shields.io/badge/dependencies-0-brightgreen?style=flat-square" alt="Zero dependencies">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue?style=flat-square" alt="MIT license"></a>
</p>

<p align="center">
  <b>Ask your AI about your notes. It finds them, reads them, and writes new ones.</b><br>
  One line to set up. Zero dependencies. It can never delete a note.
</p>

```bash
claude mcp add --scope user apple-notes -- npx -y apple-notes-plugin
```

That is the whole setup for Claude Code.
Cursor, Codex, Claude Desktop, VS Code and any other [MCP](https://modelcontextprotocol.io) tool work too: see [Connect your AI tool](docs/clients.md).

[Why this one](#why-this-one) · [What you can ask](#what-you-can-ask) · [Setup](#setup) · [Safety](#safety) · [Tools](docs/tools.md) · [Command line](docs/tools.md#command-line)

## Your notes already know things your AI doesn't

Meeting notes, design sketches, debugging logs, that one command you saved two years ago.
It all lives in Apple Notes, and your AI assistant can't see any of it.
So you dig for the note, copy it, paste it into the chat, and do it again tomorrow.

Apple Notes Plugin gives your assistant direct access to your notes.
Ask a question and it searches your notes, opens the right one and answers.
Ask it to write something down and the note appears in Notes, synced to your iPhone and iPad like any other note.

## What you can ask

```
What did I write down about the Postgres migration?
Find my notes that mention Acme and summarize what we decided.
Open my "API design" note and turn it into a task list.
Save a summary of this debugging session in my Work folder as "Auth bug postmortem".
Add a "Next steps" section to my "v2 Launch Plan" note.
Make a note called "Bug 412" with this screenshot: ~/Desktop/error.png
Look at the diagram in my "Architecture" note and explain it.
```

## Why this one

Most people want their AI to do three things with notes: find one, read it, and write something down.
This plugin does those three things very well, and nothing that could hurt your notes.

| | |
| --- | --- |
| ⚡ **Setup** | One command. No Full Disk Access, no Shortcuts to import, no helper apps. macOS asks once, you click OK. |
| 🛡️ **Safety** | No delete tool exists. Every edit is backed up first. Notes with images or files are never rewritten. |
| 🔍 **Search** | Typo-tolerant and order-free: `stagng deploy` finds *Deploy steps for staging*. Titles first, then the text inside notes. |
| 🖼️ **Images** | Your AI sees the screenshots and diagrams in a note, not just the text around them. |
| 🪶 **Tokens** | Six tools, about 1,200 tokens of context. Search returns short snippets, not whole notes. |
| 🔒 **Privacy** | Runs entirely on your Mac. No network calls, no accounts, no telemetry. Locked notes stay hidden, and you choose [which notes your AI never sees](#keep-notes-away-from-your-ai). |
| 📄 **Trust** | One file of about 680 lines, zero dependencies. Read every line that touches your notes in a few minutes. |

**Fast, too.** A search across about 270 notes, titles and text, takes under a second.

**When to pick something else:** if you want your AI to manage tags, checklists, tables or pinned notes, or to move and delete notes in bulk, a larger Notes server will suit you better.
This plugin chooses to do less, so that it is simple to set up and safe to leave connected.

## Setup

You need macOS and [Node.js](https://nodejs.org) 18 or later.
There is nothing to download or clone: your AI tool fetches the plugin from npm the first time it starts.

```bash
# Claude Code
claude mcp add --scope user apple-notes -- npx -y apple-notes-plugin

# Codex
codex mcp add apple-notes -- npx -y apple-notes-plugin
```

For Cursor, Claude Desktop and VS Code, add this to the tool's MCP config:

```json
{
  "mcpServers": {
    "apple-notes": { "command": "npx", "args": ["-y", "apple-notes-plugin"] }
  }
}
```

The first time the plugin runs, macOS asks whether your AI tool may control Notes.
Click **OK**.
Exact config file locations for each tool are in [Connect your AI tool](docs/clients.md).

## The tools

| Tool               | What it does                                                                                   |
| ------------------ | ---------------------------------------------------------------------------------------------- |
| **`search_notes`** | Finds notes in every account and folder. Titles rank first, then text matches with a snippet.  |
| **`get_note`**     | Reads a note as Markdown, so headings and lists survive, and hands over its images.            |
| **`list_folders`** | Shows every folder and how many notes it holds, so your AI knows where to put things.          |
| **`create_note`**  | Writes a new note from Markdown, with images from your Mac.                                    |
| **`update_note`**  | Adds to the end of a note, or replaces its content. Backs up the old version first.            |
| **`health`**       | Checks access to Notes and counts notes, so your AI can tell "not found" from "no access".    |

Full inputs and outputs are in the [tools reference](docs/tools.md).
No MCP in your agent?
Every tool is also a [shell command](docs/tools.md#command-line).

## Safety

Notes has no undo for changes made by scripts, so the plugin is careful by design:

- **No delete.** No tool can delete a note or a folder. There is no code for it.
- **Backups.** Before every edit, the old note is saved to `~/.apple-notes-mcp/backups/`.
- **Exact ids for edits.** `update_note` needs the id from a search. A loose title match can never edit the wrong note.
- **Attachments are protected.** Editing a note rewrites its whole body, which would remove its images and files. So the plugin refuses to edit notes with attachments.
- **Locked notes stay private.** They are hidden from search, and their contents are never shown to your AI.
- **Recently Deleted is read-only.** Nothing there can be edited, and nothing new can be created there. This works in every macOS language.
- **No guessing.** If two notes share a title, or two folders share a name, the plugin asks for an exact id or path instead of picking one.

## Keep notes away from your AI

Some notes are not for your AI: health, money, a personal journal on a work laptop.
Hide them in either of two ways:

- **Tag a note `#private`.** Type `#private` anywhere in the note.
- **Exclude whole folders.** Set `APPLE_NOTES_EXCLUDE` to a comma-separated list of folder names. Their subfolders are hidden too.

```bash
claude mcp add --scope user apple-notes -e APPLE_NOTES_EXCLUDE="Personal,Journal" -- npx -y apple-notes-plugin
```

A hidden note does not appear in search, and it cannot be read or edited.
Nothing can be created in an excluded folder.
The server also tells your AI not to reach hidden notes another way.
Your AI never learns the names of excluded folders, only how many notes are hidden.
Run `npx -y apple-notes-plugin health` in a terminal to see the full picture, including any excluded name that matches no folder, which catches typos.

This is a filter in the plugin, not encryption.
For notes that must stay secret from everything, lock them in Notes.

## Make your AI actually use your notes

Connecting the plugin is not enough.
An AI tool reaches for your notes only when something tells it to, and a general hint such as "check my notes" is usually skipped.
Name the moments.
Add a section like this to your project's `CLAUDE.md` or `AGENTS.md`, and fill in your own folder and triggers:

```markdown
## Apple Notes

Design notes and decisions for this project live in Apple Notes, in the folder `Projects/<this repo>`.
The `apple-notes` MCP server reaches them.

- Before you change <the database schema>, <the public API> or <the deploy process>,
  run `search_notes` with `folder: "Projects/<this repo>"` and read what comes back.
- In your plan, name the notes you relied on. If nothing was found, say so.
- When you finish a task, append a short entry to the note "<this repo> log" with
  `update_note`: what changed, what you decided and why, and what is still open.
- If a search returns nothing that should exist, call `health` before you conclude it is missing.
```

Three to five specific triggers work better than one general rule.
The model can match a named action, such as "changing the schema", against the task in front of it.

## How it works

`server.js` is a standard MCP server over stdio.
It talks to Notes through `osascript`, the scripting tool built into macOS, so it needs no extra permissions beyond the one macOS prompt.
Run it with arguments and it becomes a command-line tool instead.

## Documentation

| Goal                                    | Start here                                             |
| --------------------------------------- | ------------------------------------------------------ |
| Connect Claude Code, Cursor, Codex, …   | [Connect your AI tool](docs/clients.md)                |
| Learn what each tool accepts            | [Tools reference](docs/tools.md)                       |
| Write notes with Markdown               | [Supported Markdown](docs/tools.md#supported-markdown) |
| Use it from a script or non-MCP agent   | [Command line](docs/tools.md#command-line)             |
| Fix a permission or setup problem       | [Troubleshooting](docs/clients.md#troubleshooting)     |

## Development

There is nothing to install.
Everything is in `server.js`.

```bash
git clone https://github.com/addu2612/Apple-Notes-Plugin.git
cd Apple-Notes-Plugin
node --check server.js
node server.js search ""
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | node server.js
```

Test write changes on a throwaway note, never on real ones.

## Contributing

Issues and pull requests are welcome.
Please keep the project to one file with zero dependencies.
That is what makes it easy to install, and easy to trust.

## License

[MIT](LICENSE)
