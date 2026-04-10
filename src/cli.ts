#!/usr/bin/env node

/**
 * CLI entry point for agent-wiki.
 *
 * Usage:
 *   npx @agent-wiki/mcp-server                  # start MCP server (stdio)
 *   npx @agent-wiki/mcp-server --wiki-path /kb  # custom wiki root
 *   npx @agent-wiki/mcp-server init ./my-kb     # initialize a new knowledge base
 */

import { Command } from "commander";
import { Wiki } from "./wiki.js";
import { runServer, handleTool } from "./server.js";
import { VERSION } from "./version.js";

const program = new Command();

program
  .name("agent-wiki")
  .description(
    "Agent-driven knowledge base — structured Markdown wiki with MCP server.\n" +
    "raw/ = immutable sources | wiki/ = mutable knowledge | schemas/ = templates"
  )
  .version(VERSION)
  .option("--json", "Output JSON instead of human-readable text");

// Default command: start MCP server
program
  .command("serve", { isDefault: true })
  .description("Start MCP server (stdio transport)")
  .option("-w, --wiki-path <path>", "Path to config root (where .agent-wiki.yaml lives)", ".")
  .option("--workspace <path>", "Workspace directory for all data (wiki/, raw/, schemas/). Overrides config and env.")
  .action(async (opts: { wikiPath: string; workspace?: string }) => {
    await runServer(opts.wikiPath, opts.workspace);
  });

// Init
program
  .command("init [path]")
  .description("Initialize a new knowledge base")
  .option("--workspace <path>", "Separate workspace directory for data (wiki/, raw/, schemas/)")
  .action((path: string | undefined, opts: { workspace?: string }) => {
    const target = path ?? ".";
    const ws = opts.workspace;
    Wiki.init(target, ws);
    if (program.opts().json) {
      console.log(JSON.stringify({ ok: true, configRoot: target, workspace: ws ?? target }));
    } else {
      console.error(`Knowledge base initialized:`);
      console.error(`  Config:    ${target}/.agent-wiki.yaml`);
      if (ws) {
        console.error(`  Workspace: ${ws}/`);
      }
      console.error("  wiki/     — Mutable Markdown pages (agent-managed)");
      console.error("  raw/      — Immutable source documents (write-once)");
      console.error("  schemas/  — Entity templates (person, concept, event, ...)");
    }
  });

// Search
program
  .command("search <query>")
  .description("Search wiki pages by keyword")
  .option("-w, --wiki-path <path>", "Path to config root", ".")
  .option("--workspace <path>", "Workspace directory override")
  .option("-n, --limit <n>", "Max results", "10")
  .action((query: string, opts: { wikiPath: string; workspace?: string; limit: string }) => {
    const wiki = new Wiki(opts.wikiPath, opts.workspace);
    const results = wiki.search(query, parseInt(opts.limit));
    if (program.opts().json) {
      console.log(JSON.stringify({ results, count: results.length }, null, 2));
      return;
    }
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
  .option("-w, --wiki-path <path>", "Path to config root", ".")
  .option("--workspace <path>", "Workspace directory override")
  .option("-t, --type <type>", "Filter by entity type")
  .option("--tag <tag>", "Filter by tag")
  .action((opts: { wikiPath: string; workspace?: string; type?: string; tag?: string }) => {
    const wiki = new Wiki(opts.wikiPath, opts.workspace);
    const pages = wiki.list(opts.type, opts.tag);
    if (program.opts().json) {
      console.log(JSON.stringify({ pages, count: pages.length }, null, 2));
      return;
    }
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
  .option("-w, --wiki-path <path>", "Path to config root", ".")
  .option("--workspace <path>", "Workspace directory override")
  .action((opts: { wikiPath: string; workspace?: string }) => {
    const wiki = new Wiki(opts.wikiPath, opts.workspace);
    const docs = wiki.rawList();
    if (program.opts().json) {
      console.log(JSON.stringify({ documents: docs, count: docs.length }, null, 2));
      return;
    }
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
  .option("-w, --wiki-path <path>", "Path to config root", ".")
  .option("--workspace <path>", "Workspace directory override")
  .action((opts: { wikiPath: string; workspace?: string }) => {
    const wiki = new Wiki(opts.wikiPath, opts.workspace);
    const results = wiki.rawVerify();
    if (program.opts().json) {
      const ok = results.filter(r => r.status === "ok").length;
      const corrupted = results.filter(r => r.status === "corrupted").length;
      const missingMeta = results.filter(r => r.status === "missing-meta").length;
      console.log(JSON.stringify({ results, ok, corrupted, missingMeta }, null, 2));
      return;
    }
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
  .option("-w, --wiki-path <path>", "Path to config root", ".")
  .option("--workspace <path>", "Workspace directory override")
  .action((opts: { wikiPath: string; workspace?: string }) => {
    const wiki = new Wiki(opts.wikiPath, opts.workspace);
    const report = wiki.lint();
    if (program.opts().json) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }
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

// ── Generic tool call — direct handleTool() bypass ──────────
program
  .command("call <tool> [json]")
  .description(
    "Call any tool directly (bypasses MCP). Args as JSON string or key:=value pairs.\n" +
    "Examples:\n" +
    "  call wiki_search '{\"query\":\"BKDK\"}'\n" +
    "  call wiki_write '{\"page\":\"my-page\",\"content\":\"# Hello\"}'\n" +
    "  call wiki_read '{\"page\":\"overview\"}'\n" +
    "  call raw_add '{\"filename\":\"doc.cbl\",\"source_path\":\"/path/to/file\"}'\n" +
    "  call code_parse '{\"path\":\"GS0KBC.cbl\"}'\n" +
    "  call wiki_list\n" +
    "  call raw_list"
  )
  .option("-w, --wiki-path <path>", "Path to config root", ".")
  .option("--workspace <path>", "Workspace directory override")
  .action(async (tool: string, json: string | undefined, opts: { wikiPath: string; workspace?: string }) => {
    // Register code-analysis plugins (needed for code_parse / code_trace_variable)
    const { registerPlugin } = await import("./code-analysis.js");
    const { cobolPlugin } = await import("./cobol/plugin.js");
    registerPlugin(cobolPlugin);

    const wiki = new Wiki(opts.wikiPath, opts.workspace);
    const args: Record<string, unknown> = json ? JSON.parse(json) : {};

    try {
      const result = await handleTool(wiki, tool, args);
      if (typeof result === "string") {
        console.log(result);
      } else {
        // ContentBlock[] — print text blocks, skip image blocks
        for (const block of result) {
          if (block.type === "text") {
            console.log(block.text);
          } else if (block.type === "image") {
            console.error(`[image: ${block.mimeType}, ${block.data.length} bytes base64]`);
          }
        }
      }
    } catch (err) {
      console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  });

program.parse();

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
