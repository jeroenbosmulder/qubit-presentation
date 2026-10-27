/* presenter-kit.js — drop-in presenter view for any project page.
   One tag: <script src="presenter-kit.js"></script> (before or after React — it waits).
   P — opens a clean mirror window (same URL + ?present=1) that follows slides live.
   N — toggles an editable speaker-notes panel (reads data-speaker-notes off deck-stage slides;
       plain pages get a free-form pad; edits persist in localStorage).
   State sync — window.React.useState is wrapped so every JSON-serializable piece of hook
   state broadcasts from the presenter window and applies in the mirror automatically.
   Frame-rate hooks (driven by requestAnimationFrame) are detected and NOT streamed per frame:
   they go out at ≤4/s plus a final value, and the mirror ignores them for any hook it is
   animating itself — the mirror runs its own animation from the synced triggers.
   Room memos (figure histories) go out as deltas (appended points), not whole arrays.
   No deck-stage? P still mirrors scroll position. Same-browser only (BroadcastChannel). */
(function () {
  if (!('BroadcastChannel' in window) || window.__presenterKit) return;
  window.__presenterKit = true;
  var isMirror = /[?&]present(=|&|$)/.test(location.search) || location.hash.indexOf('present') >= 0;
  var CH = 'pk:' + location.pathname;
  var bc = new BroadcastChannel(CH);
  var stage = function () { return document.querySelector('deck-stage'); };
  var now = function () { return performance.now(); };

  /* ── automatic React useState sync ──
     No extra hooks are injected (safe to patch at any time, even after first render);
     hook instances are identified by their setter (stable in React) and numbered in
     first-seen order, which matches across two windows running the same page. */
  var registry = {}, ids = typeof WeakMap === 'function' ? new WeakMap() : null,
      pending = {}, lastVal = {}, lastJson = {}, cache = {}, vals = {}, nextId = 0;
  // frame-rate detection: ≥ HOT_MIN consecutive changes closer than HOT_GAP ms → "hot" until HOT_QUIET ms of silence
  var HOT_GAP = 60, HOT_MIN = 3, HOT_EVERY = 250, HOT_QUIET = 300;
  var hotAt = {}, hotRun = {}, hotSince = {}, hotSent = {}, hotTimer = {};
  function noteChange(id) {
    var t = now(), gap = t - (hotAt[id] === undefined ? -1e9 : hotAt[id]);
    hotAt[id] = t;
    hotRun[id] = gap < HOT_GAP ? (hotRun[id] || 0) + 1 : 0;
    if (hotRun[id] >= HOT_MIN) hotSince[id] = t;
  }
  function isHot(id) { return hotSince[id] !== undefined && now() - hotAt[id] < HOT_QUIET && now() - hotSince[id] < HOT_QUIET; }
  function kind(v) { return v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v; }
  function applyJson(id, json) {
    if (isHot(id)) return;                                     // the mirror animates this one itself
    var nv; try { nv = JSON.parse(json); } catch (err) { return; }
    if (id in vals && kind(vals[id]) !== kind(nv)) return;   // hook order drifted between windows — never force a wrong-typed value
    try { registry[id](nv); } catch (err) {}
  }
  function sendState(id) { hotSent[id] = now(); bc.postMessage({ pkState: id, json: cache[id] }); }
  function patchReact(R) {
    if (!R || !R.useState || R.__pkPatched || !ids) return;
    R.__pkPatched = true;
    var orig = R.useState;
    R.useLocalState = orig;                                    // opt-out: a hook that must never sync
    R.useState = function (init) {
      var pair = orig(init);
      var set = pair[1], id = ids.get(set);
      if (id === undefined) {
        id = nextId++; ids.set(set, id); registry[id] = set;
        if (isMirror && pending[id] !== undefined) {
          (function (pid, pv) { setTimeout(function () { applyJson(pid, pv); }, 0); })(id, pending[id]);
          delete pending[id];
        }
      }
      var v = pair[0];
      vals[id] = v;
      if (v !== lastVal[id] || !(id in lastVal)) {             // identity first — stringify only what actually changed
        lastVal[id] = v;
        var json;
        try { json = JSON.stringify(v); } catch (err) { json = undefined; }
        if (json !== undefined && json !== lastJson[id]) {
          lastJson[id] = json; cache[id] = json;
          noteChange(id);
          if (!isMirror) {
            clearTimeout(hotTimer[id]);
            if (!isHot(id)) sendState(id);
            else {
              if (now() - (hotSent[id] || 0) >= HOT_EVERY) sendState(id);
              hotTimer[id] = setTimeout(function () { sendState(id); }, HOT_QUIET);   // the resting value, once the animation ends
            }
          }
        }
      }
      return pair;
    };
  }
  if (window.React) patchReact(window.React);
  else {
    // patch the moment React lands, before any module can capture `const { useState } = React`
    var _R;
    try {
      Object.defineProperty(window, 'React', {
        configurable: true, enumerable: true,
        get: function () { return _R; },
        set: function (v) { _R = v; patchReact(v); },
      });
    } catch (err) {}
  }
  setInterval(function () {
    if (window.React && !window.React.__pkPatched) patchReact(window.React);
  }, 100);

  /* ── room memo + state sync (the Room store, outside React state) ──
     presenter: a changed memo key goes out as a delta — appended array points, per-subkey for objects of
     arrays, full value otherwise (structured clone, no JSON); mirror: applies, asks for a full copy on mismatch. */
  var roomStore = function () { return window.Room && window.Room.presenter ? window.Room.presenter() : null; };
  var memoRef = {}, stateRef = {}, memoQueue = [], memoT = null;
  function isObj(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
  function diff(prev, next) {
    if (prev === next) return null;
    if (Array.isArray(next) && Array.isArray(prev) && next.length >= prev.length &&
        (prev.length === 0 || (next[0] === prev[0] && next[prev.length - 1] === prev[prev.length - 1]))) {
      return next.length === prev.length ? null : { base: prev.length, append: next.slice(prev.length) };
    }
    if (isObj(next) && isObj(prev)) {
      var sub = {}, any = false;
      Object.keys(next).forEach(function (k) { var d = diff(prev[k], next[k]); if (d) { sub[k] = d; any = true; } });
      Object.keys(prev).forEach(function (k) { if (!(k in next)) { sub[k] = { del: true }; any = true; } });
      return any ? { sub: sub } : null;
    }
    return { full: next };
  }
  function applyDiff(cur, d) {
    if (d.del) return undefined;
    if ('full' in d) return d.full;
    if (d.append) {
      if (cur === undefined && d.base === 0) cur = [];
      if (!Array.isArray(cur) || cur.length !== d.base) throw new Error('memo drift');
      return cur.concat(d.append);
    }
    if (d.sub) {
      var o = {}; if (isObj(cur)) Object.keys(cur).forEach(function (k) { o[k] = cur[k]; });
      Object.keys(d.sub).forEach(function (k) { var v = applyDiff(o[k], d.sub[k]); if (v === undefined) delete o[k]; else o[k] = v; });
      return o;
    }
    return cur;
  }
  function pushMemo(all) {
    var p = roomStore(); if (!p) return;
    var cur = p.get(), m = cur.memo || {}, st = cur.state || {};
    Object.keys(m).forEach(function (k) {
      var d = all ? { full: m[k] } : diff(memoRef[k], m[k]);
      memoRef[k] = m[k];
      if (d) { try { bc.postMessage({ pkMemo: k, d: d }); } catch (err) { bc.postMessage({ pkMemo: k, d: { full: JSON.parse(JSON.stringify(m[k])) } }); } }
    });
    Object.keys(memoRef).forEach(function (k) { if (!(k in m)) { delete memoRef[k]; bc.postMessage({ pkMemo: k, d: { del: true } }); } });
    // the presenter's published room state (collect, round, scene …) goes over the same channel: immediate, no relay hop
    Object.keys(st).forEach(function (k) {
      if (all || st[k] !== stateRef[k]) { stateRef[k] = st[k]; bc.postMessage({ pkRoom: k, v: st[k] }); }
    });
  }
  function applyMemo(d) {
    var p = roomStore(); if (!p) { memoQueue.push(d); return; }
    if (d.pkRoom !== undefined) { var patch = {}; patch[d.pkRoom] = d.v; if (p.applyState) p.applyState(patch); return; }
    var k = d.pkMemo, m = p.get().memo || {};
    try { p.setMemo(k, applyDiff(m[k], d.d), true); }
    catch (err) { bc.postMessage({ needMemo: k }); }
  }
  var memoPoll = setInterval(function () {
    var p = roomStore(); if (!p) return;
    clearInterval(memoPoll);
    if (isMirror) { var q = memoQueue; memoQueue = []; q.forEach(applyMemo); return; }
    p.subscribe(function () { if (memoT) return; memoT = setTimeout(function () { memoT = null; pushMemo(false); }, 30); });
    pushMemo(true);
  }, 100);

  if (isMirror) {
    /* ── mirror window: clean view, apply everything ── */
    var tidy = function () {
      var s = stage();
      if (!s) return void setTimeout(tidy, 200);
      s.setAttribute('no-rail', '');
    };
    tidy();
    bc.postMessage({ hello: true });
    bc.addEventListener('message', function (e) {
      var d = e.data || {};
      if (d.pkState !== undefined) {
        if (registry[d.pkState]) applyJson(d.pkState, d.json);
        else pending[d.pkState] = d.json;
      }
      if (typeof d.pkMemo === 'string' || typeof d.pkRoom === 'string') applyMemo(d);
      if (typeof d.index === 'number') { var s = stage(); if (s && s.goTo) s.goTo(d.index); }
      if (typeof d.scroll === 'number') window.scrollTo(0, d.scroll);
    });
    return;
  }

  /* ── presenter window ── */
  var lastIndex = 0;
  bc.addEventListener('message', function (e) {
    var d = e.data || {};
    if (d.hello) {
      Object.keys(cache).forEach(function (k) { bc.postMessage({ pkState: +k, json: cache[k] }); });
      pushMemo(true);
      if (stage()) bc.postMessage({ index: lastIndex });
    }
    if (typeof d.needMemo === 'string') {
      var p = roomStore(), m = p && p.get().memo;
      if (m && d.needMemo in m) { memoRef[d.needMemo] = m[d.needMemo]; bc.postMessage({ pkMemo: d.needMemo, d: { full: m[d.needMemo] } }); }
    }
  });
  var scrollT = null;
  window.addEventListener('scroll', function () {
    if (stage() || scrollT) return;
    scrollT = setTimeout(function () { scrollT = null; bc.postMessage({ scroll: window.scrollY }); }, 80);
  }, { passive: true });

  /* ── speaker-notes panel (toggle with N) ── */
  var HKEY = 'pk-notes-height:' + location.pathname;
  var EKEY = 'pk-notes-edits:' + location.pathname;
  var edits = {};
  try { edits = JSON.parse(localStorage.getItem(EKEY)) || {}; } catch (err) {}
  var curSlide = null, curKey = 'page', open = false;
  var panelH = Math.max(90, Math.min(window.innerHeight * 0.6, parseInt(localStorage.getItem(HKEY), 10) || 190));
  var panel, head, body;
  function ensurePanel() {
    if (panel) return;
    panel = document.createElement('div');
    panel.id = 'pk-notes';
    panel.style.cssText = 'position:fixed;left:0;right:0;bottom:0;height:190px;box-sizing:border-box;background:#14181F;color:#FFFFFF;border-top:3px solid #6FA8DC;font-family:ui-monospace,Menlo,Consolas,monospace;z-index:9000;display:flex;flex-direction:column;';
    var grip = document.createElement('div');
    grip.style.cssText = 'position:absolute;left:0;right:0;top:-7px;height:14px;cursor:ns-resize;touch-action:none;';
    grip.addEventListener('pointerdown', function (e) {
      e.preventDefault();
      grip.setPointerCapture(e.pointerId);
      var startY = e.clientY, startH = panelH;
      var onMove = function (ev) {
        panelH = Math.max(90, Math.min(window.innerHeight * 0.6, startH + (startY - ev.clientY)));
        applyOpen();
      };
      var onUp = function () {
        grip.removeEventListener('pointermove', onMove);
        grip.removeEventListener('pointerup', onUp);
        localStorage.setItem(HKEY, String(Math.round(panelH)));
      };
      grip.addEventListener('pointermove', onMove);
      grip.addEventListener('pointerup', onUp);
    });
    panel.appendChild(grip);
    head = document.createElement('div');
    head.style.cssText = 'display:flex;justify-content:space-between;align-items:baseline;gap:16px;padding:10px 22px 4px;font-size:13px;color:#9BB4CC;flex:none;';
    body = document.createElement('div');
    body.style.cssText = 'flex:1;overflow-y:auto;padding:4px 22px 14px;font-size:17px;line-height:1.55;white-space:pre-wrap;color:#FFFFFF;outline:none;caret-color:#6FA8DC;';
    body.contentEditable = 'true';
    body.spellcheck = false;
    body.addEventListener('input', function () {
      var txt = body.innerText.replace(/\n$/, '');
      edits[curKey] = txt;
      try { localStorage.setItem(EKEY, JSON.stringify(edits)); } catch (err) {}
      if (curSlide) curSlide.setAttribute('data-speaker-notes', txt);
    });
    body.addEventListener('keydown', function (e) { e.stopPropagation(); });
    panel.appendChild(head); panel.appendChild(body);
    document.body.appendChild(panel);
    setHead('notes', 'click to edit \u00b7 drag top edge to resize \u00b7 N to hide \u00b7 P for mirror');
    body.textContent = typeof edits[curKey] === 'string' ? edits[curKey] : '';
  }
  function setHead(leftTxt, rightTxt) {
    head.innerHTML = '';
    var left = document.createElement('span');
    left.textContent = leftTxt;
    var right = document.createElement('span');
    right.textContent = rightTxt;
    right.style.color = '#5E6A85';
    head.appendChild(left); head.appendChild(right);
  }
  function applyOpen() {
    ensurePanel();
    panel.style.display = open ? 'flex' : 'none';
    panel.style.height = panelH + 'px';
    window.__deckReservedBottom = open ? Math.round(panelH) : 0;
    var s = stage();
    if (s) { s.style.height = ''; if (typeof s._fit === 'function') s._fit(); }
  }
  function updateNotes(d) {
    ensurePanel();
    var slideEl = d.slide || (stage() && stage().querySelectorAll('section')[d.index]);
    var label = slideEl ? (slideEl.getAttribute('data-label') || '') : '';
    curSlide = slideEl; curKey = label || String(d.index);
    var saved = edits[curKey];
    var note = typeof saved === 'string' ? saved : (slideEl ? (slideEl.getAttribute('data-speaker-notes') || '') : '');
    if (typeof saved === 'string' && slideEl) slideEl.setAttribute('data-speaker-notes', saved);
    setHead('notes \u00b7 slide ' + (d.index + 1) + (d.total ? '/' + d.total : '') + (label ? ' \u2014 ' + label : ''),
      'click to edit \u00b7 drag top edge to resize \u00b7 N to hide \u00b7 P for mirror');
    body.textContent = note;
    body.scrollTop = 0;
  }
  document.addEventListener('slidechange', function (e) {
    if (e.detail) {
      lastIndex = e.detail.index; bc.postMessage({ index: lastIndex });
      updateNotes(e.detail); applyOpen();
    }
  });
  window.openPresenterWindow = function () {
    var u = new URL(location.href);
    u.searchParams.set('present', '1');
    window.open(u.toString(), CH, 'width=1280,height=760');
  };
  document.addEventListener('keydown', function (e) {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    var t = e.target, tag = t && t.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || (t && t.isContentEditable)) return;
    if (e.key === 'p' || e.key === 'P') window.openPresenterWindow();
    else if (e.key === 'n' || e.key === 'N') { open = !open; applyOpen(); }
  });
})();
