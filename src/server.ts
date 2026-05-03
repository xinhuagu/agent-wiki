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
import { registerPlugin, getPlugin, getPluginForFile, listPlugins, summarizeModel } from "./code-analysis.js";
import { cobolPlugin } from "./cobol/plugin.js";
import { canonicalNodeId, deserializeGraph, displayLabel, graphEdgesFrom, graphImpactOf } from "./cobol/graph.js";
import type { CodeProcedure, CodeRelation, NormalizedCodeModel } from "./code-analysis.js";
import type { SerializedFieldLineage, SerializedInferredFieldLineageEntry } from "./cobol/field-lineage.js";
import type { GraphEdge, GraphNode, KnowledgeGraph, NodeKind, SerializedGraph } from "./cobol/graph.js";

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
        name: "raw_ingest",
        description:
          "Ingest raw source documents into the knowledge base. Select `mode` to control the ingestion method:\n" +
          "- `add`: Add a local file or content string (immutable, SHA-256 verified). Supports directory imports. Single images (<10MB) returned inline — you MUST immediately call wiki_write to describe them.\n" +
          "- `fetch`: Download a file from a URL into raw/ (arXiv abstract URLs auto-converted to PDF). Single images returned inline — you MUST immediately call wiki_write to describe them.\n" +
          "- `import_confluence`: Recursively import Confluence pages with attachments and hierarchy. Requires CONFLUENCE_API_TOKEN env var ('email:api-token').\n" +
          "- `import_jira`: Import a Jira issue with comments, attachments, and linked issues. Requires JIRA_API_TOKEN env var ('email:api-token').",
        inputSchema: {
          type: "object" as const,
          properties: {
            mode: {
              type: "string",
              enum: ["add", "fetch", "import_confluence", "import_jira"],
              description: "Ingestion mode: add (local file/content), fetch (URL download), import_confluence (Confluence pages), import_jira (Jira issues)",
            },
            filename: {
              type: "string",
              description: "[add] Filename in raw/ (e.g. 'paper.pdf'). For directory imports, becomes subdirectory prefix (e.g. 'my-docs').",
            },
            content: {
              type: "string",
              description: "[add] File content as string. Either content or source_path is required.",
            },
            source_path: {
              type: "string",
              description: "[add] Absolute path to local file or directory to copy into raw/. If directory, all files imported recursively. Either content or source_path is required.",
            },
            source_url: {
              type: "string",
              description: "[add/fetch] Original URL where the document was downloaded from",
            },
            description: {
              type: "string",
              description: "[add/fetch] Brief description of what this source contains",
            },
            tags: {
              type: "array",
              items: { type: "string" },
              description: "[add/fetch] Tags for categorization",
            },
            auto_version: {
              type: "boolean",
              description: "[add] If true and file already exists, create a versioned copy (e.g. report_v2.xlsx) instead of failing. Default: false.",
            },
            pattern: {
              type: "string",
              description: "[add] File pattern filter for directory imports (e.g. '*.html', '*.{html,css}'). Ignored for single files.",
            },
            url: {
              type: "string",
              description: "[fetch] URL to download from. arXiv abs URLs auto-converted to PDF links. [import_confluence] Confluence page URL. [import_jira] Jira issue URL.",
            },
            recursive: {
              type: "boolean",
              description: "[import_confluence] Import child pages recursively (default: false)",
            },
            depth: {
              type: "number",
              description: "[import_confluence] Max recursion depth (-1 = unlimited, default: 50 when recursive=true)",
            },
            auth_env: {
              type: "string",
              description: "[import_confluence] Auth env var name (default: CONFLUENCE_API_TOKEN). [import_jira] Auth env var name (default: JIRA_API_TOKEN)",
            },
            include_comments: {
              type: "boolean",
              description: "[import_jira] Include issue comments (default: true)",
            },
            include_attachments: {
              type: "boolean",
              description: "[import_jira] Download attachments (default: true)",
            },
            include_links: {
              type: "boolean",
              description: "[import_jira] Import linked issues (default: true)",
            },
            link_depth: {
              type: "number",
              description: "[import_jira] Levels of linked issues to follow (default: 1)",
            },
          },
          required: ["mode"],
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
        name: "raw_coverage",
        description:
          "Report which raw/ files are not yet referenced by any wiki page. Answers 'what should I compile next?' — returns uncovered files sorted by recency/size, plus overall coverage ratio. Matches frontmatter 'sources' and inline 'raw/...' body references. Parsed artifacts (raw/parsed/) are excluded.",
        inputSchema: {
          type: "object" as const,
          properties: {
            limit: {
              type: "number",
              description: "Max uncovered entries to return. Default: 50.",
            },
            sort: {
              type: "string",
              enum: ["newest", "oldest", "largest"],
              description: "Sort order for uncovered entries. Default: 'newest'.",
            },
            tag: {
              type: "string",
              description: "Only consider raw files with this tag.",
            },
          },
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
      // raw_fetch, raw_import_confluence, raw_import_jira folded into raw_ingest
      // ═══════════════════════════════════════════════════════
      //  WIKI LAYER — Mutable compiled knowledge
      // ═══════════════════════════════════════════════════════
      {
        name: "wiki_read",
        description:
          "Read one or more wiki pages. Single page: pass `page`. Multiple pages: pass `pages` array — reads all in one request, saving N-1 round trips. " +
          "RECOMMENDED WORKFLOW: (1) call without 'section' to get the TOC for large pages, " +
          "(2) use wiki_search 'section' field to jump directly to the relevant heading, " +
          "(3) call with 'section' to read only that part. " +
          "Large pages without 'section' are truncated at 200 lines — check 'truncated' and 'toc' in the response.",
        inputSchema: {
          type: "object" as const,
          properties: {
            page: {
              type: "string",
              description: "Page path relative to wiki/ (e.g. 'concept-gil.md'). Use for single-page reads.",
            },
            pages: {
              type: "array",
              items: { type: "string" },
              description: "Array of page paths for multi-page reads. Returns an array of results in one request.",
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
        },
      },
      {
        name: "wiki_write",
        description:
          "Create or update a wiki page. Content should include YAML frontmatter (title, type, tags, sources) and Markdown body. Timestamps (created/updated) are auto-managed. Auto-routes root-level pages to matching topic subdirectories (via frontmatter `topic` field or tag matching). Auto-links: scans body for mentions of existing page titles and injects [[slug|text]] links automatically (skips code blocks, existing links, URLs). Wiki pages are MUTABLE — they represent compiled knowledge that improves over time. " +
          "Set `return_content: true` to include the final written content in the response — eliminates the follow-up wiki_read call in write-then-reference workflows.",
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
            return_content: {
              type: "boolean",
              description: "If true, include the final written content in the response. Eliminates a follow-up wiki_read call. Default: false.",
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
          "Uses BM25 by default; switches to hybrid BM25+vector re-ranking when `search.hybrid: true` is set in " +
          ".agent-wiki.yaml (requires wiki_admin action:rebuild to build the vector index first). " +
          "Set include_content=true for simple inline content (with optional inline_budget cap). " +
          "Set read_top_n to additionally read the top N unique matching pages (deduplicated) — enables combined search+read in one call; " +
          "returns a `pages` array with full content and `nextReads` for unread matches. " +
          "Use `type` or `tags` to narrow results without a separate wiki_list call. " +
          "When no results are found, returns a `knowledge_gap` field with a suggested page slug, title, type, and tags — use it to decide what to create with wiki_write.",
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
            type: {
              type: "string",
              description: "Filter results to a specific entity type (person, concept, event, artifact, code, comparison, summary, how-to, note, synthesis). Applied after BM25 ranking.",
            },
            tags: {
              type: "array",
              items: { type: "string" },
              description: "Filter results to pages that have at least one of these tags. Applied after BM25 ranking.",
            },
            include_content: {
              type: "boolean",
              description: "If true, include page content inline in results. When a section matched, returns that section; otherwise returns first 200 lines. Saves a follow-up batch read. Default: false.",
            },
            inline_budget: {
              type: "number",
              description: "Max total characters of inlined content across all results (only with include_content=true). Greedy — top-scoring results get content first; lower-scoring ones fall back to snippet-only when budget is exhausted. Omit for no limit.",
            },
            read_top_n: {
              type: "number",
              description: "How many unique top-scoring pages to read in full (default: unset). When set, activates combined search+read mode: deduplicates search hits, reads up to N unique pages, and returns a `pages` array alongside `results`. Max: 10.",
            },
            section: {
              type: "string",
              description: "Section heading filter applied to all page reads when read_top_n is set (e.g. '## Installation'). Case-insensitive partial match.",
            },
            per_page_limit: {
              type: "number",
              description: "Max lines per page when read_top_n is set (default: 200, max: 500). Pages exceeding this are truncated with metadata.",
            },
            include_toc: {
              type: "boolean",
              description: "Include table of contents for truncated pages when read_top_n is set (default: false).",
            },
          },
          required: ["query"],
        },
      },
      // wiki_search_read folded into wiki_search (read_top_n parameter)
      {
        name: "wiki_admin",
        description:
          "Wiki administration and maintenance. Select `action` to control behavior:\n" +
          "- `init`: Initialize a new knowledge base — creates wiki/, raw/, schemas/ directories and default templates.\n" +
          "- `config`: Show current workspace configuration: directories, lint settings, search settings, entity templates.\n" +
          "- `rebuild`: Rebuild index.md, timeline.md, code knowledge graphs, and optionally the vector index (when search.hybrid is enabled).\n" +
          "- `lint`: Run comprehensive health checks: contradictions, orphan pages, broken links, raw file integrity (SHA-256), synthesis page integrity. Set apply_fixes=true to auto-repair fixable issues.",
        inputSchema: {
          type: "object" as const,
          properties: {
            action: {
              type: "string",
              enum: ["init", "config", "rebuild", "lint"],
              description: "Administration action to perform",
            },
            path: {
              type: "string",
              description: "[init] Config root — where .agent-wiki.yaml is created (default: current directory)",
            },
            workspace: {
              type: "string",
              description: "[init] Separate workspace directory for wiki/, raw/, schemas/. If omitted, data goes in path.",
            },
            apply_fixes: {
              type: "boolean",
              description: "[lint] If true, automatically fix auto-fixable issues (missing frontmatter → inject title/type/tags). Default: false.",
            },
          },
          required: ["action"],
        },
      },
      // wiki_log removed — use wiki_read("log.md") instead
      // wiki_lint, wiki_init, wiki_config, wiki_rebuild folded into wiki_admin
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
        name: "knowledge_ingest",
        description:
          "Knowledge ingestion pipeline. Select `mode` to control behavior:\n" +
          "- `batch`: Batch import, extract, chunk, and pack source documents into digest packs. " +
          "Scans a directory (or single file), imports to raw/, extracts text with structural provenance " +
          "(per-page PDF, per-sheet XLSX, per-slide PPTX), chunks into fixed-line segments, then packs " +
          "into markdown digest packs under raw/digest-packs/{topic}/. Files already in raw/ are skipped.\n" +
          "- `digest_write`: Write LLM-generated digest summaries to wiki with structured provenance. " +
          "Creates or updates one or more wiki pages from digested content, linking back to source raw files and digest packs. " +
          "Index is rebuilt once at the end. Each page gets auto-classified, auto-routed, and timestamped.",
        inputSchema: {
          type: "object" as const,
          properties: {
            mode: {
              type: "string",
              enum: ["batch", "digest_write"],
              description: "Ingestion mode: batch (import and pack source documents) or digest_write (write LLM summaries to wiki)",
            },
            source_path: {
              type: "string",
              description: "[batch] Absolute path to a directory or single file to ingest",
            },
            pattern: {
              type: "string",
              description: "[batch] Glob filter when source_path is a directory (e.g. '*.pdf', '*.{xlsx,docx}')",
            },
            maxFiles: {
              type: "number",
              description: "[batch] Maximum files to process (default: 100, max: 1000)",
            },
            topic: {
              type: "string",
              description: "[batch] Topic name for organizing digest packs (default: 'general')",
            },
            chunkLines: {
              type: "number",
              description: "[batch] Maximum lines per chunk (default: 100)",
            },
            packLines: {
              type: "number",
              description: "[batch] Maximum lines per digest pack (default: 500)",
            },
            continueOnError: {
              type: "boolean",
              description: "[batch] Continue processing on individual file errors (default: true)",
            },
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
                    description: "Markdown body content (without frontmatter — auto-generated)",
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
                    description: "Source raw file paths (e.g. ['raw/topic/doc.pdf'])",
                  },
                  sourcePacks: {
                    type: "array",
                    items: { type: "string" },
                    description: "Digest pack paths used to generate this page",
                  },
                },
                required: ["page", "title", "body"],
              },
              description: "[digest_write] Array of wiki pages to write",
            },
          },
          required: ["mode"],
        },
      },
      // knowledge_ingest_batch, knowledge_digest_write folded into knowledge_ingest

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
        name: "code_query",
        description:
          "Query parsed code knowledge. Select `query_type` to control behavior:\n" +
          "- `trace_variable`: Trace all references to a variable in a parsed source file — shows where it is read, written, or passed, grouped by section/paragraph.\n" +
          "- `impact`: Query the compiled knowledge graph for downstream impact — returns affected programs, copybooks, or datasets grouped by dependency depth, with evidence and uncertainty markers.\n" +
          "- `procedure_flow`: Query parsed procedure/section PERFORM flow for one source file — returns section-level and paragraph-level flow, optionally focused on one procedure.\n" +
          "- `field_lineage`: Query compiled field-lineage artifacts — returns deterministic and inferred matches for one field, optionally narrowed to a copybook or qualified name.\n" +
          "- `dataflow_edges`: Query intra-program MOVE/COMPUTE/ADD assignment edges — returns directed field→field dataflow. Filter by `from`/`to`, or set `field`+`transitive: true` to follow chains across the full graph.",
        inputSchema: {
          type: "object" as const,
          properties: {
            query_type: {
              type: "string",
              enum: ["trace_variable", "impact", "procedure_flow", "field_lineage", "dataflow_edges"],
              description: "Query type: trace_variable, impact, procedure_flow, field_lineage, or dataflow_edges",
            },
            path: {
              type: "string",
              description: "[trace_variable/procedure_flow] Path to source file in raw/ (e.g. 'PAYROLL.cbl')",
            },
            variable: {
              type: "string",
              description: "[trace_variable] Variable name to trace (e.g. 'WS-TOTAL-SALARY')",
            },
            node_id: {
              type: "string",
              description: "[impact] Canonical node ID or logical name (e.g. 'copybook:DATE-UTILS' or 'DATE-UTILS')",
            },
            kind: {
              type: "string",
              description: "[impact] Optional node kind: program, copybook, dataset, job, or step",
            },
            max_depth: {
              type: "number",
              description: "[impact/dataflow_edges] Maximum traversal depth (default: 10)",
            },
            language: {
              type: "string",
              description: "[impact/field_lineage] Compiled language artifact set to read (default: 'cobol')",
            },
            procedure: {
              type: "string",
              description: "[procedure_flow] Optional procedure/section/paragraph name to focus traversal from (e.g. 'A100-INIT')",
            },
            procedure_kind: {
              type: "string",
              description: "[procedure_flow] Optional procedure kind filter: section or paragraph",
            },
            field_name: {
              type: "string",
              description: "[field_lineage] Field name to query (e.g. 'CUSTOMER-ID')",
            },
            qualified_name: {
              type: "string",
              description: "[field_lineage] Optional qualified field path (e.g. 'CUSTOMER-REC.CUSTOMER-ID')",
            },
            copybook: {
              type: "string",
              description: "[field_lineage] Optional copybook canonical id or logical name (e.g. 'copybook:CUSTOMER-A' or 'CUSTOMER-A')",
            },
            from: {
              type: "string",
              description: "[dataflow_edges] Filter: only edges whose source field matches (e.g. 'EMP-SALARY')",
            },
            to: {
              type: "string",
              description: "[dataflow_edges] Filter: only edges whose target field matches (e.g. 'WS-TOTAL-SALARY')",
            },
            field: {
              type: "string",
              description: "[dataflow_edges] Starting field for transitive traversal (requires transitive: true)",
            },
            transitive: {
              type: "boolean",
              description: "[dataflow_edges] Follow edges transitively from `field` (default: false)",
            },
            direction: {
              type: "string",
              enum: ["downstream", "upstream", "both"],
              description: "[dataflow_edges] Traversal direction when transitive: true — downstream (default), upstream, or both",
            },
          },
          required: ["query_type"],
        },
      },
      // code_trace_variable, code_impact folded into code_query
    ],
  }));

  // ── Call Tool (with concurrency control) ────────────────────

  const queue = new RequestQueue();

  // Tools that mutate state — serialized through the write queue
  const WRITE_TOOLS = new Set([
    // Consolidated public tools
    "raw_ingest",    // add/fetch/import_confluence/import_jira all mutate raw/
    "wiki_admin",    // init/rebuild/lint all mutate state (config is read-only but routed through write queue for safety)
    "knowledge_ingest", // batch/digest_write both mutate state
    // Public tools retained from the original surface (write classification unchanged)
    "wiki_write", "wiki_delete",
    // Legacy aliases (not in public surface but remain functional for backward compatibility)
    "raw_add", "raw_fetch", "raw_import_confluence", "raw_import_jira",
    "wiki_init", "wiki_rebuild",
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

function normalizeImpactKind(raw?: string): NodeKind | undefined {
  if (!raw) return undefined;
  switch (raw.trim().toLowerCase()) {
    case "program":
      return "Program";
    case "copybook":
      return "Copybook";
    case "dataset":
      return "Dataset";
    case "job":
      return "Job";
    case "step":
      return "Step";
    default:
      throw new Error(`Unsupported node kind: ${raw}. Expected one of: program, copybook, dataset, job, step.`);
  }
}

function normalizeProcedureKind(raw?: string): "section" | "paragraph" | undefined {
  if (!raw) return undefined;
  const kind = raw.trim().toLowerCase();
  if (kind === "section" || kind === "paragraph") return kind;
  throw new Error(`Unsupported procedure_kind: ${raw}. Expected one of: section, paragraph.`);
}

function parsedArtifactStem(filePath: string): string {
  return filePath.replace(/\.[^.]+$/, "");
}

async function loadParsedNormalizedModel(wiki: Wiki, filePath: string): Promise<NormalizedCodeModel> {
  const plugin = getPluginForFile(filePath);
  if (!plugin) {
    const supported = listPlugins().flatMap((p) => p.extensions).join(", ");
    throw new Error(`Unsupported file type: ${filePath}. Supported extensions: ${supported}`);
  }
  const rawResult = await wiki.rawRead(`parsed/${plugin.id}/${parsedArtifactStem(filePath)}.normalized.json`);
  if (!rawResult || rawResult.content === null) {
    throw new Error(`Parsed normalized model not found for "${filePath}". Run code_parse on that source file first.`);
  }
  try {
    return JSON.parse(rawResult.content) as NormalizedCodeModel;
  } catch (err) {
    throw new Error(`Failed to parse normalized model for "${filePath}": ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function loadFieldLineageArtifact(wiki: Wiki, language: string): Promise<SerializedFieldLineage> {
  const plugin = getPlugin(language);
  if (!plugin) {
    const available = listPlugins().map((p) => p.id).join(", ");
    throw new Error(`Unknown code-analysis plugin: ${language}. Available plugins: ${available}`);
  }
  const rawResult = await wiki.rawRead(`parsed/${plugin.id}/field-lineage.json`);
  if (!rawResult || rawResult.content === null) {
    throw new Error(
      `Compiled field lineage not found for "${plugin.id}". Run code_parse on one or more ${plugin.id.toUpperCase()} files, or run wiki_rebuild after parsing.`
    );
  }
  try {
    return JSON.parse(rawResult.content) as SerializedFieldLineage;
  } catch (err) {
    throw new Error(`Failed to parse compiled field lineage for "${plugin.id}": ${err instanceof Error ? err.message : String(err)}`);
  }
}

function procedureSectionName(procedure?: CodeProcedure): string | null {
  if (!procedure) return null;
  return procedure.kind === "section" ? procedure.name : procedure.parentProcedure ?? null;
}

function procedureSummary(procedure?: CodeProcedure): Record<string, unknown> | null {
  if (!procedure) return null;
  return {
    name: procedure.name,
    kind: procedure.kind,
    parentUnit: procedure.parentUnit ?? null,
    parentProcedure: procedure.parentProcedure ?? null,
    section: procedureSectionName(procedure),
    loc: procedure.loc,
  };
}

function resolveProcedure(
  procedures: CodeProcedure[],
  requested: string,
  kind?: "section" | "paragraph",
): CodeProcedure {
  const needle = requested.trim().toLowerCase();
  if (!needle) throw new Error("procedure must not be empty");
  const matches = procedures.filter((procedure) => {
    if (kind && procedure.kind !== kind) return false;
    return procedure.name.toLowerCase() === needle;
  });
  if (matches.length === 1) return matches[0]!;
  if (matches.length > 1) {
    throw new Error(
      `Procedure "${requested}" is ambiguous. Use procedure_kind to narrow it. Matches: ${matches.map((p) => `${p.kind}:${p.name}`).join(", ")}`
    );
  }
  throw new Error(`Procedure not found in parsed model: ${requested}`);
}

function buildProcedureFlowResponse(
  model: NormalizedCodeModel,
  query: {
    path: string;
    procedure?: string;
    procedureKind?: "section" | "paragraph";
    maxDepth: number;
  },
): Record<string, unknown> {
  const procedures = model.procedures.filter((procedure) =>
    procedure.kind === "section" || procedure.kind === "paragraph"
  );
  const procedureByName = new Map<string, CodeProcedure>();
  for (const procedure of procedures) {
    const key = procedure.name.toLowerCase();
    if (!procedureByName.has(key)) procedureByName.set(key, procedure);
  }

  const performRelations = model.relations.filter((relation) => relation.type === "perform");
  const performs = performRelations.map((relation) => {
    const fromProcedure = procedureByName.get(relation.from.toLowerCase());
    const toProcedure = procedureByName.get(relation.to.toLowerCase());
    return {
      from: {
        name: relation.from,
        kind: fromProcedure?.kind ?? null,
        section: procedureSectionName(fromProcedure),
      },
      to: {
        name: relation.to,
        kind: toProcedure?.kind ?? null,
        section: procedureSectionName(toProcedure),
      },
      line: relation.loc.line,
      thru: typeof relation.metadata?.thru === "string" ? relation.metadata.thru : null,
    };
  });

  const sectionCallMap = new Map<string, {
    fromSection: string;
    toSection: string;
    callers: Set<string>;
    targets: Set<string>;
    count: number;
  }>();
  for (const perform of performs) {
    const fromSection = perform.from.section;
    const toSection = perform.to.section;
    if (!fromSection || !toSection) continue;
    const key = `${fromSection}→${toSection}`;
    const aggregate = sectionCallMap.get(key) ?? {
      fromSection,
      toSection,
      callers: new Set<string>(),
      targets: new Set<string>(),
      count: 0,
    };
    aggregate.callers.add(perform.from.name);
    aggregate.targets.add(perform.to.name);
    aggregate.count += 1;
    sectionCallMap.set(key, aggregate);
  }
  const sectionCalls = [...sectionCallMap.values()]
    .map((entry) => ({
      fromSection: entry.fromSection,
      toSection: entry.toSection,
      count: entry.count,
      callers: [...entry.callers].sort((a, b) => a.localeCompare(b)),
      targets: [...entry.targets].sort((a, b) => a.localeCompare(b)),
    }))
    .sort((a, b) => a.fromSection.localeCompare(b.fromSection) || a.toSection.localeCompare(b.toSection));

  const response: Record<string, unknown> = {
    query: {
      type: "procedure_flow",
      path: query.path,
      procedure: query.procedure ?? null,
      procedure_kind: query.procedureKind ?? null,
      maxDepth: query.maxDepth,
    },
    unit: model.units[0] ?? null,
    summary: {
      sections: procedures.filter((procedure) => procedure.kind === "section").length,
      paragraphs: procedures.filter((procedure) => procedure.kind === "paragraph").length,
      performRelations: performs.length,
      sectionCalls: sectionCalls.length,
    },
    procedures: {
      sections: procedures
        .filter((procedure) => procedure.kind === "section")
        .map((procedure) => procedureSummary(procedure)),
      paragraphs: procedures
        .filter((procedure) => procedure.kind === "paragraph")
        .map((procedure) => procedureSummary(procedure)),
    },
    performs,
    sectionCalls,
  };

  if (!query.procedure) return response;

  const focus = resolveProcedure(procedures, query.procedure, query.procedureKind);
  const adjacency = new Map<string, Array<CodeRelation & { metadata?: Record<string, unknown> }>>();
  for (const relation of performRelations) {
    const fromKey = relation.from.toLowerCase();
    const fromList = adjacency.get(fromKey) ?? [];
    fromList.push(relation);
    adjacency.set(fromKey, fromList);

    const fromProcedure = procedureByName.get(fromKey);
    const fromSection = procedureSectionName(fromProcedure);
    if (fromSection) {
      const sectionKey = fromSection.toLowerCase();
      const sectionList = adjacency.get(sectionKey) ?? [];
      sectionList.push({
        ...relation,
        from: fromSection,
        metadata: {
          ...(relation.metadata ?? {}),
          viaParagraph: relation.from,
        },
      });
      adjacency.set(sectionKey, sectionList);
    }
  }

  const flowByDepth: Array<Record<string, unknown>> = [];
  const visited = new Set<string>([focus.name.toLowerCase()]);
  let frontier = new Set<string>([focus.name.toLowerCase()]);

  for (let depth = 1; depth <= query.maxDepth; depth++) {
    const edges = [...frontier].flatMap((name) => adjacency.get(name) ?? []);
    const currentLevelTargets = new Set<string>();
    for (const edge of edges) {
      const targetKey = edge.to.toLowerCase();
      if (visited.has(targetKey)) continue;
      currentLevelTargets.add(targetKey);
    }
    if (currentLevelTargets.size === 0) break;

    const nodes = [...currentLevelTargets]
      .sort((a, b) => a.localeCompare(b))
      .map((targetKey) => {
        visited.add(targetKey);
        const targetProcedure = procedureByName.get(targetKey);
        const via = edges
          .filter((edge) => edge.to.toLowerCase() === targetKey)
          .map((edge) => {
            const fromProcedure = procedureByName.get(edge.from.toLowerCase());
            return {
              from: edge.from,
              fromKind: fromProcedure?.kind ?? null,
              fromSection: procedureSectionName(fromProcedure),
              viaParagraph: typeof edge.metadata?.viaParagraph === "string" ? edge.metadata.viaParagraph : null,
              line: edge.loc.line,
              thru: typeof edge.metadata?.thru === "string" ? edge.metadata.thru : null,
            };
          });
        return {
          name: targetProcedure?.name ?? targetKey,
          kind: targetProcedure?.kind ?? null,
          parentUnit: targetProcedure?.parentUnit ?? null,
          parentProcedure: targetProcedure?.parentProcedure ?? null,
          section: procedureSectionName(targetProcedure),
          resolved: Boolean(targetProcedure),
          loc: targetProcedure?.loc ?? null,
          via,
        };
      });

    flowByDepth.push({ depth, nodes });
    frontier = currentLevelTargets;
  }

  response.focus = procedureSummary(focus);
  response.flowByDepth = flowByDepth;
  response.summary = {
    ...(response.summary as Record<string, unknown>),
    reachableProcedures: flowByDepth.reduce((count, level) => count + (((level.nodes as unknown[])?.length) ?? 0), 0),
    focusDepths: flowByDepth.length,
  };
  return response;
}

function normalizeLineageCopybookQuery(raw?: string): string | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (!trimmed) throw new Error("copybook must not be empty");
  return (trimmed.includes(":") ? trimmed : canonicalNodeId("Copybook", trimmed)).toUpperCase();
}

function copybookMatches(copybook: { id: string }, requestedCopybook?: string): boolean {
  if (!requestedCopybook) return true;
  const canonical = copybook.id.toUpperCase();
  if (canonical === requestedCopybook) return true;
  return displayLabel(copybook.id).toUpperCase() === displayLabel(requestedCopybook).toUpperCase();
}

function qualifiedNameMatches(candidate: string | undefined, requested?: string): boolean {
  if (!requested) return true;
  if (!candidate) return false;
  return candidate.trim().toUpperCase() === requested.trim().toUpperCase();
}

function inferredEntryMatches(
  entry: SerializedInferredFieldLineageEntry,
  requestedFieldName?: string,
  requestedQualifiedName?: string,
  requestedCopybook?: string,
): boolean {
  if (requestedFieldName && entry.fieldName.toUpperCase() !== requestedFieldName.toUpperCase()) return false;
  if (!requestedQualifiedName && !requestedCopybook) return true;
  const leftMatches = copybookMatches(entry.left.copybook, requestedCopybook)
    && qualifiedNameMatches(entry.left.qualifiedName, requestedQualifiedName);
  const rightMatches = copybookMatches(entry.right.copybook, requestedCopybook)
    && qualifiedNameMatches(entry.right.qualifiedName, requestedQualifiedName);
  return leftMatches || rightMatches;
}

function buildFieldLineageResponse(
  lineage: SerializedFieldLineage,
  query: {
    language: string;
    fieldName?: string;
    qualifiedName?: string;
    copybook?: string;
  },
): Record<string, unknown> {
  const fieldName = query.fieldName?.trim();
  const qualifiedName = query.qualifiedName?.trim();
  const copybook = normalizeLineageCopybookQuery(query.copybook);
  if (!fieldName && !qualifiedName) {
    throw new Error("field_lineage requires field_name or qualified_name");
  }

  const deterministic = lineage.deterministic.filter((entry) => {
    if (fieldName && entry.fieldName.toUpperCase() !== fieldName.toUpperCase()) return false;
    if (qualifiedName && !entry.qualifiedNames.some((name) => qualifiedNameMatches(name, qualifiedName))) return false;
    if (copybook && !entry.copybooks.some((item) => copybookMatches(item, copybook))) return false;
    return true;
  });
  const inferredHighConfidence = lineage.inferredHighConfidence.filter((entry) =>
    inferredEntryMatches(entry, fieldName, qualifiedName, copybook)
  );
  const inferredAmbiguous = lineage.inferredAmbiguous.filter((entry) =>
    inferredEntryMatches(entry, fieldName, qualifiedName, copybook)
  );

  return {
    query: {
      type: "field_lineage",
      language: query.language,
      field_name: fieldName ?? null,
      qualified_name: qualifiedName ?? null,
      copybook: copybook ?? null,
    },
    summary: {
      deterministicMatches: deterministic.length,
      inferredHighConfidenceMatches: inferredHighConfidence.length,
      inferredAmbiguousMatches: inferredAmbiguous.length,
    },
    deterministic,
    inferredHighConfidence,
    inferredAmbiguous,
  };
}

function codeQueryConsumesCompiledArtifacts(args: Record<string, unknown>): boolean {
  const queryType = args.query_type as string | undefined;
  return queryType === "impact" || queryType === "field_lineage";
}

async function loadCompiledGraph(wiki: Wiki, language: string): Promise<KnowledgeGraph> {
  const plugin = getPlugin(language);
  if (!plugin) {
    const available = listPlugins().map((p) => p.id).join(", ");
    throw new Error(`Unknown code-analysis plugin: ${language}. Available plugins: ${available}`);
  }
  const rawResult = await wiki.rawRead(`parsed/${plugin.id}/knowledge-graph.json`);
  if (!rawResult || rawResult.content === null) {
    throw new Error(
      `Compiled knowledge graph not found for "${plugin.id}". Run code_parse on one or more ${plugin.id.toUpperCase()} files, or run wiki_rebuild after parsing.`
    );
  }
  let parsed: SerializedGraph;
  try {
    parsed = JSON.parse(rawResult.content) as SerializedGraph;
  } catch (err) {
    throw new Error(`Failed to parse compiled knowledge graph for "${plugin.id}": ${err instanceof Error ? err.message : String(err)}`);
  }
  return deserializeGraph(parsed);
}

function removeParsedArtifactIfExists(wiki: Wiki, relativePath: string): void {
  const fullPath = safePath(wiki.config.rawDir, relativePath);
  if (existsSync(fullPath)) rmSync(fullPath, { force: true });
  if (existsSync(`${fullPath}.meta.yaml`)) rmSync(`${fullPath}.meta.yaml`, { force: true });
}

function removeWikiPageIfExists(wiki: Wiki, pagePath: string): void {
  if (wiki.read(pagePath)) {
    wiki.delete(pagePath);
  }
}

function applyDerivedArtifacts(
  wiki: Wiki,
  pluginId: string,
  derived: {
    artifacts: Array<{ path: string; content: string }>;
    wikiPages: Array<{ path: string; content: string }>;
    staleArtifacts?: string[];
    staleWikiPages?: string[];
  },
): Array<string> {
  const writtenArtifacts: string[] = [];
  const currentArtifactPaths = new Set(derived.artifacts.map((artifact) => artifact.path));
  const currentWikiPagePaths = new Set(derived.wikiPages.map((page) => page.path));

  for (const artifactPath of derived.staleArtifacts ?? []) {
    if (!currentArtifactPaths.has(artifactPath)) {
      removeParsedArtifactIfExists(wiki, `parsed/${pluginId}/${artifactPath}`);
    }
  }
  for (const pagePath of derived.staleWikiPages ?? []) {
    if (!currentWikiPagePaths.has(pagePath)) {
      removeWikiPageIfExists(wiki, pagePath);
    }
  }

  for (const artifact of derived.artifacts) {
    wiki.rawAddParsedArtifact(`parsed/${pluginId}/${artifact.path}`, artifact.content);
    writtenArtifacts.push(`raw/parsed/${pluginId}/${artifact.path}`);
  }
  for (const page of derived.wikiPages) {
    wiki.write(page.path, page.content);
  }
  return writtenArtifacts;
}

function rebuildDeferredGraphs(wiki: Wiki): void {
  for (const plugin of listPlugins()) {
    const parsedDir = join(wiki.config.rawDir, "parsed", plugin.id);
    if (plugin.rebuildAggregatePages) {
      for (const page of plugin.rebuildAggregatePages(parsedDir)) {
        wiki.write(page.path, page.content);
      }
    }
    if (plugin.buildKnowledgeGraph) {
      const graphResult = plugin.buildKnowledgeGraph(parsedDir);
      if (graphResult) {
        wiki.rawAddParsedArtifact(
          `parsed/${plugin.id}/knowledge-graph.json`,
          JSON.stringify(graphResult.serialized, null, 2),
        );
        for (const page of graphResult.wikiPages) {
          wiki.write(page.path, page.content);
        }
      }
    }
    if (plugin.buildDerivedArtifacts) {
      const derived = plugin.buildDerivedArtifacts(parsedDir);
      if (derived) {
        applyDerivedArtifacts(wiki, plugin.id, derived);
      }
    }
  }
}

function resolveImpactNode(graph: KnowledgeGraph, requested: string, kind?: NodeKind): GraphNode {
  const trimmed = requested.trim();
  if (!trimmed) {
    throw new Error("node_id must not be empty");
  }
  const needle = trimmed.toLowerCase();

  const exactMatches = Array.from(graph.nodes.values()).filter((node) => {
    if (kind && node.kind !== kind) return false;
    return node.id.toLowerCase() === needle;
  });
  if (exactMatches.length === 1) return exactMatches[0]!;
  if (exactMatches.length > 1) {
    throw new Error(`Ambiguous node_id "${requested}" matched multiple nodes: ${exactMatches.map((n) => n.id).join(", ")}`);
  }

  const labelMatches = Array.from(graph.nodes.values()).filter((node) => {
    if (kind && node.kind !== kind) return false;
    return displayLabel(node.id).toLowerCase() === needle;
  });
  if (labelMatches.length === 1) return labelMatches[0]!;
  if (labelMatches.length > 1) {
    throw new Error(
      `Logical name "${requested}" is ambiguous. Use a canonical node ID or pass kind. Matches: ${labelMatches.map((n) => n.id).join(", ")}`
    );
  }

  if (kind) {
    const canonical = canonicalNodeId(kind, trimmed);
    const canonicalMatch = Array.from(graph.nodes.values()).find((node) => node.id.toLowerCase() === canonical.toLowerCase());
    if (canonicalMatch) return canonicalMatch;
  }

  throw new Error(`Node not found in compiled graph: ${requested}`);
}

function summarizeEvidence(edge: GraphEdge): Record<string, unknown> {
  return {
    to: edge.to,
    toLabel: displayLabel(edge.to),
    relationship: edge.kind,
    confidence: edge.confidence,
    sourceFile: edge.evidence.sourceFile,
    line: edge.evidence.line,
    reason: edge.evidence.reason,
  };
}

function diagnosticNodeIds(diag: { message: string }): Set<string> {
  const matches = diag.message.match(/\b(?:program|copybook|dataset|job|step):[^\s"'`\],)]+/g) ?? [];
  return new Set(matches);
}

function buildImpactResponse(graph: KnowledgeGraph, sourceNode: GraphNode, maxDepth: number): Record<string, unknown> {
  const levels = graphImpactOf(graph, sourceNode.id, maxDepth);
  const impactedIds = new Set<string>();
  let previousLevelIds = new Set<string>([sourceNode.id]);
  const impactedByDepth: Array<Record<string, unknown>> = [];
  let unresolvedNodes = 0;
  let lowerConfidencePaths = 0;

  for (let depth = 1; depth <= maxDepth; depth++) {
    const levelNodes = levels.get(depth) ?? [];
    if (levelNodes.length === 0) continue;
    const currentIds = new Set(levelNodes.map((node) => node.id));
    const nodes = levelNodes.map((node) => {
      impactedIds.add(node.id);
      if (!node.resolved) unresolvedNodes++;
      const viaEdges = graphEdgesFrom(graph, node.id).filter((edge) => previousLevelIds.has(edge.to));
      const hasLowerConfidence = viaEdges.some((edge) => edge.confidence !== "deterministic");
      if (hasLowerConfidence) lowerConfidencePaths++;
      const warnings: string[] = [];
      if (!node.resolved) warnings.push("unresolved-node");
      if (hasLowerConfidence) warnings.push("lower-confidence-path");
      return {
        node_id: node.id,
        label: displayLabel(node.id),
        kind: node.kind,
        resolved: node.resolved ?? false,
        sourceFile: node.sourceFile ?? null,
        metadata: node.metadata ?? {},
        via: viaEdges.map(summarizeEvidence),
        warnings,
      };
    });
    impactedByDepth.push({ depth, nodes });
    previousLevelIds = currentIds;
  }

  const relevantNodeIds = new Set<string>([sourceNode.id, ...impactedIds]);
  const relevantDiagnostics = graph.diagnostics.filter((diag) =>
    Array.from(diagnosticNodeIds(diag)).some((id) => relevantNodeIds.has(id))
  );

  return {
    query: {
      requested: sourceNode.id,
      maxDepth,
    },
    source: {
      node_id: sourceNode.id,
      label: displayLabel(sourceNode.id),
      kind: sourceNode.kind,
      resolved: sourceNode.resolved ?? false,
      sourceFile: sourceNode.sourceFile ?? null,
      metadata: sourceNode.metadata ?? {},
    },
    summary: {
      affectedNodes: impactedIds.size,
      depths: impactedByDepth.length,
      unresolvedNodes,
      lowerConfidencePaths,
      diagnostics: relevantDiagnostics.length,
    },
    impactedByDepth,
    diagnostics: relevantDiagnostics,
  };
}

/** Internal options — not exposed to MCP callers. */
export interface HandleToolOpts {
  /** When true, wiki_write/wiki_delete skip rebuildIndex (batch rebuilds once at end). */
  skipRebuild?: boolean;
  /** When true, code_parse skips aggregate + graph rebuild (batch rebuilds once at end). */
  skipGraphRebuild?: boolean;
}

/**
 * Build a knowledge_gap suggestion when a search returns no results.
 * Derives suggested_page, suggested_title, type, and tags from the query
 * using the same heuristics as wiki_write auto-classification.
 *
 * @param forceType  When the caller searched with a type filter, use that type
 *                   instead of the classify() guess (avoids inconsistency).
 */
function buildKnowledgeGap(query: string, wiki: Wiki, forceType?: string): Record<string, unknown> {
  const classification = wiki.classify(query);
  const type = forceType ?? classification.type;
  // Title-case each word of the query
  const suggestedTitle = query
    .split(/\s+/)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(" ");
  // Slug: lowercase ASCII, collapse spaces to hyphens, max 50 chars.
  // Falls back to a hex digest of the query for non-ASCII (CJK etc.) text.
  let slug = query
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 50)
    .replace(/-$/, "");
  if (!slug) {
    // Non-ASCII query (e.g. CJK) — use a short hash to avoid "concept-.md"
    let h = 0;
    for (let i = 0; i < query.length; i++) h = (Math.imul(31, h) + query.charCodeAt(i)) | 0;
    slug = (h >>> 0).toString(16).slice(0, 8);
  }
  const suggestedPage = `${type}-${slug}.md`;
  return {
    query,
    suggested_page: suggestedPage,
    suggested_title: suggestedTitle,
    suggested_type: type,
    suggested_tags: classification.tags,
    hint: `No pages found for "${query}". Use wiki_write to create "${suggestedPage}".`,
  };
}

/** Shared page-content reader used by wiki_search (read_top_n mode) and wiki_search_read. */
function readPagesContent(
  wiki: Wiki,
  paths: string[],
  sectionFilter: string | undefined,
  perPageLimit: number,
  includeToc: boolean,
): Array<Record<string, unknown>> {
  const pages: Array<Record<string, unknown>> = [];
  for (const pagePath of paths) {
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
        let hasSubsections = false;
        const parts = [target.content];
        for (let i = targetIdx + 1; i < sections.length; i++) {
          const s = sections[i]!;
          if (s.level <= target.level && s.heading !== "") break;
          if (s.heading !== "") hasSubsections = true;
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
          ...(truncated && hasSubsections ? { has_subsections: true } : {}),
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
  return pages;
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

    case "raw_coverage": {
      const sortArg = args.sort;
      if (sortArg !== undefined && sortArg !== "newest" && sortArg !== "oldest" && sortArg !== "largest") {
        throw new Error(`Invalid sort: ${String(sortArg)}. Must be 'newest', 'oldest', or 'largest'.`);
      }
      const report = wiki.rawCoverage({
        limit: args.limit as number | undefined,
        sort: sortArg as "newest" | "oldest" | "largest" | undefined,
        tag: args.tag as string | undefined,
      });
      return JSON.stringify(report, null, 2);
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
      // ── Multi-page read ──────────────────────────────────────
      const multiPaths = args.pages as string[] | undefined;
      if (multiPaths && multiPaths.length > 0) {
        const readOnePage = (pagePath: string) => {
          const p = wiki.read(pagePath);
          if (!p) return { page: pagePath, not_found: true };
          const fullPath = join(wiki.config.wikiDir, p.path);
          let raw: string;
          try { raw = readFileSync(fullPath, "utf-8"); } catch { return { page: pagePath, not_found: true }; }
          const lines = raw.split("\n");
          const total = lines.length;
          const DEFAULT_LIMIT = 200;
          const MAX_LIMIT = 500;
          const offset2 = Math.max(0, Math.floor((args.offset as number) ?? 0));
          const limit2 = Math.min(MAX_LIMIT, Math.max(1, Math.floor((args.limit as number) ?? DEFAULT_LIMIT)));
          const slice = lines.slice(offset2, offset2 + limit2);
          const truncated = offset2 + limit2 < total;
          if (!truncated && offset2 === 0) return { page: pagePath, content: raw };
          const toc = buildToc(splitSections(raw));
          return { page: pagePath, content: slice.join("\n"), offset: offset2, lines_returned: slice.length, total_lines: total, truncated, next_offset: truncated ? offset2 + limit2 : null, toc: toc || null };
        };
        const pages2 = multiPaths.map(readOnePage);
        return JSON.stringify({ pages: pages2, count: pages2.length }, null, 2);
      }

      // ── Single-page read (original behaviour) ───────────────
      if (!args.page) throw new Error("wiki_read requires 'page' or 'pages'");
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
      // Auto-link: inject [[slug|text]] for mentioned page titles in body
      const { content: linkedContent, linksAdded } = wiki.config.autoLink.enabled
        ? wiki.autoLink(enrichedContent, args.page as string)
        : { content: enrichedContent, linksAdded: 0 };
      // Auto-route to matching topic subdirectory
      const resolvedPage = wiki.resolvePagePath(args.page as string, linkedContent);
      const writtenContent = wiki.write(
        resolvedPage,
        linkedContent,
        args.source as string | undefined
      );
      // Auto-rebuild indexes (skipped when called from batch — batch rebuilds once at end)
      if (!opts?.skipRebuild) wiki.rebuildIndex();
      // Update vector embedding if hybrid search is enabled
      if (wiki.config.search.hybrid) {
        await wiki.updatePageVector(resolvedPage).catch(() => { /* non-fatal */ });
      }
      const classification = wiki.classify(linkedContent);
      const writeResult: Record<string, unknown> = {
        ok: true,
        page: resolvedPage,
        routed: resolvedPage !== args.page,
        autoClassified: { type: classification.type, tags: classification.tags, confidence: classification.confidence },
        autoLinked: linksAdded,
      };
      if (args.return_content) {
        // Return the content actually written to disk (includes injected timestamps)
        writeResult.content = writtenContent;
      }
      return JSON.stringify(writeResult);
    }

    case "wiki_delete": {
      const existed = wiki.delete(args.page as string);
      if (existed && !opts?.skipRebuild) wiki.rebuildIndex();
      // Remove vector embedding if hybrid search is enabled
      if (existed && wiki.config.search.hybrid) {
        wiki.removePageVector(args.page as string);
      }
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
      const searchQuery = args.query as string;
      const searchLimit = (args.limit as number) ?? 10;
      const filterType = args.type as string | undefined;
      const filterTags = args.tags as string[] | undefined;
      // Fetch extra candidates so post-filter doesn't starve results
      const fetchLimit = (filterType || filterTags?.length) ? searchLimit * 3 : searchLimit;
      const rawResults = wiki.config.search.hybrid
        ? await wiki.searchHybrid(searchQuery, fetchLimit)
        : wiki.search(searchQuery, fetchLimit);
      // Apply type / tags filters (post-ranking — BM25 scores are unaffected)
      const results = (filterType || filterTags?.length)
        ? rawResults.filter(r => {
            const p = wiki.read(r.path);
            if (!p) return false;
            if (filterType && p.type !== filterType) return false;
            if (filterTags?.length && !filterTags.some(t => p.tags.includes(t))) return false;
            return true;
          }).slice(0, searchLimit)
        : rawResults;
      // Knowledge gap: guide the agent when the search finds nothing
      if (results.length === 0) {
        return JSON.stringify({
          results: [],
          count: 0,
          knowledge_gap: buildKnowledgeGap(searchQuery, wiki, filterType),
        }, null, 2);
      }
      // Combined search+read mode (read_top_n) — supersedes include_content when both are set
      if (args.read_top_n != null) {
        const readTopN = Math.min(Math.max(1, Math.floor(args.read_top_n as number)), 10);
        const sectionFilter = args.section as string | undefined;
        const perPageLimit = Math.min(500, Math.max(1, Math.floor((args.per_page_limit as number) ?? 200)));
        const includeToc = (args.include_toc as boolean) ?? false;

        // Deduplicate — preserve score order, first occurrence wins
        const seen = new Set<string>();
        const uniquePaths: string[] = [];
        for (const r of results) {
          if (!seen.has(r.path)) {
            seen.add(r.path);
            uniquePaths.push(r.path);
          }
        }

        const toRead = uniquePaths.slice(0, readTopN);
        const nextReads = uniquePaths.slice(readTopN);
        const pages = readPagesContent(wiki, toRead, sectionFilter, perPageLimit, includeToc);

        return JSON.stringify({
          results,
          count: results.length,
          pages,
          pagesRead: pages.length,
          nextReads,
        }, null, 2);
      }

      if (!args.include_content) {
        return JSON.stringify({ results, count: results.length }, null, 2);
      }
      // Inline page content — eliminates follow-up wiki_read calls
      const inlineBudget = args.inline_budget != null ? (args.inline_budget as number) : Infinity;
      let budgetRemaining = inlineBudget;
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
              let hasSubsections = false;
              const parts = [target.content];
              for (let i = targetIdx + 1; i < sections.length; i++) {
                const s = sections[i]!;
                if (s.level <= target.level && s.heading !== "") break;
                if (s.heading !== "") hasSubsections = true;
                parts.push(s.content);
              }
              const sectionText = parts.join("\n");
              const sectionLines = sectionText.split("\n");
              const sectionTruncated = sectionLines.length > 200;
              const content = sectionTruncated ? sectionLines.slice(0, 200).join("\n") : sectionText;
              if (content.length > budgetRemaining) {
                return { ...r, budget_exceeded: true };
              }
              budgetRemaining -= content.length;
              return {
                ...r,
                content,
                ...(sectionTruncated ? { truncated: true, total_lines: sectionLines.length } : {}),
                ...(sectionTruncated && hasSubsections ? { has_subsections: true } : {}),
              };
            }
          }
          // No section match — return first 200 lines
          const lines = raw.split("\n");
          const truncated = lines.length > 200;
          const content = truncated ? lines.slice(0, 200).join("\n") : raw;
          if (content.length > budgetRemaining) {
            return { ...r, budget_exceeded: true };
          }
          budgetRemaining -= content.length;
          return {
            ...r,
            content,
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
      const results = wiki.config.search.hybrid
        ? await wiki.searchHybrid(query, limit)
        : wiki.search(query, limit);

      // Knowledge gap: guide the agent when the search finds nothing
      if (results.length === 0) {
        return JSON.stringify({
          results: [],
          pages: [],
          nextReads: [],
          count: 0,
          pagesRead: 0,
          knowledge_gap: buildKnowledgeGap(query, wiki),
        }, null, 2);
      }

      // Deduplicate — preserve score order, first occurrence wins
      const seen = new Set<string>();
      const uniquePaths: string[] = [];
      for (const r of results) {
        if (!seen.has(r.path)) {
          seen.add(r.path);
          uniquePaths.push(r.path);
        }
      }

      const toRead = uniquePaths.slice(0, readTopN);
      const nextReads = uniquePaths.slice(readTopN);
      const pages = readPagesContent(wiki, toRead, sectionFilter, perPageLimit, includeToc);

      return JSON.stringify({
        results,
        count: results.length,
        pages,
        pagesRead: pages.length,
        nextReads,
      }, null, 2);
    }

    case "wiki_lint": {
      const applyFixes = (args.apply_fixes as boolean) ?? false;
      const report = wiki.lint(applyFixes);
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
      const searchInfo: Record<string, unknown> = { ...cfg.search };
      if (cfg.search.hybrid) {
        searchInfo.vectorCount = wiki.getVectorCount();
      }
      return JSON.stringify({
        configRoot: cfg.configRoot,
        workspace: cfg.workspace,
        wikiDir: cfg.wikiDir,
        rawDir: cfg.rawDir,
        schemasDir: cfg.schemasDir,
        lint: cfg.lint,
        search: searchInfo,
        separateWorkspace: cfg.configRoot !== cfg.workspace,
        schemas: schemas.map(s => s.name),
      }, null, 2);
    }

    // wiki_schemas removed — merged into wiki_config

    case "wiki_rebuild": {
      // Rebuild code knowledge graphs for all registered plugins FIRST,
      // so that generated pages (system-map.md, call-graph.md) are included
      // in the index and timeline built afterwards.  This matches the batch
      // handler ordering (graph pages → index/timeline).
      let graphStats: { plugins: number; nodes: number; edges: number } | undefined;
      for (const plugin of listPlugins()) {
        const parsedDir = join(wiki.config.rawDir, "parsed", plugin.id);
        if (plugin.rebuildAggregatePages) {
          for (const page of plugin.rebuildAggregatePages(parsedDir)) {
            wiki.write(page.path, page.content);
          }
        }
        if (plugin.buildKnowledgeGraph) {
          const graphResult = plugin.buildKnowledgeGraph(parsedDir);
          if (graphResult) {
            wiki.rawAddParsedArtifact(
              `parsed/${plugin.id}/knowledge-graph.json`,
              JSON.stringify(graphResult.serialized, null, 2),
            );
            for (const page of graphResult.wikiPages) {
              wiki.write(page.path, page.content);
            }
            const ser = graphResult.serialized as {
              nodes?: unknown[];
              edges?: unknown[];
            };
            graphStats = {
              plugins: (graphStats?.plugins ?? 0) + 1,
              nodes: ser.nodes?.length ?? 0,
              edges: ser.edges?.length ?? 0,
            };
          }
        }
        if (plugin.buildDerivedArtifacts) {
          const derived = plugin.buildDerivedArtifacts(parsedDir);
          if (derived) {
            applyDerivedArtifacts(wiki, plugin.id, derived);
          }
        }
      }

      // Now build page cache AFTER graph pages are written, so they are
      // included in the index and timeline.
      const pageCache = wiki.buildPageCache();
      wiki.rebuildIndex(pageCache);
      // Yield event loop so MCP transport can respond to client pings.
      await new Promise((r) => setImmediate(r));
      wiki.rebuildTimeline(pageCache);

      // Rebuild vector index if hybrid search is enabled
      let vectorStats: { pagesProcessed: number; errors: number } | undefined;
      if (wiki.config.search.hybrid) {
        vectorStats = await wiki.rebuildVectorIndex().catch(() => undefined);
      }
      const parts: string[] = ["Index and timeline rebuilt"];
      if (graphStats) {
        parts.push(`Knowledge graph: ${graphStats.nodes} nodes, ${graphStats.edges} edges`);
      }
      if (vectorStats) {
        parts.push(`Vector index: ${vectorStats.pagesProcessed} pages embedded${vectorStats.errors > 0 ? `, ${vectorStats.errors} errors` : ""}`);
      }
      return JSON.stringify({ ok: true, message: parts.join(". ") + "." });
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
      // Skipped when called from batch — batch rebuilds once at end.
      if (plugin.rebuildAggregatePages && !opts?.skipGraphRebuild) {
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

      // Build knowledge graph from all parsed models
      // Skipped when called from batch — batch rebuilds once at end.
      let graphSummary: Record<string, unknown> | undefined;
      if (plugin.buildKnowledgeGraph && !opts?.skipGraphRebuild) {
        const parsedDir = join(wiki.config.rawDir, "parsed", lang);
        const graphResult = plugin.buildKnowledgeGraph(parsedDir);
        if (graphResult) {
          wiki.rawAddParsedArtifact(
            `parsed/${lang}/knowledge-graph.json`,
            JSON.stringify(graphResult.serialized, null, 2),
          );
          artifacts.push(`raw/parsed/${lang}/knowledge-graph.json`);
          for (const page of graphResult.wikiPages) {
            wiki.write(page.path, page.content);
            writtenPages.push(page.path);
          }
          const ser = graphResult.serialized as {
            nodes?: unknown[];
            edges?: unknown[];
            diagnostics?: unknown[];
          };
          graphSummary = {
            nodes: ser.nodes?.length ?? 0,
            edges: ser.edges?.length ?? 0,
            diagnostics: ser.diagnostics?.length ?? 0,
          };
        }
      }
      if (plugin.buildDerivedArtifacts && !opts?.skipGraphRebuild) {
        const parsedDir = join(wiki.config.rawDir, "parsed", lang);
        const derived = plugin.buildDerivedArtifacts(parsedDir);
        if (derived) {
          artifacts.push(...applyDerivedArtifacts(wiki, lang, derived));
          for (const page of derived.wikiPages) {
            writtenPages.push(page.path);
          }
        }
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
      if (graphSummary) {
        output.knowledgeGraph = graphSummary;
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

    case "code_impact": {
      const language = ((args.language as string | undefined) ?? "cobol").trim().toLowerCase();
      const requestedNode = args.node_id as string;
      const kind = normalizeImpactKind(args.kind as string | undefined);
      const maxDepth = Math.min(50, Math.max(1, Math.floor((args.max_depth as number | undefined) ?? 10)));
      const graph = await loadCompiledGraph(wiki, language);
      const sourceNode = resolveImpactNode(graph, requestedNode, kind);
      const response = buildImpactResponse(graph, sourceNode, maxDepth);
      return JSON.stringify(response, null, 2);
    }

    case "code_procedure_flow": {
      const filePath = args.path as string;
      const procedure = args.procedure as string | undefined;
      const procedureKind = normalizeProcedureKind(args.procedure_kind as string | undefined);
      const maxDepth = Math.min(50, Math.max(1, Math.floor((args.max_depth as number | undefined) ?? 10)));
      const model = await loadParsedNormalizedModel(wiki, filePath);
      const response = buildProcedureFlowResponse(model, { path: filePath, procedure, procedureKind, maxDepth });
      return JSON.stringify(response, null, 2);
    }

    case "code_field_lineage": {
      const language = ((args.language as string | undefined) ?? "cobol").trim().toLowerCase();
      const fieldName = args.field_name as string | undefined;
      const qualifiedName = args.qualified_name as string | undefined;
      const copybook = args.copybook as string | undefined;
      const lineage = await loadFieldLineageArtifact(wiki, language);
      const response = buildFieldLineageResponse(lineage, {
        language,
        fieldName,
        qualifiedName,
        copybook,
      });
      return JSON.stringify(response, null, 2);
    }

    case "code_dataflow_edges": {
      const filePath = args.path as string;
      const fromField = (args.from as string | undefined)?.toUpperCase();
      const toField = (args.to as string | undefined)?.toUpperCase();
      const startField = (args.field as string | undefined)?.toUpperCase();
      const transitive = (args.transitive as boolean | undefined) ?? false;
      const direction = (args.direction as string | undefined) ?? "downstream";
      const maxDepth = Math.min(50, Math.max(1, Math.floor((args.max_depth as number | undefined) ?? 10)));
      const model = await loadParsedNormalizedModel(wiki, filePath);
      const allEdges = model.relations.filter((r) => r.type === "dataflow");

      const formatEdge = (r: (typeof allEdges)[0]) => ({
        from: r.from,
        to: r.to,
        via: r.metadata?.via,
        line: r.loc.line,
        procedure: r.metadata?.procedure,
        section: r.metadata?.section,
      });

      if (transitive && startField) {
        const visited = new Set<string>([startField]);
        let frontier = [startField];
        const levels: Array<{ depth: number; fields: string[]; edges: ReturnType<typeof formatEdge>[] }> = [];

        for (let depth = 1; depth <= maxDepth && frontier.length > 0; depth++) {
          const levelEdges: typeof allEdges = [];
          const nextFields: string[] = [];

          for (const field of frontier) {
            if (direction === "downstream" || direction === "both") {
              for (const e of allEdges.filter((e) => e.from === field)) {
                levelEdges.push(e);
                if (!visited.has(e.to)) { visited.add(e.to); nextFields.push(e.to); }
              }
            }
            if (direction === "upstream" || direction === "both") {
              for (const e of allEdges.filter((e) => e.to === field)) {
                levelEdges.push(e);
                if (!visited.has(e.from)) { visited.add(e.from); nextFields.push(e.from); }
              }
            }
          }

          if (levelEdges.length > 0) {
            levels.push({ depth, fields: nextFields, edges: levelEdges.map(formatEdge) });
          }
          frontier = nextFields;
        }

        const allVisited = [...visited].filter((f) => f !== startField);
        return JSON.stringify({
          file: filePath,
          field: startField,
          direction,
          transitive: true,
          total_fields: allVisited.length,
          total_edges: levels.reduce((s, l) => s + l.edges.length, 0),
          levels,
        }, null, 2);
      }

      let edges = allEdges;
      if (fromField) edges = edges.filter((r) => r.from === fromField);
      if (toField) edges = edges.filter((r) => r.to === toField);
      return JSON.stringify({
        file: filePath,
        total: edges.length,
        edges: edges.map(formatEdge),
      }, null, 2);
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
              // Semantic chunking: split by headings first so each chunk is a
              // coherent logical unit. Falls back to a single segment for files
              // with no headings (e.g. plain CSV, config files).
              const mdSections = splitSections(content);
              const nonEmpty = mdSections.filter(s => s.content.trim().length > 0);
              segments = nonEmpty.length > 1
                ? nonEmpty.map(s => ({ text: s.content, source: { file: rawFilename } }))
                : [{ text: content, source: { file: rawFilename } }];
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
      // Tools whose per-call graph/aggregate rebuild should be deferred
      const GRAPH_REBUILD_TOOLS = new Set(["code_parse"]);
      let needsRebuild = false;
      let needsTimeline = false;
      let needsGraphRebuild = false;

      const results: Array<Record<string, unknown>> = [];
      for (const op of ops) {
        if (op.tool === "batch") {
          results.push({ tool: op.tool, error: "Cannot nest batch operations" });
          continue;
        }
        // Deduplicate wiki_rebuild / wiki_admin action:rebuild — defer to end-of-batch full rebuild
        const isRebuild = op.tool === "wiki_rebuild" ||
          (op.tool === "wiki_admin" && (op.args?.action === "rebuild"));
        if (isRebuild) {
          needsRebuild = true;
          needsTimeline = true;
          results.push({ tool: op.tool, result: { ok: true, deferred: "merged into end-of-batch rebuild" } });
          continue;
        }
        try {
          if (needsGraphRebuild && (
            op.tool === "code_impact" ||
            (op.tool === "code_query" && codeQueryConsumesCompiledArtifacts(op.args ?? {}))
          )) {
            rebuildDeferredGraphs(wiki);
            needsGraphRebuild = false;
          }

          const opOpts: HandleToolOpts = {};
          if (REBUILD_TOOLS.has(op.tool)) opOpts.skipRebuild = true;
          if (GRAPH_REBUILD_TOOLS.has(op.tool)) opOpts.skipGraphRebuild = true;
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
          if (GRAPH_REBUILD_TOOLS.has(op.tool)) {
            needsGraphRebuild = true;
            needsRebuild = true; // graph pages are wiki pages
            needsTimeline = true; // graph pages have timestamps → must appear in timeline
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

      // Deferred graph rebuild: run once at end of batch for all plugins that parsed files
      if (needsGraphRebuild) {
        rebuildDeferredGraphs(wiki);
      }

      if (needsRebuild) {
        const pageCache = wiki.buildPageCache();
        wiki.rebuildIndex(pageCache);
        if (needsTimeline) wiki.rebuildTimeline(pageCache);
      }

      return JSON.stringify({ results, count: results.length }, null, 2);
    }

    // ═══ CONSOLIDATED PUBLIC TOOLS (delegate to legacy handlers) ═══

    case "raw_ingest": {
      const mode = args.mode as string | undefined;
      switch (mode) {
        case "add": return handleTool(wiki, "raw_add", args, opts);
        case "fetch": return handleTool(wiki, "raw_fetch", args, opts);
        case "import_confluence": return handleTool(wiki, "raw_import_confluence", args, opts);
        case "import_jira": return handleTool(wiki, "raw_import_jira", args, opts);
        default: throw new Error(`Unknown raw_ingest mode: "${mode}". Expected: add | fetch | import_confluence | import_jira`);
      }
    }

    case "wiki_admin": {
      const action = args.action as string | undefined;
      switch (action) {
        case "init": return handleTool(wiki, "wiki_init", args, opts);
        case "config": return handleTool(wiki, "wiki_config", args, opts);
        case "rebuild": return handleTool(wiki, "wiki_rebuild", args, opts);
        case "lint": return handleTool(wiki, "wiki_lint", args, opts);
        default: throw new Error(`Unknown wiki_admin action: "${action}". Expected: init | config | rebuild | lint`);
      }
    }

    case "code_query": {
      const queryType = args.query_type as string | undefined;
      switch (queryType) {
        case "trace_variable": return handleTool(wiki, "code_trace_variable", args, opts);
        case "impact": return handleTool(wiki, "code_impact", args, opts);
        case "procedure_flow": return handleTool(wiki, "code_procedure_flow", args, opts);
        case "field_lineage": return handleTool(wiki, "code_field_lineage", args, opts);
        case "dataflow_edges": return handleTool(wiki, "code_dataflow_edges", args, opts);
        default: throw new Error(`Unknown code_query query_type: "${queryType}". Expected: trace_variable | impact | procedure_flow | field_lineage | dataflow_edges`);
      }
    }

    case "knowledge_ingest": {
      const mode = args.mode as string | undefined;
      switch (mode) {
        case "batch": return handleTool(wiki, "knowledge_ingest_batch", args, opts);
        case "digest_write": return handleTool(wiki, "knowledge_digest_write", args, opts);
        default: throw new Error(`Unknown knowledge_ingest mode: "${mode}". Expected: batch | digest_write`);
      }
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
