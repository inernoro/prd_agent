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
