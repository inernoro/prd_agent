/* Hosted page annotation layer. No credentials, network writes or page layout mutations. */
(function () {
  'use strict';
  if (window.__mapAnnotationsV1 || window.parent === window) return;
  window.__mapAnnotationsV1 = true;
  var context = null, host = null, shadow = null, hover = null, frame = 0;
  var currentHover = null, pending = null, lastLocations = '', activeId = null;
  var excluded = 'script,style,noscript,input,textarea,select,option,[contenteditable="true"]';
  function post(type, extra) {
    if (!context) return;
    window.parent.postMessage(Object.assign({ type: type, siteId: context.siteId, nonce: context.nonce }, extra || {}), '*');
  }
  // Published revisions use immutable storage directories, but represent the same logical page.
  function logicalPath(value) {
    return value.replace(/(\/web-hosting\/sites\/[^/]+)\/\.versions\/[^/]+(?=\/)/, '$1');
  }
  function path() {
    var url = new URL(location.protocol === 'about:' ? context.siteUrl : location.href);
    url.searchParams.delete('v');
    return logicalPath(url.pathname) + url.search + (/^#\//.test(url.hash) ? url.hash : '');
  }
  function text(el) {
    return (el.textContent || '').replace(/\s+/g, ' ').trim();
  }
  function fingerprint(el) {
    return (text(el) || el.getAttribute('aria-label') || el.getAttribute('alt') || el.getAttribute('title')
      || el.getAttribute('src') || el.getAttribute('href') || ('<' + el.tagName.toLowerCase() + '>')).slice(0, 1000);
  }
  function selectable(el) {
    return el instanceof Element && el !== host && el !== document.body && el !== document.documentElement
      && !el.closest(excluded) && !el.closest('[data-map-annotation-layer]');
  }
  function selector(el) {
    var parts = [];
    while (el && el !== document.documentElement) {
      if (el.id && document.querySelectorAll('#' + CSS.escape(el.id)).length === 1) {
        parts.unshift('#' + CSS.escape(el.id)); break;
      }
      var name = el.tagName.toLowerCase(), index = 1, prev = el.previousElementSibling;
      while (prev) { if (prev.tagName === el.tagName) index++; prev = prev.previousElementSibling; }
      parts.unshift(name + ':nth-of-type(' + index + ')'); el = el.parentElement;
    }
    return parts.join(' > ');
  }
  function baseAnchor(el) {
    return { kind: 'element', pagePath: path(), selector: selector(el), tagName: el.tagName.toLowerCase(),
      text: fingerprint(el), elementText: fingerprint(el), prefix: '', suffix: '', contentVersion: context.contentVersion || '' };
  }
  function textRange(el, anchor) {
    var walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, { acceptNode: function (node) {
      return node.parentElement && !node.parentElement.closest(excluded) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    } });
    var nodes = [], full = '', node;
    while ((node = walker.nextNode())) { nodes.push({ node: node, start: full.length }); full += node.textContent; }
    var matches = [], start = full.indexOf(anchor.text);
    while (start >= 0) {
      if ((!anchor.prefix || full.slice(0, start).endsWith(anchor.prefix))
        && (!anchor.suffix || full.slice(start + anchor.text.length).startsWith(anchor.suffix))) matches.push(start);
      start = full.indexOf(anchor.text, start + 1);
    }
    if (matches.length !== 1) return null;
    var from = matches[0], to = from + anchor.text.length, range = document.createRange();
    var first = nodes.find(function (n) { return n.start + n.node.length > from; });
    var last = nodes.find(function (n) { return n.start + n.node.length >= to; });
    if (!first || !last) return null;
    range.setStart(first.node, from - first.start); range.setEnd(last.node, to - last.start);
    return range;
  }
  function resolve(anchor) {
    if (!anchor || logicalPath(anchor.pagePath) !== path()) return null;
    var el;
    try { el = document.querySelector(anchor.selector); } catch (_) { return null; }
    function valid(candidate) {
      if (!selectable(candidate) || candidate.tagName.toLowerCase() !== anchor.tagName) return null;
      if (anchor.kind === 'text') { var range = textRange(candidate, anchor); return range ? { el: candidate, range: range } : null; }
      // IDs survive copy edits. Positional selectors require a matching fingerprint.
      return (anchor.selector.indexOf('#') === 0 && anchor.selector.indexOf(' > ') < 0)
        || (anchor.elementText && fingerprint(candidate) === anchor.elementText) ? { el: candidate } : null;
    }
    var found = el && valid(el);
    var stableId = anchor.selector.indexOf('#') === 0 && anchor.selector.indexOf(' > ') < 0;
    var sameVersion = !anchor.contentVersion || anchor.contentVersion === (context.contentVersion || '');
    if (found && (stableId || sameVersion)) return found;
    var candidates = [];
    // Unique semantic match only; repeated or empty elements are never guessed.
    if (!/^[a-z][a-z0-9-]*$/.test(anchor.tagName)) return null;
    document.querySelectorAll(anchor.tagName).forEach(function (candidate) {
      var match = valid(candidate);
      if (match && (anchor.kind === 'text' || fingerprint(candidate) === anchor.elementText)) candidates.push(match);
    });
    return candidates.length === 1 ? candidates[0] : null;
  }
  function mount() {
    if (host || !document.body) return;
    host = document.createElement('div'); host.setAttribute('data-map-annotation-layer', '');
    host.style.cssText = 'all:initial;position:fixed;inset:0;pointer-events:none;z-index:2147483646;';
    shadow = host.attachShadow({ mode: 'open' });
    var style = document.createElement('style');
    style.textContent = ':host{all:initial}*{box-sizing:border-box}.outline{position:fixed;pointer-events:none;border:2px solid #f59e0b;border-radius:4px;background:rgba(245,158,11,.09)}.highlight{position:fixed;pointer-events:none;background:rgba(245,158,11,.23);border-bottom:2px solid #f59e0b;border-radius:2px}.pin{position:fixed;pointer-events:auto;width:25px;height:25px;border-radius:50%;border:2px solid #fff;background:#d97706;color:#fff;font:600 12px/1 system-ui;box-shadow:0 2px 7px #0003;cursor:pointer}.pin.active{background:#2563eb;outline:3px solid #2563eb40}.pin:focus-visible{outline:3px solid #2563eb}.hover{border-style:dashed;background:rgba(245,158,11,.06)}';
    shadow.appendChild(style); document.body.appendChild(host);
    hover = document.createElement('div'); hover.className = 'outline hover'; hover.hidden = true; shadow.appendChild(hover);
  }
  function place(box, rect) {
    box.style.left = rect.left + 'px'; box.style.top = rect.top + 'px';
    box.style.width = rect.width + 'px'; box.style.height = rect.height + 'px';
  }
  function paint() {
    frame = 0;
    if (!context || !shadow) return;
    shadow.querySelectorAll('[data-mark]').forEach(function (el) { el.remove(); });
    var missing = [], pinCounts = new Map();
    (context.threads || []).forEach(function (thread, index) {
      if (!thread.anchor || (thread.isResolved && thread.id !== activeId)) return;
      if (logicalPath(thread.anchor.pagePath) !== path()) return;
      var found = resolve(thread.anchor);
      if (!found) { missing.push(thread.id); return; }
      var rect = found.range ? found.range.getBoundingClientRect() : found.el.getBoundingClientRect();
      if (!rect.width || !rect.height) { missing.push(thread.id); return; }
      if (rect.bottom < 0 || rect.top > innerHeight || rect.right < 0 || rect.left > innerWidth) return;
      var rects = found.range ? Array.from(found.range.getClientRects()) : [rect];
      rects.forEach(function (r) {
        var box = document.createElement('div'); box.className = found.range ? 'highlight' : 'outline';
        box.setAttribute('data-mark', ''); place(box, r); shadow.appendChild(box);
      });
      var count = pinCounts.get(found.el) || 0; pinCounts.set(found.el, count + 1);
      var pin = document.createElement('button'); pin.className = 'pin' + (thread.id === activeId ? ' active' : '');
      pin.setAttribute('data-mark', ''); pin.setAttribute('aria-label', '打开批注 ' + (index + 1));
      pin.textContent = String(index + 1); pin.style.left = Math.min(innerWidth - 29, Math.max(2, rect.right - 12 - count * 28)) + 'px';
      pin.style.top = Math.min(innerHeight - 29, Math.max(2, rect.top - 12)) + 'px';
      pin.onclick = function (event) { event.stopPropagation(); activeId = thread.id; post('map-annotation-activate', { id: thread.id }); schedule(); };
      shadow.appendChild(pin);
    });
    if (pending) { var chosen = resolve(pending); if (chosen) { var box = document.createElement('div'); box.className = 'outline'; box.setAttribute('data-mark', ''); place(box, chosen.el.getBoundingClientRect()); shadow.appendChild(box); } }
    var serialized = JSON.stringify(missing.sort());
    if (serialized !== lastLocations) { lastLocations = serialized; post('map-annotation-locations', { missingIds: missing }); }
    if (currentHover && context.enabled && currentHover.isConnected) { hover.hidden = false; place(hover, currentHover.getBoundingClientRect()); }
    else hover.hidden = true;
  }
  function schedule() { if (!frame) frame = requestAnimationFrame(paint); }
  window.addEventListener('message', function (event) {
    var data = event.data;
    if (event.source !== window.parent || !data || typeof data !== 'object') return;
    if (data.type === 'map-annotation-init') {
      if (typeof data.nonce !== 'string' || data.nonce.length > 100 || !data.nonce || typeof data.siteId !== 'string' || !data.siteId) return;
      try { new URL(data.siteUrl); } catch (_) { return; }
      context = data; activeId = data.activeId || null; if (!data.pending) pending = null;
      mount(); post('map-annotation-ready'); schedule(); return;
    }
    if (!context || data.siteId !== context.siteId || data.nonce !== context.nonce) return;
    if (data.type === 'map-annotation-focus') {
      var thread = (context.threads || []).find(function (item) { return item.id === data.id; });
      var found = thread && resolve(thread.anchor);
      if (found) { activeId = thread.id; found.el.scrollIntoView({ block: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' }); schedule(); }
      else post('map-annotation-locations', { missingIds: [data.id] });
    }
  });
  document.addEventListener('pointermove', function (event) {
    if (!context || !context.enabled) return;
    currentHover = selectable(event.target) ? event.target : null; schedule();
  }, true);
  document.addEventListener('click', function (event) {
    if (!context || !context.enabled || !selectable(event.target) || event.composedPath().indexOf(host) >= 0) return;
    event.preventDefault(); event.stopImmediatePropagation();
    var selection = window.getSelection(), anchor, el = event.target;
    if (selection && !selection.isCollapsed && selection.toString().trim()) {
      var range = selection.getRangeAt(0), common = range.commonAncestorContainer;
      el = common.nodeType === Node.ELEMENT_NODE ? common : common.parentElement;
      if (!selectable(el) || range.toString().length > 1000) return;
      anchor = baseAnchor(el); anchor.kind = 'text'; anchor.text = range.toString();
      var before = range.cloneRange(); before.selectNodeContents(el); before.setEnd(range.startContainer, range.startOffset);
      var after = range.cloneRange(); after.selectNodeContents(el); after.setStart(range.endContainer, range.endOffset);
      anchor.prefix = before.toString().slice(-100); anchor.suffix = after.toString().slice(0, 100);
    } else anchor = baseAnchor(el);
    pending = anchor; context.enabled = false; currentHover = null;
    post('map-annotation-selected', { anchor: anchor }); schedule();
  }, true);
  document.addEventListener('keydown', function (event) {
    if (context && context.enabled && event.key === 'Escape') { context.enabled = false; currentHover = null; post('map-annotation-cancel'); schedule(); }
  }, true);
  window.addEventListener('scroll', schedule, true); window.addEventListener('resize', schedule);
  window.addEventListener('hashchange', schedule);
  var observer = new MutationObserver(function (records) {
    if (context && records.some(function (record) { return record.target !== host && !host?.contains(record.target); })) schedule();
  });
  observer.observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['class', 'style', 'hidden'] });
  window.addEventListener('pagehide', function () { observer.disconnect(); if (frame) cancelAnimationFrame(frame); frame = 0; context = null; });
})();
