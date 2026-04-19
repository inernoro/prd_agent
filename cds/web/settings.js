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
    } else if (currentTab === 'github') {
      renderGithubTab();
    } else {
      // P4 Part 18 cleanup: unknown tab → fall back to General,
      // not a stale "coming soon" placeholder. Dead subnav items
      // were removed from settings.html in this same commit, so
      // the only way to land here is via a stale URL hash.
      currentTab = 'general';
      location.hash = '#general';
      renderGeneralTab();
    }
  }

  // ── Tab renderers ──
  function renderGeneralTab() {
    var p = currentProject;
    contentEl.innerHTML =
      '<div class="settings-section">' +
        '<div class="settings-section-title">项目基础信息</div>' +
        '<div class="settings-field">' +
          '<label class="settings-field-label" for="settingsName">名称</label>' +
          '<input id="settingsName" class="settings-input" type="text" maxlength="60" value="' + escapeHtml(p.name) + '">' +
        '</div>' +
        '<div class="settings-field">' +
          '<label class="settings-field-label" for="settingsDescription">描述</label>' +
          '<input id="settingsDescription" class="settings-input" type="text" maxlength="200" placeholder="可选,用一两句话说明这个项目是做什么的" value="' + escapeHtml(p.description || '') + '">' +
        '</div>' +
        '<div class="settings-field">' +
          '<label class="settings-field-label">项目 ID</label>' +
          '<div class="settings-input-group">' +
            '<input class="settings-input mono" type="text" value="' + escapeHtml(p.id) + '" readonly>' +
            '<button type="button" class="settings-copy-btn" title="复制项目 ID" onclick="_settingsCopyId()">' +
              '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M0 6.75C0 5.784.784 5 1.75 5h1.5a.75.75 0 010 1.5h-1.5a.25.25 0 00-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 00.25-.25v-1.5a.75.75 0 011.5 0v1.5A1.75 1.75 0 019.25 16h-7.5A1.75 1.75 0 010 14.25v-7.5z"/><path d="M5 1.75C5 .784 5.784 0 6.75 0h7.5C15.216 0 16 .784 16 1.75v7.5A1.75 1.75 0 0114.25 11h-7.5A1.75 1.75 0 015 9.25v-7.5z"/></svg>' +
            '</button>' +
          '</div>' +
        '</div>' +
        '<div class="settings-field">' +
          '<label class="settings-field-label" for="settingsGitRepoUrl">Git 仓库地址</label>' +
          '<input id="settingsGitRepoUrl" class="settings-input mono" type="url" placeholder="https://github.com/your-org/repo.git" value="' + escapeHtml(p.gitRepoUrl || '') + '">' +
        '</div>' +
        '<button type="button" id="settingsSaveBtn" class="settings-btn-primary" onclick="_settingsSave()">保存修改</button>' +
      '</div>' +

      '<div class="settings-section">' +
        '<div class="settings-section-title">项目统计</div>' +
        '<div class="settings-section-desc">来自当前 state.json 的实时数据。</div>' +
        '<div class="tfp-kv"><span class="tfp-kv-key">分支数</span><span class="tfp-kv-val">' + (p.branchCount || 0) + '</span></div>' +
        '<div class="tfp-kv"><span class="tfp-kv-key">创建时间</span><span class="tfp-kv-val">' + escapeHtml(new Date(p.createdAt).toLocaleString()) + '</span></div>' +
        '<div class="tfp-kv"><span class="tfp-kv-key">最近更新</span><span class="tfp-kv-val">' + escapeHtml(new Date(p.updatedAt).toLocaleString()) + '</span></div>' +
        (p.dockerNetwork ? '<div class="tfp-kv"><span class="tfp-kv-key">Docker 网络</span><span class="tfp-kv-val">' + escapeHtml(p.dockerNetwork) + '</span></div>' : '') +
        (p.legacyFlag ? '<div class="tfp-kv"><span class="tfp-kv-key">兼容标志</span><span class="tfp-kv-val">是 (默认项目,不能删除)</span></div>' : '') +
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
        '<div class="settings-section-title">存储后端</div>' +
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
          '<label class="settings-field-label" for="storageMongoUri">Mongo 连接串</label>' +
          '<input id="storageMongoUri" class="settings-input mono" type="text" placeholder="mongodb://admin:password@localhost:27017" autocomplete="off">' +
        '</div>' +
        '<div class="settings-field">' +
          '<label class="settings-field-label" for="storageMongoDb">数据库名</label>' +
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
            ? '<span class="cds-clone-status ready" style="margin-left:8px">健康</span>'
            : '<span class="cds-clone-status error" style="margin-left:8px">不可达</span>';
        }

        statusEl.className = 'settings-placeholder';
        statusEl.style.textAlign = 'left';
        statusEl.style.padding = '18px';
        statusEl.innerHTML =
          '<div style="font-size:13px;color:var(--text-primary);margin-bottom:10px">' +
            '<strong>当前后端:</strong> ' + escapeHtml(modeLabel) + healthBadge +
          '</div>' +
          (data.kind === 'mongo' ? (
            '<div class="tfp-kv"><span class="tfp-kv-key">连接串</span><span class="tfp-kv-val">' + escapeHtml(data.mongoUri || '-') + '</span></div>' +
            '<div class="tfp-kv"><span class="tfp-kv-key">数据库</span><span class="tfp-kv-val">' + escapeHtml(data.mongoDb || '-') + '</span></div>'
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

  // P4 Part 18 (Phase E.3): GitHub Integration tab.
  //
  // Global (system-wide) setting — one GitHub connection per CDS
  // install. The tab fetches /api/github/oauth/status and renders
  // one of three states:
  //
  //   A. Not configured → hint explaining CDS_GITHUB_CLIENT_ID
  //      needs to be set, Sign-in disabled.
  //   B. Configured but not connected → "Sign in with GitHub"
  //      button that walks through the Device Flow.
  //   C. Connected → avatar + login + "断开连接" button.
  //
  // The Device Flow UI here intentionally REUSES the same modals
  // defined in projects.html (githubDeviceModal, githubRepoPicker)
  // when those are available — but since this page doesn't
  // include projects.js, we redirect to projects.html?new=git
  // instead of trying to embed the device modal here.
  function renderGithubTab() {
    contentEl.innerHTML =
      // ── Section 1: GitHub App (Check Runs + auto deploy) ──
      // Shown FIRST because this is the primary integration — push→preview.
      // The older OAuth Device Flow section below only powers the "pick
      // a repo when creating a project" UI, which is now optional once
      // the App takes over repo selection.
      '<div class="settings-section" id="ghAppSection">' +
        '<div class="settings-section-title">GitHub 自动部署 (Check Runs)</div>' +
        '<div class="settings-section-desc">' +
          '安装 CDS GitHub App 后,<strong>本项目绑定到某个 GitHub 仓库</strong>,' +
          'push 到该仓库时 CDS 会自动创建/刷新分支、跑部署,' +
          '并把"CDS Deploy"结果回写到 PR 的 Checks 面板(点 Details 直达预览)。' +
          '<br>Railway / Vercel 的体验,在你自己的 CDS 上复刻一份。' +
        '</div>' +
        '<div id="ghAppOverview" class="settings-placeholder">正在加载 GitHub App 状态…</div>' +
        '<div id="ghAppProjectLink" style="margin-top:18px"></div>' +
      '</div>' +
      // ── Section 2: OAuth Device Flow (legacy repo picker) ──
      '<div class="settings-section">' +
        '<div class="settings-section-title">GitHub Device Flow 登录 (仓库选择器)</div>' +
        '<div class="settings-section-desc">' +
          '这是 <strong>系统级</strong> 设置。CDS 会使用这个 GitHub 账号拉取仓库列表,用于"从 GitHub 选择仓库"创建项目。<br>' +
          '采用 GitHub Device Flow —— 无需跳转回调 URL,任何部署方式都支持。' +
        '</div>' +
        '<div id="githubStatusBlock" class="settings-placeholder">正在加载 GitHub 状态…</div>' +
      '</div>' +
      '<div class="settings-section">' +
        '<div class="settings-section-title">管理员配置 (Device Flow)</div>' +
        '<div class="settings-section-desc">' +
          '要启用 GitHub Device Flow,需要在 CDS 进程启动前设置环境变量:' +
        '</div>' +
        '<div style="background:var(--bg-card);border:1px solid var(--card-border);border-radius:9px;padding:14px;font-family:var(--font-mono,monospace);font-size:12px;color:var(--text-secondary);white-space:pre-wrap">' +
          'export CDS_GITHUB_CLIENT_ID="<your-oauth-app-client-id>"\n' +
          '# 可选: 用于 CDS 登录的 web 流(和仓库选择器彼此独立)\n' +
          'export CDS_GITHUB_CLIENT_SECRET="<web-flow-secret>"' +
        '</div>' +
        '<div class="settings-section-desc" style="margin-top:12px">' +
          '步骤:<br>' +
          '1. 去 <a href="https://github.com/settings/developers" target="_blank" rel="noopener" style="color:#60a5fa">GitHub → Settings → Developer settings → OAuth Apps</a> 创建一个 OAuth App<br>' +
          '2. 在 App 的 <strong>General</strong> 设置中勾选 <strong>Enable Device Flow</strong><br>' +
          '3. 拷贝 Client ID,设置成 <code>CDS_GITHUB_CLIENT_ID</code> 环境变量<br>' +
          '4. 重启 CDS(<code>./exec_cds.sh restart</code>)<br>' +
          '5. 回到这个 tab 点"使用 GitHub 登录"' +
        '</div>' +
      '</div>';

    _renderGithubAppOverview();
    _renderGithubDeviceFlowStatus();
  }

  // ── GitHub App overview + per-project link state ──
  // Fetches /api/github/app + uses the already-loaded currentProject to
  // render:
  //   - App not configured → hint + docs link
  //   - App configured + project unlinked → "绑定仓库" CTA
  //   - App configured + project linked → repo info + autoDeploy toggle + 解除绑定
  function _renderGithubAppOverview() {
    var overview = document.getElementById('ghAppOverview');
    if (!overview) return;
    fetch('/api/github/app', { credentials: 'same-origin' })
      .then(function (r) { return r.json(); })
      .then(function (app) {
        if (!app.configured) {
          overview.style.textAlign = 'left';
          overview.style.padding = '18px';
          overview.innerHTML =
            '<div style="display:flex;align-items:center;gap:10px;margin-bottom:10px">' +
              '<span class="cds-clone-status error" style="display:inline-flex">未配置</span>' +
              '<span style="font-size:12px;color:var(--text-secondary)">' +
                '还没设置 CDS GitHub App 凭证。设完环境变量 + 重启 CDS 后会自动生效。' +
              '</span>' +
            '</div>' +
            '<div style="background:var(--bg-card);border:1px solid var(--card-border);border-radius:9px;padding:14px;font-family:var(--font-mono,monospace);font-size:12px;color:var(--text-secondary);white-space:pre-wrap">' +
              'export CDS_GITHUB_APP_ID="<numeric-app-id>"\n' +
              'export CDS_GITHUB_APP_PRIVATE_KEY="$(cat private-key.pem)"\n' +
              'export CDS_GITHUB_WEBHOOK_SECRET="<random-string>"\n' +
              'export CDS_GITHUB_APP_SLUG="<lowercase-app-slug>"\n' +
              'export CDS_PUBLIC_BASE_URL="https://cds.your-domain.com"' +
            '</div>' +
            '<div class="settings-section-desc" style="margin-top:12px">' +
              '步骤: 在 <a href="https://github.com/settings/apps/new" target="_blank" rel="noopener" style="color:#60a5fa">GitHub → Settings → Developer settings → GitHub Apps → New GitHub App</a> 创建 App,' +
              '授予 Checks / Contents / Metadata 权限,生成 private key,把上面 5 个环境变量写入 <code>.cds.env</code> 后重启 CDS。' +
            '</div>';
          document.getElementById('ghAppProjectLink').innerHTML = '';
          return;
        }

        // Configured — show compact overview card.
        overview.style.textAlign = 'left';
        overview.style.padding = '18px';
        var installBtn = app.installUrl
          ? '<a href="' + escapeHtml(app.installUrl) + '" target="_blank" rel="noopener" class="settings-btn-outline" style="text-decoration:none;display:inline-flex">' +
              '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" style="margin-right:6px"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>' +
              '在 GitHub 上安装/管理 App' +
            '</a>'
          : '';
        overview.innerHTML =
          '<div style="display:flex;align-items:center;gap:10px;margin-bottom:14px">' +
            '<span class="cds-clone-status ready">App 已配置</span>' +
            (app.appSlug ? '<span style="font-size:12px;color:var(--text-secondary)">@' + escapeHtml(app.appSlug) + '</span>' : '') +
          '</div>' +
          '<div class="tfp-kv"><span class="tfp-kv-key">App ID</span><span class="tfp-kv-val mono">' + escapeHtml(app.appId || '-') + '</span></div>' +
          (app.webhookUrl
            ? '<div class="tfp-kv"><span class="tfp-kv-key">Webhook URL</span><span class="tfp-kv-val mono" style="word-break:break-all">' + escapeHtml(app.webhookUrl) + '</span></div>'
            : '<div class="tfp-kv"><span class="tfp-kv-key">Webhook URL</span><span class="tfp-kv-val" style="color:var(--red)">未设置 CDS_PUBLIC_BASE_URL,GitHub 后台无法反查 URL</span></div>') +
          (app.publicBaseUrl
            ? '<div class="tfp-kv"><span class="tfp-kv-key">Public Base URL</span><span class="tfp-kv-val mono">' + escapeHtml(app.publicBaseUrl) + '</span></div>'
            : '') +
          '<div style="margin-top:14px">' + installBtn + '</div>';

        // App is live — now render the per-project link card.
        _renderGithubProjectLink();
      })
      .catch(function (err) {
        overview.innerHTML = '<span style="color:var(--red)">加载失败: ' + escapeHtml(err && err.message ? err.message : String(err)) + '</span>';
      });
  }

  // Render the "this project is linked to X / pick a repo" card.
  // Depends on currentProject being loaded.
  function _renderGithubProjectLink() {
    var el = document.getElementById('ghAppProjectLink');
    if (!el || !currentProject) return;
    var p = currentProject;
    var linked = Boolean(p.githubRepoFullName && p.githubInstallationId);

    if (linked) {
      var autoDeploy = p.githubAutoDeploy !== false; // default true
      el.innerHTML =
        '<div style="background:var(--bg-card);border:1px solid var(--card-border);border-radius:10px;padding:16px">' +
          '<div style="display:flex;align-items:center;gap:10px;margin-bottom:14px">' +
            '<span class="cds-clone-status ready">已绑定</span>' +
            '<a href="https://github.com/' + escapeHtml(p.githubRepoFullName) + '" target="_blank" rel="noopener" style="color:#60a5fa;font-weight:600;font-size:14px;text-decoration:none">' +
              escapeHtml(p.githubRepoFullName) +
              ' <span style="opacity:0.6">↗</span>' +
            '</a>' +
          '</div>' +
          '<div class="tfp-kv"><span class="tfp-kv-key">Installation ID</span><span class="tfp-kv-val mono">' + escapeHtml(String(p.githubInstallationId)) + '</span></div>' +
          (p.githubLinkedAt
            ? '<div class="tfp-kv"><span class="tfp-kv-key">绑定于</span><span class="tfp-kv-val">' + escapeHtml(new Date(p.githubLinkedAt).toLocaleString()) + '</span></div>'
            : '') +
          '<div style="display:flex;align-items:center;gap:10px;margin-top:16px;padding:12px;background:var(--bg-elevated);border-radius:8px">' +
            '<label style="flex:1;display:flex;align-items:center;gap:10px;cursor:pointer">' +
              '<input type="checkbox" id="ghAutoDeployToggle" ' + (autoDeploy ? 'checked' : '') + ' onchange="_settingsToggleAutoDeploy(this.checked)" style="width:16px;height:16px;cursor:pointer">' +
              '<div>' +
                '<div style="font-weight:600;font-size:13px;color:var(--text-primary)">自动部署</div>' +
                '<div style="font-size:11px;color:var(--text-muted);margin-top:2px">push 到该仓库时自动在 CDS 构建部署</div>' +
              '</div>' +
            '</label>' +
          '</div>' +
          '<div style="display:flex;gap:10px;margin-top:16px">' +
            '<button type="button" class="settings-btn-outline" onclick="_settingsGithubRelink()">重新绑定其他仓库</button>' +
            '<button type="button" class="settings-btn-outline settings-btn-danger" onclick="_settingsGithubUnlink()">解除绑定</button>' +
          '</div>' +
        '</div>';
    } else {
      el.innerHTML =
        '<div style="background:var(--bg-card);border:1px solid var(--card-border);border-radius:10px;padding:18px;text-align:center">' +
          '<div style="font-size:13px;color:var(--text-secondary);margin-bottom:14px">' +
            '本项目还没有绑定 GitHub 仓库。绑定后 push 会自动触发部署。' +
          '</div>' +
          '<button type="button" class="settings-btn-primary" onclick="_settingsGithubLinkOpen()">' +
            '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" style="margin-right:6px"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>' +
            '绑定 GitHub 仓库' +
          '</button>' +
        '</div>';
    }
  }

  // Extracted: load Device Flow status into the original #githubStatusBlock.
  function _renderGithubDeviceFlowStatus() {
    // Fetch status and render the appropriate state
    fetch('/api/github/oauth/status', { credentials: 'same-origin' })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        var block = document.getElementById('githubStatusBlock');
        if (!block) return;

        if (!data.configured) {
          block.style.textAlign = 'left';
          block.style.padding = '18px';
          block.innerHTML =
            '<div style="display:flex;align-items:center;gap:10px">' +
              '<span class="cds-clone-status error" style="display:inline-flex">未配置</span>' +
              '<span style="font-size:12px;color:var(--text-secondary)">管理员需设置 <code>CDS_GITHUB_CLIENT_ID</code></span>' +
            '</div>';
          return;
        }

        if (!data.connected) {
          block.style.textAlign = 'left';
          block.style.padding = '18px';
          block.innerHTML =
            '<div style="display:flex;align-items:center;gap:10px;margin-bottom:14px">' +
              '<span class="cds-clone-status" style="background:var(--bg-elevated);border:1px solid var(--card-border);color:var(--text-secondary)">未连接</span>' +
            '</div>' +
            '<div style="font-size:12px;color:var(--text-muted);margin-bottom:14px">' +
              '尚未连接 GitHub。点击下方按钮通过 Device Flow 登录(会打开一个新标签页让你在 github.com 输入代码)。' +
            '</div>' +
            '<button type="button" class="btn-github-signin" onclick="_settingsGithubSignIn()" style="display:inline-flex">' +
              '<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>' +
              '使用 GitHub 登录' +
            '</button>' +
            '<div id="githubDeviceStatus" style="margin-top:14px;font-size:12px;color:var(--text-muted);min-height:18px"></div>';
          return;
        }

        // Connected state
        var avatar = data.avatarUrl
          ? '<img src="' + escapeHtml(data.avatarUrl) + '" width="48" height="48" style="border-radius:50%;border:1px solid var(--card-border)">'
          : '<div style="width:48px;height:48px;border-radius:50%;background:var(--bg-elevated);display:flex;align-items:center;justify-content:center;color:var(--text-muted);font-size:18px;font-weight:700">?</div>';
        var scopes = (data.scopes || []).map(escapeHtml).join(', ') || '未提供';
        block.style.textAlign = 'left';
        block.style.padding = '18px';
        block.innerHTML =
          '<div style="display:flex;align-items:center;gap:14px;margin-bottom:16px">' +
            avatar +
            '<div style="flex:1">' +
              '<div style="font-size:14px;font-weight:700;color:var(--text-primary);display:flex;align-items:center;gap:8px">' +
                escapeHtml(data.name || data.login) +
                '<span class="cds-clone-status ready">已连接</span>' +
              '</div>' +
              '<div style="font-size:11px;color:var(--text-muted);margin-top:2px">@' + escapeHtml(data.login) + ' · 连接于 ' + escapeHtml(new Date(data.connectedAt).toLocaleString()) + '</div>' +
              '<div style="font-size:10px;color:var(--text-muted);margin-top:2px;font-family:var(--font-mono,monospace)">授权范围: ' + scopes + '</div>' +
            '</div>' +
          '</div>' +
          '<div style="display:flex;gap:10px">' +
            '<a href="/project-list?new=git" class="settings-btn-primary" style="text-decoration:none">新建项目 →</a>' +
            '<button type="button" class="settings-btn-outline settings-btn-danger" onclick="_settingsGithubDisconnect()">断开连接</button>' +
          '</div>';
      })
      .catch(function (err) {
        var block = document.getElementById('githubStatusBlock');
        if (block) {
          block.innerHTML = '<span style="color:var(--red)">加载失败：' + escapeHtml(err && err.message ? err.message : String(err)) + '</span>';
        }
      });
  }

  // Device flow handler for the Settings page — polls /device-poll
  // just like projects.js, but keeps state inside this IIFE.
  var _settingsDeviceTimer = null;
  var _settingsDeviceAbort = false;

  window._settingsGithubSignIn = function () {
    var statusEl = document.getElementById('githubDeviceStatus');
    if (statusEl) statusEl.innerHTML = '正在请求设备代码…';
    _settingsDeviceAbort = false;

    fetch('/api/github/oauth/device-start', {
      method: 'POST',
      credentials: 'same-origin',
    })
      .then(function (r) {
        return r.json().then(function (body) { return { status: r.status, body: body }; });
      })
      .then(function (result) {
        if (result.status !== 200) {
          if (statusEl) statusEl.innerHTML = '<span style="color:var(--red)">' + escapeHtml((result.body && result.body.message) || '启动失败') + '</span>';
          return;
        }
        var b = result.body;
        if (statusEl) {
          statusEl.innerHTML =
            '请在 <a href="' + escapeHtml(b.verificationUri) + '" target="_blank" rel="noopener" style="color:#60a5fa">' + escapeHtml(b.verificationUri) + '</a> 输入代码: ' +
            '<span style="font-family:var(--font-mono,monospace);font-size:14px;font-weight:700;color:var(--text-primary);letter-spacing:2px">' + escapeHtml(b.userCode) + '</span>' +
            '<br><span id="githubDeviceTimer" style="color:var(--text-muted)">等待授权…</span>';
        }
        try { window.open(b.verificationUri, '_blank', 'noopener'); } catch (e) { /* */ }
        _scheduleSettingsPoll(b.deviceCode, (b.interval || 5) * 1000);
      })
      .catch(function (err) {
        if (statusEl) statusEl.innerHTML = '<span style="color:var(--red)">网络错误: ' + escapeHtml(err && err.message ? err.message : String(err)) + '</span>';
      });
  };

  function _scheduleSettingsPoll(deviceCode, intervalMs) {
    if (_settingsDeviceTimer) clearTimeout(_settingsDeviceTimer);
    _settingsDeviceTimer = setTimeout(function () {
      if (_settingsDeviceAbort) return;
      fetch('/api/github/oauth/device-poll', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ deviceCode: deviceCode }),
      })
        .then(function (r) { return r.json(); })
        .then(function (body) {
          if (_settingsDeviceAbort) return;
          var timerEl = document.getElementById('githubDeviceTimer');
          if (body.status === 'ready') {
            showToast('已连接 GitHub @' + (body.login || ''));
            // Re-render the tab to show the connected state
            setTimeout(renderGithubTab, 300);
            return;
          }
          if (body.status === 'pending') {
            if (timerEl) timerEl.textContent = '等待授权…（' + new Date().toLocaleTimeString() + '）';
            _scheduleSettingsPoll(deviceCode, intervalMs);
            return;
          }
          if (body.status === 'slow-down') {
            _scheduleSettingsPoll(deviceCode, intervalMs + 5000);
            return;
          }
          if (body.status === 'expired' || body.status === 'denied') {
            if (timerEl) timerEl.innerHTML = '<span style="color:var(--red)">' + (body.status === 'expired' ? '设备代码已过期' : '用户拒绝了授权') + '</span>';
            return;
          }
          // Unknown → stop polling
          if (timerEl) timerEl.innerHTML = '<span style="color:var(--red)">未知错误: ' + escapeHtml(JSON.stringify(body)) + '</span>';
        })
        .catch(function () {
          // Network blip — retry
          _scheduleSettingsPoll(deviceCode, intervalMs);
        });
    }, intervalMs);
  }

  window._settingsGithubDisconnect = function () {
    if (!window.confirm('确定断开 GitHub 连接吗？\n\n此操作仅清除本地记录，不会撤销 GitHub 侧的 token。\n要彻底撤销请去 https://github.com/settings/applications 手动删除。')) return;
    fetch('/api/github/oauth', {
      method: 'DELETE',
      credentials: 'same-origin',
    })
      .then(function (r) { return r.json(); })
      .then(function () {
        showToast('已断开 GitHub 连接');
        _settingsDeviceAbort = true;
        renderGithubTab();
      })
      .catch(function (err) {
        showToast('断开失败: ' + (err && err.message ? err.message : err));
      });
  };

  // ── GitHub App link handlers ──

  // Toggle autoDeploy on an already-linked project. Hits the same
  // POST /github/link endpoint with existing installationId + repoFullName
  // so the backend treats this as an idempotent "relink with same target,
  // different autoDeploy". A PATCH alternative would be cleaner; kept as
  // POST for backend simplicity.
  window._settingsToggleAutoDeploy = function (enabled) {
    if (!currentProject || !currentProject.githubInstallationId || !currentProject.githubRepoFullName) {
      showToast('请先绑定仓库');
      return;
    }
    fetch('/api/projects/' + encodeURIComponent(CURRENT_PROJECT_ID) + '/github/link', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({
        installationId: currentProject.githubInstallationId,
        repoFullName: currentProject.githubRepoFullName,
        autoDeploy: Boolean(enabled),
      }),
    })
      .then(function (r) {
        return r.json().then(function (body) { return { status: r.status, body: body }; });
      })
      .then(function (result) {
        if (result.status !== 200) {
          showToast('更新失败: ' + (result.body && result.body.message || '未知错误'));
          var cb = document.getElementById('ghAutoDeployToggle');
          if (cb) cb.checked = !enabled;
          return;
        }
        currentProject = result.body.project;
        showToast(enabled ? '已启用自动部署' : '已禁用自动部署');
      })
      .catch(function (err) {
        showToast('更新失败: ' + (err && err.message ? err.message : err));
        var cb = document.getElementById('ghAutoDeployToggle');
        if (cb) cb.checked = !enabled;
      });
  };

  window._settingsGithubUnlink = function () {
    if (!window.confirm('确定解除本项目的 GitHub 仓库绑定吗？\n\npush 将不再自动部署。之前已创建的分支和 check run 不受影响。')) return;
    fetch('/api/projects/' + encodeURIComponent(CURRENT_PROJECT_ID) + '/github/link', {
      method: 'DELETE',
      credentials: 'same-origin',
    })
      .then(function (r) { return r.json(); })
      .then(function () {
        showToast('已解除绑定');
        loadProject().then(function (p) {
          currentProject = p;
          renderGithubTab();
        });
      })
      .catch(function (err) {
        showToast('解除失败: ' + (err && err.message ? err.message : err));
      });
  };

  window._settingsGithubRelink = function () {
    // Relink = unlink + open picker. We don't ask confirmation twice
    // because the picker itself is the confirmation step.
    fetch('/api/projects/' + encodeURIComponent(CURRENT_PROJECT_ID) + '/github/link', {
      method: 'DELETE',
      credentials: 'same-origin',
    })
      .then(function () {
        return loadProject();
      })
      .then(function (p) {
        currentProject = p;
        _settingsGithubLinkOpen();
      })
      .catch(function (err) {
        showToast('重置失败: ' + (err && err.message ? err.message : err));
      });
  };

  // ── Repo picker modal ──
  // Creates a dynamic overlay with two steps:
  //   Step 1: pick an installation (list comes from /api/github/installations)
  //   Step 2: pick a repo from that installation
  // The modal renders in-place inside document.body (no preset HTML slot)
  // so the settings.html stays untouched.
  var _linkModalEl = null;

  function _closeLinkModal() {
    if (_linkModalEl && _linkModalEl.parentNode) {
      _linkModalEl.parentNode.removeChild(_linkModalEl);
    }
    _linkModalEl = null;
  }

  window._settingsGithubLinkOpen = function () {
    _closeLinkModal();
    var overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.55);z-index:10001;display:flex;align-items:center;justify-content:center;padding:20px';
    overlay.addEventListener('click', function (e) { if (e.target === overlay) _closeLinkModal(); });

    var modal = document.createElement('div');
    modal.style.cssText = 'background:var(--bg-primary);border:1px solid var(--card-border);border-radius:14px;padding:24px;width:100%;max-width:560px;max-height:80vh;overflow-y:auto;box-shadow:0 24px 60px rgba(0,0,0,0.6)';
    modal.innerHTML =
      '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:18px">' +
        '<div style="font-size:18px;font-weight:700;color:var(--text-primary)">绑定 GitHub 仓库</div>' +
        '<button type="button" onclick="_settingsGithubLinkClose()" style="background:none;border:none;color:var(--text-muted);cursor:pointer;font-size:18px;padding:4px">✕</button>' +
      '</div>' +
      '<div id="ghLinkStep" style="min-height:200px">' +
        '<div class="settings-placeholder" style="padding:40px 20px">正在加载安装列表…</div>' +
      '</div>';
    overlay.appendChild(modal);
    document.body.appendChild(overlay);
    _linkModalEl = overlay;

    // Step 1: load installations
    fetch('/api/github/installations', { credentials: 'same-origin' })
      .then(function (r) {
        return r.json().then(function (body) { return { status: r.status, body: body }; });
      })
      .then(function (result) {
        var step = document.getElementById('ghLinkStep');
        if (!step) return;
        if (result.status !== 200) {
          step.innerHTML = '<div style="padding:20px;color:var(--red)">拉取安装失败: ' + escapeHtml((result.body && result.body.message) || 'HTTP ' + result.status) + '</div>';
          return;
        }
        var installs = (result.body && result.body.installations) || [];
        if (installs.length === 0) {
          step.innerHTML =
            '<div style="padding:20px;text-align:center">' +
              '<div style="font-size:14px;color:var(--text-secondary);margin-bottom:14px">' +
                '还没有任何 GitHub 账号/组织安装了本 App。' +
              '</div>' +
              '<a href="#" onclick="(async()=>{const r=await fetch(\'/api/github/app\',{credentials:\'same-origin\'}).then(x=>x.json());if(r.installUrl)window.open(r.installUrl,\'_blank\')})();return false" class="settings-btn-primary" style="text-decoration:none">在 GitHub 上安装 App</a>' +
            '</div>';
          return;
        }

        var options = installs.map(function (inst) {
          var avatar = inst.account.avatarUrl
            ? '<img src="' + escapeHtml(inst.account.avatarUrl) + '" width="28" height="28" style="border-radius:50%">'
            : '<div style="width:28px;height:28px;border-radius:50%;background:var(--bg-elevated)"></div>';
          return (
            '<button type="button" class="gh-link-item" ' +
              'onclick="_settingsPickInstallation(' + inst.id + ',\'' + escapeHtml(inst.account.login).replace(/'/g, '&#39;') + '\')" ' +
              'style="display:flex;align-items:center;gap:12px;width:100%;padding:12px;background:var(--bg-card);border:1px solid var(--card-border);border-radius:10px;cursor:pointer;transition:border-color 120ms;text-align:left;font-family:inherit">' +
              avatar +
              '<div style="flex:1">' +
                '<div style="font-weight:600;font-size:13px;color:var(--text-primary)">' + escapeHtml(inst.account.login) + '</div>' +
                '<div style="font-size:11px;color:var(--text-muted);margin-top:2px">' +
                  escapeHtml(inst.account.type || 'Unknown') + ' · ' +
                  (inst.repositorySelection === 'all' ? '所有仓库' : '指定仓库') + ' · id=' + inst.id +
                '</div>' +
              '</div>' +
              '<span style="color:var(--text-muted)">›</span>' +
            '</button>'
          );
        }).join('');

        step.innerHTML =
          '<div style="font-size:12px;color:var(--text-muted);margin-bottom:12px">' +
            '选择一个已安装本 App 的 GitHub 账号或组织:' +
          '</div>' +
          '<div style="display:flex;flex-direction:column;gap:8px">' + options + '</div>';
      })
      .catch(function (err) {
        var step = document.getElementById('ghLinkStep');
        if (step) step.innerHTML = '<div style="padding:20px;color:var(--red)">网络错误: ' + escapeHtml(err && err.message ? err.message : String(err)) + '</div>';
      });
  };

  window._settingsGithubLinkClose = _closeLinkModal;

  // Step 2: after picking an installation, list repos.
  window._settingsPickInstallation = function (installationId, ownerLogin) {
    var step = document.getElementById('ghLinkStep');
    if (step) step.innerHTML = '<div class="settings-placeholder" style="padding:40px 20px">正在加载 @' + escapeHtml(ownerLogin) + ' 下的仓库…</div>';

    fetch('/api/github/installations/' + installationId + '/repos', { credentials: 'same-origin' })
      .then(function (r) { return r.json().then(function (body) { return { status: r.status, body: body }; }); })
      .then(function (result) {
        step = document.getElementById('ghLinkStep');
        if (!step) return;
        if (result.status !== 200) {
          step.innerHTML = '<div style="padding:20px;color:var(--red)">拉取仓库失败: ' + escapeHtml((result.body && result.body.message) || 'HTTP ' + result.status) + '</div>';
          return;
        }
        var repos = (result.body && result.body.repos) || [];
        if (repos.length === 0) {
          step.innerHTML =
            '<div style="padding:20px;text-align:center">' +
              '<div style="font-size:14px;color:var(--text-secondary);margin-bottom:14px">@' + escapeHtml(ownerLogin) + ' 没有授予本 App 访问任何仓库</div>' +
              '<button type="button" class="settings-btn-outline" onclick="_settingsGithubLinkOpen()">返回重选</button>' +
            '</div>';
          return;
        }

        var options = repos.map(function (repo) {
          return (
            '<button type="button" class="gh-link-item" ' +
              'onclick="_settingsPickRepo(' + installationId + ',\'' + escapeHtml(repo.fullName).replace(/'/g, '&#39;') + '\')" ' +
              'style="display:flex;align-items:center;gap:10px;width:100%;padding:11px 12px;background:var(--bg-card);border:1px solid var(--card-border);border-radius:10px;cursor:pointer;transition:border-color 120ms;text-align:left;font-family:inherit">' +
              '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" style="color:var(--text-muted);flex-shrink:0"><path d="M2 2.5A2.5 2.5 0 014.5 0h8.75a.75.75 0 01.75.75v12.5a.75.75 0 01-.75.75h-2.5a.75.75 0 010-1.5h1.75v-2h-8a1 1 0 00-.714 1.7.75.75 0 01-1.072 1.05A2.495 2.495 0 012 11.5v-9zm10.5-1V9h-8c-.356 0-.694.074-1 .208V2.5a1 1 0 011-1h8zM5 12.25v3.25a.25.25 0 00.4.2l1.45-1.087a.25.25 0 01.3 0L8.6 15.7a.25.25 0 00.4-.2v-3.25a.25.25 0 00-.25-.25h-3.5a.25.25 0 00-.25.25z"/></svg>' +
              '<div style="flex:1;min-width:0">' +
                '<div style="font-weight:600;font-size:13px;color:var(--text-primary);display:flex;align-items:center;gap:6px">' +
                  escapeHtml(repo.fullName) +
                  (repo.private ? '<span style="font-size:10px;padding:1px 6px;border:1px solid var(--card-border);border-radius:10px;color:var(--text-muted);font-weight:500">Private</span>' : '') +
                '</div>' +
                (repo.defaultBranch ? '<div style="font-size:11px;color:var(--text-muted);margin-top:2px">默认分支: ' + escapeHtml(repo.defaultBranch) + '</div>' : '') +
              '</div>' +
              '<span style="color:var(--text-muted)">›</span>' +
            '</button>'
          );
        }).join('');

        step.innerHTML =
          '<div style="display:flex;align-items:center;gap:8px;font-size:12px;color:var(--text-muted);margin-bottom:12px">' +
            '<button type="button" onclick="_settingsGithubLinkOpen()" style="background:none;border:none;color:#60a5fa;cursor:pointer;font-size:12px;padding:0">‹ 返回</button>' +
            '<span>/ @' + escapeHtml(ownerLogin) + ' 下选一个仓库:</span>' +
          '</div>' +
          '<div style="display:flex;flex-direction:column;gap:6px">' + options + '</div>';
      })
      .catch(function (err) {
        var step = document.getElementById('ghLinkStep');
        if (step) step.innerHTML = '<div style="padding:20px;color:var(--red)">网络错误: ' + escapeHtml(err && err.message ? err.message : String(err)) + '</div>';
      });
  };

  // Step 3: confirm + POST /link
  window._settingsPickRepo = function (installationId, repoFullName) {
    var step = document.getElementById('ghLinkStep');
    if (step) {
      step.innerHTML =
        '<div style="padding:16px">' +
          '<div style="font-size:13px;color:var(--text-secondary);margin-bottom:16px">' +
            '把本项目绑定到 <strong style="color:var(--text-primary)">' + escapeHtml(repoFullName) + '</strong>' +
          '</div>' +
          '<label style="display:flex;align-items:center;gap:10px;padding:12px;background:var(--bg-elevated);border-radius:8px;cursor:pointer;margin-bottom:18px">' +
            '<input type="checkbox" id="ghLinkAutoDeploy" checked style="width:16px;height:16px;cursor:pointer">' +
            '<div>' +
              '<div style="font-weight:600;font-size:13px;color:var(--text-primary)">开启自动部署</div>' +
              '<div style="font-size:11px;color:var(--text-muted);margin-top:2px">push 到该仓库任意分支时自动在 CDS 构建部署(推荐)</div>' +
            '</div>' +
          '</label>' +
          '<div style="display:flex;gap:10px;justify-content:flex-end">' +
            '<button type="button" class="settings-btn-outline" onclick="_settingsGithubLinkOpen()">上一步</button>' +
            '<button type="button" class="settings-btn-primary" id="ghLinkConfirmBtn" ' +
              'onclick="_settingsConfirmLink(' + installationId + ',\'' + escapeHtml(repoFullName).replace(/'/g, '&#39;') + '\')">' +
              '确认绑定' +
            '</button>' +
          '</div>' +
        '</div>';
    }
  };

  window._settingsConfirmLink = function (installationId, repoFullName) {
    var btn = document.getElementById('ghLinkConfirmBtn');
    var autoEl = document.getElementById('ghLinkAutoDeploy');
    var autoDeploy = autoEl ? autoEl.checked : true;
    if (btn) { btn.disabled = true; btn.textContent = '绑定中…'; }

    fetch('/api/projects/' + encodeURIComponent(CURRENT_PROJECT_ID) + '/github/link', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({
        installationId: installationId,
        repoFullName: repoFullName,
        autoDeploy: autoDeploy,
      }),
    })
      .then(function (r) { return r.json().then(function (body) { return { status: r.status, body: body }; }); })
      .then(function (result) {
        if (result.status !== 200) {
          if (btn) { btn.disabled = false; btn.textContent = '确认绑定'; }
          showToast('绑定失败: ' + ((result.body && result.body.message) || 'HTTP ' + result.status));
          return;
        }
        showToast('已绑定 ' + repoFullName);
        _closeLinkModal();
        currentProject = result.body.project;
        renderGithubTab();
      })
      .catch(function (err) {
        if (btn) { btn.disabled = false; btn.textContent = '确认绑定'; }
        showToast('网络错误: ' + (err && err.message ? err.message : err));
      });
  };

  function renderDangerTab() {
    var p = currentProject;
    var canDelete = !p.legacyFlag;
    contentEl.innerHTML =
      // ── CDS self-recovery (admin-level, not project-scoped) ──
      '<div class="settings-section">' +
        '<div class="settings-section-title" style="color:var(--amber,#f59e0b)">CDS 自维护</div>' +
        '<div class="settings-section-desc">这些操作影响整个 CDS 实例,会在几秒内让管理面板短暂不可用。</div>' +
        '<div style="background:var(--bg-card);border:1px solid rgba(245,158,11,0.3);border-radius:10px;padding:18px;margin-bottom:14px">' +
          '<div style="font-weight:700;color:var(--text-primary);margin-bottom:6px">强制同步 CDS 源码到 origin</div>' +
          '<div style="font-size:12px;color:var(--text-muted);margin-bottom:14px;line-height:1.6">' +
            '当 self-update 的 git pull 把远端改动合并掉、CDS 运行的仍是旧代码时,用这个强制命令:' +
            '<code>git fetch + git reset --hard origin/&lt;branch&gt; + 清 dist 缓存 + 重启</code>。' +
            '<br>⚠ 会丢弃 host 上本地未推送的提交。正常部署场景下不会有本地提交,所以是安全的。' +
          '</div>' +
          '<div style="display:flex;gap:10px;align-items:center">' +
            '<input type="text" id="sfsBranch" placeholder="分支名 (留空 = 当前分支)" ' +
              'style="flex:1;background:var(--bg-elevated);border:1px solid var(--card-border);border-radius:8px;padding:8px 12px;color:var(--text-primary);font-family:var(--font-mono,monospace);font-size:12px">' +
            '<button type="button" class="settings-btn-outline" style="color:var(--amber,#f59e0b);border-color:rgba(245,158,11,0.4)" onclick="_settingsForceSync()">强制同步</button>' +
          '</div>' +
          '<div id="sfsProgress" style="margin-top:14px;font-size:12px;color:var(--text-muted);font-family:var(--font-mono,monospace);white-space:pre-wrap;max-height:240px;overflow-y:auto;line-height:1.5"></div>' +
        '</div>' +
      '</div>' +
      // ── Project deletion (original danger zone) ──
      '<div class="settings-section">' +
        '<div class="settings-section-title" style="color:var(--red,#f43f5e)">危险区</div>' +
        '<div class="settings-section-desc">这些操作不可撤销。请谨慎。</div>' +
        '<div style="background:var(--bg-card);border:1px solid rgba(244,63,94,0.3);border-radius:10px;padding:18px">' +
          '<div style="font-weight:700;color:var(--text-primary);margin-bottom:6px">删除项目</div>' +
          '<div style="font-size:12px;color:var(--text-muted);margin-bottom:14px;line-height:1.6">' +
            (canDelete
              ? '永久删除本项目。Docker 网络 <code>' + escapeHtml(p.dockerNetwork || '-') + '</code> 会被一起移除。该操作不可撤销。'
              : '⚠ 默认项目(legacy)不可删除。它是 v3.2 时代所有数据的归属,删除会让现有分支/配置全部成为孤儿。')
          + '</div>' +
          '<button type="button" class="settings-btn-outline settings-btn-danger" ' + (canDelete ? '' : 'disabled') + ' onclick="_settingsDelete()">删除此项目</button>' +
        '</div>' +
      '</div>';
  }

  // Force-sync the CDS source repo to origin. Calls POST /api/self-force-sync
  // and streams the SSE progress events into the preview box. Equivalent to
  // SSH-ing in and running `git reset --hard + rm dist/.build-sha + restart`
  // but 100% in-UI.
  window._settingsForceSync = function () {
    var inp = document.getElementById('sfsBranch');
    var progress = document.getElementById('sfsProgress');
    var branch = inp && inp.value ? inp.value.trim() : '';
    if (!window.confirm(
      '确认强制同步 CDS 源码到 origin/' + (branch || '<当前分支>') + '?\n\n' +
      '会硬重置 host 上的 /root/…/prd_agent, 清 dist 缓存, 然后重启 CDS。\n' +
      '所有本地未推送的提交会被丢弃。'
    )) return;

    if (progress) progress.textContent = '→ 启动 force-sync…\n';

    // SSE consumer — we rely on fetch + ReadableStream rather than EventSource
    // because EventSource doesn't let us POST a body. The server frames each
    // event as `event: <name>\ndata: <json>\n\n`.
    fetch('/api/self-force-sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ branch: branch || undefined }),
    })
      .then(function (r) {
        if (!r.body || !r.body.getReader) {
          return r.text().then(function (t) {
            if (progress) progress.textContent += '(no-stream) ' + t;
          });
        }
        var reader = r.body.getReader();
        var decoder = new TextDecoder();
        var buf = '';
        function pump() {
          return reader.read().then(function (chunk) {
            if (chunk.done) return;
            buf += decoder.decode(chunk.value, { stream: true });
            // SSE frame: blank line separates events.
            var parts = buf.split('\n\n');
            buf = parts.pop();
            parts.forEach(function (frame) {
              var line = frame.split('\n').find(function (l) { return l.startsWith('data: '); });
              if (!line) return;
              try {
                var data = JSON.parse(line.slice(6));
                if (data.title) {
                  var marker = data.status === 'error' ? '✖'
                              : data.status === 'warning' ? '⚠'
                              : data.status === 'done' ? '✓' : '·';
                  if (progress) {
                    progress.textContent += marker + ' [' + (data.step || '') + '] ' + data.title + '\n';
                    progress.scrollTop = progress.scrollHeight;
                  }
                } else if (data.message) {
                  if (progress) {
                    progress.textContent += '⇢ ' + data.message + '\n';
                    progress.scrollTop = progress.scrollHeight;
                  }
                }
              } catch (_) {}
            });
            return pump();
          });
        }
        return pump();
      })
      .then(function () {
        if (progress) progress.textContent += '\n→ CDS 正在重启, 刷新页面确认…\n';
        showToast('强制同步完成, 正在重启');
        // Poll /healthz until back online, then reload the tab.
        var tries = 0;
        function poll() {
          tries++;
          fetch('/healthz', { credentials: 'same-origin', cache: 'no-store' })
            .then(function (r) { return r.ok ? r.json() : null; })
            .then(function (h) {
              if (h && h.ok) {
                if (progress) progress.textContent += '✓ CDS 已重新上线\n';
                setTimeout(function () { location.reload(); }, 800);
              } else if (tries < 40) {
                setTimeout(poll, 1500);
              } else {
                if (progress) progress.textContent += '✖ 重启超时, 请手动检查\n';
              }
            })
            .catch(function () {
              if (tries < 40) setTimeout(poll, 1500);
            });
        }
        setTimeout(poll, 3000);
      })
      .catch(function (err) {
        if (progress) progress.textContent += '✖ 网络错误: ' + (err && err.message ? err.message : err) + '\n';
        showToast('force-sync 失败: ' + (err && err.message ? err.message : err));
      });
  };

  // ── Form actions (exposed on window) ──
  window._settingsCopyId = function () {
    if (!currentProject) return;
    if (navigator.clipboard) {
      navigator.clipboard.writeText(currentProject.id).then(function () {
        showToast('项目 ID 已复制');
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
          setTimeout(function () { location.href = '/project-list'; }, 800);
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
  if (topologyLink) topologyLink.href = '/branch-panel?project=' + encodeURIComponent(CURRENT_PROJECT_ID);
  var logsLink = document.getElementById('leftnavLogs');
  if (logsLink) logsLink.href = '/branch-list?project=' + encodeURIComponent(CURRENT_PROJECT_ID);

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
