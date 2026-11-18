/* Hosted page annotation layer. No credentials, network writes or page layout mutations. */
(function () {
  'use strict';
  if (window.__mapAnnotationsV1 || window.parent === window) return;
  window.__mapAnnotationsV1 = true;
  var context = null, host = null, shadow = null, hover = null, frame = 0;
  var currentHover = null, pending = null, lastLocations = '', activeId = null;
  var records = new Map(), structureDirty = true, geometryDirty = true, hoverDirty = true, threadsKey = '';
  var pendingBoxes = [], pointer = null;
  var previewId = null, dismissedPreview = null, previewLast = '';
  var previewsHidden = false, revealedPreviews = new Set();
  var dismissedPreviews = new Set(), previewsLast = '';
  var paragraphs = new Map(), paragraphIndices = new Map(), readingLast, paragraphsLast = '', markerStateDirty = true;
  var headerTints = [], headerTintsLast = '';
  var selectionFrame = 0, selectionLast = '';
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
  function selectedTextAnchor(el, range) {
    var anchor = baseAnchor(el);
    anchor.kind = 'text'; anchor.text = range.toString();
    var before = range.cloneRange(); before.selectNodeContents(el); before.setEnd(range.startContainer, range.startOffset);
    var after = range.cloneRange(); after.selectNodeContents(el); after.setStart(range.endContainer, range.endOffset);
    anchor.prefix = before.toString().slice(-100); anchor.suffix = after.toString().slice(0, 100);
    return anchor;
  }
  function clearSelectionCandidate() {
    if (!selectionLast) return;
    selectionLast = '';
    post('map-annotation-selection', { anchor: null });
  }
  function updateSelectionCandidate() {
    selectionFrame = 0;
    var selection = window.getSelection();
    if (!context?.suggestSelection || context.enabled || context.pending || !selection || selection.isCollapsed || selection.rangeCount !== 1)
      return clearSelectionCandidate();
    var range = selection.getRangeAt(0), value = range.toString();
    if (value.trim().length < 2 || value.length > 1000) return clearSelectionCandidate();
    var common = range.commonAncestorContainer;
    var paragraph = (common.nodeType === Node.ELEMENT_NODE ? common : common.parentElement)?.closest('p');
    if (!selectable(paragraph)) return clearSelectionCandidate();
    var rect = range.getBoundingClientRect();
    if (!rect.width || !rect.height || rect.bottom < 0 || rect.top > innerHeight) return clearSelectionCandidate();
    var candidate = { anchor: selectedTextAnchor(paragraph, range), rect: previewRect(rect) };
    var key = JSON.stringify(candidate);
    if (key !== selectionLast) { selectionLast = key; post('map-annotation-selection', candidate); }
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
    style.textContent = ':host{all:initial}*{box-sizing:border-box}'
      + '.outline,.highlight{z-index:0;position:absolute;pointer-events:none;border-radius:3px}'
      + '.outline{border:1px solid #ad6a2359}'
      + '.highlight{background:#efb24b30;border-bottom:1px solid #b6690b}'
      + '.outline.active,.highlight.active{border:1px solid #a15b08;background:#efb24b4d}'
      + '.pin{z-index:2;position:absolute;pointer-events:auto;width:25px;height:25px;border-radius:50%;border:2px solid #fff;background:#f3d08a;color:#392509;font:650 12px/1 system-ui;box-shadow:0 1px 4px #0002;cursor:pointer}'
      + '.pin.active{background:#262526;color:#fff}.pin:focus-visible{outline:2px solid #2563eb}'
      + ':host([data-dual-column]){--mark:#f0aa2833;--mark-selected:#f0aa2870;--mark-line:#d29312;--mark-ring:#a06400;--pin:#fbe1a6;--pin-ink:#5a3a00;--pin-selected:#1b1c1f;--pin-selected-ink:#fff;--paper:#fff;--muted:#676b73;--deemphasis:#181a1f2b}'
      + ':host([data-dual-column][data-dark-paper]){--mark:#f5b94226;--mark-selected:#f5b94254;--mark-line:#dda232;--mark-ring:#f4c35c;--pin:#4b3a16;--pin-ink:#fbde9e;--pin-selected:#f4c35c;--pin-selected-ink:#1a1305;--paper:#17181b;--muted:#9296a0;--deemphasis:#ffffff29}'
      + ':host([data-dual-column]) .outline:not(.hover){border:1px solid var(--mark-line);background:var(--mark)}'
      + ':host([data-dual-column]) .highlight{border:0;background:var(--mark);box-shadow:inset 0 -1.5px var(--mark-line);border-radius:2px}'
      + ':host([data-dual-column]) .highlight.active,:host([data-dual-column]) .outline.active{background:var(--mark-selected);box-shadow:0 0 0 1.5px var(--mark-ring);border:0}'
      + ':host([data-dual-column]) .highlight.first.active{box-shadow:-1.5px 0 var(--mark-ring),0 -1.5px var(--mark-ring),0 1.5px var(--mark-ring)}'
      + ':host([data-dual-column]) .highlight.middle.active{box-shadow:0 -1.5px var(--mark-ring),0 1.5px var(--mark-ring)}'
      + ':host([data-dual-column]) .highlight.last.active{box-shadow:1.5px 0 var(--mark-ring),0 -1.5px var(--mark-ring),0 1.5px var(--mark-ring)}'
      + ':host([data-dual-column]) .highlight.dim,:host([data-dual-column]) .outline.dim{background:transparent;box-shadow:inset 0 -1px var(--deemphasis);border:0}'
      + ':host([data-dual-column]) .pending-mark{position:absolute;pointer-events:none;border-radius:2px;background:#2a5bd71a;box-shadow:inset 0 -1.5px #2a5bd7}'
      + ':host([data-dual-column][data-dark-paper]) .pending-mark{background:#86a8ff24;box-shadow:inset 0 -1.5px #86a8ff}'
      + ':host([data-dual-column]) .pin{display:grid;place-items:center;padding:0;border:0;box-shadow:none;border-radius:20px;background:var(--pin);color:var(--pin-ink);font:600 11px/1 Inter,system-ui,sans-serif;font-variant-numeric:tabular-nums}'
      + ':host([data-dual-column]) .pin.active{background:var(--pin-selected);color:var(--pin-selected-ink);box-shadow:0 0 0 2px var(--paper)}'
      + ':host([data-dual-column]) .pin[hidden],.pnum[hidden]{display:none}'
      + '.pnum{position:absolute;display:flex;align-items:center;flex-direction:column;gap:2px;border:0;padding:2px 0;border-radius:7px;background:transparent;color:var(--muted);font:600 12px/18px Inter,system-ui,sans-serif;font-variant-numeric:tabular-nums;cursor:pointer;pointer-events:auto}'
      + '.pnum:disabled{pointer-events:none}.pnum:not(:disabled):hover{background:var(--deemphasis)}.pnum.is-current{color:var(--pin-selected)}'
      + '.pnum i{font:700 10.5px/18px Inter,system-ui,sans-serif;background:var(--pin);color:var(--pin-ink);padding:0 5px;border-radius:6px}.pnum i[hidden]{display:none}'
      + '@media(max-width:767px){:host([data-dual-column]) .pin{font-size:12px}:host([data-dual-column]) .pin::after{position:absolute;content:"";inset:-9px -3px}.pnum:not(:disabled)::after{position:absolute;content:"";inset:-2px -5px}}'
      + '.hover{border:1px dashed #ad6a23;background:#efb24b1a}';
    shadow.appendChild(style); document.body.appendChild(host);
    hover = document.createElement('div'); hover.className = 'outline hover'; hover.hidden = true; shadow.appendChild(hover);
  }
  function place(box, rect, origin) {
    box.style.transform = 'translate(' + (rect.left - origin.left) + 'px,' + (rect.top - origin.top) + 'px)';
    box.style.left = '0'; box.style.top = '0';
    box.style.width = rect.width + 'px'; box.style.height = rect.height + 'px';
  }
  function scrollToAnchor(found) {
    var behavior = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches ? 'instant' : 'smooth';
    if (!context.dualColumn || nestedScroller(found.el)) {
      found.el.scrollIntoView({ block: 'center', behavior: behavior });
      return;
    }
    var rect = found.range?.getClientRects()[0] || found.el.getBoundingClientRect();
    var top = Math.max(0, scrollY + rect.top - innerHeight * .28);
    if (Math.abs(top - scrollY) > 40) window.scrollTo({ top: top, behavior: behavior });
  }
  function nestedScroller(el) {
    for (var parent = el.parentElement; parent && parent !== document.body; parent = parent.parentElement) {
      if (parent.scrollHeight > parent.clientHeight && /^(auto|scroll|overlay)$/.test(getComputedStyle(parent).overflowY)) return true;
    }
    return false;
  }
  function activate(record, type) {
    activeId = previewId = record.thread.id;
    revealedPreviews.add(activeId); dismissedPreview = null; dismissedPreviews.delete(activeId); previewLast = ''; previewsLast = '';
    markerStateDirty = true;
    post(type || (context.displayMode === 'bubble' ? 'map-annotation-preview-select' : 'map-annotation-activate'), { id: activeId });
    if (context.dualColumn && !type && record.found) scrollToAnchor(record.found);
    schedule(false);
  }
  function reconcile() {
    var keep = new Set();
    (context.threads || []).forEach(function (thread, index) {
      if (!thread.anchor || logicalPath(thread.anchor.pagePath) !== path()) return;
      keep.add(thread.id);
      var record = records.get(thread.id);
      if (!record) {
        var pin = document.createElement('button'); pin.type = 'button'; pin.setAttribute('data-mark', '');
        pin.onclick = function (event) {
          event.stopPropagation();
          activate(record);
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
    reconcileParagraphs();
    structureDirty = false;
  }
  function reconcileParagraphs() {
    var anchored = new Map();
    records.forEach(function (record) {
      var paragraph = context.dualColumn && record.found ? record.found.el.closest('p') : null;
      record.paragraph = paragraph;
      if (!paragraph) return;
      var members = anchored.get(paragraph) || [];
      members.push(record);
      anchored.set(paragraph, members);
    });
    paragraphIndices.clear();
    var wanted = new Set();
    if (context.dualColumn) {
      var content = document.querySelector('main,article,[role="main"]') || document.body;
      var nodes = content.querySelectorAll('p');
      // Mark the whole reading column only for ordinary articles. For long pages keep
      // accurate paragraph indices, but paint only the paragraphs with annotations.
      nodes.forEach(function (el, index) {
        if (!selectable(el)) return;
        paragraphIndices.set(el, index + 1);
        if (nodes.length > 500 && !anchored.has(el)) return;
        wanted.add(el);
        var info = paragraphs.get(el);
        if (!info) {
          var button = document.createElement('button'), number = document.createElement('span'), count = document.createElement('i');
          button.className = 'pnum'; button.type = 'button';
          button.append(number, count); shadow.appendChild(button);
          info = { button: button, number: number, count: count, members: [] };
          paragraphs.set(el, info);
          button.onclick = function (event) {
            event.stopPropagation();
            if (info.members[0]) activate(info.members[0], 'map-annotation-activate');
          };
        }
        info.members = (anchored.get(el) || []).filter(function (member) { return !member.thread.isResolved; });
        info.number.textContent = String(index + 1); info.count.textContent = String(info.members.length);
        info.count.hidden = !info.members.length; info.button.disabled = !info.members.length;
        info.button.setAttribute('aria-label', '第 ' + (index + 1) + ' 段' + (info.members.length ? '，' + info.members.length + ' 条意见' : ''));
      });
    }
    paragraphs.forEach(function (info, el) { if (!wanted.has(el)) { info.button.remove(); paragraphs.delete(el); } });
  }
  function hidePreview() {
    if (previewLast) post('map-annotation-preview-hide');
    previewLast = '';
  }
  function hidePreviews() {
    hidePreview();
    if (previewsLast) post('map-annotation-previews', { items: [] });
    previewsLast = '';
  }
  function previewRect(rect) { return { left: rect.left, top: rect.top, width: rect.width, height: rect.height }; }
  function viewportGeometry(record, key) {
    if (!record.geometry) return null;
    var rect = record.geometry[key];
    if (!rect) return null;
    var left = rect.left - (scrollX - record.geometry.x), top = rect.top - (scrollY - record.geometry.y);
    return { left: left, top: top, width: rect.width, height: rect.height, right: left + rect.width, bottom: top + rect.height };
  }
  function surroundingGeometry() {
    // Sample the viewport, never scan the full document on scroll. Work is independent
    // of article length and preview text remains entirely in the trusted host.
    var boxes = [], seen = new Set(), anchors = new Set();
    if (!document.elementFromPoint) return boxes;
    records.forEach(function (record) { if (record.found) anchors.add(record.found.el); });
    for (var row = 0; row < 8; row++) for (var column = 0; column < 6; column++) {
      var target = document.elementFromPoint((column + 0.5) * innerWidth / 6, (row + 0.5) * innerHeight / 8);
      var element = target && target.closest('h1,h2,h3,h4,p,li,button,a,img,input,pre,table,blockquote');
      if (!element || element === host || host.contains(element) || anchors.has(element) || seen.has(element)) continue;
      seen.add(element);
      var rect = element.getBoundingClientRect();
      if (rect.width && rect.height) boxes.push(previewRect(rect));
    }
    return boxes;
  }
  function publishPreview(force) {
    if (context.displayMode !== 'bubble' || context.enabled || context.pending || (previewsHidden && !revealedPreviews.size)) { hidePreviews(); return; }
    var items = [], markers = [];
    records.forEach(function (item) {
      if (!item.found || !item.found.el.isConnected) return;
      if (context.dualColumn && item.thread.isResolved && item.thread.id !== activeId) return;
      var pin = viewportGeometry(item, 'pin');
      if (pin && pin.bottom > 0 && pin.top < innerHeight) markers.push(previewRect(pin));
      if (dismissedPreviews.has(item.thread.id) || (previewsHidden && !revealedPreviews.has(item.thread.id))) return;
      var rect = viewportGeometry(item, 'anchor');
      if (rect && rect.width && rect.height && rect.bottom > 0 && rect.top < innerHeight && rect.right > 0 && rect.left < innerWidth)
        items.push({ id: item.thread.id, rect: previewRect(rect), obstacles: [] });
    });
    var surrounding = items.length ? surroundingGeometry() : [];
    var itemsKey = JSON.stringify([items, surrounding, markers]);
    if (force || itemsKey !== previewsLast) { previewsLast = itemsKey; post('map-annotation-previews', { items: items, obstacles: surrounding, markers: markers }); }
    var record = records.get(previewId || activeId) || (items.length ? records.get(items[0].id) : null);
    if (record) previewId = record.thread.id;
    if (!record || !items.some(function (item) { return item.id === record.thread.id; }) || dismissedPreview === record.thread.id) { hidePreview(); return; }
    var rect = previewRect(viewportGeometry(record, 'anchor')), key = record.thread.id + JSON.stringify(rect);
    if (!force && key === previewLast) return;
    previewLast = key;
    post('map-annotation-preview', { id: record.thread.id, rect: rect, obstacles: surrounding });
  }
  function viewportPositioned(el) {
    for (var node = el; node && node !== document.documentElement; node = node.parentElement) {
      var position = getComputedStyle(node).position;
      if (position === 'fixed' || position === 'sticky') return true;
    }
    return false;
  }
  function readPaper() {
    for (var node of [document.body, document.documentElement]) {
      var color = readRgb(getComputedStyle(node).backgroundColor);
      if (color) return color;
    }
    return [255, 255, 255];
  }
  function readRgb(value) {
    var match = /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*(?:,\s*([.\d]+)\s*)?\)$/.exec(value);
    if (!match || (match[4] && Number(match[4]) < .2)) return null;
    var rgb = match.slice(1, 4).map(Number);
    return rgb.every(function (part) { return part <= 255; }) ? rgb : null;
  }
  function layoutHeaderTints() {
    headerTints = Array.from(document.querySelectorAll('header,[role="banner"]')).slice(0, 8).flatMap(function (header) {
      var rect = header.getBoundingClientRect();
      if (rect.width < innerWidth * .7 || rect.height < 36 || viewportPositioned(header)) return [];
      var style = getComputedStyle(header), linear = style.backgroundImage.lastIndexOf('linear-gradient(');
      var gradient = linear >= 0 ? style.backgroundImage.slice(linear) : style.backgroundImage;
      var colors = (gradient.match(/rgba?\([^)]*\)/g) || []).map(readRgb).filter(Boolean);
      var color = readRgb(style.backgroundColor);
      if (!colors.length && color) colors.push(color);
      return colors.length ? [{ top: rect.top + scrollY, bottom: rect.bottom + scrollY, colors: [colors[0], colors.at(-1)] }] : [];
    });
  }
  function publishHeaderTints() {
    var visible = headerTints.find(function (item) { return item.top <= scrollY + 3 && item.bottom > scrollY + 3; });
    var colors = visible ? visible.colors : null, key = JSON.stringify(colors);
    if (key !== headerTintsLast) { headerTintsLast = key; post('map-annotation-header-tints', { colors: colors }); }
  }
  function layoutParagraphs(origin) {
    if (!context.dualColumn) return;
    var desktop = innerWidth >= 768, right = 0;
    paragraphs.forEach(function (info, element) {
      var rect = element.getBoundingClientRect(), gutter = desktop ? 52 : 38;
      right = Math.max(right, rect.width > 0 ? rect.right : 0);
      // A hosted page can use every pixel. Use its existing left margin instead of
      // padding or wrapping its DOM to simulate an article.
      info.button.hidden = rect.left < gutter || !rect.width || !rect.height;
      if (!info.button.hidden) place(info.button, {
        left: rect.left - gutter, top: rect.top + 5, width: desktop ? 34 : 30, height: info.members.length ? 42 : 22,
      }, origin);
    });
    var items = [];
    var hasColumn = right > 0;
    records.forEach(function (record) {
      var paragraph = paragraphIndices.get(record.paragraph);
      if (paragraph) items.push({ id: record.thread.id, group: 'p:' + paragraph, paragraph: paragraph });
      if (!hasColumn && record.found) right = Math.max(right, record.found.el.getBoundingClientRect().right);
    });
    var paper = readPaper();
    host.toggleAttribute('data-dark-paper', .2126 * paper[0] + .7152 * paper[1] + .0722 * paper[2] < 100);
    var state = { items: items, contentRight: Math.round(right), paper: paper };
    var key = JSON.stringify(state);
    if (key !== paragraphsLast) { paragraphsLast = key; post('map-annotation-paragraphs', state); }
  }
  function publishReadingPosition() {
    if (!context.dualColumn) return;
    var nearest = null, distance = Infinity;
    records.forEach(function (record) {
      if (record.thread.isResolved) return;
      var box = viewportGeometry(record, 'anchor');
      if (!box || box.bottom <= 0 || box.top >= innerHeight) return;
      var current = Math.abs((box.top + box.bottom) / 2 - innerHeight * .35);
      if (current < distance) { distance = current; nearest = record; }
    });
    var id = nearest ? nearest.thread.id : null;
    if (id === readingLast) return;
    readingLast = id;
    post('map-annotation-reading', { id: id });
  }
  function reviewPin(last, range, occupied, lines) {
    var size = innerWidth < 768 ? 22 : 18, step = size + 3;
    var right = Math.max(2, Math.min(innerWidth, document.documentElement.scrollWidth - scrollX) - size - 2);
    var left = Math.max(2, Math.min(right, last.right + (range ? 4 : -size / 2)));
    var minTop = 2 - scrollY;
    var top = Math.max(minTop, range ? last.top + (last.height - size) / 2 : last.top - size / 2);
    function placePin(x, y, avoidText) {
      if (occupied.some(function (pin) { return Math.abs(pin.top - y) < size + 1 && Math.abs(pin.left - x) < size + 1; })) return null;
      if (avoidText && lines.some(function (box) { return box.left < x + size && box.right > x && box.top < y + size && box.bottom > y; })) return null;
      var pin = { left: x, top: y, width: size, height: size };
      occupied.push(pin);
      return pin;
    }
    function searchRow(y, avoidText) {
      for (var offset = 0; left - offset >= 2 || (range && left + offset <= right); offset += step) {
        var before = left - offset >= 2 ? placePin(left - offset, y, avoidText) : null;
        if (before) return before;
        var after = range && offset && left + offset <= right ? placePin(left + offset, y, avoidText) : null;
        if (after) return after;
      }
      return null;
    }
    // No inline space is reserved in an author's document. Recheck the text on
    // every alternate row, including the line immediately above the selection.
    var above = Math.max(minTop, last.top - size);
    var placed = placePin(left, top, range) || (range && above < top ? placePin(left, above, true) : null);
    if (placed) return placed;
    for (var row = 0; row < 10; row++) {
      var y = (range && row ? above : top) - row * step;
      if (y >= minTop) placed = searchRow(y, range);
      if (!placed && range && row) placed = searchRow(top + row * step, true);
      if (placed) return placed;
    }
    // In dense passages, extend below the anchor so every numbered target can be opened.
    for (var collisionRow = 0; !placed; collisionRow++) placed = searchRow(top + collisionRow * step, false);
    return placed;
  }
  var pendingViewportPositioned = false;
  function paint() {
    frame = 0;
    if (!context) return;
    mount(); if (!shadow) return;
    host.style.display = context.displayMode === 'hidden' && !context.enabled ? 'none' : 'block';
    host.setAttribute('data-display-mode', context.displayMode || 'bubble');
    host.toggleAttribute('data-dual-column', !!context.dualColumn);
    if (structureDirty) { reconcile(); geometryDirty = true; }
    // Read all geometry before writing. On ordinary document scroll the absolute layer
    // moves with the page natively; no DOM lookup, layout read or marker update is needed.
    var origin = host.getBoundingClientRect(), updates = [], missing = [], pinCounts = new Map(), occupiedPins = [];
    if (geometryDirty) {
      var textLines = new Map();
      records.forEach(function (record) {
        var found = record.found;
        record.viewportPositioned = !!found && viewportPositioned(found.el);
        if (!found || !found.el.isConnected) { missing.push(record.thread.id); updates.push({ record: record, rects: [] }); return; }
        var rect = found.range ? found.range.getBoundingClientRect() : found.el.getBoundingClientRect();
        if (!rect.width || !rect.height) { missing.push(record.thread.id); updates.push({ record: record, rects: [] }); return; }
        var count = pinCounts.get(found.el) || 0; pinCounts.set(found.el, count + 1);
        var rects = found.range ? Array.from(found.range.getClientRects()).filter(function (box) { return box.width && box.height; }) : [rect];
        var lines = [];
        if (context.dualColumn && found.range) {
          var paragraph = record.paragraph || found.el;
          if (!textLines.has(paragraph)) {
            var contents = document.createRange();
            contents.selectNodeContents(paragraph);
            textLines.set(paragraph, Array.from(contents.getClientRects()));
          }
          lines = textLines.get(paragraph);
        }
        var pin = context.dualColumn ? reviewPin(rects.at(-1) || rect, !!found.range, occupiedPins, lines) :
          { left: Math.max(-scrollX, Math.min(rect.right - 12 - count * 28, document.documentElement.scrollWidth - scrollX - 27)),
            top: Math.max(record.viewportPositioned ? 2 : -scrollY + 2, rect.top - 12), width: 25, height: 25 };
        updates.push({ record: record, anchor: previewRect(rect), rects: rects, pin: pin });
      });
    }
    var pendingRects = [];
    if (geometryDirty) {
      pendingViewportPositioned = false;
      if (pending) {
        var selected = resolve(pending);
        if (selected) {
          pendingRects = context.dualColumn && selected.range ? Array.from(selected.range.getClientRects()) : [selected.el.getBoundingClientRect()];
          pendingViewportPositioned = viewportPositioned(selected.el);
        }
      }
    }
    if (hoverDirty && context.enabled && pointer) {
      var target = document.elementFromPoint ? document.elementFromPoint(pointer.x, pointer.y) : currentHover;
      currentHover = selectable(target) ? target : null;
    }
    var hoverRect = currentHover && context.enabled && currentHover.isConnected ? currentHover.getBoundingClientRect() : null;
    updates.forEach(function (update) {
      var record = update.record;
      record.located = !!update.pin;
      record.geometry = update.pin ? { anchor: update.anchor, pin: update.pin, rects: update.rects.map(previewRect), x: scrollX, y: scrollY } : null;
      if (update.pin) place(record.pin, update.pin, origin);
      while (record.boxes.length > update.rects.length) record.boxes.pop().remove();
      update.rects.forEach(function (rect, index) {
        var box = record.boxes[index];
        if (!box) { box = document.createElement('div'); box.setAttribute('data-mark', ''); record.boxes.push(box); shadow.appendChild(box); }
        box.className = record.found.range ? 'highlight' : 'outline';
        if (record.found.range && update.rects.length > 1) box.classList.add(index === 0 ? 'first' : index === update.rects.length - 1 ? 'last' : 'middle');
        place(box, rect, origin);
      });
    });
    if (geometryDirty || markerStateDirty) {
      var selectedRecord = records.get(activeId), paintedBoxes = new Set();
      function paintRecord(record) {
        var selected = record.thread.id === activeId, resolved = context.dualColumn && record.thread.isResolved;
        var visible = record.located && (!resolved || selected);
        if (record.pin.hidden === visible) record.pin.hidden = !visible;
        var pinClass = 'pin' + (selected ? ' active' : '');
        if (record.pin.className !== pinClass) record.pin.className = pinClass;
        var muted = context.dualColumn && (resolved || (previewsHidden && !selected && !revealedPreviews.has(record.thread.id)));
        record.boxes.forEach(function (box) {
          var key = box.style.transform + ':' + box.style.width + ':' + box.style.height + ':' + (record.found?.range ? 'range' : 'element');
          box.hidden = !visible || (context.dualColumn && paintedBoxes.has(key));
          if (!box.hidden && context.dualColumn) paintedBoxes.add(key);
          box.classList.toggle('active', selected);
          box.classList.toggle('dim', !!muted);
        });
      }
      if (selectedRecord) paintRecord(selectedRecord);
      records.forEach(function (record) { if (record !== selectedRecord) paintRecord(record); });
      paragraphs.forEach(function (info, element) { info.button.classList.toggle('is-current', selectedRecord?.paragraph === element); });
    }
    if (geometryDirty) {
      layoutParagraphs(origin);
      if (context.dualColumn) layoutHeaderTints();
      while (pendingBoxes.length > pendingRects.length) pendingBoxes.pop().remove();
      pendingRects.forEach(function (rect, index) {
        var box = pendingBoxes[index];
        if (!box) { box = document.createElement('div'); pendingBoxes.push(box); shadow.appendChild(box); }
        box.className = context.dualColumn ? 'pending-mark' : 'outline';
        place(box, rect, origin);
      });
      var serialized = JSON.stringify(missing.sort());
      if (serialized !== lastLocations) { lastLocations = serialized; post('map-annotation-locations', { missingIds: missing }); }
    }
    hover.hidden = !hoverRect; if (hoverRect) place(hover, hoverRect, origin);
    if (context.dualColumn) publishHeaderTints();
    publishReadingPosition();
    publishPreview(geometryDirty);
    geometryDirty = false; hoverDirty = false; markerStateDirty = false;
  }
  function schedule(geometry) { if (geometry !== false) geometryDirty = true; if (!frame) frame = requestAnimationFrame(paint); }
  function invalidate() { structureDirty = true; schedule(); }
  window.addEventListener('message', function (event) {
    var data = event.data;
    if (event.source !== window.parent || !data || typeof data !== 'object') return;
    if (data.type === 'map-annotation-init') {
      if (typeof data.nonce !== 'string' || data.nonce.length > 100 || !data.nonce || typeof data.siteId !== 'string' || !data.siteId) return;
      try { new URL(data.siteUrl); } catch (_) { return; }
      if (!context || context.displayMode !== data.displayMode || context.contentVersion !== data.contentVersion) { previewId = null; dismissedPreview = null; dismissedPreviews.clear(); hidePreview(); }
      var nextKey = JSON.stringify(data.threads || []);
      if (!context || context.nonce !== data.nonce) { paragraphsLast = ''; readingLast = undefined; headerTintsLast = ''; }
      if (!context || context.siteUrl !== data.siteUrl || context.contentVersion !== data.contentVersion || context.dualColumn !== data.dualColumn || nextKey !== threadsKey) structureDirty = true;
      if (typeof data.previewsHidden === 'boolean') { previewsHidden = data.previewsHidden; revealedPreviews = new Set(Array.isArray(data.revealedPreviewIds) ? data.revealedPreviewIds.slice(0, 500) : []); }
      if (Array.isArray(data.dismissedPreviewIds)) dismissedPreviews = new Set(data.dismissedPreviewIds.slice(0, 500).filter(function (id) { return typeof id === 'string'; }));
      var pendingChanged = !!context?.pending !== !!data.pending;
      threadsKey = nextKey; context = data; activeId = data.activeId || null; if (!data.pending) pending = null;
      markerStateDirty = true;
      if (!context.suggestSelection || context.enabled || context.pending) clearSelectionCandidate();
      mount(); observe(); post('map-annotation-ready'); schedule(structureDirty || pendingChanged); return;
    }
    if (!context || data.siteId !== context.siteId || data.nonce !== context.nonce) return;
    if (data.type === 'map-annotation-preview-dismiss') {
      dismissedPreview = data.id || previewId || activeId;
      if (dismissedPreview) { dismissedPreviews.add(dismissedPreview); revealedPreviews.delete(dismissedPreview); }
      markerStateDirty = true; hidePreview(); schedule(false); return;
    }
    if (data.type === 'map-annotation-previews-hide') { previewsHidden = true; revealedPreviews.clear(); markerStateDirty = true; hidePreviews(); schedule(false); return; }
    if (data.type === 'map-annotation-previews-show') { previewsHidden = false; revealedPreviews.clear(); dismissedPreviews.clear(); dismissedPreview = null; previewsLast = ''; markerStateDirty = true; schedule(false); return; }
    if (data.type === 'map-annotation-accept-selection' && context.suggestSelection && data.anchor?.kind === 'text') {
      if (resolve(data.anchor)) {
        pending = data.anchor; clearSelectionCandidate(); window.getSelection()?.removeAllRanges(); schedule();
      }
      return;
    }
    if (data.type === 'map-annotation-dismiss-selection' && context.suggestSelection) {
      clearSelectionCandidate(); window.getSelection()?.removeAllRanges(); return;
    }
    if (data.type === 'map-annotation-focus') {
      var thread = (context.threads || []).find(function (item) { return item.id === data.id; });
      var found = thread && resolve(thread.anchor);
      if (found) { activeId = thread.id; previewId = thread.id; revealedPreviews.add(thread.id); dismissedPreview = null; dismissedPreviews.delete(thread.id); structureDirty = true; scrollToAnchor(found); schedule(); }
      else post('map-annotation-locations', { missingIds: [data.id] });
    }
  });
  document.addEventListener('pointerdown', function (event) {
    if (context && context.dualColumn && event.isTrusted) post('map-annotation-pointerdown');
  }, true);
  document.addEventListener('pointermove', function (event) {
    if (!context || !context.enabled) return;
    pointer = { x: event.clientX, y: event.clientY }; currentHover = selectable(event.target) ? event.target : null; hoverDirty = true; schedule(false);
  }, true);
  document.addEventListener('click', function (event) {
    if (!context || !selectable(event.target) || event.composedPath().indexOf(host) >= 0) return;
    if (!context.enabled) {
      if (!context.dualColumn || context.displayMode === 'hidden' || event.ctrlKey || event.metaKey || event.shiftKey
        || !window.getSelection()?.isCollapsed) return;
      var matches = [];
      records.forEach(function (record) {
        var shape = record.geometry;
        if (!record.found?.range || !shape || !record.found.el.contains(event.target)
          || (record.thread.isResolved && record.thread.id !== activeId)) return;
        var x = event.clientX + scrollX - shape.x, y = event.clientY + scrollY - shape.y;
        if (shape.rects.some(function (rect) { return x >= rect.left && x <= rect.left + rect.width && y >= rect.top && y <= rect.top + rect.height; })) matches.push(record);
      });
      if (matches.length) {
        event.preventDefault(); event.stopImmediatePropagation();
        var selected = matches.find(function (record) { return record.thread.id === activeId; });
        activate(matches[(matches.indexOf(selected) + 1) % matches.length]);
      }
      return;
    }
    event.preventDefault(); event.stopImmediatePropagation();
    var selection = window.getSelection(), anchor, el = event.target;
    if (selection && !selection.isCollapsed && selection.toString().trim()) {
      var range = selection.getRangeAt(0), common = range.commonAncestorContainer;
      el = common.nodeType === Node.ELEMENT_NODE ? common : common.parentElement;
      if (!selectable(el) || range.toString().length > 1000) return;
      anchor = selectedTextAnchor(el, range);
    } else anchor = baseAnchor(el);
    pending = anchor; context.enabled = false; currentHover = null;
    post('map-annotation-selected', { anchor: anchor }); schedule();
  }, true);
  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape') clearSelectionCandidate();
    if (context && context.enabled && event.key === 'Escape') { context.enabled = false; currentHover = null; post('map-annotation-cancel'); schedule(); }
  }, true);
  window.addEventListener('scroll', function (event) {
    if (!context) return;
    clearSelectionCandidate();
    if (event.target === document || event.target === window) {
      if (context.displayMode === 'bubble' || context.dualColumn) schedule(false);
      // Absolute markers follow ordinary content natively. Fixed/sticky targets (including
      // descendants) move relative to the document and need fresh viewport geometry.
      if (pendingViewportPositioned || Array.from(records.values()).some(function (record) { return record.viewportPositioned; })) schedule();
      if (context.enabled) { hoverDirty = true; schedule(false); }
      return;
    }
    schedule();
  }, { capture: true, passive: true });
  document.addEventListener('selectionchange', function () {
    if (context?.suggestSelection && !selectionFrame) selectionFrame = requestAnimationFrame(updateSelectionCandidate);
  });
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
  window.addEventListener('pagehide', function () {
    observer.disconnect();
    if (frame) cancelAnimationFrame(frame);
    if (selectionFrame) cancelAnimationFrame(selectionFrame);
    frame = selectionFrame = 0; context = null;
  });
})();
