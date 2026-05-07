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

  it("rationale lists REPLACING as a possible cause when the program uses COPY", () => {
    // The parser can't yet surface REPLACING per-copy (REPLACING/BY are
    // typed tokens excluded from `stmt.operands` — see follow-up issue),
    // so the resolver gates the REPLACING breadcrumb on the cheaper
    // signal: does the program use COPY at all? If yes, the note appears
    // alongside the typo / missing-copybook causes. If no, omitting it
    // avoids misleading users on pure-inline-WS programs.
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
    expect(unresolved?.rationale).toContain("REPLACING");
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
