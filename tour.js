/* ============================================================
   Guided tour engine, shared by the tool pages
   (spline-designer.html, accessible-color-generator.html).
   Styles live in tour.css.

     const tour = SiteTour.create({ steps, launchButton, seenKey, snapshot, onOpen });

   Each step dims the page and spotlights one region -- the only part that
   still takes clicks, unless the step is look-only -- and turns its tasks
   green as the user actually does them. Pages call tour.notify() whenever
   their state changes so the current step can re-check its tasks.

   Step fields (title, body and target are required):
     target()          viewport rect to spotlight
     interactive       false makes the spotlight look-only
     cardSides         sides to try for the card before docking it to the bottom
     notes             [{ eyebrow, title, text, sides, anchor(side), maxWidth? }] arrowed
                       callouts; maxWidth (px) overrides tour.css's default for long text
     legend            [{ term, text, link?: { href, text }, badgeAt() }] numbered list in
                       the card, matched by numbered badges placed on the page
     tasks             [{ key, text }], ticked off by check(snap, done)
     hint, doneHint    line under the tasks, before / after they're all done
     pulseAt()         points to ring while the tasks are unfinished
     onEnter()         runs just before the step is shown
   snapshot() is taken on entering each step and handed to check().

   Pages add var(--tour-dock, 0px) to the bottom padding of their main
   wrapper so content can scroll clear of a card docked to the bottom.
   ============================================================ */

(function () {
  "use strict";

  const GAP = 30;   // px between the spotlight and a note or the card
  const EDGE = 16;  // px kept clear of the viewport edges
  // Direction from a note toward the spotlight, per side the note sits on.
  const NORMALS = { top: [0, 1], bottom: [0, -1], left: [1, 0], right: [-1, 0] };

  const OVERLAY_HTML =
    '<div class="tour-block"></div><div class="tour-block"></div>' +
    '<div class="tour-block"></div><div class="tour-block"></div>' +
    '<div class="tour-spot" id="tourSpot"></div>' +
    '<svg class="tour-arrows" id="tourArrows" aria-hidden="true"></svg>' +
    '<div id="tourNotes"></div>' +
    '<div class="tour-badges" id="tourBadges" aria-hidden="true"></div>' +
    '<div id="tourPulses"></div>' +
    '<div class="tour-card" id="tourCard" role="dialog" aria-labelledby="tourTitle" aria-describedby="tourBody" tabindex="-1">' +
    '<div class="tour-step-label" id="tourStepLabel"></div>' +
    '<h2 id="tourTitle"></h2>' +
    '<p id="tourBody"></p>' +
    '<ol class="tour-legend" id="tourLegend"></ol>' +
    '<ul class="tour-tasks" id="tourTasks"></ul>' +
    '<p class="tour-hint" id="tourHint" aria-live="polite"></p>' +
    '<div class="tour-actions">' +
    '<button class="tour-close" id="tourClose" type="button">Close tour</button>' +
    '<button class="tour-btn" id="tourBack" type="button">Back</button>' +
    '<button class="tour-btn tour-next" id="tourNext" type="button">Next</button>' +
    "</div></div>";

  const clamp = (v, lo, hi) => Math.max(lo, Math.min(v, hi));

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  // Midpoint of an element's top edge, in viewport px.
  function topCentre(node) {
    const r = node.getBoundingClientRect();
    return { x: (r.left + r.right) / 2, y: r.top };
  }

  // Viewport box around several elements, grown by `pad` px on every side.
  function unionRect(els, pad = 0) {
    const rs = els.map((e) => e.getBoundingClientRect());
    const left = Math.min(...rs.map((r) => r.left)) - pad;
    const top = Math.min(...rs.map((r) => r.top)) - pad;
    const right = Math.max(...rs.map((r) => r.right)) + pad;
    const bottom = Math.max(...rs.map((r) => r.bottom)) + pad;
    return { left, top, right, bottom, width: right - left, height: bottom - top };
  }

  function setBox(node, left, top, width, height) {
    node.style.left = left + "px";
    node.style.top = top + "px";
    if (width != null) node.style.width = Math.max(0, width) + "px";
    if (height != null) node.style.height = Math.max(0, height) + "px";
  }

  // Put a w x h box on one side of the spotlight, lined up with point `align` and
  // kept inside the viewport (bottom limit `maxY`). Returns null when that side has
  // no room, unless `force` is set.
  function place(side, w, h, spot, align, vw, maxY, force) {
    let left, top;
    if (side === "left" || side === "right") {
      left = side === "left" ? spot.left - GAP - w : spot.right + GAP;
      if (!force && (left < EDGE || left + w > vw - EDGE)) return null;
      left = clamp(left, EDGE, vw - EDGE - w);
      top = clamp(align.y - h / 2, EDGE, maxY - EDGE - h);
    } else {
      top = side === "top" ? spot.top - GAP - h : spot.bottom + GAP;
      if (!force && (top < EDGE || top + h > maxY - EDGE)) return null;
      top = clamp(top, EDGE, maxY - EDGE - h);
      left = clamp(align.x - w / 2, EDGE, vw - EDGE - w);
    }
    return { left, top, right: left + w, bottom: top + h };
  }

  // Curved arrow from the note's facing edge to anchor `a`, drawn black with a white
  // halo so it reads on both the dimmed page and the lit region.
  function arrow(box, side, a) {
    const [nx, ny] = NORMALS[side];
    const sx = nx ? (nx > 0 ? box.right : box.left) + nx * 4 : clamp(a.x, box.left + 18, box.right - 18);
    const sy = ny ? (ny > 0 ? box.bottom : box.top) + ny * 4 : clamp(a.y, box.top + 14, box.bottom - 14);
    const ex = a.x - nx * 8, ey = a.y - ny * 8; // the line stops at the arrowhead's base
    const k = Math.max(10, Math.hypot(ex - sx, ey - sy) * 0.45);
    const d = `M${sx},${sy} C${sx + nx * k},${sy + ny * k} ${ex - nx * k},${ey - ny * k} ${ex},${ey}`;
    const head = `${a.x},${a.y} ${ex - ny * 5},${ey + nx * 5} ${ex + ny * 5},${ey - nx * 5}`;
    return `<path d="${d}" fill="none" stroke="#fff" stroke-width="5" stroke-linecap="round"/>` +
      `<path d="${d}" fill="none" stroke="#000" stroke-width="2" stroke-linecap="round"/>` +
      `<polygon points="${head}" fill="#000" stroke="#fff" stroke-width="1.5" stroke-linejoin="round"/>`;
  }

  function create({ steps, launchButton, seenKey, snapshot = () => null, onOpen }) {
    const root = el("div", "tour");
    root.id = "tour";
    root.hidden = true;
    root.innerHTML = OVERLAY_HTML;
    document.body.append(root);

    const byId = (id) => document.getElementById(id);
    const blocks = root.querySelectorAll(".tour-block");
    const spot = byId("tourSpot");
    const arrowLayer = byId("tourArrows");
    const notesLayer = byId("tourNotes");
    const badgesLayer = byId("tourBadges");
    const pulsesLayer = byId("tourPulses");
    const card = byId("tourCard");
    const legendList = byId("tourLegend");
    const taskList = byId("tourTasks");
    const hint = byId("tourHint");
    const backBtn = byId("tourBack");
    const nextBtn = byId("tourNext");

    const state = { active: false, index: 0, snap: null, done: new Set(), frame: 0 };

    // Positions everything for the current step. Returns the lowest y the spotlight
    // can use without sitting under a bottom-docked card.
    function layout() {
      const step = steps[state.index];
      const vw = document.documentElement.clientWidth;
      const vh = window.innerHeight;
      const s = step.target();

      setBox(spot, s.left, s.top, s.right - s.left, s.bottom - s.top);
      // Look-only steps swallow clicks inside the spotlight as well.
      spot.style.pointerEvents = step.interactive === false ? "auto" : "none";
      const sh = s.bottom - s.top;
      setBox(blocks[0], 0, 0, vw, s.top);
      setBox(blocks[1], 0, s.bottom, vw, vh - s.bottom);
      setBox(blocks[2], 0, s.top, s.left, sh);
      setBox(blocks[3], s.right, s.top, vw - s.right, sh);

      // Card beside the spotlight when it fits, otherwise docked to the bottom.
      let cardW = Math.min(340, vw - 2 * EDGE);
      card.style.width = cardW + "px";
      let cardH = card.offsetHeight;
      const centre = { x: (s.left + s.right) / 2, y: (s.top + s.bottom) / 2 };
      let cardBox = null;
      for (const side of step.cardSides || ["right", "left"]) {
        cardBox = place(side, cardW, cardH, s, centre, vw, vh);
        if (cardBox) break;
      }
      let freeBottom = vh;
      let docked = false;
      if (!cardBox) {
        cardW = Math.min(520, vw - 2 * EDGE);
        card.style.width = cardW + "px";
        cardH = card.offsetHeight;
        cardBox = { left: (vw - cardW) / 2, top: Math.max(EDGE, vh - EDGE - cardH) };
        freeBottom = cardBox.top - 8;
        docked = true;
      }
      document.documentElement.style.setProperty("--tour-dock", docked ? cardH + 2 * EDGE + "px" : "0px");
      setBox(card, cardBox.left, cardBox.top);

      let svg = "";
      (step.notes || []).forEach((note, i) => {
        const node = notesLayer.children[i];
        if (note.maxWidth) node.style.maxWidth = Math.min(note.maxWidth, vw - 2 * EDGE) + "px";
        setBox(node, 0, 0); // measure at full available width
        const w = node.offsetWidth, h = node.offsetHeight;
        let box = null, side = null;
        for (side of note.sides) {
          box = place(side, w, h, s, note.anchor(side), vw, freeBottom);
          if (box) break;
        }
        if (!box) box = place(side, w, h, s, note.anchor(side), vw, freeBottom, true);
        setBox(node, box.left, box.top);
        svg += arrow(box, side, note.anchor(side));
      });
      arrowLayer.innerHTML = svg;

      (step.legend || []).forEach((item, i) => {
        const p = item.badgeAt();
        setBox(badgesLayer.children[i], p.x, p.y);
      });

      if (pulsesLayer.children.length) {
        step.pulseAt().forEach((p, i) => setBox(pulsesLayer.children[i], p.x, p.y));
      }
      return freeBottom;
    }

    function queueLayout() {
      if (state.frame) return;
      state.frame = requestAnimationFrame(() => {
        state.frame = 0;
        if (state.active) layout();
      });
    }

    // Syncs the task colours, hint text and pulse rings with what's been done.
    function refresh() {
      const step = steps[state.index];
      const allDone = (step.tasks || []).every((t) => state.done.has(t.key));
      taskList.querySelectorAll("li").forEach((li) => {
        li.classList.toggle("done", state.done.has(li.dataset.key));
      });
      hint.textContent = (allDone ? step.doneHint : step.hint) || "";
      hint.classList.toggle("done", allDone);
      // Only add / remove rings when the count changes, so they don't restart mid-animation.
      const want = step.pulseAt && !allDone ? step.pulseAt().length : 0;
      while (pulsesLayer.children.length < want) pulsesLayer.append(el("div", "tour-pulse"));
      while (pulsesLayer.children.length > want) pulsesLayer.lastChild.remove();
    }

    function notify() {
      if (!state.active) return;
      const step = steps[state.index];
      if (step.check) step.check(state.snap, state.done);
      refresh();
      layout();
    }

    function show(index) {
      state.index = index;
      const step = steps[index];
      if (step.onEnter) step.onEnter();
      state.snap = snapshot();
      state.done = new Set();

      byId("tourStepLabel").textContent = "Step " + (index + 1) + " of " + steps.length;
      byId("tourTitle").textContent = step.title;
      byId("tourBody").textContent = step.body;
      taskList.replaceChildren(...(step.tasks || []).map((t) => {
        const li = el("li", null, t.text);
        li.dataset.key = t.key;
        return li;
      }));
      notesLayer.replaceChildren(...(step.notes || []).map((n) => {
        const node = el("div", "tour-note");
        node.setAttribute("role", "note");
        node.append(el("span", "tour-eyebrow", n.eyebrow), el("span", "tour-note-title", n.title), n.text);
        return node;
      }));
      // Numbered list in the card, matched by badges on the page itself.
      const legend = step.legend || [];
      legendList.replaceChildren(...legend.map((item, i) => {
        const badge = el("span", "tour-badge", String(i + 1));
        badge.setAttribute("aria-hidden", "true");
        const desc = el("span");
        desc.append(el("strong", null, item.term), " " + item.text);
        if (item.link) {
          const a = el("a", "tour-link", item.link.text);
          a.href = item.link.href;
          a.target = "_blank";
          a.rel = "noopener noreferrer";
          desc.append(" ", a);
        }
        const li = el("li");
        li.append(badge, desc);
        return li;
      }));
      badgesLayer.replaceChildren(...legend.map((_, i) => el("div", "tour-badge", String(i + 1))));
      backBtn.hidden = index === 0;
      nextBtn.textContent = index === steps.length - 1 ? "Finish" : "Next";
      refresh();

      // Scroll the spotlight to the middle of whatever space the card leaves free.
      const freeBottom = layout();
      const s = step.target();
      const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      window.scrollBy({
        top: s.top - Math.max(EDGE, (freeBottom - (s.bottom - s.top)) / 2),
        behavior: reduceMotion ? "auto" : "smooth",
      });
      card.focus({ preventScroll: true });
    }

    function onKeydown(e) {
      if (e.key === "Escape") close();
    }

    // The launch button pulses until the tour has been opened once in this browser.
    // Storage can be unavailable (private mode, blocked site data): then it just pulses each visit.
    let seen = false;
    try { seen = localStorage.getItem(seenKey) === "1"; } catch (e) { /* treat as unseen */ }
    launchButton.classList.toggle("unseen", !seen);

    function open() {
      launchButton.classList.remove("unseen");
      try { localStorage.setItem(seenKey, "1"); } catch (e) { /* pulse returns next visit */ }
      if (onOpen) onOpen(); // runs while the tour is still inactive, so it can't tick a task
      state.active = true;
      root.hidden = false;
      document.addEventListener("keydown", onKeydown);
      window.addEventListener("scroll", queueLayout, { passive: true });
      window.addEventListener("resize", queueLayout);
      show(0);
    }

    function close() {
      state.active = false;
      root.hidden = true;
      document.documentElement.style.removeProperty("--tour-dock");
      cancelAnimationFrame(state.frame);
      state.frame = 0;
      document.removeEventListener("keydown", onKeydown);
      window.removeEventListener("scroll", queueLayout);
      window.removeEventListener("resize", queueLayout);
      launchButton.focus({ preventScroll: true });
    }

    launchButton.addEventListener("click", open);
    byId("tourClose").addEventListener("click", close);
    backBtn.addEventListener("click", () => show(state.index - 1));
    nextBtn.addEventListener("click", () => {
      if (state.index < steps.length - 1) show(state.index + 1); else close();
    });

    return { notify, open, close, show, isActive: () => state.active };
  }

  window.SiteTour = { create, unionRect, topCentre };
})();
