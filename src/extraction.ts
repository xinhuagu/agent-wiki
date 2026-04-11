/**
 * Document extraction module — structured text extraction with source provenance.
 *
 * Extracts text from PDF, DOCX, XLSX, PPTX, HTML files into segments
 * that preserve source coordinates (page, sheet, slide).
 */

import { extname } from "node:path";
import { readFileSync } from "node:fs";

// ── Types ────────────────────────────────────────────────────────

export interface SourceCoordinates {
  file: string;
  page?: number;
  sheet?: string;
  slide?: number;
}

export interface ExtractionSegment {
  text: string;
  source: SourceCoordinates;
}

export interface ExtractionResult {
  segments: ExtractionSegment[];
  mimeType: string;
  format: string; // "pdf" | "docx" | "xlsx" | "pptx" | "html" | "text"
  metadata?: { totalPages?: number };
}

// ── Page range parsing ───────────────────────────────────────────

/** Parse a page range string like "1-5", "3", "1-3,7-10" into a Set of 0-based page indices. */
export function parsePageRange(pages: string, totalPages: number): Set<number> {
  const indices = new Set<number>();
  for (const part of pages.split(",")) {
    const trimmed = part.trim();
    const match = trimmed.match(/^(\d+)(?:\s*-\s*(\d+))?$/);
    if (!match) continue;
    const rawStart = parseInt(match[1], 10);
    if (rawStart > totalPages) continue; // entirely out of bounds
    const start = Math.max(1, rawStart);
    const end = Math.min(totalPages, match[2] ? parseInt(match[2], 10) : rawStart);
    for (let i = start; i <= end; i++) indices.add(i - 1); // 0-based
  }
  return indices;
}

// ── MIME type detection ──────────────────────────────────────────

export function guessMime(filename: string): string {
  const ext = extname(filename).toLowerCase();
  const map: Record<string, string> = {
    // Text
    ".md": "text/markdown",
    ".txt": "text/plain",
    ".html": "text/html",
    ".htm": "text/html",
    ".css": "text/css",
    ".js": "text/javascript",
    ".ts": "text/javascript",
    ".csv": "text/csv",
    ".xml": "text/xml",
    ".json": "application/json",
    ".yaml": "text/yaml",
    ".yml": "text/yaml",
    ".toml": "text/plain",
    ".ini": "text/plain",
    ".log": "text/plain",
    ".sh": "text/x-shellscript",
    ".py": "text/x-python",
    ".java": "text/x-java",
    ".c": "text/x-c",
    ".cpp": "text/x-c++",
    ".rs": "text/x-rust",
    ".go": "text/x-go",
    ".rb": "text/x-ruby",
    ".sql": "application/sql",
    ".r": "text/plain",
    ".cbl": "text/x-cobol",
    ".cob": "text/x-cobol",
    ".cpy": "text/x-cobol",
    ".jcl": "text/plain",
    ".pli": "text/plain",
    // Documents
    ".pdf": "application/pdf",
    ".rtf": "application/rtf",
    ".epub": "application/epub+zip",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".doc": "application/msword",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".xls": "application/vnd.ms-excel",
    ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ".ppt": "application/vnd.ms-powerpoint",
    // Images
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".svg": "image/svg+xml",
    ".webp": "image/webp",
    ".avif": "image/avif",
    ".bmp": "image/bmp",
    ".ico": "image/x-icon",
    ".tiff": "image/tiff",
    ".tif": "image/tiff",
    // Audio
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
    ".ogg": "audio/ogg",
    ".flac": "audio/flac",
    ".aac": "audio/aac",
    ".m4a": "audio/mp4",
    // Video
    ".mp4": "video/mp4",
    ".webm": "video/webm",
    ".mkv": "video/x-matroska",
    ".mov": "video/quicktime",
    ".avi": "video/x-msvideo",
    // Archives
    ".zip": "application/zip",
    ".gz": "application/gzip",
    ".tar": "application/x-tar",
    ".7z": "application/x-7z-compressed",
    ".rar": "application/x-rar-compressed",
    ".bz2": "application/x-bzip2",
    // Data / other
    ".wasm": "application/wasm",
    ".sqlite": "application/x-sqlite3",
    ".db": "application/x-sqlite3",
    ".parquet": "application/octet-stream",
    ".arrow": "application/octet-stream",
  };
  return map[ext] ?? "application/octet-stream";
}

// ── Structured document extraction ───────────────────────────────

/** Extract text from a document file into structured segments with source provenance. */
export async function extractDocument(filePath: string, pages?: string): Promise<ExtractionResult> {
  const ext = extname(filePath).toLowerCase();

  if (ext === ".pdf") {
    const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const { readFile } = await import("fs/promises");
    const data = new Uint8Array(await readFile(filePath));
    const doc = await pdfjsLib.getDocument({ data, useSystemFonts: true }).promise;
    const totalPages = doc.numPages;

    let pageIndices: number[];
    if (pages) {
      const wanted = parsePageRange(pages, totalPages);
      if (wanted.size === 0) {
        doc.destroy();
        return { segments: [], mimeType: "application/pdf", format: "pdf", metadata: { totalPages } };
      }
      pageIndices = [...wanted].sort((a, b) => a - b).map(i => i + 1);
    } else {
      pageIndices = Array.from({ length: totalPages }, (_, i) => i + 1);
    }

    const segments: ExtractionSegment[] = [];
    for (const pageNum of pageIndices) {
      const page = await doc.getPage(pageNum);
      const content = await page.getTextContent();
      let lastY: number | undefined;
      let text = "";
      for (const item of content.items) {
        if (!("str" in item)) continue;
        const y = (item as any).transform[5];
        if (lastY === y || lastY === undefined) {
          text += (item as any).str;
        } else {
          text += "\n" + (item as any).str;
        }
        lastY = y;
      }
      if (text.trim()) {
        segments.push({ text, source: { file: filePath, page: pageNum } });
      }
    }

    doc.destroy();
    return { segments, mimeType: "application/pdf", format: "pdf", metadata: { totalPages } };
  }

  if (ext === ".docx") {
    const mammoth = await import("mammoth");
    const result = await mammoth.extractRawText({ path: filePath });
    return {
      segments: [{ text: result.value, source: { file: filePath } }],
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      format: "docx",
    };
  }

  if (ext === ".xlsx") {
    const XLSX = await import("xlsx");
    const wb = XLSX.readFile(filePath);
    const segments: ExtractionSegment[] = [];
    for (const name of wb.SheetNames) {
      const ws = wb.Sheets[name];
      if (!ws) continue;
      const csv = XLSX.utils.sheet_to_csv(ws);
      if (csv.trim()) {
        segments.push({ text: csv.trim(), source: { file: filePath, sheet: name } });
      }
    }
    return {
      segments,
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      format: "xlsx",
    };
  }

  if (ext === ".pptx") {
    const AdmZip = (await import("adm-zip")).default;
    const zip = new AdmZip(filePath);
    const entries = zip.getEntries()
      .filter(e => /^ppt\/slides\/slide\d+\.xml$/.test(e.entryName))
      .sort((a, b) => a.entryName.localeCompare(b.entryName, undefined, { numeric: true }));
    const segments: ExtractionSegment[] = [];
    for (const entry of entries) {
      const xml = entry.getData().toString("utf-8");
      const text = xml.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
      if (text) {
        const num = parseInt(entry.entryName.match(/slide(\d+)/)?.[1] ?? "0", 10);
        segments.push({ text, source: { file: filePath, slide: num } });
      }
    }
    return {
      segments,
      mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      format: "pptx",
    };
  }

  if (ext === ".html" || ext === ".htm") {
    const html = readFileSync(filePath, "utf-8");
    const cleaned = html
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<[^>]+>/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    return {
      segments: [{ text: cleaned, source: { file: filePath } }],
      mimeType: "text/html",
      format: "html",
    };
  }

  throw new Error(`Unsupported document format: ${ext}`);
}

// ── Backward-compat flat text extraction ─────────────────────────

/** Extract text from a document file, returning flat text (backward compat with extractTextNode). */
export async function extractText(filePath: string, pages?: string): Promise<string> {
  const result = await extractDocument(filePath, pages);

  if (result.segments.length === 0 && result.format === "pdf" && pages) {
    return `(no pages matched range "${pages}" — PDF has ${result.metadata?.totalPages ?? "?"} pages)`;
  }

  // Re-add format-specific separators that the old extractTextNode produced
  const body = result.segments.map(s => {
    if (result.format === "xlsx" && s.source.sheet) {
      return `--- Sheet: ${s.source.sheet} ---\n${s.text}`;
    }
    if (result.format === "pptx" && s.source.slide !== undefined) {
      return `--- Slide ${s.source.slide} ---\n${s.text}`;
    }
    return s.text;
  }).join("\n\n");

  if (result.format === "pdf" && pages && result.metadata?.totalPages) {
    return `[Pages ${pages} of ${result.metadata.totalPages}]\n${body}`;
  }
  return body;
}

// ── Chunking ─────────────────────────────────────────────────────

/** Split large segments into fixed-line chunks, preserving source coordinates. */
export function chunkSegments(segments: ExtractionSegment[], maxLines: number): ExtractionSegment[] {
  const result: ExtractionSegment[] = [];
  for (const seg of segments) {
    const lines = seg.text.split("\n");
    if (lines.length <= maxLines) {
      result.push(seg);
      continue;
    }
    for (let i = 0; i < lines.length; i += maxLines) {
      result.push({
        text: lines.slice(i, i + maxLines).join("\n"),
        source: { ...seg.source },
      });
    }
  }
  return result;
}
