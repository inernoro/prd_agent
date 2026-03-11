const API = '/api';
const busyBranches = new Set();
// Per-button loading state: Map<string, Set<string>> e.g. { "main": Set(["stop", "pull"]) }
const loadingActions = new Map();
let globalBusy = false;

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
  // Don't toggle when clicking buttons/links inside the header
  if (event.target.closest('button, a, .port-badge')) return;
  if (collapsedBranches.has(id)) {
    collapsedBranches.delete(id);
  } else {
    collapsedBranches.add(id);
  }
  renderBranches();
}

// ── Init ──

async function init() {
  await Promise.all([loadBranches(), loadProfiles(), loadRoutingRules(), loadConfig(), loadEnvVars()]);
  refreshRemoteBranches();
  setInterval(loadBranches, 10000);
}

let githubRepoUrl = '';
let mainDomain = '';
let switchDomain = '';
let workerPort = '';

async function loadConfig() {
  try {
    const data = await api('GET', '/config');
    document.getElementById('workerLabel').textContent = `Worker :${data.workerPort || '?'}`;
    githubRepoUrl = data.githubRepoUrl || '';
    mainDomain = data.mainDomain || '';
    switchDomain = data.switchDomain || '';
    workerPort = data.workerPort || '';
  } catch (e) { console.error('loadConfig:', e); }
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
  const localIds = new Set(localBranches.map(b => StateService_slugify(b.branch)));
  const filtered = remoteBranches.filter(b =>
    b.name.toLowerCase().includes(q) && !localIds.has(StateService_slugify(b.name))
  ).slice(0, 20);

  if (filtered.length === 0) {
    dropdown.innerHTML = '<div class="branch-dropdown-empty">没有匹配的分支</div>';
  } else {
    dropdown.innerHTML = filtered.map(b => {
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
              <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>
            </a>
            <a href="${prUrl}" target="_blank" rel="noopener" class="branch-link-btn pr-link" onclick="event.stopPropagation()" title="访问 PR">
              <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M1.5 3.25a2.25 2.25 0 113 2.122v5.256a2.251 2.251 0 11-1.5 0V5.372A2.25 2.25 0 011.5 3.25zm5.677-.177L9.573.677A.25.25 0 0110 .854V2.5h1A2.5 2.5 0 0113.5 5v5.628a2.251 2.251 0 11-1.5 0V5a1 1 0 00-1-1h-1v1.646a.25.25 0 01-.427.177L7.177 3.427a.25.25 0 010-.354zM3.75 2.5a.75.75 0 100 1.5.75.75 0 000-1.5zm0 9.5a.75.75 0 100 1.5.75.75 0 000-1.5zm8.25.75a.75.75 0 11-1.5 0 .75.75 0 011.5 0z"/></svg>
            </a>
          </div>
        ` : ''}
      </div>
    `;
    }).join('');
  }
  dropdown.classList.remove('hidden');
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
    showToast(`分支 "${name}" 已添加`, 'success');
    await loadBranches();
  } catch (e) { showToast(e.message, 'error'); }
}

async function deployBranch(id) {
  if (busyBranches.has(id)) return;
  busyBranches.add(id);
  renderBranches();

  openLogModal(`部署 ${id}`);
  const body = document.getElementById('logModalBody');
  body.innerHTML = '<div class="live-log-header"><span class="live-dot"></span> 构建中...</div><div class="live-log-output" id="liveOutput"></div>';

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
          const el = document.getElementById('liveOutput');
          if (!el) continue;

          if (data.chunk) {
            el.textContent += data.chunk;
          } else if (data.step) {
            el.textContent += `\n[${data.status}] ${data.title || data.step}\n`;
          } else if (data.message) {
            el.textContent += `\n${data.message}\n`;
          }
          el.scrollTop = el.scrollHeight;
        }
      }
    }
  } catch (e) {
    showToast(e.message, 'error');
  }

  busyBranches.delete(id);
  await loadBranches();
}

async function stopBranch(id) {
  if (busyBranches.has(id) || isLoading(id, 'stop')) return;
  setLoading(id, 'stop');
  try {
    await api('POST', `/branches/${id}/stop`);
    showToast('服务已停止', 'success');
  } catch (e) { showToast(e.message, 'error'); }
  clearLoading(id, 'stop');
  await loadBranches();
}

async function pullBranch(id) {
  if (isLoading(id, 'pull')) return;
  setLoading(id, 'pull');
  try {
    const result = await api('POST', `/branches/${id}/pull`);
    showToast(result.updated ? `已更新: ${result.head}` : '已是最新', result.updated ? 'success' : 'info');
  } catch (e) { showToast(e.message, 'error'); }
  clearLoading(id, 'pull');
  await loadBranches();
}

function previewBranch(id) {
  // Build preview URL: prefer switchDomain, then mainDomain with /_switch/, fallback to workerPort
  let url;
  if (switchDomain) {
    url = `${location.protocol}//${switchDomain}/${encodeURIComponent(id)}`;
  } else if (mainDomain) {
    url = `${location.protocol}//${mainDomain}/_switch/${encodeURIComponent(id)}`;
  } else if (workerPort) {
    url = `${location.protocol}//${location.hostname}:${workerPort}/_switch/${encodeURIComponent(id)}`;
  } else {
    showToast('未配置预览域名，请设置 MAIN_DOMAIN 或 SWITCH_DOMAIN', 'error');
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
  renderBranches();

  const profile = buildProfiles.find(p => p.id === profileId);
  const label = profile ? profile.name : profileId;
  openLogModal(`部署 ${id} / ${label}`);
  const body = document.getElementById('logModalBody');
  body.innerHTML = '<div class="live-log-header"><span class="live-dot"></span> 构建中...</div><div class="live-log-output" id="liveOutput"></div>';

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
          const el = document.getElementById('liveOutput');
          if (!el) continue;

          if (data.chunk) {
            el.textContent += data.chunk;
          } else if (data.step) {
            el.textContent += `\n[${data.status}] ${data.title || data.step}\n`;
          } else if (data.message) {
            el.textContent += `\n${data.message}\n`;
          }
          el.scrollTop = el.scrollHeight;
        }
      }
    }
  } catch (e) {
    showToast(e.message, 'error');
  }

  busyBranches.delete(id);
  await loadBranches();
}

// ── Deploy dropdown menu ──

let openDeployMenuId = null;

function toggleDeployMenu(id, event) {
  event.stopPropagation();
  if (openDeployMenuId === id) {
    closeDeployMenu(id);
    return;
  }
  // Close any other open menu
  if (openDeployMenuId) closeDeployMenu(openDeployMenuId);
  openDeployMenuId = id;
  const menu = document.getElementById(`deploy-menu-${CSS.escape(id)}`);
  if (menu) menu.classList.remove('hidden');
}

function closeDeployMenu(id) {
  openDeployMenuId = null;
  const menu = document.getElementById(`deploy-menu-${CSS.escape(id)}`);
  if (menu) menu.classList.add('hidden');
}

// Close deploy menu on outside click
document.addEventListener('click', () => {
  if (openDeployMenuId) closeDeployMenu(openDeployMenuId);
});

// ── Rendering ──

function renderBranches() {
  const el = document.getElementById('branchList');
  const count = document.getElementById('branchCount');
  count.textContent = `${localBranches.length} 个分支`;

  // Update default branch selector
  const sel = document.getElementById('defaultBranch');
  sel.innerHTML = '<option value="">无默认</option>' +
    localBranches.map(b => `<option value="${esc(b.id)}" ${b.id === defaultBranch ? 'selected' : ''}>${esc(b.id)}</option>`).join('');

  // Update cleanup button
  const cleanupBtn = document.getElementById('cleanupBtn');
  const nonDefault = localBranches.filter(b => b.id !== defaultBranch);
  cleanupBtn.disabled = nonDefault.length === 0 || globalBusy;
  cleanupBtn.title = nonDefault.length > 0 ? `清理 ${nonDefault.length} 个分支` : '没有可清理的分支';

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
    const hasMultipleProfiles = buildProfiles.length > 1;

    // Loading state helpers for this branch
    const btnDisabled = (action) => (isBusy || isLoading(b.id, action)) ? 'disabled' : '';
    const btnLabel = (action, label) => isLoading(b.id, action) ? `<span class="btn-spinner"></span>${label}` : label;

    // Build deploy dropdown items for single-service redeploy
    const deployMenuItems = buildProfiles.map(p =>
      `<div class="deploy-menu-item" onclick="deploySingleService('${esc(b.id)}', '${esc(p.id)}')">${esc(p.name)}</div>`
    ).join('');

    const expanded = !collapsedBranches.has(b.id);

    return `
      <div class="branch-card ${isDefault ? 'active' : ''} ${isBusy ? 'is-busy' : ''} ${hasError ? 'has-error' : ''} ${expanded ? 'expanded' : ''}">
        <div class="branch-card-header" onclick="toggleBranchCard('${esc(b.id)}', event)">
          <div class="branch-card-left">
            <span class="status-dot ${b.status}"></span>
            <div class="branch-info">
              <div class="branch-name-row">
                <span class="branch-name">${esc(b.branch)}</span>
                ${isDefault ? '<span class="active-badge">默认</span>' : ''}
                ${services.length > 0 ? services.map(([pid, svc]) => `
                  <span class="port-badge ${svc.status === 'running' ? 'run-port' : 'port-idle'}"
                        onclick="event.stopPropagation(); viewContainerLogs('${esc(b.id)}', '${esc(pid)}')"
                        title="${esc(pid)}: ${svc.status}"
                        style="cursor:pointer">
                    ${esc(pid)} :${svc.hostPort}
                  </span>
                `).join('') : ''}
              </div>
            </div>
          </div>
          <div class="branch-card-right">
            <span class="branch-meta">${statusLabel(b.status)}${b.lastAccessedAt ? ` · ${relativeTime(b.lastAccessedAt)}` : ''}</span>
            <svg class="branch-chevron ${expanded ? 'open' : ''}" width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M4.427 5.427a.75.75 0 011.146 0L8 7.854l2.427-2.427a.75.75 0 111.146 1.146l-3 3a.75.75 0 01-1.146 0l-3-3a.75.75 0 010-1.146z"/></svg>
          </div>
        </div>
        ${b.errorMessage ? `<div class="branch-error" title="${esc(b.errorMessage)}">${esc(b.errorMessage)}</div>` : ''}
        <div class="branch-card-actions-row ${expanded ? '' : 'hidden'}">
          <div class="branch-actions-left">
            <button class="primary sm" onclick="pullBranch('${esc(b.id)}')" ${btnDisabled('pull')}>${btnLabel('pull', '拉取')}</button>
            ${isRunning ? `<button class="primary sm" onclick="previewBranch('${esc(b.id)}')">预览</button>` : ''}
            ${isRunning && hasMultipleProfiles ? `
              <div class="split-btn">
                <button class="sm split-btn-main" onclick="deployBranch('${esc(b.id)}')" ${isBusy ? 'disabled' : ''}>重新部署</button>
                <button class="sm split-btn-toggle" onclick="toggleDeployMenu('${esc(b.id)}', event)" ${isBusy ? 'disabled' : ''}>
                  <svg width="10" height="6" viewBox="0 0 10 6" fill="currentColor"><path d="M1 1l4 4 4-4"/></svg>
                </button>
                <div class="deploy-menu hidden" id="deploy-menu-${esc(b.id)}">
                  <div class="deploy-menu-header">选择重部署的服务</div>
                  ${deployMenuItems}
                </div>
              </div>
            ` : `
              <button class="${isRunning ? '' : 'primary '}sm" onclick="deployBranch('${esc(b.id)}')" ${isBusy ? 'disabled' : ''}>
                ${isRunning ? '重新部署' : '部署'}
              </button>
            `}
            ${isRunning ? `<button class="sm" onclick="stopBranch('${esc(b.id)}')" ${btnDisabled('stop')}>${btnLabel('stop', '停止')}</button>` : ''}
            ${services.length > 0 ? `<button class="sm" onclick="openContainerEnvPicker('${esc(b.id)}')" ${isBusy ? 'disabled' : ''}>容器变量</button>` : ''}
            ${hasError ? `<button class="sm" onclick="resetBranch('${esc(b.id)}')" ${btnDisabled('reset')}>${btnLabel('reset', '重置')}</button>` : ''}
            ${!isDefault ? `<button class="sm" onclick="setDefaultBranch('${esc(b.id)}')" ${btnDisabled('setDefault')}>${btnLabel('setDefault', '设为默认')}</button>` : ''}
            <button class="sm danger" onclick="removeBranch('${esc(b.id)}')" ${isBusy ? 'disabled' : ''}>删除</button>
          </div>
          ${b.subject ? `<div class="branch-requirement">${esc(b.subject)}</div>` : ''}
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
  const profile = {
    id: document.getElementById('profileId').value.trim(),
    name: document.getElementById('profileName').value.trim(),
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
