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
    "Agent-driven knowledge base — structured Markdown wiki with MCP server. No LLM, your agent IS the LLM."
  )
  .version("0.1.0");

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
    console.error("  wiki/     — Markdown pages (agent-managed)");
    console.error("  raw/      — Source documents (immutable)");
    console.error("  schemas/  — Entity templates");
  });

// Search (for quick CLI testing)
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

// List
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

// Lint
program
  .command("lint")
  .description("Run health checks on the wiki")
  .option("-w, --wiki-path <path>", "Path to wiki root", ".")
  .action((opts: { wikiPath: string }) => {
    const wiki = new Wiki(opts.wikiPath);
    const report = wiki.lint();
    if (report.issues.length === 0) {
      console.log(`All ${report.pagesChecked} pages healthy.`);
      return;
    }
    console.log(`Checked ${report.pagesChecked} pages, found ${report.issues.length} issues:\n`);
    for (const issue of report.issues) {
      const icon = issue.severity === "error" ? "ERR" : issue.severity === "warning" ? "WARN" : "INFO";
      console.log(`  [${icon}] ${issue.page}: ${issue.message}`);
      if (issue.suggestion) console.log(`         → ${issue.suggestion}`);
    }
  });

program.parse();
