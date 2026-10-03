/**
 * TrueType writer: document -> sfnt (.ttf) bytes, entirely in the browser.
 *
 * The mirror of `font-parser.js`, and written for the same reason: the static
 * build runs under `default-src 'self'` with no bundler, so a font library
 * cannot be fetched from a CDN and vendoring one drags in a licence obligation.
 * Only the tables a font needs to install and render are written.
 *
 * Outlines: TrueType is a *quadratic* format. Contours the document already
 * flagged as quadratic are written through unchanged; cubic contours (the
 * editor's default) are converted by adaptive subdivision. Composite glyphs are
 * written from their `references`. The module is pure - a document in, a
 * Uint8Array out - so it can be tested under Node without a DOM.
 */

import { buildSegments } from "./glyph-outline.js";

// --- tiny growable byte writer --------------------------------------------
class Writer {
  constructor(capacity = 1024) {
    this.buf = new Uint8Array(capacity);
    this.view = new DataView(this.buf.buffer);
    this.len = 0;
  }

  _ensure(n) {
    if (this.len + n <= this.buf.length) return;
    let size = this.buf.length * 2;
    while (size < this.len + n) size *= 2;
    const next = new Uint8Array(size);
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
    this.view = new DataView(next.buffer);
  }

  u8(v) { this._ensure(1); this.view.setUint8(this.len, v & 0xff); this.len += 1; }
  u16(v) { this._ensure(2); this.view.setUint16(this.len, v & 0xffff); this.len += 2; }
  i16(v) { this._ensure(2); this.view.setInt16(this.len, clampI16(v)); this.len += 2; }
  u32(v) { this._ensure(4); this.view.setUint32(this.len, v >>> 0); this.len += 4; }
  i32(v) { this._ensure(4); this.view.setInt32(this.len, v | 0); this.len += 4; }
  tag(text) { for (let i = 0; i < 4; i += 1) this.u8(text.charCodeAt(i)); }
  raw(bytes) { this._ensure(bytes.length); this.buf.set(bytes, this.len); this.len += bytes.length; }
  zeros(n) { this._ensure(n); this.len += n; }
  toUint8Array() { return this.buf.subarray(0, this.len); }
}

const clampI16 = (v) => Math.max(-32768, Math.min(32767, Math.round(v) || 0));
const clampU16 = (v) => Math.max(0, Math.min(65535, Math.round(v) || 0));
const pad4 = (n) => (n + 3) & ~3;

function padBytes(bytes) {
  const target = pad4(bytes.length);
  if (target === bytes.length) return bytes;
  const out = new Uint8Array(target);
  out.set(bytes);
  return out;
}

/** sfnt table checksum: sum of big-endian uint32s over 4-byte-padded data. */
function checksum(bytes) {
  let sum = 0;
  const padded = padBytes(bytes);
  for (let i = 0; i < padded.length; i += 4) {
    sum = (sum + ((padded[i] << 24) | (padded[i + 1] << 16) | (padded[i + 2] << 8) | padded[i + 3])) >>> 0;
  }
  return sum >>> 0;
}

// --- cubic -> quadratic conversion ----------------------------------------
const lerp2 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];

function cubicAt(p0, c1, c2, p1, t) {
  const u = 1 - t;
  const a = u * u * u;
  const b = 3 * u * u * t;
  const c = 3 * u * t * t;
  const d = t * t * t;
  return [
    a * p0[0] + b * c1[0] + c * c2[0] + d * p1[0],
    a * p0[1] + b * c1[1] + c * c2[1] + d * p1[1],
  ];
}

function quadAt(a, c, b, t) {
  const u = 1 - t;
  return [
    u * u * a[0] + 2 * u * t * c[0] + t * t * b[0],
    u * u * a[1] + 2 * u * t * c[1] + t * t * b[1],
  ];
}

/**
 * Approximate one cubic segment with quadratics by adaptive subdivision.
 *
 * The best single quadratic for a cubic shares its endpoints and puts its
 * control point at (3*(c1+c2) - p0 - p1) / 4. The error is sampled at three
 * interior points; when it exceeds `tol` the cubic is split at t=0.5 and each
 * half is retried. Depth-capped so a pathological curve cannot spin forever.
 *
 * Pushes `[ctrlX, ctrlY, endX, endY]` for each piece.
 */
function cubicToQuads(p0, c1, c2, p1, tol, out, depth) {
  const qx = (3 * (c1[0] + c2[0]) - p0[0] - p1[0]) / 4;
  const qy = (3 * (c1[1] + c2[1]) - p0[1] - p1[1]) / 4;

  let err = 0;
  for (const t of [0.25, 0.5, 0.75]) {
    const onCurve = cubicAt(p0, c1, c2, p1, t);
    const approx = quadAt(p0, [qx, qy], p1, t);
    err = Math.max(err, Math.hypot(onCurve[0] - approx[0], onCurve[1] - approx[1]));
  }

  if (err <= tol || depth >= 10) {
    out.push([qx, qy, p1[0], p1[1]]);
    return;
  }

  const p01 = lerp2(p0, c1, 0.5);
  const p12 = lerp2(c1, c2, 0.5);
  const p23 = lerp2(c2, p1, 0.5);
  const p012 = lerp2(p01, p12, 0.5);
  const p123 = lerp2(p12, p23, 0.5);
  const mid = lerp2(p012, p123, 0.5);

  cubicToQuads(p0, p01, p012, mid, tol, out, depth + 1);
  cubicToQuads(mid, p123, p23, p1, tol, out, depth + 1);
}

/**
 * One document contour -> a TrueType point list `[{x, y, on}]`.
 *
 * `buildSegments` (the renderer's own reading of the point rules) is reused so
 * the two never disagree about implied midpoints or degenerate 1-control cubics.
 * Coordinates are rounded here, which keeps the bounding boxes honest.
 */
function contourToTtPoints(contour, upem) {
  const segments = buildSegments(contour);
  if (!segments.length) return null;

  const tol = Math.max(0.3, upem / 1500);
  const start = segments[0].p0;
  const pts = [{ x: Math.round(start[0]), y: Math.round(start[1]), on: true }];

  for (const seg of segments) {
    if (seg.kind === "line") {
      pts.push({ x: Math.round(seg.p1[0]), y: Math.round(seg.p1[1]), on: true });
    } else if (seg.kind === "quad") {
      pts.push({ x: Math.round(seg.c[0]), y: Math.round(seg.c[1]), on: false });
      pts.push({ x: Math.round(seg.p1[0]), y: Math.round(seg.p1[1]), on: true });
    } else {
      const quads = [];
      cubicToQuads(seg.p0, seg.c1, seg.c2, seg.p1, tol, quads, 0);
      for (const q of quads) {
        pts.push({ x: Math.round(q[0]), y: Math.round(q[1]), on: false });
        pts.push({ x: Math.round(q[2]), y: Math.round(q[3]), on: true });
      }
    }
  }

  // A closed contour's last segment lands back on the start point we already
  // pushed; TrueType closes contours implicitly, so drop the duplicate.
  while (pts.length > 2) {
    const last = pts[pts.length - 1];
    const first = pts[0];
    if (last.on && first.on && last.x === first.x && last.y === first.y) pts.pop();
    else break;
  }

  if (pts.length < 2 || !pts.some((p) => p.on)) return null;
  return pts;
}

/** Composite components for a glyph, resolving reference names to indices. */
function compositeComponents(glyph, indexOf) {
  const out = [];
  for (const ref of glyph.references || []) {
    if (!Array.isArray(ref)) continue;
    const glyphIndex = indexOf.get(ref[0]);
    if (glyphIndex === undefined) continue;
    const m = ref[1] || [1, 0, 0, 1, 0, 0];
    out.push({
      glyphIndex,
      a: Number(m[0]) || 0,
      b: Number(m[1]) || 0,
      c: Number(m[2]) || 0,
      d: Number(m[3]) || 0,
      dx: Math.round(Number(m[4]) || 0),
      dy: Math.round(Number(m[5]) || 0),
    });
  }
  return out;
}

// --- glyph encoding --------------------------------------------------------

function bboxOfPoints(points) {
  if (!points.length) return { xMin: 0, yMin: 0, xMax: 0, yMax: 0 };
  let xMin = Infinity;
  let yMin = Infinity;
  let xMax = -Infinity;
  let yMax = -Infinity;
  for (const p of points) {
    if (p.x < xMin) xMin = p.x;
    if (p.y < yMin) yMin = p.y;
    if (p.x > xMax) xMax = p.x;
    if (p.y > yMax) yMax = p.y;
  }
  return { xMin: clampI16(xMin), yMin: clampI16(yMin), xMax: clampI16(xMax), yMax: clampI16(yMax) };
}

function encodeSimpleGlyph(contours, bbox) {
  const w = new Writer();
  w.i16(contours.length);
  w.i16(bbox.xMin); w.i16(bbox.yMin); w.i16(bbox.xMax); w.i16(bbox.yMax);

  let last = -1;
  for (const contour of contours) {
    last += contour.length;
    w.u16(last);
  }
  w.u16(0); // instructionLength

  const points = [];
  for (const contour of contours) for (const p of contour) points.push(p);

  // Flags: on-curve bit only. With no short-vector bits set, both coordinate
  // deltas are plain int16s, which is simple and always valid.
  for (const p of points) w.u8(p.on ? 0x01 : 0x00);

  let px = 0;
  for (const p of points) { w.i16(p.x - px); px = p.x; }
  let py = 0;
  for (const p of points) { w.i16(p.y - py); py = p.y; }

  return w.toUint8Array();
}

function f2dot14(v) {
  return clampI16(Math.round((Number(v) || 0) * 16384));
}

function encodeCompositeGlyph(components, bbox) {
  const near = (a, b) => Math.abs(a - b) < 1 / 16384;
  const w = new Writer();
  w.i16(-1);
  w.i16(bbox.xMin); w.i16(bbox.yMin); w.i16(bbox.xMax); w.i16(bbox.yMax);

  components.forEach((comp, i) => {
    let flags = 0x0003; // ARG_1_AND_2_ARE_WORDS | ARGS_ARE_XY_VALUES
    if (i < components.length - 1) flags |= 0x0020; // MORE_COMPONENTS

    const identity = near(comp.a, 1) && near(comp.b, 0) && near(comp.c, 0) && near(comp.d, 1);
    if (!identity) {
      if (near(comp.b, 0) && near(comp.c, 0)) {
        flags |= near(comp.a, comp.d) ? 0x0008 : 0x0040; // SCALE / X_AND_Y_SCALE
      } else {
        flags |= 0x0080; // TWO_BY_TWO
      }
    }

    w.u16(flags);
    w.u16(comp.glyphIndex);
    w.i16(comp.dx);
    w.i16(comp.dy);
    if (flags & 0x0008) w.i16(f2dot14(comp.a));
    else if (flags & 0x0040) { w.i16(f2dot14(comp.a)); w.i16(f2dot14(comp.d)); }
    else if (flags & 0x0080) {
      w.i16(f2dot14(comp.a)); w.i16(f2dot14(comp.b));
      w.i16(f2dot14(comp.c)); w.i16(f2dot14(comp.d));
    }
  });

  return w.toUint8Array();
}

// --- individual tables -----------------------------------------------------

function headTable(upem, bbox, created) {
  const w = new Writer(54);
  w.u32(0x00010000); // version 1.0
  w.u32(0x00010000); // fontRevision
  w.u32(0); // checkSumAdjustment (patched during assembly)
  w.u32(0x5f0f3cf5); // magicNumber
  w.u16(0x0003); // flags: baseline at y=0, lsb at x=0
  w.u16(upem);
  // LONGDATETIME int64 seconds since 1904; the value fits in the low word.
  w.u32(0); w.u32(created); // created
  w.u32(0); w.u32(created); // modified
  w.i16(bbox.xMin); w.i16(bbox.yMin); w.i16(bbox.xMax); w.i16(bbox.yMax);
  w.u16(0); // macStyle
  w.u16(8); // lowestRecPPEM
  w.i16(2); // fontDirectionHint
  w.i16(1); // indexToLocFormat: long
  w.i16(0); // glyphDataFormat
  return w.toUint8Array();
}

function hheaTable(doc, hmtx) {
  const w = new Writer(36);
  w.u32(0x00010000);
  w.i16(doc.ascent);
  w.i16(-Math.abs(doc.descent));
  w.i16(0); // lineGap
  w.u16(hmtx.advanceMax);
  w.i16(hmtx.minLsb);
  w.i16(hmtx.minRsb);
  w.i16(hmtx.xMaxExtent);
  w.i16(1); // caretSlopeRise
  w.i16(0); // caretSlopeRun
  w.i16(0); // caretOffset
  w.i16(0); w.i16(0); w.i16(0); w.i16(0); // reserved
  w.i16(0); // metricDataFormat
  w.u16(hmtx.numberOfHMetrics);
  return w.toUint8Array();
}

function maxpTable(stats) {
  const w = new Writer(32);
  w.u32(0x00010000);
  w.u16(stats.numGlyphs);
  w.u16(stats.maxPoints);
  w.u16(stats.maxContours);
  w.u16(stats.maxCompositePoints);
  w.u16(stats.maxCompositeContours);
  w.u16(2); // maxZones
  w.u16(0); // maxTwilightPoints
  w.u16(0); // maxStorage
  w.u16(0); // maxFunctionDefs
  w.u16(0); // maxInstructionDefs
  w.u16(0); // maxStackElements
  w.u16(0); // maxSizeOfInstructions
  w.u16(stats.maxComponentElements);
  w.u16(stats.maxComponentDepth);
  return w.toUint8Array();
}

function os2Table(doc, sum) {
  const w = new Writer(96);
  const upem = doc.em;
  w.u16(4); // version
  w.i16(sum.avgAdvance);
  w.u16(400); // usWeightClass
  w.u16(5); // usWidthClass
  w.u16(0); // fsType: installable
  w.i16(Math.round(upem * 0.65)); w.i16(Math.round(upem * 0.6));
  w.i16(0); w.i16(Math.round(upem * 0.075));
  w.i16(Math.round(upem * 0.65)); w.i16(Math.round(upem * 0.6));
  w.i16(0); w.i16(Math.round(upem * 0.35));
  w.i16(Math.round(upem * 0.05)); w.i16(Math.round(upem * 0.26));
  w.i16(0); // sFamilyClass
  for (const byte of [2, 0, 0, 0, 0, 0, 0, 0, 0, 0]) w.u8(byte); // panose
  w.u32(0); w.u32(0); w.u32(0); w.u32(0); // unicode ranges
  w.tag("NONE"); // achVendID
  w.u16(0x0040); // fsSelection: regular
  w.u16(sum.firstChar);
  w.u16(sum.lastChar);
  w.i16(doc.ascent); w.i16(-Math.abs(doc.descent)); w.i16(0); // typo metrics
  w.u16(clampU16(doc.ascent)); w.u16(clampU16(doc.descent)); // win metrics
  w.u32(1); w.u32(0); // code page ranges: Latin 1
  w.i16(0); // sxHeight
  w.i16(0); // sCapHeight
  w.u16(0); // usDefaultChar
  w.u16(32); // usBreakChar: space
  w.u16(0); // usMaxContext
  return w.toUint8Array();
}

function cmapFormat4(glyphByCode) {
  const codes = [...glyphByCode.keys()].filter((c) => c >= 0 && c <= 0xffff).sort((a, b) => a - b);
  const segs = [];
  let i = 0;
  while (i < codes.length) {
    const start = codes[i];
    const delta = (glyphByCode.get(start) - start) & 0xffff;
    let end = start;
    let j = i;
    while (j + 1 < codes.length) {
      const next = codes[j + 1];
      if (next !== codes[j] + 1) break;
      if (((glyphByCode.get(next) - next) & 0xffff) !== delta) break;
      j += 1;
      end = next;
    }
    segs.push({ start, end, delta });
    i = j + 1;
  }
  segs.push({ start: 0xffff, end: 0xffff, delta: 1 }); // sentinel -> .notdef

  const segCount = segs.length;
  const segCountX2 = segCount * 2;
  let searchRange = 1;
  let entrySelector = 0;
  while (searchRange * 2 <= segCount) { searchRange *= 2; entrySelector += 1; }
  searchRange *= 2;
  const rangeShift = segCountX2 - searchRange;
  const length = 16 + segCount * 8;

  const w = new Writer(length);
  w.u16(4); w.u16(length); w.u16(0);
  w.u16(segCountX2); w.u16(searchRange); w.u16(entrySelector); w.u16(rangeShift);
  for (const s of segs) w.u16(s.end);
  w.u16(0); // reservedPad
  for (const s of segs) w.u16(s.start);
  for (const s of segs) w.u16(s.delta & 0xffff);
  for (let k = 0; k < segCount; k += 1) w.u16(0); // idRangeOffset
  return w.toUint8Array();
}

function cmapFormat12(glyphByCode) {
  const codes = [...glyphByCode.keys()].sort((a, b) => a - b);
  const groups = [];
  let i = 0;
  while (i < codes.length) {
    const start = codes[i];
    const gid = glyphByCode.get(start);
    let end = start;
    let j = i;
    while (j + 1 < codes.length && codes[j + 1] === codes[j] + 1 && glyphByCode.get(codes[j + 1]) === gid + (codes[j + 1] - start)) {
      j += 1;
      end = codes[j];
    }
    groups.push({ start, end, gid });
    i = j + 1;
  }

  const length = 16 + groups.length * 12;
  const w = new Writer(length);
  w.u16(12); w.u16(0); w.u32(length); w.u32(0); w.u32(groups.length);
  for (const g of groups) { w.u32(g.start); w.u32(g.end); w.u32(g.gid); }
  return w.toUint8Array();
}

function cmapTable(glyphByCode) {
  const sub4 = cmapFormat4(glyphByCode);
  const hasAstral = [...glyphByCode.keys()].some((c) => c > 0xffff);
  const sub12 = hasAstral ? cmapFormat12(glyphByCode) : null;

  const records = [
    { platform: 0, encoding: 3, which: 0 },
    { platform: 3, encoding: 1, which: 0 },
  ];
  if (sub12) {
    records.push({ platform: 0, encoding: 4, which: 1 });
    records.push({ platform: 3, encoding: 10, which: 1 });
  }

  const headerLen = 4 + records.length * 8;
  const off4 = headerLen;
  const off12 = sub12 ? off4 + pad4(sub4.length) : 0;

  const w = new Writer();
  w.u16(0);
  w.u16(records.length);
  for (const r of records) {
    w.u16(r.platform); w.u16(r.encoding);
    w.u32(r.which === 0 ? off4 : off12);
  }
  w.raw(sub4);
  if (sub12) { w.zeros(pad4(sub4.length) - sub4.length); w.raw(sub12); }
  return w.toUint8Array();
}

function utf16be(text) {
  const w = new Writer(text.length * 2);
  for (let i = 0; i < text.length; i += 1) w.u16(text.charCodeAt(i));
  return w.toUint8Array();
}

function nameTable(doc) {
  const records = [
    [0, doc.comment || ""],
    [1, doc.family_name || "Untitled"],
    [2, doc.style_name || "Regular"],
    [3, `${doc.family_name || "Untitled"}-${doc.style_name || "Regular"}; Font Builder Studio`],
    [4, `${doc.family_name || "Untitled"} ${doc.style_name || "Regular"}`.trim()],
    [5, "Version 1.000"],
    [6, (doc.font_name || `${doc.family_name || "Untitled"}-${doc.style_name || "Regular"}`)
      .replace(/[^\x21-\x7e]/g, "").slice(0, 63) || "Untitled-Regular"],
  ].filter(([, text]) => text !== "").sort((a, b) => a[0] - b[0]);

  const encoded = records.map(([id, text]) => [id, utf16be(text)]);
  const headerLen = 6 + encoded.length * 12;
  let storageLen = 0;
  for (const [, bytes] of encoded) storageLen += bytes.length;

  const w = new Writer(headerLen + storageLen);
  w.u16(0);
  w.u16(encoded.length);
  w.u16(headerLen);

  let offset = 0;
  for (const [id, bytes] of encoded) {
    w.u16(3); w.u16(1); w.u16(0x0409); w.u16(id);
    w.u16(bytes.length); w.u16(offset);
    offset += bytes.length;
  }
  for (const [, bytes] of encoded) w.raw(bytes);
  return w.toUint8Array();
}

function postTable(upem) {
  const w = new Writer(32);
  w.u32(0x00030000); // version 3.0: no glyph names
  w.i32(0); // italicAngle
  w.i16(-Math.round(upem * 0.075)); // underlinePosition
  w.i16(Math.round(upem * 0.05)); // underlineThickness
  w.u32(0); // isFixedPitch
  w.u32(0); w.u32(0); w.u32(0); w.u32(0); // memory hints
  return w.toUint8Array();
}

// --- assembly --------------------------------------------------------------

function assembleSfnt(tables) {
  const sorted = [...tables].sort((a, b) => (a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0));
  const numTables = sorted.length;

  let searchRange = 1;
  let entrySelector = 0;
  while (searchRange * 2 <= numTables) { searchRange *= 2; entrySelector += 1; }
  searchRange *= 16;
  const rangeShift = numTables * 16 - searchRange;

  let offset = 12 + numTables * 16;
  const records = [];
  for (const t of sorted) {
    const data = padBytes(t.data);
    records.push({ tag: t.tag, offset, length: t.data.length, data, checksum: checksum(data) });
    offset += data.length;
  }

  const out = new Uint8Array(offset);
  const view = new DataView(out.buffer);
  view.setUint32(0, 0x00010000);
  view.setUint16(4, numTables);
  view.setUint16(6, searchRange);
  view.setUint16(8, entrySelector);
  view.setUint16(10, rangeShift);

  let rec = 12;
  for (const r of records) {
    for (let i = 0; i < 4; i += 1) out[rec + i] = r.tag.charCodeAt(i);
    view.setUint32(rec + 4, r.checksum);
    view.setUint32(rec + 8, r.offset);
    view.setUint32(rec + 12, r.length);
    rec += 16;
  }
  for (const r of records) out.set(r.data, r.offset);

  // checkSumAdjustment: computed with the field still 0, then patched in place.
  const head = records.find((r) => r.tag === "head");
  if (head) {
    const adjustment = (0xb1b0afba - checksum(out)) >>> 0;
    view.setUint32(head.offset + 8, adjustment);
  }
  return out;
}

/**
 * Build a TrueType font from a document.
 *
 * @param {object} doc the editor's document
 * @returns {Uint8Array} the complete .ttf bytes
 */
export function buildTrueTypeFont(doc) {
  const upem = Math.max(16, Math.min(16384, Math.round(doc.em) || 1000));

  // Glyph order: .notdef must be index 0.
  const glyphs = [
    { name: ".notdef", unicode: -1, width: Math.round(upem / 2), lsb: 0, contours: [], references: [] },
    ...(doc.glyphs || []).filter(Boolean),
  ];
  const indexOf = new Map();
  glyphs.forEach((g, i) => { if (!indexOf.has(g.name)) indexOf.set(g.name, i); });

  const n = glyphs.length;
  const simpleContours = new Array(n).fill(null);
  const components = new Array(n).fill(null);

  for (let i = 0; i < n; i += 1) {
    const glyph = glyphs[i];
    const contours = [];
    for (const contour of glyph.contours || []) {
      const pts = contourToTtPoints(contour, upem);
      if (pts) contours.push(pts);
    }
    if (contours.length) simpleContours[i] = contours;
    else components[i] = compositeComponents(glyph, indexOf);
  }

  // Resolve drawable points per glyph (composites flattened) for bboxes and
  // the font-wide bounds. Cycle-guarded so a bad reference cannot recurse away.
  const pointCache = new Array(n).fill(null);
  function glyphPoints(index, seen) {
    if (pointCache[index]) return pointCache[index];
    if (seen.has(index)) return [];
    seen.add(index);
    let out = [];
    if (simpleContours[index]) {
      for (const contour of simpleContours[index]) for (const p of contour) out.push(p);
    } else if (components[index]) {
      for (const comp of components[index]) {
        for (const p of glyphPoints(comp.glyphIndex, seen)) {
          out.push({
            x: comp.a * p.x + comp.c * p.y + comp.dx,
            y: comp.b * p.x + comp.d * p.y + comp.dy,
          });
        }
      }
    }
    seen.delete(index);
    pointCache[index] = out;
    return out;
  }

  const boxes = new Array(n);
  for (let i = 0; i < n; i += 1) boxes[i] = bboxOfPoints(glyphPoints(i, new Set()));

  // glyf + loca
  const glyf = new Writer();
  const loca = new Uint32Array(n + 1);
  for (let i = 0; i < n; i += 1) {
    loca[i] = glyf.len;
    let data;
    if (simpleContours[i]) data = encodeSimpleGlyph(simpleContours[i], boxes[i]);
    else if (components[i] && components[i].length) data = encodeCompositeGlyph(components[i], boxes[i]);
    else data = new Uint8Array(0);
    glyf.raw(padBytes(data));
  }
  loca[n] = glyf.len;

  const locaBytes = (() => {
    const w = new Writer((n + 1) * 4);
    for (const value of loca) w.u32(value);
    return w.toUint8Array();
  })();

  // hmtx + metrics
  const hmtx = new Writer(n * 4);
  let advanceMax = 0;
  let minLsb = 0;
  let minRsb = 0;
  let xMaxExtent = 0;
  for (let i = 0; i < n; i += 1) {
    const glyph = glyphs[i];
    const advance = clampU16(glyph.width);
    const lsb = clampI16(glyph.lsb);
    hmtx.u16(advance);
    hmtx.i16(lsb);
    advanceMax = Math.max(advanceMax, advance);
    minLsb = Math.min(minLsb, lsb);
    const ink = boxes[i].xMax - boxes[i].xMin;
    minRsb = Math.min(minRsb, advance - lsb - ink);
    xMaxExtent = Math.max(xMaxExtent, lsb + ink);
  }
  const hmtxBytes = hmtx.toUint8Array();

  // cmap
  const glyphByCode = new Map();
  for (let i = 0; i < n; i += 1) {
    const code = glyphs[i].unicode;
    if (typeof code === "number" && code >= 0 && !glyphByCode.has(code)) glyphByCode.set(code, i);
  }

  // maxp + OS/2 summaries
  let maxPoints = 0;
  let maxContours = 0;
  let maxCompositePoints = 0;
  let maxCompositeContours = 0;
  let maxComponentElements = 0;
  for (let i = 0; i < n; i += 1) {
    if (simpleContours[i]) {
      let points = 0;
      for (const contour of simpleContours[i]) points += contour.length;
      maxPoints = Math.max(maxPoints, points);
      maxContours = Math.max(maxContours, simpleContours[i].length);
    } else if (components[i]) {
      maxComponentElements = Math.max(maxComponentElements, components[i].length);
      maxCompositePoints = Math.max(maxCompositePoints, glyphPoints(i, new Set()).length);
      let contours = 0;
      for (const comp of components[i]) contours += simpleContours[comp.glyphIndex] ? simpleContours[comp.glyphIndex].length : 0;
      maxCompositeContours = Math.max(maxCompositeContours, contours);
    }
  }

  const bmpCodes = [...glyphByCode.keys()].filter((c) => c <= 0xffff);
  const sum = {
    avgAdvance: glyphByCode.size ? Math.round(glyphs.reduce((a, g) => a + clampU16(g.width), 0) / n) : 0,
    firstChar: bmpCodes.length ? Math.min(...bmpCodes) : 0,
    lastChar: bmpCodes.length ? Math.max(...bmpCodes) : 0,
  };

  const created = (Math.floor(Date.now() / 1000) + 2082844800) >>> 0;
  const fontBox = (() => {
    const all = [];
    for (let i = 0; i < n; i += 1) for (const p of glyphPoints(i, new Set())) all.push(p);
    return bboxOfPoints(all);
  })();

  const docInfo = { em: upem, ascent: clampI16(doc.ascent), descent: clampI16(doc.descent), family_name: doc.family_name, style_name: doc.style_name, font_name: doc.font_name, comment: doc.comment };

  const tables = [
    { tag: "OS/2", data: os2Table(docInfo, sum) },
    { tag: "cmap", data: cmapTable(glyphByCode) },
    { tag: "glyf", data: glyf.toUint8Array() },
    { tag: "head", data: headTable(upem, fontBox, created) },
    { tag: "hhea", data: hheaTable(docInfo, { advanceMax, minLsb, minRsb, xMaxExtent, numberOfHMetrics: n }) },
    { tag: "hmtx", data: hmtxBytes },
    { tag: "loca", data: locaBytes },
    { tag: "maxp", data: maxpTable({ numGlyphs: n, maxPoints, maxContours, maxCompositePoints, maxCompositeContours, maxComponentElements, maxComponentDepth: components.some((c) => c && c.length) ? 1 : 0 }) },
    { tag: "name", data: nameTable(docInfo) },
    { tag: "post", data: postTable(upem) },
  ];

  return assembleSfnt(tables);
}
