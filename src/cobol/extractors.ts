/**
 * COBOL extractors — AST → normalized code model.
 *
 * Walks the CobolAST and extracts structured relations:
 * program structure, CALL/PERFORM/COPY dependencies, data items, file defs.
 */

import type {
  CobolAST,
  DataItemNode,
  DivisionNode,
  SectionNode,
  SourceLocation,
  StatementNode,
} from "./types.js";
import { extractUsingArgs } from "./variable-tracer.js";

// ---------------------------------------------------------------------------
// Code model types
// ---------------------------------------------------------------------------

export interface CobolCodeModel {
  programId: string;
  sourceFile: string;
  divisions: { name: string; loc: SourceLocation }[];
  sections: { name: string; division: string; loc: SourceLocation }[];
  paragraphs: { name: string; section: string; loc: SourceLocation }[];
  calls: {
    target: string;
    /**
     * `literal` — CALL "FOO" / 'FOO' (compile-time program name).
     * `identifier` — CALL FOO (variable resolved at runtime; "dynamic call").
     * Lineage analysis treats the two differently: an unresolved literal means
     * the program isn't in the corpus; an unresolved identifier means we
     * can't determine the callee statically.
     */
    targetKind: "literal" | "identifier";
    fromParagraph: string;
    usingArgs: string[];
    loc: SourceLocation;
  }[];
  performs: { target: string; fromParagraph: string; thru?: string; loc: SourceLocation }[];
  copies: { copybook: string; replacing?: string[]; loc: SourceLocation }[];
  dataItems: DataItemNode[];
  linkageItems: DataItemNode[];
  fileDefinitions: { fd: string; recordName?: string; loc: SourceLocation }[];
  db2References: { operation?: string; tables: string[]; rawText: string; loc: SourceLocation }[];
  cicsReferences: {
    command: string;
    program?: string;
    transaction?: string;
    map?: string;
    file?: string;
    rawText: string;
    loc: SourceLocation;
  }[];
  fileAccesses: {
    file: string;
    operation: "OPEN" | "READ" | "WRITE" | "REWRITE" | "DELETE" | "CLOSE";
    mode?: string;
    recordName?: string;
    rawText: string;
    loc: SourceLocation;
  }[];
  /**
   * Write-like assignment records used by the dynamic-CALL constant-
   * propagation resolver (#46 Phase A; extended in #48 Phase A.1 to
   * cover non-MOVE write verbs). Each entry names a target identifier
   * and the verb that wrote it:
   *
   *   - `verb: "MOVE"` with a `literal` — `MOVE "FOO" TO target`.
   *     The only write shape that produces a resolvable literal.
   *   - `verb: "MOVE"` without `literal` — non-literal MOVE source
   *     (identifier or numeric). Disqualifies resolution.
   *   - `verb: "INITIALIZE" | "STRING" | "UNSTRING"` (always no
   *     `literal`) — non-MOVE writes that clobber the target with a
   *     value the resolver can't statically determine. Same effect
   *     as a non-literal MOVE: abstain.
   *
   * Multi-target `MOVE X TO A B` produces two entries with the same
   * source. Qualified targets (`A OF B`, `A IN B`) are skipped at
   * extraction time — Phase A doesn't handle them.
   *
   * `verb` is optional for back-compat with pre-#48 artifacts where
   * every entry was implicitly a MOVE; missing values default to
   * "MOVE" at consumer time.
   */
  moveAssignments: {
    target: string;
    literal?: string;
    verb?: "MOVE" | "INITIALIZE" | "STRING" | "UNSTRING" | "ACCEPT";
    loc: SourceLocation;
  }[];
}

export interface CodeSummary {
  programId: string;
  sourceFile: string;
  divisionCount: number;
  sectionCount: number;
  paragraphCount: number;
  callTargets: string[];
  performTargets: string[];
  copybooks: string[];
  dataItemCount: number;
  fileDefinitions: string[];
}

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

export function extractModel(ast: CobolAST): CobolCodeModel {
  const model: CobolCodeModel = {
    programId: ast.programId,
    sourceFile: ast.sourceFile,
    divisions: [],
    sections: [],
    paragraphs: [],
    calls: [],
    performs: [],
    copies: [],
    dataItems: [],
    linkageItems: [],
    fileDefinitions: [],
    db2References: [],
    cicsReferences: [],
    fileAccesses: [],
    moveAssignments: [],
  };

  for (const div of ast.divisions) {
    model.divisions.push({ name: div.name, loc: div.loc });

    for (const sec of div.sections) {
      model.sections.push({ name: sec.name, division: div.name, loc: sec.loc });

      // File definitions
      for (const fd of sec.fileDefinitions) {
        model.fileDefinitions.push({ fd: fd.fd, recordName: fd.recordName, loc: fd.loc });
      }

      // Data items
      if (sec.dataItems.length > 0) {
        model.dataItems.push(...sec.dataItems);
        if (sec.name.toUpperCase() === "LINKAGE") {
          model.linkageItems.push(...sec.dataItems);
        }
      }

      // Paragraphs and statements
      for (const para of sec.paragraphs) {
        model.paragraphs.push({ name: para.name, section: sec.name, loc: para.loc });

        for (const stmt of para.statements) {
          extractStatementRelations(stmt, para.name, model);
        }
      }
    }
  }

  return model;
}

function normalizeOperand(value: string): string {
  return value.replace(/['"]/g, "").toUpperCase();
}

function normalizeSqlRawText(rawText: string): string {
  return rawText
    .toUpperCase()
    .replace(/([A-Z0-9_-])\s*\.\s*([A-Z0-9_-])/g, "$1.$2");
}

export function extractSqlTableNames(rawText: string): string[] {
  const tables = new Set<string>();
  const normalized = normalizeSqlRawText(rawText);
  const patterns = [
    /\bFROM\s+([A-Z0-9][A-Z0-9_.-]*)/g,
    /\bJOIN\s+([A-Z0-9][A-Z0-9_.-]*)/g,
    /\bUPDATE\s+([A-Z0-9][A-Z0-9_.-]*)/g,
    /\bINSERT\s+INTO\s+([A-Z0-9][A-Z0-9_.-]*)/g,
    /\bMERGE\s+INTO\s+([A-Z0-9][A-Z0-9_.-]*)/g,
    /\bDELETE\s+FROM\s+([A-Z0-9][A-Z0-9_.-]*)/g,
  ];

  for (const pattern of patterns) {
    for (const match of normalized.matchAll(pattern)) {
      const table = match[1]?.replace(/['"]/g, "");
      if (table) tables.add(table);
    }
  }

  return [...tables].sort((a, b) => a.localeCompare(b));
}

function extractParenArgument(rawText: string, keyword: string): string | undefined {
  const match = rawText.match(new RegExp(`${keyword}\\s*\\(\\s*['"]?([A-Z0-9_.-]+)['"]?\\s*\\)`, "i"));
  return match?.[1]?.replace(/['"]/g, "").toUpperCase();
}

function extractDb2Reference(stmt: StatementNode): { operation?: string; tables: string[]; rawText: string; loc: SourceLocation } | null {
  if (stmt.verb !== "EXEC") return null;
  const rawText = stmt.rawText.toUpperCase();
  if (!rawText.startsWith("EXEC SQL ")) return null;

  const operation = rawText.match(/^EXEC\s+SQL\s+([A-Z-]+)/)?.[1];
  return {
    operation,
    tables: extractSqlTableNames(stmt.rawText),
    rawText: stmt.rawText,
    loc: stmt.loc,
  };
}

function extractCicsReference(
  stmt: StatementNode,
): {
  command: string;
  program?: string;
  transaction?: string;
  map?: string;
  file?: string;
  rawText: string;
  loc: SourceLocation;
} | null {
  if (stmt.verb !== "EXEC") return null;
  const rawText = stmt.rawText.toUpperCase();
  if (!rawText.startsWith("EXEC CICS ")) return null;

  const command = rawText.match(/^EXEC\s+CICS\s+([A-Z-]+)/)?.[1] ?? "UNKNOWN";
  return {
    command,
    program: extractParenArgument(stmt.rawText, "PROGRAM"),
    transaction: extractParenArgument(stmt.rawText, "TRANSID") ?? extractParenArgument(stmt.rawText, "TRANSACTION"),
    map: extractParenArgument(stmt.rawText, "MAP"),
    file: extractParenArgument(stmt.rawText, "FILE"),
    rawText: stmt.rawText,
    loc: stmt.loc,
  };
}

function inferFileAccesses(
  stmt: StatementNode,
  model: CobolCodeModel,
): Array<{
  file: string;
  operation: "OPEN" | "READ" | "WRITE" | "REWRITE" | "DELETE" | "CLOSE";
  mode?: string;
  recordName?: string;
  rawText: string;
  loc: SourceLocation;
}> {
  const verb = stmt.verb as "OPEN" | "READ" | "WRITE" | "REWRITE" | "DELETE" | "CLOSE";
  if (!["OPEN", "READ", "WRITE", "REWRITE", "DELETE", "CLOSE"].includes(verb)) return [];

  const knownFiles = new Set(model.fileDefinitions.map((fd) => fd.fd.toUpperCase()));
  const fileByRecord = new Map(
    model.fileDefinitions
      .filter((fd) => fd.recordName)
      .map((fd) => [fd.recordName!.toUpperCase(), fd.fd.toUpperCase()])
  );
  const operands = stmt.operands.map(normalizeOperand);

  if (verb === "OPEN") {
    const modes = new Set(["INPUT", "OUTPUT", "I-O", "EXTEND"]);
    const clauseKeywords = new Set([
      "WITH",
      "NO",
      "REWIND",
      "LOCK",
      "SHARING",
      "REVERSED",
    ]);
    const accesses: Array<{
      file: string;
      operation: "OPEN";
      mode?: string;
      recordName?: string;
      rawText: string;
      loc: SourceLocation;
    }> = [];
    let currentMode: string | undefined;
    let capturedForMode = false;
    for (const operand of operands) {
      if (modes.has(operand)) {
        currentMode = operand;
        capturedForMode = false;
        continue;
      }
      if (knownFiles.size > 0) {
        if (!knownFiles.has(operand)) continue;
      } else {
        if (!currentMode || capturedForMode || clauseKeywords.has(operand)) continue;
        capturedForMode = true;
      }
      accesses.push({
        file: operand,
        operation: "OPEN",
        mode: currentMode,
        rawText: stmt.rawText,
        loc: stmt.loc,
      });
    }
    return accesses;
  }

  if (verb === "CLOSE") {
    return operands
      .filter((operand) => knownFiles.size === 0 || knownFiles.has(operand))
      .map((file) => ({
        file,
        operation: "CLOSE" as const,
        rawText: stmt.rawText,
        loc: stmt.loc,
      }));
  }

  if (verb === "READ") {
    const file = operands.find((operand) => knownFiles.has(operand)) ?? operands[0];
    if (!file) return [];
    return [{
      file,
      operation: "READ",
      rawText: stmt.rawText,
      loc: stmt.loc,
    }];
  }

  const recordName = operands[0];
  const file = (recordName && fileByRecord.get(recordName))
    ?? operands.find((operand) => knownFiles.has(operand));
  if (!file) return [];
  return [{
    file,
    operation: verb,
    recordName,
    rawText: stmt.rawText,
    loc: stmt.loc,
  }];
}

function extractStatementRelations(
  stmt: StatementNode,
  paragraph: string,
  model: CobolCodeModel,
): void {
  const verb = stmt.verb;

  if (verb === "CALL") {
    // CALL "PROGRAM" (literal) or CALL identifier (dynamic).
    const target = stmt.operands[0];
    if (target) {
      const isLiteral = /^['"]/.test(target);
      model.calls.push({
        target: target.replace(/['"]/g, ""),
        targetKind: isLiteral ? "literal" : "identifier",
        fromParagraph: paragraph,
        usingArgs: extractUsingArgs(stmt.rawText),
        loc: stmt.loc,
      });
    }
  }

  if (verb === "MOVE") {
    // `MOVE <source> TO <target>...`. Use the typed token stream rather
    // than `stmt.operands`: operands silently drops OF/IN qualifier
    // keywords, so `MOVE A OF B TO C` would arrive as `[A, B, C]` and
    // produce a wrong `(source=A, targets=[B, C])` record. Walking
    // tokens lets us locate the `TO` boundary and refuse qualified
    // operands.
    //
    // Phase A conservative: only emit when each side is a single
    // unqualified identifier (or single literal on the source). Group
    // moves (`MOVE A TO B C D`) emit one record per target. Qualified
    // forms (`A OF B`, `A IN B`) are skipped entirely — they're
    // uncommon for program-name variables and Phase A's constant-
    // propagation resolver doesn't need them.
    const tokens = stmt.tokens;
    const toIdx = tokens.findIndex((t) => t.type === "TO");
    if (toIdx > 1) {
      const sourceTokens = tokens.slice(1, toIdx);
      const targetTokens = tokens.slice(toIdx + 1);
      const hasQualifier = (ts: typeof sourceTokens): boolean =>
        ts.some((t) => t.type === "OF" || t.type === "IN");
      const sourceIsSingleScalar = sourceTokens.length === 1
        && (sourceTokens[0]!.type === "IDENTIFIER"
          || sourceTokens[0]!.type === "LITERAL"
          || sourceTokens[0]!.type === "NUMERIC");
      if (sourceIsSingleScalar && !hasQualifier(sourceTokens) && !hasQualifier(targetTokens)) {
        const source = sourceTokens[0]!.value;
        const isLiteral = /^["']/.test(source);
        const literal = isLiteral ? source.replace(/^["']|["']$/g, "") : undefined;
        for (const tt of targetTokens) {
          if (tt.type !== "IDENTIFIER") continue;
          model.moveAssignments.push({
            target: tt.value,
            ...(literal !== undefined ? { literal } : {}),
            verb: "MOVE",
            loc: stmt.loc,
          });
        }
      }
    }
  }

  // #48 Phase A.1 — non-MOVE write verbs that can clobber a variable.
  // These never produce a resolvable literal (the written value is
  // computed at runtime), so they're emitted with `literal: undefined`
  // and the resolver's existing "any non-literal write disqualifies"
  // gate catches them. Each verb has a distinct target-extraction
  // shape — see comments per verb. Qualified targets (`A OF B`) are
  // skipped at the per-token level for the same reason as MOVE.
  if (verb === "INITIALIZE") {
    // `INITIALIZE <ident>... [REPLACING ...] [DEFAULT TO ...]`. Every
    // unqualified IDENTIFIER token after the verb is a target, until
    // the first OF/IN qualifier (skip the whole statement) or any
    // other keyword (REPLACING/DEFAULT/etc., stop).
    const tokens = stmt.tokens;
    const candidates: string[] = [];
    let qualified = false;
    for (let i = 1; i < tokens.length; i++) {
      const t = tokens[i]!;
      if (t.type === "IDENTIFIER") {
        candidates.push(t.value);
      } else if (t.type === "OF" || t.type === "IN") {
        qualified = true;
        break;
      } else {
        break;
      }
    }
    if (!qualified) {
      for (const target of candidates) {
        model.moveAssignments.push({ target, verb: "INITIALIZE", loc: stmt.loc });
      }
    }
  }

  if (verb === "STRING") {
    // `STRING <source-list> INTO <target> [WITH POINTER <ptr>] ... END-STRING`.
    // The first IDENTIFIER after `INTO` is the destination target.
    // A `WITH POINTER` operand is also a write target but rare for
    // program-name vars; track only the primary INTO target for now.
    const tokens = stmt.tokens;
    const intoIdx = tokens.findIndex((t) => t.type === "INTO");
    if (intoIdx > 0) {
      for (let i = intoIdx + 1; i < tokens.length; i++) {
        const t = tokens[i]!;
        if (t.type === "IDENTIFIER") {
          // Reject if the very next token is OF/IN (qualified target).
          const next = tokens[i + 1];
          if (next && (next.type === "OF" || next.type === "IN")) break;
          model.moveAssignments.push({ target: t.value, verb: "STRING", loc: stmt.loc });
          break;
        }
        // Skip any leading keyword tokens between INTO and the target.
        if (t.type === "OF" || t.type === "IN") break;
      }
    }
  }

  if (verb === "UNSTRING") {
    // `UNSTRING <source> [DELIMITED BY ...] INTO <target-1> [DELIMITER IN <d>]
    //   [COUNT IN <c>] [target-2 ...] [WITH POINTER <ptr>] [TALLYING IN <t>]
    //   END-UNSTRING`. After INTO, IDENTIFIER tokens are targets until
    // the next non-IDENTIFIER keyword (DELIMITER/COUNT/POINTER/TALLYING/etc.).
    //
    // Phase A.1 conservative rule: if ANY OF/IN qualifier appears in the
    // target run, skip the whole statement. Nested-qualifier handling
    // (`A OF B OF C`) is too brittle without proper grammar tracking;
    // false-negative (we miss the abstain) is preferred over false-
    // positive (we capture a non-target as a target).
    const tokens = stmt.tokens;
    const intoIdx = tokens.findIndex((t) => t.type === "INTO");
    if (intoIdx > 0) {
      const candidates: string[] = [];
      let qualified = false;
      for (let i = intoIdx + 1; i < tokens.length; i++) {
        const t = tokens[i]!;
        if (t.type === "IDENTIFIER") {
          candidates.push(t.value);
        } else if (t.type === "OF" || t.type === "IN") {
          qualified = true;
          break;
        } else {
          // Stop at the first non-IDENTIFIER/non-OF/IN token (DELIMITER /
          // COUNT / WITH / etc.).
          break;
        }
      }
      if (!qualified) {
        for (const target of candidates) {
          model.moveAssignments.push({ target, verb: "UNSTRING", loc: stmt.loc });
        }
      }
    }
  }

  if (verb === "ACCEPT") {
    // `ACCEPT <ident> [FROM <source>]`. The target is the FIRST
    // unqualified IDENTIFIER after the verb. ACCEPT reads runtime
    // input (date/time/env/console), so the resulting value is by
    // definition not constant — same precision risk as STRING.
    // Skip qualified targets for consistency with the other verbs.
    const tokens = stmt.tokens;
    if (tokens.length >= 2) {
      const t = tokens[1]!;
      const next = tokens[2];
      const qualified = next && (next.type === "OF" || next.type === "IN");
      if (t.type === "IDENTIFIER" && !qualified) {
        model.moveAssignments.push({ target: t.value, verb: "ACCEPT", loc: stmt.loc });
      }
    }
  }

  if (verb === "PERFORM") {
    // PERFORM paragraph-name [THRU paragraph-name]
    const target = stmt.operands[0];
    if (target) {
      let thru: string | undefined;
      const thruIdx = stmt.rawText.toUpperCase().indexOf(" THRU ");
      const throughIdx = stmt.rawText.toUpperCase().indexOf(" THROUGH ");
      if (thruIdx >= 0 || throughIdx >= 0) {
        // Find the operand after THRU
        const ops = stmt.operands;
        for (let i = 0; i < ops.length - 1; i++) {
          if (ops[i] === target && i + 1 < ops.length) {
            thru = ops[i + 1];
            break;
          }
        }
      }
      model.performs.push({
        target,
        fromParagraph: paragraph,
        thru,
        loc: stmt.loc,
      });
    }
  }

  if (verb === "COPY") {
    // COPY copybook-name [REPLACING <pair>+]
    const copybook = stmt.operands[0];
    if (copybook) {
      // #21 fix: extract REPLACING pairs from rawText, NOT stmt.operands.
      // The parser's parseStatement only pushes IDENTIFIER/LITERAL/NUMERIC
      // tokens to operands; REPLACING and BY have their own typed token
      // types (KEYWORD_MAP), so they never appear in operands. The old
      // code's `stmt.operands.indexOf("REPLACING")` always returned -1,
      // leaving `c.replacing` undefined for every program with COPY
      // REPLACING — silently disabling the field-lineage exact-program
      // filter, the graph reason marker, and plugin metadata.
      //
      // Tokenize rawText on whitespace and match REPLACING as an exact
      // array element rather than a substring. This avoids false
      // positives when a copybook name happens to contain "REPLACING"
      // (e.g., `COPY REPLACING-UTIL` lexes as one IDENTIFIER because
      // hyphens are word chars). Single-token form `REPLACING X BY Y`
      // tokenizes cleanly; pseudo-text form `REPLACING ==X== BY ==Y==`
      // shatters because `=` lexes as a single-char operator, but the
      // post-REPLACING slice is still non-empty so consumers checking
      // `length > 0` get the correct boolean signal. Fully structured
      // pseudo-text parsing is out of scope.
      const replacing: string[] = [];
      const rawTokens = stmt.rawText.toUpperCase().split(/\s+/);
      const replIdx = rawTokens.indexOf("REPLACING");
      if (replIdx >= 0) {
        replacing.push(...rawTokens.slice(replIdx + 1).filter((t) => t.length > 0));
      }
      model.copies.push({
        copybook: copybook.replace(/['"]/g, ""),
        replacing: replacing.length > 0 ? replacing : undefined,
        loc: stmt.loc,
      });
    }
  }

  const db2Ref = extractDb2Reference(stmt);
  if (db2Ref) {
    model.db2References.push(db2Ref);
  }

  const cicsRef = extractCicsReference(stmt);
  if (cicsRef) {
    model.cicsReferences.push(cicsRef);
  }

  const fileAccesses = inferFileAccesses(stmt, model);
  if (fileAccesses.length > 0) {
    model.fileAccesses.push(...fileAccesses);
  }
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

export function generateSummary(model: CobolCodeModel): CodeSummary {
  const countDataItems = (items: DataItemNode[]): number => {
    let count = 0;
    for (const item of items) {
      count++;
      count += countDataItems(item.children);
    }
    return count;
  };

  return {
    programId: model.programId,
    sourceFile: model.sourceFile,
    divisionCount: model.divisions.length,
    sectionCount: model.sections.length,
    paragraphCount: model.paragraphs.length,
    callTargets: [...new Set(model.calls.map((c) => c.target))],
    performTargets: [...new Set(model.performs.map((p) => p.target))],
    copybooks: [...new Set(model.copies.map((c) => c.copybook))],
    dataItemCount: countDataItems(model.dataItems),
    fileDefinitions: model.fileDefinitions.map((f) => f.fd),
  };
}
