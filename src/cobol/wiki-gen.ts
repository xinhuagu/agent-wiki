/**
 * COBOL wiki page generator — normalized model → Markdown wiki pages.
 */

import type { CobolCodeModel, CodeSummary } from "./extractors.js";
import type { DataItemNode } from "./types.js";
import type { NormalizedCodeModel } from "../code-analysis.js";

// ---------------------------------------------------------------------------
// Program page
// ---------------------------------------------------------------------------

export function generateProgramPage(model: CobolCodeModel, summary: CodeSummary, normalized?: NormalizedCodeModel): { path: string; content: string } {
  const id = model.programId || "UNKNOWN";
  const lines: string[] = [];

  // Frontmatter
  lines.push("---");
  lines.push(`title: "${id}"`);
  lines.push("type: code");
  lines.push(`tags: [cobol, program]`);
  lines.push(`sources: ["raw/${model.sourceFile}"]`);
  lines.push("---");
  lines.push("");

  // Program structure
  lines.push("## Program Structure");
  lines.push("");
  lines.push("| Division | Sections |");
  lines.push("|----------|----------|");
  for (const div of model.divisions) {
    const secs = model.sections
      .filter((s) => s.division === div.name)
      .map((s) => s.name);
    lines.push(`| ${div.name} | ${secs.join(", ") || "—"} |`);
  }
  lines.push("");

  // Paragraphs
  if (model.paragraphs.length > 0) {
    lines.push("## Paragraphs");
    lines.push("");
    for (const sec of model.sections.filter((s) => s.division === "PROCEDURE")) {
      const paras = model.paragraphs.filter((p) => p.section === sec.name);
      if (paras.length > 0) {
        lines.push(`### ${sec.name}`);
        lines.push("");
        for (const p of paras) {
          lines.push(`- ${p.name} (line ${p.loc.line})`);
        }
        lines.push("");
      }
    }
  }

  // Dependencies
  if (summary.callTargets.length > 0 || summary.copybooks.length > 0 || summary.performTargets.length > 0) {
    lines.push("## Dependencies");
    lines.push("");
    if (summary.callTargets.length > 0) {
      lines.push(`- **CALL**: ${summary.callTargets.join(", ")}`);
    }
    if (summary.performTargets.length > 0) {
      lines.push(`- **PERFORM**: ${summary.performTargets.join(", ")}`);
    }
    if (summary.copybooks.length > 0) {
      lines.push(`- **COPY**: ${summary.copybooks.join(", ")}`);
    }
    lines.push("");
  }

  // Key data items
  const topItems = model.dataItems.filter((d) => d.level === 1 || d.level === 77);
  if (topItems.length > 0) {
    lines.push("## Key Data Items");
    lines.push("");
    lines.push("| Level | Name | PIC | Usage |");
    lines.push("|-------|------|-----|-------|");
    for (const item of topItems) {
      renderDataRow(item, lines);
    }
    lines.push("");
  }

  // File definitions
  if (model.fileDefinitions.length > 0) {
    lines.push("## File Definitions");
    lines.push("");
    for (const fd of model.fileDefinitions) {
      lines.push(`- **${fd.fd}**${fd.recordName ? ` → ${fd.recordName}` : ""}`);
    }
    lines.push("");
  }

  if (model.db2References.length > 0 || model.cicsReferences.length > 0 || model.fileAccesses.length > 0) {
    lines.push("## External Dependencies");
    lines.push("");

    if (model.db2References.length > 0) {
      lines.push("### DB2");
      lines.push("");
      lines.push("| Operation | Tables | Line |");
      lines.push("|-----------|--------|------|");
      for (const ref of model.db2References) {
        lines.push(`| ${ref.operation ?? "SQL"} | ${ref.tables.join(", ") || "—"} | ${ref.loc.line} |`);
      }
      lines.push("");
    }

    if (model.cicsReferences.length > 0) {
      lines.push("### CICS");
      lines.push("");
      lines.push("| Command | Program | Transaction | Map | File | Line |");
      lines.push("|---------|---------|-------------|-----|------|------|");
      for (const ref of model.cicsReferences) {
        lines.push(
          `| ${ref.command} | ${ref.program ?? "—"} | ${ref.transaction ?? "—"} | ${ref.map ?? "—"} | ${ref.file ?? "—"} | ${ref.loc.line} |`
        );
      }
      lines.push("");
    }

    if (model.fileAccesses.length > 0) {
      lines.push("### File Access");
      lines.push("");
      lines.push("| Operation | File | Mode | Record | Line |");
      lines.push("|-----------|------|------|--------|------|");
      for (const access of model.fileAccesses) {
        lines.push(
          `| ${access.operation} | ${access.file} | ${access.mode ?? "—"} | ${access.recordName ?? "—"} | ${access.loc.line} |`
        );
      }
      lines.push("");
    }
  }

  // Dataflow edges from MOVE/COMPUTE/ADD/etc.
  const dfEdges = (normalized?.relations ?? []).filter((r) => r.type === "dataflow");
  if (dfEdges.length > 0) {
    lines.push("## Dataflow Edges");
    lines.push("");
    lines.push("| From | To | Via | Line | Procedure |");
    lines.push("|------|----|-----|------|-----------|");
    for (const edge of dfEdges) {
      lines.push(
        `| ${edge.from} | ${edge.to} | ${String(edge.metadata?.via ?? "—")} | ${edge.loc.line} | ${String(edge.metadata?.procedure ?? "—")} |`
      );
    }
    lines.push("");
  }

  return {
    path: `cobol/programs/${id.toLowerCase()}.md`,
    content: lines.join("\n"),
  };
}

function renderDataRow(item: DataItemNode, lines: string[]): void {
  const indent = "  ".repeat(Math.max(0, Math.floor(item.level / 5)));
  const pic = item.picture || (item.children.length > 0 ? "GROUP" : "—");
  const usage = item.usage || "—";
  lines.push(`| ${String(item.level).padStart(2, "0")} | ${indent}${item.name} | ${pic} | ${usage} |`);
  for (const child of item.children) {
    renderDataRow(child, lines);
  }
}

// ---------------------------------------------------------------------------
// Copybook page
// ---------------------------------------------------------------------------

export function generateCopybookPage(model: CobolCodeModel): { path: string; content: string } {
  const name = model.sourceFile.replace(/\.(cpy|cbl|cob)$/i, "");
  const lines: string[] = [];

  lines.push("---");
  lines.push(`title: "${name}"`);
  lines.push("type: code");
  lines.push(`tags: [cobol, copybook]`);
  lines.push(`sources: ["raw/${model.sourceFile}"]`);
  lines.push("---");
  lines.push("");

  lines.push("## Data Structure");
  lines.push("");
  if (model.dataItems.length > 0) {
    lines.push("| Level | Name | PIC | Usage |");
    lines.push("|-------|------|-----|-------|");
    for (const item of model.dataItems) {
      renderDataRow(item, lines);
    }
    lines.push("");
  } else {
    lines.push("No data items found.");
    lines.push("");
  }

  return {
    path: `cobol/copybooks/${name.toLowerCase()}.md`,
    content: lines.join("\n"),
  };
}

// ---------------------------------------------------------------------------
// Call graph page (aggregated from multiple programs)
// ---------------------------------------------------------------------------

export function generateCallGraphPage(models: CobolCodeModel[]): { path: string; content: string } {
  const lines: string[] = [];

  lines.push("---");
  lines.push('title: "COBOL Call Graph"');
  lines.push("type: synthesis");
  lines.push("tags: [cobol, call-graph]");
  const sources = models.map((m) => `"raw/${m.sourceFile}"`);
  lines.push(`sources: [${sources.join(", ")}]`);
  lines.push("---");
  lines.push("");

  // CALL graph
  lines.push("## CALL Dependencies");
  lines.push("");
  const allCalls = models.flatMap((m) =>
    m.calls.map((c) => ({ from: m.programId, to: c.target }))
  );
  if (allCalls.length > 0) {
    lines.push("| Caller | Target |");
    lines.push("|--------|--------|");
    for (const c of allCalls) {
      lines.push(`| ${c.from} | ${c.to} |`);
    }
  } else {
    lines.push("No CALL dependencies found.");
  }
  lines.push("");

  // COPY dependencies
  lines.push("## COPY Dependencies");
  lines.push("");
  const allCopies = models.flatMap((m) =>
    m.copies.map((c) => ({ program: m.programId, copybook: c.copybook }))
  );
  if (allCopies.length > 0) {
    lines.push("| Program | Copybook |");
    lines.push("|---------|----------|");
    for (const c of allCopies) {
      lines.push(`| ${c.program} | ${c.copybook} |`);
    }
  } else {
    lines.push("No COPY dependencies found.");
  }
  lines.push("");

  return {
    path: "cobol/call-graph.md",
    content: lines.join("\n"),
  };
}
