/**
 * 全局构建命令编辑面板（2026-04-22）
 *
 * 用户痛点：单 profile 的 ⚙ 编辑命令 太琐碎 —— 每个项目都要重复同一套
 * "热加载 / 冷部署" 配置。本面板让用户**一次定义，按镜像类型批量覆盖**：
 *
 *   选「所有 .NET profile」 → 填两个命令（热 + 冷）→ 保存
 *   后端 POST /api/build-profiles/bulk-set-modes，自动拍快照便于回滚
 *
 * 顶部 🔧 按钮打开本 modal。
 */
(function () {
  var modal = null;

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // 预设：每种过滤范围对应一组默认热/冷命令模板
  var PRESETS = {
    'all': null,
    'dotnet': {
      hot: { id: 'dev', label: '开发（热加载）', command: 'dotnet run --urls http://0.0.0.0:$PORT' },
      cold: { id: 'cold', label: '冷部署（publish）', command: 'dotnet publish -c Release -o /tmp/publish && cd /tmp/publish && exec dotnet *.dll --urls http://0.0.0.0:$PORT' },
    },
    'node': {
      hot: { id: 'dev', label: '开发（Vite/HMR）', command: 'pnpm install --prefer-frozen-lockfile && pnpm dev --host 0.0.0.0 --port $PORT' },
      cold: { id: 'cold', label: '冷部署（build+serve）', command: 'pnpm install --prefer-frozen-lockfile && pnpm build && pnpm preview --host 0.0.0.0 --port $PORT' },
    },
    'python': {
      hot: { id: 'dev', label: '开发（reload）', command: 'pip install -r requirements.txt && uvicorn main:app --host 0.0.0.0 --port $PORT --reload' },
      cold: { id: 'cold', label: '冷部署', command: 'pip install -r requirements.txt && uvicorn main:app --host 0.0.0.0 --port $PORT' },
    },
  };

  function fetchProfiles() {
    return fetch('/api/build-profiles?project=' + encodeURIComponent(window.CURRENT_PROJECT_ID || 'default'), { credentials: 'same-origin' })
      .then(function (r) { return r.json(); })
      .then(function (d) { return d.profiles || []; });
  }

  function open() {
    if (modal) return;
    modal = document.createElement('div');
    modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.6);z-index:10000;display:flex;align-items:center;justify-content:center;padding:20px';
    modal.onclick = function (e) { if (e.target === modal) close(); };

    var box = document.createElement('div');
    box.style.cssText = 'background:var(--bg-card);color:var(--text-primary);border:1px solid var(--border-subtle);border-radius:10px;width:min(100%, 760px);max-height:min(100%, 720px);display:flex;flex-direction:column;min-height:0';
    box.onclick = function (e) { e.stopPropagation(); };

    box.innerHTML =
      '<div style="padding:14px 18px;border-bottom:1px solid var(--border-subtle);display:flex;align-items:center;gap:12px;flex-shrink:0">' +
        '<div style="flex:1">' +
          '<div style="font-weight:600;font-size:14px">🔧 全局构建命令</div>' +
          '<div style="color:var(--text-muted);font-size:11px;margin-top:2px">一次填好，批量覆盖所有匹配的 profile · 自动拍快照可回滚</div>' +
        '</div>' +
        '<button id="globalCmdCloseBtn" class="icon-btn sm" title="关闭">✕</button>' +
      '</div>' +
      '<div id="globalCmdBody" style="flex:1;min-height:0;overflow-y:auto;padding:16px 18px"></div>';

    modal.appendChild(box);
    document.body.appendChild(modal);

    box.querySelector('#globalCmdCloseBtn').onclick = close;
    document.addEventListener('keydown', onKeydown);

    render();
  }

  function close() {
    if (modal && modal.parentNode) modal.parentNode.removeChild(modal);
    modal = null;
    document.removeEventListener('keydown', onKeydown);
  }

  function onKeydown(e) { if (e.key === 'Escape') close(); }

  var state = {
    filter: 'dotnet',
    strategy: 'merge',
    modes: [
      { modeId: 'dev', label: '开发（热加载）', command: '' },
      { modeId: 'cold', label: '冷部署', command: '' },
    ],
    profileSelection: null, // { [id]: true } when manually picking
  };

  function render() {
    var body = modal && modal.querySelector('#globalCmdBody');
    if (!body) return;
    body.innerHTML = '<div style="text-align:center;padding:30px;color:var(--text-muted)">加载 profiles…</div>';

    fetchProfiles().then(function (profiles) {
      // 应用预设的初始命令（仅当对应字段还为空时）
      var preset = PRESETS[state.filter];
      if (preset) {
        if (state.modes[0] && !state.modes[0].command) {
          state.modes[0] = { modeId: preset.hot.id, label: preset.hot.label, command: preset.hot.command };
        }
        if (state.modes[1] && !state.modes[1].command) {
          state.modes[1] = { modeId: preset.cold.id, label: preset.cold.label, command: preset.cold.command };
        }
      }

      var matched = profiles.filter(function (p) {
        var img = (p.dockerImage || '').toLowerCase();
        if (state.filter === 'all') return true;
        if (state.filter === 'dotnet') return /dotnet|mcr\.microsoft\.com\/dotnet/i.test(img);
        if (state.filter === 'node') return /node/i.test(img);
        if (state.filter === 'python') return /python/i.test(img);
        if (state.filter === 'manual') return state.profileSelection && state.profileSelection[p.id];
        return false;
      });

      var html = '';
      // 应用范围
      html += '<div style="margin-bottom:12px">' +
        '<div style="font-weight:600;font-size:12px;margin-bottom:6px">应用范围</div>' +
        '<div style="display:flex;gap:6px;flex-wrap:wrap">' +
          ['all', 'dotnet', 'node', 'python', 'manual'].map(function (f) {
            var selected = state.filter === f;
            var label = ({all:'全部 profile', dotnet:'.NET (dotnet)', node:'Node (node)', python:'Python', manual:'手动选择…'})[f];
            return '<button class="settings-btn settings-btn-sm" data-filter="' + f + '" style="' + (selected ? 'background:var(--accent,#3b82f6);color:#fff;border-color:transparent' : '') + '">' + label + '</button>';
          }).join('') +
        '</div>' +
      '</div>';

      // 命中的 profile 列表
      html += '<div style="margin-bottom:14px;padding:8px 10px;background:var(--bg-card);border:1px solid var(--border-subtle);border-radius:6px;font-size:12px">' +
        '<div style="color:var(--text-muted);margin-bottom:4px">命中 ' + matched.length + ' / ' + profiles.length + ' 个 profile：</div>' +
        (state.filter === 'manual' ? renderManualPicker(profiles) : renderMatchedList(matched)) +
      '</div>';

      // 模式编辑
      html += '<div style="font-weight:600;font-size:12px;margin-bottom:6px">模式 = label + 命令</div>';
      state.modes.forEach(function (m, idx) {
        html += '<div data-idx="' + idx + '" style="margin-bottom:10px;padding:10px;border:1px solid var(--border-subtle);border-radius:6px">' +
          '<div style="display:flex;gap:8px;align-items:center;margin-bottom:6px">' +
            '<input class="gc-modeId" type="text" value="' + escapeHtml(m.modeId) + '" placeholder="modeId（dev/cold/...）" style="width:120px;padding:4px 6px;font-family:var(--font-mono,monospace);font-size:11px;border:1px solid var(--border);border-radius:4px;background:var(--bg-input);color:var(--text-primary)">' +
            '<input class="gc-label" type="text" value="' + escapeHtml(m.label) + '" placeholder="显示名（开发 / 冷部署 / ...）" style="flex:1;padding:4px 6px;font-size:12px;border:1px solid var(--border);border-radius:4px;background:var(--bg-input);color:var(--text-primary)">' +
            '<button class="settings-btn settings-btn-sm" data-action="del-mode" data-idx="' + idx + '" style="color:#ef4444">×</button>' +
          '</div>' +
          '<textarea class="gc-cmd" rows="2" placeholder="完整 shell 命令；可用 $PORT" style="width:100%;padding:6px 8px;font-family:var(--font-mono,monospace);font-size:11px;border:1px solid var(--border);border-radius:4px;background:var(--bg-input);color:var(--text-primary);resize:vertical">' + escapeHtml(m.command) + '</textarea>' +
        '</div>';
      });
      html += '<button class="settings-btn settings-btn-sm" data-action="add-mode" style="margin-bottom:14px">+ 新增模式</button>';

      // 写入策略
      html += '<div style="margin-bottom:14px;padding:10px;border:1px solid var(--border-subtle);border-radius:6px">' +
        '<div style="font-weight:600;font-size:12px;margin-bottom:6px">写入策略</div>' +
        '<label style="display:block;margin-bottom:4px;font-size:12px;cursor:pointer">' +
          '<input type="radio" name="gc-strategy" value="merge"' + (state.strategy === 'merge' ? ' checked' : '') + '> ' +
          '<strong>merge</strong> — 同名 mode 替换；profile 已有的其他 mode 保留' +
        '</label>' +
        '<label style="display:block;font-size:12px;cursor:pointer">' +
          '<input type="radio" name="gc-strategy" value="replace"' + (state.strategy === 'replace' ? ' checked' : '') + '> ' +
          '<strong>replace</strong> — 清空该 profile 所有现有 mode，只保留这里定义的' +
        '</label>' +
      '</div>';

      // 操作按钮
      html += '<div style="display:flex;gap:8px;justify-content:flex-end;border-top:1px solid var(--border-subtle);padding-top:10px;margin-top:8px">' +
        '<button class="settings-btn" data-action="cancel">取消</button>' +
        '<button class="settings-btn settings-btn-primary" data-action="apply"' + (matched.length === 0 ? ' disabled' : '') + '>' +
          '应用到 ' + matched.length + ' 个 profile →' +
        '</button>' +
      '</div>';

      body.innerHTML = html;
      bindEvents(body, profiles, matched);
    });
  }

  function renderMatchedList(matched) {
    if (matched.length === 0) {
      return '<div style="color:#f59e0b">⚠ 没有命中的 profile（如果当前项目本来就没有这种类型的服务，可以直接关闭）</div>';
    }
    return matched.map(function (p) {
      return '<div style="padding:2px 0"><strong>' + escapeHtml(p.id) + '</strong> <span style="color:var(--text-muted)">— ' + escapeHtml(p.dockerImage || '') + '</span></div>';
    }).join('');
  }

  function renderManualPicker(profiles) {
    if (!state.profileSelection) state.profileSelection = {};
    return profiles.map(function (p) {
      var checked = state.profileSelection[p.id] ? ' checked' : '';
      return '<label style="display:block;padding:2px 0;cursor:pointer"><input type="checkbox" data-pick="' + escapeHtml(p.id) + '"' + checked + '> <strong>' + escapeHtml(p.id) + '</strong> <span style="color:var(--text-muted)">— ' + escapeHtml(p.dockerImage || '') + '</span></label>';
    }).join('');
  }

  function bindEvents(body, profiles, matched) {
    body.querySelectorAll('[data-filter]').forEach(function (btn) {
      btn.onclick = function () {
        state.filter = btn.dataset.filter;
        // 切换 filter 时清空命令模板，让下次 render() 重新填预设
        state.modes = [
          { modeId: 'dev', label: '开发（热加载）', command: '' },
          { modeId: 'cold', label: '冷部署', command: '' },
        ];
        render();
      };
    });
    body.querySelectorAll('[data-pick]').forEach(function (cb) {
      cb.onchange = function () {
        if (!state.profileSelection) state.profileSelection = {};
        state.profileSelection[cb.dataset.pick] = cb.checked;
        render();
      };
    });
    body.querySelectorAll('[data-action="del-mode"]').forEach(function (btn) {
      btn.onclick = function () {
        var i = parseInt(btn.dataset.idx, 10);
        commitFormToState(body);
        state.modes.splice(i, 1);
        render();
      };
    });
    var addBtn = body.querySelector('[data-action="add-mode"]');
    if (addBtn) addBtn.onclick = function () {
      commitFormToState(body);
      state.modes.push({ modeId: 'mode-' + Math.random().toString(36).slice(2, 6), label: '', command: '' });
      render();
    };
    body.querySelectorAll('input[name="gc-strategy"]').forEach(function (r) {
      r.onchange = function () { state.strategy = r.value; };
    });
    var cancelBtn = body.querySelector('[data-action="cancel"]');
    if (cancelBtn) cancelBtn.onclick = close;
    var applyBtn = body.querySelector('[data-action="apply"]');
    if (applyBtn) applyBtn.onclick = function () {
      commitFormToState(body);
      apply(profiles, matched);
    };
  }

  function commitFormToState(body) {
    body.querySelectorAll('[data-idx]').forEach(function (row) {
      var i = parseInt(row.dataset.idx, 10);
      if (Number.isNaN(i) || i >= state.modes.length) return;
      var modeId = row.querySelector('.gc-modeId');
      var label = row.querySelector('.gc-label');
      var cmd = row.querySelector('.gc-cmd');
      if (modeId && label && cmd) {
        state.modes[i] = {
          modeId: modeId.value.trim(),
          label: label.value.trim(),
          command: cmd.value,
        };
      }
    });
  }

  function apply(profiles, matched) {
    var modesObj = {};
    var bad = false;
    state.modes.forEach(function (m) {
      if (!m.modeId || !m.label || !m.command.trim()) { bad = true; return; }
      modesObj[m.modeId] = { label: m.label, command: m.command };
    });
    if (bad || Object.keys(modesObj).length === 0) {
      alert('每个模式必须填 modeId / 显示名 / 命令，否则会被丢弃。');
      return;
    }
    var body = {
      filter: state.filter === 'manual' ? 'all' : state.filter,
      modes: modesObj,
      strategy: state.strategy,
      profileIds: state.filter === 'manual' ? matched.map(function (p) { return p.id; }) : undefined,
    };
    var summary = '将为 ' + matched.length + ' 个 profile（' + matched.map(function (p) { return p.id; }).join(', ') + '）' +
      '执行「' + state.strategy + '」策略写入 ' + Object.keys(modesObj).length + ' 个模式。\n\n' +
      '执行前会自动拍快照，可在「历史版本 🕐」一键回滚。\n\n继续吗？';
    if (!confirm(summary)) return;

    fetch('/api/build-profiles/bulk-set-modes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(body),
    })
      .then(function (r) { return r.json().then(function (b) { return { ok: r.ok, body: b }; }); })
      .then(function (r) {
        if (!r.ok) throw new Error(r.body.error || '应用失败');
        alert(r.body.message || '已应用');
        close();
      })
      .catch(function (err) { alert('应用失败：' + err.message); });
  }

  window.openGlobalBuildCommandPanel = open;
})();
