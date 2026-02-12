const API = '/api';

// Global lock — prevents all button clicks while any async operation is running
let busy = false;

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
  setTimeout(() => (el.className = 'toast hidden'), 3000);
}

function statusLabel(s) {
  const map = {
    running: '运行中',
    building: '构建中',
    built: '已构建',
    idle: '待构建',
    stopped: '已停止',
    error: '异常',
  };
  return map[s] || s;
}

function relativeTime(isoDate) {
  if (!isoDate) return '';
  const now = Date.now();
  const then = new Date(isoDate).getTime();
  const diff = Math.max(0, now - then);
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} 天前`;
  const months = Math.floor(days / 30);
  return `${months} 个月前`;
}

// Escape HTML to prevent XSS in commit messages / author names
function esc(str) {
  const d = document.createElement('div');
  d.textContent = str || '';
  return d.innerHTML;
}

function setBusy(isBusy) {
  busy = isBusy;
  document.querySelectorAll('button').forEach((btn) => {
    btn.disabled = isBusy;
  });
  if (!isBusy) refresh(); // re-render so buttons get correct enabled/disabled state
}

// ---- Branch card (tracked branches) ----

function branchActions(b, isActive) {
  const btns = [];

  // Pull latest code: available when not building
  if (b.status !== 'building') {
    btns.push(`<button onclick="pullBranch('${b.id}')">拉取代码</button>`);
  }

  // One-click deploy: available when idle, error, built, stopped — NOT when building or already active+running
  if (['idle', 'error', 'built', 'stopped'].includes(b.status) || (b.status === 'running' && !isActive)) {
    btns.push(
      `<button class="primary" onclick="deployBranch('${b.id}')">` +
        `${b.status === 'running' ? '激活' : '一键部署'}` +
        `</button>`,
    );
  }

  if (b.status === 'running') {
    btns.push(`<button onclick="stopBranch('${b.id}')">停止</button>`);
  }

  if (!isActive) {
    btns.push(`<button class="danger" onclick="removeBranch('${b.id}')">删除</button>`);
  }

  return btns.join('');
}

function renderBranches(branches, activeBranchId) {
  const list = document.getElementById('branchList');
  const entries = Object.values(branches);

  if (entries.length === 0) {
    list.innerHTML = '<div class="empty-state">暂无分支，请从远程分支列表添加</div>';
    return;
  }

  list.innerHTML = entries
    .map((b) => {
      const isActive = b.id === activeBranchId;
      return `
      <div class="branch-card ${isActive ? 'active' : ''}">
        <div class="status-dot ${b.status}"></div>
        <div class="branch-info">
          <div class="branch-name">${esc(b.branch)} ${isActive ? '(当前激活)' : ''}</div>
          <div class="branch-meta">${statusLabel(b.status)} · DB: ${b.dbName}</div>
        </div>
        <div class="branch-actions">
          ${branchActions(b, isActive)}
        </div>
      </div>
    `;
    })
    .join('');
}

function renderHistory(history) {
  const el = document.getElementById('historyList');
  const btn = document.getElementById('rollbackBtn');
  if (history.length === 0) {
    el.textContent = '暂无切换记录';
    btn.disabled = true;
  } else {
    el.textContent = history.join(' → ');
    btn.disabled = history.length <= 1;
  }
}

function renderActiveSwitcher(branches, activeBranchId) {
  const sel = document.getElementById('activeSwitcher');
  const link = document.getElementById('activeLink');
  const entries = Object.values(branches).filter((b) => b.status === 'running');

  let html = '<option value="">无</option>';
  entries.forEach((b) => {
    const selected = b.id === activeBranchId ? 'selected' : '';
    html += `<option value="${b.id}" ${selected}>${b.branch}</option>`;
  });
  sel.innerHTML = html;
  sel.disabled = entries.length === 0;

  if (activeBranchId && branches[activeBranchId]) {
    link.classList.remove('hidden');
    link.href = `http://${location.hostname}:5500`;
  } else {
    link.classList.add('hidden');
  }
}

// ---- Remote branch list (rich display) ----

const BRANCH_ICON = `<svg class="branch-icon" viewBox="0 0 16 16" fill="currentColor"><path d="M9.5 3.25a2.25 2.25 0 1 1 3 2.122V6A2.5 2.5 0 0 1 10 8.5H6a1 1 0 0 0-1 1v1.128a2.251 2.251 0 1 1-1.5 0V5.372a2.25 2.25 0 1 1 1.5 0v1.836A2.493 2.493 0 0 1 6 7h4a1 1 0 0 0 1-1v-.628A2.25 2.25 0 0 1 9.5 3.25Zm-6 0a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Zm8.25-.75a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5ZM4.25 12a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Z"/></svg>`;

function renderRemoteBranches(branches) {
  const list = document.getElementById('remoteBranchList');

  if (branches.length === 0) {
    list.innerHTML = '<div class="empty-state">所有远程分支已添加</div>';
    return;
  }

  list.innerHTML = branches
    .map(
      (b) => `
      <div class="remote-branch-item">
        <div class="remote-branch-main">
          <div class="remote-branch-row1">
            ${BRANCH_ICON}
            <span class="remote-branch-name">${esc(b.name)}</span>
            <span class="remote-branch-time">${relativeTime(b.date)}</span>
          </div>
          <div class="remote-branch-row2">
            ${esc(b.author)} · ${esc(b.message)}
          </div>
        </div>
        <button class="primary" onclick="addBranch('${esc(b.name)}')">添加</button>
      </div>`,
    )
    .join('');
}

async function loadRemoteBranches() {
  const list = document.getElementById('remoteBranchList');
  const btn = document.getElementById('refreshRemoteBtn');
  try {
    list.innerHTML = '<div class="empty-state"><span class="loading"></span> 正在获取远程分支...</div>';
    btn.disabled = true;

    const data = await api('GET', '/remote-branches');
    renderRemoteBranches(data.branches);
  } catch (err) {
    list.innerHTML = '<div class="empty-state">加载失败</div>';
    showToast('加载远程分支失败: ' + err.message, 'error');
  } finally {
    btn.disabled = false;
  }
}

async function refresh() {
  try {
    const [branchData, historyData] = await Promise.all([
      api('GET', '/branches'),
      api('GET', '/history'),
    ]);

    renderBranches(branchData.branches, branchData.activeBranchId);
    renderHistory(historyData.history);
    renderActiveSwitcher(branchData.branches, branchData.activeBranchId);
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// --- User actions ---

async function addBranch(branchName) {
  if (!branchName || busy) return;
  setBusy(true);
  try {
    await api('POST', '/branches', { branch: branchName });
    showToast(`分支 ${branchName} 已添加`, 'success');
    await loadRemoteBranches();
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    setBusy(false);
  }
}

async function pullBranch(id) {
  if (busy) return;
  setBusy(true);
  showToast(`正在拉取 ${id} 最新代码...`, 'info');
  try {
    const data = await api('POST', `/branches/${id}/pull`);
    showToast(`${id} 已更新: ${data.head}`, 'success');
  } catch (err) {
    showToast(`拉取失败: ${err.message}`, 'error');
  } finally {
    setBusy(false);
  }
}

async function deployBranch(id) {
  if (busy) return;
  setBusy(true);
  showToast(`正在部署 ${id}...（构建+启动+激活）`, 'info');
  try {
    const data = await api('POST', `/branches/${id}/deploy`);
    showToast(`${id} 已部署并激活`, 'success');
  } catch (err) {
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
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    setBusy(false);
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
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    setBusy(false);
  }
}

async function doRollback() {
  if (busy) return;
  setBusy(true);
  showToast('正在回滚...', 'info');
  try {
    const data = await api('POST', '/rollback');
    showToast(`已回滚到 ${data.activeBranchId}`, 'success');
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    setBusy(false);
  }
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
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    setBusy(false);
  }
});

// Init
loadRemoteBranches();
refresh();
setInterval(refresh, 5000);
