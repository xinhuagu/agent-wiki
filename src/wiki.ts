/**
 * Core Wiki engine — pure data layer, zero LLM dependency.
 *
 * Architecture (Karpathy LLM Wiki pattern):
 *
 *   raw/     — Immutable source documents. Write-once, never modified.
 *              Each file has a .meta.yaml sidecar with provenance.
 *
 *   wiki/    — Mutable Markdown layer. Three kinds of files:
 *              1. System: index.md, log.md, timeline.md (auto-maintained)
 *              2. Entity pages: concept-*, person-*, artifact-*, etc.
 *              3. Synthesis pages: synthesis-* (distilled from multiple pages)
 *
 *   schemas/ — Entity templates (person, concept, event, etc.)
 *
 * Key principles:
 *   - Raw files are IMMUTABLE — the source of truth
 *   - Wiki pages are MUTABLE — compiled knowledge, continuously refined
 *   - Self-checking: lint detects contradictions, broken links, stale claims
 *   - Knowledge compounds: every write improves the whole
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, unlinkSync, rmdirSync, statSync, copyFileSync, createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { join, relative, resolve, basename, extname, dirname } from "node:path";
import { createHash } from "node:crypto";
import matter from "gray-matter";
import yaml from "js-yaml";
import { VERSION } from "./version.js";
import { SearchEngine, type SearchResult, type SearchConfig, DEFAULT_SEARCH_CONFIG } from "./search.js";
import { extractText, extractDocument, guessMime } from "./extraction.js";
import type { AtlassianConfig, ConfluenceImportResult, JiraImportResult } from "./atlassian.js";

// ── Types ─────────────────────────────────────────────────────────

export interface WikiPage {
  path: string;          // relative to wiki/, e.g. "concept-gil.md"
  title: string;
  type?: string;         // person | concept | event | artifact | synthesis | ...
  tags: string[];
  sources: string[];     // traceability back to raw/ or URLs
  content: string;       // body without frontmatter
  frontmatter: Record<string, unknown>;
  links: string[];       // [[page]] references extracted from body
  created?: string;      // ISO timestamp
  updated?: string;      // ISO timestamp
  derivedFrom?: string[]; // for synthesis pages — which pages were combined
}

export interface RawDocument {
  path: string;          // relative to raw/, e.g. "paper.pdf"
  sourceUrl?: string;    // where it was downloaded from
  downloadedAt: string;  // ISO timestamp
  sha256: string;        // content hash — integrity check
  size: number;          // bytes
  mimeType?: string;     // best-guess MIME
  description?: string;  // human-readable note
  tags?: string[];       // categorization
}

export interface LintIssue {
  severity: "error" | "warning" | "info";
  page: string;
  message: string;
  suggestion?: string;
  autoFixable: boolean;
  category?: "contradiction" | "orphan" | "broken-link" | "missing-source" | "stale" | "structure" | "integrity";
}

export interface LintReport {
  pagesChecked: number;
  rawChecked: number;
  issues: LintIssue[];
  contradictions: Contradiction[];
}

export interface Contradiction {
  claim: string;         // what's being contradicted
  pageA: string;         // first page
  excerptA: string;      // text from page A
  pageB: string;         // conflicting page
  excerptB: string;      // text from page B
  severity: "error" | "warning";
}

/** Per-file cache entry for raw integrity verification. */
interface RawIntegrityCacheEntry {
  fileMtimeMs: number;
  fileSize: number;
  metaMtimeMs: number;
  status: "ok" | "corrupted" | "missing-meta";
}

/** On-disk shape of .lint-cache.json. */
interface LintCache {
  version: 1;
  entries: Record<string, RawIntegrityCacheEntry>;
}

export interface TimelineEntry {
  time: string;
  operation: string;
  page?: string;
  summary: string;
}

export interface WikiConfig {
  /** Where the config file was loaded from (or --wiki-path). */
  configRoot: string;
  /** The workspace directory — all data lives here. */
  workspace: string;
  wikiDir: string;
  rawDir: string;
  schemasDir: string;
  lint: {
    checkOrphans: boolean;
    checkStaleDays: number;
    checkMissingSources: boolean;
    checkContradictions: boolean;
    checkIntegrity: boolean;
  };
  /**
   * Directories from which `sourcePath` in rawAdd is allowed to copy files.
   * Defaults to `[workspace]` — only files already inside the workspace.
   * Set to explicit paths in .agent-wiki.yaml to widen access.
   * An empty array blocks all sourcePath copies.
   */
  allowedSourceDirs: string[];
  /** Atlassian (Confluence / Jira) integration settings. */
  atlassian: {
    allowedHosts: string[];
    maxPages: number;
    maxAttachmentSize: number;
  };
  /** Search engine configuration. */
  search: SearchConfig;
}

// System pages that lint should treat specially
const SYSTEM_PAGES = new Set(["index.md", "log.md", "timeline.md"]);

/** Check if a page path is a system page.
 *  Root-level: index.md, log.md, timeline.md.
 *  Nested: any * /index.md — reserved for auto-generated directory indexes. */
function isSystemPage(pagePath: string): boolean {
  const normalized = pagePath.replace(/\\/g, "/");
  if (SYSTEM_PAGES.has(normalized)) return true;
  return normalized.endsWith("/index.md");
}

/**
 * Validate that a user-supplied relative path stays within the base directory.
 * Prevents directory traversal attacks (e.g. "../../etc/passwd").
 * Returns the resolved absolute path if safe, throws otherwise.
 */
export function safePath(base: string, userPath: string): string {
  if (!userPath || typeof userPath !== "string") {
    throw new Error("Path must be a non-empty string");
  }
  // Reject absolute paths outright
  if (userPath.startsWith("/") || userPath.startsWith("\\")) {
    throw new Error(`Absolute paths are not allowed: "${userPath}"`);
  }
  // Reject null bytes (poison byte attack)
  if (userPath.includes("\0")) {
    throw new Error("Path contains null bytes");
  }
  const resolved = resolve(base, userPath);
  const normalizedBase = resolve(base);
  if (!resolved.startsWith(normalizedBase + "/")) {
    throw new Error(`Path traversal detected: "${userPath}" escapes the allowed directory`);
  }
  return resolved;
}

// ── Markdown section utilities ────────────────────────────────────

export interface MarkdownSection {
  heading: string;  // e.g. "## Installation", or "" for frontmatter/pre-heading content
  level: number;    // 1–6, or 0 for pre-heading content
  content: string;  // heading line + body up to next same-or-higher heading
}

/** Split markdown into sections by headings.
 *  Correctly skips heading-like lines inside fenced code blocks (``` or ~~~).
 *  The leading frontmatter block (--- ... ---) is returned as the first section
 *  with heading "" and level 0. */
export function splitSections(markdown: string): MarkdownSection[] {
  const lines = markdown.split("\n");
  const sections: MarkdownSection[] = [];
  let buf: string[] = [];
  let currentHeading = "";
  let currentLevel = 0;
  let inFrontmatter = false;
  let inCodeBlock = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;

    // Frontmatter: first line must be exactly "---"
    if (i === 0 && line.trim() === "---") {
      inFrontmatter = true;
      buf.push(line);
      continue;
    }
    if (inFrontmatter) {
      buf.push(line);
      if (line.trim() === "---" && i > 0) inFrontmatter = false;
      continue;
    }

    // Code fence toggle (``` or ~~~, optionally with language tag)
    if (/^(`{3,}|~{3,})/.test(line)) {
      inCodeBlock = !inCodeBlock;
      buf.push(line);
      continue;
    }

    // Only detect headings outside code blocks
    const headingMatch = !inCodeBlock && line.match(/^(#{1,6})\s+(.*)/);
    if (headingMatch) {
      sections.push({ heading: currentHeading, level: currentLevel, content: buf.join("\n") });
      buf = [line];
      currentHeading = line.trimEnd();
      currentLevel = headingMatch[1]!.length;
    } else {
      buf.push(line);
    }
  }
  if (buf.length > 0) {
    sections.push({ heading: currentHeading, level: currentLevel, content: buf.join("\n") });
  }
  return sections;
}

/** Build a TOC string from sections. Indented relative to the shallowest heading level. */
export function buildToc(sections: MarkdownSection[]): string {
  const headingSections = sections.filter(s => s.heading !== "");
  if (headingSections.length === 0) return "";
  const minLevel = Math.min(...headingSections.map(s => s.level));
  return headingSections
    .map(s => "  ".repeat(s.level - minLevel) + s.heading)
    .join("\n");
}

/** Find a section by heading text. Case-insensitive, partial match, `##` prefix optional. */
export function findSectionByHeading(sections: MarkdownSection[], query: string): MarkdownSection | undefined {
  const q = query.toLowerCase().replace(/^#{1,6}\s*/, "").trim();
  return sections.find(s =>
    s.heading.toLowerCase().replace(/^#{1,6}\s*/, "").trim().includes(q)
  );
}

// ── Wiki Class ────────────────────────────────────────────────────

export class Wiki {
  readonly config: WikiConfig;
  private readonly searchEngine: SearchEngine;
  /** Lazy cache of title→slug pairs for autoLink. Invalidated incrementally on write/delete. */
  private titleIndexCache: Array<{ title: string; slug: string }> | null = null;

  /**
   * @param root — path to config root (where .agent-wiki.yaml lives)
   * @param workspace — override workspace directory (all data: wiki/, raw/, schemas/).
   *                     If not set, falls back to: AGENT_WIKI_WORKSPACE env → config file → root.
   */
  constructor(root?: string, workspace?: string) {
    const resolvedRoot = resolve(root ?? ".");
    this.config = Wiki.loadConfig(resolvedRoot, workspace);
    this.searchEngine = new SearchEngine();
    this.searchEngine.setLoader(() => this.loadAllPages());
    this.searchEngine.setConfig(this.config.search);
    // Load persisted vector index if hybrid mode is enabled
    if (this.config.search.hybrid) {
      this.loadVectorIndex();
    }
  }

  /** Load and parse all wiki pages from disk. Used as search index loader. */
  private loadAllPages(): WikiPage[] {
    return this.listAllPages()
      .map((p) => this.read(p))
      .filter((p): p is WikiPage => p !== null);
  }

  // ── Init ──────────────────────────────────────────────────────

  /**
   * Initialize a new knowledge base.
   * @param path — config root (where .agent-wiki.yaml is created)
   * @param workspace — optional separate workspace directory for all data.
   *                     If set, wiki/, raw/, schemas/ go there instead of path.
   */
  static init(path: string, workspace?: string): Wiki {
    const configRoot = resolve(path);
    const wsRoot = workspace ? resolve(workspace) : configRoot;
    const wikiDir = join(wsRoot, "wiki");
    const rawDir = join(wsRoot, "raw");
    const schemasDir = join(wsRoot, "schemas");

    for (const dir of [configRoot, wsRoot, wikiDir, rawDir, schemasDir]) {
      mkdirSync(dir, { recursive: true });
    }

    const now = new Date().toISOString();
    const nowShort = now.replace("T", " ").slice(0, 16) + " UTC";

    // index.md
    writeFileSync(join(wikiDir, "index.md"), `---
title: Knowledge Base Index
type: index
created: "${now}"
updated: "${now}"
---

# Knowledge Base Index

## Categories

_No pages yet. Use your agent to add knowledge._

## Recent Updates

_No updates yet._
`);

    // log.md
    writeFileSync(join(wikiDir, "log.md"), `---
title: Operation Log
type: log
created: "${now}"
---

# Operation Log

| Time | Operation | Page | Summary |
|------|-----------|------|---------|
| ${nowShort} | init | — | Knowledge base initialized |
`);

    // timeline.md
    writeFileSync(join(wikiDir, "timeline.md"), `---
title: Knowledge Timeline
type: timeline
created: "${now}"
updated: "${now}"
---

# Knowledge Timeline

_Chronological view of all knowledge in this wiki._

## ${now.slice(0, 10)}

- **init** — Knowledge base created
`);

    // default config — include workspace if separate from config root
    const configData: Record<string, unknown> = {
      version: "2",
      wiki: {
        ...(workspace ? { workspace: wsRoot } : {}),
        path: "wiki/",
        raw_path: "raw/",
        schemas_path: "schemas/",
      },
      lint: {
        check_orphans: true,
        check_stale_days: 30,
        check_missing_sources: true,
        check_contradictions: true,
        check_integrity: true,
      },
    };
    writeFileSync(join(configRoot, ".agent-wiki.yaml"), yaml.dump(configData, { lineWidth: 100 }));

    // default schemas
    writeDefaultSchemas(schemasDir);

    // .gitignore in workspace (if separate, also add one there)
    writeFileSync(join(configRoot, ".gitignore"), "node_modules/\ndist/\n.env\n.lint-cache.json\n");
    if (workspace && wsRoot !== configRoot) {
      writeFileSync(join(wsRoot, ".gitignore"), "# Agent Wiki workspace data\n.lint-cache.json\n");
    }

    return new Wiki(configRoot, workspace);
  }

  // ── Config ────────────────────────────────────────────────────

  /**
   * Load config from .agent-wiki.yaml.
   * 
   * Workspace resolution priority:
   *   1. Explicit `workspaceOverride` parameter (from CLI --workspace)
   *   2. `AGENT_WIKI_WORKSPACE` environment variable
   *   3. `workspace` field in .agent-wiki.yaml (absolute, or relative to config file)
   *   4. Fall back to config root itself
   *
   * All data dirs (wiki/, raw/, schemas/) resolve relative to workspace.
   */
  static loadConfig(root: string, workspaceOverride?: string): WikiConfig {
    let raw: Record<string, unknown> = {};
    const configPath = join(root, ".agent-wiki.yaml");
    const homeConfigPath = join(process.env.HOME ?? "~", ".agent-wiki.yaml");

    if (existsSync(configPath)) {
      raw = (yaml.load(readFileSync(configPath, "utf-8")) as Record<string, unknown>) ?? {};
    } else if (existsSync(homeConfigPath)) {
      raw = (yaml.load(readFileSync(homeConfigPath, "utf-8")) as Record<string, unknown>) ?? {};
    }

    const wikiData = (raw.wiki ?? {}) as Record<string, string>;
    const lintData = (raw.lint ?? {}) as Record<string, unknown>;
    const securityData = (raw.security ?? {}) as Record<string, unknown>;
    const atlassianData = (raw.atlassian ?? {}) as Record<string, unknown>;
    const searchData = (raw.search ?? {}) as Record<string, unknown>;

    // Resolve workspace directory (priority: override > env > config > root)
    let workspace: string;
    if (workspaceOverride) {
      workspace = resolve(workspaceOverride);
    } else if (process.env.AGENT_WIKI_WORKSPACE) {
      workspace = resolve(process.env.AGENT_WIKI_WORKSPACE);
    } else if (wikiData.workspace) {
      // Relative paths in config resolve against the config file's directory
      workspace = resolve(root, wikiData.workspace);
    } else {
      workspace = root;
    }

    // Ensure workspace exists
    mkdirSync(workspace, { recursive: true });

    // Resolve allowed source directories for rawAdd sourcePath.
    // Default: only the workspace itself. Config can widen to explicit dirs.
    const configuredDirs = securityData.allowed_source_dirs as string[] | undefined;
    const allowedSourceDirs: string[] = Array.isArray(configuredDirs)
      ? configuredDirs.map(d => resolve(root, d))   // relative to config root
      : [workspace];                                  // secure default

    return {
      configRoot: root,
      workspace,
      wikiDir: join(workspace, wikiData.path ?? "wiki"),
      rawDir: join(workspace, wikiData.raw_path ?? "raw"),
      schemasDir: join(workspace, wikiData.schemas_path ?? "schemas"),
      lint: {
        checkOrphans: (lintData.check_orphans as boolean) ?? true,
        checkStaleDays: (lintData.check_stale_days as number) ?? 30,
        checkMissingSources: (lintData.check_missing_sources as boolean) ?? true,
        checkContradictions: (lintData.check_contradictions as boolean) ?? true,
        checkIntegrity: (lintData.check_integrity as boolean) ?? true,
      },
      allowedSourceDirs,
      atlassian: {
        allowedHosts: Array.isArray(atlassianData.allowed_hosts) ? atlassianData.allowed_hosts as string[] : [],
        maxPages: (atlassianData.max_pages as number) ?? 100,
        maxAttachmentSize: (atlassianData.max_attachment_size as number) ?? 10 * 1024 * 1024,
      },
      search: {
        hybrid: (searchData.hybrid as boolean) ?? DEFAULT_SEARCH_CONFIG.hybrid,
        bm25Weight: (searchData.bm25_weight as number) ?? DEFAULT_SEARCH_CONFIG.bm25Weight,
        vectorWeight: (searchData.vector_weight as number) ?? DEFAULT_SEARCH_CONFIG.vectorWeight,
        model: (searchData.model as string) ?? DEFAULT_SEARCH_CONFIG.model,
      },
    };
  }

  // ═══════════════════════════════════════════════════════════════
  //  RAW LAYER — Immutable source documents
  // ═══════════════════════════════════════════════════════════════

  /** Register a raw document. Copies file to raw/ with metadata sidecar.
   *  If content is provided as string, writes it directly.
   *  If sourcePath is an existing file, copies it.
   *  Raw files are IMMUTABLE — re-adding the same path is an error. */
  rawAdd(
    filename: string,
    opts: {
      content?: string;
      sourcePath?: string;
      sourceUrl?: string;
      description?: string;
      tags?: string[];
      mimeType?: string;
      autoVersion?: boolean;
      pattern?: string;
    }
  ): RawDocument | RawDocument[] {
    // ── Directory detection: if sourcePath is a directory, import all files ──
    if (opts.sourcePath) {
      const resolvedSource = resolve(opts.sourcePath);
      this._validateSourcePath(resolvedSource, opts.sourcePath);
      if (existsSync(resolvedSource) && statSync(resolvedSource).isDirectory()) {
        return this._rawAddDirectory(filename, resolvedSource, opts);
      }
    }

    // ── Single file path ──
    return this._rawAddSingleFile(filename, opts);
  }

  /**
   * Validate that a sourcePath is within allowed directories.
   */
  private _validateSourcePath(resolvedSource: string, originalPath: string): void {
    const allowed = this.config.allowedSourceDirs.some(
      dir => resolvedSource.startsWith(resolve(dir) + "/") || resolvedSource === resolve(dir)
    );
    if (!allowed) {
      throw new Error(
        `sourcePath "${originalPath}" is outside allowed directories. ` +
        `Allowed: [${this.config.allowedSourceDirs.join(", ")}]. ` +
        `Configure security.allowed_source_dirs in .agent-wiki.yaml to widen access.`
      );
    }
  }

  /**
   * Import all files from a directory into raw/<filename>/.
   * Preserves subdirectory structure. Optionally filters by glob pattern.
   */
  private _rawAddDirectory(
    prefix: string,
    dirPath: string,
    opts: {
      sourceUrl?: string;
      description?: string;
      tags?: string[];
      autoVersion?: boolean;
      pattern?: string;
    }
  ): RawDocument[] {
    const files = this._walkDirectory(dirPath, dirPath);

    // Filter by pattern (simple glob: *.html, *.xlsx, etc.)
    const filtered = opts.pattern
      ? files.filter(f => matchSimpleGlob(f, opts.pattern!))
      : files;

    if (filtered.length === 0) {
      throw new Error(
        `No files found in directory "${dirPath}"` +
        (opts.pattern ? ` matching pattern "${opts.pattern}"` : "")
      );
    }

    const docs: RawDocument[] = [];
    for (const relFile of filtered) {
      const targetFilename = join(prefix, relFile);
      const srcFile = join(dirPath, relFile);
      const doc = this._rawAddSingleFile(targetFilename, {
        sourcePath: srcFile,
        sourceUrl: opts.sourceUrl,
        description: opts.description,
        tags: opts.tags,
        autoVersion: opts.autoVersion,
      });
      docs.push(doc);
    }

    this.log("raw-add-dir", prefix, `Imported directory: ${docs.length} files into raw/${prefix}/`);
    return docs;
  }

  /**
   * Walk a directory recursively, returning relative file paths.
   */
  private _walkDirectory(dir: string, root: string): string[] {
    const result: string[] = [];
    if (!existsSync(dir)) return result;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        result.push(...this._walkDirectory(full, root));
      } else {
        result.push(relative(root, full));
      }
    }
    return result.sort();
  }

  /**
   * Add a single file to raw/. Core logic extracted from rawAdd.
   */
  private _rawAddSingleFile(
    filename: string,
    opts: {
      content?: string;
      sourcePath?: string;
      sourceUrl?: string;
      description?: string;
      tags?: string[];
      mimeType?: string;
      autoVersion?: boolean;
    }
  ): RawDocument {
    let actualFilename = filename;

    // Auto-version: if file exists and autoVersion is true, find next version
    if (opts.autoVersion && existsSync(safePath(this.config.rawDir, filename))) {
      actualFilename = this.nextVersionFilename(filename);
    }

    const rawPath = safePath(this.config.rawDir, actualFilename);
    const metaPath = rawPath + ".meta.yaml";

    // Immutability guard — never overwrite existing raw files
    if (existsSync(rawPath)) {
      throw new Error(`Raw file already exists: ${actualFilename}. Raw files are immutable.`);
    }

    mkdirSync(dirname(rawPath), { recursive: true });

    // Write content
    if (opts.content !== undefined) {
      writeFileSync(rawPath, opts.content);
    } else if (opts.sourcePath) {
      // Security: restrict sourcePath to allowed directories BEFORE any filesystem access
      const resolvedSource = resolve(opts.sourcePath);
      this._validateSourcePath(resolvedSource, opts.sourcePath);
      if (!existsSync(resolvedSource)) {
        throw new Error("Either content or a valid sourcePath is required");
      }
      copyFileSync(resolvedSource, rawPath);
    } else {
      throw new Error("Either content or a valid sourcePath is required");
    }

    // Compute hash and size
    const buf = readFileSync(rawPath);
    const sha256 = createHash("sha256").update(buf).digest("hex");
    const size = buf.length;

    const now = new Date().toISOString();
    const doc: RawDocument = {
      path: actualFilename,
      sourceUrl: opts.sourceUrl,
      downloadedAt: now,
      sha256,
      size,
      mimeType: opts.mimeType ?? guessMime(filename),
      description: opts.description,
      tags: opts.tags,
    };

    // Write metadata sidecar
    writeFileSync(metaPath, yaml.dump(doc, { lineWidth: 100 }));

    this.log("raw-add", actualFilename, `Added raw: ${actualFilename} (${formatBytes(size)}, sha256:${sha256.slice(0, 12)}...)`);
    return doc;
  }

  /**
   * Compute the next versioned filename for auto-versioning.
   * report.xlsx → report_v2.xlsx, report_v2.xlsx → report_v3.xlsx, etc.
   */
  nextVersionFilename(filename: string): string {
    const ext = extname(filename);
    const base = filename.slice(0, filename.length - ext.length);

    // Strip existing _vN suffix to find the root name
    const vMatch = base.match(/^(.+?)(_v(\d+))?$/);
    const root = vMatch?.[1] ?? base;

    // Scan existing files to find highest version
    let maxVersion = 1; // original file counts as v1
    if (!existsSync(this.config.rawDir)) return `${root}_v2${ext}`;

    for (const file of listAllFiles(this.config.rawDir, this.config.rawDir)) {
      if (file.endsWith(".meta.yaml")) continue;
      const fExt = extname(file);
      const fBase = file.slice(0, file.length - fExt.length);
      if (fExt !== ext) continue;

      // Check if this file matches root or root_vN pattern
      if (fBase === root) {
        maxVersion = Math.max(maxVersion, 1);
      } else {
        const m = fBase.match(new RegExp(`^${root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}_v(\\d+)$`));
        if (m) {
          maxVersion = Math.max(maxVersion, parseInt(m[1]!, 10));
        }
      }
    }

    return `${root}_v${maxVersion + 1}${ext}`;
  }

  /**
   * Write a parsed artifact under raw/parsed/. Unlike rawAdd, these are
   * idempotent — re-parsing the same source overwrites the previous output.
   * A .meta.yaml sidecar is written so lint/integrity checks pass.
   */
  rawAddParsedArtifact(relativePath: string, content: string, opts?: { mimeType?: string; description?: string }): void {
    const fullPath = safePath(this.config.rawDir, relativePath);
    mkdirSync(dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, content, "utf-8");

    const buf = Buffer.from(content, "utf-8");
    const sha256 = createHash("sha256").update(buf).digest("hex");
    const doc: RawDocument = {
      path: relativePath,
      downloadedAt: new Date().toISOString(),
      sha256,
      size: buf.length,
      mimeType: opts?.mimeType ?? "application/json",
      description: opts?.description ?? "Parsed artifact generated by code_parse",
    };
    writeFileSync(fullPath + ".meta.yaml", yaml.dump(doc, { lineWidth: 100 }));
  }

  /**
   * List all versions of a raw file, sorted by version number, with the latest marked.
   * rawVersions("report.xlsx") → { versions: [...], latest: "report_v3.xlsx" }
   */
  rawVersions(filename: string): { versions: Array<{ path: string; version: number; downloadedAt: string; size: number; sha256: string }>; latest: string | null } {
    const ext = extname(filename);
    const base = filename.slice(0, filename.length - ext.length);
    const vMatch = base.match(/^(.+?)(_v(\d+))?$/);
    const root = vMatch?.[1] ?? base;

    const versions: Array<{ path: string; version: number; downloadedAt: string; size: number; sha256: string }> = [];

    if (!existsSync(this.config.rawDir)) return { versions, latest: null };

    for (const file of listAllFiles(this.config.rawDir, this.config.rawDir)) {
      if (file.endsWith(".meta.yaml")) continue;
      const fExt = extname(file);
      const fBase = file.slice(0, file.length - fExt.length);
      if (fExt !== ext) continue;

      let version = -1;
      if (fBase === root) {
        version = 1;
      } else {
        const m = fBase.match(new RegExp(`^${root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}_v(\\d+)$`));
        if (m) version = parseInt(m[1]!, 10);
      }

      if (version < 0) continue;

      const metaPath = join(this.config.rawDir, file) + ".meta.yaml";
      if (existsSync(metaPath)) {
        const meta = yaml.load(readFileSync(metaPath, "utf-8")) as RawDocument;
        versions.push({ path: meta.path, version, downloadedAt: meta.downloadedAt, size: meta.size, sha256: meta.sha256 });
      } else {
        const fullPath = join(this.config.rawDir, file);
        const buf = readFileSync(fullPath);
        versions.push({
          path: file,
          version,
          downloadedAt: statSync(fullPath).mtime.toISOString(),
          size: buf.length,
          sha256: createHash("sha256").update(buf).digest("hex"),
        });
      }
    }

    versions.sort((a, b) => a.version - b.version);
    const latest = versions.length > 0 ? versions[versions.length - 1]!.path : null;
    return { versions, latest };
  }

  /** List all raw documents with metadata. */
  rawList(): RawDocument[] {
    if (!existsSync(this.config.rawDir)) return [];

    const docs: RawDocument[] = [];
    for (const file of listAllFiles(this.config.rawDir, this.config.rawDir)) {
      if (file.endsWith(".meta.yaml")) continue; // skip sidecars
      const metaPath = join(this.config.rawDir, file) + ".meta.yaml";
      if (existsSync(metaPath)) {
        const meta = yaml.load(readFileSync(metaPath, "utf-8")) as RawDocument;
        docs.push(meta);
      } else {
        // raw file without metadata — create minimal entry
        const fullPath = join(this.config.rawDir, file);
        const buf = readFileSync(fullPath);
        docs.push({
          path: file,
          downloadedAt: statSync(fullPath).mtime.toISOString(),
          sha256: createHash("sha256").update(buf).digest("hex"),
          size: buf.length,
          mimeType: guessMime(file),
        });
      }
    }
    return docs;
  }

  /** Read a raw document's content and metadata.
   *  Text/SVG/JSON/XML files return content as UTF-8 string.
   *  Document files (PDF, DOCX, XLSX, PPTX) are extracted via Node.js libraries.
   *  For PDFs, optional `pages` parameter limits extraction to specific pages (e.g. "1-5").
   *  Image files (PNG, JPEG, GIF, WEBP, etc.) return base64-encoded data for display.
   *  Other binary files return metadata only. */
  async rawRead(filename: string, opts?: { pages?: string; sheet?: string; offset?: number; limit?: number }): Promise<{
    content: string | null;
    meta: RawDocument | null;
    binary: boolean;
    note?: string;
    imageData?: { data: string; mimeType: string };
    paginationMeta?: {
      total_lines?: number; offset?: number; lines_returned?: number; truncated?: boolean; next_offset?: number | null;
      sheet_names?: string[]; total_sheets?: number; current_sheet?: string;
      total_slides?: number; total_pages?: number;
    };
  } | null> {
    const fullPath = safePath(this.config.rawDir, filename);
    if (!existsSync(fullPath)) return null;

    const metaPath = fullPath + ".meta.yaml";
    const meta = existsSync(metaPath)
      ? (yaml.load(readFileSync(metaPath, "utf-8")) as RawDocument)
      : null;

    const mime = meta?.mimeType ?? guessMime(filename);
    const isText = mime.startsWith("text/")
      || mime === "application/json"
      || mime === "application/xml"
      || mime === "application/sql"
      || mime === "application/rtf"
      || mime === "application/x-yaml"
      || mime === "image/svg+xml";           // SVG is XML text

    if (isText) {
      const raw = readFileSync(fullPath, "utf-8");
      if (opts?.offset !== undefined || opts?.limit !== undefined) {
        const lines = raw.split("\n");
        const total_lines = lines.length;
        const offset = Math.max(0, opts.offset ?? 0);
        const limit = Math.min(500, Math.max(1, opts.limit ?? 200));
        const slice = lines.slice(offset, offset + limit);
        const truncated = offset + limit < total_lines;
        return {
          content: slice.join("\n"), meta, binary: false,
          paginationMeta: { total_lines, offset, lines_returned: slice.length, truncated, next_offset: truncated ? offset + limit : null },
        };
      }
      return { content: raw, meta, binary: false };
    }

    // Document formats — extract text via Node.js libraries
    const ext = extname(filename).toLowerCase();
    const extractable = new Set([".pdf", ".docx", ".xlsx", ".pptx", ".html", ".htm"]);
    if (extractable.has(ext)) {
      try {
        if (ext === ".xlsx") {
          const result = await extractDocument(fullPath, undefined, opts?.sheet);
          const sheetNames = result.metadata?.sheetNames ?? [];
          const content = result.segments.map(s => `--- Sheet: ${s.source.sheet} ---\n${s.text}`).join("\n\n");
          return {
            content: content || "(no content)",
            meta, binary: false,
            paginationMeta: { sheet_names: sheetNames, total_sheets: sheetNames.length, current_sheet: opts?.sheet },
          };
        }
        if (ext === ".pptx") {
          const result = await extractDocument(fullPath, opts?.pages);
          const totalSlides = result.metadata?.totalSlides;
          const content = result.segments.map(s => `--- Slide ${s.source.slide} ---\n${s.text}`).join("\n\n");
          return {
            content: content || "(no content)",
            meta, binary: false,
            paginationMeta: { total_slides: totalSlides },
          };
        }
        // PDF — use extractDocument to get totalPages metadata
        if (ext === ".pdf") {
          const result = await extractDocument(fullPath, opts?.pages);
          const totalPages = result.metadata?.totalPages;
          if (result.segments.length === 0 && opts?.pages) {
            return {
              content: `(no pages matched range "${opts.pages}" — PDF has ${totalPages ?? "?"} pages)`,
              meta, binary: false,
            };
          }
          const prefix = opts?.pages ? `[Pages ${opts.pages} of ${totalPages ?? "?"}]\n` : "";
          const body = result.segments.map(s => s.text).join("\n\n");
          return {
            content: prefix + body,
            meta, binary: false,
            ...(opts?.pages ? { paginationMeta: { total_pages: totalPages } } : {}),
          };
        }
        // DOCX / HTML — flat text extraction with optional line-based pagination
        const text = await extractText(fullPath);
        if (opts?.offset !== undefined || opts?.limit !== undefined) {
          const lines = text.split("\n");
          const total_lines = lines.length;
          const offset = Math.max(0, opts.offset ?? 0);
          const limit = Math.min(500, Math.max(1, opts.limit ?? 200));
          const slice = lines.slice(offset, offset + limit);
          const truncated = offset + limit < total_lines;
          return {
            content: slice.join("\n"), meta, binary: false,
            paginationMeta: { total_lines, offset, lines_returned: slice.length, truncated, next_offset: truncated ? offset + limit : null },
          };
        }
        return { content: text, meta, binary: false };
      } catch (e: any) {
        const stat = statSync(fullPath);
        return {
          content: null, meta, binary: true,
          note: `Text extraction failed: ${e.message}. File size: ${formatBytes(stat.size)}.`,
        };
      }
    }

    // Image files — return base64-encoded data for display (max 10MB)
    const isImage = mime.startsWith("image/") && mime !== "image/svg+xml";
    if (isImage) {
      const stat = statSync(fullPath);
      const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
      if (stat.size <= MAX_IMAGE_BYTES) {
        const data = readFileSync(fullPath).toString("base64");
        return { content: null, meta, binary: true, imageData: { data, mimeType: mime } };
      }
      return {
        content: null, meta, binary: true,
        note: `Image too large to display (${formatBytes(stat.size)}). Maximum supported size is 10 MB.`,
      };
    }

    // Other binary files — metadata only
    return { content: null, meta, binary: true };
  }

  /** Verify integrity of all raw files against their stored hashes.
   *  When a `cache` is provided, files whose mtime+size haven't changed
   *  since the last check are skipped (cache hit). Cache entries are
   *  updated in-place for misses; the caller persists the cache. */
  rawVerify(cache?: LintCache | null): Array<{ path: string; status: "ok" | "corrupted" | "missing-meta" }> {
    const results: Array<{ path: string; status: "ok" | "corrupted" | "missing-meta" }> = [];
    if (!existsSync(this.config.rawDir)) return results;

    for (const file of listAllFiles(this.config.rawDir, this.config.rawDir)) {
      if (file.endsWith(".meta.yaml")) continue;
      const fullPath = join(this.config.rawDir, file);
      const metaPath = fullPath + ".meta.yaml";

      if (!existsSync(metaPath)) {
        results.push({ path: file, status: "missing-meta" });
        continue;
      }

      // Stat both files (cheap metadata-only I/O)
      const fileStat = statSync(fullPath);
      const metaStat = statSync(metaPath);

      // Cache hit — mtime+size of both file and sidecar unchanged
      const cached = cache?.entries[file];
      if (
        cached &&
        cached.fileMtimeMs === fileStat.mtimeMs &&
        cached.fileSize === fileStat.size &&
        cached.metaMtimeMs === metaStat.mtimeMs
      ) {
        results.push({ path: file, status: cached.status });
        continue;
      }

      // Cache miss — full hash computation
      const meta = yaml.load(readFileSync(metaPath, "utf-8")) as RawDocument;
      const buf = readFileSync(fullPath);
      const actualHash = createHash("sha256").update(buf).digest("hex");
      const status = actualHash === meta.sha256 ? "ok" : "corrupted";
      results.push({ path: file, status });

      // Update cache entry in-place
      if (cache) {
        cache.entries[file] = {
          fileMtimeMs: fileStat.mtimeMs,
          fileSize: fileStat.size,
          metaMtimeMs: metaStat.mtimeMs,
          status,
        };
      }
    }
    return results;
  }

  private loadLintCache(): LintCache | null {
    const cachePath = join(this.config.workspace, ".lint-cache.json");
    if (!existsSync(cachePath)) return null;
    try {
      const raw = JSON.parse(readFileSync(cachePath, "utf-8"));
      if (raw?.version !== 1) return null;
      return raw as LintCache;
    } catch {
      return null;
    }
  }

  private saveLintCache(cache: LintCache): void {
    writeFileSync(join(this.config.workspace, ".lint-cache.json"), JSON.stringify(cache));
  }

  /**
   * Fetch a file from a URL and save it to raw/.
   * Supports arXiv smart resolution: arxiv.org/abs/XXXX → arxiv.org/pdf/XXXX.pdf
   * Returns the RawDocument metadata.
   */
  async rawFetch(
    url: string,
    opts: {
      filename?: string;
      description?: string;
      tags?: string[];
    } = {}
  ): Promise<RawDocument> {
    // ── arXiv smart URL resolution ──
    let resolvedUrl = url;
    let inferredFilename = opts.filename;

    const arxivAbsMatch = url.match(/arxiv\.org\/abs\/(\d+\.\d+)(v\d+)?/);
    const arxivPdfMatch = url.match(/arxiv\.org\/pdf\/(\d+\.\d+)(v\d+)?/);

    if (arxivAbsMatch) {
      const id = arxivAbsMatch[1]! + (arxivAbsMatch[2] ?? "");
      resolvedUrl = `https://arxiv.org/pdf/${id}.pdf`;
      if (!inferredFilename) inferredFilename = `arxiv-${id.replace(/\./g, "-")}.pdf`;
    } else if (arxivPdfMatch && !inferredFilename) {
      const id = arxivPdfMatch[1]! + (arxivPdfMatch[2] ?? "");
      inferredFilename = `arxiv-${id.replace(/\./g, "-")}.pdf`;
    }

    // ── Infer filename from URL if not provided ──
    if (!inferredFilename) {
      const urlObj = new URL(resolvedUrl);
      const pathParts = urlObj.pathname.split("/").filter(Boolean);
      const lastPart = pathParts[pathParts.length - 1] ?? "download";
      // Clean up query params and fragments
      inferredFilename = lastPart.split("?")[0]!.split("#")[0]!;
      // If no extension, try to add one based on content-type later
      if (!inferredFilename.includes(".")) {
        inferredFilename += ".bin";
      }
    }

    // ── Immutability guard ──
    const rawPath = safePath(this.config.rawDir, inferredFilename);
    if (existsSync(rawPath)) {
      throw new Error(`Raw file already exists: ${inferredFilename}. Raw files are immutable.`);
    }

    mkdirSync(dirname(rawPath), { recursive: true });

    // ── Download ──
    const response = await fetch(resolvedUrl, {
      headers: {
        "User-Agent": `agent-wiki/${VERSION}`,
      },
      redirect: "follow",
    });

    if (!response.ok) {
      throw new Error(`Download failed: HTTP ${response.status} ${response.statusText} — ${resolvedUrl}`);
    }

    // Update filename extension based on content-type if it was generic
    const contentType = response.headers.get("content-type") ?? "";
    if (inferredFilename.endsWith(".bin")) {
      const extMap: Record<string, string> = {
        // Text
        "text/html": ".html",
        "text/plain": ".txt",
        "text/markdown": ".md",
        "text/csv": ".csv",
        "text/xml": ".xml",
        "text/css": ".css",
        "text/javascript": ".js",
        // Application — documents
        "application/pdf": ".pdf",
        "application/json": ".json",
        "application/xml": ".xml",
        "application/rtf": ".rtf",
        "application/epub+zip": ".epub",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
        "application/vnd.openxmlformats-officedocument.presentationml.presentation": ".pptx",
        "application/msword": ".doc",
        "application/vnd.ms-excel": ".xls",
        "application/vnd.ms-powerpoint": ".ppt",
        // Application — archives
        "application/zip": ".zip",
        "application/gzip": ".gz",
        "application/x-tar": ".tar",
        "application/x-7z-compressed": ".7z",
        "application/x-rar-compressed": ".rar",
        // Images
        "image/png": ".png",
        "image/jpeg": ".jpg",
        "image/gif": ".gif",
        "image/svg+xml": ".svg",
        "image/webp": ".webp",
        "image/avif": ".avif",
        "image/bmp": ".bmp",
        "image/tiff": ".tiff",
        // Audio
        "audio/mpeg": ".mp3",
        "audio/wav": ".wav",
        "audio/ogg": ".ogg",
        "audio/flac": ".flac",
        "audio/aac": ".aac",
        // Video
        "video/mp4": ".mp4",
        "video/webm": ".webm",
        "video/x-matroska": ".mkv",
        "video/quicktime": ".mov",
        // Data / other
        "application/wasm": ".wasm",
        "application/x-sqlite3": ".sqlite",
        "application/sql": ".sql",
        "application/x-yaml": ".yaml",
      };
      for (const [mime, ext] of Object.entries(extMap)) {
        if (contentType.includes(mime)) {
          inferredFilename = inferredFilename.replace(/\.bin$/, ext);
          break;
        }
      }
    }

    // Re-check with potentially updated filename
    const finalPath = safePath(this.config.rawDir, inferredFilename);
    if (finalPath !== rawPath && existsSync(finalPath)) {
      throw new Error(`Raw file already exists: ${inferredFilename}. Raw files are immutable.`);
    }

    // Stream to file
    const body = response.body;
    if (!body) throw new Error("Empty response body");

    const nodeStream = Readable.fromWeb(body as any);
    const fileStream = createWriteStream(finalPath);
    await pipeline(nodeStream, fileStream);

    // ── Compute hash and create metadata ──
    const buf = readFileSync(finalPath);
    const sha256 = createHash("sha256").update(buf).digest("hex");
    const now = new Date().toISOString();

    const mime = contentType.split(";")[0]?.trim() || guessMime(inferredFilename);

    const doc: RawDocument = {
      path: inferredFilename,
      sourceUrl: url, // original URL, not resolved
      downloadedAt: now,
      sha256,
      size: buf.length,
      mimeType: mime,
      description: opts.description,
      tags: opts.tags,
    };

    // Write metadata sidecar
    writeFileSync(finalPath + ".meta.yaml", yaml.dump(doc, { lineWidth: 100 }));
    this.log("raw-fetch", inferredFilename,
      `Downloaded from ${url} (${formatBytes(buf.length)}, ${mime})`);

    return doc;
  }

  // ═══════════════════════════════════════════════════════════════
  //  ATLASSIAN — Confluence & Jira import
  // ═══════════════════════════════════════════════════════════════

  /** Import a Confluence page (and optionally all child pages) into raw/. */
  async confluenceImport(
    url: string,
    opts: { recursive?: boolean; depth?: number; authEnv?: string } = {}
  ): Promise<ConfluenceImportResult> {
    const { confluenceImport: doImport } = await import("./atlassian.js");
    const result = await doImport(url, this.config.rawDir, this.config.atlassian, opts);
    this.log(
      "confluence-import",
      `confluence/${result.tree.file}`,
      `Imported ${result.pages} page(s) from Confluence`
    );
    return result;
  }

  /** Import a Jira issue (with comments, attachments, linked issues) into raw/. */
  async jiraImport(
    url: string,
    opts: {
      includeComments?: boolean;
      includeAttachments?: boolean;
      includeLinks?: boolean;
      linkDepth?: number;
      authEnv?: string;
    } = {}
  ): Promise<JiraImportResult> {
    const { jiraImport: doImport } = await import("./atlassian.js");
    const result = await doImport(url, this.config.rawDir, this.config.atlassian, opts);
    this.log(
      "jira-import",
      result.issueKey,
      `Imported ${result.importedCount} issue(s), ${result.files.length} file(s)`
    );
    return result;
  }

  // ═══════════════════════════════════════════════════════════════
  //  WIKI LAYER — Mutable compiled knowledge
  // ═══════════════════════════════════════════════════════════════

  // ── CRUD ──────────────────────────────────────────────────────

  /** Read a wiki page. Returns null if not found. */
  read(pagePath: string): WikiPage | null {
    const fullPath = safePath(this.config.wikiDir, pagePath);
    if (!existsSync(fullPath)) {
      const withMd = fullPath.endsWith(".md") ? fullPath : fullPath + ".md";
      // withMd is derived from already-validated fullPath, so no re-check needed
      if (!existsSync(withMd)) return null;
      return this.parsePage(relative(this.config.wikiDir, withMd), readFileSync(withMd, "utf-8"));
    }
    return this.parsePage(pagePath, readFileSync(fullPath, "utf-8"));
  }

  /** Write (create or update) a wiki page. Content must include frontmatter.
   *  Automatically injects/updates created and updated timestamps. */
  write(pagePath: string, content: string, source?: string): void {
    // Guard: nested */index.md paths are reserved for auto-generated directory indexes
    if (isSystemPage(pagePath) && !SYSTEM_PAGES.has(pagePath)) {
      throw new Error(`Cannot write to reserved path: ${pagePath}. Nested */index.md is auto-generated by wiki_rebuild.`);
    }

    const fullPath = safePath(this.config.wikiDir, pagePath);
    const dir = dirname(fullPath);
    mkdirSync(dir, { recursive: true });

    const now = new Date().toISOString();

    // Parse incoming content to inject timestamps
    const parsed = matter(content);
    if (!parsed.data.created) {
      // Check if page already exists — preserve original created time
      if (existsSync(fullPath)) {
        const existing = matter(readFileSync(fullPath, "utf-8"));
        const ec = existing.data.created;
        parsed.data.created = ec instanceof Date ? ec.toISOString() : (ec as string) ?? now;
      } else {
        parsed.data.created = now;
      }
    }
    parsed.data.updated = now;

    // Reconstruct content with updated frontmatter
    const finalContent = matter.stringify(parsed.content, parsed.data);
    writeFileSync(fullPath, finalContent.trimEnd() + "\n");

    this.searchEngine.invalidate();

    // Incrementally update the title index cache (avoid full rebuild on next autoLink)
    if (this.titleIndexCache !== null) {
      const slug = basename(pagePath, ".md");
      const title = ((parsed.data.title as string) ?? slug.replace(/-/g, " ")).trim();
      const idx = this.titleIndexCache.findIndex(c => c.slug === slug);
      if (idx !== -1) this.titleIndexCache.splice(idx, 1);
      if (title.length >= 4 && !isSystemPage(pagePath)) {
        // Insert at the correct sorted position (longest-first)
        let insertAt = this.titleIndexCache.findIndex(c => c.title.length <= title.length);
        if (insertAt === -1) insertAt = this.titleIndexCache.length;
        this.titleIndexCache.splice(insertAt, 0, { title, slug });
      }
    }

    this.log("write", pagePath, `Wrote ${pagePath}${source ? ` (${source})` : ""}`);
  }

  /** Resolve page path to the correct topic subdirectory.
   *  If the path already has a subdirectory, returns as-is.
   *  Otherwise, routes based on: (1) explicit `topic` frontmatter field,
   *  (2) tag/title matching against existing nested directories (deepest match wins). */
  resolvePagePath(pagePath: string, content: string): string {
    // Already in a subdirectory? Use as-is.
    if (pagePath.includes("/")) return pagePath;

    // No existing dirs → nothing to route to
    const allDirs = this.listAllDirPaths();
    if (allDirs.length === 0) return pagePath;

    const parsed = matter(content);

    // 1. Explicit `topic` frontmatter field
    const explicitTopic = parsed.data.topic as string | undefined;
    if (explicitTopic && typeof explicitTopic === "string") {
      const normalized = explicitTopic.toLowerCase().replace(/\s+/g, "-");
      // Exact path match first (e.g. topic: "lang/js")
      if (allDirs.includes(normalized)) {
        return `${normalized}/${pagePath}`;
      }
      // Match against last segment of each dir, prefer deepest
      const match = allDirs
        .filter((d) => d.split("/").pop()!.toLowerCase() === normalized)
        .sort((a, b) => b.split("/").length - a.split("/").length)[0];
      if (match) {
        return `${match}/${pagePath}`;
      }
      // Fallback: create new directory at root
      return `${normalized}/${pagePath}`;
    }

    // 2. Match tags/title against directory names (deepest match wins)
    const classification = this.classify(content);
    const title = ((parsed.data.title as string) ?? "").toLowerCase();
    const signals = [
      ...classification.tags.map((t) => t.toLowerCase()),
      ...title.split(/[\s\-_]+/).filter(Boolean),
    ];

    // Sort dirs by depth (deepest first) so we prefer more specific matches
    const sortedDirs = [...allDirs].sort(
      (a, b) => b.split("/").length - a.split("/").length
    );

    for (const dirPath of sortedDirs) {
      const dirName = dirPath.split("/").pop()!.toLowerCase();
      if (signals.some((s) => s === dirName || s.includes(dirName) || dirName.includes(s))) {
        return `${dirPath}/${pagePath}`;
      }
    }

    return pagePath;
  }

  /** List existing topic subdirectories under wiki/ (first-level only). */
  listTopicDirs(): string[] {
    const dir = this.config.wikiDir;
    if (!existsSync(dir)) return [];
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith("."))
      .map((e) => e.name)
      .sort();
  }

  /** List all directory paths recursively under wiki/ (relative, e.g. "lang", "lang/js"). */
  listAllDirPaths(): string[] {
    const result: string[] = [];
    const walk = (dir: string, prefix: string) => {
      if (!existsSync(dir)) return;
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory() && !entry.name.startsWith(".")) {
          const relPath = prefix ? `${prefix}/${entry.name}` : entry.name;
          result.push(relPath);
          walk(join(dir, entry.name), relPath);
        }
      }
    };
    walk(this.config.wikiDir, "");
    return result.sort();
  }

  /** Delete a wiki page. Returns true if it existed. */
  delete(pagePath: string): boolean {
    // Guard: never delete system pages
    if (isSystemPage(pagePath)) {
      throw new Error(`Cannot delete system page: ${pagePath}`);
    }
    const fullPath = safePath(this.config.wikiDir, pagePath);
    if (!existsSync(fullPath)) return false;
    unlinkSync(fullPath);
    this.searchEngine.invalidate();

    // Remove from title index cache
    if (this.titleIndexCache !== null) {
      const slug = basename(pagePath, ".md");
      const idx = this.titleIndexCache.findIndex(c => c.slug === slug);
      if (idx !== -1) this.titleIndexCache.splice(idx, 1);
    }

    this.log("delete", pagePath, `Deleted ${pagePath}`);
    return true;
  }

  /** List all wiki pages, optionally filtered by type or tag. */
  list(filterType?: string, filterTag?: string): string[] {
    const pages = this.listAllPages();
    if (!filterType && !filterTag) return pages;

    return pages.filter((p) => {
      const page = this.read(p);
      if (!page) return false;
      if (filterType && page.type !== filterType) return false;
      if (filterTag && !page.tags.includes(filterTag)) return false;
      return true;
    });
  }

  // ── Search ────────────────────────────────────────────────────

  /** BM25 search across all wiki pages (synchronous, pure BM25).
   *  Index is built lazily on first search and cached until invalidated by write/delete. */
  search(query: string, limit = 10): SearchResult[] {
    return this.searchEngine.search(query, limit);
  }

  /** Hybrid BM25+vector search (async).
   *  When `config.search.hybrid` is true, re-ranks BM25 candidates using vector
   *  cosine similarity. Falls back to pure BM25 if embeddings are unavailable. */
  async searchHybrid(query: string, limit = 10): Promise<SearchResult[]> {
    return this.searchEngine.searchHybrid(query, limit);
  }

  // ── Vector index persistence (hybrid search) ─────────────────

  /** Path where the vector index is persisted. */
  get vectorIndexPath(): string {
    return join(this.config.wikiDir, ".search-vectors.json");
  }

  /** Load the persisted vector index from disk into the search engine.
   *  No-op if the file doesn't exist. */
  loadVectorIndex(): void {
    const p = this.vectorIndexPath;
    if (!existsSync(p)) return;
    try {
      const raw = JSON.parse(readFileSync(p, "utf-8")) as {
        model?: string;
        vectors?: Record<string, number[]>;
      };
      if (raw.model !== this.config.search.model) return; // stale model — discard
      const map = new Map<string, number[]>();
      for (const [path, vec] of Object.entries(raw.vectors ?? {})) {
        if (Array.isArray(vec)) map.set(path, vec);
      }
      this.searchEngine.setVectors(map);
    } catch {
      // Corrupted index — ignore, will be rebuilt on next write/rebuild
    }
  }

  /** Persist the current in-memory vector index to disk. */
  saveVectorIndex(): void {
    const vectors: Record<string, number[]> = {};
    for (const [path, vec] of this.searchEngine.getVectors()) {
      vectors[path] = vec;
    }
    const p = this.vectorIndexPath;
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify({ model: this.config.search.model, vectors }, null, 0));
  }

  /** Compute and store the embedding for a single wiki page.
   *  Intended to be called by the server after wiki_write when hybrid mode is on. */
  async updatePageVector(pagePath: string): Promise<void> {
    const page = this.read(pagePath);
    if (!page) return;
    const text = `${page.title} ${page.tags.join(" ")} ${page.content}`.slice(0, 2000);
    const embedding = await this.searchEngine.embedText(text);
    this.searchEngine.updateVector(pagePath, embedding);
    this.saveVectorIndex();
  }

  /** Remove the stored embedding for a deleted page and persist the change. */
  removePageVector(pagePath: string): void {
    this.searchEngine.removeVector(pagePath);
    this.saveVectorIndex();
  }

  /** Rebuild the full vector index for all pages (used by wiki_rebuild when hybrid is on).
   *  Returns counts of pages processed and pages that failed (e.g. embedding errors). */
  async rebuildVectorIndex(): Promise<{ pagesProcessed: number; errors: number }> {
    const pages = this.listAllPages();
    let pagesProcessed = 0;
    let errors = 0;
    for (const pagePath of pages) {
      const page = this.read(pagePath);
      if (!page) continue;
      const text = `${page.title} ${page.tags.join(" ")} ${page.content}`.slice(0, 2000);
      try {
        const embedding = await this.searchEngine.embedText(text);
        this.searchEngine.updateVector(pagePath, embedding);
        pagesProcessed++;
      } catch {
        errors++;
      }
    }
    this.saveVectorIndex();
    return { pagesProcessed, errors };
  }

  /** Return the number of pages currently in the vector index. */
  getVectorCount(): number {
    return this.searchEngine.getVectorCount();
  }

  // ── Lint — Self-checking & error detection ────────────────────

  /** Run comprehensive health checks. Pure rules, no LLM.
   *  Detects: contradictions, orphans, broken links, missing sources,
   *  stale content, structural issues, integrity problems.
   *
   *  @param applyFixes  When true, automatically fix `autoFixable` issues:
   *    - Missing frontmatter → auto-classify + inject title/type/tags
   *  Returns `fixed` count of pages that were automatically repaired. */
  lint(applyFixes = false): LintReport & { fixed: number; fixedPages: string[] } {
    const pages = this.listAllPages();
    const report: LintReport = {
      pagesChecked: pages.length,
      rawChecked: 0,
      issues: [],
      contradictions: [],
    };
    let fixed = 0;
    const fixedPages: string[] = [];

    // Build a map of all pages for cross-referencing
    const pageMap = new Map<string, WikiPage>();
    for (const pagePath of pages) {
      const page = this.read(pagePath);
      if (page) pageMap.set(pagePath, page);
    }

    // ── O(1) lookup indexes ──
    const pageSet = new Set(pages);
    const basenameToPages = new Map<string, string[]>();
    for (const p of pages) {
      const bn = basename(p, extname(p));
      const existing = basenameToPages.get(bn);
      if (existing) existing.push(p);
      else basenameToPages.set(bn, [p]);
    }
    // Reverse link index: slug → set of pages that link TO this slug
    const incomingLinks = new Map<string, Set<string>>();
    for (const [sourcePath, page] of pageMap) {
      for (const link of page.links) {
        let targets = incomingLinks.get(link);
        if (!targets) { targets = new Set(); incomingLinks.set(link, targets); }
        targets.add(sourcePath);
      }
    }

    for (const [pagePath, page] of pageMap) {
      // ── Missing frontmatter ──
      if (Object.keys(page.frontmatter).length === 0) {
        if (applyFixes) {
          // Auto-fix: derive title from filename, auto-classify type + tags
          const titleFromFilename = basename(pagePath, ".md")
            .replace(/-/g, " ")
            .replace(/\b\w/g, c => c.toUpperCase());
          const rawContent = `---\ntitle: ${titleFromFilename}\n---\n${page.content}`;
          const enriched = this.autoClassifyContent(rawContent);
          this.write(pagePath, enriched);
          fixed++;
          fixedPages.push(pagePath);
        } else {
          report.issues.push({
            severity: "warning",
            page: pagePath,
            message: "Missing YAML frontmatter",
            suggestion: "Add frontmatter with title, type, tags, and sources",
            autoFixable: true,
            category: "structure",
          });
        }
      }

      // ── Missing title ──
      if (!page.title || page.title === basename(pagePath, extname(pagePath))) {
        report.issues.push({
          severity: "warning",
          page: pagePath,
          message: "Missing or auto-generated title",
          suggestion: "Add a meaningful title in frontmatter",
          autoFixable: false,
          category: "structure",
        });
      }

      // ── Orphan pages ──
      if (this.config.lint.checkOrphans && !isSystemPage(pagePath)) {
        const slug = basename(pagePath, extname(pagePath));
        // Full relative slug: "topic/page-name" (without .md)
        const fullSlug = pagePath.endsWith(".md") ? pagePath.slice(0, -3) : pagePath;
        const slugIncoming = incomingLinks.get(slug);
        const fullSlugIncoming = incomingLinks.get(fullSlug);
        // Check that at least one *other* page links here (exclude self-links)
        const hasIncoming =
          (slugIncoming !== undefined && (slugIncoming.size > 1 || !slugIncoming.has(pagePath))) ||
          (fullSlugIncoming !== undefined && (fullSlugIncoming.size > 1 || !fullSlugIncoming.has(pagePath)));
        if (!hasIncoming) {
          report.issues.push({
            severity: "warning",
            page: pagePath,
            message: "Orphan page — no other pages link here",
            suggestion: `Add [[${fullSlug}]] to related pages or index.md`,
            autoFixable: true,
            category: "orphan",
          });
        }
      }

      // ── Broken links ──
      for (const link of page.links) {
        const linkPath = link.endsWith(".md") ? link : link + ".md";
        // O(1) direct-path check
        if (pageSet.has(linkPath) || pageSet.has(link)) continue;
        // O(1) basename check
        const bareLink = link.replace(/\.md$/, "");
        if (basenameToPages.has(link) || basenameToPages.has(bareLink)) continue;
        // BM25 "did you mean?" — search for similar page names
        const searchQuery = bareLink.replace(/-/g, " ");
        const candidates = this.search(searchQuery, 3).map(r => r.path);
        const suggestion = candidates.length > 0
          ? `Did you mean: ${candidates.join(", ")}? Or create ${link}.md`
          : `Create ${link}.md or fix the link`;
        report.issues.push({
          severity: "error",
          page: pagePath,
          message: `Broken link: [[${link}]]`,
          suggestion,
          autoFixable: false,
          category: "broken-link",
        });
      }

      // ── Missing sources (non-system pages) ──
      if (this.config.lint.checkMissingSources && !isSystemPage(pagePath)) {
        if (page.sources.length === 0 && page.type && page.type !== "index" && page.type !== "log" && page.type !== "timeline") {
          report.issues.push({
            severity: "info",
            page: pagePath,
            message: "No sources listed — claims are not traceable to raw documents",
            suggestion: "Add sources to frontmatter linking to raw/ files or URLs",
            autoFixable: false,
            category: "missing-source",
          });
        }
      }

      // ── Synthesis page integrity ──
      if (page.type === "synthesis" && page.derivedFrom) {
        for (const src of page.derivedFrom) {
          const srcPath = src.endsWith(".md") ? src : src + ".md";
          const bareSrc = src.replace(/\.md$/, "");
          const found =
            pageSet.has(srcPath) ||
            pageSet.has(src) ||
            basenameToPages.has(src) ||
            basenameToPages.has(bareSrc);
          if (!found) {
            report.issues.push({
              severity: "error",
              page: pagePath,
              message: `Synthesis source missing: ${src}`,
              suggestion: `The page this synthesis derives from no longer exists. Review and update.`,
              autoFixable: false,
              category: "integrity",
            });
          }
        }
      }

      // ── Stale content ──
      if (this.config.lint.checkStaleDays > 0) {
        try {
          const fullPath = join(this.config.wikiDir, pagePath);
          const stat = statSync(fullPath);
          const ageDays = Math.floor((Date.now() - stat.mtimeMs) / (1000 * 60 * 60 * 24));
          if (ageDays > this.config.lint.checkStaleDays) {
            report.issues.push({
              severity: "info",
              page: pagePath,
              message: `Stale content — last modified ${ageDays} days ago`,
              suggestion: "Review and update if needed",
              autoFixable: false,
              category: "stale",
            });
          }
        } catch {
          // stat failed, skip
        }
      }
    }

    // ── Cross-page contradiction detection ──
    if (this.config.lint.checkContradictions) {
      const contradictions = this.detectContradictions(pageMap);
      report.contradictions = contradictions;
      for (const c of contradictions) {
        report.issues.push({
          severity: c.severity,
          page: c.pageA,
          message: `Contradiction with [[${basename(c.pageB, ".md")}]]: ${c.claim}`,
          suggestion: `"${c.excerptA}" vs "${c.excerptB}" — review and resolve`,
          autoFixable: false,
          category: "contradiction",
        });
      }
    }

    // ── Raw file integrity (incremental — cached by mtime+size) ──
    if (this.config.lint.checkIntegrity) {
      const lintCache = this.loadLintCache() ?? { version: 1 as const, entries: {} };
      const rawResults = this.rawVerify(lintCache);
      report.rawChecked = rawResults.length;
      for (const r of rawResults) {
        if (r.status === "corrupted") {
          report.issues.push({
            severity: "error",
            page: `raw/${r.path}`,
            message: "Raw file corrupted — SHA-256 mismatch",
            suggestion: "Re-download the original source",
            autoFixable: false,
            category: "integrity",
          });
        } else if (r.status === "missing-meta") {
          report.issues.push({
            severity: "warning",
            page: `raw/${r.path}`,
            message: "Raw file has no metadata sidecar (.meta.yaml)",
            suggestion: "Use raw_add to properly register this file",
            autoFixable: true,
            category: "integrity",
          });
        }
      }
      this.saveLintCache(lintCache);
    }

    this.log("lint", "—", `Checked ${report.pagesChecked} pages + ${report.rawChecked} raw files, found ${report.issues.length} issues (${report.contradictions.length} contradictions)${fixed > 0 ? `, auto-fixed ${fixed} pages` : ""}`);
    return { ...report, fixed, fixedPages };
  }

  // ── Contradiction detection ───────────────────────────────────

  /** Normalize a numeric value + unit to a canonical (value, unit) pair.
   *  Collapses scale suffixes (million/billion/k) and ms→s so that
   *  "1000 ms" and "1 s", or "5 billion" and "5000 million", are not
   *  falsely reported as contradictions. */
  private static normalizeUnit(rawValue: string, rawUnit: string): { value: number; unit: string } {
    const v = parseFloat(rawValue);
    const u = rawUnit.toLowerCase().trim();
    if (u === "ms") return { value: v / 1000, unit: "s" };
    if (u === "million") return { value: v * 1e6, unit: "count" };
    if (u === "billion") return { value: v * 1e9, unit: "count" };
    if (u === "k") return { value: v * 1e3, unit: "count" };
    return { value: v, unit: u };
  }

  /** Normalize unit abbreviations in a context string so that keys
   *  derived from "1000 ms latency" and "1 s latency" are identical. */
  private static normalizeUnitText(text: string): string {
    return text
      .replace(/\bms\b/gi, "s")
      .replace(/\bmillion\b/gi, "count")
      .replace(/\bbillion\b/gi, "count")
      .replace(/\bk\b/g, "count");
  }

  /** Detect contradictions between pages.
   *  Looks for numeric claims, date claims, and factual statements
   *  that conflict across pages about the same entity/topic.
   *
   *  Improvements over baseline:
   *  - Bug fix: uses match.index instead of indexOf (correct context for repeated values)
   *  - Unit normalization: "1000 ms" and "1 s" are not reported as contradictions
   *  - Topic isolation: only compares pages that share a tag or link to each other
   *  - Extended date patterns: ISO dates and "Month YYYY" in addition to bare years
   */
  private detectContradictions(pageMap: Map<string, WikiPage>): Contradiction[] {
    const contradictions: Contradiction[] = [];

    // Extract claims from pages — look for patterns like "X is Y", dates, numbers
    const claims = new Map<string, Array<{ page: string; excerpt: string; value: number; rawValue: string }>>();

    for (const [pagePath, page] of pageMap) {
      if (isSystemPage(pagePath)) continue;

      // Extract date claims: "published in 2021", "released March 2021", "born 2021-03-15"
      const datePatterns = page.content.matchAll(
        /(?:published|released|founded|created|introduced|launched|announced|born|died)\s+(?:in\s+|on\s+)?(?:(?:january|february|march|april|may|june|july|august|september|october|november|december)\s+)?(\d{4}(?:-\d{2}-\d{2})?)/gi
      );
      for (const m of datePatterns) {
        const year = m[1]!.slice(0, 4); // normalize ISO dates to year only for key
        const key = m[0]!.replace(/\d{4}(?:-\d{2}-\d{2})?/, "YEAR").toLowerCase().trim();
        const entry = { page: pagePath, excerpt: m[0]!, value: parseFloat(year), rawValue: m[1]! };
        if (!claims.has(key)) claims.set(key, []);
        claims.get(key)!.push(entry);
      }

      // Extract numeric claims: "achieved XX% mAP", "XX FPS", "XX parameters"
      const numericPatterns = page.content.matchAll(
        /(\d+\.?\d*)\s*(%|fps|ms|s\b|map|ap|parameters|params|layers|million|billion|k\b)/gi
      );
      for (const m of numericPatterns) {
        // Bug fix: use match.index (correct position for repeated patterns)
        const idx = m.index ?? page.content.indexOf(m[0]!);
        const ctxStart = Math.max(0, idx - 30);
        const ctxEnd = Math.min(page.content.length, idx + m[0]!.length + 30);
        const context = page.content.slice(ctxStart, ctxEnd).replace(/\n/g, " ").trim();

        // Key = unit-normalized context with numbers replaced by "N"
        const key = Wiki.normalizeUnitText(context)
          .replace(/\d+\.?\d*/g, "N")
          .toLowerCase()
          .slice(0, 60);

        // Value = unit-normalized number for accurate comparison
        const { value: normValue } = Wiki.normalizeUnit(m[1]!, m[2]!);
        const entry = { page: pagePath, excerpt: context, value: normValue, rawValue: m[1]! };
        if (!claims.has(key)) claims.set(key, []);
        claims.get(key)!.push(entry);
      }
    }

    // Compare claims from different pages
    for (const [claimKey, entries] of claims) {
      if (entries.length < 2) continue;

      // Group by page — keep only the first occurrence per page
      const byPage = new Map<string, typeof entries[0]>();
      for (const e of entries) {
        if (!byPage.has(e.page)) byPage.set(e.page, e);
      }
      const uniquePages = [...byPage.values()];
      if (uniquePages.length < 2) continue;

      // Check if values differ across pairs
      for (let i = 0; i < uniquePages.length; i++) {
        for (let j = i + 1; j < uniquePages.length; j++) {
          const a = uniquePages[i]!;
          const b = uniquePages[j]!;
          if (a.value === b.value) continue;

          // Topic isolation: only report contradictions between related pages
          // (pages that share a tag or have a direct [[link]] between them).
          // Unrelated pages sharing a number are almost never a real contradiction.
          const pA = pageMap.get(a.page)!;
          const pB = pageMap.get(b.page)!;
          const sharedTag = pA.tags.some(t => pB.tags.includes(t));
          const slugB = basename(b.page, ".md");
          const slugA = basename(a.page, ".md");
          const linkedAtoB = pA.links.includes(slugB) || pA.links.includes(b.page.replace(/\.md$/, ""));
          const linkedBtoA = pB.links.includes(slugA) || pB.links.includes(a.page.replace(/\.md$/, ""));
          if (!sharedTag && !linkedAtoB && !linkedBtoA) continue;

          contradictions.push({
            claim: claimKey.replace(/\bn\b/gi, "?"),
            pageA: a.page,
            excerptA: a.excerpt,
            pageB: b.page,
            excerptB: b.excerpt,
            severity: Math.abs(a.value - b.value) > 10 ? "error" : "warning",
          });
        }
      }
    }

    return contradictions;
  }

  // ── Synthesis — Knowledge distillation ────────────────────────

  /** Get context for synthesis: reads multiple pages and returns
   *  their content for the agent to distill into a new page. */
  synthesizeContext(pagePaths: string[]): {
    pages: Array<{ path: string; title: string; content: string }>;
    suggestions: string[];
  } {
    const pages: Array<{ path: string; title: string; content: string }> = [];
    const allTags = new Set<string>();
    const allLinks = new Set<string>();

    for (const p of pagePaths) {
      const page = this.read(p) ?? this.read(p + ".md");
      if (page) {
        pages.push({ path: page.path, title: page.title, content: page.content });
        page.tags.forEach((t) => allTags.add(t));
        page.links.forEach((l) => allLinks.add(l));
      }
    }

    // Generate suggestions for the synthesis
    const suggestions: string[] = [];
    if (pages.length >= 2) {
      suggestions.push(`Combine insights from ${pages.map((p) => p.title).join(", ")}`);
      suggestions.push("Look for common themes, contradictions, and gaps");
      suggestions.push("Create cross-references using [[page-name]] syntax");
    }
    if (allTags.size > 0) {
      suggestions.push(`Suggested tags: ${[...allTags].join(", ")}`);
    }

    return { pages, suggestions };
  }

  // ── Auto-Classification ───────────────────────────────────────

  /** Auto-classify content into entity type and suggested tags.
   *  Pure heuristic — zero LLM dependency. Analyzes title, body,
   *  and structure to determine the best type and relevant tags.
   *  If frontmatter already has a type, respects it. */
  classify(content: string): { type: string; tags: string[]; confidence: number } {
    const parsed = matter(content);
    const body = parsed.content.toLowerCase();
    const title = ((parsed.data.title as string) ?? "").toLowerCase();
    const combined = title + " " + body;

    // If frontmatter already specifies type, respect it but still suggest tags
    if (parsed.data.type && typeof parsed.data.type === "string" && parsed.data.type !== "note") {
      const existingTags = Array.isArray(parsed.data.tags) ? parsed.data.tags.map(String) : [];
      const suggestedTags = existingTags.length > 0 ? existingTags : this.extractTags(combined);
      return { type: parsed.data.type, tags: suggestedTags, confidence: 1.0 };
    }

    // Score each entity type based on keyword signals
    const scores: Record<string, number> = {
      person: 0, concept: 0, event: 0, artifact: 0, code: 0,
      comparison: 0, summary: 0, "how-to": 0, synthesis: 0, note: 0,
    };

    // Person signals
    for (const w of ["born", "career", "biography", "researcher", "professor", "author",
      "founder", "role:", "affiliat", "人物", "创始人", "研究员"]) {
      if (combined.includes(w)) scores.person += 2;
    }

    // Concept signals
    for (const w of ["definition", "theory", "concept", "principle", "paradigm",
      "what is", "核心思想", "定义", "概念", "理论", "原理"]) {
      if (combined.includes(w)) scores.concept += 2;
    }

    // Event signals
    for (const w of ["happened", "occurred", "conference", "launched", "announced",
      "event", "发布会", "事件", "会议"]) {
      if (combined.includes(w)) scores.event += 2;
    }

    // Artifact signals (papers, tools, models)
    for (const w of ["paper", "论文", "tool", "library", "framework", "model",
      "version", "release", "arxiv", "github", "引用", "doi"]) {
      if (combined.includes(w)) scores.artifact += 2;
    }

    // Code signals (source code with business logic)
    for (const w of ["procedure division", "identification division", "data division",
      "working-storage", "copybook", "program-id", "perform", "evaluate",
      "cobol", "jcl", "cics", "db2", "vsam", "pic x", "pic 9",
      "function ", "def ", "class ", "import ", "module", "subroutine",
      "源代码", "程序", "代码", "子程序", "调用关系"]) {
      if (combined.includes(w)) scores.code += 2;
    }
    // Code blocks strongly suggest code type
    const codeBlockCount = (body.match(/```/g) ?? []).length / 2;
    if (codeBlockCount >= 1) scores.code += 2;
    if (codeBlockCount >= 3) scores.code += 3;

    // Comparison signals
    for (const w of ["vs", "versus", "compared", "comparison", "benchmark",
      "对比", "比较", "横评"]) {
      if (combined.includes(w)) scores.comparison += 2;
    }
    // Many table rows strongly suggest comparison
    if ((body.match(/\|/g) ?? []).length > 15) scores.comparison += 3;

    // Summary signals
    for (const w of ["summary", "overview", "timeline", "history", "evolution",
      "演进", "总结", "概述", "版本", "时间线", "回顾"]) {
      if (combined.includes(w)) scores.summary += 2;
    }

    // How-to signals
    for (const w of ["step", "guide", "tutorial", "how to", "procedure",
      "install", "setup", "步骤", "指南", "教程", "安装"]) {
      if (combined.includes(w)) scores["how-to"] += 2;
    }

    // Synthesis signals
    for (const w of ["synthesis", "derived from", "combining", "integrat",
      "综合", "提炼", "整合"]) {
      if (combined.includes(w)) scores.synthesis += 2;
    }

    // Pick the highest-scoring type
    let bestType = "note";
    let bestScore = 0;
    for (const [type, score] of Object.entries(scores)) {
      if (score > bestScore) { bestScore = score; bestType = type; }
    }

    const confidence = bestScore > 0 ? Math.min(bestScore / 10, 1.0) : 0.3;
    const tags = this.extractTags(combined);

    return { type: bestType, tags, confidence };
  }

  /**
   * Return the title→slug index used by autoLink, building it lazily.
   * Results are cached in `titleIndexCache` and updated incrementally by
   * `write()` and `delete()` — so the first call is O(n file reads) but
   * subsequent calls are O(1) even across a batch of writes.
   */
  private getTitleIndex(): Array<{ title: string; slug: string }> {
    if (this.titleIndexCache !== null) return this.titleIndexCache;
    const candidates: Array<{ title: string; slug: string }> = [];
    for (const p of this.listAllPages()) {
      if (isSystemPage(p)) continue;
      const slug = basename(p, ".md");
      try {
        const raw = readFileSync(join(this.config.wikiDir, p), "utf-8");
        const fm = matter(raw).data;
        const title = ((fm.title as string) ?? slug.replace(/-/g, " ")).trim();
        if (title.length >= 4) candidates.push({ title, slug });
      } catch { /* skip unreadable pages */ }
    }
    candidates.sort((a, b) => b.title.length - a.title.length);
    this.titleIndexCache = candidates;
    return this.titleIndexCache;
  }

  /**
   * Scan content body for mentions of existing page titles and inject `[[slug|text]]` links.
   *
   * Skipped zones (unchanged):
   *   - Fenced code blocks (``` or ~~~)
   *   - Inline code (`...`)
   *   - Existing `[[wiki links]]`
   *   - Markdown `[text](url)` links
   *   - Bare URLs (https?://...)
   *
   * Rules:
   *   - Only titles ≥ 4 chars are considered (avoids noise from short tokens)
   *   - Each page is linked at most once — first occurrence wins
   *   - Longest title wins when two candidates overlap
   *   - Self-references (same slug as `selfPath`) are excluded
   *
   * Returns `{ content, linksAdded }`. Content is unchanged when linksAdded === 0.
   */
  autoLink(content: string, selfPath: string): { content: string; linksAdded: number } {
    const parsed = matter(content);
    const body = parsed.content;

    const selfSlug = basename(selfPath, ".md");

    // Exclude self — filter from the shared (cached) index without mutating it
    const candidates = this.getTitleIndex().filter(c => c.slug !== selfSlug);

    if (candidates.length === 0) return { content, linksAdded: 0 };

    // Split body into skip zones (code, existing links, urls) and safe zones
    const SKIP_RE = /(```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`]*`|\[\[[^\]]*\]\]|\[[^\]]*\]\([^)]*\)|https?:\/\/\S+)/g;
    const segments: Array<{ text: string; skip: boolean }> = [];
    let last = 0;
    let m: RegExpExecArray | null;
    while ((m = SKIP_RE.exec(body)) !== null) {
      if (m.index > last) segments.push({ text: body.slice(last, m.index), skip: false });
      segments.push({ text: m[0], skip: true });
      last = m.index + m[0].length;
    }
    if (last < body.length) segments.push({ text: body.slice(last), skip: false });

    const linked = new Set<string>();
    let linksAdded = 0;

    interface SegMatch { start: number; end: number; matchText: string; slug: string }

    const newSegments = segments.map(seg => {
      if (seg.skip) return seg.text;
      const text = seg.text;

      // Collect every candidate occurrence in this segment
      const allMatches: SegMatch[] = [];
      for (const { title, slug } of candidates) {
        if (linked.has(slug)) continue;
        const escaped = title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const re = new RegExp(`(?<![\\w\\[])${escaped}(?![\\w\\]])`, "gi");
        let m2: RegExpExecArray | null;
        while ((m2 = re.exec(text)) !== null) {
          allMatches.push({ start: m2.index, end: m2.index + m2[0].length, matchText: m2[0], slug });
        }
      }

      if (allMatches.length === 0) return text;

      // Sort by position asc, then by match length desc (longer wins at same start)
      allMatches.sort((a, b) => a.start - b.start || (b.end - b.start) - (a.end - a.start));

      // Greedy selection: non-overlapping, one link per slug
      const selected: SegMatch[] = [];
      let lastEnd = 0;
      const usedSlugs = new Set<string>();
      for (const m2 of allMatches) {
        if (m2.start < lastEnd) continue;           // overlaps a previous match
        if (usedSlugs.has(m2.slug)) continue;       // slug already linked in this segment
        // (slugs in linked were pre-filtered when building allMatches above)
        selected.push(m2);
        lastEnd = m2.end;
        usedSlugs.add(m2.slug);
      }

      if (selected.length === 0) return text;

      // Apply replacements right-to-left (preserves earlier positions)
      let result = text;
      for (const m2 of [...selected].reverse()) {
        linked.add(m2.slug);
        linksAdded++;
        result = result.slice(0, m2.start) + `[[${m2.slug}|${m2.matchText}]]` + result.slice(m2.end);
      }
      return result;
    });

    if (linksAdded === 0) return { content, linksAdded: 0 };

    const newBody = newSegments.join("");
    return { content: matter.stringify(newBody, parsed.data), linksAdded };
  }

  /** Auto-classify and inject type/tags into content if missing.
   *  Returns the enriched content string. */
  autoClassifyContent(content: string): string {
    const parsed = matter(content);

    // Only auto-classify if type is missing or is generic "note"
    if (parsed.data.type && parsed.data.type !== "note") return content;

    const classification = this.classify(content);

    if (!parsed.data.type || parsed.data.type === "note") {
      parsed.data.type = classification.type;
    }

    // Merge tags: keep existing + add new suggestions (deduplicated)
    const existingTags = Array.isArray(parsed.data.tags) ? parsed.data.tags.map(String) : [];
    const merged = [...new Set([...existingTags, ...classification.tags])];
    if (merged.length > 0) parsed.data.tags = merged;

    return matter.stringify(parsed.content, parsed.data);
  }

  /** Extract relevant tags from text using keyword matching. */
  private extractTags(text: string): string[] {
    const knownTags: Record<string, string> = {
      "yolo": "yolo", "object detection": "object-detection", "目标检测": "object-detection",
      "computer vision": "computer-vision", "计算机视觉": "computer-vision",
      "deep learning": "deep-learning", "深度学习": "deep-learning",
      "machine learning": "machine-learning", "机器学习": "machine-learning",
      "transformer": "transformer", "attention": "attention-mechanism",
      "cnn": "cnn", "卷积": "cnn", "real-time": "real-time", "实时": "real-time",
      "python": "python", "pytorch": "pytorch", "tensorflow": "tensorflow",
      "arxiv": "academic", "论文": "academic", "paper": "academic",
      "benchmark": "benchmark", "基准": "benchmark",
      "neural network": "neural-network", "神经网络": "neural-network",
      "nlp": "nlp", "自然语言": "nlp", "language model": "llm", "大模型": "llm",
      "gan": "gan", "diffusion": "diffusion", "stable diffusion": "stable-diffusion",
      "reinforcement learning": "reinforcement-learning", "强化学习": "reinforcement-learning",
      "autonomous driving": "autonomous-driving", "自动驾驶": "autonomous-driving",
      "segmentation": "segmentation", "分割": "segmentation",
      "detection": "detection", "检测": "detection",
      "classification": "classification", "分类": "classification",
      "training": "training", "inference": "inference", "推理": "inference",
      "edge deploy": "edge-deployment", "边缘部署": "edge-deployment",
      "anchor": "anchor", "backbone": "backbone", "fpn": "feature-pyramid",
      "docker": "docker", "kubernetes": "kubernetes",
      "api": "api", "rest": "rest-api", "mcp": "mcp",
    };

    const tags = new Set<string>();
    const lower = text.toLowerCase();
    for (const [keyword, tag] of Object.entries(knownTags)) {
      if (lower.includes(keyword)) tags.add(tag);
    }
    return [...tags];
  }

  // ── Schemas ───────────────────────────────────────────────────

  /** List available entity type schemas. */
  schemas(): Array<{ name: string; description: string; template: string }> {
    const dir = this.config.schemasDir;
    if (!existsSync(dir)) return [];

    const result: Array<{ name: string; description: string; template: string }> = [];
    for (const file of readdirSync(dir).filter((f) => f.endsWith(".md"))) {
      const content = readFileSync(join(dir, file), "utf-8");
      const parsed = matter(content);
      result.push({
        name: basename(file, ".md"),
        description: (parsed.data.description as string) ?? "",
        template: content,
      });
    }
    return result;
  }

  // ── Log ───────────────────────────────────────────────────────

  /** Get operation log entries. */
  getLog(limit = 20): Array<{ time: string; operation: string; page: string; summary: string }> {
    const logPath = join(this.config.wikiDir, "log.md");
    if (!existsSync(logPath)) return [];

    const content = readFileSync(logPath, "utf-8");
    const lines = content.split("\n").filter((l) => l.startsWith("|") && !l.startsWith("| Time") && !l.startsWith("|---"));
    const entries: Array<{ time: string; operation: string; page: string; summary: string }> = [];

    for (const line of lines) {
      const cols = line.split("|").map((c) => c.trim()).filter(Boolean);
      if (cols.length >= 4) {
        entries.push({ time: cols[0]!, operation: cols[1]!, page: cols[2]!, summary: cols[3]! });
      } else if (cols.length >= 3) {
        entries.push({ time: cols[0]!, operation: cols[1]!, page: "—", summary: cols[2]! });
      }
    }

    return entries.slice(-limit);
  }

  // ── Index rebuild ─────────────────────────────────────────────

  /** Rebuild index.md from all pages.
   *  If topic subdirectories exist, generates per-topic sub-indexes and
   *  a top-level hub. Otherwise falls back to flat type-based grouping. */
  /** Build a page cache to avoid reading each page multiple times during rebuild. */
  buildPageCache(): Map<string, WikiPage> {
    const pages = this.listAllPages().filter((p) => !isSystemPage(p));
    const cache = new Map<string, WikiPage>();
    for (const pagePath of pages) {
      const page = this.read(pagePath);
      if (page) cache.set(pagePath, page);
    }
    return cache;
  }

  rebuildIndex(pageCache?: Map<string, WikiPage>): void {
    const pages = pageCache
      ? [...pageCache.keys()]
      : this.listAllPages().filter((p) => !isSystemPage(p));
    let rawCount = 0;
    try {
      rawCount = this.rawList().length;
    } catch { /* no raw dir */ }

    // Collect existing sub-indexes before rebuild so we can remove stale ones
    const existingSubIndexes = this.listAllPages()
      .filter((p) => p !== "index.md" && p.endsWith("/index.md"));

    // Compute the set of sub-indexes that should exist based on current pages
    const expectedSubIndexes = new Set<string>();
    for (const pagePath of pages) {
      const parts = pagePath.split("/");
      for (let i = 1; i < parts.length; i++) {
        expectedSubIndexes.add(parts.slice(0, i).join("/") + "/index.md");
      }
    }

    // Remove stale sub-indexes (and empty parent dirs)
    for (const staleIndex of existingSubIndexes) {
      if (!expectedSubIndexes.has(staleIndex)) {
        const fullPath = join(this.config.wikiDir, staleIndex);
        if (existsSync(fullPath)) unlinkSync(fullPath);
        // Clean up empty parent directories up to wiki root
        let dir = dirname(fullPath);
        const wikiRoot = resolve(this.config.wikiDir);
        while (dir !== wikiRoot && dir.startsWith(wikiRoot)) {
          try {
            rmdirSync(dir); // only succeeds if empty
            dir = dirname(dir);
          } catch {
            break; // not empty, stop
          }
        }
      }
    }

    // Partition pages into topic dirs vs root-level
    const topicPages: Record<string, string[]> = {};  // topic -> page paths
    const rootPages: string[] = [];

    for (const pagePath of pages) {
      const parts = pagePath.split("/");
      if (parts.length >= 2) {
        const topic = parts[0]!;
        if (!topicPages[topic]) topicPages[topic] = [];
        topicPages[topic]!.push(pagePath);
      } else {
        rootPages.push(pagePath);
      }
    }

    const hasTopics = Object.keys(topicPages).length > 0;
    const now = new Date().toISOString();

    if (hasTopics) {
      // ── Build per-topic sub-indexes ──
      for (const [topic, tPages] of Object.entries(topicPages)) {
        this.rebuildTopicIndex(topic, tPages, now, pageCache);
      }

      // ── Build top-level hub index ──
      const topicCount = Object.keys(topicPages).length;
      let lines = [
        "---",
        "title: Knowledge Base Index",
        "type: index",
        `created: "${this.read("index.md")?.created ?? now}"`,
        `updated: "${now}"`,
        "---",
        "",
        "# Knowledge Base Index",
        "",
        `**${pages.length} pages** across **${topicCount} topics** | **${rawCount} raw sources**`,
        "",
        "## Topics",
        "",
      ];

      const sortedTopics = Object.keys(topicPages).sort();
      for (const topic of sortedTopics) {
        const count = topicPages[topic]!.length;
        // Try to read topic sub-index title for a description
        const subIndex = this.read(`${topic}/index.md`);
        const desc = subIndex?.frontmatter?.description as string | undefined;
        const suffix = desc ? ` — ${desc}` : "";
        lines.push(`- [[${topic}/index]] — ${topic} (${count} pages)${suffix}`);
      }
      lines.push("");

      // Root-level pages (not in any topic dir)
      if (rootPages.length > 0) {
        const categories: Record<string, string[]> = {};
        for (const pagePath of rootPages) {
          const page = pageCache?.get(pagePath) ?? this.read(pagePath);
          if (!page) continue;
          const type = page.type ?? "uncategorized";
          if (!categories[type]) categories[type] = [];
          const slug = basename(pagePath, extname(pagePath));
          const updated = page.updated ? ` _(${page.updated.slice(0, 10)})_` : "";
          categories[type]!.push(`- [[${slug}]] — ${page.title}${updated}`);
        }
        for (const type of Object.keys(categories).sort()) {
          const label = type.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
          lines.push(`## ${label} (${categories[type]!.length})`, "");
          lines.push(...categories[type]!, "");
        }
      }

      lines.push("---", "", `_Last rebuilt: ${now.replace("T", " ").slice(0, 16)} UTC_`, "");
      writeFileSync(join(this.config.wikiDir, "index.md"), lines.join("\n"));
    } else {
      // ── Flat mode: group by type (backward compatible) ──
      const categories: Record<string, string[]> = {};
      for (const pagePath of pages) {
        const page = pageCache?.get(pagePath) ?? this.read(pagePath);
        if (!page) continue;
        const type = page.type ?? "uncategorized";
        if (!categories[type]) categories[type] = [];
        const slug = basename(pagePath, extname(pagePath));
        const updated = page.updated ? ` _(${page.updated.slice(0, 10)})_` : "";
        categories[type]!.push(`- [[${slug}]] — ${page.title}${updated}`);
      }

      let lines = [
        "---",
        "title: Knowledge Base Index",
        "type: index",
        `created: "${this.read("index.md")?.created ?? now}"`,
        `updated: "${now}"`,
        "---",
        "",
        "# Knowledge Base Index",
        "",
        `**${pages.length} pages** across **${Object.keys(categories).length} categories** | **${rawCount} raw sources**`,
        "",
      ];

      const sortedTypes = Object.keys(categories).sort();
      if (sortedTypes.length > 0) {
        for (const type of sortedTypes) {
          const label = type.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
          lines.push(`## ${label} (${categories[type]!.length})`, "");
          lines.push(...categories[type]!, "");
        }
      } else {
        lines.push("_No pages yet._", "");
      }

      lines.push("---", "", `_Last rebuilt: ${now.replace("T", " ").slice(0, 16)} UTC_`, "");
      writeFileSync(join(this.config.wikiDir, "index.md"), lines.join("\n"));
    }

    this.searchEngine.invalidate();
    this.log("rebuild-index", "index.md", `Rebuilt index with ${pages.length} pages`);
  }

  /** Rebuild a directory sub-index at {dirPath}/index.md.
   *  Recursively creates indexes for nested sub-directories. */
  private rebuildTopicIndex(dirPath: string, allPages: string[], now: string, pageCache?: Map<string, WikiPage>): void {
    // Separate into direct pages vs sub-directory pages
    const directPages: string[] = [];
    const subDirPages: Record<string, string[]> = {};
    const depth = dirPath.split("/").length;

    for (const pagePath of allPages) {
      const parts = pagePath.split("/");
      if (parts.length === depth + 1) {
        directPages.push(pagePath);
      } else if (parts.length > depth + 1) {
        const subDir = parts[depth]!;
        if (!subDirPages[subDir]) subDirPages[subDir] = [];
        subDirPages[subDir]!.push(pagePath);
      }
    }

    // Recursively build sub-directory indexes
    for (const [subDir, subPages] of Object.entries(subDirPages)) {
      this.rebuildTopicIndex(`${dirPath}/${subDir}`, subPages, now, pageCache);
    }

    const indexPath = `${dirPath}/index.md`;
    const existing = this.read(indexPath);
    const hasSubDirs = Object.keys(subDirPages).length > 0;
    const label = dirPath.split("/").pop()!.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

    let lines = [
      "---",
      `title: "${label}"`,
      "type: index",
      `created: "${existing?.created ?? now}"`,
      `updated: "${now}"`,
      "---",
      "",
      `# ${label}`,
      "",
      `_${allPages.length} pages_`,
      "",
    ];

    // List sub-directories first
    if (hasSubDirs) {
      lines.push("## Sub-topics", "");
      const sortedSubDirs = Object.keys(subDirPages).sort();
      for (const subDir of sortedSubDirs) {
        const count = subDirPages[subDir]!.length;
        const subLabel = subDir.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
        lines.push(`- [[${dirPath}/${subDir}/index]] — ${subLabel} (${count} pages)`);
      }
      lines.push("");
    }

    // List direct pages by type
    if (directPages.length > 0) {
      const categories: Record<string, string[]> = {};
      for (const pagePath of directPages) {
        const page = pageCache?.get(pagePath) ?? this.read(pagePath);
        if (!page) continue;
        const type = page.type ?? "uncategorized";
        if (!categories[type]) categories[type] = [];
        const slug = basename(pagePath, extname(pagePath));
        const updated = page.updated ? ` _(${page.updated.slice(0, 10)})_` : "";
        categories[type]!.push(`- [[${dirPath}/${slug}]] — ${page.title}${updated}`);
      }
      for (const type of Object.keys(categories).sort()) {
        const typeLabel = type.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
        lines.push(`## ${typeLabel} (${categories[type]!.length})`, "");
        lines.push(...categories[type]!, "");
      }
    }

    lines.push("---", "", `_Last rebuilt: ${now.replace("T", " ").slice(0, 16)} UTC_`, "");

    const fullPath = join(this.config.wikiDir, indexPath);
    mkdirSync(dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, lines.join("\n"));
  }

  // ── Timeline ──────────────────────────────────────────────────

  /** Rebuild timeline.md — chronological view of all knowledge. */
  rebuildTimeline(pageCache?: Map<string, WikiPage>): void {
    const pages = pageCache
      ? [...pageCache.keys()]
      : this.listAllPages().filter((p) => !isSystemPage(p));
    const entries: Array<{ date: string; page: string; title: string; type: string }> = [];

    for (const pagePath of pages) {
      const page = pageCache?.get(pagePath) ?? this.read(pagePath);
      if (!page) continue;
      const date = page.created ?? page.updated ?? "unknown";
      // Use full relative path (without .md) as link slug for subdirectory support
      const slug = pagePath.endsWith(".md") ? pagePath.slice(0, -3) : pagePath;
      entries.push({
        date: date.slice(0, 10),
        page: slug,
        title: page.title,
        type: page.type ?? "note",
      });
    }

    entries.sort((a, b) => b.date.localeCompare(a.date));

    const now = new Date().toISOString();
    let lines = [
      "---",
      "title: Knowledge Timeline",
      "type: timeline",
      `updated: "${now}"`,
      "---",
      "",
      "# Knowledge Timeline",
      "",
      `_${entries.length} entries — last rebuilt: ${now.replace("T", " ").slice(0, 16)} UTC_`,
      "",
    ];

    // Group by date
    let currentDate = "";
    for (const e of entries) {
      if (e.date !== currentDate) {
        currentDate = e.date;
        lines.push(`## ${currentDate}`, "");
      }
      lines.push(`- **[${e.type}]** [[${e.page}]] — ${e.title}`);
    }
    lines.push("");

    writeFileSync(join(this.config.wikiDir, "timeline.md"), lines.join("\n"));
    this.searchEngine.invalidate();
    this.log("rebuild-timeline", "timeline.md", `Rebuilt timeline with ${entries.length} entries`);
  }

  // ── Internal helpers ──────────────────────────────────────────

  private listAllPages(): string[] {
    const dir = this.config.wikiDir;
    if (!existsSync(dir)) return [];
    return listMdFiles(dir, dir);
  }

  private parsePage(pagePath: string, raw: string): WikiPage {
    const parsed = matter(raw);
    const fm = parsed.data as Record<string, unknown>;
    const body = parsed.content.trim();

    const linkMatches = body.matchAll(/\[\[([^\]]+)\]\]/g);
    // Support [[slug|display text]] format — extract slug part only
    const links = [...linkMatches].map((m) => m[1]!.split("|")[0]!.trim());

    return {
      path: pagePath,
      title: (fm.title as string) ?? basename(pagePath, extname(pagePath)),
      type: fm.type as string | undefined,
      tags: Array.isArray(fm.tags) ? fm.tags.map(String) : [],
      sources: Array.isArray(fm.sources) ? fm.sources.map(String) : [],
      content: body,
      frontmatter: fm,
      links,
      created: fm.created instanceof Date ? fm.created.toISOString() : fm.created as string | undefined,
      updated: fm.updated instanceof Date ? fm.updated.toISOString() : fm.updated as string | undefined,
      derivedFrom: Array.isArray(fm.derived_from) ? fm.derived_from.map(String) : undefined,
    };
  }

  private log(operation: string, page: string, summary: string): void {
    const logPath = join(this.config.wikiDir, "log.md");
    const now = new Date().toISOString().replace("T", " ").slice(0, 16) + " UTC";
    const entry = `| ${now} | ${operation} | ${page} | ${summary} |\n`;

    if (existsSync(logPath)) {
      const content = readFileSync(logPath, "utf-8");
      writeFileSync(logPath, content + entry);
    } else {
      const header =
        "---\ntitle: Operation Log\ntype: log\n---\n\n" +
        "# Operation Log\n\n" +
        "| Time | Operation | Page | Summary |\n" +
        "|------|-----------|------|--------|\n" +
        entry;
      writeFileSync(logPath, header);
    }
  }
}

// ── File helpers ──────────────────────────────────────────────────

function listMdFiles(dir: string, root: string): string[] {
  const result: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      result.push(...listMdFiles(full, root));
    } else if (entry.name.endsWith(".md")) {
      // Normalize to forward slashes for cross-platform consistency
      result.push(relative(root, full).replace(/\\/g, "/"));
    }
  }
  return result.sort();
}

function listAllFiles(dir: string, root: string): string[] {
  const result: string[] = [];
  if (!existsSync(dir)) return result;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      result.push(...listAllFiles(full, root));
    } else {
      result.push(relative(root, full).replace(/\\/g, "/"));
    }
  }
  return result.sort();
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function writeDefaultSchemas(dir: string): void {
  const schemas: Record<string, string> = {
    "person.md": `---
template: person
description: Profile of a person
---

# {{title}}

**Role:** [TODO]
**Affiliations:** [TODO]

## Key Contributions

- [TODO]

## Relationships

- [TODO]

## Sources

- [TODO]
`,
    "concept.md": `---
template: concept
description: An idea, theory, or abstract concept
---

# {{title}}

## Definition

[TODO]

## Properties

- [TODO]

## Relationships

- [TODO]

## Examples

- [TODO]

## Sources

- [TODO]
`,
    "event.md": `---
template: event
description: Something that happened at a specific time
---

# {{title}}

**Date:** [TODO]
**Location:** [TODO]

## Participants

- [TODO]

## What Happened

[TODO]

## Outcomes & Impact

[TODO]

## Sources

- [TODO]
`,
    "artifact.md": `---
template: artifact
description: A tool, paper, product, or created thing
---

# {{title}}

**Type:** [TODO]
**Creator:** [TODO]
**Date:** [TODO]

## Purpose

[TODO]

## Key Features

- [TODO]

## Sources

- [TODO]
`,
    "comparison.md": `---
template: comparison
description: Side-by-side analysis of two or more items
---

# {{title}}

## Items Compared

| Dimension | Item A | Item B |
|-----------|--------|--------|
| [TODO]    | [TODO] | [TODO] |

## Analysis

[TODO]

## Verdict

[TODO]

## Sources

- [TODO]
`,
    "summary.md": `---
template: summary
description: Summary of a source document
---

# {{title}}

**Source:** [TODO]
**Date:** [TODO]

## Key Points

1. [TODO]

## Detailed Summary

[TODO]

## Sources

- [TODO]
`,
    "how-to.md": `---
template: how-to
description: A procedure or guide
---

# {{title}}

## Goal

[TODO]

## Prerequisites

- [TODO]

## Steps

1. [TODO]

## Pitfalls

- [TODO]

## Sources

- [TODO]
`,
    "note.md": `---
template: note
description: Freeform knowledge — anything that does not fit other templates
---

# {{title}}

{{content}}

## Sources

- [TODO]
`,
    "code.md": `---
template: code
description: Source code with business logic explanation
---

# {{title}}

**Language:** [TODO]
**Source:** [TODO: path in raw/]

## Business Logic

[TODO: What does this code do in business terms?]

## Input / Output

| Variable | Direction | Description |
|----------|-----------|-------------|
| [TODO]   | in        | [TODO]      |
| [TODO]   | out       | [TODO]      |

## Dependencies

- [TODO: COPYBOOK, imports, called programs]

## Call Graph

- **Calls:** [TODO: [[other-programs]]]
- **Called by:** [TODO: [[parent-programs]]]

## Source Code

\`\`\`
[TODO: key code sections or link to raw/]
\`\`\`

## Sources

- [TODO]
`,
    "synthesis.md": `---
template: synthesis
description: Distilled knowledge combining insights from multiple pages
---

# {{title}}

**Derived from:** [TODO: list source pages with [[links]]]
**Date:** [TODO]

## Key Insights

[TODO: What emerges from combining these sources?]

## Connections

[TODO: How do these sources relate to each other?]

## Contradictions & Open Questions

[TODO: Where do sources disagree? What remains unclear?]

## Synthesis

[TODO: The integrated understanding]

## Sources

- [TODO]
`,
  };

  for (const [filename, content] of Object.entries(schemas)) {
    writeFileSync(join(dir, filename), content);
  }
}

/**
 * Simple glob matching for file filtering.
 * Supports: *.html, *.xlsx, *.{html,css}, **\/*.html
 * Not a full glob — just enough for pattern filtering.
 */
export function matchSimpleGlob(filepath: string, pattern: string): boolean {
  // Handle brace expansion: *.{html,css} → [html, css]
  const braceMatch = pattern.match(/\.\{([^}]+)\}$/);
  if (braceMatch) {
    const exts = braceMatch[1]!.split(",").map(e => e.trim());
    const fileExt = extname(filepath).slice(1).toLowerCase();
    return exts.some(e => e.toLowerCase() === fileExt);
  }

  // Handle simple extension pattern: *.html
  if (pattern.startsWith("*.")) {
    const ext = pattern.slice(1).toLowerCase(); // ".html"
    return filepath.toLowerCase().endsWith(ext);
  }

  // Handle recursive pattern: **/*.html → just match extension
  if (pattern.startsWith("**/")) {
    return matchSimpleGlob(filepath, pattern.slice(3));
  }

  // Fallback: exact match
  return filepath === pattern;
}
