/* =====================================================================
   VoxaMascot + VoxaNotch  (no dependencies, no shadows outside the shape)
   States: idle, listening, thinking, speaking, happy, error, sleep
   ===================================================================== */
(function (global) {
  'use strict';
  var TAU = Math.PI * 2;
  function lerp(a, b, t) { return a + (b - a) * t; }
  function clamp(v, a, b) { return Math.min(b, Math.max(a, v)); }
  function hex(h) { h = h.replace('#', ''); return [0, 2, 4].map(function (i) { return parseInt(h.substr(i, 2), 16); }); }
  function css(c) { return 'rgb(' + c.map(Math.round).join(',') + ')'; }

  var PALETTES = {
    wine:  ['#8a3f58', '#5a2236'],
    ember: ['#ff6b2c', '#c8410f'],
    mint:  ['#3ddc97', '#138a5c'],
    sky:   ['#5aa9ff', '#2457c5'],
    plum:  ['#c07bff', '#6b2fb3'],
    brick: ['#a8403a', '#7a2a28'],
    boy:   ['#d9a066', '#a06a3a']
  };

  // lid: eyelid closure, by/ba: brow height/angle, tl: head tilt, cheek: blush, es: eye size, lift: scarf lift, v: eye style
  var STATES = {
    idle:      { lid: .32, by: 0,  ba: 0,   tl: 0,  cheek: .35, es: 1,    lift: 0,  breath: .012, speed: .9,  v: 'open' },
    listening: { lid: .04, by: -2, ba: -3,  tl: -3, cheek: .35, es: 1.1,  lift: 0,  breath: .016, speed: 1.4, v: 'open' },
    thinking:  { lid: .28, by: -1, ba: 5,   tl: 6,  cheek: .3,  es: 1,    lift: 0,  breath: .012, speed: 1.1, v: 'open' },
    speaking:  { lid: .14, by: -1, ba: 0,   tl: 0,  cheek: .4,  es: 1,    lift: 0,  breath: .016, speed: 1.8, v: 'open' },
    happy:     { lid: 0,   by: -3, ba: -4,  tl: -4, cheek: 1,   es: 1,    lift: -1, breath: .02,  speed: 2.2, v: 'happy' },
    error:     { lid: 0,   by: 1,  ba: -11, tl: 0,  cheek: 0,   es: 1,    lift: 0,  breath: .008, speed: .6,  v: 'x' },
    sleep:     { lid: 1,   by: 2,  ba: 0,   tl: 8,  cheek: .35, es: 1,    lift: -2, breath: .01,  speed: .35, v: 'closed' },
    surprised: { lid: 0,   by: -6, ba: -6,  tl: 0,  cheek: .4,  es: 1.3,  lift: 0,  breath: .01,  speed: 2,   v: 'open' },
    annoyed:   { lid: .62, by: 2,  ba: 14,  tl: 0,  cheek: 0,   es: 1,    lift: 0,  breath: .02,  speed: 2,   v: 'open' },
    shy:       { lid: .38, by: 0,  ba: -4,  tl: -7, cheek: 1,   es: 1,    lift: -5, breath: .014, speed: 1.6, v: 'open' },
    ask:       { lid: .08, by: -4, ba: -9,  tl: -4, cheek: .3,  es: 1.12, lift: 0,  breath: .014, speed: 1.2, v: 'open' },
    love:      { lid: .12, by: -3, ba: -4, tl: -3, cheek: 1, es: 1.05, lift: -2, breath: .02, speed: 1.8, v: 'open', heart: 1 }
  };

  /* ------------------------------ Characters ------------------------------ */
  function browsHtml(k) {
    var b = '<path class="brow" d="M-7,0H7" fill="none" stroke="' + k + '" stroke-width="1.7" stroke-linecap="round"/>';
    return b + b;
  }
  function mouthHtml(m) {
    return '<ellipse class="mouth" cx="0" cy="' + m.cy + '" rx="' + m.rx + '" ry="' + m.ry + '" fill="' + m.fill + '" opacity="' + m.op + '"/>';
  }
  function mkEye(o) {
    return function (x) {
      var k = o.ink;
      return '<g class="eye" transform="translate(' + x + ',8)">' +
        '<g data-v="open"><g class="es">' + (o.sclera
          ? '<ellipse rx="6.4" ry="7.2" fill="#fff" stroke="' + k + '" stroke-width="1.3"/><ellipse rx="4.5" ry="5.6" fill="' + o.iris + '"/><ellipse rx="2.3" ry="3.1" fill="#17110f"/>'
          : '<ellipse rx="4.8" ry="6" fill="' + o.iris + '"/>') +
          '<circle cx="1.5" cy="-2" r="1.5" fill="#fff"/></g>' +
          '<path class="lid" d="M-8.5,0H8.5" fill="none" stroke="' + k + '" stroke-width="' + o.lw + '" stroke-linecap="round"/></g>' +
        '<g data-v="happy" style="display:none"><path d="M-5.5,2Q0,-6 5.5,2" fill="none" stroke="' + k + '" stroke-width="2.4" stroke-linecap="round"/></g>' +
        '<g data-v="x" style="display:none"><path d="M-4,-4L4,4M4,-4L-4,4" fill="none" stroke="' + k + '" stroke-width="2.4" stroke-linecap="round"/></g>' +
        '<g data-v="closed" style="display:none"><path d="M-5.5,0Q0,4.5 5.5,0" fill="none" stroke="' + k + '" stroke-width="2.2" stroke-linecap="round"/></g>' +
        '</g>';
    };
  }

  var CHARS = {
    bob: {
      ink: '#111', hair: '#323a3b', skin: '#fdeee9', palette: 'wine', lidK: 1, cheekK: 1,
      mouth: { cx: 0, cy: 21, rx: 3.4, ry: 0.4, op: 0, fill: '#6b2d3a' },
      html: function (c) {
        var uid = c.uid, INK = c.INK, SKIN = c.SKIN, hairAttr = c.hairAttr, eye = c.eye, cheek = c.cheek;
        return         '<g class="head">' +
          '<g class="hback"><path d="M-44,10C-50,-30 -26,-52 0,-52C26,-52 50,-30 44,10L42,26L32,22L-32,22L-42,26Z" ' + hairAttr + '/>' +
            '<path d="M-30,-30Q0,-52 30,-30Q0,-40 -30,-30Z" fill="#8a9191" opacity=".8"/></g>' +
          '<circle cx="-41" cy="12" r="5.5" fill="' + SKIN + '" stroke="' + INK + '" stroke-width="1.8"/>' +
          '<ellipse cx="0" cy="10" rx="31" ry="28" fill="' + SKIN + '"/>' +
          '<g class="face">' + cheek(-20) + cheek(20) +
            '<path class="brow" d="M-7,0H7" fill="none" stroke="' + INK + '" stroke-width="1.6" stroke-linecap="round"/>' +
            '<path class="brow" d="M-7,0H7" fill="none" stroke="' + INK + '" stroke-width="1.6" stroke-linecap="round"/>' +
            '<g class="eyes">' + eye(-15) + eye(15) + '</g>' +
            '<ellipse class="mouth" cx="0" cy="21" rx="3.4" ry="1" fill="#6b2d3a" opacity="0"/>' +
          '</g>' +
          '<g class="bangs">' +
            '<path d="M-40,-14C-38,-36 -12,-40 2,-38C3,-18 3,2 -1,18C-6,-6 -26,-18 -40,-14Z" ' + hairAttr + '/>' +
            '<path d="M2,-38C22,-38 40,-30 42,-12C32,-16 20,-16 8,-10C6,-22 4,-30 2,-38Z" ' + hairAttr + '/>' +
            '<path d="M4,-26C10,-16 12,-6 6,6C2,-4 0,-14 4,-26Z" ' + hairAttr + '/>' +
            '<path d="M-43,-14L-45,18L-39,22L-35,-2Z" ' + hairAttr + '/><path d="M43,-14L45,18L39,22L35,-2Z" ' + hairAttr + '/>' +
          '</g>' +
        '</g>' +
        '<g class="scarf">' +
          '<g class="tail"><path class="tailp" d="M20,52L22,64L34,64L34,48Z" fill="#5a2236" stroke="' + INK + '" stroke-width="2" stroke-linejoin="round"/></g>' +
          '<path d="M-36,28C-14,23 14,23 36,28L40,50C14,58 -14,58 -40,50Z" fill="url(#' + uid + 's)" stroke="' + INK + '" stroke-width="2.2" stroke-linejoin="round"/>' +
          '<path d="M-30,41Q0,35 32,35" fill="none" stroke="' + INK + '" stroke-width="1.8" stroke-linecap="round"/>' +
        '</g>';
      }
    },
    girl: {
      ink: '#241a19', hair: '#4a3733', skin: '#fbe6dc', palette: 'brick', lidK: 0.85, cheekK: 1.25,
      mouth: { cx: 0, cy: 21, rx: 3.4, ry: 0.4, op: 0, fill: '#6b2d3a' },
      eye: mkEye({ ink: '#241a19', iris: '#3b3340', lw: 1.8 }),
      html: function (c) {
        var uid = c.uid, INK = c.INK, SKIN = c.SKIN, hairAttr = c.hairAttr, eye = c.eye, cheek = c.cheek;
        return '<g class="head">' +
          '<g class="hback"><path d="M-44,8C-50,-32 -24,-52 0,-52C24,-52 50,-32 44,8L50,48L40,50L36,22L-36,22L-40,50L-50,48Z" ' + hairAttr + '/></g>' +
          '<ellipse cx="0" cy="10" rx="31" ry="28" fill="' + SKIN + '"/>' +
          '<g class="face">' + cheek(-20) + cheek(20) + browsHtml(INK) + '<g class="eyes">' + eye(-15) + eye(15) + '</g>' + mouthHtml(CHARS.girl.mouth) + '</g>' +
          '<g class="bangs">' +
            '<path d="M-42,-10C-40,-38 -10,-42 4,-38C2,-18 -2,2 -10,22C-14,-4 -28,-14 -42,-10Z" ' + hairAttr + '/>' +
            '<path d="M4,-38C24,-40 42,-30 43,-8C34,-14 22,-12 10,-6C8,-20 6,-30 4,-38Z" ' + hairAttr + '/>' +
            '<path d="M6,-26C12,-16 14,-4 8,8C4,-2 2,-14 6,-26Z" ' + hairAttr + '/>' +
            '<path d="M-43,-12L-50,50L-40,52L-35,0Z" ' + hairAttr + '/><path d="M43,-12L50,50L40,52L35,0Z" ' + hairAttr + '/>' +
          '</g></g>' +
          '<g class="scarf">' +
            '<path d="M-44,62C-44,42 -26,34 0,34C26,34 44,42 44,62Z" fill="#d79ab8" stroke="' + INK + '" stroke-width="2" stroke-linejoin="round"/>' +
            '<g class="tail"><path class="tailp" d="M18,50L16,66L30,64L32,48Z" fill="#7a2a28" stroke="' + INK + '" stroke-width="2" stroke-linejoin="round"/></g>' +
            '<path d="M-34,28C-14,24 14,24 34,28L38,48C14,55 -14,55 -38,48Z" fill="url(#' + uid + 's)" stroke="' + INK + '" stroke-width="2.2" stroke-linejoin="round"/>' +
            '<path d="M-28,40Q0,34 30,34" fill="none" stroke="' + INK + '" stroke-width="1.8" stroke-linecap="round"/>' +
          '</g>';
      }
    },
    boy: {
      ink: '#2a1a14', hair: '#5a3b2f', skin: '#f3cfb0', palette: 'boy', lidK: 0.12, cheekK: 0.6,
      mouth: { cx: 0, cy: 22, rx: 4.6, ry: 2.4, op: 1, fill: '#c8505e', happy: 3.6 },
      eye: mkEye({ ink: '#2a1a14', iris: '#8d8f78', sclera: true, lw: 1.6 }),
      html: function (c) {
        var uid = c.uid, INK = c.INK, SKIN = c.SKIN, hairAttr = c.hairAttr, eye = c.eye, cheek = c.cheek;
        return '<g class="head">' +
          '<g class="hback"><path d="M-42,8C-48,-26 -36,-44 -16,-50L-22,-58L-6,-52L0,-62L8,-52L24,-58L22,-48C40,-42 48,-24 43,8L39,-6L35,8L-35,8L-39,-6Z" ' + hairAttr + '/></g>' +
          '<circle cx="-33" cy="14" r="5.5" fill="' + SKIN + '" stroke="' + INK + '" stroke-width="1.8"/>' +
          '<ellipse cx="0" cy="10" rx="31" ry="28" fill="' + SKIN + '"/>' +
          '<g class="face">' + cheek(-20) + cheek(20) + browsHtml(INK) + '<g class="eyes">' + eye(-15) + eye(15) + '</g>' + mouthHtml(CHARS.boy.mouth) + '</g>' +
          '<g class="bangs">' +
            '<path d="M-42,-6C-44,-30 -24,-44 -2,-40L-8,-26L-16,-12L-20,-22L-28,-6L-34,-16Z" ' + hairAttr + '/>' +
            '<path d="M0,-40C24,-44 44,-30 44,-6L38,-16L32,-4L26,-18L18,-6L12,-22L6,-10Z" ' + hairAttr + '/>' +
            '<path d="M-4,-38L2,-14L7,-38Z" ' + hairAttr + '/>' +
          '</g></g>' +
          '<g class="scarf">' +
            '<g class="tail" style="display:none"><path class="tailp" d=""/></g>' +
            '<path d="M-8,32L-8,46L8,46L8,32Z" fill="' + SKIN + '"/>' +
            '<path d="M-46,62C-46,42 -28,36 -14,36L0,52L14,36C28,36 46,42 46,62Z" fill="#4a3830" stroke="' + INK + '" stroke-width="2" stroke-linejoin="round"/>' +
            '<path d="M-13,37L0,54L13,37L0,40Z" fill="#b8855d" stroke="' + INK + '" stroke-width="1.6" stroke-linejoin="round"/>' +
            '<path d="M-18,34C-30,36 -32,50 -26,56L-12,44ZM18,34C30,36 32,50 26,56L12,44Z" fill="#3c2c26" stroke="' + INK + '" stroke-width="1.8" stroke-linejoin="round"/>' +
          '</g>';
      }
    }
  };

  /* ------------------------------ Mascot ------------------------------ */
  function Mascot(el, opts) {
    opts = Object.assign({ follow: true, autoBlink: true, autoSleep: 0 }, opts || {});
    var CH = CHARS[opts.character] || CHARS.bob;
    var uid = 'vxm' + Math.random().toString(36).slice(2, 8);
    var INK = CH.ink, HAIR = CH.hair, SKIN = CH.skin;
    var hairAttr = 'fill="' + HAIR + '" stroke="' + INK + '" stroke-width="2" stroke-linejoin="round"';
    var eye = function (x) {
      return '<g class="eye" transform="translate(' + x + ',8)">' +
        '<g data-v="open"><g class="es"><ellipse rx="4.6" ry="6" fill="' + INK + '"/><circle cx="1.4" cy="-2" r="1.4" fill="#fff"/></g>' +
          '<path class="lid" d="M-8.5,0H8.5" fill="none" stroke="' + INK + '" stroke-width="1.8" stroke-linecap="round"/></g>' +
        '<g data-v="happy" style="display:none"><path d="M-5.5,2Q0,-6 5.5,2" fill="none" stroke="' + INK + '" stroke-width="2.4" stroke-linecap="round"/></g>' +
        '<g data-v="x" style="display:none"><path d="M-4,-4L4,4M4,-4L-4,4" fill="none" stroke="' + INK + '" stroke-width="2.4" stroke-linecap="round"/></g>' +
        '<g data-v="closed" style="display:none"><path d="M-5.5,0Q0,4.5 5.5,0" fill="none" stroke="' + INK + '" stroke-width="2.2" stroke-linecap="round"/></g>' +
        '</g>';
    };
    if (CH.eye) eye = CH.eye;
    var cheek = function (x) {
      return '<g class="cheek" opacity="0"><ellipse cx="' + x + '" cy="19" rx="6" ry="3.6" fill="#f2a29d"/>' +
        '<path d="M' + (x - 2) + ',16L' + (x - 1) + ',19.5M' + (x + 2) + ',16L' + (x + 3) + ',19.5" stroke="#e8837f" stroke-width="1" stroke-linecap="round"/></g>';
    };
    el.innerHTML =
      '<svg viewBox="-60 -60 120 120" width="100%" height="100%" role="img" aria-label="Voxa mascot" style="display:block;overflow:visible">' +
      '<defs><linearGradient id="' + uid + 's" x1="0" y1="0" x2="0" y2="1"><stop class="s0" offset="0" stop-color="#8a3f58"/><stop class="s1" offset="1" stop-color="#5a2236"/></linearGradient></defs>' +
      '<g class="rings" fill="none" stroke="#8a3f58" stroke-width="1.6"><circle r="50" opacity="0"/><circle r="50" opacity="0"/><circle r="50" opacity="0"/></g>' +
      '<g class="orbit" fill="#8a3f58"><circle r="3" opacity="0"/><circle r="3" opacity="0"/><circle r="3" opacity="0"/></g>' +
      '<g class="body-g">' +
      CH.html({ uid: uid, INK: INK, SKIN: SKIN, hairAttr: hairAttr, eye: eye, cheek: cheek }) +
      '</g>' +
      '<g class="zzz" fill="#f3e6ea" font-family="Segoe UI, system-ui, sans-serif" font-weight="700">' +
        '<text x="30" y="-34" font-size="13" opacity="0">z</text><text x="40" y="-46" font-size="10" opacity="0">z</text>' +
      '</g>' +
      '<g class="heart" opacity="0"><path d="M0,3C-9,-5 -10,-12 -5,-14C-2,-15 0,-12 0,-10C0,-12 2,-15 5,-14C10,-12 9,-5 0,3Z" fill="#ff7b9c" stroke="#d04a70" stroke-width="1.2" stroke-linejoin="round"/></g></svg>';

    var $ = function (s) { return el.querySelector(s); };
    var $$ = function (s) { return Array.prototype.slice.call(el.querySelectorAll(s)); };
    var bodyG = $('.body-g'), headG = $('.head'), faceG = $('.face'), eyesG = $('.eyes'), bangsG = $('.bangs'), hbackG = $('.hback');
    var scarfG = $('.scarf'), tailG = $('.tail'), tailP = $('.tailp'), mouth = $('.mouth');
    var cheeks = $$('.cheek'), brows = $$('.brow'), ess = $$('.es'), lids = $$('.lid'), variants = $$('.eye [data-v]');
    var ringsG = $('.rings'), rings = $$('.rings circle'), orbitG = $('.orbit'), orbit = $$('.orbit circle'), zs = $$('.zzz text');
    var stops = { s0: $('.s0'), s1: $('.s1') };
    var heartG = $('.heart'), heartOn = 0;
    var rmq = global.matchMedia ? global.matchMedia('(prefers-reduced-motion: reduce)') : { matches: false };

    var state = 'idle', temp = null, tempUntil = 0, curVariant = 'open';
    var t = 0, last = performance.now(), raf = 0, seed = Math.random() * 10;
    var spd = 0.9, lvl = 0, lvlT = 0;
    var lid = .32, by = 0, ba = 0, tl = 0, chk = .35, es = 1, lift = 0, lean = 0, breath = .012;
    var mo = CH.mouth.ry, mop = CH.mouth.op, ringsOn = 0, orbitOn = 0, zOn = 0;
    var gx = 0, gy = 0, ptr = [0, 0], lastPtr = -1e9, manual = null, wander = [0, 0], nextWander = 0;
    var pd = 999, nearT = 0, coolShy = 0, coolSurp = 0, lx = 0, ly = 0, lt = 0, clicks = [];
    var nextBlink = performance.now() + 1500, blinkStart = -1e9;
    var p = 0, pv = 0, errAt = -1e9, lastAct = performance.now();
    var pal = (PALETTES[opts.palette] || PALETTES[CH.palette] || PALETTES.wine).map(hex);
    var cc = pal.map(function (c) { return c.slice(); });
    var analyser = null, abuf = null;

    function setState(name) {
      if (!STATES[name]) { console.warn('VoxaMascot: unknown state', name); return; }
      state = name; temp = null; lastAct = performance.now();
      if (name === 'error') errAt = performance.now();
    }
    function react(name, ms) {
      if (!STATES[name]) return;
      temp = name; tempUntil = performance.now() + (ms || 900); lastAct = performance.now();
      if (state === 'sleep') state = 'idle';
    }
    function poke() {
      var now = performance.now(); lastAct = now; pv = 2.4;
      if (state === 'sleep') state = 'idle';
      clicks = clicks.filter(function (c) { return now - c < 1500; }); clicks.push(now);
      if (opts.onPoke) opts.onPoke(clicks.length);
      if (state !== 'idle') return;
      if (clicks.length >= 3) react('annoyed', 2000);
      else if (clicks.length === 2) react('happy', 1100);
      else react('surprised', 650);
    }
    function onMove(e) {
      var r = el.getBoundingClientRect(), now = performance.now();
      var dx = e.clientX - (r.left + r.width / 2), dy = e.clientY - (r.top + r.height / 2);
      ptr = [clamp(dx / 240, -1, 1), clamp(dy / 240, -1, 1)];
      pd = Math.sqrt(dx * dx + dy * dy);
      var sp = lt ? Math.sqrt(Math.pow(e.clientX - lx, 2) + Math.pow(e.clientY - ly, 2)) / Math.max(1, now - lt) * 1000 : 0;
      lx = e.clientX; ly = e.clientY; lt = now; lastPtr = now;
      if (sp > 3200 && state === 'idle' && !temp && now > coolSurp) { react('surprised', 700); coolSurp = now + 4000; }
    }
    window.addEventListener('pointermove', onMove, { passive: true });
    el.addEventListener('pointerdown', poke);

    function gazeTarget(name, now) {
      if (manual) return manual;
      if (name === 'thinking') return [0.7, -0.8];
      if (name === 'sleep') return [0, 0.4];
      if (name === 'shy') return [-0.9, 0.6];
      if (opts.follow && now - lastPtr < 4000) return ptr;
      if (now > nextWander) { wander = [Math.random() * 1.4 - 0.7, Math.random() - 0.5]; nextWander = now + 1600 + Math.random() * 2200; }
      return wander;
    }
    function tr(g, v) { g.setAttribute('transform', v); }
    function f2(v) { return v.toFixed(2); }

    function frame() {
      raf = requestAnimationFrame(frame);
      var now = performance.now();
      var dt = Math.min(0.05, (now - last) / 1000 || 0.016); last = now; t += dt;
      var rm = rmq.matches ? 0.3 : 1;
      if (temp && now > tempUntil) temp = null;
      if (opts.autoSleep && state === 'idle' && now - lastAct > opts.autoSleep) state = 'sleep';
      var name = temp || state, S = STATES[name];

      if (analyser) {
        analyser.getByteTimeDomainData(abuf);
        var s = 0; for (var i = 0; i < abuf.length; i++) { var v = (abuf[i] - 128) / 128; s += v * v; }
        lvlT = clamp(Math.sqrt(s / abuf.length) * 3.2, 0, 1);
      }
      lvl += (lvlT - lvl) * Math.min(1, dt * 16);

      // cursor proximity: lean in, wake up, get shy if it lingers
      var near = (now - lastPtr < 500) && pd < 80;
      if (near && state === 'sleep') { state = 'idle'; lastAct = now; }
      nearT = near ? nearT + dt : 0;
      if (nearT > 1.3 && !temp && state === 'idle' && now > coolShy) { react('shy', 1800); coolShy = now + 8000; }
      lean = lerp(lean, near ? 1 : 0, Math.min(1, dt * 5));

      var k = Math.min(1, dt * 7);
      lid = lerp(lid, S.lid * CH.lidK, k); by = lerp(by, S.by, k); ba = lerp(ba, S.ba, k); tl = lerp(tl, S.tl, k);
      chk = lerp(chk, S.cheek, k); es = lerp(es, S.es, k); lift = lerp(lift, S.lift, k);
      breath = lerp(breath, S.breath * rm, k); spd = lerp(spd, S.speed, k);
      ringsOn = lerp(ringsOn, opts.fx === false ? 0 : name === 'listening' ? 1 : name === 'speaking' ? 0.45 : 0, k);
      orbitOn = lerp(orbitOn, opts.fx !== false && name === 'thinking' ? 1 : 0, k);
      zOn = lerp(zOn, name === 'sleep' && opts.zzz !== false ? 1 : 0, k);
      heartOn = lerp(heartOn, S.heart ? 1 : 0, k);

      for (var c = 0; c < 2; c++) for (var j = 0; j < 3; j++) cc[c][j] = lerp(cc[c][j], pal[c][j], Math.min(1, dt * 5));
      var c0 = css(cc[0]), c1 = css(cc[1]);
      stops.s0.setAttribute('stop-color', c0); stops.s1.setAttribute('stop-color', c1); tailP.setAttribute('fill', c1);
      ringsG.setAttribute('stroke', c0); orbitG.setAttribute('fill', c0);

      // whole body: breathing, bob, poke squash, error shake
      pv += (-180 * p - 12 * pv) * dt; p += pv * dt;
      var et = (now - errAt) / 1000;
      var shake = (name === 'error' && et < 0.7 && rm === 1) ? Math.sin(et * 46) * (1 - et / 0.7) * 4 : 0;
      var bob = Math.sin(t * 1.5 * spd) * 1.1 * rm + Math.sin(t * 1.6) * breath * 40;
      var hop = -Math.max(0, p) * 10;
      tr(bodyG, 'translate(' + f2(shake) + ',' + f2(bob + hop) + ') translate(0,40) scale(' + f2(1 + p * 0.8) + ',' + f2(1 - p * 0.7) + ') translate(0,-40)');

      // gaze: head turns a little, face and eyes move more, hair layers lag for depth
      var g = gazeTarget(name, now);
      gx += (g[0] - gx) * Math.min(1, dt * 9); gy += (g[1] - gy) * Math.min(1, dt * 9);
      var nod = name === 'speaking' ? lvl * 2 : 0;
      tr(headG, 'translate(' + f2(gx * 2.2) + ',' + f2(gy * 1.6 - lean * 2 + nod) + ') rotate(' + f2(gx * 4 + tl + (opts.tilt || 0)) + ' 0 30) scale(' + f2(1 + lean * 0.04) + ')');
      tr(faceG, 'translate(' + f2(gx * 2) + ',' + f2(gy * 1.6) + ')');
      tr(eyesG, 'translate(' + f2(gx * 3) + ',' + f2(gy * 2.2) + ')');
      tr(bangsG, 'translate(' + f2(gx * 1.4) + ',' + f2(gy + Math.sin(t * 2.1 + seed) * 0.5 * rm) + ')');
      tr(hbackG, 'translate(' + f2(-gx) + ',' + f2(-gy * 0.6) + ')');
      tr(scarfG, 'translate(0,' + f2(lift - (name === 'speaking' ? lvl * 2.5 : 0)) + ')');
      tr(tailG, 'rotate(' + f2(Math.sin(t * 1.7 + seed) * 4 * rm) + ' 22 50)');

      // blink + eye style
      if (opts.autoBlink && name !== 'sleep' && name !== 'happy' && name !== 'error' && now > nextBlink) {
        blinkStart = now; nextBlink = now + 2200 + Math.random() * 3800;
        if (Math.random() < 0.18) nextBlink = now + 260;
      }
      var bp = (now - blinkStart) / 140, blink = (bp >= 0 && bp < 1) ? 1 - Math.sin(bp * Math.PI) * 0.92 : 1;
      var sy = Math.max(0.07, (1 - lid * 0.72) * blink) * es;
      ess.forEach(function (e) { tr(e, 'translate(0,6) scale(' + f2(es) + ',' + f2(sy) + ') translate(0,-6)'); });
      lids.forEach(function (l) { tr(l, 'translate(0,' + f2(6 - 12 * sy - 0.6) + ')'); });
      if (S.v !== curVariant) {
        curVariant = S.v;
        variants.forEach(function (v) { v.style.display = (v.getAttribute('data-v') === curVariant) ? '' : 'none'; });
      }
      cheeks.forEach(function (ch) { ch.setAttribute('opacity', Math.min(1, chk * 0.7 * CH.cheekK).toFixed(3)); });
      tr(brows[0], 'translate(-15,' + f2(-1 + by) + ') rotate(' + f2(ba) + ')');
      tr(brows[1], 'translate(15,' + f2(-1 + by) + ') rotate(' + f2(-ba) + ')');

      // small mouth peeks above the scarf only while speaking or happy
      var MO = CH.mouth, calm = name === 'error' || name === 'sleep';
      var mT = name === 'speaking' ? 0.8 + lvl * 3.8 : (name === 'happy' || name === 'love') ? (MO.happy || 1.8) : calm ? 0.6 : MO.ry;
      var mpT = (name === 'speaking' || name === 'happy' || name === 'love') ? 1 : calm ? (MO.op ? 1 : 0) : MO.op;
      var mk = Math.min(1, dt * (name === 'speaking' ? 24 : 10));
      mo = lerp(mo, mT, mk); mop = lerp(mop, mpT, mk);
      mouth.setAttribute('ry', mo.toFixed(2)); mouth.setAttribute('opacity', mop.toFixed(3));

      // listening rings
      for (var q = 0; q < 3; q++) {
        var ph = ((t * 0.85 * (rm < 1 ? 0.3 : 1)) + q / 3) % 1;
        rings[q].setAttribute('r', (50 + ph * 16).toFixed(1));
        rings[q].setAttribute('opacity', (ringsOn * (1 - ph) * (0.28 + lvl * 0.8)).toFixed(3));
      }
      // thinking dots
      for (var o = 0; o < 3; o++) {
        var oa = t * 2.4 * (rm < 1 ? 0.3 : 1) + o * TAU / 3;
        orbit[o].setAttribute('cx', (Math.cos(oa) * 56).toFixed(2));
        orbit[o].setAttribute('cy', (Math.sin(oa) * 56).toFixed(2));
        orbit[o].setAttribute('r', (2.6 + 1.2 * (0.5 + 0.5 * Math.sin(t * 5 + o))).toFixed(2));
        orbit[o].setAttribute('opacity', (orbitOn * 0.95).toFixed(3));
      }
      tr(heartG, 'translate(' + (opts.heartX || 44) + ',' + f2(-38 - heartOn * 8 - Math.sin(t * 4) * 2 * rm) + ') scale(' + f2(0.3 + heartOn * 0.65) + ')');
      heartG.setAttribute('opacity', heartOn.toFixed(3));
      // sleeping z's
      for (var z = 0; z < 2; z++) {
        var fl = (t * 8 + z * 6) % 14;
        zs[z].setAttribute('transform', 'translate(0,' + (-fl).toFixed(2) + ')');
        zs[z].setAttribute('opacity', (zOn * (1 - fl / 14)).toFixed(3));
      }
    }
    raf = requestAnimationFrame(frame);

    return {
      setState: setState,
      react: react,
      getState: function () { return temp || state; },
      setLevel: function (v) { lvlT = clamp(+v || 0, 0, 1); },
      setPalette: function (nameOrPair) {
        var pair = Array.isArray(nameOrPair) ? nameOrPair : (PALETTES[nameOrPair] || PALETTES.wine);
        pal = pair.map(hex);
      },
      setFollow: function (b) { opts.follow = !!b; },
      lookAt: function (x, y) { manual = (x == null) ? null : [clamp(x, -1, 1), clamp(y, -1, 1)]; },
      poke: poke,
      pointerAt: function (x, y) { onMove({ clientX: x, clientY: y }); },
      connectAnalyser: function (node) { analyser = node; abuf = new Uint8Array(node.fftSize); },
      destroy: function () {
        cancelAnimationFrame(raf);
        window.removeEventListener('pointermove', onMove);
        el.removeEventListener('pointerdown', poke);
        el.innerHTML = '';
      }
    };
  }
  Mascot.states = Object.keys(STATES);
  Mascot.palettes = PALETTES;

  /* ------------------------------ Couple ------------------------------ */
  // Two characters sharing one slot. Same API as Mascot.
  function Couple(el, opts) {
    opts = Object.assign({ follow: true, autoBlink: true, affection: true }, opts || {});
    el.innerHTML = '<div class="vx-cb"></div><div class="vx-cg"></div>';
    var common = { follow: opts.follow, autoBlink: opts.autoBlink, fx: false };
    var boy, girl, speaking = false, lastMove = 0, affT = 0, seqT = [];
    function idle(m) { return m.getState() === 'idle'; }
    boy = Mascot(el.firstChild, Object.assign({}, common, {
      character: 'boy', palette: 'boy', tilt: 5, heartX: 46, zzz: false,
      onPoke: function (n) { if (idle(girl)) girl.react(n >= 3 ? 'surprised' : 'shy', 1500); }
    }));
    girl = Mascot(el.lastChild, Object.assign({}, common, {
      character: 'girl', palette: opts.palette || 'brick', tilt: -5, heartX: -46,
      onPoke: function (n) { if (idle(boy)) boy.react(n >= 3 ? 'surprised' : 'happy', 1300); }
    }));

    function onMove() { lastMove = performance.now(); }
    window.addEventListener('pointermove', onMove, { passive: true });
    function clearSeq() { seqT.forEach(clearTimeout); seqT = []; }

    // while she is asked something or he is speaking, the other one reacts to it
    var SPLIT = { speaking: ['speaking', 'idle'], error: ['error', 'ask'], approval: ['ask', 'ask'] };
    function setState(n) {
      clearSeq();
      var m = SPLIT[n] || [n, n];
      boy.setState(m[0]); girl.setState(m[1]); speaking = n === 'speaking';
      if (speaking) girl.lookAt(-0.9, 0.1); else { girl.lookAt(null); boy.lookAt(null); }
    }
    function react(n, ms) {
      if (n === 'shy') { girl.react('shy', ms); boy.react('happy', ms); }
      else if (n === 'annoyed') { girl.react('annoyed', ms); boy.react('surprised', 800); }
      else if (n === 'love') { boy.react('love', ms || 1500); girl.react('love', ms || 1500); }
      else { boy.react(n, ms); girl.react(n, ms); }
    }

    // every so often, when nobody is touching them, they glance at each other
    function affection() {
      affT = setTimeout(function () {
        if (opts.affection !== false && !document.hidden && idle(boy) && idle(girl) && performance.now() - lastMove > 3500) {
          boy.lookAt(0.9, 0.15); girl.lookAt(-0.9, 0.15);
          seqT.push(setTimeout(function () { girl.react('shy', 1700); }, 800));
          seqT.push(setTimeout(function () { react('love', 1500); }, 1700));
          seqT.push(setTimeout(function () { boy.lookAt(null); girl.lookAt(null); }, 3600));
        }
        affection();
      }, 9000 + Math.random() * 9000);
    }
    affection();

    return {
      setState: setState,
      react: react,
      getState: function () { return boy.getState(); },
      setLevel: function (v) { boy.setLevel(v); girl.setLevel(speaking ? 0 : v); },
      setPalette: function (p) { girl.setPalette(p); },
      setFollow: function (b) { boy.setFollow(b); girl.setFollow(b); },
      lookAt: function (x, y) { boy.lookAt(x, y); girl.lookAt(x, y); },
      poke: function () { boy.poke(); girl.poke(); },
      pointerAt: function (x, y) { boy.pointerAt(x, y); girl.pointerAt(x, y); },
      connectAnalyser: function (node) { boy.connectAnalyser(node); },
      destroy: function () {
        clearTimeout(affT); clearSeq();
        window.removeEventListener('pointermove', onMove);
        boy.destroy(); girl.destroy(); el.innerHTML = '';
      }
    };
  }

  /* ------------------------------ Notch ------------------------------- */
  var LABEL = { idle: 'Ready', listening: 'Listening', thinking: 'Thinking', executing: 'Working', verifying: 'Checking', approval: 'Needs approval', answer: 'Answer', speaking: 'Speaking', happy: 'Done', error: 'Something went wrong', sleep: 'Asleep', paused: 'Paused', chat: 'Chat' };
  var MASCOT = { idle: 'idle', listening: 'listening', thinking: 'thinking', executing: 'thinking', verifying: 'thinking', approval: 'ask', answer: 'idle', speaking: 'speaking', happy: 'happy', error: 'error', sleep: 'sleep', paused: 'sleep', chat: 'idle' };
  var DEFAULT_SIZE = { idle: 'compact', sleep: 'compact', paused: 'compact', listening: 'medium', thinking: 'medium', executing: 'medium', verifying: 'medium', happy: 'medium', approval: 'expanded', answer: 'expanded', speaking: 'expanded', error: 'expanded', chat: 'chat' };
  var SVG = function (inner) { return '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">' + inner + '</svg>'; };
  var ICON = {
    settings: SVG('<circle cx="8" cy="8" r="2.2"/><path d="M8 1.8v2M8 12.2v2M1.8 8h2M12.2 8h2M3.6 3.6L5 5M11 11l1.4 1.4M12.4 3.6L11 5M5 11l-1.4 1.4"/>'),
    copy: SVG('<rect x="5.5" y="5.5" width="7.5" height="7.5" rx="2"/><path d="M3 10V4.5A1.5 1.5 0 0 1 4.5 3H10"/>'),
    retry: SVG('<path d="M13 8a5 5 0 1 1-1.6-3.7M13 2.6V5.2h-2.6"/>'),
    stop: '<svg viewBox="0 0 16 16" width="14" height="14"><rect x="3.5" y="3.5" width="9" height="9" rx="2" fill="currentColor"/></svg>',
    collapse: SVG('<path d="M4 10l4-4 4 4"/>'),
    send: SVG('<path d="M3 8h9M8.5 4L12.5 8l-4 4"/>')
  };
  var BTN = function (act, label) { return '<button type="button" class="vx-btn" data-act="' + act + '" aria-label="' + label + '" title="' + label + '">' + ICON[act] + '</button>'; };

  var Notch = {
    mount: function (root, opts) {
      opts = opts || {};
      root.classList.add('vx-notch'); if (opts.fixed) root.classList.add('vx-fixed');
      root.setAttribute('data-size', 'compact'); root.setAttribute('data-state', 'idle');
      root.setAttribute('data-style', opts.style || 'island'); root.setAttribute('data-companion', 'on');
      root.setAttribute('data-stop', 'false'); root.setAttribute('data-spec', 'false');
      root.setAttribute('data-cast', opts.cast || 'bob');
      var bars = ''; for (var b = 0; b < 16; b++) bars += '<i></i>';
      root.innerHTML =
        '<div class="vx-slot"></div>' +
        '<div class="vx-head"><span class="vx-name">Voxa</span><span class="vx-status">Ready</span><span class="vx-mode"></span></div>' +
        '<div class="vx-text" aria-live="polite"></div>' +
        '<div class="vx-spec" aria-hidden="true">' + bars + '</div>' +
        '<div class="vx-log" aria-live="polite"></div>' +
        '<div class="vx-bar"><input class="vx-input" type="text" placeholder="Ask Voxa" aria-label="Message Voxa" autocomplete="off">' + BTN('send', 'Send') + '</div>' +
        '<div class="vx-extra"><div class="vx-appr"><button type="button" class="vx-yes" data-act="allow">Allow</button><button type="button" class="vx-no" data-act="deny">Deny</button></div></div>' +
        '<div class="vx-actions">' + BTN('settings', 'Settings') + BTN('copy', 'Copy answer') + BTN('retry', 'Try again') + BTN('stop', 'Stop') + BTN('collapse', 'Collapse') + '</div>';
      var pillEl = document.createElement('div');
      pillEl.className = 'vx-pill';
      pillEl.innerHTML = '<span class="vx-ptext"></span><span class="vx-pbar"><i></i></span><button type="button" class="vx-btn vx-pcancel" data-pact="cancel" aria-label="Cancel" title="Cancel"><svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M4 4l8 8M12 4l-8 8"/></svg></button>';
      root.parentNode.insertBefore(pillEl, root.nextSibling);

      var curCast = opts.cast || 'bob';
      function makeMascot(c) {
        var slot = root.querySelector('.vx-slot'), o = Object.assign({}, opts.mascot || {});
        if (c === 'couple') return Couple(slot, o);
        o.character = c; return Mascot(slot, o);
      }
      var mascot = makeMascot(curCast);
      var $ = function (s) { return root.querySelector(s); };
      var textEl = $('.vx-text'), statusEl = $('.vx-status'), modeEl = $('.vx-mode'), logEl = $('.vx-log'), inputEl = $('.vx-input');
      var specBars = Array.prototype.slice.call(root.querySelectorAll('.vx-spec i'));
      var raw = '', typeT = null, lingerT = null, pillT = null, copyT = null, hovered = false, lingerDue = false;
      var hasBands = false, streaming = false, curState = 'idle', lastRect = '', tracking = false, trackEnd = 0;
      var lastM = 'idle'; function setM(s) { lastM = s; mascot.setState(s); }
      var api = { mascot: mascot, onAction: null, onChatSend: null, chat: {}, hit: null };

      function render() { if (opts.renderText) opts.renderText(textEl, raw); else textEl.textContent = raw; }
      function layout() {
        var r = root.getBoundingClientRect(), fixed = getComputedStyle(root).position === 'fixed';
        pillEl.style.position = fixed ? 'fixed' : 'absolute';
        pillEl.style.top = Math.round((fixed ? r.bottom : root.offsetTop + root.offsetHeight) + 8) + 'px';
        var rs = [r]; if (pillEl.classList.contains('on')) rs.push(pillEl.getBoundingClientRect());
        var x1 = Math.min.apply(null, rs.map(function (q) { return q.left; })), y1 = Math.min.apply(null, rs.map(function (q) { return q.top; }));
        var x2 = Math.max.apply(null, rs.map(function (q) { return q.right; })), y2 = Math.max.apply(null, rs.map(function (q) { return q.bottom; }));
        var key = [x1, y1, x2, y2].map(Math.round).join();
        if (key !== lastRect) {
          lastRect = key; api.hit = { x: Math.round(x1), y: Math.round(y1), width: Math.round(x2 - x1), height: Math.round(y2 - y1) };
          if (opts.onHitRect) opts.onHitRect(api.hit);
        }
      }
      function track(ms) {
        trackEnd = performance.now() + ms; if (tracking) return; tracking = true;
        (function step() { layout(); if (performance.now() < trackEnd) requestAnimationFrame(step); else tracking = false; })();
      }
      function setSize(s) { root.setAttribute('data-size', s); track(900); }
      function setText(str, o) {
        o = o || {}; clearInterval(typeT); raw = str || '';
        if (!o.type || !str) { render(); if (o.onDone) o.onDone(); return; }
        var words = raw.split(' '), i = 0;
        typeT = setInterval(function () {
          i++; textEl.textContent = words.slice(0, i).join(' ');
          if (i >= words.length) { clearInterval(typeT); render(); if (o.onDone) o.onDone(); }
        }, 95);
      }
      function armLinger(ms) {
        clearTimeout(lingerT); lingerDue = false; if (!ms) return;
        lingerT = setTimeout(function () { if (hovered) lingerDue = true; else api.fold(); }, ms);
      }
      function setStop(on) { root.setAttribute('data-stop', String(!!on)); }

      api.show = function (state, o) {
        o = o || {};
        clearTimeout(lingerT); lingerDue = false; hasBands = false; curState = state;
        root.setAttribute('data-state', state); root.setAttribute('data-spec', 'false');
        var spoken = state === 'speaking' || (state === 'answer' && !!o.spoken);
        setStop(spoken || /^(listening|thinking|executing|verifying)$/.test(state) || (state === 'chat' && streaming));
        statusEl.textContent = o.title || LABEL[state] || '';
        if (o.mode !== undefined) api.setMode(o.mode);
        setM(state === 'answer' ? (spoken ? 'speaking' : 'idle') : (MASCOT[state] || 'idle'));
        setSize(o.size || DEFAULT_SIZE[state] || 'compact');
        if (state === 'chat') setTimeout(function () { inputEl.focus(); }, 350);
        setText(o.text || '', { type: !!o.type, onDone: function () { if (o.onTyped) o.onTyped(); armLinger(o.lingerMs); } });
      };
      api.applyState = function (s) { if (s && s.state) api.show(s.state, s); };   // pass your overlay snapshot, mapped to { state, text, title, spoken, mode }
      api.setSize = setSize;
      api.setText = setText;
      api.appendText = function (chunk) { clearInterval(typeT); raw += chunk; render(); };
      api.fold = function () {
        clearTimeout(lingerT); clearInterval(typeT); lingerDue = false; hasBands = false; curState = 'idle';
        mascot.setLevel(0); raw = '';
        root.setAttribute('data-state', 'idle'); root.setAttribute('data-spec', 'false'); setStop(false);
        statusEl.textContent = LABEL.idle; setM('idle'); setSize('compact'); textEl.textContent = '';
        if (opts.onFold) opts.onFold();
      };
      api.hide = api.fold;
      api.setLevel = function (v) { mascot.setLevel(v); };
      api.setBands = function (a) {
        if (!a || curState !== 'listening' || root.getAttribute('data-size') === 'compact') return;
        if (!hasBands) { hasBands = true; root.setAttribute('data-spec', 'true'); }
        for (var i = 0; i < 16; i++) specBars[i].style.transform = 'scaleY(' + Math.max(0.1, Math.min(1, a[i] || 0)).toFixed(3) + ')';
      };
      api.setCursor = function (x, y) { mascot.pointerAt(x, y); };   // for click-through windows that receive the cursor over IPC
      api.setMode = function (m) { modeEl.textContent = m ? String(m).charAt(0).toUpperCase() + String(m).slice(1) : ''; };
      api.setStyle = function (s) { root.setAttribute('data-style', s === 'notch' ? 'notch' : 'island'); track(300); };
      api.setCast = function (c) {   // 'bob' | 'girl' | 'boy' | 'couple'
        if (c === curCast) return;
        curCast = c; mascot.destroy(); mascot = makeMascot(c); api.mascot = mascot;
        root.setAttribute('data-cast', c); mascot.setState(lastM); track(900);
      };
      api.setCompanion = function (on) { root.setAttribute('data-companion', on ? 'on' : 'off'); };
      api.getHitRect = function () { layout(); return api.hit; };

      api.pill = function (text, o) {
        o = o || {}; clearTimeout(pillT);
        pillEl.querySelector('.vx-ptext').textContent = text || '';
        var has = typeof o.progress === 'number';
        pillEl.setAttribute('data-progress', String(has)); pillEl.setAttribute('data-cancel', String(!!o.cancel));
        pillEl.querySelector('.vx-pbar i').style.width = has ? Math.round(clamp(o.progress, 0, 1) * 100) + '%' : '0';
        pillEl.classList.add('on'); if (o.ms) pillT = setTimeout(api.pillClear, o.ms);
        track(400);
      };
      api.pillClear = function () { clearTimeout(pillT); pillEl.classList.remove('on'); track(200); };

      function addMsg(role, text) {
        var d = document.createElement('div'); d.className = 'vx-msg ' + (role === 'user' ? 'user' : 'ai'); d._raw = text || '';
        fill(d); logEl.appendChild(d); logEl.scrollTop = logEl.scrollHeight; return d;
      }
      function fill(d) { if (opts.renderText && d.classList.contains('ai')) opts.renderText(d, d._raw); else d.textContent = d._raw; }
      api.chat.add = addMsg;
      api.chat.append = function (chunk) {
        var ai = logEl.querySelectorAll('.vx-msg.ai'), d = ai.length ? ai[ai.length - 1] : addMsg('ai', '');
        d._raw += chunk; fill(d); logEl.scrollTop = logEl.scrollHeight;
      };
      api.chat.clear = function () { logEl.innerHTML = ''; };
      api.chat.setStreaming = function (on) { streaming = !!on; if (curState === 'chat') setStop(streaming); };
      function sendChat() {
        var v = inputEl.value.trim(); if (!v) return;
        inputEl.value = ''; addMsg('user', v); if (api.onChatSend) api.onChatSend(v);
      }
      inputEl.addEventListener('keydown', function (e) { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(); } });

      function act(a) {
        if (api.onAction) api.onAction(a);
        if (a === 'collapse' || a === 'stop') api.fold();
        if (a === 'copy') {
          var cb = $('[data-act=copy]'); cb.classList.add('ok'); cb.title = 'Copied'; clearTimeout(copyT);
          copyT = setTimeout(function () { cb.classList.remove('ok'); cb.title = 'Copy answer'; }, 1400);
        }
      }
      function onKey(e) {
        if (curState === 'approval') {
          if (e.key === 'Enter') { e.preventDefault(); act('allow'); } else if (e.key === 'Escape') { act('deny'); }
        } else if (curState === 'chat' && e.key === 'Escape') act('collapse');
      }
      document.addEventListener('keydown', onKey);
      root.addEventListener('mouseenter', function () { hovered = true; });
      root.addEventListener('mouseleave', function () { hovered = false; if (lingerDue) api.fold(); });
      root.addEventListener('click', function (e) {
        var b = e.target.closest('[data-act]'); if (!b) return;
        if (b.getAttribute('data-act') === 'send') return sendChat();
        act(b.getAttribute('data-act'));
      });
      pillEl.addEventListener('click', function (e) { if (e.target.closest('[data-pact=cancel]') && api.onAction) api.onAction('download-cancel'); });
      api.destroy = function () { document.removeEventListener('keydown', onKey); mascot.destroy(); pillEl.remove(); };
      track(300);
      return api;
    }
  };

  global.VoxaMascot = Mascot;
  global.VoxaNotch = Notch;
})(window);
