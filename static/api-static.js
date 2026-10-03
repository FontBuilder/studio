/**
 * Static backend: the same surface as `api-manager.js`, with no server behind it.
 *
 * The editor was already client-side, so the only things that actually needed a
 * server were: parsing a font, writing a font, running FontForge operations,
 * storing projects, accounts, and the Unicode index. Of those, parsing and the
 * index have honest in-browser replacements; the rest are unavailable and say so
 * rather than failing obscurely.
 *
 * Returning **empty** export/operation lists is deliberate: the UI reads those
 * to decide whether to disable its panels, so this is how the static build
 * communicates "not here" to the rest of the app.
 */

import { createDocument, documentStats } from "./font-doc.js";
import { parseFontBuffer, STATIC_PARSE_LIMIT } from "./font-parser.js";
import { buildTrueTypeFont } from "./font-writer.js";
import * as unicodeData from "./unicode-static.js";

const NO_WRITER =
  "Only .ttf and .json can be written in the browser; other formats need the server build.";
const NO_FONTFORGE = "Cleanup operations run inside FontForge, so they need the server build.";
const NO_PROJECTS = "Projects are stored by the server; this build keeps everything in the page.";

// The one export a browser can honestly produce: the document itself, as JSON.
// Same build, so a work file written here can be read straight back in (see
// `parseFont`). Font binaries still need the server.
const WORKFILE_FORMAT = "json";
const WORKFILE_KIND = "font-builder-studio/work";
const WORKFILE_MIME = "application/json";

/* global Blob, URL, TextDecoder, document */

// --- auth: a static site has no accounts ----------------------------------
export function onUnauthorized() {}
export function setAuthToken() {}
export function getAuthToken() {
  return null;
}

// --- capabilities ----------------------------------------------------------
export async function getFormats() {
  return {
    ok: true,
    // TrueType is written in the browser; the document can also be saved as a
    // JSON work file and imported again.
    export_formats: [
      { format: "ttf", label: "TrueType (.ttf)" },
      { format: WORKFILE_FORMAT, label: "Project (.json)" },
    ],
    // What the in-browser parser can actually read, plus our own work file.
    import_extensions: [".ttf", ".otf", ".json"],
    mimetypes: { ttf: "font/ttf", otf: "font/otf", json: WORKFILE_MIME },
    operations: [],
    unicode_picker: unicodeData.meta(),
    limits: {
      max_upload_bytes: STATIC_PARSE_LIMIT,
      max_glyphs: 65535,
      max_points_total: 4000000,
      max_points_per_contour: 8192,
      max_contours_per_glyph: 4096,
    },
  };
}

// --- documents -------------------------------------------------------------
export async function newFont(options = {}) {
  const document = createDocument({
    em: options.em || 1000,
    ascent: options.ascent ?? Math.round((options.em || 1000) * 0.8),
    descent: options.descent ?? Math.round((options.em || 1000) * 0.2),
    family_name: options.family_name || "Untitled",
    style_name: options.style_name || "Regular",
  });
  document.font_name = `${document.family_name.replace(/ /g, "")}-${document.style_name.replace(/ /g, "")}`;
  return { ok: true, document, stats: documentStats(document) };
}

/**
 * Parse a font file in the browser.
 *
 * Matches the HTTP contract exactly - `{document, stats}` - so the caller does
 * not care which build it is running in.
 */
export async function parseFont(file) {
  const name = String(file.name || "");
  const buffer = await file.arrayBuffer();
  // A work file exported by this build comes back as JSON: detect it by
  // extension or MIME type and load the document directly.
  if (/\.json$/i.test(name) || file.type === WORKFILE_MIME) {
    return parseWorkFile(buffer);
  }
  const fallbackName = name.replace(/\.[^.]+$/, "") || "font";
  return parseFontBuffer(buffer, { familyName: fallbackName });
}

/**
 * Export a document as a downloadable font or work file.
 *
 * `ttf` produces a real installable TrueType font (see font-writer.js); `json`
 * produces the whole document wrapped with a small envelope so `parseFont` can
 * recognise it on the way back in. Mirrors the server `buildFont` contract
 * (returns `{stats, bytes, filename}`) so the caller is none the wiser.
 */
export async function buildFont(fontDocument, format = "ttf", filename) {
  const base = String(filename || fontDocument.family_name || "font").replace(/\.(json|ttf)$/i, "");

  if (format === "ttf") {
    const blob = new Blob([buildTrueTypeFont(fontDocument)], { type: "font/ttf" });
    const downloadName = `${base}.ttf`;
    downloadBlob(blob, downloadName);
    return { stats: documentStats(fontDocument), bytes: blob.size, filename: downloadName };
  }

  if (format === WORKFILE_FORMAT) {
    const payload = JSON.stringify(
      { kind: WORKFILE_KIND, version: 1, saved_at: new Date().toISOString(), document: fontDocument },
      null,
      2,
    );
    const blob = new Blob([payload], { type: WORKFILE_MIME });
    const downloadName = `${base}.json`;
    downloadBlob(blob, downloadName);
    return { stats: documentStats(fontDocument), bytes: blob.size, filename: downloadName };
  }

  throw new Error(NO_WRITER);
}

/** Trigger a browser download for a Blob. */
function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

/** Decode and validate a work file produced by `buildFont`. */
function parseWorkFile(buffer) {
  let payload;
  try {
    payload = JSON.parse(new TextDecoder().decode(buffer));
  } catch {
    throw new Error("not a Font Builder Studio project file (invalid JSON)");
  }
  const document_ = payload && payload.kind === WORKFILE_KIND ? payload.document : null;
  if (!document_ || !Array.isArray(document_.glyphs)) {
    throw new Error("not a Font Builder Studio project file");
  }
  return { document: document_, stats: documentStats(document_) };
}

export async function runOperation() {
  throw new Error(NO_FONTFORGE);
}

// --- projects: no server, nothing to list --------------------------------
export async function listProjects() {
  return { ok: true, projects: [] };
}
export async function createProject() {
  throw new Error(NO_PROJECTS);
}
export async function getProject() {
  throw new Error(NO_PROJECTS);
}
export async function updateProject() {
  throw new Error(NO_PROJECTS);
}
export async function deleteProject() {
  throw new Error(NO_PROJECTS);
}

// --- Unicode picker: same shapes as the HTTP endpoints --------------------
export async function getUnicodeBlocks() {
  await unicodeData.loadIndex();
  return { ok: true, meta: unicodeData.meta(), blocks: unicodeData.blocks() };
}

export async function getUnicodeChars(block, offset = 0, limit = 256) {
  await unicodeData.loadIndex();
  const page = unicodeData.chars(block, offset, limit);
  if (!page) throw new Error(`unknown block index ${block}`);
  return { ok: true, ...page };
}

export async function searchUnicode(text, limit = 256) {
  await unicodeData.loadIndex();
  return { ok: true, ...unicodeData.search(text, limit) };
}

export async function lookupUnicode(code) {
  await unicodeData.loadIndex();
  const value = typeof code === "string" ? unicodeData.parseCodePoint(code) : code;
  if (value === null || value === undefined) throw new Error("invalid code point");
  const found = unicodeData.lookup(value);
  if (!found) {
    return { ok: true, code: value, name: "", glyph_name: "", named: false };
  }
  return { ok: true, named: true, ...found };
}
