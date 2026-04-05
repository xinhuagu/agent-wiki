/**
 * agent-wiki — Agent-driven knowledge base.
 *
 * Architecture (Karpathy LLM Wiki pattern):
 *
 *   raw/     — Immutable sources. Write-once, never modified. SHA-256 verified.
 *   wiki/    — Mutable knowledge. System pages, entity pages, synthesis pages.
 *   schemas/ — Entity templates.
 *
 * No LLM dependency. Your agent IS the LLM.
 * This package provides:
 *   - Raw document management (immutable, integrity-checked)
 *   - Wiki CRUD with auto-timestamping
 *   - Keyword search with relevance scoring
 *   - Lint with contradiction detection and integrity checks
 *   - Knowledge synthesis preparation
 *   - MCP server interface
 *
 * Usage as MCP server:
 *   npx agent-wiki
 *
 * Usage as library:
 *   import { Wiki } from "agent-wiki";
 *   const wiki = new Wiki("/path/to/kb");
 *   wiki.rawAdd("paper.md", { content: "...", sourceUrl: "..." });
 *   wiki.write("concept-gil.md", content);
 *   const results = wiki.search("python");
 *   const report = wiki.lint();  // contradiction detection included
 */

export { Wiki } from "./wiki.js";
export type {
  WikiPage,
  RawDocument,
  LintIssue,
  LintReport,
  Contradiction,
  TimelineEntry,
  WikiConfig,
} from "./wiki.js";
export { createServer, runServer } from "./server.js";
