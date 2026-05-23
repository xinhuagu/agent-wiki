/**
 * CLI for the lineage dogfood report — handy when investigating a
 * real-world corpus. The library lives at src/cobol/dogfood-lineage.ts
 * (imported by the vitest baseline regression test); this file is a
 * thin wrapper that wires it to argv + stdout.
 *
 * usage:
 *   tsx scripts/dogfood-lineage.ts <corpus-dir> <out-file>
 */

import { writeFileSync } from "node:fs";
import { runDogfood, renderDogfood } from "../src/cobol/dogfood-lineage.js";

const [corpusDir, outFile] = process.argv.slice(2);
if (!corpusDir || !outFile) {
  console.error("usage: tsx scripts/dogfood-lineage.ts <corpus-dir> <out-file>");
  process.exit(1);
}
const report = runDogfood(corpusDir);
writeFileSync(outFile, renderDogfood(report));
console.error(`wrote ${report.inferredHigh.length} inferred-high pairs to ${outFile}`);
