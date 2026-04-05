/**
 * Core Wiki engine — pure data layer, zero LLM dependency.
 *
 * All intelligence lives in the calling agent. This is just
 * structured Markdown CRUD + keyword search + lint.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, unlinkSync, statSync } from "node:fs";
import { join, relative, resolve, basename, extname } from "node:path";
import matter from "gray-matter";
import yaml from "js-yaml";

// ── Types ─────────────────────────────────────────────────────────

export interface WikiPage {
  path: string;          // relative to wiki/, e.g. "concept-gil.md"
  title: string;
  type?: string;         // person | concept | event | artifact | ...
  tags: string[];
  sources: string[];
  content: string;       // body without frontmatter
  frontmatter: Record<string, unknown>;
  links: string[];       // [[page]] references extracted from body
}

export interface LintIssue {
  severity: "error" | "warning" | "info";
  page: string;
  message: string;
  suggestion?: string;
  autoFixable: boolean;
}

export interface LintReport {
  pagesChecked: number;
  issues: LintIssue[];
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
  };
}

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

    // index.md
    const indexContent = `---
title: Knowledge Base Index
type: index
---

# Knowledge Base Index

## Categories

_No pages yet. Use your agent to add knowledge._

## Recent Updates

_No updates yet._
`;
    writeFileSync(join(wikiDir, "index.md"), indexContent);

    // log.md
    const now = new Date().toISOString().replace("T", " ").slice(0, 16) + " UTC";
    const logContent = `---
title: Operation Log
type: log
---

# Operation Log

| Time | Operation | Summary |
|------|-----------|---------|
| ${now} | init | Knowledge base initialized |
`;
    writeFileSync(join(wikiDir, "log.md"), logContent);

    // default config
    const configData = {
      version: "1",
      wiki: { path: "wiki/", raw_path: "raw/", schemas_path: "schemas/" },
      lint: {
        check_orphans: true,
        check_stale_days: 30,
        check_missing_sources: true,
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
      },
    };
  }

  // ── CRUD ──────────────────────────────────────────────────────

  /** Read a wiki page. Returns null if not found. */
  read(pagePath: string): WikiPage | null {
    const fullPath = join(this.config.wikiDir, pagePath);
    if (!existsSync(fullPath)) {
      // try with .md
      const withMd = fullPath.endsWith(".md") ? fullPath : fullPath + ".md";
      if (!existsSync(withMd)) return null;
      return this.parsePage(relative(this.config.wikiDir, withMd), readFileSync(withMd, "utf-8"));
    }
    return this.parsePage(pagePath, readFileSync(fullPath, "utf-8"));
  }

  /** Write (create or update) a wiki page. Content must include frontmatter. */
  write(pagePath: string, content: string, source?: string): void {
    const fullPath = join(this.config.wikiDir, pagePath);
    const dir = join(fullPath, "..");
    mkdirSync(dir, { recursive: true });
    writeFileSync(fullPath, content.trimEnd() + "\n");

    this.log("write", `Wrote ${pagePath}${source ? ` (${source})` : ""}`);
  }

  /** Delete a wiki page. Returns true if it existed. */
  delete(pagePath: string): boolean {
    const fullPath = join(this.config.wikiDir, pagePath);
    if (!existsSync(fullPath)) return false;
    unlinkSync(fullPath);
    this.log("delete", `Deleted ${pagePath}`);
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
        // count occurrences
        let idx = 0;
        while ((idx = text.indexOf(term, idx)) !== -1) {
          score++;
          idx += term.length;
        }
        // title match bonus
        if (page.title.toLowerCase().includes(term)) score += 5;
        // tag match bonus
        if (page.tags.some((t) => String(t).toLowerCase().includes(term))) score += 3;
      }

      if (score > 0) {
        // extract snippet around first match
        const firstIdx = text.indexOf(terms[0]!);
        const start = Math.max(0, firstIdx - 40);
        const end = Math.min(text.length, firstIdx + 80);
        const snippet = (start > 0 ? "..." : "") + text.slice(start, end).trim() + (end < text.length ? "..." : "");
        results.push({ path: pagePath, score, snippet });
      }
    }

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, limit);
  }

  // ── Lint ──────────────────────────────────────────────────────

  /** Run health checks. Pure rules, no LLM. */
  lint(): LintReport {
    const pages = this.listAllPages();
    const report: LintReport = { pagesChecked: pages.length, issues: [] };

    for (const pagePath of pages) {
      const page = this.read(pagePath);
      if (!page) continue;

      // Missing frontmatter
      if (Object.keys(page.frontmatter).length === 0) {
        report.issues.push({
          severity: "warning",
          page: pagePath,
          message: "Missing YAML frontmatter",
          suggestion: "Add frontmatter with title, type, tags, and sources",
          autoFixable: true,
        });
      }

      // Orphan pages
      if (this.config.lint.checkOrphans && !["index.md", "log.md"].includes(pagePath)) {
        const slug = basename(pagePath, extname(pagePath));
        const hasIncoming = pages.some((other) => {
          if (other === pagePath) return false;
          const otherPage = this.read(other);
          return otherPage?.links.includes(slug) ?? false;
        });
        if (!hasIncoming) {
          report.issues.push({
            severity: "warning",
            page: pagePath,
            message: "Orphan page — no other pages link here",
            suggestion: `Add [[${slug}]] to related pages or index.md`,
            autoFixable: true,
          });
        }
      }

      // Broken links
      for (const link of page.links) {
        const linkPath = link.endsWith(".md") ? link : link + ".md";
        if (!pages.includes(linkPath) && !pages.includes(link)) {
          report.issues.push({
            severity: "error",
            page: pagePath,
            message: `Broken link: [[${link}]]`,
            suggestion: `Create ${link}.md or fix the link`,
            autoFixable: false,
          });
        }
      }

      // Missing sources
      if (this.config.lint.checkMissingSources && page.type && page.type !== "index" && page.type !== "log") {
        if (page.sources.length === 0) {
          report.issues.push({
            severity: "info",
            page: pagePath,
            message: "No sources listed — claims are not traceable",
            suggestion: "Add sources to frontmatter",
            autoFixable: false,
          });
        }
      }

      // Stale content
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
            });
          }
        } catch {
          // stat failed, skip
        }
      }
    }

    this.log("lint", `Checked ${report.pagesChecked} pages, found ${report.issues.length} issues`);
    return report;
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
  getLog(limit = 20): Array<{ time: string; operation: string; summary: string }> {
    const logPath = join(this.config.wikiDir, "log.md");
    if (!existsSync(logPath)) return [];

    const content = readFileSync(logPath, "utf-8");
    const lines = content.split("\n").filter((l) => l.startsWith("|") && !l.startsWith("| Time") && !l.startsWith("|---"));
    const entries: Array<{ time: string; operation: string; summary: string }> = [];

    for (const line of lines) {
      const cols = line.split("|").map((c) => c.trim()).filter(Boolean);
      if (cols.length >= 3) {
        entries.push({ time: cols[0]!, operation: cols[1]!, summary: cols[2]! });
      }
    }

    return entries.slice(-limit);
  }

  // ── Index rebuild ─────────────────────────────────────────────

  /** Rebuild index.md from all pages. */
  rebuildIndex(): void {
    const pages = this.listAllPages().filter((p) => p !== "index.md" && p !== "log.md");
    const categories: Record<string, string[]> = {};

    for (const pagePath of pages) {
      const page = this.read(pagePath);
      if (!page) continue;
      const type = page.type ?? "uncategorized";
      if (!categories[type]) categories[type] = [];
      const slug = basename(pagePath, extname(pagePath));
      categories[type].push(`- [[${slug}]] — ${page.title}`);
    }

    const now = new Date().toISOString().replace("T", " ").slice(0, 16) + " UTC";
    let lines = [
      "---",
      "title: Knowledge Base Index",
      "type: index",
      "---",
      "",
      "# Knowledge Base Index",
      "",
    ];

    const sortedTypes = Object.keys(categories).sort();
    if (sortedTypes.length > 0) {
      for (const type of sortedTypes) {
        lines.push(`## ${type.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())}`);
        lines.push("");
        lines.push(...categories[type]!);
        lines.push("");
      }
    } else {
      lines.push("_No pages yet._");
      lines.push("");
    }

    lines.push("## Recent Updates", "", `_Last rebuilt: ${now}_`, "");

    writeFileSync(join(this.config.wikiDir, "index.md"), lines.join("\n"));
    this.log("rebuild-index", `Rebuilt index with ${pages.length} pages`);
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

    // Extract [[links]]
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
    };
  }

  private log(operation: string, summary: string): void {
    const logPath = join(this.config.wikiDir, "log.md");
    const now = new Date().toISOString().replace("T", " ").slice(0, 16) + " UTC";
    const entry = `| ${now} | ${operation} | ${summary} |\n`;

    if (existsSync(logPath)) {
      const content = readFileSync(logPath, "utf-8");
      writeFileSync(logPath, content + entry);
    } else {
      const header =
        "---\ntitle: Operation Log\ntype: log\n---\n\n" +
        "# Operation Log\n\n" +
        "| Time | Operation | Summary |\n" +
        "|------|-----------|--------|\n" +
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
  };

  for (const [filename, content] of Object.entries(schemas)) {
    writeFileSync(join(dir, filename), content);
  }
}
