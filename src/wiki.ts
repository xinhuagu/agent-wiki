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

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, unlinkSync, statSync, copyFileSync, createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { join, relative, resolve, basename, extname, dirname } from "node:path";
import { createHash } from "node:crypto";
import matter from "gray-matter";
import yaml from "js-yaml";
import { VERSION } from "./version.js";
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
}

// System pages that lint should treat specially
const SYSTEM_PAGES = new Set(["index.md", "log.md", "timeline.md"]);

/** Check if a page path is a system page (top-level or topic sub-index). */
function isSystemPage(pagePath: string): boolean {
  // Normalize to forward slashes for cross-platform consistency
  const normalized = pagePath.replace(/\\/g, "/");
  if (SYSTEM_PAGES.has(normalized)) return true;
  // Topic sub-indexes: e.g. "cobol/index.md"
  return /^[^/]+\/index\.md$/.test(normalized);
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

// ── Wiki Class ────────────────────────────────────────────────────

export class Wiki {
  readonly config: WikiConfig;

  /**
   * @param root — path to config root (where .agent-wiki.yaml lives)
   * @param workspace — override workspace directory (all data: wiki/, raw/, schemas/).
   *                     If not set, falls back to: AGENT_WIKI_WORKSPACE env → config file → root.
   */
  constructor(root?: string, workspace?: string) {
    const resolvedRoot = resolve(root ?? ".");
    this.config = Wiki.loadConfig(resolvedRoot, workspace);
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
    writeFileSync(join(configRoot, ".gitignore"), "node_modules/\ndist/\n.env\n");
    if (workspace && wsRoot !== configRoot) {
      writeFileSync(join(wsRoot, ".gitignore"), "# Agent Wiki workspace data\n");
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
   *  Other binary files (images, etc.) return metadata only. */
  async rawRead(filename: string): Promise<{ content: string | null; meta: RawDocument | null; binary: boolean; note?: string } | null> {
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
      const content = readFileSync(fullPath, "utf-8");
      return { content, meta, binary: false };
    }

    // Document formats — extract text via Node.js libraries
    const ext = extname(filename).toLowerCase();
    const extractable = new Set([".pdf", ".docx", ".xlsx", ".pptx", ".html", ".htm"]);
    if (extractable.has(ext)) {
      try {
        const text = await extractTextNode(fullPath);
        return { content: text, meta, binary: false };
      } catch (e: any) {
        const stat = statSync(fullPath);
        return {
          content: null, meta, binary: true,
          note: `Text extraction failed: ${e.message}. File size: ${formatBytes(stat.size)}.`,
        };
      }
    }

    // Other binary files — metadata only
    return { content: null, meta, binary: true };
  }

  /** Verify integrity of all raw files against their stored hashes. */
  rawVerify(): Array<{ path: string; status: "ok" | "corrupted" | "missing-meta" }> {
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

      const meta = yaml.load(readFileSync(metaPath, "utf-8")) as RawDocument;
      const buf = readFileSync(fullPath);
      const actualHash = createHash("sha256").update(buf).digest("hex");

      results.push({
        path: file,
        status: actualHash === meta.sha256 ? "ok" : "corrupted",
      });
    }
    return results;
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

    this.log("write", pagePath, `Wrote ${pagePath}${source ? ` (${source})` : ""}`);
  }

  /** Resolve page path to the correct topic subdirectory.
   *  If the path already has a subdirectory, returns as-is.
   *  Otherwise, routes based on: (1) explicit `topic` frontmatter field,
   *  (2) tag/title matching against existing topic directories. */
  resolvePagePath(pagePath: string, content: string): string {
    // Already in a subdirectory? Use as-is.
    if (pagePath.includes("/")) return pagePath;

    // No existing topic dirs → nothing to route to
    const topics = this.listTopicDirs();
    if (topics.length === 0) return pagePath;

    const parsed = matter(content);

    // 1. Explicit `topic` frontmatter field
    const explicitTopic = parsed.data.topic as string | undefined;
    if (explicitTopic && typeof explicitTopic === "string") {
      const normalized = explicitTopic.toLowerCase().replace(/\s+/g, "-");
      return `${normalized}/${pagePath}`;
    }

    // 2. Match tags/title against existing topic directory names
    const classification = this.classify(content);
    const title = ((parsed.data.title as string) ?? "").toLowerCase();
    const signals = [
      ...classification.tags.map((t) => t.toLowerCase()),
      ...title.split(/[\s\-_]+/).filter(Boolean),
    ];

    for (const topic of topics) {
      const topicLower = topic.toLowerCase();
      if (signals.some((s) => s === topicLower || s.includes(topicLower) || topicLower.includes(s))) {
        return `${topic}/${pagePath}`;
      }
    }

    return pagePath;
  }

  /** List existing topic subdirectories under wiki/. */
  listTopicDirs(): string[] {
    const dir = this.config.wikiDir;
    if (!existsSync(dir)) return [];
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith("."))
      .map((e) => e.name)
      .sort();
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

  /** Keyword search across all wiki pages. Returns paths sorted by relevance. */
  search(query: string, limit = 10): Array<{ path: string; score: number; snippet: string }> {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (terms.length === 0) return [];

    const pages = this.listAllPages();
    const results: Array<{ path: string; score: number; snippet: string }> = [];

    for (const pagePath of pages) {
      const page = this.read(pagePath);
      if (!page) continue;

      const text = (page.title + " " + page.tags.join(" ") + " " + page.content).toLowerCase();
      let score = 0;
      for (const term of terms) {
        let idx = 0;
        while ((idx = text.indexOf(term, idx)) !== -1) {
          score++;
          idx += term.length;
        }
        if (page.title.toLowerCase().includes(term)) score += 5;
        if (page.tags.some((t) => String(t).toLowerCase().includes(term))) score += 3;
        // Boost synthesis pages slightly — they represent distilled knowledge
        if (page.type === "synthesis") score += 1;
      }

      if (score > 0) {
        const firstIdx = text.indexOf(terms[0]!);
        const start = Math.max(0, firstIdx - 50);
        const end = Math.min(text.length, firstIdx + 100);
        const snippet = (start > 0 ? "..." : "") + text.slice(start, end).trim() + (end < text.length ? "..." : "");
        results.push({ path: pagePath, score, snippet });
      }
    }

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, limit);
  }

  // ── Lint — Self-checking & error detection ────────────────────

  /** Run comprehensive health checks. Pure rules, no LLM.
   *  Detects: contradictions, orphans, broken links, missing sources,
   *  stale content, structural issues, integrity problems. */
  lint(): LintReport {
    const pages = this.listAllPages();
    const report: LintReport = {
      pagesChecked: pages.length,
      rawChecked: 0,
      issues: [],
      contradictions: [],
    };

    // Build a map of all pages for cross-referencing
    const pageMap = new Map<string, WikiPage>();
    for (const pagePath of pages) {
      const page = this.read(pagePath);
      if (page) pageMap.set(pagePath, page);
    }

    for (const [pagePath, page] of pageMap) {
      // ── Missing frontmatter ──
      if (Object.keys(page.frontmatter).length === 0) {
        report.issues.push({
          severity: "warning",
          page: pagePath,
          message: "Missing YAML frontmatter",
          suggestion: "Add frontmatter with title, type, tags, and sources",
          autoFixable: true,
          category: "structure",
        });
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
        const hasIncoming = [...pageMap].some(([other, otherPage]) => {
          if (other === pagePath) return false;
          // Match by basename slug or full relative path slug
          return otherPage.links.includes(slug) || otherPage.links.includes(fullSlug);
        });
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
        // Direct match by relative path
        if (pages.includes(linkPath) || pages.includes(link)) continue;
        // Basename match: [[slug]] resolves to any "topic/slug.md"
        const matchByBasename = pages.some(
          (p) => basename(p, extname(p)) === link || basename(p, extname(p)) === link.replace(/\.md$/, ""),
        );
        if (!matchByBasename) {
          report.issues.push({
            severity: "error",
            page: pagePath,
            message: `Broken link: [[${link}]]`,
            suggestion: `Create ${link}.md or fix the link`,
            autoFixable: false,
            category: "broken-link",
          });
        }
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
          const found =
            pages.includes(srcPath) ||
            pages.includes(src) ||
            pages.some((p) => basename(p, extname(p)) === src || basename(p, extname(p)) === src.replace(/\.md$/, ""));
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

    // ── Raw file integrity ──
    if (this.config.lint.checkIntegrity) {
      const rawResults = this.rawVerify();
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
    }

    this.log("lint", "—", `Checked ${report.pagesChecked} pages + ${report.rawChecked} raw files, found ${report.issues.length} issues (${report.contradictions.length} contradictions)`);
    return report;
  }

  // ── Contradiction detection ───────────────────────────────────

  /** Detect contradictions between pages.
   *  Looks for numeric claims, date claims, and factual statements
   *  that conflict across pages about the same entity/topic. */
  private detectContradictions(pageMap: Map<string, WikiPage>): Contradiction[] {
    const contradictions: Contradiction[] = [];

    // Extract claims from pages — look for patterns like "X is Y", dates, numbers
    const claims = new Map<string, Array<{ page: string; excerpt: string; value: string }>>();

    for (const [pagePath, page] of pageMap) {
      if (isSystemPage(pagePath)) continue;

      // Extract date claims: "published in YYYY", "released YYYY", "founded YYYY"
      const datePatterns = page.content.matchAll(
        /(?:published|released|founded|created|introduced|launched|announced|born|died)\s+(?:in\s+)?(\d{4})/gi
      );
      for (const m of datePatterns) {
        const key = m[0]!.replace(/\d{4}/, "YEAR").toLowerCase().trim();
        const entry = { page: pagePath, excerpt: m[0]!, value: m[1]! };
        if (!claims.has(key)) claims.set(key, []);
        claims.get(key)!.push(entry);
      }

      // Extract numeric claims: "achieved XX% mAP", "XX FPS", "XX parameters"
      const numericPatterns = page.content.matchAll(
        /(\d+\.?\d*)\s*(%|fps|ms|map|ap|parameters|params|layers|million|billion|m\b|b\b|k\b)/gi
      );
      for (const m of numericPatterns) {
        // Context: 30 chars before and after
        const idx = page.content.indexOf(m[0]!);
        const ctxStart = Math.max(0, idx - 30);
        const ctxEnd = Math.min(page.content.length, idx + m[0]!.length + 30);
        const context = page.content.slice(ctxStart, ctxEnd).replace(/\n/g, " ").trim();

        // Key = normalized context without the number
        const key = context.replace(/\d+\.?\d*/g, "N").toLowerCase().slice(0, 60);
        const entry = { page: pagePath, excerpt: context, value: m[1]! };
        if (!claims.has(key)) claims.set(key, []);
        claims.get(key)!.push(entry);
      }
    }

    // Compare claims from different pages
    for (const [claimKey, entries] of claims) {
      if (entries.length < 2) continue;

      // Group by page
      const byPage = new Map<string, typeof entries[0]>();
      for (const e of entries) {
        if (!byPage.has(e.page)) byPage.set(e.page, e);
      }
      const uniquePages = [...byPage.values()];
      if (uniquePages.length < 2) continue;

      // Check if values differ
      for (let i = 0; i < uniquePages.length; i++) {
        for (let j = i + 1; j < uniquePages.length; j++) {
          const a = uniquePages[i]!;
          const b = uniquePages[j]!;
          if (a.value !== b.value) {
            contradictions.push({
              claim: claimKey.replace(/\bn\b/gi, "?"),
              pageA: a.page,
              excerptA: a.excerpt,
              pageB: b.page,
              excerptB: b.excerpt,
              severity: Math.abs(parseFloat(a.value) - parseFloat(b.value)) > 10 ? "error" : "warning",
            });
          }
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
  rebuildIndex(): void {
    const pages = this.listAllPages().filter((p) => !isSystemPage(p));
    let rawCount = 0;
    try {
      rawCount = this.rawList().length;
    } catch { /* no raw dir */ }

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
        this.rebuildTopicIndex(topic, tPages, now);
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
          const page = this.read(pagePath);
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
        const page = this.read(pagePath);
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

    this.log("rebuild-index", "index.md", `Rebuilt index with ${pages.length} pages`);
  }

  /** Rebuild a topic sub-index at {topic}/index.md. */
  private rebuildTopicIndex(topic: string, topicPages: string[], now: string): void {
    const categories: Record<string, string[]> = {};
    for (const pagePath of topicPages) {
      const page = this.read(pagePath);
      if (!page) continue;
      const type = page.type ?? "uncategorized";
      if (!categories[type]) categories[type] = [];
      const slug = basename(pagePath, extname(pagePath));
      const updated = page.updated ? ` _(${page.updated.slice(0, 10)})_` : "";
      categories[type]!.push(`- [[${topic}/${slug}]] — ${page.title}${updated}`);
    }

    const topicIndexPath = `${topic}/index.md`;
    const existing = this.read(topicIndexPath);
    const label = topic.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

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
      `_${topicPages.length} pages_`,
      "",
    ];

    for (const type of Object.keys(categories).sort()) {
      const typeLabel = type.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
      lines.push(`## ${typeLabel} (${categories[type]!.length})`, "");
      lines.push(...categories[type]!, "");
    }

    lines.push("---", "", `_Last rebuilt: ${now.replace("T", " ").slice(0, 16)} UTC_`, "");

    const fullPath = join(this.config.wikiDir, topicIndexPath);
    mkdirSync(dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, lines.join("\n"));
  }

  // ── Timeline ──────────────────────────────────────────────────

  /** Rebuild timeline.md — chronological view of all knowledge. */
  rebuildTimeline(): void {
    const pages = this.listAllPages().filter((p) => !isSystemPage(p));
    const entries: Array<{ date: string; page: string; title: string; type: string }> = [];

    for (const pagePath of pages) {
      const page = this.read(pagePath);
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
    const links = [...linkMatches].map((m) => m[1]!);

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

/** Extract text from document files using pure Node.js libraries (no Python). */
async function extractTextNode(filePath: string): Promise<string> {
  const ext = extname(filePath).toLowerCase();

  if (ext === ".pdf") {
    const pdfParse = (await import("pdf-parse")).default;
    const buf = readFileSync(filePath);
    const data = await pdfParse(buf);
    return data.text;
  }

  if (ext === ".docx") {
    const mammoth = await import("mammoth");
    const result = await mammoth.extractRawText({ path: filePath });
    return result.value;
  }

  if (ext === ".xlsx") {
    const XLSX = await import("xlsx");
    const wb = XLSX.readFile(filePath);
    const sheets: string[] = [];
    for (const name of wb.SheetNames) {
      const ws = wb.Sheets[name];
      if (!ws) continue;
      const csv = XLSX.utils.sheet_to_csv(ws);
      if (csv.trim()) {
        sheets.push(`--- Sheet: ${name} ---\n${csv.trim()}`);
      }
    }
    return sheets.join("\n\n");
  }

  if (ext === ".pptx") {
    const AdmZip = (await import("adm-zip")).default;
    const zip = new AdmZip(filePath);
    const slides: string[] = [];
    const entries = zip.getEntries()
      .filter(e => /^ppt\/slides\/slide\d+\.xml$/.test(e.entryName))
      .sort((a, b) => a.entryName.localeCompare(b.entryName, undefined, { numeric: true }));
    for (const entry of entries) {
      const xml = entry.getData().toString("utf-8");
      // Strip XML tags, keep text content
      const text = xml.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
      if (text) {
        const num = entry.entryName.match(/slide(\d+)/)?.[1] ?? "?";
        slides.push(`--- Slide ${num} ---\n${text}`);
      }
    }
    return slides.join("\n\n");
  }

  if (ext === ".html" || ext === ".htm") {
    const html = readFileSync(filePath, "utf-8");
    // Strip script/style blocks, then tags
    const cleaned = html
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<[^>]+>/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    return cleaned;
  }

  throw new Error(`Unsupported document format: ${ext}`);
}

function guessMime(filename: string): string {
  const ext = extname(filename).toLowerCase();
  const map: Record<string, string> = {
    // Text
    ".md": "text/markdown",
    ".txt": "text/plain",
    ".html": "text/html",
    ".htm": "text/html",
    ".css": "text/css",
    ".js": "text/javascript",
    ".ts": "text/javascript",
    ".csv": "text/csv",
    ".xml": "text/xml",
    ".json": "application/json",
    ".yaml": "text/yaml",
    ".yml": "text/yaml",
    ".toml": "text/plain",
    ".ini": "text/plain",
    ".log": "text/plain",
    ".sh": "text/x-shellscript",
    ".py": "text/x-python",
    ".java": "text/x-java",
    ".c": "text/x-c",
    ".cpp": "text/x-c++",
    ".rs": "text/x-rust",
    ".go": "text/x-go",
    ".rb": "text/x-ruby",
    ".sql": "application/sql",
    ".r": "text/plain",
    // Documents
    ".pdf": "application/pdf",
    ".rtf": "application/rtf",
    ".epub": "application/epub+zip",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".doc": "application/msword",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".xls": "application/vnd.ms-excel",
    ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ".ppt": "application/vnd.ms-powerpoint",
    // Images
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".svg": "image/svg+xml",
    ".webp": "image/webp",
    ".avif": "image/avif",
    ".bmp": "image/bmp",
    ".ico": "image/x-icon",
    ".tiff": "image/tiff",
    ".tif": "image/tiff",
    // Audio
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
    ".ogg": "audio/ogg",
    ".flac": "audio/flac",
    ".aac": "audio/aac",
    ".m4a": "audio/mp4",
    // Video
    ".mp4": "video/mp4",
    ".webm": "video/webm",
    ".mkv": "video/x-matroska",
    ".mov": "video/quicktime",
    ".avi": "video/x-msvideo",
    // Archives
    ".zip": "application/zip",
    ".gz": "application/gzip",
    ".tar": "application/x-tar",
    ".7z": "application/x-7z-compressed",
    ".rar": "application/x-rar-compressed",
    ".bz2": "application/x-bzip2",
    // Data / other
    ".wasm": "application/wasm",
    ".sqlite": "application/x-sqlite3",
    ".db": "application/x-sqlite3",
    ".parquet": "application/octet-stream",
    ".arrow": "application/octet-stream",
  };
  return map[ext] ?? "application/octet-stream";
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
function matchSimpleGlob(filepath: string, pattern: string): boolean {
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
