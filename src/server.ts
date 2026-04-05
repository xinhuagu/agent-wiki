/**
 * MCP Server — Exposes Agent Wiki as tools to any MCP-compatible agent.
 *
 * Architecture (Karpathy LLM Wiki, upgraded):
 *
 *   raw/  → Immutable source layer (raw_add, raw_list, raw_read, raw_verify)
 *   wiki/ → Mutable knowledge layer (read, write, delete, search, lint, synthesize)
 *
 * The agent IS the LLM. This server is pure data operations.
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
import { VERSION } from "./version.js";

export function createServer(wikiPath?: string, workspace?: string): Server {
  const wiki = new Wiki(wikiPath, workspace);
  const server = new Server(
    { name: "agent-wiki", version: VERSION },
    { capabilities: { tools: {} } }
  );

  // ── List Tools ──────────────────────────────────────────────

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      // ═══════════════════════════════════════════════════════
      //  RAW LAYER — Immutable source documents
      // ═══════════════════════════════════════════════════════
      {
        name: "raw_add",
        description:
          "Add a raw source document to the knowledge base. Raw files are IMMUTABLE — once added, they cannot be modified or overwritten. Each file gets a .meta.yaml sidecar with provenance (source URL, download time, SHA-256 hash). Use this for downloaded articles, papers, web pages, data files. Supports both content string and local file path (physical copy).",
        inputSchema: {
          type: "object" as const,
          properties: {
            filename: {
              type: "string",
              description: "Filename in raw/ (e.g. 'paper-attention.pdf', 'article-yolo.md')",
            },
            content: {
              type: "string",
              description: "File content as string (for text files). Either content or source_path is required.",
            },
            source_path: {
              type: "string",
              description: "Absolute path to a local file to physically copy into raw/. The original file is NOT modified — a full copy is made. Either content or source_path is required.",
            },
            source_url: {
              type: "string",
              description: "Original URL where the document was downloaded from",
            },
            description: {
              type: "string",
              description: "Brief description of what this source contains",
            },
            tags: {
              type: "array",
              items: { type: "string" },
              description: "Tags for categorization",
            },
          },
          required: ["filename"],
        },
      },
      {
        name: "raw_list",
        description:
          "List all raw source documents with metadata (path, source URL, download time, hash, size).",
        inputSchema: {
          type: "object" as const,
          properties: {},
        },
      },
      {
        name: "raw_read",
        description:
          "Read a raw source document's content and metadata. Raw files are immutable — this is read-only. Text/SVG files return content as string; document files (PDF, DOCX, XLSX, PPTX) have text extracted automatically; other binary files (images, etc.) return metadata only.",
        inputSchema: {
          type: "object" as const,
          properties: {
            filename: {
              type: "string",
              description: "Filename relative to raw/ (e.g. 'article-yolo.md')",
            },
          },
          required: ["filename"],
        },
      },
      {
        name: "raw_verify",
        description:
          "Verify integrity of all raw files by checking SHA-256 hashes against stored metadata. Detects corruption or tampering.",
        inputSchema: {
          type: "object" as const,
          properties: {},
        },
      },
      {
        name: "raw_fetch",
        description:
          "Download a file from a URL and save it to raw/ as an immutable source document. Automatically generates .meta.yaml sidecar with provenance (source URL, download time, SHA-256 hash). Smart URL handling: arXiv abstract URLs (arxiv.org/abs/XXXX) are auto-converted to PDF download links. Supports any downloadable file: PDFs, HTML pages, images, data files, etc.",
        inputSchema: {
          type: "object" as const,
          properties: {
            url: {
              type: "string",
              description: "URL to download from. arXiv abs URLs are auto-converted to PDF links (e.g. https://arxiv.org/abs/2304.00501 → PDF download)",
            },
            filename: {
              type: "string",
              description: "Optional filename in raw/. If omitted, auto-inferred from URL (arXiv papers get clean names like 'arxiv-2304-00501.pdf')",
            },
            description: {
              type: "string",
              description: "Brief description of what this source document contains",
            },
            tags: {
              type: "array",
              items: { type: "string" },
              description: "Tags for categorization",
            },
          },
          required: ["url"],
        },
      },
      // ═══════════════════════════════════════════════════════
      //  ATLASSIAN — Confluence & Jira
      // ═══════════════════════════════════════════════════════
      {
        name: "raw_import_confluence",
        description:
          "Import a Confluence page (and optionally all child pages recursively) into raw/. " +
          "Saves each page as HTML with metadata sidecar. Generates _tree.yaml preserving page hierarchy. " +
          "Requires CONFLUENCE_API_TOKEN env var set to 'email:api-token'.",
        inputSchema: {
          type: "object" as const,
          properties: {
            url: {
              type: "string",
              description: "Confluence page URL (e.g. https://company.atlassian.net/wiki/spaces/ENG/pages/123456/Page-Title)",
            },
            recursive: {
              type: "boolean",
              description: "Import child pages recursively (default: false)",
            },
            depth: {
              type: "number",
              description: "Max recursion depth (-1 = unlimited, default: 50 when recursive=true, 0 when false)",
            },
            auth_env: {
              type: "string",
              description: "Environment variable name containing auth credentials (default: CONFLUENCE_API_TOKEN)",
            },
          },
          required: ["url"],
        },
      },
      {
        name: "raw_import_jira",
        description:
          "Import a Jira issue into raw/ with full details: fields, description, comments, attachments, and linked issues. " +
          "Saves structured JSON + readable Markdown. Attachments are downloaded to subdirectory. " +
          "Requires JIRA_API_TOKEN env var set to 'email:api-token'.",
        inputSchema: {
          type: "object" as const,
          properties: {
            url: {
              type: "string",
              description: "Jira issue URL (e.g. https://company.atlassian.net/browse/PROJ-123)",
            },
            include_comments: {
              type: "boolean",
              description: "Include issue comments (default: true)",
            },
            include_attachments: {
              type: "boolean",
              description: "Download attachments (default: true)",
            },
            include_links: {
              type: "boolean",
              description: "Import linked issues (default: true)",
            },
            link_depth: {
              type: "number",
              description: "How many levels of linked issues to follow (default: 1)",
            },
            auth_env: {
              type: "string",
              description: "Environment variable name containing auth credentials (default: JIRA_API_TOKEN)",
            },
          },
          required: ["url"],
        },
      },
      // ═══════════════════════════════════════════════════════
      //  WIKI LAYER — Mutable compiled knowledge
      // ═══════════════════════════════════════════════════════
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
          "Create or update a wiki page. Content should include YAML frontmatter (title, type, tags, sources) and Markdown body. Timestamps (created/updated) are auto-managed. Wiki pages are MUTABLE — they represent compiled knowledge that improves over time.",
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
        description: "Delete a wiki page. Cannot delete system pages (index.md, log.md, timeline.md).",
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
                "Filter by entity type (person, concept, event, artifact, comparison, summary, how-to, note, synthesis)",
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
          "Run comprehensive health checks. Detects: contradictions between pages, orphan pages, broken [[links]], missing sources, stale content, raw file integrity (SHA-256 verification), synthesis page integrity. Returns categorized issues with fix suggestions.",
        inputSchema: {
          type: "object" as const,
          properties: {},
        },
      },
      {
        name: "wiki_log",
        description: "View the operation history log with timestamps, operations, affected pages, and summaries.",
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
          "Initialize a new knowledge base. Creates wiki/, raw/, schemas/ directories and default templates. Optionally use a separate workspace directory for all data files.",
        inputSchema: {
          type: "object" as const,
          properties: {
            path: {
              type: "string",
              description: "Config root — where .agent-wiki.yaml is created (default: current directory)",
            },
            workspace: {
              type: "string",
              description: "Separate workspace directory for all data (wiki/, raw/, schemas/). If omitted, data goes in path.",
            },
          },
        },
      },
      {
        name: "wiki_config",
        description:
          "Show the current workspace configuration: config root, workspace directory, data directories (wiki/, raw/, schemas/), and lint settings.",
        inputSchema: {
          type: "object" as const,
          properties: {},
        },
      },
      {
        name: "wiki_schemas",
        description:
          "List available entity type templates (person, concept, event, artifact, comparison, summary, how-to, note, synthesis). Use these to structure wiki pages consistently.",
        inputSchema: {
          type: "object" as const,
          properties: {},
        },
      },
      {
        name: "wiki_rebuild_index",
        description:
          "Rebuild the index.md from all wiki pages. Organizes pages by type with counts and dates.",
        inputSchema: {
          type: "object" as const,
          properties: {},
        },
      },
      {
        name: "wiki_rebuild_timeline",
        description:
          "Rebuild timeline.md — a chronological view of all knowledge entries, grouped by date.",
        inputSchema: {
          type: "object" as const,
          properties: {},
        },
      },
      {
        name: "wiki_classify",
        description:
          "Auto-classify content into entity type (person, concept, event, artifact, comparison, summary, how-to, synthesis, note) and suggest tags. Pure heuristic — zero LLM dependency. Useful for previewing classification before writing, or for enriching existing pages. Returns type, tags, and confidence score.",
        inputSchema: {
          type: "object" as const,
          properties: {
            content: {
              type: "string",
              description: "The full page content (with or without frontmatter) to classify",
            },
          },
          required: ["content"],
        },
      },
      {
        name: "wiki_synthesize",
        description:
          "Prepare context for knowledge synthesis — reads multiple wiki pages and returns their content so the agent can distill them into a new synthesis page. Synthesis pages represent higher-order knowledge derived from combining multiple sources.",
        inputSchema: {
          type: "object" as const,
          properties: {
            pages: {
              type: "array",
              items: { type: "string" },
              description: "List of page paths to synthesize from (e.g. ['concept-yolo.md', 'comparison-detectors.md'])",
            },
          },
          required: ["pages"],
        },
      },
    ],
  }));

  // ── Call Tool ───────────────────────────────────────────────

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;

    try {
      const result = await handleTool(wiki, name, args as Record<string, unknown>);
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

async function handleTool(
  wiki: Wiki,
  name: string,
  args: Record<string, unknown>
): Promise<string> {
  switch (name) {
    // ═══ RAW LAYER ═══

    case "raw_add": {
      const doc = wiki.rawAdd(args.filename as string, {
        content: args.content as string | undefined,
        sourcePath: args.source_path as string | undefined,
        sourceUrl: args.source_url as string | undefined,
        description: args.description as string | undefined,
        tags: args.tags as string[] | undefined,
      });
      return JSON.stringify({ ok: true, document: doc }, null, 2);
    }

    case "raw_list": {
      const docs = wiki.rawList();
      return JSON.stringify({ documents: docs, count: docs.length }, null, 2);
    }

    case "raw_read": {
      const result = await wiki.rawRead(args.filename as string);
      if (!result) return `Raw file not found: ${args.filename}`;
      if (result.binary) {
        return JSON.stringify({
          meta: result.meta,
          binary: true,
          note: `Binary file (${result.meta?.mimeType ?? "unknown type"}, ${result.meta?.size != null ? result.meta.size + " bytes" : "unknown size"}). Content cannot be read as text. Use the file path directly if you need to process it.`,
        }, null, 2);
      }
      const content = result.content!;
      return JSON.stringify({
        meta: result.meta,
        binary: false,
        content: content.length > 10000
          ? content.slice(0, 10000) + "\n\n... (truncated, " + content.length + " chars total)"
          : content,
      }, null, 2);
    }

    case "raw_verify": {
      const results = wiki.rawVerify();
      const corrupted = results.filter((r) => r.status === "corrupted");
      const missingMeta = results.filter((r) => r.status === "missing-meta");
      return JSON.stringify({
        total: results.length,
        ok: results.filter((r) => r.status === "ok").length,
        corrupted: corrupted.length,
        missingMeta: missingMeta.length,
        details: results,
      }, null, 2);
    }

    case "raw_fetch": {
      const doc = await wiki.rawFetch(args.url as string, {
        filename: args.filename as string | undefined,
        description: args.description as string | undefined,
        tags: args.tags as string[] | undefined,
      });
      return JSON.stringify({ ok: true, document: doc }, null, 2);
    }

    // ═══ ATLASSIAN ═══

    case "raw_import_confluence": {
      const result = await wiki.confluenceImport(args.url as string, {
        recursive: args.recursive as boolean | undefined,
        depth: args.depth as number | undefined,
        authEnv: args.auth_env as string | undefined,
      });
      return JSON.stringify({
        ok: true,
        pages: result.pages,
        files: result.files,
        tree: result.tree,
      }, null, 2);
    }

    case "raw_import_jira": {
      const result = await wiki.jiraImport(args.url as string, {
        includeComments: args.include_comments as boolean | undefined,
        includeAttachments: args.include_attachments as boolean | undefined,
        includeLinks: args.include_links as boolean | undefined,
        linkDepth: args.link_depth as number | undefined,
        authEnv: args.auth_env as string | undefined,
      });
      return JSON.stringify({
        ok: true,
        issueKey: result.issueKey,
        summary: result.summary,
        files: result.files,
        linkedIssues: result.linkedIssues,
        importedCount: result.importedCount,
      }, null, 2);
    }

    // ═══ WIKI LAYER ═══

    case "wiki_read": {
      const page = wiki.read(args.page as string);
      if (!page) return `Page not found: ${args.page}`;
      // wiki.read() already validates the path via safePath, so we
      // reconstruct the full path from wiki.config + validated pagePath
      const fullPath = join(wiki.config.wikiDir, page.path);
      try {
        return readFileSync(fullPath, "utf-8");
      } catch {
        return `Page not found: ${args.page}`;
      }
    }

    case "wiki_write": {
      // Auto-classify if type/tags are missing
      const enrichedContent = wiki.autoClassifyContent(args.content as string);
      wiki.write(
        args.page as string,
        enrichedContent,
        args.source as string | undefined
      );
      const classification = wiki.classify(enrichedContent);
      return JSON.stringify({
        ok: true,
        page: args.page,
        autoClassified: { type: classification.type, tags: classification.tags, confidence: classification.confidence },
      });
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
      const ws = args.workspace as string | undefined;
      Wiki.init(path, ws);
      return JSON.stringify({
        ok: true,
        configRoot: path,
        workspace: ws ?? path,
        message: ws
          ? `Knowledge base initialized. Config at ${path}, data at ${ws}`
          : `Knowledge base initialized at ${path} with wiki/, raw/, schemas/`,
      });
    }

    case "wiki_config": {
      const cfg = wiki.config;
      return JSON.stringify({
        configRoot: cfg.configRoot,
        workspace: cfg.workspace,
        wikiDir: cfg.wikiDir,
        rawDir: cfg.rawDir,
        schemasDir: cfg.schemasDir,
        lint: cfg.lint,
        separateWorkspace: cfg.configRoot !== cfg.workspace,
      }, null, 2);
    }

    case "wiki_schemas": {
      const schemas = wiki.schemas();
      return JSON.stringify({ schemas }, null, 2);
    }

    case "wiki_rebuild_index": {
      wiki.rebuildIndex();
      return JSON.stringify({ ok: true, message: "Index rebuilt" });
    }

    case "wiki_rebuild_timeline": {
      wiki.rebuildTimeline();
      return JSON.stringify({ ok: true, message: "Timeline rebuilt" });
    }

    case "wiki_classify": {
      const classification = wiki.classify(args.content as string);
      return JSON.stringify(classification, null, 2);
    }

    case "wiki_synthesize": {
      const pagePaths = args.pages as string[];
      if (!pagePaths || pagePaths.length === 0) {
        return JSON.stringify({ error: "Provide at least one page path to synthesize from" });
      }
      const ctx = wiki.synthesizeContext(pagePaths);
      return JSON.stringify(ctx, null, 2);
    }

    default:
      return `Unknown tool: ${name}`;
  }
}

// ── Entry point for stdio transport ───────────────────────────

export async function runServer(wikiPath?: string, workspace?: string): Promise<void> {
  const server = createServer(wikiPath, workspace);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
