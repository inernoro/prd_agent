/**
 * cds-settings.js — CDS 系统设置页驱动（2026-04-27 新建）
 *
 * 与 settings.js（项目设置）严格区分：
 *   - settings.js     → 项目级，必带 ?project=<id>
 *   - cds-settings.js → 系统级，无项目语境
 *
 * 边界由 .claude/rules/scope-naming.md 锁定，永远禁止互相串。
 *
 * 7 个 tab：
 *   overview     概览（CDS 版本/模式/节点数/登录用户）
 *   auth         登录与认证（CDS_USERNAME/PASSWORD、GitHub OAuth）
 *   github       GitHub 集成（GitHub App 状态 + webhook）
 *   storage      存储后端（CDS_STORAGE_MODE 切换）
 *   cluster      集群（拓扑、issue-token、connect/disconnect）
 *   global-vars  CDS 全局变量（_global.customEnv，跨项目共享）
 *   maintenance  维护（自更新、镜像加速、标签名、孤儿清理、恢复出厂）
 *
 * Step D 阶段会把 app.js / projects.js 现散落的系统级 modal 搬过来填充。
 * 当前先骨架 + 占位 + tab 切换，已落地的部分（自更新、孤儿清理）可直接复用
 * project-list.html 已加载的同款 modal 函数（self-update.js / projects.js
 * 提供）。Tab 内容采用「点击按钮触发既有弹窗」的最小集成方式，避免
 * 重复实现。
 */
(function () {
  'use strict';

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
  window.escapeHtml = window.escapeHtml || escapeHtml;

  // ── Tabs ──
  var currentTab = (location.hash || '#overview').slice(1) || 'overview';

  function switchCdsTab(tab) {
    currentTab = tab;
    location.hash = '#' + tab;
    document.querySelectorAll('.settings-subnav-item').forEach(function (el) {
      el.classList.toggle('active', el.dataset.tab === tab);
    });
    renderActiveTab();
  }
  window.switchCdsTab = switchCdsTab;

  function renderActiveTab() {
    var renderers = {
      'overview': renderOverviewTab,
      'auth': renderAuthTab,
      'github': renderGithubTab,
      'storage': renderStorageTab,
      'cluster': renderClusterTab,
      'global-vars': renderGlobalVarsTab,
      'maintenance': renderMaintenanceTab,
    };
    var fn = renderers[currentTab] || renderOverviewTab;
    fn();
  }

  // ── 概览 ──
  function renderOverviewTab() {
    contentEl.innerHTML =
      '<div class="settings-section">' +
        '<h2 class="settings-section-title">概览</h2>' +
        '<p class="settings-section-desc">本 CDS 实例的运行状态。</p>' +
        '<div id="cdsOverviewBody"><div class="settings-placeholder">加载中…</div></div>' +
      '</div>';
    fetch('/api/me', { credentials: 'same-origin' })
      .then(function (r) { return r.json().then(function (b) { return { ok: r.ok, body: b }; }); })
      .then(function (me) {
        return fetch('/api/connections', { credentials: 'same-origin' })
          .then(function (r) { return r.json().then(function (b) { return { ok: r.ok, body: b }; }); })
          .then(function (cluster) { return { me: me, cluster: cluster }; });
      })
      .then(function (data) {
        var meBody = (data.me && data.me.body) || {};
        var clusterBody = (data.cluster && data.cluster.body) || {};
        var nodes = Array.isArray(clusterBody.nodes) ? clusterBody.nodes : [];
        var html =
          '<div class="settings-field">' +
            '<div class="settings-field-label">登录用户</div>' +
            '<div>' + escapeHtml(meBody.username || meBody.login || '未登录') + '</div>' +
          '</div>' +
          '<div class="settings-field">' +
            '<div class="settings-field-label">运行模式</div>' +
            '<div>' + escapeHtml(meBody.cdsMode || '—') + '</div>' +
          '</div>' +
          '<div class="settings-field">' +
            '<div class="settings-field-label">集群节点</div>' +
            '<div>' + nodes.length + ' 个节点</div>' +
          '</div>';
        document.getElementById('cdsOverviewBody').innerHTML = html;
      })
      .catch(function (err) {
        document.getElementById('cdsOverviewBody').innerHTML =
          '<div style="color:var(--red)">加载失败：' + escapeHtml(err.message) + '</div>';
      });
  }

  // ── 登录与认证 ──（占位，Step D 填充）
  function renderAuthTab() {
    contentEl.innerHTML =
      '<div class="settings-section">' +
        '<h2 class="settings-section-title">登录与认证</h2>' +
        '<p class="settings-section-desc">' +
          'CDS Dashboard 自身的登录账号与 GitHub OAuth 配置。这些值在 <code>cds/.cds.env</code> 文件中，修改后需要 <code>./exec_cds.sh restart</code>。' +
        '</p>' +
        '<div class="settings-placeholder">' +
          '<div class="settings-placeholder-title">敬请期待</div>' +
          '<div class="settings-placeholder-desc">' +
            '当前请通过 SSH 修改 cds/.cds.env 的 CDS_USERNAME / CDS_PASSWORD / CDS_GITHUB_CLIENT_ID 等变量，再执行 ./exec_cds.sh restart 生效。' +
          '</div>' +
        '</div>' +
      '</div>';
  }

  // ── GitHub 集成 ──（占位，Step D 填充）
  function renderGithubTab() {
    contentEl.innerHTML =
      '<div class="settings-section">' +
        '<h2 class="settings-section-title">GitHub 集成</h2>' +
        '<p class="settings-section-desc">CDS GitHub App 配置（webhook + check-run）。</p>' +
        '<div id="cdsGithubBody"><div class="settings-placeholder">加载中…</div></div>' +
      '</div>';
    fetch('/api/github/app', { credentials: 'same-origin' })
      .then(function (r) { return r.json().then(function (b) { return { ok: r.ok, body: b }; }); })
      .then(function (resp) {
        var b = resp.body || {};
        if (!resp.ok || !b.configured) {
          document.getElementById('cdsGithubBody').innerHTML =
            '<div class="settings-placeholder">' +
              '<div class="settings-placeholder-title">未配置 GitHub App</div>' +
              '<div class="settings-placeholder-desc">' +
                '在 cds/.cds.env 设置 CDS_GITHUB_APP_ID / CDS_GITHUB_APP_PRIVATE_KEY / CDS_GITHUB_WEBHOOK_SECRET 后 restart。详见 doc/guide.cds-cluster-setup.md。' +
              '</div>' +
            '</div>';
          return;
        }
        var html =
          '<div class="settings-field">' +
            '<div class="settings-field-label">App Slug</div>' +
            '<div>' + escapeHtml(b.appSlug || '—') + '</div>' +
          '</div>' +
          '<div class="settings-field">' +
            '<div class="settings-field-label">Webhook 地址（GitHub App 配置时填这个）</div>' +
            '<div class="settings-input-group">' +
              '<input class="settings-input mono" readonly value="' + escapeHtml(b.webhookUrl || '') + '">' +
              '<button class="settings-copy-btn" onclick="navigator.clipboard.writeText(\'' + escapeHtml(b.webhookUrl || '') + '\').then(function(){window.cdsToast&&cdsToast(\'已复制\')})">复制</button>' +
            '</div>' +
          '</div>';
        document.getElementById('cdsGithubBody').innerHTML = html;
      })
      .catch(function (err) {
        document.getElementById('cdsGithubBody').innerHTML =
          '<div style="color:var(--red)">加载失败：' + escapeHtml(err.message) + '</div>';
      });
  }
  window.cdsToast = showToast;

  // ── 存储后端 ──（占位，Step D 填充）
  function renderStorageTab() {
    contentEl.innerHTML =
      '<div class="settings-section">' +
        '<h2 class="settings-section-title">存储后端</h2>' +
        '<p class="settings-section-desc">' +
          'CDS 实例的状态存储模式（json / mongo），影响整个实例。修改前请确保已备份。' +
        '</p>' +
        '<div id="cdsStorageBody"><div class="settings-placeholder">加载中…</div></div>' +
      '</div>';
    fetch('/api/storage-mode', { credentials: 'same-origin' })
      .then(function (r) { return r.json().then(function (b) { return { ok: r.ok, body: b }; }); })
      .then(function (resp) {
        var b = resp.body || {};
        var mode = b.mode || 'json';
        document.getElementById('cdsStorageBody').innerHTML =
          '<div class="settings-field">' +
            '<div class="settings-field-label">当前模式</div>' +
            '<div><code>' + escapeHtml(mode) + '</code></div>' +
          '</div>' +
          '<div class="settings-field">' +
            '<div class="settings-field-label">说明</div>' +
            '<div style="font-size:12px;color:var(--text-secondary);line-height:1.6">' +
              'json：state 文件存于 ' + escapeHtml(b.jsonPath || '<repo>/.cds/state.json') + '<br>' +
              'mongo：state 存于 MongoDB（CDS_MONGO_URI / CDS_MONGO_DB）<br>' +
              '切换在 cds/.cds.env 修改 CDS_STORAGE_MODE 后 ./exec_cds.sh restart。' +
            '</div>' +
          '</div>';
      })
      .catch(function (err) {
        document.getElementById('cdsStorageBody').innerHTML =
          '<div style="color:var(--red)">加载失败：' + escapeHtml(err.message) + '</div>';
      });
  }

  // ── 集群 ──（占位，Step D 填充）
  function renderClusterTab() {
    contentEl.innerHTML =
      '<div class="settings-section">' +
        '<h2 class="settings-section-title">集群</h2>' +
        '<p class="settings-section-desc">CDS 集群拓扑、节点连接管理。</p>' +
        '<div id="cdsClusterBody"><div class="settings-placeholder">加载中…</div></div>' +
      '</div>';
    fetch('/api/connections', { credentials: 'same-origin' })
      .then(function (r) { return r.json().then(function (b) { return { ok: r.ok, body: b }; }); })
      .then(function (resp) {
        var b = resp.body || {};
        var nodes = Array.isArray(b.nodes) ? b.nodes : [];
        var rows = nodes.length === 0
          ? '<div class="settings-placeholder">' +
              '<div class="settings-placeholder-title">单机模式</div>' +
              '<div class="settings-placeholder-desc">未加入集群。要扩容请在另一台机器执行 ./exec_cds.sh connect &lt;主URL&gt; &lt;token&gt;。本机签发 token：./exec_cds.sh issue-token</div>' +
            '</div>'
          : nodes.map(function (n) {
              return '<div class="settings-field" style="display:flex;justify-content:space-between;align-items:center">' +
                '<div><strong>' + escapeHtml(n.id || '?') + '</strong> · ' + escapeHtml(n.host || '?') + '</div>' +
                '<div style="font-size:11px;color:var(--text-muted)">' + escapeHtml(n.role || '') + ' · ' + escapeHtml(n.status || '') + '</div>' +
              '</div>';
            }).join('');
        document.getElementById('cdsClusterBody').innerHTML = rows;
      })
      .catch(function (err) {
        document.getElementById('cdsClusterBody').innerHTML =
          '<div style="color:var(--red)">加载失败：' + escapeHtml(err.message) + '</div>';
      });
  }

  // ── CDS 全局变量 ──（_global.customEnv，跨项目共享）
  function renderGlobalVarsTab() {
    contentEl.innerHTML =
      '<div class="settings-section">' +
        '<h2 class="settings-section-title">CDS 全局变量</h2>' +
        '<p class="settings-section-desc">' +
          '所有项目共享的环境变量（<code>_global</code> scope）。CDS 自身也读其中的 legacy 名（JWT_SECRET / PREVIEW_DOMAIN 等）配置自身。<br>' +
          '<strong>注意</strong>：项目独有的变量请在<a href="/project-list" style="color:var(--accent)">项目列表</a>选择项目后从「项目设置 → 项目环境变量」配置，不要塞这里。' +
        '</p>' +
        '<div id="cdsGlobalVarsBody"><div class="settings-placeholder">加载中…</div></div>' +
      '</div>';
    fetch('/api/env?scope=_global', { credentials: 'same-origin' })
      .then(function (r) { return r.json().then(function (b) { return { ok: r.ok, body: b }; }); })
      .then(function (resp) {
        var env = (resp.body && resp.body.env) || {};
        var keys = Object.keys(env).sort();
        if (keys.length === 0) {
          document.getElementById('cdsGlobalVarsBody').innerHTML =
            '<div class="settings-placeholder">' +
              '<div class="settings-placeholder-title">没有全局变量</div>' +
              '<div class="settings-placeholder-desc">如需添加跨项目共享变量，进入分支列表页 → 环境变量弹窗 → 全局 tab。</div>' +
            '</div>';
          return;
        }
        var html = '<div style="margin-bottom:8px;font-size:12px;color:var(--text-secondary)">共 ' + keys.length + ' 个变量：</div>' +
          '<ul style="list-style:none;padding:0;margin:0;font-family:var(--font-mono,monospace);font-size:12px">' +
          keys.map(function (k) {
            var v = env[k] || '';
            var masked = /password|secret|token|key|pat/i.test(k) && v.length > 4
              ? '****' + v.slice(-4)
              : v;
            return '<li style="padding:6px 10px;border-bottom:1px solid var(--border-light);display:flex;justify-content:space-between;gap:12px">' +
              '<code style="color:var(--text-primary);font-weight:600">' + escapeHtml(k) + '</code>' +
              '<code style="color:var(--text-secondary);text-align:right">' + escapeHtml(masked) + '</code>' +
            '</li>';
          }).join('') +
          '</ul>' +
          '<p style="margin-top:14px;font-size:12px;color:var(--text-muted)">编辑请到<a href="/" style="color:var(--accent)">分支列表页</a>右侧 ⚙ 菜单 → 环境变量 → 全局 tab。</p>';
        document.getElementById('cdsGlobalVarsBody').innerHTML = html;
      })
      .catch(function (err) {
        document.getElementById('cdsGlobalVarsBody').innerHTML =
          '<div style="color:var(--red)">加载失败：' + escapeHtml(err.message) + '</div>';
      });
  }

  // ── 维护 ──（占位，Step D 填充）
  function renderMaintenanceTab() {
    contentEl.innerHTML =
      '<div class="settings-section">' +
        '<h2 class="settings-section-title">维护</h2>' +
        '<p class="settings-section-desc">CDS 实例级维护操作。</p>' +
        '<div class="settings-field">' +
          '<button class="settings-btn-outline" onclick="window.openSelfUpdate ? window.openSelfUpdate() : window.location.href=\'/\'">CDS 自动更新</button>' +
          '<div style="font-size:12px;color:var(--text-muted);margin-top:6px">检查并应用最新代码（git pull + 重启）</div>' +
        '</div>' +
        '<div class="settings-field">' +
          '<div class="settings-field-label">镜像加速</div>' +
          '<div id="cdsMirrorState" style="font-size:13px">加载中…</div>' +
        '</div>' +
        '<div class="settings-field">' +
          '<div class="settings-field-label">浏览器标签名</div>' +
          '<div id="cdsTabTitleState" style="font-size:13px">加载中…</div>' +
        '</div>' +
      '</div>' +
      '<div class="settings-section">' +
        '<h2 class="settings-section-title" style="color:var(--red)">危险操作</h2>' +
        '<p class="settings-section-desc">影响所有项目的不可逆操作。</p>' +
        '<button class="settings-btn-outline settings-btn-danger" onclick="cdsDoFactoryReset()">恢复出厂设置（清空所有项目）</button>' +
      '</div>';

    Promise.all([
      fetch('/api/mirror', { credentials: 'same-origin' }).then(function (r) { return r.json(); }),
      fetch('/api/tab-title', { credentials: 'same-origin' }).then(function (r) { return r.json(); }),
    ]).then(function (results) {
      var mirror = results[0] || {};
      var tab = results[1] || {};
      document.getElementById('cdsMirrorState').textContent = mirror.enabled ? '已启用' : '未启用';
      document.getElementById('cdsTabTitleState').textContent = tab.enabled ? '已启用' : '未启用';
    });
  }

  window.cdsDoFactoryReset = function () {
    if (!confirm('确定恢复出厂设置？这会清空所有项目的所有：分支、构建配置、环境变量、基础设施、路由规则。Docker 数据卷会保留。')) return;
    if (!confirm('二次确认：所有配置将被清空，此操作不可撤销。')) return;
    fetch('/api/factory-reset', { method: 'POST', credentials: 'same-origin' })
      .then(function (r) { return r.json().then(function (b) { return { ok: r.ok, body: b }; }); })
      .then(function (resp) {
        if (!resp.ok) throw new Error((resp.body && resp.body.error) || '操作失败');
        showToast('已恢复出厂设置，正在跳转…');
        setTimeout(function () { location.href = '/project-list'; }, 1500);
      })
      .catch(function (err) { showToast('失败：' + err.message); });
  };

  // ── Init ──
  renderActiveTab();
})();
