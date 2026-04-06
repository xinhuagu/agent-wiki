# agent-wiki

**The knowledge base that makes AI agents smarter over time.**

Instead of retrieving raw fragments every query (RAG), your agent compiles, refines, and interlinks knowledge — like a team wiki that writes itself.

Works with Claude Code, Cursor, Windsurf, and any MCP client. No LLM built in — your agent IS the intelligence.

[![npm](https://img.shields.io/npm/v/@agent-wiki/mcp-server)](https://www.npmjs.com/package/@agent-wiki/mcp-server)
[![CI](https://github.com/xinhuagu/agent-wiki/actions/workflows/ci.yml/badge.svg)](https://github.com/xinhuagu/agent-wiki/actions/workflows/ci.yml)
[![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](https://nodejs.org)
[![MCP](https://img.shields.io/badge/protocol-MCP-blue)](https://modelcontextprotocol.io)
[![License: MIT](https://img.shields.io/badge/license-MIT-yellow.svg)](LICENSE)

## Quick Start

```bash
npx @agent-wiki/mcp-server serve --wiki-path ./my-knowledge
```

Add to your MCP client config (Claude Code, Cursor, Windsurf, Claude Desktop):

```json
{
  "mcpServers": {
    "agent-wiki": {
      "command": "npx",
      "args": ["-y", "@agent-wiki/mcp-server", "serve", "--wiki-path", "/path/to/knowledge"]
    }
  }
}
```

That's it. Your agent now has a persistent, structured knowledge base.

## Why Not RAG?

| | RAG | agent-wiki |
|---|---|---|
| **Approach** | Retrieve fragments at query time | Build and maintain compiled knowledge |
| **Memory** | Stateless — forgets after each query | Persistent — knowledge accumulates |
| **Quality** | Raw chunks, often noisy | Curated, structured, interlinked |
| **Cost** | Embedding + retrieval every query | One-time compilation, free reads |
| **Contradictions** | Invisible — buried in source docs | Flagged automatically by lint |
| **Source tracking** | Lost after retrieval | Full provenance chain (raw -> wiki) |

## Features

| Feature | Description |
|---------|-------------|
| **Immutable Sources** | SHA-256 verified `raw/` layer — write-once, tamper-proof, full provenance |
| **Knowledge Compilation** | Agent builds structured wiki pages from raw sources — not retrieve-and-forget |
| **Auto-Classification** | Zero-LLM heuristic assigns entity types and tags across 9 categories |
| **Self-Checking Lint** | Catches contradictions, broken links, orphan pages, stale content |
| **Atlassian Import** | One-command Confluence pages and Jira issues with full hierarchy |
| **File Versioning** | Auto-version same-name files, query latest, list all versions |
| **Directory Import** | Point to a folder — imports all files with optional glob filtering |
| **Document Extraction** | PDF (with per-page access), DOCX, XLSX (multi-tab), PPTX — text extracted automatically |
| **21 MCP Tools** | Full CRUD + search + synthesis + health checks |
| **Git-Native** | Plain Markdown — diffable, blameable, revertable |

## Architecture

Three immutability layers, inspired by how compilers work:

| Layer | Mutability | Role |
|-------|-----------|------|
| **raw/** | Immutable | Source documents — write-once, SHA-256 verified |
| **wiki/** | Mutable | Compiled knowledge — structured pages that improve over time |
| **schemas/** | Reference | Entity templates — consistent structure across knowledge types |

<p align="center">
  <img src="architecture.svg" alt="agent-wiki architecture" width="700" />
</p>

## Design Principles

1. **Raw is immutable** — Source documents are write-once, SHA-256 verified. Ground truth never changes.
2. **Wiki is mutable** — Compiled knowledge improves with every interaction.
3. **No LLM dependency** — Zero API keys, zero cost per operation. Your agent IS the intelligence.
4. **Self-checking** — Lint catches structural issues and flags potential contradictions.
5. **Knowledge compounds** — Every write enriches the whole wiki. Synthesis creates higher-order understanding.
6. **Provenance matters** — Every wiki claim traces back to raw sources.
7. **Git-native** — Plain Markdown. Every change is diffable, blameable, and revertable.

## Documentation

- [MCP Tools (21) & Entity Types](docs/tools.md)
- [Configuration, CLI & Security](docs/configuration.md)

## Acknowledgment

Inspired by Andrej Karpathy's [LLM Wiki](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) concept — the idea that AI agents should compile and maintain knowledge, not just retrieve raw fragments. This project is an independent, full implementation of that vision.

## License

MIT
