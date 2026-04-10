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
