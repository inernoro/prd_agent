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

function setBusy(isBusy) {
  busy = isBusy;
  document.querySelectorAll('button').forEach((btn) => {
    btn.disabled = isBusy;
  });
  if (!isBusy) refresh(); // re-render so buttons get correct enabled/disabled state
}

// Build the action buttons for each branch based on current state
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

  // Stop: only when running
  if (b.status === 'running') {
    btns.push(`<button onclick="stopBranch('${b.id}')">停止</button>`);
  }

  // Delete: never on active branch
  if (!isActive) {
    btns.push(`<button class="danger" onclick="removeBranch('${b.id}')">删除</button>`);
  }

  return btns.join('');
}

function renderBranches(branches, activeBranchId) {
  const list = document.getElementById('branchList');
  const entries = Object.values(branches);

  if (entries.length === 0) {
    list.innerHTML = '<div class="empty-state">暂无分支，请从下拉框选择添加</div>';
    return;
  }

  list.innerHTML = entries
    .map((b) => {
      const isActive = b.id === activeBranchId;
      return `
      <div class="branch-card ${isActive ? 'active' : ''}">
        <div class="status-dot ${b.status}"></div>
        <div class="branch-info">
          <div class="branch-name">${b.branch} ${isActive ? '(当前激活)' : ''}</div>
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

// Render the top-level active branch switcher dropdown
function renderActiveSwitcher(branches, activeBranchId) {
  const sel = document.getElementById('activeSwitcher');
  const link = document.getElementById('activeLink');
  const entries = Object.values(branches).filter((b) => b.status === 'running');

  // Build options
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

async function loadRemoteBranches() {
  const sel = document.getElementById('branchSelect');
  const addBtn = document.getElementById('addBtn');
  try {
    sel.innerHTML = '<option value="">加载中...</option>';
    addBtn.disabled = true;

    const data = await api('GET', '/remote-branches');
    if (data.branches.length === 0) {
      sel.innerHTML = '<option value="">无可用远程分支</option>';
      addBtn.disabled = true;
    } else {
      sel.innerHTML =
        '<option value="">选择分支...</option>' +
        data.branches.map((b) => `<option value="${b}">${b}</option>`).join('');
      addBtn.disabled = false;
    }
  } catch (err) {
    sel.innerHTML = '<option value="">加载失败</option>';
    addBtn.disabled = true;
    showToast('加载远程分支失败: ' + err.message, 'error');
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

async function addBranch() {
  const sel = document.getElementById('branchSelect');
  const branch = sel.value;
  if (!branch) return showToast('请先从下拉框选择分支', 'error');
  if (busy) return;

  setBusy(true);
  try {
    await api('POST', '/branches', { branch });
    showToast(`分支 ${branch} 已添加`, 'success');
    await loadRemoteBranches(); // refresh dropdown to remove the added branch
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
  showToast(`正在部署 ${id}...（拉取+构建+启动+激活）`, 'info');
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

// Top switcher: when user picks a different running branch from the dropdown
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

// Enable add button only when a branch is selected
document.getElementById('branchSelect').addEventListener('change', (e) => {
  document.getElementById('addBtn').disabled = !e.target.value;
});

// Init
loadRemoteBranches();
refresh();
setInterval(refresh, 5000);
setInterval(loadRemoteBranches, 30_000); // auto-refresh remote branches every 30s
