// Nav highlight + scroll-driven app walkthrough.
// No frameworks: the page's whole personality is that it looks like 2004
// and behaves like 2026.

(function () {
  "use strict";

  // ── Nav: highlight the section in view ──────────────────────────
  const links = Array.from(document.querySelectorAll("nav a"));
  const targets = links
    .map((a) => document.querySelector(a.getAttribute("href")))
    .filter(Boolean);

  function refreshNav() {
    // Pick the last heading above the viewport midline. The walkthrough
    // (#scrub-wrap) belongs to "The App" even though the section element
    // itself is short.
    const mid = window.scrollY + window.innerHeight * 0.35;
    let current = targets[0];
    for (const t of targets) {
      if (t.offsetTop <= mid) current = t;
    }
    const wrap = document.getElementById("scrub-wrap");
    if (wrap && wrap.offsetTop <= mid && mid < wrap.offsetTop + wrap.offsetHeight) {
      current = document.getElementById("app");
    }
    // At the very bottom the midline can never pass the last heading.
    if (window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 2) {
      current = targets[targets.length - 1];
    }
    links.forEach((a) =>
      a.classList.toggle("current", a.getAttribute("href") === "#" + current.id)
    );
  }

  // ── Scroll scrub ────────────────────────────────────────────────
  const FRAME_COUNT = window.SCRUB_FRAMES || 0;
  const canvas = document.getElementById("scrub-canvas");
  const wrap = document.getElementById("scrub-wrap");
  const steps = Array.from(document.querySelectorAll(".scrub-step"));
  const ctx = canvas ? canvas.getContext("2d") : null;
  const frames = new Array(FRAME_COUNT);
  let drawn = -1;

  function frameSrc(i) {
    return "assets/frames/f" + String(i + 1).padStart(3, "0") + ".webp";
  }

  // Decode eagerly but politely: nearest-first would be nicer, but the
  // whole sequence is a few MB of webp and the browser caches it.
  function preload() {
    for (let i = 0; i < FRAME_COUNT; i++) {
      const img = new Image();
      img.src = frameSrc(i);
      img.decode?.().catch(() => {});
      frames[i] = img;
    }
  }

  function progress() {
    const rect = wrap.getBoundingClientRect();
    const total = wrap.offsetHeight - window.innerHeight;
    return Math.min(1, Math.max(0, -rect.top / total));
  }

  function draw(i) {
    if (i === drawn) return;
    const img = frames[i];
    if (!img || !img.complete || !img.naturalWidth) return;
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    drawn = i;
  }

  function refreshScrub() {
    if (!ctx || !FRAME_COUNT) return;
    const p = progress();
    draw(Math.min(FRAME_COUNT - 1, Math.floor(p * FRAME_COUNT)));
    for (const s of steps) {
      const from = parseFloat(s.dataset.from);
      const to = parseFloat(s.dataset.to);
      s.classList.toggle("active", p >= from && p < to);
    }
  }

  let ticking = false;
  function onScroll() {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(() => {
      refreshScrub();
      refreshNav();
      ticking = false;
    });
  }

  if (canvas && wrap) {
    preload();
    // First frame as soon as it decodes.
    const first = new Image();
    first.src = frameSrc(0);
    first.onload = () => { if (drawn < 0) ctx.drawImage(first, 0, 0, canvas.width, canvas.height); };
  }
  window.addEventListener("scroll", onScroll, { passive: true });
  window.addEventListener("resize", onScroll);
  onScroll();
})();
