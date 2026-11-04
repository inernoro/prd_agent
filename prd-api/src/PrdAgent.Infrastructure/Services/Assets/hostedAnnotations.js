/* Hosted page annotation layer. No credentials, network writes or page layout mutations. */
(function () {
  'use strict';
  if (window.__mapAnnotationsV1 || window.parent === window) return;
  window.__mapAnnotationsV1 = true;
  var context = null, host = null, shadow = null, hover = null, frame = 0;
  var currentHover = null, pending = null, lastLocations = '', activeId = null;
  var records = new Map(), structureDirty = true, geometryDirty = true, hoverDirty = true, threadsKey = '';
  var pendingBox = null, pointer = null;
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
    url.searchParams.delete('v'); url.searchParams.delete('_map_bridge');
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
    if (!document.body) return;
    if (host) { if (!host.isConnected) document.body.appendChild(host); return; }
    host = document.createElement('div'); host.setAttribute('data-map-annotation-layer', '');
    host.style.cssText = 'all:initial;position:absolute;left:0;top:0;width:0;height:0;overflow:visible;pointer-events:none;z-index:2147483646;';
    shadow = host.attachShadow({ mode: 'open' });
    var style = document.createElement('style');
    style.textContent = ':host{all:initial}*{box-sizing:border-box}.outline{position:absolute;pointer-events:none;border:2px solid #f59e0b;border-radius:4px;background:rgba(245,158,11,.09)}.highlight{position:absolute;pointer-events:none;background:rgba(245,158,11,.23);border-bottom:2px solid #f59e0b;border-radius:2px}.pin{position:absolute;pointer-events:auto;width:25px;height:25px;border-radius:50%;border:2px solid #fff;background:#d97706;color:#fff;font:600 12px/1 system-ui;box-shadow:0 2px 7px #0003;cursor:pointer}.pin.active{background:#2563eb;outline:3px solid #2563eb40}.pin:focus-visible{outline:3px solid #2563eb}.hover{border-style:dashed;background:rgba(245,158,11,.06)}';
    shadow.appendChild(style); document.body.appendChild(host);
    hover = document.createElement('div'); hover.className = 'outline hover'; hover.hidden = true; shadow.appendChild(hover);
  }
  function place(box, rect, origin) {
    box.style.transform = 'translate(' + (rect.left - origin.left) + 'px,' + (rect.top - origin.top) + 'px)';
    box.style.left = '0'; box.style.top = '0';
    box.style.width = rect.width + 'px'; box.style.height = rect.height + 'px';
  }
  function reconcile() {
    var keep = new Set();
    (context.threads || []).forEach(function (thread, index) {
      if (!thread.anchor || (thread.isResolved && thread.id !== activeId) || logicalPath(thread.anchor.pagePath) !== path()) return;
      keep.add(thread.id);
      var record = records.get(thread.id);
      if (!record) {
        var pin = document.createElement('button'); pin.setAttribute('data-mark', '');
        pin.onclick = function (event) {
          event.stopPropagation(); activeId = thread.id;
          post('map-annotation-activate', { id: thread.id }); schedule(false);
        };
        shadow.appendChild(pin);
        record = { boxes: [], pin: pin }; records.set(thread.id, record);
      }
      record.thread = thread; record.index = index; record.found = resolve(thread.anchor);
      record.pin.textContent = String(index + 1);
      record.pin.setAttribute('aria-label', '打开批注 ' + (index + 1));
    });
    records.forEach(function (record, id) {
      if (!keep.has(id)) { record.pin.remove(); record.boxes.forEach(function (box) { box.remove(); }); records.delete(id); }
    });
    structureDirty = false;
  }
  function paint() {
    frame = 0;
    if (!context) return;
    mount(); if (!shadow) return;
    host.style.display = context.displayMode === 'hidden' && !context.enabled ? 'none' : 'block';
    host.setAttribute('data-display-mode', context.displayMode || 'bubble');
    if (structureDirty) { reconcile(); geometryDirty = true; }
    // Read all geometry before writing. On ordinary document scroll the absolute layer
    // moves with the page natively; no DOM lookup, layout read or marker update is needed.
    var origin = host.getBoundingClientRect(), updates = [], missing = [], pinCounts = new Map();
    if (geometryDirty) {
      records.forEach(function (record) {
        var found = record.found;
        if (!found || !found.el.isConnected) { missing.push(record.thread.id); updates.push({ record: record, rects: [] }); return; }
        var rect = found.range ? found.range.getBoundingClientRect() : found.el.getBoundingClientRect();
        if (!rect.width || !rect.height) { missing.push(record.thread.id); updates.push({ record: record, rects: [] }); return; }
        var count = pinCounts.get(found.el) || 0; pinCounts.set(found.el, count + 1);
        updates.push({ record: record, rects: found.range ? Array.from(found.range.getClientRects()) : [rect],
          pin: { left: Math.max(-scrollX, Math.min(rect.right - 12 - count * 28, document.documentElement.scrollWidth - scrollX - 27)),
            top: Math.max(-scrollY + 2, rect.top - 12), width: 25, height: 25 } });
      });
    }
    var pendingRect = null;
    if (pending && geometryDirty) { var selected = resolve(pending); if (selected) pendingRect = selected.el.getBoundingClientRect(); }
    if (hoverDirty && context.enabled && pointer) {
      var target = document.elementFromPoint ? document.elementFromPoint(pointer.x, pointer.y) : currentHover;
      currentHover = selectable(target) ? target : null;
    }
    var hoverRect = currentHover && context.enabled && currentHover.isConnected ? currentHover.getBoundingClientRect() : null;
    updates.forEach(function (update) {
      var record = update.record;
      record.located = !!update.pin;
      if (update.pin) place(record.pin, update.pin, origin);
      while (record.boxes.length > update.rects.length) record.boxes.pop().remove();
      update.rects.forEach(function (rect, index) {
        var box = record.boxes[index];
        if (!box) { box = document.createElement('div'); box.setAttribute('data-mark', ''); record.boxes.push(box); shadow.appendChild(box); }
        box.className = record.found.range ? 'highlight' : 'outline'; place(box, rect, origin);
      });
    });
    records.forEach(function (record) {
      record.pin.hidden = !record.located || context.displayMode === 'standard';
      record.pin.className = 'pin' + (record.thread.id === activeId ? ' active' : '');
    });
    if (geometryDirty) {
      if (pendingRect) {
        if (!pendingBox) { pendingBox = document.createElement('div'); pendingBox.className = 'outline'; shadow.appendChild(pendingBox); }
        pendingBox.hidden = false; place(pendingBox, pendingRect, origin);
      } else if (pendingBox) pendingBox.hidden = true;
      var serialized = JSON.stringify(missing.sort());
      if (serialized !== lastLocations) { lastLocations = serialized; post('map-annotation-locations', { missingIds: missing }); }
    }
    hover.hidden = !hoverRect; if (hoverRect) place(hover, hoverRect, origin);
    geometryDirty = false; hoverDirty = false;
  }
  function schedule(geometry) { if (geometry !== false) geometryDirty = true; if (!frame) frame = requestAnimationFrame(paint); }
  function invalidate() { structureDirty = true; schedule(); }
  window.addEventListener('message', function (event) {
    var data = event.data;
    if (event.source !== window.parent || !data || typeof data !== 'object') return;
    if (data.type === 'map-annotation-init') {
      if (typeof data.nonce !== 'string' || data.nonce.length > 100 || !data.nonce || typeof data.siteId !== 'string' || !data.siteId) return;
      try { new URL(data.siteUrl); } catch (_) { return; }
      var nextKey = JSON.stringify(data.threads || []);
      if (!context || context.siteUrl !== data.siteUrl || context.contentVersion !== data.contentVersion || activeId !== (data.activeId || null) || nextKey !== threadsKey) structureDirty = true;
      threadsKey = nextKey; context = data; activeId = data.activeId || null; if (!data.pending) pending = null;
      mount(); observe(); post('map-annotation-ready'); schedule(); return;
    }
    if (!context || data.siteId !== context.siteId || data.nonce !== context.nonce) return;
    if (data.type === 'map-annotation-focus') {
      var thread = (context.threads || []).find(function (item) { return item.id === data.id; });
      var found = thread && resolve(thread.anchor);
      if (found) { activeId = thread.id; structureDirty = true; found.el.scrollIntoView({ block: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' }); schedule(); }
      else post('map-annotation-locations', { missingIds: [data.id] });
    }
  });
  document.addEventListener('pointermove', function (event) {
    if (!context || !context.enabled) return;
    pointer = { x: event.clientX, y: event.clientY }; currentHover = selectable(event.target) ? event.target : null; hoverDirty = true; schedule(false);
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
  window.addEventListener('scroll', function (event) {
    if (!context) return;
    if (event.target === document || event.target === window) {
      if (context.enabled) { hoverDirty = true; schedule(false); }
      return;
    }
    schedule();
  }, { capture: true, passive: true });
  window.addEventListener('resize', function () { schedule(); }, { passive: true });
  document.addEventListener('load', function () { schedule(); }, true);
  window.addEventListener('hashchange', invalidate);
  var observer = new MutationObserver(function (changes) {
    var relevant = changes.filter(function (record) {
      if (record.target === host || host?.contains(record.target)) return false;
      return record.type !== 'childList' || Array.from(record.addedNodes).concat(Array.from(record.removedNodes)).some(function (node) { return node !== host; });
    });
    if (!context || !relevant.length) return;
    if (relevant.some(function (record) { return record.type !== 'attributes' || record.attributeName === 'id'; })) structureDirty = true;
    schedule();
  });
  function observe() {
    observer.observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true,
      attributeFilter: ['class', 'style', 'hidden', 'id'] });
  }
  observe();
  window.addEventListener('pagehide', function () { observer.disconnect(); if (frame) cancelAnimationFrame(frame); frame = 0; context = null; });
})();
