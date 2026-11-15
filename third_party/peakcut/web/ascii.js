/* PeakCut ASCII field: a soft colour cloud with loose clusters of small characters that fade in and out as it drifts.
   Smooth: every character keeps its own glyph and only its opacity moves, and the cloud is drawn small and scaled up
   (a cheap, natural blur), so it can run at full frame rate.
   Usage: PeakAscii(canvasElement, {strength: 1}). Pauses off screen and when the tab is hidden; still for reduced motion. */
(function () {
  const GLYPHS = "-=+xX+x=";
  const CLOUD = [[255, 206, 166], [255, 228, 198], [255, 192, 146], [255, 238, 220]];
  const INK = "214,120,52";

  const P = new Uint8Array(512);
  (function () { const p = []; for (let i = 0; i < 256; i++) p[i] = i;
    let s = 7; for (let i = 255; i > 0; i--) { s = (s * 16807) % 2147483647; const j = s % (i + 1); [p[i], p[j]] = [p[j], p[i]]; }
    for (let i = 0; i < 512; i++) P[i] = p[i & 255]; })();
  const ease = t => t * t * (3 - 2 * t);
  function vnoise(x, y) {
    const xi = Math.floor(x), yi = Math.floor(y), u = ease(x - xi), v = ease(y - yi);
    const h = (a, b) => P[(P[a & 255] + b) & 511] / 255;
    const a = h(xi, yi), b = h(xi + 1, yi), c = h(xi, yi + 1), d = h(xi + 1, yi + 1);
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
  }
  const noise = (x, y) => vnoise(x, y) * .65 + vnoise(x * 2.1 + 17, y * 2.1 + 5) * .35;
  const smooth = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

  function PeakAscii(canvas, opts) {
    opts = Object.assign({cell: 11, line: 17, strength: 1}, opts || {});
    const ctx = canvas.getContext("2d");
    const cloud = document.createElement("canvas"), cctx = cloud.getContext("2d");
    const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
    let w = 0, h = 0, raf = 0, visible = true, cells = [];
    const t0 = performance.now();

    const band = y => { const v = y / h; return smooth(.12, .5, v) * smooth(1.04, .84, v); };

    function size() {
      const r = canvas.getBoundingClientRect(), dpr = Math.min(2, window.devicePixelRatio || 1);
      w = Math.max(1, Math.round(r.width)); h = Math.max(1, Math.round(r.height));
      canvas.width = w * dpr; canvas.height = h * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      cloud.width = Math.max(8, Math.round(w / 10)); cloud.height = Math.max(8, Math.round(h / 10));
      cells = [];                                         // every character keeps its glyph; only opacity changes
      for (let y = 4, row = 0; y < h; y += opts.line, row++) {
        const m = band(y);
        if (m < .03) continue;
        for (let x = (row % 2) * opts.cell * .5; x < w; x += opts.cell) {
          const k = P[(P[(x / opts.cell) & 255] + row) & 511];
          cells.push({x, y, m, g: GLYPHS[k % GLYPHS.length], o: (k % 7) / 7});
        }
      }
    }

    function draw(now) {
      const t = (now - t0) / 1000;
      // the cloud, drawn at a tenth of the size and stretched: soft without an expensive blur
      const cw = cloud.width, ch = cloud.height;
      cctx.clearRect(0, 0, cw, ch);
      CLOUD.forEach((c, i) => {
        const bx = (.15 + i * .24 + Math.sin(t * .09 + i * 1.9) * .07) * cw;
        const by = (.68 + Math.cos(t * .07 + i * 1.3) * .08) * ch;
        const r = (.38 + (i % 2) * .1) * Math.max(cw, ch * 1.6);
        const g = cctx.createRadialGradient(bx, by, 0, bx, by, r);
        g.addColorStop(0, `rgba(${c},.62)`); g.addColorStop(.55, `rgba(${c},.25)`); g.addColorStop(1, `rgba(${c},0)`);
        cctx.fillStyle = g; cctx.fillRect(0, 0, cw, ch);
      });
      ctx.clearRect(0, 0, w, h);
      ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = "high";
      ctx.drawImage(cloud, 0, 0, w, h);
      const top = ctx.createLinearGradient(0, 0, 0, h * .5);
      top.addColorStop(0, "#fff"); top.addColorStop(.6, "rgba(255,255,255,.75)"); top.addColorStop(1, "rgba(255,255,255,0)");
      ctx.fillStyle = top; ctx.fillRect(0, 0, w, h * .5);

      // the characters: each one fades in and out with the drifting noise
      ctx.font = `400 ${opts.line - 5}px ui-monospace, "Cascadia Mono", Consolas, monospace`;
      ctx.textBaseline = "top";
      const sx = t * .045, sy = t * .028;
      for (const c of cells) {
        const n = noise(c.x * .012 + sx, c.y * .03 - sy) + c.o * .06;
        const a = smooth(.5, .78, n) * c.m * opts.strength * .5;
        if (a < .02) continue;
        ctx.fillStyle = `rgba(${INK},${a.toFixed(3)})`;
        ctx.fillText(c.g, c.x, c.y);
      }
    }

    function loop(now) {
      raf = 0;
      if (!visible || document.hidden) return;
      draw(now);
      raf = requestAnimationFrame(loop);
    }
    const start = () => { if (!raf && !still) raf = requestAnimationFrame(loop); };
    size(); draw(performance.now());
    new ResizeObserver(() => { size(); draw(performance.now()); }).observe(canvas);
    try { new IntersectionObserver(es => { visible = es[0].isIntersecting; if (visible) start(); }).observe(canvas); } catch {}
    document.addEventListener("visibilitychange", start);
    start();
  }
  window.PeakAscii = PeakAscii;
})();
