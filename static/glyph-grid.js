/**
 * Glyph list: searchable, selectable rows for every glyph in the document.
 */

import { codepointLabel, drawsSomething, hasOwnPoints, isComposite } from "./font-doc.js";

export function createGlyphGrid(container, doc, hooks = {}) {
  let filter = "";

  function normalizeFilter(value) {
    return String(value || "").trim().toLowerCase();
  }

  /**
   * Survey keywords. Real fonts are full of composite and empty slots, and the
   * only way to tell them apart in the list is the dot, so being able to list
   * them is the difference between "this font is broken" and "that one is
   * built from references".
   */
  const KEYWORDS = {
    "is:empty": (g) => !drawsSomething(g),
    "is:drawn": hasOwnPoints,
    "is:composite": isComposite,
    "is:encoded": (g) => Number.isInteger(g.unicode) && g.unicode >= 0,
    "is:unencoded": (g) => !(Number.isInteger(g.unicode) && g.unicode >= 0),
  };

  function matches(glyph) {
    if (!filter) return true;
    const keyword = KEYWORDS[filter];
    if (keyword) return keyword(glyph);
    if (glyph.name.toLowerCase().includes(filter)) return true;
    const bare = filter.replace(/^u\+/, "");
    if (/^[0-9a-f]{1,6}$/.test(bare) && typeof glyph.unicode === "number" && glyph.unicode >= 0) {
      const hex = glyph.unicode.toString(16);
      if (hex.includes(bare) || hex.padStart(4, "0").includes(bare)) return true;
    }
    return false;
  }

  function render() {
    const glyphs = (doc.doc.glyphs || []).filter(matches);
    container.textContent = "";

    if (glyphs.length === 0) {
      const empty = document.createElement("p");
      empty.className = "hint";
      const known = Object.keys(KEYWORDS).includes(filter);
      empty.textContent = (doc.doc.glyphs || []).length
        ? known
          ? `No glyphs are ${filter.replace("is:", "")}.`
          : "No glyphs match that filter. Try is:composite or is:empty."
        : "No glyphs yet — import a font or add one.";
      container.appendChild(empty);
      return;
    }

    const fragment = document.createDocumentFragment();
    for (const glyph of glyphs) {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "glyph-row" + (glyph.name === doc.glyphName ? " active" : "");

      const dot = document.createElement("span");
      const own = hasOwnPoints(glyph);
      const composite = isComposite(glyph);
      // Shape carries the meaning: solid = its own points, ring = borrowed or
      // absent. Colour alone was not readable.
      dot.className =
        "gempty" + (own ? " filled" : "") + (composite ? " composite" : "");
      dot.title = own
        ? "Has its own outlines"
        : composite
          ? `Composite - drawn from ${glyph.references.length} reference${glyph.references.length === 1 ? "" : "s"}`
          : "No outlines yet";

      const name = document.createElement("span");
      name.className = "gname";
      name.textContent = glyph.name;

      const code = document.createElement("span");
      code.className = "gcode";
      code.textContent = codepointLabel(glyph.unicode);

      row.append(dot, name, code);
      if (hooks.onSelect) {
        row.addEventListener("click", () => hooks.onSelect(glyph.name));
      }
      if (hooks.onDelete) {
        // Hover-revealed so the list stays readable; stopPropagation so it does
        // not also select the glyph.
        const remove = document.createElement("span");
        remove.className = "gremove";
        remove.textContent = "✕";
        remove.title = `Delete ${glyph.name}`;
        remove.addEventListener("click", (event) => {
          event.stopPropagation();
          hooks.onDelete(glyph.name);
        });
        row.appendChild(remove);
      }
      fragment.appendChild(row);
    }
    container.appendChild(fragment);
  }

  return {
    render,
    setFilter(value) {
      filter = normalizeFilter(value);
      render();
    },
  };
}
