/**
 * Thin wrapper around the Font Builder Studio HTTP API.
 *
 * Every call returns parsed JSON, or throws an Error whose message is the
 * server's own error text (which is written to be user-facing).
 *
 * When authentication is enabled the bearer token is attached to every request
 * and a 401 fires the registered callback so the UI can prompt for sign-in.
 */

const TOKEN_KEY = "fbs.token";

let authToken = null;
let unauthorizedHandler = null;

/** Register a callback invoked whenever the server returns 401. */
export function onUnauthorized(fn) {
  unauthorizedHandler = fn;
}

/** Store (or clear) the bearer token, persisting it to localStorage. */
export function setAuthToken(token) {
  authToken = token || null;
  try {
    if (authToken) window.localStorage.setItem(TOKEN_KEY, authToken);
    else window.localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* private mode / storage disabled - the in-memory token still works */
  }
}

export function getAuthToken() {
  if (authToken) return authToken;
  try {
    authToken = window.localStorage.getItem(TOKEN_KEY);
  } catch {
    authToken = null;
  }
  return authToken;
}

function authHeaders(extra = {}) {
  const token = getAuthToken();
  return token ? { ...extra, Authorization: `Bearer ${token}` } : { ...extra };
}

async function parseError(response) {
  if (response.status === 401 && unauthorizedHandler) {
    unauthorizedHandler();
  }
  let detail = "";
  try {
    const body = await response.json();
    detail = body && body.error ? body.error : "";
  } catch {
    detail = "";
  }
  if (!detail) {
    detail = `${response.status} ${response.statusText}`;
  }
  return new Error(detail);
}

export async function getFormats() {
  const response = await fetch("/api/font/formats", { headers: authHeaders() });
  if (!response.ok) throw await parseError(response);
  return response.json();
}

export async function newFont(options = {}) {
  const response = await fetch("/api/font/new", {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify(options),
  });
  if (!response.ok) throw await parseError(response);
  return response.json();
}

/**
 * Every Unicode block, for the character picker's section list.
 * @returns {Promise<{meta: object, blocks: Array<object>}>}
 */
export async function getUnicodeBlocks() {
  const response = await fetch("/api/font/unicode/blocks", { headers: authHeaders() });
  if (!response.ok) throw await parseError(response);
  return response.json();
}

/**
 * One page of characters inside a block.
 * @param {number} block block index
 * @param {number} [offset]
 * @param {number} [limit]
 */
export async function getUnicodeChars(block, offset = 0, limit = 256) {
  const query = new URLSearchParams({ block: String(block), offset: String(offset), limit: String(limit) });
  const response = await fetch(`/api/font/unicode/chars?${query}`, { headers: authHeaders() });
  if (!response.ok) throw await parseError(response);
  return response.json();
}

/**
 * Characters whose name, annotation or code point matches `text`.
 * @param {string} text
 * @param {number} [limit]
 */
export async function searchUnicode(text, limit = 256) {
  const query = new URLSearchParams({ q: text, limit: String(limit) });
  const response = await fetch(`/api/font/unicode/search?${query}`, { headers: authHeaders() });
  if (!response.ok) throw await parseError(response);
  return response.json();
}

/** Name and metadata for a single code point (accepts "U+2603" or 9731). */
export async function lookupUnicode(code) {
  const query = new URLSearchParams({ code: String(code) });
  const response = await fetch(`/api/font/unicode/lookup?${query}`, { headers: authHeaders() });
  if (!response.ok) throw await parseError(response);
  return response.json();
}

/**
 * Upload a font file and get back an editable document.
 * @param {File} file
 * @param {{statsOnly?: boolean}} [options]
 */
export async function parseFont(file, options = {}) {
  const form = new FormData();
  form.append("file", file, file.name);
  const query = options.statsOnly ? "?stats_only=1" : "";
  const response = await fetch(`/api/font/parse${query}`, {
    method: "POST",
    headers: authHeaders(),
    body: form,
  });
  if (!response.ok) throw await parseError(response);
  return response.json();
}

/**
 * Build a font from a document and trigger a browser download.
 *
 * NOTE: the parameter must not be named `document` - that would shadow the DOM
 * global and break the download link creation.
 *
 * @param {object} fontDocument
 * @param {string} format
 * @param {string} [filename]
 * @returns {Promise<object>} the stats from the X-Font-Stats header
 */
export async function buildFont(fontDocument, format, filename) {
  const response = await fetch("/api/font/build", {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ document: fontDocument, format, filename }),
  });
  if (!response.ok) throw await parseError(response);

  let stats = {};
  const header = response.headers.get("X-Font-Stats");
  if (header) {
    try {
      stats = JSON.parse(header);
    } catch {
      stats = {};
    }
  }

  const blob = await response.blob();
  const disposition = response.headers.get("Content-Disposition") || "";
  const match = /filename="?([^";]+)"?/i.exec(disposition);
  const downloadName = match ? match[1] : `font.${format}`;

  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = downloadName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);

  return { stats, bytes: blob.size, filename: downloadName };
}

/**
 * Run a FontForge cleanup operation over some or all glyphs.
 * @param {object} fontDocument
 * @param {string} op
 * @param {string[]|null} glyphs null = whole font
 */
export async function runOperation(fontDocument, op, glyphs) {
  const response = await fetch("/api/font/op", {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ document: fontDocument, op, glyphs: glyphs || null }),
  });
  if (!response.ok) throw await parseError(response);
  return response.json();
}

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------
export async function listProjects() {
  const response = await fetch("/api/projects", { headers: authHeaders() });
  if (!response.ok) throw await parseError(response);
  return response.json();
}

export async function createProject(name, fontDocument) {
  const response = await fetch("/api/projects", {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ name, document: fontDocument }),
  });
  if (!response.ok) throw await parseError(response);
  return response.json();
}

export async function getProject(id) {
  const response = await fetch(`/api/projects/${encodeURIComponent(id)}`, { headers: authHeaders() });
  if (!response.ok) throw await parseError(response);
  return response.json();
}

export async function updateProject(id, name, fontDocument) {
  const response = await fetch(`/api/projects/${encodeURIComponent(id)}`, {
    method: "PUT",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ name, document: fontDocument }),
  });
  if (!response.ok) throw await parseError(response);
  return response.json();
}

export async function deleteProject(id) {
  const response = await fetch(`/api/projects/${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: authHeaders(),
  });
  if (!response.ok) throw await parseError(response);
  return response.json();
}
