/**
 * 历史版本 & 紧急还原面板
 *
 * 一个 modal 两个 tab：
 *   - 配置历史：列出 ConfigSnapshot，每条带「回滚」按钮
 *   - 最近操作：列出 DestructiveOperationLog，30 分钟内可「撤销」
 *
 * 用户故事：用户导入了污染配置 → 打开面板 → 看到"导入前"快照 → 点回滚 → 秒复原。
 *          用户不小心点了 replace-all 导入 → 打开面板 → 看到"最近操作" → 点撤销。
 */
(function () {
  var modal = null;
  var currentTab = 'snapshots';

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function humanSize(b) {
    if (b == null) return '—';
    if (b < 1024) return b + ' B';
    if (b < 1024 * 1024) return (b / 1024).toFixed(1) + ' KB';
    return (b / 1024 / 1024).toFixed(1) + ' MB';
  }

  function triggerLabel(t) {
    return {
      'pre-import': '导入前',
      'pre-destructive': '破坏性操作前',
      'manual': '手动保存',
      'scheduled': '定时备份',
    }[t] || t;
  }

  function triggerColor(t) {
    return {
      'pre-import': '#3b82f6',
      'pre-destructive': '#ef4444',
      'manual': '#22c55e',
      'scheduled': '#a855f7',
    }[t] || '#999';
  }

  function opTypeLabel(t) {
    return {
      'import-replace-all': 'replace-all 导入',
      'factory-reset': '恢复出厂',
      'delete-project': '删除项目',
      'purge-branch': '清空分支',
      'purge-database': '清空数据库',
      'other': '其他',
    }[t] || t;
  }

  function renderSnapshots(body) {
    body.innerHTML = '<div style="padding:40px;text-align:center;color:var(--text-muted)">加载中…</div>';
    fetch('/api/config-snapshots', { credentials: 'same-origin' })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        var list = data.snapshots || [];
        if (list.length === 0) {
          body.innerHTML = '<div style="padding:40px;text-align:center;color:var(--text-muted)">' +
            '<div style="font-size:40px;margin-bottom:10px">📦</div>' +
            '还没有配置快照。<br>下次 <code>POST /import-config</code> 时会自动拍一份，' +
            '也可以 <button id="snapshotManualBtn" class="settings-btn settings-btn-sm" style="margin-top:8px">手动保存当前配置</button>' +
          '</div>';
          var btn = document.getElementById('snapshotManualBtn');
          if (btn) btn.onclick = manualSave;
          return;
        }
        var html = '<div style="padding:12px 16px;display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid var(--border-subtle)">' +
          '<span style="color:var(--text-muted);font-size:12px">' + list.length + ' 条 · 保留最近 ' + (data.limit || 30) + ' 条</span>' +
          '<button id="snapshotManualBtn" class="settings-btn settings-btn-sm">💾 手动保存当前配置</button>' +
        '</div>';
        list.forEach(function (s) {
          var color = triggerColor(s.trigger);
          html += '<div style="padding:12px 16px;border-bottom:1px solid var(--border-subtle);display:flex;gap:12px;align-items:flex-start">' +
            '<div style="flex:1;min-width:0">' +
              '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:4px">' +
                '<span style="padding:2px 8px;background:' + color + '22;color:' + color + ';font-size:11px;border-radius:4px;font-weight:600">' + triggerLabel(s.trigger) + '</span>' +
                '<span style="font-weight:600">' + escapeHtml(s.label) + '</span>' +
              '</div>' +
              '<div style="color:var(--text-muted);font-size:12px">' +
                escapeHtml(new Date(s.createdAt).toLocaleString('zh-CN')) + ' · ' +
                humanSize(s.sizeBytes) + ' · ' +
                s.counts.buildProfiles + ' profile · ' +
                s.counts.infraServices + ' infra · ' +
                s.counts.routingRules + ' 规则 · ' +
                s.counts.envVarScopes + ' env scope' +
              '</div>' +
            '</div>' +
            '<div style="display:flex;gap:6px;flex-shrink:0">' +
              '<button class="settings-btn settings-btn-sm" onclick="window._snapshotView(\'' + escapeHtml(s.id) + '\')">查看</button>' +
              '<button class="settings-btn settings-btn-sm" onclick="window._snapshotRollback(\'' + escapeHtml(s.id) + '\', \'' + escapeHtml(s.label.replace(/\\/g, '\\\\').replace(/'/g, "\\'")) + '\')" style="color:#3b82f6">↩ 回滚</button>' +
              '<button class="settings-btn settings-btn-sm" onclick="window._snapshotDelete(\'' + escapeHtml(s.id) + '\')" style="color:#ef4444">✕</button>' +
            '</div>' +
          '</div>';
        });
        body.innerHTML = html;
        var mbtn = document.getElementById('snapshotManualBtn');
        if (mbtn) mbtn.onclick = manualSave;
      })
      .catch(function (err) {
        body.innerHTML = '<div style="padding:20px;color:#ef4444">加载快照列表失败：' + escapeHtml(err.message) + '</div>';
      });
  }

  function renderDestructiveOps(body) {
    body.innerHTML = '<div style="padding:40px;text-align:center;color:var(--text-muted)">加载中…</div>';
    fetch('/api/destructive-ops', { credentials: 'same-origin' })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        var ops = data.ops || [];
        if (ops.length === 0) {
          body.innerHTML = '<div style="padding:40px;text-align:center;color:var(--text-muted)">' +
            '<div style="font-size:40px;margin-bottom:10px">🛡</div>' +
            '暂无破坏性操作记录。<br>这里会出现：replace-all 导入、清空分支、清空数据库、恢复出厂、删除项目等操作。' +
          '</div>';
          return;
        }
        var html = '<div style="padding:12px 16px;color:var(--text-muted);font-size:12px;border-bottom:1px solid var(--border-subtle)">' +
          ops.length + ' 条 · 30 分钟内可撤销' +
        '</div>';
        ops.forEach(function (op) {
          var age = Date.now() - new Date(op.at).getTime();
          var ageMin = Math.floor(age / 60000);
          var ageStr = ageMin < 1 ? '刚刚' : (ageMin < 60 ? ageMin + ' 分钟前' : Math.floor(ageMin / 60) + ' 小时前');
          var done = op.undoneAt ? ' (已撤销)' : '';
          html += '<div style="padding:12px 16px;border-bottom:1px solid var(--border-subtle);display:flex;gap:12px;align-items:flex-start' + (op.undoneAt ? ';opacity:0.5' : '') + '">' +
            '<div style="flex:1;min-width:0">' +
              '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:4px">' +
                '<span style="padding:2px 8px;background:#ef444422;color:#ef4444;font-size:11px;border-radius:4px;font-weight:600">' + opTypeLabel(op.type) + '</span>' +
                '<span style="font-weight:600">' + escapeHtml(op.summary) + escapeHtml(done) + '</span>' +
              '</div>' +
              '<div style="color:var(--text-muted);font-size:12px">' +
                escapeHtml(ageStr) + ' · ' + escapeHtml(new Date(op.at).toLocaleString('zh-CN')) +
                (op.triggeredBy ? ' · by ' + escapeHtml(op.triggeredBy) : '') +
                (op.snapshotId ? ' · 📦 已关联快照' : ' · <span style="color:#f59e0b">⚠ 无快照</span>') +
              '</div>' +
            '</div>' +
            '<div style="flex-shrink:0">' +
              (op.canUndo
                ? '<button class="settings-btn settings-btn-sm" onclick="window._opUndo(\'' + escapeHtml(op.id) + '\')" style="color:#3b82f6">↩ 撤销</button>'
                : '<span style="color:var(--text-muted);font-size:11px">已过期</span>'
              ) +
            '</div>' +
          '</div>';
        });
        body.innerHTML = html;
      })
      .catch(function (err) {
        body.innerHTML = '<div style="padding:20px;color:#ef4444">加载失败：' + escapeHtml(err.message) + '</div>';
      });
  }

  function manualSave() {
    var label = prompt('给这份快照起个名字（可选）：', '手动保存 · ' + new Date().toLocaleString('zh-CN'));
    if (label === null) return;
    fetch('/api/config-snapshots', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ label: label.trim() || undefined }),
    })
      .then(function (r) { return r.json().then(function (b) { return { ok: r.ok, body: b }; }); })
      .then(function (r) {
        if (!r.ok) throw new Error(r.body.error || '保存失败');
        renderActive();
      })
      .catch(function (err) { alert('保存失败：' + err.message); });
  }

  window._snapshotView = function (id) {
    fetch('/api/config-snapshots/' + encodeURIComponent(id), { credentials: 'same-origin' })
      .then(function (r) { return r.json(); })
      .then(function (s) {
        var w = window.open('', '_blank');
        w.document.write('<pre style="padding:20px;font-family:monospace;white-space:pre-wrap;word-break:break-all">' +
          escapeHtml(JSON.stringify(s, null, 2)) + '</pre>');
      });
  };

  window._snapshotRollback = function (id, label) {
    if (!confirm('回滚到「' + label + '」？\n\n这会用该快照覆盖当前的 buildProfiles / envVars / infraServices / routingRules。\n回滚前会自动再拍一份当前状态，便于再改回来。\n\n分支和数据库不会被触碰。')) return;
    fetch('/api/config-snapshots/' + encodeURIComponent(id) + '/rollback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: '{}',
    })
      .then(function (r) { return r.json().then(function (b) { return { ok: r.ok, body: b }; }); })
      .then(function (r) {
        if (!r.ok) throw new Error(r.body.error || '回滚失败');
        alert(r.body.message || '回滚完成');
        renderActive();
      })
      .catch(function (err) { alert('回滚失败：' + err.message); });
  };

  window._snapshotDelete = function (id) {
    if (!confirm('删除这份快照？此操作不可撤销。')) return;
    fetch('/api/config-snapshots/' + encodeURIComponent(id), {
      method: 'DELETE',
      credentials: 'same-origin',
    })
      .then(function (r) { return r.json().then(function (b) { return { ok: r.ok, body: b }; }); })
      .then(function (r) {
        if (!r.ok) throw new Error(r.body.error || '删除失败');
        renderActive();
      })
      .catch(function (err) { alert('删除失败：' + err.message); });
  };

  window._opUndo = function (id) {
    if (!confirm('撤销这次破坏性操作？\n\n会通过回滚对应快照把配置恢复到操作前的状态。')) return;
    fetch('/api/destructive-ops/' + encodeURIComponent(id) + '/undo', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: '{}',
    })
      .then(function (r) { return r.json().then(function (b) { return { ok: r.ok, body: b }; }); })
      .then(function (r) {
        if (!r.ok) throw new Error(r.body.error || '撤销失败');
        alert(r.body.message || '撤销成功');
        renderActive();
      })
      .catch(function (err) { alert('撤销失败：' + err.message); });
  };

  function renderActive() {
    if (!modal) return;
    var body = modal.querySelector('#historyBody');
    if (!body) return;
    if (currentTab === 'snapshots') renderSnapshots(body);
    else renderDestructiveOps(body);
  }

  function setTab(tab) {
    currentTab = tab;
    if (!modal) return;
    modal.querySelectorAll('.history-tab').forEach(function (el) {
      var on = el.dataset.tab === tab;
      el.style.borderBottomColor = on ? 'var(--accent, #3b82f6)' : 'transparent';
      el.style.color = on ? 'var(--text-primary)' : 'var(--text-muted)';
    });
    renderActive();
  }

  function openModal() {
    if (modal) return;
    modal = document.createElement('div');
    modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.6);z-index:10000;display:flex;align-items:center;justify-content:center;padding:20px';
    modal.onclick = function (e) { if (e.target === modal) closeModal(); };

    var box = document.createElement('div');
    box.style.cssText = 'background:var(--bg-card);color:var(--text-primary);border:1px solid var(--border-subtle);border-radius:10px;width:min(100%, 880px);height:min(100%, 680px);display:flex;flex-direction:column;min-height:0';
    box.onclick = function (e) { e.stopPropagation(); };

    box.innerHTML =
      '<div style="padding:12px 18px;border-bottom:1px solid var(--border-subtle);display:flex;gap:16px;align-items:center;flex-shrink:0">' +
        '<div style="font-weight:600;font-size:14px">🕐 历史版本 & 紧急还原</div>' +
        '<button class="history-tab" data-tab="snapshots" style="background:none;border:none;border-bottom:2px solid transparent;padding:8px 4px;cursor:pointer;color:var(--text-primary);font-size:13px">配置历史</button>' +
        '<button class="history-tab" data-tab="ops" style="background:none;border:none;border-bottom:2px solid transparent;padding:8px 4px;cursor:pointer;color:var(--text-muted);font-size:13px">最近破坏性操作</button>' +
        '<div style="flex:1"></div>' +
        '<button id="historyCloseBtn" class="icon-btn sm" title="关闭">✕</button>' +
      '</div>' +
      '<div id="historyBody" style="flex:1;min-height:0;overflow-y:auto"></div>';

    modal.appendChild(box);
    document.body.appendChild(modal);

    box.querySelector('#historyCloseBtn').onclick = closeModal;
    modal.querySelectorAll('.history-tab').forEach(function (el) {
      el.onclick = function () { setTab(el.dataset.tab); };
    });

    setTab(currentTab);
    document.addEventListener('keydown', onKeydown);
  }

  function onKeydown(e) { if (e.key === 'Escape') closeModal(); }

  function closeModal() {
    if (modal && modal.parentNode) modal.parentNode.removeChild(modal);
    modal = null;
    document.removeEventListener('keydown', onKeydown);
  }

  window.openHistoryModal = openModal;
  window.closeHistoryModal = closeModal;
  // 顶部菜单 "历史/撤销" 直接切到 ops tab
  window.openHistoryModalOnOps = function () { currentTab = 'ops'; openModal(); };
})();
