import { describe, it, expect } from "vitest";
import { cobolTierToEvidence, type CobolLineageTier } from "../evidence-mapping.js";

describe("cobolTierToEvidence", () => {
  it("maps deterministic tier to strong/deterministic", () => {
    expect(cobolTierToEvidence("deterministic")).toEqual({
      confidence: "strong",
      basis: "deterministic",
    });
  });

  it("maps high and inferredHighConfidence to weak/inferred", () => {
    expect(cobolTierToEvidence("high")).toEqual({
      confidence: "weak",
      basis: "inferred",
    });
    expect(cobolTierToEvidence("inferredHighConfidence")).toEqual({
      confidence: "weak",
      basis: "inferred",
    });
  });

  it("maps ambiguous and inferredAmbiguous to absent/inferred", () => {
    expect(cobolTierToEvidence("ambiguous")).toEqual({
      confidence: "absent",
      basis: "inferred",
    });
    expect(cobolTierToEvidence("inferredAmbiguous")).toEqual({
      confidence: "absent",
      basis: "inferred",
    });
  });

  it("covers every tier — exhaustive enumeration documents the supported set", () => {
    // Adding a new lineage tier without updating cobolTierToEvidence will
    // fail TypeScript's exhaustive switch at compile time; this test
    // additionally documents the current set so a contributor sees the
    // checklist.
    const allTiers: CobolLineageTier[] = [
      "deterministic",
      "high",
      "ambiguous",
      "inferredHighConfidence",
      "inferredAmbiguous",
    ];
    for (const tier of allTiers) {
      const result = cobolTierToEvidence(tier);
      expect(["strong", "weak", "absent"]).toContain(result.confidence);
      expect(["deterministic", "inferred"]).toContain(result.basis);
    }
  });
});
