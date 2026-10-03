/**
 * Font Builder Studio - editor wiring.
 *
 * Owns the document, the canvas editor and the glyph grid, and connects them
 * to the controls in index.html.
 */

import * as api from "./api.js";
import { STATIC_MODE, STATIC_NOTES } from "./runtime.js";
import { initAuth, onSignedIn } from "./auth.js";
import { FontDocument, codepointLabel, formatCodePoint, hasOwnPoints, isComposite, mat, parseCodePoint, stepCodePoint } from "./font-doc.js";
import { createCanvasEditor } from "./editor-canvas.js";
import { createGlyphGrid } from "./glyph-grid.js";
import { createCharPicker } from "./char-picker.js";

const $ = (id) => document.getElementById(id);

const doc = new FontDocument();
const editor = createCanvasEditor($("glyphCanvas"), doc, {
  onStatus: updateStatus,
});
const grid = createGlyphGrid($("glyphList"), doc, {
  onSelect(name) {
    doc.selectGlyph(name);
    editor.fit();
  },
  onDelete(name) {
    deleteGlyph(name);
  },
});

let formats = { export_formats: [], import_extensions: [], operations: [] };

// Project persistence. `currentProjectId` stays null until a document is saved,
// which is what makes "Save" create rather than update.
let currentProjectId = null;

// ============================================================================
// Feedback helpers
// ============================================================================
function toast(message, kind = "") {
  const host = $("toastHost");
  const node = document.createElement("div");
  node.className = `toast ${kind}`;
  node.textContent = message;
  host.appendChild(node);
  setTimeout(() => node.remove(), kind === "error" ? 7000 : 3500);
}

function setBusy(busy, label = "Working…") {
  let overlay = $("busyOverlay");
  if (busy) {
    if (!overlay) {
      overlay = document.createElement("div");
      overlay.id = "busyOverlay";
      overlay.className = "busy";
      overlay.textContent = label;
      document.body.appendChild(overlay);
    }
    overlay.textContent = label;
  } else if (overlay) {
    overlay.remove();
  }
}

/**
 * Static builds keep the whole document in memory, so a refresh wipes it. The
 * banner is the only warning the user gets; it lives until dismissed, and is
 * shown again on the next load (nothing is persisted on purpose).
 */
function showDataWarning() {
  const banner = $("dataWarning");
  if (!banner) return;
  $("dataWarningText").textContent = STATIC_NOTES.dataLoss;
  banner.hidden = false;
  $("dataWarningDismiss").addEventListener("click", () => {
    banner.hidden = true;
  });
}

const clampInt = (value, fallback = 0) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

// ============================================================================
// Header menu (Projects)
// ============================================================================
function openMenu() {
  $("projectsMenu").hidden = false;
  $("projectsBtn").setAttribute("aria-expanded", "true");
}

function closeMenu() {
  $("projectsMenu").hidden = true;
  $("projectsBtn").setAttribute("aria-expanded", "false");
}

function toggleMenu() {
  if ($("projectsMenu").hidden) openMenu();
  else closeMenu();
}

// ============================================================================
// Projects
// ============================================================================
function renderProjects(projects) {
  const list = $("projectList");
  list.textContent = "";
  if (!projects || projects.length === 0) {
    const empty = document.createElement("p");
    empty.className = "hint";
    empty.textContent = "No saved projects yet.";
    list.appendChild(empty);
    return;
  }
  for (const project of projects) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "glyph-row" + (project.id === currentProjectId ? " active" : "");
    row.title = "Click to open";

    const name = document.createElement("span");
    name.className = "gname";
    name.textContent = project.name;

    const meta = document.createElement("span");
    meta.className = "gcode";
    meta.textContent = `${project.glyphs ?? 0}g`;

    const remove = document.createElement("span");
    remove.className = "gcode";
    remove.textContent = "✕";
    remove.title = "Delete project";
    remove.addEventListener("click", (event) => {
      event.stopPropagation();
      deleteProject(project);
    });

    row.append(name, meta, remove);
    row.addEventListener("click", () => openProject(project.id));
    list.appendChild(row);
  }
}

async function refreshProjects() {
  try {
    const result = await api.listProjects();
    renderProjects(result.projects);
    $("projectBadge").textContent = String((result.projects || []).length);
    const storage = result.storage || {};
    $("projectNote").textContent = storage.writable === false
      ? "Storage is not writable - projects will not persist."
      : `${(result.projects || []).length} / ${storage.max_projects ?? "?"} projects`;
  } catch (error) {
    $("projectNote").textContent = `Could not list projects: ${error.message}`;
  }
}

async function saveProject(forceNew = false) {
  const name = ($("projectName").value || doc.doc.family_name || "Untitled").trim();
  setBusy(true, "Saving project…");
  try {
    const result = forceNew || !currentProjectId
      ? await api.createProject(name, doc.doc)
      : await api.updateProject(currentProjectId, name, doc.doc);
    currentProjectId = result.project.id;
    doc.doc.baseName = name;
    doc.dirty = false;
    $("projectName").value = result.project.name;
    toast(`Project saved: ${result.project.name}`, "ok");
    await refreshProjects();
    closeMenu();
  } catch (error) {
    toast(`Save failed: ${error.message}`, "error");
  } finally {
    setBusy(false);
  }
}

async function openProject(id) {
  if (doc.dirty && !window.confirm("Discard unsaved changes and open this project?")) return;
  setBusy(true, "Opening project…");
  try {
    const result = await api.getProject(id);
    currentProjectId = result.project.id;
    doc.loadDocument(result.project.document, result.project.name);
    $("projectName").value = result.project.name;
    editor.fit();
    await refreshProjects();
    toast(`Opened ${result.project.name}`, "ok");
    closeMenu();
  } catch (error) {
    toast(`Could not open project: ${error.message}`, "error");
  } finally {
    setBusy(false);
  }
}

async function deleteProject(project) {
  if (!window.confirm(`Delete project "${project.name}"? This cannot be undone.`)) return;
  try {
    await api.deleteProject(project.id);
    if (currentProjectId === project.id) currentProjectId = null;
    toast("Project deleted", "ok");
    await refreshProjects();
  } catch (error) {
    toast(`Delete failed: ${error.message}`, "error");
  }
}

// ============================================================================
// UI refresh
// ============================================================================
function updateStatus(info = {}) {
  const glyph = doc.glyph;
  $("statGlyph").textContent = glyph ? glyph.name : "—";
  $("statContours").textContent = glyph ? (glyph.contours || []).length : 0;
  $("statPoints").textContent = glyph
    ? (glyph.contours || []).reduce((sum, c) => sum + (c.points || []).length, 0)
    : 0;
  $("statSelected").textContent = doc.selection.size;
  $("statCursor").textContent = info.cursor
    ? `${Math.round(info.cursor[0])}, ${Math.round(info.cursor[1])}`
    : "—";
  // `view` arrives with every status call, so this stays safe even during the
  // editor's very first synchronous render (before `editor` is assigned).
  const scale = (info.view && info.view.scale) || 1;
  $("zoomReadout").textContent = `${Math.round(scale * 100)}%`;
}

function updateDocumentInfo() {
  const { glyphs, contours, points, encoded } = countStats();
  $("fontStats").innerHTML = "";
  const rows = [
    ["Glyphs", glyphs],
    ["Encoded", encoded],
    ["Contours", contours],
    ["Points", points],
    ["Units/em", doc.doc.em],
  ];
  for (const [label, value] of rows) {
    const key = document.createElement("span");
    key.textContent = label;
    const val = document.createElement("b");
    val.textContent = String(value);
    $("fontStats").append(key, val);
  }

  $("glyphCount").textContent = String(glyphs);
  if (document.activeElement !== $("fontFamily")) $("fontFamily").value = doc.doc.family_name || "";
  if (document.activeElement !== $("fontStyle")) $("fontStyle").value = doc.doc.style_name || "";
  if (document.activeElement !== $("fontEm")) $("fontEm").value = doc.doc.em;
}

function countStats() {
  let contours = 0;
  let points = 0;
  let encoded = 0;
  for (const glyph of doc.doc.glyphs || []) {
    if (typeof glyph.unicode === "number" && glyph.unicode >= 0) encoded += 1;
    for (const contour of glyph.contours || []) {
      contours += 1;
      points += (contour.points || []).length;
    }
  }
  return { glyphs: (doc.doc.glyphs || []).length, contours, points, encoded };
}

// ============================================================================
// Unicode helpers
// ============================================================================
// A bare number like "208" tells a non-expert nothing, so the interpreted code
// point is always shown three ways: the character itself, hex, and decimal.
const DEFAULT_UNICODE_HINT =
  "Accepts U+0041, 0x41 or 65 (decimal). Blank = unencoded.";

function setUnicodeHint(message, isWarning = false) {
  const el = $("unicodeHint");
  el.textContent = message || DEFAULT_UNICODE_HINT;
  el.classList.toggle("warn", Boolean(isWarning));
}

function updateUnicodeReadout(code) {
  const info = formatCodePoint(code);
  $("unicodeHex").textContent = info.hex;
  $("unicodeDec").textContent = info.dec;
  const charEl = $("unicodeChar");
  charEl.textContent = info.char || "—";
  charEl.classList.toggle("empty", !info.char);
  charEl.title = info.unencoded
    ? "Unencoded glyph"
    : `${info.hex} (decimal ${info.dec})`;
}

/**
 * Blank the readouts for unparseable input.
 *
 * Without this the previous character stays on screen while the field holds
 * something invalid, which reads as "this is still fine".
 */
function clearUnicodeReadout() {
  $("unicodeHex").textContent = "—";
  $("unicodeDec").textContent = "—";
  const charEl = $("unicodeChar");
  charEl.textContent = "—";
  charEl.classList.add("empty");
  charEl.title = "Not a valid code point";
}

/** Message when another glyph already claims this code point, else "". */
function unicodeClashMessage(code, exclude) {
  if (!Number.isInteger(code) || code < 0) return "";
  const clash = doc.doc.glyphs.find((g) => g !== exclude && g.unicode === code);
  return clash ? `${codepointLabel(code)} is already used by "${clash.name}"` : "";
}

/** Sync the unicode field, its readouts and the warning from the current glyph. */
function refreshUnicodeUi() {
  const glyph = doc.glyph;
  const code = glyph ? glyph.unicode : -1;
  if (document.activeElement !== $("glyphUnicode")) {
    $("glyphUnicode").value = code >= 0 ? formatCodePoint(code).hex : "";
  }
  updateUnicodeReadout(code);
  const clash = unicodeClashMessage(code, glyph);
  setUnicodeHint(clash, Boolean(clash));
}

/**
 * Show the arithmetic behind the two spacing fields.
 *
 * "600" and "100" on their own explain nothing; LSB + ink + RSB = advance width
 * is the whole idea, and a negative RSB is worth flagging because it means this
 * glyph's ink runs into the next one's.
 */
function refreshSpacingUi() {
  const info = doc.spacing();
  const set = (id, text, warn = false) => {
    const el = $(id);
    el.textContent = text;
    el.classList.toggle("warn", warn);
  };

  if (!info) {
    set("spLsb", "—");
    set("spInk", "—");
    set("spRsb", "—");
    $("spacingHint").textContent = "LSB + ink + RSB = advance width.";
    return;
  }

  if (info.empty) {
    set("spLsb", String(info.lsb), info.lsb < 0);
    set("spInk", "—");
    set("spRsb", "—");
    $("spacingHint").textContent =
      "Nothing drawn, so there is no ink to measure. Add outlines and the breakdown appears here.";
    return;
  }

  set("spLsb", String(info.lsb), info.lsb < 0);
  set("spInk", String(info.inkWidth));
  set("spRsb", String(info.rsb), info.rsb < 0);
  $("spacingHint").textContent = (info.lsb < 0 || info.rsb < 0)
    ? `${info.lsb} + ${info.inkWidth} + ${info.rsb} = ${info.width}. A negative value means the ink overhangs the advance width, so this glyph overlaps its neighbours.`
    : `${info.lsb} + ${info.inkWidth} + ${info.rsb} = ${info.width}.`;
}

function updateGlyphInputs() {
  const glyph = doc.glyph;
  const hasGlyph = Boolean(glyph);
  for (const id of ["glyphName", "glyphUnicode", "glyphWidth", "glyphLsb"]) {
    $(id).disabled = !hasGlyph;
  }
  $("resetWidth").disabled = !hasGlyph;
  $("resetLsb").disabled = !hasGlyph;
  for (const id of ["addContour", "delContour", "makeOn", "makeOff", "delPoints"]) {
    $(id).disabled = !hasGlyph;
  }
  $("deleteGlyph").disabled = !hasGlyph;
  $("duplicateGlyph").disabled = !hasGlyph;
  $("browseGlyph").disabled = !hasGlyph;
  for (const button of document.querySelectorAll(".u-step")) {
    button.disabled = !hasGlyph;
  }
  $("opScope").textContent = $("opAllGlyphs").checked ? "whole font" : (doc.glyphName || "—");
  $("glyphCodepoint").textContent = glyph ? codepointLabel(glyph.unicode) : "—";

  if (!glyph) {
    $("glyphName").value = "";
    $("glyphUnicode").value = "";
    $("glyphWidth").value = "";
    $("glyphLsb").value = "";
    refreshUnicodeUi();
    refreshSpacingUi();
    return;
  }

  // Keep the stored LSB in step with the outline before showing it - dragging a
  // point changes xMin, and the two must not drift apart or the build slides the
  // glyph back to where the stale value said it was.
  doc.syncSideBearing();
  if (document.activeElement !== $("glyphName")) $("glyphName").value = glyph.name;
  if (document.activeElement !== $("glyphWidth")) $("glyphWidth").value = glyph.width;
  if (document.activeElement !== $("glyphLsb")) $("glyphLsb").value = glyph.lsb;
  refreshUnicodeUi();
  refreshSpacingUi();
}

function updateHistoryButtons() {
  $("undoBtn").disabled = !doc.canUndo();
  $("redoBtn").disabled = !doc.canRedo();
}

/**
 * Explain what an empty canvas means.
 *
 * Three situations otherwise look identical: no document at all, a glyph that
 * exists but carries no outlines, and - the confusing one - a **composite**
 * glyph, which does render but only as faint ghosts, because its shape is
 * borrowed from other glyphs and it owns no points to select. Reported as "the
 * glyph isn't coloured and not really clickable".
 */
function updateCanvasEmptyState(glyph) {
  const title = $("emptyTitle");
  const note = $("emptyNote");
  const action = $("emptyAction");
  const compose = $("emptyAction2");
  const reset = () => {
    note.hidden = true;
    action.hidden = true;
    compose.hidden = true;
  };

  if (!glyph) {
    title.textContent = "Import a font or start a new one, then pick a glyph.";
    reset();
    $("canvasEmpty").hidden = false;
    return;
  }

  // A glyph with its own outlines needs no explanation, so the overlay stays
  // hidden - but the buttons are reset anyway so no stale state can survive to
  // the next glyph that does need them.
  if (hasOwnPoints(glyph)) {
    title.textContent = "";
    reset();
    $("canvasEmpty").hidden = true;
    return;
  }

  const code = glyph.unicode >= 0 ? ` (${codepointLabel(glyph.unicode)})` : "";

  // A template is only offered when every part actually exists in the font -
  // there is nothing to reference otherwise - and never when it would make the
  // glyph reference itself.
  const template = doc.templateParts();
  const usable = Boolean(
    template &&
      template.length > 1 &&
      template.every((part) => part.glyph && part.glyph !== glyph)
  );
  const partNames = usable ? template.map((part) => part.glyph.name).join(" + ") : "";

  if (isComposite(glyph)) {
    const count = glyph.references.length;
    const parts = glyph.references.map((ref) => ref[0]).join(" + ");
    title.textContent = `${glyph.name} is a composite glyph`;
    note.textContent =
      `It has no points of its own${code} - it is drawn from ${count} ` +
      `reference${count === 1 ? "" : "s"} (${parts}), which is why the outline shows ` +
      "here as a faint ghost. Unlink the references to bake them into real " +
      "contours, then the points can be edited and drawn on normally.";
    action.textContent = "Unlink references";
    action.dataset.action = "unlink";
    action.hidden = false;
    note.hidden = false;
  } else {
    title.textContent = `${glyph.name} has no outlines yet`;
    const templated = usable && template
      ? ` This character decomposes into ${partNames}, so it can also be composed from those as references.`
      : "";
    note.textContent =
      `This is an empty slot${code}. Fonts commonly include them as placeholders for ` +
      "code points they do not draw, so nothing is broken. Add a contour to start " +
      `drawing, or pick a glyph that already has outlines and use Duplicate.${templated}`;
    action.textContent = "Add a contour";
    action.dataset.action = "contour";
    action.hidden = false;
    note.hidden = false;
  }

  compose.hidden = !usable;
  compose.textContent = isComposite(glyph) ? "Rebuild from template" : "Compose from template";
  $("canvasEmpty").hidden = false;
}

function updateAll() {
  grid.render();
  updateGlyphInputs();
  updateDocumentInfo();
  updateHistoryButtons();
  const glyph = doc.glyph;
  // A composite glyph renders but owns no points, so it needs explaining too.
  updateCanvasEmptyState(glyph);
  updateStatus({ view: editor.view });
}

doc.onChange((_document, reason) => {
  if (reason === "selection") {
    updateStatus();
    editor.render();
    return;
  }
  updateAll();
  if (reason === "structure" || reason === "load" || reason === "selectGlyph" || reason === "history") {
    editor.render();
  }
});

// ============================================================================
// Import / new / export
// ============================================================================
async function importFiles(fileList) {
  const file = fileList && fileList[0];
  if (!file) return;
  setBusy(true, `Parsing ${file.name}…`);
  try {
    const result = await api.parseFont(file);
    currentProjectId = null;
    doc.loadDocument(result.document, file.name.replace(/\.[^.]+$/, ""));
    $("projectName").value = result.document.family_name || file.name;
    editor.fit();
    const stats = result.stats || {};
    toast(`Imported ${file.name} — ${stats.glyphs} glyphs, ${stats.points} points`, "ok");
  } catch (error) {
    toast(`Import failed: ${error.message}`, "error");
  } finally {
    setBusy(false);
  }
}

/**
 * Open the editor on the bundled Inter sample instead of an empty canvas.
 *
 * Inter (SIL Open Font License) ships next to this module so a new user has a
 * real font to explore immediately. It only ever runs against an empty document
 * and re-checks after each await, so a slow fetch can never overwrite work
 * started in the meantime. A missing sample is not an error - the empty state
 * still explains what to do - which is why the catch is silent.
 */
async function loadSampleFont() {
  if (doc.doc.glyphs.length) return;
  try {
    // Resolved against this module, so it works in both builds: /static/app.js
    // under Flask, ./static/app.js on the static site.
    const sample = new URL("Inter-Italic-VariableFont_opsz,wght.ttf", import.meta.url);
    const response = await fetch(sample);
    if (!response.ok) return;
    const blob = await response.blob();
    const file = new File([blob], "Inter-Italic-VariableFont_opsz,wght.ttf", {
      type: "font/ttf",
    });
    const result = await api.parseFont(file);
    // The user may have imported or created something while this was loading.
    if (doc.doc.glyphs.length) return;
    currentProjectId = null;
    doc.loadDocument(result.document, "Inter");
    $("projectName").value = result.document.family_name || "Inter";
    editor.fit();
    const stats = result.stats || {};
    toast(`Inter sample loaded — ${stats.glyphs} glyphs. Start editing, or use “New empty font”.`, "ok");
  } catch (error) {
    // A convenience, not a requirement: never block the editor on it.
    console.warn("Inter sample not loaded:", error);
  }
}

async function newFont() {
  setBusy(true, "Creating font…");
  try {
    // Family/style/em come from the Font panel (collapsed by default but still
    // in the DOM), so metadata can be set before starting the font.
    const result = await api.newFont({
      family_name: ($("fontFamily").value || "Untitled").trim(),
      style_name: ($("fontStyle").value || "Regular").trim(),
      em: clampInt($("fontEm").value, 1000) || 1000,
    });
    currentProjectId = null;
    doc.loadDocument(result.document, "Untitled");
    $("projectName").value = result.document.family_name || "Untitled";
    editor.fit();
    closeMenu();
    toast("New font created — add a glyph to begin", "ok");
  } catch (error) {
    toast(`Could not create font: ${error.message}`, "error");
  } finally {
    setBusy(false);
  }
}

async function exportFont() {
  const format = $("exportFormat").value;
  if (!doc.doc.glyphs.length) {
    toast("Nothing to export — the font has no glyphs", "error");
    return;
  }
  setBusy(true, `Building ${format.toUpperCase()}…`);
  try {
    const base = ($("fontFamily").value || doc.doc.family_name || "Untitled").trim();
    doc.doc.family_name = base;
    const result = await api.buildFont(doc.doc, format, base);
    const stats = result.stats || {};
    toast(`Exported ${result.filename} (${result.bytes} bytes)`, "ok");
    if (stats.glyphs) {
      $("exportNote").textContent = `${stats.glyphs} glyphs, ${stats.contours} contours, ${stats.points} points`;
    }
  } catch (error) {
    toast(`Export failed: ${error.message}`, "error");
  } finally {
    setBusy(false);
  }
}

// ============================================================================
// Glyph operations
// ============================================================================
/**
 * Delete a glyph, with confirmation.
 *
 * Reachable from the Glyph panel and from the hover affordance in the glyph
 * list, so removal does not require selecting the glyph first.
 */
function deleteGlyph(name) {
  if (!name) return;
  if (!window.confirm(`Delete glyph "${name}"? This cannot be undone.`)) return;
  if (!doc.removeGlyph(name)) return;
  editor.fit();
  updateAll();
  toast(`Deleted ${name}`, "ok");
}

function addGlyph() {
  const name = ($("newGlyphName").value || "").trim();
  const parsed = parseCodePoint($("newGlyphCode").value);

  if (!name) {
    toast("Enter a glyph name", "error");
    return;
  }
  if (!parsed.ok) {
    toast(parsed.error, "error");
    return;
  }
  if (doc.doc.glyphs.some((g) => g.name === name)) {
    toast(`Glyph "${name}" already exists`, "error");
    return;
  }
  const clash = unicodeClashMessage(parsed.code, null);
  if (clash) {
    toast(clash, "error");
    return;
  }

  doc.addGlyph(name, parsed.code);
  doc.selectGlyph(name);
  $("newGlyphName").value = "";
  $("newGlyphCode").value = "";
  editor.fit();
  updateAll();
}

// ============================================================================
// Code point nudging (the stepper arrows, and Up/Down in the field)
// ============================================================================
/**
 * Give the selected glyph a new code point.
 *
 * `coalesce` folds the change into the previous undo entry, so a run of
 * stepper clicks undoes as one action instead of filling the history.
 */
function applyCodePoint(code, { coalesce = false } = {}) {
  const glyph = doc.glyph;
  if (!glyph || code === glyph.unicode) return;
  if (coalesce) doc.beginCoalescedEdit("unicode-step");
  else doc.beginEdit();
  glyph.unicode = code;
  doc.commitEdit("edit");
  // Set the readouts directly as well: the shared refresh skips the field
  // while it holds focus, which is exactly the case during arrow-key nudging.
  $("glyphUnicode").value = formatCodePoint(code).hex;
  updateUnicodeReadout(code);
  const clash = unicodeClashMessage(code, glyph);
  setUnicodeHint(clash, Boolean(clash));
}

/** Step the selected glyph's code point, skipping the surrogate block. */
function nudgeCodePoint(delta) {
  const glyph = doc.glyph;
  if (!glyph) return;
  // Prefer what is typed over what is committed, so nudging works mid-edit.
  const parsed = parseCodePoint($("glyphUnicode").value);
  const base = parsed.ok ? parsed.code : glyph.unicode;
  applyCodePoint(stepCodePoint(base, delta), { coalesce: true });
}

/**
 * Write a character chosen in the picker into a field.
 *
 * Only the code point is written. When adding a new glyph the name is filled in
 * too, but only if the user has not typed one - silently overwriting a chosen
 * name would be worse than leaving it blank.
 */
function applyPickedCharacter(entry, fieldId) {
  const label = formatCodePoint(entry.code).hex;

  if (fieldId === "newGlyphCode") {
    $("newGlyphCode").value = label;
    if (!$("newGlyphName").value.trim() && entry.glyph_name) {
      $("newGlyphName").value = entry.glyph_name;
    }
    $("newGlyphName").focus();
    return;
  }

  const glyph = doc.glyph;
  if (!glyph) return;
  const clash = unicodeClashMessage(entry.code, glyph);
  if (clash && glyph.unicode !== entry.code) {
    toast(clash, "error");
    return;
  }
  applyCodePoint(entry.code);
}

// ============================================================================
// Wiring
// ============================================================================
function wire() {
  // Import
  const dropZone = $("dropZone");
  const fileInput = $("fileInput");
  dropZone.addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", () => {
    importFiles(fileInput.files);
    fileInput.value = "";
  });
  for (const type of ["dragenter", "dragover"]) {
    dropZone.addEventListener(type, (event) => {
      event.preventDefault();
      dropZone.classList.add("dragover");
    });
  }
  for (const type of ["dragleave", "drop"]) {
    dropZone.addEventListener(type, (event) => {
      event.preventDefault();
      dropZone.classList.remove("dragover");
    });
  }
  dropZone.addEventListener("drop", (event) => importFiles(event.dataTransfer.files));

  // New / export
  $("newFontBtn").addEventListener("click", newFont);
  $("exportBtn").addEventListener("click", exportFont);

  // Glyph add/remove
  $("addGlyphBtn").addEventListener("click", addGlyph);
  $("deleteGlyph").addEventListener("click", () => deleteGlyph(doc.glyphName));

  // Code point steppers. There is one set per readout (char / hex / decimal);
  // they are the same control repeated, so whichever one the eye lands on,
  // the nudge is right there. Hold Shift for 16.
  for (const button of document.querySelectorAll(".u-step")) {
    button.addEventListener("click", (event) => {
      const amount = Number(button.dataset.step) || 0;
      nudgeCodePoint(amount * (event.shiftKey ? 16 : 1));
    });
  }
  // Up/Down in the field does the same thing, for keyboard users.
  $("glyphUnicode").addEventListener("keydown", (event) => {
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    if (!parseCodePoint(event.target.value).ok) return; // let a bad value be
    event.preventDefault();
    const direction = event.key === "ArrowUp" ? 1 : -1;
    nudgeCodePoint(direction * (event.shiftKey ? 16 : 1));
  });

  // Character picker: browse by block, or search by name.
  const charPicker = createCharPicker({ doc, onPick: applyPickedCharacter });
  if (charPicker) {
    $("browseGlyph").addEventListener("click", () => {
      const parsed = parseCodePoint($("glyphUnicode").value);
      charPicker.open("glyphUnicode", parsed.ok ? parsed.code : -1);
    });
    $("browseNewGlyph").addEventListener("click", () => {
      const parsed = parseCodePoint($("newGlyphCode").value);
      charPicker.open("newGlyphCode", parsed.ok ? parsed.code : -1);
    });
  }

  // Glyph list filter
  $("glyphSearch").addEventListener("input", (event) => grid.setFilter(event.target.value));

  // Glyph property edits
  $("glyphWidth").addEventListener("change", (event) => {
    if (doc.setAdvanceWidth(clampInt(event.target.value, 0))) editor.render();
    updateGlyphInputs();
  });
  // Setting the LSB slides the glyph (and its width) exactly as FontForge does,
  // rather than storing a number that the build would then have to reconcile.
  $("glyphLsb").addEventListener("change", (event) => {
    if (doc.setLeftSideBearing(clampInt(event.target.value, 0))) {
      editor.fit();
      updateAll();
    } else {
      updateGlyphInputs();
    }
  });

  // Field resets: back to what the glyph had when it first appeared, or the
  // font's own typical width when there is nothing to revert to.
  $("resetWidth").addEventListener("click", () => {
    if (!doc.glyph) return;
    const original = doc.originalMetrics(doc.glyphName);
    const target = original && original.width > 0 ? original.width : doc.typicalWidth();
    if (doc.setAdvanceWidth(target)) {
      editor.render();
      updateAll();
      toast(`Advance width reset to ${target}`, "ok");
    }
  });
  $("resetLsb").addEventListener("click", () => {
    if (!doc.glyph) return;
    const original = doc.originalMetrics(doc.glyphName);
    const target = original ? original.lsb : 0;
    if (doc.setLeftSideBearing(target)) {
      editor.fit();
      updateAll();
      toast(`LSB reset to ${target}`, "ok");
    }
  });
  // Live readout while typing, so the interpretation is never a surprise.
  $("glyphUnicode").addEventListener("input", (event) => {
    const parsed = parseCodePoint(event.target.value);
    if (!parsed.ok) {
      clearUnicodeReadout();
      setUnicodeHint(parsed.error, true);
      return;
    }
    updateUnicodeReadout(parsed.code);
    const clash = unicodeClashMessage(parsed.code, doc.glyph);
    setUnicodeHint(clash, Boolean(clash));
  });

  $("glyphUnicode").addEventListener("change", (event) => {
    if (!doc.glyph) return;
    const parsed = parseCodePoint(event.target.value);
    if (!parsed.ok) {
      toast(parsed.error, "error");
      refreshUnicodeUi(); // put the field back to the glyph's real value
      return;
    }
    doc.beginEdit();
    doc.glyph.unicode = parsed.code;
    doc.commitEdit("edit");
  });
  $("glyphName").addEventListener("change", (event) => {
    const glyph = doc.glyph;
    const next = String(event.target.value).trim();
    if (!glyph || !next || next === glyph.name) return;
    if (doc.doc.glyphs.some((g) => g.name === next)) {
      toast(`Glyph "${next}" already exists`, "error");
      updateGlyphInputs();
      return;
    }
    glyph.name = next;
    doc.glyphName = next;
    doc.dirty = true;
    updateAll();
  });

  // Font-level properties
  $("fontFamily").addEventListener("change", (event) => {
    doc.doc.family_name = String(event.target.value).trim() || "Untitled";
    doc.dirty = true;
    updateDocumentInfo();
  });
  $("fontStyle").addEventListener("change", (event) => {
    doc.doc.style_name = String(event.target.value).trim() || "Regular";
    doc.dirty = true;
    updateDocumentInfo();
  });
  $("fontEm").addEventListener("change", (event) => {
    doc.doc.em = clampInt(event.target.value, 1000) || 1000;
    doc.dirty = true;
    editor.render();
    updateDocumentInfo();
  });

  // Contour / point operations
  $("addContour").addEventListener("click", () => {
    if (doc.addContour()) {
      editor.render();
      updateAll();
    }
  });
  // Same actions the panels offer, surfaced where the confusion happens.
  $("emptyAction").addEventListener("click", () => {
    if ($("emptyAction").dataset.action === "unlink") {
      if (doc.unlinkReferences()) {
        editor.fit();
        updateAll();
        toast(`Unlinked references on ${doc.glyphName}`, "ok");
      }
      return;
    }
    $("addContour").click();
  });
  // Compose a composite from the character's Unicode decomposition.
  $("emptyAction2").addEventListener("click", () => {
    const template = doc.templateParts();
    const result = doc.composeFromTemplate(template);
    if (result.ok) {
      editor.fit();
      updateAll();
      const parts = template.map((part) => part.glyph.name).join(" + ");
      toast(`Composed ${doc.glyphName} from ${parts}`, "ok");
      return;
    }
    if (result.missing !== undefined) {
      toast(
        `No glyph for ${codepointLabel(result.missing)} in this font, so it cannot be referenced yet`,
        "error"
      );
      return;
    }
    toast("This character has no decomposition to build from", "error");
  });
  $("delContour").addEventListener("click", () => {
    const selected = doc.selectedPoints();
    const ci = selected.length ? selected[0].ci : 0;
    if (doc.deleteContour(ci)) {
      editor.render();
      updateAll();
    }
  });
  $("makeOn").addEventListener("click", () => {
    if (doc.setPointType(true)) editor.render();
  });
  $("makeOff").addEventListener("click", () => {
    if (doc.setPointType(false)) editor.render();
  });
  $("delPoints").addEventListener("click", () => {
    if (doc.deleteSelectedPoints()) {
      editor.render();
      updateAll();
    }
  });

  // Duplicate glyph
  $("duplicateGlyph").addEventListener("click", () => {
    const glyph = doc.glyph;
    if (!glyph) return;
    const name = doc.uniqueGlyphName(`${glyph.name}.alt`);
    const copy = doc.duplicateGlyph(glyph.name, name, -1);
    if (!copy) {
      toast(`Could not duplicate "${glyph.name}"`, "error");
      return;
    }
    doc.selectGlyph(name);
    editor.fit();
    updateAll();
    toast(`Duplicated to ${name}`, "ok");
  });

  // Transforms (applied to the selection, or the whole glyph)
  $("flipH").addEventListener("click", () => {
    if (doc.transform(mat.flipH())) editor.render();
  });
  $("flipV").addEventListener("click", () => {
    if (doc.transform(mat.flipV())) editor.render();
  });
  $("applyTransform").addEventListener("click", () => {
    const sx = (clampInt($("scaleX").value, 100) || 100) / 100;
    const sy = (clampInt($("scaleY").value, 100) || 100) / 100;
    const rotate = clampInt($("rotateDeg").value, 0);
    const skew = clampInt($("skewX").value, 0);
    const dx = clampInt($("moveX").value, 0);
    const dy = clampInt($("moveY").value, 0);

    if (sx === 0 || sy === 0) {
      toast("Scale cannot be 0%", "error");
      return;
    }

    // Composed in the order the user reads them: scale, then rotate, then skew.
    let matrix = mat.scale(sx, sy);
    if (rotate) matrix = mat.compose(matrix, mat.rotate(rotate));
    if (skew) matrix = mat.compose(matrix, mat.skew(skew, 0));

    if (doc.transform(matrix, { dx, dy })) {
      editor.render();
      toast("Transform applied", "ok");
    } else {
      toast("Nothing to transform", "error");
    }
  });

  // ---- selection, clipboard and the quick transform buttons ----------------
  // The clipboard lives here rather than in the document: it survives switching
  // glyphs, which is what makes copying outline across glyphs work, but it is
  // not part of the document and must not be undone or saved.
  let clipboard = null;

  function selectionLabel() {
    const n = doc.selection.size;
    return `${n} point${n === 1 ? "" : "s"}`;
  }

  function selectAllPoints() {
    const count = doc.selectAll();
    editor.render();
    toast(
      count ? `Selected ${selectionLabel()}` : "No points here to select",
      count ? "ok" : ""
    );
  }

  function copyPoints() {
    clipboard = doc.copySelection();
    toast(
      clipboard ? `Copied ${selectionLabel()}` : "Select some points first",
      clipboard ? "ok" : "error"
    );
  }

  function pastePoints() {
    if (!clipboard) {
      toast("Nothing has been copied yet", "error");
      return;
    }
    const result = doc.pastePoints(clipboard);
    if (!result) {
      // pastePoints refuses anything the server-side validator would reject, so
      // this is a shape problem rather than a bug.
      toast("A copied contour needs at least 2 points", "error");
      return;
    }
    editor.render();
    const skipped = result.skipped ? `, ${result.skipped} fragment(s) skipped` : "";
    toast(`Pasted ${result.points} points into ${result.contours} new contour(s)${skipped}`, "ok");
  }

  function quickTransform(matrix, label) {
    if (!doc.transform(matrix)) {
      toast("Nothing to transform", "error");
      return;
    }
    editor.render();
    toast(label, "ok");
  }

  $("selectAllBtn").addEventListener("click", selectAllPoints);
  $("copySelBtn").addEventListener("click", copyPoints);
  $("pasteSelBtn").addEventListener("click", pastePoints);
  $("quickFlipH").addEventListener("click", () =>
    quickTransform(mat.flipH(), "Flipped horizontally"));
  $("quickFlipV").addEventListener("click", () =>
    quickTransform(mat.flipV(), "Flipped vertically"));
  $("quickRotL").addEventListener("click", () =>
    quickTransform(mat.rotate(-90), "Rotated 90\u00b0 anticlockwise"));
  $("quickRotR").addEventListener("click", () =>
    quickTransform(mat.rotate(90), "Rotated 90\u00b0 clockwise"));

  // Server-side cleanup operations
  $("opAllGlyphs").addEventListener("change", () => updateGlyphInputs());
  $("runOpBtn").addEventListener("click", async () => {
    const op = $("opSelect").value;
    if (!op) return;
    const all = $("opAllGlyphs").checked;
    if (!doc.doc.glyphs.length) {
      toast("The font has no glyphs", "error");
      return;
    }
    if (!all && !doc.glyph) {
      toast("Select a glyph first, or tick 'apply to the whole font'", "error");
      return;
    }

    const keep = doc.glyphName;
    setBusy(true, `Running ${op}…`);
    try {
      const result = await api.runOperation(doc.doc, op, all ? null : [keep]);
      doc.loadDocument(result.document, doc.doc.baseName);
      if (keep && doc.doc.glyphs.some((g) => g.name === keep)) doc.selectGlyph(keep);
      editor.fit();

      const errors = result.errors || [];
      const note = `${op}: ${result.applied} glyph(s) updated`
        + (errors.length ? `, ${errors.length} skipped` : "");
      $("opNote").textContent = note;
      toast(note, errors.length ? "" : "ok");
    } catch (error) {
      toast(`${op} failed: ${error.message}`, "error");
    } finally {
      setBusy(false);
    }
  });

  // Header menu
  $("projectsBtn").addEventListener("click", (event) => {
    event.stopPropagation();
    toggleMenu();
  });
  document.addEventListener("click", (event) => {
    if (!$("projectsMenu").hidden && !event.target.closest(".menu-wrap")) closeMenu();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeMenu();
  });

  // Projects
  $("saveProjectBtn").addEventListener("click", () => saveProject(false));
  $("saveAsProjectBtn").addEventListener("click", () => saveProject(true));

  // History
  $("undoBtn").addEventListener("click", () => {
    doc.undo();
    editor.render();
  });
  $("redoBtn").addEventListener("click", () => {
    doc.redo();
    editor.render();
  });

  // Zoom
  $("zoomIn").addEventListener("click", () => editor.zoomBy(1.25));
  $("zoomOut").addEventListener("click", () => editor.zoomBy(1 / 1.25));
  $("zoomFit").addEventListener("click", () => editor.fit());

  // Keyboard
  window.addEventListener("keydown", (event) => {
    const tag = (event.target.tagName || "").toLowerCase();
    if (tag === "input" || tag === "textarea" || tag === "select") return;

    const meta = event.ctrlKey || event.metaKey;
    if (meta && event.key.toLowerCase() === "z") {
      event.preventDefault();
      if (event.shiftKey) doc.redo();
      else doc.undo();
      editor.render();
      return;
    }
    if (meta && event.key.toLowerCase() === "y") {
      event.preventDefault();
      doc.redo();
      editor.render();
      return;
    }
    if (meta && event.key.toLowerCase() === "a") {
      event.preventDefault();
      selectAllPoints();
      return;
    }
    if (meta && event.key.toLowerCase() === "c") {
      event.preventDefault();
      copyPoints();
      return;
    }
    if (meta && event.key.toLowerCase() === "v") {
      event.preventDefault();
      pastePoints();
      return;
    }
    if (event.shiftKey && !meta) {
      // event.code, not event.key: Shift+[ is "{" on most layouts.
      if (event.code === "KeyH") {
        event.preventDefault();
        quickTransform(mat.flipH(), "Flipped horizontally");
        return;
      }
      if (event.code === "KeyV") {
        event.preventDefault();
        quickTransform(mat.flipV(), "Flipped vertically");
        return;
      }
      if (event.code === "BracketLeft") {
        event.preventDefault();
        quickTransform(mat.rotate(-90), "Rotated 90\u00b0 anticlockwise");
        return;
      }
      if (event.code === "BracketRight") {
        event.preventDefault();
        quickTransform(mat.rotate(90), "Rotated 90\u00b0 clockwise");
        return;
      }
    }
    if (event.key === "Escape" && doc.selection.size) {
      doc.clearSelection();
      editor.render();
      return;
    }
    if (event.key === "Delete" || event.key === "Backspace") {
      if (doc.selection.size && doc.deleteSelectedPoints()) {
        event.preventDefault();
        editor.render();
        updateAll();
      }
      return;
    }
    if (event.key.startsWith("Arrow")) {
      const selected = doc.selectedPoints();
      if (!selected.length) return;
      event.preventDefault();
      const step = event.shiftKey ? 10 : 1;
      const dx = event.key === "ArrowLeft" ? -step : event.key === "ArrowRight" ? step : 0;
      const dy = event.key === "ArrowDown" ? -step : event.key === "ArrowUp" ? step : 0;
      doc.beginEdit();
      for (const { point } of selected) {
        point[0] += dx;
        point[1] += dy;
      }
      doc.commitEdit("edit");
      editor.render();
      return;
    }
    if (event.key.toLowerCase() === "f") {
      editor.fit();
    }
  });
}

// ============================================================================
// Boot
// ============================================================================
async function boot() {
  // Establish the session first: when REQUIRE_AUTH is on, every API call below
  // needs a token, and initAuth also pops the sign-in dialog when required.
  await initAuth();

  // A static build has no server storage, so hide the entry point rather than
  // leaving a menu that fails when opened, and warn up front that the document
  // only lives in this tab.
  if (STATIC_MODE) {
    $("projectsBtn").hidden = true;
    showDataWarning();
  }

  // Signing in unlocks the API, so reload everything that auth was gating.
  onSignedIn(async () => {
    await loadCapabilities();
    if (!STATIC_MODE) await refreshProjects();
  });

  wire();
  await loadCapabilities();
  if (!STATIC_MODE) await refreshProjects();
  if (!$("projectName").value) $("projectName").value = doc.doc.family_name || "Untitled";
  updateAll();
  editor.fit();

  // Open on something real rather than an empty canvas: the bundled Inter
  // sample gives a new user a font to explore straight away.
  await loadSampleFont();
}

/**
 * Load the capability lists the UI is built from.
 *
 * These calls are auth-gated, so this runs again after a successful sign-in -
 * otherwise the export and operation dropdowns stay empty on a fresh page load.
 */
async function loadCapabilities() {
  try {
    formats = await api.getFormats();

    const select = $("exportFormat");
    const previous = select.value;
    select.textContent = "";
    const exportFormats = formats.export_formats || [];
    for (const entry of exportFormats) {
      const option = document.createElement("option");
      option.value = entry.format;
      option.textContent = entry.label || entry.format.toUpperCase();
      select.appendChild(option);
    }
    // Keep the previous choice when it still exists, otherwise default to the
    // first available format (not a hard-coded "woff2", which a static build
    // does not offer).
    select.value = exportFormats.some((f) => f.format === previous)
      ? previous
      : (exportFormats[0] && exportFormats[0].format) || "";

    $("importHint").textContent = (formats.import_extensions || []).join(" ");

    const maxMb = formats.limits
      ? Math.round((formats.limits.max_upload_bytes || 0) / 1048576)
      : 25;
    $("uploadLimit").textContent = `${maxMb} MB`;

    const opSelect = $("opSelect");
    const previousOp = opSelect.value;
    opSelect.textContent = "";
    for (const op of formats.operations || []) {
      const option = document.createElement("option");
      option.value = op;
      option.textContent = op;
      opSelect.appendChild(option);
    }
    if (previousOp) opSelect.value = previousOp;

    // An empty list is how a build says "I cannot do that". Disable the control
    // and explain, rather than leaving a button that fails when clicked.
    const canExport = (formats.export_formats || []).length > 0;
    $("exportBtn").disabled = !canExport;
    if (!canExport) $("exportNote").textContent = STATIC_NOTES.exportDisabled;
    else if (STATIC_MODE) $("exportNote").textContent = STATIC_NOTES.exportHint;

    const canOperate = (formats.operations || []).length > 0;
    $("runOpBtn").disabled = !canOperate;
    if (!canOperate) $("opNote").textContent = STATIC_NOTES.operationsDisabled;
  } catch (error) {
    toast(`Could not load API capabilities: ${error.message}`, "error");
  }
}

boot();
