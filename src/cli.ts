#!/usr/bin/env node

/**
 * CLI entry point for agent-wiki.
 *
 * Usage:
 *   npx agent-wiki                  # start MCP server (stdio)
 *   npx agent-wiki --wiki-path /kb  # custom wiki root
 *   npx agent-wiki init ./my-kb     # initialize a new knowledge base
 */

import { Command } from "commander";
import { Wiki } from "./wiki.js";
import { runServer } from "./server.js";

const program = new Command();

program
  .name("agent-wiki")
  .description(
    "Agent-driven knowledge base — structured Markdown wiki with MCP server.\n" +
    "raw/ = immutable sources | wiki/ = mutable knowledge | schemas/ = templates"
  )
  .version("0.2.0");

// Default command: start MCP server
program
  .command("serve", { isDefault: true })
  .description("Start MCP server (stdio transport)")
  .option("-w, --wiki-path <path>", "Path to wiki root", ".")
  .action(async (opts: { wikiPath: string }) => {
    await runServer(opts.wikiPath);
  });

// Init
program
  .command("init [path]")
  .description("Initialize a new knowledge base")
  .action((path?: string) => {
    const target = path ?? ".";
    Wiki.init(target);
    console.error(`Knowledge base initialized at ${target}`);
    console.error("  wiki/     — Mutable Markdown pages (agent-managed)");
    console.error("  raw/      — Immutable source documents (write-once)");
    console.error("  schemas/  — Entity templates (person, concept, event, ...)");
  });

// Search
program
  .command("search <query>")
  .description("Search wiki pages by keyword")
  .option("-w, --wiki-path <path>", "Path to wiki root", ".")
  .option("-n, --limit <n>", "Max results", "10")
  .action((query: string, opts: { wikiPath: string; limit: string }) => {
    const wiki = new Wiki(opts.wikiPath);
    const results = wiki.search(query, parseInt(opts.limit));
    if (results.length === 0) {
      console.log("No matches.");
      return;
    }
    for (const r of results) {
      console.log(`  [${r.score}] ${r.path}`);
      console.log(`       ${r.snippet}`);
    }
  });

// List wiki pages
program
  .command("list")
  .description("List all wiki pages")
  .option("-w, --wiki-path <path>", "Path to wiki root", ".")
  .option("-t, --type <type>", "Filter by entity type")
  .option("--tag <tag>", "Filter by tag")
  .action((opts: { wikiPath: string; type?: string; tag?: string }) => {
    const wiki = new Wiki(opts.wikiPath);
    const pages = wiki.list(opts.type, opts.tag);
    if (pages.length === 0) {
      console.log("No pages.");
      return;
    }
    console.log(`${pages.length} pages:`);
    for (const p of pages) {
      console.log(`  ${p}`);
    }
  });

// List raw sources
program
  .command("raw-list")
  .description("List all raw source documents")
  .option("-w, --wiki-path <path>", "Path to wiki root", ".")
  .action((opts: { wikiPath: string }) => {
    const wiki = new Wiki(opts.wikiPath);
    const docs = wiki.rawList();
    if (docs.length === 0) {
      console.log("No raw documents.");
      return;
    }
    console.log(`${docs.length} raw documents:`);
    for (const d of docs) {
      const url = d.sourceUrl ? ` (${d.sourceUrl})` : "";
      console.log(`  ${d.path} — ${formatBytes(d.size)}${url}`);
    }
  });

// Verify raw integrity
program
  .command("raw-verify")
  .description("Verify integrity of raw source documents (SHA-256)")
  .option("-w, --wiki-path <path>", "Path to wiki root", ".")
  .action((opts: { wikiPath: string }) => {
    const wiki = new Wiki(opts.wikiPath);
    const results = wiki.rawVerify();
    if (results.length === 0) {
      console.log("No raw documents to verify.");
      return;
    }
    let ok = 0, bad = 0, noMeta = 0;
    for (const r of results) {
      if (r.status === "ok") { ok++; }
      else if (r.status === "corrupted") {
        bad++;
        console.log(`  [CORRUPT] ${r.path}`);
      } else {
        noMeta++;
        console.log(`  [NO META] ${r.path}`);
      }
    }
    console.log(`\n${ok} ok, ${bad} corrupted, ${noMeta} missing metadata`);
  });

// Lint
program
  .command("lint")
  .description("Run health checks (contradictions, orphans, broken links, integrity)")
  .option("-w, --wiki-path <path>", "Path to wiki root", ".")
  .action((opts: { wikiPath: string }) => {
    const wiki = new Wiki(opts.wikiPath);
    const report = wiki.lint();
    if (report.issues.length === 0) {
      console.log(`All ${report.pagesChecked} pages + ${report.rawChecked} raw files healthy.`);
      return;
    }
    console.log(`Checked ${report.pagesChecked} pages + ${report.rawChecked} raw files\n`);

    if (report.contradictions.length > 0) {
      console.log(`Contradictions (${report.contradictions.length}):`);
      for (const c of report.contradictions) {
        console.log(`  ${c.pageA} vs ${c.pageB}: ${c.claim}`);
        console.log(`    "${c.excerptA}" vs "${c.excerptB}"`);
      }
      console.log();
    }

    const grouped: Record<string, typeof report.issues> = {};
    for (const issue of report.issues) {
      const cat = issue.category ?? "other";
      if (!grouped[cat]) grouped[cat] = [];
      grouped[cat].push(issue);
    }
    for (const [cat, issues] of Object.entries(grouped)) {
      console.log(`${cat} (${issues.length}):`);
      for (const issue of issues) {
        const icon = issue.severity === "error" ? "ERR" : issue.severity === "warning" ? "WARN" : "INFO";
        console.log(`  [${icon}] ${issue.page}: ${issue.message}`);
        if (issue.suggestion) console.log(`         -> ${issue.suggestion}`);
      }
      console.log();
    }
  });

program.parse();

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
