# `@solaraai/mcp-server-langfuse`

[Model Context Protocol](https://modelcontextprotocol.io) (MCP) server that exposes
your [Langfuse](https://langfuse.com) prompts as standard MCP *prompts* **and**
CLI *tools*. Now installable in one line:

```bash
npx -y @solaraai/mcp-server-langfuse  # requires LANGFUSE_* env vars
```

---

## Features

### MCP Prompt capability

| Endpoint            | Description                                           |
| ------------------- | ----------------------------------------------------- |
| `prompts/list`      | Paginated list of available prompts (production label) |
| `prompts/get`       | Fetch + compile a single prompt (text or chat)        |

### CLI / Tool equivalents *(for hosts that don’t implement prompt-capability)*

| Tool name              | Purpose                                                       |
| ---------------------- | ------------------------------------------------------------- |
| `get-prompts`          | List prompts (same as `prompts/list`)                         |
| `get-prompt`           | Fetch & compile one prompt                                    |
| `get-prompts-bulk`     | Fetch & compile **multiple** prompts in one call              |
| `edit-prompt`          | Create or update (new version) a prompt                       |
| `publish-prompt`       | Tag a prompt version as `production` or any label             |
| `list-prompt-versions` | Show all versions/labels/tags for a prompt                    |
| `get-prompt-metadata`  | Fetch metadata for a version/label (no compilation)           |
| `search-prompts`       | Search by name / label / tag                                  |
| `validate-prompt`      | Linter for prompt templates (unclosed vars, chat JSON etc.)   |

---

## Quick start

```bash
# 1. Export your Langfuse keys (or add them to your MCP config)
export LANGFUSE_PUBLIC_KEY="pk-..."
export LANGFUSE_SECRET_KEY="sk-..."
export LANGFUSE_BASEURL="https://cloud.langfuse.com"   # optional, defaults

# 2. Launch via npx
npx -y @solaraai/mcp-server-langfuse
```

The server runs on STDIO, so any MCP host that supports stdio transports (e.g.
Cursor, Claude Desktop) can spawn it with the same `npx` command.

### Example host configuration (Cursor)

```jsonc
{
  "mcpServers": {
    "langfuse-prompts": {
      "command": "npx",
      "args": ["-y", "@solaraai/mcp-server-langfuse"],
      "env": {
        "LANGFUSE_PUBLIC_KEY": "pk-...",
        "LANGFUSE_SECRET_KEY": "sk-...",
        "LANGFUSE_BASEURL": "https://cloud.langfuse.com"
      },
      "transportType": "stdio"
    }
  }
}
```

---

## Development

```bash
git clone https://github.com/solaraai/mcp-server-langfuse
cd mcp-server-langfuse
npm install
npm run build  # emits ./build/index.js

# Run locally
LANGFUSE_PUBLIC_KEY=... node ./build/index.js

# Or test via MCP inspector
npx @modelcontextprotocol/inspector npx -y @solaraai/mcp-server-langfuse
```

### Publishing

Scoped packages default to *private*. We ship it public:

```bash
npm run deploy   # builds & publishes with --access public
```

---

## Limitations

* Only prompt versions with the `production` label are returned by
  `prompts/list` for safety (use `search-prompts` or pass `label` param to
  query others).
* Variable metadata (required/optional, description) isn’t available from the
  Langfuse API, so arguments are listed without rich docs.

Contributions welcome – open an issue or PR!

---
