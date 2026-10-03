/**
 * Minimal sfnt reader: TrueType/OpenType buffer -> this app's document format,
 * entirely in the browser.
 *
 * Why hand-written rather than a library: the static build runs under a strict
 * `default-src 'self'` policy with no bundler, so fetching a parser from a CDN
 * is not an option, and vendoring one drags in a licence obligation. Only the
 * tables the editor actually reads are parsed.
 *
 * Supported: TrueType outlines (`glyf` + `loca`) in a `.ttf`, or in an `.otf`
 * that happens to use them. Composite glyphs become **references**, matching
 * what the server's FontForge path produces, so the rest of the editor behaves
 * identically.
 *
 * Not supported, each with an explicit error rather than a half-read document:
 * CFF/PostScript outlines, WOFF/WOFF2 containers, and font collections beyond
 * the first face.
 *
 * The module is pure: it takes an ArrayBuffer and returns data, so it can be
 * tested under Node without a DOM.
 */

/** Point layout matches font-doc.js: [x, y, on_curve, type, interpolated, name]. */
const POINT_CORNER = 0;
const POINT_CURVE = 1;

// Composite glyph component flags.
const ARG_1_AND_2_ARE_WORDS = 0x0001;
const ARGS_ARE_XY_VALUES = 0x0002;
const WE_HAVE_A_SCALE = 0x0008;
const MORE_COMPONENTS = 0x0020;
const WE_HAVE_AN_X_AND_Y_SCALE = 0x0040;
const WE_HAVE_A_TWO_BY_TWO = 0x0080;

/**
 * The standard Macintosh glyph ordering, used by `post` format 2.0 for the
 * first 258 names. Most Latin text glyphs land here, and without it every
 * basic letter would show up as `uni0041` instead of `A`.
 */
const MAC_GLYPH_NAMES = (
  ".notdef .null nonmarkingreturn space exclam quotedbl numbersign dollar percent ampersand " +
  "quotesingle parenleft parenright asterisk plus comma hyphen period slash zero one two three " +
  "four five six seven eight nine colon semicolon less equal greater question at A B C D E F G " +
  "H I J K L M N O P Q R S T U V W X Y Z bracketleft backslash bracketright asciicircum " +
  "underscore grave a b c d e f g h i j k l m n o p q r s t u v w x y z braceleft bar " +
  "braceright asciitilde Adieresis Aring Ccedilla Eacute Ntilde Odieresis Udieresis aacute " +
  "agrave acircumflex adieresis atilde aring ccedilla eacute egrave ecircumflex edieresis " +
  "iacute igrave icircumflex idieresis ntilde oacute ograve ocircumflex odieresis otilde uacute " +
  "ugrave ucircumflex udieresis dagger degree cent sterling section bullet paragraph germandbls " +
  "registered copyright trademark acute dieresis notequal AE Oslash infinity plusminus lessequal " +
  "greaterequal yen mu partialdiff summation product pi integral ordfeminine ordmasculine Omega " +
  "ae oslash questiondown exclamdown logicalnot radical florin approxequal Delta guillemotleft " +
  "guillemotright ellipsis nonbreakingspace Agrave Atilde Otilde OE oe endash emdash " +
  "quotedblleft quotedblright quoteleft quoteright divide lozenge ydieresis Ydieresis fraction " +
  "currency guilsinglleft guilsinglright fi fl daggerdbl periodcentered quotesinglbase " +
  "quotedblbase perthousand Acircumflex Ecircumflex Aacute Edieresis Egrave Iacute Icircumflex " +
  "Idieresis Igrave Oacute Ocircumflex apple Ograve Uacute Ucircumflex Ugrave dotlessi " +
  "circumflex tilde macron breve dotaccent ring cedilla hungarumlaut ogonek caron Lslash lslash " +
  "Scaron scaron Zcaron zcaron brokenbar Eth eth Yacute yacute Thorn thorn minus multiply " +
  "onesuperior twosuperior threesuperior onehalf onequarter threequarters franc Gbreve gbreve " +
  "Idotaccent Scedilla scedilla Cacute cacute Ccaron ccaron dcroat"
).split(" ");

export const STATIC_PARSE_LIMIT = 60 * 1024 * 1024;

function tagAt(view, offset) {
  return (
    String.fromCharCode(view.getUint8(offset)) +
    String.fromCharCode(view.getUint8(offset + 1)) +
    String.fromCharCode(view.getUint8(offset + 2)) +
    String.fromCharCode(view.getUint8(offset + 3))
  );
}

function readTableDirectory(view) {
  let base = 0;
  let version = view.getUint32(0);

  if (version === 0x74746366) {
    // 'ttcf' - a collection. Read the first face rather than refusing outright.
    base = view.getUint32(12);
    version = view.getUint32(base);
  }
  if (version === 0x774f4646 || version === 0x774f4632) {
    throw new Error(
      "WOFF/WOFF2 files are not supported in the browser build (needs brotli/compression); convert to .ttf or .otf first"
    );
  }

  const numTables = view.getUint16(base + 4);
  const tables = {};
  for (let i = 0; i < numTables; i += 1) {
    const record = base + 12 + i * 16;
    if (record + 16 > view.byteLength) break;
    tables[tagAt(view, record)] = {
      offset: view.getUint32(record + 8),
      length: view.getUint32(record + 12),
    };
  }
  return tables;
}

function readNameTable(view, tables) {
  const table = tables.name;
  const out = {};
  if (!table) return out;

  const count = view.getUint16(table.offset + 2);
  const storage = table.offset + view.getUint16(table.offset + 4);

  for (let i = 0; i < count; i += 1) {
    const record = table.offset + 6 + i * 12;
    if (record + 12 > view.byteLength) break;
    const platform = view.getUint16(record);
    const encoding = view.getUint16(record + 2);
    const language = view.getUint16(record + 4);
    const nameId = view.getUint16(record + 6);
    const length = view.getUint16(record + 8);
    const offset = view.getUint16(record + 10);
    if (nameId > 6) continue;

    // Windows/Unicode English preferred; Mac Roman as a fallback.
    const windows = platform === 3 && (encoding === 1 || encoding === 10);
    const mac = platform === 1 && encoding === 0 && language === 0;
    if (!windows && !mac) continue;

    const at = storage + offset;
    if (at + length > view.byteLength) continue;

    let text = "";
    if (windows) {
      for (let j = 0; j + 1 < length; j += 2) text += String.fromCharCode(view.getUint16(at + j));
    } else {
      for (let j = 0; j < length; j += 1) text += String.fromCharCode(view.getUint8(at + j));
    }
    if (!out[nameId] || windows) out[nameId] = text;
  }
  return out;
}

function readCmap(view, tables) {
  const table = tables.cmap;
  if (!table) return new Map();

  const count = view.getUint16(table.offset + 2);
  let best = null;
  let bestScore = -1;

  for (let i = 0; i < count; i += 1) {
    const record = table.offset + 4 + i * 8;
    if (record + 8 > view.byteLength) break;
    const platform = view.getUint16(record);
    const encoding = view.getUint16(record + 2);
    const offset = table.offset + view.getUint32(record + 4);
    if (offset + 2 > view.byteLength) continue;
    const format = view.getUint16(offset);

    // Prefer full-Unicode subtables, then BMP, then anything usable.
    let score = -1;
    if (platform === 3 && encoding === 10 && format === 12) score = 5;
    else if (platform === 0 && format === 12) score = 4;
    else if (platform === 3 && encoding === 1 && format === 4) score = 3;
    else if (platform === 0 && format === 4) score = 2;
    else if (format === 12) score = 1;
    else if (format === 4) score = 1;

    if (score > bestScore) {
      bestScore = score;
      best = { format, offset };
    }
  }

  const map = new Map();
  if (!best) return map;
  if (best.format === 4) readCmap4(view, best.offset, map);
  else if (best.format === 12) readCmap12(view, best.offset, map);
  return map;
}

function readCmap4(view, offset, map) {
  const segCountX2 = view.getUint16(offset + 6);
  const endBase = offset + 14;
  const startBase = endBase + segCountX2 + 2; // +2 skips reservedPad
  const deltaBase = startBase + segCountX2;
  const rangeBase = deltaBase + segCountX2;

  for (let segment = 0; segment < segCountX2 / 2; segment += 1) {
    const end = view.getUint16(endBase + segment * 2);
    const start = view.getUint16(startBase + segment * 2);
    const delta = view.getInt16(deltaBase + segment * 2);
    const rangeOffset = view.getUint16(rangeBase + segment * 2);
    if (start > end) continue;

    for (let code = start; code <= end; code += 1) {
      if (code === 0xffff) continue;
      let glyph;
      if (rangeOffset === 0) {
        glyph = (code + delta) & 0xffff;
      } else {
        const at = rangeBase + segment * 2 + rangeOffset + (code - start) * 2;
        if (at + 2 > view.byteLength) continue;
        glyph = view.getUint16(at);
        if (glyph !== 0) glyph = (glyph + delta) & 0xffff;
      }
      if (glyph !== 0) map.set(code, glyph);
    }
  }
}

function readCmap12(view, offset, map) {
  const groups = view.getUint32(offset + 12);
  for (let group = 0; group < groups; group += 1) {
    const record = offset + 16 + group * 12;
    if (record + 12 > view.byteLength) break;
    const start = view.getUint32(record);
    const end = view.getUint32(record + 4);
    const startGlyph = view.getUint32(record + 8);
    for (let code = start; code <= end; code += 1) map.set(code, startGlyph + (code - start));
  }
}

function readPostNames(view, tables, numGlyphs) {
  const table = tables.post;
  if (!table || table.offset + 34 > view.byteLength) return null;
  if (view.getUint32(table.offset) !== 0x00020000) return null; // only format 2.0 carries names

  const count = view.getUint16(table.offset + 32);
  const indices = [];
  for (let i = 0; i < count; i += 1) {
    const at = table.offset + 34 + i * 2;
    if (at + 2 > view.byteLength) break;
    indices.push(view.getUint16(at));
  }
  if (indices.length < numGlyphs) return null; // malformed; fall back to derived names

  const strings = [];
  let cursor = table.offset + 34 + count * 2;
  const end = Math.min(table.offset + table.length, view.byteLength);
  while (cursor < end) {
    const length = view.getUint8(cursor);
    cursor += 1;
    let text = "";
    for (let i = 0; i < length; i += 1) text += String.fromCharCode(view.getUint8(cursor + i));
    cursor += length;
    strings.push(text);
  }
  return { indices, strings };
}

function readLoca(view, tables, format, numGlyphs) {
  const table = tables.loca;
  const offsets = new Uint32Array(numGlyphs + 1);
  if (!table) return offsets;
  for (let i = 0; i <= numGlyphs; i += 1) {
    if (format === 0) {
      const at = table.offset + i * 2;
      offsets[i] = at + 2 <= view.byteLength ? view.getUint16(at) * 2 : 0;
    } else {
      const at = table.offset + i * 4;
      offsets[i] = at + 4 <= view.byteLength ? view.getUint32(at) : 0;
    }
  }
  return offsets;
}

function readSimpleContours(view, start, count, endPts, cursor) {
  const pointCount = endPts.length ? endPts[endPts.length - 1] + 1 : 0;
  const flags = [];
  let p = cursor;
  while (flags.length < pointCount && p < view.byteLength) {
    const flag = view.getUint8(p);
    p += 1;
    flags.push(flag);
    if (flag & 0x08) {
      const repeat = view.getUint8(p);
      p += 1;
      for (let i = 0; i < repeat && flags.length < pointCount; i += 1) flags.push(flag);
    }
  }

  const xs = [];
  let x = 0;
  for (const flag of flags) {
    if (flag & 0x02) {
      const delta = view.getUint8(p);
      p += 1;
      x += flag & 0x10 ? delta : -delta;
    } else if (!(flag & 0x10)) {
      x += view.getInt16(p);
      p += 2;
    }
    xs.push(x);
  }

  const ys = [];
  let y = 0;
  for (const flag of flags) {
    if (flag & 0x04) {
      const delta = view.getUint8(p);
      p += 1;
      y += flag & 0x20 ? delta : -delta;
    } else if (!(flag & 0x20)) {
      y += view.getInt16(p);
      p += 2;
    }
    ys.push(y);
  }

  const contours = [];
  let first = 0;
  for (const last of endPts) {
    const points = [];
    for (let i = first; i <= last && i < flags.length; i += 1) {
      const onCurve = flags[i] & 0x01 ? 1 : 0;
      points.push([xs[i], ys[i], onCurve, onCurve ? POINT_CORNER : POINT_CURVE, 0, null]);
    }
    // TrueType outlines are quadratic, which the canvas renderer handles by
    // implying the on-curve midpoint between consecutive off-curve points.
    if (points.length) contours.push({ closed: true, quadratic: true, points });
    first = last + 1;
  }
  return contours;
}

function readComposite(view, end) {
  const components = [];
  let p = end;
  let more = true;
  while (more && p + 4 <= view.byteLength) {
    const flags = view.getUint16(p);
    p += 2;
    const glyphIndex = view.getUint16(p);
    p += 2;

    let dx = 0;
    let dy = 0;
    if (flags & ARG_1_AND_2_ARE_WORDS) {
      if (flags & ARGS_ARE_XY_VALUES) {
        dx = view.getInt16(p);
        dy = view.getInt16(p + 2);
      }
      p += 4;
    } else {
      if (flags & ARGS_ARE_XY_VALUES) {
        dx = view.getInt8(p);
        dy = view.getInt8(p + 1);
      }
      p += 2;
    }

    let a = 1;
    let b = 0;
    let c = 0;
    let d = 1;
    const f2dot14 = (at) => view.getInt16(at) / 16384;
    if (flags & WE_HAVE_A_SCALE) {
      a = f2dot14(p);
      d = a;
      p += 2;
    } else if (flags & WE_HAVE_AN_X_AND_Y_SCALE) {
      a = f2dot14(p);
      d = f2dot14(p + 2);
      p += 4;
    } else if (flags & WE_HAVE_A_TWO_BY_TWO) {
      a = f2dot14(p);
      b = f2dot14(p + 2);
      c = f2dot14(p + 4);
      d = f2dot14(p + 6);
      p += 8;
    }

    components.push({ glyphIndex, matrix: [a, b, c, d, dx, dy] });
    more = Boolean(flags & MORE_COMPONENTS);
  }
  return components;
}

/**
 * Parse a font buffer into a document.
 *
 * @param {ArrayBuffer} buffer
 * @param {{familyName?: string}} [options]
 * @returns {{document: object, stats: {glyphs: number, contours: number, points: number}}}
 */
export function parseFontBuffer(buffer, options = {}) {
  if (!(buffer instanceof ArrayBuffer)) throw new Error("expected an ArrayBuffer");
  if (buffer.byteLength > STATIC_PARSE_LIMIT) throw new Error("font is too large to open in the browser");

  const view = new DataView(buffer);
  if (view.byteLength < 12) throw new Error("not a font file (too small)");

  const tables = readTableDirectory(view);

  if (!tables.glyf || !tables.loca) {
    if (tables["CFF "] || tables.CFF2) {
      throw new Error(
        "this font uses CFF/PostScript outlines, which the browser build cannot read yet - use the server build for CFF fonts"
      );
    }
    throw new Error("no TrueType outlines found in this file");
  }
  if (!tables.head || !tables.maxp) throw new Error("not a font file (missing head/maxp)");

  const unitsPerEm = view.getUint16(tables.head.offset + 18) || 1000;
  const indexToLocFormat = view.getInt16(tables.head.offset + 50);
  const numGlyphs = view.getUint16(tables.maxp.offset + 4);

  const hhea = tables.hhea;
  const ascender = hhea ? view.getInt16(hhea.offset + 4) : Math.round(unitsPerEm * 0.8);
  const descender = hhea ? view.getInt16(hhea.offset + 6) : Math.round(unitsPerEm * -0.2);
  const numberOfHMetrics = hhea ? view.getUint16(hhea.offset + 34) : numGlyphs;

  const advance = new Uint16Array(numGlyphs);
  const sideBearing = new Int16Array(numGlyphs);
  if (tables.hmtx) {
    for (let i = 0; i < numGlyphs; i += 1) {
      if (i < numberOfHMetrics) {
        const at = tables.hmtx.offset + i * 4;
        advance[i] = view.getUint16(at);
        sideBearing[i] = view.getInt16(at + 2);
      } else {
        const at = tables.hmtx.offset + (numberOfHMetrics - 1) * 4 + 2 + (i - numberOfHMetrics + 1) * 2;
        advance[i] = numberOfHMetrics ? advance[numberOfHMetrics - 1] : 0;
        sideBearing[i] = at + 2 <= view.byteLength ? view.getInt16(at) : 0;
      }
    }
  }

  const cmap = readCmap(view, tables);
  const post = readPostNames(view, tables, numGlyphs);
  const names = readNameTable(view, tables);
  const loca = readLoca(view, tables, indexToLocFormat, numGlyphs);

  // glyph id -> the lowest code point that maps to it
  const codeOfGlyph = new Map();
  for (const [code, glyph] of cmap) {
    if (glyph >= numGlyphs) continue;
    const existing = codeOfGlyph.get(glyph);
    if (existing === undefined || code < existing) codeOfGlyph.set(glyph, code);
  }

  const used = new Set();
  const glyphNames = new Array(numGlyphs);
  for (let i = 0; i < numGlyphs; i += 1) {
    let name = "";
    const index = post ? post.indices[i] : undefined;
    if (index !== undefined && index < MAC_GLYPH_NAMES.length) name = MAC_GLYPH_NAMES[index];
    else if (post && index !== undefined) name = post.strings[index - MAC_GLYPH_NAMES.length] || "";
    if (!name) {
      const code = codeOfGlyph.get(i);
      name = code === undefined ? `glyph${i}` : `uni${code.toString(16).toUpperCase().padStart(4, "0")}`;
    }
    if (used.has(name)) {
      // Two glyphs sharing a name would break the name-keyed document model.
      let suffix = 1;
      let candidate = `${name}.${suffix}`;
      while (used.has(candidate)) {
        suffix += 1;
        candidate = `${name}.${suffix}`;
      }
      name = candidate;
    }
    used.add(name);
    glyphNames[i] = name;
  }

  const glyphs = [];
  let totalContours = 0;
  let totalPoints = 0;

  for (let i = 0; i < numGlyphs; i += 1) {
    const start = loca[i];
    const end = loca[i + 1];
    const record = {
      name: glyphNames[i],
      unicode: codeOfGlyph.has(i) ? codeOfGlyph.get(i) : -1,
      width: advance[i] || 0,
      lsb: sideBearing[i] || 0,
      vwidth: 0,
      quadratic: true,
      contours: [],
      references: [],
    };

    if (end > start && start + 10 <= view.byteLength) {
      const at = tables.glyf.offset + start;
      if (at + 10 <= view.byteLength) {
        const contourCount = view.getInt16(at);
        if (contourCount >= 0) {
          let cursor = at + 10;
          const endPts = [];
          for (let c = 0; c < contourCount; c += 1) {
            endPts.push(view.getUint16(cursor));
            cursor += 2;
          }
          const instructionLength = view.getUint16(cursor);
          cursor += 2 + instructionLength;
          record.contours = readSimpleContours(view, at, contourCount, endPts, cursor);
        } else {
          record.references = readComposite(view, at + 10).map((component) => [
            glyphNames[component.glyphIndex] || `glyph${component.glyphIndex}`,
            component.matrix,
            false,
          ]);
        }
      }
    }

    // A composite owns no points, so `quadratic` should describe its own
    // outlines; leave it true only when it actually has some.
    if (!record.contours.length) record.quadratic = true;

    totalContours += record.contours.length;
    for (const contour of record.contours) totalPoints += contour.points.length;
    glyphs.push(record);
  }

  const family = names[1] || options.familyName || "Untitled";
  const style = names[2] || "Regular";
  const document = {
    version: 1,
    em: unitsPerEm,
    ascent: Math.max(0, ascender),
    descent: Math.max(0, -descender),
    family_name: family,
    style_name: style,
    font_name: names[4] || `${family.replace(/ /g, "")}-${style.replace(/ /g, "")}`,
    comment: names[0] || "",
    glyphs,
  };

  return { document, stats: { glyphs: glyphs.length, contours: totalContours, points: totalPoints } };
}
