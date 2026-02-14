const API = '/api';
let busy = false;

// ---- Utilities ----

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
  // Success/info toasts: longer by default so user can read them
  const ms = duration ?? (type === 'success' ? 6000 : type === 'error' ? 8000 : 4000);
  toastTimer = setTimeout(() => { el.className = 'toast hidden'; toastTimer = null; }, ms);
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

  // ── Source mode (run/rerun merged into one button) ──
  const srcBtns = [];
  if (srcRunning) {
    srcBtns.push(`<button class="run-active" onclick="rerunBranch('${b.id}')" title="拉取最新代码并重新运行">重运行</button>`);
  } else {
    srcBtns.push(`<button class="run" onclick="runBranch('${b.id}')" title="挂载源码运行 (dotnet run)">运行</button>`);
  }
  groups.push(srcBtns.join(''));

  // ── Deploy mode (deploy/stop merged into one button) ──
  const depBtns = [];
  depBtns.push(!isBuilding
    ? `<button onclick="pullBranch('${b.id}')" title="拉取最新代码">拉取</button>`
    : `<button disabled title="正在构建中，请等待完成">拉取</button>`);
  if (depRunning) {
    depBtns.push(isActive
      ? `<button class="primary" disabled title="当前激活的部署不能停止">停止</button>`
      : `<button onclick="stopBranch('${b.id}')" title="停止部署容器">停止</button>`);
  } else {
    const canDeploy = ['idle', 'error', 'built', 'stopped'].includes(b.status) && !isBuilding;
    depBtns.push(canDeploy
      ? `<button class="primary" onclick="deployBranch('${b.id}')">部署</button>`
      : `<button class="primary" disabled title="${isBuilding ? '正在构建中' : '请先拉取或构建'}">部署</button>`);
  }
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
  mgmtBtns.push(`<button onclick="viewLogs('${b.id}')" title="查看日志">日志</button>`);
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
    const depRunning = b.status === 'running';
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

    // Activate button: always visible for non-active branches (auto-runs if needed)
    const activateHtml = !a
      ? `<button class="activate-inline" onclick="switchToBranch('${b.id}')" title="切换到此分支（未运行则自动启动）">切换到此分支</button>`
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

    // Deployed (artifact running) branches get a special visual treatment
    const deployedClass = depRunning ? 'deployed' : '';

    return `
    <div class="branch-card ${a ? 'active' : ''} ${deployedClass} ${b.status === 'error' || b.runStatus === 'error' ? 'has-error' : ''}">
      <div class="branch-card-header">
        <div class="branch-card-left">
          <div class="status-dot ${b.status}"></div>
          <div class="branch-info">
            <div class="branch-name">
              ${depRunning ? '<span class="deploy-icon" title="制品部署运行中">📦</span> ' : ''}${esc(b.branch)} ${a ? '<span class="active-badge">当前激活</span>' : ''}
            </div>
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

// ============================================================
// Operation History — Visual Timeline
// ============================================================

function renderHistory(history, branches) {
  const el = document.getElementById('historyList');
  const btn = document.getElementById('rollbackBtn');

  if (!history.length) {
    el.innerHTML = '<div class="timeline-empty">暂无切换记录</div>';
    btn.disabled = true;
    return;
  }

  btn.disabled = history.length <= 1;

  // Deduplicate consecutive entries for cleaner display, keep last N
  const displayHistory = history.slice(-10);
  const currentId = displayHistory[displayHistory.length - 1];
  const rollbackTarget = displayHistory.length > 1 ? displayHistory[displayHistory.length - 2] : null;

  el.innerHTML = `<div class="timeline">` +
    displayHistory.map((id, i) => {
      const isCurrent = i === displayHistory.length - 1;
      const isRollbackTarget = rollbackTarget && i === displayHistory.length - 2;
      const branchName = branches?.[id]?.branch || id;
      const nodeClass = isCurrent ? 'timeline-node current' : isRollbackTarget ? 'timeline-node rollback-target' : 'timeline-node';
      const label = isCurrent ? '当前' : isRollbackTarget ? '回滚目标 ↩' : '';
      return `
        <div class="${nodeClass}">
          <div class="timeline-dot"></div>
          <div class="timeline-content">
            <span class="timeline-branch">${esc(branchName)}</span>
            ${label ? `<span class="timeline-label">${label}</span>` : ''}
          </div>
          ${i < displayHistory.length - 1 ? '<div class="timeline-line"></div>' : ''}
        </div>`;
    }).join('') +
    `</div>`;
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

// Update cleanup button state based on branches
function updateCleanupBtn(branches, activeBranchId) {
  const btn = document.getElementById('cleanupBtn');
  if (!btn) return;
  const nonActive = Object.values(branches).filter((b) => b.id !== activeBranchId);
  btn.disabled = !nonActive.length;
  btn.title = nonActive.length
    ? `清理 ${nonActive.length} 个非活跃分支（含容器、镜像、数据库）`
    : '没有可清理的分支';
}

// ---- Branch picker (combobox dropdown) ----

const BRANCH_ICON = `<svg class="branch-icon" viewBox="0 0 16 16" fill="currentColor"><path d="M9.5 3.25a2.25 2.25 0 1 1 3 2.122V6A2.5 2.5 0 0 1 10 8.5H6a1 1 0 0 0-1 1v1.128a2.251 2.251 0 1 1-1.5 0V5.372a2.25 2.25 0 1 1 1.5 0v1.836A2.493 2.493 0 0 1 6 7h4a1 1 0 0 0 1-1v-.628A2.25 2.25 0 0 1 9.5 3.25Zm-6 0a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Zm8.25-.75a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5ZM4.25 12a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Z"/></svg>`;

let remoteBranches = []; // cached from server
let mainDbName = 'prdagent'; // updated from API
let lastBranches = {}; // cached branch data for history rendering

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
    lastBranches = bd.branches;
    renderBranches(bd.branches, bd.activeBranchId);
    renderHistory(hd.history, bd.branches);
    renderActiveSwitcher(bd.branches, bd.activeBranchId);
    updateCleanupBtn(bd.branches, bd.activeBranchId);
  } catch (err) { showToast(err.message, 'error'); }
}

// ============================================================
// Operation Log Modal (shared for deploy / run / log viewing)
// ============================================================

let currentLogModalBranchId = null;
let activeSSEBranchId = null; // branch with ongoing SSE stream
let liveLogAbort = null; // AbortController for live log streaming
let currentLogTab = 'live'; // 'live' or 'history'

function openLogModal(title) {
  document.getElementById('logModalTitle').textContent = title;
  document.getElementById('logModalBody').innerHTML = '';
  document.getElementById('logModal').classList.remove('hidden');
  // Hide tabs when opening for SSE operations (deploy/run)
  document.getElementById('logTabs').classList.add('hidden');
}

function showLogModal() {
  // Re-show without clearing content
  document.getElementById('logModal').classList.remove('hidden');
}

function closeLogModal() {
  document.getElementById('logModal').classList.add('hidden');
  stopLiveLog();
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
    const title = data.title || '';
    body.insertAdjacentHTML('beforeend',
      `<div class="deploy-complete">✅ ${url ? `完成 — <a href="${esc(url)}" target="_blank">${esc(url)}</a>` : esc(title) || '操作完成'}</div>`);
    return;
  }

  // ---- fatal error — also mark any running steps as failed ----
  if (data.step === 'error') {
    body.querySelectorAll('.deploy-step.is-running').forEach((el) => {
      el.className = 'deploy-step is-error';
      const hdr = el.querySelector('.deploy-step-hdr');
      if (hdr) {
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
      const progressBar = (data.total != null)
        ? `<div class="step-progress"><div class="step-progress-bar" style="width:${Math.round(((data.progress || 0) / data.total) * 100)}%"></div></div>`
        : '';
      body.insertAdjacentHTML('beforeend', `
        <div class="deploy-step is-running" id="ds-${data.step}">
          <div class="deploy-step-hdr">${STEP_ICONS.running} <span>${esc(data.title)}</span></div>
          ${progressBar}
          <pre class="deploy-stream-log"></pre>
        </div>`);
    } else {
      // Update title and progress
      const hdr = el.querySelector('.deploy-step-hdr span');
      if (hdr) hdr.textContent = data.title;
      if (data.total != null) {
        let pb = el.querySelector('.step-progress-bar');
        if (pb) pb.style.width = `${Math.round(((data.progress || 0) / data.total) * 100)}%`;
      }
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

    // Hide progress bar on completion
    const pb = el.querySelector('.step-progress');
    if (pb) pb.style.display = 'none';

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
      if (d.nginxConf) {
        el.insertAdjacentHTML('beforeend',
          `<details class="deploy-log-wrap"><summary>查看 Nginx 配置</summary><pre class="deploy-log">${esc(d.nginxConf || '')}</pre></details>`);
      }
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
async function consumeSSE(url, { method, onEvent, onError, onDone }) {
  const response = await fetch(url, {
    method: method || 'POST',
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

// ============================================================
// Live container log streaming
// ============================================================

function stopLiveLog() {
  if (liveLogAbort) {
    liveLogAbort.abort();
    liveLogAbort = null;
  }
}

async function startLiveLog(id) {
  stopLiveLog();
  liveLogAbort = new AbortController();

  const body = document.getElementById('logModalBody');
  body.innerHTML = `
    <div class="live-log-header">
      <span class="loading"></span> 正在连接容器日志...
    </div>
    <pre class="live-log-output" id="liveLogOutput"></pre>`;

  try {
    const response = await fetch(`${API}/branches/${id}/container-logs`, {
      method: 'POST',
      signal: liveLogAbort.signal,
    });

    if (!response.ok && !response.headers.get('content-type')?.includes('text/event-stream')) {
      const err = await response.json();
      body.innerHTML = `<div class="empty-state">${esc(err.error || '无法获取日志')}</div>`;
      return;
    }

    // Update header to connected
    const hdr = body.querySelector('.live-log-header');
    if (hdr) hdr.innerHTML = '<span class="live-dot"></span> 实时日志（自动刷新）';

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });

      const lines = buf.split('\n');
      buf = lines.pop();

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          try {
            const data = JSON.parse(line.slice(6));
            if (data.type === 'log') {
              const el = document.getElementById('liveLogOutput');
              if (el) {
                el.textContent += data.text;
                el.scrollTop = el.scrollHeight;
              }
            } else if (data.type === 'end') {
              const hdr2 = body.querySelector('.live-log-header');
              if (hdr2) hdr2.innerHTML = '容器已停止';
            }
          } catch { /* skip */ }
        }
      }
    }
  } catch (err) {
    if (err.name === 'AbortError') return;
    const el = document.getElementById('liveLogOutput');
    if (el) el.textContent += `\n[连接断开: ${err.message}]`;
  }
}

async function loadLogHistory(id) {
  const body = document.getElementById('logModalBody');
  body.innerHTML = '<div class="empty-state"><span class="loading"></span> 加载中...</div>';

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

function switchLogTab(tab) {
  currentLogTab = tab;
  document.querySelectorAll('.log-tab').forEach(t =>
    t.classList.toggle('active', t.dataset.tab === tab));

  if (tab === 'live') {
    stopLiveLog();
    startLiveLog(currentLogModalBranchId);
  } else {
    stopLiveLog();
    loadLogHistory(currentLogModalBranchId);
  }
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
      showToast(`${id} 已是最新 (${data.after})`, 'success');
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
  let hasRunningContainer = false;
  try {
    const bd = await api('GET', '/branches');
    const b = bd.branches[id];
    branchName = b?.branch || id;
    hasRunningContainer = b?.status === 'running' || b?.runStatus === 'running';
  } catch { /* use id */ }

  currentLogModalBranchId = id;
  openLogModal(`日志 — ${branchName}`);

  // Show tabs
  const tabs = document.getElementById('logTabs');
  tabs.classList.remove('hidden');

  // Default to live logs if container is running, otherwise history
  if (hasRunningContainer) {
    currentLogTab = 'live';
    document.querySelectorAll('.log-tab').forEach(t =>
      t.classList.toggle('active', t.dataset.tab === 'live'));
    startLiveLog(id);
  } else {
    currentLogTab = 'history';
    document.querySelectorAll('.log-tab').forEach(t =>
      t.classList.toggle('active', t.dataset.tab === 'history'));
    loadLogHistory(id);
  }
}

// ---- Async delete with SSE progress (request 6) ----
async function removeBranch(id) {
  // Get branch info for better confirm message
  let branchName = id;
  let isDeploying = false;
  try {
    const bd = await api('GET', '/branches');
    const b = bd.branches[id];
    if (b) {
      branchName = b.branch;
      isDeploying = b.status === 'building';
    }
  } catch { /* ok */ }

  if (isDeploying) {
    if (!confirm(`⚠️ 分支 ${branchName} 正在构建中！\n确认强制删除？这会中断构建过程。\n\n将删除: 容器、Worktree、镜像、分支数据库`)) return;
  } else {
    if (!confirm(`确认删除分支 ${branchName}？\n将停止容器、删除 worktree、镜像和分支数据库。`)) return;
  }

  if (busy) return;
  setBusy(true);

  currentLogModalBranchId = id;
  openLogModal(`删除 — ${branchName}`);

  try {
    await consumeSSE(`${API}/branches/${id}`, {
      method: 'DELETE',
      onEvent: appendLogEvent,
    });
    showToast(`${branchName} 已删除`, 'success');
    await loadRemoteBranches();
  } catch (err) {
    appendLogEvent({ step: 'error', status: 'error', title: '删除失败', log: err.message });
    showToast(`删除失败: ${err.message}`, 'error');
  } finally {
    setBusy(false);
  }
}

// ---- switchToBranch: auto-run + activate ----

async function switchToBranch(id) {
  let bd;
  try { bd = await api('GET', '/branches'); } catch { return; }
  const b = bd.branches[id];
  if (!b) return;

  const isRunning = b.status === 'running' || b.runStatus === 'running';

  if (isRunning) {
    // Container already running, just activate nginx
    await activateBranch(id);
  } else {
    // Need to run first, then activate
    if (busy) return;
    setBusy(true);

    const branchName = b.branch || id;
    currentLogModalBranchId = id;
    activeSSEBranchId = id;
    openLogModal(`运行 + 切换 — ${branchName}`);

    try {
      // Step 1: Run from source (SSE)
      await consumeSSE(`${API}/branches/${id}/run`, {
        onEvent: appendLogEvent,
      });

      // Step 2: Activate nginx
      appendLogEvent({ step: 'activate', status: 'running', title: '切换 Nginx 网关' });
      try {
        const result = await api('POST', `/branches/${id}/activate`);
        appendLogEvent({
          step: 'activate', status: 'done', title: '切换 Nginx 网关',
          detail: { gateway: result.url },
        });
      } catch (err) {
        appendLogEvent({ step: 'activate', status: 'error', title: '切换 Nginx 网关', log: err.message });
        throw err;
      }

      showToast(`${branchName} 已运行并切换`, 'success');
    } catch (err) {
      if (!document.querySelector('#ds-activate')) {
        appendLogEvent({ step: 'error', status: 'error', title: '失败', log: err.message });
      }
      showToast(`切换失败: ${err.message}`, 'error');
    } finally {
      activeSSEBranchId = null;
      setBusy(false);
    }
  }
}

// ---- Database management ----

async function cloneDb(id) {
  if (!confirm(`将主库数据克隆到 ${id} 的分支库？\n（会覆盖分支库现有数据）`)) return;
  if (busy) return;
  setBusy(true);

  let branchName = id;
  try {
    const bd = await api('GET', '/branches');
    branchName = bd.branches[id]?.branch || id;
  } catch { /* ok */ }

  currentLogModalBranchId = id;
  openLogModal(`克隆数据库 — ${branchName}`);

  try {
    await consumeSSE(`${API}/branches/${id}/db/clone`, {
      onEvent: appendLogEvent,
    });
    showToast('数据库克隆完成', 'success');
  } catch (err) {
    appendLogEvent({ step: 'error', status: 'error', title: '克隆失败', log: err.message });
    showToast(`克隆失败: ${err.message}`, 'error');
  } finally {
    setBusy(false);
  }
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

// ---- One-click cleanup ----
async function cleanupAll() {
  const nonActive = Object.values(lastBranches).filter((b) => b.id !== document.getElementById('activeSwitcher').value);
  if (!nonActive.length) {
    showToast('没有需要清理的分支', 'info');
    return;
  }
  const names = nonActive.map(b => b.branch).join('\n  ');
  if (!confirm(`一键清理以下 ${nonActive.length} 个分支？\n  ${names}\n\n将删除: 容器、Worktree、镜像、分支数据库\n（当前激活分支不会被清理）`)) return;

  if (busy) return;
  setBusy(true);

  openLogModal(`一键清理 ${nonActive.length} 个分支`);

  try {
    await consumeSSE(`${API}/cleanup`, {
      onEvent: appendLogEvent,
    });
    showToast('清理完成', 'success');
    await loadRemoteBranches();
  } catch (err) {
    appendLogEvent({ step: 'error', status: 'error', title: '清理失败', log: err.message });
    showToast(`清理失败: ${err.message}`, 'error');
  } finally {
    setBusy(false);
  }
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
