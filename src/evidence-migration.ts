/**
 * Evidence-first phase 2a — one-shot migration that classifies every
 * pre-existing wiki page so the new "unsupported / synthesis / grounded"
 * vocabulary doesn't drown in false positives the day phase 2a deploys.
 *
 * Classification rules (in order — first match wins):
 *   1. `type: synthesis` already in frontmatter      → leave alone (legit)
 *   2. Page lives under `wiki/<plugin-id>/...`       → add `synthesis: true`
 *      (compiler-generated artifact)
 *   3. `sources: [...]` is non-empty                 → leave alone (grounded)
 *   4. Anything else (pre-existing user-authored,
 *      no sources, no synthesis flag)                → add `legacyUnsupported: true`
 *
 * Runs at most once per workspace, gated by a marker file under
 * .agent-wiki/. Subsequent rebuilds short-circuit immediately.
 *
 * See docs/evidence-envelope.md ("Synthesis-page grandfather migration").
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Wiki } from "./wiki.js";
import { evidenceDir, migrationMarkerPath } from "./evidence-write-log.js";

export interface MigrationResult {
  alreadyMigrated: boolean;
  totalPages: number;
  syntheses: number;          // pages marked synthesis: true (rule 2)
  grounded: number;           // pages with non-empty sources (rule 3, no change)
  legacy: number;             // pages marked legacyUnsupported: true (rule 4)
  preExistingSynthesis: number; // pages with type: synthesis (rule 1, no change)
}

/**
 * Run the one-shot migration. Idempotent: if the marker file exists the
 * function returns `alreadyMigrated: true` and touches nothing.
 *
 * Plugin IDs are passed in (not imported) so this module stays decoupled
 * from the plugin registry; the caller (typically wiki_admin rebuild)
 * supplies them.
 */
export function migrateExistingPagesForEvidence(
  wiki: Wiki,
  pluginIds: string[],
): MigrationResult {
  const marker = migrationMarkerPath(wiki.config.workspace);
  if (existsSync(marker)) {
    return {
      alreadyMigrated: true,
      totalPages: 0,
      syntheses: 0,
      grounded: 0,
      legacy: 0,
      preExistingSynthesis: 0,
    };
  }

  const result: MigrationResult = {
    alreadyMigrated: false,
    totalPages: 0,
    syntheses: 0,
    grounded: 0,
    legacy: 0,
    preExistingSynthesis: 0,
  };

  const pluginPathPrefixes = pluginIds.map((id) => `${id}/`);

  for (const pagePath of wiki.listAllPages()) {
    if (isSystemIndex(pagePath)) continue;
    const page = wiki.read(pagePath);
    if (!page) continue;
    result.totalPages++;

    const fm = page.frontmatter;
    const sources = Array.isArray(fm.sources) ? (fm.sources as unknown[]) : [];

    // Rule 1: type: synthesis is the pre-existing convention — already legit.
    if (fm.type === "synthesis") {
      result.preExistingSynthesis++;
      continue;
    }

    // Rule 2: compiler-generated artifact under wiki/<plugin-id>/...
    const isPluginArtifact = pluginPathPrefixes.some((prefix) => pagePath.startsWith(prefix));
    if (isPluginArtifact && fm.synthesis !== true) {
      writeWithFrontmatterPatch(wiki, pagePath, page.content, fm, { synthesis: true });
      result.syntheses++;
      continue;
    }
    if (isPluginArtifact) {
      // Already had synthesis: true — count under syntheses but no change needed.
      result.syntheses++;
      continue;
    }

    // Rule 3: grounded — has sources.
    if (sources.length > 0) {
      result.grounded++;
      continue;
    }

    // Rule 4: legacy unsupported — pre-existing page without sources/synthesis.
    writeWithFrontmatterPatch(wiki, pagePath, page.content, fm, { legacyUnsupported: true });
    result.legacy++;
  }

  // Mark migration done.
  mkdirSync(evidenceDir(wiki.config.workspace), { recursive: true });
  writeFileSync(marker, new Date().toISOString());

  return result;
}

function isSystemIndex(pagePath: string): boolean {
  // Auto-generated indexes: top-level index.md, log.md, timeline.md, and any
  // nested */index.md. These are managed by the rebuild loop, not user content.
  return (
    pagePath === "index.md" ||
    pagePath === "log.md" ||
    pagePath === "timeline.md" ||
    pagePath.endsWith("/index.md")
  );
}

function writeWithFrontmatterPatch(
  wiki: Wiki,
  pagePath: string,
  body: string,
  existingFrontmatter: Record<string, unknown>,
  patch: Record<string, unknown>,
): void {
  // Reconstruct the page with the patched frontmatter and route through
  // wiki.write() so the search index, title cache, and log all stay
  // in sync. wiki.write()'s phase-2a classifier respects the new
  // markers (synthesis / legacyUnsupported), so it won't re-stamp the
  // page as "unsupported" on top of the migration patch.
  const merged = { ...existingFrontmatter, ...patch };
  const fmYaml = stringifyFrontmatter(merged);
  wiki.write(pagePath, `---\n${fmYaml}---\n${body}`);
}

function stringifyFrontmatter(data: Record<string, unknown>): string {
  // gray-matter's stringify is asymmetric with parse; build the YAML
  // ourselves so the migration write produces deterministic output.
  // Keep this minimal — only the fields we know we touch — and let
  // wiki.write() pass it through gray-matter for the final form.
  const lines: string[] = [];
  for (const [k, v] of Object.entries(data)) {
    if (v === undefined) continue;
    lines.push(formatYamlPair(k, v));
  }
  return lines.join("\n") + "\n";
}

function formatYamlPair(key: string, value: unknown): string {
  if (value === null) return `${key}: null`;
  if (typeof value === "boolean" || typeof value === "number") return `${key}: ${value}`;
  if (typeof value === "string") {
    // Quote if string contains characters that would break YAML parsing.
    if (/[:#&*!|>'"%@`]|^\s|\s$|^[\d-]/.test(value)) {
      return `${key}: ${JSON.stringify(value)}`;
    }
    return `${key}: ${value}`;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return `${key}: []`;
    const items = value
      .map((v) =>
        typeof v === "string" && !/[:#&*!|>'"%@`]/.test(v) ? v : JSON.stringify(v)
      )
      .join(", ");
    return `${key}: [${items}]`;
  }
  // Fallback to JSON for objects.
  return `${key}: ${JSON.stringify(value)}`;
}
