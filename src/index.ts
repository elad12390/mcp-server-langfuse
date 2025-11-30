#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListPromptsRequestSchema,
  ListPromptsRequest,
  ListPromptsResult,
  GetPromptRequestSchema,
  GetPromptRequest,
  GetPromptResult,
  CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import { Langfuse, ChatPromptClient } from "langfuse";
import {
  extractVariables,
  UNCLOSED_VARIABLE_REGEX,
  MULTILINE_VARIABLE_REGEX,
} from "./utils.js";
import { z } from "zod";

// Requires Environment Variables
const langfuse = new Langfuse();

// Helper to encode prompt names with slashes for API calls
// Langfuse API uses prompt name in URL path, so slashes need encoding
function encodePromptName(name: string): string {
  return encodeURIComponent(name);
}

// Create MCP server instance with a "prompts" capability.
const server = new McpServer(
  {
    name: "langfuse-prompts",
    version: "1.0.0",
  },
  {
    capabilities: {
      prompts: {},
    },
  }
);

async function listPromptsHandler(
  request: ListPromptsRequest
): Promise<ListPromptsResult> {
  try {
    const cursor = request.params?.cursor;
    const page = cursor ? Number(cursor) : 1;
    if (cursor !== undefined && isNaN(page)) {
      throw new Error("Cursor must be a valid number");
    }

    const res = await langfuse.api.promptsList({
      limit: 100,
      page,
      label: "production",
    });

    const resPrompts: ListPromptsResult["prompts"] = await Promise.all(
      res.data.map(async (i) => {
        const prompt = await langfuse.getPrompt(i.name, undefined, {
          cacheTtlSeconds: 0,
        });
        const variables = extractVariables(JSON.stringify(prompt.prompt));
        return {
          name: i.name,
          arguments: variables.map((v) => ({
            name: v,
            required: false,
          })),
        };
      })
    );

    return {
      prompts: resPrompts,
      nextCursor:
        res.meta.totalPages > page ? (page + 1).toString() : undefined,
    };
  } catch (error) {
    console.error("Error fetching prompts:", error);
    throw new Error("Failed to fetch prompts");
  }
}

async function getPromptHandler(
  request: GetPromptRequest
): Promise<GetPromptResult> {
  const promptName: string = request.params.name;
  const args = request.params.arguments || {};

  try {
    // Initialize Langfuse client and fetch the prompt by name.
    let compiledTextPrompt: string | undefined;
    let compiledChatPrompt: ChatPromptClient["prompt"] | undefined; // Langfuse chat prompt type

    try {
      // try chat prompt type first
      const prompt = await langfuse.getPrompt(promptName, undefined, {
        type: "chat",
      });
      if (prompt.type !== "chat") {
        throw new Error(`Prompt '${promptName}' is not a chat prompt`);
      }
      compiledChatPrompt = prompt.compile(args);
    } catch (error) {
      // fallback to text prompt type
      const prompt = await langfuse.getPrompt(promptName, undefined, {
        type: "text",
      });
      compiledTextPrompt = prompt.compile(args);
    }

    if (compiledChatPrompt) {
      const result: GetPromptResult = {
        messages: compiledChatPrompt.map((msg) => ({
          role: ["ai", "assistant"].includes(msg.role) ? "assistant" : "user",
          content: {
            type: "text",
            text: msg.content,
          },
        })),
      };
      return result;
    } else if (compiledTextPrompt) {
      const result: GetPromptResult = {
        messages: [
          {
            role: "user",
            content: { type: "text", text: compiledTextPrompt },
          },
        ],
      };
      return result;
    } else {
      throw new Error(`Failed to get prompt for '${promptName}'`);
    }
  } catch (error: any) {
    throw new Error(
      `Failed to get prompt for '${promptName}': ${error.message}`
    );
  }
}

// Register handlers
server.server.setRequestHandler(ListPromptsRequestSchema, listPromptsHandler);
server.server.setRequestHandler(GetPromptRequestSchema, getPromptHandler);

// ============================================================================
// PROMPT MANAGEMENT TOOLS
// These tools help you manage prompts stored in Langfuse - a platform for
// storing and versioning the instructions you give to AI models.
// Think of prompts like templates that tell the AI how to behave.
// ============================================================================

// Tool to list all prompts
server.tool(
  "get-prompts",
  "Shows all your saved prompts. Returns a list of prompt names, their versions, labels, and tags. Use this to see what prompts exist in your Langfuse project.",
  {
    cursor: z
      .string()
      .optional()
      .describe("Page number if you have many prompts and need to see more"),
  },
  async (args) => {
    try {
      const res = await listPromptsHandler({
        method: "prompts/list",
        params: {
          cursor: args.cursor,
        },
      });

      const parsedRes: CallToolResult = {
        content: res.prompts.map((p) => ({
          type: "text",
          text: JSON.stringify(p),
        })),
      };

      return parsedRes;
    } catch (error) {
      return {
        content: [{ type: "text", text: "Error: " + error }],
        isError: true,
      };
    }
  }
);

// Tool to get a single prompt - returns RAW content without variable substitution
server.tool(
  "get-prompt",
  "Gets the exact content of a prompt as stored in Langfuse - including all {{variables}} unchanged. Returns the raw prompt text, type, version, labels, and config. Use this to review or copy prompt content.",
  {
    name: z
      .string()
      .describe("The name of the prompt you want to retrieve"),
    version: z
      .number()
      .optional()
      .describe("Specific version number to get. Leave empty for the production version."),
    label: z
      .string()
      .optional()
      .describe("Get prompt by label like 'production', 'staging', or 'latest'"),
  },
  async (args) => {
    try {
      const res = await langfuse.api.promptsGet({
        promptName: encodePromptName(args.name),
        version: args.version,
        label: args.label ?? (args.version ? undefined : "production"),
      });

      // Return the raw prompt data exactly as stored
      const result = {
        name: res.name,
        version: res.version,
        type: res.type,
        prompt: res.prompt,  // Raw content with {{variables}} intact
        labels: res.labels,
        tags: res.tags,
        config: res.config,
      };

      const parsedRes: CallToolResult = {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
      };

      return parsedRes;
    } catch (error) {
      return {
        content: [{ type: "text", text: "Error: " + error }],
        isError: true,
      };
    }
  }
);

// Tool to create or edit a prompt - with optional publish in same call
server.tool(
  "edit-prompt",
  "Creates a new prompt or saves a new version of an existing one. Every edit creates a new version (you never lose previous work). You can also publish it to production in the same step by setting publish=true.",
  {
    name: z
      .string()
      .describe("Name for your prompt. Use slashes to organize into folders like 'customer-service/greeting'"),
    type: z
      .enum(["text", "chat"])
      .optional()
      .describe("'text' for simple prompts, 'chat' for conversation-style prompts with multiple messages"),
    prompt: z
      .string()
      .describe(
        "The prompt content. Use {{variable_name}} for placeholders. For chat type, provide a JSON array of messages with 'role' and 'content'."
      ),
    publish: z
      .boolean()
      .optional()
      .describe("Set to true to immediately mark this version as 'production' (live). Default is false (saves as draft)."),
    labels: z
      .array(z.string())
      .optional()
      .describe(
        "Additional labels to apply. If publish=true, 'production' is automatically added."
      ),
    tags: z
      .array(z.string())
      .optional()
      .describe("Categories to help find this prompt later, like 'sales' or 'support'"),
    config: z
      .string()
      .optional()
      .describe("Extra settings as JSON string (advanced)"),
  },
  async (args) => {
    try {
      const { name, type = "text", publish = false } = args;

      // Parse prompt content according to type
      let promptContent: any;
      if (type === "chat") {
        try {
          promptContent = JSON.parse(args.prompt);
          if (!Array.isArray(promptContent)) {
            throw new Error("Chat prompt must be a JSON array of messages");
          }
        } catch (e) {
          throw new Error(
            "Failed to parse 'prompt' as JSON array for chat prompt: " + e
          );
        }
      } else {
        // text prompt – take raw string
        promptContent = args.prompt;
      }

      // Parse optional config
      let configObj: Record<string, unknown> | undefined = undefined;
      if (args.config) {
        try {
          configObj = JSON.parse(args.config);
        } catch (e) {
          throw new Error("Failed to parse 'config' JSON: " + e);
        }
      }

      // Build labels - add 'production' if publishing
      let labels = args.labels ?? [];
      if (publish && !labels.includes("production")) {
        labels = ["production", ...labels];
      }

      // Call Langfuse SDK to create the prompt (creates new version if name exists)
      const createBody: any = {
        name,
        prompt: promptContent,
        labels: labels.length > 0 ? labels : undefined,
        tags: args.tags,
        config: configObj,
      };

      if (type === "chat") {
        createBody.type = "chat";
      }

      const res = await langfuse.createPrompt(createBody as any);

      const statusMsg = publish 
        ? `Created and published prompt '${name}' version ${res.version} to production.`
        : `Created prompt '${name}' version ${res.version} as draft. Use publish-prompt to make it live.`;

      const parsedRes: CallToolResult = {
        content: [
          {
            type: "text",
            text: statusMsg,
          },
        ],
      };

      return parsedRes;
    } catch (error) {
      return {
        content: [{ type: "text", text: "Error: " + error }],
        isError: true,
      };
    }
  }
);

// Tool to publish a prompt version
server.tool(
  "publish-prompt",
  "Makes a prompt version 'live' by marking it as 'production'. Use this when you've reviewed a draft and it's ready for your app to use.",
  {
    name: z.string().describe("Name of the prompt to publish"),
    version: z
      .number()
      .optional()
      .describe(
        "Which version number to publish. Leave empty to publish the newest version."
      ),
    labels: z
      .array(z.string())
      .optional()
      .describe(
        "Labels to apply. Default is ['production']. Examples: ['production'], ['production', 'reviewed']"
      ),
  },
  async (args) => {
    try {
      const { name } = args;
      let version = args.version;

      // If version not provided, fetch latest version
      if (version === undefined) {
        const latest = await langfuse.getPrompt(name, undefined, {
          label: "latest",
          cacheTtlSeconds: 0,
        });
        version = latest.version;
      }

      const newLabels = args.labels ?? ["production"];

      await langfuse.updatePrompt({
        name,
        version,
        newLabels,
      });

      const parsedRes: CallToolResult = {
        content: [
          {
            type: "text",
            text: `Prompt '${name}' version ${version} is now live with labels: ${newLabels.join(", ")}`,
          },
        ],
      };

      return parsedRes;
    } catch (error) {
      return {
        content: [{ type: "text", text: "Error: " + error }],
        isError: true,
      };
    }
  }
);

// Tool to list versions of a prompt
server.tool(
  "list-prompt-versions",
  "Shows the history of a prompt - all versions, their labels, and tags. Use this to see what versions exist before comparing or rolling back.",
  {
    name: z.string().describe("Name of the prompt to see history for"),
  },
  async (args) => {
    try {
      const res = await langfuse.api.promptsList({ name: args.name, limit: 1 });
      if (res.data.length === 0) {
        throw new Error(`Prompt '${args.name}' not found`);
      }
      const meta = res.data[0];
      const parsedRes: CallToolResult = {
        content: [
          {
            type: "text",
            text: JSON.stringify(meta, null, 2),
          },
        ],
      };
      return parsedRes;
    } catch (error) {
      return { content: [{ type: "text", text: "Error: " + error }], isError: true };
    }
  }
);

// Tool to search prompts
server.tool(
  "search-prompts",
  "Find prompts by name, label, or tag. Like a search engine for your prompts. Helpful when you have many prompts and need to find specific ones.",
  {
    query: z.string().optional().describe("Search text to find in prompt names"),
    label: z.string().optional().describe("Find prompts with this label, like 'production' or 'draft'"),
    tag: z.string().optional().describe("Find prompts with this tag, like 'sales' or 'support'"),
    page: z.number().optional().describe("Page number for results (starts at 1)"),
    limit: z.number().optional().describe("How many results to show (default 100)"),
  },
  async (args) => {
    try {
      const { query, label, tag, page, limit } = args;
      const res = await langfuse.api.promptsList({
        name: query ?? undefined,
        label: label ?? undefined,
        tag: tag ?? undefined,
        page: page ?? 1,
        limit: limit ?? 100,
      });
      const parsed = res.data.map((p) => ({
        name: p.name,
        versions: p.versions,
        labels: p.labels,
        tags: p.tags,
      }));

      const parsedRes: CallToolResult = {
        content: [{ type: "text", text: JSON.stringify({ data: parsed, meta: res.meta }, null, 2) }],
      };
      return parsedRes;
    } catch (error) {
      return { content: [{ type: "text", text: "Error: " + error }], isError: true };
    }
  }
);

// Tool to validate a prompt template
server.tool(
  "validate-prompt",
  "Checks your prompt for common mistakes before you save it. Catches things like unclosed {{variables}} or badly formatted chat messages.",
  {
    type: z.enum(["text", "chat"]).optional().describe("'text' for simple prompts, 'chat' for conversation-style"),
    prompt: z.string().describe("The prompt content you want to check for errors"),
  },
  async (args) => {
    try {
      const issues: string[] = [];

      if (args.type === "chat") {
        // Chat prompt expected to be JSON array of messages with role/content
        try {
          const parsed = JSON.parse(args.prompt);
          if (!Array.isArray(parsed)) {
            issues.push("Chat prompt must be a list of messages");
          } else {
            parsed.forEach((msg: any, idx: number) => {
              if (
                typeof msg !== "object" ||
                typeof msg.role !== "string" ||
                typeof msg.content !== "string"
              ) {
                issues.push(`Message #${idx + 1} is missing 'role' or 'content'`);
              }
            });
          }
        } catch (e) {
          issues.push("Could not read the prompt - check the formatting");
        }
      } else {
        // Text prompt validation
        if (MULTILINE_VARIABLE_REGEX.test(args.prompt)) {
          issues.push("Variables like {{name}} should be on one line, not split across lines");
        }
        if (UNCLOSED_VARIABLE_REGEX.test(args.prompt)) {
          issues.push("Found an opening {{ without a closing }} - check your variables");
        }
      }

      const resultObj = {
        isValid: issues.length === 0,
        issues,
        message: issues.length === 0 ? "Looks good! No problems found." : "Found some issues to fix.",
      };

      const parsedRes: CallToolResult = {
        content: [{ type: "text", text: JSON.stringify(resultObj, null, 2) }],
      };
      return parsedRes;
    } catch (error) {
      return { content: [{ type: "text", text: "Error: " + error }], isError: true };
    }
  }
);

// Tool to rollback prompt to a previous version
server.tool(
  "rollback-prompt",
  "Undo changes by making an older version the new 'production' version. Use this if the latest version has problems and you need to quickly go back to what was working.",
  {
    name: z.string().describe("Name of the prompt to roll back"),
    targetVersion: z.number().describe("Which version number to go back to"),
  },
  async (args) => {
    try {
      // First verify the version exists
      const prompt = await langfuse.api.promptsGet({ 
        promptName: encodePromptName(args.name), 
        version: args.targetVersion 
      });

      if (!prompt) {
        throw new Error(`Version ${args.targetVersion} of prompt '${args.name}' not found`);
      }

      // Update the target version to have 'production' label
      await langfuse.updatePrompt({
        name: args.name,
        version: args.targetVersion,
        newLabels: ["production"],
      });

      const parsedRes: CallToolResult = {
        content: [{ 
          type: "text", 
          text: `Done! Rolled back '${args.name}' to version ${args.targetVersion}. This version is now live.`
        }],
      };
      return parsedRes;
    } catch (error) {
      return { content: [{ type: "text", text: "Error: " + error }], isError: true };
    }
  }
);

// Tool to show diff between current production and a new prompt before editing
server.tool(
  "diff-prompt",
  "Shows a diff between the current production prompt and new content you want to save. Use this BEFORE editing to review what will change. Helps catch mistakes before publishing.",
  {
    name: z.string().describe("Name of the prompt to compare against"),
    newPrompt: z.string().describe("The new prompt content you're planning to save"),
    newType: z.enum(["text", "chat"]).optional().describe("Type of the new prompt (defaults to current type)"),
  },
  async (args) => {
    try {
      // Get current production version
      let currentPrompt;
      try {
        currentPrompt = await langfuse.api.promptsGet({
          promptName: encodePromptName(args.name),
          label: "production",
        });
      } catch (e) {
        // Prompt doesn't exist yet - this is a new prompt
        const parsedRes: CallToolResult = {
          content: [{ 
            type: "text", 
            text: JSON.stringify({
              status: "new_prompt",
              message: `Prompt '${args.name}' doesn't exist yet. This will create a brand new prompt.`,
              newContent: args.newPrompt,
            }, null, 2)
          }],
        };
        return parsedRes;
      }

      // Parse new prompt if it's chat type
      let newPromptContent: any = args.newPrompt;
      const newType = args.newType ?? currentPrompt.type;
      if (newType === "chat") {
        try {
          newPromptContent = JSON.parse(args.newPrompt);
        } catch (e) {
          // Keep as string if parse fails - validation will catch it
        }
      }

      // Get current content as string for comparison
      const currentContent = typeof currentPrompt.prompt === "string" 
        ? currentPrompt.prompt 
        : JSON.stringify(currentPrompt.prompt, null, 2);
      
      const newContent = typeof newPromptContent === "string"
        ? newPromptContent
        : JSON.stringify(newPromptContent, null, 2);

      // Simple line-by-line diff
      const currentLines = currentContent.split('\n');
      const newLines = newContent.split('\n');
      
      const diff: string[] = [];
      const maxLines = Math.max(currentLines.length, newLines.length);
      
      for (let i = 0; i < maxLines; i++) {
        const currentLine = currentLines[i] ?? '';
        const newLine = newLines[i] ?? '';
        
        if (currentLine !== newLine) {
          if (currentLine && !newLine) {
            diff.push(`- ${currentLine}`);
          } else if (!currentLine && newLine) {
            diff.push(`+ ${newLine}`);
          } else {
            diff.push(`- ${currentLine}`);
            diff.push(`+ ${newLine}`);
          }
        }
      }

      const hasChanges = diff.length > 0;
      const typeChanged = newType !== currentPrompt.type;

      const result = {
        name: args.name,
        currentVersion: currentPrompt.version,
        hasChanges,
        typeChanged,
        currentType: currentPrompt.type,
        newType,
        summary: hasChanges 
          ? `${diff.filter(l => l.startsWith('-')).length} lines removed, ${diff.filter(l => l.startsWith('+')).length} lines added`
          : "No changes detected",
        diff: hasChanges ? diff.join('\n') : null,
        currentContent,
        newContent,
      };

      const parsedRes: CallToolResult = {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
      return parsedRes;
    } catch (error) {
      return { content: [{ type: "text", text: "Error: " + error }], isError: true };
    }
  }
);

// Tool to download a prompt to a file
server.tool(
  "download-prompt",
  "Downloads a prompt's raw content to a local file. Saves the prompt exactly as stored in Langfuse - perfect for backup, local editing, or version control.",
  {
    name: z
      .string()
      .describe("The name of the prompt to download"),
    filePath: z
      .string()
      .describe("Full file path where the prompt should be saved (e.g., '/path/to/prompt.txt' or '/path/to/prompt.json')"),
    version: z
      .number()
      .optional()
      .describe("Specific version number to download. Leave empty for the production version."),
    label: z
      .string()
      .optional()
      .describe("Download prompt by label like 'production', 'staging', or 'latest'"),
    includeMetadata: z
      .boolean()
      .optional()
      .describe("If true, includes metadata (version, labels, tags, config) in the output. Default is false (just the prompt content)."),
  },
  async (args) => {
    try {
      const fs = await import("fs/promises");
      const path = await import("path");
      
      const res = await langfuse.api.promptsGet({
        promptName: encodePromptName(args.name),
        version: args.version,
        label: args.label ?? (args.version ? undefined : "production"),
      });

      let fileContent: string;
      
      if (args.includeMetadata) {
        // Include full metadata
        const fullData = {
          name: res.name,
          version: res.version,
          type: res.type,
          prompt: res.prompt,
          labels: res.labels,
          tags: res.tags,
          config: res.config,
        };
        fileContent = JSON.stringify(fullData, null, 2);
      } else {
        // Just the raw prompt content
        if (typeof res.prompt === "string") {
          fileContent = res.prompt;
        } else {
          // Chat prompt - array of messages
          fileContent = JSON.stringify(res.prompt, null, 2);
        }
      }

      // Ensure directory exists
      const dir = path.dirname(args.filePath);
      await fs.mkdir(dir, { recursive: true });
      
      // Write the file
      await fs.writeFile(args.filePath, fileContent, "utf-8");

      const parsedRes: CallToolResult = {
        content: [
          {
            type: "text",
            text: `Downloaded prompt '${res.name}' (v${res.version}) to ${args.filePath}`,
          },
        ],
      };

      return parsedRes;
    } catch (error) {
      return {
        content: [{ type: "text", text: "Error: " + error }],
        isError: true,
      };
    }
  }
);

// Tool to upload/update a prompt from a file
server.tool(
  "upload-prompt",
  "Creates or updates a prompt using content from a local file. Perfect for syncing prompts from version control or restoring from backups. Supports both raw prompt files and metadata JSON files (from download-prompt with includeMetadata).",
  {
    name: z
      .string()
      .describe("Name for the prompt in Langfuse. Use slashes to organize into folders like 'customer-service/greeting'"),
    filePath: z
      .string()
      .describe("Full file path to read the prompt content from"),
    type: z
      .enum(["text", "chat", "auto"])
      .optional()
      .describe("'text' for simple prompts, 'chat' for conversation-style prompts, 'auto' to detect from file content (default)"),
    publish: z
      .boolean()
      .optional()
      .describe("Set to true to immediately mark this version as 'production' (live). Default is false (saves as draft)."),
    labels: z
      .array(z.string())
      .optional()
      .describe("Additional labels to apply. If publish=true, 'production' is automatically added."),
    tags: z
      .array(z.string())
      .optional()
      .describe("Categories to help find this prompt later, like 'sales' or 'support'"),
  },
  async (args) => {
    try {
      const fs = await import("fs/promises");
      
      // Read file content
      const fileContent = await fs.readFile(args.filePath, "utf-8");
      
      let promptContent: any;
      let promptType: "text" | "chat" = "text";
      let detectedLabels = args.labels ?? [];
      let detectedTags = args.tags;
      let configObj: Record<string, unknown> | undefined;
      
      // Try to parse as JSON (could be metadata file or chat prompt)
      try {
        const parsed = JSON.parse(fileContent);
        
        // Check if it's a metadata file (from download-prompt with includeMetadata)
        if (parsed.prompt !== undefined && parsed.type !== undefined) {
          // It's a metadata file
          promptContent = parsed.prompt;
          promptType = parsed.type === "chat" ? "chat" : "text";
          
          // Use metadata labels/tags if not explicitly provided
          if (!args.labels && parsed.labels) {
            detectedLabels = parsed.labels;
          }
          if (!args.tags && parsed.tags) {
            detectedTags = parsed.tags;
          }
          if (parsed.config) {
            configObj = parsed.config;
          }
        } else if (Array.isArray(parsed)) {
          // It's a chat prompt (array of messages)
          promptContent = parsed;
          promptType = "chat";
        } else {
          // It's some other JSON - treat as text
          promptContent = fileContent;
          promptType = "text";
        }
      } catch {
        // Not valid JSON - treat as text prompt
        promptContent = fileContent;
        promptType = "text";
      }
      
      // Override type if explicitly specified
      if (args.type && args.type !== "auto") {
        promptType = args.type;
        // If forcing text type on parsed JSON array, stringify it back
        if (promptType === "text" && Array.isArray(promptContent)) {
          promptContent = JSON.stringify(promptContent, null, 2);
        }
      }
      
      // Build labels - add 'production' if publishing
      if (args.publish && !detectedLabels.includes("production")) {
        detectedLabels = ["production", ...detectedLabels];
      }
      
      // Create the prompt
      const createBody: any = {
        name: args.name,
        prompt: promptContent,
        labels: detectedLabels.length > 0 ? detectedLabels : undefined,
        tags: detectedTags,
        config: configObj,
      };
      
      if (promptType === "chat") {
        createBody.type = "chat";
      }
      
      const res = await langfuse.createPrompt(createBody as any);
      
      const statusMsg = args.publish
        ? `Uploaded and published prompt '${args.name}' version ${res.version} to production from ${args.filePath}`
        : `Uploaded prompt '${args.name}' version ${res.version} as draft from ${args.filePath}. Use publish-prompt to make it live.`;
      
      const parsedRes: CallToolResult = {
        content: [
          {
            type: "text",
            text: statusMsg,
          },
        ],
      };
      
      return parsedRes;
    } catch (error) {
      return {
        content: [{ type: "text", text: "Error: " + error }],
        isError: true,
      };
    }
  }
);

// Tool to compare two prompt versions
server.tool(
  "compare-versions",
  "Shows the exact content of two versions side-by-side with a diff. Use this to review what changed between versions, or before rolling back.",
  {
    name: z.string().describe("Name of the prompt"),
    version1: z.number().describe("First version number"),
    version2: z.number().describe("Second version number"),
  },
  async (args) => {
    try {
      const [prompt1, prompt2] = await Promise.all([
        langfuse.api.promptsGet({ promptName: encodePromptName(args.name), version: args.version1 }),
        langfuse.api.promptsGet({ promptName: encodePromptName(args.name), version: args.version2 }),
      ]);

      // Get content as strings for comparison
      const content1 = typeof prompt1.prompt === "string" 
        ? prompt1.prompt 
        : JSON.stringify(prompt1.prompt, null, 2);
      
      const content2 = typeof prompt2.prompt === "string"
        ? prompt2.prompt
        : JSON.stringify(prompt2.prompt, null, 2);

      // Simple line-by-line diff
      const lines1 = content1.split('\n');
      const lines2 = content2.split('\n');
      
      const diff: string[] = [];
      const maxLines = Math.max(lines1.length, lines2.length);
      
      for (let i = 0; i < maxLines; i++) {
        const line1 = lines1[i] ?? '';
        const line2 = lines2[i] ?? '';
        
        if (line1 !== line2) {
          if (line1 && !line2) {
            diff.push(`v${args.version1}: - ${line1}`);
          } else if (!line1 && line2) {
            diff.push(`v${args.version2}: + ${line2}`);
          } else {
            diff.push(`v${args.version1}: - ${line1}`);
            diff.push(`v${args.version2}: + ${line2}`);
          }
        }
      }

      const hasChanges = diff.length > 0 || prompt1.type !== prompt2.type;

      const comparison = {
        name: args.name,
        hasChanges,
        typeChanged: prompt1.type !== prompt2.type,
        version1: {
          version: args.version1,
          type: prompt1.type,
          labels: prompt1.labels,
          prompt: prompt1.prompt,
        },
        version2: {
          version: args.version2,
          type: prompt2.type,
          labels: prompt2.labels,
          prompt: prompt2.prompt,
        },
        diff: hasChanges ? diff.join('\n') : "No differences",
      };

      const parsedRes: CallToolResult = {
        content: [{ type: "text", text: JSON.stringify(comparison, null, 2) }],
      };
      return parsedRes;
    } catch (error) {
      return { content: [{ type: "text", text: "Error: " + error }], isError: true };
    }
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Langfuse Prompts MCP Server running on stdio");
}

main().catch((error) => {
  console.error("Fatal error in main():", error);
  process.exit(1);
});
