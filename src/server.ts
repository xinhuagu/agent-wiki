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
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { Wiki } from "./wiki.js";
import { VERSION } from "./version.js";
import { RequestQueue } from "./queue.js";

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
          "Add a raw source document to the knowledge base. Raw files are IMMUTABLE — once added, they cannot be modified or overwritten. Each file gets a .meta.yaml sidecar with provenance (source URL, download time, SHA-256 hash). Use this for downloaded articles, papers, web pages, data files. Supports both content string and local file path (physical copy). If source_path points to a DIRECTORY, all files in it are imported recursively (use pattern to filter, e.g. '*.html'). IMPORTANT: When adding a single image file (PNG, JPEG, GIF, WEBP, etc.) under 10 MB, the image will be returned inline in the response so you can see it. Directory imports and oversized images return metadata only. When an image IS returned, you MUST immediately call wiki_write to create a description page for the image capturing what it shows, any text visible in it, and its relevance to the knowledge base.",
        inputSchema: {
          type: "object" as const,
          properties: {
            filename: {
              type: "string",
              description: "Filename in raw/ (e.g. 'paper-attention.pdf', 'article-yolo.md'). When importing a directory, this becomes the subdirectory prefix in raw/ (e.g. 'my-docs').",
            },
            content: {
              type: "string",
              description: "File content as string (for text files). Either content or source_path is required.",
            },
            source_path: {
              type: "string",
              description: "Absolute path to a local file OR DIRECTORY to physically copy into raw/. If a directory, all files are imported recursively. The original is NOT modified — full copies are made. Either content or source_path is required.",
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
            auto_version: {
              type: "boolean",
              description: "If true and file already exists, automatically create a versioned copy (e.g. report_v2.xlsx) instead of failing. Default: false.",
            },
            pattern: {
              type: "string",
              description: "File pattern filter when importing a directory (e.g. '*.html', '*.xlsx', '*.{html,css}'). Only matching files are imported. Ignored for single file imports.",
            },
          },
          required: ["filename"],
        },
      },
      {
        name: "raw_versions",
        description:
          "List all versions of a raw file, sorted by version number, with the latest version marked. Given a base filename (e.g. 'report.xlsx'), returns all matching versions (report.xlsx as v1, report_v2.xlsx, report_v3.xlsx, etc.) with metadata and a 'latest' field pointing to the newest file.",
        inputSchema: {
          type: "object" as const,
          properties: {
            filename: {
              type: "string",
              description: "Base filename to list versions of (e.g. 'report.xlsx')",
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
          "Read a raw source document's content and metadata. Raw files are immutable — this is read-only. Text/SVG files return content as string; document files (PDF, DOCX, XLSX, PPTX) have text extracted automatically; other binary files (images, etc.) return metadata only. For large PDFs, use the 'pages' parameter to read specific page ranges instead of the entire document.",
        inputSchema: {
          type: "object" as const,
          properties: {
            filename: {
              type: "string",
              description: "Filename relative to raw/ (e.g. 'article-yolo.md')",
            },
            pages: {
              type: "string",
              description: "Page range for PDF files (e.g. '1-5', '3', '1-3,7-10'). Only applies to PDFs. Omit to read all pages.",
            },
          },
          required: ["filename"],
        },
      },
      // raw_verify removed — wiki_lint already includes SHA-256 integrity checks
      {
        name: "raw_fetch",
        description:
          "Download a file from a URL and save it to raw/ as an immutable source document. Automatically generates .meta.yaml sidecar with provenance (source URL, download time, SHA-256 hash). Smart URL handling: arXiv abstract URLs (arxiv.org/abs/XXXX) are auto-converted to PDF download links. Supports any downloadable file: PDFs, HTML pages, images, data files, etc. IMPORTANT: When fetching an image file (PNG, JPEG, GIF, WEBP, etc.) under 10 MB, the image will be returned inline in the response so you can see it. Oversized images return metadata only. When an image IS returned, you MUST immediately call wiki_write to create a description page for the image capturing what it shows, any text visible in it, and its relevance to the knowledge base.",
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
          "Create or update a wiki page. Content should include YAML frontmatter (title, type, tags, sources) and Markdown body. Timestamps (created/updated) are auto-managed. Auto-routes root-level pages to matching topic subdirectories (via frontmatter `topic` field or tag matching). Wiki pages are MUTABLE — they represent compiled knowledge that improves over time.",
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
                "Filter by entity type (person, concept, event, artifact, code, comparison, summary, how-to, note, synthesis)",
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
      // wiki_log removed — use wiki_read("log.md") instead
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
          "Show the current workspace configuration: config root, workspace directory, data directories (wiki/, raw/, schemas/), lint settings, and available entity type templates.",
        inputSchema: {
          type: "object" as const,
          properties: {},
        },
      },
      // wiki_schemas removed — merged into wiki_config
      {
        name: "wiki_rebuild",
        description:
          "Rebuild the index.md and timeline.md from all wiki pages. If topic subdirectories exist, generates per-topic sub-indexes and a top-level hub. Otherwise groups pages by type with counts and dates.",
        inputSchema: {
          type: "object" as const,
          properties: {},
        },
      },
      // wiki_classify removed — wiki_write auto-classifies internally
      // wiki_synthesize removed — agent can call wiki_read on multiple pages directly
    ],
  }));

  // ── Call Tool (with concurrency control) ────────────────────

  const queue = new RequestQueue();

  // Tools that mutate state — serialized through the write queue
  const WRITE_TOOLS = new Set([
    "raw_add", "raw_fetch", "raw_import_confluence", "raw_import_jira",
    "wiki_write", "wiki_delete", "wiki_init", "wiki_rebuild",
    "wiki_lint", // writes .lint-cache.json + log.md
  ]);

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;
    const params = args as Record<string, unknown>;
    const isWrite = WRITE_TOOLS.has(name);

    const run = async () => {
      try {
        const result = await handleTool(wiki, name, params);
        if (typeof result === "string") {
          return { content: [{ type: "text" as const, text: result }] };
        }
        return { content: result };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text" as const, text: `Error: ${msg}` }],
          isError: true,
        };
      }
    };

    return isWrite ? queue.write(run) : queue.read(run);
  });

  return server;
}

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

const IMAGE_MIME_TYPES = new Set([
  "image/png", "image/jpeg", "image/gif", "image/webp",
  "image/avif", "image/bmp", "image/tiff",
]);
const MAX_INLINE_IMAGE_BYTES = 10 * 1024 * 1024; // 10 MB

/** If filePath is a displayable image under the size limit, return an image ContentBlock; else null. */
export function tryImageBlock(filePath: string, mimeType: string): ContentBlock | null {
  if (!IMAGE_MIME_TYPES.has(mimeType)) return null;
  if (!existsSync(filePath)) return null;
  const size = statSync(filePath).size;
  if (size > MAX_INLINE_IMAGE_BYTES) return null;
  const data = readFileSync(filePath).toString("base64");
  return { type: "image", data, mimeType };
}

export async function handleTool(
  wiki: Wiki,
  name: string,
  args: Record<string, unknown>
): Promise<string | ContentBlock[]> {
  switch (name) {
    // ═══ RAW LAYER ═══

    case "raw_add": {
      const result = wiki.rawAdd(args.filename as string, {
        content: args.content as string | undefined,
        sourcePath: args.source_path as string | undefined,
        sourceUrl: args.source_url as string | undefined,
        description: args.description as string | undefined,
        tags: args.tags as string[] | undefined,
        autoVersion: args.auto_version as boolean | undefined,
        pattern: args.pattern as string | undefined,
      });
      // Directory import returns array — no inline image for batch imports
      if (Array.isArray(result)) {
        return JSON.stringify({ ok: true, imported: result.length, documents: result }, null, 2);
      }
      const text = JSON.stringify({ ok: true, document: result }, null, 2);
      // For single image files, include image content block so agent can describe it
      const imgBlock = tryImageBlock(join(wiki.config.rawDir, result.path), result.mimeType ?? "");
      return imgBlock ? [{ type: "text", text }, imgBlock] : text;
    }

    case "raw_list": {
      const docs = wiki.rawList();
      return JSON.stringify({ documents: docs, count: docs.length }, null, 2);
    }

    case "raw_versions": {
      const result = wiki.rawVersions(args.filename as string);
      return JSON.stringify({ versions: result.versions, latest: result.latest, count: result.versions.length }, null, 2);
    }

    case "raw_read": {
      const result = await wiki.rawRead(args.filename as string, {
        pages: args.pages as string | undefined,
      });
      if (!result) return `Raw file not found: ${args.filename}`;
      if (result.binary) {
        if (result.imageData) {
          // Return text first (consistent with raw_add/raw_fetch), then image block
          return [
            { type: "text", text: JSON.stringify({ meta: result.meta, binary: true }, null, 2) },
            { type: "image", data: result.imageData.data, mimeType: result.imageData.mimeType },
          ];
        }
        return JSON.stringify({
          meta: result.meta,
          binary: true,
          note: result.note ?? `Binary file (${result.meta?.mimeType ?? "unknown type"}, ${result.meta?.size != null ? result.meta.size + " bytes" : "unknown size"}). Content cannot be read as text. Use the file path directly if you need to process it.`,
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

    // raw_verify removed — use wiki_lint instead (includes SHA-256 checks)

    case "raw_fetch": {
      const doc = await wiki.rawFetch(args.url as string, {
        filename: args.filename as string | undefined,
        description: args.description as string | undefined,
        tags: args.tags as string[] | undefined,
      });
      const text = JSON.stringify({ ok: true, document: doc }, null, 2);
      // For image files, include image content block so agent can describe it
      const imgBlock = tryImageBlock(join(wiki.config.rawDir, doc.path), doc.mimeType ?? "");
      return imgBlock ? [{ type: "text", text }, imgBlock] : text;
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
      // Auto-route to matching topic subdirectory
      const resolvedPage = wiki.resolvePagePath(args.page as string, enrichedContent);
      wiki.write(
        resolvedPage,
        enrichedContent,
        args.source as string | undefined
      );
      const classification = wiki.classify(enrichedContent);
      return JSON.stringify({
        ok: true,
        page: resolvedPage,
        routed: resolvedPage !== args.page,
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

    // wiki_log removed — use wiki_read("log.md") instead

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
      const schemas = wiki.schemas();
      return JSON.stringify({
        configRoot: cfg.configRoot,
        workspace: cfg.workspace,
        wikiDir: cfg.wikiDir,
        rawDir: cfg.rawDir,
        schemasDir: cfg.schemasDir,
        lint: cfg.lint,
        separateWorkspace: cfg.configRoot !== cfg.workspace,
        schemas: schemas.map(s => s.name),
      }, null, 2);
    }

    // wiki_schemas removed — merged into wiki_config

    case "wiki_rebuild": {
      // Read all pages once into cache — avoids double I/O on slow filesystems
      // (e.g. OneDrive cloud storage where each readFileSync has network latency).
      const pageCache = wiki.buildPageCache();
      wiki.rebuildIndex(pageCache);
      // Yield event loop so MCP transport can respond to client pings.
      await new Promise((r) => setImmediate(r));
      wiki.rebuildTimeline(pageCache);
      return JSON.stringify({ ok: true, message: "Index and timeline rebuilt" });
    }

    // wiki_classify removed — wiki_write auto-classifies
    // wiki_synthesize removed — agent can wiki_read multiple pages

    default:
      return `Unknown tool: ${name}`;
  }
}

// ── Entry point for stdio transport ───────────────────────────

export async function runServer(wikiPath?: string, workspace?: string): Promise<void> {
  const server = createServer(wikiPath, workspace);
  const transport = new StdioServerTransport();

  // Handle transport/process errors gracefully instead of crashing
  process.on("SIGPIPE", () => {
    // Client disconnected — ignore, let transport handle cleanup
  });
  process.stdin.on("error", () => { /* stdin closed */ });
  process.stdout.on("error", () => { /* stdout closed */ });

  server.onerror = (err) => {
    console.error(`[agent-wiki] MCP error: ${err instanceof Error ? err.message : String(err)}`);
  };

  server.onclose = () => {
    process.exit(0);
  };

  await server.connect(transport);
}
