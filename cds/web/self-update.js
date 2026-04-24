/*
 * CDS 系统更新弹窗 — 跨页面统一实现
 *
 * 历史背景:
 *   2026-04-18 后台重构把「自动更新」从分支列表页搬到项目列表页的设
 *   置里,于是出现了两个独立实现: app.js:openSelfUpdate(复用 index.html
 *   的 #configModal 全局模态,combobox 可搜索) 和 projects.js:
 *   cdsOpenSelfUpdate (自带 DOM,原生 <select>,多一个强制同步按钮)。
 *   用户反馈要合并到一个统一版本,支持粘贴/搜索/强制同步/全页可用。
 *
 * 本模块导出全局函数 window.openSelfUpdateModal(),由 index.html 和
 * project-list.html 共同加载,两页 UX 一致。原有的两个 openSelfUpdate /
 * cdsOpenSelfUpdate 函数都收敛到调这个入口。
 *
 * 依赖: 无 — 只用原生 DOM + fetch。不需要 jQuery / 全局 esc 函数
 * (自带 escHtml),也不依赖 index.html 上的 #configModal 元素。
 */

(function () {
  'use strict';

  function escHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  async function fetchBranches() {
    const r = await fetch('/api/self-branches', { credentials: 'same-origin' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
  }

  // 全局防抖: 重复点击不应叠起两个弹窗
  let _openBackdrop = null;
  function closeAny() {
    if (_openBackdrop && document.body.contains(_openBackdrop)) {
      document.body.removeChild(_openBackdrop);
    }
    _openBackdrop = null;
  }

  /**
   * 主入口。页面任意位置点「自动更新」/「系统更新」按钮都进这里。
   * 参数 opts 保留为对象以便未来扩展 (例如 deeplink 预选分支)。
   */
  async function openSelfUpdateModal(opts) {
    opts = opts || {};
    closeAny();

    // 先异步拉分支 —— 拉完再上 UI,避免打开弹窗再显示"加载中"的闪烁
    let info;
    try {
      info = await fetchBranches();
    } catch (e) {
      const msg = 'CDS 系统更新: 拉取分支列表失败 — ' + (e && e.message || e);
      // 两个页面都有 showToast 变体,找到哪个用哪个
      if (typeof window.showToast === 'function') window.showToast(msg, 'error');
      else alert(msg);
      return;
    }

    const current = info.current || '';
    const commitHash = (info.commitHash || '').slice(0, 8);
    const branches = Array.isArray(info.branches) ? info.branches : [];
    // 当前分支置顶,其它按字典序排,不改原数组
    const sorted = [current, ...branches.filter((b) => b && b !== current).sort()];

    // ── Modal DOM ──
    const backdrop = document.createElement('div');
    backdrop.className = 'cds-selfupdate-backdrop';
    backdrop.style.cssText = [
      'position:fixed', 'inset:0', 'background:rgba(3,7,18,0.55)',
      'backdrop-filter:blur(4px)', 'z-index:10000',
      'display:flex', 'align-items:center', 'justify-content:center',
      'padding:24px',
    ].join(';');
    backdrop.onclick = () => closeAny();
    _openBackdrop = backdrop;

    const dlg = document.createElement('div');
    dlg.className = 'cds-selfupdate-dialog';
    // 关键约束 (参见 .claude/rules/frontend-modal.md):
    // - 布局关键 height / maxHeight 走 inline style,不受 Tailwind 构建影响
    // - min-height:0 让滚动区可压缩
    dlg.style.cssText = [
      'background:var(--bg-card,#0f1014)',
      'border:1px solid var(--card-border,rgba(255,255,255,0.08))',
      'border-radius:10px',
      'width:min(560px,calc(100vw - 32px))',
      'max-height:min(640px,90vh)',
      'display:flex', 'flex-direction:column',
      'box-shadow:0 24px 60px rgba(0,0,0,0.55)',
      'overflow:hidden',
    ].join(';');
    dlg.onclick = (e) => e.stopPropagation();

    dlg.innerHTML = [
      // Header
      '<div style="flex-shrink:0;padding:14px 18px;border-bottom:1px solid var(--card-border,rgba(255,255,255,0.08));display:flex;align-items:center;justify-content:space-between">',
      '  <div style="font-size:14px;font-weight:700;color:var(--text-primary)">🔄 CDS 系统更新</div>',
      '  <button id="_suClose" style="width:26px;height:26px;border-radius:6px;border:1px solid var(--card-border,rgba(255,255,255,0.08));background:transparent;color:var(--text-muted);cursor:pointer;font-size:16px;line-height:1">×</button>',
      '</div>',
      // Scrollable body
      '<div style="flex:1;min-height:0;overflow-y:auto;padding:16px 18px">',
      '  <div style="font-size:12px;color:var(--text-secondary);line-height:1.6;margin-bottom:14px">',
      '    拉取目标分支最新代码并重启 CDS。流程 <code style="padding:1px 5px;background:var(--bg-code-block,rgba(255,255,255,0.06));border-radius:3px">git fetch → checkout → pull → tsc 预检 → restart</code>',
      '  </div>',
      '  <div style="font-size:12px;color:var(--text-secondary);margin-bottom:4px">当前分支</div>',
      '  <div style="font-family:var(--font-mono,monospace);font-size:13px;color:var(--accent);margin-bottom:16px">',
      escHtml(current) + (commitHash ? ' <span style="color:var(--text-muted);font-size:11px">@ ' + escHtml(commitHash) + '</span>' : ''),
      '  </div>',
      // Branch combobox (搜索 + 选择 + 粘贴)
      '  <label style="display:block;font-size:12px;color:var(--text-secondary);margin-bottom:4px">目标分支 <span style="color:var(--text-muted)">(' + branches.length + ' 个可选, 支持粘贴 / 搜索)</span></label>',
      '  <div id="_suCombo" style="position:relative">',
      '    <div style="position:relative">',
      '      <input id="_suBranch" type="text" autocomplete="off" spellcheck="false" ',
      '        value="' + escHtml(current) + '" placeholder="输入分支名 / 粘贴 Ctrl+V / 点击下拉选择" ',
      '        style="width:100%;box-sizing:border-box;padding:8px 38px 8px 10px;border-radius:6px;border:1px solid var(--card-border,rgba(255,255,255,0.08));background:var(--bg-base);color:var(--text-primary);font-family:var(--font-mono,monospace);font-size:12px">',
      '      <button id="_suToggle" type="button" tabindex="-1" style="position:absolute;right:1px;top:1px;bottom:1px;width:34px;display:flex;align-items:center;justify-content:center;border:none;background:transparent;color:var(--text-muted);cursor:pointer">',
      '        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 6 8 10 12 6"/></svg>',
      '      </button>',
      '    </div>',
      // Dropdown 使用 position:fixed + portal 到 document.body,而不是
      // 相对 combobox 的 absolute — 否则外层 `overflow-y:auto` 滚动体
      // 会在弹窗底部把下拉框裁切一半(image 1 红框就是这个问题)。
      // fixed + JS 定位跟随 input 的 boundingRect,scroll / resize 时
      // 重算,保证永远贴在输入框正下方。
      '  </div>',
      // Progress area (initially hidden)
      // 进度日志：bg + color 都走 token，白天浅底深字，黑夜深底浅字。禁止 hardcoded 颜色。
      '  <div id="_suProgress" style="display:none;margin-top:16px;border:1px solid var(--card-border,rgba(255,255,255,0.08));border-radius:6px;padding:10px 12px;background:var(--bg-terminal);color:var(--text-primary);font-family:var(--font-mono,monospace);font-size:11px;max-height:260px;overflow-y:auto;line-height:1.6"></div>',
      '  <div id="_suStatus" style="margin-top:8px;font-size:12px;color:var(--text-muted);min-height:14px"></div>',
      '</div>',
      // Sticky footer — 关键改进: 按钮永远在可视区域,不会被长内容推出屏幕
      '<div style="flex-shrink:0;padding:12px 18px;border-top:1px solid var(--card-border,rgba(255,255,255,0.08));display:flex;gap:8px;justify-content:space-between;align-items:center;flex-wrap:wrap;background:var(--bg-card,#0f1014)">',
      '  <button id="_suForce" title="git fetch + reset --hard origin/<branch> + 清 dist 缓存 + restart — 用于 self-update 因本地分叉 merge 而丢远端改动时救急" style="padding:7px 12px;border-radius:6px;border:1px solid rgba(245,158,11,0.4);background:transparent;color:#f59e0b;cursor:pointer;font-size:12px;font-weight:500">💥 强制同步 (hard-reset)</button>',
      '  <div style="display:flex;gap:8px">',
      '    <button id="_suCancel" style="padding:7px 14px;border-radius:6px;border:1px solid var(--card-border,rgba(255,255,255,0.08));background:transparent;color:var(--text-primary);cursor:pointer;font-size:12px">取消</button>',
      '    <button id="_suGo" style="padding:7px 14px;border-radius:6px;border:none;background:var(--accent,#10b981);color:#fff;cursor:pointer;font-size:12px;font-weight:600">拉取并重启</button>',
      '  </div>',
      '</div>',
    ].join('');

    backdrop.appendChild(dlg);
    document.body.appendChild(backdrop);

    // ── Interactions ──
    const $ = (id) => dlg.querySelector('#' + id);
    const input = $('_suBranch');
    const toggle = $('_suToggle');
    const goBtn = $('_suGo');
    const forceBtn = $('_suForce');
    const cancelBtn = $('_suCancel');
    const closeBtn = $('_suClose');
    const progressEl = $('_suProgress');
    const statusEl = $('_suStatus');

    // Build the dropdown as a sibling of <body>, positioned fixed. Keeps
    // it outside the modal's scrollable body so it can't be clipped.
    const dropdown = document.createElement('div');
    dropdown.id = '_suDropdown';
    dropdown.style.cssText = [
      'display:none', 'position:fixed',
      'max-height:240px', 'overflow-y:auto',
      'background:var(--bg-card,#0f1014)',
      'border:1px solid var(--card-border,rgba(255,255,255,0.08))',
      'border-radius:6px', 'box-shadow:0 8px 24px rgba(0,0,0,0.3)',
      'z-index:10010', // 比 backdrop(10000) 高
    ].join(';');
    dropdown.innerHTML = sorted.map((b) => {
      const isCurrent = b === current;
      return '<div class="_sui" data-value="' + escHtml(b) + '" style="padding:7px 12px;font-size:12px;color:var(--text-primary);font-family:var(--font-mono,monospace);cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis' +
        (isCurrent ? ';background:var(--bg-hover,rgba(255,255,255,0.04))' : '') +
        '">' +
        (isCurrent ? '<span style="color:var(--green,#10b981);margin-right:6px">✓</span>' : '') +
        escHtml(b) +
        (isCurrent ? ' <span style="color:var(--text-muted);font-size:11px">(当前)</span>' : '') +
        '</div>';
    }).join('');
    document.body.appendChild(dropdown);

    // 跟随 input 位置: 贴在 input 正下方。scroll / resize 时重算,
    // 否则 modal body 滚动会让下拉浮在空中。
    function positionDropdown() {
      const r = input.getBoundingClientRect();
      dropdown.style.top = (r.bottom + 4) + 'px';
      dropdown.style.left = r.left + 'px';
      dropdown.style.width = r.width + 'px';
    }
    dlg.querySelector('[id="_suCombo"] + *')?.before?.(); // noop; just for clarity

    function closeDropdown() { dropdown.style.display = 'none'; }
    function openDropdown() { positionDropdown(); dropdown.style.display = 'block'; }

    // Body 滚 / 窗口变尺寸要重定位。用 rAF 节流避免抖动。
    let __rafId = 0;
    const reposition = () => {
      if (dropdown.style.display !== 'block') return;
      if (__rafId) return;
      __rafId = requestAnimationFrame(() => { __rafId = 0; positionDropdown(); });
    };
    const scrollHost = dlg.querySelector('div[style*="overflow-y:auto"]');
    if (scrollHost) scrollHost.addEventListener('scroll', reposition, { passive: true });
    window.addEventListener('resize', reposition, { passive: true });
    window.addEventListener('scroll', reposition, { passive: true });
    function filter(q) {
      const needle = (q || '').toLowerCase();
      let anyVisible = false;
      for (const item of dropdown.querySelectorAll('._sui')) {
        const val = (item.getAttribute('data-value') || '').toLowerCase();
        const show = !needle || val.includes(needle);
        item.style.display = show ? '' : 'none';
        if (show) anyVisible = true;
      }
      // 有命中才展开下拉;清空就关闭避免遮挡
      if (needle) {
        if (anyVisible) openDropdown(); else closeDropdown();
      }
    }

    // 2026-04-22 fix: 选中分支后 input.focus() 会触发 'focus' 监听重新 openDropdown,
    // 用户感觉"点了下拉框关不掉"。引入 _suppressFocusOpen 标志：programmatic
    // focus 时跳过自动展开。
    let _suppressFocusOpen = false;
    input.addEventListener('focus', () => {
      if (_suppressFocusOpen) { _suppressFocusOpen = false; return; }
      openDropdown();
    });
    input.addEventListener('input', (e) => filter(e.target.value));
    // 粘贴走浏览器默认,再触发 filter 以展开匹配项
    input.addEventListener('paste', () => {
      // 下一个 tick 才能读到 value
      setTimeout(() => filter(input.value), 0);
    });
    toggle.addEventListener('click', (e) => {
      e.stopPropagation();
      if (dropdown.style.display === 'block') closeDropdown();
      else { filter(''); openDropdown(); input.focus(); }
    });
    dropdown.addEventListener('click', (e) => {
      const item = e.target.closest('._sui');
      if (!item) return;
      input.value = item.getAttribute('data-value') || '';
      closeDropdown();
      // 选中后让 focus 留在 input（方便继续编辑），但不让 focus 触发 openDropdown
      _suppressFocusOpen = true;
      input.focus();
    });
    // 点击 modal 其它地方关闭下拉(但保留 modal). Dropdown 是 portal
    // 到 body 的独立元素,这里要单独判断两处:
    //   - 点在 #_suCombo 里:不关(用户在输入)
    //   - 点在 dropdown 里:不关(点选分支)
    //   - 其它地方:关下拉
    const onBodyClick = (e) => {
      if (e.target.closest('#_suCombo')) return;
      if (e.target.closest('#_suDropdown')) return;
      closeDropdown();
    };
    document.addEventListener('click', onBodyClick, true);

    const close = () => {
      document.removeEventListener('keydown', onEsc);
      document.removeEventListener('click', onBodyClick, true);
      window.removeEventListener('resize', reposition);
      window.removeEventListener('scroll', reposition);
      if (scrollHost) scrollHost.removeEventListener('scroll', reposition);
      // Portal 过的 dropdown 也要一起清掉,否则残留在 body 上
      if (dropdown && dropdown.parentNode) dropdown.parentNode.removeChild(dropdown);
      closeAny();
    };
    const onEsc = (ev) => { if (ev.key === 'Escape') close(); };
    document.addEventListener('keydown', onEsc);
    closeBtn.addEventListener('click', close);
    cancelBtn.addEventListener('click', close);

    // ── SSE runner — shared between /self-update and /self-force-sync ──
    async function runSync(endpoint, label) {
      const target = input.value.trim();
      if (!target) {
        statusEl.innerHTML = '<span style="color:var(--red,#f43f5e)">✗ 分支名不能为空</span>';
        return;
      }
      goBtn.disabled = true;
      forceBtn.disabled = true;
      cancelBtn.disabled = true;
      goBtn.textContent = label + '中…';
      progressEl.style.display = 'block';
      progressEl.innerHTML = '';
      statusEl.innerHTML = '<span style="color:var(--text-muted)">连接 ' + escHtml(endpoint) + ' …</span>';

      let resp;
      try {
        resp = await fetch(endpoint, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ branch: target }),
        });
      } catch (e) {
        statusEl.innerHTML = '<span style="color:var(--red,#f43f5e)">✗ ' + escHtml(e.message) + '</span>';
        reenable();
        return;
      }
      if (!resp.ok) {
        statusEl.innerHTML = '<span style="color:var(--red,#f43f5e)">✗ HTTP ' + resp.status + '</span>';
        reenable();
        return;
      }

      const reader = resp.body && resp.body.getReader ? resp.body.getReader() : null;
      if (!reader) {
        statusEl.textContent = '浏览器不支持流式读取,已触发更新,稍后 CDS 会自动重启';
        return;
      }
      const decoder = new TextDecoder();
      let buf = '', curEvent = '', done = false;
      while (!done) {
        try {
          const { value, done: streamDone } = await reader.read();
          if (streamDone) break;
          buf += decoder.decode(value, { stream: true });
          let idx;
          while ((idx = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, idx).trimEnd();
            buf = buf.slice(idx + 1);
            if (!line) continue;
            if (line.startsWith('event: ')) curEvent = line.slice(7);
            else if (line.startsWith('data: ')) {
              try {
                const d = JSON.parse(line.slice(6));
                const title = d.title || d.message || '';
                const stepLabel = d.step || curEvent;
                const color = d.status === 'done' ? 'var(--green,#10b981)'
                  : d.status === 'error' ? 'var(--red,#f43f5e)'
                  : d.status === 'warning' ? '#f59e0b'
                  : curEvent === 'done' ? 'var(--green,#10b981)'
                  : curEvent === 'error' ? 'var(--red,#f43f5e)'
                  : 'var(--text-secondary)';
                progressEl.innerHTML += '<div style="color:' + color + '">[' + escHtml(stepLabel) + '] ' + escHtml(title) + '</div>';
                progressEl.scrollTop = progressEl.scrollHeight;
                if (curEvent === 'done') {
                  statusEl.innerHTML = '<span style="color:var(--green,#10b981)">✓ ' + label + '已触发,CDS 正在重启… 自动刷新中</span>';
                  done = true;
                  pollHealthy();
                }
                if (curEvent === 'error') {
                  statusEl.innerHTML = '<span style="color:var(--red,#f43f5e)">✗ ' + escHtml(title) + '</span>';
                  reenable();
                  done = true;
                }
              } catch { /* JSON 解析失败跳过 */ }
            }
          }
        } catch {
          // 流在 CDS 重启时被掐断,正常 —— 下面的 pollHealthy 兜底
          break;
        }
      }
      if (!done) {
        statusEl.innerHTML = '<span style="color:#f59e0b">⌛ CDS 正在重启,等待端口就绪…</span>';
        goBtn.textContent = '等待重启';
        pollHealthy();
      }
    }

    function reenable() {
      goBtn.disabled = false;
      forceBtn.disabled = false;
      cancelBtn.disabled = false;
      goBtn.textContent = '重试';
    }

    function pollHealthy() {
      // 与 app.js 的 waitForCdsHealthy 行为对齐: 最多等 60 秒
      let tries = 0;
      (function tick() {
        tries++;
        fetch('/healthz', { credentials: 'same-origin', cache: 'no-store' })
          .then((r) => (r.ok ? r.json() : null))
          .then((h) => {
            if (h && h.ok) {
              statusEl.innerHTML = '<span style="color:var(--green,#10b981)">✓ CDS 已重启,刷新页面...</span>';
              setTimeout(() => location.reload(), 600);
            } else if (tries < 40) {
              setTimeout(tick, 1500);
            } else {
              statusEl.innerHTML = '<span style="color:var(--red,#f43f5e)">✗ 重启超时,请手动刷新页面</span>';
              reenable();
            }
          })
          .catch(() => { if (tries < 40) setTimeout(tick, 1500); });
      })();
    }

    goBtn.addEventListener('click', () => runSync('/api/self-update', '更新'));
    forceBtn.addEventListener('click', () => {
      if (!window.confirm(
        '💥 强制同步会丢弃 host 上所有本地未推送的提交,硬重置到 origin/<当前选中分支>,再清 dist 缓存 + 重启。\n\n用于 self-update 的 git pull 合并错误导致代码没更新的场景。\n\n确定继续?'
      )) return;
      runSync('/api/self-force-sync', '强制同步');
    });

    // 打开后聚焦搜索框,方便直接开始输入 / 粘贴
    setTimeout(() => { input.focus(); input.select(); }, 10);
  }

  // 暴露到全局,两个页面都能调
  window.openSelfUpdateModal = openSelfUpdateModal;
})();
