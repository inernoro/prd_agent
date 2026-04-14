/**
 * settings.js — Project Settings page driver (P4 Part 13).
 *
 * Loads the project metadata via /api/projects/:id, renders the
 * General tab form, persists changes via PUT /api/projects/:id.
 *
 * Tab dispatch is handled here in JS (no server-side routing change
 * needed). Active tab is reflected in the URL hash so deep links
 * to /settings.html?project=X#members work in the future once those
 * tabs land.
 */

(function () {
  'use strict';

  // ── State ──
  var CURRENT_PROJECT_ID = (function () {
    try {
      var p = new URLSearchParams(location.search);
      return p.get('project') || 'default';
    } catch (e) { return 'default'; }
  })();

  var currentProject = null;
  var currentTab = (location.hash || '#general').slice(1) || 'general';

  // ── DOM helpers ──
  var contentEl = document.getElementById('settingsContent');
  var toastEl = document.getElementById('toast');
  var toastTimer = null;

  function showToast(msg) {
    if (!toastEl) return;
    toastEl.textContent = msg;
    toastEl.classList.remove('hidden');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.classList.add('hidden'); }, 3200);
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // ── Data layer ──
  function loadProject() {
    return fetch('/api/projects/' + encodeURIComponent(CURRENT_PROJECT_ID), {
      credentials: 'same-origin',
    })
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      });
  }

  function saveProject(patch) {
    return fetch('/api/projects/' + encodeURIComponent(CURRENT_PROJECT_ID), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(patch),
    })
      .then(function (res) {
        return res.json().then(function (body) { return { status: res.status, body: body }; });
      });
  }

  // ── Tabs ──
  function switchSettingsTab(tab) {
    currentTab = tab;
    location.hash = '#' + tab;
    document.querySelectorAll('.settings-subnav-item').forEach(function (el) {
      el.classList.toggle('active', el.dataset.tab === tab);
    });
    renderActiveTab();
  }
  window.switchSettingsTab = switchSettingsTab;

  function renderActiveTab() {
    if (!currentProject) {
      contentEl.innerHTML = '<div class="settings-placeholder">加载中…</div>';
      return;
    }

    if (currentTab === 'general') {
      renderGeneralTab();
    } else if (currentTab === 'danger') {
      renderDangerTab();
    } else if (currentTab === 'storage') {
      renderStorageTab();
    } else {
      contentEl.innerHTML =
        '<div class="settings-placeholder">' +
          '<div class="settings-placeholder-title">' + escapeHtml(currentTab) + '</div>' +
          '<div class="settings-placeholder-desc">该 tab 将在 P5 / P6 上线</div>' +
        '</div>';
    }
  }

  // ── Tab renderers ──
  function renderGeneralTab() {
    var p = currentProject;
    contentEl.innerHTML =
      '<div class="settings-section">' +
        '<div class="settings-section-title">Project Info</div>' +
        '<div class="settings-field">' +
          '<label class="settings-field-label" for="settingsName">Name</label>' +
          '<input id="settingsName" class="settings-input" type="text" maxlength="60" value="' + escapeHtml(p.name) + '">' +
        '</div>' +
        '<div class="settings-field">' +
          '<label class="settings-field-label" for="settingsDescription">Description</label>' +
          '<input id="settingsDescription" class="settings-input" type="text" maxlength="200" placeholder="Optional description of this project" value="' + escapeHtml(p.description || '') + '">' +
        '</div>' +
        '<div class="settings-field">' +
          '<label class="settings-field-label">Project ID</label>' +
          '<div class="settings-input-group">' +
            '<input class="settings-input mono" type="text" value="' + escapeHtml(p.id) + '" readonly>' +
            '<button type="button" class="settings-copy-btn" title="复制 Project ID" onclick="_settingsCopyId()">' +
              '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M0 6.75C0 5.784.784 5 1.75 5h1.5a.75.75 0 010 1.5h-1.5a.25.25 0 00-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 00.25-.25v-1.5a.75.75 0 011.5 0v1.5A1.75 1.75 0 019.25 16h-7.5A1.75 1.75 0 010 14.25v-7.5z"/><path d="M5 1.75C5 .784 5.784 0 6.75 0h7.5C15.216 0 16 .784 16 1.75v7.5A1.75 1.75 0 0114.25 11h-7.5A1.75 1.75 0 015 9.25v-7.5z"/></svg>' +
            '</button>' +
          '</div>' +
        '</div>' +
        '<div class="settings-field">' +
          '<label class="settings-field-label" for="settingsGitRepoUrl">Git Repository URL</label>' +
          '<input id="settingsGitRepoUrl" class="settings-input mono" type="url" placeholder="https://github.com/your-org/repo.git" value="' + escapeHtml(p.gitRepoUrl || '') + '">' +
        '</div>' +
        '<button type="button" id="settingsSaveBtn" class="settings-btn-primary" onclick="_settingsSave()">Update</button>' +
      '</div>' +

      '<div class="settings-section">' +
        '<div class="settings-section-title">Visibility</div>' +
        '<div class="settings-section-desc">' +
          '该项目当前为 <strong>PRIVATE</strong>。CDS 当前所有项目都是 private（无访客模式）。' +
          '公开访问 + 链接分享将在 P6 上线。' +
        '</div>' +
        '<button type="button" class="settings-btn-outline" disabled>Change visibility</button>' +
      '</div>' +

      '<div class="settings-section">' +
        '<div class="settings-section-title">Project Stats</div>' +
        '<div class="settings-section-desc">来自当前 state.json 的实时数据。</div>' +
        '<div class="tfp-kv"><span class="tfp-kv-key">Branches</span><span class="tfp-kv-val">' + (p.branchCount || 0) + '</span></div>' +
        '<div class="tfp-kv"><span class="tfp-kv-key">Created</span><span class="tfp-kv-val">' + escapeHtml(new Date(p.createdAt).toLocaleString()) + '</span></div>' +
        '<div class="tfp-kv"><span class="tfp-kv-key">Updated</span><span class="tfp-kv-val">' + escapeHtml(new Date(p.updatedAt).toLocaleString()) + '</span></div>' +
        (p.dockerNetwork ? '<div class="tfp-kv"><span class="tfp-kv-key">Docker network</span><span class="tfp-kv-val">' + escapeHtml(p.dockerNetwork) + '</span></div>' : '') +
        (p.legacyFlag ? '<div class="tfp-kv"><span class="tfp-kv-key">Legacy flag</span><span class="tfp-kv-val">true (cannot be deleted)</span></div>' : '') +
      '</div>';
  }

  // P4 Part 18 (D.3): Storage backend tab.
  //
  // This is a GLOBAL / system-wide setting, not project-scoped — but
  // we mount it inside the project settings page because that's where
  // operators expect to configure the running CDS. A banner at the
  // top of the tab makes the scope explicit.
  //
  // Flow:
  //   1. GET /api/storage-mode on tab render → fill current status
  //   2. Form: mongo URI + db name inputs
  //   3. "Test connection" button → POST /test-mongo
  //   4. "Switch to mongo" button → POST /switch-to-mongo
  //      (disabled until test passes)
  //   5. "Revert to JSON" button shown only when currently on mongo
  function renderStorageTab() {
    contentEl.innerHTML =
      '<div class="settings-section">' +
        '<div class="settings-section-title">Storage Backend</div>' +
        '<div class="settings-section-desc">' +
          '这是 <strong>系统级</strong> 设置（不是项目级）。所有项目共用同一个 CDS state 存储后端。<br>' +
          'JSON 模式 = 本地 <code>state.json</code>；Mongo 模式 = 独立 MongoDB 实例。' +
          '切换不会丢数据：CDS 会将当前 state 一次性导入目标后端。' +
        '</div>' +
        '<div id="storageModeStatus" class="settings-placeholder">加载存储状态…</div>' +
      '</div>' +
      '<div class="settings-section" id="storageModeFormSection" style="display:none">' +
        '<div class="settings-section-title">MongoDB 连接</div>' +
        '<div class="settings-section-desc">' +
          '填入 mongo URI 和数据库名。点"测试连接"通过后才能切换。<br>' +
          '⚠ 切换是<strong>运行时热切换</strong>，下次进程重启需要同步设置 <code>CDS_STORAGE_MODE=mongo</code> + <code>CDS_MONGO_URI</code> 到 .cds.env，否则会回到当前 env 指定的模式。' +
        '</div>' +
        '<div class="settings-field">' +
          '<label class="settings-field-label" for="storageMongoUri">Mongo URI</label>' +
          '<input id="storageMongoUri" class="settings-input mono" type="text" placeholder="mongodb://admin:password@localhost:27017" autocomplete="off">' +
        '</div>' +
        '<div class="settings-field">' +
          '<label class="settings-field-label" for="storageMongoDb">Database Name</label>' +
          '<input id="storageMongoDb" class="settings-input mono" type="text" placeholder="cds_state_db" value="cds_state_db" autocomplete="off">' +
        '</div>' +
        '<div id="storageTestResult" class="settings-section-desc" style="min-height:20px"></div>' +
        '<button type="button" id="storageTestBtn" class="settings-btn-outline" onclick="_storageTest()" style="margin-right:8px">' +
          '测试连接' +
        '</button>' +
        '<button type="button" id="storageSwitchMongoBtn" class="settings-btn-primary" onclick="_storageSwitchToMongo()" disabled>' +
          '切换到 Mongo' +
        '</button>' +
      '</div>' +
      '<div class="settings-section" id="storageRevertSection" style="display:none">' +
        '<div class="settings-section-title">回滚到 JSON</div>' +
        '<div class="settings-section-desc">' +
          '将当前存储从 Mongo 切回本地 state.json。CDS 会先将最新状态写入 state.json，然后关闭 mongo 连接。' +
          '<br>建议在切回前先用 mongo 客户端手动备份 <code>cds_state</code> 集合。' +
        '</div>' +
        '<button type="button" id="storageRevertBtn" class="settings-btn-outline settings-btn-danger" onclick="_storageRevertToJson()">' +
          '切回 JSON 模式' +
        '</button>' +
      '</div>';

    // Fetch current state and render the status block
    fetch('/api/storage-mode', { credentials: 'same-origin' })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        var statusEl = document.getElementById('storageModeStatus');
        if (!statusEl) return;

        var modeLabel = {
          json: 'JSON (本地 state.json)',
          mongo: 'MongoDB',
          'auto-fallback-json': 'JSON (auto 模式下 mongo 不可达，已降级)',
        }[data.mode] || data.mode;

        var healthBadge = '';
        if (data.kind === 'mongo') {
          healthBadge = data.mongoHealthy
            ? '<span class="cds-clone-status ready" style="margin-left:8px">HEALTHY</span>'
            : '<span class="cds-clone-status error" style="margin-left:8px">UNREACHABLE</span>';
        }

        statusEl.className = 'settings-placeholder';
        statusEl.style.textAlign = 'left';
        statusEl.style.padding = '18px';
        statusEl.innerHTML =
          '<div style="font-size:13px;color:var(--text-primary);margin-bottom:10px">' +
            '<strong>当前后端:</strong> ' + escapeHtml(modeLabel) + healthBadge +
          '</div>' +
          (data.kind === 'mongo' ? (
            '<div class="tfp-kv"><span class="tfp-kv-key">URI</span><span class="tfp-kv-val">' + escapeHtml(data.mongoUri || '-') + '</span></div>' +
            '<div class="tfp-kv"><span class="tfp-kv-key">Database</span><span class="tfp-kv-val">' + escapeHtml(data.mongoDb || '-') + '</span></div>'
          ) : (
            '<div style="font-size:11px;color:var(--text-muted)">' +
              '当前使用本地 state.json 作为 CDS 全局状态存储。切换到 Mongo 后，多进程 CDS 实例可以共享同一份 state。' +
            '</div>'
          ));

        // Show the form section only when NOT already on mongo
        var formSec = document.getElementById('storageModeFormSection');
        if (formSec) formSec.style.display = data.mode === 'mongo' ? 'none' : 'block';

        // Show the revert section only when ON mongo
        var revertSec = document.getElementById('storageRevertSection');
        if (revertSec) revertSec.style.display = data.mode === 'mongo' ? 'block' : 'none';
      })
      .catch(function (err) {
        var statusEl = document.getElementById('storageModeStatus');
        if (statusEl) {
          statusEl.innerHTML = '<span style="color:var(--red)">加载失败：' + escapeHtml(err && err.message ? err.message : String(err)) + '</span>';
        }
      });
  }

  // Test a candidate mongo URI — delegates to POST /test-mongo.
  // On success, flips the "Switch to Mongo" button from disabled → enabled.
  window._storageTest = function () {
    var uri = (document.getElementById('storageMongoUri') || {}).value || '';
    var db = (document.getElementById('storageMongoDb') || {}).value || 'cds_state_db';
    var resultEl = document.getElementById('storageTestResult');
    var testBtn = document.getElementById('storageTestBtn');
    var switchBtn = document.getElementById('storageSwitchMongoBtn');

    if (!uri.trim()) {
      if (resultEl) resultEl.innerHTML = '<span style="color:var(--red)">URI 不能为空</span>';
      return;
    }
    if (resultEl) resultEl.innerHTML = '正在测试…';
    if (testBtn) testBtn.disabled = true;

    fetch('/api/storage-mode/test-mongo', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ uri: uri.trim(), databaseName: db.trim() }),
    })
      .then(function (r) { return r.json(); })
      .then(function (body) {
        if (body.ok) {
          if (resultEl) {
            resultEl.innerHTML = '<span style="color:var(--green)">✅ 连接成功 (' + body.ms + ' ms)</span>';
          }
          if (switchBtn) switchBtn.disabled = false;
        } else {
          if (resultEl) {
            resultEl.innerHTML = '<span style="color:var(--red)">❌ 连接失败：' + escapeHtml(body.message || '未知错误') + '</span>';
          }
          if (switchBtn) switchBtn.disabled = true;
        }
      })
      .catch(function (err) {
        if (resultEl) {
          resultEl.innerHTML = '<span style="color:var(--red)">❌ 网络错误：' + escapeHtml(err && err.message ? err.message : String(err)) + '</span>';
        }
      })
      .finally(function () {
        if (testBtn) testBtn.disabled = false;
      });
  };

  window._storageSwitchToMongo = function () {
    var uri = (document.getElementById('storageMongoUri') || {}).value || '';
    var db = (document.getElementById('storageMongoDb') || {}).value || 'cds_state_db';
    if (!uri.trim()) {
      showToast('请先填入 URI');
      return;
    }
    if (!window.confirm(
      '确定将存储后端从 JSON 切换到 Mongo 吗？\n\n' +
      '当前 state 会被一次性导入到 ' + db + '。\n' +
      '切换后 state.json 会保留在本地作为冷备。'
    )) return;

    var btn = document.getElementById('storageSwitchMongoBtn');
    if (btn) { btn.disabled = true; btn.textContent = '切换中…'; }

    fetch('/api/storage-mode/switch-to-mongo', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ uri: uri.trim(), databaseName: db.trim() }),
    })
      .then(function (r) {
        return r.json().then(function (body) { return { status: r.status, body: body }; });
      })
      .then(function (result) {
        if (result.status === 200 && result.body.ok) {
          showToast(result.body.message || '已切换到 Mongo');
          // Re-render the tab to reflect the new state
          renderStorageTab();
        } else {
          showToast((result.body && result.body.message) || ('切换失败 (HTTP ' + result.status + ')'));
          if (btn) { btn.disabled = false; btn.textContent = '切换到 Mongo'; }
        }
      })
      .catch(function (err) {
        showToast('网络错误：' + (err && err.message ? err.message : err));
        if (btn) { btn.disabled = false; btn.textContent = '切换到 Mongo'; }
      });
  };

  window._storageRevertToJson = function () {
    if (!window.confirm(
      '确定从 Mongo 切回 JSON 模式吗？\n\n' +
      '当前 state 会被写入 state.json，Mongo 连接会被关闭。\n' +
      'Mongo 的 cds_state 集合不会被删除（可手动清理）。'
    )) return;

    var btn = document.getElementById('storageRevertBtn');
    if (btn) { btn.disabled = true; btn.textContent = '切换中…'; }

    fetch('/api/storage-mode/switch-to-json', {
      method: 'POST',
      credentials: 'same-origin',
    })
      .then(function (r) {
        return r.json().then(function (body) { return { status: r.status, body: body }; });
      })
      .then(function (result) {
        if (result.status === 200 && result.body.ok) {
          showToast(result.body.message || '已切回 JSON');
          renderStorageTab();
        } else {
          showToast((result.body && result.body.message) || ('切换失败 (HTTP ' + result.status + ')'));
          if (btn) { btn.disabled = false; btn.textContent = '切回 JSON 模式'; }
        }
      })
      .catch(function (err) {
        showToast('网络错误：' + (err && err.message ? err.message : err));
        if (btn) { btn.disabled = false; btn.textContent = '切回 JSON 模式'; }
      });
  };

  function renderDangerTab() {
    var p = currentProject;
    var canDelete = !p.legacyFlag;
    contentEl.innerHTML =
      '<div class="settings-section">' +
        '<div class="settings-section-title" style="color:var(--red,#f43f5e)">Danger Zone</div>' +
        '<div class="settings-section-desc">这些操作不可撤销。请谨慎。</div>' +
        '<div style="background:var(--bg-card);border:1px solid rgba(244,63,94,0.3);border-radius:10px;padding:18px">' +
          '<div style="font-weight:700;color:var(--text-primary);margin-bottom:6px">删除项目</div>' +
          '<div style="font-size:12px;color:var(--text-muted);margin-bottom:14px;line-height:1.6">' +
            (canDelete
              ? '永久删除本项目。Docker 网络 <code>' + escapeHtml(p.dockerNetwork || '-') + '</code> 会被一起移除。该操作不可撤销。'
              : '⚠ 默认项目（legacy）不可删除。它是 v3.2 时代所有数据的归属，删除会让现有分支/配置全部成为孤儿。')
          + '</div>' +
          '<button type="button" class="settings-btn-outline settings-btn-danger" ' + (canDelete ? '' : 'disabled') + ' onclick="_settingsDelete()">Delete this project</button>' +
        '</div>' +
      '</div>';
  }

  // ── Form actions (exposed on window) ──
  window._settingsCopyId = function () {
    if (!currentProject) return;
    if (navigator.clipboard) {
      navigator.clipboard.writeText(currentProject.id).then(function () {
        showToast('Project ID 已复制');
      });
    } else {
      showToast(currentProject.id);
    }
  };

  window._settingsSave = function () {
    if (!currentProject) return;
    var btn = document.getElementById('settingsSaveBtn');
    var name = document.getElementById('settingsName').value.trim();
    var description = document.getElementById('settingsDescription').value.trim();
    var gitRepoUrl = document.getElementById('settingsGitRepoUrl').value.trim();
    if (!name) {
      showToast('项目名称不能为空');
      return;
    }
    if (btn) { btn.disabled = true; btn.textContent = '保存中…'; }
    saveProject({ name: name, description: description, gitRepoUrl: gitRepoUrl })
      .then(function (result) {
        if (result.status === 200) {
          currentProject = result.body.project;
          showToast('已保存');
          // Refresh the breadcrumb name
          var nameEl = document.getElementById('breadcrumbProjectName');
          if (nameEl) nameEl.textContent = currentProject.name;
        } else {
          showToast((result.body && result.body.message) || ('保存失败 (HTTP ' + result.status + ')'));
        }
      })
      .catch(function (err) {
        showToast('网络错误：' + (err && err.message ? err.message : err));
      })
      .finally(function () {
        if (btn) { btn.disabled = false; btn.textContent = 'Update'; }
      });
  };

  window._settingsDelete = function () {
    if (!currentProject || currentProject.legacyFlag) return;
    var ok = window.confirm(
      '确定要永久删除项目 “' + currentProject.name + '” 吗？\n\n' +
      'Docker 网络会被一起移除，且不可撤销。'
    );
    if (!ok) return;

    fetch('/api/projects/' + encodeURIComponent(currentProject.id), {
      method: 'DELETE',
      credentials: 'same-origin',
    })
      .then(function (res) {
        if (res.status === 204 || res.status === 200) {
          showToast('项目已删除，正在跳回项目列表…');
          setTimeout(function () { location.href = 'projects.html'; }, 800);
        } else {
          return res.json().then(function (body) {
            showToast((body && body.message) || ('删除失败 (HTTP ' + res.status + ')'));
          });
        }
      })
      .catch(function (err) {
        showToast('网络错误：' + (err && err.message ? err.message : err));
      });
  };

  // ── Wire leftnav links to current project's topology / list / logs ──
  var topologyLink = document.getElementById('leftnavTopology');
  if (topologyLink) topologyLink.href = 'index.html?project=' + encodeURIComponent(CURRENT_PROJECT_ID);
  var logsLink = document.getElementById('leftnavLogs');
  if (logsLink) logsLink.href = 'index.html?project=' + encodeURIComponent(CURRENT_PROJECT_ID);

  // ── Init ──
  loadProject()
    .then(function (p) {
      currentProject = p;
      var nameEl = document.getElementById('breadcrumbProjectName');
      if (nameEl) nameEl.textContent = p.name;
      // Apply hash-based tab
      var initialTab = (location.hash || '#general').slice(1) || 'general';
      switchSettingsTab(initialTab);
    })
    .catch(function (err) {
      contentEl.innerHTML =
        '<div class="settings-placeholder" style="color:var(--red)">' +
          '<div class="settings-placeholder-title">加载项目失败</div>' +
          '<div class="settings-placeholder-desc">' + escapeHtml(err && err.message ? err.message : String(err)) + '</div>' +
        '</div>';
    });
})();
