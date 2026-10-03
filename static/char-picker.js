/**
 * Character picker: browse Unicode by block, or search by name.
 *
 * Grouping by Unicode block rather than script matches how people actually
 * think about where a character lives ("it's in Arrows, near the math signs"),
 * and the search box accepts whatever the user has: a name fragment
 * ("snowman"), an official name, or a code point in any notation ("U+2603",
 * "0x2603", "9731").
 *
 * The name data comes from the server (see `unicode_data.py`), which reads an
 * index built from FontForge's embedded NamesList at image build time.
 */

import * as api from "./api.js";
import { formatCodePoint } from "./font-doc.js";
import { drawGlyphThumbnail } from "./glyph-outline.js";

const PAGE_SIZE = 256;
const SEARCH_LIMIT = 256;
const SEARCH_DEBOUNCE_MS = 180;

/**
 * Sentinel "block index" for the loaded font's own characters. Real blocks are
 * 0-based indexes, so a negative value cannot collide with one.
 */
const IN_FONT_BLOCK = -2;

/** Kept in step with .picker-thumb in editor.css. Passed explicitly so drawing
 *  never has to measure the canvas, which would force layout per thumbnail. */
const THUMB_SIZE = { width: 34, height: 30 };

/**
 * Blocks reached for most often, floated to the top of the list so ordinary
 * work does not begin by scrolling past obscure scripts. The rest follow in
 * code order.
 */
const PREFERRED_BLOCKS = [
  "Basic Latin",
  "Latin-1 Supplement",
  "Latin Extended-A",
  "General Punctuation",
  "Currency Symbols",
  "Letterlike Symbols",
  "Number Forms",
  "Arrows",
  "Mathematical Operators",
  "Miscellaneous Symbols",
  "Dingbats",
  "Geometric Shapes",
  "Cyrillic",
  "Greek and Coptic",
];

/** Which blocks are currently on screen (search narrows the list). */
function blockMatches(block, needle) {
  return block.name.toLowerCase().includes(needle);
}

export function createCharPicker({ doc, onPick }) {
  const backdrop = document.getElementById("pickerBackdrop");
  const blocksEl = document.getElementById("pickerBlocks");
  const gridEl = document.getElementById("pickerGrid");
  const statusEl = document.getElementById("pickerStatus");
  const searchEl = document.getElementById("pickerSearch");
  const detailEl = document.getElementById("pickerDetail");
  const useBtn = document.getElementById("pickerUse");
  const moreBtn = document.getElementById("pickerMore");
  const closeBtn = document.getElementById("pickerClose");

  if (!backdrop) return null;

  let blocks = [];
  let blocksLoaded = false;
  let activeBlock = -1;
  let targetField = "glyphUnicode";
  let entries = [];
  let total = 0;
  let truncated = false;
  let selected = null;
  let query = "";
  let debounceTimer = 0;
  let searchToken = 0;
  let lastFocus = null;
  /** code point -> glyph name, so the grid can flag what is already encoded. */
  let inFont = new Map();

  // ---------------------------------------------------------------- helpers
  function setStatus(text) {
    statusEl.textContent = text;
  }

  function refreshInFont() {
    inFont = new Map();
    for (const glyph of doc.doc.glyphs || []) {
      if (glyph.unicode >= 0) inFont.set(glyph.unicode, glyph.name);
    }
  }

  function detailText(entry) {
    detailEl.textContent = "";
    if (!entry) {
      // Three distinct states: nothing found, results but nothing picked yet,
      // and nothing asked for. Only the first is a failure.
      if (entries.length) {
        detailEl.textContent = "Click a character to see its details.";
      } else if (query) {
        // The grid already says what failed; this says what to try instead.
        detailEl.textContent = "Try “snowman”, “arrow”, “greek”, or a code point like U+2603.";
      } else {
        detailEl.textContent = "Pick a block, or search by name.";
      }
      return;
    }
    const info = formatCodePoint(entry.code);
    const char = document.createElement("span");
    char.className = "pd-char";
    char.textContent = info.char || "�";
    detailEl.appendChild(char);

    const name = document.createElement("b");
    name.textContent = entry.name;
    detailEl.appendChild(name);

    const meta = document.createElement("span");
    meta.textContent = ` · ${info.hex} · decimal ${info.dec} · ${entry.glyph_name || "unnamed"}`;
    detailEl.appendChild(meta);
  }

  function select(entry) {
    selected = entry;
    for (const cell of gridEl.querySelectorAll(".picker-cell")) {
      cell.classList.toggle("selected", Number(cell.dataset.code) === (entry && entry.code));
    }
    useBtn.disabled = !entry;
    detailText(entry);
  }

  // --------------------------------------------------------------- thumbs
  /**
   * Thumbnails preview the font's own outlines rather than the character, which
   * would otherwise render in whatever font the OS happens to supply.
   *
   * Drawn synchronously, once the cells are in the document so each canvas knows
   * its laid-out size. An IntersectionObserver was the first attempt, to avoid
   * work on a long preview, but it never fired with the grid as its root: cells
   * stayed blank and there was no error to show for it. Drawing here is bounded
   * by PAGE_SIZE per page, so the laziness was not worth that failure mode.
   */
  function drawThumb(canvas, color) {
    const code = Number(canvas.dataset.code);
    const name = inFont.get(code);
    const contours = name ? doc.outlinesOf(name) : [];
    if (contours.length && drawGlyphThumbnail(canvas, contours, { color, ...THUMB_SIZE })) return;
    // Nothing drawable - an empty slot, or a glyph with no outlines of its own.
    // Fall back to the character so the cell reads as something, not a blank box.
    const span = document.createElement("span");
    span.textContent = formatCodePoint(code).char || "—";
    canvas.replaceWith(span);
  }

  function drawThumbnails() {
    const pending = gridEl.querySelectorAll(".picker-thumb:not([data-drawn])");
    if (!pending.length) return;
    // Resolved once, not once per cell: getComputedStyle forces a style
    // recalculation, and calling it inside the loop dominated the entire render
    // (~6ms per thumbnail, ~1.5s for a full page).
    const color = getComputedStyle(pending[0]).color;
    // Marked so "Load more" only draws what it just added, not the whole grid.
    for (const canvas of pending) {
      canvas.dataset.drawn = "1";
      drawThumb(canvas, color);
    }
  }

  // ------------------------------------------------------------------ grid
  function cellFor(entry) {
    const info = formatCodePoint(entry.code);
    const cell = document.createElement("button");
    cell.type = "button";
    cell.className = "picker-cell";
    cell.dataset.code = String(entry.code);
    cell.title = inFont.has(entry.code)
      ? `${entry.name}\nAlready in this font as "${inFont.get(entry.code)}"`
      : entry.name;
    if (inFont.has(entry.code)) cell.classList.add("in-font");
    if (selected && selected.code === entry.code) cell.classList.add("selected");

    const label = document.createElement("small");
    label.textContent = info.hex;

    if (activeBlock === IN_FONT_BLOCK && inFont.has(entry.code)) {
      // Preview the font's own outline. Rendering the character instead would
      // show whatever font the OS happens to supply, which is exactly the
      // complaint for custom designs.
      const thumb = document.createElement("canvas");
      thumb.className = "picker-thumb";
      thumb.dataset.code = String(entry.code);
      cell.append(thumb, label);
    } else {
      const glyph = document.createElement("span");
      glyph.textContent = info.char || "—";
      cell.append(glyph, label);
    }

    cell.addEventListener("click", () => select(entry));
    cell.addEventListener("dblclick", () => {
      select(entry);
      use();
    });
    return cell;
  }

  function renderGrid({ append = false } = {}) {
    if (!append) gridEl.textContent = "";
    for (const entry of entries) gridEl.appendChild(cellFor(entry));
    // After the cells are in the document: a canvas that is not laid out yet
    // reports no size, and the backing store would be sized wrong.
    drawThumbnails();
    moreBtn.hidden = !truncated;
  }

  function showEmpty(message) {
    entries = [];
    total = 0;
    truncated = false;
    gridEl.textContent = "";
    const empty = document.createElement("p");
    empty.className = "picker-empty";
    empty.textContent = message;
    gridEl.appendChild(empty);
    moreBtn.hidden = true;
  }

  // ---------------------------------------------------------------- blocks
  function renderBlocks() {
    const needle = query.toLowerCase();
    blocksEl.textContent = "";

    // Pinned above the blocks and never filtered by the block search: it answers
    // "what is in this font", which is a different question from "what is in
    // Unicode".
    const pinned = document.createElement("button");
    pinned.type = "button";
    pinned.className = "picker-block pinned";
    if (activeBlock === IN_FONT_BLOCK) pinned.classList.add("active");
    const pinnedName = document.createElement("span");
    pinnedName.textContent = "In this font";
    const pinnedCount = document.createElement("small");
    pinnedCount.textContent = `${inFont.size} encoded`;
    pinned.append(pinnedName, pinnedCount);
    pinned.addEventListener("click", () => {
      activeBlock = IN_FONT_BLOCK;
      query = "";
      searchEl.value = "";
      renderBlocks();
      loadBlock(IN_FONT_BLOCK);
    });
    blocksEl.appendChild(pinned);

    const visible = blocks.filter((block) => !needle || blockMatches(block, needle));
    const ordered = [
      ...visible.filter((block) => PREFERRED_BLOCKS.includes(block.name)),
      ...visible.filter((block) => !PREFERRED_BLOCKS.includes(block.name)),
    ];
    // Keep the preferred ordering as declared, not as returned by the server.
    ordered.sort((a, b) => {
      const ai = PREFERRED_BLOCKS.indexOf(a.name);
      const bi = PREFERRED_BLOCKS.indexOf(b.name);
      if (ai >= 0 && bi >= 0) return ai - bi;
      if (ai >= 0) return -1;
      if (bi >= 0) return 1;
      return a.index - b.index;
    });

    for (const block of ordered) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "picker-block";
      if (block.index === activeBlock) button.classList.add("active");

      const name = document.createElement("span");
      name.textContent = block.name;
      const range = document.createElement("small");
      range.textContent = `${block.count} · U+${block.start.toString(16).toUpperCase().padStart(4, "0")}`;
      button.append(name, range);

      button.addEventListener("click", () => {
        activeBlock = block.index;
        query = "";
        searchEl.value = "";
        renderBlocks();
        loadBlock(block.index);
      });
      blocksEl.appendChild(button);
    }

    if (!ordered.length) {
      // Not an error: the block filter is just narrower than the character
      // search, which is showing its own results on the right.
      const note = document.createElement("p");
      note.className = "picker-block";
      note.textContent = query ? "No block by that name." : "No blocks available.";
      blocksEl.appendChild(note);
    }
  }

  /** Drop the "already in this font" dimming when the whole grid is that font. */
  function setGridMode(inFontView) {
    gridEl.classList.toggle("in-font-view", Boolean(inFontView));
  }

  /** The loaded font's encoded characters, in code point order. */
  function inFontEntries() {
    return [...inFont.entries()]
      .map(([code, name]) => ({ code, name, glyph_name: name }))
      .sort((a, b) => a.code - b.code);
  }

  /**
   * Preview the font's own repertoire: every glyph that claims a code point.
   *
   * Served from the document rather than the Unicode index, so it reflects the
   * open font exactly - including code points Unicode has no name for - and
   * needs no request.
   */
  function loadInFont({ append = false } = {}) {
    const all = inFontEntries();
    if (!all.length) {
      showEmpty("This font has no encoded characters yet.");
      setStatus("");
      return;
    }
    const from = append ? entries.length : 0;
    entries = append ? entries.concat(all.slice(from, from + PAGE_SIZE)) : all.slice(0, PAGE_SIZE);
    total = all.length;
    truncated = entries.length < all.length;
    renderGrid({ append });
    setStatus(
      `In this font - ${total} encoded character${total === 1 ? "" : "s"}` +
        (truncated ? ` - showing the first ${entries.length}` : "")
    );
    if (!append) select(null);
  }

  async function loadBlock(index, { append = false } = {}) {
    // "In this font" is served from the loaded document, not the Unicode index,
    // so it needs no request and cannot page out from under the user.
    setGridMode(index === IN_FONT_BLOCK);
    if (index === IN_FONT_BLOCK) {
      loadInFont({ append });
      return;
    }
    setStatus("Loading…");
    try {
      const data = await api.getUnicodeChars(index, append ? entries.length : 0, PAGE_SIZE);
      entries = append ? entries.concat(data.chars) : data.chars;
      total = data.total;
      truncated = Boolean(data.truncated);
      renderGrid({ append });
      const block = data.block;
      setStatus(
        `${block.name} — ${total} characters · U+${block.start.toString(16).toUpperCase()}–U+${block.end
          .toString(16)
          .toUpperCase()}${truncated ? ` (showing ${entries.length})` : ""}`
      );
      if (!append) select(null);
    } catch (error) {
      showEmpty(`Could not load that block: ${error.message}`);
      setStatus("");
    }
  }

  // ---------------------------------------------------------------- search
  async function runSearch(text) {
    const token = ++searchToken;
    if (!text) {
      renderBlocks();
      // IN_FONT_BLOCK is negative, so it needs the explicit test: without it,
      // clearing the search while previewing the font would blank the grid.
      if (activeBlock === IN_FONT_BLOCK || activeBlock >= 0) await loadBlock(activeBlock);
      else showEmpty("Pick a block on the left, or search by name.");
      return;
    }

    setStatus("Searching…");
    setGridMode(false);
    try {
      const data = await api.searchUnicode(text, SEARCH_LIMIT);
      if (token !== searchToken) return; // a newer keystroke won
      entries = data.results || [];
      total = data.total || 0;
      truncated = Boolean(data.truncated);
      if (!entries.length) {
        showEmpty(`Nothing matches “${text}”.`);
        setStatus("0 characters");
      } else {
        renderGrid();
        setStatus(
          `${total} match${total === 1 ? "" : "es"} for “${text}”` +
            (truncated ? ` — showing the first ${entries.length}` : "")
        );
      }
      select(null);
    } catch (error) {
      if (token !== searchToken) return;
      showEmpty(`Search failed: ${error.message}`);
      setStatus("");
    }
  }

  // ------------------------------------------------------------------ open
  function defaultBlockFor(code) {
    if (code < 0) return blocks.findIndex((block) => block.name === "Basic Latin");
    const found = blocks.find((block) => code >= block.start && code <= block.end);
    if (found) return found.index;
    return blocks.findIndex((block) => block.name === "Basic Latin");
  }

  async function open(fieldId, seedCode = -1) {
    targetField = fieldId || "glyphUnicode";
    lastFocus = document.activeElement;
    refreshInFont();
    selected = null;
    entries = [];
    total = 0;
    truncated = false;
    useBtn.disabled = true;
    query = "";
    searchEl.value = "";
    detailText(null);
    backdrop.hidden = false;
    document.body.classList.add("picker-open");
    searchEl.focus();

    if (!blocksLoaded) {
      setStatus("Loading Unicode data…");
      try {
        const data = await api.getUnicodeBlocks();
        blocks = data.blocks || [];
        blocksLoaded = true;
      } catch (error) {
        showEmpty(`Unicode data unavailable: ${error.message}`);
        setStatus("");
        return;
      }
    }

    activeBlock = defaultBlockFor(seedCode);
    renderBlocks();
    if (activeBlock >= 0) await loadBlock(activeBlock);
  }

  function close() {
    backdrop.hidden = true;
    document.body.classList.remove("picker-open");
    clearTimeout(debounceTimer);
    if (lastFocus && typeof lastFocus.focus === "function") lastFocus.focus();
  }

  function use() {
    if (!selected) return;
    onPick(selected, targetField);
    close();
  }

  // -------------------------------------------------------------- keyboard
  function moveSelection(step) {
    if (!entries.length) return;
    const current = selected ? entries.findIndex((e) => e.code === selected.code) : -1;
    const next = Math.min(entries.length - 1, Math.max(0, current + step));
    select(entries[next]);
    const cell = gridEl.querySelector(`.picker-cell[data-code="${entries[next].code}"]`);
    if (cell) cell.scrollIntoView({ block: "nearest" });
  }

  function columnsPerRow() {
    const width = gridEl.clientWidth || 0;
    return Math.max(1, Math.floor(width / 46));
  }

  backdrop.addEventListener("click", (event) => {
    if (event.target === backdrop) close();
  });
  closeBtn.addEventListener("click", close);
  useBtn.addEventListener("click", use);
  moreBtn.addEventListener("click", () => loadBlock(activeBlock, { append: true }));

  searchEl.addEventListener("input", (event) => {
    query = event.target.value.trim();
    renderBlocks();
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => runSearch(query), SEARCH_DEBOUNCE_MS);
  });

  searchEl.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      if (selected) use();
      else moveSelection(1);
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      moveSelection(1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      moveSelection(-1);
    } else if (event.key === "Escape") {
      event.preventDefault();
      close();
    }
  });

  gridEl.addEventListener("keydown", (event) => {
    const columns = columnsPerRow();
    if (event.key === "ArrowRight") moveSelection(1);
    else if (event.key === "ArrowLeft") moveSelection(-1);
    else if (event.key === "ArrowDown") moveSelection(columns);
    else if (event.key === "ArrowUp") moveSelection(-columns);
    else if (event.key === "Enter" || event.key === " ") use();
    else if (event.key === "Escape") close();
    else return;
    event.preventDefault();
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !backdrop.hidden) close();
  });

  return {
    open,
    close,
    get isOpen() {
      return !backdrop.hidden;
    },
  };
}
