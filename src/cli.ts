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
import { existsSync, mkdirSync, cpSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { Wiki } from "./wiki.js";
import { runServer, handleTool } from "./server.js";
import { VERSION } from "./version.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

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
  .action(async (query: string, opts: { wikiPath: string; workspace?: string; limit: string }) => {
    const wiki = new Wiki(opts.wikiPath, opts.workspace);
    const results = wiki.config.search.hybrid
      ? await wiki.searchHybrid(query, parseInt(opts.limit))
      : wiki.search(query, parseInt(opts.limit));
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
    "Call any tool directly (bypasses MCP). Args as JSON string.\n" +
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

// ── Install as skill for various agent harnesses ─────────
program
  .command("install <target>")
  .description(
    "Install agent-wiki as a skill for an agent harness.\n" +
    "Targets:\n" +
    "  aceclaw      — Copy skill to ~/.aceclaw/skills/agent-wiki/\n" +
    "  claude-code  — Copy plugin to ~/.claude/plugins/agent-wiki/"
  )
  .option("--wiki-path <path>", "Wiki path to embed in MCP config (default: current directory)")
  .action((target: string, opts: { wikiPath?: string }) => {
    // Skill sources live next to dist/ in the package root
    const pkgRoot = join(__dirname, "..");

    /** Read version from an installed SKILL.md frontmatter. Returns null if not found. */
    function readInstalledVersion(skillPath: string): string | null {
      if (!existsSync(skillPath)) return null;
      const content = readFileSync(skillPath, "utf-8");
      const m = content.match(/^version:\s*"?([^"\n]+)"?\s*$/m);
      return m ? m[1] : null;
    }

    /** Stamp VERSION placeholder in SKILL.md content and write to dest. */
    function installSkill(src: string, dest: string): void {
      let content = readFileSync(src, "utf-8");
      content = content.replace("${VERSION}", VERSION);
      writeFileSync(dest, content);
    }

    /** Print install/upgrade status line. */
    function printStatus(destSkill: string, label: string): void {
      const oldVersion = readInstalledVersion(destSkill);
      if (oldVersion && oldVersion !== VERSION) {
        console.log(`${label} upgraded: ${oldVersion} -> ${VERSION}`);
      } else if (oldVersion === VERSION) {
        console.log(`${label} already at v${VERSION} (reinstalled)`);
      } else {
        console.log(`${label} installed: v${VERSION}`);
      }
    }

    if (target === "aceclaw") {
      const skillDir = join(homedir(), ".aceclaw", "skills", "agent-wiki");
      const destSkill = join(skillDir, "SKILL.md");
      const srcSkill = join(pkgRoot, "skills", "aceclaw", "SKILL.md");

      if (!existsSync(srcSkill)) {
        console.error(`Error: skill source not found at ${srcSkill}`);
        process.exit(1);
      }

      // Detect existing version before overwriting
      printStatus(destSkill, "Skill");

      // Copy SKILL.md with version stamp
      mkdirSync(skillDir, { recursive: true });
      installSkill(srcSkill, destSkill);
      console.log(`  ${destSkill}`);

      // Add MCP server config to ~/.aceclaw/mcp-servers.json
      const mcpPath = join(homedir(), ".aceclaw", "mcp-servers.json");
      let mcpConfig: Record<string, unknown> = {};
      if (existsSync(mcpPath)) {
        try { mcpConfig = JSON.parse(readFileSync(mcpPath, "utf-8")); } catch { /* ignore */ }
      }

      const servers = (mcpConfig.mcpServers ?? mcpConfig) as Record<string, unknown>;
      if (!servers["agent-wiki"]) {
        const wikiPath = resolve(opts.wikiPath ?? ".");
        servers["agent-wiki"] = {
          command: "npx",
          args: ["-y", "@agent-wiki/mcp-server", "serve", "--wiki-path", wikiPath],
        };
        // Write back — use mcpServers key if it was already used, else top-level
        const output = mcpConfig.mcpServers ? mcpConfig : { mcpServers: servers };
        mkdirSync(dirname(mcpPath), { recursive: true });
        writeFileSync(mcpPath, JSON.stringify(output, null, 2) + "\n");
        console.log(`MCP server added: ${mcpPath}`);
      } else {
        console.log(`MCP server already configured in ${mcpPath}`);
      }

      console.log("\nRestart AceClaw daemon to activate:");
      console.log("  aceclaw daemon restart");

    } else if (target === "claude-code") {
      const pluginDir = join(homedir(), ".claude", "plugins", "agent-wiki");
      const destSkill = join(pluginDir, "skills", "agent-wiki", "SKILL.md");
      const srcPlugin = join(pkgRoot, ".claude-plugin");
      const srcSkills = join(pkgRoot, "skills", "agent-wiki");

      if (!existsSync(srcPlugin) || !existsSync(srcSkills)) {
        console.error(`Error: plugin source not found in ${pkgRoot}`);
        process.exit(1);
      }

      // Detect existing version before overwriting
      printStatus(destSkill, "Plugin");

      // Copy plugin structure with version stamp
      mkdirSync(join(pluginDir, ".claude-plugin"), { recursive: true });
      mkdirSync(join(pluginDir, "skills", "agent-wiki", "references"), { recursive: true });
      cpSync(join(srcPlugin, "plugin.json"), join(pluginDir, ".claude-plugin", "plugin.json"));
      installSkill(join(srcSkills, "SKILL.md"), destSkill);
      const refsDir = join(srcSkills, "references");
      if (existsSync(join(refsDir, "tools-reference.md"))) {
        cpSync(join(refsDir, "tools-reference.md"), join(pluginDir, "skills", "agent-wiki", "references", "tools-reference.md"));
      }

      console.log(`  ${pluginDir}/`);
      console.log("\nEnable in Claude Code:");
      console.log("  claude --plugin-dir " + pluginDir);

    } else {
      console.error(`Unknown target: ${target}`);
      console.error("Available targets: aceclaw, claude-code");
      process.exit(1);
    }
  });

// Web — thin handoff to the optional @agent-wiki/graph-viewer package.
// Core must not import graph-viewer statically (zero-coupling constraint), so
// we resolve it at runtime and spawn it as a child process. If the package
// isn't installed, print actionable install / npx instructions and exit.
program
  .command("web")
  .description("Open the realtime 3D knowledge graph viewer (requires @agent-wiki/graph-viewer)")
  .option("-w, --wiki-path <path>", "Path to the wiki directory", ".")
  .option("-p, --port <n>", "HTTP port", "4711")
  .option("--host <host>", "Bind host", "127.0.0.1")
  .option("--open", "Open the browser on startup")
  .action((opts: { wikiPath: string; port: string; host: string; open?: boolean }) => {
    const req = createRequire(import.meta.url);
    let cliPath: string;
    try {
      cliPath = req.resolve("@agent-wiki/graph-viewer/dist/cli.js");
    } catch {
      console.error("The 3D graph viewer is not installed.");
      console.error("");
      console.error("Install globally:");
      console.error("  npm install -g @agent-wiki/graph-viewer");
      console.error("");
      console.error("Or run without installing:");
      console.error(`  npx @agent-wiki/graph-viewer --wiki-path ${opts.wikiPath}`);
      process.exit(1);
    }
    const args = ["--wiki-path", opts.wikiPath, "--port", opts.port, "--host", opts.host];
    if (opts.open) args.push("--open");
    const child = spawn(process.execPath, [cliPath, ...args], { stdio: "inherit" });
    child.on("exit", (code) => process.exit(code ?? 0));
  });

program.parse();

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
