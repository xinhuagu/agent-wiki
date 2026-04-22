import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep, posix } from "node:path";
import matter from "gray-matter";
import type { ParsedPage } from "./types.js";

const LINK_RE = /\[\[([^\]]+)\]\]/g;

/** Recursively list .md files under `dir`, returning paths relative to `root` using forward slashes. */
export function listMarkdownFiles(dir: string, root: string = dir): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry.startsWith(".")) continue;
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      out.push(...listMarkdownFiles(full, root));
    } else if (stat.isFile() && entry.endsWith(".md")) {
      out.push(relative(root, full).split(sep).join(posix.sep));
    }
  }
  return out;
}

/** Extract `[[slug]]` or `[[slug|alias]]` targets from body text. */
export function extractLinks(body: string): string[] {
  const out: string[] = [];
  for (const m of body.matchAll(LINK_RE)) {
    const target = m[1]!.split("|")[0]!.trim();
    if (target) out.push(target);
  }
  return out;
}

/** Parse a single Markdown file into a ParsedPage. `relPath` uses forward slashes. */
export function parsePage(relPath: string, raw: string): ParsedPage {
  const parsed = matter(raw);
  const fm = parsed.data as Record<string, unknown>;
  const body = parsed.content;

  const slug = relPath.endsWith(".md") ? relPath.slice(0, -3) : relPath;
  const base = slug.includes("/") ? slug.slice(slug.lastIndexOf("/") + 1) : slug;
  const topic = slug.includes("/") ? slug.slice(0, slug.indexOf("/")) : "";

  return {
    path: relPath,
    slug,
    basename: base,
    title: (fm.title as string) ?? base,
    type: fm.type as string | undefined,
    tags: Array.isArray(fm.tags) ? fm.tags.map(String) : [],
    sources: Array.isArray(fm.sources) ? fm.sources.map(String) : [],
    topic,
    links: extractLinks(body),
  };
}

/** Read and parse every .md file under `wikiDir`. */
export function readWikiPages(wikiDir: string): ParsedPage[] {
  const paths = listMarkdownFiles(wikiDir);
  const out: ParsedPage[] = [];
  for (const rel of paths) {
    const raw = readFileSync(join(wikiDir, rel), "utf8");
    out.push(parsePage(rel, raw));
  }
  return out;
}
