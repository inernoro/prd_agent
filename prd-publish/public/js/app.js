/**
 * PRD-Publish Frontend Application
 */

// State
const state = {
  token: localStorage.getItem('prd-publish-token'),
  user: localStorage.getItem('prd-publish-user'),
  currentCommit: null,
  commits: [],
  tags: [],
  history: [],
  commitsOffset: 0,
  isDeploying: false,
  selectedCommit: null,
};

// DOM Elements
const elements = {
  loginPage: document.getElementById('login-page'),
  mainPage: document.getElementById('main-page'),
  loginForm: document.getElementById('login-form'),
  loginError: document.getElementById('login-error'),
  currentUser: document.getElementById('current-user'),
  logoutBtn: document.getElementById('logout-btn'),
  currentVersion: document.getElementById('current-version'),
  lastDeploy: document.getElementById('last-deploy'),
  statusWarning: document.getElementById('status-warning'),
  tabs: document.querySelectorAll('.tab'),
  panels: {
    commits: document.getElementById('commits-panel'),
    tags: document.getElementById('tags-panel'),
    history: document.getElementById('history-panel'),
  },
  commitsList: document.getElementById('commits-list'),
  tagsList: document.getElementById('tags-list'),
  historyList: document.getElementById('history-list'),
  historyStats: document.getElementById('history-stats'),
  searchInput: document.getElementById('search-input'),
  refreshBtn: document.getElementById('refresh-btn'),
  loadMoreBtn: document.getElementById('load-more-commits'),
  modal: document.getElementById('deploy-modal'),
  modalClose: document.getElementById('modal-close'),
  deployConfirm: document.getElementById('deploy-confirm'),
  deployProgress: document.getElementById('deploy-progress'),
  deployResult: document.getElementById('deploy-result'),
  deployHash: document.getElementById('deploy-hash'),
  deployMessage: document.getElementById('deploy-message'),
  deployLogs: document.getElementById('deploy-logs'),
  confirmDeployBtn: document.getElementById('confirm-deploy-btn'),
  cancelDeployBtn: document.getElementById('cancel-deploy-btn'),
  cancelRunningBtn: document.getElementById('cancel-running-btn'),
  retryBtn: document.getElementById('retry-btn'),
  closeResultBtn: document.getElementById('close-result-btn'),
  progressText: document.getElementById('progress-text'),
  progressIcon: document.getElementById('progress-icon'),
  progressRetry: document.getElementById('progress-retry'),
  resultIcon: document.getElementById('result-icon'),
  resultTitle: document.getElementById('result-title'),
  resultMessage: document.getElementById('result-message'),
  resultLogs: document.getElementById('result-logs'),
};

// API Helper
async function api(endpoint, options = {}) {
  const headers = {
    'Content-Type': 'application/json',
    ...options.headers,
  };

  if (state.token) {
    headers['Authorization'] = `Bearer ${state.token}`;
  }

  const response = await fetch(`/api${endpoint}`, {
    ...options,
    headers,
  });

  const data = await response.json();

  if (response.status === 401) {
    logout();
    throw new Error('认证已过期，请重新登录');
  }

  if (!response.ok) {
    throw new Error(data.error || '请求失败');
  }

  return data;
}

// Format relative time
function formatRelativeTime(dateStr) {
  const date = new Date(dateStr);
  const now = new Date();
  const diffSec = Math.floor((now - date) / 1000);

  if (diffSec < 60) return '刚刚';
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}分钟前`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}小时前`;
  if (diffSec < 604800) return `${Math.floor(diffSec / 86400)}天前`;
  return date.toLocaleDateString('zh-CN');
}

// Format duration
function formatDuration(ms) {
  if (ms < 1000) return `${ms}ms`;
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}秒`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}分${sec % 60}秒`;
  return `${Math.floor(min / 60)}小时${min % 60}分`;
}

// Auth Functions
async function login(username, password) {
  const data = await api('/login', {
    method: 'POST',
    body: JSON.stringify({ username, password }),
  });

  state.token = data.token;
  state.user = username;
  localStorage.setItem('prd-publish-token', data.token);
  localStorage.setItem('prd-publish-user', username);

  showMainPage();
}

function logout() {
  state.token = null;
  state.user = null;
  localStorage.removeItem('prd-publish-token');
  localStorage.removeItem('prd-publish-user');
  showLoginPage();
}

// Page Navigation
function showLoginPage() {
  elements.loginPage.classList.remove('hidden');
  elements.mainPage.classList.add('hidden');
  elements.loginError.textContent = '';
}

function showMainPage() {
  elements.loginPage.classList.add('hidden');
  elements.mainPage.classList.remove('hidden');
  elements.currentUser.textContent = state.user;
  loadData();
}

// Data Loading
async function loadData() {
  await Promise.all([
    loadStatus(),
    loadCommits(),
    loadHistory(),
  ]);
}

async function loadStatus() {
  try {
    const { data } = await api('/status');
    state.currentCommit = data.currentCommit;

    elements.currentVersion.textContent = data.currentCommit.shortHash;
    elements.currentVersion.title = data.currentCommit.message;

    // Load last deploy
    const historyData = await api('/history?limit=1');
    if (historyData.data.length > 0) {
      const last = historyData.data[0];
      const statusIcon = last.status === 'success' ? '✓' : last.status === 'failed' ? '✗' : '○';
      const statusClass = last.status === 'success' ? 'success' : last.status === 'failed' ? 'error' : '';
      elements.lastDeploy.innerHTML = `${formatRelativeTime(last.endTime)} <span class="${statusClass}">${statusIcon}</span>`;
    }

    // Check for version mismatch warning
    if (data.hasChanges) {
      elements.statusWarning.classList.remove('hidden');
      elements.statusWarning.querySelector('.warning-text').textContent =
        `检测到 ${data.changedFiles} 个未提交的更改`;
    } else {
      elements.statusWarning.classList.add('hidden');
    }
  } catch (error) {
    console.error('Failed to load status:', error);
  }
}

async function loadCommits(reset = true) {
  try {
    if (reset) {
      state.commitsOffset = 0;
      elements.commitsList.innerHTML = '<div class="loading">加载中...</div>';
    }

    const search = elements.searchInput.value;
    const { data, pagination } = await api(`/commits?limit=20&offset=${state.commitsOffset}&search=${encodeURIComponent(search)}`);

    if (reset) {
      state.commits = data;
      elements.commitsList.innerHTML = '';
    } else {
      state.commits = [...state.commits, ...data];
    }

    renderCommits(data, !reset);
    state.commitsOffset += data.length;

    // Show/hide load more button
    if (pagination.hasMore) {
      elements.loadMoreBtn.classList.remove('hidden');
    } else {
      elements.loadMoreBtn.classList.add('hidden');
    }
  } catch (error) {
    elements.commitsList.innerHTML = `<div class="empty-state"><div class="empty-state-icon">⚠️</div>${error.message}</div>`;
  }
}

async function loadTags() {
  try {
    elements.tagsList.innerHTML = '<div class="loading">加载中...</div>';
    const { data } = await api('/tags');
    state.tags = data;
    renderTags(data);
  } catch (error) {
    elements.tagsList.innerHTML = `<div class="empty-state"><div class="empty-state-icon">⚠️</div>${error.message}</div>`;
  }
}

async function loadHistory() {
  try {
    elements.historyList.innerHTML = '<div class="loading">加载中...</div>';
    const { data, stats } = await api('/history');
    state.history = data;
    renderHistory(data);
    renderHistoryStats(stats);
  } catch (error) {
    elements.historyList.innerHTML = `<div class="empty-state"><div class="empty-state-icon">⚠️</div>${error.message}</div>`;
  }
}

// Rendering
function renderCommits(commits, append = false) {
  if (!append && commits.length === 0) {
    elements.commitsList.innerHTML = '<div class="empty-state"><div class="empty-state-icon">📭</div>没有找到提交</div>';
    return;
  }

  const html = commits.map(commit => {
    const isCurrent = state.currentCommit && commit.hash === state.currentCommit.hash;
    const tags = commit.tags.map(t => `<span class="commit-tag">${t}</span>`).join('');

    return `
      <div class="list-item ${isCurrent ? 'current' : ''}" data-hash="${commit.hash}">
        <div class="commit-indicator ${isCurrent ? 'current' : 'other'}"></div>
        <div class="list-item-content">
          <div class="list-item-header">
            <span class="commit-hash">${commit.shortHash}</span>
            ${tags}
          </div>
          <div class="commit-message">${escapeHtml(commit.message)}</div>
          <div class="commit-meta">
            <span>${commit.author}</span>
            <span>${formatRelativeTime(commit.date)}</span>
          </div>
        </div>
        <div class="list-item-actions">
          <button class="btn btn-primary btn-small deploy-btn" data-hash="${commit.hash}" data-short="${commit.shortHash}" data-message="${escapeHtml(commit.message)}">
            发布
          </button>
        </div>
      </div>
    `;
  }).join('');

  if (append) {
    elements.commitsList.insertAdjacentHTML('beforeend', html);
  } else {
    elements.commitsList.innerHTML = html;
  }

  // Bind deploy buttons
  elements.commitsList.querySelectorAll('.deploy-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      openDeployModal(btn.dataset.hash, btn.dataset.short, btn.dataset.message);
    });
  });
}

function renderTags(tags) {
  if (tags.length === 0) {
    elements.tagsList.innerHTML = '<div class="empty-state"><div class="empty-state-icon">🏷️</div>没有标签</div>';
    return;
  }

  elements.tagsList.innerHTML = tags.map(tag => `
    <div class="list-item" data-hash="${tag.shortHash}">
      <div class="list-item-content">
        <div class="list-item-header">
          <span class="commit-tag">${tag.name}</span>
          <span class="commit-hash">${tag.shortHash}</span>
        </div>
        <div class="commit-message">${escapeHtml(tag.message || '')}</div>
        <div class="commit-meta">
          <span>${formatRelativeTime(tag.date)}</span>
        </div>
      </div>
      <div class="list-item-actions">
        <button class="btn btn-primary btn-small deploy-btn" data-hash="${tag.shortHash}" data-short="${tag.shortHash}" data-message="${tag.name}">
          发布
        </button>
      </div>
    </div>
  `).join('');

  elements.tagsList.querySelectorAll('.deploy-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      openDeployModal(btn.dataset.hash, btn.dataset.short, btn.dataset.message);
    });
  });
}

function renderHistory(history) {
  if (history.length === 0) {
    elements.historyList.innerHTML = '<div class="empty-state"><div class="empty-state-icon">📋</div>没有发布历史</div>';
    return;
  }

  elements.historyList.innerHTML = history.map(record => {
    const statusClass = record.status === 'success' ? 'success' : record.status === 'failed' ? 'failed' : 'cancelled';
    const statusText = record.status === 'success' ? '成功' : record.status === 'failed' ? '失败' : '已取消';
    const statusIcon = record.status === 'success' ? '✓' : record.status === 'failed' ? '✗' : '○';

    return `
      <div class="list-item">
        <div class="list-item-content">
          <div class="list-item-header">
            <span class="commit-hash">${record.shortHash}</span>
            <span class="history-status ${statusClass}">${statusIcon} ${statusText}</span>
            ${record.retryCount > 0 ? `<span class="commit-tag">重试 ${record.retryCount} 次</span>` : ''}
          </div>
          <div class="commit-message">${escapeHtml(record.message)}</div>
          <div class="commit-meta">
            <span>${record.operator}</span>
            <span>${formatRelativeTime(record.endTime)}</span>
            <span>${formatDuration(record.duration)}</span>
          </div>
        </div>
        ${record.status === 'failed' ? `
        <div class="list-item-actions">
          <button class="btn btn-ghost btn-small retry-history-btn" data-id="${record.id}">重试</button>
        </div>
        ` : ''}
      </div>
    `;
  }).join('');

  elements.historyList.querySelectorAll('.retry-history-btn').forEach(btn => {
    btn.addEventListener('click', () => retryFromHistory(btn.dataset.id));
  });
}

function renderHistoryStats(stats) {
  elements.historyStats.innerHTML = `
    <div class="stat-item">
      <div class="stat-value">${stats.total}</div>
      <div class="stat-label">总计</div>
    </div>
    <div class="stat-item">
      <div class="stat-value success">${stats.successful}</div>
      <div class="stat-label">成功</div>
    </div>
    <div class="stat-item">
      <div class="stat-value error">${stats.failed}</div>
      <div class="stat-label">失败</div>
    </div>
    <div class="stat-item">
      <div class="stat-value">${stats.successRate}%</div>
      <div class="stat-label">成功率</div>
    </div>
  `;
}

// Deploy Modal
function openDeployModal(hash, shortHash, message) {
  state.selectedCommit = { hash, shortHash, message };
  elements.deployHash.textContent = shortHash;
  elements.deployMessage.textContent = message;
  elements.deployConfirm.classList.remove('hidden');
  elements.deployProgress.classList.add('hidden');
  elements.deployResult.classList.add('hidden');
  elements.modal.classList.remove('hidden');
}

function closeDeployModal() {
  elements.modal.classList.add('hidden');
  state.selectedCommit = null;
}

async function startDeploy() {
  if (!state.selectedCommit) return;

  elements.deployConfirm.classList.add('hidden');
  elements.deployProgress.classList.remove('hidden');
  elements.deployLogs.innerHTML = '';
  elements.progressText.textContent = '正在发布...';
  elements.progressIcon.textContent = '🚀';
  elements.progressRetry.classList.add('hidden');

  try {
    // Start SSE connection
    const eventSource = new EventSource(`/api/deploy/stream?token=${state.token}`);

    eventSource.onmessage = (event) => {
      const data = JSON.parse(event.data);

      if (data.type === 'output') {
        appendLog(data.data.text, data.data.stream);
      } else if (data.type === 'status' && data.status === 'retrying') {
        elements.progressText.textContent = '重试中...';
        elements.progressRetry.textContent = `(${data.data.retryCount}/${data.data.maxRetries})`;
        elements.progressRetry.classList.remove('hidden');
      } else if (data.type === 'complete') {
        eventSource.close();
        showDeployResult(data.data);
      } else if (data.type === 'error') {
        eventSource.close();
        showDeployResult({ success: false, message: data.error });
      }
    };

    eventSource.onerror = () => {
      eventSource.close();
    };

    // Start deployment
    const result = await api('/deploy', {
      method: 'POST',
      body: JSON.stringify({ commitHash: state.selectedCommit.hash }),
    });

    if (!result.success) {
      eventSource.close();
      showDeployResult(result.data || { success: false, message: result.error });
    }
  } catch (error) {
    showDeployResult({ success: false, message: error.message });
  }
}

function appendLog(text, stream) {
  const span = document.createElement('span');
  span.className = stream;
  span.textContent = text;
  elements.deployLogs.appendChild(span);
  elements.deployLogs.scrollTop = elements.deployLogs.scrollHeight;
}

function showDeployResult(result) {
  elements.deployProgress.classList.add('hidden');
  elements.deployResult.classList.remove('hidden');

  if (result.success) {
    elements.resultIcon.textContent = '✓';
    elements.resultIcon.className = 'result-icon success';
    elements.resultTitle.textContent = '发布成功';
    elements.resultMessage.textContent = `版本 ${result.shortHash || state.selectedCommit?.shortHash} 已部署`;
    elements.retryBtn.classList.add('hidden');
    elements.resultLogs.classList.add('hidden');
  } else {
    elements.resultIcon.textContent = '✗';
    elements.resultIcon.className = 'result-icon error';
    elements.resultTitle.textContent = '发布失败';
    elements.resultMessage.textContent = result.message || '未知错误';
    elements.retryBtn.classList.remove('hidden');

    if (result.logs && result.logs.length > 0) {
      elements.resultLogs.classList.remove('hidden');
      const logsHtml = result.logs.slice(-20).map(l =>
        `<span class="${l.stream}">${escapeHtml(l.text)}</span>`
      ).join('');
      elements.resultLogs.querySelector('pre').innerHTML = logsHtml;
    }
  }

  // Refresh data
  loadStatus();
  loadHistory();
  loadCommits();
}

async function cancelDeploy() {
  try {
    await api('/deploy/cancel', { method: 'POST' });
    elements.progressText.textContent = '正在取消...';
  } catch (error) {
    console.error('Cancel failed:', error);
  }
}

async function retryDeploy() {
  if (state.selectedCommit) {
    elements.deployResult.classList.add('hidden');
    await startDeploy();
  }
}

async function retryFromHistory(id) {
  try {
    openDeployModal('', '', '从历史重试');
    elements.deployConfirm.classList.add('hidden');
    elements.deployProgress.classList.remove('hidden');
    elements.deployLogs.innerHTML = '';

    const result = await api(`/history/${id}/retry`, { method: 'POST' });
    showDeployResult(result.data);
  } catch (error) {
    showDeployResult({ success: false, message: error.message });
  }
}

// Utility
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// Tab switching
function switchTab(tabName) {
  elements.tabs.forEach(tab => {
    tab.classList.toggle('active', tab.dataset.tab === tabName);
  });

  Object.entries(elements.panels).forEach(([name, panel]) => {
    panel.classList.toggle('hidden', name !== tabName);
  });

  // Load data for tabs
  if (tabName === 'tags' && state.tags.length === 0) {
    loadTags();
  }
}

// Event Listeners
document.addEventListener('DOMContentLoaded', () => {
  // Check auth
  if (state.token) {
    showMainPage();
  } else {
    showLoginPage();
  }

  // Login form
  elements.loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = document.getElementById('username').value;
    const password = document.getElementById('password').value;
    const btn = elements.loginForm.querySelector('button');

    btn.classList.add('loading');
    btn.disabled = true;
    elements.loginError.textContent = '';

    try {
      await login(username, password);
    } catch (error) {
      elements.loginError.textContent = error.message;
    } finally {
      btn.classList.remove('loading');
      btn.disabled = false;
    }
  });

  // Logout
  elements.logoutBtn.addEventListener('click', logout);

  // Tabs
  elements.tabs.forEach(tab => {
    tab.addEventListener('click', () => switchTab(tab.dataset.tab));
  });

  // Search
  let searchTimeout;
  elements.searchInput.addEventListener('input', () => {
    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(() => loadCommits(), 300);
  });

  // Refresh
  elements.refreshBtn.addEventListener('click', () => loadData());

  // Load more
  elements.loadMoreBtn.addEventListener('click', () => loadCommits(false));

  // Modal
  elements.modalClose.addEventListener('click', closeDeployModal);
  elements.modal.querySelector('.modal-backdrop').addEventListener('click', closeDeployModal);
  elements.cancelDeployBtn.addEventListener('click', closeDeployModal);
  elements.confirmDeployBtn.addEventListener('click', startDeploy);
  elements.cancelRunningBtn.addEventListener('click', cancelDeploy);
  elements.retryBtn.addEventListener('click', retryDeploy);
  elements.closeResultBtn.addEventListener('click', closeDeployModal);

  // Pull to refresh (mobile)
  let touchStartY = 0;
  document.addEventListener('touchstart', (e) => {
    touchStartY = e.touches[0].clientY;
  });

  document.addEventListener('touchmove', (e) => {
    const touchY = e.touches[0].clientY;
    const scrollTop = document.documentElement.scrollTop || document.body.scrollTop;

    if (scrollTop === 0 && touchY > touchStartY + 100) {
      loadData();
    }
  });
});

// Handle token in SSE (workaround)
const originalFetch = window.fetch;
window.fetch = function(url, options = {}) {
  if (url.includes('/api/deploy/stream')) {
    // SSE doesn't support headers, use query param
    return originalFetch(url, options);
  }
  return originalFetch(url, options);
};
