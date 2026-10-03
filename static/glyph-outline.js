/**
 * Outline geometry and thumbnail drawing.
 *
 * `buildSegments` lives here rather than inside the canvas editor because two
 * callers now need the same reading of FontForge's point rules - the editor and
 * the character picker's thumbnails. Two copies would drift, and the quadratic
 * implied-midpoint case is subtle enough to get wrong quietly.
 *
 * This module never parses anything: it draws outlines that are already in the
 * document. See `drawGlyphThumbnail` for why that matters.
 */

/** On-curve test. FontForge writes the flag as 1/0; JSON may carry a boolean. */
export const hit = (p) => p[2] === 1 || p[2] === true;

function midpoint(a, b) {
  return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
}

/**
 * Expand a contour into drawing segments, resolving FontForge's point
 * conventions:
 *  - cubic contours: 0 or 2 off-curve points between on-curve points
 *  - quadratic contours: 2 consecutive off-curve points imply an on-curve
 *    point at their midpoint
 *
 * `startOrig` is the index (in the contour's own array) of the segment's
 * starting point, or null when the start is an implied midpoint.
 *
 * Returned points are the contour's own arrays, not copies.
 */
export function buildSegments(contour) {
  const points = contour.points || [];
  const n = points.length;
  if (n < 2) return [];

  let start = points.findIndex((p) => hit(p));
  if (start < 0) return [];

  const idx = [];
  const rot = [];
  for (let k = 0; k < n; k += 1) {
    const i = (start + k) % n;
    idx.push(i);
    rot.push(points[i]);
  }

  const segments = [];
  let prevOn = rot[0];
  let prevOrig = idx[0];
  let pending = [];

  const endSegment = (startPoint, startOrig, offs, endPoint, endOrig) => {
    if (offs.length === 0) {
      segments.push({ kind: "line", p0: startPoint, p1: endPoint, startOrig, endOrig });
    } else if (offs.length === 1) {
      if (contour.quadratic) {
        segments.push({
          kind: "quad",
          p0: startPoint,
          c: offs[0],
          p1: endPoint,
          startOrig,
          endOrig,
        });
      } else {
        segments.push({
          kind: "cubic",
          p0: startPoint,
          c1: offs[0],
          c2: offs[0],
          p1: endPoint,
          startOrig,
          endOrig,
        });
      }
    } else {
      segments.push({
        kind: "cubic",
        p0: startPoint,
        c1: offs[offs.length - 2],
        c2: offs[offs.length - 1],
        p1: endPoint,
        startOrig,
        endOrig,
      });
    }
  };

  for (let k = 1; k < rot.length; k += 1) {
    const p = rot[k];
    if (hit(p)) {
      if (contour.quadratic && pending.length > 1) {
        // Emit implied-midpoint segments for the earlier off-curves.
        let prev = prevOn;
        for (let j = 0; j < pending.length - 1; j += 1) {
          const m = midpoint(pending[j], pending[j + 1]);
          segments.push({
            kind: "quad",
            p0: prev,
            c: pending[j],
            p1: m,
            startOrig: j === 0 ? prevOrig : null,
            endOrig: null,
          });
          prev = m;
        }
        endSegment(prev, null, [pending[pending.length - 1]], p, idx[k]);
      } else {
        endSegment(prevOn, prevOrig, pending, p, idx[k]);
      }
      pending = [];
      prevOn = p;
      prevOrig = idx[k];
    } else {
      pending.push(p);
    }
  }

  if (contour.closed && rot.length > 1) {
    const first = rot[0];
    if (contour.quadratic && pending.length > 1) {
      let prev = prevOn;
      for (let j = 0; j < pending.length - 1; j += 1) {
        const m = midpoint(pending[j], pending[j + 1]);
        segments.push({
          kind: "quad",
          p0: prev,
          c: pending[j],
          p1: m,
          startOrig: j === 0 ? prevOrig : null,
          endOrig: null,
        });
        prev = m;
      }
      endSegment(prev, null, [pending[pending.length - 1]], first, idx[0]);
    } else {
      endSegment(prevOn, prevOrig, pending, first, idx[0]);
    }
  }

  return segments;
}

/** Bounding box across contours, or null when none of them hold a point. */
export function boundsOfContours(contours) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const contour of contours || []) {
    for (const point of contour.points || []) {
      if (point[0] < minX) minX = point[0];
      if (point[1] < minY) minY = point[1];
      if (point[0] > maxX) maxX = point[0];
      if (point[1] > maxY) maxY = point[1];
    }
  }
  return Number.isFinite(minX) ? { minX, minY, maxX, maxY } : null;
}

/**
 * Draw outlines into a canvas, scaled to fit with a little padding.
 *
 * Deliberately draws the document's own outline data rather than rendering the
 * character as text. Two reasons, and the second is the important one:
 *
 *  1. Text would come from whatever font the OS has, so a custom design would
 *     preview as somebody else's letterform - the complaint that prompted this.
 *  2. Showing a *real* preview by loading font bytes (FontFace from the upload)
 *     would hand untrusted font data to the browser's font engine and would need
 *     `blob:` added to `font-src` in the CSP, which is deliberately not there.
 *     Moving points onto a canvas needs neither: no parsing, no network, no new
 *     CSP allowance.
 *
 * @returns {boolean} false when there was nothing drawable
 */
export function drawGlyphThumbnail(canvas, contours, options = {}) {
  const box = boundsOfContours(contours);
  if (!box) return false;

  const padding = options.padding === undefined ? 3 : options.padding;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  // An explicit size wins over measuring. Reading clientWidth forces layout, and
  // reading it between the canvas-resize writes below thrashes layout once per
  // thumbnail - ~5ms each, which is the whole cost of a long preview.
  const width = options.width || canvas.clientWidth || 34;
  const height = options.height || canvas.clientHeight || 30;
  canvas.width = Math.max(1, Math.round(width * dpr));
  canvas.height = Math.max(1, Math.round(height * dpr));

  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);

  // Control points bound their curve, so including them is a safe over-estimate.
  const spanX = Math.max(box.maxX - box.minX, 1);
  const spanY = Math.max(box.maxY - box.minY, 1);
  const scale = Math.min((width - padding * 2) / spanX, (height - padding * 2) / spanY);
  if (!Number.isFinite(scale) || scale <= 0) return false;

  ctx.translate(width / 2, height / 2);
  // Font units are y-up and the canvas is y-down, so the y scale is negated.
  ctx.scale(scale, -scale);
  ctx.translate(-(box.minX + box.maxX) / 2, -(box.minY + box.maxY) / 2);

  // Every contour goes into ONE path, filled once. Filling contour by contour
  // would paint the counters solid - the hole in an "o" would disappear.
  ctx.beginPath();
  let drew = false;
  for (const contour of contours) {
    const segments = buildSegments(contour);
    if (!segments.length) continue;
    ctx.moveTo(segments[0].p0[0], segments[0].p0[1]);
    for (const segment of segments) {
      if (segment.kind === "line") {
        ctx.lineTo(segment.p1[0], segment.p1[1]);
      } else if (segment.kind === "quad") {
        ctx.quadraticCurveTo(segment.c[0], segment.c[1], segment.p1[0], segment.p1[1]);
      } else {
        ctx.bezierCurveTo(
          segment.c1[0],
          segment.c1[1],
          segment.c2[0],
          segment.c2[1],
          segment.p1[0],
          segment.p1[1]
        );
      }
    }
    if (contour.closed) ctx.closePath();
    drew = true;
  }
  if (!drew) return false;

  // `currentColor` is not usable as a fillStyle, so resolve it from the element,
  // which keeps the thumbnail on the same theme token as its neighbours.
  ctx.fillStyle = options.color || getComputedStyle(canvas).color || "#e7eaf0";
  ctx.fill();
  return true;
}
