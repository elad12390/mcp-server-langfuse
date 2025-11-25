# `@elad12390/mcp-server-langfuse`

A tool that lets AI assistants (like Claude or Cursor) manage your prompt library stored in [Langfuse](https://langfuse.com).

**What are prompts?** Prompts are the instructions you give to AI models. Instead of writing them directly in your code, you can store them in Langfuse and manage them like documents - with versions, drafts, and the ability to update them without changing your code.

```bash
npx -y @elad12390/mcp-server-langfuse  # requires LANGFUSE_* env vars
```

---

## What Can You Do?

| Tool | What it does |
| ---- | ------------ |
| `get-prompts` | List all your saved prompts |
| `get-prompt` | Get the exact content of a prompt (with all `{{variables}}` intact) |
| `edit-prompt` | Create or update a prompt. Set `publish=true` to make it live immediately |
| `publish-prompt` | Mark a draft version as "production" (live) |
| `list-prompt-versions` | See all versions of a prompt |
| `search-prompts` | Find prompts by name, label, or tag |
| `validate-prompt` | Check a prompt for syntax errors before saving |
| `diff-prompt` | Preview what will change BEFORE you edit (compare new content vs current production) |
| `compare-versions` | See differences between any two versions |
| `rollback-prompt` | Go back to an older version if something breaks |

---

## Quick Start

```bash
# 1. Set your Langfuse credentials
export LANGFUSE_PUBLIC_KEY="pk-..."
export LANGFUSE_SECRET_KEY="sk-..."
export LANGFUSE_BASEURL="https://cloud.langfuse.com"   # optional

# 2. Run it
npx -y @solaraai/mcp-server-langfuse
```

### Example: Add to Cursor

Add this to your MCP config:

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

## Common Workflows

### 1. View a prompt exactly as stored
```
get-prompt name="support/greeting"
```
Returns the raw content with all `{{variables}}` intact - perfect for reviewing and editing.

### 2. Edit and publish in one step
```
edit-prompt name="support/greeting" prompt="..." publish=true
```
Creates a new version AND marks it as production immediately.

### 3. Safe editing workflow (recommended)
```
# First, see what will change
diff-prompt name="support/greeting" newPrompt="..."

# If it looks good, save it
edit-prompt name="support/greeting" prompt="..." publish=true
```

### 4. Something went wrong? Roll back
```
# See what versions exist
list-prompt-versions name="support/greeting"

# Compare current vs old version
compare-versions name="support/greeting" version1=3 version2=2

# Roll back to version 2
rollback-prompt name="support/greeting" targetVersion=2
```

---

## Development

```bash
git clone https://github.com/solaraai/mcp-server-langfuse
cd mcp-server-langfuse
npm install
npm run build

# Run locally
LANGFUSE_PUBLIC_KEY=... node ./build/index.js
```

---

## Notes

- `get-prompt` returns raw content with `{{variables}}` - it does NOT substitute values
- Every edit creates a new version - you never lose previous work
- Use `diff-prompt` before editing to review changes
- Only prompts labeled "production" show up in `get-prompts` (use `search-prompts` to find drafts)

Questions? Open an issue!
