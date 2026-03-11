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

// ── Init ──

async function init() {
  await Promise.all([loadBranches(), loadProfiles(), loadRoutingRules(), loadConfig(), loadEnvVars()]);
  refreshRemoteBranches();
  setInterval(loadBranches, 10000);
}

async function loadConfig() {
  try {
    const data = await api('GET', '/config');
    document.getElementById('workerLabel').textContent = `Worker :${data.workerPort || '?'}`;
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
    dropdown.innerHTML = filtered.map(b => `
      <div class="branch-dropdown-item" onclick="addBranch('${esc(b.name)}')">
        <div class="branch-dropdown-item-info">
          <div class="branch-dropdown-item-row1">
            <span class="branch-dropdown-item-name">${esc(b.name)}</span>
            <span class="branch-dropdown-item-time">${relativeTime(b.date)}</span>
          </div>
          <div class="branch-dropdown-item-row2">${esc(b.author || '')} — ${esc(b.subject || '')}</div>
        </div>
      </div>
    `).join('');
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

    return `
      <div class="branch-card ${isDefault ? 'active' : ''} ${isBusy ? 'is-busy' : ''} ${hasError ? 'has-error' : ''}">
        <div class="branch-card-header">
          <div class="branch-card-left">
            <span class="status-dot ${b.status}"></span>
            <div class="branch-info">
              <div class="branch-name">
                ${esc(b.branch)}
                ${isDefault ? '<span class="active-badge">默认</span>' : ''}
              </div>
              <div class="branch-meta">
                ${statusLabel(b.status)}
                ${b.lastAccessedAt ? ` · ${relativeTime(b.lastAccessedAt)}` : ''}
              </div>
              ${services.length > 0 ? `
                <div class="branch-ports">
                  ${services.map(([pid, svc]) => `
                    <span class="port-badge ${svc.status === 'running' ? 'run-port' : 'port-idle'}"
                          onclick="viewContainerLogs('${esc(b.id)}', '${esc(pid)}')"
                          title="${esc(pid)}: ${svc.status}"
                          style="cursor:pointer">
                      ${esc(pid)} :${svc.hostPort}
                    </span>
                  `).join('')}
                </div>
              ` : ''}
              ${b.errorMessage ? `<div class="branch-error" title="${esc(b.errorMessage)}">${esc(b.errorMessage)}</div>` : ''}
            </div>
          </div>
        </div>
        <div class="branch-card-actions-row">
          ${isRunning && hasMultipleProfiles ? `
            <div class="split-btn">
              <button class="primary sm split-btn-main" onclick="deployBranch('${esc(b.id)}')" ${isBusy ? 'disabled' : ''}>重新部署</button>
              <button class="primary sm split-btn-toggle" onclick="toggleDeployMenu('${esc(b.id)}', event)" ${isBusy ? 'disabled' : ''}>
                <svg width="10" height="6" viewBox="0 0 10 6" fill="currentColor"><path d="M1 1l4 4 4-4"/></svg>
              </button>
              <div class="deploy-menu hidden" id="deploy-menu-${esc(b.id)}">
                <div class="deploy-menu-header">选择重部署的服务</div>
                ${deployMenuItems}
              </div>
            </div>
          ` : `
            <button class="primary sm" onclick="deployBranch('${esc(b.id)}')" ${isBusy ? 'disabled' : ''}>
              ${isRunning ? '重新部署' : '部署'}
            </button>
          `}
          ${isRunning ? `<button class="sm" onclick="stopBranch('${esc(b.id)}')" ${btnDisabled('stop')}>${btnLabel('stop', '停止')}</button>` : ''}
          <button class="sm" onclick="pullBranch('${esc(b.id)}')" ${btnDisabled('pull')}>${btnLabel('pull', '拉取')}</button>
          ${hasError ? `<button class="sm" onclick="resetBranch('${esc(b.id)}')" ${btnDisabled('reset')}>${btnLabel('reset', '重置')}</button>` : ''}
          ${!isDefault ? `<button class="sm" onclick="setDefaultBranch('${esc(b.id)}')" ${btnDisabled('setDefault')}>${btnLabel('setDefault', '设为默认')}</button>` : ''}
          <button class="sm danger" onclick="removeBranch('${esc(b.id)}')" ${isBusy ? 'disabled' : ''}>删除</button>
        </div>
      </div>
    `;
  }).join('');
}

// ── Routing rules ──

function renderRoutingRules() {
  const el = document.getElementById('routingRulesList');
  if (routingRules.length === 0) {
    el.innerHTML = '<div class="config-empty">暂无路由规则。请求将使用 X-Branch 头或默认分支。</div>';
    return;
  }
  el.innerHTML = routingRules.map(r => `
    <div class="config-item ${r.enabled ? '' : 'disabled'}">
      <div class="config-item-main">
        <span class="config-item-type">${esc(r.type)}</span>
        <code class="config-item-match">${esc(r.match)}</code>
        <span class="config-item-arrow">&rarr;</span>
        <span class="config-item-target">${esc(r.branch)}</span>
      </div>
      <div class="config-item-actions">
        <button class="icon-btn xs" onclick="toggleRule('${esc(r.id)}')" title="${r.enabled ? '禁用' : '启用'}">
          ${r.enabled ? '&#x2713;' : '&#x2717;'}
        </button>
        <button class="icon-btn xs danger-icon" onclick="deleteRule('${esc(r.id)}')" title="删除">&times;</button>
      </div>
    </div>
  `).join('');
}

function showAddRuleForm() { document.getElementById('addRuleForm').classList.remove('hidden'); }
function hideAddRuleForm() { document.getElementById('addRuleForm').classList.add('hidden'); }

async function saveRule() {
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
    hideAddRuleForm();
    showToast('规则已添加', 'success');
    await loadRoutingRules();
  } catch (e) { showToast(e.message, 'error'); }
}

async function toggleRule(id) {
  const rule = routingRules.find(r => r.id === id);
  if (!rule) return;
  try {
    await api('PUT', `/routing-rules/${id}`, { enabled: !rule.enabled });
    await loadRoutingRules();
  } catch (e) { showToast(e.message, 'error'); }
}

async function deleteRule(id) {
  try {
    await api('DELETE', `/routing-rules/${id}`);
    showToast('规则已删除', 'success');
    await loadRoutingRules();
  } catch (e) { showToast(e.message, 'error'); }
}

// ── Build profiles ──

function renderProfiles() {
  const el = document.getElementById('profilesList');
  const banner = document.getElementById('quickstartBanner');
  if (buildProfiles.length === 0) {
    el.innerHTML = '<div class="config-empty">暂无构建配置，请添加一个。</div>';
    banner.classList.remove('hidden');
    return;
  }
  banner.classList.add('hidden');
  el.innerHTML = buildProfiles.map(p => `
    <div class="config-item">
      <div class="config-item-main">
        <strong>${esc(p.name)}</strong>
        <code class="config-item-match">${esc(p.dockerImage)}</code>
        <span class="config-item-detail">${esc(p.workDir || '.')} :${p.containerPort}</span>
        <code class="config-item-cmd" title="${esc(p.runCommand)}">${esc(p.runCommand)}</code>
      </div>
      <div class="config-item-actions">
        <button class="icon-btn xs danger-icon" onclick="deleteProfile('${esc(p.id)}')" title="删除">&times;</button>
      </div>
    </div>
  `).join('');
}

function showAddProfileForm() {
  document.getElementById('addProfileForm').classList.remove('hidden');
  loadDockerImages();
}
function hideAddProfileForm() { document.getElementById('addProfileForm').classList.add('hidden'); }

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

async function saveProfile() {
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
    hideAddProfileForm();
    showToast('配置已添加', 'success');
    await loadProfiles();
  } catch (e) { showToast(e.message, 'error'); }
}

async function runQuickstart() {
  try {
    const data = await api('POST', '/quickstart');
    showToast(data.message, 'success');
    await loadProfiles();
  } catch (e) { showToast(e.message, 'error'); }
}

async function deleteProfile(id) {
  try {
    await api('DELETE', `/build-profiles/${id}`);
    showToast('配置已删除', 'success');
    await loadProfiles();
  } catch (e) { showToast(e.message, 'error'); }
}

// ── Environment variables ──

async function loadEnvVars() {
  try {
    const data = await api('GET', '/env');
    customEnvVars = data.env || {};
    renderEnvVars();
  } catch (e) { console.error('loadEnvVars:', e); }
}

function maskValue(key, val) {
  if (/password|secret|key/i.test(key)) return '••••••••';
  return val;
}

function renderEnvVars() {
  const el = document.getElementById('envVarsList');
  const entries = Object.entries(customEnvVars);
  if (entries.length === 0) {
    el.innerHTML = '<div class="config-empty">暂无自定义环境变量。默认使用自动检测的主机变量 (MONGODB_HOST 等)。</div>';
    return;
  }
  el.innerHTML = entries.map(([k, v]) => `
    <div class="config-item">
      <div class="config-item-main">
        <code class="env-key">${esc(k)}</code>
        <span class="config-item-arrow">=</span>
        <code class="env-val" title="${esc(v)}">${esc(maskValue(k, v))}</code>
      </div>
      <div class="config-item-actions">
        <button class="icon-btn xs" onclick="editEnvVar('${esc(k)}')" title="编辑">&#x270E;</button>
        <button class="icon-btn xs danger-icon" onclick="deleteEnvVar('${esc(k)}')" title="删除">&times;</button>
      </div>
    </div>
  `).join('');
}

function showAddEnvForm() { document.getElementById('addEnvForm').classList.remove('hidden'); }
function hideAddEnvForm() { document.getElementById('addEnvForm').classList.add('hidden'); }

async function saveEnvVar() {
  const key = document.getElementById('envKey').value.trim();
  const value = document.getElementById('envValue').value;
  if (!key) { showToast('键名不能为空', 'error'); return; }
  try {
    await api('PUT', `/env/${encodeURIComponent(key)}`, { value });
    hideAddEnvForm();
    document.getElementById('envKey').value = '';
    document.getElementById('envValue').value = '';
    showToast(`已设置 ${key}`, 'success');
    await loadEnvVars();
  } catch (e) { showToast(e.message, 'error'); }
}

async function editEnvVar(key) {
  document.getElementById('envKey').value = key;
  document.getElementById('envValue').value = customEnvVars[key] || '';
  showAddEnvForm();
}

async function deleteEnvVar(key) {
  try {
    await api('DELETE', `/env/${encodeURIComponent(key)}`);
    showToast(`已删除 ${key}`, 'success');
    await loadEnvVars();
  } catch (e) { showToast(e.message, 'error'); }
}

function toggleBulkEnvEdit() {
  const form = document.getElementById('bulkEnvForm');
  const isHidden = form.classList.contains('hidden');
  if (isHidden) {
    // 填充当前变量到 textarea
    const textarea = document.getElementById('bulkEnvTextarea');
    const entries = Object.entries(customEnvVars);
    if (entries.length > 0) {
      textarea.value = entries.map(([k, v]) => `${k}=${v}`).join('\n');
    }
    form.classList.remove('hidden');
    hideAddEnvForm();
    updateBulkHint();
    textarea.addEventListener('input', updateBulkHint);
  } else {
    form.classList.add('hidden');
  }
}

function updateBulkHint() {
  const textarea = document.getElementById('bulkEnvTextarea');
  const hint = document.getElementById('bulkEnvHint');
  const lines = textarea.value.split('\n').filter(l => l.trim() && !l.trim().startsWith('#'));
  const validCount = lines.filter(l => l.includes('=')).length;
  hint.textContent = `${validCount} 个变量`;
}

async function saveBulkEnv() {
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
    // 删除不在新列表中的旧变量
    const oldKeys = Object.keys(customEnvVars);
    for (const key of oldKeys) {
      if (!(key in newVars)) {
        await api('DELETE', `/env/${encodeURIComponent(key)}`);
      }
    }
    // 添加/更新新变量
    for (const [key, value] of Object.entries(newVars)) {
      await api('PUT', `/env/${encodeURIComponent(key)}`, { value });
    }
    document.getElementById('bulkEnvForm').classList.add('hidden');
    showToast(`已保存 ${Object.keys(newVars).length} 个环境变量`, 'success');
    await loadEnvVars();
  } catch (e) { showToast(e.message, 'error'); }
}

// ── Panels ──

function togglePanel(id) {
  const el = document.getElementById(id);
  el.classList.toggle('hidden');
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

// ── Start ──
init();
