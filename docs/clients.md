# Connect your AI tool

Apple Notes Plugin is a standard [MCP](https://modelcontextprotocol.io) server over stdio. Any tool that supports MCP can use it.

Every example runs the plugin with `npx -y apple-notes-plugin`, which downloads it from npm the first time and keeps it cached after that.
You only need [Node.js](https://nodejs.org) 18 or later.

> **Tip:** If a desktop app says it cannot find `npx`, use the full path to it instead. Run `which npx` to get it, for example `/usr/local/bin/npx`.

## Claude Code

```bash
claude mcp add --scope user apple-notes -- npx -y apple-notes-plugin
```

Check it with `claude mcp list`.

## Codex

```bash
codex mcp add apple-notes -- npx -y apple-notes-plugin
```

Check it with `codex mcp list`.

## Cursor

Add this to `~/.cursor/mcp.json`. Create the file if it does not exist.

```json
{
  "mcpServers": {
    "apple-notes": {
      "command": "npx",
      "args": ["-y", "apple-notes-plugin"]
    }
  }
}
```

Then open Cursor Settings, go to the MCP section, and turn on `apple-notes`.

## Claude Desktop

Add the same `mcpServers` block as Cursor to:

```
~/Library/Application Support/Claude/claude_desktop_config.json
```

Then restart Claude Desktop.

## VS Code (GitHub Copilot)

Add this to `.vscode/mcp.json` in your project, or to your user MCP settings:

```json
{
  "servers": {
    "apple-notes": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "apple-notes-plugin"]
    }
  }
}
```

## Any other MCP client

| Setting   | Value                       |
| --------- | --------------------------- |
| Transport | stdio                       |
| Command   | `npx`                       |
| Arguments | `-y`, `apple-notes-plugin`  |

## Running from a clone

To run your own copy instead, clone the repo and point your tool at `server.js` with its full path:

```bash
git clone https://github.com/addu2612/Apple-Notes-Plugin.git
claude mcp add --scope user apple-notes -- node "$(pwd)/Apple-Notes-Plugin/server.js"
```

## Agents without MCP

Any agent that can run shell commands can use the [command-line interface](tools.md#command-line). Add a line like this to the agent's instructions file, for example `AGENTS.md`:

> To work with Apple Notes, run `npx -y apple-notes-plugin --help` and use its commands.

## Troubleshooting

**"macOS blocked access to Notes"**
Open **System Settings → Privacy & Security → Automation**. Find the app that runs the plugin (Terminal, iTerm, Cursor, Codex or Claude). Turn on **Notes**.

**The AI tool does not show the tools**
Restart the tool after you change its config. Then run `npx -y apple-notes-plugin search ""` in a terminal to confirm the plugin works.

**"This note has N attachment(s)"**
This is a safety rule, not a bug. See [Safety](../README.md#safety).

**The first call is slow**
The very first run downloads the plugin, and if Notes is not running, macOS starts it first. That takes a few seconds. Later calls take well under a second.
