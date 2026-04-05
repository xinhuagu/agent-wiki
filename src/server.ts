/**
 * MCP Server — Exposes Agent Wiki as tools to any MCP-compatible agent.
 *
 * No LLM. No API keys. Pure data operations.
 * The calling agent IS the LLM.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Wiki } from "./wiki.js";

export function createServer(wikiPath?: string): Server {
  const wiki = new Wiki(wikiPath);
  const server = new Server(
    { name: "agent-wiki", version: "0.1.0" },
    { capabilities: { tools: {} } }
  );

  // ── List Tools ──────────────────────────────────────────────

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "wiki_read",
        description:
          "Read a wiki page by path. Returns frontmatter + Markdown content.",
        inputSchema: {
          type: "object" as const,
          properties: {
            page: {
              type: "string",
              description: "Page path relative to wiki/ (e.g. 'concept-gil.md')",
            },
          },
          required: ["page"],
        },
      },
      {
        name: "wiki_write",
        description:
          "Create or update a wiki page. Content should include YAML frontmatter (title, type, tags, sources) and Markdown body.",
        inputSchema: {
          type: "object" as const,
          properties: {
            page: {
              type: "string",
              description: "Page path relative to wiki/",
            },
            content: {
              type: "string",
              description:
                "Full page content including YAML frontmatter and Markdown body",
            },
            source: {
              type: "string",
              description: "Provenance — why this write is happening",
            },
          },
          required: ["page", "content"],
        },
      },
      {
        name: "wiki_delete",
        description: "Delete a wiki page.",
        inputSchema: {
          type: "object" as const,
          properties: {
            page: {
              type: "string",
              description: "Page path relative to wiki/",
            },
          },
          required: ["page"],
        },
      },
      {
        name: "wiki_list",
        description:
          "List all wiki pages, optionally filtered by entity type or tag.",
        inputSchema: {
          type: "object" as const,
          properties: {
            type: {
              type: "string",
              description:
                "Filter by entity type (person, concept, event, artifact, comparison, summary, how-to, note)",
            },
            tag: {
              type: "string",
              description: "Filter by tag",
            },
          },
        },
      },
      {
        name: "wiki_search",
        description:
          "Full-text keyword search across all wiki pages. Returns paths, scores, and snippets sorted by relevance.",
        inputSchema: {
          type: "object" as const,
          properties: {
            query: {
              type: "string",
              description: "Search query (keywords)",
            },
            limit: {
              type: "number",
              description: "Max results (default: 10)",
            },
          },
          required: ["query"],
        },
      },
      {
        name: "wiki_lint",
        description:
          "Run health checks on the wiki. Finds orphan pages, broken links, missing sources, stale content. No LLM needed.",
        inputSchema: {
          type: "object" as const,
          properties: {},
        },
      },
      {
        name: "wiki_log",
        description: "View the operation history log.",
        inputSchema: {
          type: "object" as const,
          properties: {
            limit: {
              type: "number",
              description: "Max entries (default: 20)",
            },
          },
        },
      },
      {
        name: "wiki_init",
        description:
          "Initialize a new knowledge base at a given path. Creates wiki/, raw/, schemas/ directories and default templates.",
        inputSchema: {
          type: "object" as const,
          properties: {
            path: {
              type: "string",
              description: "Path for the new knowledge base (default: current directory)",
            },
          },
        },
      },
      {
        name: "wiki_schemas",
        description:
          "List available entity type templates (person, concept, event, etc.). Use these to structure wiki pages consistently.",
        inputSchema: {
          type: "object" as const,
          properties: {},
        },
      },
      {
        name: "wiki_rebuild_index",
        description:
          "Rebuild the index.md from all wiki pages. Organizes pages by type.",
        inputSchema: {
          type: "object" as const,
          properties: {},
        },
      },
    ],
  }));

  // ── Call Tool ───────────────────────────────────────────────

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;

    try {
      const result = handleTool(wiki, name, args as Record<string, unknown>);
      return { content: [{ type: "text" as const, text: result }] };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text" as const, text: `Error: ${msg}` }],
        isError: true,
      };
    }
  });

  return server;
}

function handleTool(
  wiki: Wiki,
  name: string,
  args: Record<string, unknown>
): string {
  switch (name) {
    case "wiki_read": {
      const page = wiki.read(args.page as string);
      if (!page) return `Page not found: ${args.page}`;
      try {
        return readFileSync(join(wiki.config.wikiDir, args.page as string), "utf-8");
      } catch {
        return `Page not found: ${args.page}`;
      }
    }

    case "wiki_write": {
      wiki.write(
        args.page as string,
        args.content as string,
        args.source as string | undefined
      );
      return JSON.stringify({ ok: true, page: args.page });
    }

    case "wiki_delete": {
      const existed = wiki.delete(args.page as string);
      return JSON.stringify({ ok: existed, page: args.page });
    }

    case "wiki_list": {
      const pages = wiki.list(
        args.type as string | undefined,
        args.tag as string | undefined
      );
      return JSON.stringify({ pages, count: pages.length }, null, 2);
    }

    case "wiki_search": {
      const results = wiki.search(
        args.query as string,
        (args.limit as number) ?? 10
      );
      return JSON.stringify(
        { results, count: results.length },
        null,
        2
      );
    }

    case "wiki_lint": {
      const report = wiki.lint();
      return JSON.stringify(report, null, 2);
    }

    case "wiki_log": {
      const entries = wiki.getLog((args.limit as number) ?? 20);
      return JSON.stringify({ entries }, null, 2);
    }

    case "wiki_init": {
      const path = (args.path as string) ?? ".";
      Wiki.init(path);
      return JSON.stringify({ ok: true, path, message: "Knowledge base initialized" });
    }

    case "wiki_schemas": {
      const schemas = wiki.schemas();
      return JSON.stringify({ schemas }, null, 2);
    }

    case "wiki_rebuild_index": {
      wiki.rebuildIndex();
      return JSON.stringify({ ok: true, message: "Index rebuilt" });
    }

    default:
      return `Unknown tool: ${name}`;
  }
}

// ── Entry point for stdio transport ───────────────────────────

export async function runServer(wikiPath?: string): Promise<void> {
  const server = createServer(wikiPath);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
