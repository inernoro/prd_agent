/**
 * 全局转发日志面板
 *
 * 场景：用户看到「接口 502，但 CDS / 服务器日志都没东西」，分不清是
 * "请求没命中"、"命中但上游没起来"、还是"上游崩了"。本面板是 worker
 * port 的代理层日志，区别于 Activity Monitor 的 /api/* Dashboard 调用。
 *
 * 使用：顶部 🔍 按钮打开 → 弹窗显示最近 500 条，SSE 实时更新。
 */
(function () {
  var modal = null;
  var sse = null;
  var filter = 'all'; // all | errors | upstream-error | no-branch-match

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function outcomeTag(evt) {
    var map = {
      'ok': { label: 'OK', bg: 'rgba(34,197,94,0.15)', fg: '#22c55e' },
      'client-error': { label: '客户端', bg: 'rgba(251,146,60,0.18)', fg: '#fb923c' },
      'upstream-error': { label: '上游错误', bg: 'rgba(239,68,68,0.18)', fg: '#ef4444' },
      'no-branch-match': { label: '未命中路由', bg: 'rgba(168,85,247,0.18)', fg: '#a855f7' },
      'branch-not-running': { label: '分支未运行', bg: 'rgba(245,158,11,0.18)', fg: '#f59e0b' },
      'timeout': { label: '超时', bg: 'rgba(239,68,68,0.18)', fg: '#ef4444' },
    };
    var m = map[evt.outcome] || { label: evt.outcome, bg: 'rgba(120,120,120,0.18)', fg: '#999' };
    return '<span style="display:inline-block;padding:1px 8px;border-radius:4px;background:' + m.bg + ';color:' + m.fg + ';font-size:11px;font-weight:600">' + m.label + '</span>';
  }

  function methodTag(m) {
    var colors = { GET: '#22c55e', POST: '#3b82f6', PUT: '#f59e0b', DELETE: '#ef4444', PATCH: '#a855f7' };
    var c = colors[m] || '#999';
    return '<span style="font-family:var(--font-mono, monospace);font-weight:600;color:' + c + ';font-size:11px">' + escapeHtml(m) + '</span>';
  }

  function rowHtml(evt) {
    var t = new Date(evt.ts);
    var tStr = t.toLocaleTimeString() + '.' + String(t.getMilliseconds()).padStart(3, '0');
    var passFilter = (
      filter === 'all' ||
      (filter === 'errors' && (evt.outcome === 'upstream-error' || evt.outcome === 'no-branch-match' || evt.outcome === 'branch-not-running' || evt.outcome === 'timeout' || evt.outcome === 'client-error')) ||
      filter === evt.outcome
    );
    if (!passFilter) return '';

    var detail = '';
    if (evt.errorCode) {
      detail += '<div style="font-family:var(--font-mono, monospace);font-size:11px;color:#ef4444;margin-top:4px">' +
        '<strong>' + escapeHtml(evt.errorCode) + '</strong>: ' + escapeHtml(evt.errorMessage || '') +
      '</div>';
    }
    if (evt.hint) {
      detail += '<div style="font-size:12px;color:var(--text-muted);margin-top:3px">💡 ' + escapeHtml(evt.hint) + '</div>';
    }

    return '<div class="proxy-log-row" style="padding:8px 12px;border-bottom:1px solid var(--border-subtle);font-size:12px">' +
      '<div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">' +
        '<span style="color:var(--text-muted);font-family:var(--font-mono, monospace);font-size:11px">' + escapeHtml(tStr) + '</span>' +
        outcomeTag(evt) +
        methodTag(evt.method) +
        '<span style="color:var(--text-muted)">' + evt.status + '</span>' +
        '<span style="color:var(--text-muted)">' + evt.durationMs + 'ms</span>' +
        (evt.branchSlug ? '<span style="padding:1px 6px;background:var(--bg-card);border:1px solid var(--border-subtle);border-radius:3px;font-family:var(--font-mono, monospace);font-size:11px">' + escapeHtml(evt.branchSlug) + (evt.profileId ? ':' + escapeHtml(evt.profileId) : '') + '</span>' : '') +
      '</div>' +
      '<div style="margin-top:4px;font-family:var(--font-mono, monospace);font-size:12px;word-break:break-all">' +
        '<span style="color:var(--text-muted)">' + escapeHtml(evt.host || '-') + '</span>' +
        '<span style="color:var(--text-primary)">' + escapeHtml(evt.url) + '</span>' +
        (evt.upstream ? '<span style="color:var(--text-muted)"> → ' + escapeHtml(evt.upstream) + '</span>' : '') +
      '</div>' +
      detail +
    '</div>';
  }

  function renderList(container, events) {
    if (events.length === 0) {
      container.innerHTML = '<div style="padding:40px;text-align:center;color:var(--text-muted)">暂无转发日志。尝试刷新某个预览分支，这里会实时记录。</div>';
      return;
    }
    // 最新在上
    var html = events.slice().reverse().map(rowHtml).join('');
    if (!html.trim()) {
      container.innerHTML = '<div style="padding:40px;text-align:center;color:var(--text-muted)">当前过滤下无匹配记录。</div>';
      return;
    }
    container.innerHTML = html;
  }

  function openModal() {
    if (modal) return; // already open

    modal = document.createElement('div');
    modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.6);z-index:10000;display:flex;align-items:center;justify-content:center;padding:20px';
    modal.onclick = function (e) { if (e.target === modal) closeModal(); };

    var box = document.createElement('div');
    box.style.cssText = 'background:var(--bg-card);color:var(--text-primary);border:1px solid var(--border-subtle);border-radius:10px;width:min(100%, 980px);height:min(100%, 720px);display:flex;flex-direction:column;min-height:0';
    box.onclick = function (e) { e.stopPropagation(); };

    box.innerHTML =
      '<div style="padding:14px 18px;border-bottom:1px solid var(--border-subtle);display:flex;align-items:center;gap:12px;flex-shrink:0">' +
        '<div style="flex:1">' +
          '<div style="font-weight:600;font-size:14px">🔍 全局转发日志</div>' +
          '<div style="color:var(--text-muted);font-size:11px;margin-top:2px">CDS worker port 每一次请求都会在这里留痕 · 用于排查「接口 502 但服务器日志为空」</div>' +
        '</div>' +
        '<select id="proxyLogFilter" style="padding:6px 10px;background:var(--bg-input);color:var(--text-primary);border:1px solid var(--border-subtle);border-radius:5px;font-size:12px">' +
          '<option value="all">全部</option>' +
          '<option value="errors">仅错误</option>' +
          '<option value="upstream-error">上游错误</option>' +
          '<option value="no-branch-match">未命中路由</option>' +
          '<option value="branch-not-running">分支未运行</option>' +
        '</select>' +
        '<button id="proxyLogClearBtn" class="icon-btn sm" title="清空列表">清空</button>' +
        '<button id="proxyLogCloseBtn" class="icon-btn sm" title="关闭">✕</button>' +
      '</div>' +
      '<div id="proxyLogBody" style="flex:1;min-height:0;overflow-y:auto" data-testid="proxy-log-body"></div>' +
      '<div style="padding:8px 18px;border-top:1px solid var(--border-subtle);color:var(--text-muted);font-size:11px;flex-shrink:0">' +
        '<span id="proxyLogCount">0</span> 条记录 · 实时更新（SSE）· 环形缓冲最多 500 条' +
      '</div>';

    modal.appendChild(box);
    document.body.appendChild(modal);

    var body = box.querySelector('#proxyLogBody');
    var filterEl = box.querySelector('#proxyLogFilter');
    var countEl = box.querySelector('#proxyLogCount');

    var events = [];

    function update() {
      renderList(body, events);
      countEl.textContent = events.length;
    }

    filterEl.onchange = function () { filter = filterEl.value; update(); };
    box.querySelector('#proxyLogClearBtn').onclick = function () { events = []; update(); };
    box.querySelector('#proxyLogCloseBtn').onclick = closeModal;

    // 初始拉一次 + 开 SSE 持续订阅
    fetch('/api/proxy-log', { credentials: 'same-origin' })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        events = data.events || [];
        update();
        startSse(data.maxId || 0);
      })
      .catch(function (err) {
        body.innerHTML = '<div style="padding:20px;color:#ef4444">加载日志失败：' + escapeHtml(err.message) + '</div>';
      });

    function startSse(afterSeq) {
      try {
        sse = new EventSource('/api/proxy-log/stream?afterSeq=' + afterSeq);
        sse.onmessage = function (e) {
          try {
            var evt = JSON.parse(e.data);
            if (!evt || !evt.id) return;
            events.push(evt);
            if (events.length > 500) events.shift();
            update();
          } catch { /* ignore parse error */ }
        };
        sse.onerror = function () { /* browser auto-reconnects; we swallow errors */ };
      } catch (err) {
        // SSE not supported — degrade to manual refresh
      }
    }

    // ESC 关
    document.addEventListener('keydown', onKeydown);
  }

  function onKeydown(e) {
    if (e.key === 'Escape') closeModal();
  }

  function closeModal() {
    if (sse) { try { sse.close(); } catch { /* ignore */ } sse = null; }
    if (modal && modal.parentNode) modal.parentNode.removeChild(modal);
    modal = null;
    document.removeEventListener('keydown', onKeydown);
  }

  window.openProxyLogModal = openModal;
  window.closeProxyLogModal = closeModal;
})();
