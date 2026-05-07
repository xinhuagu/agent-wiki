import { describe, it, expect } from "vitest";
import { parse } from "../parser.js";
import { extractModel } from "../extractors.js";
import { buildDb2TableLineage } from "../db2-table-lineage.js";

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
});
