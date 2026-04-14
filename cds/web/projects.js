/**
 * projects.js — Railway-inspired landing page driver.
 *
 * Fetches /api/projects for the card list, then for each project makes
 * one extra round of /api/build-profiles?project=<id> and
 * /api/infra?project=<id> to fill in the service icon strip on each
 * card. Also drives the create-project modal (POST /api/projects) and
 * per-card delete (DELETE /api/projects/:id).
 *
 * The UX goal is to match the visual density of Railway's project
 * list without copying any proprietary assets:
 *   - each card shows a small dotted canvas with icon tiles
 *   - service icons are picked from Simple Icons / Lucide via inline
 *     SVG so the page works without external CDN dependencies
 *   - legacy "default" project is always pinned first and marked with
 *     a Legacy badge so users know it's not deletable.
 */

(function () {
  'use strict';

  var gridEl = document.getElementById('projectsGrid');
  var toastEl = document.getElementById('toast');
  var projectCountEl = document.getElementById('projectCount');
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

  // ── Service icon registry ─────────────────────────────────────────
  //
  // Maps a rough service "kind" (detected from infra id or profile
  // docker image) to an inline brand SVG. Added organically as users
  // request: if your docker image contains any of the keys, you get
  // the corresponding icon. Fallback is a generic cube.
  //
  // Icon sources: Simple Icons CC0 glyphs, hand-tweaked to fit a 22×22
  // viewBox. No external CDN — everything inlined so the page works
  // offline and without auth probes.
  var ICONS = {
    mongodb: {
      color: '#10aa50',
      svg: '<path d="M12 2.25C9.32 4.79 7.9 8.17 8.14 11.73c.22 3.19 1.53 5.83 3.45 7.76.26.26.66.28.94.05 1.96-1.59 3.22-4.05 3.34-6.85.16-3.62-1.24-7.17-3.87-10.44z"/>',
    },
    redis: {
      color: '#dc382d',
      svg: '<path d="M12 2.2c4.6 0 8.3 1.5 8.3 3.4s-3.7 3.4-8.3 3.4S3.7 7.5 3.7 5.6 7.4 2.2 12 2.2zm0 7.5c4.6 0 8.3 1.5 8.3 3.4s-3.7 3.4-8.3 3.4-8.3-1.5-8.3-3.4 3.7-3.4 8.3-3.4zm0 7.5c4.6 0 8.3 1.5 8.3 3.4S16.6 24 12 24s-8.3-1.5-8.3-3.4 3.7-3.4 8.3-3.4z"/>',
    },
    postgres: {
      color: '#336791',
      svg: '<path d="M12 2C7 2 4 5 4 10c0 5 3 10 6 11 1 .3 2 0 2-1 0-1-1-1-1-2 0-4 2-6 5-7 2-.7 3-2 3-4s-1-5-7-5z"/>',
    },
    mysql: {
      color: '#00546b',
      svg: '<path d="M4 6v12l4-2V8l4 2v8l4-2V6l-4 2V4z"/>',
    },
    node: {
      color: '#539e43',
      svg: '<path d="M12 2 3 7v10l9 5 9-5V7zm0 2.3 6.9 3.85L12 12 5.1 8.15zM5 10l6 3.35V20l-6-3.35zm14 0v6.65L13 20v-6.65z"/>',
    },
    dotnet: {
      color: '#512bd4',
      svg: '<path d="M3 3h5l6 8V3h4v18h-5l-6-8v8H3z"/>',
    },
    python: {
      color: '#3776ab',
      svg: '<path d="M9 2c-2 0-3 1-3 3v2h6v1H4c-1 0-2 1-2 3v4c0 2 1 3 3 3h2v-3c0-1 1-2 3-2h4c1 0 2-1 2-2V5c0-1-1-3-3-3zm1 2a1 1 0 110 2 1 1 0 010-2zm5 6h1c2 0 3 1 3 3v4c0 2-1 3-3 3h-6v-1h6c1 0 2-1 2-2v-1h-6c-1 0-2-1-2-2v-2c0-2 1-3 3-3zm-2 8a1 1 0 110 2 1 1 0 010-2z"/>',
    },
    nginx: {
      color: '#009639',
      svg: '<path d="M12 2 3 7v10l9 5 9-5V7zM8 9l6 8H8z"/>',
    },
    git: {
      color: '#f05032',
      svg: '<path d="M22.6 11.4 12.6 1.4c-.6-.6-1.5-.6-2.1 0L8.3 3.7l2.9 2.9a1.7 1.7 0 012.2 2.2l2.8 2.8a1.7 1.7 0 11-1 1l-2.6-2.6v6.9a1.7 1.7 0 11-1.4 0V9.9a1.7 1.7 0 01-.9-2.2L7.3 4.8 1.4 10.7c-.6.6-.6 1.5 0 2.1l10 10c.6.6 1.5.6 2.1 0l9.1-9.1c.6-.6.6-1.6 0-2.3z"/>',
    },
    github: {
      color: '#ffffff',
      svg: '<path d="M12 2C6.5 2 2 6.6 2 12.3c0 4.5 2.9 8.3 6.8 9.7.5.1.7-.2.7-.5v-1.7c-2.8.6-3.4-1.4-3.4-1.4-.4-1.2-1.1-1.5-1.1-1.5-.9-.6.1-.6.1-.6 1 .1 1.5 1.1 1.5 1.1.9 1.6 2.4 1.1 3 .9.1-.7.4-1.1.6-1.4-2.2-.3-4.6-1.1-4.6-5 0-1.1.4-2 1-2.7-.1-.3-.4-1.3.1-2.7 0 0 .8-.3 2.7 1 .8-.2 1.6-.3 2.5-.3s1.7.1 2.5.3c1.9-1.3 2.7-1 2.7-1 .5 1.4.2 2.4.1 2.7.6.7 1 1.6 1 2.7 0 3.9-2.3 4.7-4.6 5 .4.3.7.9.7 1.9v2.8c0 .3.2.6.7.5 3.9-1.4 6.8-5.2 6.8-9.7C22 6.6 17.5 2 12 2z"/>',
    },
    docker: {
      color: '#2496ed',
      svg: '<path d="M22 9h-3v3h-2V6h-2v6h-2V6h-2v6H9V6H7v6H5V9H2v3c0 5 3 9 10 9 6 0 9-4 10-9z"/>',
    },
    rabbitmq: {
      color: '#ff6600',
      svg: '<path d="M21 13h-6V7h-2v6h-2V7H9v6H4V5h-2v16h18c1 0 2-1 2-2v-6c0-.6-.4-1-1-1z"/>',
    },
    elasticsearch: {
      color: '#005571',
      svg: '<path d="M3 7c0-2 2-4 4-4h10c2 0 4 2 4 4s-2 4-4 4H7c-2 0-4-2-4-4zm0 10c0-2 2-4 4-4h10c2 0 4 2 4 4s-2 4-4 4H7c-2 0-4-2-4-4z"/>',
    },
    fallback: {
      color: '#71717a',
      svg: '<path d="M12 2 3 7v10l9 5 9-5V7zm-2 10.5-5-2.9V7.1l5 2.9zm2-5.2L7 4.4 12 1.6l5 2.8zm7 2.3-5 2.9V9.9l5-2.9z"/>',
    },
  };

  /**
   * Pick an icon key based on a service's name / dockerImage / kind.
   * Order matches most-specific-first so `node` doesn't shadow
   * `node-exporter` etc. Returns the key into ICONS.
   */
  function detectIcon(label) {
    var s = (label || '').toLowerCase();
    if (!s) return 'fallback';
    if (s.indexOf('mongo') >= 0) return 'mongodb';
    if (s.indexOf('redis') >= 0) return 'redis';
    if (s.indexOf('postgres') >= 0 || s.indexOf('pgsql') >= 0 || s.indexOf('pg-') >= 0) return 'postgres';
    if (s.indexOf('mysql') >= 0 || s.indexOf('mariadb') >= 0) return 'mysql';
    if (s.indexOf('rabbitmq') >= 0) return 'rabbitmq';
    if (s.indexOf('elasticsearch') >= 0) return 'elasticsearch';
    if (s.indexOf('nginx') >= 0) return 'nginx';
    if (s.indexOf('dotnet') >= 0 || s.indexOf('aspnet') >= 0) return 'dotnet';
    if (s.indexOf('python') >= 0) return 'python';
    if (s.indexOf('node') >= 0 || s.indexOf('npm') >= 0 || s.indexOf('pnpm') >= 0) return 'node';
    if (s.indexOf('docker') >= 0) return 'docker';
    return 'fallback';
  }

  function renderIconSvg(key) {
    var i = ICONS[key] || ICONS.fallback;
    return (
      '<svg viewBox="0 0 24 24" fill="' + i.color + '" xmlns="http://www.w3.org/2000/svg">' +
      i.svg +
      '</svg>'
    );
  }

  // ── Card rendering ────────────────────────────────────────────────

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

  function renderServiceStrip(project, services) {
    // services: { profiles: [...], infra: [...] }
    // We union them, dedupe by icon key, show up to 4 tiles and a "+N"
    // badge if there are more.
    var items = [];
    (services.profiles || []).forEach(function (p) {
      items.push({ key: detectIcon(p.dockerImage || p.name || p.id), label: p.name || p.id });
    });
    (services.infra || []).forEach(function (i) {
      items.push({ key: detectIcon(i.dockerImage || i.name || i.id), label: i.name || i.id });
    });

    if (items.length === 0) {
      return '<div class="cds-service-empty">尚未配置服务</div>';
    }

    // Dedupe by icon key preserving first occurrence
    var seen = {};
    var unique = [];
    for (var i = 0; i < items.length; i++) {
      if (!seen[items[i].key]) {
        seen[items[i].key] = true;
        unique.push(items[i]);
      }
    }

    var visible = unique.slice(0, 4);
    var overflow = unique.length - visible.length;

    var tiles = visible
      .map(function (it) {
        return (
          '<div class="cds-service-tile" title="' + escapeHtml(it.label) + '">' +
          renderIconSvg(it.key) +
          '</div>'
        );
      })
      .join('');
    if (overflow > 0) {
      tiles += '<div class="cds-service-tile more">+' + overflow + '</div>';
    }
    return tiles;
  }

  function renderCard(project, services) {
    var href = 'index.html?project=' + encodeURIComponent(project.id);
    var deleteBtn = project.legacyFlag
      ? ''
      : '<button class="cds-project-card-delete" title="删除项目" onclick="handleDeleteProject(event, ' +
        "'" + escapeHtml(project.id) + "', '" + escapeHtml(project.name) + "')\">" +
        '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M11 1.75V3h2.25a.75.75 0 010 1.5H2.75a.75.75 0 010-1.5H5V1.75C5 .784 5.784 0 6.75 0h2.5C10.216 0 11 .784 11 1.75zM4.496 6.675l.66 6.6a.25.25 0 00.249.225h5.19a.25.25 0 00.249-.225l.66-6.6a.75.75 0 111.492.149l-.66 6.6A1.748 1.748 0 0110.595 15h-5.19a1.75 1.75 0 01-1.741-1.575l-.66-6.6a.75.75 0 111.492-.15z"/></svg>' +
        '</button>';

    var totalServices =
      ((services && services.profiles && services.profiles.length) || 0) +
      ((services && services.infra && services.infra.length) || 0);
    var onlineCount = project.legacyFlag && services && services.profiles
      ? services.profiles.filter(function () { return true; }).length
      : 0;
    var envLabel = project.legacyFlag ? 'production' : 'production';

    return [
      '<a class="cds-project-card" href="', href, '">',
      '  <div class="cds-project-card-head">',
      '    <div class="cds-project-card-title">', escapeHtml(project.name), '</div>',
      '    ', (project.legacyFlag ? '<span class="cds-legacy-badge">Legacy</span>' : ''),
      '  </div>',
      '  <div class="cds-service-strip">', renderServiceStrip(project, services || {}), '</div>',
      '  <div class="cds-project-card-foot">',
      '    <span class="cds-env-dot">', envLabel, '</span>',
      '    <span class="cds-service-count"><strong>', totalServices, '</strong> service', totalServices === 1 ? '' : 's', '</span>',
      '  </div>',
      '  ', deleteBtn,
      '</a>',
    ].join('');
  }

  function renderError(message) {
    gridEl.innerHTML = '<div class="cds-grid-state error">' + escapeHtml(message) + '</div>';
  }

  function renderEmpty() {
    gridEl.innerHTML = [
      '<div class="cds-grid-state">',
      '  <p style="margin-bottom:12px;font-size:14px"><strong>还没有任何项目</strong></p>',
      '  <p>点击右上角 <strong>New</strong> 按钮创建第一个项目。</p>',
      '</div>',
    ].join('');
  }

  // Fetch services (profiles + infra) for a given project. Returns
  // { profiles, infra } arrays. Silent on network error — we just
  // render an empty strip.
  function fetchServicesFor(projectId) {
    var p = encodeURIComponent(projectId);
    return Promise.all([
      fetch('/api/build-profiles?project=' + p, { credentials: 'same-origin' })
        .then(function (r) { return r.ok ? r.json() : { profiles: [] }; })
        .catch(function () { return { profiles: [] }; }),
      fetch('/api/infra?project=' + p, { credentials: 'same-origin' })
        .then(function (r) { return r.ok ? r.json() : { services: [] }; })
        .catch(function () { return { services: [] }; }),
    ]).then(function (results) {
      return {
        profiles: (results[0] && results[0].profiles) || [],
        infra: (results[1] && results[1].services) || [],
      };
    });
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
        if (projectCountEl) projectCountEl.textContent = projects.length;

        if (!projects.length) {
          renderEmpty();
          return;
        }

        // Legacy project sorts first for stable top position.
        projects.sort(function (a, b) {
          if (a.legacyFlag && !b.legacyFlag) return -1;
          if (!a.legacyFlag && b.legacyFlag) return 1;
          return 0;
        });

        // Render initial card skeletons (no service strip yet) so the
        // user sees content instantly, then fetch services in parallel
        // and re-render each card as its data lands.
        gridEl.innerHTML = projects
          .map(function (p) { return renderCard(p, null); })
          .join('');

        // Enhance each card with real service icons.
        projects.forEach(function (p, idx) {
          fetchServicesFor(p.id).then(function (services) {
            // Replace just this card's outer HTML in-place.
            var cards = gridEl.querySelectorAll('.cds-project-card');
            if (cards[idx]) {
              var wrapper = document.createElement('div');
              wrapper.innerHTML = renderCard(p, services);
              if (wrapper.firstElementChild) {
                cards[idx].outerHTML = wrapper.firstElementChild.outerHTML;
              }
            }
          });
        });
      })
      .catch(function (err) {
        console.error('[projects.js] failed to load projects:', err);
        renderError('加载项目列表失败：' + (err && err.message ? err.message : err));
      });
  }

  // ── User / workspace bootstrap ────────────────────────────────────

  function bootstrapMeLabel() {
    fetch('/api/me', { credentials: 'same-origin', cache: 'no-store' })
      .then(function (res) { return res.ok ? res.json() : null; })
      .catch(function () { return null; })
      .then(function (body) {
        if (!body || !body.user) return;
        var user = body.user;
        var nameEl = document.getElementById('userName');
        var avatarEl = document.getElementById('userAvatar');
        if (nameEl) nameEl.textContent = user.githubLogin || user.name || '登录用户';
        if (avatarEl) {
          if (user.avatarUrl) {
            avatarEl.innerHTML =
              '<img src="' + user.avatarUrl.replace(/"/g, '') + '" alt="">';
          } else {
            avatarEl.textContent = (user.githubLogin || '?').charAt(0).toUpperCase();
          }
        }
      });
  }

  // ── Create-project modal ───────────────────────────────────────────

  function getModal() { return document.getElementById('createProjectModal'); }

  function openCreateProjectModal() {
    var modal = getModal();
    if (!modal) return;
    var form = document.getElementById('createProjectForm');
    if (form) form.reset();
    var err = document.getElementById('createProjectError');
    if (err) err.textContent = '';
    modal.classList.add('visible');
    setTimeout(function () {
      var first = document.getElementById('cp-name');
      if (first) first.focus();
    }, 50);
  }

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
        return res.json().then(function (body) { return { status: res.status, body: body }; });
      })
      .then(function (result) {
        if (result.status === 201) {
          closeCreateProjectModal({ currentTarget: getModal(), target: getModal() });
          showToast('项目 “' + payload.name + '” 已创建');
          loadProjects();
        } else {
          var msg = (result.body && result.body.message) || ('创建失败 (HTTP ' + result.status + ')');
          errEl.textContent = msg;
        }
      })
      .catch(function (err) {
        errEl.textContent = '网络错误：' + (err && err.message ? err.message : err);
      })
      .finally(function () { setSubmitBusy(false); });
  }

  // ── Delete project ────────────────────────────────────────────────

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
        if (res.status === 204 || res.status === 200) {
          showToast('项目已删除');
          loadProjects();
          return;
        }
        return res.json().then(function (body) {
          showToast((body && body.message) || ('删除失败 (HTTP ' + res.status + ')'));
        });
      })
      .catch(function (err) {
        showToast('网络错误：' + (err && err.message ? err.message : err));
      });
  }

  // Expose handlers referenced by inline HTML.
  window.handleNewProject = openCreateProjectModal;
  window.closeCreateProjectModal = closeCreateProjectModal;
  window.handleCreateProjectSubmit = handleCreateProjectSubmit;
  window.handleDeleteProject = handleDeleteProject;

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') {
      var modal = getModal();
      if (modal && modal.classList.contains('visible')) {
        modal.classList.remove('visible');
      }
    }
  });

  loadProjects();
  bootstrapMeLabel();
})();
