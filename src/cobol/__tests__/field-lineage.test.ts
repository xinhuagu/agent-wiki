import { describe, it, expect } from "vitest";
import { parse } from "../parser.js";
import { extractModel } from "../extractors.js";
import { buildFieldLineage, generateFieldLineagePage } from "../field-lineage.js";

function model(source: string, filename: string) {
  return extractModel(parse(source, filename));
}

const sharedCopybook = `
       01  CUSTOMER-REC.
           05  CUSTOMER-ID       PIC X(10).
           05  CUSTOMER-ADDRESS.
               10  ZIP-CODE      PIC 9(5).
`;

const customerA = `
       01  CUSTOMER-REC.
           05  CUSTOMER-ID       PIC X(10).
`;

const customerB = `
       01  CLIENT-REC.
           05  CUSTOMER-ID       PIC X(10).
`;

const legacyCustomer = `
       01  LEGACY-CUSTOMER.
           05  CUSTOMER-ID       PIC 9(8).
`;

function program(programId: string, copybook: string): string {
  return `
       IDENTIFICATION DIVISION.
       PROGRAM-ID. ${programId}.
       DATA DIVISION.
       WORKING-STORAGE SECTION.
       COPY ${copybook}.
       PROCEDURE DIVISION.
       A000-MAIN SECTION.
       A100-START.
           STOP RUN.
`;
}

describe("COBOL field lineage", () => {
  it("builds deterministic shared lineage for the same parsed copybook across programs", () => {
    const lineage = buildFieldLineage([
      model(sharedCopybook, "CUSTOMER-REC.cpy"),
      model(program("ORDERA", "CUSTOMER-REC"), "ORDERA.cbl"),
      model(program("ORDERB", "CUSTOMER-REC"), "ORDERB.cbl"),
    ]);

    expect(lineage).not.toBeNull();
    const zipCode = lineage!.deterministic.find((entry) => entry.fieldName === "ZIP-CODE");
    expect(zipCode).toBeDefined();
    expect(zipCode!.copybooks.map((copybook) => copybook.id)).toEqual(["copybook:CUSTOMER-REC"]);
    expect(zipCode!.programs.map((program) => program.id)).toEqual(["program:ORDERA", "program:ORDERB"]);
    expect(zipCode!.qualifiedNames).toContain("CUSTOMER-REC.CUSTOMER-ADDRESS.ZIP-CODE");
    expect(zipCode!.parentQualifiedNames).toContain("CUSTOMER-REC.CUSTOMER-ADDRESS");
    expect(zipCode!.linkage).toBe("deterministic");
  });

  it("marks same-name same-type fields across different copybooks as high-confidence", () => {
    const lineage = buildFieldLineage([
      model(customerA, "CUSTOMER-A.cpy"),
      model(customerB, "CUSTOMER-B.cpy"),
      model(program("BILLINGA", "CUSTOMER-A"), "BILLINGA.cbl"),
      model(program("BILLINGB", "CUSTOMER-B"), "BILLINGB.cbl"),
    ]);

    expect(lineage).not.toBeNull();
    const customerId = lineage!.highConfidence.find((entry) => entry.fieldName === "CUSTOMER-ID");
    expect(customerId).toBeDefined();
    expect(customerId!.copybooks.map((copybook) => copybook.id)).toEqual([
      "copybook:CUSTOMER-A",
      "copybook:CUSTOMER-B",
    ]);
    expect(customerId!.pictures).toEqual(["X(10)"]);
    expect(customerId!.linkage).toBe("high-confidence");
  });

  it("marks conflicting field-name collisions across copybooks as ambiguous", () => {
    const lineage = buildFieldLineage([
      model(customerA, "CUSTOMER-A.cpy"),
      model(legacyCustomer, "LEGACY-CUSTOMER.cpy"),
      model(program("BILLINGA", "CUSTOMER-A"), "BILLINGA.cbl"),
      model(program("LEGACYB", "LEGACY-CUSTOMER"), "LEGACYB.cbl"),
    ]);

    expect(lineage).not.toBeNull();
    const customerId = lineage!.ambiguous.find((entry) => entry.fieldName === "CUSTOMER-ID");
    expect(customerId).toBeDefined();
    expect(customerId!.copybooks.map((copybook) => copybook.id)).toEqual([
      "copybook:CUSTOMER-A",
      "copybook:LEGACY-CUSTOMER",
    ]);
    expect(customerId!.pictures).toEqual(["9(8)", "X(10)"]);
    expect(customerId!.linkage).toBe("ambiguous");
  });

  it("does not treat COPY REPLACING consumers as deterministic shared lineage", () => {
    const orderA = model(program("ORDERA", "CUSTOMER-REC"), "ORDERA.cbl");
    const orderB = model(program("ORDERB", "CUSTOMER-REC"), "ORDERB.cbl");
    orderB.copies[0]!.replacing = ["CUSTOMER-ID", "CLIENT-ID"];

    const lineage = buildFieldLineage([
      model(sharedCopybook, "CUSTOMER-REC.cpy"),
      orderA,
      orderB,
    ]);

    expect(lineage).toBeNull();
  });

  it("summary counts only programs that actually participate in lineage", () => {
    const lineage = buildFieldLineage([
      model(sharedCopybook, "CUSTOMER-REC.cpy"),
      model(customerB, "CUSTOMER-B.cpy"),
      model(program("ORDERA", "CUSTOMER-REC"), "ORDERA.cbl"),
      model(program("ORDERB", "CUSTOMER-REC"), "ORDERB.cbl"),
      model(program("BILLINGB", "CUSTOMER-B"), "BILLINGB.cbl"),
    ]);

    expect(lineage).not.toBeNull();
    expect(lineage!.summary.programs).toBe(3);
    expect(lineage!.copybookUsage.map((entry) => entry.copybookId)).toEqual([
      "copybook:CUSTOMER-B",
      "copybook:CUSTOMER-REC",
    ]);
  });

  it("does not conflate parsed copybooks that share the same basename", () => {
    const billingCommon = `
       01  BILLING-COMMON.
           05  SHARED-ID         PIC X(10).
`;
    const claimsCommon = `
       01  CLAIMS-COMMON.
           05  CLAIM-ID          PIC 9(8).
`;

    const lineage = buildFieldLineage([
      model(billingCommon, "billing/COMMON.cpy"),
      model(claimsCommon, "claims/COMMON.cpy"),
      model(program("BILLINGA", "COMMON"), "BILLINGA.cbl"),
      model(program("BILLINGB", "COMMON"), "BILLINGB.cbl"),
    ]);

    expect(lineage).toBeNull();
  });

  it("generates a lineage wiki summary page", () => {
    const lineage = buildFieldLineage([
      model(sharedCopybook, "CUSTOMER-REC.cpy"),
      model(customerB, "CUSTOMER-B.cpy"),
      model(legacyCustomer, "LEGACY-CUSTOMER.cpy"),
      model(program("ORDERA", "CUSTOMER-REC"), "ORDERA.cbl"),
      model(program("ORDERB", "CUSTOMER-REC"), "ORDERB.cbl"),
      model(program("BILLINGB", "CUSTOMER-B"), "BILLINGB.cbl"),
      model(program("LEGACYB", "LEGACY-CUSTOMER"), "LEGACYB.cbl"),
    ]);

    expect(lineage).not.toBeNull();
    const page = generateFieldLineagePage(lineage!);
    expect(page.path).toBe("cobol/field-lineage.md");
    expect(page.content).toContain("COBOL Field Lineage");
    expect(page.content).toContain("Shared Copybook-Backed Fields");
    expect(page.content).toContain("High-Confidence Candidates");
    expect(page.content).toContain("Ambiguous Collisions");
    expect(page.content).toContain("CUSTOMER-REC");
  });
});
