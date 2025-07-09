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

// Tools for compatibility
server.tool(
  "get-prompts",
  "Get prompts that are stored in Langfuse",
  {
    cursor: z
      .string()
      .optional()
      .describe("Cursor to paginate through prompts"),
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

server.tool(
  "get-prompt",
  "Get a prompt that is stored in Langfuse",
  {
    name: z
      .string()
      .describe(
        "Name of the prompt to retrieve, use get-prompts to get a list of prompts"
      ),
    arguments: z
      .record(z.string())
      .optional()
      .describe(
        'Arguments with prompt variables to pass to the prompt template, json object, e.g. {"<name>":"<value>"}'
      ),
  },
  async (args, extra) => {
    try {
      const res = await getPromptHandler({
        method: "prompts/get",
        params: {
          name: args.name,
          arguments: args.arguments,
        },
      });

      const parsedRes: CallToolResult = {
        content: [
          {
            type: "text",
            text: JSON.stringify(res),
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

// Tool to create or edit (new version) a prompt in Langfuse
server.tool(
  "edit-prompt",
  "Create a new prompt or add a new version to an existing prompt in Langfuse",
  {
    name: z
      .string()
      .describe("Unique name of the prompt. Use slashes (/) to create folders."),
    type: z
      .enum(["text", "chat"])
      .optional()
      .describe("Prompt type: 'text' (default) or 'chat'."),
    prompt: z
      .string()
      .describe(
        "Prompt content. For 'text' prompts provide a string. For 'chat' prompts provide a JSON array string of chat messages each with 'role' and 'content'."
      ),
    labels: z
      .array(z.string())
      .optional()
      .describe(
        "Labels to assign to the prompt version, e.g. ['production', 'latest']."
      ),
    tags: z
      .array(z.string())
      .optional()
      .describe("Tags to assign to the prompt (shared across versions)."),
    config: z
      .string()
      .optional()
      .describe("Optional JSON string with custom config object for the prompt."),
  },
  async (args) => {
    try {
      const { name, type = "text" } = args;

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

      // Call Langfuse SDK to create the prompt (creates new version if name exists)
      const createBody: any = {
        name,
        prompt: promptContent,
        labels: args.labels,
        tags: args.tags,
        config: configObj,
      };

      if (type === "chat") {
        createBody.type = "chat";
      }

      const res = await langfuse.createPrompt(createBody as any);

      const parsedRes: CallToolResult = {
        content: [
          {
            type: "text",
            text: `Successfully created/updated prompt '${name}' (version ${res.version}).`,
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

// Tool to publish a prompt version by assigning the 'production' label (and optionally additional labels)
server.tool(
  "publish-prompt",
  "Publish an existing prompt version by assigning labels like 'production' to it",
  {
    name: z.string().describe("Name of the prompt to publish"),
    version: z
      .number()
      .optional()
      .describe(
        "Version number to publish. If omitted, the latest version will be published."
      ),
    labels: z
      .array(z.string())
      .optional()
      .describe(
        "Labels to assign. Defaults to ['production']. Existing labels will be replaced with these."
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
            text: `Prompt '${name}' version ${version} successfully updated with labels: ${newLabels.join(", ")}`,
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

// Tool to fetch and compile multiple prompts at once
server.tool(
  "get-prompts-bulk",
  "Fetch and compile multiple prompts in one call",
  {
    names: z
      .array(z.string())
      .min(1)
      .describe("Array of prompt names to fetch and compile"),
    arguments: z
      .record(z.record(z.any()))
      .optional()
      .describe(
        "Optional map from prompt name to arguments object to be passed to each prompt compile"
      ),
  },
  async (args) => {
    try {
      const results = await Promise.all(
        args.names.map(async (promptName) => {
          const promptArgs = args.arguments?.[promptName] ?? {};
          const res = await getPromptHandler({
            method: "prompts/get",
            params: {
              name: promptName,
              arguments: promptArgs,
            },
          });
          return { name: promptName, result: res };
        })
      );

      const parsedRes: CallToolResult = {
        content: results.map((r) => ({
          type: "text",
          text: JSON.stringify(r),
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

// Tool to list versions & metadata of a prompt
server.tool(
  "list-prompt-versions",
  "List all versions, labels, and tags of a prompt",
  {
    name: z.string().describe("Name of the prompt"),
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
            text: JSON.stringify(meta),
          },
        ],
      };
      return parsedRes;
    } catch (error) {
      return { content: [{ type: "text", text: "Error: " + error }], isError: true };
    }
  }
);

// Tool to fetch only prompt metadata (single version)
server.tool(
  "get-prompt-metadata",
  "Get metadata of a specific prompt version or label",
  {
    name: z.string().describe("Name of the prompt"),
    version: z.number().optional().describe("Version number to fetch"),
    label: z.string().optional().describe("Label to fetch (e.g. 'production')"),
  },
  async (args) => {
    try {
      const res = await langfuse.api.promptsGet({
        promptName: args.name,
        version: args.version ?? undefined,
        label: args.label ?? undefined,
      });
      const parsedRes: CallToolResult = {
        content: [{ type: "text", text: JSON.stringify(res) }],
      };
      return parsedRes;
    } catch (error) {
      return { content: [{ type: "text", text: "Error: " + error }], isError: true };
    }
  }
);

// Tool to search prompts by name/label/tag substring filters
server.tool(
  "search-prompts",
  "Search prompts by name substring and/or label/tag filters",
  {
    query: z.string().optional().describe("Substring to match against prompt names"),
    label: z.string().optional().describe("Label filter (e.g. 'production')"),
    tag: z.string().optional().describe("Tag filter"),
    page: z.number().optional().describe("Page number for pagination (starts at 1)"),
    limit: z.number().optional().describe("Items per page, default 100"),
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
        content: [{ type: "text", text: JSON.stringify({ data: parsed, meta: res.meta }) }],
      };
      return parsedRes;
    } catch (error) {
      return { content: [{ type: "text", text: "Error: " + error }], isError: true };
    }
  }
);

// Tool to validate a prompt template before publishing
server.tool(
  "validate-prompt",
  "Validate a prompt template for syntax issues (unclosed variables, malformed chat JSON, etc.)",
  {
    type: z.enum(["text", "chat"]).optional().describe("Prompt type"),
    prompt: z.string().describe("Prompt content to validate"),
  },
  async (args) => {
    try {
      const issues: string[] = [];

      if (args.type === "chat") {
        // Chat prompt expected to be JSON array of messages with role/content
        try {
          const parsed = JSON.parse(args.prompt);
          if (!Array.isArray(parsed)) {
            issues.push("Chat prompt must be a JSON array of messages");
          } else {
            parsed.forEach((msg: any, idx: number) => {
              if (
                typeof msg !== "object" ||
                typeof msg.role !== "string" ||
                typeof msg.content !== "string"
              ) {
                issues.push(`Message at index ${idx} is not valid {role, content}`);
              }
            });
          }
        } catch (e) {
          issues.push("Prompt JSON parsing failed: " + e);
        }
      } else {
        // Text prompt validation
        if (MULTILINE_VARIABLE_REGEX.test(args.prompt)) {
          issues.push("Multiline variables detected; variables must be single-line");
        }
        if (UNCLOSED_VARIABLE_REGEX.test(args.prompt)) {
          issues.push("Unclosed variable placeholder detected");
        }
      }

      const resultObj = {
        isValid: issues.length === 0,
        issues,
      };

      const parsedRes: CallToolResult = {
        content: [{ type: "text", text: JSON.stringify(resultObj) }],
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
