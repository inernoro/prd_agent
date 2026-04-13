/**
 * projects.js — P1 multi-project shell landing page.
 *
 * Fetches /api/projects, renders a grid of project cards, and navigates
 * into the legacy dashboard when a card is clicked. The dashboard lives
 * at /index.html and has no awareness of the enclosing projectId yet;
 * that changes in P4 when real multi-project filtering lands.
 *
 * See doc/design.cds-multi-project.md and doc/plan.cds-multi-project-phases.md.
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
    // The dashboard currently ignores project context; `/index.html` loads
    // the legacy state.json directly. We still pass `?project=<id>` so that
    // when P4 wires up project-aware routing, the URL already carries the
    // information.
    var href = 'index.html?project=' + encodeURIComponent(p.id);
    return [
      '<a class="project-card" href="', href, '">',
      '  <div class="project-card-header">',
      '    <h2 class="project-card-title">', escapeHtml(p.name), '</h2>',
      '    ', (p.legacyFlag ? '<span class="project-card-badge">Legacy</span>' : ''),
      '  </div>',
      '  <div class="project-card-desc">', escapeHtml(p.description || ''), '</div>',
      '  <div class="project-card-stats">',
      '    <span><strong>', p.branchCount || 0, '</strong> 分支</span>',
      '    <span>更新于 ', formatRelative(p.updatedAt), '</span>',
      '  </div>',
      '</a>',
    ].join('');
  }

  function renderError(message) {
    gridEl.innerHTML = '<div class="projects-error">' + escapeHtml(message) + '</div>';
  }

  function renderEmpty() {
    gridEl.innerHTML = [
      '<div class="projects-empty">',
      '  <p style="margin-bottom:12px;font-size:14px">还没有任何项目</p>',
      '  <p>P4 上线后即可点击 <strong>New Project</strong> 创建第一个项目。</p>',
      '</div>',
    ].join('');
  }

  function loadProjects() {
    // Minimal fetch — auth cookie is sent automatically if present.
    fetch('/api/projects', {
      method: 'GET',
      headers: { 'Accept': 'application/json' },
      credentials: 'same-origin',
    })
      .then(function (res) {
        if (!res.ok) {
          throw new Error('HTTP ' + res.status + ' ' + res.statusText);
        }
        return res.json();
      })
      .then(function (data) {
        var projects = (data && data.projects) || [];
        if (!projects.length) {
          renderEmpty();
          return;
        }
        gridEl.innerHTML = projects.map(renderCard).join('');
      })
      .catch(function (err) {
        // eslint-disable-next-line no-console
        console.error('[projects.js] failed to load projects:', err);
        renderError('加载项目列表失败：' + (err && err.message ? err.message : err));
      });
  }

  // Exposed so the inline onclick in projects.html can trigger the toast.
  window.handleNewProject = function () {
    showToast('创建新项目将在 P4 上线 · 现阶段仅展示默认项目');
  };

  // Kick off load on DOMContentLoaded (script is placed before </body>, so
  // the grid element is already parsed when this executes).
  loadProjects();
})();
