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
import { existsSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { join, resolve, basename, extname } from "node:path";
import { Wiki, splitSections, buildToc, findSectionByHeading, matchSimpleGlob, safePath } from "./wiki.js";
import { extractDocument, chunkSegments, guessMime, type ExtractionSegment } from "./extraction.js";
import matter from "gray-matter";
import { VERSION } from "./version.js";
import { RequestQueue } from "./queue.js";
import { registerPlugin, getPluginForFile, listPlugins, summarizeModel } from "./code-analysis.js";
import { cobolPlugin } from "./cobol/plugin.js";

// Register built-in plugins
registerPlugin(cobolPlugin);

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
          "Read a raw source document's content and metadata. Raw files are immutable — this is read-only. Text/SVG files return content as string; document files (PDF, DOCX, XLSX, PPTX) have text extracted automatically; other binary files (images, etc.) return metadata only.\n\nPagination by format:\n- PDF: use 'pages' for page ranges (e.g. '1-5')\n- PPTX: use 'pages' for slide ranges (e.g. '1-10')\n- XLSX: use 'sheet' to read a specific sheet; response always includes 'sheet_names'\n- DOCX / text: use 'offset' + 'limit' for line-based pagination (default limit: 200)\n\nFor large documents, paginate rather than reading all at once.",
        inputSchema: {
          type: "object" as const,
          properties: {
            filename: {
              type: "string",
              description: "Filename relative to raw/ (e.g. 'article-yolo.md')",
            },
            pages: {
              type: "string",
              description: "Page/slide range (e.g. '1-5', '3', '1-3,7-10'). Applies to PDF and PPTX. Omit to read all.",
            },
            sheet: {
              type: "string",
              description: "Sheet name for XLSX files. Omit to read all sheets (response always includes sheet_names list).",
            },
            offset: {
              type: "number",
              description: "Line offset for paginating text/DOCX files. Default: 0.",
            },
            limit: {
              type: "number",
              description: "Max lines to return for text/DOCX pagination. Default: 200, max: 500.",
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
          "Read a wiki page by path. Returns frontmatter + Markdown content. " +
          "RECOMMENDED WORKFLOW: (1) call without 'section' to get the TOC for large pages, " +
          "(2) use wiki_search 'section' field to jump directly to the relevant heading, " +
          "(3) call with 'section' to read only that part. " +
          "Large pages without 'section' are truncated at 200 lines — check 'truncated' and 'toc' in the response.",
        inputSchema: {
          type: "object" as const,
          properties: {
            page: {
              type: "string",
              description: "Page path relative to wiki/ (e.g. 'concept-gil.md')",
            },
            section: {
              type: "string",
              description: "Heading to read (e.g. '## Installation'). Case-insensitive partial match. Returns that section and its sub-sections only. Use the 'section' field from wiki_search results to navigate directly.",
            },
            offset: {
              type: "number",
              description: "First line to return, 0-indexed (default: 0). Fallback for line-based paging when section navigation is insufficient.",
            },
            limit: {
              type: "number",
              description: "Max lines to return (default: 200, max: 500).",
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
          "Full-text keyword search across all wiki pages. Returns paths, scores, and snippets sorted by relevance. " +
          "Set include_content=true for simple inline content. For advanced search+read with deduplication, " +
          "readTopN control, and per-page limits, use wiki_search_read instead.",
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
            include_content: {
              type: "boolean",
              description: "If true, include page content in results. When a section matched, returns that section; otherwise returns first 200 lines. Saves a follow-up batch read. Default: false.",
            },
          },
          required: ["query"],
        },
      },
      {
        name: "wiki_search_read",
        description:
          "Search wiki pages and read top results in a single call. " +
          "Combines wiki_search + wiki_read with deduplication — multiple search hits on the same page read it only once. " +
          "Returns search metadata (results) separately from page content (pages). " +
          "Remaining unread result paths are listed in nextReads for follow-up if needed.",
        inputSchema: {
          type: "object" as const,
          properties: {
            query: {
              type: "string",
              description: "Search query (keywords)",
            },
            limit: {
              type: "number",
              description: "Max search results (default: 10)",
            },
            readTopN: {
              type: "number",
              description: "How many unique top-scoring pages to read content for (default: 3, max: 10). Counts unique pages, not search results.",
            },
            section: {
              type: "string",
              description: "Section heading filter applied to all page reads (e.g. '## Installation'). Case-insensitive partial match. If omitted, reads full page content.",
            },
            perPageLimit: {
              type: "number",
              description: "Max lines per page (default: 200, max: 500). Pages exceeding this are truncated with metadata.",
            },
            includeToc: {
              type: "boolean",
              description: "Include table of contents for truncated pages (default: false).",
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

      // ═══════════════════════════════════════════════════════
      //  BATCH — Combine multiple tool calls into one request
      // ═══════════════════════════════════════════════════════
      {
        name: "batch",
        description:
          "Execute multiple tool calls in a single request. Reduces tool-call count for LLM subscriptions " +
          "that bill per-request (e.g. GitHub Copilot). Supports ANY combination of tools — " +
          "e.g. read 5 wiki pages, write 3 pages, add 2 raw files, search, all in one call. " +
          "Wiki index rebuild is automatically deduplicated (runs once at the end, not per-write). " +
          "Each operation is independent — one failure does not abort the batch. Nested batch calls are not allowed.",
        inputSchema: {
          type: "object" as const,
          properties: {
            operations: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  tool: {
                    type: "string",
                    description: "Tool name (e.g. 'wiki_read', 'wiki_write', 'raw_add', 'raw_read', 'wiki_search')",
                  },
                  args: {
                    type: "object",
                    description: "Tool arguments — same as calling the tool individually",
                  },
                },
                required: ["tool"],
              },
              description: "Array of operations to execute sequentially",
            },
          },
          required: ["operations"],
        },
      },

      // ═══════════════════════════════════════════════════════
      //  KNOWLEDGE INGESTION — Batch import, extract, chunk, pack
      // ═══════════════════════════════════════════════════════
      {
        name: "knowledge_ingest_batch",
        description:
          "Batch import, extract, chunk, and pack source documents into digest packs. " +
          "Scans a directory (or single file), imports to raw/, extracts text with structural provenance " +
          "(per-page PDF, per-sheet XLSX, per-slide PPTX), chunks into fixed-line segments, then packs " +
          "into markdown digest packs under raw/digest-packs/{topic}/. Each pack includes provenance headers. " +
          "Files already in raw/ are skipped. Returns a compact summary with recommended next reads.",
        inputSchema: {
          type: "object" as const,
          properties: {
            source_path: {
              type: "string",
              description: "Absolute path to a directory or single file to ingest",
            },
            pattern: {
              type: "string",
              description: "Glob filter when source_path is a directory (e.g. '*.pdf', '*.{xlsx,docx}')",
            },
            maxFiles: {
              type: "number",
              description: "Maximum files to process (default: 100, max: 1000)",
            },
            topic: {
              type: "string",
              description: "Topic name for organizing digest packs (default: 'general')",
            },
            chunkLines: {
              type: "number",
              description: "Maximum lines per chunk (default: 100)",
            },
            packLines: {
              type: "number",
              description: "Maximum lines per digest pack (default: 500)",
            },
            continueOnError: {
              type: "boolean",
              description: "Continue processing on individual file errors (default: true)",
            },
          },
          required: ["source_path"],
        },
      },

      {
        name: "knowledge_digest_write",
        description:
          "Write LLM-generated digest summaries back to wiki with structured provenance. " +
          "Creates or updates one or more wiki pages from digested content, linking back to " +
          "source raw files and digest packs. Supports batch writes — index is rebuilt once at the end. " +
          "Each page gets auto-classified, auto-routed, and timestamped like wiki_write.",
        inputSchema: {
          type: "object" as const,
          properties: {
            pages: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  page: {
                    type: "string",
                    description: "Page path relative to wiki/ (e.g. 'concept-transformer.md')",
                  },
                  title: {
                    type: "string",
                    description: "Page title",
                  },
                  body: {
                    type: "string",
                    description: "Markdown body content (without frontmatter — frontmatter is auto-generated)",
                  },
                  type: {
                    type: "string",
                    description: "Entity type (concept, person, event, how-to, summary, synthesis, etc.). Auto-classified if omitted.",
                  },
                  tags: {
                    type: "array",
                    items: { type: "string" },
                    description: "Tags for categorization. Auto-classified if omitted.",
                  },
                  topic: {
                    type: "string",
                    description: "Topic subdirectory for auto-routing (e.g. 'trade-lifecycle')",
                  },
                  sources: {
                    type: "array",
                    items: { type: "string" },
                    description: "Source raw file paths (e.g. ['raw/topic/doc.pdf', 'raw/topic/data.xlsx'])",
                  },
                  sourcePacks: {
                    type: "array",
                    items: { type: "string" },
                    description: "Digest pack paths used to generate this page (e.g. ['raw/digest-packs/topic/pack-001.md'])",
                  },
                },
                required: ["page", "title", "body"],
              },
              description: "Array of wiki pages to write",
            },
          },
          required: ["pages"],
        },
      },

      // ═══════════════════════════════════════════════════════
      //  CODE ANALYSIS — Parse source files into structured knowledge
      // ═══════════════════════════════════════════════════════
      {
        name: "code_parse",
        description:
          "Parse a source file from raw/ into structured code knowledge (AST, normalized model, summary). Currently supports COBOL (.cbl, .cob, .cpy). Persists artifacts under raw/parsed/cobol/. Optionally traces all references to a variable.",
        inputSchema: {
          type: "object" as const,
          properties: {
            path: {
              type: "string",
              description: "Path to source file in raw/ (e.g. 'PAYROLL.cbl')",
            },
            trace_variable: {
              type: "string",
              description: "Optional: variable name to trace (e.g. 'WS-TOTAL-SALARY')",
            },
          },
          required: ["path"],
        },
      },
      {
        name: "code_trace_variable",
        description:
          "Trace all references to a variable across a parsed COBOL program. Shows where it is read, written, or passed, grouped by section/paragraph.",
        inputSchema: {
          type: "object" as const,
          properties: {
            path: {
              type: "string",
              description: "Path to source file in raw/ (e.g. 'PAYROLL.cbl')",
            },
            variable: {
              type: "string",
              description: "Variable name to trace (e.g. 'WS-TOTAL-SALARY')",
            },
          },
          required: ["path", "variable"],
        },
      },
    ],
  }));

  // ── Call Tool (with concurrency control) ────────────────────

  const queue = new RequestQueue();

  // Tools that mutate state — serialized through the write queue
  const WRITE_TOOLS = new Set([
    "raw_add", "raw_fetch", "raw_import_confluence", "raw_import_jira",
    "wiki_write", "wiki_delete", "wiki_init", "wiki_rebuild",
    "wiki_lint", // writes .lint-cache.json + log.md
    "code_parse", // writes parsed artifacts under raw/parsed/
    "knowledge_ingest_batch", // writes to raw/ and raw/digest-packs/
    "knowledge_digest_write", // writes to wiki/
  ]);

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;
    const params = args as Record<string, unknown>;

    // batch: route dynamically — write queue only if any op mutates state
    let isWrite: boolean;
    if (name === "batch") {
      const ops = params.operations;
      // Malformed args → route through read queue; handleTool will return validation error
      isWrite = Array.isArray(ops) && ops.some((op: any) => WRITE_TOOLS.has(op?.tool));
    } else {
      isWrite = WRITE_TOOLS.has(name);
    }

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

/** Recursively walk a directory, returning relative file paths (skips dotfiles). */
function walkSourceDir(dir: string): string[] {
  const result: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      result.push(...walkSourceDir(full).map(f => join(entry.name, f)));
    } else {
      result.push(entry.name);
    }
  }
  return result.sort();
}

/** Validate and sanitize a topic string to a safe path slug. */
function sanitizeTopic(raw: string): string {
  if (!raw || /\.\.|^\/|^\\|\x00/.test(raw)) {
    throw new Error(`Invalid topic: "${raw}". Must not contain "..", absolute paths, or null bytes.`);
  }
  return raw.replace(/[^a-zA-Z0-9_\-/]/g, "-").replace(/\/{2,}/g, "/").replace(/^\/|\/$/g, "");
}

/** Internal options — not exposed to MCP callers. */
export interface HandleToolOpts {
  /** When true, wiki_write/wiki_delete skip rebuildIndex (batch rebuilds once at end). */
  skipRebuild?: boolean;
}

export async function handleTool(
  wiki: Wiki,
  name: string,
  args: Record<string, unknown>,
  opts?: HandleToolOpts,
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
        sheet: args.sheet as string | undefined,
        offset: args.offset as number | undefined,
        limit: args.limit as number | undefined,
      });
      if (!result) throw new Error(`Raw file not found: ${args.filename}`);
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
      // Paginated responses (sheet/offset/pages specified) skip the 10K truncation
      const isPaginated = result.paginationMeta !== undefined;
      const finalContent = isPaginated
        ? content
        : content.length > 10000
          ? content.slice(0, 10000) + "\n\n... (truncated, " + content.length + " chars total)"
          : content;
      return JSON.stringify({
        meta: result.meta,
        binary: false,
        content: finalContent,
        ...(result.paginationMeta ? { pagination: result.paginationMeta } : {}),
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
      if (!page) throw new Error(`Page not found: ${args.page}`);
      const fullPath = join(wiki.config.wikiDir, page.path);
      let raw: string;
      try {
        raw = readFileSync(fullPath, "utf-8");
      } catch {
        throw new Error(`Page not found: ${args.page}`);
      }

      // ── Section-based read ──────────────────────────────────
      if (args.section) {
        const sections = splitSections(raw);
        const target = findSectionByHeading(sections, args.section as string);
        if (!target) {
          const toc = buildToc(sections);
          throw new Error(
            `Section "${args.section}" not found in ${args.page}.\nAvailable sections:\n${toc}`
          );
        }
        // Include sub-sections (higher heading level) that follow immediately
        const targetIdx = sections.indexOf(target);
        const parts = [target.content];
        for (let i = targetIdx + 1; i < sections.length; i++) {
          const s = sections[i]!;
          if (s.level <= target.level && s.heading !== "") break;
          parts.push(s.content);
        }
        const content = parts.join("\n");
        return JSON.stringify({
          section: target.heading,
          content,
          total_lines: content.split("\n").length,
        }, null, 2);
      }

      // ── Line-based read (fallback / small pages) ────────────
      const lines = raw.split("\n");
      const total = lines.length;
      const DEFAULT_LIMIT = 200;
      const MAX_LIMIT = 500;
      const offset = Math.max(0, Math.floor((args.offset as number) ?? 0));
      const limit = Math.min(MAX_LIMIT, Math.max(1, Math.floor((args.limit as number) ?? DEFAULT_LIMIT)));
      const slice = lines.slice(offset, offset + limit);
      const truncated = offset + limit < total;
      if (!truncated && offset === 0) {
        // Small page — return as plain text for backwards compatibility
        return raw;
      }
      // Large page — include TOC so agent can navigate by section
      const toc = buildToc(splitSections(raw));
      return JSON.stringify({
        content: slice.join("\n"),
        offset,
        lines_returned: slice.length,
        total_lines: total,
        truncated,
        next_offset: truncated ? offset + limit : null,
        toc: toc || null,
      }, null, 2);
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
      // Auto-rebuild indexes (skipped when called from batch — batch rebuilds once at end)
      if (!opts?.skipRebuild) wiki.rebuildIndex();
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
      if (existed && !opts?.skipRebuild) wiki.rebuildIndex();
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
      if (!args.include_content) {
        return JSON.stringify({ results, count: results.length }, null, 2);
      }
      // Inline page content — eliminates follow-up wiki_read calls
      const enriched = results.map((r) => {
        try {
          const fullPath = join(wiki.config.wikiDir, r.path);
          const raw = readFileSync(fullPath, "utf-8");
          if (r.section) {
            // Return the matched section only, capped at 200 lines
            const sections = splitSections(raw);
            const target = findSectionByHeading(sections, r.section);
            if (target) {
              const targetIdx = sections.indexOf(target);
              const parts = [target.content];
              for (let i = targetIdx + 1; i < sections.length; i++) {
                const s = sections[i]!;
                if (s.level <= target.level && s.heading !== "") break;
                parts.push(s.content);
              }
              const sectionText = parts.join("\n");
              const sectionLines = sectionText.split("\n");
              const sectionTruncated = sectionLines.length > 200;
              return {
                ...r,
                content: sectionTruncated ? sectionLines.slice(0, 200).join("\n") : sectionText,
                ...(sectionTruncated ? { truncated: true, total_lines: sectionLines.length } : {}),
              };
            }
          }
          // No section match — return first 200 lines
          const lines = raw.split("\n");
          const truncated = lines.length > 200;
          return {
            ...r,
            content: truncated ? lines.slice(0, 200).join("\n") : raw,
            ...(truncated ? { truncated: true, total_lines: lines.length } : {}),
          };
        } catch {
          return { ...r, content: null };
        }
      });
      return JSON.stringify({ results: enriched, count: enriched.length }, null, 2);
    }

    case "wiki_search_read": {
      const query = args.query as string;
      const limit = (args.limit as number) ?? 10;
      const readTopN = Math.min(Math.max(1, Math.floor((args.readTopN as number) ?? 3)), 10);
      const sectionFilter = args.section as string | undefined;
      const perPageLimit = Math.min(500, Math.max(1, Math.floor((args.perPageLimit as number) ?? 200)));
      const includeToc = (args.includeToc as boolean) ?? false;

      // Step 1: Search
      const results = wiki.search(query, limit);

      // Step 2: Deduplicate — preserve score order, first occurrence wins
      const seen = new Set<string>();
      const uniquePaths: string[] = [];
      for (const r of results) {
        if (!seen.has(r.path)) {
          seen.add(r.path);
          uniquePaths.push(r.path);
        }
      }

      // Step 3: Split into read vs. nextReads
      const toRead = uniquePaths.slice(0, readTopN);
      const nextReads = uniquePaths.slice(readTopN);

      // Step 4: Read each page
      const pages: Array<Record<string, unknown>> = [];
      for (const pagePath of toRead) {
        try {
          const page = wiki.read(pagePath);
          if (!page) throw new Error(`Page not found: ${pagePath}`);
          const fullPath = join(wiki.config.wikiDir, page.path);
          const raw = readFileSync(fullPath, "utf-8");

          if (sectionFilter) {
            const sections = splitSections(raw);
            const target = findSectionByHeading(sections, sectionFilter);
            if (!target) {
              pages.push({
                path: pagePath,
                content: null,
                error: `Section "${sectionFilter}" not found`,
                toc: buildToc(sections) || null,
              });
              continue;
            }
            const targetIdx = sections.indexOf(target);
            const parts = [target.content];
            for (let i = targetIdx + 1; i < sections.length; i++) {
              const s = sections[i]!;
              if (s.level <= target.level && s.heading !== "") break;
              parts.push(s.content);
            }
            const sectionText = parts.join("\n");
            const sectionLines = sectionText.split("\n");
            const truncated = sectionLines.length > perPageLimit;
            pages.push({
              path: pagePath,
              content: truncated ? sectionLines.slice(0, perPageLimit).join("\n") : sectionText,
              truncated,
              ...(truncated ? { total_lines: sectionLines.length } : {}),
              ...(truncated && includeToc ? { toc: buildToc(sections) } : {}),
            });
          } else {
            const lines = raw.split("\n");
            const truncated = lines.length > perPageLimit;
            pages.push({
              path: pagePath,
              content: truncated ? lines.slice(0, perPageLimit).join("\n") : raw,
              truncated,
              ...(truncated ? { total_lines: lines.length } : {}),
              ...(truncated && includeToc ? { toc: buildToc(splitSections(raw)) } : {}),
            });
          }
        } catch (err) {
          pages.push({
            path: pagePath,
            content: null,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      return JSON.stringify({
        results,
        count: results.length,
        pages,
        pagesRead: pages.length,
        nextReads,
      }, null, 2);
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

    case "code_parse": {
      const filePath = args.path as string;
      const plugin = getPluginForFile(filePath);
      if (!plugin) {
        const supported = listPlugins().flatMap((p) => p.extensions).join(", ");
        throw new Error(`Unsupported file type: ${filePath}. Supported extensions: ${supported}`);
      }
      const rawResult = await wiki.rawRead(filePath);
      if (!rawResult || rawResult.content === null) {
        throw new Error(`Cannot read raw/${filePath}`);
      }

      // All dispatch goes through the plugin interface
      const ast = plugin.parse(rawResult.content, filePath);
      const normalized = plugin.normalize(ast);
      const summary = summarizeModel(normalized);
      const wikiPages = plugin.generateWikiPages(normalized, filePath, ast);

      // Persist parsed artifacts
      const stem = filePath.replace(/\.[^.]+$/, "");
      const lang = plugin.id;
      wiki.rawAddParsedArtifact(`parsed/${lang}/${stem}.ast.json`, JSON.stringify(ast, null, 2));
      wiki.rawAddParsedArtifact(`parsed/${lang}/${stem}.normalized.json`, JSON.stringify(normalized, null, 2));
      wiki.rawAddParsedArtifact(`parsed/${lang}/${stem}.summary.json`, JSON.stringify(summary, null, 2));

      // Language-specific model (richer than normalized — e.g. COBOL PIC clauses)
      if (plugin.extractLanguageModel) {
        const langModel = plugin.extractLanguageModel(ast);
        wiki.rawAddParsedArtifact(`parsed/${lang}/${stem}.model.json`, JSON.stringify(langModel, null, 2));
      }

      // Write wiki pages
      const writtenPages: string[] = [];
      for (const page of wikiPages) {
        wiki.write(page.path, page.content, `raw/${filePath}`);
        writtenPages.push(page.path);
      }

      // Rebuild aggregate pages (e.g. call graph) from all parsed models
      if (plugin.rebuildAggregatePages) {
        const parsedDir = join(wiki.config.rawDir, "parsed", lang);
        const aggPages = plugin.rebuildAggregatePages(parsedDir);
        for (const page of aggPages) {
          wiki.write(page.path, page.content);
          writtenPages.push(page.path);
        }
      }

      // Optional variable trace
      const traceVar = args.trace_variable as string | undefined;
      let variableTrace;
      if (traceVar && plugin.traceVariable) {
        variableTrace = plugin.traceVariable(ast, traceVar);
      }

      const artifacts = [
        `raw/parsed/${lang}/${stem}.ast.json`,
        `raw/parsed/${lang}/${stem}.normalized.json`,
        `raw/parsed/${lang}/${stem}.summary.json`,
      ];
      if (plugin.extractLanguageModel) {
        artifacts.push(`raw/parsed/${lang}/${stem}.model.json`);
      }

      const output: Record<string, unknown> = {
        summary,
        normalizedModel: {
          units: normalized.units.length,
          procedures: normalized.procedures.length,
          symbols: normalized.symbols.length,
          relations: normalized.relations.length,
        },
        artifacts,
        wikiPages: writtenPages,
      };
      if (variableTrace) {
        output.variableTrace = variableTrace;
      }
      return JSON.stringify(output, null, 2);
    }

    case "code_trace_variable": {
      const filePath = args.path as string;
      const varName = args.variable as string;
      const plugin = getPluginForFile(filePath);
      if (!plugin) {
        const supported = listPlugins().flatMap((p) => p.extensions).join(", ");
        throw new Error(`Unsupported file type: ${filePath}. Supported extensions: ${supported}`);
      }
      if (!plugin.traceVariable) {
        throw new Error(`Plugin "${plugin.id}" does not support variable tracing`);
      }
      const rawResult = await wiki.rawRead(filePath);
      if (!rawResult || rawResult.content === null) {
        throw new Error(`Cannot read raw/${filePath}`);
      }
      const ast = plugin.parse(rawResult.content, filePath);
      const refs = plugin.traceVariable(ast, varName);
      return JSON.stringify({ variable: varName, file: filePath, references: refs }, null, 2);
    }

    // ═══ KNOWLEDGE INGESTION ═══

    case "knowledge_ingest_batch": {
      const sourcePath = resolve(args.source_path as string);
      const pattern = args.pattern as string | undefined;
      const maxFiles = Math.min(Math.max(1, Math.floor((args.maxFiles as number) ?? 100)), 1000);
      const topic = sanitizeTopic((args.topic as string) ?? "general");
      const packLinesLimit = Math.max(50, Math.floor((args.packLines as number) ?? 500));
      const chunkLinesLimit = Math.min(Math.max(10, Math.floor((args.chunkLines as number) ?? 100)), packLinesLimit);
      const continueOnError = (args.continueOnError as boolean) ?? true;

      // Step 0: Validate source_path against allowed source directories
      const allowed = wiki.config.allowedSourceDirs.some(
        dir => sourcePath.startsWith(resolve(dir) + "/") || sourcePath === resolve(dir)
      );
      if (!allowed) {
        throw new Error(
          `source_path "${args.source_path}" is outside allowed directories. ` +
          `Allowed: [${wiki.config.allowedSourceDirs.join(", ")}]. ` +
          `Configure security.allowed_source_dirs in .agent-wiki.yaml to widen access.`
        );
      }

      // Step 1: Scan
      let filePaths: string[];
      const srcStat = statSync(sourcePath);
      if (srcStat.isDirectory()) {
        filePaths = walkSourceDir(sourcePath);
        if (pattern) {
          filePaths = filePaths.filter(f => matchSimpleGlob(f, pattern));
        }
      } else {
        filePaths = [basename(sourcePath)];
      }
      filePaths = filePaths.slice(0, maxFiles);

      const matched = filePaths.length;
      let imported = 0, skipped = 0, extracted = 0, totalChunks = 0;
      const errors: Array<{ file: string; stage: string; error: string }> = [];

      // Extractable document formats
      const EXTRACTABLE = new Set([".pdf", ".docx", ".xlsx", ".pptx", ".html", ".htm"]);
      const TEXT_LIKE = (mime: string) =>
        mime.startsWith("text/") || mime === "application/json" || mime === "application/xml"
        || mime === "application/sql" || mime === "application/x-yaml";

      // Clean stale packs from previous runs of this topic (safePath prevents escape)
      const packsDir = safePath(wiki.config.rawDir, join("digest-packs", topic));
      if (existsSync(packsDir)) {
        for (const f of readdirSync(packsDir)) {
          if (f.startsWith("pack-") && f.endsWith(".md")) {
            const p = join(packsDir, f);
            rmSync(p, { force: true });
            const meta = p + ".meta.yaml";
            if (existsSync(meta)) rmSync(meta, { force: true });
          }
        }
      }

      // Streaming packer — flushes packs as chunks arrive, bounded memory
      const packs: Array<{ path: string; chunks: number; sources: string[] }> = [];
      let packNum = 1;
      let currentPackLines = 0;
      let currentPackChunks: ExtractionSegment[] = [];

      const flushPack = () => {
        if (currentPackChunks.length === 0) return;
        const packSources = [...new Set(currentPackChunks.map(c => `raw/${c.source.file}`))];

        let md = "---\n";
        md += `title: "Digest Pack ${String(packNum).padStart(3, "0")}"\n`;
        md += `topic: "${topic}"\n`;
        md += `sources: ${JSON.stringify(packSources)}\n`;
        md += `totalChunks: ${currentPackChunks.length}\n`;
        md += "---\n\n";

        for (const chunk of currentPackChunks) {
          let header = `## raw/${chunk.source.file}`;
          if (chunk.source.page !== undefined) header += ` [Page ${chunk.source.page}]`;
          if (chunk.source.sheet) header += ` [Sheet: ${chunk.source.sheet}]`;
          if (chunk.source.slide !== undefined) header += ` [Slide ${chunk.source.slide}]`;
          md += `${header}\n\n${chunk.text}\n\n`;
        }

        const packPath = `digest-packs/${topic}/pack-${String(packNum).padStart(3, "0")}.md`;
        wiki.rawAddParsedArtifact(packPath, md.trimEnd(), {
          mimeType: "text/markdown",
          description: `Digest pack ${packNum} for topic "${topic}"`,
        });

        packs.push({ path: packPath, chunks: currentPackChunks.length, sources: packSources });
        packNum++;
        currentPackChunks = [];
        currentPackLines = 0;
      };

      const addChunkToPack = (chunk: ExtractionSegment) => {
        const lines = chunk.text.split("\n").length;
        if (currentPackLines + lines > packLinesLimit && currentPackChunks.length > 0) {
          flushPack();
        }
        currentPackChunks.push(chunk);
        currentPackLines += lines;
        totalChunks++;
      };

      // Step 2-3: Import + Extract + Stream into packs
      for (const relPath of filePaths) {
        const rawFilename = `${topic}/${relPath}`;
        const fullSourcePath = srcStat.isDirectory()
          ? join(sourcePath, relPath)
          : sourcePath;

        // Import to raw/
        try {
          wiki.rawAdd(rawFilename, { sourcePath: fullSourcePath });
          imported++;
        } catch (e: any) {
          if (e.message.includes("already exists")) {
            skipped++;
          } else if (continueOnError) {
            errors.push({ file: relPath, stage: "import", error: e.message });
            continue;
          } else {
            throw e;
          }
        }

        // Extract + chunk + stream into packs
        const ext = extname(relPath).toLowerCase();
        const rawFullPath = join(wiki.config.rawDir, rawFilename);
        try {
          let segments: ExtractionSegment[];
          if (EXTRACTABLE.has(ext)) {
            const result = await extractDocument(rawFullPath);
            segments = result.segments;
          } else {
            const mime = guessMime(relPath);
            if (TEXT_LIKE(mime)) {
              const content = readFileSync(rawFullPath, "utf-8");
              segments = [{ text: content, source: { file: rawFilename } }];
            } else {
              continue; // Binary file — skip extraction
            }
          }

          // Normalize file path in source coordinates
          for (const seg of segments) {
            seg.source.file = rawFilename;
          }

          // Chunk and stream directly into packs (bounded memory)
          const chunked = chunkSegments(segments, chunkLinesLimit);
          for (const chunk of chunked) {
            addChunkToPack(chunk);
          }
          extracted++;
        } catch (e: any) {
          if (continueOnError) {
            errors.push({ file: relPath, stage: "extract", error: e.message });
          } else {
            throw e;
          }
        }
      }

      flushPack(); // flush remaining

      const nextRecommendedReads = packs.slice(0, 5).map(p => `raw/${p.path}`);

      return JSON.stringify({
        ok: true,
        matched,
        imported,
        skipped,
        extracted,
        chunks: totalChunks,
        packs: packs.length,
        failed: errors.length,
        ...(errors.length > 0 ? { errors: errors.slice(0, 10) } : {}),
        packPaths: packs.map(p => `raw/${p.path}`),
        nextRecommendedReads,
      }, null, 2);
    }

    case "knowledge_digest_write": {
      const MAX_DIGEST_PAGES = 100;
      const items = args.pages as Array<{
        page: string; title: string; body: string;
        type?: string; tags?: string[]; topic?: string;
        sources?: string[]; sourcePacks?: string[];
      }>;
      if (!Array.isArray(items) || items.length === 0) {
        throw new Error("pages must be a non-empty array");
      }
      if (items.length > MAX_DIGEST_PAGES) {
        throw new Error(`Too many pages: ${items.length} exceeds limit of ${MAX_DIGEST_PAGES}`);
      }

      const results: Array<Record<string, unknown>> = [];
      for (let idx = 0; idx < items.length; idx++) {
        const item = items[idx];
        const pageLabel = (item && typeof item === "object" && typeof item.page === "string")
          ? item.page : `(item ${idx})`;
        try {
          // Validate required fields
          if (!item || typeof item !== "object" || typeof item.page !== "string"
              || typeof item.title !== "string" || typeof item.body !== "string") {
            throw new Error("Each page must have string page, title, and body fields");
          }

          const topicField = item.topic ? sanitizeTopic(item.topic) : undefined;

          // Build frontmatter + body using gray-matter for safe YAML serialization
          const fm: Record<string, unknown> = { title: item.title };
          if (item.type) fm.type = item.type;
          if (item.tags && item.tags.length > 0) fm.tags = item.tags;
          if (topicField) fm.topic = topicField;
          if (item.sources && item.sources.length > 0) fm.sources = item.sources;
          if (item.sourcePacks && item.sourcePacks.length > 0) fm.source_packs = item.sourcePacks;
          const content = matter.stringify("\n" + item.body, fm);

          // Auto-classify if type/tags missing
          const enrichedContent = wiki.autoClassifyContent(content);
          // Auto-route to topic subdirectory
          const resolvedPage = wiki.resolvePagePath(item.page, enrichedContent);
          wiki.write(resolvedPage, enrichedContent, item.sourcePacks?.[0] ?? item.sources?.[0]);
          const classification = wiki.classify(enrichedContent);

          results.push({
            ok: true,
            page: resolvedPage,
            routed: resolvedPage !== item.page,
            autoClassified: { type: classification.type, tags: classification.tags, confidence: classification.confidence },
          });
        } catch (err) {
          results.push({ ok: false, page: pageLabel, error: err instanceof Error ? err.message : String(err) });
        }
      }

      // Rebuild index once after all writes
      wiki.rebuildIndex();

      return JSON.stringify({
        results,
        count: results.length,
        written: results.filter(r => r.ok).length,
      }, null, 2);
    }

    // ═══ BATCH ═══

    case "batch": {
      const MAX_BATCH_OPS = 50;
      const ops = args.operations as Array<{ tool: string; args?: Record<string, unknown> }>;
      if (!Array.isArray(ops) || ops.length === 0) {
        throw new Error("operations must be a non-empty array");
      }
      if (ops.length > MAX_BATCH_OPS) {
        throw new Error(`Batch too large: ${ops.length} operations exceeds limit of ${MAX_BATCH_OPS}`);
      }

      // Tools whose per-call rebuildIndex should be deferred to end of batch
      const REBUILD_TOOLS = new Set(["wiki_write", "wiki_delete"]);
      let needsRebuild = false;
      let needsTimeline = false;

      const results: Array<Record<string, unknown>> = [];
      for (const op of ops) {
        if (op.tool === "batch") {
          results.push({ tool: op.tool, error: "Cannot nest batch operations" });
          continue;
        }
        // Deduplicate wiki_rebuild — defer to end-of-batch full rebuild
        if (op.tool === "wiki_rebuild") {
          needsRebuild = true;
          needsTimeline = true;
          results.push({ tool: op.tool, result: { ok: true, deferred: "merged into end-of-batch rebuild" } });
          continue;
        }
        try {
          const opOpts: HandleToolOpts = REBUILD_TOOLS.has(op.tool) ? { skipRebuild: true } : {};
          const result = await handleTool(wiki, op.tool, op.args ?? {}, opOpts);

          if (REBUILD_TOOLS.has(op.tool)) {
            // Check if the operation actually changed something worth rebuilding for
            if (op.tool === "wiki_write") {
              needsRebuild = true;
            } else if (op.tool === "wiki_delete") {
              const parsed = JSON.parse(typeof result === "string" ? result : "{}");
              if (parsed.ok) needsRebuild = true;
            }
          }

          if (typeof result === "string") {
            try {
              results.push({ tool: op.tool, result: JSON.parse(result) });
            } catch {
              results.push({ tool: op.tool, result });
            }
          } else {
            // ContentBlock[] — preserve full blocks including inline images
            results.push({ tool: op.tool, result });
          }
        } catch (err) {
          results.push({ tool: op.tool, error: err instanceof Error ? err.message : String(err) });
        }
      }

      if (needsRebuild) {
        const pageCache = wiki.buildPageCache();
        wiki.rebuildIndex(pageCache);
        if (needsTimeline) wiki.rebuildTimeline(pageCache);
      }

      return JSON.stringify({ results, count: results.length }, null, 2);
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
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
