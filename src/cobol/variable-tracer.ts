/**
 * COBOL variable tracer — find all references to a variable with read/write classification.
 *
 * Scans PROCEDURE DIVISION statements and classifies each operand position
 * as read, write, or both based on a verb classification table.
 */

import type { CobolAST, StatementNode } from "./types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AccessMode = "read" | "write" | "both";

export interface VariableReference {
  variable: string;
  qualifiedName?: string;
  paragraph: string;
  section: string;
  line: number;
  access: AccessMode;
  statement: string;
  verb: string;
}

export interface DataflowEdge {
  from: string;
  to: string;
  via: string;
  line: number;
  procedure: string;
  section: string;
}

// ---------------------------------------------------------------------------
// Verb classification table
//
// For each verb, define which operand positions are read vs. write.
// Format: array of access modes applied to operands in order.
// Special keyword markers (TO, FROM, INTO, GIVING, BY) split operands
// into read/write groups.
// ---------------------------------------------------------------------------

interface VerbRule {
  /** Default access for operands before any keyword marker */
  defaultBefore: AccessMode;
  /** Keyword markers that change the access mode */
  markers: Record<string, AccessMode>;
  /** Default access for unknown positions */
  fallback: AccessMode;
}

const VERB_RULES: Record<string, VerbRule> = {
  "MOVE": { defaultBefore: "read", markers: { "TO": "write" }, fallback: "read" },
  "ADD": { defaultBefore: "read", markers: { "TO": "both", "GIVING": "write" }, fallback: "read" },
  "SUBTRACT": { defaultBefore: "read", markers: { "FROM": "both", "GIVING": "write" }, fallback: "read" },
  "MULTIPLY": { defaultBefore: "read", markers: { "BY": "both", "GIVING": "write" }, fallback: "read" },
  "DIVIDE": { defaultBefore: "read", markers: { "INTO": "both", "GIVING": "write", "REMAINDER": "write" }, fallback: "read" },
  "COMPUTE": { defaultBefore: "write", markers: { "=": "read" }, fallback: "read" },
  "SET": { defaultBefore: "write", markers: { "TO": "read", "UP": "read", "DOWN": "read" }, fallback: "read" },
  "INITIALIZE": { defaultBefore: "write", markers: {}, fallback: "write" },
  "STRING": { defaultBefore: "read", markers: { "INTO": "write" }, fallback: "read" },
  "UNSTRING": { defaultBefore: "read", markers: { "INTO": "write", "TALLYING": "write" }, fallback: "read" },
  "INSPECT": { defaultBefore: "both", markers: { "TALLYING": "write", "REPLACING": "write" }, fallback: "read" },
  "ACCEPT": { defaultBefore: "write", markers: {}, fallback: "write" },
  "DISPLAY": { defaultBefore: "read", markers: {}, fallback: "read" },
  "READ": { defaultBefore: "read", markers: { "INTO": "write" }, fallback: "read" },
  "WRITE": { defaultBefore: "read", markers: { "FROM": "read" }, fallback: "read" },
  "REWRITE": { defaultBefore: "read", markers: { "FROM": "read" }, fallback: "read" },
  "DELETE": { defaultBefore: "read", markers: {}, fallback: "read" },
  "START": { defaultBefore: "read", markers: {}, fallback: "read" },
  "SEARCH": { defaultBefore: "read", markers: {}, fallback: "read" },
  "EVALUATE": { defaultBefore: "read", markers: {}, fallback: "read" },
  "IF": { defaultBefore: "read", markers: {}, fallback: "read" },
  "PERFORM": { defaultBefore: "read", markers: {}, fallback: "read" },
  "CALL": { defaultBefore: "read", markers: { "USING": "both", "GIVING": "write", "RETURNING": "write" }, fallback: "both" },
  "OPEN": { defaultBefore: "read", markers: {}, fallback: "read" },
  "CLOSE": { defaultBefore: "read", markers: {}, fallback: "read" },
  "SORT": { defaultBefore: "read", markers: { "GIVING": "write" }, fallback: "read" },
  "MERGE": { defaultBefore: "read", markers: { "GIVING": "write" }, fallback: "read" },
  "RELEASE": { defaultBefore: "read", markers: { "FROM": "read" }, fallback: "read" },
  "RETURN": { defaultBefore: "read", markers: { "INTO": "write" }, fallback: "read" },
};

// Known keywords that are NOT variable names
const NON_VARIABLE_KEYWORDS = new Set([
  "TO", "FROM", "INTO", "BY", "GIVING", "USING", "RETURNING",
  "THRU", "THROUGH", "REPLACING", "REMAINDER", "TALLYING",
  "DELIMITED", "SIZE", "SPACES", "SPACE", "ZEROS", "ZERO",
  "ZEROES", "QUOTES", "QUOTE", "HIGH-VALUES", "HIGH-VALUE",
  "LOW-VALUES", "LOW-VALUE", "ALL", "ON", "OFF", "TRUE", "FALSE",
  "NOT", "AND", "OR", "THAN", "EQUAL", "GREATER", "LESS",
  "ALSO", "OTHER", "WHEN", "THEN", "ELSE", "END-IF",
  "END-EVALUATE", "END-PERFORM", "END-CALL", "END-COMPUTE",
  "END-READ", "END-WRITE", "END-STRING", "END-UNSTRING",
  "END-MULTIPLY", "END-DIVIDE", "END-ADD", "END-SUBTRACT",
  "END-SEARCH", "END-RETURN", "END-DELETE", "END-REWRITE",
  "END-START", "END-ACCEPT", "UNTIL", "VARYING", "AFTER",
  "BEFORE", "WITH", "UPON", "ADVANCING", "AT", "INVALID",
  "CORRESPONDING", "CORR", "ROUNDED",
  "INPUT", "OUTPUT", "I-O", "EXTEND",
  "=", "(", ")", "<", ">", "+", "-", "*", "/",
]);

// Figurative constants — not variables
const FIGURATIVE = new Set([
  "SPACES", "SPACE", "ZEROS", "ZERO", "ZEROES",
  "QUOTES", "QUOTE", "HIGH-VALUES", "HIGH-VALUE",
  "LOW-VALUES", "LOW-VALUE",
]);

// ---------------------------------------------------------------------------
// Tracer
// ---------------------------------------------------------------------------

export function traceVariable(ast: CobolAST, variable: string): VariableReference[] {
  const refs: VariableReference[] = [];
  const target = variable.toUpperCase();

  for (const div of ast.divisions) {
    if (div.name !== "PROCEDURE") continue;

    for (const sec of div.sections) {
      for (const para of sec.paragraphs) {
        for (const stmt of para.statements) {
          const stmtRefs = classifyStatement(stmt, target);
          for (const ref of stmtRefs) {
            refs.push({
              ...ref,
              paragraph: para.name,
              section: sec.name,
            });
          }
        }
      }
    }
  }

  return refs;
}

function classifyStatement(
  stmt: StatementNode,
  target: string,
): Omit<VariableReference, "paragraph" | "section">[] {
  const results: Omit<VariableReference, "paragraph" | "section">[] = [];
  const verb = stmt.verb;
  const rule = VERB_RULES[verb];
  const tokens = stmt.rawText.split(/\s+/).map((t) => t.toUpperCase());

  // Check if the target variable appears in this statement at all
  if (!tokens.includes(target)) {
    // Also check for qualified names: TARGET OF xxx or xxx OF TARGET
    const hasQualified = tokens.some((t, i) => {
      if (t === target) return true;
      if (t === "OF" || t === "IN") {
        return (i > 0 && tokens[i - 1] === target) || (i + 1 < tokens.length && tokens[i + 1] === target);
      }
      return false;
    });
    if (!hasQualified) return results;
  }

  // Determine access mode for the target variable based on its position
  let currentAccess: AccessMode = rule?.defaultBefore ?? "both";

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];

    // Check if this token is a marker that changes access mode
    if (rule?.markers[tok] !== undefined) {
      currentAccess = rule.markers[tok];
      continue;
    }

    if (tok === target) {
      // Build qualified name if preceded/followed by OF/IN
      let qualifiedName: string | undefined;
      if (i + 2 < tokens.length && (tokens[i + 1] === "OF" || tokens[i + 1] === "IN")) {
        qualifiedName = `${target} OF ${tokens[i + 2]}`;
      }

      results.push({
        variable: target,
        qualifiedName,
        line: stmt.loc.line,
        access: currentAccess,
        statement: stmt.rawText,
        verb,
      });
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Dataflow edge extraction
// ---------------------------------------------------------------------------

const DATAFLOW_VERBS = new Set([
  "MOVE", "COMPUTE", "ADD", "SUBTRACT", "MULTIPLY", "DIVIDE",
  "SET", "STRING", "UNSTRING", "READ", "WRITE", "REWRITE",
  "SORT", "MERGE", "RELEASE", "RETURN",
]);

// All COBOL verbs and clause keywords that can appear as tokens inside rawText
const ALL_COBOL_VERBS = new Set([
  "MOVE", "ADD", "SUBTRACT", "MULTIPLY", "DIVIDE", "COMPUTE", "SET",
  "STRING", "UNSTRING", "INSPECT", "ACCEPT", "DISPLAY",
  "READ", "WRITE", "REWRITE", "DELETE", "START", "OPEN", "CLOSE",
  "SEARCH", "EVALUATE", "IF", "PERFORM", "CALL", "STOP", "EXIT",
  "GO", "SORT", "MERGE", "RELEASE", "RETURN", "INITIALIZE",
  "EXEC", "END-EXEC",
  // AT END / NOT AT END clause keywords
  "END", "RUN",
]);

function isDataflowVariable(tok: string): boolean {
  if (NON_VARIABLE_KEYWORDS.has(tok)) return false;
  if (FIGURATIVE.has(tok)) return false;
  if (ALL_COBOL_VERBS.has(tok)) return false;
  if (/^[0-9]/.test(tok)) return false;
  if (/^["']/.test(tok)) return false;
  if (!/[A-Z]/.test(tok)) return false;
  return true;
}

function edgesFromStatement(
  stmt: StatementNode,
): Omit<DataflowEdge, "procedure" | "section">[] {
  const verb = stmt.verb;
  if (!DATAFLOW_VERBS.has(verb)) return [];
  const rule = VERB_RULES[verb];
  if (!rule) return [];

  const tokens = stmt.rawText.split(/\s+/).map((t) => t.toUpperCase());
  let currentAccess: AccessMode = rule.defaultBefore;
  const reads: string[] = [];
  const writes: string[] = [];

  for (const tok of tokens) {
    if (rule.markers[tok] !== undefined) {
      currentAccess = rule.markers[tok];
      continue;
    }
    if (!isDataflowVariable(tok)) continue;
    if (currentAccess === "read") {
      reads.push(tok);
    } else if (currentAccess === "write") {
      writes.push(tok);
    } else {
      reads.push(tok);
      writes.push(tok);
    }
  }

  const edges: Omit<DataflowEdge, "procedure" | "section">[] = [];
  for (const from of reads) {
    for (const to of writes) {
      if (from !== to) {
        edges.push({ from, to, via: verb, line: stmt.loc.line });
      }
    }
  }
  return edges;
}

// ---------------------------------------------------------------------------
// SQL host variable dataflow edges
// ---------------------------------------------------------------------------

// Extracts table names from an uppercase SQL rawText string.
function sqlTableNames(upper: string): string[] {
  const tables = new Set<string>();
  const patterns = [
    /\bFROM\s+([A-Z][A-Z0-9_.-]*)/g,
    /\bJOIN\s+([A-Z][A-Z0-9_.-]*)/g,
    /\bUPDATE\s+([A-Z][A-Z0-9_.-]*)/g,
    /\bINSERT\s+INTO\s+([A-Z][A-Z0-9_.-]*)/g,
    /\bDELETE\s+FROM\s+([A-Z][A-Z0-9_.-]*)/g,
  ];
  for (const pat of patterns) {
    for (const m of upper.matchAll(pat)) {
      if (m[1]) tables.add(m[1]);
    }
  }
  return [...tables];
}

// Host variables in rawText appear as ": VARNAME" because the lexer emits ":" as a
// separate token.  We match that pattern and return upper-cased variable names.
const HOST_VAR_RE = /: ([A-Z][A-Z0-9-]+)/g;

function sqlHostVars(upper: string): string[] {
  return [...upper.matchAll(HOST_VAR_RE)].map((m) => m[1]);
}

function extractSqlEdgesFromStatement(
  stmt: StatementNode,
): Omit<DataflowEdge, "procedure" | "section">[] {
  if (stmt.verb !== "EXEC") return [];
  const upper = stmt.rawText.toUpperCase();
  if (!upper.includes("EXEC SQL ")) return [];

  const opMatch = upper.match(/EXEC\s+SQL\s+([A-Z-]+)/);
  const op = opMatch?.[1];
  if (!op) return [];

  const via = `EXEC SQL ${op}`;
  const line = stmt.loc.line;
  const tables = sqlTableNames(upper);
  const edges: Omit<DataflowEdge, "procedure" | "section">[] = [];

  if (op === "SELECT") {
    // Structure: SELECT cols INTO :writes FROM table WHERE :reads
    const intoIdx = upper.indexOf(" INTO ");
    if (intoIdx < 0) return [];
    const fromIdx = upper.indexOf(" FROM ", intoIdx);

    // Host vars in INTO…FROM zone are written (receiving query results)
    const writeZone = fromIdx >= 0
      ? upper.substring(intoIdx + 6, fromIdx)
      : upper.substring(intoIdx + 6);
    // Host vars in FROM…END zone are read (WHERE/HAVING filter params)
    const readZone = fromIdx >= 0 ? upper.substring(fromIdx) : "";

    const writeVars = sqlHostVars(writeZone);
    const readVars = sqlHostVars(readZone);

    for (const table of tables) {
      for (const wv of writeVars) {
        edges.push({ from: `SQL:${table}`, to: wv, via, line });
      }
    }
    for (const rv of readVars) {
      for (const table of tables) {
        edges.push({ from: rv, to: `SQL:${table}`, via, line });
      }
    }
  } else if (op === "FETCH") {
    // FETCH cursor INTO :writes — all host vars after INTO are writes
    const intoIdx = upper.indexOf(" INTO ");
    if (intoIdx < 0) return [];
    const writeVars = sqlHostVars(upper.substring(intoIdx + 6));

    for (const table of tables) {
      for (const wv of writeVars) {
        edges.push({ from: `SQL:${table}`, to: wv, via, line });
      }
    }
  } else if (op === "INSERT" || op === "UPDATE" || op === "DELETE") {
    const hvs = sqlHostVars(upper);
    for (const hv of hvs) {
      for (const table of tables) {
        edges.push({ from: hv, to: `SQL:${table}`, via, line });
      }
    }
  }

  return edges;
}

export function extractDataflowEdges(ast: CobolAST): DataflowEdge[] {
  const edges: DataflowEdge[] = [];

  for (const div of ast.divisions) {
    if (div.name !== "PROCEDURE") continue;
    for (const sec of div.sections) {
      for (const para of sec.paragraphs) {
        for (const stmt of para.statements) {
          for (const e of edgesFromStatement(stmt)) {
            edges.push({ ...e, procedure: para.name, section: sec.name });
          }
          for (const e of extractSqlEdgesFromStatement(stmt)) {
            edges.push({ ...e, procedure: para.name, section: sec.name });
          }
        }
      }
    }
  }

  return edges;
}
