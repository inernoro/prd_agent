const API = '/api';
const busyBranches = new Set();
// Per-button loading state: Map<string, Set<string>> e.g. { "main": Set(["stop", "pull"]) }
const loadingActions = new Map();
let globalBusy = false;

// ── Inline deploy log state ──
// { branchId: { lines: string[], status: 'building'|'done'|'error', expanded: bool, errorMsg?: string } }
const inlineDeployLogs = new Map();
// Track branches that just finished deploy (for slide-in animation)
const justDeployed = new Set();

// ── Icons (Octicons 16px) ──
const ICON = {
  branch: '<svg class="inline-icon" width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M9.5 3.25a2.25 2.25 0 113 2.122V6A2.5 2.5 0 0110 8.5H6a1 1 0 00-1 1v1.128a2.251 2.251 0 11-1.5 0V5.372a2.25 2.25 0 111.5 0v1.836A2.493 2.493 0 016 7h4a1 1 0 001-1v-.628A2.25 2.25 0 019.5 3.25z"/></svg>',
  commit: '<svg class="inline-icon" width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M11.93 8.5a4.002 4.002 0 01-7.86 0H.75a.75.75 0 010-1.5h3.32a4.002 4.002 0 017.86 0h3.32a.75.75 0 010 1.5h-3.32zM8 10.5a2.5 2.5 0 100-5 2.5 2.5 0 000 5z"/></svg>',
  pr: '<svg class="inline-icon" width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M5.45 5.154A4.25 4.25 0 009.25 7.5h1.378a2.251 2.251 0 110 1.5H9.25A5.734 5.734 0 015 7.123v3.505a2.25 2.25 0 11-1.5 0V5.372a2.25 2.25 0 111.95-.218zM4.25 13.5a.75.75 0 100-1.5.75.75 0 000 1.5zm8.5-4.5a.75.75 0 100-1.5.75.75 0 000 1.5zM5 3.25a.75.75 0 10-1.5 0 .75.75 0 001.5 0z"/></svg>',
  pull: '<svg class="inline-icon" width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M8 2.004a.75.75 0 01.75.75v5.689l1.97-1.97a.749.749 0 111.06 1.06l-3.25 3.25a.749.749 0 01-1.06 0L4.22 7.533a.749.749 0 111.06-1.06l1.97 1.97V2.754a.75.75 0 01.75-.75zM2.75 12.5h10.5a.75.75 0 010 1.5H2.75a.75.75 0 010-1.5z"/></svg>',
  preview: '<svg class="inline-icon" width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M0 8s3-5.5 8-5.5S16 8 16 8s-3 5.5-8 5.5S0 8 0 8zm8 3.5a3.5 3.5 0 100-7 3.5 3.5 0 000 7zm0-1.5a2 2 0 110-4 2 2 0 010 4z"/></svg>',
  deploy: '<svg class="inline-icon" width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M8.75.75a.75.75 0 00-1.5 0V2h-3A1.75 1.75 0 002.5 3.75v2.5A1.75 1.75 0 004.25 8h7.5A1.75 1.75 0 0013.5 6.25v-2.5A1.75 1.75 0 0011.75 2h-3V.75zM4.25 3.5h7.5a.25.25 0 01.25.25v2.5a.25.25 0 01-.25.25h-7.5a.25.25 0 01-.25-.25v-2.5a.25.25 0 01.25-.25zM2.5 10.25a.75.75 0 01.75-.75h9.5a.75.75 0 010 1.5h-9.5a.75.75 0 01-.75-.75zm.75 2.25a.75.75 0 000 1.5h9.5a.75.75 0 000-1.5h-9.5z"/></svg>',
  trash: '<svg class="inline-icon" width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M6.5 1.75a.25.25 0 01.25-.25h2.5a.25.25 0 01.25.25V3h-3V1.75zM11 3V1.75A1.75 1.75 0 009.25 0h-2.5A1.75 1.75 0 005 1.75V3H2.75a.75.75 0 000 1.5h.3l.8 8.2A1.75 1.75 0 005.6 14.5h4.8a1.75 1.75 0 001.75-1.8l.8-8.2h.3a.75.75 0 000-1.5H11z"/></svg>',
  reset: '<svg class="inline-icon" width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M8 2.5a5.487 5.487 0 00-4.131 1.869l1.204 1.204A.25.25 0 014.896 6H1.25A.25.25 0 011 5.75V2.104a.25.25 0 01.427-.177l1.38 1.38A7.002 7.002 0 0115 8a.75.75 0 01-1.5 0A5.5 5.5 0 008 2.5z"/></svg>',
  star: '<svg class="inline-icon" width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M8 .25a.75.75 0 01.673.418l1.882 3.815 4.21.612a.75.75 0 01.416 1.279l-3.046 2.97.719 4.192a.75.75 0 01-1.088.791L8 12.347l-3.766 1.98a.75.75 0 01-1.088-.79l.72-4.194L.818 6.374a.75.75 0 01.416-1.28l4.21-.611L7.327.668A.75.75 0 018 .25z"/></svg>',
  starOutline: '<svg class="inline-icon" width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M8 .25a.75.75 0 01.673.418l1.882 3.815 4.21.612a.75.75 0 01.416 1.279l-3.046 2.97.719 4.192a.751.751 0 01-1.088.791L8 12.347l-3.766 1.98a.75.75 0 01-1.088-.79l.72-4.194L.818 6.374a.75.75 0 01.416-1.28l4.21-.611L7.327.668A.75.75 0 018 .25zm0 2.445L6.615 5.5a.75.75 0 01-.564.41l-3.097.45 2.24 2.184a.75.75 0 01.216.664l-.528 3.084 2.769-1.456a.75.75 0 01.698 0l2.77 1.456-.53-3.084a.75.75 0 01.216-.664l2.24-2.183-3.096-.45a.75.75 0 01-.564-.41L8 2.694z"/></svg>',
  edit: '<svg class="inline-icon" width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M11.013 1.427a1.75 1.75 0 012.474 0l1.086 1.086a1.75 1.75 0 010 2.474l-8.61 8.61c-.21.21-.47.364-.756.445l-3.251.93a.75.75 0 01-.927-.928l.929-3.25c.081-.286.235-.547.445-.758l8.61-8.61zM11.189 3L3.75 10.44l-.528 1.849 1.85-.528L12.5 4.311 11.189 3z"/></svg>',
  // Port beacon icons by profile type
  portApi: '<svg class="inline-icon" width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M1.5 1.75a.75.75 0 00-1.5 0v12.5c0 .414.336.75.75.75h14.5a.75.75 0 000-1.5H1.5V1.75zm14.28 2.53a.75.75 0 00-1.06-1.06L10 7.94 7.53 5.47a.75.75 0 00-1.06 0L2.22 9.72a.75.75 0 001.06 1.06L7 7.06l2.47 2.47a.75.75 0 001.06 0l5.25-5.25z"/></svg>',
  portWeb: '<svg class="inline-icon" width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M0 8a8 8 0 1116 0A8 8 0 010 8zm7.5-6.923c-.67.204-1.335.82-1.887 1.855A7.97 7.97 0 005.145 4H7.5V1.077zM4.09 4a9.27 9.27 0 01.64-1.539 6.7 6.7 0 01.597-.933A6.536 6.536 0 002.535 4H4.09zm-.582 3.5c.03-.877.138-1.718.312-2.5H1.674a6.958 6.958 0 00-.656 2.5H3.508zM7.5 11H5.145a7.97 7.97 0 00.468 1.068c.552 1.035 1.218 1.65 1.887 1.855V11zm1 2.923c.67-.204 1.335-.82 1.887-1.855A7.97 7.97 0 0010.855 11H8.5v2.923zM11.91 11a9.27 9.27 0 00.64 1.539 6.7 6.7 0 00.597.933A6.536 6.536 0 0015.465 11H11.91zm.582-1.5c.03-.877.138-1.718.312-2.5h2.49a6.958 6.958 0 01.656 2.5h-3.458z"/></svg>',
  portDefault: '<svg class="inline-icon" width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M4.75 7.25a.75.75 0 000 1.5h6.5a.75.75 0 000-1.5h-6.5z"/><path d="M0 8a8 8 0 1116 0A8 8 0 010 8zm8-6.5a6.5 6.5 0 100 13 6.5 6.5 0 000-13z"/></svg>',
};

// Port beacon icon mapping: profileId → icon key
const PORT_ICON_MAP = {
  api: 'portApi',
  web: 'portWeb',
  admin: 'portWeb',
  frontend: 'portWeb',
};

/** Pick commit/PR icon based on subject text */
function commitIcon(subject) {
  return /^Merge pull request/.test(subject) ? ICON.pr : ICON.commit;
}

// ── Update tracking ──
let branchUpdates = JSON.parse(localStorage.getItem('cds_branch_updates') || '{}'); // { branchId: { behind: number, latestRemoteSubject?: string } }
const recentlyTouched = new Map(); // { branchId: timestamp } — branches user just operated on
let isCheckingUpdates = false;

// ── Preview mode: 'simple' (set default + open main) or 'multi' (subdomain per branch) ──
let previewMode = localStorage.getItem('cds_preview_mode') || 'simple';

// ── Utilities ──

async function api(method, path, body) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`${API}${path}`, opts);
  if (res.status === 401) { location.href = '/login.html'; return; }
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

let toastTimer = null;
function showToast(msg, type = 'info', duration) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = `toast ${type}`;
  if (toastTimer) clearTimeout(toastTimer);
  const ms = duration ?? (type === 'success' ? 6000 : type === 'error' ? 8000 : 4000);
  toastTimer = setTimeout(() => { el.className = 'toast hidden'; toastTimer = null; }, ms);
}

function statusLabel(s) {
  const map = { running: '运行中', building: '构建中', idle: '空闲', stopped: '已停止', error: '错误' };
  return map[s] || s;
}

function relativeTime(iso) {
  if (!iso) return '';
  const m = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (m < 1) return '刚刚';
  if (m < 60) return `${m}分钟前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}小时前`;
  return `${Math.floor(h / 24)}天前`;
}

function esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

// ── Loading state helpers ──

function setLoading(id, action) {
  if (!loadingActions.has(id)) loadingActions.set(id, new Set());
  loadingActions.get(id).add(action);
  renderBranches();
}

function clearLoading(id, action) {
  const set = loadingActions.get(id);
  if (set) { set.delete(action); if (set.size === 0) loadingActions.delete(id); }
  renderBranches();
}

function isLoading(id, action) {
  const set = loadingActions.get(id);
  return set ? set.has(action) : false;
}

function hasAnyLoading(id) {
  const set = loadingActions.get(id);
  return set ? set.size > 0 : false;
}

// ── State ──

let remoteBranches = [];
let localBranches = [];
let buildProfiles = [];
let routingRules = [];
let defaultBranch = null;
let customEnvVars = {};
const collapsedBranches = new Set();

function toggleBranchCard(id, event) {
  // Don't toggle when clicking buttons/links/inputs inside the header
  if (event.target.closest('button, a, input, .port-badge, .branch-notes-editor, .fav-toggle, .set-default-link, .notes-edit-btn, .branch-actions-commit, .branch-name')) return;
  if (collapsedBranches.has(id)) {
    collapsedBranches.delete(id);
  } else {
    collapsedBranches.add(id);
  }
  renderBranches();
}

// ── Init ──

let githubRepoUrl = '';
let mainDomain = '';
let switchDomain = '';
let previewDomain = '';
let workerPort = '';

async function init() {
  await Promise.all([loadBranches(), loadProfiles(), loadRoutingRules(), loadConfig(), loadEnvVars()]);
  refreshRemoteBranches();
  updatePreviewModeUI();
  setInterval(loadBranches, 10000);
}

async function loadConfig() {
  try {
    const data = await api('GET', '/config');
    document.getElementById('workerLabel').textContent = `Worker :${data.workerPort || '?'}`;
    githubRepoUrl = data.githubRepoUrl || '';
    mainDomain = data.mainDomain || '';
    switchDomain = data.switchDomain || '';
    previewDomain = data.previewDomain || '';
    workerPort = data.workerPort || '';
  } catch (e) { console.error('loadConfig:', e); }
}

// ── Check updates (global refresh) ──

async function checkAllUpdates() {
  if (isCheckingUpdates) return;
  isCheckingUpdates = true;
  const btn = document.getElementById('globalRefreshBtn');
  if (btn) btn.classList.add('spinning');
  try {
    const data = await api('GET', '/check-updates');
    branchUpdates = data.updates || {};
    localStorage.setItem('cds_branch_updates', JSON.stringify(branchUpdates));
    renderBranches();
    const count = Object.keys(branchUpdates).length;
    if (count > 0) {
      showToast(`${count} 个分支有远程更新`, 'info');
    } else {
      showToast('所有分支已是最新', 'success');
    }
  } catch (e) {
    showToast('检查更新失败: ' + e.message, 'error');
  }
  isCheckingUpdates = false;
  if (btn) btn.classList.remove('spinning');
}

function confirmOpenGithub(event) {
  if (!confirm('即将跳转到 GitHub.dev 在线编辑器浏览代码，是否继续？')) {
    event.preventDefault();
    return false;
  }
  return true;
}

function togglePreviewMode() {
  previewMode = previewMode === 'simple' ? 'multi' : 'simple';
  localStorage.setItem('cds_preview_mode', previewMode);
  updatePreviewModeUI();
  renderBranches();
  if (previewMode === 'multi' && !previewDomain) {
    showToast('已开启多分支预览模式，但 PREVIEW_DOMAIN 未配置，预览将回退到简洁模式。请在「变量」中设置 PREVIEW_DOMAIN。', 'error');
  } else {
    showToast(previewMode === 'multi' ? '已开启多分支预览模式' : '已切换到简洁预览模式', 'info');
  }
}

function updatePreviewModeUI() {
  // Update switch in settings menu if open
  const sw = document.querySelector('.settings-switch');
  if (sw) sw.classList.toggle('on', previewMode === 'multi');
}

// ── Data loading ──

async function loadBranches() {
  try {
    const data = await api('GET', '/branches');
    localBranches = data.branches || [];
    defaultBranch = data.defaultBranch;
    renderBranches();
  } catch (e) { console.error('loadBranches:', e); }
}

async function loadProfiles() {
  try {
    const data = await api('GET', '/build-profiles');
    buildProfiles = data.profiles || [];
    renderProfiles();
  } catch (e) { console.error('loadProfiles:', e); }
}

async function loadRoutingRules() {
  try {
    const data = await api('GET', '/routing-rules');
    routingRules = data.rules || [];
    renderRoutingRules();
  } catch (e) { console.error('loadRoutingRules:', e); }
}

async function refreshRemoteBranches() {
  const btn = document.getElementById('refreshRemoteBtn');
  btn.disabled = true;
  try {
    const data = await api('GET', '/remote-branches');
    remoteBranches = data.branches || [];
    // 只有搜索框聚焦时才打开下拉框
    if (document.activeElement === searchInput) {
      filterBranches();
    }
  } catch (e) { showToast(e.message, 'error'); }
  btn.disabled = false;
}

// ── Branch picker (search + dropdown) ──

const searchInput = document.getElementById('branchSearch');
const dropdown = document.getElementById('branchDropdown');

searchInput.addEventListener('input', filterBranches);
searchInput.addEventListener('focus', filterBranches);
document.addEventListener('click', (e) => {
  if (!e.target.closest('.branch-picker')) dropdown.classList.add('hidden');
});

function filterBranches() {
  const q = searchInput.value.trim().toLowerCase();

  // Don't show dropdown when search is empty and triggered by focus
  if (!q) {
    dropdown.classList.add('hidden');
    return;
  }

  // Section 1: Match already-added local branches
  const matchedLocal = localBranches.filter(b =>
    b.branch.toLowerCase().includes(q) || b.id.toLowerCase().includes(q)
  ).slice(0, 10);

  // Section 2: Match remote branches not yet added
  const localIds = new Set(localBranches.map(b => StateService_slugify(b.branch)));
  const matchedRemote = remoteBranches.filter(b =>
    b.name.toLowerCase().includes(q) && !localIds.has(StateService_slugify(b.name))
  ).slice(0, 15);

  if (matchedLocal.length === 0 && matchedRemote.length === 0) {
    dropdown.innerHTML = '<div class="branch-dropdown-empty">没有匹配的分支</div>';
  } else {
    let html = '';

    // ── Already added section ──
    if (matchedLocal.length > 0) {
      html += '<div class="branch-dropdown-section-label">已添加</div>';
      html += matchedLocal.map(b => {
        const isRunning = b.status === 'running';
        const statusText = statusLabel(b.status);
        const services = Object.entries(b.services || {});
        const portText = services.length > 0 ? services.map(([pid, svc]) => `:${svc.hostPort}`).join(' ') : '';
        return `
        <div class="branch-dropdown-item branch-dropdown-local" onclick="scrollToAndHighlight('${esc(b.id)}')">
          <svg class="branch-dropdown-icon" width="16" height="16" viewBox="0 0 16 16" fill="currentColor" style="color: var(--accent)"><path d="M2.5 1.75v11.5c0 .138.112.25.25.25h6.5a.75.75 0 010 1.5h-6.5A1.75 1.75 0 011 13.25V1.75C1 .784 1.784 0 2.75 0h8.5C12.216 0 13 .784 13 1.75v7.5a.75.75 0 01-1.5 0V1.75a.25.25 0 00-.25-.25h-8.5a.25.25 0 00-.25.25zm13.06 9.72a.75.75 0 010 1.06l-2.5 2.5a.75.75 0 01-1.06 0l-1.5-1.5a.75.75 0 111.06-1.06l.97.97 1.97-1.97a.75.75 0 011.06 0z"/></svg>
          <div class="branch-dropdown-item-info">
            <div class="branch-dropdown-item-row1">
              <span class="branch-dropdown-item-name">${esc(b.branch)}</span>
              <span class="branch-dropdown-item-status ${isRunning ? 'running' : ''}">${statusText}${portText ? ' ' + portText : ''}</span>
            </div>
            ${b.notes ? `<div class="branch-dropdown-item-row2">${esc(b.notes)}</div>` : ''}
          </div>
        </div>`;
      }).join('');
    }

    // ── Can be added section ──
    if (matchedRemote.length > 0) {
      if (matchedLocal.length > 0) {
        html += '<div class="branch-dropdown-section-label">可添加</div>';
      }
      html += matchedRemote.map(b => {
        const branchUrl = githubRepoUrl ? `${githubRepoUrl}/tree/${encodeURIComponent(b.name)}` : '';
        const prUrl = githubRepoUrl ? `${githubRepoUrl}/pulls?q=is%3Apr+head%3A${encodeURIComponent(b.name)}` : '';
        return `
        <div class="branch-dropdown-item">
          <svg class="branch-dropdown-icon" width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path fill-rule="evenodd" d="M11.75 2.5a.75.75 0 100 1.5.75.75 0 000-1.5zm-2.25.75a2.25 2.25 0 113 2.122V6A2.5 2.5 0 0110 8.5H6a1 1 0 00-1 1v1.128a2.251 2.251 0 11-1.5 0V5.372a2.25 2.25 0 111.5 0v1.836A2.492 2.492 0 016 7h4a1 1 0 001-1v-.628A2.25 2.25 0 019.5 3.25zM4.25 12a.75.75 0 100 1.5.75.75 0 000-1.5zM3.5 3.25a.75.75 0 111.5 0 .75.75 0 01-1.5 0z"/></svg>
          <div class="branch-dropdown-item-info" onclick="addBranch('${esc(b.name)}')">
            <div class="branch-dropdown-item-row1">
              <span class="branch-dropdown-item-name">${esc(b.name)}</span>
              <span class="branch-dropdown-item-time">${relativeTime(b.date)}</span>
            </div>
            <div class="branch-dropdown-item-row2">${esc(b.author || '')} — ${esc(b.subject || '')}</div>
          </div>
          ${githubRepoUrl ? `
            <div class="branch-dropdown-item-actions">
              <a href="${branchUrl}" target="_blank" rel="noopener" class="branch-link-btn" onclick="event.stopPropagation()" title="访问 GitHub 分支">
                <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>
              </a>
              <a href="${prUrl}" target="_blank" rel="noopener" class="branch-link-btn pr-link" onclick="event.stopPropagation()" title="访问 PR">
                <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M1.5 3.25a2.25 2.25 0 113 2.122v5.256a2.251 2.251 0 11-1.5 0V5.372A2.25 2.25 0 011.5 3.25zm5.677-.177L9.573.677A.25.25 0 0110 .854V2.5h1A2.5 2.5 0 0113.5 5v5.628a2.251 2.251 0 11-1.5 0V5a1 1 0 00-1-1h-1v1.646a.25.25 0 01-.427.177L7.177 3.427a.25.25 0 010-.354zM3.75 2.5a.75.75 0 100 1.5.75.75 0 000-1.5zm0 9.5a.75.75 0 100 1.5.75.75 0 000-1.5zm8.25.75a.75.75 0 11-1.5 0 .75.75 0 011.5 0z"/></svg>
              </a>
            </div>
          ` : ''}
        </div>`;
      }).join('');
    }

    dropdown.innerHTML = html;
  }
  dropdown.classList.remove('hidden');
}

// Scroll to an already-added branch card and highlight it
function scrollToAndHighlight(id) {
  dropdown.classList.add('hidden');
  searchInput.value = '';
  // Ensure the card is expanded
  collapsedBranches.delete(id);
  renderBranches();
  // Find and scroll to the card
  requestAnimationFrame(() => {
    const card = document.querySelector(`.branch-card[data-branch-id="${CSS.escape(id)}"]`);
    if (card) {
      card.scrollIntoView({ behavior: 'smooth', block: 'center' });
      markTouched(id);
    }
  });
}

function StateService_slugify(branch) {
  return branch.replace(/[^a-zA-Z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').toLowerCase();
}

// ── Branch actions ──

async function addBranch(name) {
  dropdown.classList.add('hidden');
  searchInput.value = '';
  try {
    await api('POST', '/branches', { branch: name });
    const slug = StateService_slugify(name);
    markTouched(slug);
    showToast(`分支 "${name}" 已添加`, 'success');
    await loadBranches();
    // Scroll to the newly added card
    requestAnimationFrame(() => {
      const card = document.querySelector(`.branch-card[data-branch-id="${CSS.escape(slug)}"]`);
      if (card) card.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
  } catch (e) { showToast(e.message, 'error'); }
}

async function deployBranch(id) {
  if (busyBranches.has(id)) return;
  markTouched(id);
  busyBranches.add(id);
  // Ensure card is expanded so user sees inline log
  collapsedBranches.delete(id);
  inlineDeployLogs.set(id, { lines: [], status: 'building', expanded: false });
  renderBranches();

  try {
    const res = await fetch(`${API}/branches/${id}/deploy`, { method: 'POST' });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `部署失败 (HTTP ${res.status})`);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split('\n');
      buffer = lines.pop();

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const data = JSON.parse(line.slice(6));
          const log = inlineDeployLogs.get(id);
          if (!log) continue;

          if (data.chunk) {
            log.lines.push(data.chunk);
          } else if (data.step) {
            log.lines.push(`[${data.status}] ${data.title || data.step}`);
          } else if (data.message) {
            log.lines.push(data.message);
          }
          updateInlineLog(id);
        }
      }
    }
    // Deploy succeeded
    const log = inlineDeployLogs.get(id);
    if (log) log.status = 'done';
    justDeployed.add(id);
    setTimeout(() => { justDeployed.delete(id); }, 3000);
  } catch (e) {
    const log = inlineDeployLogs.get(id);
    if (log) { log.status = 'error'; log.errorMsg = e.message; }
    showToast(e.message, 'error');
  }

  busyBranches.delete(id);
  await loadBranches();
  // Keep inline log visible for a moment, then clean up
  setTimeout(() => { inlineDeployLogs.delete(id); renderBranches(); }, 5000);
}

function updateInlineLog(id) {
  const el = document.getElementById(`inline-log-${CSS.escape(id)}`);
  if (!el) return;
  const log = inlineDeployLogs.get(id);
  if (!log) return;
  const filtered = log.lines.filter(l => l.trim());
  const maxLines = log.expanded ? filtered.length : 8;
  const visibleLines = filtered.slice(-maxLines);
  el.textContent = visibleLines.join('\n');
  el.scrollTop = el.scrollHeight;
}

function toggleInlineLog(id, event) {
  event.stopPropagation();
  const log = inlineDeployLogs.get(id);
  if (!log) return;
  log.expanded = !log.expanded;
  const wrapper = document.getElementById(`inline-log-wrapper-${CSS.escape(id)}`);
  if (wrapper) wrapper.classList.toggle('expanded', log.expanded);
  updateInlineLog(id);
}

function openFullDeployLog(id, event) {
  event.stopPropagation();
  const log = inlineDeployLogs.get(id);
  if (!log) return;
  openLogModal(`部署日志 ${id}`);
  document.getElementById('logModalBody').innerHTML =
    `<pre class="live-log-output">${esc(log.lines.join('\n') || '暂无日志')}</pre>`;
}

async function stopBranch(id) {
  if (busyBranches.has(id) || isLoading(id, 'stop')) return;
  markTouched(id);
  busyBranches.add(id);
  setLoading(id, 'stop');
  renderBranches();
  try {
    await api('POST', `/branches/${id}/stop`);
    showToast('服务已停止', 'success');
  } catch (e) { showToast(e.message, 'error'); }
  busyBranches.delete(id);
  clearLoading(id, 'stop');
  await loadBranches();
}

async function pullBranch(id) {
  if (isLoading(id, 'pull')) return;
  markTouched(id);
  setLoading(id, 'pull');
  try {
    const result = await api('POST', `/branches/${id}/pull`);
    delete branchUpdates[id];
    localStorage.setItem('cds_branch_updates', JSON.stringify(branchUpdates));
    showToast(result.updated ? `已更新: ${result.head}` : '已是最新', result.updated ? 'success' : 'info');
  } catch (e) { showToast(e.message, 'error'); }
  clearLoading(id, 'pull');
  await loadBranches();
}

async function previewBranch(id) {
  markTouched(id);
  const slug = StateService_slugify(id);

  if (previewMode === 'multi' && previewDomain) {
    // Multi-branch mode: open subdomain URL directly
    const url = `${location.protocol}//${slug}.${previewDomain}`;
    window.open(url, '_blank');
    return;
  }

  // Simple mode: set as default branch → open main domain
  try {
    await api('POST', `/branches/${slug}/set-default`);
    defaultBranch = slug;
    renderBranches();
  } catch (e) {
    showToast('设为默认失败: ' + e.message, 'error');
    return;
  }

  let url;
  if (mainDomain) {
    url = `${location.protocol}//${mainDomain}`;
  } else if (workerPort) {
    url = `${location.protocol}//${location.hostname}:${workerPort}`;
  } else {
    showToast('MAIN_DOMAIN 未配置，无法打开预览', 'error');
    return;
  }
  window.open(url, '_blank');
}

async function removeBranch(id) {
  if (!confirm(`确定删除分支 "${id}"？将停止所有服务并删除工作区。`)) return;
  busyBranches.add(id);
  renderBranches();
  try {
    const res = await fetch(`${API}/branches/${id}`, { method: 'DELETE' });
    // SSE stream — just consume it
    const reader = res.body.getReader();
    while (!(await reader.read()).done) {}
    showToast(`分支 "${id}" 已删除`, 'success');
  } catch (e) { showToast(e.message, 'error'); }
  busyBranches.delete(id);
  await loadBranches();
}

async function resetBranch(id) {
  if (isLoading(id, 'reset')) return;
  setLoading(id, 'reset');
  try {
    await api('POST', `/branches/${id}/reset`);
    showToast('状态已重置', 'success');
  } catch (e) { showToast(e.message, 'error'); }
  clearLoading(id, 'reset');
  await loadBranches();
}

async function toggleFavorite(id) {
  const branch = localBranches.find(b => b.id === id);
  if (!branch) return;
  const newVal = !branch.isFavorite;
  try {
    await api('PATCH', `/branches/${id}`, { isFavorite: newVal });
    branch.isFavorite = newVal;
    await loadBranches();
  } catch (e) { showToast(e.message, 'error'); }
}

async function saveBranchNotes(id) {
  const input = document.getElementById(`notes-input-${CSS.escape(id)}`);
  if (!input) return;
  try {
    await api('PATCH', `/branches/${id}`, { notes: input.value });
    showToast('备注已保存', 'success');
    await loadBranches();
  } catch (e) { showToast(e.message, 'error'); }
}

function startEditNotes(id, event) {
  event.stopPropagation();
  const display = document.getElementById(`notes-display-${CSS.escape(id)}`);
  const editor = document.getElementById(`notes-editor-${CSS.escape(id)}`);
  if (display) display.classList.add('hidden');
  if (editor) {
    editor.classList.remove('hidden');
    const input = editor.querySelector('input');
    if (input) { input.focus(); input.select(); }
  }
}

function cancelEditNotes(id) {
  const display = document.getElementById(`notes-display-${CSS.escape(id)}`);
  const editor = document.getElementById(`notes-editor-${CSS.escape(id)}`);
  if (display) display.classList.remove('hidden');
  if (editor) editor.classList.add('hidden');
}

function getPortIcon(profileId, profile) {
  // Use profile's custom icon if set
  if (profile && profile.icon && ICON['port' + profile.icon.charAt(0).toUpperCase() + profile.icon.slice(1)]) {
    return ICON['port' + profile.icon.charAt(0).toUpperCase() + profile.icon.slice(1)];
  }
  // Fall back to map
  const key = PORT_ICON_MAP[profileId.toLowerCase()];
  return key ? ICON[key] : ICON.portDefault;
}

async function setDefaultBranch(id) {
  if (!id) return;
  if (isLoading(id, 'setDefault')) return;
  setLoading(id, 'setDefault');
  try {
    await api('POST', `/branches/${id}/set-default`);
    showToast(`默认分支已设为: ${id}`, 'success');
  } catch (e) { showToast(e.message, 'error'); }
  clearLoading(id, 'setDefault');
  await loadBranches();
}

async function cleanupAll() {
  if (!confirm('确定清理所有非默认分支？')) return;
  globalBusy = true;
  renderBranches();
  try {
    const res = await fetch(`${API}/cleanup`, { method: 'POST' });
    const reader = res.body.getReader();
    while (!(await reader.read()).done) {}
    showToast('清理完成', 'success');
  } catch (e) { showToast(e.message, 'error'); }
  globalBusy = false;
  await loadBranches();
}

async function viewContainerLogs(id, profileId) {
  try {
    const data = await api('POST', `/branches/${id}/container-logs`, { profileId });
    openLogModal(`日志: ${id}/${profileId || '默认'}`);
    document.getElementById('logModalBody').innerHTML = `<pre class="live-log-output">${esc(data.logs || '暂无日志')}</pre>`;
  } catch (e) { showToast(e.message, 'error'); }
}

// ── Single-service deploy ──

async function deploySingleService(id, profileId) {
  if (busyBranches.has(id)) return;
  busyBranches.add(id);
  closeDeployMenu(id);
  collapsedBranches.delete(id);
  inlineDeployLogs.set(id, { lines: [], status: 'building', expanded: false });
  renderBranches();

  try {
    const res = await fetch(`${API}/branches/${id}/deploy/${encodeURIComponent(profileId)}`, { method: 'POST' });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `部署失败 (HTTP ${res.status})`);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split('\n');
      buffer = lines.pop();

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const data = JSON.parse(line.slice(6));
          const log = inlineDeployLogs.get(id);
          if (!log) continue;

          if (data.chunk) {
            log.lines.push(data.chunk);
          } else if (data.step) {
            log.lines.push(`[${data.status}] ${data.title || data.step}`);
          } else if (data.message) {
            log.lines.push(data.message);
          }
          updateInlineLog(id);
        }
      }
    }
    const log = inlineDeployLogs.get(id);
    if (log) log.status = 'done';
    justDeployed.add(id);
    setTimeout(() => { justDeployed.delete(id); }, 3000);
  } catch (e) {
    const log = inlineDeployLogs.get(id);
    if (log) { log.status = 'error'; log.errorMsg = e.message; }
    showToast(e.message, 'error');
  }

  busyBranches.delete(id);
  await loadBranches();
  setTimeout(() => { inlineDeployLogs.delete(id); renderBranches(); }, 5000);
}

// ── Deploy dropdown menu ──

// ── Portal-based dropdown system ──
// All dropdowns render into #dropdownPortal (body-level), so they are never
// clipped by parent stacking contexts (backdrop-filter, transform, etc.).

const portal = document.getElementById('dropdownPortal');
let openDeployMenuId = null;

function positionPortalDropdown(el, anchor, align = 'left') {
  const r = anchor.getBoundingClientRect();
  el.style.top = `${r.bottom + 4}px`;
  // Measure after appending (display must not be 'none')
  const w = el.offsetWidth || 140;
  if (align === 'right') {
    let left = r.right - w;
    if (left < 8) left = 8;
    el.style.left = `${left}px`;
  } else {
    let left = r.left;
    if (left + w > window.innerWidth - 8) left = window.innerWidth - 8 - w;
    el.style.left = `${left}px`;
    el.style.minWidth = `${r.width}px`;
  }
}

function toggleDeployMenu(id, event) {
  event.stopPropagation();
  if (openDeployMenuId === id) { closeDeployMenu(); return; }
  closeDeployMenu();
  closeCommitLog();
  openDeployMenuId = id;

  // Read the menu HTML from the hidden template inside the card
  const tpl = document.getElementById(`deploy-menu-tpl-${CSS.escape(id)}`);
  if (!tpl) return;
  const menu = document.createElement('div');
  menu.className = 'deploy-menu';
  menu.id = 'deploy-menu-portal';
  menu.innerHTML = tpl.innerHTML;
  portal.appendChild(menu);

  const anchor = event.currentTarget.closest('.split-btn');
  if (anchor) positionPortalDropdown(menu, anchor, 'left');
}

function closeDeployMenu() {
  openDeployMenuId = null;
  const el = document.getElementById('deploy-menu-portal');
  if (el) el.remove();
}

// Close on outside click
document.addEventListener('click', () => {
  closeDeployMenu();
  closeCommitLog();
  closeSettingsMenu();
});

// ── Settings dropdown menu ──

let settingsMenuOpen = false;

function toggleSettingsMenu(event) {
  event.stopPropagation();
  if (settingsMenuOpen) { closeSettingsMenu(); return; }
  closeSettingsMenu();
  closeDeployMenu();
  closeCommitLog();
  settingsMenuOpen = true;

  const menu = document.createElement('div');
  menu.className = 'settings-menu';
  menu.id = 'settings-menu-portal';
  menu.onclick = (e) => e.stopPropagation();
  menu.innerHTML = `
    <div class="settings-menu-item" onclick="closeSettingsMenu(); openProfileModal()">
      <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M7.22 1.547a2.403 2.403 0 011.56 0l4.03 1.384a.48.48 0 01.33.457v1.224a.48.48 0 01-.33.457L8.78 6.453a2.403 2.403 0 01-1.56 0L3.19 5.069a.48.48 0 01-.33-.457V3.388a.48.48 0 01.33-.457l4.03-1.384zM3.19 6.903l4.03 1.384a2.403 2.403 0 001.56 0l4.03-1.384a.48.48 0 01.33.457v1.224a.48.48 0 01-.33.457L8.78 10.425a2.403 2.403 0 01-1.56 0L3.19 9.041a.48.48 0 01-.33-.457V7.36a.48.48 0 01.33-.457zm0 3.972l4.03 1.384a2.403 2.403 0 001.56 0l4.03-1.384a.48.48 0 01.33.457v1.224a.48.48 0 01-.33.457l-4.03 1.384a2.403 2.403 0 01-1.56 0l-4.03-1.384a.48.48 0 01-.33-.457v-1.224a.48.48 0 01.33-.457z"/></svg>
      构建配置
    </div>
    <div class="settings-menu-item" onclick="closeSettingsMenu(); openEnvModal()">
      <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M2.5 2a.5.5 0 00-.5.5v11a.5.5 0 00.5.5h11a.5.5 0 00.5-.5v-11a.5.5 0 00-.5-.5h-11zM1 2.5A1.5 1.5 0 012.5 1h11A1.5 1.5 0 0115 2.5v11a1.5 1.5 0 01-1.5 1.5h-11A1.5 1.5 0 011 13.5v-11zM4 5h2v1H4V5zm3 0h5v1H7V5zM4 8h2v1H4V8zm3 0h5v1H7V8zM4 11h2v1H4v-1zm3 0h5v1H7v-1z"/></svg>
      环境变量
    </div>
    <div class="settings-menu-item" onclick="closeSettingsMenu(); openRoutingModal()">
      <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M8 0a8 8 0 100 16A8 8 0 008 0zM1.5 8a6.5 6.5 0 0113 0h-2.1a8.3 8.3 0 00-.4-2.2 9 9 0 00-1-1.9A4.5 4.5 0 017 7.5H4.5A8.3 8.3 0 001.5 8zm5.5 5.5a6.5 6.5 0 01-5.4-3h2.3c.3 1.2.8 2.2 1.5 3H7zm1-5.5a7.8 7.8 0 014-3.8c.5.6.9 1.2 1.2 1.8H8zm0 1h5.4a8.3 8.3 0 01-.3 2H8.9 8V9zm0 3h3.8c-.6 1.3-1.5 2.4-2.8 3A6.5 6.5 0 018 9z"/></svg>
      路由规则
    </div>
    <div class="settings-menu-item settings-menu-switch" onclick="togglePreviewMode()">
      <span class="settings-menu-switch-label">多分支预览</span>
      <span class="settings-switch ${previewMode === 'multi' ? 'on' : ''}">
        <span class="settings-switch-track">
          <span class="settings-switch-thumb"></span>
        </span>
      </span>
    </div>
    <div class="settings-menu-divider"></div>
    <div class="settings-menu-item danger" onclick="closeSettingsMenu(); cleanupAll()">
      <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M6.5 1.75a.25.25 0 01.25-.25h2.5a.25.25 0 01.25.25V3h-3V1.75zM11 3V1.75A1.75 1.75 0 009.25 0h-2.5A1.75 1.75 0 005 1.75V3H2.75a.75.75 0 000 1.5h.3l.8 8.2A1.75 1.75 0 005.6 14.5h4.8a1.75 1.75 0 001.75-1.8l.8-8.2h.3a.75.75 0 000-1.5H11z"/></svg>
      清理分支
    </div>
    <div class="settings-menu-divider"></div>
    <div class="settings-menu-item" onclick="closeSettingsMenu(); doLogout()">
      <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M2 2.75C2 1.784 2.784 1 3.75 1h2.5a.75.75 0 010 1.5h-2.5a.25.25 0 00-.25.25v10.5c0 .138.112.25.25.25h2.5a.75.75 0 010 1.5h-2.5A1.75 1.75 0 012 13.25V2.75zm10.44 4.5H6.75a.75.75 0 000 1.5h5.69l-1.97 1.97a.749.749 0 101.06 1.06l3.25-3.25a.749.749 0 000-1.06l-3.25-3.25a.749.749 0 10-1.06 1.06l1.97 1.97z"/></svg>
      退出登录
    </div>
  `;
  portal.appendChild(menu);
  positionPortalDropdown(menu, event.currentTarget, 'right');
}

function closeSettingsMenu() {
  settingsMenuOpen = false;
  const el = document.getElementById('settings-menu-portal');
  if (el) el.remove();
}

// ── Recently-touched visual feedback ──

function markTouched(id) {
  recentlyTouched.set(id, Date.now());
  // Apply class immediately to the existing card element
  const cards = document.querySelectorAll('.branch-card');
  cards.forEach(card => {
    if (card.dataset.branchId === id) {
      card.classList.add('recently-touched');
    }
  });
  // Auto-fade after 8 seconds
  setTimeout(() => {
    recentlyTouched.delete(id);
    const c = document.querySelector(`.branch-card[data-branch-id="${CSS.escape(id)}"]`);
    if (c) c.classList.remove('recently-touched');
  }, 8000);
}

// ── Rendering ──

function renderBranches() {
  const el = document.getElementById('branchList');
  const count = document.getElementById('branchCount');
  count.textContent = `${localBranches.length} 个分支`;

  // Update default branch selector
  const sel = document.getElementById('defaultBranch');
  sel.innerHTML = '<option value="">无默认</option>' +
    localBranches.map(b => `<option value="${esc(b.id)}" ${b.id === defaultBranch ? 'selected' : ''}>${esc(b.id)}</option>`).join('');

  // Update cleanup button (if visible in DOM)
  const cleanupBtn = document.getElementById('cleanupBtn');
  if (cleanupBtn) {
    const nonDefault = localBranches.filter(b => b.id !== defaultBranch);
    cleanupBtn.disabled = nonDefault.length === 0 || globalBusy;
    cleanupBtn.title = nonDefault.length > 0 ? `清理 ${nonDefault.length} 个分支` : '没有可清理的分支';
  }

  if (localBranches.length === 0) {
    el.innerHTML = '<div class="empty-state">暂无分支，请在上方搜索并添加。</div>';
    return;
  }

  el.innerHTML = localBranches.map(b => {
    const isBusy = busyBranches.has(b.id) || globalBusy;
    const anyLoading = hasAnyLoading(b.id);
    const isDefault = b.id === defaultBranch;
    const services = Object.entries(b.services || {});
    const hasError = b.status === 'error';
    const isRunning = b.status === 'running';
    const isStopped = !isRunning && services.length > 0 && !hasError && b.status !== 'building';
    const hasMultipleProfiles = buildProfiles.length > 1;
    const hasUpdates = !!branchUpdates[b.id];

    // Loading state helpers for this branch
    const btnDisabled = (action) => (isBusy || isLoading(b.id, action)) ? 'disabled' : '';
    const btnLabel = (action, label) => isLoading(b.id, action) ? `<span class="btn-spinner"></span>${label}` : label;

    // Build deploy dropdown items for single-service redeploy
    const deployMenuItems = buildProfiles.map(p =>
      `<div class="deploy-menu-item" onclick="deploySingleService('${esc(b.id)}', '${esc(p.id)}')">${esc(p.name)}</div>`
    ).join('');

    const expanded = !collapsedBranches.has(b.id);

    // Build stop menu item for deploy dropdown
    const stopMenuItem = isRunning ? `<div class="deploy-menu-divider"></div><div class="deploy-menu-item deploy-menu-item-danger" onclick="event.stopPropagation(); closeDeployMenu('${esc(b.id)}'); stopBranch('${esc(b.id)}')">停止所有服务</div>` : '';

    // Port badges — icon + name:port, icon from profile config
    const portBadgesHtml = services.length > 0 ? services.map(([pid, svc]) => {
      const profile = buildProfiles.find(p => p.id === pid);
      const icon = getPortIcon(pid, profile);
      return `<span class="port-badge ${svc.status === 'running' ? 'run-port' : 'port-idle'}"
                    onclick="event.stopPropagation(); viewContainerLogs('${esc(b.id)}', '${esc(pid)}')"
                    title="${esc(pid)}: ${svc.status}">
                ${icon} ${esc(pid)}:${svc.hostPort}
              </span>`;
    }).join('') : '';

    // Notes — separate line below header
    const notesHtml = `
      <div class="branch-notes-line" id="notes-display-${esc(b.id)}">
        ${b.notes ? `<span class="branch-notes-text" title="${esc(b.notes)}">${esc(b.notes)}</span>` : ''}
        <span class="notes-edit-btn" onclick="startEditNotes('${esc(b.id)}', event)" title="编辑备注">
          ${ICON.edit}
        </span>
      </div>
      <div class="branch-notes-editor hidden" id="notes-editor-${esc(b.id)}">
        <input class="form-input notes-input" id="notes-input-${esc(b.id)}" value="${esc(b.notes || '')}" placeholder="添加备注..."
               onkeydown="if(event.key==='Enter'){event.preventDefault();saveBranchNotes('${esc(b.id)}');}if(event.key==='Escape'){cancelEditNotes('${esc(b.id)}');}"
               onclick="event.stopPropagation()">
        <button class="icon-btn xs" onclick="event.stopPropagation(); saveBranchNotes('${esc(b.id)}')" title="保存">&#x2713;</button>
        <button class="icon-btn xs" onclick="event.stopPropagation(); cancelEditNotes('${esc(b.id)}')" title="取消">&times;</button>
      </div>
    `;

    // Actions row: left = safe actions, right = dangerous actions
    // When container not running (stopped/idle): only show deploy button
    let actionsLeftHtml = '';
    let actionsRightHtml = '';

    if (isRunning) {
      actionsLeftHtml = `
        <button class="preview sm" onclick="previewBranch('${esc(b.id)}')">${ICON.preview} 预览</button>
      `;
      actionsRightHtml = `
        <div class="split-btn">
          <button class="sm split-btn-main" onclick="deployBranch('${esc(b.id)}')" ${isBusy ? 'disabled' : ''}>${ICON.deploy} 重新部署</button>
          <button class="sm split-btn-toggle" onclick="toggleDeployMenu('${esc(b.id)}', event)" ${isBusy ? 'disabled' : ''}>
            <svg width="10" height="6" viewBox="0 0 10 6" fill="currentColor"><path d="M1 1l4 4 4-4"/></svg>
          </button>
          <template id="deploy-menu-tpl-${esc(b.id)}">
            ${hasMultipleProfiles ? `<div class="deploy-menu-header">选择重部署的服务</div>${deployMenuItems}` : ''}
            ${stopMenuItem}
          </template>
        </div>
        <button class="sm danger" onclick="removeBranch('${esc(b.id)}')" ${isBusy ? 'disabled' : ''}>${ICON.trash} 删除</button>
      `;
    } else if (isStopped) {
      // Container exists but stopped — neutral deploy, not primary
      actionsLeftHtml = `
        <button class="sm" onclick="deployBranch('${esc(b.id)}')" ${isBusy ? 'disabled' : ''}>${ICON.deploy} 部署</button>
      `;
      actionsRightHtml = `
        <button class="sm danger" onclick="removeBranch('${esc(b.id)}')" ${isBusy ? 'disabled' : ''}>${ICON.trash} 删除</button>
      `;
    } else {
      // Idle (never deployed) or building — neutral deploy button
      actionsLeftHtml = `
        <button class="sm" onclick="deployBranch('${esc(b.id)}')" ${isBusy ? 'disabled' : ''}>${ICON.deploy} 部署</button>
      `;
      actionsRightHtml = `
        ${hasError ? `<button class="sm" onclick="resetBranch('${esc(b.id)}')" ${btnDisabled('reset')}>${btnLabel('reset', ICON.reset + ' 重置')}</button>` : ''}
        <button class="sm danger" onclick="removeBranch('${esc(b.id)}')" ${isBusy ? 'disabled' : ''}>${ICON.trash} 删除</button>
      `;
    }

    const deployLog = inlineDeployLogs.get(b.id);
    const isDeploying = !!deployLog && deployLog.status === 'building';
    const deployFailed = !!deployLog && deployLog.status === 'error';
    const isJustDeployed = justDeployed.has(b.id);

    // Commit area in actions row (always show commit info)
    let commitAreaHtml = '';
    if (b.subject) {
      commitAreaHtml = `
        <div class="branch-actions-commit" onclick="event.stopPropagation(); toggleCommitLog('${esc(b.id)}', this)" title="点击查看历史提交">
          ${commitIcon(b.subject)} ${esc(b.subject)}
          <svg class="commit-chevron" width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M4.427 5.427a.75.75 0 011.146 0L8 7.854l2.427-2.427a.75.75 0 111.146 1.146l-3 3a.75.75 0 01-1.146 0l-3-3a.75.75 0 010-1.146z"/></svg>
        </div>
      `;
    }

    // Inline deploy log (below actions row, at card bottom)
    let inlineLogHtml = '';
    if (deployLog) {
      const logStatusClass = deployLog.status === 'error' ? 'deploy-log-error' : deployLog.status === 'done' ? 'deploy-log-done' : '';
      const filteredLines = deployLog.lines.filter(l => l.trim());
      const visibleLines = deployLog.expanded ? filteredLines : filteredLines.slice(-8);
      inlineLogHtml = `
        <div class="inline-deploy-log-wrapper ${deployLog.expanded ? 'expanded' : ''} ${logStatusClass}" id="inline-log-wrapper-${esc(b.id)}" onclick="toggleInlineLog('${esc(b.id)}', event)">
          <div class="inline-deploy-log-header">
            <span class="live-dot ${deployLog.status !== 'building' ? 'stopped' : ''}"></span>
            <span>${deployLog.status === 'building' ? '部署中...' : deployLog.status === 'done' ? '部署完成' : '部署失败'}</span>
            <span class="inline-log-expand-hint" onclick="openFullDeployLog('${esc(b.id)}', event)">查看完整日志</span>
          </div>
          <pre class="inline-deploy-log" id="inline-log-${esc(b.id)}">${esc(visibleLines.join('\n'))}</pre>
          ${deployFailed && deployLog.errorMsg ? `<div class="inline-deploy-error">${esc(deployLog.errorMsg)}</div>` : ''}
        </div>
      `;
    }

    return `
      <div class="branch-card status-${b.status || 'idle'} ${isDefault ? 'active' : ''} ${isBusy ? 'is-busy' : ''} ${hasError ? 'has-error' : ''} ${expanded ? 'expanded' : ''} ${b.isFavorite ? 'is-favorite' : ''} ${hasUpdates ? 'has-updates' : ''} ${recentlyTouched.has(b.id) ? 'recently-touched' : ''} ${previewMode === 'multi' && isRunning ? 'show-preview-border' : ''} ${isDeploying ? 'is-deploying' : ''}" data-branch-id="${esc(b.id)}">
        ${isDeploying ? '<div class="deploy-progress-bar"><div class="deploy-progress-bar-fill"></div></div>' : ''}
        <div class="branch-card-header" onclick="toggleBranchCard('${esc(b.id)}', event)">
          <div class="branch-card-left">
            <span class="fav-toggle ${b.isFavorite ? 'active' : ''}" onclick="event.stopPropagation(); toggleFavorite('${esc(b.id)}')" title="${b.isFavorite ? '取消收藏' : '收藏'}">
              ${b.isFavorite ? ICON.star : ICON.starOutline}
            </span>
            <a class="branch-name" href="${githubRepoUrl ? githubRepoUrl.replace('github.com', 'github.dev') + '/tree/' + encodeURIComponent(b.branch) : '#'}" target="_blank" onclick="event.stopPropagation(); return confirmOpenGithub(event)" title="在 GitHub.dev 中浏览代码">${ICON.branch} ${esc(b.branch)}</a>
            ${isDefault ? '<span class="default-tag">默认</span>' : `
              <span class="set-default-link" onclick="event.stopPropagation(); setDefaultBranch('${esc(b.id)}')" title="设为默认分支">设默认</span>
            `}
          </div>
          <div class="branch-card-right">
            ${portBadgesHtml}
            <span class="branch-meta">${isLoading(b.id, 'stop') ? '<span class="stopping-indicator">停止中...</span>' : statusLabel(b.status)}${b.lastAccessedAt && !isLoading(b.id, 'stop') ? ` · ${relativeTime(b.lastAccessedAt)}` : ''}</span>
            ${!isBusy ? `<span class="update-pull-group" onclick="event.stopPropagation(); pullBranch('${esc(b.id)}')" title="${hasUpdates ? branchUpdates[b.id].behind + ' 个新提交，点击拉取' : '点击拉取最新代码'}">
              ${hasUpdates ? `<span class="update-badge">↓${branchUpdates[b.id].behind}</span>` : ''}
              <svg class="update-pull-icon ${isLoading(b.id, 'pull') ? 'spinning' : ''}" width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M8 2.5a5.487 5.487 0 00-4.131 1.869l1.204 1.204A.25.25 0 014.896 6H1.25A.25.25 0 011 5.75V2.104a.25.25 0 01.427-.177l1.38 1.38A7.002 7.002 0 0115 8a.75.75 0 01-1.5 0A5.5 5.5 0 008 2.5zM2.5 8a.75.75 0 00-1.5 0 7.002 7.002 0 0012.023 4.87l1.38 1.38a.25.25 0 00.427-.177V10.5a.25.25 0 00-.25-.25h-3.646a.25.25 0 00-.177.427l1.204 1.204A5.5 5.5 0 012.5 8z"/></svg>
            </span>` : ''}
            <svg class="branch-chevron ${expanded ? 'open' : ''}" width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M4.427 5.427a.75.75 0 011.146 0L8 7.854l2.427-2.427a.75.75 0 111.146 1.146l-3 3a.75.75 0 01-1.146 0l-3-3a.75.75 0 010-1.146z"/></svg>
          </div>
        </div>
        ${b.errorMessage && !deployLog ? `<div class="branch-error" title="${esc(b.errorMessage)}">${esc(b.errorMessage)}</div>` : ''}
        <div class="branch-card-body ${expanded ? '' : 'hidden'}">
          ${notesHtml}
          <div class="branch-card-actions-row">
            <div class="branch-actions-left">
              ${actionsLeftHtml}
            </div>
            ${commitAreaHtml}
            <div class="branch-actions-right ${isJustDeployed ? 'slide-in-right' : ''}">
              ${actionsRightHtml}
            </div>
          </div>
          ${inlineLogHtml}
        </div>
      </div>
    `;
  }).join('');
}

// ── Build profiles (data only) ──

function renderProfiles() {
  // Profiles are now rendered inside modal, this just controls the quickstart banner
  const banner = document.getElementById('quickstartBanner');
  if (buildProfiles.length === 0) {
    banner.classList.remove('hidden');
  } else {
    banner.classList.add('hidden');
  }
}

function onImageSelect(val) {
  const custom = document.getElementById('profileImageCustom');
  if (val === '__custom__') {
    custom.classList.remove('hidden');
    custom.focus();
  } else {
    custom.classList.add('hidden');
    custom.value = '';
  }
}

function toggleAdvanced() {
  document.getElementById('advancedFields').classList.toggle('hidden');
}

async function loadDockerImages() {
  try {
    const data = await api('GET', '/docker-images');
    const group = document.getElementById('localImages');
    if (data.images && data.images.length > 0) {
      group.innerHTML = data.images.map(img =>
        `<option value="${esc(img.repo + ':' + img.tag)}">${esc(img.repo)}:${esc(img.tag)} (${esc(img.size)})</option>`
      ).join('');
    } else {
      group.innerHTML = '<option disabled>未找到本地镜像</option>';
    }
  } catch { /* ignore */ }
}

async function runQuickstart() {
  try {
    const data = await api('POST', '/quickstart');
    showToast(data.message, 'success');
    await loadProfiles();
  } catch (e) { showToast(e.message, 'error'); }
}

// ── Environment variables (data only) ──

async function loadEnvVars() {
  try {
    const data = await api('GET', '/env');
    customEnvVars = data.env || {};
  } catch (e) { console.error('loadEnvVars:', e); }
}

function maskValue(key, val) {
  if (/password|secret|key/i.test(key)) return '••••••••';
  return val;
}

// ── Routing rules (data only) ──

function renderRoutingRules() {
  // Routing rules are now rendered inside modal, no-op for data load callback
}

// ── Config modal (shared) ──

function openConfigModal(title, html) {
  document.getElementById('configModalTitle').textContent = title;
  document.getElementById('configModalBody').innerHTML = html;
  document.getElementById('configModal').classList.remove('hidden');
}

function closeConfigModal() {
  document.getElementById('configModal').classList.add('hidden');
}

// ── Env modal ──

function openEnvModal() {
  const entries = Object.entries(customEnvVars);

  function envItemHtml(k, v) {
    const safeK = esc(k);
    const escapedK = encodeURIComponent(k);
    return `
      <div class="env-item-wrap" id="env-item-${escapedK}">
        <div class="config-item">
          <div class="config-item-main">
            <code class="env-key">${safeK}</code>
            <span class="config-item-arrow">=</span>
            <code class="env-val" title="${esc(v)}">${esc(maskValue(k, v))}</code>
          </div>
          <div class="config-item-actions">
            <button class="icon-btn xs" onclick="editEnvVarInline('${safeK}')" title="编辑">&#x270E;</button>
            <button class="icon-btn xs danger-icon" onclick="deleteEnvVarAndRefresh('${safeK}')" title="删除">&times;</button>
          </div>
        </div>
        <div class="env-inline-edit hidden" id="env-edit-${escapedK}">
          <div class="form-row">
            <input class="form-input" value="${safeK}" readonly style="opacity:0.6;flex:0.4">
            <input class="form-input" id="env-edit-val-${escapedK}" value="${esc(v)}">
          </div>
          <div class="form-row">
            <button class="primary sm" onclick="saveInlineEnvVar('${safeK}')">保存</button>
            <button class="sm" onclick="cancelInlineEnvEdit('${safeK}')">取消</button>
          </div>
        </div>
      </div>
    `;
  }

  const listHtml = entries.length === 0
    ? '<div class="config-empty">暂无自定义环境变量。默认使用自动检测的主机变量 (MONGODB_HOST 等)。</div>'
    : entries.map(([k, v]) => envItemHtml(k, v)).join('');

  const html = `
    <p class="config-panel-desc">
      自定义环境变量将注入到所有容器中，可覆盖自动检测的主机变量。
      键名中包含 <code>PASSWORD</code> 或 <code>SECRET</code> 的值在显示时会被遮蔽。
    </p>
    <div class="config-panel-actions" style="margin-bottom:10px">
      <button class="sm" onclick="openBulkEnvModal()">批量编辑</button>
      <button class="sm primary" onclick="toggleModalForm('envAddForm')">+ 添加</button>
    </div>
    <div id="envAddForm" class="hidden">
      <div class="form-row">
        <input id="envKey" placeholder="键名（如 MongoDB__ConnectionString）" class="form-input">
        <input id="envValue" placeholder="值" class="form-input">
      </div>
      <div class="form-row">
        <button class="primary sm" onclick="saveNewEnvVar()">保存</button>
        <button class="sm" onclick="toggleModalForm('envAddForm')">取消</button>
      </div>
    </div>
    <div id="envListInModal">${listHtml}</div>
  `;
  openConfigModal('环境变量', html);
}

function editEnvVarInline(key) {
  // Close any other open inline edits
  document.querySelectorAll('.env-inline-edit').forEach(el => el.classList.add('hidden'));
  const editEl = document.getElementById(`env-edit-${encodeURIComponent(key)}`);
  if (editEl) {
    editEl.classList.remove('hidden');
    const input = document.getElementById(`env-edit-val-${encodeURIComponent(key)}`);
    if (input) { input.focus(); input.select(); }
  }
}

function cancelInlineEnvEdit(key) {
  const editEl = document.getElementById(`env-edit-${encodeURIComponent(key)}`);
  if (editEl) editEl.classList.add('hidden');
}

async function saveInlineEnvVar(key) {
  const input = document.getElementById(`env-edit-val-${encodeURIComponent(key)}`);
  if (!input) return;
  const value = input.value;
  try {
    await api('PUT', `/env/${encodeURIComponent(key)}`, { value });
    showToast(`已保存 ${key}`, 'success');
    await loadEnvVars();
    openEnvModal();
  } catch (e) { showToast(e.message, 'error'); }
}

async function saveNewEnvVar() {
  const key = document.getElementById('envKey').value.trim();
  const value = document.getElementById('envValue').value;
  if (!key) { showToast('键名不能为空', 'error'); return; }
  try {
    await api('PUT', `/env/${encodeURIComponent(key)}`, { value });
    showToast(`已设置 ${key}`, 'success');
    await loadEnvVars();
    openEnvModal();
  } catch (e) { showToast(e.message, 'error'); }
}

async function deleteEnvVarAndRefresh(key) {
  try {
    await api('DELETE', `/env/${encodeURIComponent(key)}`);
    showToast(`已删除 ${key}`, 'success');
    await loadEnvVars();
    openEnvModal();
  } catch (e) { showToast(e.message, 'error'); }
}

function openBulkEnvModal() {
  const entries = Object.entries(customEnvVars);
  const prefill = entries.length > 0 ? entries.map(([k, v]) => `${k}=${v}`).join('\n') : '';
  const html = `
    <p class="config-panel-desc">
      每行一个变量，格式为 <code>KEY=VALUE</code>。空行和 <code>#</code> 开头的注释会被忽略。
      保存时将<strong>替换</strong>所有现有变量。
    </p>
    <textarea id="bulkEnvTextarea" class="bulk-textarea" rows="12" placeholder="# 数据库连接&#10;MongoDB__ConnectionString=mongodb://localhost:27017&#10;REDIS_URL=redis://localhost:6379&#10;&#10;# 密钥&#10;JWT_SECRET=your-secret-here">${esc(prefill)}</textarea>
    <div class="form-row" style="margin-top:8px">
      <button class="primary sm" onclick="saveBulkEnvAndRefresh()">保存全部</button>
      <button class="sm" onclick="openEnvModal()">取消</button>
    </div>
  `;
  openConfigModal('批量编辑环境变量', html);
}

async function saveBulkEnvAndRefresh() {
  const textarea = document.getElementById('bulkEnvTextarea');
  const lines = textarea.value.split('\n');
  const newVars = {};
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx <= 0) continue;
    const key = trimmed.substring(0, eqIdx).trim();
    const value = trimmed.substring(eqIdx + 1);
    if (key) newVars[key] = value;
  }
  try {
    await api('PUT', '/env', newVars);
    showToast(`已保存 ${Object.keys(newVars).length} 个环境变量`, 'success');
    await loadEnvVars();
    openEnvModal();
  } catch (e) { showToast(e.message, 'error'); }
}

// ── Routing modal ──

function openRoutingModal() {
  const listHtml = routingRules.length === 0
    ? '<div class="config-empty">暂无路由规则。请求将使用 X-Branch 头或默认分支。</div>'
    : routingRules.map(r => `
        <div class="config-item ${r.enabled ? '' : 'disabled'}">
          <div class="config-item-main">
            <span class="config-item-type">${esc(r.type)}</span>
            <code class="config-item-match">${esc(r.match)}</code>
            <span class="config-item-arrow">&rarr;</span>
            <span class="config-item-target">${esc(r.branch)}</span>
          </div>
          <div class="config-item-actions">
            <button class="icon-btn xs" onclick="toggleRuleAndRefresh('${esc(r.id)}')" title="${r.enabled ? '禁用' : '启用'}">
              ${r.enabled ? '&#x2713;' : '&#x2717;'}
            </button>
            <button class="icon-btn xs danger-icon" onclick="deleteRuleAndRefresh('${esc(r.id)}')" title="删除">&times;</button>
          </div>
        </div>
      `).join('');

  const html = `
    <p class="config-panel-desc">
      通过 <code>X-Branch</code> 请求头、域名模式或 URL 模式将请求路由到分支。
    </p>
    <div style="margin-bottom:10px">
      <button class="sm primary" onclick="toggleModalForm('addRuleFormModal')">+ 添加</button>
    </div>
    <div id="addRuleFormModal" class="hidden">
      <div class="form-row">
        <input id="ruleId" placeholder="规则 ID" class="form-input sm">
        <input id="ruleName" placeholder="名称" class="form-input sm">
      </div>
      <div class="form-row">
        <select id="ruleType" class="form-input sm">
          <option value="domain">域名</option>
          <option value="header">请求头</option>
          <option value="pattern">URL 模式</option>
        </select>
        <input id="ruleMatch" placeholder="匹配模式" class="form-input">
      </div>
      <div class="form-row">
        <input id="ruleBranch" placeholder="目标分支（用 $1 表示捕获组）" class="form-input">
        <input id="rulePriority" type="number" value="0" placeholder="优先级" class="form-input xs">
      </div>
      <div class="form-row">
        <button class="primary sm" onclick="saveRuleAndRefresh()">保存</button>
        <button class="sm" onclick="toggleModalForm('addRuleFormModal')">取消</button>
      </div>
    </div>
    <div id="routingListInModal">${listHtml}</div>
  `;
  openConfigModal('路由规则', html);
}

async function saveRuleAndRefresh() {
  const rule = {
    id: document.getElementById('ruleId').value.trim(),
    name: document.getElementById('ruleName').value.trim(),
    type: document.getElementById('ruleType').value,
    match: document.getElementById('ruleMatch').value.trim(),
    branch: document.getElementById('ruleBranch').value.trim(),
    priority: parseInt(document.getElementById('rulePriority').value) || 0,
    enabled: true,
  };
  try {
    await api('POST', '/routing-rules', rule);
    showToast('规则已添加', 'success');
    await loadRoutingRules();
    openRoutingModal();
  } catch (e) { showToast(e.message, 'error'); }
}

async function toggleRuleAndRefresh(id) {
  const rule = routingRules.find(r => r.id === id);
  if (!rule) return;
  try {
    await api('PUT', `/routing-rules/${id}`, { enabled: !rule.enabled });
    await loadRoutingRules();
    openRoutingModal();
  } catch (e) { showToast(e.message, 'error'); }
}

async function deleteRuleAndRefresh(id) {
  try {
    await api('DELETE', `/routing-rules/${id}`);
    showToast('规则已删除', 'success');
    await loadRoutingRules();
    openRoutingModal();
  } catch (e) { showToast(e.message, 'error'); }
}

// ── Profile modal ──

function openProfileModal() {
  const listHtml = buildProfiles.length === 0
    ? '<div class="config-empty">暂无构建配置，请添加一个。</div>'
    : buildProfiles.map(p => `
        <div class="config-item">
          <div class="config-item-main">
            <span style="opacity:0.7">${getPortIcon(p.id, p)}</span>
            <strong>${esc(p.name)}</strong>
            <code class="config-item-match">${esc(p.dockerImage)}</code>
            <span class="config-item-detail">${esc(p.workDir || '.')} :${p.containerPort}</span>
            <code class="config-item-cmd" title="${esc(p.runCommand)}">${esc(p.runCommand)}</code>
          </div>
          <div class="config-item-actions">
            <button class="icon-btn xs danger-icon" onclick="deleteProfileAndRefresh('${esc(p.id)}')" title="删除">&times;</button>
          </div>
        </div>
      `).join('');

  const html = `
    <p class="config-panel-desc">
      定义如何构建和运行服务。每个配置对应一个 Docker 容器及自定义命令。
    </p>
    <div style="margin-bottom:10px">
      <button class="sm primary" onclick="showAddProfileInModal()">+ 添加</button>
    </div>
    <div id="addProfileFormModal" class="hidden">
      <div class="form-row">
        <input id="profileId" placeholder="配置 ID（如 api、web）" class="form-input sm">
        <input id="profileName" placeholder="显示名称" class="form-input sm">
        <select id="profileIcon" class="form-input xs" title="端口图标">
          <option value="">图标</option>
          <option value="api">📊 API</option>
          <option value="web">🌐 Web</option>
          <option value="default">⊖ 默认</option>
        </select>
      </div>
      <div class="form-row">
        <select id="profileImage" class="form-input" onchange="onImageSelect(this.value)">
          <option value="">-- 选择 Docker 镜像 --</option>
          <optgroup label="预设镜像" id="presetImages">
            <option value="mcr.microsoft.com/dotnet/sdk:8.0">.NET 8 SDK</option>
            <option value="node:20-slim">Node.js 20</option>
            <option value="node:22-slim">Node.js 22</option>
            <option value="python:3.12-slim">Python 3.12</option>
            <option value="golang:1.22-alpine">Go 1.22</option>
            <option value="rust:1.77-slim">Rust 1.77</option>
          </optgroup>
          <optgroup label="本地镜像" id="localImages"></optgroup>
          <option value="__custom__">自定义...</option>
        </select>
        <input id="profileImageCustom" placeholder="自定义镜像" class="form-input hidden">
      </div>
      <div class="form-row">
        <input id="profileWorkDir" placeholder="工作目录（默认: .）" class="form-input sm" value=".">
        <input id="profilePort" type="number" value="8080" placeholder="端口" class="form-input xs">
      </div>
      <div class="form-row">
        <input id="profileRun" placeholder="运行命令（必填）" class="form-input">
      </div>
      <div id="advancedFields" class="hidden">
        <div class="form-row">
          <input id="profileInstall" placeholder="安装命令（可选）" class="form-input">
        </div>
        <div class="form-row">
          <input id="profileBuild" placeholder="构建命令（可选）" class="form-input">
        </div>
      </div>
      <div class="form-row">
        <button class="primary sm" onclick="saveProfileAndRefresh()">保存</button>
        <button class="sm" onclick="toggleModalForm('addProfileFormModal')">取消</button>
        <button class="sm text-btn" onclick="toggleAdvanced()">高级选项</button>
      </div>
    </div>
    <div id="profileListInModal">${listHtml}</div>
  `;
  openConfigModal('构建配置', html);
}

function showAddProfileInModal() {
  toggleModalForm('addProfileFormModal');
  loadDockerImages();
}

async function saveProfileAndRefresh() {
  const selectVal = document.getElementById('profileImage').value;
  const customVal = document.getElementById('profileImageCustom').value.trim();
  const dockerImage = selectVal === '__custom__' ? customVal : selectVal;
  const iconVal = document.getElementById('profileIcon').value;
  const profile = {
    id: document.getElementById('profileId').value.trim(),
    name: document.getElementById('profileName').value.trim(),
    icon: iconVal || undefined,
    dockerImage,
    workDir: document.getElementById('profileWorkDir').value.trim() || '.',
    containerPort: parseInt(document.getElementById('profilePort').value) || 8080,
    installCommand: document.getElementById('profileInstall').value.trim() || undefined,
    buildCommand: document.getElementById('profileBuild').value.trim() || undefined,
    runCommand: document.getElementById('profileRun').value.trim(),
  };
  try {
    await api('POST', '/build-profiles', profile);
    showToast('配置已添加', 'success');
    await loadProfiles();
    openProfileModal();
  } catch (e) { showToast(e.message, 'error'); }
}

async function deleteProfileAndRefresh(id) {
  try {
    await api('DELETE', `/build-profiles/${id}`);
    showToast('配置已删除', 'success');
    await loadProfiles();
    openProfileModal();
  } catch (e) { showToast(e.message, 'error'); }
}

// ── Container env viewer ──

async function viewContainerEnv(id, profileId) {
  openConfigModal('容器环境变量', '<div class="config-empty"><span class="btn-spinner"></span> 加载中...</div>');
  try {
    const data = await api('POST', `/branches/${id}/container-env`, { profileId });
    const envText = data.env || '';
    const lines = envText.trim().split('\n').filter(Boolean).sort();
    const listHtml = lines.map(line => {
      const eqIdx = line.indexOf('=');
      if (eqIdx <= 0) return `<div class="config-item"><div class="config-item-main"><code class="env-val">${esc(line)}</code></div></div>`;
      const k = line.substring(0, eqIdx);
      const v = line.substring(eqIdx + 1);
      return `
        <div class="config-item">
          <div class="config-item-main">
            <code class="env-key">${esc(k)}</code>
            <span class="config-item-arrow">=</span>
            <code class="env-val" title="${esc(v)}">${esc(maskValue(k, v))}</code>
          </div>
        </div>
      `;
    }).join('');
    const label = profileId || '默认';
    openConfigModal(`容器变量: ${id} / ${label}`, `
      <p class="config-panel-desc">容器内部实际运行的环境变量（只读）。共 ${lines.length} 个变量。</p>
      ${listHtml}
    `);
  } catch (e) {
    openConfigModal('容器环境变量', `<div class="config-empty" style="color:var(--red)">${esc(e.message)}</div>`);
  }
}

function openContainerEnvPicker(branchId) {
  const branch = localBranches.find(b => b.id === branchId);
  if (!branch) return;
  const services = Object.entries(branch.services || {});
  if (services.length === 0) {
    showToast('该分支没有运行中的服务', 'error');
    return;
  }
  if (services.length === 1) {
    viewContainerEnv(branchId, services[0][0]);
    return;
  }
  // Multiple services — let user pick
  const listHtml = services.map(([pid, svc]) => `
    <div class="config-item" style="cursor:pointer" onclick="viewContainerEnv('${esc(branchId)}', '${esc(pid)}')">
      <div class="config-item-main">
        <strong>${esc(pid)}</strong>
        <span class="port-badge ${svc.status === 'running' ? 'run-port' : 'port-idle'}" style="display:inline-block">:${svc.hostPort}</span>
        <span class="config-item-detail">${svc.status}</span>
      </div>
    </div>
  `).join('');
  openConfigModal('选择服务查看容器变量', listHtml);
}

function toggleModalForm(id) {
  const el = document.getElementById(id);
  if (el) el.classList.toggle('hidden');
}

// ── Log modal ──

function openLogModal(title) {
  document.getElementById('logModalTitle').textContent = title;
  document.getElementById('logModal').classList.remove('hidden');
}

function closeLogModal() {
  document.getElementById('logModal').classList.add('hidden');
}

// ── Logout ──

async function doLogout() {
  try { await fetch('/api/logout', { method: 'POST' }); } catch { /* ignore */ }
  location.href = '/login.html';
}

// ── Commit log dropdown (portal) ──

let openCommitLogId = null;

function closeCommitLog() {
  openCommitLogId = null;
  const el = document.getElementById('commit-log-portal');
  if (el) el.remove();
}

async function toggleCommitLog(id, triggerEl) {
  if (openCommitLogId === id) { closeCommitLog(); return; }
  closeCommitLog();
  closeDeployMenu();
  openCommitLogId = id;

  const el = document.createElement('div');
  el.className = 'commit-log-dropdown';
  el.id = 'commit-log-portal';
  el.onclick = (e) => e.stopPropagation();
  el.innerHTML = '<div class="commit-log-loading"><span class="btn-spinner"></span> 加载中...</div>';
  portal.appendChild(el);
  positionPortalDropdown(el, triggerEl, 'right');

  try {
    const data = await api('GET', `/branches/${encodeURIComponent(id)}/git-log?count=15`);
    const commits = data.commits || [];
    if (commits.length === 0) {
      el.innerHTML = '<div class="commit-log-empty">暂无提交记录</div>';
      return;
    }
    el.innerHTML = commits.map((c, i) => `
      <div class="commit-log-item ${i === 0 ? 'latest' : ''}">
        ${commitIcon(c.subject)}<code class="commit-hash">${esc(c.hash)}</code>
        <span class="commit-subject">${esc(c.subject)}</span>
        <span class="commit-meta">${esc(c.author)} · ${esc(c.date)}</span>
      </div>
    `).join('');
  } catch (e) {
    el.innerHTML = `<div class="commit-log-empty" style="color:var(--red)">${esc(e.message)}</div>`;
  }
}

// ── Title animation ──

function initTitleRotation() {
  const el = document.getElementById('titleRotating');
  if (!el) return;
  const words = ['一键部署', '极速开发', '分支管理', '云端协作'];
  let idx = 0;
  el.innerHTML = `<span class="title-rotating-text">${words[0]}</span>`;

  setInterval(() => {
    idx = (idx + 1) % words.length;
    const span = el.querySelector('.title-rotating-text');
    if (!span) return;
    span.style.transition = 'opacity 0.3s, transform 0.3s';
    span.style.opacity = '0';
    span.style.transform = 'translateY(-100%)';
    setTimeout(() => {
      span.textContent = words[idx];
      span.style.transform = 'translateY(100%)';
      span.style.opacity = '0';
      requestAnimationFrame(() => {
        span.style.opacity = '1';
        span.style.transform = 'translateY(0)';
      });
    }, 300);
  }, 3000);
}

initTitleRotation();

// ── Start ──
init();
