import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import yaml from "js-yaml";
import type { WikiConfig } from "./wiki.js";
import { VERSION } from "./version.js";

export const OKF_FORMAT = "agent-wiki-okf";
export const OKF_FORMAT_VERSION = "0.1";
export const OKF_MANIFEST_FILENAME = "agent-wiki.yaml";

export type OkfIssueSeverity = "error" | "warning" | "info";

export interface OkfFormatCheckIssue {
  severity: OkfIssueSeverity;
  path: string;
  message: string;
  suggestion?: string;
}

export interface OkfManifest {
  format: typeof OKF_FORMAT;
  format_version: string;
  name: string;
  version: string;
  license: string;
  owner: string;
  created_at: string;
  description?: string;
  generator?: {
    name: string;
    version: string;
  };
  source_policy: {
    raw_immutable: true;
    require_sha256: true;
    require_meta_sidecars?: boolean;
  };
  wiki_policy: {
    require_sources_for_grounded_pages: boolean;
    allow_synthesis_pages: boolean;
    stale_after_days?: number;
  };
  evidence_policy: {
    allow_unsupported_pages: "allow" | "warn" | "reject";
    require_abstain_signal: boolean;
  };
  metadata?: Record<string, unknown>;
}

export interface OkfFormatCheckReport {
  ok: boolean;
  format: typeof OKF_FORMAT;
  expectedFormatVersion: typeof OKF_FORMAT_VERSION;
  manifestPath: string;
  packageRoot: string;
  schema: string;
  manifest?: OkfManifest;
  issues: OkfFormatCheckIssue[];
  checked: {
    manifest: boolean;
    rawDir: boolean;
    wikiDir: boolean;
    schemasDir: boolean;
  };
}

const TOP_LEVEL_KEYS = new Set([
  "format",
  "format_version",
  "name",
  "version",
  "license",
  "owner",
  "created_at",
  "description",
  "generator",
  "source_policy",
  "wiki_policy",
  "evidence_policy",
  "metadata",
]);

const SOURCE_POLICY_KEYS = new Set([
  "raw_immutable",
  "require_sha256",
  "require_meta_sidecars",
]);

const WIKI_POLICY_KEYS = new Set([
  "require_sources_for_grounded_pages",
  "allow_synthesis_pages",
  "stale_after_days",
]);

const EVIDENCE_POLICY_KEYS = new Set([
  "allow_unsupported_pages",
  "require_abstain_signal",
]);

const GENERATOR_KEYS = new Set(["name", "version"]);

export function runOkfFormatCheck(config: WikiConfig): OkfFormatCheckReport {
  const packageRoot = config.workspace;
  const manifestPath = join(packageRoot, OKF_MANIFEST_FILENAME);
  const issues: OkfFormatCheckIssue[] = [];
  let manifest: OkfManifest | undefined;

  if (!existsSync(manifestPath)) {
    issues.push({
      severity: "error",
      path: OKF_MANIFEST_FILENAME,
      message: `Missing ${OKF_MANIFEST_FILENAME} package manifest.`,
      suggestion: `Create ${OKF_MANIFEST_FILENAME} at the package root and validate it against schemas/agent-wiki-okf.schema.json.`,
    });
  } else {
    try {
      const parsed = yaml.load(readFileSync(manifestPath, "utf-8"));
      manifest = validateManifest(parsed, issues);
    } catch (err) {
      issues.push({
        severity: "error",
        path: OKF_MANIFEST_FILENAME,
        message: `Could not parse ${OKF_MANIFEST_FILENAME}: ${err instanceof Error ? err.message : String(err)}`,
        suggestion: "Fix the YAML syntax and run format-check again.",
      });
    }
  }

  checkDirectory(config.rawDir, "raw/", true, issues);
  checkDirectory(config.wikiDir, "wiki/", true, issues);
  checkDirectory(config.schemasDir, "schemas/", false, issues);

  if (manifest?.generator?.name === "agent-wiki" && manifest.generator.version !== VERSION) {
    issues.push({
      severity: "info",
      path: "agent-wiki.yaml:generator.version",
      message: `Manifest generator version is ${manifest.generator.version}; current agent-wiki version is ${VERSION}.`,
      suggestion: "This is informational only. Rebuild package metadata when you want the manifest to reflect the current tool version.",
    });
  }

  return {
    ok: issues.every((issue) => issue.severity !== "error"),
    format: OKF_FORMAT,
    expectedFormatVersion: OKF_FORMAT_VERSION,
    manifestPath,
    packageRoot,
    schema: "schemas/agent-wiki-okf.schema.json",
    manifest,
    issues,
    checked: {
      manifest: existsSync(manifestPath),
      rawDir: directoryExists(config.rawDir),
      wikiDir: directoryExists(config.wikiDir),
      schemasDir: directoryExists(config.schemasDir),
    },
  };
}

function validateManifest(input: unknown, issues: OkfFormatCheckIssue[]): OkfManifest | undefined {
  if (!isRecord(input)) {
    issues.push({
      severity: "error",
      path: OKF_MANIFEST_FILENAME,
      message: "Manifest must be a YAML object.",
      suggestion: "Use top-level key/value fields such as format, format_version, name, version, license, and owner.",
    });
    return undefined;
  }

  rejectUnknownKeys(input, TOP_LEVEL_KEYS, "agent-wiki.yaml", issues);

  const format = requireString(input, "format", "agent-wiki.yaml:format", issues);
  if (format !== undefined && format !== OKF_FORMAT) {
    issues.push({
      severity: "error",
      path: "agent-wiki.yaml:format",
      message: `format must be "${OKF_FORMAT}".`,
      suggestion: `Set format: ${OKF_FORMAT}.`,
    });
  }

  const formatVersion = requireFormatVersion(input, issues);
  const name = requireString(input, "name", "agent-wiki.yaml:name", issues);
  if (name !== undefined && !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name)) {
    issues.push({
      severity: "error",
      path: "agent-wiki.yaml:name",
      message: "name must start with an alphanumeric character and contain only letters, numbers, '.', '_', or '-'.",
      suggestion: "Use a portable package slug such as payroll-modernization-knowledge.",
    });
  }

  const version = requireString(input, "version", "agent-wiki.yaml:version", issues);
  const license = requireString(input, "license", "agent-wiki.yaml:license", issues);
  const owner = requireString(input, "owner", "agent-wiki.yaml:owner", issues);
  const createdAt = requireDateString(input, "created_at", "agent-wiki.yaml:created_at", issues);
  if (createdAt !== undefined && !/^\d{4}-\d{2}-\d{2}($|T)/.test(createdAt)) {
    issues.push({
      severity: "error",
      path: "agent-wiki.yaml:created_at",
      message: "created_at must start with YYYY-MM-DD or be an ISO 8601 datetime.",
      suggestion: "Use a value such as 2026-06-20.",
    });
  }

  const description = optionalString(input, "description", "agent-wiki.yaml:description", issues);
  const generator = validateGenerator(input.generator, issues);
  const sourcePolicy = validateSourcePolicy(input.source_policy, issues);
  const wikiPolicy = validateWikiPolicy(input.wiki_policy, issues);
  const evidencePolicy = validateEvidencePolicy(input.evidence_policy, issues);

  if (input.metadata !== undefined && !isRecord(input.metadata)) {
    issues.push({
      severity: "error",
      path: "agent-wiki.yaml:metadata",
      message: "metadata must be an object when present.",
      suggestion: "Use metadata for freeform tool annotations.",
    });
  }

  if (
    format !== OKF_FORMAT ||
    formatVersion !== OKF_FORMAT_VERSION ||
    !name ||
    !version ||
    !license ||
    !owner ||
    !createdAt ||
    !sourcePolicy ||
    !wikiPolicy ||
    !evidencePolicy
  ) {
    return undefined;
  }

  return {
    format: OKF_FORMAT,
    format_version: OKF_FORMAT_VERSION,
    name,
    version,
    license,
    owner,
    created_at: createdAt,
    ...(description !== undefined ? { description } : {}),
    ...(generator !== undefined ? { generator } : {}),
    source_policy: sourcePolicy,
    wiki_policy: wikiPolicy,
    evidence_policy: evidencePolicy,
    ...(isRecord(input.metadata) ? { metadata: input.metadata } : {}),
  };
}

function validateGenerator(input: unknown, issues: OkfFormatCheckIssue[]): OkfManifest["generator"] | undefined {
  if (input === undefined) return undefined;
  if (!isRecord(input)) {
    issues.push({
      severity: "error",
      path: "agent-wiki.yaml:generator",
      message: "generator must be an object when present.",
      suggestion: "Use generator: { name: agent-wiki, version: <version> }.",
    });
    return undefined;
  }
  rejectUnknownKeys(input, GENERATOR_KEYS, "agent-wiki.yaml:generator", issues);
  const name = requireString(input, "name", "agent-wiki.yaml:generator.name", issues);
  const version = requireString(input, "version", "agent-wiki.yaml:generator.version", issues);
  return name && version ? { name, version } : undefined;
}

function validateSourcePolicy(input: unknown, issues: OkfFormatCheckIssue[]): OkfManifest["source_policy"] | undefined {
  if (!isRecord(input)) {
    issues.push({
      severity: "error",
      path: "agent-wiki.yaml:source_policy",
      message: "source_policy must be an object.",
      suggestion: "Set source_policy.raw_immutable: true and source_policy.require_sha256: true.",
    });
    return undefined;
  }
  rejectUnknownKeys(input, SOURCE_POLICY_KEYS, "agent-wiki.yaml:source_policy", issues);
  const rawImmutable = requireBoolean(input, "raw_immutable", "agent-wiki.yaml:source_policy.raw_immutable", issues);
  const requireSha256 = requireBoolean(input, "require_sha256", "agent-wiki.yaml:source_policy.require_sha256", issues);
  const requireMetaSidecars = optionalBoolean(input, "require_meta_sidecars", "agent-wiki.yaml:source_policy.require_meta_sidecars", issues);

  if (rawImmutable === false) {
    issues.push({
      severity: "error",
      path: "agent-wiki.yaml:source_policy.raw_immutable",
      message: "source_policy.raw_immutable must be true for OKF v0.1.",
      suggestion: "Set raw_immutable: true.",
    });
  }
  if (requireSha256 === false) {
    issues.push({
      severity: "error",
      path: "agent-wiki.yaml:source_policy.require_sha256",
      message: "source_policy.require_sha256 must be true for OKF v0.1.",
      suggestion: "Set require_sha256: true.",
    });
  }
  if (rawImmutable !== true || requireSha256 !== true) return undefined;

  return {
    raw_immutable: true,
    require_sha256: true,
    ...(requireMetaSidecars !== undefined ? { require_meta_sidecars: requireMetaSidecars } : {}),
  };
}

function validateWikiPolicy(input: unknown, issues: OkfFormatCheckIssue[]): OkfManifest["wiki_policy"] | undefined {
  if (!isRecord(input)) {
    issues.push({
      severity: "error",
      path: "agent-wiki.yaml:wiki_policy",
      message: "wiki_policy must be an object.",
      suggestion: "Set wiki_policy.require_sources_for_grounded_pages and wiki_policy.allow_synthesis_pages.",
    });
    return undefined;
  }
  rejectUnknownKeys(input, WIKI_POLICY_KEYS, "agent-wiki.yaml:wiki_policy", issues);
  const requireSources = requireBoolean(input, "require_sources_for_grounded_pages", "agent-wiki.yaml:wiki_policy.require_sources_for_grounded_pages", issues);
  const allowSynthesis = requireBoolean(input, "allow_synthesis_pages", "agent-wiki.yaml:wiki_policy.allow_synthesis_pages", issues);
  const staleAfterDays = optionalPositiveInteger(input, "stale_after_days", "agent-wiki.yaml:wiki_policy.stale_after_days", issues);

  if (requireSources === undefined || allowSynthesis === undefined) return undefined;
  return {
    require_sources_for_grounded_pages: requireSources,
    allow_synthesis_pages: allowSynthesis,
    ...(staleAfterDays !== undefined ? { stale_after_days: staleAfterDays } : {}),
  };
}

function validateEvidencePolicy(input: unknown, issues: OkfFormatCheckIssue[]): OkfManifest["evidence_policy"] | undefined {
  if (!isRecord(input)) {
    issues.push({
      severity: "error",
      path: "agent-wiki.yaml:evidence_policy",
      message: "evidence_policy must be an object.",
      suggestion: "Set evidence_policy.allow_unsupported_pages and evidence_policy.require_abstain_signal.",
    });
    return undefined;
  }
  rejectUnknownKeys(input, EVIDENCE_POLICY_KEYS, "agent-wiki.yaml:evidence_policy", issues);
  const allowUnsupportedPages = requireString(input, "allow_unsupported_pages", "agent-wiki.yaml:evidence_policy.allow_unsupported_pages", issues);
  const requireAbstainSignal = requireBoolean(input, "require_abstain_signal", "agent-wiki.yaml:evidence_policy.require_abstain_signal", issues);

  if (
    allowUnsupportedPages !== undefined &&
    allowUnsupportedPages !== "allow" &&
    allowUnsupportedPages !== "warn" &&
    allowUnsupportedPages !== "reject"
  ) {
    issues.push({
      severity: "error",
      path: "agent-wiki.yaml:evidence_policy.allow_unsupported_pages",
      message: 'evidence_policy.allow_unsupported_pages must be "allow", "warn", or "reject".',
      suggestion: "Use warn for the current evidence-first default.",
    });
  }
  if (
    (allowUnsupportedPages !== "allow" && allowUnsupportedPages !== "warn" && allowUnsupportedPages !== "reject") ||
    requireAbstainSignal === undefined
  ) {
    return undefined;
  }
  return {
    allow_unsupported_pages: allowUnsupportedPages,
    require_abstain_signal: requireAbstainSignal,
  };
}

function checkDirectory(
  path: string,
  label: string,
  required: boolean,
  issues: OkfFormatCheckIssue[],
): void {
  if (directoryExists(path)) return;
  issues.push({
    severity: required ? "error" : "warning",
    path: label,
    message: `${label} directory is ${required ? "required" : "recommended"} for OKF v0.1 packages.`,
    suggestion: required
      ? `Create ${label} at the package root or run wiki_admin action:init.`
      : `Create ${label} when you publish reusable page/entity schemas.`,
  });
}

function directoryExists(path: string): boolean {
  return existsSync(path) && statSync(path).isDirectory();
}

function rejectUnknownKeys(
  record: Record<string, unknown>,
  allowed: Set<string>,
  path: string,
  issues: OkfFormatCheckIssue[],
): void {
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      issues.push({
        severity: "error",
        path: `${path}.${key}`,
        message: `Unknown manifest field "${key}".`,
        suggestion: "Remove the field or place tool-specific annotations under metadata.",
      });
    }
  }
}

function requireString(
  record: Record<string, unknown>,
  key: string,
  path: string,
  issues: OkfFormatCheckIssue[],
): string | undefined {
  const value = record[key];
  if (typeof value === "string" && value.trim() !== "") return value;
  issues.push({
    severity: "error",
    path,
    message: `${key} must be a non-empty string.`,
    suggestion: `Set ${key} in ${OKF_MANIFEST_FILENAME}.`,
  });
  return undefined;
}

function optionalString(
  record: Record<string, unknown>,
  key: string,
  path: string,
  issues: OkfFormatCheckIssue[],
): string | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value === "string") return value;
  issues.push({
    severity: "error",
    path,
    message: `${key} must be a string when present.`,
    suggestion: `Use a string value for ${key}.`,
  });
  return undefined;
}

function requireBoolean(
  record: Record<string, unknown>,
  key: string,
  path: string,
  issues: OkfFormatCheckIssue[],
): boolean | undefined {
  const value = record[key];
  if (typeof value === "boolean") return value;
  issues.push({
    severity: "error",
    path,
    message: `${key} must be a boolean.`,
    suggestion: `Set ${key}: true or ${key}: false.`,
  });
  return undefined;
}

function optionalBoolean(
  record: Record<string, unknown>,
  key: string,
  path: string,
  issues: OkfFormatCheckIssue[],
): boolean | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value === "boolean") return value;
  issues.push({
    severity: "error",
    path,
    message: `${key} must be a boolean when present.`,
    suggestion: `Set ${key}: true or ${key}: false.`,
  });
  return undefined;
}

function optionalPositiveInteger(
  record: Record<string, unknown>,
  key: string,
  path: string,
  issues: OkfFormatCheckIssue[],
): number | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (Number.isInteger(value) && typeof value === "number" && value > 0) return value;
  issues.push({
    severity: "error",
    path,
    message: `${key} must be a positive integer when present.`,
    suggestion: "Use a positive number of days.",
  });
  return undefined;
}

function requireFormatVersion(
  record: Record<string, unknown>,
  issues: OkfFormatCheckIssue[],
): string | undefined {
  const value = record.format_version;
  const normalized = typeof value === "number" ? String(value) : value;
  if (normalized === OKF_FORMAT_VERSION) return OKF_FORMAT_VERSION;
  issues.push({
    severity: "error",
    path: "agent-wiki.yaml:format_version",
    message: `format_version must be ${OKF_FORMAT_VERSION}.`,
    suggestion: `Set format_version: ${OKF_FORMAT_VERSION}.`,
  });
  return undefined;
}

function requireDateString(
  record: Record<string, unknown>,
  key: string,
  path: string,
  issues: OkfFormatCheckIssue[],
): string | undefined {
  const value = record[key];
  if (typeof value === "string" && value.trim() !== "") return value;
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString().slice(0, 10);
  issues.push({
    severity: "error",
    path,
    message: `${key} must be a non-empty date string.`,
    suggestion: `Set ${key} to YYYY-MM-DD or an ISO 8601 datetime.`,
  });
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
