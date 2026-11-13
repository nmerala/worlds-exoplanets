/* WORLDS — an interactive documentary of every planet we've found beyond our solar system.
   Data: NASA Exoplanet Archive (Planetary Systems Composite Parameters), read live from Tableau.
   Locally (no Tableau), it reads dev/planets.json so the experience can be previewed. */
(function () {
  'use strict';

  // ---------------------------------------------------------------- constants
  var LY_PER_PC = 3.26156;
  var NOW_YEAR = new Date().getFullYear();
  var STILL = /[?&]still=1/.test(location.search); // local screenshots: skip animation
  var REDUCED = STILL || (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  var SPEED = 1; // story pace multiplier: 1 = default (slow), 0.5 = faster, 2 = slower
  var DPR = Math.min(window.devicePixelRatio || 1, 2);

  var FIELDS = [
    { cap: 'Planet', key: 'name' },
    { cap: 'Host Star', key: 'host' },
    { cap: 'Discovery Method', key: 'method' },
    { cap: 'Discovery Facility', key: 'facility' },
    { cap: 'Radius Estimated', key: 'radEst' },
    { cap: 'Mass Estimated', key: 'massEst' },
    { cap: 'Temp Estimated', key: 'tempEst' },
    { cap: 'Discovery Year', key: 'year', fn: 'MIN' },
    { cap: 'Orbital Period (days)', key: 'period', fn: 'AVG' },
    { cap: 'Radius (Earth)', key: 'radius', fn: 'AVG' },
    { cap: 'Mass (Earth)', key: 'mass', fn: 'AVG' },
    { cap: 'Eq Temp (K)', key: 'temp', fn: 'AVG' },
    { cap: 'Distance (pc)', key: 'pc', fn: 'AVG' },
    { cap: 'Planets in System', key: 'sys', fn: 'MAX' },
    { cap: 'Star Temp (K)', key: 'starTemp', fn: 'AVG' },
    { cap: 'Star Radius (Sun)', key: 'starRad', fn: 'AVG' },
    { cap: 'RA', key: 'ra', fn: 'AVG' },
    { cap: 'Dec', key: 'dec', fn: 'AVG' }
  ];

  // Question-style filters. Every definition is shown on screen, so nothing is hidden in code.
  var QUESTIONS = [
    { id: 'earth', label: 'Earth-sized', test: function (p) { return p.radius != null && p.radius >= 0.8 && p.radius <= 1.25; },
      say: 'between 0.8 and 1.25 times Earth’s width. Similar size, not necessarily similar anything else.' },
    { id: 'near', label: 'Nearby', test: function (p) { return p.ly != null && p.ly <= 50; },
      say: 'within 50 light-years. Our cosmic neighborhood.' },
    { id: 'hotj', label: 'Hot Jupiters', test: function (p) { return (p.radius != null && p.radius >= 8 || p.mass != null && p.mass >= 95) && p.period != null && p.period < 10; },
      say: 'giant planets that circle their star in under 10 days. Nobody predicted these.' },
    { id: 'temperate', label: 'Potentially temperate', test: function (p) { return p.temp != null && p.temp >= 200 && p.temp <= 320; },
      say: 'with an equilibrium temperature of 200–320 K. That’s a calculation from starlight, not a measured surface temperature.' },
    { id: 'kepler', label: 'Found by Kepler', test: function (p) { return p.facility === 'Kepler'; },
      say: 'found by NASA’s Kepler telescope, which stared at one patch of sky for four years.' },
    { id: 'tess', label: 'Found by TESS', test: function (p) { return /TESS/.test(p.facility); },
      say: 'found by TESS, which sweeps nearly the whole sky looking at bright, nearby stars.' },
    { id: 'decade', label: 'This decade', test: function (p) { return p.year >= 2020; },
      say: 'discovered since 2020.' }
  ];

  var METHOD_GROUPS = [
    { id: 'Transit', label: 'Transit (a shadow)', match: function (m) { return m === 'Transit'; } },
    { id: 'Radial Velocity', label: 'Wobble (radial velocity)', match: function (m) { return m === 'Radial Velocity'; } },
    { id: 'Microlensing', label: 'Microlensing (bent light)', match: function (m) { return m === 'Microlensing'; } },
    { id: 'Imaging', label: 'Direct imaging (a photo)', match: function (m) { return m === 'Imaging'; } },
    { id: 'Other', label: 'Other methods', match: function () { return true; } }
  ];

  // ---------------------------------------------------------------- state
  var S = {
    planets: [], byName: new Map(), byHost: new Map(), total: 0,
    theme: 'dark', question: null, hover: null, worldOpen: null,
    firstYear: 1992, lastYear: NOW_YEAR, storyYear: 1992, playing: false
  };
  var $ = function (id) { return document.getElementById(id); };
  var fmt = d3.format(',');

  // ---------------------------------------------------------------- theme
  var PAL = {};
  function readPalette() {
    var cs = getComputedStyle(document.documentElement);
    var v = function (n) { return cs.getPropertyValue(n).trim(); };
    PAL = {
      bg: v('--bg'), bg2: v('--bg-2'), ink: v('--ink'), ink2: v('--ink-2'), ink3: v('--ink-3'),
      line: v('--line'), accent: v('--accent'),
      t: [v('--t0'), v('--t1'), v('--t2'), v('--t3'), v('--t4')], tn: v('--tn'),
      dark: S.theme === 'dark'
    };
    tempColor = d3.scaleLog().domain([150, 300, 700, 1500, 3000]).range(PAL.t).interpolate(d3.interpolateRgb).clamp(true);
  }
  var tempColor = function () { return '#fff'; };
  function colorOf(p) { return p.temp != null ? tempColor(p.temp) : PAL.tn; }

  function setTheme(t) {
    S.theme = t;
    document.documentElement.setAttribute('data-theme', t);
    var btn = $('theme');
    btn.setAttribute('aria-pressed', String(t === 'light'));
    btn.setAttribute('aria-label', t === 'dark' ? 'Switch to light mode' : 'Switch to dark mode');
    btn.querySelector('.theme-ico').textContent = t === 'dark' ? '☾' : '☀';
    btn.querySelector('.theme-txt').textContent = t === 'dark' ? 'Night' : 'Atlas';
    readPalette();
    Sky.rebuild(); Story.rebuild(); Near.rebuild(); Zoo.rebuild(); Found.rebuild(); Missions.rebuild(); Ending.rebuild();
    if (S.worldOpen) World.draw();
  }

  // ---------------------------------------------------------------- data
  function status(msg, isErr) {
    var el = $('status');
    if (!msg) { el.hidden = true; return; }
    el.hidden = false; el.textContent = msg; el.classList.toggle('err', !!isErr);
  }
  function val(x) { if (x && typeof x === 'object' && 'value' in x) x = x.value; return x; }
  function num(x) { x = val(x); if (x === null || x === undefined || x === '' || x === '%null%') return null; var n = +x; return isFinite(n) ? n : null; }
  function str(x) { x = val(x); return x === null || x === undefined || x === '%null%' ? '' : String(x); }

  function normalize(rows, keyed) {
    var out = [];
    rows.forEach(function (r) {
      var g = function (f) { return keyed ? r[f.key] : r[f.cap]; };
      var p = {};
      FIELDS.forEach(function (f) { p[f.key] = f.fn ? num(g(f)) : str(g(f)); });
      if (!p.name || p.ra == null || p.dec == null) return;
      p.year = p.year != null ? Math.round(p.year) : null;
      p.ly = p.pc != null ? p.pc * LY_PER_PC : null;
      p.radEst = p.radEst === 'Yes'; p.massEst = p.massEst === 'Yes'; p.tempEst = p.tempEst === 'Yes';
      out.push(p);
    });
    return out;
  }

  function loadLive() {
    return tableau.extensions.initializeAsync().then(function () {
      return tableau.extensions.workbook.getAllDataSourcesAsync();
    }).then(function (list) {
      var ds = list.find(function (d) { return /exoplanet|worlds/i.test(d.name); }) || list[0];
      if (!ds) throw new Error('No data source is connected to this app.');
      var q = function (withFn) {
        return ds.queryAsync({ fields: FIELDS.map(function (f) {
          var o = { fieldCaption: f.cap, fieldAlias: f.key };
          if (withFn && f.fn) o.function = f.fn;
          return o;
        }) });
      };
      return q(true).catch(function () { return q(false); });
    }).then(function (res) { return normalize(res.data || [], true); });
  }

  function loadDev() {
    return fetch('dev/planets.json').then(function (r) {
      if (!r.ok) throw new Error('Preview data missing (dev/planets.json).');
      return r.json();
    }).then(function (rows) { return normalize(rows, false); });
  }

  function index(planets) {
    S.planets = planets;
    S.total = planets.length;
    planets.forEach(function (p) {
      S.byName.set(p.name.toLowerCase(), p);
      if (!S.byHost.has(p.host)) S.byHost.set(p.host, []);
      S.byHost.get(p.host).push(p);
    });
    S.byHost.forEach(function (arr) { arr.sort(function (a, b) { return (a.period || 1e9) - (b.period || 1e9); }); });
    var yrs = planets.map(function (p) { return p.year; }).filter(function (y) { return y != null; });
    S.firstYear = d3.min(yrs); S.lastYear = d3.max(yrs);
    S.storyYear = S.firstYear;
  }

  // ---------------------------------------------------------------- sky geometry (shared)
  // Planets sit where their host star appears in our sky (RA/Dec on an equal-area all-sky map).
  function lonOf(ra) { var l = 330 - ra; return ((l + 540) % 360) - 180; } // sky seen from inside: RA grows to the left
  function makeProjection(w, h, pad) {
    pad = pad || { t: 20, r: 20, b: 20, l: 20 };
    return d3.geoEqualEarth().fitExtent([[pad.l, pad.t], [w - pad.r, h - pad.b]], { type: 'Sphere' });
  }

  // Seeded random so the background sky is the same every visit.
  function rng(seed) { return function () { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; }; }
  function gauss(r) { var u = 0, v = 0; while (u === 0) u = r(); v = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }

  // Galactic (l, b) -> equatorial (RA, Dec), J2000.
  var D2R = Math.PI / 180;
  function galToEq(l, b) {
    var aN = 192.85948 * D2R, dN = 27.12825 * D2R, lN = 122.93192 * D2R;
    l *= D2R; b *= D2R;
    var sd = Math.sin(dN) * Math.sin(b) + Math.cos(dN) * Math.cos(b) * Math.cos(lN - l);
    var y = Math.cos(b) * Math.sin(lN - l);
    var x = Math.cos(dN) * Math.sin(b) - Math.sin(dN) * Math.cos(b) * Math.cos(lN - l);
    var ra = (aN + Math.atan2(y, x)) / D2R; ra = ((ra % 360) + 360) % 360;
    return [ra, Math.asin(sd) / D2R];
  }

  var BG_STARS = (function () {
    var r = rng(7), out = [];
    for (var i = 0; i < 2600; i++) {
      var ra = r() * 360, dec = Math.asin(2 * r() - 1) / D2R;
      out.push({ ra: ra, dec: dec, m: Math.pow(r(), 3), tw: r() });
    }
    return out;
  })();
  var MILKY = (function () {
    var r = rng(42), out = [];
    for (var i = 0; i < 9000; i++) {
      var l = r() * 360;
      // denser and wider toward the galactic center (l = 0)
      var core = Math.cos(((l + 180) % 360 - 180) * D2R * 0.5);
      var b = gauss(r) * (3.5 + 6 * Math.max(0, core) * Math.max(0, core));
      if (r() > 0.35 + 0.65 * Math.max(0, core)) continue;
      out.push(galToEq(l, b).concat([r()]));
    }
    return out;
  })();

  function sizeOf(p, k) {
    k = k || 1;
    if (p.radius == null) return 0.75 * k;
    return Math.max(0.6, Math.min(3.4, 0.35 + 0.62 * Math.sqrt(p.radius))) * k;
  }

  function setupCanvas(cv) {
    var r = cv.getBoundingClientRect();
    var w = Math.max(1, r.width), h = Math.max(1, r.height);
    cv.width = Math.round(w * DPR); cv.height = Math.round(h * DPR);
    var ctx = cv.getContext('2d'); ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    return { ctx: ctx, w: w, h: h };
  }

  // Draws the sky backdrop (background stars, Milky Way, graticule) into ctx.
  function paintBackdrop(ctx, w, h, proj, opts) {
    opts = opts || {};
    ctx.fillStyle = PAL.bg; ctx.fillRect(0, 0, w, h);
    var path = d3.geoPath(proj, ctx);

    // sky outline + graticule
    ctx.save();
    ctx.beginPath(); path({ type: 'Sphere' });
    if (PAL.dark) {
      var g = ctx.createRadialGradient(w * 0.55, h * 0.5, 0, w * 0.55, h * 0.5, Math.max(w, h) * 0.6);
      g.addColorStop(0, 'rgba(40,60,130,0.10)'); g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g; ctx.fill();
    } else {
      ctx.fillStyle = 'rgba(255,252,244,0.55)'; ctx.fill();
    }
    ctx.clip();
    ctx.beginPath(); path(d3.geoGraticule().step([30, 30])());
    ctx.strokeStyle = PAL.dark ? 'rgba(160,180,255,0.05)' : 'rgba(80,60,30,0.10)';
    ctx.lineWidth = 0.6; ctx.stroke();

    // Milky Way (opts.faint dims it so data layers stay the hero)
    var mw = opts.faint ? 0.35 : 1;
    ctx.globalCompositeOperation = PAL.dark ? 'lighter' : 'multiply';
    ctx.globalAlpha = mw;
    for (var i = 0; i < MILKY.length; i++) {
      var m = MILKY[i], xy = proj([lonOf(m[0]), m[1]]);
      if (!xy) continue;
      ctx.fillStyle = PAL.dark ? 'rgba(130,150,230,' + (0.018 + 0.03 * m[2]) + ')' : 'rgba(165,135,90,' + (0.012 + 0.018 * m[2]) + ')';
      ctx.beginPath(); ctx.arc(xy[0], xy[1], 2 + 5 * m[2], 0, 6.283); ctx.fill();
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';

    // faint background stars
    if (!opts.noStars) {
      for (var j = 0; j < BG_STARS.length; j++) {
        var s = BG_STARS[j], p = proj([lonOf(s.ra), s.dec]);
        if (!p) continue;
        ctx.fillStyle = PAL.dark ? 'rgba(220,228,255,' + (0.08 + 0.35 * s.m) + ')' : 'rgba(60,50,35,' + (0.06 + 0.2 * s.m) + ')';
        ctx.fillRect(p[0], p[1], 0.6 + s.m, 0.6 + s.m);
      }
    }
    ctx.restore();

    ctx.beginPath(); path({ type: 'Sphere' });
    ctx.strokeStyle = PAL.dark ? 'rgba(160,180,255,0.12)' : 'rgba(80,60,30,0.28)';
    ctx.lineWidth = 1; ctx.stroke();
  }

  function dot(ctx, x, y, r, color, alpha, glow) {
    ctx.globalAlpha = alpha;
    if (glow && PAL.dark) {
      var g = ctx.createRadialGradient(x, y, 0, x, y, r * 4);
      g.addColorStop(0, color); g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, r * 4, 0, 6.283); ctx.fill();
    }
    ctx.fillStyle = color; ctx.beginPath(); ctx.arc(x, y, r, 0, 6.283); ctx.fill();
    ctx.globalAlpha = 1;
  }

  // ================================================================ 01 THE SKY
  var Sky = (function () {
    var cv, base, tree, proj, W, H, ctx, xy = [], mix = 1, mixFrom, raf = null, loopOn = false;

    function project() {
      proj = makeProjection(W, H, { t: 70, r: 24, b: 24, l: 24 });
      xy = S.planets.map(function (p) { return proj([lonOf(p.ra), p.dec]); });
      tree = d3.quadtree().x(function (i) { return xy[i][0]; }).y(function (i) { return xy[i][1]; })
        .addAll(S.planets.map(function (_, i) { return i; }).filter(function (i) { return xy[i]; }));
    }

    function rebuild() {
      if (!cv) return;
      var c = setupCanvas(cv); ctx = c.ctx; W = c.w; H = c.h;
      project();
      base = document.createElement('canvas'); base.width = cv.width; base.height = cv.height;
      var b = base.getContext('2d'); b.setTransform(DPR, 0, 0, DPR, 0, 0);
      paintBackdrop(b, W, H, proj);
      draw(0);
    }

    function matches(p) { return !S.question || S.question.test(p); }

    function draw(t) {
      if (!ctx) return;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.drawImage(base, 0, 0);
      ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
      var k = Math.max(0.8, Math.min(1.2, W / 1400));
      var q = S.question, n = S.planets.length;
      var alphaFor = function (question, p) { return question ? (question.test(p) ? 0.95 : 0.06) : 0.62; };
      // non-matching worlds fade back; matching ones come forward
      for (var i = 0; i < n; i++) {
        var p = S.planets[i], c = xy[i]; if (!c) continue;
        var on = matches(p);
        var a1 = alphaFor(q, p);
        var a = mixFrom === undefined ? a1 : alphaFor(mixFrom, p) + (a1 - alphaFor(mixFrom, p)) * mix;
        var tw = loopOn ? 0.88 + 0.12 * Math.sin(t / 900 + i * 1.7) : 1;
        dot(ctx, c[0], c[1], sizeOf(p, k) * (q && on ? 1.25 : 1), colorOf(p), a * tw, false);
      }
      if (S.hover != null) {
        var hp = S.planets[S.hover], hc = xy[S.hover];
        ctx.strokeStyle = PAL.ink; ctx.lineWidth = 1.2;
        ctx.beginPath(); ctx.arc(hc[0], hc[1], sizeOf(hp, k) + 6, 0, 6.283); ctx.stroke();
        ctx.globalAlpha = 0.35; ctx.beginPath(); ctx.arc(hc[0], hc[1], sizeOf(hp, k) + 12, 0, 6.283); ctx.stroke(); ctx.globalAlpha = 1;
      }
    }

    function frame(t) { draw(t); if (loopOn) raf = requestAnimationFrame(frame); }
    function startLoop() { if (REDUCED || loopOn) return; loopOn = true; raf = requestAnimationFrame(frame); }
    function stopLoop() { loopOn = false; if (raf) cancelAnimationFrame(raf); raf = null; draw(0); }

    function transition(from) {
      if (REDUCED) { mixFrom = undefined; draw(0); return; }
      mixFrom = from || null; mix = 0;
      var t0 = performance.now();
      (function step(now) {
        mix = d3.easeCubicOut(Math.min(1, (now - t0) / 700));
        if (!loopOn) draw(now);
        if (mix < 1) requestAnimationFrame(step); else { mixFrom = undefined; draw(now); }
      })(t0);
    }

    function nearest(mx, my) {
      var found = null, best = 14;
      tree.visit(function (node, x0, y0, x1, y1) {
        if (!node.length) {
          do {
            var i = node.data, c = xy[i];
            if (S.question && !S.question.test(S.planets[i])) continue;
            var d = Math.hypot(c[0] - mx, c[1] - my);
            if (d < best) { best = d; found = i; }
          } while ((node = node.next));
        }
        return x0 > mx + best || x1 < mx - best || y0 > my + best || y1 < my - best;
      });
      return found;
    }

    function showTip(i, mx, my) {
      var tip = $('tip');
      if (i == null) { tip.hidden = true; return; }
      var p = S.planets[i];
      tip.textContent = '';
      var h = document.createElement('strong'); h.textContent = p.name; tip.appendChild(h);
      row(tip, 'Size', p.radius != null ? sizeWords(p.radius) : 'not measured', p.radEst);
      row(tip, 'Distance', p.ly != null ? fmtLy(p.ly) : 'not measured');
      row(tip, 'Found', (p.year || '?') + ' · ' + shortMethod(p.method));
      var hint = document.createElement('div'); hint.className = 'hint'; hint.textContent = 'Click to visit'; tip.appendChild(hint);
      tip.hidden = false;
      var tw = tip.offsetWidth, th = tip.offsetHeight;
      var x = mx + 16, y = my + 16;
      if (x + tw > W - 8) x = mx - tw - 16;
      if (y + th > H - 8) y = my - th - 16;
      tip.style.left = x + 'px'; tip.style.top = y + 'px';
    }

    function init() {
      cv = $('skyCanvas');
      rebuild();
      cv.addEventListener('mousemove', function (e) {
        var r = cv.getBoundingClientRect(), mx = e.clientX - r.left, my = e.clientY - r.top;
        var i = nearest(mx, my);
        if (i !== S.hover) { S.hover = i; if (!loopOn) draw(0); }
        showTip(i, mx, my);
        cv.style.cursor = i != null ? 'pointer' : 'crosshair';
      });
      cv.addEventListener('mouseleave', function () { S.hover = null; showTip(null); if (!loopOn) draw(0); });
      cv.addEventListener('click', function () { if (S.hover != null) World.open(S.planets[S.hover], cv); });
      // twinkle only while the sky is on screen
      new IntersectionObserver(function (en) { en[0].isIntersecting ? startLoop() : stopLoop(); }, { threshold: 0.15 }).observe(cv);
    }

    return { init: init, rebuild: rebuild, transition: transition, draw: draw };
  })();

  function row(parent, k, v, est) {
    var d = document.createElement('div'); d.className = 'row';
    var a = document.createElement('span'); a.textContent = k;
    var b = document.createElement('b'); b.textContent = v;
    if (est) { var e = document.createElement('span'); e.className = 'est'; e.textContent = 'est.'; e.title = 'Estimated by NASA from other measurements'; b.appendChild(e); }
    d.appendChild(a); d.appendChild(b); parent.appendChild(d);
  }

  // ---------------------------------------------------------------- words
  function fmtLy(ly) {
    if (ly < 10) return ly.toFixed(1) + ' light-years';
    if (ly < 10000) return fmt(Math.round(ly)) + ' light-years';
    return fmt(Math.round(ly / 100) * 100) + ' light-years';
  }
  function sizeWords(r) {
    if (r < 0.95) return (r).toFixed(2) + '× Earth';
    if (r < 1.06) return 'about Earth’s size';
    if (r < 10) return r.toFixed(1) + '× Earth';
    return r.toFixed(0) + '× Earth';
  }
  function shortMethod(m) {
    return ({ 'Radial Velocity': 'star wobble', 'Transit': 'transit', 'Microlensing': 'microlensing', 'Imaging': 'direct image', 'Pulsar Timing': 'pulsar timing' })[m] || (m || '').toLowerCase();
  }
  function lightLeft(ly) {
    var y = Math.round(NOW_YEAR - ly);
    if (y > 0) return 'around ' + y;
    return 'around ' + fmt(1 - y) + ' BCE';
  }
  function periodWords(d) {
    if (d == null) return null;
    if (d < 2) return (d * 24).toFixed(0) + ' hours';
    if (d < 400) return d.toFixed(d < 10 ? 1 : 0) + ' days';
    var y = d / 365.25;
    return (y < 100 ? y.toFixed(1) : fmt(Math.round(y))) + ' Earth years';
  }

  // ================================================================ ask the sky (chips + finder)
  var Ask = (function () {
    function renderResult() {
      var el = $('askResult'); el.textContent = '';
      var q = S.question;
      var b = document.createElement('b');
      if (!q) {
        b.textContent = fmt(S.total);
        el.appendChild(b);
        el.appendChild(document.createTextNode(' confirmed worlds. Try a question above, or hover any light.'));
      } else {
        var n = S.planets.filter(q.test).length;
        b.textContent = fmt(n) + ' worlds';
        el.appendChild(b);
        el.appendChild(document.createTextNode(' ' + q.say));
      }
      renderNotable();
    }

    function renderNotable() {
      var list = $('notable'); list.textContent = '';
      var pool = S.planets.filter(function (p) { return p.ly != null && (!S.question || S.question.test(p)); });
      pool.sort(function (a, b) { return a.ly - b.ly; });
      $('notableTitle').textContent = S.question ? 'Closest ' + S.question.label.toLowerCase() + ' worlds' : 'Closest worlds';
      pool.slice(0, 5).forEach(function (p) {
        var li = document.createElement('li'), b = document.createElement('button');
        b.type = 'button';
        b.appendChild(document.createTextNode(p.name));
        var s = document.createElement('span'); s.textContent = p.ly < 100 ? p.ly.toFixed(1) + ' ly' : fmt(Math.round(p.ly)) + ' ly';
        b.appendChild(s);
        b.addEventListener('click', function () { World.open(p, b); });
        li.appendChild(b); list.appendChild(li);
      });
    }

    function init() {
      var wrap = $('chips');
      QUESTIONS.forEach(function (q) {
        var b = document.createElement('button');
        b.type = 'button'; b.className = 'chip'; b.textContent = q.label; b.setAttribute('aria-pressed', 'false');
        b.addEventListener('click', function () {
          var prev = S.question;
          S.question = prev === q ? null : q;
          wrap.querySelectorAll('.chip').forEach(function (c) { c.setAttribute('aria-pressed', 'false'); });
          if (S.question) b.setAttribute('aria-pressed', 'true');
          Sky.transition(prev);
          renderResult();
        });
        wrap.appendChild(b);
      });
      renderResult();
      initSearch();
      $('surprise').addEventListener('click', function () {
        var pool = S.planets.filter(function (p) { return p.radius != null && p.ly != null && (!S.question || S.question.test(p)); });
        if (pool.length) World.open(pool[Math.floor(Math.random() * pool.length)], $('surprise'));
      });
    }

    function initSearch() {
      var input = $('search'), box = $('suggest'), items = [], sel = -1;
      function close() { box.hidden = true; input.setAttribute('aria-expanded', 'false'); sel = -1; }
      function render() {
        var q = input.value.trim().toLowerCase();
        box.textContent = ''; items = [];
        if (q.length < 2) { close(); return; }
        for (var i = 0; i < S.planets.length && items.length < 8; i++) {
          var p = S.planets[i];
          if (p.name.toLowerCase().indexOf(q) !== -1 || p.host.toLowerCase().indexOf(q) !== -1) items.push(p);
        }
        items.sort(function (a, b) { return a.name.toLowerCase().indexOf(q) - b.name.toLowerCase().indexOf(q) || a.name.length - b.name.length; });
        if (!items.length) { var li0 = document.createElement('li'); li0.textContent = 'No world by that name (yet).'; box.appendChild(li0); }
        items.forEach(function (p, k) {
          var li = document.createElement('li');
          li.id = 'sg-' + k; li.setAttribute('role', 'option'); li.setAttribute('aria-selected', 'false');
          li.textContent = p.name;
          var s = document.createElement('small'); s.textContent = p.year || ''; li.appendChild(s);
          li.addEventListener('mousedown', function (e) { e.preventDefault(); pick(p); });
          box.appendChild(li);
        });
        box.hidden = false; input.setAttribute('aria-expanded', 'true');
      }
      function mark() {
        Array.prototype.forEach.call(box.children, function (li, k) { li.setAttribute('aria-selected', String(k === sel)); });
        if (sel >= 0) input.setAttribute('aria-activedescendant', 'sg-' + sel); else input.removeAttribute('aria-activedescendant');
      }
      function pick(p) { close(); input.value = ''; World.open(p, input); }
      input.addEventListener('input', render);
      input.addEventListener('blur', close);
      input.addEventListener('keydown', function (e) {
        if (e.key === 'ArrowDown') { sel = Math.min(items.length - 1, sel + 1); mark(); e.preventDefault(); }
        else if (e.key === 'ArrowUp') { sel = Math.max(0, sel - 1); mark(); e.preventDefault(); }
        else if (e.key === 'Enter') { var p = items[sel >= 0 ? sel : 0]; if (p) pick(p); }
        else if (e.key === 'Escape') close();
      });
    }

    return { init: init };
  })();

  // ================================================================ 02 THE DISCOVERY STORY
  var Story = (function () {
    var cv, ctx, W, H, proj, base, xy = [], rib, rctx, RW, RH, counts = [], cum = new Map(), byYear = new Map(), started = false, timer = null;
    var GROUP_COLORS;

    function milestones() {
      var peg = S.byName.get('51 peg b');
      var maxYear = 0, maxN = 0;
      byYear.forEach(function (arr, y) { if (arr.length > maxN) { maxN = arr.length; maxYear = y; } });
      var early = S.planets.filter(function (p) { return p.year != null && p.year <= 2008; });
      var rvShare = early.length ? Math.round(100 * early.filter(function (p) { return p.method === 'Radial Velocity'; }).length / early.length) : 0;
      var k14 = (byYear.get(2014) || []).filter(function (p) { return p.facility === 'Kepler'; }).length;
      var tess = S.planets.filter(function (p) { return /TESS/.test(p.facility); }).length;
      var list = [
        { year: S.firstYear, tag: 'The first', title: 'The first worlds orbit a dead star.', clip: 0,
          body: 'Two planets are found circling PSR B1257+12, a pulsar: the spinning, collapsed core of an exploded star. Nobody expected planets there.',
          focus: S.byName.get('psr b1257+12 c') },
        { year: 1995, tag: '1995', title: 'A planet around a star like the Sun.', clip: 1,
          body: '51 Pegasi b is a giant world that circles its star in ' + (peg && peg.period ? peg.period.toFixed(1) : 'about four') + ' days, closer than Mercury is to our Sun. It’s found by the tiny wobble it causes in its star.',
          focus: peg },
        { year: 2004, tag: '2000s', title: 'The wobble era.', clip: 2,
          body: 'Through 2008, ' + rvShare + '% of known worlds are found by watching stars wobble. Big planets, close in, are the easiest to catch.' },
        { year: 2009, tag: '2009', title: 'A telescope that stares at one patch of sky.', clip: 3,
          body: 'NASA’s Kepler launches and watches about 150,000 stars at once, waiting for the tiny dip in light when a planet passes in front.' },
        { year: 2014, tag: '2014', title: 'Hundreds at once.', clip: 4,
          body: 'Kepler’s planets start to be confirmed in batches. ' + fmt(k14) + ' Kepler worlds are added in 2014 alone.' },
        { year: maxYear, tag: String(maxYear), title: 'The biggest year yet.', clip: 5,
          body: fmt(maxN) + ' worlds are confirmed in ' + maxYear + ', ' + (function () {
            var before = S.planets.filter(function (p) { return p.year != null && p.year < maxYear; }).length;
            if (maxN > before) return 'more than every year before it combined.';
            if (maxN > 0.6 * before) return 'almost as many as every year before it combined.';
            return 'the most ever in a single year.';
          })() + ' Most come from Kepler, confirmed in bulk.' },
        { year: 2018, tag: '2018', title: 'Kepler retires. TESS takes the whole sky.', clip: 6,
          body: 'TESS launches to survey nearly the entire sky, looking at bright, nearby stars. It has found ' + fmt(tess) + ' of the worlds here so far.' },
        { year: S.lastYear, tag: 'Today', title: fmt(S.total) + ' worlds. And counting.', clip: 7,
          body: 'In a little over three decades we went from zero to ' + fmt(S.total) + '. Most are worlds we can’t see directly: only shadows, wobbles and bent light.' }
      ];
      // keep milestones in order and inside the data range; drop the "biggest year" if it collides with another
      var seen = {};
      return list.filter(function (m) {
        if (m.year < S.firstYear || m.year > S.lastYear || seen[m.year]) return false;
        seen[m.year] = 1; return true;
      }).sort(function (a, b) { return a.year - b.year; });
    }
    var MS = [];

    function rebuild() {
      if (!cv) return;
      GROUP_COLORS = PAL.dark ? ['#9cc2ff', '#ffc27a', '#c69cff', '#7fe0c4', '#8a8fb3'] : ['#23468f', '#b06a12', '#6b3fa0', '#1f7a62', '#8a8796'];
      var c = setupCanvas(cv); ctx = c.ctx; W = c.w; H = c.h;
      var pad = { t: 10, r: 10, b: 10, l: W < 600 ? 10 : Math.min(260, W * 0.22) };
      proj = makeProjection(W, H, pad);
      xy = S.planets.map(function (p) { return proj([lonOf(p.ra), p.dec]); });
      base = document.createElement('canvas'); base.width = cv.width; base.height = cv.height;
      var b = base.getContext('2d'); b.setTransform(DPR, 0, 0, DPR, 0, 0);
      paintBackdrop(b, W, H, proj, { noStars: false });
      var rc = setupCanvas(rib); rctx = rc.ctx; RW = rc.w; RH = rc.h;
      renderKey(); placeMilestones();
      draw(S.storyYear, 1);
    }

    function draw(year, flash) {
      if (!ctx) return;
      ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.drawImage(base, 0, 0); ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
      var k = Math.max(0.75, Math.min(1.1, W / 1500));
      for (var i = 0; i < S.planets.length; i++) {
        var p = S.planets[i], c = xy[i];
        if (!c || p.year == null || p.year > year) continue;
        var isNew = p.year === year;
        if (isNew) dot(ctx, c[0], c[1], sizeOf(p, k) * (1 + 0.9 * flash), colorOf(p), 1, true);
        else dot(ctx, c[0], c[1], sizeOf(p, k), colorOf(p), 0.55, false);
      }
      var m = MS.find(function (x) { return x.year === year; });
      if (m && m.focus) annotate(m.focus);
      drawRibbon(year);
      var n = cum.get(year) || 0;
      $('storyYear').textContent = year;
      $('storyCount').textContent = fmt(n);
      $('yearRange').value = year;
      $('yearRange').setAttribute('aria-valuetext', year + ': ' + fmt(n) + ' worlds known');
    }

    function annotate(p) {
      var c = proj([lonOf(p.ra), p.dec]); if (!c) return;
      ctx.strokeStyle = PAL.ink; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.arc(c[0], c[1], 14, 0, 6.283); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(c[0] + 10, c[1] - 10); ctx.lineTo(c[0] + 40, c[1] - 40); ctx.lineTo(c[0] + 52, c[1] - 40); ctx.stroke();
      ctx.fillStyle = PAL.ink; ctx.font = '13px ' + getComputedStyle(document.body).fontFamily;
      ctx.fillText(p.host, c[0] + 58, c[1] - 36);
    }

    function drawRibbon(year) {
      if (!rctx) return;
      rctx.clearRect(0, 0, RW, RH);
      var x = d3.scaleBand().domain(d3.range(S.firstYear, S.lastYear + 1)).range([0, RW]).paddingInner(0.18);
      var max = d3.max(counts, function (c) { return c.total; }) || 1;
      var y = d3.scaleLinear().domain([0, max]).range([0, RH - 6]);
      counts.forEach(function (c) {
        var h0 = 0, x0 = x(c.year), bw = x.bandwidth();
        var past = c.year <= year;
        c.parts.forEach(function (v, gi) {
          if (!v) return;
          var hh = y(v);
          rctx.fillStyle = GROUP_COLORS[gi];
          rctx.globalAlpha = past ? (c.year === year ? 1 : 0.75) : 0.13;
          rctx.fillRect(x0, RH - h0 - hh, bw, Math.max(hh, 1.5));
          h0 += hh;
        });
      });
      rctx.globalAlpha = 1;
      var cx = x(year) + x.bandwidth() / 2;
      rctx.strokeStyle = PAL.ink; rctx.lineWidth = 1; rctx.beginPath(); rctx.moveTo(cx, 0); rctx.lineTo(cx, RH); rctx.stroke();
    }

    function renderKey() {
      var el = $('ribbonKey'); el.textContent = '';
      var lead = document.createElement('span'); lead.textContent = 'Each bar is one year of discoveries, by how they were found:'; el.appendChild(lead);
      METHOD_GROUPS.forEach(function (g, i) {
        var s = document.createElement('span'), dotEl = document.createElement('i');
        dotEl.style.background = GROUP_COLORS[i]; s.appendChild(dotEl); s.appendChild(document.createTextNode(g.label)); el.appendChild(s);
      });
    }

    function placeMilestones() {
      var el = $('milestones'); el.textContent = '';
      var span = S.lastYear - S.firstYear || 1;
      MS.forEach(function (m) {
        var b = document.createElement('button'); b.type = 'button'; b.textContent = m.tag;
        b.style.left = ((m.year - S.firstYear + 0.5) / (span + 1) * 100) + '%';
        b.setAttribute('aria-label', 'Jump to ' + m.year + ': ' + m.title);
        b.addEventListener('click', function () { stop(); go(m.year, true); });
        el.appendChild(b);
      });
    }

    function caption(year) {
      var el = $('caption');
      var m = MS.slice().reverse().find(function (x) { return x.year <= year; });
      var key = m ? m.year : 'none';
      if (el.dataset.key === String(key)) return;
      el.dataset.key = key;
      el.classList.add('hide');
      setTimeout(function () {
        el.textContent = '';
        if (!m) return;
        var t = document.createElement('div'); t.className = 'cap-year'; t.textContent = m.year === S.lastYear ? 'Today' : String(m.year);
        var h = document.createElement('h3'); h.textContent = m.title;
        var p = document.createElement('p'); p.textContent = m.body;
        el.appendChild(t); el.appendChild(h); el.appendChild(p);
        el.classList.remove('hide');
      }, REDUCED ? 0 : 260);
      $('milestones').querySelectorAll('button').forEach(function (b, i) { b.classList.toggle('on', MS[i] === m); });
    }

    // ---- narration: one continuous track (base64 mp3 via Web Audio), on by default, can be turned off
    var actx = null, abuf = null, asrc = null, narrate = true, tOff = 0, tStart = 0, tPos = 0, tDone = false;
    function stopAudio() { var s = asrc; asrc = null; if (s) { try { s.stop(); } catch (e) {} } }
    function loadTrack() {
      if (abuf) return abuf;
      var b64 = window.WORLDS_NARRATION; if (!b64 || !actx) return null;
      var bin = atob(b64), u = new Uint8Array(bin.length);
      for (var k = 0; k < bin.length; k++) u[k] = bin.charCodeAt(k);
      abuf = actx.decodeAudioData(u.buffer.slice(0)); return abuf;
    }
    function startTrack(offsetFn) {
      stopAudio();
      if (!narrate || !actx) return;
      var pr = loadTrack(); if (!pr) return;
      pr.then(function (buf) {
        if (!narrate || !S.playing) return;
        stopAudio();
        var off = Math.max(0, Math.min(buf.duration - 0.5, offsetFn(buf)));
        var src = actx.createBufferSource(); src.buffer = buf; src.connect(actx.destination);
        tOff = off; tStart = actx.currentTime; src.start(0, off); asrc = src;
        src.onended = function () { if (asrc === src) { asrc = null; tDone = true; } };
      }).catch(function () {});
    }
    function pauseTrack() { if (asrc) { tPos = tOff + actx.currentTime - tStart; } stopAudio(); }
    function setNarrate(on) {
      narrate = on;
      if (on) {
        if (!actx) { var AC = window.AudioContext || window.webkitAudioContext; if (!AC) { narrate = false; return; } actx = new AC(); }
        if (actx.state === 'suspended') actx.resume();
        loadTrack();
        if (S.playing) startTrack(function (buf) { return (S.storyYear - S.firstYear) / (S.lastYear - S.firstYear) * buf.duration * 0.8; });
      } else { pauseTrack(); }
      var b = $('narrate'); if (b) { b.setAttribute('aria-pressed', String(narrate)); b.textContent = narrate ? 'Narration: on' : 'Narration: off'; }
    }

    function go(year, animateFlash) {
      S.storyYear = year;
      caption(year);
      if (REDUCED || !animateFlash) { draw(year, 0); return; }
      var t0 = performance.now();
      (function step(now) {
        var f = 1 - Math.min(1, (now - t0) / (900 * SPEED));
        if (S.storyYear !== year) return;
        draw(year, f);
        if (f > 0) requestAnimationFrame(step);
      })(t0);
    }

    function play() {
      var fresh = S.storyYear >= S.lastYear || S.storyYear <= S.firstYear;
      if (fresh) { S.storyYear = S.firstYear - 1; tPos = 0; tDone = false; }
      S.playing = true; setPlayBtn();
      if (!tDone) startTrack(function () { return tPos; });
      (function tick() {
        if (!S.playing) return;
        var y = S.storyYear + 1;
        if (y > S.lastYear) { stop(true); return; }
        go(y, true);
        var isMs = MS.some(function (m) { return m.year === y; });
        var dwell = isMs ? 6500 : 1250;
        timer = setTimeout(tick, dwell * SPEED);
      })();
    }
    function stop(letVoiceFinish) { S.playing = false; clearTimeout(timer); if (letVoiceFinish !== true) pauseTrack(); setPlayBtn(); }
    function setPlayBtn() {
      var b = $('play');
      b.querySelector('.play-ico').textContent = S.playing ? '❚❚' : '▶';
      b.querySelector('.play-txt').textContent = S.playing ? 'Pause' : (S.storyYear >= S.lastYear ? 'Replay' : 'Play');
      b.setAttribute('aria-label', S.playing ? 'Pause the discovery story' : 'Play the discovery story');
    }

    function init() {
      cv = $('storyCanvas'); rib = $('ribbon');
      S.planets.forEach(function (p) {
        if (p.year == null) return;
        if (!byYear.has(p.year)) byYear.set(p.year, []);
        byYear.get(p.year).push(p);
      });
      var run = 0;
      for (var y = S.firstYear; y <= S.lastYear; y++) {
        var arr = byYear.get(y) || [];
        run += arr.length; cum.set(y, run);
        var parts = METHOD_GROUPS.map(function () { return 0; });
        arr.forEach(function (p) {
          for (var g = 0; g < METHOD_GROUPS.length; g++) if (METHOD_GROUPS[g].match(p.method)) { parts[g]++; break; }
        });
        counts.push({ year: y, total: arr.length, parts: parts });
      }
      MS = milestones();
      $('storyStart').textContent = S.firstYear - 1 >= 1990 ? (S.firstYear - 1) : S.firstYear;
      var range = $('yearRange'); range.min = S.firstYear; range.max = S.lastYear;
      range.addEventListener('input', function () { stop(); go(+range.value, false); });
      $('play').addEventListener('click', function () { if (actx && actx.state === 'suspended') actx.resume(); S.playing ? stop() : play(); });
      var sp = $('speed'), PACES = [[1, 'Pace: steady'], [2, 'Pace: slower'], [0.5, 'Pace: quicker']], pi = 0;
      sp.addEventListener('click', function () { pi = (pi + 1) % PACES.length; SPEED = PACES[pi][0]; sp.textContent = PACES[pi][1]; });
      var nb = $('narrate');
      if (nb && window.WORLDS_NARRATION) {
        nb.addEventListener('click', function () { setNarrate(!narrate); });
        setNarrate(true);
        var wake = function () { if (actx && actx.state === 'suspended') actx.resume(); };
        ['pointerdown', 'keydown', 'touchstart'].forEach(function (ev) { document.addEventListener(ev, wake, { passive: true }); });
      } else { narrate = false; if (nb) nb.hidden = true; }
      rebuild();
      caption(S.storyYear);
      if (REDUCED) { go(S.lastYear, false); setPlayBtn(); }
      else {
        new IntersectionObserver(function (en) {
          if (en[0].isIntersecting && !started && (!narrate || (actx && actx.state === 'running'))) { started = true; setTimeout(play, 1200); }
          if (!en[0].isIntersecting && S.playing) stop();
        }, { threshold: 0.45 }).observe($('story'));
      }
    }

    return { init: init, rebuild: rebuild };
  })();

  // ================================================================ 09 ONE WORLD
  var World = (function () {
    var p = null, returnFocus = null, raf = null, t0 = 0;

    function fact(dl, label, value, note, est) {
      var d = document.createElement('div');
      var dt = document.createElement('dt'); dt.textContent = label;
      var dd = document.createElement('dd'); dd.textContent = value;
      if (est) { var e = document.createElement('span'); e.className = 'est'; e.textContent = 'est.'; e.title = 'Estimated by NASA from other measurements'; dd.appendChild(e); }
      if (note) { var s = document.createElement('small'); s.textContent = note; dd.appendChild(s); }
      d.appendChild(dt); d.appendChild(dd); dl.appendChild(d);
    }

    function fill() {
      $('wName').textContent = p.name;
      var sib = S.byHost.get(p.host) || [p];
      $('wHost').textContent = sib.length > 1
        ? 'One of ' + sib.length + ' known planets around ' + p.host + '.'
        : 'The only known planet around ' + p.host + '.';
      var dl = $('wFacts'); dl.textContent = '';
      fact(dl, 'Size', p.radius != null ? sizeWords(p.radius) : 'Not measured',
        p.radius != null ? (p.radius >= 8 ? (p.radius / 11.21).toFixed(1) + '× Jupiter’s width' : 'Width compared with Earth') : null, p.radEst);
      fact(dl, 'Mass', p.mass != null ? (p.mass < 10 ? p.mass.toFixed(1) : fmt(Math.round(p.mass))) + '× Earth' : 'Not measured', null, p.massEst);
      fact(dl, 'A year here lasts', periodWords(p.period) || 'Unknown', p.period != null ? 'One trip around its star' : null);
      fact(dl, 'Temperature', p.temp != null ? fmt(Math.round(p.temp)) + ' K (' + fmt(Math.round(p.temp - 273.15)) + ' °C)' : 'Not measured',
        p.temp != null ? 'Equilibrium estimate from starlight, not the surface' : null, p.tempEst);
      fact(dl, 'Distance', p.ly != null ? fmtLy(p.ly) : 'Not measured');
      fact(dl, 'Discovered', (p.year || '?') + ' · ' + shortMethod(p.method), p.facility || null);
      fact(dl, 'Its star', p.starTemp != null ? fmt(Math.round(p.starTemp)) + ' K' : 'Temperature unknown',
        p.starRad != null ? p.starRad.toFixed(2) + '× the Sun’s width' : null);
      fact(dl, 'Planets in system', p.sys != null ? String(p.sys) : String(sib.length));
      $('wLight').textContent = p.ly != null
        ? 'The light reaching us from ' + p.host + ' tonight left it ' + lightLeft(p.ly) + '.'
        : 'We don’t yet know exactly how far away ' + p.host + ' is.';
      $('wClose').textContent = 'One of ' + fmt(S.total) + ' known worlds.';
      var idx = sib.indexOf(p);
      $('wPrev').hidden = $('wNext').hidden = sib.length < 2;
      $('wPrev').disabled = idx <= 0; $('wNext').disabled = idx >= sib.length - 1;
      $('wScale').textContent = p.radius != null ? 'Shown to scale with Earth' : 'Size not measured, so the outline is a placeholder';
    }

    function starColor(t) {
      if (t == null) return '#ffe9c4';
      return d3.scaleLinear().domain([3000, 4500, 5800, 7500, 10000]).range(['#ff9a5a', '#ffc78a', '#fff1d6', '#e7efff', '#b9d0ff']).clamp(true)(t);
    }

    function draw(now) {
      var cv = $('worldCanvas'); var c = setupCanvas(cv), ctx = c.ctx, w = c.w, h = c.h;
      var t = REDUCED ? 0 : ((now || 0) - t0) / 1000;
      ctx.clearRect(0, 0, w, h);
      // host star glow from the upper left
      var sc = starColor(p.starTemp);
      var g = ctx.createRadialGradient(-w * 0.1, -h * 0.05, 0, -w * 0.1, -h * 0.05, Math.max(w, h) * 0.9);
      g.addColorStop(0, sc); g.addColorStop(0.08, d3.color(sc).copy({ opacity: PAL.dark ? 0.35 : 0.5 }) + '');
      g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
      // stars
      var r = rng(p.name.length * 977 + (p.year || 0));
      for (var i = 0; i < 160; i++) {
        ctx.fillStyle = PAL.dark ? 'rgba(230,236,255,' + (0.1 + 0.5 * r()) + ')' : 'rgba(60,50,35,' + (0.08 + 0.2 * r()) + ')';
        ctx.fillRect(r() * w, r() * h, 1, 1);
      }
      // sizes: planet and Earth to scale, capped to fit the panel
      var cx = w * 0.56, cy = h * 0.5, maxR = Math.min(w, h) * 0.36;
      var pr = p.radius != null ? p.radius : null;
      var scale = pr != null ? Math.min(maxR / Math.max(pr, 1), maxR * 0.42) : maxR * 0.5;
      var R = pr != null ? pr * scale : maxR * 0.7;
      var eR = 1 * scale;
      var col = colorOf(p);
      if (pr != null) {
        var body = ctx.createRadialGradient(cx - R * 0.45, cy - R * 0.45, R * 0.05, cx, cy, R);
        body.addColorStop(0, d3.color(col).brighter(0.8) + '');
        body.addColorStop(0.55, col);
        body.addColorStop(1, d3.color(col).darker(PAL.dark ? 2.6 : 1.6) + '');
        ctx.fillStyle = body; ctx.beginPath(); ctx.arc(cx, cy, R, 0, 6.283); ctx.fill();
        // soft bands that drift, for texture (purely decorative)
        ctx.save(); ctx.beginPath(); ctx.arc(cx, cy, R, 0, 6.283); ctx.clip();
        ctx.globalAlpha = PAL.dark ? 0.045 : 0.035;
        for (var b = -5; b <= 5; b++) {
          ctx.fillStyle = b % 2 ? '#000' : '#fff';
          var off = Math.sin(t * 0.3 + b) * R * 0.04;
          ctx.fillRect(cx - R, cy + b * R * 0.18 + off, R * 2, R * 0.07);
        }
        ctx.restore();
        // night side
        var shade = ctx.createLinearGradient(cx - R, cy - R, cx + R, cy + R);
        shade.addColorStop(0.45, 'rgba(0,0,0,0)'); shade.addColorStop(1, 'rgba(0,0,0,' + (PAL.dark ? 0.75 : 0.45) + ')');
        ctx.fillStyle = shade; ctx.beginPath(); ctx.arc(cx, cy, R, 0, 6.283); ctx.fill();
        // atmosphere rim
        ctx.strokeStyle = d3.color(col).copy({ opacity: 0.35 }) + ''; ctx.lineWidth = Math.max(1, R * 0.03);
        ctx.beginPath(); ctx.arc(cx, cy, R * 1.01, Math.PI * 0.9, Math.PI * 1.75); ctx.stroke();
      } else {
        ctx.setLineDash([4, 6]); ctx.strokeStyle = PAL.ink3; ctx.lineWidth = 1.2;
        ctx.beginPath(); ctx.arc(cx, cy, R, 0, 6.283); ctx.stroke(); ctx.setLineDash([]);
      }
      // Earth for scale
      if (pr != null) {
        var ex = Math.min(w - eR - 24, cx + R + Math.max(eR, 10) + 26), ey = cy + R - eR;
        if (ex - eR < cx + R + 6) { ex = cx; ey = cy + R + eR + 22; }
        var eg = ctx.createRadialGradient(ex - eR * 0.4, ey - eR * 0.4, eR * 0.1, ex, ey, eR);
        eg.addColorStop(0, '#9fd3ff'); eg.addColorStop(0.6, '#2f6fbf'); eg.addColorStop(1, '#0d2244');
        ctx.fillStyle = eg; ctx.beginPath(); ctx.arc(ex, ey, Math.max(eR, 1.2), 0, 6.283); ctx.fill();
        ctx.fillStyle = PAL.ink2; ctx.font = '12px ' + getComputedStyle(document.body).fontFamily;
        ctx.textAlign = 'center'; ctx.fillText('Earth', ex, ey + Math.max(eR, 2) + 16); ctx.textAlign = 'left';
      }
      if (!REDUCED && S.worldOpen) raf = requestAnimationFrame(draw);
    }

    function open(planet, from) {
      p = planet; S.worldOpen = p;
      returnFocus = from || document.activeElement;
      var dlg = $('world'); dlg.hidden = false;
      fill(); t0 = performance.now();
      cancelAnimationFrame(raf); draw(t0);
      dlg.querySelector('.world-panel').focus();
      document.body.style.overflow = 'hidden';
    }
    function close() {
      S.worldOpen = null; cancelAnimationFrame(raf);
      $('world').hidden = true; document.body.style.overflow = '';
      if (returnFocus && returnFocus.focus) returnFocus.focus();
    }
    function step(d) {
      var sib = S.byHost.get(p.host) || []; var i = sib.indexOf(p) + d;
      if (sib[i]) { p = sib[i]; S.worldOpen = p; fill(); }
    }
    function init() {
      $('world').addEventListener('click', function (e) { if (e.target.hasAttribute('data-close')) close(); });
      $('wPrev').addEventListener('click', function () { step(-1); });
      $('wNext').addEventListener('click', function () { step(1); });
      $('wRandom').addEventListener('click', function () {
        var pool = S.planets.filter(function (x) { return x.radius != null && x.ly != null; });
        p = pool[Math.floor(Math.random() * pool.length)]; S.worldOpen = p; fill();
      });
      document.addEventListener('keydown', function (e) {
        if (!S.worldOpen) return;
        if (e.key === 'Escape') close();
        if (e.key === 'Tab') { // keep focus inside the dialog
          var f = Array.prototype.filter.call($('world').querySelectorAll('button:not([disabled]):not([hidden])'), function (b) { return b.offsetParent; });
          if (!f.length) return;
          var first = f[0], last = f[f.length - 1];
          if (e.shiftKey && document.activeElement === first) { last.focus(); e.preventDefault(); }
          else if (!e.shiftKey && document.activeElement === last) { first.focus(); e.preventDefault(); }
        }
      });
    }
    return { init: init, open: open, draw: function () { if (p) draw(performance.now()); } };
  })();


  // ================================================================ 05 NEIGHBORS
  // Distance view: Earth at the center, log rings, angle = direction (RA). Honest about what "Earth-ish" means.
  var Near = (function () {
    var cv, ctx, W, H, cx, cy, R, pts = [], tree, mode = 'size', hover = null;
    var MODES = [
      { id: 'size', label: 'Similar size', test: function (p) { return p.radius != null && p.radius >= 0.8 && p.radius <= 1.25; },
        say: 'planets between 0.8 and 1.25× Earth’s width.' },
      { id: 'temp', label: 'Similar temperature', test: function (p) { return p.temp != null && p.temp >= 230 && p.temp <= 300; },
        say: 'planets whose equilibrium temperature is 230–300 K. Earth’s is about 255 K. This is a calculation from starlight, not a surface reading.' },
      { id: 'both', label: 'Both', test: function (p) { return p.radius != null && p.temp != null && p.radius >= 0.8 && p.radius <= 1.25 && p.temp >= 230 && p.temp <= 300; },
        say: 'planets that match on size and on temperature. Very few do, and none is a promise of anything.' }
    ];
    var rScale = d3.scaleLog().domain([2, 30000]).range([0.05, 1]).clamp(true);

    function cur() { return MODES.filter(function (m) { return m.id === mode; })[0]; }

    function layout() {
      var c = setupCanvas(cv); ctx = c.ctx; W = c.w; H = c.h;
      cx = W / 2; cy = H / 2; R = Math.max(Math.min(W, H) / 2 - 34, 20);
      pts = S.planets.map(function (p) {
        if (p.ly == null) return null;
        var a = (330 - p.ra) * D2R, r = rScale(p.ly) * R;
        return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
      });
      tree = d3.quadtree().x(function (i) { return pts[i][0]; }).y(function (i) { return pts[i][1]; })
        .addAll(S.planets.map(function (_, i) { return i; }).filter(function (i) { return pts[i]; }));
    }

    function draw() {
      if (!ctx) return;
      ctx.clearRect(0, 0, W, H);
      var rings = [[10, '10 ly'], [100, '100 ly'], [1000, '1,000 ly'], [10000, '10,000 ly']];
      ctx.lineWidth = 1; ctx.font = '11px ' + getComputedStyle(document.body).fontFamily;
      rings.forEach(function (rg) {
        var r = rScale(rg[0]) * R;
        ctx.strokeStyle = PAL.line; ctx.beginPath(); ctx.arc(cx, cy, r, 0, 6.283); ctx.stroke();
        ctx.textAlign = 'center'; ctx.lineWidth = 3; ctx.strokeStyle = PAL.bg; ctx.strokeText(rg[1], cx, cy - r - 5); ctx.lineWidth = 1; ctx.fillStyle = PAL.ink2; ctx.fillText(rg[1], cx, cy - r - 5);
      });
      ctx.textAlign = 'left';
      var m = cur(), k = Math.max(0.8, Math.min(1.15, W / 900));
      var dim = [], lit = [];
      S.planets.forEach(function (p, i) { if (pts[i]) (m.test(p) ? lit : dim).push(i); });
      dim.forEach(function (i) { dot(ctx, pts[i][0], pts[i][1], Math.max(0.8, sizeOf(S.planets[i], k) * 0.7), colorOf(S.planets[i]), 0.28, false); });
      lit.forEach(function (i) {
        var p = S.planets[i];
        ctx.strokeStyle = PAL.ink; ctx.globalAlpha = 0.5; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.arc(pts[i][0], pts[i][1], sizeOf(p, k) + 5, 0, 6.283); ctx.stroke(); ctx.globalAlpha = 1;
        dot(ctx, pts[i][0], pts[i][1], sizeOf(p, k) + 0.8, colorOf(p), 1, true);
      });
      // Earth at the center
      var eg = ctx.createRadialGradient(cx - 2, cy - 2, 1, cx, cy, 8);
      eg.addColorStop(0, '#9fd3ff'); eg.addColorStop(1, '#1f5fb5');
      ctx.fillStyle = eg; ctx.beginPath(); ctx.arc(cx, cy, 7, 0, 6.283); ctx.fill();
      ctx.fillStyle = PAL.ink; ctx.font = '12px ' + getComputedStyle(document.body).fontFamily;
      ctx.fillText('You are here', cx + 14, cy + 4);
      if (hover != null) {
        ctx.strokeStyle = PAL.ink; ctx.lineWidth = 1.4; ctx.beginPath(); ctx.arc(pts[hover][0], pts[hover][1], 9, 0, 6.283); ctx.stroke();
      }
    }

    function result() {
      var m = cur(), hits = S.planets.filter(m.test);
      var el = $('nearResult'); el.textContent = '';
      var b = document.createElement('b'); b.textContent = fmt(hits.length) + ' worlds'; el.appendChild(b);
      el.appendChild(document.createTextNode(' — ' + m.say));
      var list = $('nearList'); list.textContent = '';
      hits.filter(function (p) { return p.ly != null; }).sort(function (a, b) { return a.ly - b.ly; }).slice(0, 5).forEach(function (p) {
        var li = document.createElement('li'), bt = document.createElement('button'); bt.type = 'button';
        bt.appendChild(document.createTextNode(p.name));
        var s = document.createElement('span'); s.textContent = (p.ly < 100 ? p.ly.toFixed(1) : fmt(Math.round(p.ly))) + ' ly'; bt.appendChild(s);
        bt.addEventListener('click', function () { World.open(p, bt); });
        li.appendChild(bt); list.appendChild(li);
      });
    }

    function nearest(mx, my) {
      var best = 12, found = null;
      tree.visit(function (node, x0, y0, x1, y1) {
        if (!node.length) { do { var i = node.data, d = Math.hypot(pts[i][0] - mx, pts[i][1] - my); if (d < best) { best = d; found = i; } } while ((node = node.next)); }
        return x0 > mx + best || x1 < mx - best || y0 > my + best || y1 < my - best;
      });
      return found;
    }

    function init() {
      cv = $('nearCanvas'); layout();
      var wrap = $('nearChips');
      MODES.forEach(function (m) {
        var b = document.createElement('button'); b.type = 'button'; b.className = 'chip'; b.textContent = m.label;
        b.setAttribute('aria-pressed', String(m.id === mode));
        b.addEventListener('click', function () {
          mode = m.id; wrap.querySelectorAll('.chip').forEach(function (c) { c.setAttribute('aria-pressed', 'false'); });
          b.setAttribute('aria-pressed', 'true'); result(); draw();
        });
        wrap.appendChild(b);
      });
      result(); draw();
      cv.addEventListener('mousemove', function (e) {
        var r = cv.getBoundingClientRect(), mx = e.clientX - r.left, my = e.clientY - r.top, i = nearest(mx, my);
        if (i !== hover) { hover = i; draw(); }
        var tip = $('tip');
        if (i == null) { tip.hidden = true; return; }
        var p = S.planets[i]; tip.textContent = '';
        var st = document.createElement('strong'); st.textContent = p.name; tip.appendChild(st);
        row(tip, 'Distance', fmtLy(p.ly));
        row(tip, 'Size', p.radius != null ? sizeWords(p.radius) : 'not measured', p.radEst);
        tip.hidden = false;
        var sec = $('near').getBoundingClientRect(), box = cv.getBoundingClientRect();
        tip.style.position = 'fixed'; tip.style.left = Math.min(window.innerWidth - tip.offsetWidth - 8, e.clientX + 16) + 'px'; tip.style.top = (e.clientY + 16) + 'px';
      });
      cv.addEventListener('mouseleave', function () { hover = null; $('tip').hidden = true; draw(); });
      cv.addEventListener('click', function () { if (hover != null) World.open(S.planets[hover], cv); });
    }
    return { init: init, rebuild: function () { if (cv) { layout(); draw(); } }, draw: function () { draw(); } };
  })();



  // ================================================================ 04 PLANET ZOO
  // Simple, visible rules. Each planet lands in the first group it fits.
  var Zoo = (function () {
    var GROUPS = [
      { id: 'hotj', name: 'Hot Jupiters', rule: 'Giant (8× Earth’s width or more) with a year shorter than 10 days.',
        say: 'Giants hugging their stars. A year here is a few days.', test: function (p) { return p.radius != null && p.radius >= 8 && p.period != null && p.period < 10; } },
      { id: 'lava', name: 'Scorched small worlds', rule: 'Smaller than 2× Earth, and over 1,000 K by calculation.',
        say: 'Rocky-sized and baked. Think hotter than lava.', test: function (p) { return p.radius != null && p.radius < 2 && p.temp != null && p.temp >= 1000; } },
      { id: 'cold', name: 'Cold giants', rule: 'Giant (6× Earth’s width or more) with a year over 400 days.',
        say: 'Our Jupiter and Saturn’s kind of world, far from the star.', test: function (p) { return p.radius != null && p.radius >= 6 && p.period != null && p.period >= 400; } },
      { id: 'warm', name: 'Other giants', rule: 'Giant (6× Earth’s width or more), everything else.',
        say: 'Big, gassy, and somewhere in between.', test: function (p) { return p.radius != null && p.radius >= 6; } },
      { id: 'nep', name: 'Neptune-ish', rule: 'Between 2× and 6× Earth’s width.',
        say: 'The most common size we find. Our Solar System has two: Neptune and Uranus.', test: function (p) { return p.radius != null && p.radius >= 2; } },
      { id: 'super', name: 'Super-Earths', rule: 'Between 1.25× and 2× Earth’s width.',
        say: 'Bigger than Earth, smaller than Neptune. “Super” is about size only.', test: function (p) { return p.radius != null && p.radius >= 1.25; } },
      { id: 'earth', name: 'Earth-sized or smaller', rule: 'Under 1.25× Earth’s width.',
        say: 'Earth-sized is not Earth-like. We only know the width.', test: function (p) { return p.radius != null; } },
      { id: 'unk', name: 'Size not measured', rule: 'No radius in the archive yet.',
        say: 'Found, but not yet sized.', test: function () { return true; } }
    ];
    var members = {};
    function rad(p) { return p.radius == null ? 1.6 : Math.min(13, 1.2 + 2.2 * Math.log2(p.radius + 1)); }
    function rng(seed) { return function () { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; }; }

    function classify() {
      GROUPS.forEach(function (g) { members[g.id] = []; });
      S.planets.forEach(function (p) { for (var i = 0; i < GROUPS.length; i++) if (GROUPS[i].test(p)) { members[GROUPS[i].id].push(p); break; } });
    }
    function paint(cv, g) {
      var c = setupCanvas(cv), ctx = c.ctx, W = c.w, H = c.h;
      ctx.clearRect(0, 0, W, H);
      var list = members[g.id], r = rng(7 + g.id.length * 31);
      var sample = list.length > 140 ? d3.shuffle(list.slice(), r).slice(0, 140) : list;
      sample.slice().sort(function (a, b) { return rad(b) - rad(a); }).forEach(function (p) {
        var x = 10 + r() * (W - 20), y = 10 + r() * (H - 20), rr = rad(p);
        ctx.globalAlpha = 0.85; ctx.fillStyle = colorOf(p);
        ctx.beginPath(); ctx.arc(x, y, rr, 0, 6.283); ctx.fill();
        if (p.radius == null) { ctx.strokeStyle = PAL.ink3; ctx.stroke(); }
      });
      ctx.globalAlpha = 1;
    }
    function build() {
      var grid = $('zooGrid'); grid.textContent = '';
      GROUPS.forEach(function (g) {
        var list = members[g.id]; if (!list.length) return;
        var card = document.createElement('article'); card.className = 'zoo-card';
        var cv = document.createElement('canvas'); cv.setAttribute('role', 'img');
        cv.setAttribute('aria-label', g.name + ': ' + fmt(list.length) + ' planets');
        var h3 = document.createElement('h3'); h3.textContent = g.name;
        var n = document.createElement('span'); n.className = 'num'; n.textContent = fmt(list.length); h3.appendChild(n);
        var say = document.createElement('p'); say.textContent = g.say;
        var rule = document.createElement('p'); rule.className = 'rule'; rule.textContent = g.rule;
        var b = document.createElement('button'); b.type = 'button'; b.className = 'btn ghost'; b.textContent = 'Meet one';
        b.addEventListener('click', function () { World.open(list[Math.floor(Math.random() * list.length)], b); });
        [cv, h3, say, rule, b].forEach(function (e) { card.appendChild(e); });
        card._g = g; card._cv = cv; grid.appendChild(card);
      });
      repaint();
    }
    function repaint() { Array.prototype.forEach.call($('zooGrid').children, function (card) { paint(card._cv, card._g); }); }
    function init() { classify(); build(); }
    return { init: init, rebuild: function () { if ($('zooGrid').children.length) repaint(); } };
  })();

  // ================================================================ 05 HOW WE FOUND THEM
  // Method -> facility -> size group. Not "what exists": what our instruments are good at finding.
  var Found = (function () {
    var chart = null;
    var SIZE = [
      { id: 'Earth-sized or smaller', test: function (r) { return r < 1.25; } },
      { id: 'Super-Earths', test: function (r) { return r >= 1.25 && r < 2; } },
      { id: 'Neptune-ish', test: function (r) { return r >= 2 && r < 6; } },
      { id: 'Giants', test: function (r) { return r >= 6; } }
    ];
    var UNK = 'Size not measured';
    var SHORT = { 'Transiting Exoplanet Survey Satellite (TESS)': 'TESS', 'Multiple Observatories': 'Multiple observatories', 'Hubble Space Telescope': 'Hubble', 'James Webb Space Telescope': 'JWST' };
    function fac(f) { return SHORT[f] || f || 'Unknown'; }
    function sizeOfP(p) { if (p.radius == null) return UNK; for (var i = 0; i < SIZE.length; i++) if (SIZE[i].test(p.radius)) return SIZE[i].id; return UNK; }
    function methodOf(p, keep) { return keep[p.method] ? methodLabel(p.method) : 'Other methods'; }
    function methodLabel(m) { return ({ 'Transit': 'Transit', 'Radial Velocity': 'Wobble', 'Microlensing': 'Microlensing', 'Imaging': 'Direct imaging' })[m] || m; }

    function build() {
      var mc = d3.rollup(S.planets, function (v) { return v.length; }, function (p) { return p.method; });
      var topM = Array.from(mc).sort(function (a, b) { return b[1] - a[1]; }).slice(0, 4).map(function (x) { return x[0]; });
      var keepM = {}; topM.forEach(function (m) { keepM[m] = 1; });
      var fc = d3.rollup(S.planets, function (v) { return v.length; }, function (p) { return fac(p.facility); });
      var topF = Array.from(fc).sort(function (a, b) { return b[1] - a[1]; }).slice(0, 6).map(function (x) { return x[0]; });
      var keepF = {}; topF.forEach(function (f) { keepF[f] = 1; });
      var l1 = new Map(), l2 = new Map();
      S.planets.forEach(function (p) {
        var m = methodOf(p, keepM), f = keepF[fac(p.facility)] ? fac(p.facility) : 'Other facilities', z = sizeOfP(p);
        var k1 = m + '\u0001' + f, k2 = f + '\u0001' + z;
        l1.set(k1, (l1.get(k1) || 0) + 1); l2.set(k2, (l2.get(k2) || 0) + 1);
      });
      var links = [];
      l1.forEach(function (v, k) { var a = k.split('\u0001'); links.push({ source: 'm:' + a[0], target: 'f:' + a[1], value: v }); });
      l2.forEach(function (v, k) { var a = k.split('\u0001'); links.push({ source: 'f:' + a[0], target: 'z:' + a[1], value: v }); });
      return { links: links, keepM: keepM, topM: topM };
    }

    function notes() {
      var el = $('foundNotes'); el.textContent = '';
      var withR = S.planets.filter(function (p) { return p.radius != null; });
      var shareOf = function (method, grp) {
        var pool = withR.filter(function (p) { return p.method === method; });
        return pool.length ? Math.round(100 * pool.filter(function (p) { return sizeOfP(p) === grp; }).length / pool.length) : 0;
      };
      var items = [];
      var earthTot = withR.filter(function (p) { return sizeOfP(p) === 'Earth-sized or smaller'; });
      if (earthTot.length) {
        var viaT = Math.round(100 * earthTot.filter(function (p) { return p.method === 'Transit'; }).length / earthTot.length);
        items.push(['<b>' + viaT + '%</b> of the Earth-sized or smaller worlds were found by transit. Small planets are hard to catch any other way.']);
      }
      items.push(['Giants make up <b>' + shareOf('Radial Velocity', 'Giants') + '%</b> of wobble finds, but only <b>' + shareOf('Transit', 'Giants') + '%</b> of transit finds. Different tools see different planets.']);
      var kep = S.planets.filter(function (p) { return p.facility === 'Kepler'; }).length;
      items.push(['<b>' + fmt(kep) + '</b> worlds came from one telescope staring at one patch of sky. This map shows what we looked at, not a census of the galaxy.']);
      items.forEach(function (it) {
        var p = document.createElement('p'); var tmp = document.createElement('div'); tmp.innerHTML = it[0]; // static strings + computed numbers only
        while (tmp.firstChild) p.appendChild(tmp.firstChild); el.appendChild(p);
      });
    }

    function option() {
      var d = build();
      var mcol = PAL.dark ? ['#9cc2ff', '#ffc27a', '#c69cff', '#7fe0c4', '#8a8fb3'] : ['#23468f', '#b06a12', '#6b3fa0', '#1f7a62', '#8a8796'];
      var nodes = {}, order = [];
      function add(key, label, color) { if (!nodes[key]) { nodes[key] = { name: key, label: label, color: color }; order.push(key); } }
      var mi = {}; d.topM.forEach(function (m, i) { mi[methodLabel(m)] = i; });
      d.links.forEach(function (l) {
        [l.source, l.target].forEach(function (k) {
          var t = k.charAt(0), n = k.slice(2);
          if (t === 'm') add(k, n, mcol[mi[n] != null ? mi[n] : 4]);
          else if (t === 'f') add(k, n, PAL.dark ? '#aab3d4' : '#59607a');
          else add(k, n, n === UNK ? PAL.tn : PAL.t[Math.max(0, SIZE.map(function (z) { return z.id; }).indexOf(n)) + (n === UNK ? 0 : 0) + 0] || PAL.accent);
        });
      });
      // size nodes get a cool->warm ramp by size
      var zc = [PAL.t[1], PAL.t[2], PAL.t[3], PAL.t[4]];
      SIZE.forEach(function (z, i) { if (nodes['z:' + z.id]) nodes['z:' + z.id].color = zc[i]; });
      return {
        aria: { enabled: true },
        animationDuration: REDUCED ? 0 : 900,
        tooltip: { trigger: 'item', backgroundColor: PAL.dark ? 'rgba(14,20,44,.96)' : 'rgba(248,245,238,.97)', borderColor: PAL.line, textStyle: { color: PAL.ink, fontSize: 13 },
          formatter: function (p) {
            if (p.dataType === 'edge') return nodes[p.data.source].label + ' → ' + nodes[p.data.target].label + '<br/><b>' + fmt(p.data.value) + '</b> worlds';
            return '<b>' + nodes[p.data.name].label + '</b><br/>' + fmt(p.value) + ' worlds';
          } },
        series: [{
          type: 'sankey', left: 8, right: 200, top: 10, bottom: 10, nodeWidth: 16, nodeGap: 12, draggable: false, layoutIterations: 24,
          emphasis: { focus: 'adjacency' },
          lineStyle: { color: 'gradient', opacity: PAL.dark ? 0.32 : 0.4, curveness: 0.5 },
          label: { color: PAL.ink, fontSize: 12.5, formatter: function (p) { return nodes[p.name].label + '  ' + fmt(p.value); } },
          data: order.map(function (k) { return { name: k, itemStyle: { color: nodes[k].color, borderWidth: 0 } }; }),
          links: d.links
        }]
      };
    }

    function render() {
      if (!chart) return;
      chart.setOption(option(), true);
    }

    function init() {
      var el = $('foundChart');
      if (!window.echarts) { el.textContent = 'Chart library unavailable.'; return; }
      chart = echarts.init(el, null, { renderer: 'canvas' });
      render(); notes();
      window.addEventListener('resize', function () { chart && chart.resize(); });
    }
    return { init: init, rebuild: function () { render(); } };
  })();


  // ================================================================ 06 FIND ME A WORLD
  var FindMe = (function () {
    var GROUPS = [
      { id: 'size', label: 'How big?', opts: [
        ['any', 'Any size', null],
        ['earth', 'Earth-sized or smaller', function (p) { return p.radius != null && p.radius < 1.25; }],
        ['super', 'Super-Earth', function (p) { return p.radius != null && p.radius >= 1.25 && p.radius < 2; }],
        ['nep', 'Neptune-ish', function (p) { return p.radius != null && p.radius >= 2 && p.radius < 6; }],
        ['giant', 'Giant', function (p) { return p.radius != null && p.radius >= 6; }]] },
      { id: 'heat', label: 'How hot? (calculated from starlight)', opts: [
        ['any', 'Any heat', null],
        ['cold', 'Cold, under 200 K', function (p) { return p.temp != null && p.temp < 200; }],
        ['mild', 'Mild, 200–350 K', function (p) { return p.temp != null && p.temp >= 200 && p.temp < 350; }],
        ['warm', 'Hot, 350–1,000 K', function (p) { return p.temp != null && p.temp >= 350 && p.temp < 1000; }],
        ['scorch', 'Scorching, 1,000 K+', function (p) { return p.temp != null && p.temp >= 1000; }]] },
      { id: 'dist', label: 'How far?', opts: [
        ['any', 'Any distance', null],
        ['n50', 'Within 50 light-years', function (p) { return p.ly != null && p.ly <= 50; }],
        ['n500', 'Within 500', function (p) { return p.ly != null && p.ly <= 500; }],
        ['n5k', 'Within 5,000', function (p) { return p.ly != null && p.ly <= 5000; }]] },
      { id: 'how', label: 'How was it found?', opts: [
        ['any', 'Any way', null],
        ['tr', 'Transit', function (p) { return p.method === 'Transit'; }],
        ['rv', 'Wobble', function (p) { return p.method === 'Radial Velocity'; }],
        ['im', 'Direct imaging', function (p) { return p.method === 'Imaging'; }],
        ['ml', 'Microlensing', function (p) { return p.method === 'Microlensing'; }]] }
    ];
    var pick = { size: 'any', heat: 'any', dist: 'any', how: 'any' };
    var matches = [];

    function tests() {
      var t = [];
      GROUPS.forEach(function (g) { g.opts.forEach(function (o) { if (o[0] === pick[g.id] && o[2]) t.push(o[2]); }); });
      return t;
    }
    function phrase() {
      var bits = [];
      GROUPS.forEach(function (g) { g.opts.forEach(function (o) { if (o[0] === pick[g.id] && o[2]) bits.push(o[1].toLowerCase()); }); });
      return bits.length ? bits.join(' · ') : 'no filters yet';
    }
    function update() {
      var t = tests();
      matches = S.planets.filter(function (p) { return t.every(function (f) { return f(p); }); });
      $('fmCount').textContent = fmt(matches.length) + (matches.length === 1 ? ' world' : ' worlds');
      $('fmSay').textContent = matches.length ? 'match: ' + phrase() + '.' : 'Nothing matches that mix, at least not yet. Loosen one choice. That’s the point: we’ve barely started looking.';
      var list = $('fmList'); list.textContent = '';
      matches.filter(function (p) { return p.ly != null; }).sort(function (a, b) { return a.ly - b.ly; }).slice(0, 6).forEach(function (p) {
        var li = document.createElement('li'), b = document.createElement('button'); b.type = 'button';
        b.appendChild(document.createTextNode(p.name));
        var d = document.createElement('span'); d.textContent = (p.ly < 100 ? p.ly.toFixed(1) : fmt(Math.round(p.ly))) + ' ly'; b.appendChild(d);
        b.addEventListener('click', function () { World.open(p, b); });
        li.appendChild(b); list.appendChild(li);
      });
      $('fmRandom').disabled = !matches.length;
      Array.prototype.forEach.call(document.querySelectorAll('#fmGroups .chip'), function (c) {
        c.setAttribute('aria-pressed', String(pick[c.dataset.g] === c.dataset.o));
      });
    }
    function init() {
      var wrap = $('fmGroups'); wrap.textContent = '';
      GROUPS.forEach(function (g) {
        var box = document.createElement('div'); box.className = 'fm-group'; box.setAttribute('role', 'group'); box.setAttribute('aria-label', g.label);
        var l = document.createElement('p'); l.className = 'ask-label'; l.textContent = g.label;
        var chips = document.createElement('div'); chips.className = 'chips';
        g.opts.forEach(function (o) {
          var b = document.createElement('button'); b.type = 'button'; b.className = 'chip'; b.textContent = o[1];
          b.dataset.g = g.id; b.dataset.o = o[0];
          b.addEventListener('click', function () { pick[g.id] = o[0]; update(); });
          chips.appendChild(b);
        });
        box.appendChild(l); box.appendChild(chips); wrap.appendChild(box);
      });
      $('fmRandom').addEventListener('click', function () { if (matches.length) World.open(matches[Math.floor(Math.random() * matches.length)], $('fmRandom')); });
      $('fmReset').addEventListener('click', function () { pick = { size: 'any', heat: 'any', dist: 'any', how: 'any' }; update(); });
      update();
    }
    return { init: init, rebuild: function () {} };
  })();


  // ================================================================ 07 WHEN YOU WERE BORN
  var Born = (function () {
    var range, out, cards;
    function card(big, text, planet) {
      var d = document.createElement('div'); d.className = 'born-card';
      var b = document.createElement('div'); b.className = 'big num'; b.textContent = big;
      var p = document.createElement('p'); p.textContent = text;
      d.appendChild(b); d.appendChild(p);
      if (planet) {
        var bt = document.createElement('button'); bt.type = 'button'; bt.className = 'btn ghost'; bt.textContent = 'Meet ' + planet.name;
        bt.addEventListener('click', function () { World.open(planet, bt); }); d.appendChild(bt);
      }
      return d;
    }
    function render() {
      var y = +range.value, age = NOW_YEAR - y;
      out.textContent = y; cards.textContent = '';
      var known = S.planets.filter(function (p) { return p.year != null && p.year <= y; });
      var since = S.total - known.length;
      if (!known.length) {
        cards.appendChild(card('0', 'Confirmed planets around other stars the year you were born. The first ones came in ' + S.firstYear + '.'));
      } else {
        cards.appendChild(card(fmt(known.length), 'Confirmed planets around other stars the year you were born' + (y >= S.firstYear ? ' (counting up to the end of that year).' : '.')));
      }
      cards.appendChild(card('+' + fmt(since), 'worlds found since. That’s about ' + fmt(Math.round(since / Math.max(age, 1))) + ' a year, every year of your life.'));
      var inYear = S.planets.filter(function (p) { return p.year === y; });
      if (inYear.length) {
        var pick = inYear.slice().sort(function (a, b) { return (a.ly || 1e9) - (b.ly || 1e9); })[0];
        cards.appendChild(card(fmt(inYear.length), (inYear.length === 1 ? 'world was' : 'worlds were') + ' found in ' + y + '. Closest of them: ' + pick.name + (pick.ly != null ? ', ' + fmtLy(pick.ly) + ' away.' : '.'), pick));
      } else if (y >= S.firstYear) {
        cards.appendChild(card('0', 'worlds were found in ' + y + '. A quiet year.'));
      } else {
        var first = S.planets.filter(function (p) { return p.year === S.firstYear; })[0];
        if (first) cards.appendChild(card(String(S.firstYear), 'The first confirmed planets around another star. Their light left long before you were born.', first));
      }
      var near = S.planets.filter(function (p) { return p.ly != null && p.ly > 0.5 && Math.abs(p.ly - age) <= 1; })
        .sort(function (a, b) { return Math.abs(a.ly - age) - Math.abs(b.ly - age); })[0];
      if (age > 4 && near) {
        cards.appendChild(card(fmtLy(near.ly), 'Light leaving ' + near.name + ' the year you were born is only reaching Earth about now.', near));
      }
    }
    function init() {
      range = $('bornYear'); out = $('bornOut'); cards = $('bornCards');
      range.max = String(NOW_YEAR);
      range.addEventListener('input', render); render();
    }
    return { init: init, rebuild: function () {} };
  })();


  // ================================================================ 09 HOW FAR IS FAR
  // Scale model: 1 AU = 1 human step (~0.75 m). Everything else follows.
  var Far = (function () {
    var AU_PER_LY = 63241, STEP_M = 0.75;
    var MOON_KM = 384400;
    function walkText(au) {
      var m = au * STEP_M;
      if (m < 10) return [Math.round(m) + ' m', 'a few steps'];
      if (m < 1000) return [Math.round(m) + ' m', 'a short walk'];
      var km = m / 1000;
      if (km < 100) return [fmt(Math.round(km)) + ' km', 'a drive across town'];
      if (km < 5000) return [fmt(Math.round(km)) + ' km', 'a drive between cities'];
      if (km < 40000) return [fmt(Math.round(km)) + ' km', 'a flight across the world'];
      if (km < MOON_KM) return [fmt(Math.round(km)) + ' km', 'most of the way to the Moon'];
      var moons = km / MOON_KM;
      if (moons < 2) return [moons.toFixed(1) + '× to the Moon', 'past the Moon'];
      return [fmt(Math.round(moons)) + '× the trip to the Moon', 'far past the Moon'];
    }
    function row(label, sub, au, max) {
      var el = document.createElement('div'); el.className = 'far-row';
      var who = document.createElement('div'); who.className = 'who';
      var b = document.createElement('b'); b.textContent = label; var s = document.createElement('span'); s.textContent = sub;
      who.appendChild(b); who.appendChild(s);
      var bar = document.createElement('div'); bar.className = 'far-bar';
      bar.style.width = Math.max(3, 100 * Math.log10(au + 1) / Math.log10(max + 1)) + '%';
      var w = walkText(au); var walk = document.createElement('div'); walk.className = 'walk';
      var wb = document.createElement('b'); wb.textContent = w[0]; var wt = document.createElement('span'); wt.textContent = w[1];
      walk.appendChild(wb); walk.appendChild(wt);
      el.appendChild(who); el.appendChild(bar); el.appendChild(walk);
      if (au > 0) el.style.cursor = 'default';
      return el;
    }
    function init() {
      var wrap = $('farSteps'); if (!wrap) return; wrap.textContent = '';
      var withLy = S.planets.filter(function (p) { return p.ly != null && p.ly > 0.1; });
      var nearest = withLy.slice().sort(function (a, b) { return a.ly - b.ly; })[0];
      var farthest = withLy.slice().sort(function (a, b) { return b.ly - a.ly; })[0];
      var rows = [
        ['The Sun', 'our own star · 1 step', 1],
        ['Neptune', 'edge of our planets', 30],
        ['Voyager 1', 'our farthest spacecraft', 167],
        ['Proxima Centauri', 'the nearest star', 4.246 * AU_PER_LY]
      ];
      if (nearest) rows.push([nearest.name, 'nearest known exoplanet · ' + fmtLy(nearest.ly), nearest.ly * AU_PER_LY]);
      if (farthest) rows.push([farthest.name, 'one of the farthest we’ve found · ' + fmtLy(farthest.ly), farthest.ly * AU_PER_LY]);
      var max = d3.max(rows, function (r) { return r[2]; });
      rows.forEach(function (r) { wrap.appendChild(row(r[0], r[1], r[2], max)); });
    }
    return { init: init, rebuild: function () {} };
  })();


  // ================================================================ 10 MISSION FINGERPRINTS
  var Missions = (function () {
    var cv, ctx, W, H, proj, mode = 'kepler', xy = [];
    var isK = function (p) { return p.facility === 'Kepler' || p.facility === 'K2'; };
    var isKepler = function (p) { return p.facility === 'Kepler'; };
    var isT = function (p) { return /TESS/.test(p.facility || ''); };
    var COL = function () { return { k: PAL.dark ? '#ffb46b' : '#b8610f', t: PAL.dark ? '#7fb8ff' : '#1f4fa8' }; };
    function layout() {
      var c = setupCanvas(cv); ctx = c.ctx; W = c.w; H = c.h;
      proj = makeProjection(W, H, { t: 10, r: 10, b: 10, l: 10 });
      xy = S.planets.map(function (p) { return p.ra != null && p.dec != null ? proj([lonOf(p.ra), p.dec]) : null; });
    }
    function draw() {
      if (!ctx) return;
      paintBackdrop(ctx, W, H, proj, { faint: true });
      var col = COL();
      // everyone else, faint
      ctx.globalAlpha = PAL.dark ? 0.18 : 0.22; ctx.fillStyle = PAL.ink3;
      S.planets.forEach(function (p, i) { var c = xy[i]; if (!c || isKepler(p) || isT(p)) return; ctx.beginPath(); ctx.arc(c[0], c[1], 1.1, 0, 6.283); ctx.fill(); });
      function layer(test, color) {
        ctx.globalAlpha = 0.8; ctx.fillStyle = color;
        S.planets.forEach(function (p, i) { var c = xy[i]; if (!c || !test(p)) return; ctx.beginPath(); ctx.arc(c[0], c[1], 1.8, 0, 6.283); ctx.fill(); });
      }
      if (mode === 'kepler' || mode === 'both') layer(isKepler, col.k);
      if (mode === 'tess' || mode === 'both') layer(isT, col.t);
      ctx.globalAlpha = 1;
    }
    function say() {
      var k = S.planets.filter(isKepler).length, t = S.planets.filter(isT).length, el = $('missionSay');
      el.textContent = '';
      var b = document.createElement('b'), p = document.createElement('p');
      if (mode === 'kepler') { b.textContent = fmt(k) + ' worlds'; p.textContent = 'Kepler stared at one small patch of sky, under half a percent of it, for four years. That tight cluster is the fingerprint: go deep, not wide.'; }
      else if (mode === 'tess') { b.textContent = fmt(t) + ' worlds'; p.textContent = 'TESS sweeps nearly the whole sky in strips, favoring bright, nearby stars. Wide, not deep. Its finds are scattered everywhere.'; }
      else { b.textContent = fmt(k + t) + ' worlds'; p.textContent = 'Together: one deep core sample and one wide survey. Where we looked shapes what we found.'; }
      el.appendChild(b); el.appendChild(p);
    }
    function set(m) {
      mode = m;
      document.querySelectorAll('.mission-toggle .chip').forEach(function (c) { c.setAttribute('aria-pressed', String(c.dataset.m === m)); });
      draw(); say();
    }
    function init() {
      cv = $('missionCanvas'); if (!cv) return;
      document.querySelectorAll('.mission-toggle .chip').forEach(function (c) { c.addEventListener('click', function () { set(c.dataset.m); }); });
      layout(); set('kepler');
    }
    return { init: init, rebuild: function () { if (cv) { layout(); draw(); } } };
  })();

  // ================================================================ ENDING
  var Ending = (function () {
    var cv, ctx, W, H, stars = [], raf = null, on = false;
    function rebuild() {
      if (!cv) return;
      var c = setupCanvas(cv); ctx = c.ctx; W = c.w; H = c.h;
      var r = rng(99); stars = [];
      for (var i = 0; i < 420; i++) stars.push({ x: r() * W, y: r() * H, z: 0.2 + r() * 0.8, tw: r() * 6.28 });
      draw(0);
    }
    function draw(t) {
      ctx.clearRect(0, 0, W, H);
      for (var i = 0; i < stars.length; i++) {
        var s = stars[i];
        var x = (s.x + t * 0.004 * s.z) % W;
        var a = 0.25 + 0.55 * s.z * (REDUCED ? 1 : 0.75 + 0.25 * Math.sin(t / 1100 + s.tw));
        ctx.fillStyle = 'rgba(225,232,255,' + a + ')';
        ctx.beginPath(); ctx.arc(x, s.y, 0.4 + s.z * 1.1, 0, 6.283); ctx.fill();
      }
    }
    function loop(t) { draw(t); if (on) raf = requestAnimationFrame(loop); }
    function init() {
      cv = $('endCanvas'); rebuild();
      $('endCount').textContent = fmt(S.total);
      if (!REDUCED) new IntersectionObserver(function (en) {
        on = en[0].isIntersecting; if (on) raf = requestAnimationFrame(loop); else cancelAnimationFrame(raf);
      }, { threshold: 0.1 }).observe(cv);
    }
    return { init: init, rebuild: rebuild };
  })();

  // ================================================================ boot
  function countUp(el, n) {
    if (REDUCED) { el.textContent = fmt(n); return; }
    var t0 = performance.now(), dur = 2200, ip = d3.interpolateRound(0, n);
    (function step(now) {
      var k = Math.min(1, (now - t0) / dur);
      el.textContent = fmt(ip(d3.easeCubicOut(k)));
      if (k < 1) requestAnimationFrame(step);
    })(t0);
  }

  function chapterNav() {
    var links = document.querySelectorAll('.toc a');
    var io = new IntersectionObserver(function (en) {
      en.forEach(function (e) {
        if (!e.isIntersecting) return;
        links.forEach(function (a) { a.classList.toggle('on', a.dataset.ch === e.target.id); });
      });
    }, { threshold: 0.5 });
    document.querySelectorAll('.chapter').forEach(function (c) { io.observe(c); });
  }

  // Local preview only: ?theme=light&ask=earth&open=51%20Peg%20b&year=2009 for screenshots.
  function devHooks() {
    var q = new URLSearchParams(location.search);
    if (q.get('only')) document.querySelectorAll('.chapter').forEach(function (c) { if (c.id !== q.get('only')) c.style.display = 'none'; });
    if (q.get('theme') === 'light') setTheme('light');
    if (q.get('only')) { Story.rebuild(); Near.rebuild(); Missions.rebuild(); Ending.rebuild(); }
    if (q.get('ask')) { var b = Array.prototype.find.call(document.querySelectorAll('.chip'), function (c, i) { return QUESTIONS[i].id === q.get('ask'); }); if (b) b.click(); }
    if (q.get('year')) { var r = $('yearRange'); r.value = q.get('year'); r.dispatchEvent(new Event('input')); }
    if (q.get('open')) { var p = S.byName.get(q.get('open').toLowerCase()); if (p) World.open(p); }
    if (q.get('mission')) { var mb = document.querySelector('.mission-toggle .chip[data-m="' + q.get('mission') + '"]'); if (mb) mb.click(); }
  }

  function boot() {
    if (STILL) document.documentElement.classList.add('still');
    readPalette();
    var live = !!(window.tableau && tableau.extensions && tableau.extensions.initializeAsync);
    (live ? loadLive() : loadDev()).then(function (planets) {
      if (!planets.length) throw new Error('The data source returned no planets.');
      index(planets);
      status(null);
      Sky.init(); Ask.init(); Story.init(); Near.init(); Zoo.init(); Found.init(); FindMe.init(); Born.init(); Far.init(); Missions.init(); World.init(); Ending.init();
      countUp($('heroCount'), S.total); $('builtCount').textContent = fmt(S.total);
      chapterNav();
      // Open on chapter 2 (the story) by default. #sky or ?start=sky opens at the top instead.
      var want = (location.hash || '').replace('#', '') || new URLSearchParams(location.search).get('start') || 'story';
      if (want !== 'sky' && $(want) && !new URLSearchParams(location.search).get('only')) {
        requestAnimationFrame(function () { $(want).scrollIntoView({ behavior: 'auto', block: 'start' }); });
      }
      $('theme').addEventListener('click', function () { setTheme(S.theme === 'dark' ? 'light' : 'dark'); });
      if (!live) devHooks();
      var resizeT;
      window.addEventListener('resize', function () {
        clearTimeout(resizeT);
        resizeT = setTimeout(function () { Sky.rebuild(); Story.rebuild(); Near.rebuild(); Ending.rebuild(); }, 150);
      });
    }).catch(function (e) {
      status('Couldn’t load the planets: ' + ((e && (e.message || e.errorCode)) || e), true);
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
