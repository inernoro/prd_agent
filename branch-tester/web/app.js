const API = '/api';

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
  setTimeout(() => el.className = 'toast hidden', 3000);
}

function statusLabel(s) {
  const map = { running: '运行中', building: '构建中', built: '已构建', idle: '待构建', stopped: '已停止', error: '异常' };
  return map[s] || s;
}

function renderBranches(branches, activeBranchId) {
  const list = document.getElementById('branchList');
  const entries = Object.values(branches);

  if (entries.length === 0) {
    list.innerHTML = '<div class="empty-state">暂无分支，请添加</div>';
    return;
  }

  list.innerHTML = entries.map(b => {
    const isActive = b.id === activeBranchId;
    return `
      <div class="branch-card ${isActive ? 'active' : ''}">
        <div class="status-dot ${b.status}"></div>
        <div class="branch-info">
          <div class="branch-name">${b.branch} ${isActive ? '(当前激活)' : ''}</div>
          <div class="branch-meta">
            ID: ${b.id} | DB: ${b.dbName} | 容器: ${b.containerName} | ${statusLabel(b.status)}
          </div>
        </div>
        <div class="branch-actions">
          ${b.status === 'idle' || b.status === 'error' || b.status === 'built' ? `<button class="primary" onclick="buildBranch('${b.id}')">${b.status === 'built' ? '重新构建' : '构建'}</button>` : ''}
          ${b.status === 'built' || b.status === 'stopped' ? `<button class="primary" onclick="startBranch('${b.id}')">启动</button>` : ''}
          ${b.status === 'running' && !isActive ? `<button class="activate" onclick="activateBranch('${b.id}')">切换到此分支</button>` : ''}
          ${b.status === 'running' ? `<button onclick="stopBranch('${b.id}')">停止</button>` : ''}
          ${!isActive ? `<button class="danger" onclick="removeBranch('${b.id}')">删除</button>` : ''}
        </div>
      </div>
    `;
  }).join('');
}

function renderHistory(history) {
  const el = document.getElementById('historyList');
  const btn = document.getElementById('rollbackBtn');
  if (history.length === 0) {
    el.textContent = '暂无切换记录';
    btn.disabled = true;
  } else {
    el.textContent = history.join(' -> ');
    btn.disabled = history.length <= 1;
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

    const activeBranch = document.getElementById('activeBranch');
    const activeLink = document.getElementById('activeLink');
    if (branchData.activeBranchId) {
      const entry = branchData.branches[branchData.activeBranchId];
      activeBranch.textContent = entry ? entry.branch : branchData.activeBranchId;
      activeLink.classList.remove('hidden');
      activeLink.href = `http://${location.hostname}:5500`;
    } else {
      activeBranch.textContent = '-';
      activeLink.classList.add('hidden');
    }
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function addBranch() {
  const input = document.getElementById('branchInput');
  const branch = input.value.trim();
  if (!branch) return showToast('请输入分支名', 'error');
  try {
    await api('POST', '/branches', { branch });
    input.value = '';
    showToast(`分支 ${branch} 已添加`, 'success');
    await refresh();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function buildBranch(id) {
  try {
    showToast(`正在构建 ${id}...`, 'info');
    await api('POST', `/branches/${id}/build`);
    showToast(`${id} 构建完成`, 'success');
    await refresh();
  } catch (err) {
    showToast(`构建失败: ${err.message}`, 'error');
    await refresh();
  }
}

async function startBranch(id) {
  try {
    await api('POST', `/branches/${id}/start`);
    showToast(`${id} 已启动`, 'success');
    await refresh();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function stopBranch(id) {
  try {
    await api('POST', `/branches/${id}/stop`);
    showToast(`${id} 已停止`, 'success');
    await refresh();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function activateBranch(id) {
  try {
    showToast(`正在切换到 ${id}...`, 'info');
    await api('POST', `/branches/${id}/activate`);
    showToast(`已切换到 ${id}`, 'success');
    await refresh();
  } catch (err) {
    showToast(err.message, 'error');
    await refresh();
  }
}

async function removeBranch(id) {
  if (!confirm(`确认删除分支 ${id}？将停止容器、删除 worktree 和镜像。`)) return;
  try {
    await api('DELETE', `/branches/${id}`);
    showToast(`${id} 已删除`, 'success');
    await refresh();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function doRollback() {
  try {
    showToast('正在回滚...', 'info');
    const data = await api('POST', '/rollback');
    showToast(`已回滚到 ${data.activeBranchId}`, 'success');
    await refresh();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// Enter key to add branch
document.getElementById('branchInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') addBranch();
});

// Auto-refresh every 5 seconds
refresh();
setInterval(refresh, 5000);
