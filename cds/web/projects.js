/**
 * projects.js — multi-project landing page.
 *
 * P1 shipped a read-only grid of one hard-coded card.
 * P4 Part 1 switched the grid to read /api/projects for real data.
 * P4 Part 2 (this file) wires up:
 *   - "+ New Project" button → opens a create modal → POST /api/projects
 *   - Per-card delete button → DELETE /api/projects/:id (with confirm)
 *   - Inline error display inside the modal on validation / docker failures
 *
 * The dashboard lives at /index.html (legacy CDS UI) and has no awareness
 * of the enclosing projectId yet; that changes in P4 Part 3 when all
 * existing resources get projectId-scoped.
 */

(function () {
  'use strict';

  var gridEl = document.getElementById('projectsGrid');
  var toastEl = document.getElementById('toast');
  var toastTimer = null;

  function showToast(message) {
    if (!toastEl) return;
    toastEl.textContent = message;
    toastEl.classList.remove('hidden');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      toastEl.classList.add('hidden');
    }, 3200);
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function formatRelative(iso) {
    if (!iso) return '-';
    var then = new Date(iso).getTime();
    if (isNaN(then)) return '-';
    var diff = (Date.now() - then) / 1000;
    if (diff < 60) return '刚刚';
    if (diff < 3600) return Math.floor(diff / 60) + ' 分钟前';
    if (diff < 86400) return Math.floor(diff / 3600) + ' 小时前';
    if (diff < 2592000) return Math.floor(diff / 86400) + ' 天前';
    return new Date(iso).toLocaleDateString();
  }

  function renderCard(p) {
    var href = 'index.html?project=' + encodeURIComponent(p.id);
    // Delete button appears on non-legacy projects only. The legacy
    // project is the anchor for pre-P4 data and cannot be removed.
    var deleteBtn = p.legacyFlag
      ? ''
      : '<button class="project-card-delete" title="删除项目" onclick="handleDeleteProject(event, ' +
        '\'' + escapeHtml(p.id) + '\', \'' + escapeHtml(p.name) + '\')">' +
        '<svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M11 1.75V3h2.25a.75.75 0 010 1.5H2.75a.75.75 0 010-1.5H5V1.75C5 .784 5.784 0 6.75 0h2.5C10.216 0 11 .784 11 1.75zM4.496 6.675l.66 6.6a.25.25 0 00.249.225h5.19a.25.25 0 00.249-.225l.66-6.6a.75.75 0 111.492.149l-.66 6.6A1.748 1.748 0 0110.595 15h-5.19a1.75 1.75 0 01-1.741-1.575l-.66-6.6a.75.75 0 111.492-.15z"/></svg>' +
        '</button>';

    return [
      '<div class="project-card-wrap" style="position:relative">',
      '  <a class="project-card" href="', href, '">',
      '    <div class="project-card-header">',
      '      <h2 class="project-card-title">', escapeHtml(p.name), '</h2>',
      '      ', (p.legacyFlag ? '<span class="project-card-badge">Legacy</span>' : ''),
      '    </div>',
      '    <div class="project-card-desc">', escapeHtml(p.description || ''), '</div>',
      '    <div class="project-card-stats">',
      '      <span><strong>', p.branchCount || 0, '</strong> 分支</span>',
      '      <span>更新于 ', formatRelative(p.updatedAt), '</span>',
      '    </div>',
      '  </a>',
      '  ', deleteBtn,
      '</div>',
    ].join('');
  }

  function renderError(message) {
    gridEl.innerHTML = '<div class="projects-error">' + escapeHtml(message) + '</div>';
  }

  function renderEmpty() {
    gridEl.innerHTML = [
      '<div class="projects-empty">',
      '  <p style="margin-bottom:12px;font-size:14px">还没有任何项目</p>',
      '  <p>点击右上角 <strong>New Project</strong> 创建第一个项目。</p>',
      '</div>',
    ].join('');
  }

  function loadProjects() {
    fetch('/api/projects', {
      method: 'GET',
      headers: { Accept: 'application/json' },
      credentials: 'same-origin',
    })
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + res.statusText);
        return res.json();
      })
      .then(function (data) {
        var projects = (data && data.projects) || [];
        if (!projects.length) {
          renderEmpty();
          return;
        }
        // The legacy project (if present) sorts first so the user always
        // sees the pre-P4 data at a stable position.
        projects.sort(function (a, b) {
          if (a.legacyFlag && !b.legacyFlag) return -1;
          if (!a.legacyFlag && b.legacyFlag) return 1;
          return 0;
        });
        gridEl.innerHTML = projects.map(renderCard).join('');
      })
      .catch(function (err) {
        // eslint-disable-next-line no-console
        console.error('[projects.js] failed to load projects:', err);
        renderError('加载项目列表失败：' + (err && err.message ? err.message : err));
      });
  }

  // ── Create-project modal helpers ─────────────────────────────────────

  function getModal() {
    return document.getElementById('createProjectModal');
  }

  function openCreateProjectModal() {
    var modal = getModal();
    if (!modal) return;
    // Clear previous state
    var form = document.getElementById('createProjectForm');
    if (form) form.reset();
    var err = document.getElementById('createProjectError');
    if (err) err.textContent = '';
    modal.classList.add('visible');
    // Focus the first field
    setTimeout(function () {
      var first = document.getElementById('cp-name');
      if (first) first.focus();
    }, 50);
  }

  // Close only if the click was on the backdrop (event target equals the
  // modal element itself, not the dialog inside it). Called on ESC too.
  function closeCreateProjectModal(event) {
    var modal = getModal();
    if (!modal) return;
    if (event && event.currentTarget !== event.target) return;
    modal.classList.remove('visible');
  }

  function setSubmitBusy(busy) {
    var btn = document.getElementById('createProjectSubmitBtn');
    if (!btn) return;
    btn.disabled = busy;
    btn.textContent = busy ? '创建中…' : '创建';
  }

  function handleCreateProjectSubmit(event) {
    event.preventDefault();

    var nameEl = document.getElementById('cp-name');
    var slugEl = document.getElementById('cp-slug');
    var gitEl = document.getElementById('cp-gitRepoUrl');
    var descEl = document.getElementById('cp-description');
    var errEl = document.getElementById('createProjectError');

    errEl.textContent = '';

    var payload = {
      name: nameEl.value.trim(),
      slug: slugEl.value.trim() || undefined,
      gitRepoUrl: gitEl.value.trim() || undefined,
      description: descEl.value.trim() || undefined,
    };
    if (!payload.name) {
      errEl.textContent = '请填写项目名称';
      return;
    }

    setSubmitBusy(true);
    fetch('/api/projects', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      credentials: 'same-origin',
      body: JSON.stringify(payload),
    })
      .then(function (res) {
        return res.json().then(function (body) {
          return { status: res.status, body: body };
        });
      })
      .then(function (result) {
        if (result.status === 201) {
          // Success — close modal, toast, refresh list.
          closeCreateProjectModal({ currentTarget: getModal(), target: getModal() });
          showToast('项目 “' + payload.name + '” 已创建');
          loadProjects();
        } else {
          // Error — show inline message. Server returns structured errors
          // so we can surface specific field issues.
          var msg =
            (result.body && result.body.message) ||
            ('创建失败 (HTTP ' + result.status + ')');
          errEl.textContent = msg;
        }
      })
      .catch(function (err) {
        errEl.textContent = '网络错误：' + (err && err.message ? err.message : err);
      })
      .finally(function () {
        setSubmitBusy(false);
      });
  }

  // ── Delete project ──────────────────────────────────────────────────

  function handleDeleteProject(event, projectId, projectName) {
    event.preventDefault();
    event.stopPropagation();

    var ok = window.confirm(
      '确定要删除项目 “' + projectName + '” 吗？\n\n' +
      '此操作会删除其 Docker 网络，且不可撤销。',
    );
    if (!ok) return;

    fetch('/api/projects/' + encodeURIComponent(projectId), {
      method: 'DELETE',
      credentials: 'same-origin',
    })
      .then(function (res) {
        if (res.status === 204) {
          showToast('项目已删除');
          loadProjects();
          return;
        }
        return res.json().then(function (body) {
          var msg = (body && body.message) || ('删除失败 (HTTP ' + res.status + ')');
          showToast(msg);
        });
      })
      .catch(function (err) {
        showToast('网络错误：' + (err && err.message ? err.message : err));
      });
  }

  // Expose the handlers the inline HTML event handlers reference.
  window.handleNewProject = openCreateProjectModal;
  window.closeCreateProjectModal = closeCreateProjectModal;
  window.handleCreateProjectSubmit = handleCreateProjectSubmit;
  window.handleDeleteProject = handleDeleteProject;

  // ESC key closes the modal.
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') {
      var modal = getModal();
      if (modal && modal.classList.contains('visible')) {
        modal.classList.remove('visible');
      }
    }
  });

  loadProjects();
})();
