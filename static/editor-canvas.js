/**
 * Glyph outline canvas editor.
 *
 * Renders one glyph's contours on a 2D canvas and handles pan / zoom / point
 * editing. Font units are y-up; the canvas is y-down, so the view transform
 * flips y.
 *
 * Usage:
 *   const editor = createCanvasEditor(canvas, fontDocument, hooks);
 *   editor.fit();
 *   editor.render();
 */

// Outline interpretation is shared with the picker's thumbnails, so it lives in
// one module rather than being reimplemented per renderer.
import { buildSegments, hit } from "./glyph-outline.js";

const HIT_RADIUS = 7; // screen px
const POINT_RADIUS = 4; // drawn radius, screen px
// How close to the outline a double-click must land to insert a point.
const SEGMENT_HIT_RADIUS = 8; // screen px
const MIN_SCALE = 0.02;
const MAX_SCALE = 60;

const COLORS = {
  gridMinor: "rgba(255,255,255,0.045)",
  gridMajor: "rgba(255,255,255,0.09)",
  baseline: "rgba(168,85,247,0.55)",
  metric: "rgba(154,164,181,0.35)",
  advance: "rgba(34,197,94,0.55)",
  outline: "#e7eaf0",
  outlineFill: "rgba(168,85,247,0.10)",
  ghost: "rgba(154,164,181,0.30)",
  pointOn: "#22c55e",
  pointOff: "#f59e0b",
  pointSel: "#a855f7",
  pointSelOff: "#f0abfc",
  // Deliberately a colour nothing else uses: green is on-curve, orange
  // off-curve, purple selected. The insert ghost must not read as any of those.
  insertPreview: "#38bdf8",
  handle: "rgba(245,158,11,0.45)",
  // The band is purple too: the points it sweeps up turn purple as they are
  // caught, so the band reads as the thing doing the highlighting.
  marqueeEdge: "rgba(168,85,247,0.85)",
  marqueeFill: "rgba(168,85,247,0.10)",
};

export function createCanvasEditor(canvas, doc, hooks = {}) {
  const ctx = canvas.getContext("2d");
  const view = { scale: 1, offsetX: 0, offsetY: 0 };
  const state = {
    tool: "select",
    drag: null,
    hoverPoint: null,
    hoverSegment: null,
    hoverGlyph: null,
    hoverAt: null,
    previewDrawn: false,
    cursorFont: null,
    spaceDown: false,
  };

  const toScreen = (fx, fy) => [fx * view.scale + view.offsetX, -fy * view.scale + view.offsetY];
  const toFont = (sx, sy) => [(sx - view.offsetX) / view.scale, -(sy - view.offsetY) / view.scale];

  function status(extra = {}) {
    if (hooks.onStatus) hooks.onStatus({ view, ...extra });
  }

  // -------------------------------------------------------------------------
  // Sizing
  // -------------------------------------------------------------------------
  function resize() {
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    const width = Math.max(1, Math.round(rect.width));
    const height = Math.max(1, Math.round(rect.height));
    if (canvas.width !== width * dpr || canvas.height !== height * dpr) {
      canvas.width = width * dpr;
      canvas.height = height * dpr;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    render();
  }

  const observer = new ResizeObserver(resize);
  observer.observe(canvas);

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------
  function tracePath(segments) {
    ctx.beginPath();
    if (segments.length === 0) return;
    const [sx, sy] = toScreen(segments[0].p0[0], segments[0].p0[1]);
    ctx.moveTo(sx, sy);
    for (const segment of segments) {
      if (segment.kind === "line") {
        const [x, y] = toScreen(segment.p1[0], segment.p1[1]);
        ctx.lineTo(x, y);
      } else if (segment.kind === "quad") {
        const [cx, cy] = toScreen(segment.c[0], segment.c[1]);
        const [x, y] = toScreen(segment.p1[0], segment.p1[1]);
        ctx.quadraticCurveTo(cx, cy, x, y);
      } else {
        const [c1x, c1y] = toScreen(segment.c1[0], segment.c1[1]);
        const [c2x, c2y] = toScreen(segment.c2[0], segment.c2[1]);
        const [x, y] = toScreen(segment.p1[0], segment.p1[1]);
        ctx.bezierCurveTo(c1x, c1y, c2x, c2y, x, y);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------
  function drawGuides() {
    const rect = canvas.getBoundingClientRect();
    const width = rect.width;
    const height = rect.height;
    const glyph = doc.glyph;

    // Vertical grid every 100 units
    const [zeroX] = toScreen(0, 0);
    const step = 100 * view.scale;
    if (step > 6) {
      ctx.strokeStyle = COLORS.gridMinor;
      ctx.lineWidth = 1;
      for (let x = zeroX; x >= 0; x -= step) line(x, 0, x, height);
      for (let x = zeroX + step; x <= width; x += step) line(x, 0, x, height);
    }

    // Horizontal metrics: baseline, ascent, descent
    const metrics = [
      [0, COLORS.baseline, 1.4],
      [doc.doc.ascent, COLORS.metric, 1],
      [-doc.doc.descent, COLORS.metric, 1],
    ];
    for (const [y, color, lineWidth] of metrics) {
      const [, sy] = toScreen(0, y);
      ctx.strokeStyle = color;
      ctx.lineWidth = lineWidth;
      line(0, sy, width, sy);
    }

    // Advance width
    if (glyph) {
      const [ax] = toScreen(glyph.width || 0, 0);
      ctx.strokeStyle = COLORS.advance;
      ctx.lineWidth = 1.2;
      ctx.setLineDash([5, 4]);
      line(ax, 0, ax, height);
      ctx.setLineDash([]);
    }
    return { width, height };
  }

  function line(x1, y1, x2, y2) {
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
  }

  function drawGhosts(depth = 0) {
    const glyph = doc.glyph;
    if (!glyph || depth > 1 || !glyph.references || glyph.references.length === 0) return;
    ctx.strokeStyle = COLORS.ghost;
    ctx.lineWidth = 1;
    for (const ref of glyph.references) {
      const target = doc.doc.glyphs.find((g) => g.name === ref[0]);
      const matrix = ref[1] || [1, 0, 0, 1, 0, 0];
      if (!target) continue;
      for (const contour of target.contours || []) {
        const transformed = {
          ...contour,
          points: contour.points.map((p) => {
            const x = matrix[0] * p[0] + matrix[2] * p[1] + matrix[4];
            const y = matrix[1] * p[0] + matrix[3] * p[1] + matrix[5];
            return [x, y, p[2], p[3], p[4], p[5]];
          }),
        };
        tracePath(buildSegments(transformed));
        ctx.stroke();
      }
    }
  }

  function drawOutline() {
    const glyph = doc.glyph;
    if (!glyph) return;
    for (const contour of glyph.contours || []) {
      const segments = buildSegments(contour);
      if (segments.length === 0) continue;
      tracePath(segments);
      if (contour.closed) {
        ctx.fillStyle = COLORS.outlineFill;
        ctx.fill();
      }
      ctx.strokeStyle = COLORS.outline;
      ctx.lineWidth = 1.6;
      ctx.stroke();
    }
  }

  function drawHandles() {
    const glyph = doc.glyph;
    if (!glyph || state.tool !== "select") return;
    ctx.strokeStyle = COLORS.handle;
    ctx.lineWidth = 1;
    for (const contour of glyph.contours || []) {
      const segments = buildSegments(contour);
      for (const segment of segments) {
        if (segment.kind === "cubic") {
          const [p0x, p0y] = toScreen(segment.p0[0], segment.p0[1]);
          const [c1x, c1y] = toScreen(segment.c1[0], segment.c1[1]);
          const [c2x, c2y] = toScreen(segment.c2[0], segment.c2[1]);
          const [p1x, p1y] = toScreen(segment.p1[0], segment.p1[1]);
          line(p0x, p0y, c1x, c1y);
          line(c2x, c2y, p1x, p1y);
        } else if (segment.kind === "quad") {
          const [p0x, p0y] = toScreen(segment.p0[0], segment.p0[1]);
          const [cx, cy] = toScreen(segment.c[0], segment.c[1]);
          const [p1x, p1y] = toScreen(segment.p1[0], segment.p1[1]);
          line(p0x, p0y, cx, cy);
          line(cx, cy, p1x, p1y);
        }
      }
    }
  }

  function drawPoints() {
    const glyph = doc.glyph;
    if (!glyph) return;
    for (let ci = 0; ci < glyph.contours.length; ci += 1) {
      const contour = glyph.contours[ci];
      for (let pi = 0; pi < contour.points.length; pi += 1) {
        const point = contour.points[pi];
        const [x, y] = toScreen(point[0], point[1]);
        const selected = doc.isSelected(ci, pi);
        const on = hit(point);

        ctx.beginPath();
        if (on) {
          ctx.rect(x - POINT_RADIUS, y - POINT_RADIUS, POINT_RADIUS * 2, POINT_RADIUS * 2);
        } else {
          ctx.arc(x, y, POINT_RADIUS, 0, Math.PI * 2);
        }
        ctx.fillStyle = selected ? (on ? COLORS.pointSel : COLORS.pointSelOff) : on ? COLORS.pointOn : COLORS.pointOff;
        ctx.fill();
        ctx.strokeStyle = "rgba(0,0,0,0.55)";
        ctx.lineWidth = 1;
        ctx.stroke();
      }
    }
  }

  /** The rubber band, while a marquee drag is in progress. */
  function drawMarquee() {
    const drag = state.drag;
    if (!drag || drag.kind !== "marquee" || !drag.moved) return;
    const [x0, y0] = drag.start;
    const [x1, y1] = drag.current;
    const x = Math.min(x0, x1);
    const y = Math.min(y0, y1);
    const w = Math.abs(x1 - x0);
    const h = Math.abs(y1 - y0);
    ctx.save();
    ctx.fillStyle = COLORS.marqueeFill;
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = COLORS.marqueeEdge;
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 3]);
    // The half-pixel offset keeps a 1px stroke from straddling two pixels.
    ctx.strokeRect(x + 0.5, y + 0.5, w, h);
    ctx.restore();
  }

  function render() {
    const rect = canvas.getBoundingClientRect();
    ctx.clearRect(0, 0, rect.width, rect.height);

    drawGuides();
    drawGhosts();
    drawOutline();
    drawHandles();
    drawPoints();
    drawInsertPreview();
    drawMarquee();
    status();
  }

  /**
   * Ghost the point a double-click would add.
   *
   * There is no button for this gesture, so without a preview the outline looks
   * un-clickable - which is exactly how it was reported.
   */
  function drawInsertPreview() {
    const segment = state.hoverSegment;
    if (!segment || state.tool !== "select") return;
    // A hover belongs to one glyph; drop it when the selection moves on.
    if (state.hoverGlyph !== doc.glyphName) return;
    const [fx, fy] = pointOnSegment(segment.geo, segment.t);
    const [x, y] = toScreen(fx, fy);
    ctx.save();
    ctx.setLineDash([3, 3]);
    ctx.strokeStyle = COLORS.insertPreview;
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.arc(x, y, POINT_RADIUS + 2.5, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  // -------------------------------------------------------------------------
  // Hit testing
  // -------------------------------------------------------------------------
  function findPoint(sx, sy) {
    const glyph = doc.glyph;
    if (!glyph) return null;
    let best = null;
    let bestDistance = HIT_RADIUS;
    for (let ci = 0; ci < glyph.contours.length; ci += 1) {
      const contour = glyph.contours[ci];
      for (let pi = 0; pi < contour.points.length; pi += 1) {
        const [x, y] = toScreen(contour.points[pi][0], contour.points[pi][1]);
        const distance = Math.hypot(x - sx, y - sy);
        if (distance <= bestDistance) {
          bestDistance = distance;
          best = { ci, pi };
        }
      }
    }
    return best;
  }

  /**
   * The segment nearest the cursor, for double-click point insertion.
   *
   * Sampling is the whole problem here. This used to walk t in steps of 0.1 and
   * require the click within 8px of one of those 11 samples, so on a long edge
   * (samples ~50px apart) roughly 80% of the outline silently ignored the
   * double-click - the outline looked un-clickable. The step is now derived from
   * the segment's on-screen size and the result is refined, so every part of the
   * outline is live and the reported `t` is where the user actually clicked.
   *
   * @returns {{ci: number, startOrig: number, t: number, distance: number}|null}
   */
  function findSegment(sx, sy) {
    const glyph = doc.glyph;
    if (!glyph) return null;
    let best = null;

    for (let ci = 0; ci < glyph.contours.length; ci += 1) {
      const segments = buildSegments(glyph.contours[ci]);
      for (const segment of segments) {
        if (segment.startOrig === null || segment.startOrig === undefined) continue;

        // Cheap reject: ignore segments whose on-screen box is nowhere near.
        const box = segmentScreenBounds(segment);
        if (
          sx < box.minX - SEGMENT_HIT_RADIUS ||
          sx > box.maxX + SEGMENT_HIT_RADIUS ||
          sy < box.minY - SEGMENT_HIT_RADIUS ||
          sy > box.maxY + SEGMENT_HIT_RADIUS
        ) {
          continue;
        }

        // The control polygon is a cheap over-estimate of the curve length,
        // which only means a few wasted samples.
        const rough = box.maxX - box.minX + (box.maxY - box.minY);
        const steps = Math.min(160, Math.max(8, Math.ceil(rough / 6)));

        let nearT = 0;
        let nearD = Infinity;
        for (let i = 0; i <= steps; i += 1) {
          const t = i / steps;
          const d = distanceOnSegment(segment, t, sx, sy);
          if (d < nearD) {
            nearD = d;
            nearT = t;
          }
        }

        // Ternary refinement for sub-pixel accuracy and a stable `t`.
        let low = Math.max(0, nearT - 1 / steps);
        let high = Math.min(1, nearT + 1 / steps);
        for (let i = 0; i < 14; i += 1) {
          const a = low + (high - low) / 3;
          const b = high - (high - low) / 3;
          if (distanceOnSegment(segment, a, sx, sy) < distanceOnSegment(segment, b, sx, sy)) {
            high = b;
          } else {
            low = a;
          }
        }
        const t = (low + high) / 2;
        const distance = distanceOnSegment(segment, t, sx, sy);

        if (distance < (best ? best.distance : SEGMENT_HIT_RADIUS)) {
          // `geo` is kept so the preview can recompute the point on this segment.
          best = { ci, startOrig: segment.startOrig, t, distance, geo: segment };
        }
      }
    }
    return best;
  }

  function distanceOnSegment(segment, t, sx, sy) {
    const [fx, fy] = pointOnSegment(segment, t);
    const [x, y] = toScreen(fx, fy);
    return Math.hypot(x - sx, y - sy);
  }

  /** Screen-space bounding box of a segment's control points. */
  function segmentScreenBounds(segment) {
    const controls =
      segment.kind === "line"
        ? [segment.p0, segment.p1]
        : segment.kind === "quad"
          ? [segment.p0, segment.c, segment.p1]
          : [segment.p0, segment.c1, segment.c2, segment.p1];
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const [fx, fy] of controls) {
      const [x, y] = toScreen(fx, fy);
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    return { minX, minY, maxX, maxY };
  }

  function pointOnSegment(segment, t) {
    if (segment.kind === "line") {
      return [
        segment.p0[0] + (segment.p1[0] - segment.p0[0]) * t,
        segment.p0[1] + (segment.p1[1] - segment.p0[1]) * t,
      ];
    }
    if (segment.kind === "quad") {
      const u = 1 - t;
      return [
        u * u * segment.p0[0] + 2 * u * t * segment.c[0] + t * t * segment.p1[0],
        u * u * segment.p0[1] + 2 * u * t * segment.c[1] + t * t * segment.p1[1],
      ];
    }
    const u = 1 - t;
    const a = u * u * u;
    const b = 3 * u * u * t;
    const c = 3 * u * t * t;
    const d = t * t * t;
    return [
      a * segment.p0[0] + b * segment.c1[0] + c * segment.c2[0] + d * segment.p1[0],
      a * segment.p0[1] + b * segment.c1[1] + c * segment.c2[1] + d * segment.p1[1],
    ];
  }

  // -------------------------------------------------------------------------
  // Pointer interaction
  // -------------------------------------------------------------------------
  function localPoint(event) {
    const rect = canvas.getBoundingClientRect();
    return [event.clientX - rect.left, event.clientY - rect.top];
  }

  /** Two screen corners -> a normalised box in font units. */
  function marqueeBox(from, to) {
    const [ax, ay] = toFont(from[0], from[1]);
    const [bx, by] = toFont(to[0], to[1]);
    return {
      minX: Math.min(ax, bx),
      minY: Math.min(ay, by),
      maxX: Math.max(ax, bx),
      maxY: Math.max(ay, by),
    };
  }

  function onPointerDown(event) {
    const [sx, sy] = localPoint(event);

    // Panning moved off the bare left-drag, which now belongs to the marquee:
    // middle-drag, or Space held down, is how the view scrolls.
    if (event.button === 1 || state.spaceDown) {
      event.preventDefault();
      canvas.setPointerCapture(event.pointerId);
      state.drag = { kind: "pan", last: [sx, sy], moved: false };
      canvas.classList.add("panning");
      return;
    }
    if (event.button !== 0) return;
    canvas.setPointerCapture(event.pointerId);

    const point = state.tool === "select" ? findPoint(sx, sy) : null;
    if (point) {
      if (event.shiftKey) {
        doc.toggleSelection(point.ci, point.pi);
      } else if (!doc.isSelected(point.ci, point.pi)) {
        doc.setSelection(point.ci, point.pi);
      }
      const selected = doc.selectedPoints();
      if (selected.length) doc.beginEdit();
      state.drag = { kind: "points", last: toFont(sx, sy), moved: false };
      return;
    }

    // Empty space: rubber-band a selection. Shift keeps what is already
    // selected rather than replacing it; a click with no drag deselects.
    if (!event.shiftKey) doc.clearSelection();
    canvas.style.cursor = "crosshair";
    state.drag = {
      kind: "marquee",
      start: [sx, sy],
      current: [sx, sy],
      add: event.shiftKey,
      moved: false,
    };
  }

  function onPointerMove(event) {
    const [sx, sy] = localPoint(event);
    state.cursorFont = toFont(sx, sy);

    if (!state.drag) {
      const point = state.tool === "select" ? findPoint(sx, sy) : null;
      state.hoverPoint = point;

      // Offer to add a point when hovering the outline (but not an existing
      // point, where the gesture means something else).
      const segment = point || state.tool !== "select" ? null : findSegment(sx, sy);
      const sameSegment =
        Boolean(state.hoverSegment) &&
        Boolean(segment) &&
        state.hoverSegment.ci === segment.ci &&
        state.hoverSegment.startOrig === segment.startOrig;
      const moved =
        !state.hoverAt || Math.hypot(state.hoverAt[0] - sx, state.hoverAt[1] - sy) > 0.75;

      const hadPreview = state.previewDrawn;
      state.hoverSegment = segment;
      state.hoverGlyph = segment ? doc.glyphName : null;
      state.hoverAt = [sx, sy];
      state.previewDrawn = Boolean(segment);

      canvas.style.cursor = point ? "move" : segment ? "copy" : "crosshair";

      // Only repaint when the ghost actually moves: a full render on every
      // pointermove would be wasteful on a large glyph.
      if (hadPreview && !segment) render();
      else if (segment && (!sameSegment || moved)) render();

      // After render(), which resets the readout when no cursor is passed.
      status({ cursor: state.cursorFont });
      return;
    }

    if (state.drag.kind === "marquee") {
      state.drag.moved = true;
      state.drag.current = [sx, sy];
      // selectInBox emits "selection", which is what repaints the canvas and
      // refreshes the selected count. Relying on that keeps the highlight live
      // during the drag without a second full render on every pointermove.
      doc.selectInBox(marqueeBox(state.drag.start, state.drag.current), {
        add: state.drag.add,
      });
      return;
    }

    if (state.drag.kind === "pan") {
      view.offsetX += sx - state.drag.last[0];
      view.offsetY += sy - state.drag.last[1];
      state.drag.last = [sx, sy];
      state.drag.moved = true;
      render();
      return;
    }

    if (state.drag.kind === "points") {
      const [fx, fy] = toFont(sx, sy);
      const dx = fx - state.drag.last[0];
      const dy = fy - state.drag.last[1];
      if (dx === 0 && dy === 0) return;
      for (const { point } of doc.selectedPoints()) {
        point[0] += dx;
        point[1] += dy;
      }
      state.drag.last = [fx, fy];
      state.drag.moved = true;
      render();
    }
  }

  function onPointerUp(event) {
    if (state.drag && state.drag.kind === "points" && state.drag.moved) {
      doc.commitEdit("edit");
    }
    canvas.classList.remove("panning");
    state.drag = null;
    if (canvas.hasPointerCapture(event.pointerId)) {
      canvas.releasePointerCapture(event.pointerId);
    }
    render();
  }

  function onDoubleClick(event) {
    if (state.tool !== "select") return;
    const [sx, sy] = localPoint(event);
    if (findPoint(sx, sy)) return; // double-clicking a point is not an insert
    const segment = findSegment(sx, sy);
    if (!segment) return;
    // Split where the user clicked, not at the segment's midpoint.
    if (doc.insertPointOnSegment(segment.ci, segment.startOrig, segment.t)) {
      // The geometry moved, so the old hover result is stale.
      state.hoverSegment = null;
      state.hoverGlyph = null;
      state.previewDrawn = false;
      render();
    }
  }

  function onWheel(event) {
    event.preventDefault();
    const [sx, sy] = localPoint(event);
    const [fx, fy] = toFont(sx, sy);

    const factor = Math.exp(-event.deltaY * 0.0015);
    const next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, view.scale * factor));
    if (next === view.scale) return;
    view.scale = next;

    // Keep the font point under the cursor fixed.
    view.offsetX = sx - fx * view.scale;
    view.offsetY = sy + fy * view.scale;
    render();
  }

  // Space turns the pointer into a pan grip. Tracked here rather than in app.js
  // so the two can never disagree about what a drag is about to do.
  function onKeyDown(event) {
    if (event.key !== " " || state.spaceDown) return;
    const tag = (event.target.tagName || "").toLowerCase();
    if (tag === "input" || tag === "textarea" || tag === "select") return;
    state.spaceDown = true;
    canvas.style.cursor = "grab";
  }

  function onKeyUp(event) {
    if (event.key !== " ") return;
    state.spaceDown = false;
  }

  canvas.addEventListener("pointerdown", onPointerDown);
  canvas.addEventListener("pointermove", onPointerMove);
  canvas.addEventListener("pointerup", onPointerUp);
  canvas.addEventListener("pointercancel", onPointerUp);
  canvas.addEventListener("dblclick", onDoubleClick);
  canvas.addEventListener("wheel", onWheel, { passive: false });
  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);

  // -------------------------------------------------------------------------
  // View helpers
  // -------------------------------------------------------------------------
  function fit(padding = 48) {
    const rect = canvas.getBoundingClientRect();
    const glyph = doc.glyph;
    let box = glyph ? doc.glyphBounds() : null;

    if (!box) {
      // Fall back to the em box so an empty glyph still shows the metrics.
      box = { minX: 0, maxX: glyph && glyph.width ? glyph.width : doc.doc.em, minY: -doc.doc.descent, maxY: doc.doc.ascent };
    }

    const glyphWidth = Math.max(1, box.maxX - box.minX);
    const glyphHeight = Math.max(1, box.maxY - box.minY);
    const scale = Math.min(
      (rect.width - padding * 2) / glyphWidth,
      (rect.height - padding * 2) / glyphHeight
    );
    view.scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
    const centerX = (box.minX + box.maxX) / 2;
    const centerY = (box.minY + box.maxY) / 2;
    view.offsetX = rect.width / 2 - centerX * view.scale;
    view.offsetY = rect.height / 2 + centerY * view.scale;
    render();
  }

  function zoomBy(factor) {
    const rect = canvas.getBoundingClientRect();
    const cx = rect.width / 2;
    const cy = rect.height / 2;
    const [fx, fy] = toFont(cx, cy);
    view.scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, view.scale * factor));
    view.offsetX = cx - fx * view.scale;
    view.offsetY = cy + fy * view.scale;
    render();
  }

  function setTool(tool) {
    state.tool = tool;
    render();
  }

  function destroy() {
    observer.disconnect();
    window.removeEventListener("keydown", onKeyDown);
    window.removeEventListener("keyup", onKeyUp);
    canvas.removeEventListener("pointerdown", onPointerDown);
    canvas.removeEventListener("pointermove", onPointerMove);
    canvas.removeEventListener("pointerup", onPointerUp);
    canvas.removeEventListener("pointercancel", onPointerUp);
    canvas.removeEventListener("dblclick", onDoubleClick);
    canvas.removeEventListener("wheel", onWheel);
  }

  resize();
  return { render, fit, zoomBy, setTool, destroy, view };
}
