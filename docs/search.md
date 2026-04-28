# Search Architecture

How agent-wiki finds and ranks knowledge — from keyword matching to hybrid semantic search.

## Overview

agent-wiki search is local, deterministic, and LLM-free. It ships with a BM25 lexical engine and an optional hybrid mode that blends BM25 with dense vector similarity for semantic recall.

| Mode | Dependency | Latency | Best for |
|------|-----------|---------|----------|
| **BM25 only** (default) | None | <10ms | Exact keywords, known terms, CJK text |
| **Hybrid BM25+Vector** | `@xenova/transformers` (~90 MB model) | 50-200ms | Semantic queries, synonym-heavy domains, cross-lingual concepts |

---

## BM25 Engine

### Scoring Formula

Each wiki page is scored against the query using [Okapi BM25](https://en.wikipedia.org/wiki/Okapi_BM25) with parameters `k1=1.2, b=0.75`. Scoring runs independently across five fields with different weights:

| Field | Weight | Why |
|-------|:------:|-----|
| `title` | 4.0x | Strongest signal — a title match almost always means relevance |
| `tags` | 3.0x | Curated metadata, high precision |
| `slug` | 3.0x | File name captures topic even when title is verbose |
| `frontmatter` | 1.5x | Type, sources, dates — secondary metadata |
| `body` | 1.0x | Largest field but noisiest — baseline weight |

Final score = sum of per-field BM25 scores, weighted.

### Query Pipeline

```
User query
  │
  ├── 1. Normalize (lowercase, full-width→half-width, strip punctuation)
  │
  ├── 2. Tokenize (whitespace split for Latin; Intl.Segmenter + n-grams for CJK)
  │
  ├── 3. Expand synonyms (llm→"large language model", k8s→kubernetes, etc.)
  │     ↳ Expanded terms scored at 0.4× weight to avoid diluting exact matches
  │
  ├── 4. Postings union (O(1) lookup per term → candidate document set)
  │
  ├── 5. Prefix matching (title, tags, slug only)
  │     ↳ "deploy" matches "deployment"
  │
  ├── 6. Fuzzy matching (edit distance: 1 for 4-7 char terms, 2 for 8+)
  │     ↳ "kuberntes" matches "kubernetes" (Latin only, not CJK)
  │
  ├── 7. Score each candidate across all 5 fields
  │
  ├── 8. Exact phrase boost (+8 title, +6 slug, +3 body)
  │
  └── 9. Sort by score, return top N
```

### Built-in Synonyms

The synonym table expands common abbreviations at query time:

| Term | Expands to |
|------|-----------|
| `llm` | large language model |
| `rag` | retrieval augmented generation |
| `k8s` | kubernetes |
| `ml` | machine learning |
| `dl` | deep learning |
| `cv` | computer vision |
| `nlp` | natural language processing |
| `ci` / `cd` | continuous integration / delivery |
| `auth` | authentication, authorization |
| `api` | interface, endpoint |
| `config` | configuration |
| `deps` | dependencies |
| `infra` | infrastructure |
| `repo` | repository |
| `docs` | documentation |

Expansion is bidirectional where listed. Expanded matches receive 0.4x weight to prevent synonym flooding.

### CJK Support

For Chinese, Japanese, and Korean text:

1. **`Intl.Segmenter`** (Node 16+) performs word-level segmentation for Chinese (`zh` locale)
2. **2-gram + 3-gram fallback** captures sub-word patterns when segmenter is unavailable or for Japanese/Korean
3. CJK tokens are **not fuzzy-matched** (edit distance = 0) — character-level changes are too destructive in logographic scripts

Mixed text (e.g. "GPT-4模型架构") is split into script runs and tokenized separately.

### Inverted Index

The index is an in-memory postings map: `term → { docPath → field hit counts }`.

- **Lazy build**: constructed on first search, not on startup
- **Incremental invalidation**: `wiki_write` / `wiki_delete` marks the index stale; next search rebuilds it
- **Postings union**: only documents containing at least one query term are scored — the rest of the corpus is skipped entirely

For a wiki with 1000 pages, a typical search touches 10-50 documents, not 1000.

---

## Hybrid BM25+Vector Search

Hybrid mode re-ranks BM25 candidates using dense vector cosine similarity. This improves recall for semantic queries where the user's words don't match the wiki's terminology.

### When to use hybrid

| Scenario | BM25 alone | Hybrid |
|----------|:---:|:---:|
| Exact keyword: "kubernetes pod scheduling" | Great | Great |
| Synonym: "container orchestration" → finds kubernetes page | Good (if synonym table covers it) | Better |
| Semantic: "how does auth work" → finds "OAuth 2.0 Flow" page | Weak | Strong |
| CJK keyword: "注意力机制" | Great | Great |
| Cross-concept: "tradeoffs between latency and throughput" | Weak | Better |

**Rule of thumb**: if your wiki uses consistent terminology and your queries use the same terms, BM25 alone is sufficient. If your queries are natural-language questions or your wiki has diverse terminology, enable hybrid.

### Setup

1. Install the embedding library:

```bash
npm install @xenova/transformers
```

2. Enable in `.agent-wiki.yaml`:

```yaml
search:
  hybrid: true
```

3. Build the vector index (embeds all existing pages):

```bash
agent-wiki call wiki_admin '{"action":"rebuild"}'
```

The model (`Xenova/all-MiniLM-L6-v2`, ~90 MB) downloads automatically from HuggingFace Hub on first run and is cached locally.

After setup, every `wiki_write` automatically embeds the new/updated page — no manual steps needed.

### How it works

```
User query
  │
  ├── 1. BM25 search (same pipeline as above)
  │     ↳ Fetch 3× requested limit as candidate pool
  │
  ├── 2. Embed query → 384-dim dense vector
  │     ↳ Uses Xenova/all-MiniLM-L6-v2 sentence-transformer
  │
  ├── 3. For each candidate:
  │     ├── Normalize BM25 score to [0, 1] (min-max within candidate set)
  │     ├── Compute cosine similarity with page embedding
  │     └── Final score = bm25_weight × norm_bm25 + vector_weight × cosine
  │
  └── 4. Re-sort by final score, return top N
```

### Configuration

| Key | Default | Description |
|-----|---------|-------------|
| `search.hybrid` | `false` | Enable hybrid mode |
| `search.model` | `Xenova/all-MiniLM-L6-v2` | Sentence-transformer model for embeddings |
| `search.bm25_weight` | `0.5` | Weight for BM25 score in final blend (0-1) |
| `search.vector_weight` | `0.5` | Weight for cosine similarity in final blend (0-1) |

### Tuning weights

| Use case | `bm25_weight` | `vector_weight` | Rationale |
|----------|:---:|:---:|-----------|
| Keyword-heavy wiki (code, API docs) | 0.7 | 0.3 | Exact terms matter more than semantics |
| Natural-language wiki (meeting notes, reports) | 0.4 | 0.6 | Semantic similarity captures intent better |
| Balanced (default) | 0.5 | 0.5 | Good starting point for most wikis |
| Debugging search issues | 1.0 | 0.0 | Equivalent to pure BM25 — useful for comparison |

Weights must sum to 1.0 for consistent scoring. Adjust in `.agent-wiki.yaml` and re-run searches — no rebuild needed (weights only affect score blending, not the vector index).

### Vector index persistence

- Embeddings are saved to `wiki/.search-vectors.json`
- Loaded on startup when `hybrid: true`
- Automatically invalidated if `search.model` changes
- `wiki_write` updates the single page's embedding incrementally
- `wiki_delete` removes the page's embedding
- `wiki_admin` with `action: "rebuild"` rebuilds all embeddings from scratch

### Graceful degradation

Hybrid search never fails:

- If `@xenova/transformers` is not installed → falls back to pure BM25
- If the model download fails → falls back to pure BM25
- If a page has no embedding yet → that page is scored by BM25 only
- Error details are logged but not surfaced to the MCP client

---

## Search Result Format

Each result includes:

```json
{
  "path": "concept-transformer.md",
  "score": 12.34,
  "snippet": "...Attention is all you need. The Transformer architecture...",
  "section": "## Architecture"
}
```

| Field | Description |
|-------|-------------|
| `path` | Page path relative to `wiki/` |
| `score` | Final score (BM25 or hybrid blend). Higher = more relevant |
| `snippet` | ~150 char context window around the best matching term |
| `section` | The `## heading` containing the match (if any). Use with `wiki_read(section: ...)` for targeted reads |

### `knowledge_gap` on zero results

When search returns 0 results, the response includes a ready-to-use suggestion:

```json
{
  "results": [],
  "count": 0,
  "knowledge_gap": {
    "query": "transformer attention",
    "suggested_page": "concept-transformer-attention.md",
    "suggested_title": "Transformer Attention",
    "suggested_type": "concept",
    "suggested_tags": ["transformer", "attention-mechanism"],
    "hint": "No pages found. Use wiki_write to create ..."
  }
}
```

This eliminates the retry-search-then-create loop — the agent can directly `wiki_write` the suggested page.

---

## Performance Characteristics

| Metric | BM25 | Hybrid |
|--------|------|--------|
| Index build | ~1ms per page | Same + ~50ms per page for embedding |
| Query latency | <10ms | 50-200ms (embedding computation) |
| Memory (1000 pages) | ~5 MB (inverted index) | ~5 MB + ~1.5 MB (384-dim vectors) |
| Disk (vector index) | 0 | ~1.5 MB for 1000 pages |
| Model download | 0 | ~90 MB (one-time, cached) |
| Accuracy (keyword queries) | High | High |
| Accuracy (semantic queries) | Medium | High |

### Scaling

The BM25 index and vector store are both in-memory. For wikis up to ~10,000 pages this is fast and practical. Beyond that:

- BM25 inverted index scales linearly with corpus vocabulary size
- Vector index scales linearly with page count (384 floats per page)
- Query time scales with candidate set size, not corpus size (postings union)
