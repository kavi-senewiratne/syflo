/*
 * Syflo bridge - the script the backend injects into an HTML source
 * (ADR-0013 decisions 2, 5, 9, 10). It is concatenated after anchor.js into
 * bridge.js by build-bridge.js; window.SyfloAnchor is available here.
 * Full protocol: backend/bridge/PROTOCOL.md. Summary:
 *
 * Every message carries { source: 'syflo-bridge', token, type, ... }; the
 * token is the data-token attribute of this <script> tag, and window.parent
 * is the only peer.
 *
 * Page -> parent:  ready | outline { sections:[{level,heading}] }
 *   | selection { text, anchor, rect } | selection-cleared
 *   | highlight-click { id, rect } | section { heading, index }
 *   | highlights-painted { resolved:[id], missing:[id] }
 *   | anchor-not-found { anchor } | open-link { url }
 * Parent -> page (only from window.parent AND with the matching token):
 *   set-highlights { highlights:[{id,color,anchor}] } | scroll-to-anchor { anchor }
 *   | scroll-to-section { index } | clear-selection | hello
 */
(function () {
  var script = document.currentScript;
  var token = (script && script.getAttribute('data-token')) || '';
  // Optional hardening: when the server knows the Syflo origin it can pin it.
  var parentOrigin = (script && script.getAttribute('data-parent-origin')) || '';
  // A URL import remembers the web address it came from: relative links in the
  // snapshot resolve against it. An uploaded file has no such address.
  var sourceUrl = (script && script.getAttribute('data-source-url')) || '';
  var A = window.SyfloAnchor;

  var COLORS = {
    // Deep tones at a fixed opacity: they read on light AND dark pages
    // (ADR-0013 decision 10) and are the same in every Syflo theme.
    yellow: 'rgba(202,138,4,0.42)',
    green: 'rgba(22,163,74,0.38)',
    blue: 'rgba(37,99,235,0.36)',
    pink: 'rgba(219,39,119,0.36)',
    orange: 'rgba(234,88,12,0.40)',
  };
  var FLASH = 'rgba(250,204,21,0.85)';
  var NOT_TEXT = 'script,style,noscript,canvas,svg,template,textarea,select,mjx-container,math,.katex';

  function post(type, payload) {
    if (!token) return;
    var msg = { source: 'syflo-bridge', token: token, type: type };
    for (var k in payload) if (Object.prototype.hasOwnProperty.call(payload, k)) msg[k] = payload[k];
    try { window.parent.postMessage(msg, parentOrigin || '*'); } catch (e) { /* no parent */ }
  }

  function rectOf(range) {
    var r = range.getBoundingClientRect ? range.getBoundingClientRect() : { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
  }

  // ---- styles ------------------------------------------------------------
  function ensureStyle() {
    if (document.getElementById('syflo-bridge-style')) return;
    var css = '';
    Object.keys(COLORS).forEach(function (c) {
      css += '::highlight(syflo-hl-' + c + '){background-color:' + COLORS[c] + ';color:inherit;}\n';
      css += 'mark[data-syflo-hl][data-color="' + c + '"]{background-color:' + COLORS[c] + ';color:inherit;}\n';
      css += '[data-syflo-hl-atom="' + c + '"]{background-color:' + COLORS[c] + ';}\n';
    });
    css += '::highlight(syflo-flash){background-color:' + FLASH + ';color:inherit;}\n';
    css += 'mark[data-syflo-flash]{background-color:' + FLASH + ';color:inherit;}\n';
    var st = document.createElement('style');
    st.id = 'syflo-bridge-style';
    st.textContent = css;
    (document.head || document.documentElement).appendChild(st);
  }

  // ---- painting ------------------------------------------------------------
  var useApi = function () {
    return typeof window.Highlight === 'function' && window.CSS && window.CSS.highlights;
  };
  var current = [];      // last highlights received from the parent
  var apiRanges = [];    // [{ id, range }] painted through the Custom Highlight API
  var painting = false;
  var observer = null;

  function unwrapMarks(sel) {
    var marks = document.querySelectorAll(sel);
    for (var i = 0; i < marks.length; i++) {
      var m = marks[i];
      var p = m.parentNode;
      if (!p) continue;
      while (m.firstChild) p.insertBefore(m.firstChild, m);
      p.removeChild(m);
      p.normalize();
    }
  }

  // Wrap the text nodes of a range in <mark>. Formulas are never entered:
  // they only get an attribute, so their tokens stay whole.
  function wrapRange(range, attrs) {
    var root = range.commonAncestorContainer;
    var segs = [];
    if (root.nodeType === 3) {
      segs.push({ node: root, s: range.startOffset, e: range.endOffset });
    } else {
      var walker = document.createTreeWalker(root, 4 /* SHOW_TEXT */, null);
      for (var n = walker.nextNode(); n; n = walker.nextNode()) {
        if (!range.intersectsNode(n)) continue;
        if (n.parentElement && n.parentElement.closest(NOT_TEXT)) continue;
        var s = n === range.startContainer ? range.startOffset : 0;
        var e = n === range.endContainer ? range.endOffset : n.length;
        if (e > s && /\S/.test(n.data.slice(s, e))) segs.push({ node: n, s: s, e: e });
      }
      var scope = root.nodeType === 1 ? root : root.parentElement;
      if (scope && attrs['data-color']) {
        var atoms = scope.querySelectorAll('mjx-container,math,.katex');
        for (var a = 0; a < atoms.length; a++) {
          if (range.intersectsNode(atoms[a])) atoms[a].setAttribute('data-syflo-hl-atom', attrs['data-color']);
        }
      }
    }
    // Last to first, so earlier offsets stay valid while nodes are split.
    for (var i = segs.length - 1; i >= 0; i--) {
      var seg = segs[i];
      var target = seg.node;
      if (seg.e < target.length) target.splitText(seg.e);
      if (seg.s > 0) target = target.splitText(seg.s);
      var mark = document.createElement('mark');
      for (var k in attrs) mark.setAttribute(k, attrs[k]);
      target.parentNode.insertBefore(mark, target);
      mark.appendChild(target);
    }
  }

  function clearPaint() {
    apiRanges = [];
    if (useApi()) Object.keys(COLORS).forEach(function (c) { window.CSS.highlights.delete('syflo-hl-' + c); });
    unwrapMarks('mark[data-syflo-hl]');
    var atoms = document.querySelectorAll('[data-syflo-hl-atom]');
    for (var i = 0; i < atoms.length; i++) atoms[i].removeAttribute('data-syflo-hl-atom');
  }

  function paint() {
    painting = true;
    try {
      ensureStyle();
      clearPaint();
      var resolved = [];
      var missing = [];
      var byColor = {};
      var model = useApi() ? A.textModel(document.body) : null;
      current.forEach(function (h) {
        if (!COLORS[h.color]) { missing.push(h.id); return; }
        // Fallback painting mutates the DOM, so it re-resolves against a fresh model.
        var range = A.resolveAnchor(document.body, h.anchor, model);
        if (!range) { missing.push(h.id); return; }
        resolved.push(h.id);
        if (model) {
          (byColor[h.color] = byColor[h.color] || []).push(range);
          apiRanges.push({ id: h.id, range: range });
        } else {
          wrapRange(range, { 'data-syflo-hl': String(h.id), 'data-color': h.color });
        }
      });
      if (model) {
        Object.keys(byColor).forEach(function (c) {
          window.CSS.highlights.set('syflo-hl-' + c, new (Function.prototype.bind.apply(window.Highlight, [null].concat(byColor[c])))());
        });
      }
      if (observer) observer.takeRecords();
      post('highlights-painted', { resolved: resolved, missing: missing });
    } finally {
      painting = false;
    }
  }

  function flash(range) {
    painting = true;
    try {
      ensureStyle();
      if (useApi()) {
        window.CSS.highlights.set('syflo-flash', new window.Highlight(range));
        setTimeout(function () { window.CSS.highlights.delete('syflo-flash'); }, 1400);
      } else {
        wrapRange(range, { 'data-syflo-flash': '1' });
        setTimeout(function () {
          painting = true;
          unwrapMarks('mark[data-syflo-flash]');
          if (observer) observer.takeRecords();
          painting = false;
        }, 1400);
      }
      if (observer) observer.takeRecords();
    } finally {
      painting = false;
    }
  }

  // ---- outline and current section ------------------------------------------
  function headings() {
    var out = [];
    var all = document.querySelectorAll('h1,h2,h3');
    for (var i = 0; i < all.length; i++) {
      var h = all[i];
      if (h.closest('script,style,noscript,template')) continue;
      var text = A.textModel(h).text;
      if (text) out.push({ el: h, level: Number(h.tagName.charAt(1)), heading: text });
    }
    return out;
  }

  // The heading a node sits under: the last heading that comes before it in the
  // document ('' above the first heading).
  function sectionOf(node) {
    var name = '';
    var hs = headings();
    for (var i = 0; i < hs.length; i++) {
      var rel = hs[i].el.compareDocumentPosition(node);
      // DOCUMENT_POSITION_FOLLOWING (4) or contained (16): the heading is before the node.
      if ((rel & 4) || (rel & 16)) name = hs[i].heading; else break;
    }
    return name;
  }

  function sendOutline() {
    post('outline', { sections: headings().map(function (h) { return { level: h.level, heading: h.heading }; }) });
  }

  var lastSection = -2;
  function checkSection(force) {
    var hs = headings();
    var threshold = Math.max(40, (window.innerHeight || 0) * 0.25);
    var idx = -1;
    for (var i = 0; i < hs.length; i++) {
      if (hs[i].el.getBoundingClientRect().top <= threshold) idx = i; else break;
    }
    if (idx === lastSection && !force) return;
    lastSection = idx;
    post('section', { heading: idx >= 0 ? hs[idx].heading : '', index: idx });
  }

  var sectionTimer = null;
  window.addEventListener('scroll', function () {
    if (sectionTimer) return;
    sectionTimer = setTimeout(function () { sectionTimer = null; checkSection(false); }, 100);
  }, { passive: true });

  // ---- selection -------------------------------------------------------------
  var hadSelection = false;
  function reportSelection() {
    var sel = window.getSelection && window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) {
      if (hadSelection) { hadSelection = false; post('selection-cleared', {}); }
      return;
    }
    var range = sel.getRangeAt(0);
    var anchor = A.createAnchor(range);
    if (!anchor.exact) return;
    hadSelection = true;
    post('selection', { text: anchor.exact, anchor: anchor, rect: rectOf(range), section: sectionOf(range.startContainer) });
  }
  document.addEventListener('mouseup', function () { setTimeout(reportSelection, 0); }, true);
  document.addEventListener('keyup', function (e) {
    if (e.shiftKey || /^Arrow|^Home$|^End$|^Page/.test(e.key || '')) setTimeout(reportSelection, 0);
  }, true);
  document.addEventListener('selectionchange', function () {
    var sel = window.getSelection && window.getSelection();
    if (hadSelection && sel && sel.isCollapsed) { hadSelection = false; post('selection-cleared', {}); }
  });

  // ---- links ------------------------------------------------------------------
  // The snapshot is ONE page (ADR-0013 decision 3): a link to anywhere else
  // must not navigate the frame - the bridge, the marks and the chat's source
  // would be gone, and most sites refuse to be framed anyway (a blank error
  // page with no way back). In-page anchors (#...) keep scrolling; everything
  // else is handed to Syflo, which opens it in the system browser.
  function linkDestination(a) {
    var raw = a.getAttribute('href') || '';
    if (/^\s*#/.test(raw) || /^\s*javascript:/i.test(raw)) return null; // the page's own business
    if (/^[a-z][a-z0-9+.-]*:/i.test(raw.trim())) return raw.trim(); // absolute
    if (!sourceUrl) return ''; // relative link of an uploaded file: nowhere to go
    try { return new URL(raw, sourceUrl).href; } catch (err) { return ''; }
  }
  document.addEventListener('click', function (e) {
    if (e.defaultPrevented || e.button !== 0) return;
    var a = e.target && e.target.closest && e.target.closest('a[href]');
    if (!a) return;
    var dest = linkDestination(a);
    if (dest === null) return;
    e.preventDefault();
    if (dest) post('open-link', { url: dest });
  }, true);

  // ---- highlight clicks -----------------------------------------------------
  document.addEventListener('click', function (e) {
    var sel = window.getSelection && window.getSelection();
    if (sel && !sel.isCollapsed) return; // a drag-select, not a click
    var mark = e.target && e.target.closest && e.target.closest('mark[data-syflo-hl]');
    if (mark) {
      var r = mark.getBoundingClientRect();
      post('highlight-click', { id: mark.getAttribute('data-syflo-hl'),
        rect: { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height } });
      return;
    }
    if (!apiRanges.length) return;
    var pos = document.caretPositionFromPoint && document.caretPositionFromPoint(e.clientX, e.clientY);
    var node = pos ? pos.offsetNode : null;
    var off = pos ? pos.offset : 0;
    if (!pos && document.caretRangeFromPoint) {
      var cr = document.caretRangeFromPoint(e.clientX, e.clientY);
      if (cr) { node = cr.startContainer; off = cr.startOffset; }
    }
    if (!node) return;
    for (var i = apiRanges.length - 1; i >= 0; i--) {
      if (apiRanges[i].range.isPointInRange(node, off)) {
        post('highlight-click', { id: apiRanges[i].id, rect: rectOf(apiRanges[i].range) });
        return;
      }
    }
  }, true);

  // ---- commands ---------------------------------------------------------------
  function scrollEl(el) {
    if (el && el.scrollIntoView) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }

  var commands = {
    'set-highlights': function (d) {
      current = Array.isArray(d.highlights) ? d.highlights : [];
      paint();
    },
    'scroll-to-anchor': function (d) {
      var range = A.resolveAnchor(document.body, d.anchor);
      if (!range) { post('anchor-not-found', { anchor: d.anchor }); return; }
      var c = range.startContainer;
      scrollEl(c.nodeType === 1 ? c : c.parentElement);
      flash(range);
    },
    'scroll-to-section': function (d) {
      var h = headings()[d.index];
      if (h && h.el.scrollIntoView) h.el.scrollIntoView({ block: 'start', behavior: 'smooth' });
    },
    'clear-selection': function () {
      if (window.getSelection) window.getSelection().removeAllRanges();
      hadSelection = false;
    },
    hello: function () { announce(); },
  };

  window.addEventListener('message', function (ev) {
    var d = ev.data;
    if (!token || ev.source !== window.parent) return;
    if (parentOrigin && ev.origin !== parentOrigin) return;
    if (!d || typeof d !== 'object' || d.token !== token) return;
    if (Object.prototype.hasOwnProperty.call(commands, d.type)) commands[d.type](d);
  });

  // ---- late DOM changes (MathJax typesets after load) ---------------------
  var repaintTimer = null;
  function watchDom() {
    if (typeof MutationObserver !== 'function') return;
    observer = new MutationObserver(function () {
      if (painting || !current.length) return;
      clearTimeout(repaintTimer);
      repaintTimer = setTimeout(paint, 250);
    });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  }

  // ---- start ---------------------------------------------------------------
  function announce() {
    post('ready', {});
    sendOutline();
    checkSection(true);
  }
  function start() {
    watchDom();
    announce();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
