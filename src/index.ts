/**
 * agent-wiki — Agent-driven knowledge base.
 *
 * No LLM dependency. Your agent IS the LLM.
 * This package provides structured Markdown CRUD, keyword search,
 * lint, and an MCP server interface.
 *
 * Usage as MCP server:
 *   npx agent-wiki
 *
 * Usage as library:
 *   import { Wiki } from "agent-wiki";
 *   const wiki = new Wiki("/path/to/kb");
 *   wiki.write("concept-gil.md", content);
 *   const results = wiki.search("python");
 */

export { Wiki } from "./wiki.js";
export type { WikiPage, LintIssue, LintReport, WikiConfig } from "./wiki.js";
export { createServer, runServer } from "./server.js";
