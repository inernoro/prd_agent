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

// Theme toggle for projects page (shared localStorage key with index.html).
//
// Uses the same View Transition API + clip-path ripple animation that
// app.js::toggleTheme uses on the branch page, so the two pages feel
// identical when the user switches pages mid-session. The CSS rules
// (::view-transition-new(root), --ripple-x/y/radius vars, vt-snapshotting
// class) already live in style.css (around line 2670+); we just need
// to wire the same origin calc + view-transition call here.
// 2026-04-22 手机端 ☰ 菜单开关：切换 .cds-sidebar 的 .mobile-open 类
function _toggleCdsSidebar(event) {
  if (event) event.stopPropagation();
  var sidebar = document.getElementById('cdsSidebar');
  var btn = document.getElementById('cdsMobileMenuBtn');
  if (!sidebar) return;
  var wasOpen = sidebar.classList.toggle('mobile-open');
  if (btn) btn.setAttribute('aria-expanded', wasOpen ? 'true' : 'false');
}
window._toggleCdsSidebar = _toggleCdsSidebar;

function _projectsToggleTheme(btn) {
  var isLight = document.documentElement.dataset.theme === 'light';
  var next = isLight ? 'dark' : 'light';

  // Origin point: prefer the clicked button's center so the ripple
  // radiates from the sun/moon icon. Fall back to top-center.
  var x, y;
  if (btn && btn.getBoundingClientRect) {
    var rect = btn.getBoundingClientRect();
    x = rect.left + rect.width / 2;
    y = rect.top + rect.height / 2;
  } else {
    x = window.innerWidth / 2;
    y = 0;
  }
  var maxRadius = Math.ceil(Math.sqrt(
    Math.max(x, window.innerWidth - x) * Math.max(x, window.innerWidth - x) +
    Math.max(y, window.innerHeight - y) * Math.max(y, window.innerHeight - y)
  ));
  document.documentElement.style.setProperty('--ripple-x', x + 'px');
  document.documentElement.style.setProperty('--ripple-y', y + 'px');
  document.documentElement.style.setProperty('--ripple-radius', maxRadius + 'px');

  function applyTheme() {
    localStorage.setItem('cds_theme', next);
    if (next === 'light') {
      document.documentElement.dataset.theme = 'light';
    } else {
      delete document.documentElement.dataset.theme;
    }
    // swap icon for the sidebar button (sun ↔ moon). The header theme
    // button uses a static SVG that doesn't need updating because it's
    // already animated via CSS on theme change.
    var icon = document.getElementById('projectsThemeIcon');
    if (icon) {
      if (next === 'light') {
        icon.innerHTML = '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>';
        icon.setAttribute('fill', 'currentColor');
        icon.removeAttribute('stroke');
      } else {
        icon.innerHTML = '<circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="4.22" x2="19.78" y2="5.64"/>';
        icon.setAttribute('fill', 'none');
        icon.setAttribute('stroke', 'currentColor');
      }
    }
  }

  if (document.startViewTransition) {
    var transition = document.startViewTransition(function () {
      document.documentElement.classList.add('vt-snapshotting');
      applyTheme();
    });
    transition.ready.then(function () {
      document.documentElement.classList.remove('vt-snapshotting');
    }).catch(function () {
      document.documentElement.classList.remove('vt-snapshotting');
    });
  } else {
    applyTheme();
  }
}
// Initialize icon to reflect current state on page load
(function () {
  var btn = document.getElementById('projectsThemeBtn');
  var icon = document.getElementById('projectsThemeIcon');
  if (!icon) return;
  if (document.documentElement.dataset.theme === 'light') {
    icon.innerHTML = '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>';
    icon.setAttribute('fill', 'currentColor');
    icon.removeAttribute('stroke');
  }
}());

// ── CDS-wide settings (moved here from branch-list app.js) ─────────
// Theme toggle — reuses the ripple-aware _projectsToggleTheme. Passes
// the actual click target so the clip-path ripple radiates from the
// specific button the user pressed (header vs sidebar).
window.toggleTheme = function (event) {
  var btn = (event && (event.currentTarget || event.target))
    || document.getElementById('themeToggleBtn')
    || document.getElementById('projectsThemeBtn');
  _projectsToggleTheme(btn);
};

// Lightweight toast helper mirroring the one inside the IIFE. Used only by
// the global-settings handlers since showToast inside the IIFE isn't in
// scope here.
function _plSettingsToast(message) {
  var el = document.getElementById('toast');
  if (!el) return;
  el.textContent = message;
  el.classList.remove('hidden');
  clearTimeout(_plSettingsToast._t);
  _plSettingsToast._t = setTimeout(function () { el.classList.add('hidden'); }, 3200);
}

var _plSettingsOpen = false;
function toggleProjectListSettingsMenu(event) {
  event.stopPropagation();
  if (_plSettingsOpen) { closeProjectListSettingsMenu(); return; }
  _plSettingsOpen = true;
  var menu = document.createElement('div');
  menu.className = 'settings-menu';
  menu.id = 'pl-settings-menu';
  menu.onclick = function (e) { e.stopPropagation(); };
  // 2026-04-22：改用 settings-menu-item class + SVG 图标（GitHub Octicons），
  // 不再用 emoji + 内联样式。和分支列表页 ⚙ 菜单风格完全一致
  // （见 app.js toggleSettingsMenu 的 innerHTML）。
  menu.innerHTML = [
    '<div class="settings-menu-item" onclick="closeProjectListSettingsMenu(); cdsOpenSelfUpdate()">',
    '  <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M8 2.5a5.487 5.487 0 00-4.131 1.869l1.204 1.204A.25.25 0 014.896 6H1.25A.25.25 0 011 5.75V2.104a.25.25 0 01.427-.177l1.38 1.38A7.002 7.002 0 0115 8a.75.75 0 01-1.5 0A5.5 5.5 0 008 2.5zM2.5 8a.75.75 0 00-1.5 0 7.002 7.002 0 0012.023 4.87l1.38 1.38a.25.25 0 00.427-.177V10.5a.25.25 0 00-.25-.25h-3.646a.25.25 0 00-.177.427l1.204 1.204A5.5 5.5 0 012.5 8z"/></svg>',
    '  CDS 自动更新',
    '</div>',
    // Bootstrap-equivalent Agent Key (cdsg_*)：比 per-card 的项目 key 更高权限，
    // 放在 self-update 旁边但不突出视觉。
    '<div class="settings-menu-item" onclick="closeProjectListSettingsMenu(); cdsOpenGlobalAgentKeyManager()">',
    '  <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M10.5 0a5.499 5.499 0 1 1-1.288 10.848l-.932.932a.749.749 0 0 1-.53.22H7v.75a.749.749 0 0 1-.22.53l-.5.5a.749.749 0 0 1-.53.22H5v.75a.749.749 0 0 1-.22.53l-.5.5a.749.749 0 0 1-.53.22h-2A1.75 1.75 0 0 1 0 14.25v-2c0-.199.079-.389.22-.53l4.932-4.932A5.5 5.5 0 0 1 10.5 0Zm0 1.5a4.002 4.002 0 0 0-3.923 4.802.75.75 0 0 1-.206.701L1.5 12.561v1.689c0 .138.112.25.25.25h1.689l.31-.31V13a.75.75 0 0 1 .75-.75h1.19l.31-.31V11a.75.75 0 0 1 .75-.75h1.19l1.371-1.371a.751.751 0 0 1 .701-.206A4 4 0 1 0 10.5 1.5Zm1 2.5a1 1 0 1 1 0 2 1 1 0 0 1 0-2Z"/></svg>',
    '  Agent 全局通行证',
    '</div>',
    '<div class="settings-menu-item" onclick="closeProjectListSettingsMenu(); cdsOpenClusterModal()">',
    '  <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M5 2.75a2.25 2.25 0 114.5 0 2.25 2.25 0 01-4.5 0zM7.25 0a2.75 2.75 0 00-.75 5.397V7H2.75A1.75 1.75 0 001 8.75v1.603a2.75 2.75 0 101.5 0V8.75a.25.25 0 01.25-.25H6.5v1.397a2.75 2.75 0 101.5 0V8.5h3.75a.25.25 0 01.25.25v1.603a2.75 2.75 0 101.5 0V8.75A1.75 1.75 0 0011.75 7H8V5.397A2.75 2.75 0 007.25 0zM2.5 13a1.25 1.25 0 112.5 0 1.25 1.25 0 01-2.5 0zM8.5 13a1.25 1.25 0 112.5 0 1.25 1.25 0 01-2.5 0zm4.75-1.25a1.25 1.25 0 100 2.5 1.25 1.25 0 000-2.5z"/></svg>',
    '  集群',
    '</div>',
    '<div class="settings-menu-divider"></div>',
    '<div class="settings-menu-group-label">快捷 · CDS 全局开关</div>',
    '<div class="settings-menu-item settings-menu-switch" onclick="cdsCyclePreviewMode()">',
    '  <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M1.679 7.932c.412-.621 1.242-1.75 2.366-2.717C5.175 4.242 6.527 3.5 8 3.5c1.473 0 2.824.742 3.955 1.715 1.124.967 1.954 2.096 2.366 2.717a.119.119 0 010 .136c-.412.621-1.242 1.75-2.366 2.717C10.825 11.758 9.473 12.5 8 12.5c-1.473 0-2.824-.742-3.955-1.715C2.92 9.818 2.09 8.689 1.679 8.068a.119.119 0 010-.136zM8 2c-1.981 0-3.67.992-4.933 2.078C1.797 5.169.88 6.423.43 7.1a1.619 1.619 0 000 1.798c.45.678 1.367 1.932 2.637 3.024C4.329 13.008 6.019 14 8 14c1.981 0 3.67-.992 4.933-2.078 1.27-1.091 2.187-2.345 2.637-3.023a1.619 1.619 0 000-1.798c-.45-.678-1.367-1.932-2.637-3.024C11.671 2.992 9.981 2 8 2z"/><path d="M8 10a2 2 0 100-4 2 2 0 000 4z"/></svg>',
    '  <span class="settings-menu-switch-label">预览模式</span>',
    '  <span id="pl-preview-mode-label" style="font-size:11px;color:var(--blue);font-weight:500"></span>',
    '</div>',
    '<div class="settings-menu-item settings-menu-switch" onclick="cdsToggleMirror()">',
    '  <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M13 2.5a.5.5 0 01.5.5v8a.5.5 0 01-.5.5h-2.086a1 1 0 00-.707.293l-1.5 1.5a.5.5 0 01-.707 0l-1.5-1.5A1 1 0 005.793 11.5H3.5a.5.5 0 01-.5-.5V3a.5.5 0 01.5-.5h9.5zM3.5 1A1.5 1.5 0 002 2.5v9A1.5 1.5 0 003.5 13h2.293l1.5 1.5a1.5 1.5 0 002.121 0l1.5-1.5h2.086A1.5 1.5 0 0014.5 11.5v-9A1.5 1.5 0 0013 1H3.5z"/></svg>',
    '  <span class="settings-menu-switch-label">镜像加速</span>',
    '  <span class="settings-switch" id="pl-mirror-switch">',
    '    <span class="settings-switch-track"><span class="settings-switch-thumb"></span></span>',
    '  </span>',
    '</div>',
    '<div class="settings-menu-item settings-menu-switch" onclick="cdsToggleTabTitle()">',
    '  <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M0 4.75C0 3.784.784 3 1.75 3h12.5c.966 0 1.75.784 1.75 1.75v6.5A1.75 1.75 0 0114.25 13H1.75A1.75 1.75 0 010 11.25v-6.5zm1.75-.25a.25.25 0 00-.25.25v6.5c0 .138.112.25.25.25h12.5a.25.25 0 00.25-.25v-6.5a.25.25 0 00-.25-.25H1.75z"/></svg>',
    '  <span class="settings-menu-switch-label">浏览器标签名</span>',
    '  <span class="settings-switch" id="pl-tabtitle-switch">',
    '    <span class="settings-switch-track"><span class="settings-switch-thumb"></span></span>',
    '  </span>',
    '</div>',
    '<div class="settings-menu-divider"></div>',
    '<div class="settings-menu-item danger" onclick="closeProjectListSettingsMenu(); cdsFactoryReset()">',
    '  <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M8.982 1.566a1.13 1.13 0 00-1.96 0L.165 13.233c-.457.778.091 1.767.98 1.767h13.713c.889 0 1.438-.99.98-1.767L8.982 1.566zM8 5c.535 0 .954.462.9.995l-.35 3.507a.552.552 0 01-1.1 0L7.1 5.995A.905.905 0 018 5zm.002 6a1 1 0 110 2 1 1 0 010-2z"/></svg>',
    '  恢复出厂设置',
    '</div>',
    '<div class="settings-menu-item" onclick="closeProjectListSettingsMenu(); cdsDoLogout()">',
    '  <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M2 2.75C2 1.784 2.784 1 3.75 1h2.5a.75.75 0 010 1.5h-2.5a.25.25 0 00-.25.25v10.5c0 .138.112.25.25.25h2.5a.75.75 0 010 1.5h-2.5A1.75 1.75 0 012 13.25V2.75zm10.44 4.5L10.97 5.78a.75.75 0 111.06-1.06l2.75 2.75a.75.75 0 010 1.06l-2.75 2.75a.75.75 0 11-1.06-1.06l1.47-1.47H6.75a.75.75 0 010-1.5h5.69z"/></svg>',
    '  退出登录',
    '</div>',
  ].join('');
  document.body.appendChild(menu);
  var rect = event.currentTarget.getBoundingClientRect();
  menu.style.top = (rect.bottom + 6) + 'px';
  menu.style.right = (window.innerWidth - rect.right) + 'px';
  menu.style.minWidth = '220px';
  setTimeout(function () {
    document.addEventListener('click', closeProjectListSettingsMenu, { once: true });
  }, 0);
  _refreshPlSettingsLabels();
}
function closeProjectListSettingsMenu() {
  _plSettingsOpen = false;
  var el = document.getElementById('pl-settings-menu');
  if (el) el.remove();
}
window.toggleProjectListSettingsMenu = toggleProjectListSettingsMenu;
window.closeProjectListSettingsMenu = closeProjectListSettingsMenu;

function _refreshPlSettingsLabels() {
  // Preview mode lives under /api/preview-mode; mirror under /api/mirror;
  // tab-title under /api/tab-title. Keep it cheap: 3 independent GETs so
  // a failure on one doesn't starve the others.
  fetch('/api/preview-mode', { credentials: 'same-origin' })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (d) {
      if (!d) return;
      var pm = d.mode || 'simple';
      var el = document.getElementById('pl-preview-mode-label');
      if (el) el.textContent = ({ simple: '简洁', port: '端口直连', multi: '子域名' })[pm] || pm;
    })
    .catch(function () {});
  fetch('/api/mirror', { credentials: 'same-origin' })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (d) {
      if (!d) return;
      // 2026-04-22：改走 .settings-switch 开关（和分支列表一致），不是文字
      var sw = document.getElementById('pl-mirror-switch');
      if (sw) sw.classList.toggle('on', !!d.enabled);
    })
    .catch(function () {});
  fetch('/api/tab-title', { credentials: 'same-origin' })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (d) {
      if (!d) return;
      var sw = document.getElementById('pl-tabtitle-switch');
      if (sw) sw.classList.toggle('on', !!d.enabled);
    })
    .catch(function () {});
}

// ── Action implementations (copied from app.js fetch calls) ──
async function cdsCyclePreviewMode() {
  try {
    var cur = await fetch('/api/preview-mode', { credentials: 'same-origin' }).then(function (r) { return r.json(); });
    var modes = ['simple', 'port', 'multi'];
    var idx = modes.indexOf(cur.mode || 'simple');
    var next = modes[(idx + 1) % modes.length];
    var res = await fetch('/api/preview-mode', {
      method: 'PUT', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: next }),
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    var labels = { simple: '简洁', port: '端口直连', multi: '子域名' };
    _plSettingsToast('预览模式：' + labels[next]);
    _refreshPlSettingsLabels();
  } catch (e) { _plSettingsToast('切换失败: ' + e.message); }
}

async function cdsToggleMirror() {
  try {
    var cur = await fetch('/api/mirror', { credentials: 'same-origin' }).then(function (r) { return r.json(); });
    var res = await fetch('/api/mirror', {
      method: 'PUT', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: !cur.enabled }),
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    _plSettingsToast(!cur.enabled ? '镜像加速已开启' : '镜像加速已关闭');
    _refreshPlSettingsLabels();
  } catch (e) { _plSettingsToast('切换失败: ' + e.message); }
}

async function cdsToggleTabTitle() {
  try {
    var cur = await fetch('/api/tab-title', { credentials: 'same-origin' }).then(function (r) { return r.json(); });
    var res = await fetch('/api/tab-title', {
      method: 'PUT', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: !cur.enabled }),
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    _plSettingsToast(!cur.enabled ? '标签页标题已开启' : '标签页标题已关闭');
    _refreshPlSettingsLabels();
  } catch (e) { _plSettingsToast('切换失败: ' + e.message); }
}

async function cdsOpenSelfUpdate() {
  // 2026-04-19 统一: 分支列表页和项目列表页 collapse 到同一个
  // web/self-update.js 的 openSelfUpdateModal() —— 支持搜索 / 粘贴 /
  // 强制同步,并且粘性底部按钮解决之前被截断的问题。
  //
  // 先尝试全局模块;未加载时回退到原内置实现,保证刷新不完全的客户端
  // 也能继续工作。
  if (typeof window.openSelfUpdateModal === 'function') {
    return window.openSelfUpdateModal();
  }
  // ── Legacy fallback (极少触发:self-update.js 没加载时才走这里) ──
  const escapeHtml = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
  let info;
  try {
    const r = await fetch('/api/self-branches', { credentials: 'same-origin' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    info = await r.json();
  } catch (e) {
    _plSettingsToast('获取分支列表失败: ' + e.message);
    return;
  }
  const current = info.current || '';
  const commitHash = (info.commitHash || '').slice(0, 8);
  const branches = Array.isArray(info.branches) ? info.branches : [];

  const backdrop = document.createElement('div');
  backdrop.style.cssText = 'position:fixed;inset:0;background:rgba(3,7,18,0.55);backdrop-filter:blur(4px);z-index:10000;display:flex;align-items:center;justify-content:center;padding:24px';
  backdrop.onclick = () => { if (document.body.contains(backdrop)) document.body.removeChild(backdrop); };

  const dlg = document.createElement('div');
  dlg.style.cssText = 'background:var(--bg-card);border:1px solid var(--card-border);border-radius:10px;width:min(520px,calc(100vw - 32px));max-height:82vh;display:flex;flex-direction:column;overflow:hidden;box-shadow:0 24px 60px rgba(0,0,0,.55)';
  dlg.onclick = (e) => e.stopPropagation();

  // Sort branches: current first, then alphabetical
  const sorted = [current, ...branches.filter(b => b && b !== current).sort()];
  const options = sorted.map(b =>
    '<option value="' + escapeHtml(b) + '"' + (b === current ? ' selected' : '') + '>' +
    escapeHtml(b) + (b === current ? ' （当前）' : '') +
    '</option>'
  ).join('');

  dlg.innerHTML = [
    '<div style="flex-shrink:0;padding:14px 18px;border-bottom:1px solid var(--card-border);display:flex;align-items:center;justify-content:space-between">',
    '  <div style="font-size:14px;font-weight:700">🔄 CDS 系统更新</div>',
    '  <button id="_plSuClose" style="width:26px;height:26px;border-radius:6px;border:1px solid var(--card-border);background:transparent;color:var(--text-muted);cursor:pointer">×</button>',
    '</div>',
    '<div style="flex:1;min-height:0;overflow-y:auto;padding:16px 18px">',
    '  <div style="font-size:12px;color:var(--text-secondary);margin-bottom:12px;line-height:1.6">',
    '    拉取目标分支最新代码并重启 CDS。流程 <code>git fetch → checkout → pull → tsc 预检 → restart</code>',
    '  </div>',
    '  <div style="font-size:12px;color:var(--text-secondary);margin-bottom:4px">当前分支</div>',
    '  <div style="font-family:monospace;font-size:13px;color:var(--accent);margin-bottom:14px">',
    escapeHtml(current) + (commitHash ? ' <span style="color:var(--text-muted);font-size:11px">@ ' + escapeHtml(commitHash) + '</span>' : ''),
    '  </div>',
    '  <label style="display:block;font-size:12px;color:var(--text-secondary);margin-bottom:4px">目标分支（' + branches.length + ' 个可选）</label>',
    '  <select id="_plSuBranch" style="width:100%;padding:8px 10px;border-radius:6px;border:1px solid var(--card-border);background:var(--bg-base);color:var(--text-primary);font-family:monospace;font-size:12px;margin-bottom:14px">',
    options,
    '  </select>',
    '  <div id="_plSuProgress" style="display:none;margin-top:12px;border:1px solid var(--card-border);border-radius:6px;padding:10px;background:var(--bg-base);font-family:monospace;font-size:11px;max-height:240px;overflow-y:auto;line-height:1.55"></div>',
    '  <div id="_plSuStatus" style="margin-top:8px;font-size:12px;color:var(--text-muted);min-height:14px"></div>',
    '</div>',
    '<div style="flex-shrink:0;padding:12px 18px;border-top:1px solid var(--card-border);display:flex;gap:8px;justify-content:space-between;align-items:center;flex-wrap:wrap">',
    '  <button id="_plSuForce" title="git fetch + reset --hard origin/<branch> + 清 dist 缓存 + restart. 用于 self-update 因本地分叉 merge 而丢远端改动时救急" style="padding:7px 12px;border-radius:6px;border:1px solid rgba(245,158,11,0.4);background:transparent;color:var(--amber,#f59e0b);cursor:pointer;font-size:12px">💥 强制同步 (hard-reset)</button>',
    '  <div style="display:flex;gap:8px">',
    '    <button id="_plSuCancel" style="padding:7px 14px;border-radius:6px;border:1px solid var(--card-border);background:transparent;color:var(--text-primary);cursor:pointer;font-size:12px">取消</button>',
    '    <button id="_plSuGo" style="padding:7px 14px;border-radius:6px;border:none;background:var(--accent,#10b981);color:#fff;cursor:pointer;font-size:12px;font-weight:600">拉取并重启</button>',
    '  </div>',
    '</div>',
  ].join('');

  backdrop.appendChild(dlg);
  document.body.appendChild(backdrop);

  const close = () => { if (document.body.contains(backdrop)) document.body.removeChild(backdrop); };
  dlg.querySelector('#_plSuClose').onclick = close;
  dlg.querySelector('#_plSuCancel').onclick = close;
  const esc = (ev) => { if (ev.key === 'Escape') { close(); document.removeEventListener('keydown', esc); } };
  document.addEventListener('keydown', esc);

  // Shared SSE runner — both 拉取并重启 (self-update) and 强制同步
  // (self-force-sync) stream the same {event, data:{step,status,title}}
  // envelope. Extracted so the "Force" button reuses all the UI glue.
  async function runSelfSync(endpoint, label) {
    const target = dlg.querySelector('#_plSuBranch').value;
    const progress = dlg.querySelector('#_plSuProgress');
    const status = dlg.querySelector('#_plSuStatus');
    const goBtn = dlg.querySelector('#_plSuGo');
    const forceBtn = dlg.querySelector('#_plSuForce');
    goBtn.disabled = true;
    forceBtn.disabled = true;
    goBtn.textContent = label + '中…';
    progress.style.display = 'block';
    progress.innerHTML = '';
    status.textContent = '连接 ' + endpoint + ' …';

    let resp;
    try {
      resp = await fetch(endpoint, {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ branch: target }),
      });
    } catch (e) {
      status.innerHTML = '<span style="color:var(--red)">✗ ' + escapeHtml(e.message) + '</span>';
      goBtn.disabled = false;
      forceBtn.disabled = false;
      goBtn.textContent = '重试';
      return;
    }
    if (!resp.ok) {
      status.innerHTML = '<span style="color:var(--red)">✗ HTTP ' + resp.status + '</span>';
      goBtn.disabled = false;
      forceBtn.disabled = false;
      goBtn.textContent = '重试';
      return;
    }

    // 解析 SSE 流：event: step / done / error，data: JSON
    const reader = resp.body && resp.body.getReader ? resp.body.getReader() : null;
    if (!reader) {
      status.textContent = '浏览器不支持流式读取，已触发更新，稍后 CDS 会自动重启';
      return;
    }
    const decoder = new TextDecoder();
    let buf = '';
    let curEvent = '';
    let done = false;
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
              const color = d.status === 'done' ? 'var(--green)'
                : d.status === 'error' ? 'var(--red)'
                : d.status === 'warning' ? 'var(--amber,#f59e0b)'
                : curEvent === 'done' ? 'var(--green)'
                : curEvent === 'error' ? 'var(--red)'
                : 'var(--text-secondary)';
              progress.innerHTML += '<div style="color:' + color + '">[' + escapeHtml(stepLabel) + '] ' + escapeHtml(title) + '</div>';
              progress.scrollTop = progress.scrollHeight;
              if (curEvent === 'done') {
                status.innerHTML = '<span style="color:var(--green)">✓ ' + label + '已触发，CDS 正在重启… 5s 后自动刷新页面</span>';
                done = true;
                setTimeout(() => location.reload(), 5000);
              }
              if (curEvent === 'error') {
                status.innerHTML = '<span style="color:var(--red)">✗ ' + escapeHtml(title) + '</span>';
                goBtn.disabled = false;
                forceBtn.disabled = false;
                goBtn.textContent = '重试';
                done = true;
              }
            } catch { /* JSON 解析失败跳过 */ }
          }
        }
      } catch {
        // 流被 CDS 重启中断，正常情况
        break;
      }
    }
    // Stream ended without an explicit `done` event — almost always
    // because CDS's restart killed the SSE mid-flight. Show a "正在
    // 重启" state and poll /healthz until CDS responds, then reload.
    // Without this fallback the button stays "更新中…" forever.
    if (!done) {
      status.innerHTML = '<span style="color:var(--amber,#f59e0b)">⌛ CDS 正在重启，等待端口就绪…</span>';
      goBtn.textContent = '等待重启';
      var tries = 0;
      var poll = function () {
        tries++;
        fetch('/healthz', { credentials: 'same-origin', cache: 'no-store' })
          .then(function (r) { return r.ok ? r.json() : null; })
          .then(function (h) {
            if (h && h.ok) {
              status.innerHTML = '<span style="color:var(--green)">✓ CDS 已重启,刷新页面...</span>';
              setTimeout(function () { location.reload(); }, 600);
            } else if (tries < 40) {
              setTimeout(poll, 1500);
            } else {
              status.innerHTML = '<span style="color:var(--red)">✗ 重启超时,请手动刷新页面确认</span>';
              goBtn.disabled = false;
              forceBtn.disabled = false;
              goBtn.textContent = '重试';
            }
          })
          .catch(function () { if (tries < 40) setTimeout(poll, 1500); });
      };
      setTimeout(poll, 2000);
    }
  }

  dlg.querySelector('#_plSuGo').onclick = () => runSelfSync('/api/self-update', '更新');
  dlg.querySelector('#_plSuForce').onclick = () => {
    if (!window.confirm(
      '💥 强制同步会丢弃 host 上所有本地未推送的提交,硬重置到 origin/<当前选中分支>,再清 dist 缓存 + 重启。\n\n用于 self-update 的 git pull 合并错误导致代码没更新的场景。\n\n确定继续?'
    )) return;
    runSelfSync('/api/self-force-sync', '强制同步');
  };
}

function cdsOpenClusterModal() {
  // v1 placeholder: direct users to the full cluster UI on branch-list.
  alert('集群管理在分支页的齿轮菜单里：访问控制台（/branch-list）查看与配置集群。');
}

async function cdsFactoryReset() {
  if (!confirm('[警告] 恢复出厂设置\n\n将清除所有：分支、构建配置、环境变量、基础设施服务、路由规则。\nDocker 数据卷（数据库文件等）会保留。\n\n确定继续？')) return;
  if (!confirm('二次确认：所有配置将被清空，此操作不可撤销。')) return;
  try {
    var res = await fetch('/api/factory-reset', { method: 'POST', credentials: 'same-origin' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    // drain the NDJSON stream
    var reader = res.body && res.body.getReader ? res.body.getReader() : null;
    if (reader) { while (!(await reader.read()).done) {} }
    _plSettingsToast('已恢复出厂设置');
  } catch (e) { _plSettingsToast('重置失败: ' + e.message); }
}

async function cdsDoLogout() {
  try { await fetch('/api/logout', { method: 'POST', credentials: 'same-origin' }); } catch (e) { /* ignore */ }
  location.href = '/login.html';
}

window.cdsCyclePreviewMode = cdsCyclePreviewMode;
window.cdsToggleMirror = cdsToggleMirror;
window.cdsToggleTabTitle = cdsToggleTabTitle;
window.cdsOpenSelfUpdate = cdsOpenSelfUpdate;
window.cdsOpenClusterModal = cdsOpenClusterModal;
window.cdsFactoryReset = cdsFactoryReset;
window.cdsDoLogout = cdsDoLogout;

(function () {
  'use strict';

  // 注入项目卡 actions 容器样式 — 三个图标按钮统一在右上角，默认隐藏，
  // hover 整张卡时一起显示。delete 用红色描边强调危险，icon 走深红填充
  // 在浅红背景上保证对比度可见（之前 fill 也是 #f43f5e 跟背景同色看不见）。
  (function () {
    if (document.getElementById('cds-cardactions-patch')) return;
    var s = document.createElement('style');
    s.id = 'cds-cardactions-patch';
    s.textContent =
      '.cds-project-card-wrapper{position:relative}' +
      '.cds-project-card-actions{' +
        'position:absolute;top:10px;right:10px;' +
        'display:flex;align-items:center;gap:6px;' +
        'opacity:0;pointer-events:none;' +
        'transition:opacity .15s ease;z-index:2}' +
      '.cds-project-card-wrapper:hover .cds-project-card-actions,' +
      '.cds-project-card-wrapper:focus-within .cds-project-card-actions{' +
        'opacity:1;pointer-events:auto}' +
      '.cds-project-card-action-btn{' +
        'width:26px;height:26px;border-radius:6px;' +
        'border:1px solid var(--card-border);' +
        'background:var(--bg-card);color:var(--text-secondary);' +
        'cursor:pointer;display:inline-flex;align-items:center;' +
        'justify-content:center;padding:0;' +
        'transition:background 120ms ease,border-color 120ms ease,color 120ms ease}' +
      '.cds-project-card-action-btn svg{width:13px;height:13px}' +
      '.cds-project-card-action-btn:hover{' +
        'background:var(--bg-elevated);color:var(--text-primary)}' +
      '.cds-project-card-action-btn.danger{' +
        'background:rgba(244,63,94,0.10);' +
        'border-color:rgba(244,63,94,0.32);' +
        'color:#f43f5e}' +
      '.cds-project-card-action-btn.danger:hover{' +
        'background:rgba(244,63,94,0.22);' +
        'border-color:rgba(244,63,94,0.55);' +
        'color:#fff}' +
      /* 触摸设备没 hover，常驻显示避免按钮藏起来 */
      '@media (hover:none){' +
        '.cds-project-card-actions{opacity:1;pointer-events:auto}}' +
      /* Header 右侧 GitHub mini link — 小图标 + 短 repo 名，比独立 chip 克制 */
      '.cds-card-gh-link{' +
        'display:inline-flex;align-items:center;gap:5px;' +
        'padding:2px 7px;border-radius:5px;' +
        'font-size:11px;font-weight:500;' +
        'color:var(--text-muted);' +
        'background:transparent;cursor:pointer;' +
        'transition:color 120ms ease,background 120ms ease}' +
      '.cds-card-gh-link:hover{color:var(--text-primary);background:var(--bg-elevated)}' +
      '.cds-card-gh-link svg{width:11px;height:11px;flex-shrink:0;opacity:0.85}' +
      '.cds-card-gh-name{max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
      /* 极简 footer：单行 `production · 5 services · 3 running`，参考 Railway 风格 */
      '.cds-project-card-foot{' +
        'display:flex;align-items:center;gap:6px;' +
        'font-size:12px;color:var(--text-muted);' +
        'padding-top:2px}' +
      '.cds-foot-sep{color:var(--text-muted);opacity:0.45;font-size:10px}' +
      '.cds-running-count{color:var(--text-secondary)}' +
      '.cds-running-count.is-live{color:var(--green,#10b981);font-weight:500}' +
      '.cds-project-card-clone-foot{padding-top:6px}';
    document.head.appendChild(s);
  }());

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
      color: '#47A248',
      svg: '<path d="M17.193 9.555c-1.264-5.58-4.252-7.414-4.573-8.115-.28-.394-.53-.954-.735-1.44-.036.495-.055.685-.523 1.184-.723.566-4.438 3.682-4.74 10.02-.282 5.912 4.27 9.435 4.888 9.884l.07.05A73.49 73.49 0 0111.91 24h.481c.114-1.032.284-2.056.51-3.07.417-.296.604-.463.85-.693a11.342 11.342 0 003.639-8.464c.01-.814-.103-1.662-.197-2.218zm-5.336 8.195s0-8.291.275-8.29c.213 0 .49 10.695.49 10.695-.381-.045-.765-1.76-.765-2.405z"/>',
    },
    redis: {
      color: '#FF4438',
      svg: '<path d="M22.71 13.145c-1.66 2.092-3.452 4.483-7.038 4.483-3.203 0-4.397-2.825-4.48-5.12.701 1.484 2.073 2.685 4.214 2.63 4.117-.133 6.94-3.852 6.94-7.239 0-4.05-3.022-6.972-8.268-6.972-3.752 0-8.4 1.428-11.455 3.685C2.59 6.937 3.885 9.958 4.35 9.626c2.648-1.904 4.748-3.13 6.784-3.744C8.12 9.244.886 17.05 0 18.425c.1 1.261 1.66 4.648 2.424 4.648.232 0 .431-.133.664-.365a100.49 100.49 0 0 0 5.54-6.765c.222 3.104 1.748 6.898 6.014 6.898 3.819 0 7.604-2.756 9.33-8.965.2-.764-.73-1.361-1.261-.73zm-4.349-5.013c0 1.959-1.926 2.922-3.685 2.922-.941 0-1.664-.247-2.235-.568 1.051-1.592 2.092-3.225 3.21-4.973 1.972.334 2.71 1.43 2.71 2.619z"/>',
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
      color: '#5FA04E',
      svg: '<path d="M11.998 24c-.321 0-.641-.084-.922-.247l-2.936-1.737c-.438-.245-.224-.332-.08-.383.585-.203.703-.25 1.328-.604.065-.037.151-.023.218.017l2.256 1.339c.082.045.197.045.272 0l8.795-5.076c.082-.047.134-.141.134-.238V6.921c0-.099-.053-.192-.137-.242l-8.791-5.072c-.081-.047-.189-.047-.271 0L3.075 6.68C2.99 6.729 2.936 6.825 2.936 6.921v10.15c0 .097.054.189.139.235l2.409 1.392c1.307.654 2.108-.116 2.108-.89V7.787c0-.142.114-.253.256-.253h1.115c.139 0 .255.112.255.253v10.021c0 1.745-.95 2.745-2.604 2.745-.508 0-.909 0-2.026-.551L2.28 18.675c-.57-.329-.922-.945-.922-1.604V6.921c0-.659.353-1.275.922-1.603l8.795-5.082c.557-.315 1.296-.315 1.848 0l8.794 5.082c.57.329.924.944.924 1.603v10.15c0 .659-.354 1.273-.924 1.604l-8.794 5.078C12.643 23.916 12.324 24 11.998 24zm2.692-6.993c-3.703 0-4.469-1.097-4.469-2.014 0-.141.113-.253.254-.253h1.137c.126 0 .233.091.253.215.172 1.158.684 1.742 3.011 1.742 1.853 0 2.642-.419 2.642-1.402 0-.566-.223-.987-3.103-1.269-2.407-.238-3.895-.77-3.895-2.695 0-1.775 1.496-2.833 4.004-2.833 2.817 0 4.211.978 4.388 3.076.007.073-.019.142-.067.196a.26.26 0 0 1-.186.081h-1.141a.253.253 0 0 1-.247-.199c-.274-1.218-.94-1.607-2.747-1.607-2.023 0-2.258.705-2.258 1.233 0 .639.278.826 3.009 1.187 2.703.357 3.987.863 3.987 2.763-.016 1.917-1.614 3.014-4.573 3.014z"/>',
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
      svg: '<path d="M12 0L1.605 6v12L12 24l10.395-6V6L12 0zm6 16.59c0 .705-.646 1.29-1.529 1.29-.631 0-1.351-.255-1.801-.81l-6-7.141v6.66c0 .721-.57 1.29-1.274 1.29H7.32c-.721 0-1.29-.6-1.29-1.29V7.41c0-.705.63-1.29 1.5-1.29.646 0 1.38.255 1.83.81l5.97 7.141V7.41c0-.721.6-1.29 1.29-1.29h.075c.72 0 1.29.6 1.29 1.29v9.18H18z"/>',
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

  // ── Roll-up stats strip ─────────────────────────────────────────
  //
  // Reads {branchCount, runningBranchCount, runningServiceCount,
  // lastDeployedAt} from the /api/projects summary (see routes/projects.ts
  // ProjectStats). Renders three pill-shaped chips:
  //   • N 分支   — total branches in this project
  //   • M 运行中 — live if any service is running (green pulse dot)
  //   • 最近部署 X — lastAccessedAt of most-recently-deployed branch
  // Returns empty string when the project has no stats (e.g. freshly
  // created from the legacy fallback path) so the layout collapses.
  function renderStatsStrip(project) {
    var bc = typeof project.branchCount === 'number' ? project.branchCount : null;
    if (bc === null) return '';
    var rsc = project.runningServiceCount || 0;
    var runningClass = rsc > 0 ? 'cds-stat cds-stat-running' : 'cds-stat cds-stat-idle';
    var dotClass = rsc > 0 ? 'live-dot pulsing' : 'live-dot';
    var lastLabel = project.lastDeployedAt
      ? '最近部署 ' + formatRelative(project.lastDeployedAt)
      : '尚未部署';
    // GitHub link chip — same pill style as the other stats so the strip
    // stays homogeneous. CANNOT use a nested <a> (the whole card is already
    // an <a>; nested <a> is invalid HTML and browsers silently close the
    // outer <a>, breaking the card layout — the chip renders as a huge
    // circle). Use <span> + onclick that calls window.open.
    var ghChip = '';
    if (project.githubRepoFullName) {
      var repo = project.githubRepoFullName;
      // Strict GitHub repo name pattern: owner/repo where each side is
      // [A-Za-z0-9._-]+. GitHub's actual rules are a bit more lenient
      // but this covers every real repo and rejects anything containing
      // shell/JS meta-characters. If a malicious state.json gets a
      // crafted repoFullName (e.g. "owner/x'+alert(1)+'"), we refuse
      // to render the chip rather than inject it into an onclick JS
      // literal. Caught by Cursor Bugbot #450 round 5.
      if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(repo)) {
        ghChip = '';
      } else {
      var autoOff = project.githubAutoDeploy === false;
      var ghTitle = autoOff
        ? 'GitHub: ' + repo + ' (自动部署已关闭)'
        : 'GitHub: ' + repo + ' (push 自动部署)';
      // Build the URL with encodeURIComponent on each path segment —
      // unlike encodeURI, encodeURIComponent encodes single quotes
      // (`%27`), eliminating the onclick JS-string-literal injection.
      var ghUrl = 'https://github.com/' + repo.split('/').map(encodeURIComponent).join('/');
      ghChip =
        '<span class="cds-stat cds-stat-github" role="link" tabindex="0"' +
          ' onclick="event.preventDefault();event.stopPropagation();window.open(\'' + escapeHtml(ghUrl).replace(/'/g, '&#39;') + '\',\'_blank\',\'noopener\')"' +
          ' title="' + escapeHtml(ghTitle) + '"' +
          ' style="cursor:pointer' + (autoOff ? ';opacity:0.55' : '') + '">' +
          '<svg viewBox="0 0 16 16" fill="currentColor" style="width:12px;height:12px;flex-shrink:0"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>' +
          escapeHtml(repo.split('/').slice(-1)[0] || repo) +
          (autoOff ? ' <span style="opacity:0.7">(off)</span>' : '') +
        '</span>';
      }
    }
    return [
      '<div class="cds-card-stats">',
      '  <span class="cds-stat" title="分支总数">',
      '    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">',
      '      <line x1="6" y1="3" x2="6" y2="15"/>',
      '      <circle cx="18" cy="6" r="3"/>',
      '      <circle cx="6" cy="18" r="3"/>',
      '      <path d="M18 9a9 9 0 0 1-9 9"/>',
      '    </svg>',
      '    <strong>' + bc + '</strong> 分支',
      '  </span>',
      '  <span class="' + runningClass + '" title="运行中的服务数量">',
      '    <span class="' + dotClass + '"></span>',
      '    <strong>' + rsc + '</strong> 运行中',
      '  </span>',
      '  <span class="cds-stat" title="最近一次部署时间">',
      '    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">',
      '      <circle cx="12" cy="12" r="9"/>',
      '      <polyline points="12 7 12 12 15 14"/>',
      '    </svg>',
      '    ' + escapeHtml(lastLabel),
      '  </span>',
      ghChip,
      '</div>',
    ].join('');
  }

  // Clear "→ 进入分支" affordance. The whole card is already a link
  // so this is purely visual reinforcement — many users miss that the
  // card is clickable when the only thing in the foot is a service
  // count. Slides right on hover (see .cds-project-card:hover rule).
  function renderEnterCta() {
    return [
      '<span class="cds-enter-cta">',
      '  进入分支',
      '  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">',
      '    <line x1="5" y1="12" x2="19" y2="12"/>',
      '    <polyline points="12 5 19 12 12 19"/>',
      '  </svg>',
      '</span>',
    ].join('');
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

  // P4 Part 18 (G1.7): render the clone lifecycle badge next to the
  // card title. Legacy projects (no cloneStatus at all) show the
  // existing "Legacy" pill instead; G1 projects show one of four:
  //   pending  — waiting for user to kick off the clone
  //   cloning  — SSE in progress
  //   ready    — clone finished, usable for deploy
  //   error    — last clone attempt failed (hover → cloneError)
  //
  // GitHub link badge for bound projects lives inside renderStatsStrip
  // (cds-stat-github chip). The old standalone renderGithubBadge helper
  // was removed after the strip-integrated version replaced it.
  function renderCloneBadge(project) {
    if (project.legacyFlag) {
      return '<span class="cds-legacy-badge">Legacy</span>';
    }
    if (!project.cloneStatus) {
      return '';
    }
    var label = {
      pending: 'PENDING',
      cloning: 'CLONING',
      ready: 'READY',
      error: 'ERROR',
    }[project.cloneStatus] || project.cloneStatus.toUpperCase();
    var spinner = project.cloneStatus === 'cloning'
      ? '<span class="spinner"></span>'
      : '';
    var title = project.cloneStatus === 'error' && project.cloneError
      ? ' title="' + escapeHtml(project.cloneError) + '"'
      : '';
    return (
      '<span class="cds-clone-status ' + escapeHtml(project.cloneStatus) + '"' + title + '>' +
      spinner + escapeHtml(label) +
      '</span>'
    );
  }

  // Clone / retry button — only present for 'pending' and 'error'.
  // Stops propagation so clicking it doesn't navigate into the card.
  function renderCloneButton(project) {
    if (project.legacyFlag) return '';
    if (project.cloneStatus !== 'pending' && project.cloneStatus !== 'error') return '';
    var label = project.cloneStatus === 'error' ? '重新克隆' : '开始克隆';
    var cls = project.cloneStatus === 'error' ? 'cds-clone-btn retry' : 'cds-clone-btn';
    return (
      '<button class="' + cls + '" ' +
      'onclick="handleCloneProject(event, \'' + escapeHtml(project.id) + '\', \'' + escapeHtml(project.aliasName || project.name) + '\', \'' + escapeHtml(project.gitRepoUrl || '') + '\')">' +
      escapeHtml(label) +
      '</button>'
    );
  }

  // In-flight clone indicator: a skinny yellow bar that replaces the
  // service strip while cloneStatus is pending or cloning, and a red
  // bar for 'error' state. For ready / undefined we render the normal
  // service icons via renderServiceStrip(). See pollProjectsForClone()
  // below for the 5s polling loop that drives the UX auto-transition.
  function renderCloneProgressBar(project) {
    var st = project.cloneStatus;
    if (st === 'pending' || st === 'cloning') {
      var label = st === 'cloning' ? '正在克隆…' : '待克隆';
      return (
        '<div style="height:120px;display:flex;align-items:center;justify-content:center;gap:10px;' +
          'background:rgba(251,191,36,0.08);border:1px dashed rgba(251,191,36,0.45);border-radius:10px;' +
          'color:#fbbf24;font-size:12px;font-weight:600">' +
          '<span class="spinner" style="width:10px;height:10px;border:1.5px solid currentColor;' +
            'border-top-color:transparent;border-radius:50%;animation:cds-spin 700ms linear infinite"></span>' +
          escapeHtml(label) +
        '</div>'
      );
    }
    if (st === 'error') {
      var msg = project.cloneError ? String(project.cloneError) : '克隆失败';
      if (msg.length > 80) msg = msg.slice(0, 80) + '…';
      return (
        '<div style="height:120px;display:flex;align-items:center;justify-content:center;padding:10px 14px;' +
          'background:rgba(244,63,94,0.08);border:1px dashed rgba(244,63,94,0.45);border-radius:10px;' +
          'color:#fca5a5;font-size:11px;font-family:var(--font-mono,monospace);text-align:center;line-height:1.5">' +
          '克隆失败：' + escapeHtml(msg) +
        '</div>'
      );
    }
    return null;
  }

  // 简约 footer：一行 `● production · 5 services · 3 running` 风格。
  // 把原 chips 行的「分支数 / 最近部署 / GitHub repo」信息放到 tooltip
  // 和 header 里，不再单独占一行。
  function renderMinimalFooter(project, totalServices) {
    var rsc = project.runningServiceCount || 0;
    var bc = typeof project.branchCount === 'number' ? project.branchCount : null;
    var lastTip = project.lastDeployedAt
      ? '最近部署 ' + formatRelative(project.lastDeployedAt)
      : '尚未部署';
    var bcTip = bc !== null ? bc + ' 分支' : '';
    var tooltip = [bcTip, lastTip].filter(Boolean).join(' · ');
    var svcLabel = totalServices + ' service' + (totalServices === 1 ? '' : 's');
    var runLabel = rsc + ' running';
    return [
      '<div class="cds-project-card-foot" title="' + escapeHtml(tooltip) + '">',
      '  <span class="cds-env-dot">production</span>',
      '  <span class="cds-foot-sep">·</span>',
      '  <span class="cds-service-count">', svcLabel, '</span>',
      '  <span class="cds-foot-sep">·</span>',
      '  <span class="cds-running-count' + (rsc > 0 ? ' is-live' : '') + '">', runLabel, '</span>',
      '</div>',
    ].join('');
  }

  // 头部右侧 GitHub repo 小标识（仅在 link 存在时显示）。
  // 走 SVG icon + repo short name，不抢眼，参考 Railway / Vercel 风格。
  function renderHeaderGithubLink(project) {
    if (!project.githubRepoFullName) return '';
    var repo = project.githubRepoFullName;
    if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(repo)) return '';
    var autoOff = project.githubAutoDeploy === false;
    var ghTitle = autoOff
      ? 'GitHub: ' + repo + '（自动部署已关闭）'
      : 'GitHub: ' + repo + '（push 自动部署）';
    var ghUrl = 'https://github.com/' + repo.split('/').map(encodeURIComponent).join('/');
    var shortName = repo.split('/').slice(-1)[0] || repo;
    return (
      '<span class="cds-card-gh-link"' +
        ' role="link" tabindex="0"' +
        ' onclick="event.preventDefault();event.stopPropagation();window.open(\'' + escapeHtml(ghUrl).replace(/'/g, '&#39;') + '\',\'_blank\',\'noopener\')"' +
        ' title="' + escapeHtml(ghTitle) + '"' +
        (autoOff ? ' style="opacity:0.55"' : '') +
        '>' +
        '<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>' +
        '<span class="cds-card-gh-name">' + escapeHtml(shortName) + '</span>' +
      '</span>'
    );
  }

  function renderCard(project, services) {
    var href = '/branch-list?project=' + encodeURIComponent(project.id);
    // 三个右上角按钮：下载技能 / 授权 Agent / 删除项目
    // 用 .cds-project-card-actions 容器统一定位 + hover 显隐 + 间距 6px。
    // 顺序按破坏性递增：下载（无副作用）→ 授权（中等）→ 删除（高危）。
    // Legacy 项目不能删除，自动省略最后一个按钮。
    var downloadSkillBtn =
      '<button class="cds-project-card-action-btn cds-project-card-download-skill" ' +
      'title="下载 cds 技能包 (tar.gz) — 解压到项目 .claude/skills/ 即可在 Claude Code 里调用 cdscli" ' +
      "onclick=\"handleDownloadCdsSkill(event)\">" +
      '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" x2="12" y1="15" y2="3"/></svg>' +
      '</button>';
    var agentKeyBtn =
      '<button class="cds-project-card-action-btn cds-project-card-agentkey" title="授权 Agent / 管理 Key" ' +
      "onclick=\"handleProjectAgentKey(event, '" + escapeHtml(project.id) + "')\">" +
      '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="7.5" cy="15.5" r="5.5"/><path d="m21 2-9.6 9.6"/><path d="m15.5 7.5 3 3L22 7l-3-3"/></svg>' +
      '</button>';
    var deleteBtn = project.legacyFlag
      ? ''
      : '<button class="cds-project-card-action-btn danger cds-project-card-delete" title="删除项目" onclick="handleDeleteProject(event, ' +
        "'" + escapeHtml(project.id) + "', '" + escapeHtml(project.aliasName || project.name) + "')\">" +
        '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2"/></svg>' +
        '</button>';
    var actionsRow =
      '<div class="cds-project-card-actions">' + downloadSkillBtn + agentKeyBtn + deleteBtn + '</div>';

    var totalServices =
      ((services && services.profiles && services.profiles.length) || 0) +
      ((services && services.infra && services.infra.length) || 0);
    var envLabel = project.legacyFlag ? 'production' : 'production';
    var cloneBadge = renderCloneBadge(project);
    // GitHub link: rendered INSIDE renderStatsStrip as a 4th chip
    // (cds-stat-github) so the badge shares the same pill style as
    // the other stats and doesn't need its own row.
    var cloneBtn = renderCloneButton(project);
    // Show the clone error inline under the service strip when the
    // last attempt failed AND we're not already using the full-size
    // progress bar in place of the service strip (otherwise the msg
    // appears twice on 'error' state).
    var progressBar = renderCloneProgressBar(project);
    var errorBlock = (!progressBar && project.cloneStatus === 'error' && project.cloneError)
      ? '<div class="cds-clone-error">' + escapeHtml(project.cloneError) + '</div>'
      : '';

    // Body element: either the progress bar (when cloning/pending/error)
    // or the normal service icon strip.
    var bodyHtml = progressBar
      ? progressBar
      : '<div class="cds-service-strip">' + renderServiceStrip(project, services || {}) + '</div>';

    // 2026-04-27 重构：参考 Railway 风格简约设计。
    // 不再渲染：(1) chips 行 — 分支/运行/最近部署/GitHub 4 个 chip
    //           (2) 「进入分支 →」CTA — 整张卡是 link 已经够了
    // 替代：    (1) GitHub repo 移到 header 标题右侧的小 icon + 短名
    //           (2) Footer 一行 `● production · X services · Y running`
    //           (3) 分支数 + 最近部署时间放 tooltip
    var ghLink = progressBar ? '' : renderHeaderGithubLink(project);
    var minimalFoot = progressBar ? '' : renderMinimalFooter(project, totalServices);
    var cloneFoot = (progressBar || !cloneBtn) ? '' :
      '<div class="cds-project-card-clone-foot">' + cloneBtn + '</div>';

    // Wrap in a div so the action buttons can sit OUTSIDE the <a> tag.
    // <button> inside <a> is invalid HTML — click events on the button
    // bubble to the <a> in some browsers and navigate instead.
    return [
      '<div class="cds-project-card-wrapper" style="position:relative">',
      '  <a class="cds-project-card" href="', href, '">',
      '    <div class="cds-project-card-head">',
      '      <div class="cds-project-card-title">', escapeHtml(project.aliasName || project.name), '</div>',
      '      ', ghLink,
      '      ', cloneBadge,
      '    </div>',
      '    ', bodyHtml,
      errorBlock,
      '    ', minimalFoot,
      '    ', cloneFoot,
      '  </a>',
      '  ', actionsRow,
      '</div>',
    ].join('');
  }

  // Expose a global click handler so the inline onclick can reach the
  // IIFE-internal render logic without leaking the renderCard closure.
  // 📦 下载 cds 技能包：命中 /api/export-skill，浏览器原生下载。
  // 不依赖当前 project（所有项目用同一个 cds 技能），所以不需要
  // projectId 参数。ev.preventDefault/stopPropagation 防止冒泡到外
  // 层 <a> 导致误导航。
  window.handleDownloadCdsSkill = function (ev) {
    if (ev && ev.preventDefault) ev.preventDefault();
    if (ev && ev.stopPropagation) ev.stopPropagation();
    // Trigger native download — 让浏览器处理文件名（后端 Content-Disposition 已给好）
    var a = document.createElement('a');
    a.href = '/api/export-skill';
    a.download = '';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    if (typeof showToast === 'function') {
      showToast('正在下载 CDS 技能包（cds + cds-deploy-pipeline + cds-project-scan）…解压到项目根目录即可', 'info', 5000);
    }
  };

  window.handleProjectAgentKey = function (ev, projectId) {
    if (ev && ev.preventDefault) ev.preventDefault();
    if (ev && ev.stopPropagation) ev.stopPropagation();
    if (window.cdsOpenAgentKeyManager) {
      window.cdsOpenAgentKeyManager(projectId);
    }
  };

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
        if (!res.ok) {
          // Surface the server-side error body so the user (and future
          // bug reports) see the real reason for 4xx/5xx, not just
          // "HTTP 400". Many CDS errors include a JSON {error,message}
          // shape — fall back to raw text otherwise.
          return res.text().then(function (raw) {
            var detail = '';
            try {
              var parsed = JSON.parse(raw);
              detail = parsed.message || parsed.error || raw;
            } catch (_e) {
              detail = raw;
            }
            throw new Error('HTTP ' + res.status + (detail ? ' — ' + String(detail).slice(0, 200) : ''));
          });
        }
        return res.json();
      })
      .then(function (data) {
        var projects = (data && data.projects) || [];
        if (projectCountEl) projectCountEl.textContent = projects.length;

        // 2026-04-22 遗留 default 项目迁移提醒
        // 2026-04-24 split into two user-facing states:
        //   needsMigration → still has real data on "default", show
        //     the original 迁移 → button (calls rename-default).
        //   residualOnly   → data already migrated, only an empty dir
        //     / env scope left behind, show 清理残留 button (calls
        //     cleanup-residual). Avoids the "我已经迁移了怎么还要迁移"
        //     paradox.
        fetch('/api/legacy-cleanup/status', { credentials: 'same-origin' })
          .then(function (r) { return r.json(); })
          .then(function (st) {
            var banner = document.getElementById('legacyBanner');
            if (!st.legacyInUse) { if (banner) banner.remove(); return; }
            if (banner) banner.remove(); // re-render if state changed kind
            var el = document.createElement('div');
            el.id = 'legacyBanner';
            el.style.cssText = 'margin:16px 0;padding:12px 16px;background:rgba(245,158,11,0.08);border:1px solid rgba(245,158,11,0.45);border-radius:8px;display:flex;gap:12px;align-items:center;font-size:13px';

            var isResidual = !!st.residualOnly;
            var title = isResidual
              ? '发现「default」项目残留目录'
              : '检测到遗留 "default" 项目';
            // PR #498 round-5 fix: residualOnly now strictly means
            // "only the empty <base>/default directory remains" (env
            // scope with real keys routes to needsMigration so that
            // 「迁移 →」copies the secrets into the new project's scope
            // instead of pointing the user at a button that always 409s).
            var detail = isResidual
              ? 'default 项目已迁移,仅剩工作树目录未清理。点「清理残留」可彻底移除横幅。'
              : st.counts.branches + ' 分支 / ' + st.counts.buildProfiles + ' profile / ' + st.counts.infraServices + ' infra' +
                (st.counts.customEnvScopeExists ? ' + 自定义环境变量' : '') + '。' +
                'default 是升级兼容占位,建议给它改成真实项目名以获得完整权限隔离。';
            var btnLabel = isResidual ? '清理残留' : '迁移 →';
            var btnId = isResidual ? 'legacyResidualBtn' : 'legacyMigrateBtn';

            el.innerHTML =
              '<div style="font-size:20px">⚠</div>' +
              '<div style="flex:1"><strong>' + title + '</strong><br>' +
                '<span style="color:var(--text-muted);font-size:12px">' + detail + '</span>' +
              '</div>' +
              '<button id="' + btnId + '" class="btn-primary-solid">' + btnLabel + '</button>';
            var container = document.querySelector('.project-list-container') || document.body;
            container.prepend(el);

            if (isResidual) {
              document.getElementById('legacyResidualBtn').onclick = function () {
                if (!confirm('将删除 default 残留工作目录。此操作已做数据安全校验,继续?')) return;
                fetch('/api/legacy-cleanup/cleanup-residual', {
                  method: 'POST',
                  credentials: 'same-origin',
                })
                  .then(function (r) { return r.json().then(function (b) { return { ok: r.ok, body: b }; }); })
                  .then(function (r) {
                    if (!r.ok) throw new Error(r.body.message || r.body.error || '清理失败');
                    alert(r.body.message || '清理完成');
                    location.reload();
                  })
                  .catch(function (err) { alert('清理失败:' + err.message); });
              };
            } else {
              document.getElementById('legacyMigrateBtn').onclick = function () {
                var newId = prompt('为 "default" 项目起个新 id（小写字母、数字、短横线，如 prd-agent）：');
                if (!newId) return;
                var newName = prompt('为项目起个中文显示名（可选）：') || undefined;
                fetch('/api/legacy-cleanup/rename-default', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  credentials: 'same-origin',
                  body: JSON.stringify({ newId: newId.trim(), newName: newName }),
                })
                  .then(function (r) { return r.json().then(function (b) { return { ok: r.ok, body: b }; }); })
                  .then(function (r) {
                    if (!r.ok) throw new Error(r.body.error || '迁移失败');
                    alert(r.body.message || '迁移完成');
                    location.reload();
                  })
                  .catch(function (err) { alert('迁移失败：' + err.message); });
              };
            }
          })
          .catch(function () { /* legacy-cleanup 接口缺失就静默 */ });

        // Cache by id so the pending-import drawer can look up the
        // human-readable project name without its own /api/projects
        // round trip. Refreshed on every loadProjects() call.
        _projectsById = {};
        for (var _pi = 0; _pi < projects.length; _pi++) {
          _projectsById[projects[_pi].id] = projects[_pi];
        }

        // Drive the 5s poll only while some project is in a non-terminal
        // clone state. Once everything is ready/error/undefined we stop.
        _syncClonePoll(projects);

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
            // Query the wrapper div (parent of <a>) so the full card
            // (including the delete button outside the <a>) gets replaced.
            var cards = gridEl.querySelectorAll('.cds-project-card-wrapper');
            if (cards[idx]) {
              var tmp = document.createElement('div');
              tmp.innerHTML = renderCard(p, services);
              if (tmp.firstElementChild) {
                cards[idx].outerHTML = tmp.firstElementChild.outerHTML;
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

  // Badge resolution priority (Backlog UF-02, 2nd pass):
  //   1. CDS session user (/api/me) — when CDS_AUTH_MODE=github and
  //      the user has an active session, this is authoritative.
  //   2. GitHub Device Flow user (/api/github/oauth/status) — when
  //      CDS auth is disabled / mode=basic, but the operator has
  //      linked a personal GitHub via Device Flow, we surface that
  //      login as the badge.
  //   3. Fallback: show "未登录" with a tooltip explaining why.
  //
  // The function is IDEMPOTENT and EVENT-DRIVEN — it can be called
  // any number of times, including after a GitHub Device Flow login
  // completes mid-session (the main UF-02 regression: the old code
  // only ran once at pageload, so a user who logged in AFTER the
  // page loaded was stuck seeing "未登录" until a manual refresh).
  //
  // Re-entry points:
  //   - `loadProjects()` at pageload
  //   - `_pollGithubDevice` on 'ready' (inside the create modal)
  //   - `_settingsGithubDisconnect` equivalent if/when we add one
  //   - Any other flow that mutates the CDS session or GitHub link

  // Track the last resolved identity so we don't repaint unchanged
  // state (cuts a tiny visual flicker). Compared by login id.
  var _lastResolvedBadgeLogin = null;
  // UF-11: cache the last GitHub status response so the popover can
  // show "未配置 / 未登录 / 已连接 @xxx" without re-fetching.
  var _lastGithubStatus = null;

  function _setUserCardClass(cls) {
    var card = document.getElementById('userCard');
    if (!card) return;
    card.classList.remove('signed-in', 'not-configured');
    if (cls) card.classList.add(cls);
  }

  function _updateUserPopover() {
    var statusEl = document.getElementById('userPopoverStatus');
    var signinBtn = document.getElementById('userPopoverSignin');
    var logoutBtn = document.getElementById('userPopoverLogout');
    // UF-12: top-level setup banner, only visible when configured=false
    var setupBanner = document.getElementById('githubSetupBanner');
    if (!statusEl) return;
    var s = _lastGithubStatus;
    if (!s) {
      statusEl.textContent = '正在检查登录状态…';
      if (signinBtn) signinBtn.style.display = 'none';
      if (logoutBtn) logoutBtn.style.display = 'none';
      if (setupBanner) setupBanner.style.display = 'none';
      return;
    }
    if (!s.configured) {
      statusEl.innerHTML = '⚠ 未配置 · 运维需设置 <code style="background:var(--bg-elevated);padding:1px 4px;border-radius:3px">CDS_GITHUB_CLIENT_ID</code>';
      if (signinBtn) signinBtn.style.display = 'none';
      if (logoutBtn) logoutBtn.style.display = 'none';
      if (setupBanner) setupBanner.style.display = 'block';
      return;
    }
    if (setupBanner) setupBanner.style.display = 'none';
    if (s.connected && s.login && s.login !== '(unknown)') {
      statusEl.innerHTML = '<span style="color:var(--green)">✓</span> 已连接 <code style="background:var(--bg-elevated);padding:1px 4px;border-radius:3px">@' + escapeHtml(s.login) + '</code>';
      if (signinBtn) signinBtn.style.display = 'none';
      if (logoutBtn) logoutBtn.style.display = 'flex';
    } else {
      statusEl.textContent = '已配置 GitHub 但尚未登录 — 点下方完成 Device Flow';
      if (signinBtn) signinBtn.style.display = 'flex';
      if (logoutBtn) logoutBtn.style.display = 'none';
    }
  }


  function _renderBadgeIdentity(login, displayName, avatarUrl) {
    var nameEl = document.getElementById('userName');
    var avatarEl = document.getElementById('userAvatar');
    if (!nameEl || !avatarEl) return;
    if (nameEl) nameEl.textContent = displayName || login || '登录用户';
    if (nameEl) nameEl.title = login ? ('@' + login + ' · 点击管理') : '';
    if (avatarUrl) {
      avatarEl.innerHTML =
        '<img src="' + String(avatarUrl).replace(/"/g, '') + '" alt="">';
    } else {
      avatarEl.textContent = ((login || displayName || '?') + '').charAt(0).toUpperCase();
    }
    _lastResolvedBadgeLogin = login || null;
    _setUserCardClass('signed-in');
    _updateUserPopover();
  }

  // P5: update the workspace pill (top-left sidebar area) based on the
  // user's first personal workspace. If they have team workspaces too,
  // show the count as a subtle indicator.
  function _renderWorkspacePill(workspaces) {
    var wsAvatar = document.getElementById('wsAvatar');
    var wsName = document.getElementById('wsName');
    if (!wsAvatar || !wsName) return;
    if (!workspaces || workspaces.length === 0) return;

    // Personal workspace first; fall back to first item.
    var personal = workspaces.find(function (w) { return w.kind === 'personal'; });
    var active = personal || workspaces[0];

    wsName.textContent = active.name || '个人工作区';
    wsAvatar.textContent = (active.name || '?').charAt(0).toUpperCase();

    // Add tooltip listing team workspaces if any.
    var teamCount = workspaces.filter(function (w) { return w.kind === 'team'; }).length;
    var pill = wsAvatar.closest ? wsAvatar.closest('.cds-workspace') : null;
    if (pill) {
      pill.title = teamCount > 0
        ? active.name + '（还有 ' + teamCount + ' 个团队工作区）'
        : active.name;
    }
  }

  function _renderBadgeNotLoggedIn(hint, notConfigured) {
    var nameEl = document.getElementById('userName');
    var avatarEl = document.getElementById('userAvatar');
    if (!nameEl || !avatarEl) return;
    if (_lastResolvedBadgeLogin !== null) _lastResolvedBadgeLogin = null;
    nameEl.textContent = notConfigured ? '未配置' : '未登录';
    nameEl.title = hint || '点击打开登录菜单';
    avatarEl.innerHTML = notConfigured ? '⚙' : '?';
    _setUserCardClass(notConfigured ? 'not-configured' : null);
    _updateUserPopover();
  }

  // UF-11: helpers used by the inline onclick handlers in projects.html.
  window._toggleUserMenu = function (ev) {
    if (ev) ev.stopPropagation();
    var card = document.getElementById('userCard');
    if (!card) return;
    card.classList.toggle('menu-open');
  };
  window._closeUserMenu = function () {
    var card = document.getElementById('userCard');
    if (card) card.classList.remove('menu-open');
  };
  window._openGithubSignin = function () {
    // Close the popover then route to the existing Device Flow modal.
    // If the create modal isn't open we still need the device modal
    // harness, which is already wired inside openCreateProjectModal.
    window._closeUserMenu();
    // _openGithubSignin() in projects.js's create-modal scope expects
    // the device modal DOM to exist. The create modal markup in
    // projects.html contains that DOM, so opening the create modal
    // first guarantees it. Users can hit cancel on the create form
    // without losing the github connection.
    if (typeof openCreateProjectModal === 'function') {
      openCreateProjectModal();
    }
    // Defer so the create-modal's _refreshGithubSignInState runs first.
    setTimeout(function () {
      // Now call the internal _openGithubSignin handler (the one
      // defined inside the IIFE scope) via the Sign-in button that
      // _refreshGithubSignInState puts into the DOM. The button's
      // onclick fires the same handler.
      var btn = document.getElementById('cp-github-signin');
      if (btn) btn.click();
    }, 80);
  };
  window._disconnectGithub = async function () {
    window._closeUserMenu();
    if (!window.confirm('确定断开 GitHub 连接吗?\n\n此操作清除 CDS 本地保存的 token。GitHub 侧的授权需要去 https://github.com/settings/applications 手动撤销。')) return;
    try {
      var res = await fetch('/api/github/oauth', { method: 'DELETE', credentials: 'same-origin' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      showToast('已断开 GitHub 连接', 'success');
      // Immediately refresh the badge so the user sees the change
      _lastGithubStatus = null;
      _lastResolvedBadgeLogin = null;
      bootstrapMeLabel();
    } catch (err) {
      showToast('断开失败: ' + (err && err.message ? err.message : err), 'error');
    }
  };
  // Close popover on outside click
  document.addEventListener('click', function (e) {
    var card = document.getElementById('userCard');
    if (!card || !card.classList.contains('menu-open')) return;
    if (!card.contains(e.target)) card.classList.remove('menu-open');
  });

  function bootstrapMeLabel() {
    // Phase 1: probe CDS session. If we get a 200 with a user back,
    // that's authoritative — use it and stop.
    fetch('/api/me', { credentials: 'same-origin', cache: 'no-store' })
      .then(function (res) { return res.ok ? res.json() : null; })
      .catch(function (err) {
        // Network error (rare); fall through to phase 2.
        // eslint-disable-next-line no-console
        console.debug('[projects] /api/me network error:', err && err.message);
        return null;
      })
      .then(function (body) {
        if (body && body.user) {
          var user = body.user;
          _renderBadgeIdentity(
            user.githubLogin,
            user.githubLogin || user.name || user.email,
            user.avatarUrl,
          );
          // P5: load workspace list and populate the workspace pill.
          fetch('/api/workspaces', { credentials: 'same-origin', cache: 'no-store' })
            .then(function (r) { return r.ok ? r.json() : null; })
            .then(function (ws) { if (ws) _renderWorkspacePill(ws.workspaces || []); })
            .catch(function () { /* quiet — workspace pill stays at default */ });
          // Even when /api/me resolves, fetch the GitHub status in
          // parallel so the popover can offer disconnect/reconnect
          // for the separate Device Flow token.
          fetch('/api/github/oauth/status', { credentials: 'same-origin', cache: 'no-store' })
            .then(function (res) { return res.ok ? res.json() : null; })
            .then(function (gh) { _lastGithubStatus = gh; _updateUserPopover(); })
            .catch(function () { /* quiet */ });
          return;
        }
        // Phase 2: probe GitHub Device Flow status. This is the
        // branch that activates when CDS is running in
        // auth-mode=disabled (single-user install) but the operator
        // has linked their personal GitHub account for repo listing.
        return fetch('/api/github/oauth/status', { credentials: 'same-origin', cache: 'no-store' })
          .then(function (res) { return res.ok ? res.json() : null; })
          .catch(function (err) {
            // eslint-disable-next-line no-console
            console.debug('[projects] /api/github/oauth/status network error:', err && err.message);
            return null;
          })
          .then(function (gh) {
            _lastGithubStatus = gh || { configured: false, connected: false };
            if (gh && gh.connected && gh.login && gh.login !== '(unknown)') {
              _renderBadgeIdentity(gh.login, gh.name || gh.login, gh.avatarUrl);
              return;
            }
            // Nothing resolved. Render the not-logged-in hint with
            // a diagnostic tooltip explaining the probe results so
            // operators don't have to open DevTools.
            var diag = [];
            if (!body) diag.push('CDS 会话: 无');
            else if (!body.user) diag.push('CDS 会话: 空');
            if (!gh) diag.push('GitHub 状态: 探测失败');
            else if (!gh.configured) diag.push('GitHub: 未配置 CDS_GITHUB_CLIENT_ID');
            else if (!gh.connected) diag.push('GitHub: 未完成 Device Flow 登录');
            else if (gh.login === '(unknown)') diag.push('GitHub: token 无 profile 信息');
            _renderBadgeNotLoggedIn(diag.join(' · '), gh && !gh.configured);
          });
      });
  }

  // UF-13: global error guard. If any uncaught JS error fires (typically
  // a syntax error in app.js after redeploy, or a network failure inside
  // a fetch callback), surface it as a toast + console so users can
  // self-diagnose instead of staring at a silent broken page. This is
  // the escape hatch the user requested ("我不知道什么情况下它不是未登录").
  window.addEventListener('error', function (e) {
    try {
      var msg = (e && e.message) || '未知脚本错误';
      var src = (e && e.filename) || '';
      // eslint-disable-next-line no-console
      console.error('[projects] uncaught error:', msg, 'at', src, e);
      // Only show a toast for errors that aren't from the browser
      // complaining about images/3rd-party (those fire 'error' events
      // on elements and bubble up here with src set to the image URL).
      if (typeof showToast === 'function' && !/\.(png|jpg|jpeg|svg|webp)$/i.test(src)) {
        showToast('脚本错误: ' + msg + ' — 请 Cmd+R 刷新,仍有问题请运维检查 CDS 版本', 'error', 8000);
      }
    } catch (_e) { /* last-resort guard */ }
  }, true);

  // Expose so other code paths (device-flow success, modal handlers)
  // can trigger an immediate badge refresh. Also aliased on window so
  // the inline onclick handlers inside create / device modals can
  // reach it without a closure dance.
  window._cdsRefreshIdentityBadge = bootstrapMeLabel;

  // ── Create-project modal ───────────────────────────────────────────

  function getModal() { return document.getElementById('createProjectModal'); }

  function openCreateProjectModal() {
    var modal = getModal();
    if (!modal) return;
    var form = document.getElementById('createProjectForm');
    if (form) form.reset();
    var err = document.getElementById('createProjectError');
    if (err) err.textContent = '';
    // Reset collapsible advanced section
    var advSec = document.getElementById('cp-advanced-section');
    var advChev = document.getElementById('cp-advanced-chev');
    if (advSec) advSec.style.display = 'none';
    if (advChev) advChev.style.transform = 'rotate(0deg)';
    // Reset hint line
    if (typeof _updateCreateHint === 'function') _updateCreateHint();
    modal.classList.add('visible');
    // P4 Part 18 (Phase E.2): probe GitHub OAuth status so we can
    // show the Sign-in button vs "already connected" state vs
    // "not configured" hint. Fire-and-forget; errors fall through
    // to "not configured" which is the safest default.
    _refreshGithubSignInState();
    setTimeout(function () {
      // P4 Part 18 UX rework: focus the smart input (URL or name)
      var first = document.getElementById('cp-smart-input');
      if (first) first.focus();
    }, 50);
  }

  // P4 Part 18 (Phase E.2): probe /api/github/oauth/status and
  // show one of three states inside the create modal:
  //   1. not configured → hint: "需要 CDS_GITHUB_CLIENT_ID"
  //   2. configured, not connected → Sign-in button
  //   3. configured, connected → green banner + "浏览我的仓库"
  function _refreshGithubSignInState() {
    var signinBtn = document.getElementById('cp-github-signin');
    var connectedBox = document.getElementById('cp-github-connected');
    var connectedLogin = document.getElementById('cp-github-connected-login');
    var hintEl = document.getElementById('cp-github-hint');
    var divider = document.getElementById('cp-divider');

    function hideAll() {
      if (signinBtn) signinBtn.style.display = 'none';
      if (connectedBox) connectedBox.style.display = 'none';
      if (hintEl) hintEl.style.display = 'none';
      if (divider) divider.style.display = 'none';
    }
    hideAll();

    fetch('/api/github/oauth/status', { credentials: 'same-origin' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .catch(function () { return null; })
      .then(function (data) {
        if (!data) {
          // Probe failed — hide everything, let user use smart input
          return;
        }
        if (!data.configured) {
          if (hintEl) hintEl.style.display = 'block';
          if (divider) divider.style.display = 'block';
          return;
        }
        if (data.connected) {
          if (connectedBox) connectedBox.style.display = 'block';
          if (connectedLogin) connectedLogin.textContent = '@' + (data.login || '');
        } else {
          if (signinBtn) signinBtn.style.display = 'flex';
        }
        if (divider) divider.style.display = 'block';
      });
  }

  // ── GitHub Device Flow driver (P4 Part 18 Phase E.2) ──────────────
  //
  // Flow:
  //   1. User clicks "使用 GitHub 登录" → _openGithubSignin()
  //   2. We POST /device-start → get user_code + verification_uri
  //   3. Show the device modal with the code + link
  //   4. Loop _pollGithubDevice() every `interval` seconds
  //   5. On 'ready' → close device modal, open repo picker
  //   6. On 'denied' / 'expired' → show error in modal
  //
  // Polling is stored in a closure-scoped timer so the user can
  // cancel via the "取消" button (closeGithubDeviceModal).

  var _ghDevicePollTimer = null;
  var _ghDevicePollAbort = false;

  function _openGithubSignin() {
    var modal = document.getElementById('githubDeviceModal');
    if (!modal) return;
    var bodyEl = document.getElementById('gh-device-body');
    var errEl = document.getElementById('gh-device-error');
    var subtitleEl = document.getElementById('gh-device-subtitle');
    if (bodyEl) bodyEl.style.display = 'none';
    if (errEl) { errEl.style.display = 'none'; errEl.textContent = ''; }
    if (subtitleEl) subtitleEl.textContent = '正在请求设备代码…';
    // P4 Part 18 (Phase E audit fix #3): kill any in-flight Device
    // Flow before starting a new one. Without this, a user who
    // re-clicks "Sign in" while a previous /device-start fetch is
    // still pending gets two concurrent flows, and the userCode
    // display flickers as both fetches' .then callbacks race.
    _ghDevicePollAbort = true;
    if (_ghDevicePollTimer) {
      clearTimeout(_ghDevicePollTimer);
      _ghDevicePollTimer = null;
    }
    // Tick forward to the next microtask so the aborted poll's
    // last .then() (if any) fires and sees abort=true. Then re-enable.
    setTimeout(function () { _ghDevicePollAbort = false; }, 0);
    modal.classList.add('visible');

    fetch('/api/github/oauth/device-start', {
      method: 'POST',
      credentials: 'same-origin',
    })
      .then(function (r) {
        return r.json().then(function (body) { return { status: r.status, body: body }; });
      })
      .then(function (result) {
        if (result.status !== 200) {
          _showDeviceError(result.body && result.body.message || 'device-start 失败');
          return;
        }
        var b = result.body;
        var codeEl = document.getElementById('gh-device-code');
        var linkEl = document.getElementById('gh-device-link');
        var subtitleEl = document.getElementById('gh-device-subtitle');
        if (codeEl) codeEl.textContent = b.userCode;
        if (linkEl) linkEl.href = b.verificationUri;
        if (bodyEl) bodyEl.style.display = 'block';
        if (subtitleEl) subtitleEl.textContent = '访问 GitHub 并输入下面的代码完成授权';
        // Auto-open the verification URI in a new tab as a
        // convenience (users can still click the button to open
        // again if the popup is blocked).
        try { window.open(b.verificationUri, '_blank', 'noopener'); } catch (e) { /* */ }
        _schedulePoll(b.deviceCode, (b.interval || 5) * 1000);
      })
      .catch(function (err) {
        _showDeviceError('网络错误：' + (err && err.message ? err.message : err));
      });
  }

  function _schedulePoll(deviceCode, intervalMs) {
    if (_ghDevicePollTimer) clearTimeout(_ghDevicePollTimer);
    _ghDevicePollTimer = setTimeout(function () {
      _pollGithubDevice(deviceCode, intervalMs);
    }, intervalMs);
  }

  function _pollGithubDevice(deviceCode, intervalMs) {
    if (_ghDevicePollAbort) return;
    fetch('/api/github/oauth/device-poll', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ deviceCode: deviceCode }),
    })
      .then(function (r) { return r.json(); })
      .then(function (body) {
        if (_ghDevicePollAbort) return;
        var statusEl = document.getElementById('gh-device-status');

        if (body.status === 'ready') {
          if (statusEl) statusEl.textContent = '✓ 已连接 @' + (body.login || '');
          showToast('GitHub 已连接 @' + (body.login || ''));
          setTimeout(function () {
            closeGithubDeviceModal();
            // UF-02 regression: refresh the bottom-left identity badge
            // immediately. Previously this was only done at pageload,
            // so users who completed Device Flow mid-session kept
            // seeing "未登录" until a manual browser refresh.
            bootstrapMeLabel();
            // Refresh the create-modal sign-in state (shows connected banner)
            _refreshGithubSignInState();
            // Open the repo picker immediately
            _openRepoPicker();
          }, 600);
          return;
        }
        if (body.status === 'pending') {
          if (statusEl) statusEl.textContent = '等待授权…（' + new Date().toLocaleTimeString() + '）';
          _schedulePoll(deviceCode, intervalMs);
          return;
        }
        if (body.status === 'slow-down') {
          if (statusEl) statusEl.textContent = 'GitHub 要求降低轮询频率，已自动放慢…';
          _schedulePoll(deviceCode, intervalMs + 5000);
          return;
        }
        if (body.status === 'expired') {
          _showDeviceError('设备代码已过期，请关闭后重新开始');
          return;
        }
        if (body.status === 'denied') {
          _showDeviceError('你在 GitHub 拒绝了授权请求');
          return;
        }
        _showDeviceError((body && body.message) || '未知错误：' + JSON.stringify(body));
      })
      .catch(function (err) {
        if (_ghDevicePollAbort) return;
        // Transient network error — retry after the interval
        _schedulePoll(deviceCode, intervalMs);
      });
  }

  function _showDeviceError(msg) {
    var errEl = document.getElementById('gh-device-error');
    if (errEl) {
      errEl.textContent = msg;
      errEl.style.display = 'block';
    }
    if (_ghDevicePollTimer) {
      clearTimeout(_ghDevicePollTimer);
      _ghDevicePollTimer = null;
    }
  }

  function closeGithubDeviceModal(event) {
    if (event && event.currentTarget !== event.target) return;
    var modal = document.getElementById('githubDeviceModal');
    if (modal) modal.classList.remove('visible');
    _ghDevicePollAbort = true;
    if (_ghDevicePollTimer) {
      clearTimeout(_ghDevicePollTimer);
      _ghDevicePollTimer = null;
    }
  }

  // ── Repo picker (P4 Part 18 Phase E.2) ────────────────────────────
  //
  // Lists the user's GitHub repos (via /api/github/repos). Click a
  // repo → fill the smart input in the create modal with its
  // clone_url and close the picker. Users can still paste a custom
  // URL afterwards if they want.

  var _allRepos = [];
  // FU-01: pagination state. `_repoPickerNextPage` is the page to
  // fetch on the next "加载更多" click; `_repoPickerLoadingMore` is a
  // re-entrancy guard so rapid double-clicks don't double-fetch.
  var _repoPickerNextPage = 1;
  var _repoPickerHasMore = false;
  var _repoPickerLoadingMore = false;

  function _openRepoPicker() {
    var modal = document.getElementById('githubRepoPickerModal');
    if (!modal) return;
    var listEl = document.getElementById('gh-picker-list');
    var subtitleEl = document.getElementById('gh-picker-subtitle');
    var searchEl = document.getElementById('gh-picker-search');
    if (listEl) listEl.innerHTML = '<div style="padding:60px 20px;text-align:center;color:var(--text-muted);font-size:12px">正在加载仓库列表…</div>';
    if (searchEl) searchEl.style.display = 'none';
    if (subtitleEl) subtitleEl.textContent = '正在加载…';
    modal.classList.add('visible');

    // Reset pagination state on each open
    _allRepos = [];
    _repoPickerNextPage = 1;
    _repoPickerHasMore = false;
    _repoPickerLoadingMore = false;

    fetch('/api/github/repos?page=1', { credentials: 'same-origin' })
      .then(function (r) {
        return r.json().then(function (body) { return { status: r.status, body: body }; });
      })
      .then(function (result) {
        if (result.status !== 200) {
          var msg = (result.body && result.body.message) || ('加载失败 (HTTP ' + result.status + ')');
          if (listEl) {
            listEl.innerHTML = '<div style="padding:60px 20px;text-align:center;color:var(--red);font-size:12px">' + escapeHtml(msg) + '</div>';
          }
          if (subtitleEl) subtitleEl.textContent = '加载失败';
          if (result.body && result.body.error === 'token_revoked') {
            // Re-open the sign-in flow next time user clicks
            setTimeout(_refreshGithubSignInState, 100);
          }
          return;
        }

        _allRepos = result.body.repos || [];
        _repoPickerHasMore = !!result.body.hasNext;
        _repoPickerNextPage = 2;
        if (subtitleEl) {
          subtitleEl.textContent = _repoPickerHasMore
            ? '已加载 ' + _allRepos.length + ' 个仓库(还有更多)'
            : '共 ' + _allRepos.length + ' 个仓库';
        }
        if (searchEl) { searchEl.style.display = 'block'; searchEl.value = ''; }
        _renderRepoList(_allRepos);
        setTimeout(function () {
          if (searchEl) searchEl.focus();
        }, 80);
      })
      .catch(function (err) {
        if (listEl) {
          listEl.innerHTML = '<div style="padding:60px 20px;text-align:center;color:var(--red);font-size:12px">网络错误:' + escapeHtml(err && err.message ? err.message : String(err)) + '</div>';
        }
      });
  }

  // FU-01: fetch the next page of repos and append to the list.
  // Called from the "加载更多" button at the bottom of the render output.
  function _repoPickerLoadMore() {
    if (_repoPickerLoadingMore || !_repoPickerHasMore) return;
    _repoPickerLoadingMore = true;
    var loadMoreBtn = document.getElementById('gh-picker-load-more');
    if (loadMoreBtn) { loadMoreBtn.disabled = true; loadMoreBtn.textContent = '正在加载…'; }
    fetch('/api/github/repos?page=' + encodeURIComponent(_repoPickerNextPage), { credentials: 'same-origin' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (body) {
        if (!body || !Array.isArray(body.repos)) {
          showToast('加载更多失败', 'error');
          return;
        }
        _allRepos = _allRepos.concat(body.repos);
        _repoPickerHasMore = !!body.hasNext;
        _repoPickerNextPage += 1;
        var subtitleEl = document.getElementById('gh-picker-subtitle');
        if (subtitleEl) {
          subtitleEl.textContent = _repoPickerHasMore
            ? '已加载 ' + _allRepos.length + ' 个仓库(还有更多)'
            : '共 ' + _allRepos.length + ' 个仓库';
        }
        // Re-render with the current search query applied
        var searchEl = document.getElementById('gh-picker-search');
        var q = searchEl ? searchEl.value.trim().toLowerCase() : '';
        var filtered = q
          ? _allRepos.filter(function (r) { return r.fullName.toLowerCase().includes(q); })
          : _allRepos;
        _renderRepoList(filtered);
      })
      .catch(function (err) {
        showToast('加载更多失败:' + (err && err.message ? err.message : err), 'error');
      })
      .finally(function () {
        _repoPickerLoadingMore = false;
      });
  }

  function _renderRepoList(repos) {
    var listEl = document.getElementById('gh-picker-list');
    if (!listEl) return;
    if (repos.length === 0) {
      listEl.innerHTML = '<div style="padding:60px 20px;text-align:center;color:var(--text-muted);font-size:12px">没有匹配的仓库</div>';
      return;
    }
    listEl.innerHTML = repos.map(function (r) {
      var meta = [];
      if (r.isPrivate) meta.push('<span class="private">PRIVATE</span>');
      if (r.language) meta.push('<span class="language">' + escapeHtml(r.language) + '</span>');
      if (r.stargazersCount > 0) meta.push('★ ' + r.stargazersCount);
      if (r.defaultBranch && r.defaultBranch !== 'main') meta.push('default: ' + escapeHtml(r.defaultBranch));
      return '<div class="gh-repo-row" data-fullname="' + escapeHtml(r.fullName) + '" onclick="_pickRepo(\'' + escapeHtml(r.cloneUrl).replace(/'/g, '\\\'') + '\', \'' + escapeHtml(r.name) + '\')">' +
        '<div style="flex:1;min-width:0">' +
          '<div class="gh-repo-name">' + escapeHtml(r.fullName) + '</div>' +
          '<div class="gh-repo-meta">' + meta.join('<span style="color:var(--text-muted);opacity:0.4">·</span>') + '</div>' +
          (r.description ? '<div class="gh-repo-desc">' + escapeHtml(r.description) + '</div>' : '') +
        '</div>' +
        '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" style="color:var(--text-muted);flex-shrink:0;margin-top:4px"><path d="M6.22 3.22a.75.75 0 011.06 0l4.25 4.25a.75.75 0 010 1.06l-4.25 4.25a.75.75 0 01-1.06-1.06L9.94 8 6.22 4.28a.75.75 0 010-1.06z"/></svg>' +
        '</div>';
    }).join('');
    // FU-01: render a "加载更多" button at the bottom of the list
    // whenever the last page response indicated hasNext=true. Clicking
    // it appends the next page and rerenders. Matches GitHub's own
    // paginated UI convention.
    if (_repoPickerHasMore) {
      listEl.innerHTML += '<button type="button" id="gh-picker-load-more" class="gh-repo-row" style="justify-content:center;cursor:pointer;color:var(--accent,#10b981);font-weight:600;border:1px dashed rgba(16,185,129,0.4)" onclick="_repoPickerLoadMore()">' +
        '<span>加载更多(第 ' + _repoPickerNextPage + ' 页)</span>' +
        '</button>';
    }
  }

  function _filterRepoPicker(query) {
    var q = (query || '').trim().toLowerCase();
    if (!q) {
      _renderRepoList(_allRepos);
      return;
    }
    var filtered = _allRepos.filter(function (r) {
      return r.fullName.toLowerCase().indexOf(q) >= 0
        || (r.description && r.description.toLowerCase().indexOf(q) >= 0)
        || (r.language && r.language.toLowerCase().indexOf(q) >= 0);
    });
    _renderRepoList(filtered);
  }
  window._filterRepoPicker = _filterRepoPicker;

  function _pickRepo(cloneUrl, repoName) {
    // Fill the smart input with the chosen repo's clone URL
    var smartEl = document.getElementById('cp-smart-input');
    if (smartEl) {
      smartEl.value = cloneUrl;
    }
    // Update the live hint so the user sees what will happen
    if (typeof _updateCreateHint === 'function') _updateCreateHint();
    closeRepoPickerModal();
    showToast('已选择 ' + repoName + '，点击"创建并部署"开始');
  }
  window._pickRepo = _pickRepo;

  function closeRepoPickerModal(event) {
    if (event && event.currentTarget !== event.target) return;
    var modal = document.getElementById('githubRepoPickerModal');
    if (modal) modal.classList.remove('visible');
  }
  window.closeRepoPickerModal = closeRepoPickerModal;

  window._openGithubSignin = _openGithubSignin;
  window._openRepoPicker = _openRepoPicker;
  // FU-01: pagination load-more handler
  window._repoPickerLoadMore = _repoPickerLoadMore;
  window.closeGithubDeviceModal = closeGithubDeviceModal;

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

  // ── Smart-input helpers (P4 Part 18 UX rework) ────────────────────
  //
  // The create modal no longer exposes separate "name" and "git URL"
  // fields by default. Users type into one input: if it looks like a
  // URL we treat it as a git repo and derive the project name from
  // the last path segment; otherwise it's an empty-project name.
  // The advanced section (name override, slug, description) stays
  // collapsed so the 90% case is a one-field form.

  function _parseSmartInput(raw) {
    var val = String(raw || '').trim();
    if (!val) return { kind: 'empty', name: '', gitRepoUrl: null };

    // P4 Part 18 (Phase E audit fix #6 + #8): tighten URL detection.
    // Only treat the input as a URL when it has an explicit protocol
    // prefix. The previous "ends in .git" fallback accepted bare
    // filenames like `myrepo.git` as clone URLs and confused users.
    // We also drop `file://` from the allowed protocols — local
    // filesystem clone paths are an escape hatch that CDS doesn't
    // need and that can leak FS structure via git error messages.
    var isUrl = /^(https?:\/\/|git@|ssh:\/\/)/i.test(val);
    if (!isUrl) {
      return { kind: 'name', name: val, gitRepoUrl: null };
    }

    // P4 Part 18 (Phase E audit fix #5): strip common GitHub "view"
    // URL suffixes before extracting the repo name. Users often
    // paste the URL from their browser address bar which looks like
    //   https://github.com/foo/bar/tree/main
    //   https://github.com/foo/bar/pull/42
    //   https://github.com/foo/bar/commits
    // All of these should resolve to project name "bar", and the
    // canonical clone URL is "https://github.com/foo/bar.git".
    var normalized = val;
    var githubViewMatch = /^(https?:\/\/(?:www\.)?github\.com\/[^/]+\/[^/]+)(?:\/(?:tree|blob|pull|commits|issues|actions|wiki|releases|settings)(?:\/.*)?)?\/?$/i.exec(val);
    if (githubViewMatch) {
      normalized = githubViewMatch[1];
      if (!/\.git$/i.test(normalized)) normalized += '.git';
    }

    // Derive project name from the URL's last segment, stripping .git
    var segment = normalized;
    // Handle git@github.com:foo/bar.git → take "bar"
    var colonMatch = /^git@[^:]+:(.+)$/.exec(val);
    if (colonMatch) segment = colonMatch[1];
    // Strip trailing slash(es)
    segment = segment.replace(/\/+$/, '');
    var lastSlash = segment.lastIndexOf('/');
    if (lastSlash >= 0) segment = segment.slice(lastSlash + 1);
    segment = segment.replace(/\.git$/i, '');
    if (!segment) segment = 'project';

    return { kind: 'url', name: segment, gitRepoUrl: normalized };
  }

  // Called from the smart-input oninput handler — updates the hint
  // text live as the user types so they see the auto-derived name
  // and what the form will do when they hit Create.
  function _updateCreateHint() {
    var raw = (document.getElementById('cp-smart-input') || {}).value || '';
    var parsed = _parseSmartInput(raw);
    var hintEl = document.getElementById('cp-hint');
    if (!hintEl) return;

    if (parsed.kind === 'empty') {
      hintEl.textContent = '粘贴一个 Git URL (会自动 clone)，或者输入一个项目名 (创建空项目)';
      hintEl.style.color = 'var(--text-muted)';
    } else if (parsed.kind === 'url') {
      hintEl.innerHTML = '<svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor" style="vertical-align:-1px"><path d="M8 0L1.5 4v8L8 16l6.5-4V4L8 0zm0 1.5l5 3.1v6.8L8 14.5l-5-3.1V4.6L8 1.5z"/></svg> 识别为 Git 仓库。将创建项目 <strong style="color:var(--text-primary)">' + escapeHtml(parsed.name) + '</strong> 并自动克隆';
      hintEl.style.color = 'var(--green, #10b981)';
    } else {
      hintEl.innerHTML = '<svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor" style="vertical-align:-1px"><path d="M2 1.75C2 .784 2.784 0 3.75 0h6.586c.464 0 .909.184 1.237.513l2.914 2.914c.329.328.513.773.513 1.237v9.586A1.75 1.75 0 0112.25 16h-8.5A1.75 1.75 0 012 14.25V1.75zm1.75-.25a.25.25 0 00-.25.25v12.5c0 .138.112.25.25.25h8.5a.25.25 0 00.25-.25V6h-2.75A1.75 1.75 0 018 4.25V1.5H3.75zm6.75.062V4.25c0 .138.112.25.25.25h2.688a.252.252 0 00-.011-.013l-2.914-2.914a.272.272 0 00-.013-.011z"/></svg> 将创建空项目 <strong style="color:var(--text-primary)">' + escapeHtml(parsed.name) + '</strong>（无 Git 集成，可后续补充）';
      hintEl.style.color = 'var(--text-secondary)';
    }
  }
  window._updateCreateHint = _updateCreateHint;

  // Toggle the "更多选项" collapsible section.
  function _toggleCreateAdvanced() {
    var sec = document.getElementById('cp-advanced-section');
    var chev = document.getElementById('cp-advanced-chev');
    if (!sec) return;
    var nowOpen = sec.style.display === 'none' || sec.style.display === '';
    sec.style.display = nowOpen ? 'block' : 'none';
    if (chev) chev.style.transform = nowOpen ? 'rotate(90deg)' : 'rotate(0deg)';
  }
  window._toggleCreateAdvanced = _toggleCreateAdvanced;

  function handleCreateProjectSubmit(event) {
    event.preventDefault();
    var smartEl = document.getElementById('cp-smart-input');
    var nameEl = document.getElementById('cp-name');
    var slugEl = document.getElementById('cp-slug');
    var descEl = document.getElementById('cp-description');
    var errEl = document.getElementById('createProjectError');
    errEl.textContent = '';

    var parsed = _parseSmartInput(smartEl ? smartEl.value : '');
    if (parsed.kind === 'empty') {
      errEl.textContent = '请粘贴 Git URL 或输入项目名';
      return;
    }

    // Advanced name override wins if the user opened the section
    // and typed something explicit.
    var nameOverride = nameEl && nameEl.value.trim();
    var finalName = nameOverride || parsed.name;

    var payload = {
      name: finalName,
      slug: slugEl && slugEl.value.trim() || undefined,
      gitRepoUrl: parsed.gitRepoUrl || undefined,
      description: descEl && descEl.value.trim() || undefined,
    };

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
          var adj = result.body && result.body.slugAutoAdjusted;
          if (adj && adj.to && adj.from && adj.to !== adj.from) {
            showToast('项目 “' + payload.name + '” 已创建（slug 自动调整为 ' + adj.to + '，原 ' + adj.from + ' 已被占用）');
          } else {
            showToast('项目 “' + payload.name + '” 已创建');
          }
          loadProjects();
          var created = result.body && result.body.project;
          // P4 Part 18 (UX rework): if the new project was created
          // WITH a gitRepoUrl + the server stamped cloneStatus=pending,
          // auto-open the clone progress modal. The clone modal itself
          // then chains: clone → detect stack → offer "Create default
          // build profile" so the user goes from "paste URL" to
          // "ready to deploy" in a single continuous experience.
          if (created && created.cloneStatus === 'pending') {
            handleCloneProject(null, created.id, created.name, created.gitRepoUrl || '');
          }
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

  // ── Clone project (P4 Part 18 G1.7) ───────────────────────────────
  //
  // Triggers POST /api/projects/:id/clone via fetch + manual SSE
  // decoding (EventSource doesn't support POST). Streams each
  // `event: … / data: …` block into the modal log as it arrives,
  // flips the title/status pill through the lifecycle, and on
  // complete auto-closes after 1.5s and refreshes the grid. On
  // error, leaves the modal open so the user can read the message.

  var cloneModalAbort = null;

  function getCloneModal() { return document.getElementById('cloneProgressModal'); }

  function setCloneModalStatus(status, textOverride) {
    var pill = document.getElementById('cloneModalStatus');
    var text = document.getElementById('cloneModalStatusText');
    if (!pill || !text) return;
    pill.className = 'cds-clone-status ' + status;
    text.textContent = textOverride || status.toUpperCase();
    // Only show spinner for the 'cloning' state.
    var existingSpinner = pill.querySelector('.spinner');
    if (status === 'cloning') {
      if (!existingSpinner) {
        var s = document.createElement('span');
        s.className = 'spinner';
        pill.insertBefore(s, text);
      }
    } else if (existingSpinner) {
      existingSpinner.remove();
    }
  }

  function appendCloneLogLine(text, cls) {
    var logEl = document.getElementById('cloneModalLog');
    if (!logEl) return;
    var line = document.createElement('span');
    line.className = 'line' + (cls ? ' ' + cls : '');
    line.textContent = text;
    logEl.appendChild(line);
    // Auto-scroll to bottom on every new line
    logEl.scrollTop = logEl.scrollHeight;
  }

  function clearCloneLog() {
    var logEl = document.getElementById('cloneModalLog');
    if (logEl) logEl.innerHTML = '';
  }

  function handleCloneProject(event, projectId, projectName, gitRepoUrl) {
    if (event) {
      event.preventDefault();
      event.stopPropagation();
    }
    var modal = getCloneModal();
    if (!modal) return;

    // Reset modal state
    var titleEl = document.getElementById('cloneModalTitle');
    var urlEl = document.getElementById('cloneModalUrl');
    var closeBtn = document.getElementById('cloneModalCloseBtn');
    if (titleEl) titleEl.textContent = '克隆: ' + projectName;
    if (urlEl) urlEl.textContent = gitRepoUrl || '(no gitRepoUrl)';
    if (closeBtn) {
      closeBtn.textContent = '取消';
      closeBtn.disabled = false;
    }
    clearCloneLog();
    setCloneModalStatus('cloning', 'CLONING');
    appendCloneLogLine('→ POST /api/projects/' + projectId + '/clone', 'info');
    modal.classList.add('visible');

    // Abort any previous clone
    if (cloneModalAbort) {
      try { cloneModalAbort.abort(); } catch (e) { /* */ }
    }
    var controller = new AbortController();
    cloneModalAbort = controller;

    fetch('/api/projects/' + encodeURIComponent(projectId) + '/clone', {
      method: 'POST',
      headers: { Accept: 'text/event-stream' },
      credentials: 'same-origin',
      signal: controller.signal,
    })
      .then(function (res) {
        if (!res.ok) {
          return res.json().then(function (body) {
            throw new Error((body && body.message) || ('HTTP ' + res.status));
          });
        }
        if (!res.body) throw new Error('Streaming not supported by this browser');
        return res.body.getReader();
      })
      .then(function (reader) {
        var decoder = new TextDecoder();
        var buffer = '';
        var sawComplete = false;
        var sawError = false;

        function processBuffer() {
          // Each SSE block is separated by a blank line ("\n\n").
          var idx;
          while ((idx = buffer.indexOf('\n\n')) >= 0) {
            var block = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 2);

            var eventMatch = block.match(/^event: (.+)$/m);
            var dataMatch = block.match(/^data: (.+)$/m);
            if (!eventMatch || !dataMatch) continue;

            var eventName = eventMatch[1].trim();
            var data = {};
            try { data = JSON.parse(dataMatch[1].trim()); } catch (e) { /* keep as string */ }

            if (eventName === 'start') {
              appendCloneLogLine('[start] ' + (data.gitRepoUrl || '') + ' → ' + (data.repoPath || ''), 'info');
              setCloneModalStatus('cloning', 'CLONING');
            } else if (eventName === 'progress') {
              appendCloneLogLine(data.line || '');
            } else if (eventName === 'complete') {
              appendCloneLogLine('[complete] 项目已就绪: ' + (data.repoPath || ''), 'complete');
              setCloneModalStatus('ready', 'READY');
              sawComplete = true;
            } else if (eventName === 'error') {
              appendCloneLogLine('[error] ' + (data.message || 'unknown'), 'error');
              setCloneModalStatus('error', 'ERROR');
              sawError = true;
            }
          }
        }

        function pump() {
          return reader.read().then(function (result) {
            if (result.done) {
              // Post-stream: run the detect → auto-profile chain on success,
              // leave the modal open on error so the user can read the log.
              if (sawComplete) {
                _runPostCloneChain(projectId, projectName, modal, closeBtn);
              } else if (sawError) {
                // Leave modal open, let the user read the error.
                if (closeBtn) closeBtn.textContent = '关闭';
                loadProjects();
              } else {
                appendCloneLogLine('[stream ended unexpectedly]', 'error');
                loadProjects();
              }
              return;
            }
            buffer += decoder.decode(result.value, { stream: true });
            processBuffer();
            return pump();
          });
        }
        return pump();
      })
      .catch(function (err) {
        if (err.name === 'AbortError') {
          appendCloneLogLine('[aborted]', 'error');
          return;
        }
        appendCloneLogLine('[error] ' + (err.message || err), 'error');
        setCloneModalStatus('error', 'ERROR');
        if (closeBtn) closeBtn.textContent = '关闭';
      });
  }

  function closeCloneProgressModal(event) {
    var modal = getCloneModal();
    if (!modal) return;
    if (event && event.currentTarget !== event.target) return;
    if (cloneModalAbort) {
      try { cloneModalAbort.abort(); } catch (e) { /* */ }
      cloneModalAbort = null;
    }
    modal.classList.remove('visible');
  }

  // ── Pending-import approval UI ────────────────────────────────────
  //
  // External agents (Claude Code running cds-project-scan etc.) submit
  // compose YAML via POST /api/projects/:id/pending-import. A human
  // operator sees a yellow 🔔 badge in the header and opens the right-
  // side drawer to approve/reject each request.
  //
  // Polling cadence: 10s while the page is open. We cache both the
  // project list (for name lookup) and the last imports response so
  // the drawer renders instantly on open.

  // Project id → { id, name, ... }. Populated by loadProjects() so the
  // drawer can show "目标项目: foo" without another network call.
  var _projectsById = {};

  // Cached last pollPendingImports() response.
  var _lastPendingImportsResp = null;
  // Map of importId → YAML text fetched lazily from /pending-imports/:id
  // the first time the user expands "预览 YAML" on a card.
  var _importYamlCache = {};
  // Map of importId → bool, tracks whether the card's "预览 YAML"
  // collapsible section is currently expanded.
  var _importYamlExpanded = {};
  // Import ids currently busy with approve/reject so buttons can be
  // disabled and double-clicks don't fire two network calls.
  var _importBusy = {};

  var PENDING_IMPORT_POLL_MS = 10000;
  var _pendingImportPollTimer = null;

  function pollPendingImports() {
    fetch('/api/pending-imports', { credentials: 'same-origin', cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .catch(function () { return null; })
      .then(function (data) {
        if (!data) return;
        _lastPendingImportsResp = data;
        _updatePendingImportBadge(data.pendingCount || 0);
        // Re-render drawer body if it's currently open so the user
        // sees approvals submitted from other tabs without a manual
        // refresh.
        var drawer = document.getElementById('pendingImportDrawer');
        if (drawer && drawer.style.display === 'flex') {
          renderPendingImportDrawer();
        }
      });
  }

  // Tracks the last pendingCount we rendered so we can detect a RISE
  // (new agent submission) and trigger a short flash animation. Starts
  // at -1 so the first load doesn't auto-flash on page reload.
  var _lastPendingCount = -1;

  function _updatePendingImportBadge(count) {
    var btn = document.getElementById('pendingImportBadge');
    var label = document.getElementById('pendingImportBadgeLabel');
    var icon = document.getElementById('pendingImportBadgeIcon');
    if (!btn || !label) return;
    // Badge is ALWAYS visible. State toggles purely via color/label so
    // the operator can click into history at any time even when
    // pendingCount=0 (they want to see past申请/批准/拒绝 records).
    btn.style.display = 'inline-flex';
    if (count > 0) {
      btn.setAttribute('data-state', 'active');
      label.textContent = count + ' 个 Agent 申请配置';
      if (icon) icon.textContent = '🔔';
      // Flash only on a RISE from the previously observed count. Don't
      // flash on steady state or on decrease (approvals/rejects shouldn't
      // make it blink — only brand-new incoming requests do).
      if (_lastPendingCount >= 0 && count > _lastPendingCount) {
        btn.classList.remove('pi-flash');
        // Reflow to restart the CSS animation from frame 0.
        void btn.offsetWidth;
        btn.classList.add('pi-flash');
        setTimeout(function () { btn.classList.remove('pi-flash'); }, 3000);
      }
    } else {
      btn.setAttribute('data-state', 'idle');
      label.textContent = 'Agent 记录';
      if (icon) icon.textContent = '📜';
    }
    _lastPendingCount = count;
  }

  function openPendingImportDrawer(targetImportId) {
    var drawer = document.getElementById('pendingImportDrawer');
    var backdrop = document.getElementById('pendingImportDrawerBackdrop');
    if (!drawer || !backdrop) return;
    backdrop.style.display = 'block';
    drawer.style.display = 'flex';
    // Kick the transform transition on next frame so it animates in
    // rather than appearing instantly.
    requestAnimationFrame(function () {
      drawer.style.transform = 'translateX(0)';
    });
    drawer.setAttribute('aria-hidden', 'false');
    // Force-refresh the list on open — the cached response may be
    // up to 10s stale and the user specifically opened the drawer to
    // see the current state.
    fetch('/api/pending-imports', { credentials: 'same-origin', cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) {
        if (data) {
          _lastPendingImportsResp = data;
          _updatePendingImportBadge(data.pendingCount || 0);
        }
        renderPendingImportDrawer(targetImportId);
      })
      .catch(function () {
        renderPendingImportDrawer(targetImportId);
      });
  }

  function closePendingImportDrawer(event) {
    if (event && event.currentTarget !== event.target) return;
    var drawer = document.getElementById('pendingImportDrawer');
    var backdrop = document.getElementById('pendingImportDrawerBackdrop');
    if (!drawer || !backdrop) return;
    drawer.style.transform = 'translateX(100%)';
    drawer.setAttribute('aria-hidden', 'true');
    // Hide after the transform animation completes.
    setTimeout(function () {
      drawer.style.display = 'none';
      backdrop.style.display = 'none';
    }, 200);
  }

  function renderPendingImportDrawer(scrollToImportId) {
    var body = document.getElementById('pendingImportDrawerBody');
    var subtitle = document.getElementById('pendingImportDrawerSubtitle');
    if (!body) return;
    var resp = _lastPendingImportsResp;
    if (!resp) {
      body.innerHTML = '<div style="padding:60px 20px;text-align:center;color:var(--text-muted);font-size:12px">加载失败，稍后重试</div>';
      return;
    }
    var imports = resp.imports || [];
    var pending = imports.filter(function (it) { return it.status === 'pending'; });
    var decided = imports.filter(function (it) { return it.status !== 'pending'; });
    if (subtitle) {
      var firstImport = pending[0] || imports[0];
      var focusPid = firstImport && firstImport.projectId;
      subtitle.innerHTML =
        pending.length + ' 个待处理 · ' + decided.length + ' 个最近处理' +
        (focusPid
          ? ' · <a href="#" style="color:var(--accent);text-decoration:underline" ' +
            'onclick="event.preventDefault();event.stopPropagation();window.cdsOpenAgentKeyModal(\'' +
            focusPid + '\')">签发新 Agent Key</a>'
          : '');
    }

    if (imports.length === 0) {
      body.innerHTML = [
        '<div style="padding:60px 20px;text-align:center;color:var(--text-muted);font-size:12px;line-height:1.6">',
        '  <div style="font-size:32px;margin-bottom:10px">📭</div>',
        '  <div style="margin-bottom:6px">暂无 Agent 配置申请</div>',
        '  <div style="font-size:11px;color:var(--text-muted);opacity:0.7">Agent 通过 <code>POST /api/projects/:id/pending-import</code> 提交的请求会出现在这里；已处理记录保留 7 天</div>',
        '</div>',
      ].join('');
      return;
    }

    var html = '';
    if (pending.length > 0) {
      html += pending.map(renderPendingImportCard).join('');
    }
    if (decided.length > 0) {
      html += [
        '<div style="margin-top:22px;padding-top:14px;border-top:1px solid var(--card-border)">',
        '  <div style="display:flex;align-items:baseline;justify-content:space-between;margin-bottom:10px">',
        '    <div style="font-size:10px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;color:var(--text-muted)">最近处理（近 7 天）</div>',
        '    <div style="font-size:10px;color:var(--text-muted);opacity:0.6">共 ' + decided.length + ' 条</div>',
        '  </div>',
        '  ', decided.map(renderPendingImportCard).join(''),
        '</div>',
      ].join('');
    }
    body.innerHTML = html;

    // Scroll target card into view if ?pendingImport=... was passed.
    if (scrollToImportId) {
      var target = body.querySelector('[data-import-id="' + scrollToImportId.replace(/"/g, '') + '"]');
      if (target && target.scrollIntoView) {
        target.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    }
  }

  function renderPendingImportCard(item) {
    var isDecided = item.status !== 'pending';
    var projName = (_projectsById[item.projectId] && _projectsById[item.projectId].name)
      || ('(已删除的项目 ' + item.projectId + ')');
    var pills = [];
    if (item.summary) {
      if (item.summary.addedProfiles && item.summary.addedProfiles.length > 0) {
        pills.push('<span style="padding:2px 7px;background:rgba(59,130,246,0.15);border:1px solid rgba(59,130,246,0.35);border-radius:4px;color:#60a5fa;font-size:10px;font-weight:600">+' + item.summary.addedProfiles.length + ' profiles</span>');
      }
      if (item.summary.addedInfra && item.summary.addedInfra.length > 0) {
        pills.push('<span style="padding:2px 7px;background:rgba(139,92,246,0.15);border:1px solid rgba(139,92,246,0.35);border-radius:4px;color:#a78bfa;font-size:10px;font-weight:600">+' + item.summary.addedInfra.length + ' infra</span>');
      }
      if (item.summary.addedEnvKeys && item.summary.addedEnvKeys.length > 0) {
        pills.push('<span style="padding:2px 7px;background:rgba(16,185,129,0.15);border:1px solid rgba(16,185,129,0.35);border-radius:4px;color:#34d399;font-size:10px;font-weight:600">+' + item.summary.addedEnvKeys.length + ' env</span>');
      }
    }

    var statusBadge = '';
    if (item.status === 'approved') {
      statusBadge = '<span style="padding:2px 8px;background:rgba(16,185,129,0.15);border:1px solid rgba(16,185,129,0.4);border-radius:4px;color:#34d399;font-size:10px;font-weight:700;letter-spacing:0.3px">已批准</span>';
    } else if (item.status === 'rejected') {
      statusBadge = '<span style="padding:2px 8px;background:rgba(244,63,94,0.15);border:1px solid rgba(244,63,94,0.4);border-radius:4px;color:#fca5a5;font-size:10px;font-weight:700;letter-spacing:0.3px">已拒绝</span>';
    }

    var busy = _importBusy[item.id];
    var expanded = _importYamlExpanded[item.id];
    var yamlText = _importYamlCache[item.id];
    var idAttr = escapeHtml(item.id);

    // Build the card body. Uses inline styles (no new CSS class needed)
    // so the drawer is self-contained; mild opacity on decided cards.
    var cardStyle = 'padding:14px 14px 12px;margin-bottom:12px;background:var(--bg-elevated);border:1px solid var(--card-border);border-radius:10px;' +
      (isDecided ? 'opacity:0.7' : '');

    var actions = '';
    if (!isDecided) {
      actions = [
        '<div style="display:flex;gap:8px;margin-top:12px">',
        '  <button type="button" ' + (busy ? 'disabled' : '') + ' onclick="_pendingImportApprove(\'' + idAttr + '\')" ',
        '    style="flex:1;padding:8px 12px;background:rgba(16,185,129,0.18);border:1px solid rgba(16,185,129,0.45);border-radius:7px;color:#34d399;font-size:12px;font-weight:700;cursor:' + (busy ? 'wait' : 'pointer') + ';font-family:inherit">',
        '    ', busy === 'approve' ? '正在应用…' : '批准并应用',
        '  </button>',
        '  <button type="button" ' + (busy ? 'disabled' : '') + ' onclick="_pendingImportReject(\'' + idAttr + '\')" ',
        '    style="padding:8px 14px;background:transparent;border:1px solid rgba(244,63,94,0.45);border-radius:7px;color:#fca5a5;font-size:12px;font-weight:600;cursor:' + (busy ? 'wait' : 'pointer') + ';font-family:inherit">',
        '    ', busy === 'reject' ? '…' : '拒绝',
        '  </button>',
        '</div>',
      ].join('');
    } else if (item.status === 'rejected' && item.rejectReason) {
      actions = '<div style="margin-top:10px;font-size:11px;color:var(--text-muted)">拒绝理由：' + escapeHtml(item.rejectReason) + '</div>';
    }

    var yamlSection = '';
    if (expanded) {
      var content;
      if (yamlText === undefined) {
        content = '<div style="padding:12px;color:var(--text-muted);font-size:11px">正在加载 YAML…</div>';
      } else if (yamlText === null) {
        content = '<div style="padding:12px;color:#fca5a5;font-size:11px">YAML 加载失败</div>';
      } else {
        // 2026-04-22：bg+color 走主题 token，白天浅底深字，黑夜深底浅字。禁止 hardcoded 颜色。
        content = '<pre style="margin:0;padding:10px 12px;font-family:var(--font-mono,monospace);font-size:10.5px;line-height:1.55;color:var(--text-primary);background:var(--bg-terminal);border-radius:6px;max-height:280px;overflow:auto;white-space:pre;">' + escapeHtml(yamlText) + '</pre>';
      }
      yamlSection = (
        '<div style="margin-top:10px">' +
          '<button type="button" onclick="_toggleImportYaml(\'' + idAttr + '\')" ' +
            'style="background:transparent;border:none;color:var(--text-muted);font-size:11px;cursor:pointer;padding:0;margin-bottom:6px;font-family:inherit">' +
            '▾ 预览 YAML（点击收起）' +
          '</button>' +
          content +
        '</div>'
      );
    } else {
      yamlSection = (
        '<button type="button" onclick="_toggleImportYaml(\'' + idAttr + '\')" ' +
          'style="background:transparent;border:none;color:var(--text-muted);font-size:11px;cursor:pointer;padding:0;margin-top:8px;font-family:inherit">' +
          '▸ 预览 YAML' +
        '</button>'
      );
    }

    return [
      '<div data-import-id="', idAttr, '" style="', cardStyle, '">',
      '  <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:4px">',
      '    <div style="font-size:13px;font-weight:700;color:var(--text-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">',
      '      ', escapeHtml(item.agentName || '(未知 Agent)'),
      '    </div>',
      '    <div style="display:flex;align-items:center;gap:6px;flex-shrink:0">',
      '      ', statusBadge,
      '      <span style="font-size:10px;color:var(--text-muted)">', escapeHtml(formatRelative(item.submittedAt)), '</span>',
      '    </div>',
      '  </div>',
      '  <div style="font-size:11px;color:var(--text-secondary);margin-bottom:6px">',
      '    目标项目：<strong style="color:var(--text-primary)">', escapeHtml(projName), '</strong>',
      '  </div>',
      item.purpose
        ? '  <div style="font-size:12px;color:var(--text-secondary);line-height:1.5;margin-bottom:8px">' + escapeHtml(item.purpose) + '</div>'
        : '',
      pills.length > 0
        ? '  <div style="display:flex;flex-wrap:wrap;gap:5px;margin-bottom:4px">' + pills.join('') + '</div>'
        : '',
      '  ', yamlSection,
      '  ', actions,
      '</div>',
    ].join('');
  }

  function _toggleImportYaml(importId) {
    var willExpand = !_importYamlExpanded[importId];
    _importYamlExpanded[importId] = willExpand;
    // Lazy-load the YAML the first time the user expands the section.
    // Cache it forever (drawer session) — YAML is immutable once
    // submitted.
    if (willExpand && _importYamlCache[importId] === undefined) {
      // Re-render immediately so the "正在加载 YAML…" placeholder shows
      renderPendingImportDrawer();
      fetch('/api/pending-imports/' + encodeURIComponent(importId), {
        credentials: 'same-origin',
      })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (body) {
          _importYamlCache[importId] = (body && body.import && body.import.composeYaml) || null;
          if (_importYamlExpanded[importId]) renderPendingImportDrawer();
        })
        .catch(function () {
          _importYamlCache[importId] = null;
          if (_importYamlExpanded[importId]) renderPendingImportDrawer();
        });
    } else {
      renderPendingImportDrawer();
    }
  }

  function _pendingImportApprove(importId) {
    if (_importBusy[importId]) return;
    _importBusy[importId] = 'approve';
    renderPendingImportDrawer();
    fetch('/api/pending-imports/' + encodeURIComponent(importId) + '/approve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
    })
      .then(function (res) {
        return res.json().then(function (body) { return { status: res.status, body: body }; });
      })
      .then(function (result) {
        _importBusy[importId] = null;
        if (result.status === 200 && result.body && result.body.applied) {
          // Look up the target project name for the toast.
          var item = (_lastPendingImportsResp && _lastPendingImportsResp.imports || [])
            .filter(function (it) { return it.id === importId; })[0];
          var projName = item && _projectsById[item.projectId]
            ? _projectsById[item.projectId].name
            : (item ? item.projectId : '项目');
          var profCount = (result.body.appliedProfiles || []).length;
          showToast('已应用到 ' + projName + '（+' + profCount + ' profiles）');
          pollPendingImports();
          loadProjects();
        } else {
          var msg = (result.body && result.body.message) || ('批准失败 (HTTP ' + result.status + ')');
          showToast('批准失败：' + msg);
          pollPendingImports();
        }
      })
      .catch(function (err) {
        _importBusy[importId] = null;
        showToast('网络错误：' + (err && err.message ? err.message : err));
        renderPendingImportDrawer();
      });
  }

  function _pendingImportReject(importId) {
    if (_importBusy[importId]) return;
    // Keep it dead simple per spec: window.prompt for an optional reason.
    var reason = window.prompt('拒绝理由（可选，回车确认）：', '');
    if (reason === null) return; // user cancelled
    _importBusy[importId] = 'reject';
    renderPendingImportDrawer();
    fetch('/api/pending-imports/' + encodeURIComponent(importId) + '/reject', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ reason: reason }),
    })
      .then(function (res) {
        return res.json().then(function (body) { return { status: res.status, body: body }; });
      })
      .then(function (result) {
        _importBusy[importId] = null;
        if (result.status === 200) {
          showToast('已拒绝该申请');
        } else {
          var msg = (result.body && result.body.message) || ('拒绝失败 (HTTP ' + result.status + ')');
          showToast('拒绝失败：' + msg);
        }
        pollPendingImports();
      })
      .catch(function (err) {
        _importBusy[importId] = null;
        showToast('网络错误：' + (err && err.message ? err.message : err));
        renderPendingImportDrawer();
      });
  }

  function startPendingImportPoll() {
    pollPendingImports();
    if (_pendingImportPollTimer) clearInterval(_pendingImportPollTimer);
    _pendingImportPollTimer = setInterval(pollPendingImports, PENDING_IMPORT_POLL_MS);
  }

  // ── Projects clone-state polling ──────────────────────────────────
  //
  // While any project is in a non-terminal clone state (pending/cloning)
  // we poll /api/projects every 5s so the yellow "正在克隆…" bar flips
  // to the normal service strip without a manual refresh. Polling
  // self-disables when nothing non-terminal remains.

  var CLONE_POLL_MS = 5000;
  var _clonePollTimer = null;

  function _hasNonTerminalClone(projects) {
    for (var i = 0; i < (projects || []).length; i++) {
      var st = projects[i].cloneStatus;
      if (st === 'pending' || st === 'cloning') return true;
    }
    return false;
  }

  function _syncClonePoll(projects) {
    if (_hasNonTerminalClone(projects)) {
      if (!_clonePollTimer) {
        _clonePollTimer = setInterval(loadProjects, CLONE_POLL_MS);
      }
    } else if (_clonePollTimer) {
      clearInterval(_clonePollTimer);
      _clonePollTimer = null;
    }
  }

  // ── End-to-end auto flow (P4 Part 18 UX rework) ───────────────────
  //
  // Once a clone completes successfully we keep the modal open and
  // chain:
  //
  //   1. POST /api/detect-stack { projectId }
  //      Logs the detected stack + summary. Unknown stack is OK —
  //      just means the user has to configure the profile by hand.
  //   2. If stack is known AND not a Dockerfile (which requires an
  //      externally-built image), POST /api/build-profiles to
  //      auto-create a default profile using the detected settings.
  //   3. Log the profile creation and close the modal.
  //
  // The user goes from "paste URL" to "ready to deploy" without
  // ever touching the BuildProfile form. They can still tune things
  // afterwards — this just skips the friction for the common case.

  async function _runPostCloneChain(projectId, projectName, modal, closeBtn) {
    try {
      appendCloneLogLine('', '');
      appendCloneLogLine('[detect] 扫描代码仓库识别技术栈…', 'info');

      var detectRes = await fetch('/api/detect-stack', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ projectId: projectId }),
      });
      if (!detectRes.ok) {
        // Non-fatal: detection failed (server error or new deployment).
        // Fall through to manual-setup path instead of aborting the chain.
        appendCloneLogLine('[detect] 未能自动识别技术栈（HTTP ' + detectRes.status + '），请手动配置', 'warning');
        _finalizeCloneModal(modal, closeBtn, projectName, '项目已就绪，请手动添加构建配置');
        return;
      }
      var detection = await detectRes.json();
      appendCloneLogLine('[detect] ' + (detection.summary || detection.stack), 'info');

      if (detection.stack === 'unknown') {
        appendCloneLogLine('未识别出已知栈 — 请在项目设置里手动添加构建配置', 'error');
        _finalizeCloneModal(modal, closeBtn, projectName, '项目已就绪，但需要手动配置构建');
        return;
      }
      if (detection.manualSetupRequired) {
        appendCloneLogLine('⚠ ' + (detection.summary || 'manual setup required'), 'error');
        _finalizeCloneModal(modal, closeBtn, projectName, '项目已就绪，但需要手动配置镜像');
        return;
      }

      // Auto-create a default build profile.
      appendCloneLogLine('[profile] 自动创建默认构建配置…', 'info');
      var profileId = _suggestProfileId(detection.stack, projectName);
      var profile = {
        id: profileId,
        name: profileId,
        projectId: projectId,
        dockerImage: detection.dockerImage,
        workDir: detection.workDir || '.',
        containerPort: detection.containerPort || 8080,
        command: detection.runCommand || '',
        installCommand: detection.installCommand || undefined,
        buildCommand: detection.buildCommand || undefined,
      };
      var profRes = await fetch('/api/build-profiles', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(profile),
      });
      if (!profRes.ok) {
        var pb = await profRes.json().catch(function () { return {}; });
        // 409 is fine — profile already exists. Anything else → warn
        // but still finalize, the clone itself succeeded.
        appendCloneLogLine('⚠ 构建配置创建失败: ' + (pb.error || profRes.status), 'error');
        _finalizeCloneModal(modal, closeBtn, projectName, '项目已就绪（构建配置需要手动创建）');
        return;
      }
      appendCloneLogLine('[profile] 已创建: ' + profileId + ' (' + detection.dockerImage + ')', 'complete');
      appendCloneLogLine('[profile]   run: ' + detection.runCommand, 'info');
      if (detection.installCommand) {
        appendCloneLogLine('[profile]   install: ' + detection.installCommand, 'info');
      }
      if (detection.buildCommand) {
        appendCloneLogLine('[profile]   build: ' + detection.buildCommand, 'info');
      }

      _finalizeCloneModal(modal, closeBtn, projectName, '项目已就绪，可以部署');
    } catch (err) {
      appendCloneLogLine('[chain-error] ' + (err && err.message ? err.message : err), 'error');
      if (closeBtn) closeBtn.textContent = '关闭';
      loadProjects();
    }
  }

  function _suggestProfileId(stack, projectName) {
    // Map stack → short handle for the profile id
    var handle = {
      nodejs: 'api',
      python: 'api',
      go: 'api',
      rust: 'api',
      java: 'api',
      ruby: 'api',
      php: 'api',
    }[stack] || 'app';
    return handle;
  }

  function _finalizeCloneModal(modal, closeBtn, projectName, toastMsg) {
    showToast(toastMsg || ('克隆完成: ' + projectName));
    loadProjects();
    // Give the user a moment to read the final log lines, then close.
    setTimeout(function () {
      try { modal.classList.remove('visible'); } catch (e) { /* */ }
    }, 2400);
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
  window.handleCloneProject = handleCloneProject;
  window.closeCloneProgressModal = closeCloneProgressModal;

  // Pending-import drawer handlers (called from inline onclick attributes
  // in project-list.html and from card actions rendered as HTML strings).
  window.openPendingImportDrawer = openPendingImportDrawer;
  window.closePendingImportDrawer = closePendingImportDrawer;
  window._toggleImportYaml = _toggleImportYaml;
  window._pendingImportApprove = _pendingImportApprove;
  window._pendingImportReject = _pendingImportReject;

  // P4 Part 18 (Phase E audit fix #7): close the TOPMOST visible
  // modal on ESC, not a hardcoded one. Previously ESC always
  // targeted createProjectModal, so if a user hit ESC while the
  // device-flow modal or repo picker was stacked on top, the
  // underlying create modal closed and they were stranded with
  // a top-level modal that had lost its parent context.
  //
  // Order: picker (topmost when chaining sign-in → pick) > device
  // flow (topmost while polling) > create modal (base layer).
  // Toast / clone-progress aren't ESC-dismissible on purpose —
  // they're time-critical feedback the user should see.
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    var picker = document.getElementById('githubRepoPickerModal');
    var device = document.getElementById('githubDeviceModal');
    var create = getModal();
    var drawer = document.getElementById('pendingImportDrawer');
    if (picker && picker.classList.contains('visible')) {
      closeRepoPickerModal();
      return;
    }
    if (device && device.classList.contains('visible')) {
      closeGithubDeviceModal();
      return;
    }
    if (create && create.classList.contains('visible')) {
      create.classList.remove('visible');
      return;
    }
    if (drawer && drawer.style.display === 'flex') {
      closePendingImportDrawer();
    }
  });

  loadProjects();
  bootstrapMeLabel();
  startPendingImportPoll();

  // P4 Part 18 (UX rework): if the user arrived via projects.html?new=git
  // (e.g. from topology "+ Add → GitHub Repository"), auto-open the
  // create modal so they don't have to hunt for the New button. Also
  // strip the query string so a page refresh doesn't re-pop the modal.
  //
  // The cds-project-scan skill's success message includes a
  // ?pendingImport=<id> deep link. When that query param is present,
  // auto-open the drawer and scroll to the target card. Strip the
  // param so a refresh doesn't re-pop the drawer.
  (function handleAutoOpenQuery() {
    try {
      var q = new URLSearchParams(location.search);
      if (q.get('new') === 'git') {
        setTimeout(openCreateProjectModal, 80);
        q.delete('new');
      }
      var targetImportId = q.get('pendingImport');
      if (targetImportId) {
        // Give pollPendingImports() a moment to land the first response
        // so the drawer has data to render against.
        setTimeout(function () {
          openPendingImportDrawer(targetImportId);
        }, 240);
        q.delete('pendingImport');
      }
      var newUrl = location.pathname + (q.toString() ? '?' + q.toString() : '') + location.hash;
      if (newUrl !== location.pathname + location.search + location.hash) {
        window.history.replaceState(null, '', newUrl);
      }
    } catch (e) { /* no-op */ }
  })();
})();
