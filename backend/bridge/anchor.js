/*
 * Quote anchors for HTML sources (ADR-0013 decision 5).
 *
 * Plain browser-safe JS, no ESM syntax and no build step: it is a CommonJS
 * module under Jest and a classic script (window.SyfloAnchor) in the served
 * page, where build-bridge.js concatenates it into bridge.js.
 *
 * A highlight is remembered as { exact, prefix, suffix } - the selected text
 * plus ~32 characters of context on each side - never as character offsets,
 * because the DOM shifts after MathJax typesets or a quiz reveals text.
 * All three strings live in the "text model": the visible text of the
 * document in reading order, whitespace collapsed, script/style/noscript/
 * canvas/svg skipped, and every formula ONE atomic token whose text is its
 * TeX. The model also maps text offsets back to DOM positions.
 */
(function () {
  var CONTEXT = 32;
  var SKIP = { script: 1, style: 1, noscript: 1, canvas: 1, svg: 1, template: 1, head: 1, title: 1,
    textarea: 1, select: 1, option: 1, object: 1, iframe: 1 };
  var BLOCK = { address: 1, article: 1, aside: 1, blockquote: 1, br: 1, dd: 1, details: 1, div: 1, dl: 1,
    dt: 1, fieldset: 1, figcaption: 1, figure: 1, footer: 1, form: 1, h1: 1, h2: 1, h3: 1, h4: 1, h5: 1,
    h6: 1, header: 1, hr: 1, li: 1, main: 1, nav: 1, ol: 1, p: 1, pre: 1, section: 1, summary: 1,
    table: 1, tbody: 1, td: 1, tfoot: 1, th: 1, thead: 1, tr: 1, ul: 1, body: 1 };
  var WS = /\s/;

  function tagOf(el) {
    return (el.localName || el.nodeName || '').toLowerCase();
  }

  function isFormula(el) {
    var tag = tagOf(el);
    if (tag === 'mjx-container' || tag === 'math') return true;
    return tag === 'span' && el.classList && el.classList.contains('katex');
  }

  function squash(s) {
    return String(s).replace(/\s+/g, ' ').trim();
  }

  function texSibling(el) {
    var dirs = ['nextSibling', 'previousSibling'];
    for (var d = 0; d < dirs.length; d++) {
      var n = el[dirs[d]];
      while (n && n.nodeType === 3 && !/\S/.test(n.data)) n = n[dirs[d]];
      if (n && n.nodeType === 1 && tagOf(n) === 'script' &&
          /^math\/tex/i.test(n.getAttribute('type') || '')) return n.textContent;
    }
    return '';
  }

  // The TeX of a formula element, or its visible text as the last resort.
  function formulaText(el) {
    var tex = texSibling(el);
    if (!tex) tex = el.getAttribute('data-tex') || '';
    if (!tex && el.querySelector) {
      var ann = el.querySelector('annotation[encoding="application/x-tex"]');
      if (ann) tex = ann.textContent;
    }
    if (!tex) tex = el.getAttribute('aria-label') || '';
    if (!tex) tex = el.textContent || '';
    return squash(tex);
  }

  function textModel(root) {
    var chars = [];
    var cn = []; // char -> text node, or the formula element for atomic chars
    var co = []; // char -> offset in that text node (-1 for atomic chars)
    var starts = new Map();
    var ends = new Map();
    var atoms = new Set();

    function push(ch, node, off) {
      chars.push(ch);
      cn.push(node);
      co.push(off);
    }
    function gap() {
      if (chars.length && chars[chars.length - 1] !== ' ') push(' ', null, 0);
    }

    function walk(node) {
      starts.set(node, chars.length);
      if (node.nodeType === 3) {
        var d = node.data;
        for (var i = 0; i < d.length; i++) {
          if (WS.test(d[i])) {
            if (chars.length && chars[chars.length - 1] !== ' ') push(' ', node, i);
          } else {
            push(d[i], node, i);
          }
        }
      } else if (node.nodeType === 1) {
        var tag = tagOf(node);
        if (SKIP[tag]) {
          // contributes nothing
        } else if (isFormula(node)) {
          var tex = formulaText(node);
          for (var k = 0; k < tex.length; k++) push(tex[k], node, -1);
          if (tex) atoms.add(node);
        } else {
          var block = BLOCK[tag];
          if (block) gap();
          for (var c = node.firstChild; c; c = c.nextSibling) walk(c);
          if (block) gap();
        }
      }
      ends.set(node, chars.length);
    }
    walk(root);
    if (chars.length && chars[chars.length - 1] === ' ') {
      chars.pop();
      cn.pop();
      co.pop();
    }
    return { root: root, text: chars.join(''), cn: cn, co: co, starts: starts, ends: ends, atoms: atoms };
  }

  function indexOfNode(node) {
    var i = 0;
    while ((node = node.previousSibling)) i++;
    return i;
  }

  // Model index of a DOM boundary point; formulas snap to the whole token.
  function boundaryIndex(model, container, offset, isStart) {
    for (var n = container; n; n = n.parentNode) {
      if (model.atoms.has(n)) return isStart ? model.starts.get(n) : model.ends.get(n);
      if (n === model.root) break;
    }
    if (container.nodeType === 3) {
      var st = model.starts.get(container);
      var en = model.ends.get(container);
      if (st === undefined) return null;
      for (var i = st; i < en; i++) if (model.co[i] >= offset) return i;
      return en;
    }
    if (offset < container.childNodes.length) {
      var idx = model.starts.get(container.childNodes[offset]);
      return idx === undefined ? null : idx;
    }
    var e = model.ends.get(container);
    return e === undefined ? null : e;
  }

  function toRange(model, s, e) {
    var len = model.text.length;
    if (e > len) e = len;
    while (s < e && model.cn[s] === null) s++;
    while (e > s && model.cn[e - 1] === null) e--;
    if (s >= e) return null;
    var doc = model.root.ownerDocument || model.root;
    var r = doc.createRange();
    var a = model.cn[s];
    var b = model.cn[e - 1];
    if (a.nodeType === 1) r.setStart(a.parentNode, indexOfNode(a));
    else r.setStart(a, model.co[s]);
    if (b.nodeType === 1) r.setEnd(b.parentNode, indexOfNode(b) + 1);
    else r.setEnd(b, model.co[e - 1] + 1);
    return r;
  }

  function defaultRoot(range) {
    var c = range.commonAncestorContainer;
    var doc = c.ownerDocument || c;
    return doc.body || doc.documentElement;
  }

  function createAnchor(range, root) {
    root = root || defaultRoot(range);
    var model = textModel(root);
    var s = boundaryIndex(model, range.startContainer, range.startOffset, true);
    var e = boundaryIndex(model, range.endContainer, range.endOffset, false);
    if (s === null || e === null) return { exact: '', prefix: '', suffix: '' };
    var t = model.text;
    while (s < e && t[s] === ' ') s++;
    while (e > s && t[e - 1] === ' ') e--;
    if (e <= s) return { exact: '', prefix: '', suffix: '' };
    return {
      exact: t.slice(s, e),
      prefix: t.slice(Math.max(0, s - CONTEXT), s),
      suffix: t.slice(e, e + CONTEXT),
    };
  }

  function commonTail(a, b) {
    var n = 0;
    while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n++;
    return n;
  }
  function commonHead(a, b) {
    var n = 0;
    while (n < a.length && n < b.length && a[n] === b[n]) n++;
    return n;
  }

  function findAll(text, needle) {
    var out = [];
    for (var i = text.indexOf(needle); i !== -1; i = text.indexOf(needle, i + 1)) out.push(i);
    return out;
  }

  function resolveAnchor(root, anchor, prebuiltModel) {
    if (!anchor || typeof anchor.exact !== 'string') return null;
    var exact = squash(anchor.exact);
    if (!exact) return null;
    // context keeps its edge spaces (they are part of the match)
    var prefix = String(anchor.prefix || '').replace(/\s+/g, ' ');
    var suffix = String(anchor.suffix || '').replace(/\s+/g, ' ');
    var model = prebuiltModel || textModel(root);
    var text = model.text;
    var spans = findAll(text, exact).map(function (i) { return [i, i + exact.length]; });

    if (!spans.length) {
      // Whitespace-insensitive fallback: the page may join or split words
      // differently now than when the anchor was made.
      var flat = '';
      var map = [];
      for (var i = 0; i < text.length; i++) {
        if (text[i] !== ' ') { flat += text[i]; map.push(i); }
      }
      var needle = exact.replace(/ /g, '');
      spans = findAll(flat, needle).map(function (k) {
        return [map[k], map[k + needle.length - 1] + 1];
      });
    }
    if (!spans.length) return null;

    var best = null;
    var bestScore = -1;
    for (var j = 0; j < spans.length; j++) {
      var s = spans[j][0];
      var e = spans[j][1];
      var before = text.slice(Math.max(0, s - prefix.length), s);
      var after = text.slice(e, e + suffix.length);
      var score = commonTail(prefix, before) + commonHead(suffix, after);
      if (score > bestScore) { bestScore = score; best = spans[j]; }
    }
    return toRange(model, best[0], best[1]);
  }

  var api = { textModel: textModel, createAnchor: createAnchor, resolveAnchor: resolveAnchor };
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  else window.SyfloAnchor = api;
})();
