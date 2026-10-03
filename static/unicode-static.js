/**
 * Unicode name lookup for the static build.
 *
 * A JavaScript port of the query logic in `unicode_data.py`, reading the same
 * index that module reads (built by `tools/build_unicode_index.py`). Keeping the
 * ranking identical matters: the picker's behaviour should not change depending
 * on which build you are using, and the shared test data is the same.
 *
 * The index is fetched lazily on first use, because it is several megabytes and
 * most sessions never open the picker.
 */

const DEFAULT_LIMIT = 256;
const MAX_LIMIT = 4096;
const BUCKET_CAP = 512;

const state = {
  index: null,
  folded: null,
  loading: null,
  error: null,
};

export function indexUrl() {
  return new URL("./unicode-index.json", import.meta.url).href;
}

/** Lower bound: first index whose value is >= `value`. */
function lowerBound(array, value) {
  let lo = 0;
  let hi = array.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (array[mid] < value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Upper bound: first index whose value is > `value`. */
function upperBound(array, value) {
  let lo = 0;
  let hi = array.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (array[mid] <= value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Fetch and prepare the index, once.
 *
 * @returns {Promise<object|null>} the index, or null if it could not be loaded.
 */
export function loadIndex(url = indexUrl()) {
  if (state.index) return Promise.resolve(state.index);
  if (state.loading) return state.loading;

  state.loading = (async () => {
    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      if (data.schema !== 1) throw new Error(`unsupported index schema ${data.schema}`);
      // Python's casefold has no exact JS equivalent; lower-casing both sides is
      // enough for the ASCII-heavy Unicode name set.
      state.folded = data.names.map((name) => name.toLowerCase());
      state.index = data;
      return data;
    } catch (error) {
      state.error = error;
      return null;
    } finally {
      state.loading = null;
    }
  })();

  return state.loading;
}

export function available() {
  // Optimistic before the first load: the asset is part of the build.
  return state.error === null;
}

export function meta() {
  if (!state.index) return { available: available(), count: 0, nameslist: "", block_count: 0 };
  return {
    available: true,
    count: state.index.count || 0,
    nameslist: state.index.nameslist || "",
    block_count: (state.index.blocks || []).length,
  };
}

export function blocks() {
  const data = state.index;
  if (!data) return [];
  const codes = data.codes;
  return data.blocks.map((block, i) => {
    const [name, start, end] = block;
    const lo = lowerBound(codes, start);
    const hi = upperBound(codes, end);
    return { index: i, name, start, end, count: hi - lo };
  });
}

function entry(index) {
  const data = state.index;
  const code = data.codes[index];
  const note = data.annotations ? data.annotations[String(index)] : undefined;
  return {
    code,
    name: data.names[index],
    glyph_name: data.glyphNames[index],
    annotation: note || "",
  };
}

export function chars(blockIndex, offset = 0, limit = DEFAULT_LIMIT) {
  const data = state.index;
  if (!data) return null;
  const table = data.blocks;
  if (!(blockIndex >= 0 && blockIndex < table.length)) return null;

  const [name, start, end] = table[blockIndex];
  const codes = data.codes;
  const lo = lowerBound(codes, start);
  const hi = upperBound(codes, end);
  const total = hi - lo;

  const from = Math.max(0, offset);
  const size = Math.max(1, Math.min(limit, MAX_LIMIT));
  const out = [];
  for (let i = lo + from; i < Math.min(hi, lo + from + size); i += 1) out.push(entry(i));

  return {
    block: { index: blockIndex, name, start, end },
    total,
    offset: from,
    chars: out,
    truncated: from + size < total,
  };
}

export function lookup(code) {
  const data = state.index;
  if (!data || !Number.isInteger(code)) return null;
  const codes = data.codes;
  const at = lowerBound(codes, code);
  if (at >= codes.length || codes[at] !== code) return null;
  return entry(at);
}

/** Interpret `U+0041` / `0x41` / `41` / `65` the same way the Python side does. */
export function parseCodePoint(text) {
  if (typeof text !== "string") return null;
  const raw = text.trim();
  if (!raw) return null;

  const lowered = raw.toLowerCase();
  let value;
  if (lowered.startsWith("u+")) value = parseInt(raw.slice(2), 16);
  else if (lowered.startsWith("0x")) value = parseInt(raw.slice(2), 16);
  else if (/[a-f]/.test(lowered) && /^[0-9a-f]+$/.test(lowered)) value = parseInt(raw, 16);
  else if (/^[0-9]+$/.test(raw)) value = parseInt(raw, 10);
  else return null;

  if (!Number.isFinite(value) || value < 0 || value > 0x10ffff) return null;
  return value;
}

function allTokensPresent(needle, name) {
  if (!needle.includes(" ")) return false;
  return needle.split(" ").every((token) => name.includes(token));
}

/**
 * Match strength for one entry: lower is better, null means no match.
 * Mirrors `_rank` in unicode_data.py.
 */
function rank(needle, index) {
  const name = state.folded[index];
  if (name === needle) return 0;
  if (name.startsWith(needle)) return 1;
  if (name.includes(` ${needle}`)) return 2;
  if (name.includes(needle)) return 3;
  if (allTokensPresent(needle, name)) return 4;
  const note = state.index.annotations ? state.index.annotations[String(index)] : undefined;
  if (note && note.toLowerCase().includes(needle)) return 5;
  return null;
}

export function search(query, limit = DEFAULT_LIMIT) {
  const data = state.index;
  if (!data) return { results: [], total: 0, truncated: false, available: false };

  const text = String(query || "").trim();
  const size = Math.max(1, Math.min(limit, MAX_LIMIT));
  if (!text) return { results: [], total: 0, truncated: false };

  const needle = text.toLowerCase();
  const codes = data.codes;

  // Pinned: an explicit code point, or a single typed character, comes first.
  const pinned = [];
  const pin = (code) => {
    const at = lowerBound(codes, code);
    if (at < codes.length && codes[at] === code && !pinned.includes(at)) pinned.push(at);
  };
  const exact = parseCodePoint(text);
  if (exact !== null) pin(exact);
  if ([...text].length === 1) pin(text.codePointAt(0));

  // Buckets keep only their first N matches, which is safe because ties break by
  // code point; every match is still counted so `total` stays exact.
  const buckets = [[], [], [], [], [], []];
  const counts = [0, 0, 0, 0, 0, 0];
  for (let i = 0; i < codes.length; i += 1) {
    const r = rank(needle, i);
    if (r === null) continue;
    counts[r] += 1;
    if (buckets[r].length < BUCKET_CAP) buckets[r].push(i);
  }

  const page = pinned.slice(0, size);
  const seen = new Set(page);
  for (const bucket of buckets) {
    for (const index of bucket) {
      if (page.length >= size) break;
      if (!seen.has(index)) {
        seen.add(index);
        page.push(index);
      }
    }
  }

  let total = counts.reduce((sum, n) => sum + n, 0);
  total += pinned.filter((index) => rank(needle, index) === null).length;

  return {
    results: page.map(entry),
    total,
    truncated: total > page.length,
    query: text,
  };
}
