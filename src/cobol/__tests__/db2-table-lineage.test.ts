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
    expect(entry.writer.hostVars).toContain("WS-NAME");
    expect(entry.reader.programId).toBe("program:READER");
    expect(entry.reader.operations).toEqual(["SELECT"]);
    expect(entry.reader.hostVars).toContain("WS-NAME");
    expect(entry.reader.hostVars).toContain("WS-ID");
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

  it("returns null when a table is only written and never read in the corpus", () => {
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

    // ORPHAN has no reader; SOMETHING-ELSE has no writer; no entries.
    expect(lineage).toBeNull();
  });

  it("excludes non-classifiable operations like DECLARE / OPEN / CLOSE", () => {
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

    // DECLARE is not classified as a write; CUSTOMERS has no writer in scope.
    // READER alone reads, so no lineage emitted.
    expect(lineage).toBeNull();
  });

  it("excludes self-loops where the same program writes and reads the same table", () => {
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
    // self-loop excluded; no cross-program lineage on LOG.
    expect(lineage).toBeNull();
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

  it("returns null when fewer than two parsed programs are provided", () => {
    const writer = programWith("WRITER", [[
      "EXEC SQL INSERT INTO T (X)",
      "  VALUES (:WS-ID) END-EXEC",
    ]]);
    expect(buildDb2TableLineage([model(writer, "WRITER.cbl")])).toBeNull();
  });
});
