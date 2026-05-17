import { describe, it, expect } from "vitest";
import { parse } from "../parser.js";
import { extractModel } from "../extractors.js";
import { buildDb2TableLineage, parseReplacingPairs, parseSqlColumnBindings } from "../db2-table-lineage.js";

describe("parseSqlColumnBindings (#41 Phase A)", () => {
  it("pairs INSERT INTO T (col-list) VALUES (host-list) positionally", () => {
    expect(parseSqlColumnBindings(
      "EXEC SQL INSERT INTO CUSTOMERS (ID, NAME, EMAIL) VALUES (:WS-ID, :WS-NAME, :WS-EMAIL) END-EXEC",
      "INSERT",
    )).toEqual([
      { column: "ID", hostVar: "WS-ID" },
      { column: "NAME", hostVar: "WS-NAME" },
      { column: "EMAIL", hostVar: "WS-EMAIL" },
    ]);
  });

  it("returns empty for INSERT without column list (positional binding impossible)", () => {
    expect(parseSqlColumnBindings(
      "EXEC SQL INSERT INTO CUSTOMERS VALUES (:WS-ID, :WS-NAME) END-EXEC",
      "INSERT",
    )).toEqual([]);
  });

  it("aborts INSERT binding when column count != value count (arity mismatch)", () => {
    expect(parseSqlColumnBindings(
      "EXEC SQL INSERT INTO CUSTOMERS (ID, NAME) VALUES (:WS-ID, :WS-NAME, :WS-EMAIL) END-EXEC",
      "INSERT",
    )).toEqual([]);
  });

  it("skips non-host-var INSERT values (literals, NULL, function calls) but keeps the rest", () => {
    expect(parseSqlColumnBindings(
      "EXEC SQL INSERT INTO T (A, B, C) VALUES (:WS-A, 'literal', :WS-C) END-EXEC",
      "INSERT",
    )).toEqual([
      { column: "A", hostVar: "WS-A" },
      { column: "C", hostVar: "WS-C" },
    ]);
  });

  it("pairs SELECT col-list INTO host-list FROM... positionally", () => {
    expect(parseSqlColumnBindings(
      "EXEC SQL SELECT ID, NAME INTO :WS-ID, :WS-NAME FROM CUSTOMERS END-EXEC",
      "SELECT",
    )).toEqual([
      { column: "ID", hostVar: "WS-ID" },
      { column: "NAME", hostVar: "WS-NAME" },
    ]);
  });

  it("returns empty for SELECT without INTO (subquery, no host-var landing)", () => {
    expect(parseSqlColumnBindings(
      "EXEC SQL SELECT ID FROM CUSTOMERS WHERE NAME = :WS-NAME END-EXEC",
      "SELECT",
    )).toEqual([]);
  });

  it("pairs UPDATE SET col = :host explicitly; WHERE host vars do NOT bind", () => {
    expect(parseSqlColumnBindings(
      "EXEC SQL UPDATE CUSTOMERS SET NAME = :WS-NAME, EMAIL = :WS-EMAIL WHERE ID = :WS-ID END-EXEC",
      "UPDATE",
    )).toEqual([
      { column: "NAME", hostVar: "WS-NAME" },
      { column: "EMAIL", hostVar: "WS-EMAIL" },
    ]);
  });

  it("UPDATE without WHERE: last assignment still binds (END-EXEC anchor)", () => {
    // Without an END-EXEC anchor in the regex, the trailing token would
    // leak into the last assignment string and the strict
    // `col = :host` match would drop it. Locks the END-EXEC behavior.
    expect(parseSqlColumnBindings(
      "EXEC SQL UPDATE T SET A = :WS-A, B = :WS-B END-EXEC",
      "UPDATE",
    )).toEqual([
      { column: "A", hostVar: "WS-A" },
      { column: "B", hostVar: "WS-B" },
    ]);
  });

  it("UPDATE: arithmetic / function on the right-hand side drops that assignment", () => {
    expect(parseSqlColumnBindings(
      "EXEC SQL UPDATE T SET COUNT = COUNT + 1, NAME = :WS-NAME WHERE ID = :WS-ID END-EXEC",
      "UPDATE",
    )).toEqual([
      { column: "NAME", hostVar: "WS-NAME" },
    ]);
  });

  it("does not split commas inside nested parens (function calls in column list)", () => {
    // `COALESCE(A, B)` shouldn't shatter the column list into 4 entries
    // and produce a wrong pairing. Pattern doesn't match (function isn't
    // a plain column name) → bindings drop cleanly for that position;
    // the bare-column / host-var positions still bind.
    expect(parseSqlColumnBindings(
      "EXEC SQL SELECT COALESCE(A, B), C INTO :WS-AB, :WS-C FROM T END-EXEC",
      "SELECT",
    )).toEqual([
      { column: "C", hostVar: "WS-C" },
    ]);
  });

  it("returns empty for FETCH (column list lives on the DECLARE CURSOR, not here)", () => {
    expect(parseSqlColumnBindings(
      "EXEC SQL FETCH C1 INTO :WS-ID, :WS-NAME END-EXEC",
      "FETCH",
    )).toEqual([]);
  });

  it("returns empty when operation is undefined", () => {
    expect(parseSqlColumnBindings("anything", undefined)).toEqual([]);
  });

  it("handles multi-line SQL (newlines between clauses)", () => {
    const sql = `EXEC SQL
      INSERT INTO CUSTOMERS
        (ID, NAME)
      VALUES
        (:WS-ID, :WS-NAME)
      END-EXEC`;
    expect(parseSqlColumnBindings(sql, "INSERT")).toEqual([
      { column: "ID", hostVar: "WS-ID" },
      { column: "NAME", hostVar: "WS-NAME" },
    ]);
  });
});

describe("parseReplacingPairs (#37 Phase A)", () => {
  it("parses single-token form X BY Y", () => {
    expect(parseReplacingPairs(["X", "BY", "Y"])).toEqual([{ from: "X", to: "Y" }]);
  });

  it("parses pseudo-text form ==X== BY ==Y== as the COBOL lexer shatters it", () => {
    // The actual parser output for `REPLACING ==X== BY ==Y==` because `=`
    // lexes as a single-character operator and shatters the `==` markers.
    const shattered = ["=", "=", "X", "=", "=", "BY", "=", "=", "Y", "=", "="];
    expect(parseReplacingPairs(shattered)).toEqual([{ from: "X", to: "Y" }]);
  });

  it("also accepts pre-joined ==X== tokens (defensive — in case upstream doesn't shatter)", () => {
    expect(parseReplacingPairs(["==X==", "BY", "==Y=="])).toEqual([{ from: "X", to: "Y" }]);
  });

  it("parses multi-pair form X BY Y Z BY W", () => {
    expect(parseReplacingPairs(["X", "BY", "Y", "Z", "BY", "W"])).toEqual([
      { from: "X", to: "Y" },
      { from: "Z", to: "W" },
    ]);
  });

  it("drops pairs whose tokens aren't valid identifiers (shattered pseudo-text)", () => {
    // Lexer-shattered tokens that aren't legal COBOL identifiers must not
    // produce substitutions — Phase A treats them as unrecognized and falls
    // through to host-var-unresolved.
    expect(parseReplacingPairs(["=", "BY", "="])).toEqual([]);
    expect(parseReplacingPairs([":T", "BY", "WS"])).toEqual([]); // fragment prefix
  });

  it("returns empty array when REPLACING token list lacks BY entirely", () => {
    expect(parseReplacingPairs(["X", "Y"])).toEqual([]);
    expect(parseReplacingPairs([])).toEqual([]);
  });
});

function model(source: string, filename: string) {
  return extractModel(parse(source, filename));
}

function programWith(programId: string, sqlBlocks: string[][]): string {
  // Each SQL block is an array of lines (so callers can split long SQL across
  // lines to stay within fixed-format col 72). Each line is indented by 11
  // spaces — typical PROCEDURE DIVISION code position.
  return `
       IDENTIFICATION DIVISION.
       PROGRAM-ID. ${programId}.
       DATA DIVISION.
       WORKING-STORAGE SECTION.
       01  WS-NAME            PIC X(30).
       01  WS-ID              PIC 9(8).
       PROCEDURE DIVISION.
       A000-MAIN SECTION.
       A100-START.
${sqlBlocks.flatMap((block) => block.map((line) => `           ${line}`)).join("\n")}
           STOP RUN.
`;
}

describe("buildDb2TableLineage", () => {
  it("emits a writer→reader pair when one program inserts and another selects from the same table", () => {
    const writer = programWith("WRITER", [[
      "EXEC SQL INSERT INTO CUSTOMERS (NAME)",
      "  VALUES (:WS-NAME) END-EXEC",
    ]]);
    const reader = programWith("READER", [[
      "EXEC SQL SELECT NAME INTO :WS-NAME",
      "  FROM CUSTOMERS WHERE :WS-ID > 0 END-EXEC",
    ]]);

    const lineage = buildDb2TableLineage([
      model(writer, "WRITER.cbl"),
      model(reader, "READER.cbl"),
    ]);

    expect(lineage).not.toBeNull();
    expect(lineage!.summary.sharedTables).toBe(1);
    expect(lineage!.entries).toHaveLength(1);
    const entry = lineage!.entries[0];
    expect(entry.confidence).toBe("deterministic");
    expect(entry.table).toBe("CUSTOMERS");
    expect(entry.writer.programId).toBe("program:WRITER");
    expect(entry.writer.operations).toEqual(["INSERT"]);
    expect(entry.writer.hostVars.map((hv) => hv.name)).toContain("WS-NAME");
    expect(entry.reader.programId).toBe("program:READER");
    expect(entry.reader.operations).toEqual(["SELECT"]);
    expect(entry.reader.hostVars.map((hv) => hv.name)).toContain("WS-NAME");
    expect(entry.reader.hostVars.map((hv) => hv.name)).toContain("WS-ID");
    // Phase A: each resolved host var carries a DataItem ref with shape info.
    const wsName = entry.writer.hostVars.find((hv) => hv.name === "WS-NAME");
    expect(wsName?.dataItem?.picture).toBe("X(30)");
    expect(wsName?.dataItem?.level).toBe(1);
    const wsId = entry.reader.hostVars.find((hv) => hv.name === "WS-ID");
    expect(wsId?.dataItem?.picture).toBe("9(8)");
  });

  it("emits one entry per (writer × reader) pair when multiple writers feed one reader", () => {
    const writerA = programWith("WRITERA", [[
      "EXEC SQL INSERT INTO LOG (MSG)",
      "  VALUES (:WS-NAME) END-EXEC",
    ]]);
    const writerB = programWith("WRITERB", [[
      "EXEC SQL UPDATE LOG SET MSG = :WS-NAME",
      "  WHERE ID = :WS-ID END-EXEC",
    ]]);
    const reader = programWith("READER", [[
      "EXEC SQL SELECT MSG INTO :WS-NAME",
      "  FROM LOG END-EXEC",
    ]]);

    const lineage = buildDb2TableLineage([
      model(writerA, "WRITERA.cbl"),
      model(writerB, "WRITERB.cbl"),
      model(reader, "READER.cbl"),
    ]);

    expect(lineage).not.toBeNull();
    expect(lineage!.summary.sharedTables).toBe(1);
    expect(lineage!.entries).toHaveLength(2);
    const writerIds = lineage!.entries.map((e) => e.writer.programId).sort();
    expect(writerIds).toEqual(["program:WRITERA", "program:WRITERB"]);
    expect(lineage!.entries.every((e) => e.reader.programId === "program:READER")).toBe(true);
  });

  it("emits one entry per (writer × reader) pair when multiple readers fan out from one writer", () => {
    const writer = programWith("WRITER", [[
      "EXEC SQL INSERT INTO ORDERS (ID)",
      "  VALUES (:WS-ID) END-EXEC",
    ]]);
    const readerA = programWith("READERA", [[
      "EXEC SQL SELECT ID INTO :WS-ID",
      "  FROM ORDERS END-EXEC",
    ]]);
    const readerB = programWith("READERB", [[
      "EXEC SQL FETCH C-ORDERS",
      "  INTO :WS-ID FROM ORDERS END-EXEC",
    ]]);

    const lineage = buildDb2TableLineage([
      model(writer, "WRITER.cbl"),
      model(readerA, "READERA.cbl"),
      model(readerB, "READERB.cbl"),
    ]);

    expect(lineage).not.toBeNull();
    expect(lineage!.entries).toHaveLength(2);
    const readerIds = lineage!.entries.map((e) => e.reader.programId).sort();
    expect(readerIds).toEqual(["program:READERA", "program:READERB"]);
  });

  it("emits writer-only / reader-only diagnostics when a table flows only one way", () => {
    const writer = programWith("WRITER", [[
      "EXEC SQL INSERT INTO ORPHAN (NAME)",
      "  VALUES (:WS-NAME) END-EXEC",
    ]]);
    const other = programWith("OTHER", [[
      "EXEC SQL SELECT NAME INTO :WS-NAME",
      "  FROM SOMETHING-ELSE END-EXEC",
    ]]);

    const lineage = buildDb2TableLineage([
      model(writer, "WRITER.cbl"),
      model(other, "OTHER.cbl"),
    ]);

    // ORPHAN has no reader; SOMETHING-ELSE has no writer; no entries but
    // both are surfaced as diagnostics.
    expect(lineage).not.toBeNull();
    expect(lineage!.entries).toHaveLength(0);
    const byKind = lineage!.diagnostics.reduce<Record<string, string[]>>((acc, d) => {
      (acc[d.kind] ??= []).push(d.table ?? "");
      return acc;
    }, {});
    expect(byKind["writer-only"]).toEqual(["ORPHAN"]);
    expect(byKind["reader-only"]).toEqual(["SOMETHING-ELSE"]);
  });

  it("emits non-classifiable-op diagnostic for DECLARE / OPEN / CLOSE", () => {
    const declarer = programWith("DECLARER", [[
      "EXEC SQL DECLARE C-CUR CURSOR FOR",
      "  SELECT ID FROM CUSTOMERS END-EXEC",
    ]]);
    const reader = programWith("READER", [[
      "EXEC SQL SELECT ID INTO :WS-ID",
      "  FROM CUSTOMERS END-EXEC",
    ]]);

    const lineage = buildDb2TableLineage([
      model(declarer, "DECLARER.cbl"),
      model(reader, "READER.cbl"),
    ]);

    // DECLARE is not in WRITE_OPS or READ_OPS; surfaces as non-classifiable-op.
    // READER alone reads CUSTOMERS, so it surfaces as reader-only.
    expect(lineage).not.toBeNull();
    expect(lineage!.entries).toHaveLength(0);
    const declareDiag = lineage!.diagnostics.find((d) => d.kind === "non-classifiable-op");
    expect(declareDiag?.operation).toBe("DECLARE");
    expect(lineage!.diagnostics.some((d) => d.kind === "reader-only" && d.table === "CUSTOMERS")).toBe(true);
  });

  it("emits self-loop diagnostic when one program writes and reads the same table", () => {
    const both = programWith("BOTH", [
      ["EXEC SQL INSERT INTO LOG (MSG)", "  VALUES (:WS-NAME) END-EXEC"],
      ["EXEC SQL SELECT MSG INTO :WS-NAME", "  FROM LOG END-EXEC"],
    ]);
    const other = programWith("OTHER", [[
      "EXEC SQL SELECT ID INTO :WS-ID",
      "  FROM CUSTOMERS END-EXEC",
    ]]);

    const lineage = buildDb2TableLineage([
      model(both, "BOTH.cbl"),
      model(other, "OTHER.cbl"),
    ]);

    // BOTH is the only program touching LOG, and it both writes and reads —
    // self-loop diagnostic emitted; no entry on LOG.
    expect(lineage).not.toBeNull();
    expect(lineage!.entries).toHaveLength(0);
    const selfLoop = lineage!.diagnostics.find((d) => d.kind === "self-loop");
    expect(selfLoop?.table).toBe("LOG");
    expect(selfLoop?.programId).toBe("program:BOTH");
  });

  it("aggregates multiple write ops on the same table from the same program", () => {
    // Real-world pattern (seen in dogfood: SAMPLE-D writes to T2 via both
    // INSERT and UPDATE). Both ops should appear on the writer side.
    const writer = programWith("WRITER", [
      ["EXEC SQL INSERT INTO LOG (MSG)", "  VALUES (:WS-NAME) END-EXEC"],
      ["EXEC SQL UPDATE LOG SET MSG = :WS-NAME", "  WHERE :WS-ID > 0 END-EXEC"],
    ]);
    const reader = programWith("READER", [[
      "EXEC SQL SELECT MSG INTO :WS-NAME",
      "  FROM LOG END-EXEC",
    ]]);

    const lineage = buildDb2TableLineage([
      model(writer, "WRITER.cbl"),
      model(reader, "READER.cbl"),
    ]);

    expect(lineage).not.toBeNull();
    expect(lineage!.entries).toHaveLength(1);
    const entry = lineage!.entries[0];
    expect(entry.writer.operations).toEqual(["INSERT", "UPDATE"]);
    expect(entry.evidence.writerOps).toEqual(["INSERT", "UPDATE"]);
    expect(entry.rationale).toContain("INSERT,UPDATE");
  });

  it("attaches an EvidenceEnvelope (strong/deterministic) to each entry", () => {
    const writer = programWith("WRITER", [[
      "EXEC SQL INSERT INTO SHARED (X)",
      "  VALUES (:WS-X) END-EXEC",
    ]]);
    const reader = programWith("READER", [[
      "EXEC SQL SELECT X INTO :WS-X",
      "  FROM SHARED END-EXEC",
    ]]);
    const lineage = buildDb2TableLineage([
      model(writer, "WRITER.cbl"),
      model(reader, "READER.cbl"),
    ]);
    expect(lineage).not.toBeNull();
    const entry = lineage!.entries[0]!;
    expect(entry.envelope.confidence).toBe("strong");
    expect(entry.envelope.basis).toBe("deterministic");
    expect(entry.envelope.abstain).toBe(false);
    expect(entry.envelope.provenance).toEqual([
      { raw: "WRITER.cbl" },
      { raw: "READER.cbl" },
    ]);
  });

  it("returns null when fewer than two parsed programs are provided", () => {
    const writer = programWith("WRITER", [[
      "EXEC SQL INSERT INTO T (X)",
      "  VALUES (:WS-ID) END-EXEC",
    ]]);
    expect(buildDb2TableLineage([model(writer, "WRITER.cbl")])).toBeNull();
  });

  it("emits host-var-unresolved diagnostic when SQL references a name not in the data tree", () => {
    // The fixture only declares WS-NAME and WS-ID; :WS-MISSING is bogus.
    const writer = programWith("WRITER", [[
      "EXEC SQL INSERT INTO ORDERS (ID, NAME)",
      "  VALUES (:WS-ID, :WS-MISSING) END-EXEC",
    ]]);
    const reader = programWith("READER", [[
      "EXEC SQL SELECT NAME INTO :WS-NAME FROM ORDERS END-EXEC",
    ]]);

    const lineage = buildDb2TableLineage([
      model(writer, "WRITER.cbl"),
      model(reader, "READER.cbl"),
    ]);

    expect(lineage).not.toBeNull();
    const unresolved = lineage!.diagnostics.filter((d) => d.kind === "host-var-unresolved");
    expect(unresolved).toHaveLength(1);
    expect(unresolved[0].programId).toBe("program:WRITER");
    expect(unresolved[0].hostVar).toBe("WS-MISSING");
    expect(unresolved[0].rationale).toContain("WS-MISSING");
    expect(lineage!.summary.diagnosticsByKind["host-var-unresolved"]).toBe(1);
    // The unresolved name still appears on the participant (without dataItem)
    // so the wiki can render it with a `(?)` flag rather than dropping it.
    const writerEntry = lineage!.entries.find((e) => e.writer.programId === "program:WRITER");
    const missing = writerEntry?.writer.hostVars.find((hv) => hv.name === "WS-MISSING");
    expect(missing).toBeDefined();
    expect(missing?.dataItem).toBeUndefined();
  });

  it("dedupes host-var-unresolved diagnostics — same name across multiple SQL blocks fires once", () => {
    const writer = programWith("WRITER", [
      [
        "EXEC SQL INSERT INTO T (X) VALUES (:WS-MISSING) END-EXEC",
      ],
      [
        "EXEC SQL UPDATE T SET X = :WS-MISSING WHERE ID = :WS-ID END-EXEC",
      ],
    ]);
    const reader = programWith("READER", [[
      "EXEC SQL SELECT X INTO :WS-NAME FROM T END-EXEC",
    ]]);

    const lineage = buildDb2TableLineage([
      model(writer, "WRITER.cbl"),
      model(reader, "READER.cbl"),
    ]);

    expect(lineage).not.toBeNull();
    const unresolved = lineage!.diagnostics.filter(
      (d) => d.kind === "host-var-unresolved" && d.hostVar === "WS-MISSING",
    );
    expect(unresolved).toHaveLength(1);
  });

  it("resolves host vars declared in LINKAGE (callee subprogram pattern)", () => {
    // A callee subprogram receives its host vars via CALL USING, so they
    // live in LINKAGE, not WORKING-STORAGE. Searching only dataItems
    // would emit a spurious `host-var-unresolved` for this very common
    // pattern in COBOL/DB2 systems.
    const callee = `
       IDENTIFICATION DIVISION.
       PROGRAM-ID. CALLEE.
       DATA DIVISION.
       WORKING-STORAGE SECTION.
       01  WS-LOCAL           PIC X(8).
       LINKAGE SECTION.
       01  LK-CUSTOMER-ID     PIC 9(8).
       01  LK-NAME            PIC X(30).
       PROCEDURE DIVISION USING LK-CUSTOMER-ID, LK-NAME.
       A000-MAIN SECTION.
       A100-START.
           EXEC SQL UPDATE CUSTOMERS SET NAME = :LK-NAME
             WHERE ID = :LK-CUSTOMER-ID END-EXEC.
           GOBACK.
`;
    const reader = programWith("READER", [[
      "EXEC SQL SELECT NAME INTO :WS-NAME FROM CUSTOMERS END-EXEC",
    ]]);

    const lineage = buildDb2TableLineage([
      model(callee, "CALLEE.cbl"),
      model(reader, "READER.cbl"),
    ]);

    expect(lineage).not.toBeNull();
    const writerEntry = lineage!.entries.find((e) => e.writer.programId === "program:CALLEE");
    const lkId = writerEntry?.writer.hostVars.find((hv) => hv.name === "LK-CUSTOMER-ID");
    expect(lkId?.dataItem?.picture).toBe("9(8)");
    expect(lkId?.dataItem?.level).toBe(1);
    const lkName = writerEntry?.writer.hostVars.find((hv) => hv.name === "LK-NAME");
    expect(lkName?.dataItem?.picture).toBe("X(30)");
    // LINKAGE-declared host vars are NOT unresolved.
    const unresolved = lineage!.diagnostics.filter((d) => d.kind === "host-var-unresolved");
    expect(unresolved).toHaveLength(0);
  });

  it("emits one host-var-unresolved per program when the SAME missing name appears in multiple programs", () => {
    // The dedup key is `${programId}|${name}` — same name in two programs
    // must NOT collapse to one diagnostic, since the user has to fix both
    // programs independently.
    const writer = programWith("WRITER", [[
      "EXEC SQL INSERT INTO T (X) VALUES (:WS-MISSING) END-EXEC",
    ]]);
    const reader = programWith("READER", [[
      "EXEC SQL SELECT X INTO :WS-MISSING FROM T END-EXEC",
    ]]);

    const lineage = buildDb2TableLineage([
      model(writer, "WRITER.cbl"),
      model(reader, "READER.cbl"),
    ]);

    expect(lineage).not.toBeNull();
    const unresolved = lineage!.diagnostics.filter(
      (d) => d.kind === "host-var-unresolved" && d.hostVar === "WS-MISSING",
    );
    expect(unresolved).toHaveLength(2);
    const programIds = unresolved.map((d) => d.programId).sort();
    expect(programIds).toEqual(["program:READER", "program:WRITER"]);
  });

  it("resolves nested host vars (declared as a child of a group record)", () => {
    // Override the standard fixture with a program that declares the SQL host
    // var as a 05-level child of a group record — this is the typical layout
    // when the field lives in a copybook-defined record like CUSTOMER-RECORD.
    const writer = `
       IDENTIFICATION DIVISION.
       PROGRAM-ID. WRITER.
       DATA DIVISION.
       WORKING-STORAGE SECTION.
       01  CUSTOMER-RECORD.
           05  CUST-ID         PIC 9(8).
           05  CUST-NAME       PIC X(30).
       PROCEDURE DIVISION.
       A000-MAIN SECTION.
       A100-START.
           EXEC SQL INSERT INTO CUSTOMERS (ID, NAME)
             VALUES (:CUST-ID, :CUST-NAME) END-EXEC.
           STOP RUN.
`;
    const reader = programWith("READER", [[
      "EXEC SQL SELECT ID INTO :WS-ID FROM CUSTOMERS END-EXEC",
    ]]);

    const lineage = buildDb2TableLineage([
      model(writer, "WRITER.cbl"),
      model(reader, "READER.cbl"),
    ]);

    expect(lineage).not.toBeNull();
    const writerEntry = lineage!.entries.find((e) => e.writer.programId === "program:WRITER");
    const custId = writerEntry?.writer.hostVars.find((hv) => hv.name === "CUST-ID");
    expect(custId?.dataItem?.level).toBe(5);
    expect(custId?.dataItem?.picture).toBe("9(8)");
    // No unresolved diagnostic for the nested fields.
    const unresolved = lineage!.diagnostics.filter((d) => d.kind === "host-var-unresolved");
    expect(unresolved).toHaveLength(0);
  });

  it("resolves host vars defined in a COPY'd copybook and tags originCopybook", () => {
    // Phase B: parser does NOT inline-expand COPY, so copybook fields
    // aren't in program.dataItems. Without copybook fallback, every
    // SQL host var sourced from a copybook would emit a spurious
    // host-var-unresolved.
    const copybook = `
       01  CUSTOMER-RECORD.
           05  CUST-ID         PIC 9(8).
           05  CUST-NAME       PIC X(30).
`;
    const writer = `
       IDENTIFICATION DIVISION.
       PROGRAM-ID. WRITER.
       DATA DIVISION.
       WORKING-STORAGE SECTION.
           COPY CUSTID.
       PROCEDURE DIVISION.
       A000-MAIN SECTION.
       A100-START.
           EXEC SQL INSERT INTO CUSTOMERS (ID, NAME)
             VALUES (:CUST-ID, :CUST-NAME) END-EXEC.
           STOP RUN.
`;
    const reader = programWith("READER", [[
      "EXEC SQL SELECT ID INTO :WS-ID FROM CUSTOMERS END-EXEC",
    ]]);

    const lineage = buildDb2TableLineage([
      model(copybook, "CUSTID.cpy"),
      model(writer, "WRITER.cbl"),
      model(reader, "READER.cbl"),
    ]);

    expect(lineage).not.toBeNull();
    const writerEntry = lineage!.entries.find((e) => e.writer.programId === "program:WRITER");
    const custId = writerEntry?.writer.hostVars.find((hv) => hv.name === "CUST-ID");
    expect(custId?.dataItem?.picture).toBe("9(8)");
    expect(custId?.dataItem?.originCopybook).toBe("CUSTID");
    const custName = writerEntry?.writer.hostVars.find((hv) => hv.name === "CUST-NAME");
    expect(custName?.dataItem?.originCopybook).toBe("CUSTID");
    // No unresolved diagnostic — copybook search picked them up.
    const unresolved = lineage!.diagnostics.filter((d) => d.kind === "host-var-unresolved");
    expect(unresolved).toHaveLength(0);
  });

  it("inline WS fields don't carry originCopybook — absence ≠ unresolved", () => {
    const writer = programWith("WRITER", [[
      "EXEC SQL INSERT INTO T (X) VALUES (:WS-NAME) END-EXEC",
    ]]);
    const reader = programWith("READER", [[
      "EXEC SQL SELECT X INTO :WS-NAME FROM T END-EXEC",
    ]]);

    const lineage = buildDb2TableLineage([
      model(writer, "WRITER.cbl"),
      model(reader, "READER.cbl"),
    ]);

    const wsName = lineage!.entries[0].writer.hostVars.find((hv) => hv.name === "WS-NAME");
    expect(wsName?.dataItem).toBeDefined();        // resolved …
    expect(wsName?.dataItem?.originCopybook).toBeUndefined();  // … but inline, not from a copybook
  });

  it("emits host-var-unresolved when COPY references a copybook NOT in the parsed corpus", () => {
    // Program copies CUSTID but no CUSTID.cpy is passed — the resolver
    // can't follow the breadcrumb. Should still emit the diagnostic, with
    // the rationale pointing at the missing-copybook case.
    const writer = `
       IDENTIFICATION DIVISION.
       PROGRAM-ID. WRITER.
       DATA DIVISION.
       WORKING-STORAGE SECTION.
           COPY CUSTID.
       PROCEDURE DIVISION.
       A000-MAIN SECTION.
       A100-START.
           EXEC SQL INSERT INTO T (X) VALUES (:CUST-ID) END-EXEC.
           STOP RUN.
`;
    const reader = programWith("READER", [[
      "EXEC SQL SELECT X INTO :WS-NAME FROM T END-EXEC",
    ]]);

    const lineage = buildDb2TableLineage([
      // CUSTID.cpy intentionally NOT included
      model(writer, "WRITER.cbl"),
      model(reader, "READER.cbl"),
    ]);

    expect(lineage).not.toBeNull();
    const unresolved = lineage!.diagnostics.filter(
      (d) => d.kind === "host-var-unresolved" && d.hostVar === "CUST-ID",
    );
    expect(unresolved).toHaveLength(1);
    expect(unresolved[0].rationale).toContain("copybook");
  });

  it("inline WS field shadows a copybook field of the same name", () => {
    // Three-tier precedence (WS → LINKAGE → copybook) must keep WS first.
    // If a program declares WS-NAME inline AND copies a copybook that also
    // has WS-NAME, the inline declaration wins — and originCopybook is
    // absent because the resolver never reached the copybook tier. The
    // `originCopybook === undefined` assertion is what genuinely verifies
    // precedence: parser doesn't expand COPY inline, so `program.dataItems`
    // only contains the inline declaration; the copybook fields live in
    // the separate parsed copybook model. The resolver hitting WS first
    // is what we're locking.
    const copybook = `
       01  COPYBOOK-WS-NAME       PIC X(99).
       01  WS-NAME                PIC X(99).
`;
    const writer = `
       IDENTIFICATION DIVISION.
       PROGRAM-ID. WRITER.
       DATA DIVISION.
       WORKING-STORAGE SECTION.
       01  WS-NAME            PIC X(30).
           COPY OVERLAP.
       PROCEDURE DIVISION.
       A000-MAIN SECTION.
       A100-START.
           EXEC SQL INSERT INTO T (X) VALUES (:WS-NAME) END-EXEC.
           STOP RUN.
`;
    const reader = programWith("READER", [[
      "EXEC SQL SELECT X INTO :WS-ID FROM T END-EXEC",
    ]]);

    const lineage = buildDb2TableLineage([
      model(copybook, "OVERLAP.cpy"),
      model(writer, "WRITER.cbl"),
      model(reader, "READER.cbl"),
    ]);

    const wsName = lineage!.entries[0].writer.hostVars.find((hv) => hv.name === "WS-NAME");
    // Inline X(30) wins over copybook's X(99) — and origin is absent.
    expect(wsName?.dataItem?.picture).toBe("X(30)");
    expect(wsName?.dataItem?.originCopybook).toBeUndefined();
  });

  it("resolves REDEFINES siblings inside a copybook", () => {
    // REDEFINES in a copybook — both the original and the redefining alias
    // must resolve as distinct items via depth-first walk through children.
    const copybook = `
       01  RECORD-AREA.
           05  RAW-BUF         PIC X(8).
           05  PARSED-BUF REDEFINES RAW-BUF.
               10  PARSED-PART PIC X(4).
               10  PARSED-TAG  PIC X(4).
`;
    const writer = `
       IDENTIFICATION DIVISION.
       PROGRAM-ID. WRITER.
       DATA DIVISION.
       WORKING-STORAGE SECTION.
           COPY REDEF.
       PROCEDURE DIVISION.
       A000-MAIN SECTION.
       A100-START.
           EXEC SQL INSERT INTO T (RAW, ALIAS, TAG)
             VALUES (:RAW-BUF, :PARSED-BUF, :PARSED-TAG) END-EXEC.
           STOP RUN.
`;
    const reader = programWith("READER", [[
      "EXEC SQL SELECT RAW INTO :WS-NAME FROM T END-EXEC",
    ]]);

    const lineage = buildDb2TableLineage([
      model(copybook, "REDEF.cpy"),
      model(writer, "WRITER.cbl"),
      model(reader, "READER.cbl"),
    ]);

    const writerEntry = lineage!.entries.find((e) => e.writer.programId === "program:WRITER");
    const rawBuf = writerEntry?.writer.hostVars.find((hv) => hv.name === "RAW-BUF");
    const parsedTag = writerEntry?.writer.hostVars.find((hv) => hv.name === "PARSED-TAG");
    expect(rawBuf?.dataItem?.picture).toBe("X(8)");
    expect(parsedTag?.dataItem?.picture).toBe("X(4)");
    expect(rawBuf?.dataItem?.originCopybook).toBe("REDEF");
    expect(parsedTag?.dataItem?.originCopybook).toBe("REDEF");
    // The redefining group itself (PARSED-BUF) is also resolvable as an
    // alias for the original storage. As a group record it has no PIC
    // (children carry the PICs).
    const parsedBuf = writerEntry?.writer.hostVars.find((hv) => hv.name === "PARSED-BUF");
    expect(parsedBuf?.dataItem).toBeDefined();
    expect(parsedBuf?.dataItem?.picture).toBeUndefined();
    expect(parsedBuf?.dataItem?.originCopybook).toBe("REDEF");
  });

  it("rationale lists REPLACING as a possible cause when the program uses COPY ... REPLACING (#21)", () => {
    // Now that #21 fixed the parser's REPLACING detection (rawText-based
    // instead of stmt.operands-based, which always missed because
    // REPLACING/BY are typed keyword tokens), the gate is accurate
    // per-program: ONLY programs that actually use REPLACING get the
    // breadcrumb, not every program that uses any COPY.
    const copybook = `
       01  CUSTOMER-RECORD.
           05  CUST-ID         PIC 9(8).
`;
    const writer = `
       IDENTIFICATION DIVISION.
       PROGRAM-ID. WRITER.
       DATA DIVISION.
       WORKING-STORAGE SECTION.
           COPY CUSTID REPLACING CUST-ID BY ORDER-ID.
       PROCEDURE DIVISION.
       A000-MAIN SECTION.
       A100-START.
           EXEC SQL INSERT INTO T (X) VALUES (:WS-MISSING) END-EXEC.
           STOP RUN.
`;
    const reader = programWith("READER", [[
      "EXEC SQL SELECT X INTO :WS-NAME FROM T END-EXEC",
    ]]);

    const lineage = buildDb2TableLineage([
      model(copybook, "CUSTID.cpy"),
      model(writer, "WRITER.cbl"),
      model(reader, "READER.cbl"),
    ]);

    const unresolved = lineage!.diagnostics.find(
      (d) => d.kind === "host-var-unresolved" && d.hostVar === "WS-MISSING",
    );
    expect(unresolved?.rationale).toContain("REPLACING");
  });

  it("rationale OMITS REPLACING note when program uses COPY but NOT REPLACING (#21 accurate gate)", () => {
    // Companion test: prior to #21, this case would have falsely
    // surfaced the REPLACING breadcrumb because the gate was the loose
    // heuristic `program.copies.length > 0`. Now the gate uses the
    // accurate per-copy REPLACING flag, so a plain COPY (no REPLACING)
    // doesn't trigger the note.
    const copybook = `
       01  CUSTOMER-RECORD.
           05  CUST-ID         PIC 9(8).
`;
    const writer = `
       IDENTIFICATION DIVISION.
       PROGRAM-ID. WRITER.
       DATA DIVISION.
       WORKING-STORAGE SECTION.
           COPY CUSTID.
       PROCEDURE DIVISION.
       A000-MAIN SECTION.
       A100-START.
           EXEC SQL INSERT INTO T (X) VALUES (:WS-MISSING) END-EXEC.
           STOP RUN.
`;
    const reader = programWith("READER", [[
      "EXEC SQL SELECT X INTO :WS-NAME FROM T END-EXEC",
    ]]);

    const lineage = buildDb2TableLineage([
      model(copybook, "CUSTID.cpy"),
      model(writer, "WRITER.cbl"),
      model(reader, "READER.cbl"),
    ]);

    const unresolved = lineage!.diagnostics.find(
      (d) => d.kind === "host-var-unresolved" && d.hostVar === "WS-MISSING",
    );
    expect(unresolved?.rationale).not.toContain("REPLACING");
    // Other breadcrumbs still present.
    expect(unresolved?.rationale).toContain("typos");
    expect(unresolved?.rationale).toContain("copybook");
  });

  it("rationale OMITS REPLACING note for pure-inline-WS programs (no COPY)", () => {
    // Program has no COPY directives — the REPLACING note would be
    // misleading noise. Locks the gate so future refactors don't drop
    // the conditional and re-introduce the always-on text.
    const writer = programWith("WRITER", [[
      "EXEC SQL INSERT INTO T (X) VALUES (:WS-MISSING) END-EXEC",
    ]]);
    const reader = programWith("READER", [[
      "EXEC SQL SELECT X INTO :WS-NAME FROM T END-EXEC",
    ]]);

    const lineage = buildDb2TableLineage([
      model(writer, "WRITER.cbl"),
      model(reader, "READER.cbl"),
    ]);

    const unresolved = lineage!.diagnostics.find(
      (d) => d.kind === "host-var-unresolved" && d.hostVar === "WS-MISSING",
    );
    expect(unresolved?.rationale).not.toContain("REPLACING");
    // … but the typo and missing-copybook breadcrumbs should still be there.
    expect(unresolved?.rationale).toContain("typos");
  });

  describe("DB2 column-level host-var binding (#41 Phase A)", () => {
    // SQL fixtures: every line stays inside COBOL fixed-format columns
    // 8-72. `programWithSql` glues an array of pre-indented SQL lines
    // into a PROCEDURE DIVISION around a fixed three-field WS layout.
    function programWithSql(programId: string, sqlLines: string[]): string {
      const lines = sqlLines.map((l) => `           ${l}`).join("\n");
      return `
       IDENTIFICATION DIVISION.
       PROGRAM-ID. ${programId}.
       DATA DIVISION.
       WORKING-STORAGE SECTION.
       01  WS-ID              PIC X(10).
       01  WS-NAME            PIC X(30).
       01  WS-EMAIL           PIC X(50).
       PROCEDURE DIVISION.
       A000-MAIN SECTION.
       A100-START.
${lines}
           STOP RUN.
`;
    }
    const reader = programWithSql("READER", [
      "EXEC SQL SELECT ID, NAME INTO :WS-ID, :WS-NAME",
      "         FROM CUSTOMERS END-EXEC.",
    ]);

    it("attaches column to writer host vars from INSERT (col-list) VALUES (host-list)", () => {
      const writer = programWithSql("WRITER", [
        "EXEC SQL INSERT INTO CUSTOMERS (ID, NAME, EMAIL)",
        "         VALUES (:WS-ID, :WS-NAME, :WS-EMAIL) END-EXEC.",
      ]);
      const lineage = buildDb2TableLineage([
        model(writer, "WRITER.cbl"),
        model(reader, "READER.cbl"),
      ]);
      const entry = lineage!.entries[0]!;
      const byName = new Map(entry.writer.hostVars.map((hv) => [hv.name, hv]));
      expect(byName.get("WS-ID")?.columns).toEqual(["ID"]);
      expect(byName.get("WS-NAME")?.columns).toEqual(["NAME"]);
      expect(byName.get("WS-EMAIL")?.columns).toEqual(["EMAIL"]);
    });

    it("attaches column to reader host vars from SELECT col-list INTO host-list", () => {
      const writer = programWithSql("WRITER", [
        "EXEC SQL INSERT INTO CUSTOMERS (ID, NAME)",
        "         VALUES (:WS-ID, :WS-NAME) END-EXEC.",
      ]);
      const lineage = buildDb2TableLineage([
        model(writer, "WRITER.cbl"),
        model(reader, "READER.cbl"),
      ]);
      const readerVars = lineage!.entries[0]!.reader.hostVars;
      expect(readerVars.find((hv) => hv.name === "WS-ID")?.columns).toEqual(["ID"]);
      expect(readerVars.find((hv) => hv.name === "WS-NAME")?.columns).toEqual(["NAME"]);
    });

    it("attaches column on UPDATE SET pairs; WHERE-clause host vars stay unbound", () => {
      const updater = programWithSql("UPDATER", [
        "EXEC SQL UPDATE CUSTOMERS",
        "         SET NAME = :WS-NAME, EMAIL = :WS-EMAIL",
        "         WHERE ID = :WS-ID END-EXEC.",
      ]);
      const lineage = buildDb2TableLineage([
        model(updater, "UPDATER.cbl"),
        model(reader, "READER.cbl"),
      ]);
      const writerVars = lineage!.entries[0]!.writer.hostVars;
      const byName = new Map(writerVars.map((hv) => [hv.name, hv]));
      expect(byName.get("WS-NAME")?.columns).toEqual(["NAME"]);
      expect(byName.get("WS-EMAIL")?.columns).toEqual(["EMAIL"]);
      // WHERE clause filter — no column binding.
      expect(byName.get("WS-ID")?.columns).toEqual([]);
      expect(byName.get("WS-ID")?.column).toBeUndefined();
      // But the host var itself is still resolved (has a dataItem).
      expect(byName.get("WS-ID")?.dataItem?.picture).toBe("X(10)");
    });

    it("falls through to no column when INSERT has no column list", () => {
      const writer = programWithSql("WRITER", [
        "EXEC SQL INSERT INTO CUSTOMERS",
        "         VALUES (:WS-ID, :WS-NAME, :WS-EMAIL) END-EXEC.",
      ]);
      const lineage = buildDb2TableLineage([
        model(writer, "WRITER.cbl"),
        model(reader, "READER.cbl"),
      ]);
      const writerVars = lineage!.entries[0]!.writer.hostVars;
      // Host vars still listed; just no column attached.
      expect(writerVars.find((hv) => hv.name === "WS-ID")?.dataItem?.picture).toBe("X(10)");
      expect(writerVars.every((hv) => hv.columns.length === 0)).toBe(true);
    });

    it("a later SQL ref can attach a column to a host var first seen unbound", () => {
      // Two SQL blocks in the same program against the same table: the
      // first uses a WHERE filter (no column binding), the second is an
      // INSERT with a column list. The bump-merge logic attaches the
      // column from the second block to the existing host-var entry.
      const writer = programWithSql("WRITER", [
        "EXEC SQL SELECT NAME FROM CUSTOMERS",
        "         WHERE ID = :WS-ID END-EXEC.",
        "EXEC SQL INSERT INTO CUSTOMERS (ID, NAME)",
        "         VALUES (:WS-ID, :WS-NAME) END-EXEC.",
      ]);
      const lineage = buildDb2TableLineage([
        model(writer, "WRITER.cbl"),
        model(reader, "READER.cbl"),
      ]);
      const writerVars = lineage!.entries[0]!.writer.hostVars;
      expect(writerVars.find((hv) => hv.name === "WS-ID")?.columns).toEqual(["ID"]);
      expect(writerVars.find((hv) => hv.name === "WS-NAME")?.columns).toEqual(["NAME"]);
    });

    it("aborts column binding on arity mismatch (3 cols, 2 hosts) — host vars still listed without column", () => {
      // Caller wrote a buggy SQL: 3 columns, only 2 values. We refuse
      // to guess a positional pairing for the surviving values, drop
      // ALL bindings for that ref.
      const writer = programWithSql("WRITER", [
        "EXEC SQL INSERT INTO CUSTOMERS (ID, NAME, EMAIL)",
        "         VALUES (:WS-ID, :WS-NAME) END-EXEC.",
      ]);
      const lineage = buildDb2TableLineage([
        model(writer, "WRITER.cbl"),
        model(reader, "READER.cbl"),
      ]);
      const writerVars = lineage!.entries[0]!.writer.hostVars;
      expect(writerVars.every((hv) => hv.columns.length === 0)).toBe(true);
    });
  });

  describe("DB2 cross-program column-level pairing (#41 Phase B)", () => {
    // Reuses the column-binding writer / reader shapes from Phase A.
    // The new assertion target is `entry.columnPairs` — each pair
    // asserts `writerHostVar → column → readerHostVar` cross-program
    // flow when both sides bind the same column.
    function makeWriter(programId: string, sql: string[]): string {
      const lines = sql.map((l) => `           ${l}`).join("\n");
      return `
       IDENTIFICATION DIVISION.
       PROGRAM-ID. ${programId}.
       DATA DIVISION.
       WORKING-STORAGE SECTION.
       01  WR-ID              PIC X(10).
       01  WR-NAME            PIC X(30).
       01  WR-EMAIL           PIC X(50).
       PROCEDURE DIVISION.
       A000-MAIN SECTION.
       A100-START.
${lines}
           STOP RUN.
`;
    }
    function makeReader(programId: string, sql: string[]): string {
      const lines = sql.map((l) => `           ${l}`).join("\n");
      return `
       IDENTIFICATION DIVISION.
       PROGRAM-ID. ${programId}.
       DATA DIVISION.
       WORKING-STORAGE SECTION.
       01  RD-ID              PIC X(10).
       01  RD-NAME            PIC X(30).
       PROCEDURE DIVISION.
       A000-MAIN SECTION.
       A100-START.
${lines}
           STOP RUN.
`;
    }

    it("emits a column pair per shared (writer-bound, reader-bound) column", () => {
      const writer = makeWriter("WRITER", [
        "EXEC SQL INSERT INTO CUSTOMERS (ID, NAME, EMAIL)",
        "         VALUES (:WR-ID, :WR-NAME, :WR-EMAIL) END-EXEC.",
      ]);
      const reader = makeReader("READER", [
        "EXEC SQL SELECT ID, NAME INTO :RD-ID, :RD-NAME",
        "         FROM CUSTOMERS END-EXEC.",
      ]);
      const lineage = buildDb2TableLineage([
        model(writer, "WRITER.cbl"),
        model(reader, "READER.cbl"),
      ]);
      const entry = lineage!.entries[0]!;
      // EMAIL drops because the reader doesn't bind it; ID and NAME pair.
      expect(entry.columnPairs).toEqual([
        { column: "ID", writerHostVar: "WR-ID", readerHostVar: "RD-ID" },
        { column: "NAME", writerHostVar: "WR-NAME", readerHostVar: "RD-NAME" },
      ]);
      expect(lineage!.summary.columnPairs).toBe(2);
    });

    it("emits no column pairs when one side has no column bindings", () => {
      // Writer uses INSERT-without-column-list → no bindings on writer side.
      // Reader's INTO bindings exist but can't intersect.
      const writer = makeWriter("WRITER", [
        "EXEC SQL INSERT INTO CUSTOMERS",
        "         VALUES (:WR-ID, :WR-NAME, :WR-EMAIL) END-EXEC.",
      ]);
      const reader = makeReader("READER", [
        "EXEC SQL SELECT ID, NAME INTO :RD-ID, :RD-NAME",
        "         FROM CUSTOMERS END-EXEC.",
      ]);
      const lineage = buildDb2TableLineage([
        model(writer, "WRITER.cbl"),
        model(reader, "READER.cbl"),
      ]);
      expect(lineage!.entries[0]!.columnPairs).toEqual([]);
      expect(lineage!.summary.columnPairs).toBe(0);
    });

    it("emits no column pairs when both sides bind but on disjoint columns", () => {
      const writer = makeWriter("WRITER", [
        "EXEC SQL INSERT INTO CUSTOMERS (ID)",
        "         VALUES (:WR-ID) END-EXEC.",
      ]);
      const reader = makeReader("READER", [
        "EXEC SQL SELECT NAME INTO :RD-NAME",
        "         FROM CUSTOMERS END-EXEC.",
      ]);
      const lineage = buildDb2TableLineage([
        model(writer, "WRITER.cbl"),
        model(reader, "READER.cbl"),
      ]);
      expect(lineage!.entries[0]!.columnPairs).toEqual([]);
    });

    it("handles UPDATE writer + SELECT INTO reader (SET-clause columns only)", () => {
      // The writer's WHERE clause binds :WR-ID against ID for filtering,
      // not column-writing, so :WR-ID has no column. The SET pairs do
      // bind. The reader's SELECT INTO binds both columns.
      const writer = makeWriter("WRITER", [
        "EXEC SQL UPDATE CUSTOMERS",
        "         SET NAME = :WR-NAME, EMAIL = :WR-EMAIL",
        "         WHERE ID = :WR-ID END-EXEC.",
      ]);
      const reader = makeReader("READER", [
        "EXEC SQL SELECT NAME, EMAIL INTO :RD-NAME, :RD-EMAIL",
        "         FROM CUSTOMERS END-EXEC.",
      ]);
      // RD-EMAIL needs a declaration matching the reader fixture.
      const reader2 = `
       IDENTIFICATION DIVISION.
       PROGRAM-ID. READER.
       DATA DIVISION.
       WORKING-STORAGE SECTION.
       01  RD-NAME            PIC X(30).
       01  RD-EMAIL           PIC X(50).
       PROCEDURE DIVISION.
       A000-MAIN SECTION.
       A100-START.
           EXEC SQL SELECT NAME, EMAIL INTO :RD-NAME, :RD-EMAIL
                    FROM CUSTOMERS END-EXEC.
           STOP RUN.
`;
      // Ignore reader from the helper (didn't have RD-EMAIL), use reader2.
      void reader;
      const lineage = buildDb2TableLineage([
        model(writer, "WRITER.cbl"),
        model(reader2, "READER.cbl"),
      ]);
      const entry = lineage!.entries[0]!;
      // WR-ID drops (no column, WHERE filter); NAME and EMAIL pair.
      expect(entry.columnPairs).toEqual([
        { column: "EMAIL", writerHostVar: "WR-EMAIL", readerHostVar: "RD-EMAIL" },
        { column: "NAME", writerHostVar: "WR-NAME", readerHostVar: "RD-NAME" },
      ]);
    });

    it("Cartesian intersection emits one pair per (writer-side, reader-side) host var when both bind the same column", () => {
      // Writer has two host vars binding NAME via different SQL refs:
      // INSERT NAME = :WR-NAME and UPDATE SET NAME = :WR-EMAIL. The bump
      // merge dedupes per-host-var-name (not per-column), so both
      // bindings survive. The reader has one host var on NAME. The
      // Cartesian intersection therefore emits two pairs — both writer
      // host vars feed the same column that the reader receives from.
      // This is the documented behavior; downstream dedup is the
      // consumer's call.
      const writer = makeWriter("WRITER", [
        "EXEC SQL INSERT INTO CUSTOMERS (NAME)",
        "         VALUES (:WR-NAME) END-EXEC.",
        "EXEC SQL UPDATE CUSTOMERS SET NAME = :WR-EMAIL",
        "         WHERE ID = '1' END-EXEC.",
      ]);
      const reader = makeReader("READER", [
        "EXEC SQL SELECT NAME INTO :RD-NAME",
        "         FROM CUSTOMERS END-EXEC.",
      ]);
      const lineage = buildDb2TableLineage([
        model(writer, "WRITER.cbl"),
        model(reader, "READER.cbl"),
      ]);
      const pairs = lineage!.entries[0]!.columnPairs;
      // Two writer host vars × one reader host var on the same column → 2 pairs.
      // Sorted by writerHostVar.
      expect(pairs).toEqual([
        { column: "NAME", writerHostVar: "WR-EMAIL", readerHostVar: "RD-NAME" },
        { column: "NAME", writerHostVar: "WR-NAME", readerHostVar: "RD-NAME" },
      ]);
    });

    it("regression: column pairs are deterministically sorted", () => {
      // Two columns bound on both sides; the sort must be stable regardless
      // of host-var iteration order. Lock against future Map / Set order
      // changes by asserting full equality.
      const writer = makeWriter("WRITER", [
        "EXEC SQL INSERT INTO CUSTOMERS (NAME, ID)",
        "         VALUES (:WR-NAME, :WR-ID) END-EXEC.",
      ]);
      const reader = makeReader("READER", [
        "EXEC SQL SELECT NAME, ID INTO :RD-NAME, :RD-ID",
        "         FROM CUSTOMERS END-EXEC.",
      ]);
      const lineage = buildDb2TableLineage([
        model(writer, "WRITER.cbl"),
        model(reader, "READER.cbl"),
      ]);
      // Sort key: column → writerHostVar → readerHostVar (alphabetical).
      expect(lineage!.entries[0]!.columnPairs).toEqual([
        { column: "ID", writerHostVar: "WR-ID", readerHostVar: "RD-ID" },
        { column: "NAME", writerHostVar: "WR-NAME", readerHostVar: "RD-NAME" },
      ]);
    });

    it("multi-column binding on a single host var: each column produces its own pair (Codex review fix)", () => {
      // The Codex review on #43 caught that the pre-fix code stored only
      // the first column per host var, silently dropping later bindings
      // and the Phase B intersection along with them. Concrete case:
      // INSERT binds :WR-ID to BOTH ID and ALT_ID; a reader selecting
      // ALT_ID INTO :RD-ALT-ID must still pair through the second
      // column.
      const writer = makeWriter("WRITER", [
        "EXEC SQL INSERT INTO CUSTOMERS (ID, ALT_ID)",
        "         VALUES (:WR-ID, :WR-ID) END-EXEC.",
      ]);
      const reader = `
       IDENTIFICATION DIVISION.
       PROGRAM-ID. READER.
       DATA DIVISION.
       WORKING-STORAGE SECTION.
       01  RD-ID              PIC X(10).
       01  RD-ALT-ID          PIC X(10).
       PROCEDURE DIVISION.
       A000-MAIN SECTION.
       A100-START.
           EXEC SQL SELECT ALT_ID INTO :RD-ALT-ID
                    FROM CUSTOMERS END-EXEC.
           STOP RUN.
`;
      const lineage = buildDb2TableLineage([
        model(writer, "WRITER.cbl"),
        model(reader, "READER.cbl"),
      ]);
      // Writer's :WR-ID carries both columns.
      const wrId = lineage!.entries[0]!.writer.hostVars.find((hv) => hv.name === "WR-ID");
      expect(wrId?.columns).toEqual(["ALT_ID", "ID"]); // sorted for byte-stable artifact
      // `column` is the #41 Phase A back-compat alias — first-observed
      // in the SQL, not alphabetically first. INSERT lists ID before
      // ALT_ID, so column === "ID".
      expect(wrId?.column).toBe("ID");
      // The Phase B intersection now produces the ALT_ID flow that the
      // pre-fix code silently dropped.
      expect(lineage!.entries[0]!.columnPairs).toEqual([
        { column: "ALT_ID", writerHostVar: "WR-ID", readerHostVar: "RD-ALT-ID" },
      ]);
    });

    it("multi-table SQL refs skip column binding to avoid false cross-table pairs (Codex review fix)", () => {
      // The Codex review on #43 caught that a SELECT touching multiple
      // tables (via subqueries, joins, or WHERE EXISTS) had the same
      // column bindings attached to every table — so a writer to T2
      // would falsely pair through a reader that actually reads from
      // T1. Fix: when ref.tables.length > 1, parseSqlColumnBindings is
      // skipped and no host var carries a column. The Phase B
      // intersection therefore emits no false pairs.
      const writer = makeWriter("WRITER", [
        "EXEC SQL INSERT INTO ORDERS (ID)",
        "         VALUES (:WR-ID) END-EXEC.",
      ]);
      // Reader's SELECT mentions both ORDERS (FROM) and CUSTOMERS
      // (in a subquery). extractSqlTableNames returns both tables.
      const reader = `
       IDENTIFICATION DIVISION.
       PROGRAM-ID. READER.
       DATA DIVISION.
       WORKING-STORAGE SECTION.
       01  RD-ID              PIC X(10).
       PROCEDURE DIVISION.
       A000-MAIN SECTION.
       A100-START.
           EXEC SQL SELECT ID INTO :RD-ID FROM CUSTOMERS
                    WHERE ID IN (SELECT CUST_ID FROM ORDERS) END-EXEC.
           STOP RUN.
`;
      const lineage = buildDb2TableLineage([
        model(writer, "WRITER.cbl"),
        model(reader, "READER.cbl"),
      ]);
      // ORDERS is the shared table → entry exists.
      const ordersEntry = lineage!.entries.find((e) => e.table === "ORDERS");
      expect(ordersEntry).toBeDefined();
      // Reader's :RD-ID has NO column binding because the multi-table
      // ref triggered the guard. So no false pair through ORDERS.ID.
      const rdId = ordersEntry!.reader.hostVars.find((hv) => hv.name === "RD-ID");
      expect(rdId?.columns).toEqual([]);
      expect(ordersEntry!.columnPairs).toEqual([]);
    });

    it("summary.columnPairs sums across multiple writer-reader entries", () => {
      // One writer, two readers — produces two entries (one per writer-
      // reader pair). Each entry contributes its own columnPairs; the
      // summary counter is the sum.
      const writer = makeWriter("WRITER", [
        "EXEC SQL INSERT INTO CUSTOMERS (ID, NAME)",
        "         VALUES (:WR-ID, :WR-NAME) END-EXEC.",
      ]);
      const reader1 = makeReader("READER1", [
        "EXEC SQL SELECT ID, NAME INTO :RD-ID, :RD-NAME",
        "         FROM CUSTOMERS END-EXEC.",
      ]);
      const reader2 = makeReader("READER2", [
        "EXEC SQL SELECT NAME INTO :RD-NAME",
        "         FROM CUSTOMERS END-EXEC.",
      ]);
      const lineage = buildDb2TableLineage([
        model(writer, "WRITER.cbl"),
        model(reader1, "READER1.cbl"),
        model(reader2, "READER2.cbl"),
      ]);
      // Two entries: (WRITER, READER1) → 2 pairs, (WRITER, READER2) → 1 pair.
      expect(lineage!.entries.length).toBe(2);
      expect(lineage!.summary.columnPairs).toBe(3);
    });
  });

  describe("REPLACING-aware host-var resolution (#37 Phase A)", () => {
    const customerCopybook = `
       01  CUSTOMER-REC.
           05  CUSTOMER-ID       PIC X(10).
           05  CUSTOMER-NAME     PIC X(30).
`;

    function writerWithCopy(copyDirective: string, hostVar: string): string {
      return `
       IDENTIFICATION DIVISION.
       PROGRAM-ID. WRITER.
       DATA DIVISION.
       WORKING-STORAGE SECTION.
           ${copyDirective}
       PROCEDURE DIVISION.
       A000-MAIN SECTION.
       A100-START.
           EXEC SQL INSERT INTO CUSTOMERS (ID) VALUES (:${hostVar}) END-EXEC.
           STOP RUN.
`;
    }

    const reader = `
       IDENTIFICATION DIVISION.
       PROGRAM-ID. READER.
       DATA DIVISION.
       WORKING-STORAGE SECTION.
       01  WS-ID              PIC X(10).
       PROCEDURE DIVISION.
       A000-MAIN SECTION.
       A100-START.
           EXEC SQL SELECT ID INTO :WS-ID FROM CUSTOMERS END-EXEC.
           STOP RUN.
`;

    it("resolves single-token REPLACING (CUSTOMER-ID BY CLIENT-ID)", () => {
      const writer = writerWithCopy(
        "COPY CUSTOMER-REC REPLACING CUSTOMER-ID BY CLIENT-ID.",
        "CLIENT-ID",
      );
      const lineage = buildDb2TableLineage([
        model(customerCopybook, "CUSTOMER-REC.cpy"),
        model(writer, "WRITER.cbl"),
        model(reader, "READER.cbl"),
      ]);
      expect(lineage).not.toBeNull();
      const entry = lineage!.entries[0]!;
      const clientId = entry.writer.hostVars.find((hv) => hv.name === "CLIENT-ID");
      expect(clientId?.dataItem).toBeDefined();
      expect(clientId?.dataItem?.name).toBe("CUSTOMER-ID");
      expect(clientId?.dataItem?.picture).toBe("X(10)");
      expect(clientId?.dataItem?.originCopybook).toBe("CUSTOMER-REC");
      expect(clientId?.dataItem?.replacingSubstitution).toEqual({
        fromName: "CUSTOMER-ID",
        toName: "CLIENT-ID",
      });
      // No host-var-unresolved diagnostic for CLIENT-ID after Phase A.
      expect(
        lineage!.diagnostics.some(
          (d) => d.kind === "host-var-unresolved" && d.hostVar === "CLIENT-ID",
        ),
      ).toBe(false);
    });

    it("resolves pseudo-text REPLACING (==CUSTOMER-ID== BY ==CLIENT-ID==)", () => {
      const writer = writerWithCopy(
        "COPY CUSTOMER-REC REPLACING ==CUSTOMER-ID== BY ==CLIENT-ID==.",
        "CLIENT-ID",
      );
      const lineage = buildDb2TableLineage([
        model(customerCopybook, "CUSTOMER-REC.cpy"),
        model(writer, "WRITER.cbl"),
        model(reader, "READER.cbl"),
      ]);
      const entry = lineage!.entries[0]!;
      const clientId = entry.writer.hostVars.find((hv) => hv.name === "CLIENT-ID");
      expect(clientId?.dataItem?.name).toBe("CUSTOMER-ID");
      expect(clientId?.dataItem?.replacingSubstitution?.fromName).toBe("CUSTOMER-ID");
    });

    it("resolves multi-pair REPLACING (two pairs in one COPY)", () => {
      const writer = `
       IDENTIFICATION DIVISION.
       PROGRAM-ID. WRITER.
       DATA DIVISION.
       WORKING-STORAGE SECTION.
           COPY CUSTOMER-REC REPLACING CUSTOMER-ID BY CLIENT-ID
                                       CUSTOMER-NAME BY CLIENT-NAME.
       PROCEDURE DIVISION.
       A000-MAIN SECTION.
       A100-START.
           EXEC SQL INSERT INTO CUSTOMERS (ID, NAME)
              VALUES (:CLIENT-ID, :CLIENT-NAME) END-EXEC.
           STOP RUN.
`;
      const lineage = buildDb2TableLineage([
        model(customerCopybook, "CUSTOMER-REC.cpy"),
        model(writer, "WRITER.cbl"),
        model(reader, "READER.cbl"),
      ]);
      const writerVars = lineage!.entries[0]!.writer.hostVars;
      const clientId = writerVars.find((hv) => hv.name === "CLIENT-ID");
      const clientName = writerVars.find((hv) => hv.name === "CLIENT-NAME");
      expect(clientId?.dataItem?.name).toBe("CUSTOMER-ID");
      expect(clientName?.dataItem?.name).toBe("CUSTOMER-NAME");
      expect(clientId?.dataItem?.replacingSubstitution?.fromName).toBe("CUSTOMER-ID");
      expect(clientName?.dataItem?.replacingSubstitution?.fromName).toBe("CUSTOMER-NAME");
    });

    it("falls through to host-var-unresolved when the SQL name doesn't match any REPLACING target", () => {
      // REPLACING is present (CUSTOMER-ID BY CLIENT-ID) but the SQL
      // references a third name — neither a copybook field nor a `to`
      // value. Phase A must not promote this to "resolved".
      const writer = writerWithCopy(
        "COPY CUSTOMER-REC REPLACING CUSTOMER-ID BY CLIENT-ID.",
        "STRAY-NAME",
      );
      const lineage = buildDb2TableLineage([
        model(customerCopybook, "CUSTOMER-REC.cpy"),
        model(writer, "WRITER.cbl"),
        model(reader, "READER.cbl"),
      ]);
      const entry = lineage!.entries[0]!;
      const stray = entry.writer.hostVars.find((hv) => hv.name === "STRAY-NAME");
      expect(stray?.dataItem).toBeUndefined();
      expect(
        lineage!.diagnostics.some(
          (d) => d.kind === "host-var-unresolved" && d.hostVar === "STRAY-NAME",
        ),
      ).toBe(true);
    });

    it("does not attach replacingSubstitution when resolution succeeded via direct copybook lookup", () => {
      // SQL references a name that's actually in the copybook — Phase A
      // fallback must not run. replacingSubstitution stays undefined.
      const writer = writerWithCopy(
        "COPY CUSTOMER-REC REPLACING CUSTOMER-ID BY CLIENT-ID.",
        "CUSTOMER-NAME",
      );
      const lineage = buildDb2TableLineage([
        model(customerCopybook, "CUSTOMER-REC.cpy"),
        model(writer, "WRITER.cbl"),
        model(reader, "READER.cbl"),
      ]);
      const entry = lineage!.entries[0]!;
      const custName = entry.writer.hostVars.find((hv) => hv.name === "CUSTOMER-NAME");
      expect(custName?.dataItem?.name).toBe("CUSTOMER-NAME");
      expect(custName?.dataItem?.replacingSubstitution).toBeUndefined();
    });

    it("inline WS declaration shadows REPLACING substitution (precedence preserved)", () => {
      // Program has BOTH a REPLACING that would resolve CLIENT-ID and
      // an inline WS declaration of CLIENT-ID. Inline must win — same
      // precedence rule the rest of the resolver uses.
      const writer = `
       IDENTIFICATION DIVISION.
       PROGRAM-ID. WRITER.
       DATA DIVISION.
       WORKING-STORAGE SECTION.
       01  CLIENT-ID            PIC X(99).
           COPY CUSTOMER-REC REPLACING CUSTOMER-ID BY CLIENT-ID.
       PROCEDURE DIVISION.
       A000-MAIN SECTION.
       A100-START.
           EXEC SQL INSERT INTO CUSTOMERS (ID) VALUES (:CLIENT-ID) END-EXEC.
           STOP RUN.
`;
      const lineage = buildDb2TableLineage([
        model(customerCopybook, "CUSTOMER-REC.cpy"),
        model(writer, "WRITER.cbl"),
        model(reader, "READER.cbl"),
      ]);
      const clientId = lineage!.entries[0]!.writer.hostVars.find((hv) => hv.name === "CLIENT-ID");
      expect(clientId?.dataItem?.picture).toBe("X(99)"); // inline WS, not the copybook
      expect(clientId?.dataItem?.replacingSubstitution).toBeUndefined();
      expect(clientId?.dataItem?.originCopybook).toBeUndefined();
    });
  });

  it("originCopybook is deterministic across input orders when copybooks share a logical name", () => {
    // Two .cpy files share the basename "SHARED.cpy" but live at
    // different paths. The map sort by sourceFile makes the resolver's
    // "first match" stable regardless of which CobolCodeModel order
    // the caller passed. Without the sort, originCopybook would flip
    // depending on filesystem listing.
    const cpyA = `
       01  SHARED-FIELD       PIC X(8).
`;
    const cpyB = `
       01  SHARED-FIELD       PIC X(99).
`;
    const writer = `
       IDENTIFICATION DIVISION.
       PROGRAM-ID. WRITER.
       DATA DIVISION.
       WORKING-STORAGE SECTION.
           COPY SHARED.
       PROCEDURE DIVISION.
       A000-MAIN SECTION.
       A100-START.
           EXEC SQL INSERT INTO T (X) VALUES (:SHARED-FIELD) END-EXEC.
           STOP RUN.
`;
    const reader = programWith("READER", [[
      "EXEC SQL SELECT X INTO :WS-NAME FROM T END-EXEC",
    ]]);

    // Two copybook files at different paths but same canonical name.
    const a = model(cpyA, "dir-a/SHARED.cpy");
    const b = model(cpyB, "dir-b/SHARED.cpy");
    const w = model(writer, "WRITER.cbl");
    const r = model(reader, "READER.cbl");

    const lineage1 = buildDb2TableLineage([a, b, w, r])!;
    const lineage2 = buildDb2TableLineage([b, a, w, r])!;
    const find = (l: typeof lineage1): string | undefined => l.entries
      .find((e) => e.writer.programId === "program:WRITER")
      ?.writer.hostVars.find((hv) => hv.name === "SHARED-FIELD")
      ?.dataItem?.picture;
    // Same input set → same resolution regardless of array order. The
    // sort by sourceFile makes "dir-a/SHARED.cpy" win deterministically.
    expect(find(lineage1)).toBe("X(8)");
    expect(find(lineage2)).toBe("X(8)");
  });
});
