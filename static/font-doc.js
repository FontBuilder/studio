/**
 * Font document model + edit history.
 *
 * The document mirrors the server's `font_model.py` schema, so a document
 * produced here can be POSTed straight to /api/font/build.
 *
 * Point layout (compact, because large fonts hold millions of points):
 *   [x, y, onCurve, type, interpolated, name]
 */

export const POINT_CORNER = 0;
export const POINT_CURVE = 1;
export const POINT_HV_CURVE = 2;
export const POINT_TANGENT = 3;

const UNDO_DEPTH = 100;

// How far a paste is nudged when it lands back on the glyph it was copied from.
// Without it the copy would sit exactly underneath the original and look as
// though nothing had happened.
const PASTE_OFFSET = 20;

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

export function createGlyph(name, unicode = -1) {
  return {
    name,
    unicode,
    width: 0,
    lsb: 0,
    vwidth: 0,
    quadratic: false,
    contours: [],
    references: [],
  };
}

export function createDocument(overrides = {}) {
  return {
    version: 1,
    em: 1000,
    ascent: 800,
    descent: 200,
    family_name: "Untitled",
    style_name: "Regular",
    font_name: "Untitled-Regular",
    comment: "",
    glyphs: [],
    ...overrides,
  };
}

export function documentStats(doc) {
  const glyphs = doc.glyphs || [];
  let contours = 0;
  let points = 0;
  for (const glyph of glyphs) {
    for (const contour of glyph.contours || []) {
      contours += 1;
      points += (contour.points || []).length;
    }
  }
  return {
    glyphs: glyphs.length,
    contours,
    points,
    encoded: glyphs.filter((g) => typeof g.unicode === "number" && g.unicode >= 0).length,
  };
}

export function codepointLabel(unicode) {
  if (typeof unicode !== "number" || unicode < 0) return "—";
  return `U+${unicode.toString(16).toUpperCase().padStart(4, "0")}`;
}

/**
 * Parse a Unicode code point from free-form user input.
 *
 * Unicode is conventionally written in hex, so an explicit `U+`/`0x` prefix - or
 * any letters - selects hex. A bare number is treated as **decimal**, which is
 * what FontForge's own API uses. The UI always shows the interpreted result, so
 * a misread value is immediately visible rather than silently wrong.
 *
 * @returns {{ok: true, code: number} | {ok: false, error: string}}
 *   `code` is `-1` for "unencoded" (blank input).
 */
export function parseCodePoint(raw) {
  const text = String(raw ?? "").trim();
  if (text === "") return { ok: true, code: -1 };

  let code;
  if (/^u\+/i.test(text)) {
    code = Number.parseInt(text.slice(2), 16);
  } else if (/^0x/i.test(text)) {
    code = Number.parseInt(text.slice(2), 16);
  } else if (/^[0-9a-f]+$/i.test(text) && /[a-f]/i.test(text)) {
    code = Number.parseInt(text, 16);
  } else if (/^[0-9]+$/.test(text)) {
    code = Number.parseInt(text, 10);
  } else {
    return { ok: false, error: "Not a code point - try U+0041, 0x41 or 65" };
  }

  if (!Number.isInteger(code) || code < 0 || code > 0x10ffff) {
    return { ok: false, error: "Code point must be between 0 and 10FFFF" };
  }
  return { ok: true, code };
}

/**
 * Human-facing forms of a code point: hex label, decimal value and the actual
 * character (empty for unassigned/surrogate ranges).
 */
export function formatCodePoint(code) {
  if (!Number.isInteger(code) || code < 0) {
    return { hex: "—", dec: "—", char: "", unencoded: true };
  }
  let char = "";
  // Surrogates and noncharacters have nothing printable to show.
  if (!(code >= 0xd800 && code <= 0xdfff)) {
    try {
      char = String.fromCodePoint(code);
    } catch {
      char = "";
    }
  }
  return {
    hex: `U+${code.toString(16).toUpperCase().padStart(4, "0")}`,
    dec: String(code),
    char,
    unencoded: false,
  };
}

/**
 * The code point `delta` steps away from `code`, skipping the surrogate block.
 *
 * Surrogates are skipped because they cannot stand alone in a Unicode string.
 * An unencoded glyph (-1) starts from the first printable character when
 * stepping up, and the end of the code space when stepping down. The result is
 * clamped rather than wrapped, so holding a stepper cannot silently jump from
 * the last code point back to the first.
 */
export function stepCodePoint(code, delta) {
  const FIRST = 0x20; // space; below this is only controls
  const LAST = 0x10ffff;
  const SURROGATE_LO = 0xd800;
  const SURROGATE_HI = 0xdfff;
  const SURROGATE_LEN = SURROGATE_HI - SURROGATE_LO + 1;

  // Land exactly on FIRST/LAST for the first step out of "unencoded".
  let next = code >= 0 ? code : delta > 0 ? FIRST - delta : LAST - delta;
  next += delta;

  if (next >= SURROGATE_LO && next <= SURROGATE_HI) {
    next += delta > 0 ? SURROGATE_LEN : -SURROGATE_LEN;
  }
  return Math.min(LAST, Math.max(0, next));
}

/**
 * A composite glyph is drawn from references to other glyphs rather than from
 * its own points. `Scaron` in a typical font is just "S" plus a caron: no
 * points of its own, so nothing on it can be selected or edited.
 */
export function isComposite(glyph) {
  return Boolean(glyph && Array.isArray(glyph.references) && glyph.references.length);
}

/** True when a glyph has points of its own to edit. */
export function hasOwnPoints(glyph) {
  return Boolean(glyph && glyph.contours && glyph.contours.length);
}

/** True when a glyph renders anything at all - its own points, or references. */
export function drawsSomething(glyph) {
  return hasOwnPoints(glyph) || isComposite(glyph);
}

/**
 * Conventional glyph names for combining marks.
 *
 * The compatibility-decomposition route (see `compatIndex`) only links marks
 * that *have* a decomposition - measured: acute, breve, diaeresis, ring and
 * cedilla do, while grave, circumflex and caron do not. Those can only be found
 * by the name fonts traditionally give them.
 */
const MARK_NAMES = {
  0x0300: ["grave"],
  0x0301: ["acute"],
  0x0302: ["circumflex"],
  0x0303: ["tilde"],
  0x0304: ["macron"],
  0x0306: ["breve"],
  0x0307: ["dotaccent"],
  0x0308: ["dieresis"],
  0x0309: ["hookabove"],
  0x030a: ["ring"],
  0x030b: ["hungarumlaut"],
  0x030c: ["caron"],
  0x0323: ["dotbelow"],
  0x0327: ["cedilla"],
  0x0328: ["ogonek"],
};

/**
 * Holds the working document plus undo/redo history.
 *
 * History snapshots the *glyph being edited* rather than the whole document,
 * which keeps undo cheap on large fonts. Document-level changes (import, new)
 * reset the history instead of being undoable.
 */
export class FontDocument {
  constructor() {
    this.doc = createDocument();
    this.doc.baseName = "Untitled";
    this.glyphName = null;
    this.selection = new Set(); // "contourIndex:pointIndex"
    this.undoStack = [];
    this.redoStack = [];
    this.listeners = new Set();
    this.dirty = false;
    // Metrics as they were when each glyph entered the document, so the
    // spacing fields can be reverted rather than guessed at.
    this.originals = new Map();
    this._compat = null;
  }

  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit(reason = "change") {
    for (const fn of this.listeners) fn(this, reason);
  }

  get glyph() {
    if (!this.glyphName) return null;
    return this.doc.glyphs.find((g) => g.name === this.glyphName) || null;
  }

  get glyphIndex() {
    return this.doc.glyphs.findIndex((g) => g.name === this.glyphName);
  }

  /** Replace the whole document (import / new). History is reset. */
  loadDocument(doc, baseName = null) {
    this.doc = doc;
    this.doc.baseName = baseName || this.doc.baseName || "font";
    this.glyphName = (doc.glyphs && doc.glyphs[0] && doc.glyphs[0].name) || null;
    this.selection.clear();
    this.undoStack = [];
    this.redoStack = [];
    this.dirty = false;
    this.captureOriginals();
    this.emit("load");
  }

  /** Snapshot every glyph's metrics, for the field reset buttons. */
  captureOriginals() {
    this.originals = new Map();
    for (const glyph of this.doc.glyphs || []) {
      this.originals.set(glyph.name, {
        width: Math.round(Number(glyph.width) || 0),
        lsb: Math.round(Number(glyph.lsb) || 0),
      });
    }
  }

  /**
   * The metrics to revert to: whatever the glyph had when it was first seen.
   * Captured lazily so glyphs added after load are covered too.
   */
  originalMetrics(name) {
    if (!this.originals.has(name)) {
      const glyph = this.doc.glyphs.find((g) => g.name === name);
      if (!glyph) return null;
      this.originals.set(name, {
        width: Math.round(Number(glyph.width) || 0),
        lsb: Math.round(Number(glyph.lsb) || 0),
      });
    }
    return this.originals.get(name);
  }

  selectGlyph(name) {
    this.glyphName = name;
    this.selection.clear();
    this.emit("selectGlyph");
  }

  /** Snapshot the current glyph so the next mutation can be undone. */
  beginEdit() {
    const glyph = this.glyph;
    if (!glyph) return;
    this.undoStack.push({ glyphName: glyph.name, snapshot: clone(glyph) });
    if (this.undoStack.length > UNDO_DEPTH) this.undoStack.shift();
    this.redoStack = [];
  }

  /**
   * Snapshot for a mutation that repeats in quick succession - stepper clicks,
   * arrow-key nudges. A second call with the same `tag` inside `windowMs`
   * reuses the existing entry and keeps its *original* snapshot, so a burst of
   * clicks undoes as one action instead of burying the history.
   */
  beginCoalescedEdit(tag, windowMs = 1500) {
    const glyph = this.glyph;
    if (!glyph) return;
    const last = this.undoStack[this.undoStack.length - 1];
    const now = Date.now();
    if (
      last &&
      last.tag === tag &&
      last.glyphName === glyph.name &&
      now - (last.at || 0) < windowMs
    ) {
      last.at = now;
      this.redoStack = [];
      return;
    }
    this.beginEdit();
    const pushed = this.undoStack[this.undoStack.length - 1];
    if (pushed) {
      pushed.tag = tag;
      pushed.at = now;
    }
  }

  /** Mark the current glyph as changed (call after a mutation). */
  commitEdit(reason = "edit") {
    this.dirty = true;
    this.emit(reason);
  }

  canUndo() {
    return this.undoStack.length > 0;
  }

  canRedo() {
    return this.redoStack.length > 0;
  }

  undo() {
    const entry = this.undoStack.pop();
    if (!entry) return;
    const current = this.doc.glyphs.find((g) => g.name === entry.glyphName);
    if (current) {
      this.redoStack.push({ glyphName: entry.glyphName, snapshot: clone(current) });
    }
    this.restore(entry);
  }

  redo() {
    const entry = this.redoStack.pop();
    if (!entry) return;
    const current = this.doc.glyphs.find((g) => g.name === entry.glyphName);
    if (current) {
      this.undoStack.push({ glyphName: entry.glyphName, snapshot: clone(current) });
    }
    this.restore(entry);
  }

  restore(entry) {
    const index = this.doc.glyphs.findIndex((g) => g.name === entry.glyphName);
    if (index >= 0) {
      this.doc.glyphs[index] = clone(entry.snapshot);
    } else {
      this.doc.glyphs.push(clone(entry.snapshot));
    }
    this.glyphName = entry.glyphName;
    this.selection.clear();
    this.dirty = true;
    this.emit("history");
  }

  /** Add a glyph, or return the existing one with that name. */
  addGlyph(name, unicode = -1) {
    const existing = this.doc.glyphs.find((g) => g.name === name);
    if (existing) return existing;
    const glyph = createGlyph(name, unicode);
    this.doc.glyphs.push(glyph);
    this.dirty = true;
    return glyph;
  }

  removeGlyph(name) {
    const index = this.doc.glyphs.findIndex((g) => g.name === name);
    if (index < 0) return false;
    this.doc.glyphs.splice(index, 1);
    if (this.glyphName === name) {
      this.glyphName = (this.doc.glyphs[0] && this.doc.glyphs[0].name) || null;
      this.selection.clear();
    }
    this.dirty = true;
    this.emit("removeGlyph");
    return true;
  }

  // ---- selection helpers -------------------------------------------------
  selectedPoints() {
    const glyph = this.glyph;
    const out = [];
    if (!glyph) return out;
    for (const key of this.selection) {
      const [ci, pi] = key.split(":").map(Number);
      const contour = glyph.contours[ci];
      if (contour && contour.points[pi]) {
        out.push({ ci, pi, point: contour.points[pi] });
      }
    }
    return out;
  }

  isSelected(ci, pi) {
    return this.selection.has(`${ci}:${pi}`);
  }

  clearSelection() {
    this.selection.clear();
    this.emit("selection");
  }

  toggleSelection(ci, pi) {
    const key = `${ci}:${pi}`;
    if (this.selection.has(key)) this.selection.delete(key);
    else this.selection.add(key);
    this.emit("selection");
  }

  setSelection(ci, pi) {
    this.selection.clear();
    this.selection.add(`${ci}:${pi}`);
    this.emit("selection");
  }

  /** Select every point in the current glyph (Ctrl+A). */
  selectAll() {
    const glyph = this.glyph;
    if (!glyph) return 0;
    for (let ci = 0; ci < glyph.contours.length; ci += 1) {
      const count = glyph.contours[ci].points.length;
      for (let pi = 0; pi < count; pi += 1) this.selection.add(`${ci}:${pi}`);
    }
    this.emit("selection");
    return this.selection.size;
  }

  /**
   * Select every point inside a rectangle in font units - the marquee gesture.
   *
   * @param {{minX: number, minY: number, maxX: number, maxY: number}} box
   * @param {{add?: boolean}} [options] `add` keeps what is already selected,
   *   which is what holding Shift through the drag means.
   * @returns {number} the number of points selected afterwards
   */
  selectInBox(box, options = {}) {
    const glyph = this.glyph;
    if (!glyph || !box) return 0;
    if (!options.add) this.selection.clear();
    for (let ci = 0; ci < glyph.contours.length; ci += 1) {
      const points = glyph.contours[ci].points;
      for (let pi = 0; pi < points.length; pi += 1) {
        const point = points[pi];
        if (
          point[0] >= box.minX &&
          point[0] <= box.maxX &&
          point[1] >= box.minY &&
          point[1] <= box.maxY
        ) {
          this.selection.add(`${ci}:${pi}`);
        }
      }
    }
    this.emit("selection");
    return this.selection.size;
  }

  /** Bounding box of the selected points, or null when nothing is selected. */
  selectionBounds() {
    const selected = this.selectedPoints();
    if (!selected.length) return null;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const { point } of selected) {
      if (point[0] < minX) minX = point[0];
      if (point[1] < minY) minY = point[1];
      if (point[0] > maxX) maxX = point[0];
      if (point[1] > maxY) maxY = point[1];
    }
    return { minX, minY, maxX, maxY };
  }

  /**
   * Snapshot the selection for the clipboard.
   *
   * Points are copied as plain arrays, grouped per contour and put back into
   * contour order: `this.selection` is a Set in click order, so pasting its raw
   * iteration would scramble the outline. Copies rather than references, so
   * editing - or undoing - after a copy cannot change what gets pasted.
   *
   * @returns {{fromGlyph: string, groups: Array<Array<Array<number>>>, minX: number, minY: number}|null}
   */
  copySelection() {
    const glyph = this.glyph;
    const selected = this.selectedPoints();
    if (!glyph || !selected.length) return null;

    const byContour = new Map();
    for (const { ci, pi, point } of selected) {
      if (!byContour.has(ci)) byContour.set(ci, []);
      byContour.get(ci).push({ pi, point });
    }

    const groups = [];
    for (const ci of [...byContour.keys()].sort((a, b) => a - b)) {
      const entries = byContour.get(ci).sort((a, b) => a.pi - b.pi);
      groups.push(entries.map(({ point }) => point.slice()));
    }

    const box = this.selectionBounds();
    return { fromGlyph: glyph.name, groups, minX: box.minX, minY: box.minY };
  }

  /**
   * Paste a clipboard payload as new closed contour(s), then select them.
   *
   * New contours rather than splicing into an existing one: appending points
   * would deform that contour, and pasting again would keep deforming it. Each
   * contour needs at least 2 points, the floor `font_model.py` enforces, so a
   * smaller group is skipped rather than producing a document the server would
   * reject at export time.
   *
   * @param {object} payload from `copySelection`
   * @param {{offset?: number}} [options] paste offset in font units
   * @returns {{contours: number, points: number, skipped: number}|null}
   */
  pastePoints(payload, options = {}) {
    const glyph = this.glyph;
    if (!glyph || !payload || !Array.isArray(payload.groups)) return null;

    const groups = payload.groups.filter((group) => Array.isArray(group) && group.length >= 2);
    const skipped = payload.groups.length - groups.length;
    if (!groups.length) return null;

    // A copy dropped back onto its own glyph would hide underneath the
    // original, so nudge it. Across glyphs the original position is the point.
    const offset =
      options.offset !== undefined
        ? Number(options.offset) || 0
        : payload.fromGlyph === glyph.name
          ? PASTE_OFFSET
          : 0;

    const firstIndex = glyph.contours.length;
    this.beginEdit();
    for (const group of groups) {
      glyph.contours.push({
        closed: true,
        quadratic: Boolean(glyph.quadratic),
        points: group.map((point) => [
          point[0] + offset,
          point[1] + offset,
          point[2],
          point[3],
          point[4] === undefined ? 0 : point[4],
          point[5] === undefined ? null : point[5],
        ]),
      });
    }

    this.selection.clear();
    let points = 0;
    for (let ci = firstIndex; ci < glyph.contours.length; ci += 1) {
      const count = glyph.contours[ci].points.length;
      for (let pi = 0; pi < count; pi += 1) this.selection.add(`${ci}:${pi}`);
      points += count;
    }

    this.commitEdit("structure");
    return { contours: groups.length, points, skipped };
  }

  /**
   * Insert a point into a segment by splitting the curve (de Casteljau), so
   * the outline's shape is preserved exactly.
   *
   * @param {number} ci contour index
   * @param {number} pi index of the on-curve point the segment starts at
   * @param {number} [t=0.5] where along the segment to split (0..1). The canvas
   *   passes the position the user actually clicked, so the new point appears
   *   under the cursor rather than always at the segment's midpoint.
   * @returns {boolean} whether anything was inserted
   */
  insertPointOnSegment(ci, pi, t = 0.5) {
    const glyph = this.glyph;
    if (!glyph) return false;
    const contour = glyph.contours[ci];
    if (!contour) return false;
    const points = contour.points;
    const count = points.length;
    if (count < 2) return false;

    // Keep the split strictly inside the segment: t=0 or t=1 would drop the new
    // point on top of an existing one.
    const split = Math.min(0.99, Math.max(0.01, Number(t) || 0.5));

    // Collect the segment that starts at pi: [start, ...offsets, end]
    const startIndex = pi;
    const onCount = [];
    let cursor = (startIndex + 1) % count;
    let guard = 0;
    while (guard < 4) {
      const point = points[cursor];
      if (point[2]) break;
      onCount.push(cursor);
      cursor = (cursor + 1) % count;
      guard += 1;
    }
    if (!points[cursor] || !points[cursor][2]) return false;

    const p0 = points[startIndex];
    const p1 = points[cursor];
    const offs = onCount.map((i) => points[i]);

    let inserted;
    if (offs.length === 0) {
      // asOn() matters: a bare [x, y] pair has no on-curve flag, so the point
      // would be read back as an off-curve control point and the next split
      // would think it was looking at a curve.
      inserted = [asOn(lerp(p0, p1, split))];
    } else if (offs.length === 1) {
      // quadratic
      const a = lerp(p0, offs[0], split);
      const b = lerp(offs[0], p1, split);
      const m = lerp(a, b, split);
      inserted = [asOff(a), asOn(m), asOff(b)];
    } else {
      // cubic - uses the last two off-curve points
      const c1 = offs[offs.length - 2];
      const c2 = offs[offs.length - 1];
      const a = lerp(p0, c1, split);
      const b = lerp(c1, c2, split);
      const c = lerp(c2, p1, split);
      const d = lerp(a, b, split);
      const e = lerp(b, c, split);
      const m = lerp(d, e, split);
      inserted = [asOff(a), asOff(d), asOn(m), asOff(e), asOff(c)];
    }

    // Snapshot BEFORE mutating. Taking it afterwards captured the point that
    // had just been inserted, so the insert could never be undone.
    this.beginEdit();

    const at = (startIndex + 1) % (count + inserted.length);
    points.splice(startIndex + 1, 0, ...inserted);
    this.selection.clear();
    this.selection.add(`${ci}:${at}`);
    this.dirty = true;
    this.emit("structure");
    return true;
  }

  deleteSelectedPoints() {
    const glyph = this.glyph;
    if (!glyph || this.selection.size === 0) return false;
    this.beginEdit();

    const grouped = new Map();
    for (const key of this.selection) {
      const [ci, pi] = key.split(":").map(Number);
      if (!grouped.has(ci)) grouped.set(ci, []);
      grouped.get(ci).push(pi);
    }

    // Delete high indices first so earlier ones keep their position.
    for (const [ci, indices] of grouped) {
      const contour = glyph.contours[ci];
      if (!contour) continue;
      indices.sort((a, b) => b - a).forEach((pi) => contour.points.splice(pi, 1));
    }

    glyph.contours = glyph.contours.filter((c) => c.points.length >= 2);
    this.selection.clear();
    this.dirty = true;
    this.emit("structure");
    return true;
  }

  setPointType(onCurve) {
    const glyph = this.glyph;
    const selected = this.selectedPoints();
    if (!glyph || selected.length === 0) return false;
    this.beginEdit();
    for (const { point } of selected) {
      point[2] = onCurve ? 1 : 0;
      if (!onCurve && (point[3] === undefined || point[3] === null)) {
        point[3] = POINT_CURVE;
      }
    }
    this.dirty = true;
    this.emit("structure");
    return true;
  }

  /** Remove an entire contour. */
  deleteContour(ci) {
    const glyph = this.glyph;
    if (!glyph || !glyph.contours[ci]) return false;
    this.beginEdit();
    glyph.contours.splice(ci, 1);
    this.selection.clear();
    this.dirty = true;
    this.emit("structure");
    return true;
  }

  /**
   * Outlines of a glyph with every reference resolved, in that glyph's own space.
   *
   * Walks the `[glyphName, matrix]` pairs, applying each matrix, so borrowed
   * shapes can be baked down into real contours.
   */
  outlinesOf(name, depth = 0) {
    // Guard against a reference cycle, which would otherwise recurse forever.
    if (depth > 4) return [];
    const glyph = this.doc.glyphs.find((g) => g.name === name);
    if (!glyph) return [];

    const out = (glyph.contours || []).map((contour) => ({
      ...contour,
      points: contour.points.map((p) => [...p]),
    }));

    for (const ref of glyph.references || []) {
      const matrix = ref[1] || [1, 0, 0, 1, 0, 0];
      for (const contour of this.outlinesOf(ref[0], depth + 1)) {
        out.push({
          ...contour,
          points: contour.points.map((p) => [
            matrix[0] * p[0] + matrix[2] * p[1] + matrix[4],
            matrix[1] * p[0] + matrix[3] * p[1] + matrix[5],
            p[2],
            p[3],
            p[4],
            p[5],
          ]),
        });
      }
    }
    return out;
  }

  /**
   * Replace a composite glyph's references with real contours.
   *
   * Until this happens the glyph has nothing to select: no points, no segments,
   * no double-click targets, so it cannot be edited at all. This bakes each
   * referenced outline through its matrix into the glyph itself.
   */
  unlinkReferences() {
    const glyph = this.glyph;
    if (!glyph || !isComposite(glyph)) return false;

    const baked = this.outlinesOf(glyph.name);
    if (!baked.length) return false;

    this.beginEdit();
    glyph.contours = baked;
    glyph.references = [];
    this.selection.clear();
    this.dirty = true;
    this.emit("structure");
    return true;
  }

  /** Start a new empty contour (closed) on the current glyph. */
  addContour(points) {
    const glyph = this.glyph;
    if (!glyph) return false;
    this.beginEdit();
    glyph.contours.push({
      closed: true,
      quadratic: Boolean(glyph.quadratic),
      points: points || [
        [100, 0, 1, POINT_CORNER, 0, null],
        [500, 700, 1, POINT_CORNER, 0, null],
        [900, 0, 1, POINT_CORNER, 0, null],
      ],
    });
    this.dirty = true;
    this.emit("structure");
    return true;
  }

  /** Bounding box across all contours, or null when the glyph is empty. */
  glyphBounds() {
    return this.boundsOf(this.glyph ? this.glyph.contours : null);
  }

  /** Bounding box of everything the glyph *draws*, references included. */
  inkBounds() {
    const glyph = this.glyph;
    if (!glyph) return null;
    return this.boundsOf(this.outlinesOf(glyph.name));
  }

  boundsOf(contours) {
    if (!contours || contours.length === 0) return null;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const contour of contours) {
      for (const point of contour.points || []) {
        if (point[0] < minX) minX = point[0];
        if (point[1] < minY) minY = point[1];
        if (point[0] > maxX) maxX = point[0];
        if (point[1] > maxY) maxY = point[1];
      }
    }
    if (!Number.isFinite(minX)) return null;
    return { minX, minY, maxX, maxY };
  }

  // ---- metrics -----------------------------------------------------------
  /**
   * Slide the whole glyph, references included.
   *
   * A reference's position lives in the translation part of its matrix, so it
   * has to move with the outline or a composite would come apart.
   */
  translateAll(dx, dy = 0) {
    const glyph = this.glyph;
    if (!glyph || (dx === 0 && dy === 0)) return;
    for (const contour of glyph.contours || []) {
      for (const point of contour.points) {
        point[0] += dx;
        point[1] += dy;
      }
    }
    for (const ref of glyph.references || []) {
      const m = ref[1] || [1, 0, 0, 1, 0, 0];
      ref[1] = [m[0], m[1], m[2], m[3], m[4] + dx, m[5] + dy];
    }
  }

  /**
   * Move the glyph horizontally so its left edge sits at `value`.
   *
   * FontForge does not treat the left sidebearing as an independent number -
   * setting it slides the drawing and drags the advance width along, keeping the
   * right sidebearing fixed. Verified against the engine: setting lsb=300 on a
   * glyph spanning x=100..900 moved xMin to 300 and width from 1000 to 1200.
   * Mirroring that here is what keeps the document and the built font agreeing.
   */
  setLeftSideBearing(value) {
    const glyph = this.glyph;
    if (!glyph) return false;
    const target = Math.round(Number(value) || 0);
    const bounds = this.inkBounds();

    // Nothing drawn: the number is all there is to set.
    if (!bounds) {
      if (glyph.lsb === target) return false;
      this.beginEdit();
      glyph.lsb = target;
      this.dirty = true;
      this.emit("edit");
      return true;
    }

    const dx = target - Math.round(bounds.minX);
    if (dx === 0 && glyph.lsb === target) return false;

    this.beginEdit();
    this.translateAll(dx, 0);
    glyph.width = Math.round(Number(glyph.width) || 0) + dx;
    glyph.lsb = target;
    this.dirty = true;
    this.emit("structure");
    return true;
  }

  /** Set the advance width, snapshotting first. */
  setAdvanceWidth(value) {
    const glyph = this.glyph;
    if (!glyph) return false;
    const next = Math.round(Number(value) || 0);
    if (glyph.width === next) return false;
    this.beginEdit();
    glyph.width = next;
    this.dirty = true;
    this.emit("edit");
    return true;
  }

  /**
   * Keep the stored left sidebearing honest.
   *
   * In the engine LSB *is* xMin, so dragging a point left must move the stored
   * value with it. Without this the two drift apart and the build slides the
   * glyph back, silently exporting something other than what was drawn. Silent
   * by design - it corrects a derived value, it is not an edit.
   */
  syncSideBearing() {
    const glyph = this.glyph;
    if (!glyph) return;
    const bounds = this.inkBounds();
    const derived = bounds ? Math.round(bounds.minX) : 0;
    if (glyph.lsb !== derived) glyph.lsb = derived;
  }

  /**
   * A plausible advance width for this font: the most common non-zero width
   * already in use, so a reset lands on something that matches the design.
   * Falls back to the em when nothing has been drawn yet.
   */
  typicalWidth() {
    const counts = new Map();
    for (const glyph of this.doc.glyphs || []) {
      const width = Math.round(Number(glyph.width) || 0);
      if (width > 0) counts.set(width, (counts.get(width) || 0) + 1);
    }
    let best = 0;
    let bestCount = 0;
    for (const [width, count] of counts) {
      // Ties go to the narrower width, which is the safer default.
      if (count > bestCount || (count === bestCount && width < best)) {
        best = width;
        bestCount = count;
      }
    }
    return best || Math.round(Number(this.doc.em) || 0) || 600;
  }

  /** The numbers behind the spacing fields, for the readout beneath them. */
  spacing() {
    const glyph = this.glyph;
    if (!glyph) return null;
    const width = Math.round(Number(glyph.width) || 0);
    const lsb = Math.round(Number(glyph.lsb) || 0);
    const bounds = this.inkBounds();
    if (!bounds) return { lsb, width, inkWidth: null, rsb: null, empty: true };
    const inkWidth = Math.round(bounds.maxX - bounds.minX);
    return {
      lsb,
      width,
      inkWidth,
      // What is left for the right side, which is what the next glyph sees.
      rsb: width - lsb - inkWidth,
      empty: false,
    };
  }

  // ---- reference templates -----------------------------------------------
  /**
   * Lookup tables from code point to glyph.
   *
   * `byCompat` exists because fonts almost always draw the *spacing* clone
   * (U+02C7 caron) and reference that, while Unicode decomposition asks for the
   * combining mark (U+030C). The spacing clone's compatibility decomposition
   * contains the mark, which links the two without a lookup table. Cached by
   * glyph count, which is enough because this only feeds template matching.
   */
  compatIndex() {
    const key = (this.doc.glyphs || []).length;
    if (this._compat && this._compat.key === key) return this._compat;

    const byCode = new Map();
    const byCompat = new Map();
    for (const glyph of this.doc.glyphs || []) {
      if (!Number.isInteger(glyph.unicode) || glyph.unicode < 0) continue;
      byCode.set(glyph.unicode, glyph);
      let text;
      try {
        text = String.fromCodePoint(glyph.unicode);
      } catch {
        continue;
      }
      const compat = text.normalize("NFKD");
      if (compat === text) continue;

      // Only "spacing clones" qualify: a character whose decomposition is marks
      // alone, optionally after a space - U+02C7 caron -> U+0020 U+030C. A
      // precomposed letter such as U+0160 also decomposes to base + mark, and
      // letting that map the mark back to the letter makes the glyph reference
      // *itself* when composed from its own template.
      const parts = Array.from(compat);
      if (!parts.every((ch) => ch === " " || /\p{M}/u.test(ch))) continue;

      for (const ch of parts) {
        const code = ch.codePointAt(0);
        if (code !== glyph.unicode && !byCompat.has(code)) byCompat.set(code, glyph);
      }
    }
    this._compat = { key, byCode, byCompat };
    return this._compat;
  }

  /** The glyph that can stand in for a code point: exact, compat, or by name. */
  glyphForCode(code) {
    const index = this.compatIndex();
    const found = index.byCode.get(code) || index.byCompat.get(code);
    if (found) return found;

    const aliases = MARK_NAMES[code];
    if (!aliases) return null;
    const wanted = new Set(aliases.map((name) => name.toLowerCase()));
    wanted.add(`uni${code.toString(16).toUpperCase().padStart(4, "0")}`.toLowerCase());
    for (const glyph of this.doc.glyphs || []) {
      if (wanted.has(String(glyph.name).toLowerCase())) return glyph;
    }
    return null;
  }

  /**
   * Decomposition template for a code point, using the browser's own Unicode
   * normalisation.
   *
   * `S` + caron, `E` + acute - that is exactly the structure composite glyphs
   * are built from, and NFD hands it over for free, so no decomposition table
   * has to be shipped. Returns null when the code point does not decompose.
   */
  templateParts(code = null) {
    const glyph = this.glyph;
    const point = code === null ? (glyph ? glyph.unicode : -1) : code;
    if (!Number.isInteger(point) || point < 0) return null;

    let text;
    try {
      text = String.fromCodePoint(point);
    } catch {
      return null;
    }

    const codes = Array.from(text.normalize("NFD"), (ch) => ch.codePointAt(0));
    if (codes.length < 2) return null;

    return codes.map((value, index) => {
      const part = String.fromCodePoint(value);
      return {
        code: value,
        // A combining mark is a mark; the first part is the base it sits on.
        combining: index > 0 && /\p{M}/u.test(part),
        glyph: this.glyphForCode(value),
      };
    });
  }

  /**
   * Build this glyph as a composite from its decomposition template.
   *
   * Marks are placed centred over the base's ink and resting on top of it. That
   * is a deliberate starting point rather than correct accent placement, which
   * is font-specific - the result is meant to be nudged (the transform panel
   * moves references) or unlinked.
   *
   * @returns {{ok: boolean, missing?: number}} what happened, and which code
   *   point had no glyph to reference.
   */
  composeFromTemplate(parts = null) {
    const glyph = this.glyph;
    if (!glyph) return { ok: false };
    const template = parts || this.templateParts();
    if (!template || template.length < 2) return { ok: false };

    // A glyph must never reference itself: that is a cycle the engine cannot
    // resolve, and it would only ever be a bug in the template lookup.
    if (template.some((part) => part.glyph === glyph && part.glyph)) {
      return { ok: false, selfReference: true };
    }

    const base = template[0].glyph;
    if (!base) return { ok: false, missing: template[0].code };
    for (const part of template.slice(1)) {
      if (!part.glyph) return { ok: false, missing: part.code };
    }

    const baseBounds = this.boundsOf(this.outlinesOf(base.name));
    if (!baseBounds) return { ok: false, missing: base.unicode };
    const baseCenter = (baseBounds.minX + baseBounds.maxX) / 2;

    const references = [[base.name, [1, 0, 0, 1, 0, 0]]];
    let top = baseBounds.maxY;

    for (const part of template.slice(1)) {
      const bounds = this.boundsOf(this.outlinesOf(part.glyph.name));
      if (!bounds) continue;
      const markWidth = bounds.maxX - bounds.minX;
      const dx = Math.round(baseCenter - bounds.minX - markWidth / 2);
      const dy = Math.round(top - bounds.minY);
      references.push([part.glyph.name, [1, 0, 0, 1, dx, dy]]);
      top += bounds.maxY - bounds.minY;
    }

    this.beginEdit();
    glyph.contours = [];
    glyph.references = references;
    // Inherit the base's spacing, or fall back to the font's usual width when the
    // base has not been spaced yet - inheriting a bare 0 would help nobody.
    glyph.width = Math.round(Number(base.width) || 0) || this.typicalWidth();
    this.dirty = true;
    this.emit("structure");
    return { ok: true, references };
  }

  // ---- transforms --------------------------------------------------------
  /** The points a transform would affect: the selection, or the whole glyph. */
  transformTargets() {
    const selected = this.selectedPoints();
    if (selected.length) return selected.map((entry) => entry.point);
    const glyph = this.glyph;
    if (!glyph) return [];
    const out = [];
    for (const contour of glyph.contours || []) {
      for (const point of contour.points) out.push(point);
    }
    return out;
  }

  /**
   * Apply an affine matrix `[a, b, c, d, e, f]` to the selection (or the whole
   * glyph when nothing is selected).
   *
   * The matrix is applied about the targets' bounding-box centre, which is what
   * users expect from "flip" and "scale"; `dx`/`dy` are added afterwards in
   * font units, so "move" is unaffected by the rotation/scale.
   *
   * @returns {boolean} whether anything changed
   */
  transform(matrix, options = {}) {
    const selected = this.selectedPoints();
    const targets = this.transformTargets();
    const glyph = this.glyph;
    const references = glyph && !selected.length ? glyph.references || [] : [];
    // A composite has no points of its own, so references alone are enough to
    // justify a transform.
    if (!targets.length && !references.length) return false;

    const [a, b, c, d, e, f] = matrix;
    const dx = Number(options.dx) || 0;
    const dy = Number(options.dy) || 0;

    let cx = 0;
    let cy = 0;
    if (options.aboutCenter !== false) {
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      const pivotOn = targets.length ? targets : this.outlinesOf(glyph.name).flatMap((c2) => c2.points);
      for (const point of pivotOn) {
        if (point[0] < minX) minX = point[0];
        if (point[1] < minY) minY = point[1];
        if (point[0] > maxX) maxX = point[0];
        if (point[1] > maxY) maxY = point[1];
      }
      if (!Number.isFinite(minX)) {
        cx = 0;
        cy = 0;
      } else {
        cx = (minX + maxX) / 2;
        cy = (minY + maxY) / 2;
      }
    }

    this.beginEdit();
    for (const point of targets) {
      const x = point[0] - cx;
      const y = point[1] - cy;
      point[0] = a * x + c * y + e + cx + dx;
      point[1] = b * x + d * y + f + cy + dy;
    }

    // References carry their own matrix, so a whole-glyph transform has to be
    // composed with it (`outer` then `inner`); otherwise a composite would be
    // left behind while its own outlines moved.
    if (references.length) {
      const E = e + cx + dx - a * cx - c * cy;
      const F = f + cy + dy - b * cx - d * cy;
      for (const ref of references) {
        const m = ref[1] || [1, 0, 0, 1, 0, 0];
        ref[1] = [
          a * m[0] + c * m[1],
          b * m[0] + d * m[1],
          a * m[2] + c * m[3],
          b * m[2] + d * m[3],
          a * m[4] + c * m[5] + E,
          b * m[4] + d * m[5] + F,
        ];
      }
    }

    this.dirty = true;
    this.emit("structure");
    return true;
  }

  // ---- glyph duplication -------------------------------------------------
  /** Deep-copy a glyph's outlines and metrics into a new glyph. */
  duplicateGlyph(sourceName, newName, unicode = -1) {
    const source = this.doc.glyphs.find((g) => g.name === sourceName);
    if (!source) return null;
    if (this.doc.glyphs.some((g) => g.name === newName)) return null;
    const copy = clone(source);
    copy.name = newName;
    copy.unicode = unicode;
    this.doc.glyphs.push(copy);
    this.dirty = true;
    return copy;
  }

  /** Suggest an unused glyph name derived from `base` (e.g. A -> A.alt). */
  uniqueGlyphName(base) {
    const taken = new Set(this.doc.glyphs.map((g) => g.name));
    if (!taken.has(base)) return base;
    for (let i = 1; i < 1000; i += 1) {
      const candidate = `${base}.${i}`;
      if (!taken.has(candidate)) return candidate;
    }
    return `${base}.${Date.now()}`;
  }
}

function lerp(a, b, t) {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}

function asOff(point) {
  return [point[0], point[1], 0, POINT_CURVE, 0, null];
}

function asOn(point) {
  return [point[0], point[1], 1, POINT_CORNER, 0, null];
}

// ---------------------------------------------------------------------------
// Affine matrices, laid out as [a, b, c, d, e, f]:
//   x' = a*x + c*y + e
//   y' = b*x + d*y + f
// (the same order FontForge and PostScript use)
// ---------------------------------------------------------------------------
const DEG = Math.PI / 180;

export const mat = {
  identity: () => [1, 0, 0, 1, 0, 0],
  scale: (sx, sy) => [sx, 0, 0, sy, 0, 0],
  rotate: (deg) => {
    const r = deg * DEG;
    const cos = Math.cos(r);
    const sin = Math.sin(r);
    return [cos, sin, -sin, cos, 0, 0];
  },
  skew: (degX, degY) => [1, Math.tan(degY * DEG), Math.tan(degX * DEG), 1, 0, 0],
  flipH: () => [-1, 0, 0, 1, 0, 0],
  flipV: () => [1, 0, 0, -1, 0, 0],
  /** Compose so `first` is applied before `second`. */
  compose(first, second) {
    const [a1, b1, c1, d1, e1, f1] = first;
    const [a2, b2, c2, d2, e2, f2] = second;
    return [
      a1 * a2 + b1 * c2,
      a1 * b2 + b1 * d2,
      c1 * a2 + d1 * c2,
      c1 * b2 + d1 * d2,
      e1 * a2 + f1 * c2 + e2,
      e1 * b2 + f1 * d2 + f2,
    ];
  },
};
