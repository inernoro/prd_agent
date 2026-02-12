const API = '/api';
let busy = false;

// ---- Utilities ----

async function api(method, path, body) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`${API}${path}`, opts);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function showToast(msg, type = 'info') {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = `toast ${type}`;
  setTimeout(() => (el.className = 'toast hidden'), 4000);
}

function statusLabel(s) {
  const map = {
    running: '运行中', building: '构建中', built: '已构建',
    idle: '待构建', stopped: '已停止', error: '异常',
  };
  return map[s] || s;
}

function relativeTime(iso) {
  if (!iso) return '';
  const m = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (m < 1) return '刚刚';
  if (m < 60) return `${m} 分钟前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小时前`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d} 天前`;
  return `${Math.floor(d / 30)} 个月前`;
}

function esc(str) {
  const d = document.createElement('div');
  d.textContent = str || '';
  return d.innerHTML;
}

function setBusy(v) {
  busy = v;
  if (!v) refresh();
}

// ---- Tracked branch cards ----

function branchActions(b, isActive) {
  const btns = [];
  if (b.status !== 'building')
    btns.push(`<button onclick="pullBranch('${b.id}')">拉取代码</button>`);
  if (['idle', 'error', 'built', 'stopped'].includes(b.status) || (b.status === 'running' && !isActive))
    btns.push(`<button class="primary" onclick="deployBranch('${b.id}')">${b.status === 'running' ? '激活' : '一键部署'}</button>`);
  if (b.status === 'running')
    btns.push(`<button onclick="stopBranch('${b.id}')">停止</button>`);
  if (!isActive)
    btns.push(`<button class="danger" onclick="removeBranch('${b.id}')">删除</button>`);
  return btns.join('');
}

function renderBranches(branches, activeBranchId) {
  const list = document.getElementById('branchList');
  const entries = Object.values(branches);
  if (!entries.length) {
    list.innerHTML = '<div class="empty-state">暂无分支，请从远程分支列表添加</div>';
    return;
  }
  list.innerHTML = entries.map((b) => {
    const a = b.id === activeBranchId;
    return `
    <div class="branch-card ${a ? 'active' : ''}">
      <div class="status-dot ${b.status}"></div>
      <div class="branch-info">
        <div class="branch-name">${esc(b.branch)} ${a ? '(当前激活)' : ''}</div>
        <div class="branch-meta">${statusLabel(b.status)} · DB: ${b.dbName}</div>
      </div>
      <div class="branch-actions">${branchActions(b, a)}</div>
    </div>`;
  }).join('');
}

function renderHistory(history) {
  const el = document.getElementById('historyList');
  const btn = document.getElementById('rollbackBtn');
  if (!history.length) { el.textContent = '暂无切换记录'; btn.disabled = true; }
  else { el.textContent = history.join(' → '); btn.disabled = history.length <= 1; }
}

function renderActiveSwitcher(branches, activeBranchId) {
  const sel = document.getElementById('activeSwitcher');
  const link = document.getElementById('activeLink');
  const entries = Object.values(branches).filter((b) => b.status === 'running');
  let html = '<option value="">无</option>';
  entries.forEach((b) => {
    html += `<option value="${b.id}" ${b.id === activeBranchId ? 'selected' : ''}>${b.branch}</option>`;
  });
  sel.innerHTML = html;
  sel.disabled = !entries.length;
  if (activeBranchId && branches[activeBranchId]) {
    link.classList.remove('hidden');
    link.href = `http://${location.hostname}:5500`;
  } else link.classList.add('hidden');
}

// ---- Branch picker (combobox dropdown) ----

const BRANCH_ICON = `<svg class="branch-icon" viewBox="0 0 16 16" fill="currentColor"><path d="M9.5 3.25a2.25 2.25 0 1 1 3 2.122V6A2.5 2.5 0 0 1 10 8.5H6a1 1 0 0 0-1 1v1.128a2.251 2.251 0 1 1-1.5 0V5.372a2.25 2.25 0 1 1 1.5 0v1.836A2.493 2.493 0 0 1 6 7h4a1 1 0 0 0 1-1v-.628A2.25 2.25 0 0 1 9.5 3.25Zm-6 0a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Zm8.25-.75a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5ZM4.25 12a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Z"/></svg>`;

let remoteBranches = []; // cached from server

function renderDropdown(keyword) {
  const dd = document.getElementById('branchDropdown');
  const kw = (keyword || '').toLowerCase();
  const filtered = kw
    ? remoteBranches.filter((b) =>
        b.name.toLowerCase().includes(kw) ||
        (b.author && b.author.toLowerCase().includes(kw)) ||
        (b.message && b.message.toLowerCase().includes(kw)))
    : remoteBranches;

  if (!filtered.length) {
    dd.innerHTML = `<div class="branch-dropdown-empty">${remoteBranches.length ? '无匹配分支' : '暂无可添加的分支'}</div>`;
    dd.classList.remove('hidden');
    return;
  }

  dd.innerHTML = filtered.map((b) => `
    <div class="branch-dropdown-item" data-branch="${esc(b.name)}">
      <div class="branch-dropdown-item-info">
        <div class="branch-dropdown-item-row1">
          ${BRANCH_ICON}
          <span class="branch-dropdown-item-name">${esc(b.name)}</span>
          <span class="branch-dropdown-item-time">${relativeTime(b.date)}</span>
        </div>
        <div class="branch-dropdown-item-row2">${esc(b.author || '')}${b.message ? ' · ' + esc(b.message) : ''}</div>
      </div>
    </div>`).join('');
  dd.classList.remove('hidden');
}

function hideDropdown() {
  document.getElementById('branchDropdown').classList.add('hidden');
}

// Input events
document.getElementById('branchSearch').addEventListener('focus', () => {
  renderDropdown(document.getElementById('branchSearch').value);
});

document.getElementById('branchSearch').addEventListener('input', (e) => {
  renderDropdown(e.target.value);
});

// Click on dropdown item → add branch
document.getElementById('branchDropdown').addEventListener('click', (e) => {
  const item = e.target.closest('.branch-dropdown-item');
  if (!item) return;
  const name = item.dataset.branch;
  if (name) {
    hideDropdown();
    document.getElementById('branchSearch').value = '';
    addBranch(name);
  }
});

// Click outside → close dropdown
document.addEventListener('mousedown', (e) => {
  const picker = document.querySelector('.branch-picker');
  if (picker && !picker.contains(e.target)) hideDropdown();
});

// Silent data fetch — no UI side effects
async function loadRemoteBranches() {
  const btn = document.getElementById('refreshRemoteBtn');
  try {
    btn.disabled = true;
    const data = await api('GET', '/remote-branches');
    remoteBranches = data.branches || [];
  } catch (err) {
    remoteBranches = [];
    showToast('加载远程分支失败: ' + err.message, 'error');
  } finally {
    btn.disabled = false;
  }
}

// Manual refresh — show loading state in dropdown
async function refreshRemoteBranches() {
  const dd = document.getElementById('branchDropdown');
  dd.innerHTML = '<div class="branch-dropdown-empty"><span class="loading"></span> 正在获取...</div>';
  dd.classList.remove('hidden');
  await loadRemoteBranches();
  renderDropdown(document.getElementById('branchSearch').value);
}

async function refresh() {
  try {
    const [bd, hd] = await Promise.all([api('GET', '/branches'), api('GET', '/history')]);
    renderBranches(bd.branches, bd.activeBranchId);
    renderHistory(hd.history);
    renderActiveSwitcher(bd.branches, bd.activeBranchId);
  } catch (err) { showToast(err.message, 'error'); }
}

// ============================================================
// Deploy Log Modal (SSE consumer)
// ============================================================

function openDeployModal(branch) {
  document.getElementById('deployModalTitle').textContent = `部署日志 — ${branch}`;
  document.getElementById('deployModalBody').innerHTML = '';
  document.getElementById('deployModal').classList.remove('hidden');
}

function closeDeployModal() {
  document.getElementById('deployModal').classList.add('hidden');
}

const STEP_ICONS = { running: '<span class="loading"></span>', done: '✅', skip: '⏭️', warn: '⚠️', error: '❌' };

function appendDeployEvent(data) {
  const body = document.getElementById('deployModalBody');

  // ---- env info block ----
  if (data.step === 'env') {
    const d = data.detail;
    body.insertAdjacentHTML('beforeend', `
      <div class="deploy-env">
        <table class="deploy-env-table">
          <tr><td>Commit</td><td><code>${esc(d.commitLog)}</code></td></tr>
          <tr><td>Worktree</td><td><code>${esc(d.worktreePath)}</code></td></tr>
          <tr><td>容器</td><td><code>${esc(d.containerName)}</code></td></tr>
          <tr><td>镜像</td><td><code>${esc(d.imageName)}</code></td></tr>
          <tr><td>数据库</td><td><code>${esc(d.dbName)}</code></td></tr>
          <tr><td>Docker 网络</td><td><code>${esc(d.network)}</code></td></tr>
          <tr><td>网关端口</td><td><code>${d.gatewayPort}</code></td></tr>
        </table>
      </div>`);
    return;
  }

  // ---- complete ----
  if (data.step === 'complete') {
    body.insertAdjacentHTML('beforeend',
      `<div class="deploy-complete">✅ 部署完成</div>`);
    return;
  }

  // ---- fatal error — also mark any running steps as failed ----
  if (data.step === 'error') {
    body.querySelectorAll('.deploy-step.is-running').forEach((el) => {
      el.className = 'deploy-step is-error';
      const hdr = el.querySelector('.deploy-step-hdr');
      if (hdr) hdr.innerHTML = `${STEP_ICONS.error} ${hdr.querySelector('span')?.outerHTML || ''}`;
    });
    body.insertAdjacentHTML('beforeend', `
      <div class="deploy-step is-error">
        <div class="deploy-step-hdr">${STEP_ICONS.error} <span>${esc(data.title)}</span></div>
        ${data.log ? `<pre class="deploy-log">${esc(data.log)}</pre>` : ''}
      </div>`);
    return;
  }

  // ---- regular step ----
  const el = document.getElementById(`ds-${data.step}`);

  if (data.status === 'running') {
    if (!el) {
      // First running event — create step with streaming log area
      body.insertAdjacentHTML('beforeend', `
        <div class="deploy-step is-running" id="ds-${data.step}">
          <div class="deploy-step-hdr">${STEP_ICONS.running} <span>${esc(data.title)}</span></div>
          <pre class="deploy-stream-log"></pre>
        </div>`);
    }
    // Append streaming chunk if present
    if (data.chunk) {
      const logEl = document.querySelector(`#ds-${data.step} .deploy-stream-log`);
      if (logEl) {
        logEl.textContent += data.chunk;
        logEl.scrollTop = logEl.scrollHeight;
      }
    }
    body.scrollTop = body.scrollHeight;
    return;
  }

  if (data.status === 'skip') {
    body.insertAdjacentHTML('beforeend', `
      <div class="deploy-step is-skip" id="ds-${data.step}">
        <div class="deploy-step-hdr">${STEP_ICONS.skip} <span class="step-skip-text">${esc(data.title)}</span></div>
      </div>`);
    return;
  }

  // Update existing step (done / warn / error)
  if (el) {
    const icon = STEP_ICONS[data.status] || STEP_ICONS.done;
    el.className = `deploy-step is-${data.status}`;

    // Update header icon
    const hdr = el.querySelector('.deploy-step-hdr');
    if (hdr) hdr.innerHTML = `${icon} <span>${esc(data.title)}</span>`;

    // If streaming log has content, keep it visible; otherwise hide empty pre
    const streamLog = el.querySelector('.deploy-stream-log');
    if (streamLog && !streamLog.textContent.trim()) {
      streamLog.style.display = 'none';
      // Non-streaming step: show collapsible log if provided
      if (data.log) {
        el.insertAdjacentHTML('beforeend',
          `<details class="deploy-log-wrap"><summary>查看日志</summary><pre class="deploy-log">${esc(data.log)}</pre></details>`);
      }
    }

    // Nginx config detail
    if (data.detail && data.step === 'activate') {
      const d = data.detail;
      el.insertAdjacentHTML('beforeend',
        `<div class="deploy-detail">upstream: <code>${esc(String(d.upstream))}</code> → gateway: <code>${esc(String(d.gateway))}</code></div>`);
      el.insertAdjacentHTML('beforeend',
        `<details class="deploy-log-wrap"><summary>查看 Nginx 配置</summary><pre class="deploy-log">${esc(d.nginxConf || '')}</pre></details>`);
    }

    // Health check detail
    if (data.detail && data.step === 'health') {
      const d = data.detail;
      const mark = d.match ? '<span class="health-ok">✓ 匹配</span>' : '<span class="health-fail">✗ 不匹配</span>';
      el.insertAdjacentHTML('beforeend', `<div class="deploy-detail">
        URL: <code>${esc(String(d.url))}</code><br>
        期望 commit: <code>${esc(String(d.expected))}</code><br>
        实际 commit: <code>${esc(String(d.actual))}</code> ${mark}
        ${d.builtAt ? `<br>构建时间: ${esc(d.builtAt)}` : ''}
        ${d.hint ? `<br><span class="health-hint">${esc(d.hint)}</span>` : ''}
        ${d.error ? `<br><span class="health-fail">${esc(d.error)}</span>` : ''}
      </div>`);
    }

    // Start container detail
    if (data.detail && data.step === 'start') {
      const d = data.detail;
      el.insertAdjacentHTML('beforeend',
        `<div class="deploy-detail">容器: <code>${esc(d.containerName)}</code> · 网络: <code>${esc(d.network)}</code></div>`);
    }
  }

  body.scrollTop = body.scrollHeight;
}

// ---- User Actions ----

async function addBranch(name) {
  if (!name || busy) return;
  setBusy(true);
  try {
    await api('POST', '/branches', { branch: name });
    showToast(`分支 ${name} 已添加`, 'success');
    await loadRemoteBranches();
  } catch (err) { showToast(err.message, 'error'); }
  finally { setBusy(false); }
}

async function pullBranch(id) {
  if (busy) return;
  setBusy(true);
  showToast(`正在拉取 ${id} 最新代码...`, 'info');
  try {
    const data = await api('POST', `/branches/${id}/pull`);
    showToast(`${id} 已更新: ${data.head}`, 'success');
  } catch (err) { showToast(`拉取失败: ${err.message}`, 'error'); }
  finally { setBusy(false); }
}

async function deployBranch(id) {
  if (busy) return;
  setBusy(true);

  // Get branch name for modal title
  let branchName = id;
  try {
    const bd = await api('GET', '/branches');
    branchName = bd.branches[id]?.branch || id;
  } catch { /* use id */ }

  openDeployModal(branchName);

  try {
    const response = await fetch(`${API}/branches/${id}/deploy`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });

    // Non-SSE error response (404 / 409)
    if (!response.ok && !response.headers.get('content-type')?.includes('text/event-stream')) {
      const err = await response.json();
      throw new Error(err.error || `HTTP ${response.status}`);
    }

    // Consume SSE stream
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });

      const lines = buf.split('\n');
      buf = lines.pop(); // keep incomplete line in buffer

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          try { appendDeployEvent(JSON.parse(line.slice(6))); } catch { /* skip bad json */ }
        }
      }
    }

    showToast(`${branchName} 部署完成`, 'success');
  } catch (err) {
    appendDeployEvent({ step: 'error', status: 'error', title: '连接失败', log: err.message });
    showToast(`部署失败: ${err.message}`, 'error');
  } finally {
    setBusy(false);
  }
}

async function stopBranch(id) {
  if (busy) return;
  setBusy(true);
  try {
    await api('POST', `/branches/${id}/stop`);
    showToast(`${id} 已停止`, 'success');
  } catch (err) { showToast(err.message, 'error'); }
  finally { setBusy(false); }
}

async function removeBranch(id) {
  if (!confirm(`确认删除分支 ${id}？将停止容器、删除 worktree 和镜像。`)) return;
  if (busy) return;
  setBusy(true);
  try {
    await api('DELETE', `/branches/${id}`);
    showToast(`${id} 已删除`, 'success');
    await loadRemoteBranches();
  } catch (err) { showToast(err.message, 'error'); }
  finally { setBusy(false); }
}

async function doRollback() {
  if (busy) return;
  setBusy(true);
  showToast('正在回滚...', 'info');
  try {
    const data = await api('POST', '/rollback');
    showToast(`已回滚到 ${data.activeBranchId}`, 'success');
  } catch (err) { showToast(err.message, 'error'); }
  finally { setBusy(false); }
}

// Top switcher
document.getElementById('activeSwitcher').addEventListener('change', async (e) => {
  const id = e.target.value;
  if (!id || busy) return;
  setBusy(true);
  showToast(`正在切换到 ${id}...`, 'info');
  try {
    await api('POST', `/branches/${id}/activate`);
    showToast(`已切换到 ${id}`, 'success');
  } catch (err) { showToast(err.message, 'error'); }
  finally { setBusy(false); }
});

// Init
loadRemoteBranches();
refresh();
