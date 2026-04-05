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

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, unlinkSync, statSync, copyFileSync } from "node:fs";
import { join, relative, resolve, basename, extname, dirname } from "node:path";
import { createHash } from "node:crypto";
import matter from "gray-matter";
import yaml from "js-yaml";

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
  root: string;
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
}

// System pages that lint should treat specially
const SYSTEM_PAGES = new Set(["index.md", "log.md", "timeline.md"]);

// ── Wiki Class ────────────────────────────────────────────────────

export class Wiki {
  readonly config: WikiConfig;

  constructor(root?: string) {
    const resolvedRoot = resolve(root ?? ".");
    this.config = Wiki.loadConfig(resolvedRoot);
  }

  // ── Init ──────────────────────────────────────────────────────

  static init(path: string): Wiki {
    const root = resolve(path);
    const wikiDir = join(root, "wiki");
    const rawDir = join(root, "raw");
    const schemasDir = join(root, "schemas");

    for (const dir of [root, wikiDir, rawDir, schemasDir]) {
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

    // default config
    const configData = {
      version: "2",
      wiki: { path: "wiki/", raw_path: "raw/", schemas_path: "schemas/" },
      lint: {
        check_orphans: true,
        check_stale_days: 30,
        check_missing_sources: true,
        check_contradictions: true,
        check_integrity: true,
      },
    };
    writeFileSync(join(root, ".agent-wiki.yaml"), yaml.dump(configData, { lineWidth: 100 }));

    // default schemas
    writeDefaultSchemas(schemasDir);

    // .gitignore
    writeFileSync(join(root, ".gitignore"), "node_modules/\ndist/\n.env\n");

    return new Wiki(root);
  }

  // ── Config ────────────────────────────────────────────────────

  static loadConfig(root: string): WikiConfig {
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

    return {
      root,
      wikiDir: join(root, wikiData.path ?? "wiki"),
      rawDir: join(root, wikiData.raw_path ?? "raw"),
      schemasDir: join(root, wikiData.schemas_path ?? "schemas"),
      lint: {
        checkOrphans: (lintData.check_orphans as boolean) ?? true,
        checkStaleDays: (lintData.check_stale_days as number) ?? 30,
        checkMissingSources: (lintData.check_missing_sources as boolean) ?? true,
        checkContradictions: (lintData.check_contradictions as boolean) ?? true,
        checkIntegrity: (lintData.check_integrity as boolean) ?? true,
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
    }
  ): RawDocument {
    const rawPath = join(this.config.rawDir, filename);
    const metaPath = rawPath + ".meta.yaml";

    // Immutability guard — never overwrite existing raw files
    if (existsSync(rawPath)) {
      throw new Error(`Raw file already exists: ${filename}. Raw files are immutable.`);
    }

    mkdirSync(dirname(rawPath), { recursive: true });

    // Write content
    if (opts.content !== undefined) {
      writeFileSync(rawPath, opts.content);
    } else if (opts.sourcePath && existsSync(opts.sourcePath)) {
      copyFileSync(opts.sourcePath, rawPath);
    } else {
      throw new Error("Either content or a valid sourcePath is required");
    }

    // Compute hash and size
    const buf = readFileSync(rawPath);
    const sha256 = createHash("sha256").update(buf).digest("hex");
    const size = buf.length;

    const now = new Date().toISOString();
    const doc: RawDocument = {
      path: filename,
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

    this.log("raw-add", filename, `Added raw: ${filename} (${formatBytes(size)}, sha256:${sha256.slice(0, 12)}...)`);
    return doc;
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

  /** Read a raw document's content. */
  rawRead(filename: string): { content: string; meta: RawDocument | null } | null {
    const fullPath = join(this.config.rawDir, filename);
    if (!existsSync(fullPath)) return null;

    const content = readFileSync(fullPath, "utf-8");
    const metaPath = fullPath + ".meta.yaml";
    const meta = existsSync(metaPath)
      ? (yaml.load(readFileSync(metaPath, "utf-8")) as RawDocument)
      : null;

    return { content, meta };
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

  // ═══════════════════════════════════════════════════════════════
  //  WIKI LAYER — Mutable compiled knowledge
  // ═══════════════════════════════════════════════════════════════

  // ── CRUD ──────────────────────────────────────────────────────

  /** Read a wiki page. Returns null if not found. */
  read(pagePath: string): WikiPage | null {
    const fullPath = join(this.config.wikiDir, pagePath);
    if (!existsSync(fullPath)) {
      const withMd = fullPath.endsWith(".md") ? fullPath : fullPath + ".md";
      if (!existsSync(withMd)) return null;
      return this.parsePage(relative(this.config.wikiDir, withMd), readFileSync(withMd, "utf-8"));
    }
    return this.parsePage(pagePath, readFileSync(fullPath, "utf-8"));
  }

  /** Write (create or update) a wiki page. Content must include frontmatter.
   *  Automatically injects/updates created and updated timestamps. */
  write(pagePath: string, content: string, source?: string): void {
    const fullPath = join(this.config.wikiDir, pagePath);
    const dir = dirname(fullPath);
    mkdirSync(dir, { recursive: true });

    const now = new Date().toISOString();

    // Parse incoming content to inject timestamps
    const parsed = matter(content);
    if (!parsed.data.created) {
      // Check if page already exists — preserve original created time
      if (existsSync(fullPath)) {
        const existing = matter(readFileSync(fullPath, "utf-8"));
        parsed.data.created = existing.data.created ?? now;
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

  /** Delete a wiki page. Returns true if it existed. */
  delete(pagePath: string): boolean {
    // Guard: never delete system pages
    if (SYSTEM_PAGES.has(pagePath)) {
      throw new Error(`Cannot delete system page: ${pagePath}`);
    }
    const fullPath = join(this.config.wikiDir, pagePath);
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
      if (this.config.lint.checkOrphans && !SYSTEM_PAGES.has(pagePath)) {
        const slug = basename(pagePath, extname(pagePath));
        const hasIncoming = [...pageMap].some(([other, otherPage]) => {
          if (other === pagePath) return false;
          return otherPage.links.includes(slug);
        });
        if (!hasIncoming) {
          report.issues.push({
            severity: "warning",
            page: pagePath,
            message: "Orphan page — no other pages link here",
            suggestion: `Add [[${slug}]] to related pages or index.md`,
            autoFixable: true,
            category: "orphan",
          });
        }
      }

      // ── Broken links ──
      for (const link of page.links) {
        const linkPath = link.endsWith(".md") ? link : link + ".md";
        if (!pages.includes(linkPath) && !pages.includes(link)) {
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
      if (this.config.lint.checkMissingSources && !SYSTEM_PAGES.has(pagePath)) {
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
          if (!pages.includes(srcPath) && !pages.includes(src)) {
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
      if (SYSTEM_PAGES.has(pagePath)) continue;

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
      person: 0, concept: 0, event: 0, artifact: 0,
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

  /** Rebuild index.md from all pages. Groups by type with page counts. */
  rebuildIndex(): void {
    const pages = this.listAllPages().filter((p) => !SYSTEM_PAGES.has(p));
    const categories: Record<string, string[]> = {};
    let rawCount = 0;
    try {
      rawCount = this.rawList().length;
    } catch { /* no raw dir */ }

    for (const pagePath of pages) {
      const page = this.read(pagePath);
      if (!page) continue;
      const type = page.type ?? "uncategorized";
      if (!categories[type]) categories[type] = [];
      const slug = basename(pagePath, extname(pagePath));
      const updated = page.updated ? ` _(${page.updated.slice(0, 10)})_` : "";
      categories[type].push(`- [[${slug}]] — ${page.title}${updated}`);
    }

    const now = new Date().toISOString();
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
        lines.push(`## ${label} (${categories[type]!.length})`);
        lines.push("");
        lines.push(...categories[type]!);
        lines.push("");
      }
    } else {
      lines.push("_No pages yet._");
      lines.push("");
    }

    lines.push("---", "", `_Last rebuilt: ${now.replace("T", " ").slice(0, 16)} UTC_`, "");

    writeFileSync(join(this.config.wikiDir, "index.md"), lines.join("\n"));
    this.log("rebuild-index", "index.md", `Rebuilt index with ${pages.length} pages`);
  }

  // ── Timeline ──────────────────────────────────────────────────

  /** Rebuild timeline.md — chronological view of all knowledge. */
  rebuildTimeline(): void {
    const pages = this.listAllPages().filter((p) => !SYSTEM_PAGES.has(p));
    const entries: Array<{ date: string; page: string; title: string; type: string }> = [];

    for (const pagePath of pages) {
      const page = this.read(pagePath);
      if (!page) continue;
      const date = page.created ?? page.updated ?? "unknown";
      entries.push({
        date: date.slice(0, 10),
        page: basename(pagePath, extname(pagePath)),
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
      created: fm.created as string | undefined,
      updated: fm.updated as string | undefined,
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
      result.push(relative(root, full));
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
      result.push(relative(root, full));
    }
  }
  return result.sort();
}

function guessMime(filename: string): string {
  const ext = extname(filename).toLowerCase();
  const map: Record<string, string> = {
    ".md": "text/markdown",
    ".txt": "text/plain",
    ".pdf": "application/pdf",
    ".html": "text/html",
    ".json": "application/json",
    ".yaml": "text/yaml",
    ".yml": "text/yaml",
    ".csv": "text/csv",
    ".xml": "text/xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".svg": "image/svg+xml",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
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
