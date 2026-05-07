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
import matter from "gray-matter";
import type { Wiki } from "./wiki.js";
import { evidenceDir, migrationMarkerPath } from "./evidence-write-log.js";

export interface MigrationResult {
  alreadyMigrated: boolean;
  totalPages: number;
  syntheses: number;            // pages marked synthesis: true (rule 2)
  grounded: number;             // pages with non-empty sources (rule 3, no change)
  legacy: number;               // pages marked legacyUnsupported: true (rule 4)
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
    if (isPluginArtifact) {
      if (fm.synthesis !== true) {
        writeWithFrontmatterPatch(wiki, pagePath, page.content, fm, { synthesis: true });
      }
      result.syntheses++;
      continue;
    }

    // Rule 3: grounded — has sources.
    if (sources.length > 0) {
      result.grounded++;
      continue;
    }

    // Rule 4: legacy unsupported. Also clear any prior `unsupported: true`
    // from a fresh phase-2a write so the flags don't pile up.
    writeWithFrontmatterPatch(wiki, pagePath, page.content, fm, {
      legacyUnsupported: true,
      unsupported: undefined,
    });
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
  // Apply patch — keys with `undefined` are removed; everything else overrides.
  const merged: Record<string, unknown> = { ...existingFrontmatter };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) delete merged[k];
    else merged[k] = v;
  }
  // Use gray-matter's stringify so YAML escaping matches the rest of the
  // wiki write path. Route through wiki.write() so search-index / title-cache
  // updates fire; pass `silent: true` so a multi-hundred-page migration
  // doesn't spam log.md with one entry per page (the rebuild's summary
  // line covers the migration in aggregate). `bypassEvidenceClassification`
  // is required so the classifier doesn't (a) double-fire telemetry on
  // restoration of legacy state or (b) reject the write under Phase 2b
  // reject mode — migration is internal state tagging, not assertion.
  const newContent = matter.stringify(body, merged);
  wiki.write(pagePath, newContent, undefined, {
    silent: true,
    bypassEvidenceClassification: true,
  });
}
