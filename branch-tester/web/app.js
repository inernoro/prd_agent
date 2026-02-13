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

function runStatusLabel(s) {
  const map = { running: '运行中', stopped: '已停止', error: '异常' };
  return map[s] || '';
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
  const groups = [];
  const srcRunning = b.runStatus === 'running';
  const depRunning = b.status === 'running';
  const isBuilding = b.status === 'building';
  const isMainDb = b.dbName === mainDbName;
  const hasError = b.status === 'error' || b.runStatus === 'error';

  // ── Source mode (run) ──
  const srcBtns = [];
  srcBtns.push(!srcRunning
    ? `<button class="run" onclick="runBranch('${b.id}')" title="挂载源码运行 (dotnet run)">运行</button>`
    : `<button class="run" disabled title="源码容器已在运行">运行</button>`);
  srcBtns.push(srcRunning
    ? `<button class="run-active" onclick="rerunBranch('${b.id}')" title="拉取最新代码并重新运行">重运行</button>`
    : `<button disabled title="源码容器未运行，无法重运行">重运行</button>`);
  srcBtns.push(srcRunning
    ? `<button onclick="stopRunBranch('${b.id}')" title="停止源码容器">停止</button>`
    : `<button disabled title="源码容器未运行">停止</button>`);
  groups.push(srcBtns.join(''));

  // ── Deploy mode (artifact) ──
  const depBtns = [];
  depBtns.push(!isBuilding
    ? `<button onclick="pullBranch('${b.id}')" title="拉取最新代码">拉取</button>`
    : `<button disabled title="正在构建中，请等待完成">拉取</button>`);
  const canDeploy = ['idle', 'error', 'built', 'stopped'].includes(b.status) || (depRunning && !isActive);
  depBtns.push(canDeploy
    ? `<button class="primary" onclick="deployBranch('${b.id}')">${depRunning ? '激活' : '部署'}</button>`
    : `<button class="primary" disabled title="${isBuilding ? '正在构建中' : isActive ? '当前分支已激活' : '请先拉取或构建'}">部署</button>`);
  depBtns.push(depRunning
    ? `<button onclick="stopBranch('${b.id}')" title="停止部署容器">停止</button>`
    : `<button disabled title="部署容器未运行">停止</button>`);
  groups.push(depBtns.join(''));

  // ── Database ──
  const dbBtns = [];
  dbBtns.push(!isMainDb
    ? `<button onclick="cloneDb('${b.id}')" title="将主库数据克隆到分支库">克隆主库</button>`
    : `<button disabled title="已在使用主库">克隆主库</button>`);
  dbBtns.push(!isMainDb
    ? `<button onclick="useMainDb('${b.id}')" title="切换到主库（共享数据）">用主库</button>`
    : `<button disabled title="已在使用主库">用主库</button>`);
  if (b.originalDbName) {
    dbBtns.push(isMainDb
      ? `<button onclick="useOwnDb('${b.id}')" title="切换回独立数据库">用独立库</button>`
      : `<button disabled title="已在使用独立库">用独立库</button>`);
  }
  groups.push(dbBtns.join(''));

  // ── Management ──
  const mgmtBtns = [];
  mgmtBtns.push(`<button onclick="viewLogs('${b.id}')" title="查看操作历史日志">日志</button>`);
  mgmtBtns.push(hasError
    ? `<button class="warn" onclick="resetBranch('${b.id}')" title="重置错误状态">重置</button>`
    : `<button disabled title="无异常状态需要重置">重置</button>`);
  mgmtBtns.push(!isActive
    ? `<button class="danger" onclick="removeBranch('${b.id}')">删除</button>`
    : `<button class="danger" disabled title="当前激活的分支不能删除">删除</button>`);
  groups.push(mgmtBtns.join(''));

  return groups.join('<span class="action-divider">|</span>');
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
    // Build port info line
    let portInfo = '';
    if (b.runStatus === 'running' && b.hostPort) {
      portInfo = `<span class="port-badge run-port" title="源码运行端口">:${b.hostPort} → API (源码)</span>`;
    } else if (b.hostPort) {
      portInfo = `<span class="port-badge port-idle" title="已分配端口（未运行）">:${b.hostPort} (已分配)</span>`;
    }
    if (a) {
      portInfo += `<span class="port-badge deploy-port" title="部署网关端口">:5500 → 网关 (部署)</span>`;
    }

    // Activate button (show when branch has a running container but is not the active one)
    const canActivate = !a && (b.status === 'running' || b.runStatus === 'running');
    const activateHtml = canActivate
      ? `<button class="activate-inline" onclick="activateBranch('${b.id}')" title="切换 Nginx 网关指向此分支">切换到此分支</button>`
      : '';

    // Error message
    let errorHtml = '';
    if (b.status === 'error' && b.errorMessage) {
      errorHtml = `<div class="branch-error" title="${esc(b.errorMessage)}">部署异常: ${esc(b.errorMessage.slice(0, 120))}</div>`;
    }
    if (b.runStatus === 'error' && b.runErrorMessage) {
      errorHtml += `<div class="branch-error" title="${esc(b.runErrorMessage)}">运行异常: ${esc(b.runErrorMessage.slice(0, 120))}</div>`;
    }

    // Status line: deploy status + run status
    const deployStatus = statusLabel(b.status);
    const runStatus = b.runStatus ? ` · 运行: ${runStatusLabel(b.runStatus)}` : '';

    // Time info
    const timeInfo = [];
    if (b.createdAt) timeInfo.push(`添加于 ${relativeTime(b.createdAt)}`);
    if (b.lastActivatedAt) timeInfo.push(`激活于 ${relativeTime(b.lastActivatedAt)}`);
    const timeLine = timeInfo.length ? timeInfo.join(' · ') : '';

    return `
    <div class="branch-card ${a ? 'active' : ''} ${b.status === 'error' || b.runStatus === 'error' ? 'has-error' : ''}">
      <div class="branch-card-header">
        <div class="branch-card-left">
          <div class="status-dot ${b.status}"></div>
          <div class="branch-info">
            <div class="branch-name">${esc(b.branch)} ${a ? '<span class="active-badge">当前激活</span>' : ''}</div>
            <div class="branch-meta">部署: ${deployStatus}${runStatus} · DB: <span class="${b.originalDbName ? 'db-shared' : ''}" title="${b.originalDbName ? '正在使用主库（原始库: ' + esc(b.originalDbName) + '）' : ''}">${b.dbName}${b.originalDbName ? ' (主库)' : ''}</span></div>
            ${timeLine ? `<div class="branch-time">${timeLine}</div>` : ''}
            ${portInfo ? `<div class="branch-ports">${portInfo}</div>` : ''}
            ${errorHtml}
          </div>
        </div>
        ${activateHtml}
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
  const entries = Object.values(branches);

  let html = '<option value="">未指向任何分支</option>';
  if (activeBranchId) {
    html += '<option value="__disconnect__">断开网关</option>';
  }
  entries.forEach((b) => {
    const isRunning = b.status === 'running' || b.runStatus === 'running';
    const mode = b.status === 'running' ? '制品' : b.runStatus === 'running' ? '源码' : '';
    const tag = isRunning ? ` (${mode})` : ` [${statusLabel(b.status)}]`;
    const selected = b.id === activeBranchId ? 'selected' : '';
    html += `<option value="${b.id}" ${selected}>${b.branch}${tag}</option>`;
  });
  sel.innerHTML = html;
  sel.disabled = !entries.length;
  const active = activeBranchId && branches[activeBranchId];
  if (active) {
    link.classList.remove('hidden');
    link.href = `http://${location.hostname}:5500`;
    sel.classList.remove('gateway-none');
    sel.classList.add('gateway-active');
  } else {
    link.classList.add('hidden');
    sel.classList.remove('gateway-active');
    sel.classList.add('gateway-none');
  }
}

// ---- Branch picker (combobox dropdown) ----

const BRANCH_ICON = `<svg class="branch-icon" viewBox="0 0 16 16" fill="currentColor"><path d="M9.5 3.25a2.25 2.25 0 1 1 3 2.122V6A2.5 2.5 0 0 1 10 8.5H6a1 1 0 0 0-1 1v1.128a2.251 2.251 0 1 1-1.5 0V5.372a2.25 2.25 0 1 1 1.5 0v1.836A2.493 2.493 0 0 1 6 7h4a1 1 0 0 0 1-1v-.628A2.25 2.25 0 0 1 9.5 3.25Zm-6 0a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Zm8.25-.75a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5ZM4.25 12a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Z"/></svg>`;

let remoteBranches = []; // cached from server
let mainDbName = 'prdagent'; // updated from API

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
    if (bd.mainDbName) mainDbName = bd.mainDbName;
    renderBranches(bd.branches, bd.activeBranchId);
    renderHistory(hd.history);
    renderActiveSwitcher(bd.branches, bd.activeBranchId);
  } catch (err) { showToast(err.message, 'error'); }
}

// ============================================================
// Operation Log Modal (shared for deploy / run / log viewing)
// ============================================================

let currentLogModalBranchId = null;
let activeSSEBranchId = null; // branch with ongoing SSE stream

function openLogModal(title) {
  document.getElementById('logModalTitle').textContent = title;
  document.getElementById('logModalBody').innerHTML = '';
  document.getElementById('logModal').classList.remove('hidden');
}

function showLogModal() {
  // Re-show without clearing content
  document.getElementById('logModal').classList.remove('hidden');
}

function closeLogModal() {
  document.getElementById('logModal').classList.add('hidden');
  // Keep currentLogModalBranchId so we can reopen during active SSE
}

const STEP_ICONS = { running: '<span class="loading"></span>', done: '✅', skip: '⏭️', warn: '⚠️', error: '❌' };

function appendLogEvent(data) {
  const body = document.getElementById('logModalBody');

  // ---- env info block ----
  if (data.step === 'env') {
    const d = data.detail;
    const mode = d.mode || 'deploy';
    const modeLabel = mode === 'source' ? '源码运行' : '制品部署';
    let rows = `<tr><td>模式</td><td><code>${esc(modeLabel)}</code></td></tr>`;
    rows += `<tr><td>Commit</td><td><code>${esc(d.commitLog || '')}</code></td></tr>`;

    if (mode === 'source') {
      rows += `<tr><td>容器</td><td><code>${esc(d.runContainerName || '')}</code></td></tr>`;
      rows += `<tr><td>端口</td><td><code>${d.hostPort || '?'} → API :8080</code></td></tr>`;
      rows += `<tr><td>基础镜像</td><td><code>${esc(d.baseImage || '')}</code></td></tr>`;
      rows += `<tr><td>源码目录</td><td><code>${esc(d.sourceDir || '')}</code></td></tr>`;
      rows += `<tr><td>访问地址</td><td><a href="${esc(d.url || '')}" target="_blank"><code>${esc(d.url || '')}</code></a></td></tr>`;
    } else {
      if (d.worktreePath) rows += `<tr><td>Worktree</td><td><code>${esc(d.worktreePath)}</code></td></tr>`;
      if (d.containerName) rows += `<tr><td>容器</td><td><code>${esc(d.containerName)}</code></td></tr>`;
      if (d.imageName) rows += `<tr><td>镜像</td><td><code>${esc(d.imageName)}</code></td></tr>`;
      if (d.dbName) rows += `<tr><td>数据库</td><td><code>${esc(d.dbName)}</code></td></tr>`;
      if (d.network) rows += `<tr><td>Docker 网络</td><td><code>${esc(d.network)}</code></td></tr>`;
      if (d.gatewayPort) rows += `<tr><td>网关端口</td><td><code>${d.gatewayPort}</code></td></tr>`;
    }

    body.insertAdjacentHTML('beforeend', `
      <div class="deploy-env">
        <table class="deploy-env-table">${rows}</table>
      </div>`);
    return;
  }

  // ---- complete ----
  if (data.step === 'complete') {
    const url = data.detail?.url;
    body.insertAdjacentHTML('beforeend',
      `<div class="deploy-complete">✅ ${url ? `完成 — <a href="${esc(url)}" target="_blank">${esc(url)}</a>` : '操作完成'}</div>`);
    return;
  }

  // ---- fatal error — also mark any running steps as failed ----
  if (data.step === 'error') {
    body.querySelectorAll('.deploy-step.is-running').forEach((el) => {
      el.className = 'deploy-step is-error';
      const hdr = el.querySelector('.deploy-step-hdr');
      if (hdr) {
        // Get title text from the non-loading span (skip spinner span)
        const titleSpan = hdr.querySelector('span:not(.loading)');
        const titleText = titleSpan ? titleSpan.textContent : '';
        hdr.innerHTML = `${STEP_ICONS.error} <span>${esc(titleText)}</span>`;
      }
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

    // Pull diff detail
    if (data.detail && data.step === 'pull') {
      const d = data.detail;
      el.insertAdjacentHTML('beforeend', `<div class="deploy-detail">
        ${d.before} → ${d.after}
        ${d.newCommits ? `<pre class="deploy-log">${esc(d.newCommits)}</pre>` : ''}
        ${d.changes ? `<details class="deploy-log-wrap"><summary>文件变更</summary><pre class="deploy-log">${esc(d.changes)}</pre></details>` : ''}
      </div>`);
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

    // Start container detail (run mode)
    if (data.detail && data.step === 'start') {
      const d = data.detail;
      if (d.url) {
        el.insertAdjacentHTML('beforeend',
          `<div class="deploy-detail">容器: <code>${esc(d.runContainerName || d.containerName)}</code> · 端口: <code>${d.hostPort || ''}</code> · <a href="${esc(d.url)}" target="_blank">${esc(d.url)}</a></div>`);
      } else if (d.containerName) {
        el.insertAdjacentHTML('beforeend',
          `<div class="deploy-detail">容器: <code>${esc(d.containerName)}</code> · 网络: <code>${esc(d.network)}</code></div>`);
      }
    }
  }

  body.scrollTop = body.scrollHeight;
}

// ---- SSE consumer helper ----
async function consumeSSE(url, { onEvent, onError, onDone }) {
  const response = await fetch(url, {
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
        try { onEvent(JSON.parse(line.slice(6))); } catch { /* skip bad json */ }
      }
    }
  }

  if (onDone) onDone();
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
    if (data.updated) {
      showToast(`${id} 已更新: ${data.before} → ${data.after}`, 'success');
    } else {
      showToast(`${id} 已是最新 (${data.after})`, 'info');
    }
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

  currentLogModalBranchId = id;
  activeSSEBranchId = id;
  openLogModal(`部署日志 — ${branchName}`);

  try {
    await consumeSSE(`${API}/branches/${id}/deploy`, {
      onEvent: appendLogEvent,
    });
    showToast(`${branchName} 部署完成`, 'success');
  } catch (err) {
    appendLogEvent({ step: 'error', status: 'error', title: '连接失败', log: err.message });
    showToast(`部署失败: ${err.message}`, 'error');
  } finally {
    activeSSEBranchId = null;
    setBusy(false);
  }
}

async function runBranch(id) {
  if (busy) return;
  setBusy(true);

  let branchName = id;
  try {
    const bd = await api('GET', '/branches');
    branchName = bd.branches[id]?.branch || id;
  } catch { /* use id */ }

  currentLogModalBranchId = id;
  activeSSEBranchId = id;
  openLogModal(`运行日志 — ${branchName}`);

  try {
    await consumeSSE(`${API}/branches/${id}/run`, {
      onEvent: appendLogEvent,
    });
    showToast(`${branchName} 运行已启动`, 'success');
  } catch (err) {
    appendLogEvent({ step: 'error', status: 'error', title: '连接失败', log: err.message });
    showToast(`运行失败: ${err.message}`, 'error');
  } finally {
    activeSSEBranchId = null;
    setBusy(false);
  }
}

async function rerunBranch(id) {
  if (busy) return;
  setBusy(true);

  let branchName = id;
  try {
    const bd = await api('GET', '/branches');
    branchName = bd.branches[id]?.branch || id;
  } catch { /* use id */ }

  currentLogModalBranchId = id;
  activeSSEBranchId = id;
  openLogModal(`重运行日志 — ${branchName}`);

  try {
    await consumeSSE(`${API}/branches/${id}/rerun`, {
      onEvent: appendLogEvent,
    });
    showToast(`${branchName} 重运行完成`, 'success');
  } catch (err) {
    appendLogEvent({ step: 'error', status: 'error', title: '连接失败', log: err.message });
    showToast(`重运行失败: ${err.message}`, 'error');
  } finally {
    activeSSEBranchId = null;
    setBusy(false);
  }
}

async function stopRunBranch(id) {
  if (busy) return;
  setBusy(true);
  try {
    await api('POST', `/branches/${id}/stop-run`);
    showToast(`${id} 源码运行已停止`, 'success');
  } catch (err) { showToast(err.message, 'error'); }
  finally { setBusy(false); }
}

async function stopBranch(id) {
  if (busy) return;
  setBusy(true);
  try {
    await api('POST', `/branches/${id}/stop`);
    showToast(`${id} 部署容器已停止`, 'success');
  } catch (err) { showToast(err.message, 'error'); }
  finally { setBusy(false); }
}

async function resetBranch(id) {
  if (!confirm(`重置 ${id} 的状态？将停止所有容器并恢复到初始状态。`)) return;
  if (busy) return;
  setBusy(true);
  try {
    await api('POST', `/branches/${id}/reset`);
    showToast(`${id} 状态已重置`, 'success');
  } catch (err) { showToast(`重置失败: ${err.message}`, 'error'); }
  finally { setBusy(false); }
}

async function viewLogs(id) {
  // If an SSE stream is active for this branch, just re-show the modal
  if (activeSSEBranchId === id && currentLogModalBranchId === id) {
    showLogModal();
    return;
  }

  let branchName = id;
  try {
    const bd = await api('GET', '/branches');
    branchName = bd.branches[id]?.branch || id;
  } catch { /* use id */ }

  currentLogModalBranchId = id;
  openLogModal(`操作历史 — ${branchName}`);
  const body = document.getElementById('logModalBody');

  try {
    const data = await api('GET', `/branches/${id}/logs`);
    const logs = data.logs || [];

    if (!logs.length) {
      body.innerHTML = '<div class="empty-state">暂无操作日志</div>';
      return;
    }

    // Render logs (most recent first)
    body.innerHTML = logs.slice().reverse().map((log, i) => {
      const typeLabel = { deploy: '部署', run: '运行', rerun: '重运行' }[log.type] || log.type;
      const statusIcon = { completed: '✅', error: '❌', running: '<span class="loading"></span>' }[log.status] || '';
      const time = log.startedAt ? new Date(log.startedAt).toLocaleString() : '';
      const duration = (log.startedAt && log.finishedAt)
        ? `${Math.round((new Date(log.finishedAt) - new Date(log.startedAt)) / 1000)}s`
        : '';

      // Render events summary
      const eventsHtml = log.events.map(ev => {
        const icon = STEP_ICONS[ev.status] || '';
        return `<div class="log-event-line">${icon} ${esc(ev.title || ev.step)}${ev.log ? ` — ${esc(ev.log.slice(0, 200))}` : ''}</div>`;
      }).join('');

      return `
        <details class="log-entry ${log.status}" ${i === 0 ? 'open' : ''}>
          <summary class="log-entry-header">
            ${statusIcon} <strong>${typeLabel}</strong>
            <span class="log-entry-time">${time}</span>
            ${duration ? `<span class="log-entry-duration">${duration}</span>` : ''}
          </summary>
          <div class="log-entry-events">${eventsHtml}</div>
        </details>`;
    }).join('');
  } catch (err) {
    body.innerHTML = `<div class="deploy-step is-error"><div class="deploy-step-hdr">${STEP_ICONS.error} <span>加载日志失败: ${esc(err.message)}</span></div></div>`;
  }
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

// ---- Database management ----

async function cloneDb(id) {
  if (!confirm(`将主库数据克隆到 ${id} 的分支库？\n（会覆盖分支库现有数据）`)) return;
  if (busy) return;
  setBusy(true);
  showToast('正在克隆数据库...', 'info');
  try {
    const data = await api('POST', `/branches/${id}/db/clone`);
    showToast(data.message, 'success');
  } catch (err) { showToast(err.message, 'error'); }
  finally { setBusy(false); }
}

async function useMainDb(id) {
  if (!confirm(`将 ${id} 切换到主库？\n（共享主库数据，需要重启容器生效）`)) return;
  if (busy) return;
  setBusy(true);
  try {
    const data = await api('POST', `/branches/${id}/db/use-main`);
    showToast(data.message, 'success');
  } catch (err) { showToast(err.message, 'error'); }
  finally { setBusy(false); }
}

async function useOwnDb(id) {
  if (!confirm(`将 ${id} 切换回独立数据库？\n（需要重启容器生效）`)) return;
  if (busy) return;
  setBusy(true);
  try {
    const data = await api('POST', `/branches/${id}/db/use-own`);
    showToast(data.message, 'success');
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

async function activateBranch(id) {
  if (busy) return;
  setBusy(true);
  showToast(`正在切换到 ${id}...`, 'info');
  try {
    await api('POST', `/branches/${id}/activate`);
    showToast(`已切换到 ${id}`, 'success');
  } catch (err) { showToast(err.message, 'error'); }
  finally { setBusy(false); }
}

// Top switcher
document.getElementById('activeSwitcher').addEventListener('change', async (e) => {
  const id = e.target.value;
  if (!id || busy) return;
  setBusy(true);
  try {
    if (id === '__disconnect__') {
      showToast('正在断开网关...', 'info');
      await api('POST', '/gateway/disconnect');
      showToast('网关已断开', 'success');
    } else {
      showToast(`正在切换到 ${id}...`, 'info');
      await api('POST', `/branches/${id}/activate`);
      showToast(`已切换到 ${id}`, 'success');
    }
  } catch (err) { showToast(err.message, 'error'); }
  finally { setBusy(false); }
});

// Init
loadRemoteBranches();
refresh();
