import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "./parser.js";
import { extractModel } from "./extractors.js";
import {
  buildFieldLineage,
  type SerializedInferredFieldLineageEntry,
} from "./field-lineage.js";

/**
 * Corpus-level lineage dogfood report. The dogfood test runs this against
 * a committed real-world COBOL slice (NIST CCVS) and asserts the output
 * exactly matches a committed baseline — catches "builder started
 * emitting something the per-fixture manifests don't pin" regressions.
 */

function stripPrefix(value: string, prefix: string): string {
  return value.startsWith(prefix) ? value.slice(prefix.length) : value;
}

function entryKey(entry: SerializedInferredFieldLineageEntry): string {
  const cbs = [
    stripPrefix(entry.left.copybook.id, "copybook:"),
    stripPrefix(entry.right.copybook.id, "copybook:"),
  ].sort().join(",");
  return `${entry.fieldName}|cbs=${cbs}|leftQN=${entry.left.qualifiedName}|rightQN=${entry.right.qualifiedName}`;
}

export interface DogfoodReport {
  inferredHigh: string[];
  inferredAmbiguous: string[];
  inferredSemantic: string[];
  deterministicCount: number;
  deterministicViaReplacingCount: number;
}

export function runDogfood(corpusDir: string): DogfoodReport {
  const sources = readdirSync(corpusDir)
    .filter((n) => /\.(cbl|cob|cpy)$/i.test(n))
    .sort();
  const models = sources.flatMap((rel) => {
    const src = readFileSync(join(corpusDir, rel), "utf-8");
    try {
      return [extractModel(parse(src, rel))];
    } catch {
      // Skip unparseable files — the dogfood is a precision/recall
      // regression anchor on what DOES parse, not a parser-coverage test.
      return [];
    }
  });
  const lineage = buildFieldLineage(models);
  if (!lineage) {
    return {
      inferredHigh: [],
      inferredAmbiguous: [],
      inferredSemantic: [],
      deterministicCount: 0,
      deterministicViaReplacingCount: 0,
    };
  }
  return {
    inferredHigh: lineage.inferredHighConfidence.map(entryKey).sort(),
    inferredAmbiguous: lineage.inferredAmbiguous.map(entryKey).sort(),
    inferredSemantic: lineage.inferredSemantic.map(entryKey).sort(),
    deterministicCount: lineage.deterministic.length,
    deterministicViaReplacingCount: lineage.summary.deterministic.viaReplacing,
  };
}

export function renderDogfood(report: DogfoodReport): string {
  const lines: string[] = [];
  lines.push(`# inferred-high pairs: ${report.inferredHigh.length}`);
  lines.push(`# inferred-ambiguous pairs: ${report.inferredAmbiguous.length}`);
  lines.push(`# inferred-semantic pairs: ${report.inferredSemantic.length}`);
  lines.push(`# deterministic entries: ${report.deterministicCount}`);
  lines.push(`# (det via REPLACING: ${report.deterministicViaReplacingCount})`);
  lines.push("");
  lines.push("## inferred-high");
  for (const key of report.inferredHigh) lines.push(key);
  lines.push("");
  lines.push("## inferred-ambiguous");
  for (const key of report.inferredAmbiguous) lines.push(key);
  lines.push("");
  lines.push("## inferred-semantic");
  for (const key of report.inferredSemantic) lines.push(key);
  return lines.join("\n") + "\n";
}
