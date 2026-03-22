const API = '/api';
const busyBranches = new Set();
// Per-button loading state: Map<string, Set<string>> e.g. { "main": Set(["stop", "pull"]) }
const loadingActions = new Map();
let globalBusy = false;

// ── Tag filter state ──
let activeTagFilter = null; // null = show all, string = filter by tag

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
  deploy: '<svg class="inline-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m15 12-8.373 8.373a1 1 0 1 1-3-3L12 9"/><path d="m18 15 4-4"/><path d="m21.5 11.5c.7-1 .5-2.4-.3-3.2L17 4.2c-.8-.8-2.2-1-3.2-.3L12 5.5l6.5 6.5z"/></svg>',
  trash: '<svg class="inline-icon" width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M6.5 1.75a.25.25 0 01.25-.25h2.5a.25.25 0 01.25.25V3h-3V1.75zM11 3V1.75A1.75 1.75 0 009.25 0h-2.5A1.75 1.75 0 005 1.75V3H2.75a.75.75 0 000 1.5h.3l.8 8.2A1.75 1.75 0 005.6 14.5h4.8a1.75 1.75 0 001.75-1.8l.8-8.2h.3a.75.75 0 000-1.5H11z"/></svg>',
  reset: '<svg class="inline-icon" width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M8 2.5a5.487 5.487 0 00-4.131 1.869l1.204 1.204A.25.25 0 014.896 6H1.25A.25.25 0 011 5.75V2.104a.25.25 0 01.427-.177l1.38 1.38A7.002 7.002 0 0115 8a.75.75 0 01-1.5 0A5.5 5.5 0 008 2.5z"/></svg>',
  star: '<svg class="inline-icon" width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M8 .25a.75.75 0 01.673.418l1.882 3.815 4.21.612a.75.75 0 01.416 1.279l-3.046 2.97.719 4.192a.75.75 0 01-1.088.791L8 12.347l-3.766 1.98a.75.75 0 01-1.088-.79l.72-4.194L.818 6.374a.75.75 0 01.416-1.28l4.21-.611L7.327.668A.75.75 0 018 .25z"/></svg>',
  starOutline: '<svg class="inline-icon" width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M8 .25a.75.75 0 01.673.418l1.882 3.815 4.21.612a.75.75 0 01.416 1.279l-3.046 2.97.719 4.192a.751.751 0 01-1.088.791L8 12.347l-3.766 1.98a.75.75 0 01-1.088-.79l.72-4.194L.818 6.374a.75.75 0 01.416-1.28l4.21-.611L7.327.668A.75.75 0 018 .25zm0 2.445L6.615 5.5a.75.75 0 01-.564.41l-3.097.45 2.24 2.184a.75.75 0 01.216.664l-.528 3.084 2.769-1.456a.75.75 0 01.698 0l2.77 1.456-.53-3.084a.75.75 0 01.216-.664l2.24-2.183-3.096-.45a.75.75 0 01-.564-.41L8 2.694z"/></svg>',
  edit: '<svg class="inline-icon" width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M11.013 1.427a1.75 1.75 0 012.474 0l1.086 1.086a1.75 1.75 0 010 2.474l-8.61 8.61c-.21.21-.47.364-.756.445l-3.251.93a.75.75 0 01-.927-.928l.929-3.25c.081-.286.235-.547.445-.758l8.61-8.61zM11.189 3L3.75 10.44l-.528 1.849 1.85-.528L12.5 4.311 11.189 3z"/></svg>',
  tag: '<svg class="inline-icon" width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M1 7.775V2.75C1 1.784 1.784 1 2.75 1h5.025c.464 0 .91.184 1.238.513l6.25 6.25a1.75 1.75 0 010 2.474l-5.026 5.026a1.75 1.75 0 01-2.474 0l-6.25-6.25A1.75 1.75 0 011 7.775zM5 5a1 1 0 100-2 1 1 0 000 2z"/></svg>',
  // Human footprint (web access indicator)
  footprint: '<svg class="human-access-icon" width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C9.24 2 7 4.24 7 7c0 2.85 2.92 7.21 5 9.88 2.11-2.69 5-7 5-9.88 0-2.76-2.24-5-5-5zm0 7.5a2.5 2.5 0 010-5 2.5 2.5 0 010 5z"/><path d="M7.05 16.87C5.01 17.46 3.5 18.5 3.5 19.5 3.5 21.15 7.36 22 12 22s8.5-.85 8.5-2.5c0-1-.51-2.04-2.55-2.63-.53 1.04-1.3 2.13-2.21 3.13H8.26c-.91-1-1.68-2.09-2.21-3.13z"/></svg>',
  lightbulb: '<svg class="inline-icon" width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M8 1.5a4.5 4.5 0 00-1.68 8.68.5.5 0 01.3.46v1.86h2.76v-1.86a.5.5 0 01.3-.46A4.5 4.5 0 008 1.5zM5.5 13v.5c0 .83.67 1.5 1.5 1.5h2c.83 0 1.5-.67 1.5-1.5V13h-5z"/></svg>',
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

// ── Mirror acceleration (npm/docker registry mirrors) ──
let mirrorEnabled = false;

// ── Theme (light/dark) ──
// Theme is applied in <head> inline script to prevent FOUC (flash of unstyled content).
let cdsTheme = localStorage.getItem('cds_theme') || 'dark';

// ── Executor/Scheduler state ──
let cdsMode = 'standalone';
let executors = [];

// ── Container capacity ──
let containerCapacity = { maxContainers: 999, runningContainers: 0, totalMemGB: 0 };

// ── Utilities ──

async function api(method, path, body, { poll } = {}) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (poll) opts.headers['X-CDS-Poll'] = 'true';
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
  const map = { running: '运行中', starting: '启动中', building: '构建中', stopping: '正在停止', idle: '空闲', stopped: '已停止', error: '错误' };
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

let remoteCandidates = [];  // remote refs for branch picker (from GET /remote-branches)
let branches = [];          // tracked branches (from GET /branches)
let buildProfiles = [];
let routingRules = [];
let defaultBranch = null;
let customEnvVars = {};
let infraServices = [];

// ── AI Occupation Tracking ──
// Maps branchId → { agent, lastSeen (timestamp) }
const aiOccupation = new Map();
const AI_OCCUPY_TTL = 30000; // 30s — if no AI activity, consider released

// Per-branch AI activity log (last N events)
const aiBranchEvents = new Map(); // branchId → [event, ...]
const AI_BRANCH_EVENTS_MAX = 5;

function getAiOccupant(branchId) {
  const entry = aiOccupation.get(branchId);
  if (!entry) return null;
  if (Date.now() - entry.lastSeen > AI_OCCUPY_TTL) {
    aiOccupation.delete(branchId);
    return null;
  }
  return entry.agent;
}

function trackAiBranchEvent(event) {
  if (event.source !== 'ai' || !event.branchId) return;
  let list = aiBranchEvents.get(event.branchId);
  if (!list) { list = []; aiBranchEvents.set(event.branchId, list); }
  list.push(event);
  if (list.length > AI_BRANCH_EVENTS_MAX) list.shift();
}

function renderAiBranchFeed(branchId) {
  const events = aiBranchEvents.get(branchId);
  if (!events || events.length === 0) return '';
  // Show only the latest event — roller animation is done via DOM updates
  const ev = events[events.length - 1];
  const statusCls = ev.status < 400 ? 'ok' : 'err';
  const label = ev.label || ev.path.replace(/^\/api\//, '').replace(/branches\/[^/]+\/?/, '');
  const dur = ev.duration < 1000 ? `${ev.duration}ms` : `${(ev.duration / 1000).toFixed(1)}s`;
  return `<div class="ai-branch-feed" data-branch-feed="${escapeHtml(branchId)}"><div class="roller-line roller-active"><span class="roller-ai">AI</span><span class="activity-method ${ev.method}">${ev.method}</span><span class="ai-feed-label">${escapeHtml(label)}</span><span class="activity-status ${statusCls}">${ev.status}</span><span class="ai-feed-dur">${dur}</span></div></div>`;
}

function updateBranchFeedRoller(event) {
  const feed = document.querySelector(`[data-branch-feed="${event.branchId}"]`);
  if (!feed) { renderBranches(); return; }

  const statusCls = event.status < 400 ? 'ok' : 'err';
  const label = event.label || event.path.replace(/^\/api\//, '').replace(/branches\/[^/]+\/?/, '');
  const dur = event.duration < 1000 ? `${event.duration}ms` : `${(event.duration / 1000).toFixed(1)}s`;

  const html = `<span class="roller-ai">AI</span><span class="activity-method ${event.method}">${event.method}</span><span class="ai-feed-label">${escapeHtml(label)}</span><span class="activity-status ${statusCls}">${event.status}</span><span class="ai-feed-dur">${dur}</span>`;

  feed.innerHTML = `<div class="roller-line roller-flip">${html}</div>`;
}

// Periodically expire stale AI occupations and refresh cards
setInterval(() => {
  let changed = false;
  for (const [id, entry] of aiOccupation) {
    if (Date.now() - entry.lastSeen > AI_OCCUPY_TTL) {
      aiOccupation.delete(id);
      aiBranchEvents.delete(id);
      changed = true;
    }
  }
  if (changed) renderBranches();
}, 10000);

// ── Init ──

let githubRepoUrl = '';
let mainDomain = '';
let previewDomain = '';
let workerPort = '';

async function init() {
  updateThemeUI();
  await Promise.all([loadBranches(), loadProfiles(), loadRoutingRules(), loadConfig(), loadEnvVars(), loadInfraServices(), loadMirrorState()]);
  refreshRemoteCandidates();
  updatePreviewModeUI();
  initStateStream(); // Server-authority: listen for state changes via SSE (replaces polling)
}

// ── State stream: server pushes branch state changes (no polling needed) ──
let stateEventSource = null;

function initStateStream() {
  stateEventSource = new EventSource(`${API}/state-stream`);
  stateEventSource.onmessage = (e) => {
    try {
      const data = JSON.parse(e.data);
      if (data.branches) {
        // Merge commit info: state-stream has no git data, so preserve existing subject/commitSha
        // Only update status and service states from server push
        const branchMap = new Map(branches.map(b => [b.id, b]));
        for (const pushed of data.branches) {
          const existing = branchMap.get(pushed.id);
          if (existing) {
            // Preserve git info, update status/services
            Object.assign(existing, pushed, {
              subject: existing.subject,
              commitSha: existing.commitSha,
            });
          } else {
            branches.push(pushed);
          }
        }
        // Remove branches that no longer exist
        const pushedIds = new Set(data.branches.map(b => b.id));
        branches = branches.filter(b => pushedIds.has(b.id));
        if (data.defaultBranch !== undefined) defaultBranch = data.defaultBranch;
        renderBranches();
      }
    } catch {}
  };
  stateEventSource.onerror = () => {
    setTimeout(() => {
      if (stateEventSource) stateEventSource.close();
      initStateStream();
    }, 3000);
  };
}

async function loadConfig() {
  try {
    const data = await api('GET', '/config');
    githubRepoUrl = data.githubRepoUrl || '';
    mainDomain = data.mainDomain || '';
    previewDomain = data.previewDomain || '';
    workerPort = data.workerPort || '';
    cdsMode = data.mode || 'standalone';
    executors = data.executors || [];
    renderExecutorPanel();
  } catch (e) { console.error('loadConfig:', e); }
}

// ── Executor Panel (scheduler mode) ──

function renderExecutorPanel() {
  const panel = document.getElementById('executorPanel');
  if (!panel) return;

  // Only show in scheduler mode or when executors exist
  if (cdsMode !== 'scheduler' && executors.length === 0) {
    panel.classList.add('hidden');
    return;
  }

  panel.classList.remove('hidden');

  if (executors.length === 0) {
    panel.innerHTML = `
      <div class="executor-header">
        <span class="executor-title">执行器集群</span>
        <span class="executor-badge empty">无执行器</span>
      </div>
      <div class="executor-hint">
        在远程服务器上运行 <code>CDS_MODE=executor CDS_SCHEDULER_URL=http://本机:9900 node dist/index.js</code> 来注册执行器
      </div>`;
    return;
  }

  const online = executors.filter(e => e.status === 'online').length;
  const total = executors.length;

  panel.innerHTML = `
    <div class="executor-header" onclick="toggleExecutorPanel()">
      <span class="executor-title">执行器集群</span>
      <span class="executor-badge ${online === total ? 'all-ok' : 'partial'}">${online}/${total} 在线</span>
      <span class="executor-toggle">▾</span>
    </div>
    <div id="executorList" class="executor-list hidden">
      ${executors.map(ex => {
        const memPct = ex.capacity.memoryMB > 0 ? Math.round(ex.load.memoryUsedMB / ex.capacity.memoryMB * 100) : 0;
        const memGB = (ex.load.memoryUsedMB / 1024).toFixed(1);
        const totalGB = (ex.capacity.memoryMB / 1024).toFixed(1);
        return `
          <div class="executor-card executor-${ex.status}">
            <div class="executor-card-header">
              <span class="executor-dot ${ex.status}"></span>
              <span class="executor-id">${esc(ex.id)}</span>
              <span class="executor-host">${esc(ex.host)}:${ex.port}</span>
            </div>
            <div class="executor-metrics">
              <div class="executor-metric">
                <span class="metric-label">内存</span>
                <div class="metric-bar"><div class="metric-fill ${memPct > 85 ? 'danger' : memPct > 65 ? 'warn' : ''}" style="width:${memPct}%"></div></div>
                <span class="metric-value">${memGB}/${totalGB} GB</span>
              </div>
              <div class="executor-metric">
                <span class="metric-label">CPU</span>
                <div class="metric-bar"><div class="metric-fill ${ex.load.cpuPercent > 85 ? 'danger' : ex.load.cpuPercent > 65 ? 'warn' : ''}" style="width:${Math.min(ex.load.cpuPercent, 100)}%"></div></div>
                <span class="metric-value">${ex.load.cpuPercent}%</span>
              </div>
            </div>
            <div class="executor-branches">
              ${ex.branches.length > 0 ? ex.branches.map(bid => `<span class="executor-branch-tag">${esc(bid)}</span>`).join('') : '<span class="executor-no-branches">无部署分支</span>'}
            </div>
            ${ex.status === 'online' ? `<button class="executor-action-btn" onclick="drainExecutor('${esc(ex.id)}')">排空</button>` : ''}
            <button class="executor-action-btn danger" onclick="removeExecutor('${esc(ex.id)}')">移除</button>
          </div>`;
      }).join('')}
    </div>`;
}

function toggleExecutorPanel() {
  const list = document.getElementById('executorList');
  const toggle = document.querySelector('.executor-toggle');
  if (list) {
    list.classList.toggle('hidden');
    if (toggle) toggle.textContent = list.classList.contains('hidden') ? '▾' : '▴';
  }
}

async function drainExecutor(id) {
  try {
    await api('POST', `/executors/${id}/drain`);
    showToast(`执行器 ${id} 已标记为排空`, 'info');
    loadConfig();
  } catch (e) { showToast(e.message, 'error'); }
}

async function removeExecutor(id) {
  if (!confirm(`确定移除执行器 ${id}？该节点上的分支不会自动迁移。`)) return;
  try {
    await api('DELETE', `/executors/${id}`);
    showToast(`执行器 ${id} 已移除`, 'success');
    loadConfig();
  } catch (e) { showToast(e.message, 'error'); }
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
      showToast(`${count} 个分支有远程更新，非前端改动可能需要重新部署`, 'info', 8000);
      // Flash only the updated cards' pull icons to draw attention
      setTimeout(() => {
        document.querySelectorAll('.branch-card.has-updates .update-pull-icon').forEach(icon => {
          icon.classList.add('needs-pull');
          icon.addEventListener('animationend', () => icon.classList.remove('needs-pull'), { once: true });
        });
      }, 100);
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

function cyclePreviewMode() {
  // Cycle: simple → port → multi → simple
  const modes = ['simple', 'port', 'multi'];
  const idx = modes.indexOf(previewMode);
  previewMode = modes[(idx + 1) % modes.length];
  localStorage.setItem('cds_preview_mode', previewMode);
  updatePreviewModeUI();
  renderBranches();
  const labels = { simple: '简洁模式（cookie 切换）', port: '端口直连模式（无缓存问题）', multi: '子域名模式（需 PREVIEW_DOMAIN）' };
  if (previewMode === 'multi' && !previewDomain) {
    showToast('已开启子域名预览模式，但 PREVIEW_DOMAIN 未配置，预览将回退到简洁模式。请在「变量」中设置 PREVIEW_DOMAIN。', 'error');
  } else {
    showToast(`预览：${labels[previewMode]}`, 'info');
  }
}


function updatePreviewModeUI() {
  // Update the label in settings menu if open
  const label = document.querySelector('.preview-mode-label');
  const labels = { simple: '简洁', port: '端口直连', multi: '子域名' };
  if (label) label.textContent = labels[previewMode] || previewMode;
}

// ── Mirror acceleration ──

async function loadMirrorState() {
  try {
    const data = await api('GET', '/mirror');
    mirrorEnabled = data.enabled;
  } catch { /* ignore */ }
}

async function toggleMirror() {
  const newVal = !mirrorEnabled;
  try {
    await api('PUT', '/mirror', { enabled: newVal });
    mirrorEnabled = newVal;
    updateMirrorUI();
    showToast(newVal ? '镜像加速已开启，下次部署生效' : '镜像加速已关闭', 'info');
  } catch (e) {
    showToast(e.message, 'error');
  }
}

function updateMirrorUI() {
  const sw = document.querySelector('.settings-switch-mirror');
  if (sw) sw.classList.toggle('on', mirrorEnabled);
}

// ── Theme toggle ──

function setTheme(theme) {
  cdsTheme = theme;
  if (theme === 'dark') {
    delete document.documentElement.dataset.theme;
  } else {
    document.documentElement.dataset.theme = theme;
  }
  localStorage.setItem('cds_theme', theme);
  updateThemeUI();
}

function toggleTheme(event) {
  const newTheme = cdsTheme === 'dark' ? 'light' : 'dark';

  // Get origin point from button click
  let x, y;
  if (event) {
    const btn = event.currentTarget || event.target;
    const rect = btn.getBoundingClientRect();
    x = rect.left + rect.width / 2;
    y = rect.top + rect.height / 2;
  } else {
    x = window.innerWidth / 2;
    y = 0;
  }

  // Calculate max radius to cover entire page
  const maxRadius = Math.ceil(Math.sqrt(
    Math.max(x, window.innerWidth - x) ** 2 +
    Math.max(y, window.innerHeight - y) ** 2
  ));

  // Set CSS custom properties for clip-path animation origin
  document.documentElement.style.setProperty('--ripple-x', `${x}px`);
  document.documentElement.style.setProperty('--ripple-y', `${y}px`);
  document.documentElement.style.setProperty('--ripple-radius', `${maxRadius}px`);

  if (document.startViewTransition) {
    // View Transition API: captures old state as snapshot, then reveals new state
    // with clip-path circle animation (like clawhub.ai)
    const transition = document.startViewTransition(() => {
      // Disable CSS transitions so the "new" snapshot captures final theme colors
      // immediately, not mid-transition states (which cause cards to show wrong skin
      // as the ripple sweeps over them).
      document.documentElement.classList.add('vt-snapshotting');
      setTheme(newTheme);
    });
    // Re-enable CSS transitions after the view transition snapshots are captured
    transition.ready.then(() => {
      document.documentElement.classList.remove('vt-snapshotting');
    }).catch(() => {
      document.documentElement.classList.remove('vt-snapshotting');
    });
  } else {
    // Fallback: instant switch
    setTheme(newTheme);
  }
}

function updateThemeUI() {
  const sw = document.querySelector('.settings-switch-theme');
  if (sw) sw.classList.toggle('on', cdsTheme === 'light');
  // Update header toggle icon
  const headerBtn = document.getElementById('themeToggleBtn');
  if (headerBtn) {
    headerBtn.innerHTML = cdsTheme === 'light'
      ? '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z"/></svg>'
      : '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="4.22" x2="19.78" y2="5.64"/></svg>';
    headerBtn.title = cdsTheme === 'light' ? '切换到暗色模式' : '切换到亮色模式';
  }
}

// ── Data loading ──

async function loadBranches({ silent } = {}) {
  try {
    if (silent) _pollInFlight = true;
    const data = await api('GET', '/branches', null, { poll: !!silent });
    branches = data.branches || [];
    defaultBranch = data.defaultBranch;
    if (data.capacity) containerCapacity = data.capacity;
    // Auto-select main/master as default when no default is set
    if (!defaultBranch && branches.length > 0) {
      const mainBranch = branches.find(b => b.id === 'main') || branches.find(b => b.id === 'master');
      if (mainBranch) defaultBranch = mainBranch.id;
    }
    renderBranches();
  } catch (e) { console.error('loadBranches:', e); }
  finally { if (silent) setTimeout(() => { _pollInFlight = false; }, 500); }
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
  } catch (e) { console.error('loadRoutingRules:', e); }
}

async function refreshRemoteCandidates() {
  const btn = document.getElementById('refreshRemoteBtn');
  btn.disabled = true;
  _lastRemoteRefreshQuery = '';
  try {
    const data = await api('GET', '/remote-branches');
    remoteCandidates = data.branches || [];
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

let _branchSearchTimer = null;
let _lastRemoteRefreshQuery = '';

function filterBranches() {
  const q = searchInput.value.trim().toLowerCase();

  // Section 1: Match tracked branches (show all when empty)
  const matchedLocal = branches.filter(b =>
    !q || b.branch.toLowerCase().includes(q) || b.id.toLowerCase().includes(q)
  ).slice(0, 10);

  // Section 2: Match remote candidates not yet tracked (show all when empty)
  const trackedIds = new Set(branches.map(b => StateService_slugify(b.branch)));
  const matchedRemote = remoteCandidates.filter(b =>
    (!q || b.name.toLowerCase().includes(q)) && !trackedIds.has(StateService_slugify(b.name))
  ).slice(0, 15);

  if (matchedLocal.length === 0 && matchedRemote.length === 0) {
    if (q && _lastRemoteRefreshQuery !== q) {
      // Show "searching online" then auto-refresh remote branches
      dropdown.innerHTML = '<div class="branch-dropdown-empty"><span class="branch-search-spinner"></span>正在在线搜索…</div>';
      dropdown.classList.remove('hidden');
      clearTimeout(_branchSearchTimer);
      _branchSearchTimer = setTimeout(async () => {
        _lastRemoteRefreshQuery = q;
        try {
          const data = await api('GET', '/remote-branches');
          remoteCandidates = data.branches || [];
        } catch (_) { /* ignore */ }
        // Re-filter with updated remote candidates
        if (searchInput.value.trim().toLowerCase() === q) {
          filterBranches();
        }
      }, 400);
      return;
    }
    dropdown.innerHTML = '<div class="branch-dropdown-empty">没有匹配的分支</div>';
  } else {
    _lastRemoteRefreshQuery = ''; // Reset so future searches can trigger refresh
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

// Scroll to an already-added branch card — gold flash 3x then stay blue
function scrollToAndHighlight(id) {
  dropdown.classList.add('hidden');
  searchInput.value = '';
  renderBranches();
  requestAnimationFrame(() => {
    const card = document.querySelector(`.branch-card[data-branch-id="${CSS.escape(id)}"]`);
    if (card) {
      card.scrollIntoView({ behavior: 'smooth', block: 'center' });
      // Gold flash 3 times (0.4s × 3 = 1.2s), then settle to blue
      card.classList.remove('duplicate-flash', 'recently-touched');
      void card.offsetWidth; // force reflow to restart animation
      card.classList.add('duplicate-flash');
      card.addEventListener('animationend', () => {
        card.classList.remove('duplicate-flash');
        markTouched(id);
      }, { once: true });
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
  const slug = StateService_slugify(name);

  // Optimistic: immediately add placeholder card
  if (!branches.find(b => b.id === slug)) {
    branches.push({
      id: slug, branch: name, worktreePath: '',
      services: {}, status: 'idle', createdAt: new Date().toISOString(),
      subject: '', _optimistic: true,
    });
    markTouched(slug);
    renderBranches();
    requestAnimationFrame(() => {
      const card = document.querySelector(`.branch-card[data-branch-id="${CSS.escape(slug)}"]`);
      if (card) card.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
  }

  // Server request in background
  try {
    await api('POST', '/branches', { branch: name });
    showToast(`分支 "${name}" 已添加`, 'success');
  } catch (e) {
    // Rollback optimistic add on failure
    branches = branches.filter(b => b.id !== slug || !b._optimistic);
    renderBranches();
    showToast(e.message, 'error');
    return;
  }
  await loadBranches();
}

// ── Container capacity check ──

function getNewContainerCount(branchId, profileId) {
  const br = branches.find(b => b.id === branchId);
  if (profileId) {
    // Single service deploy: only adds 1 if not already running
    const svc = br?.services?.[profileId];
    return (!svc || svc.status === 'idle' || svc.status === 'stopped' || svc.status === 'error') ? 1 : 0;
  }
  // Full deploy: count services that are not already running
  const alreadyRunning = br ? Object.values(br.services).filter(s =>
    s.status === 'running' || s.status === 'building' || s.status === 'starting'
  ).length : 0;
  return Math.max(0, buildProfiles.length - alreadyRunning);
}

/**
 * Find all running branches except excludeId, sorted by earliest started first.
 * Uses lastAccessedAt (set on deploy) as the deploy timestamp.
 */
function findRunningBranches(excludeId) {
  return branches
    .filter(b => b.id !== excludeId && (b.status === 'running' || b.status === 'starting'))
    .sort((a, b) => {
      // Color-marked branches are deprioritized (sorted to end) — they won't be stopped first
      const am = a.isColorMarked ? 1 : 0;
      const bm = b.isColorMarked ? 1 : 0;
      if (am !== bm) return am - bm;
      return new Date(a.lastAccessedAt || a.createdAt || 0) - new Date(b.lastAccessedAt || b.createdAt || 0);
    });
}

/**
 * Count how many running containers a branch has.
 */
function countRunningServices(br) {
  if (!br?.services) return 0;
  return Object.values(br.services).filter(s =>
    s.status === 'running' || s.status === 'building' || s.status === 'starting'
  ).length;
}

/**
 * Format a branch label for display in capacity modal.
 * Shows: tagIcon tag branchName (or just branchName if no tags).
 */
function branchDisplayLabel(br) {
  const tags = br.tags || [];
  const tagStr = tags.length > 0 ? `${ICON.tag} ${esc(tags[0])} ` : '';
  return `${tagStr}${esc(br.branch)}`;
}

function checkCapacityAndDeploy(id, profileId) {
  const newCount = getNewContainerCount(id, profileId);
  const afterDeploy = containerCapacity.runningContainers + newCount;
  if (newCount === 0 || afterDeploy <= containerCapacity.maxContainers) {
    // No new containers needed (redeploy) or within capacity — deploy directly
    if (profileId) deploySingleServiceDirect(id, profileId);
    else deployBranchDirect(id);
    return;
  }

  const runningBranches = findRunningBranches(id);
  const oldest = runningBranches[0];

  // Check if the oldest branch has all services running (fully occupied).
  // If so, stopping it frees exactly the containers we need — no partial warning needed.
  // But if a branch is partially running (e.g., 1 of 2), warn the user.
  const oldestServiceCount = oldest ? countRunningServices(oldest) : 0;
  const needsPartialWarning = oldest && oldestServiceCount > 0 && oldestServiceCount < buildProfiles.length;

  // Build dropdown list of all stoppable branches (oldest first)
  const stopListHtml = runningBranches.map(br => {
    const svcCount = countRunningServices(br);
    const svcLabel = svcCount < buildProfiles.length ? `(${svcCount}/${buildProfiles.length} 运行中)` : '';
    return `<div class="capacity-stop-item" onclick="capacityChoiceStopBranch('${esc(id)}', ${profileId ? `'${esc(profileId)}'` : 'null'}, '${esc(br.id)}')">
      <span class="capacity-stop-label">${branchDisplayLabel(br)}</span>
      ${svcLabel ? `<span class="capacity-stop-partial">${svcLabel}</span>` : ''}
    </div>`;
  }).join('');

  // Show capacity warning modal
  const html = `
    <div class="capacity-warning">
      <div class="capacity-warning-icon">⚠️</div>
      <div class="capacity-warning-text">
        <p>当前服务器内存 <strong>${containerCapacity.totalMemGB}GB</strong>，最多支持 <strong>${containerCapacity.maxContainers}</strong> 个容器。</p>
        <p>目前已有 <strong>${containerCapacity.runningContainers}</strong> 个容器运行中，本次部署需新增 <strong>${newCount}</strong> 个。</p>
        ${needsPartialWarning ? `<p style="color:var(--orange);margin-top:8px;">⚠ 最早的分支仅部分运行，停掉可能影响开发中的服务。</p>` : ''}
      </div>
      <div class="capacity-warning-actions">
        <button class="primary sm" onclick="capacityChoiceForce('${esc(id)}', ${profileId ? `'${esc(profileId)}'` : 'null'})">我偏要</button>
        ${oldest ? `
          <div class="capacity-stop-split">
            <button class="sm capacity-stop-btn" onclick="capacityChoiceStopBranch('${esc(id)}', ${profileId ? `'${esc(profileId)}'` : 'null'}, '${esc(oldest.id)}')">
              停掉 ${branchDisplayLabel(oldest)}
            </button>
            ${runningBranches.length > 1 ? `
              <button class="sm capacity-stop-toggle" onclick="toggleCapacityStopList(event)">
                <svg width="10" height="6" viewBox="0 0 10 6" fill="currentColor"><path d="M1 1l4 4 4-4"/></svg>
              </button>
              <div class="capacity-stop-list hidden" id="capacityStopList">
                <div class="capacity-stop-list-header">选择要停止的分支（最早启动排前）</div>
                ${stopListHtml}
              </div>
            ` : ''}
          </div>
        ` : ''}
        <button class="sm" onclick="closeConfigModal()">取消</button>
      </div>
    </div>
  `;
  openConfigModal('容器容量不足', html);
}

function toggleCapacityStopList(event) {
  event.stopPropagation();
  const list = document.getElementById('capacityStopList');
  if (list) list.classList.toggle('hidden');
}

function capacityChoiceForce(id, profileId) {
  closeConfigModal();
  if (profileId) deploySingleServiceDirect(id, profileId);
  else deployBranchDirect(id);
}

async function capacityChoiceStopBranch(id, profileId, stopId) {
  closeConfigModal();
  const stopBr = branches.find(b => b.id === stopId);
  const stopName = stopBr ? stopBr.branch : stopId;
  showToast(`正在停止分支 ${stopName}...`, 'info');
  // Set stopping state for visual feedback
  if (stopBr) {
    stopBr.status = 'stopping';
    for (const svc of Object.values(stopBr.services || {})) {
      if (svc.status === 'running' || svc.status === 'starting') svc.status = 'stopping';
    }
    renderBranches();
  }
  try {
    await api('POST', `/branches/${stopId}/stop`);
    await loadBranches();
    showToast(`已停止分支 ${stopName}`, 'success');
    if (profileId) deploySingleServiceDirect(id, profileId);
    else deployBranchDirect(id);
  } catch (e) {
    showToast(`停止失败: ${e.message}`, 'error');
  }
}

async function deployBranch(id) {
  checkCapacityAndDeploy(id, null);
}

async function deployBranchDirect(id) {
  if (busyBranches.has(id)) return;
  markTouched(id);
  busyBranches.add(id);
  // Clear previous error message immediately on new deploy
  const br = branches.find(b => b.id === id);
  if (br) { br.errorMessage = undefined; br.status = 'building'; }
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
            data.chunk.split('\n').filter(l => l.trim()).forEach(l => log.lines.push(l));
          } else if (data.step) {
            log.lines.push(`[${data.status}] ${data.title || data.step}`);
          } else if (data.message) {
            data.message.split('\n').filter(l => l.trim()).forEach(l => log.lines.push(l));
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
  inlineDeployLogs.delete(id);
  renderBranches();
}

function updateInlineLog(id) {
  const el = document.getElementById(`inline-log-${CSS.escape(id)}`);
  if (!el) return;
  const log = inlineDeployLogs.get(id);
  if (!log) return;
  const filtered = log.lines.filter(l => l.trim());
  const maxLines = log.expanded ? filtered.length : 20;
  const visibleLines = filtered.slice(-maxLines);
  el.textContent = visibleLines.join('\n');
  el.scrollTop = el.scrollHeight;
}


function openFullDeployLog(id, event) {
  event.stopPropagation();
  const log = inlineDeployLogs.get(id);
  if (!log) return;
  let isFirst = true;
  const renderInline = () => {
    const body = document.getElementById('logModalBody');
    const oldPre = body.querySelector('.live-log-output');
    const prevScrollTop = oldPre ? oldPre.scrollTop : 0;
    const wasAtBottom = oldPre
      ? (oldPre.scrollTop + oldPre.clientHeight >= oldPre.scrollHeight - 30)
      : true;
    const current = inlineDeployLogs.get(id);
    body.innerHTML = `<pre class="live-log-output">${esc(current ? current.lines.join('\n') : '暂无日志')}</pre>`;
    if (isFirst || wasAtBottom) {
      _scrollLogToBottom();
      isFirst = false;
    } else {
      const newPre = body.querySelector('.live-log-output');
      if (newPre) newPre.scrollTop = prevScrollTop;
    }
  };
  openLogModal(`部署日志 ${id}`, id);
  renderInline();
  _scrollLogToBottom();
  _startLogPoll(() => { renderInline(); return Promise.resolve(); }, 1000);
}

async function stopBranch(id) {
  if (busyBranches.has(id) || isLoading(id, 'stop')) return;
  markTouched(id);
  busyBranches.add(id);
  setLoading(id, 'stop');
  // Immediately set stopping state for visual feedback
  const br = branches.find(b => b.id === id);
  if (br) {
    br.status = 'stopping';
    for (const svc of Object.values(br.services || {})) {
      if (svc.status === 'running' || svc.status === 'starting') {
        svc.status = 'stopping';
      }
    }
  }
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

  // ── Mode: multi (subdomain) ──
  if (previewMode === 'multi' && previewDomain) {
    const url = `${location.protocol}//${slug}.${previewDomain}`;
    window.open(url, '_blank');
    return;
  }

  // ── Mode: port (direct port access — no proxy, no cache issues) ──
  if (previewMode === 'port') {
    const branch = branches.find(b => b.id === slug);
    if (!branch || branch.status !== 'running') {
      showToast('分支未运行，无法通过端口预览', 'error');
      return;
    }
    const services = Object.entries(branch.services || {});
    // Find the web/frontend service (first non-API service, or first service)
    const webService = services.find(([pid]) => !pid.includes('api') && !pid.includes('backend'))
      || services.find(([pid]) => pid.includes('web') || pid.includes('frontend') || pid.includes('admin'))
      || services[0];
    if (!webService) {
      showToast('未找到可预览的服务端口', 'error');
      return;
    }
    const [, svc] = webService;
    const url = `${location.protocol}//${location.hostname}:${svc.hostPort}`;
    window.open(url, '_blank');
    return;
  }

  // ── Mode: simple (cookie switch — set default + open main domain) ──
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
  const branch = branches.find(b => b.id === id);
  if (!branch) return;
  const newVal = !branch.isFavorite;

  // Optimistic UI: apply visual state immediately
  branch.isFavorite = newVal;
  const card = document.querySelector(`.branch-card[data-branch-id="${CSS.escape(id)}"]`);
  if (card) {
    card.classList.toggle('is-favorite', newVal);
    const toggle = card.querySelector('.fav-toggle');
    if (toggle) {
      toggle.classList.toggle('active', newVal);
      toggle.innerHTML = newVal ? ICON.star : ICON.starOutline;
    }
  }

  try {
    await api('PATCH', `/branches/${id}`, { isFavorite: newVal });
  } catch (e) {
    // Rollback
    branch.isFavorite = !newVal;
    if (card) {
      card.classList.toggle('is-favorite', !newVal);
      const toggle = card.querySelector('.fav-toggle');
      if (toggle) {
        toggle.classList.toggle('active', !newVal);
        toggle.innerHTML = !newVal ? ICON.star : ICON.starOutline;
      }
    }
    showToast(e.message, 'error');
  }
}

async function toggleColorMark(id, event) {
  event.stopPropagation();
  const branch = branches.find(b => b.id === id);
  if (!branch) return;
  const newVal = !branch.isColorMarked;
  const card = event.currentTarget.closest('.branch-card');
  const btn = event.currentTarget;

  // Optimistic UI: apply visual state immediately
  branch.isColorMarked = newVal;
  if (card) {
    card.classList.toggle('is-color-marked', newVal);
    btn.classList.toggle('active', newVal);
  }

  // Card-scoped ripple transition (cosmetic, non-blocking)
  if (card) {
    const cardRect = card.getBoundingClientRect();
    const btnRect = btn.getBoundingClientRect();
    const x = btnRect.left + btnRect.width / 2 - cardRect.left;
    const y = btnRect.top + btnRect.height / 2 - cardRect.top;
    const maxRadius = Math.ceil(Math.sqrt(
      Math.max(x, cardRect.width - x) ** 2 +
      Math.max(y, cardRect.height - y) ** 2
    ));

    const overlay = document.createElement('div');
    overlay.className = 'color-mark-ripple';
    overlay.style.setProperty('--cm-ripple-x', `${x}px`);
    overlay.style.setProperty('--cm-ripple-y', `${y}px`);
    overlay.style.setProperty('--cm-ripple-radius', `${maxRadius}px`);
    overlay.classList.add(newVal ? 'ripple-marked' : 'ripple-normal');
    card.appendChild(overlay);
    overlay.offsetHeight;
    overlay.classList.add('animate');
    overlay.addEventListener('animationend', () => overlay.remove(), { once: true });
  }

  // Persist in background — rollback on failure
  try {
    await api('PATCH', `/branches/${id}`, { isColorMarked: newVal });
  } catch (e) {
    // Rollback optimistic state
    branch.isColorMarked = !newVal;
    if (card) {
      card.classList.toggle('is-color-marked', !newVal);
      btn.classList.toggle('active', !newVal);
    }
    showToast(e.message, 'error');
  }
}

// ── Tag management ──

async function addTagToBranch(id, event) {
  event.stopPropagation();
  const tag = prompt('输入标签名称:');
  if (!tag || !tag.trim()) return;
  const trimmed = tag.trim();
  const branch = branches.find(b => b.id === id);
  if (!branch) return;
  const tags = [...(branch.tags || [])];
  if (tags.includes(trimmed)) { showToast('标签已存在', 'info'); return; }
  tags.push(trimmed);
  // Optimistic update
  branch.tags = tags;
  renderBranches();
  renderTagFilterBar();
  try {
    await api('PATCH', `/branches/${id}`, { tags });
  } catch (e) {
    branch.tags = tags.filter(t => t !== trimmed);
    renderBranches();
    renderTagFilterBar();
    showToast(e.message, 'error');
  }
}

async function removeTagFromBranch(id, tag, event) {
  event.stopPropagation();
  if (!confirm(`确定删除标签「${tag}」？`)) return;
  const branch = branches.find(b => b.id === id);
  if (!branch) return;
  const oldTags = [...(branch.tags || [])];
  const tags = oldTags.filter(t => t !== tag);
  // Optimistic
  branch.tags = tags;
  renderBranches();
  renderTagFilterBar();
  try {
    await api('PATCH', `/branches/${id}`, { tags });
  } catch (e) {
    branch.tags = oldTags;
    renderBranches();
    renderTagFilterBar();
    showToast(e.message, 'error');
  }
}

function filterByTag(tag) {
  activeTagFilter = activeTagFilter === tag ? null : tag;
  renderTagFilterBar();
  renderBranches();
}

function getAllTags() {
  const tagSet = new Set();
  branches.forEach(b => (b.tags || []).forEach(t => tagSet.add(t)));
  return [...tagSet].sort();
}

function renderTagFilterBar() {
  const el = document.getElementById('tagFilterBar');
  if (!el) return;
  const allTags = getAllTags();
  if (allTags.length === 0) {
    el.classList.add('hidden');
    return;
  }
  el.classList.remove('hidden');
  el.innerHTML = allTags.map(t => `
    <span class="tag-filter-chip ${activeTagFilter === t ? 'active' : ''}" onclick="filterByTag('${esc(t)}')">
      ${ICON.tag} ${esc(t)}
    </span>
  `).join('');
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

async function factoryReset() {
  if (!confirm('⚠️ 恢复出厂设置\n\n将清除所有：分支、构建配置、环境变量、基础设施服务、路由规则。\nDocker 数据卷（数据库文件等）会保留。\n\n确定继续？')) return;
  if (!confirm('二次确认：所有配置将被清空，此操作不可撤销。')) return;
  globalBusy = true;
  renderBranches();
  try {
    const res = await fetch(`${API}/factory-reset`, { method: 'POST' });
    const reader = res.body.getReader();
    while (!(await reader.read()).done) {}
    showToast('已恢复出厂设置', 'success');
  } catch (e) { showToast(e.message, 'error'); }
  globalBusy = false;
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

async function pruneStaleBranches() {
  const html = `
    <div class="capacity-warning">
      <div class="capacity-warning-icon">🧹</div>
      <div class="capacity-warning-text">
        <p>删除本地 git 分支中不在 CDS 部署列表上的分支</p>
        <p style="color:var(--text-muted);font-size:12px">保护分支（main/master/develop/当前分支）不会被删除</p>
      </div>
      <pre id="pruneLog" style="text-align:left;font-size:11px;color:var(--text-secondary);background:rgba(8,12,28,0.6);border:1px solid var(--border);border-radius:var(--radius-sm);padding:10px 12px;margin:12px 0;max-height:200px;overflow-y:auto;white-space:pre-wrap;font-family:var(--font-mono)">正在扫描本地分支...</pre>
      <div class="capacity-warning-actions" id="pruneActions">
        <button class="sm" disabled><span class="btn-spinner"></span>扫描中...</button>
      </div>
    </div>
  `;
  openConfigModal('清理非列表分支', html);

  try {
    const res = await fetch(`${API}/prune-stale-branches`, { method: 'POST' });
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const logEl = document.getElementById('pruneLog');
    let pruneCount = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        if (line.startsWith('data: ')) {
          try {
            const data = JSON.parse(line.slice(6));
            if (data.title && logEl) {
              const prefix = data.status === 'error' ? '✗' : data.status === 'done' ? '✓' : data.status === 'info' ? 'ℹ' : '…';
              logEl.textContent += `\n[${prefix}] ${data.title}`;
              logEl.scrollTop = logEl.scrollHeight;
            }
            if (data.pruneCount !== undefined) pruneCount = data.pruneCount;
          } catch {}
        }
      }
    }

    const actionsEl = document.getElementById('pruneActions');
    if (actionsEl) {
      actionsEl.innerHTML = `<button class="primary sm" onclick="closeConfigModal()">完成 (${pruneCount} 个已清理)</button>`;
    }
    showToast(pruneCount > 0 ? `已清理 ${pruneCount} 个非列表分支` : '没有需要清理的分支', pruneCount > 0 ? 'success' : 'info');
  } catch (e) {
    showToast('清理失败: ' + e.message, 'error');
    const actionsEl = document.getElementById('pruneActions');
    if (actionsEl) {
      actionsEl.innerHTML = `<button class="sm" onclick="closeConfigModal()">关闭</button>`;
    }
  }
}

async function cleanupOrphans() {
  // Show progress in a modal with SSE streaming
  const html = `
    <div class="capacity-warning">
      <div class="capacity-warning-icon">🔍</div>
      <div class="capacity-warning-text">
        <p>正在拉取远程分支列表并检测孤儿分支...</p>
        <p style="color:var(--text-muted);font-size:12px">孤儿分支 = 本地存在但远程已删除的分支</p>
      </div>
      <pre id="orphanCleanupLog" style="text-align:left;font-size:11px;color:var(--text-secondary);background:rgba(8,12,28,0.6);border:1px solid var(--border);border-radius:var(--radius-sm);padding:10px 12px;margin:12px 0;max-height:200px;overflow-y:auto;white-space:pre-wrap;font-family:var(--font-mono)">正在获取远程分支信息...</pre>
      <div class="capacity-warning-actions" id="orphanCleanupActions">
        <button class="sm" disabled><span class="btn-spinner"></span>检测中...</button>
      </div>
    </div>
  `;
  openConfigModal('清理孤儿分支', html);

  try {
    const res = await fetch(`${API}/cleanup-orphans`, { method: 'POST' });
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const logEl = document.getElementById('orphanCleanupLog');
    let orphanCount = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const data = JSON.parse(line.slice(6));
          if (data.title && logEl) {
            const prefix = data.status === 'error' ? '✗' : data.status === 'done' ? '✓' : data.status === 'info' ? 'ℹ' : '…';
            logEl.textContent += `\n[${prefix}] ${data.title}`;
            logEl.scrollTop = logEl.scrollHeight;
          }
          if (data.orphanCount !== undefined) orphanCount = data.orphanCount;
        }
      }
    }

    const actionsEl = document.getElementById('orphanCleanupActions');
    if (actionsEl) {
      actionsEl.innerHTML = `<button class="primary sm" onclick="closeConfigModal()">完成 (${orphanCount} 个已清理)</button>`;
    }
    showToast(orphanCount > 0 ? `已清理 ${orphanCount} 个孤儿分支` : '没有发现孤儿分支', orphanCount > 0 ? 'success' : 'info');
    await loadBranches();
  } catch (e) {
    showToast('清理失败: ' + e.message, 'error');
    const actionsEl = document.getElementById('orphanCleanupActions');
    if (actionsEl) {
      actionsEl.innerHTML = `<button class="sm" onclick="closeConfigModal()">关闭</button>`;
    }
  }
}

async function viewBranchLogs(id) {
  // Active inline deploy log — poll from inlineDeployLogs
  const inlineLog = inlineDeployLogs.get(id);
  if (inlineLog) {
    let isFirst = true;
    const renderInline = () => {
      const body = document.getElementById('logModalBody');
      const oldPre = body.querySelector('.live-log-output');
      const prevScrollTop = oldPre ? oldPre.scrollTop : 0;
      const wasAtBottom = oldPre
        ? (oldPre.scrollTop + oldPre.clientHeight >= oldPre.scrollHeight - 30)
        : true;
      const current = inlineDeployLogs.get(id);
      body.innerHTML = `<pre class="live-log-output">${esc(current ? current.lines.join('\n') : '暂无日志')}</pre>`;
      if (isFirst || wasAtBottom) {
        _scrollLogToBottom();
        isFirst = false;
      } else {
        const newPre = body.querySelector('.live-log-output');
        if (newPre) newPre.scrollTop = prevScrollTop;
        checkLogErrors();
      }
    };
    openLogModal(`部署日志 — ${id}`, id);
    renderInline();
    _scrollLogToBottom();
    _startLogPoll(() => { renderInline(); return Promise.resolve(); }, 1000);
    return;
  }
  // Otherwise fetch historical operation logs from API
  let isFirst = true;
  const fetchAndRender = async () => {
    const data = await api('GET', `/branches/${encodeURIComponent(id)}/logs`);
    const logs = data.logs || [];
    if (logs.length === 0) {
      document.getElementById('logModalBody').innerHTML = '<div style="padding:16px;color:var(--text-muted)">暂无部署日志</div>';
      return;
    }
    const latest = logs[logs.length - 1];
    const logLines = (latest.events || []).map(ev => {
      const prefix = ev.status === 'error' ? '✗' : ev.status === 'done' ? '✓' : '…';
      let line = `[${prefix}] ${ev.title || ev.step}`;
      if (ev.log) line += '\n    ' + ev.log;
      return line;
    });
    const statusLabel = latest.status === 'completed' ? '成功' : latest.status === 'error' ? '失败' : '进行中';
    document.getElementById('logModalTitle').textContent = `部署日志 — ${id} (${statusLabel})`;
    const body = document.getElementById('logModalBody');
    const oldPre = body.querySelector('.live-log-output');
    const prevScrollTop = oldPre ? oldPre.scrollTop : 0;
    const wasAtBottom = oldPre
      ? (oldPre.scrollTop + oldPre.clientHeight >= oldPre.scrollHeight - 30)
      : true;
    body.innerHTML = `<pre class="live-log-output">${esc(logLines.join('\n') || '暂无日志')}</pre>`;
    if (isFirst || wasAtBottom) {
      _scrollLogToBottom();
      isFirst = false;
    } else {
      const newPre = body.querySelector('.live-log-output');
      if (newPre) newPre.scrollTop = prevScrollTop;
      checkLogErrors();
    }
  };
  try {
    openLogModal(`部署日志 — ${id}`, id);
    await fetchAndRender();
    _scrollLogToBottom();
    _startLogPoll(fetchAndRender, 3000);
  } catch (e) { showToast('获取日志失败: ' + e.message, 'error'); }
}

let _logStreamController = null;

async function viewContainerLogs(id, profileId) {
  // Abort any previous log stream
  if (_logStreamController) { _logStreamController.abort(); _logStreamController = null; }

  try {
    openLogModal(`日志: ${id}/${profileId || '默认'}`, id, profileId);
    const body = document.getElementById('logModalBody');
    body.innerHTML = '<pre class="live-log-output"></pre>';

    // Start SSE log stream
    const ac = new AbortController();
    _logStreamController = ac;
    const res = await fetch(`/api/branches/${id}/container-logs-stream/${profileId}`, {
      signal: ac.signal,
    });
    if (!res.ok) {
      // Fallback: one-shot fetch if SSE not available
      const data = await api('POST', `/branches/${id}/container-logs`, { profileId });
      body.innerHTML = `<pre class="live-log-output">${esc(data.logs || '暂无日志')}</pre>`;
      _scrollLogToBottom();
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    const processStream = async () => {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        // Parse SSE lines
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          try {
            const evt = JSON.parse(line.slice(6));
            if (evt.chunk) {
              const pre = body.querySelector('.live-log-output');
              if (!pre) break;
              const wasAtBottom = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 30;
              pre.textContent += evt.chunk;
              if (wasAtBottom) _scrollLogToBottom();
            }
          } catch { /* skip malformed */ }
        }
      }
    };

    processStream().catch(() => { /* stream closed */ });

    // Stop stream when modal closes
    const observer = new MutationObserver(() => {
      const modal = document.getElementById('logModal');
      if (modal && modal.classList.contains('hidden')) {
        ac.abort();
        observer.disconnect();
      }
    });
    observer.observe(document.getElementById('logModal'), { attributes: true, attributeFilter: ['class'] });

  } catch (e) {
    if (e.name !== 'AbortError') showToast(e.message, 'error');
  }
}

// ── Single-service deploy ──

function deploySingleService(id, profileId) {
  checkCapacityAndDeploy(id, profileId);
}

async function deploySingleServiceDirect(id, profileId) {
  if (busyBranches.has(id)) return;
  busyBranches.add(id);
  closeDeployMenu(id);
  // Clear previous error message immediately on new deploy
  const br = branches.find(b => b.id === id);
  if (br) { br.errorMessage = undefined; br.status = 'building'; }
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
            data.chunk.split('\n').filter(l => l.trim()).forEach(l => log.lines.push(l));
          } else if (data.step) {
            log.lines.push(`[${data.status}] ${data.title || data.step}`);
          } else if (data.message) {
            data.message.split('\n').filter(l => l.trim()).forEach(l => log.lines.push(l));
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
    <div class="settings-menu-item" onclick="closeSettingsMenu(); openImportModal()" style="color:#58a6ff">
      <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M8 2.004a.75.75 0 01.75.75v5.689l1.97-1.97a.749.749 0 111.06 1.06l-3.25 3.25a.749.749 0 01-1.06 0L4.22 7.533a.749.749 0 111.06-1.06l1.97 1.97V2.754a.75.75 0 01.75-.75zM2.75 12.5h10.5a.75.75 0 010 1.5H2.75a.75.75 0 010-1.5z"/></svg>
      一键导入配置
    </div>
    <div class="settings-menu-divider"></div>
    <div class="settings-menu-item" onclick="closeSettingsMenu(); openProfileModal()">
      <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M7.22 1.547a2.403 2.403 0 011.56 0l4.03 1.384a.48.48 0 01.33.457v1.224a.48.48 0 01-.33.457L8.78 6.453a2.403 2.403 0 01-1.56 0L3.19 5.069a.48.48 0 01-.33-.457V3.388a.48.48 0 01.33-.457l4.03-1.384zM3.19 6.903l4.03 1.384a2.403 2.403 0 001.56 0l4.03-1.384a.48.48 0 01.33.457v1.224a.48.48 0 01-.33.457L8.78 10.425a2.403 2.403 0 01-1.56 0L3.19 9.041a.48.48 0 01-.33-.457V7.36a.48.48 0 01.33-.457zm0 3.972l4.03 1.384a2.403 2.403 0 001.56 0l4.03-1.384a.48.48 0 01.33.457v1.224a.48.48 0 01-.33.457l-4.03 1.384a2.403 2.403 0 01-1.56 0l-4.03-1.384a.48.48 0 01-.33-.457v-1.224a.48.48 0 01.33-.457z"/></svg>
      构建配置
    </div>
    <div class="settings-menu-item" onclick="closeSettingsMenu(); openEnvModal()">
      <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M2.5 2a.5.5 0 00-.5.5v11a.5.5 0 00.5.5h11a.5.5 0 00.5-.5v-11a.5.5 0 00-.5-.5h-11zM1 2.5A1.5 1.5 0 012.5 1h11A1.5 1.5 0 0115 2.5v11a1.5 1.5 0 01-1.5 1.5h-11A1.5 1.5 0 011 13.5v-11zM4 5h2v1H4V5zm3 0h5v1H7V5zM4 8h2v1H4V8zm3 0h5v1H7V8zM4 11h2v1H4v-1zm3 0h5v1H7v-1z"/></svg>
      环境变量
    </div>
    <div class="settings-menu-item" onclick="closeSettingsMenu(); openInfraModal()">
      <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M2 2a2 2 0 012-2h8a2 2 0 012 2v2a2 2 0 01-2 2H4a2 2 0 01-2-2V2zm2-.5a.5.5 0 00-.5.5v2a.5.5 0 00.5.5h8a.5.5 0 00.5-.5V2a.5.5 0 00-.5-.5H4zM2 9.5A1.5 1.5 0 013.5 8h9A1.5 1.5 0 0114 9.5v3a1.5 1.5 0 01-1.5 1.5h-9A1.5 1.5 0 012 12.5v-3zm1.5 0v3h9v-3h-9zM4 10.5a.5.5 0 01.5-.5h1a.5.5 0 010 1h-1a.5.5 0 01-.5-.5z"/></svg>
      基础设施
      ${infraServices.some(s => s.status === 'running') ? '<span style="color:#3fb950;font-size:11px;margin-left:auto">● ' + infraServices.filter(s => s.status === 'running').length + ' 运行中</span>' : ''}
    </div>
    <div class="settings-menu-item" onclick="closeSettingsMenu(); openStartupSignalModal()">
      <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M8.834.066C7.494-.087 6.5 1.048 6.5 2.25v.5c0 1.329-.647 2.124-1.318 2.614-.328.24-.66.403-.918.508A1.75 1.75 0 003 7.25v3.5c0 .785.52 1.449 1.235 1.666.186.06.404.145.639.263.461.232.838.49 1.126.756V14.5a.75.75 0 001.5 0v-.329c.247-.075.502-.186.759-.334.364-.21.726-.503 1.051-.886.35-.413.645-.94.822-1.598.114-.424.26-.722.458-.963.2-.245.466-.437.838-.597A1.75 1.75 0 0012 8.25V4.25A1.75 1.75 0 0010.264 2.5h-.129c-.382 0-.733-.074-1.008-.18A2.43 2.43 0 018.834.066z"/></svg>
      启动成功标志
      ${buildProfiles.some(p => p.startupSignal) ? '<span style="color:#3fb950;font-size:11px;margin-left:auto">● 已配置</span>' : ''}
    </div>
    <div class="settings-menu-item" onclick="closeSettingsMenu(); openRoutingModal()">
      <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M8 0a8 8 0 100 16A8 8 0 008 0zM1.5 8a6.5 6.5 0 0113 0h-2.1a8.3 8.3 0 00-.4-2.2 9 9 0 00-1-1.9A4.5 4.5 0 017 7.5H4.5A8.3 8.3 0 001.5 8zm5.5 5.5a6.5 6.5 0 01-5.4-3h2.3c.3 1.2.8 2.2 1.5 3H7zm1-5.5a7.8 7.8 0 014-3.8c.5.6.9 1.2 1.2 1.8H8zm0 1h5.4a8.3 8.3 0 01-.3 2H8.9 8V9zm0 3h3.8c-.6 1.3-1.5 2.4-2.8 3A6.5 6.5 0 018 9z"/></svg>
      路由规则
    </div>
    <div class="settings-menu-item settings-menu-switch" onclick="cyclePreviewMode()">
      <span class="settings-menu-switch-label">预览模式</span>
      <span class="preview-mode-label" style="margin-left:auto;font-size:11px;color:#58a6ff;font-weight:500">${{ simple: '简洁', port: '端口直连', multi: '子域名' }[previewMode]}</span>
    </div>
    <div class="settings-menu-item settings-menu-switch" onclick="toggleMirror()">
      <span class="settings-menu-switch-label">镜像加速</span>
      <span class="settings-switch settings-switch-mirror ${mirrorEnabled ? 'on' : ''}">
        <span class="settings-switch-track">
          <span class="settings-switch-thumb"></span>
        </span>
      </span>
    </div>
    <div class="settings-menu-item settings-menu-switch" onclick="toggleTheme(event)">
      <span class="settings-menu-switch-label">白天模式</span>
      <span class="settings-switch settings-switch-theme ${cdsTheme === 'light' ? 'on' : ''}">
        <span class="settings-switch-track">
          <span class="settings-switch-thumb"></span>
        </span>
      </span>
    </div>
    <div class="settings-menu-item" onclick="closeSettingsMenu(); exportConfig()">
      <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M3.5 13a.5.5 0 01-.5-.5V3a.5.5 0 01.5-.5h5.586a.5.5 0 01.354.146l3.414 3.414a.5.5 0 01.146.354V12.5a.5.5 0 01-.5.5h-9zM3.5 1A1.5 1.5 0 002 2.5v11A1.5 1.5 0 003.5 15h9a1.5 1.5 0 001.5-1.5V6.414a1.5 1.5 0 00-.44-1.06L10.147 1.94A1.5 1.5 0 009.086 1.5H3.5z"/></svg>
      导出配置
    </div>
    <div class="settings-menu-item" onclick="closeSettingsMenu(); exportSkill()">
      <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M3.5 1.75a.25.25 0 01.25-.25h3.5a.75.75 0 000-1.5h-3.5A1.75 1.75 0 002 1.75v11.5c0 .966.784 1.75 1.75 1.75h8.5A1.75 1.75 0 0014 13.25v-6a.75.75 0 00-1.5 0v6a.25.25 0 01-.25.25h-8.5a.25.25 0 01-.25-.25V1.75z"/><path d="M11.78.22a.75.75 0 00-1.06 0L6.22 4.72a.75.75 0 000 1.06l.53.53-2.97 2.97a.75.75 0 101.06 1.06l2.97-2.97.53.53a.75.75 0 001.06 0l4.5-4.5a.75.75 0 000-1.06L11.78.22z"/></svg>
      导出部署技能
    </div>
    <div class="settings-menu-item" onclick="closeSettingsMenu(); openSelfUpdate()">
      <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M8 2.5a5.487 5.487 0 00-4.131 1.869l1.204 1.204A.25.25 0 014.896 6H1.25A.25.25 0 011 5.75V2.104a.25.25 0 01.427-.177l1.38 1.38A7.002 7.002 0 0114.95 7.16a.75.75 0 01-1.49.178A5.5 5.5 0 008 2.5zm6.294 5.505a.75.75 0 01.834.656 5.5 5.5 0 01-9.592 2.97l1.204-1.204a.25.25 0 00-.177-.427H3.354a.25.25 0 01-.354-.354l1.38-1.38A7.002 7.002 0 0014.95 7.16z"/><circle cx="8" cy="8" r="2"/></svg>
      自动更新
    </div>
    <div class="settings-menu-divider"></div>
    <div class="settings-menu-item danger" onclick="closeSettingsMenu(); pruneStaleBranches()">
      <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M1.5 3.25a2.25 2.25 0 113 2.122v5.256a2.251 2.251 0 11-1.5 0V5.372A2.25 2.25 0 011.5 3.25zm5.677-.177L9.573.677A.25.25 0 0110 .854V2.5h1A2.5 2.5 0 0113.5 5v5.628a2.251 2.251 0 11-1.5 0V5a1 1 0 00-1-1h-1v1.646a.25.25 0 01-.427.177L7.177 3.427a.25.25 0 010-.354z"/></svg>
      清理非列表分支
    </div>
    <div class="settings-menu-item danger" onclick="closeSettingsMenu(); cleanupOrphans()">
      <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M5 3.254V3.25a.75.75 0 01.75-.75h4.5a.75.75 0 01.75.75v.004a2.5 2.5 0 011.94 2.204l.089.713a.75.75 0 11-1.486.186l-.089-.714A1 1 0 0010.47 4.75H5.53a1 1 0 00-.984.893l-.089.714a.75.75 0 01-1.486-.186l.089-.714A2.5 2.5 0 015 3.254zM4.07 6.5l.7 5.95c.09.747.71 1.3 1.46 1.3h3.54c.75 0 1.37-.553 1.46-1.3l.7-5.95H4.07z"/></svg>
      清理孤儿分支
    </div>
    <div class="settings-menu-item danger" onclick="closeSettingsMenu(); cleanupAll()">
      <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M6.5 1.75a.25.25 0 01.25-.25h2.5a.25.25 0 01.25.25V3h-3V1.75zM11 3V1.75A1.75 1.75 0 009.25 0h-2.5A1.75 1.75 0 005 1.75V3H2.75a.75.75 0 000 1.5h.3l.8 8.2A1.75 1.75 0 005.6 14.5h4.8a1.75 1.75 0 001.75-1.8l.8-8.2h.3a.75.75 0 000-1.5H11z"/></svg>
      清理全部分支
    </div>
    <div class="settings-menu-item danger" onclick="closeSettingsMenu(); factoryReset()">
      <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M1.705 8.005a.75.75 0 0 1 .834.656 5.5 5.5 0 0 0 9.592 2.97l-1.204-1.204a.25.25 0 0 1 .177-.427h3.646a.25.25 0 0 1 .25.25v3.646a.25.25 0 0 1-.427.177l-1.38-1.38A7.002 7.002 0 0 1 1.05 8.84a.75.75 0 0 1 .656-.834ZM8 2.5a5.487 5.487 0 0 0-4.131 1.869l1.204 1.204A.25.25 0 0 1 4.896 6H1.25A.25.25 0 0 1 1 5.75V2.104a.25.25 0 0 1 .427-.177l1.38 1.38A7.002 7.002 0 0 1 14.95 7.16a.75.75 0 0 1-1.49.178A5.5 5.5 0 0 0 8 2.5Z"/></svg>
      恢复出厂设置
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
  // Save scroll position before re-render
  const scrollY = window.scrollY;
  const el = document.getElementById('branchList');
  const count = document.getElementById('branchCount');
  const modeLabel = cdsMode === 'scheduler' ? ' · 调度端' : cdsMode === 'executor' ? ' · 执行端' : '';
  count.textContent = `${branches.length} 个分支${modeLabel}`;

  if (branches.length === 0) {
    el.innerHTML = '<div class="empty-state">暂无分支，请在上方搜索并添加。</div>';
    window.scrollTo(0, scrollY);
    return;
  }

  // Tag filter bar
  renderTagFilterBar();

  // Filter by active tag
  const filteredBranches = activeTagFilter
    ? branches.filter(b => (b.tags || []).includes(activeTagFilter))
    : branches;

  if (filteredBranches.length === 0 && branches.length > 0) {
    el.innerHTML = `<div class="empty-state">没有匹配标签「${esc(activeTagFilter)}」的分支</div>`;
    window.scrollTo(0, scrollY);
    return;
  }

  el.innerHTML = filteredBranches.map(b => {
    const isBusy = busyBranches.has(b.id) || globalBusy;
    const isDefault = b.id === defaultBranch;
    const services = Object.entries(b.services || {});
    const hasError = b.status === 'error';
    const isRunning = b.status === 'running';
    const isStopping = b.status === 'stopping';
    const isStopped = !isRunning && !isStopping && services.length > 0 && !hasError && b.status !== 'building';
    const hasMultipleProfiles = buildProfiles.length > 1;
    const hasUpdates = !!branchUpdates[b.id];

    // Loading state helpers for this branch
    const btnDisabled = (action) => (isBusy || isLoading(b.id, action)) ? 'disabled' : '';
    const btnLabel = (action, label) => isLoading(b.id, action) ? `<span class="btn-spinner"></span>${label}` : label;

    // Build deploy dropdown items for single-service redeploy
    const deployMenuItems = buildProfiles.map(p =>
      `<div class="deploy-menu-item" onclick="deploySingleService('${esc(b.id)}', '${esc(p.id)}')">${esc(p.name)}</div>`
    ).join('');

    // Build stop menu item for deploy dropdown
    const stopMenuItem = isRunning ? `<div class="deploy-menu-divider"></div><div class="deploy-menu-item deploy-menu-item-danger" onclick="event.stopPropagation(); closeDeployMenu('${esc(b.id)}'); stopBranch('${esc(b.id)}')">停止所有服务</div>` : '';

    // Port badges — icon + name:port, icon from profile config
    const portBadgesHtml = services.length > 0 ? services.map(([pid, svc]) => {
      const profile = buildProfiles.find(p => p.id === pid);
      const icon = getPortIcon(pid, profile);
      const badgeClass = svc.status === 'running' ? 'run-port' : svc.status === 'starting' ? 'port-starting' : svc.status === 'stopping' ? 'port-stopping' : svc.status === 'building' ? 'port-building' : svc.status === 'error' ? 'port-error' : 'port-idle';
      const portTitle = `${esc(pid)}: ${statusLabel(svc.status)}${b.lastAccessedAt ? '\n运行时间: ' + relativeTime(b.lastAccessedAt) : ''}`;
      return `<span class="port-badge ${badgeClass}"
                    onclick="event.stopPropagation(); viewContainerLogs('${esc(b.id)}', '${esc(pid)}')"
                    title="${portTitle}">
                ${icon} ${esc(pid)}:${svc.hostPort}
              </span>`;
    }).join('') : '';

    // Tags — shown below header
    const branchTags = b.tags || [];
    const tagsHtml = `
      <div class="branch-tags-line">
        ${branchTags.map(t => `
          <span class="branch-tag" onclick="event.stopPropagation(); filterByTag('${esc(t)}')" title="筛选标签: ${esc(t)}">
            ${ICON.tag} ${esc(t)}
            <span class="branch-tag-remove" onclick="event.stopPropagation(); removeTagFromBranch('${esc(b.id)}', '${esc(t)}', event)" title="删除标签">&times;</span>
          </span>
        `).join('')}
        <span class="branch-tag-add" onclick="addTagToBranch('${esc(b.id)}', event)" title="添加标签">+ 标签</span>
      </div>
    `;

    // Actions row: left = safe actions, right = dangerous actions
    // When container not running (stopped/idle): only show deploy button
    let actionsLeftHtml = '';
    let actionsRightHtml = '';

    if (isStopping) {
      actionsLeftHtml = `
        <button class="sm" disabled><span class="btn-spinner"></span>正在停止...</button>
      `;
      actionsRightHtml = '';
    } else if (isRunning) {
      actionsLeftHtml = `
        <button class="preview sm" onclick="previewBranch('${esc(b.id)}')" title="Preview">${ICON.preview}</button>
      `;
      actionsRightHtml = `
        <div class="split-btn">
          <button class="sm split-btn-main" onclick="deployBranch('${esc(b.id)}')" ${isBusy ? 'disabled' : ''} title="重新部署">${ICON.deploy} 部署</button>
          <button class="sm split-btn-toggle" onclick="toggleDeployMenu('${esc(b.id)}', event)" ${isBusy ? 'disabled' : ''}>
            <svg width="10" height="6" viewBox="0 0 10 6" fill="currentColor"><path d="M1 1l4 4 4-4"/></svg>
          </button>
          <template id="deploy-menu-tpl-${esc(b.id)}">
            ${hasMultipleProfiles ? `<div class="deploy-menu-header">选择重部署的服务</div>${deployMenuItems}` : ''}
            <div class="deploy-menu-item" onclick="event.stopPropagation(); closeDeployMenu('${esc(b.id)}'); viewBranchLogs('${esc(b.id)}')"><svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" style="vertical-align:-1px;margin-right:4px"><path d="M1 2.75C1 1.784 1.784 1 2.75 1h10.5c.966 0 1.75.784 1.75 1.75v7.5A1.75 1.75 0 0113.25 12H9.06l-2.573 2.573A1.458 1.458 0 014 13.543V12H2.75A1.75 1.75 0 011 10.25v-7.5zm1.5 0a.25.25 0 01.25-.25h10.5a.25.25 0 01.25.25v7.5a.25.25 0 01-.25.25h-4.5a.75.75 0 00-.75.75v2.19l-2.72-2.72a.75.75 0 00-.53-.22H2.75a.25.25 0 01-.25-.25v-7.5z"/></svg>部署日志</div>
            ${stopMenuItem}
            <div class="deploy-menu-divider"></div>
            <div class="deploy-menu-item deploy-menu-item-danger" onclick="event.stopPropagation(); closeDeployMenu('${esc(b.id)}'); removeBranch('${esc(b.id)}')">${ICON.trash} 删除分支</div>
          </template>
        </div>
      `;
    } else if (isStopped) {
      // Container exists but stopped — neutral deploy, not primary
      actionsLeftHtml = `
        <button class="sm" onclick="deployBranch('${esc(b.id)}')" ${isBusy ? 'disabled' : ''} title="部署">${ICON.deploy} 部署</button>
      `;
      actionsRightHtml = `
        <button class="sm danger" onclick="removeBranch('${esc(b.id)}')" ${isBusy ? 'disabled' : ''}>${ICON.trash}</button>
      `;
    } else {
      // Idle (never deployed) or building — neutral deploy button
      actionsLeftHtml = `
        <button class="sm" onclick="deployBranch('${esc(b.id)}')" ${isBusy ? 'disabled' : ''} title="部署">${ICON.deploy} 部署</button>
      `;
      actionsRightHtml = `
        ${hasError ? `<button class="sm" onclick="resetBranch('${esc(b.id)}')" ${btnDisabled('reset')}>${btnLabel('reset', ICON.reset + ' 重置')}</button>` : ''}
        <button class="sm danger" onclick="removeBranch('${esc(b.id)}')" ${isBusy ? 'disabled' : ''}>${ICON.trash}</button>
      `;
    }

    const deployLog = inlineDeployLogs.get(b.id);
    const isDeploying = !!deployLog && deployLog.status === 'building';
    const deployFailed = !!deployLog && deployLog.status === 'error';
    const isJustDeployed = justDeployed.has(b.id);

    // Commit area in actions row — shows commit info or deploy log during deployment
    let commitAreaHtml = '';
    if (isDeploying && deployLog) {
      const compactLines = deployLog.lines.filter(l => l.trim()).slice(-2);
      commitAreaHtml = `
        <div class="branch-actions-deploy-status" title="部署中，点击查看完整日志" onclick="event.stopPropagation(); openFullDeployLog('${esc(b.id)}', event)">
          <span class="live-dot"></span>
          <pre class="deploy-status-log">${esc(compactLines.join('\n')) || '正在启动...'}</pre>
        </div>
      `;
    } else if (b.subject) {
      commitAreaHtml = `
        <div class="branch-actions-commit" onclick="event.stopPropagation(); toggleCommitLog('${esc(b.id)}', this)" title="点击查看历史提交">
          ${commitIcon(b.subject)} ${esc(b.subject)}
          <svg class="commit-chevron" width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M4.427 5.427a.75.75 0 011.146 0L8 7.854l2.427-2.427a.75.75 0 111.146 1.146l-3 3a.75.75 0 01-1.146 0l-3-3a.75.75 0 010-1.146z"/></svg>
        </div>
      `;
    }

    // Inline deploy log was removed (squeezes card layout).
    // Deploy logs are accessible via the log button in toolbar.

    return `
      <div class="branch-card status-${b.status || 'idle'} ${isDefault ? 'active' : ''} ${isBusy ? 'is-busy' : ''} ${hasError ? 'has-error' : ''} expanded ${b.isFavorite ? 'is-favorite' : ''} ${hasUpdates ? 'has-updates' : ''} ${recentlyTouched.has(b.id) ? 'recently-touched' : ''} ${isDeploying ? 'is-deploying' : ''} ${b.isColorMarked ? 'is-color-marked' : ''} ${getAiOccupant(b.id) ? 'is-ai-occupied' : ''}" data-branch-id="${esc(b.id)}">
        ${isDeploying ? '<div class="deploy-progress-bar"><div class="deploy-progress-bar-fill"></div></div>' : ''}
        <div class="branch-card-toolbar">
          ${!isBusy ? `<span class="update-pull-group" onclick="event.stopPropagation(); pullBranch('${esc(b.id)}')" title="${hasUpdates ? branchUpdates[b.id].behind + ' 个新提交，点击拉取' : '点击拉取最新代码'}">
            ${hasUpdates ? `<span class="update-badge">↓${branchUpdates[b.id].behind}</span>` : ''}
            <svg class="update-pull-icon ${isLoading(b.id, 'pull') ? 'spinning' : ''}" width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M8 2.5a5.487 5.487 0 00-4.131 1.869l1.204 1.204A.25.25 0 014.896 6H1.25A.25.25 0 011 5.75V2.104a.25.25 0 01.427-.177l1.38 1.38A7.002 7.002 0 0115 8a.75.75 0 01-1.5 0A5.5 5.5 0 008 2.5zM2.5 8a.75.75 0 00-1.5 0 7.002 7.002 0 0012.023 4.87l1.38 1.38a.25.25 0 00.427-.177V10.5a.25.25 0 00-.25-.25h-3.646a.25.25 0 00-.177.427l1.204 1.204A5.5 5.5 0 012.5 8z"/></svg>
          </span>` : ''}
          ${(() => {
            const occupant = getAiOccupant(b.id);
            if (occupant) {
              return `<button class="color-mark-btn ai-mark active" title="AI 操控中: ${esc(occupant)}">
                <svg class="ai-mark-spinner" width="18" height="18" viewBox="0 0 18 18" fill="none">
                  <defs>
                    <linearGradient id="aiGrad${esc(b.id)}" x1="0" y1="0" x2="1" y2="1">
                      <stop offset="0%" stop-color="#a78bfa"/>
                      <stop offset="50%" stop-color="#60a5fa"/>
                      <stop offset="100%" stop-color="#c084fc"/>
                    </linearGradient>
                  </defs>
                  <circle cx="9" cy="9" r="7.5" stroke="url(#aiGrad${esc(b.id)})" stroke-width="1.5" fill="none" stroke-dasharray="12 6" />
                  <text x="9" y="9" text-anchor="middle" dominant-baseline="central" fill="url(#aiGrad${esc(b.id)})" font-size="7" font-weight="800" letter-spacing="0.3">AI</text>
                </svg>
              </button>`;
            }
            return `<button class="color-mark-btn ${b.isColorMarked ? 'active' : ''}" onclick="toggleColorMark('${esc(b.id)}', event)" title="${b.isColorMarked ? '取消调试标记' : '标记为调试中'}">
              ${ICON.lightbulb}
            </button>`;
          })()}
          ${ICON.footprint}
        </div>
        <div class="branch-card-header">
          <div class="branch-card-row1">
            <span class="status-dot status-dot-${b.status || 'idle'}" title="${statusLabel(b.status || 'idle')}"></span>
            <span class="fav-toggle ${b.isFavorite ? 'active' : ''}" onclick="event.stopPropagation(); toggleFavorite('${esc(b.id)}')" title="${b.isFavorite ? '取消收藏' : '收藏'}">
              ${b.isFavorite ? ICON.star : ICON.starOutline}
            </span>
            <a class="branch-name" href="${githubRepoUrl ? githubRepoUrl.replace('github.com', 'github.dev') + '/tree/' + encodeURIComponent(b.branch) : '#'}" target="_blank" onclick="event.stopPropagation(); return confirmOpenGithub(event)" title="在 GitHub.dev 中浏览代码">${ICON.branch} ${esc(b.branch)}</a>
          </div>
          ${b.subject ? `<div class="branch-card-row2"><span class="branch-commit-msg" title="${esc(b.subject)}">${commitIcon(b.subject)} ${esc(b.subject)}</span></div>` : ''}
          ${portBadgesHtml ? `<div class="branch-card-ports">${portBadgesHtml}</div>` : ''}
          ${b.executorId ? `<span class="executor-tag" title="部署在执行器 ${esc(b.executorId)}">⚡ ${esc(b.executorId.replace(/^executor-/, '').slice(0, 20))}</span>` : ''}
        </div>
        ${b.errorMessage && !deployLog ? `<div class="branch-error" title="${esc(b.errorMessage)}">${esc(b.errorMessage)}</div>` : ''}
        <div class="branch-card-body">
          ${tagsHtml}
          ${renderAiBranchFeed(b.id)}
          <div class="branch-card-actions-row">
            <div class="branch-actions-left">
              ${actionsLeftHtml}
            </div>
            ${commitAreaHtml}
            <div class="branch-actions-right ${isJustDeployed ? 'slide-in-right' : ''}">
              ${actionsRightHtml}
            </div>
          </div>
        </div>
      </div>
    `;
  }).join('');

  // Restore scroll position after re-render
  window.scrollTo(0, scrollY);

  // Re-apply preview activity spinners (cards were rebuilt)
  for (const branchId of previewingBranches.keys()) {
    const card = document.querySelector(`.branch-card[data-branch-id="${branchId}"]`);
    if (card) card.classList.add('is-previewing');
  }
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

// ── Config Import / Export ──

function openImportModal() {
  const html = `
    <p class="config-panel-desc">
      粘贴由 <code>/cds-scan</code> 生成的 CDS Compose YAML，或从其他 CDS 实例导出的配置。
      支持 YAML（推荐）和 JSON 两种格式，粘贴后会自动识别。
    </p>
    <textarea id="importConfigTextarea" class="bulk-textarea" rows="14" placeholder="services:\n  api:\n    image: node:20-slim\n    working_dir: /app\n    volumes: ['./src:/app']\n    ports: ['3000']\n    command: npm install && npm start\n    depends_on:\n      mongodb: { condition: service_healthy }\n    environment:\n      MONGO_URL: 'mongodb://\${CDS_HOST}:\${CDS_MONGODB_PORT}'\n    labels:\n      cds.path-prefix: '/api/'\n  mongodb:\n    image: mongo:7\n    ports: ['27017']\n    healthcheck:\n      test: mongosh --eval 'db.runCommand({ping:1})'\n      interval: 10s\n      retries: 3"
    ></textarea>
    <div id="importPreview" style="margin-top:8px"></div>
    <div class="form-row" style="margin-top:8px;gap:6px">
      <button class="primary sm" onclick="previewImportConfig()">验证 & 预览</button>
      <button class="sm" id="importApplyBtn" disabled onclick="applyImportConfig()">仅导入配置</button>
      <button class="sm accent" id="importInitBtn" disabled onclick="importAndInit()">导入并初始化</button>
      <button class="sm" onclick="closeConfigModal()">取消</button>
    </div>
    <div style="margin-top:4px;font-size:11px;color:var(--fg-muted)">
      「仅导入配置」只写入配置不启动服务；「导入并初始化」会自动启动基础设施、创建主分支并部署。
    </div>
  `;
  openConfigModal('一键导入配置', html);
}

async function previewImportConfig() {
  const textarea = document.getElementById('importConfigTextarea');
  const previewDiv = document.getElementById('importPreview');
  const applyBtn = document.getElementById('importApplyBtn');
  const initBtn = document.getElementById('importInitBtn');

  const raw = textarea.value.trim();
  if (!raw) {
    previewDiv.innerHTML = '<div style="color:var(--red);font-size:13px">请粘贴配置内容</div>';
    applyBtn.disabled = true;
    if (initBtn) initBtn.disabled = true;
    return;
  }

  // Auto-detect format: if starts with '{' → JSON object, otherwise send as YAML string
  let config;
  if (raw.startsWith('{')) {
    try {
      config = JSON.parse(raw);
    } catch (e) {
      previewDiv.innerHTML = '<div style="color:var(--red);font-size:13px">JSON 格式错误: ' + esc(e.message) + '</div>';
      applyBtn.disabled = true;
      if (initBtn) initBtn.disabled = true;
      return;
    }
  } else {
    // Send as raw string — backend will parse as CDS Compose YAML
    config = raw;
  }

  try {
    const data = await api('POST', '/import-config', { config, dryRun: true });
    if (!data.valid) {
      previewDiv.innerHTML = '<div style="color:var(--red);font-size:13px">验证失败:<ul>' +
        (data.errors || []).map(e => '<li>' + esc(e) + '</li>').join('') + '</ul></div>';
      applyBtn.disabled = true;
      if (initBtn) initBtn.disabled = true;
      return;
    }

    const p = data.preview;
    let summaryHtml = '<div style="font-size:13px;background:var(--bg-tertiary);padding:10px 12px;border-radius:6px;margin-top:4px">';
    summaryHtml += '<div style="color:#3fb950;margin-bottom:4px">✓ 验证通过，预览变更：</div>';

    function sectionSummary(label, section) {
      if (!section || (section.add === 0 && section.replace === 0 && section.skip === 0)) return '';
      const parts = [];
      if (section.add > 0) parts.push('<span style="color:#3fb950">+' + section.add + ' 新增</span>');
      if (section.replace > 0) parts.push('<span style="color:#d29922">⟳' + section.replace + ' 替换</span>');
      if (section.skip > 0) parts.push('<span style="color:#8b949e">⊘' + section.skip + ' 跳过</span>');
      return '<div style="margin:4px 0"><strong>' + label + '</strong>: ' + parts.join(' ') + '</div>';
    }

    summaryHtml += sectionSummary('构建配置', p.buildProfiles);
    summaryHtml += sectionSummary('环境变量', p.envVars);
    summaryHtml += sectionSummary('基础设施', p.infraServices);
    summaryHtml += sectionSummary('路由规则', p.routingRules);

    // Show detail items
    const allItems = [
      ...(p.buildProfiles?.items || []),
      ...(p.envVars?.items || []),
      ...(p.infraServices?.items || []),
      ...(p.routingRules?.items || []),
    ];
    if (allItems.length > 0 && allItems.length <= 20) {
      summaryHtml += '<div style="margin-top:6px;font-size:11px;color:var(--fg-muted)">';
      allItems.forEach(item => { summaryHtml += '<div>· ' + esc(item) + '</div>'; });
      summaryHtml += '</div>';
    }

    summaryHtml += '</div>';
    previewDiv.innerHTML = summaryHtml;
    applyBtn.disabled = false;
    if (initBtn) initBtn.disabled = false;
  } catch (e) {
    previewDiv.innerHTML = '<div style="color:var(--red);font-size:13px">' + esc(e.message) + '</div>';
    applyBtn.disabled = true;
    if (initBtn) initBtn.disabled = true;
  }
}

async function applyImportConfig() {
  const textarea = document.getElementById('importConfigTextarea');
  const raw = textarea.value.trim();
  if (!raw) return;

  // Same auto-detect as preview
  let config;
  if (raw.startsWith('{')) {
    try { config = JSON.parse(raw); } catch { return; }
  } else {
    config = raw;
  }

  try {
    const data = await api('POST', '/import-config', { config, dryRun: false });
    showToast(data.message || '配置已导入', 'success');
    // Refresh all data
    await Promise.all([loadProfiles(), loadEnvVars(), loadInfraServices(), loadRoutingRules()]);
    closeConfigModal();
  } catch (e) {
    showToast('导入失败: ' + e.message, 'error');
  }
}

async function importAndInit() {
  const textarea = document.getElementById('importConfigTextarea');
  if (!textarea) return;
  const raw = textarea.value.trim();
  if (!raw) return;

  let config;
  if (raw.startsWith('{')) {
    try { config = JSON.parse(raw); } catch { return; }
  } else {
    config = raw;
  }

  // Switch modal to progress view
  const modalBody = document.getElementById('configModalBody');
  if (!modalBody) return;

  modalBody.innerHTML = `
    <div id="initProgressContainer" style="min-height:300px">
      <div style="margin-bottom:12px;font-size:14px;font-weight:600">正在初始化项目...</div>
      <div id="initSteps" style="font-size:13px"></div>
      <pre id="initLog" class="live-log-output" style="margin-top:8px;max-height:200px;overflow-y:auto;font-size:11px;display:none"></pre>
      <div id="initResult" style="margin-top:12px;display:none"></div>
    </div>
  `;

  const stepsEl = document.getElementById('initSteps');
  const logEl = document.getElementById('initLog');
  const resultEl = document.getElementById('initResult');
  const stepStates = {};

  function updateStep(step, status, title) {
    const icon = status === 'running' ? '<span class="live-dot"></span>' :
                 status === 'done' ? '<span style="color:#3fb950">✓</span>' :
                 status === 'error' ? '<span style="color:#f85149">✗</span>' :
                 '<span style="color:#8b949e">○</span>';

    if (!stepStates[step]) {
      stepStates[step] = { el: document.createElement('div'), status };
      stepStates[step].el.style.cssText = 'padding:3px 0;display:flex;align-items:center;gap:6px';
      stepsEl.appendChild(stepStates[step].el);
    }
    stepStates[step].status = status;
    stepStates[step].el.innerHTML = icon + ' ' + esc(title);
  }

  try {
    const res = await fetch(API + '/import-and-init', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ config }),
    });

    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || data.errors?.join(', ') || `HTTP ${res.status}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let finalStatus = 'done';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split('\n');
      buffer = lines.pop();

      for (const line of lines) {
        if (line.startsWith('event: ')) continue;
        if (line.startsWith('data: ')) {
          try {
            const data = JSON.parse(line.slice(6));
            if (data.step) {
              updateStep(data.step, data.status, data.title);
            }
            if (data.chunk) {
              logEl.style.display = 'block';
              logEl.textContent += data.chunk;
              logEl.scrollTop = logEl.scrollHeight;
            }
            if (data.status === 'error') finalStatus = 'error';
          } catch { /* skip parse errors */ }
        }
      }
    }

    resultEl.style.display = 'block';
    if (finalStatus === 'done') {
      resultEl.innerHTML = `
        <div style="color:#3fb950;font-weight:600;margin-bottom:8px">初始化完成</div>
        <button class="primary sm" onclick="closeConfigModal(); loadBranches(); loadInfraServices();">完成</button>
      `;
    } else {
      resultEl.innerHTML = `
        <div style="color:#f85149;font-weight:600;margin-bottom:8px">初始化过程中出现错误</div>
        <button class="sm" onclick="closeConfigModal(); loadBranches(); loadInfraServices();">关闭</button>
      `;
    }

    // Refresh data in background
    await Promise.all([loadProfiles(), loadEnvVars(), loadInfraServices(), loadRoutingRules(), loadBranches()]);
  } catch (e) {
    if (resultEl) {
      resultEl.style.display = 'block';
      resultEl.innerHTML = `
        <div style="color:#f85149;font-weight:600;margin-bottom:4px">初始化失败</div>
        <div style="color:#f85149;font-size:12px;margin-bottom:8px">${esc(e.message)}</div>
        <button class="sm" onclick="closeConfigModal()">关闭</button>
      `;
    } else {
      showToast('初始化失败: ' + e.message, 'error');
      closeConfigModal();
    }
  }
}

async function exportConfig() {
  try {
    // Fetch as YAML (primary format)
    const resp = await fetch(API + '/export-config?format=yaml');
    if (!resp.ok) throw new Error('导出失败');
    const yamlText = await resp.text();

    // Copy to clipboard
    try {
      await navigator.clipboard.writeText(yamlText);
      showToast('配置已复制到剪贴板 (Compose YAML)', 'success');
    } catch {
      // Fallback: show in modal
      openConfigModal('导出配置', `
        <p class="config-panel-desc">当前 CDS 配置（Compose YAML 格式，可复制分享或备份）：</p>
        <textarea class="bulk-textarea" rows="16" readonly onclick="this.select()">${esc(yamlText)}</textarea>
        <div class="form-row" style="margin-top:8px">
          <button class="sm" onclick="closeConfigModal()">关闭</button>
        </div>
      `);
    }
  } catch (e) {
    showToast('导出失败: ' + e.message, 'error');
  }
}

async function exportSkill() {
  try {
    showToast('正在打包部署技能...', 'info');
    const resp = await fetch(API + '/export-skill');
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({ error: '导出失败' }));
      throw new Error(err.error || '导出失败');
    }
    const blob = await resp.blob();
    const disposition = resp.headers.get('Content-Disposition') || '';
    const match = disposition.match(/filename="?([^"]+)"?/);
    const filename = match ? match[1] : 'cds-deployment-skill.tar.gz';
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    showToast('部署技能包已下载', 'success');
  } catch (e) {
    showToast('导出失败: ' + e.message, 'error');
  }
}

// ── Self-update: switch branch + pull + restart ──

async function openSelfUpdate() {
  // Fetch branch list
  let data;
  try {
    data = await api('GET', '/self-branches');
  } catch (e) {
    showToast('获取分支列表失败: ' + e.message, 'error');
    return;
  }

  const { current, branches } = data;
  const branchItems = branches.map(b =>
    `<div class="combobox-item${b === current ? ' active' : ''}" data-value="${esc(b)}" onclick="selectComboItem(this)">
      ${b === current ? '<span style="color:var(--green);margin-right:4px">✓</span>' : ''}${esc(b)}${b === current ? ' <span style="color:var(--fg-muted);font-size:11px">(当前)</span>' : ''}
    </div>`
  ).join('');

  openConfigModal('自动更新', `
    <p class="config-panel-desc">
      切换 CDS 代码分支并重启。操作流程：<code>git fetch → git checkout → git pull → restart</code>
    </p>
    <div class="form-row" style="flex-direction:column;align-items:stretch">
      <label class="form-label">目标分支</label>
      <div class="combobox" id="selfUpdateCombobox">
        <div class="combobox-input-wrap">
          <input id="selfUpdateBranch" class="form-input" style="width:100%;padding-right:36px"
            value="${esc(current)}" placeholder="输入或选择分支名" autocomplete="off"
            onfocus="openComboDropdown()" oninput="filterComboItems(this.value)">
          <button type="button" class="combobox-toggle" onclick="toggleComboDropdown()" tabindex="-1">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 6 8 10 12 6"/></svg>
          </button>
        </div>
        <div class="combobox-dropdown" id="selfUpdateDropdown">
          ${branchItems}
        </div>
      </div>
    </div>
    <div class="form-row" style="margin-top:4px;font-size:12px;color:var(--fg-muted)">
      当前分支：<code>${esc(current)}</code>
    </div>
    <div id="selfUpdateProgress" style="display:none;margin-top:12px">
      <div id="selfUpdateSteps" style="display:flex;flex-direction:column;gap:6px"></div>
      <div id="selfUpdateStatus" style="margin-top:8px;font-size:13px"></div>
    </div>
    <div class="form-row" style="margin-top:12px;display:flex;gap:8px;align-items:center">
      <button class="sm" id="selfUpdateBtn" onclick="executeSelfUpdate()">更新并重启</button>
      <button class="sm ghost" onclick="closeConfigModal()">取消</button>
      <span style="flex:1"></span>
      <button class="sm ghost" style="color:var(--red);font-size:12px" onclick="closeConfigModal();pruneStaleBranches()">🧹 清理未托管分支</button>
    </div>
  `);

  // Allow combobox dropdown to overflow the modal body
  const modalBody = document.querySelector('.config-modal-dialog .modal-body');
  if (modalBody) modalBody.style.overflow = 'visible';

  // Close dropdown when clicking outside
  document.addEventListener('click', _comboOutsideClick);
}

// ── Combobox helpers ──

function _comboOutsideClick(e) {
  const box = document.getElementById('selfUpdateCombobox');
  if (box && !box.contains(e.target)) {
    closeComboDropdown();
  }
}

function openComboDropdown() {
  const dd = document.getElementById('selfUpdateDropdown');
  if (dd) dd.classList.add('open');
}

function closeComboDropdown() {
  const dd = document.getElementById('selfUpdateDropdown');
  if (dd) dd.classList.remove('open');
  document.removeEventListener('click', _comboOutsideClick);
}

function toggleComboDropdown() {
  const dd = document.getElementById('selfUpdateDropdown');
  if (dd) {
    if (dd.classList.contains('open')) {
      closeComboDropdown();
    } else {
      // Reset filter to show all
      filterComboItems('');
      dd.classList.add('open');
      document.getElementById('selfUpdateBranch')?.focus();
    }
  }
}

function filterComboItems(query) {
  const dd = document.getElementById('selfUpdateDropdown');
  if (!dd) return;
  const q = query.toLowerCase();
  let visible = 0;
  for (const item of dd.querySelectorAll('.combobox-item')) {
    const val = (item.dataset.value || '').toLowerCase();
    const show = !q || val.includes(q);
    item.style.display = show ? '' : 'none';
    if (show) visible++;
  }
  if (visible > 0 && q) dd.classList.add('open');
}

function selectComboItem(el) {
  const input = document.getElementById('selfUpdateBranch');
  if (input) input.value = el.dataset.value;
  closeComboDropdown();
}

function executeSelfUpdate() {
  const input = document.getElementById('selfUpdateBranch');
  const branch = input ? input.value.trim() : '';
  const btn = document.getElementById('selfUpdateBtn');
  const progress = document.getElementById('selfUpdateProgress');
  const stepsEl = document.getElementById('selfUpdateSteps');
  const statusEl = document.getElementById('selfUpdateStatus');

  if (btn) btn.disabled = true;
  if (progress) progress.style.display = 'block';

  const stepMap = {};
  function updateStep(id, status, title) {
    let el = stepMap[id];
    if (!el) {
      el = document.createElement('div');
      el.style.cssText = 'display:flex;align-items:center;gap:8px;padding:6px 10px;background:var(--bg-secondary);border:1px solid var(--border);border-radius:6px;font-size:13px';
      el.innerHTML = '<span class="step-dot"></span><span></span>';
      stepsEl.appendChild(el);
      stepMap[id] = el;
    }
    const dot = el.querySelector('.step-dot');
    const label = el.querySelector('span:last-child');
    label.textContent = title;
    const colors = { running: 'var(--blue)', done: 'var(--green)', error: 'var(--red)' };
    dot.style.cssText = `width:8px;height:8px;border-radius:50%;background:${colors[status] || 'var(--fg-muted)'}`;
    if (status === 'running') {
      dot.style.animation = 'pulse 1s infinite';
    }
  }

  // SSE request via fetch
  fetch(API + '/self-update', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ branch: branch || undefined }),
  }).then(resp => {
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    function processChunk() {
      return reader.read().then(({ done, value }) => {
        if (done) return;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        let eventType = '';
        for (const line of lines) {
          if (line.startsWith('event: ')) {
            eventType = line.slice(7).trim();
          } else if (line.startsWith('data: ')) {
            try {
              const data = JSON.parse(line.slice(6));
              if (eventType === 'step') {
                updateStep(data.step, data.status, data.title);
              } else if (eventType === 'done') {
                statusEl.innerHTML = '<span style="color:var(--green)">' + esc(data.message) + '</span>';
                // Auto-reload after delay
                setTimeout(() => { location.reload(); }, 5000);
                statusEl.innerHTML += '<br><span style="font-size:12px;color:var(--fg-muted)">5 秒后自动刷新...</span>';
                let sec = 4;
                const t = setInterval(() => {
                  if (sec <= 0) { clearInterval(t); location.reload(); }
                  else { statusEl.querySelector('span:last-child').textContent = sec + ' 秒后自动刷新...'; sec--; }
                }, 1000);
              } else if (eventType === 'error') {
                statusEl.innerHTML = '<span style="color:var(--red)">❌ ' + esc(data.message) + '</span>';
                if (btn) btn.disabled = false;
              }
            } catch {}
          }
        }
        return processChunk();
      });
    }
    return processChunk();
  }).catch(err => {
    // Connection lost is expected during restart
    if (statusEl && !statusEl.textContent) {
      statusEl.innerHTML = '<span style="color:var(--fg-muted)">连接已断开（CDS 正在重启），即将刷新...</span>';
      setTimeout(() => { location.reload(); }, 5000);
    }
  });
}

// ── Infrastructure services ──

async function loadInfraServices() {
  try {
    const data = await api('GET', '/infra');
    infraServices = data.services || [];
  } catch (e) { console.error('loadInfraServices:', e); }
}

function infraStatusDot(status) {
  const colors = { running: '#3fb950', stopped: '#8b949e', error: '#f85149' };
  return `<span style="color:${colors[status] || '#8b949e'}">●</span>`;
}

function infraStatusLabel(status) {
  const map = { running: '运行中', stopped: '已停止', error: '错误' };
  return map[status] || status;
}

function openInfraModal() {
  const listHtml = infraServices.length === 0
    ? `<div class="config-empty">
        暂无基础设施服务。点击"从 Compose 导入"自动发现项目中的 docker-compose.yml 服务。
      </div>`
    : infraServices.map(svc => `
        <div class="config-item" style="flex-direction:column;align-items:stretch;gap:6px">
          <div style="display:flex;align-items:center;gap:8px">
            <span style="font-size:14px">${infraStatusDot(svc.status)}</span>
            <strong style="flex:1">${esc(svc.name)}</strong>
            <code style="font-size:11px;opacity:0.6">${esc(svc.dockerImage)}</code>
            <code style="font-size:12px;color:var(--blue)">:${svc.hostPort}</code>
          </div>
          <div style="display:flex;align-items:center;gap:4px;font-size:12px;color:var(--fg-muted)">
            <span>${infraStatusLabel(svc.status)}</span>
            ${svc.errorMessage ? `<span style="color:var(--red);margin-left:8px" title="${esc(svc.errorMessage)}">⚠ 错误</span>` : ''}
            <span style="margin-left:auto;display:flex;gap:4px">
              ${svc.status === 'running'
                ? `<button class="icon-btn xs" onclick="infraAction('${esc(svc.id)}','stop')" title="停止">⏹</button>
                   <button class="icon-btn xs" onclick="infraAction('${esc(svc.id)}','restart')" title="重启">⟳</button>`
                : `<button class="icon-btn xs" onclick="infraAction('${esc(svc.id)}','start')" title="启动">▶</button>`}
              <button class="icon-btn xs" onclick="infraShowLogs('${esc(svc.id)}')" title="日志">📋</button>
              <button class="icon-btn xs danger-icon" onclick="infraDelete('${esc(svc.id)}')" title="删除">&times;</button>
            </span>
          </div>
          ${svc.injectEnv && Object.keys(svc.injectEnv).length > 0 ? `
          <div style="font-size:11px;color:var(--fg-muted);background:var(--bg-tertiary);padding:4px 8px;border-radius:4px;margin-top:2px">
            自动注入: ${Object.keys(svc.injectEnv).map(k => `<code>${esc(k)}</code>`).join(', ')}
          </div>` : `
          <div style="font-size:11px;color:var(--fg-muted);background:var(--bg-tertiary);padding:4px 8px;border-radius:4px;margin-top:2px">
            v2 环境变量: <code>\${CDS_${svc.id.toUpperCase().replace(/-/g, '_')}_PORT}</code>
          </div>`}
        </div>
      `).join('');

  const html = `
    <p class="config-panel-desc">
      CDS 托管的基础设施服务（数据库、缓存等）。容器使用 Docker Label 标记，CDS 重启后自动接管。
      v2 格式：App 服务通过 <code>\${CDS_&lt;SERVICE&gt;_PORT}</code> 引用端口。v1 兼容：使用 <code>{{host}}:{{port}}</code> 自动注入。
    </p>
    <div class="config-panel-actions" style="margin-bottom:10px;display:flex;gap:6px">
      <button class="sm primary" onclick="infraDiscover()">📦 从 Compose 导入</button>
      <button class="sm" onclick="openInfraAddModal()">+ 自定义</button>
    </div>
    <div id="infraListInModal">${listHtml}</div>
  `;
  openConfigModal('基础设施', html);
}

async function infraAction(id, action) {
  try {
    const data = await api('POST', `/infra/${encodeURIComponent(id)}/${action}`);
    showToast(data.message, 'success');
    await loadInfraServices();
    openInfraModal();
  } catch (e) { showToast(e.message, 'error'); }
}

async function infraDelete(id) {
  if (!confirm(`确定删除基础设施服务 "${id}"？容器将被停止，但数据卷会保留。`)) return;
  try {
    await api('DELETE', `/infra/${encodeURIComponent(id)}`);
    showToast(`已删除 ${id}`, 'success');
    await loadInfraServices();
    openInfraModal();
  } catch (e) { showToast(e.message, 'error'); }
}

async function infraShowLogs(id) {
  openConfigModal('基础设施日志', '<div class="config-empty"><span class="btn-spinner"></span> 加载中...</div>');
  try {
    const data = await api('GET', `/infra/${encodeURIComponent(id)}/logs`);
    const html = `
      <pre style="max-height:400px;overflow:auto;background:var(--bg-tertiary);padding:12px;border-radius:6px;font-size:11px;line-height:1.5;white-space:pre-wrap;word-break:break-all">${esc(data.logs || '(空)')}</pre>
      <div class="form-row" style="margin-top:8px">
        <button class="sm" onclick="openInfraModal()">返回</button>
      </div>
    `;
    openConfigModal(`${id} 日志`, html);
  } catch (e) {
    openConfigModal('基础设施日志', `<div class="config-empty" style="color:var(--red)">${esc(e.message)}</div>`);
  }
}

async function infraDiscover() {
  try {
    const data = await api('GET', '/infra/discover');
    const discovered = data.discovered || [];
    if (discovered.length === 0) {
      showToast('未在项目中发现 docker-compose.yml 文件', 'error');
      return;
    }

    // Show discovered services for user to pick (deduplicate by ID, first file wins)
    const allServices = [];
    const seenIds = new Set();
    for (const entry of discovered) {
      for (const svc of entry.services) {
        if (!seenIds.has(svc.id)) {
          seenIds.add(svc.id);
          allServices.push({ ...svc, fromFile: entry.file });
        }
      }
    }

    const listHtml = allServices.map((svc, i) => `
      <label class="config-item" style="cursor:pointer;gap:8px;align-items:center">
        <input type="checkbox" value="${esc(svc.id)}" checked data-idx="${i}">
        <div style="flex:1">
          <strong>${esc(svc.name)}</strong>
          <code style="font-size:11px;opacity:0.6;margin-left:8px">${esc(svc.dockerImage)}</code>
          <div style="font-size:11px;color:var(--fg-muted)">来自: ${esc(svc.fromFile)} | 端口: ${svc.containerPort}</div>
          ${Object.keys(svc.injectEnv || {}).length > 0 ? `<div style="font-size:11px;color:var(--fg-muted)">注入: ${Object.keys(svc.injectEnv).map(k => '<code>' + esc(k) + '</code>').join(', ')}</div>` : ''}
        </div>
      </label>
    `).join('');

    const html = `
      <p class="config-panel-desc">
        从项目 compose 文件中发现了以下基础设施服务。勾选要导入的服务：
      </p>
      <div id="infraDiscoverList">${listHtml}</div>
      <div class="form-row" style="margin-top:10px;gap:6px">
        <button class="primary sm" onclick="infraQuickstartSelected()">创建并启动</button>
        <button class="sm" onclick="openInfraModal()">取消</button>
      </div>
    `;
    openConfigModal('发现基础设施服务', html);
  } catch (e) { showToast(e.message, 'error'); }
}

async function infraQuickstartSelected() {
  const checkboxes = document.querySelectorAll('#infraDiscoverList input[type=checkbox]:checked');
  const serviceIds = Array.from(checkboxes).map(cb => cb.value);
  if (serviceIds.length === 0) {
    showToast('请至少选择一个服务', 'error');
    return;
  }
  try {
    const data = await api('POST', '/infra/quickstart', { serviceIds });
    const results = data.results || [];
    const msgs = results.map(r => `${r.id}: ${r.status === 'started' ? '已启动' : r.status === 'exists' ? '已存在' : r.error || r.status}`);
    showToast(msgs.join(' | '), results.every(r => r.status === 'started' || r.status === 'exists') ? 'success' : 'error');
    await loadInfraServices();
    openInfraModal();
  } catch (e) { showToast(e.message, 'error'); }
}

function openInfraAddModal() {
  const html = `
    <p class="config-panel-desc">添加自定义基础设施服务。</p>
    <div class="form-row">
      <input id="infraId" placeholder="ID (如 postgres)" class="form-input" style="flex:0.5">
      <input id="infraName" placeholder="显示名称 (如 PostgreSQL 16)" class="form-input">
    </div>
    <div class="form-row">
      <input id="infraImage" placeholder="Docker 镜像 (如 postgres:16)" class="form-input">
      <input id="infraPort" placeholder="容器端口 (如 5432)" class="form-input" type="number" style="flex:0.4">
    </div>
    <div class="form-row">
      <input id="infraVolName" placeholder="卷名 (如 cds-postgres-data)" class="form-input" style="flex:0.5">
      <input id="infraVolPath" placeholder="挂载路径 (如 /var/lib/postgresql/data)" class="form-input">
    </div>
    <p class="config-panel-desc" style="margin-top:8px">
      注入环境变量（每行 <code>KEY=模板</code>，支持 <code>{{host}}</code> 和 <code>{{port}}</code>）：
    </p>
    <textarea id="infraInjectEnv" class="bulk-textarea" rows="3" placeholder="DATABASE_URL=postgres://{{host}}:{{port}}/mydb"></textarea>
    <div class="form-row" style="margin-top:8px">
      <button class="primary sm" onclick="saveCustomInfra()">创建并启动</button>
      <button class="sm" onclick="openInfraModal()">取消</button>
    </div>
  `;
  openConfigModal('添加基础设施服务', html);
}

async function saveCustomInfra() {
  const id = document.getElementById('infraId').value.trim();
  const name = document.getElementById('infraName').value.trim();
  const dockerImage = document.getElementById('infraImage').value.trim();
  const containerPort = parseInt(document.getElementById('infraPort').value);
  const volName = document.getElementById('infraVolName').value.trim();
  const volPath = document.getElementById('infraVolPath').value.trim();
  const injectEnvText = document.getElementById('infraInjectEnv').value.trim();

  if (!id || !name || !dockerImage || !containerPort) {
    showToast('请填写所有必填项', 'error');
    return;
  }

  const volumes = volName && volPath ? [{ name: volName, containerPath: volPath }] : [];
  const injectEnv = {};
  if (injectEnvText) {
    for (const line of injectEnvText.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx > 0) {
        injectEnv[trimmed.substring(0, eqIdx).trim()] = trimmed.substring(eqIdx + 1);
      }
    }
  }

  try {
    await api('POST', '/infra', { id, name, dockerImage, containerPort, volumes, injectEnv, env: {} });
    showToast(`已创建 ${name}`, 'success');
    // Auto-start
    try { await api('POST', `/infra/${encodeURIComponent(id)}/start`); } catch { /* ok */ }
    await loadInfraServices();
    openInfraModal();
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
            <span class="config-item-detail">${esc(p.workDir || '.')} :${p.containerPort}${p.pathPrefixes?.length ? ' → ' + p.pathPrefixes.join(', ') : ''}</span>
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
        <div class="form-row">
          <input id="profilePathPrefixes" placeholder="路由路径前缀（逗号分隔，如 /api/,/graphql）" class="form-input" title="指定此服务处理哪些 URL 路径前缀。不填则使用约定：id 含 api 时自动处理 /api/*">
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
  const pathPrefixesRaw = document.getElementById('profilePathPrefixes').value.trim();
  if (pathPrefixesRaw) {
    profile.pathPrefixes = pathPrefixesRaw.split(',').map(s => s.trim()).filter(Boolean);
  }
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

function toggleModalForm(id) {
  const el = document.getElementById(id);
  if (el) el.classList.toggle('hidden');
}

// ── Startup Signal configuration modal ──

function openStartupSignalModal() {
  if (buildProfiles.length === 0) {
    showToast('请先添加构建配置', 'error');
    return;
  }

  const signalExamples = {
    api: 'Now listening on: http://0.0.0.0:5000',
    admin: '➜  Network:',
    web: '➜  Network:',
    frontend: '➜  Network:',
  };

  const listHtml = buildProfiles.map(p => {
    const currentSignal = p.startupSignal || '';
    const placeholder = signalExamples[p.id] || '容器日志中的启动成功标志字符串';
    return `
      <div class="config-item" style="flex-direction:column;align-items:stretch;gap:8px;padding:12px">
        <div style="display:flex;align-items:center;gap:8px">
          <span style="opacity:0.7">${getPortIcon(p.id, p)}</span>
          <strong>${esc(p.name)}</strong>
          <code class="config-item-match" style="margin-left:auto">:${p.containerPort}</code>
        </div>
        <div style="display:flex;gap:8px;align-items:center">
          <input id="signal-${esc(p.id)}" class="form-input" value="${esc(currentSignal)}" placeholder="${esc(placeholder)}" style="flex:1;font-size:12px">
          ${currentSignal ? '<span style="color:var(--green);font-size:11px;white-space:nowrap">● 已设置</span>' : '<span style="color:var(--text-muted);font-size:11px;white-space:nowrap">未设置</span>'}
        </div>
      </div>
    `;
  }).join('');

  const html = `
    <p class="config-panel-desc">
      为每个服务配置启动成功标志。CDS 会监听容器日志，检测到该字符串后才标记服务为"运行中"。<br>
      <span style="color:var(--text-muted);font-size:11px">未配置时，CDS 仅通过容器存活检查判断启动状态（可能容器活着但服务还没准备好）。</span>
    </p>
    <div id="signalProfileList">${listHtml}</div>
    <div style="margin-top:12px;display:flex;gap:8px">
      <button class="primary sm" onclick="saveStartupSignals()">保存</button>
      <button class="sm" onclick="closeConfigModal()">取消</button>
    </div>
  `;
  openConfigModal('启动成功标志', html);
}

async function saveStartupSignals() {
  try {
    for (const p of buildProfiles) {
      const input = document.getElementById('signal-' + p.id);
      if (!input) continue;
      const newSignal = input.value.trim();
      const oldSignal = p.startupSignal || '';
      if (newSignal !== oldSignal) {
        await api('PUT', '/build-profiles/' + encodeURIComponent(p.id), { startupSignal: newSignal || undefined });
      }
    }
    showToast('启动成功标志已保存', 'success');
    await loadProfiles();
    closeConfigModal();
  } catch (e) { showToast(e.message, 'error'); }
}

// ── Log modal (with tabs: logs / terminal) ──

let _logPollTimer = null;
let _logPollFn = null;
let _logModalContext = { branchId: null, profileId: null }; // track which branch/service is open
let _logModalTab = 'logs'; // 'logs' | 'terminal'
let _terminalHistory = []; // command history per session
let _terminalHistoryIdx = -1;

function openLogModal(title, branchId, profileId) {
  document.getElementById('logModalTitle').textContent = title;
  document.getElementById('logModal').classList.remove('hidden');
  document.getElementById('logModal').dataset.mode = 'logs';
  _logModalContext = { branchId: branchId || null, profileId: profileId || null };
  // Show tabs only when we have branch context (can exec)
  const tabsEl = document.getElementById('logModalTabs');
  if (branchId) {
    tabsEl.classList.remove('hidden');
  } else {
    tabsEl.classList.add('hidden');
  }
  // Hide copy-error button initially
  const copyBtn = document.getElementById('copyErrorBtn');
  if (copyBtn) { copyBtn.classList.add('hidden'); copyBtn.classList.remove('copied'); }
  // Clear terminal state for new session
  document.getElementById('terminalOutput').innerHTML = '';
  document.getElementById('terminalInput').value = '';
  _terminalHistory = [];
  _terminalHistoryIdx = -1;
  switchLogTab('logs');
  _scrollLogToBottom();
}

// Error patterns to detect in logs
const _errorPatterns = /\berror\s+(CS|TS|NG)\d+\b|:\s*error\s+\w+\d+:|Build FAILED|FAILED|Exception:|Unhandled exception|fatal error|npm ERR!|Error:|Cannot find module|ENOENT|EACCES|Segmentation fault/i;

function checkLogErrors() {
  const modal = document.getElementById('logModal');
  const body = document.getElementById('logModalBody');
  const btn = document.getElementById('copyErrorBtn');
  if (!body || !btn) return;
  // Don't show error button in activity-detail mode (not a log view)
  if (modal && modal.dataset.mode === 'activity-detail') { btn.classList.add('hidden'); return; }
  const text = body.textContent || '';
  if (_errorPatterns.test(text)) {
    btn.classList.remove('hidden');
    btn.classList.remove('copied');
  } else {
    btn.classList.add('hidden');
  }
}

function copyErrorForLLM() {
  const body = document.getElementById('logModalBody');
  const btn = document.getElementById('copyErrorBtn');
  if (!body) return;
  const logText = body.textContent || '';

  // Extract error lines + some context
  const lines = logText.split('\n');
  const errorLines = [];
  for (let i = 0; i < lines.length; i++) {
    if (_errorPatterns.test(lines[i])) {
      // Include 2 lines before for context
      for (let j = Math.max(0, i - 2); j <= Math.min(lines.length - 1, i + 1); j++) {
        const line = lines[j].trim();
        if (line && !errorLines.includes(line)) errorLines.push(line);
      }
    }
  }

  const title = document.getElementById('logModalTitle')?.textContent || '';
  const ctx = _logModalContext;
  const prompt = [
    '我的项目部署出错了，请帮我分析错误原因并给出修复方案。',
    '',
    `服务: ${title}`,
    ctx.branchId ? `分支: ${ctx.branchId}` : '',
    ctx.profileId ? `配置: ${ctx.profileId}` : '',
    '',
    '错误日志:',
    '```',
    errorLines.length > 0 ? errorLines.join('\n') : logText.slice(-3000),
    '```',
  ].filter(l => l !== false).join('\n');

  navigator.clipboard.writeText(prompt).then(() => {
    if (btn) {
      btn.classList.add('copied');
      btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M13.78 4.22a.75.75 0 010 1.06l-7.25 7.25a.75.75 0 01-1.06 0L2.22 9.28a.75.75 0 011.06-1.06L6 10.94l6.72-6.72a.75.75 0 011.06 0z"/></svg> 已复制';
      setTimeout(() => {
        if (btn) {
          btn.classList.remove('copied');
          btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M0 6.75C0 5.784.784 5 1.75 5h1.5a.75.75 0 010 1.5h-1.5a.25.25 0 00-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 00.25-.25v-1.5a.75.75 0 011.5 0v1.5A1.75 1.75 0 019.25 16h-7.5A1.75 1.75 0 010 14.25v-7.5z"/><path d="M5 1.75C5 .784 5.784 0 6.75 0h7.5C15.216 0 16 .784 16 1.75v7.5A1.75 1.75 0 0114.25 11h-7.5A1.75 1.75 0 015 9.25v-7.5zm1.75-.25a.25.25 0 00-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 00.25-.25v-7.5a.25.25 0 00-.25-.25h-7.5z"/></svg> 一键复制错误给大模型排错';
        }
      }, 2000);
    }
    showToast('错误日志已复制到剪贴板，粘贴给 AI 即可排错', 'success');
  }).catch(() => {
    showToast('复制失败，请手动选择日志文本', 'error');
  });
}

function closeLogModal() {
  document.getElementById('logModal').classList.add('hidden');
  if (_logPollTimer) { clearInterval(_logPollTimer); _logPollTimer = null; _logPollFn = null; }
  if (_logStreamController) { _logStreamController.abort(); _logStreamController = null; }
  _logModalContext = { branchId: null, profileId: null };
}

function switchLogTab(tab) {
  _logModalTab = tab;
  const logBody = document.getElementById('logModalBody');
  const termBody = document.getElementById('terminalBody');
  const tabs = document.querySelectorAll('#logModalTabs .log-tab');
  tabs.forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
  if (tab === 'logs') {
    logBody.classList.remove('hidden');
    termBody.classList.add('hidden');
  } else {
    logBody.classList.add('hidden');
    termBody.classList.remove('hidden');
    const input = document.getElementById('terminalInput');
    if (input) setTimeout(() => input.focus(), 50);
  }
}

async function execTerminalCmd() {
  const input = document.getElementById('terminalInput');
  const command = input.value.trim();
  if (!command) return;
  const { branchId, profileId } = _logModalContext;
  if (!branchId) { showToast('无法执行: 未关联分支', 'error'); return; }

  // Push to history
  _terminalHistory.push(command);
  _terminalHistoryIdx = _terminalHistory.length;

  // Append command to output
  const output = document.getElementById('terminalOutput');
  output.innerHTML += `<div class="term-line term-cmd"><span class="term-prompt">$</span> ${esc(command)}</div>`;
  input.value = '';
  input.disabled = true;

  try {
    const data = await api('POST', `/branches/${encodeURIComponent(branchId)}/container-exec`, { profileId, command });
    const text = (data.stdout || '') + (data.stderr || '');
    if (text.trim()) {
      const exitClass = data.exitCode !== 0 ? ' term-error' : '';
      output.innerHTML += `<pre class="term-line term-result${exitClass}">${esc(text)}</pre>`;
    }
    if (data.exitCode !== 0) {
      output.innerHTML += `<div class="term-line term-exit">exit code: ${data.exitCode}</div>`;
    }
  } catch (e) {
    output.innerHTML += `<div class="term-line term-error">${esc(e.message)}</div>`;
  }
  input.disabled = false;
  input.focus();
  output.scrollTop = output.scrollHeight;
}

// Terminal history navigation (up/down arrows)
document.addEventListener('keydown', (e) => {
  if (_logModalTab !== 'terminal') return;
  const input = document.getElementById('terminalInput');
  if (!input || document.activeElement !== input) return;
  if (e.key === 'ArrowUp') {
    e.preventDefault();
    if (_terminalHistoryIdx > 0) {
      _terminalHistoryIdx--;
      input.value = _terminalHistory[_terminalHistoryIdx] || '';
    }
  } else if (e.key === 'ArrowDown') {
    e.preventDefault();
    if (_terminalHistoryIdx < _terminalHistory.length - 1) {
      _terminalHistoryIdx++;
      input.value = _terminalHistory[_terminalHistoryIdx] || '';
    } else {
      _terminalHistoryIdx = _terminalHistory.length;
      input.value = '';
    }
  }
});

function _startLogPoll(fn, intervalMs) {
  if (_logPollTimer) clearInterval(_logPollTimer);
  _logPollFn = fn;
  _logPollTimer = setInterval(async () => {
    if (document.getElementById('logModal').classList.contains('hidden')) {
      clearInterval(_logPollTimer); _logPollTimer = null; _logPollFn = null; return;
    }
    if (_logModalTab !== 'logs') return; // don't poll when on terminal tab
    await _logPollFn();
  }, intervalMs);
}

function _scrollLogToBottom() {
  requestAnimationFrame(() => {
    const body = document.getElementById('logModalBody');
    if (!body) return;
    const pre = body.querySelector('.live-log-output');
    const target = pre || body;
    target.scrollTop = target.scrollHeight;
    checkLogErrors();
  });
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

// ════════════════ API Activity Monitor ════════════════

let activityEvents = [];
let webActivityEvents = [];
let activityExpanded = false;
let activityEventSource = null;
let _pollInFlight = false; // true while silent poll is running
let activeActivityTab = 'cds'; // 'cds' or 'web'

// ── Card preview activity tracking ──
// { branchId: timeoutHandle } — auto-clear after idle
const previewingBranches = new Map();
const PREVIEW_IDLE_TIMEOUT = 8000; // 8s idle → stop spinner

function markBranchPreviewing(branchId) {
  // Clear previous timeout
  if (previewingBranches.has(branchId)) {
    clearTimeout(previewingBranches.get(branchId));
  }
  // Add class to card
  const card = document.querySelector(`.branch-card[data-branch-id="${branchId}"]`);
  if (card && !card.classList.contains('is-previewing')) {
    card.classList.add('is-previewing');
  }
  // Set idle timeout
  previewingBranches.set(branchId, setTimeout(() => {
    const card = document.querySelector(`.branch-card[data-branch-id="${branchId}"]`);
    if (card) card.classList.remove('is-previewing');
    previewingBranches.delete(branchId);
  }, PREVIEW_IDLE_TIMEOUT));
}

function switchActivityTab(tab) {
  activeActivityTab = tab;
  const cdsBody = document.getElementById('activityBody');
  const webBody = document.getElementById('webActivityBody');
  document.querySelectorAll('.activity-tab').forEach(t => {
    t.classList.toggle('active', t.dataset.tab === tab);
  });
  if (tab === 'cds') {
    cdsBody.style.display = '';
    webBody.style.display = 'none';
    requestAnimationFrame(() => { cdsBody.scrollTop = cdsBody.scrollHeight; });
  } else {
    cdsBody.style.display = 'none';
    webBody.style.display = '';
    requestAnimationFrame(() => { webBody.scrollTop = webBody.scrollHeight; });
  }
}

function initActivityMonitor() {
  activityEventSource = new EventSource(`${API}/activity-stream`);
  activityEventSource.onmessage = (e) => {
    try {
      const event = JSON.parse(e.data);

      // Web access events → separate tab + card spinner
      if (event.type === 'web') {
        webActivityEvents.push(event);
        if (webActivityEvents.length > 200) webActivityEvents = webActivityEvents.slice(-200);
        renderWebActivityItem(event);
        document.getElementById('webTabCount').textContent = webActivityEvents.length;
        // Trigger card preview spinner
        if (event.branchId) markBranchPreviewing(event.branchId);
        // Update total count & roller
        updateTotalCount();
        updateActivityRoller(event);
        return;
      }

      // CDS API events (default)
      // Frontend poll filter: skip poll responses (defense-in-depth, server also filters)
      if (_pollInFlight && event.method === 'GET' && event.path === '/api/branches' && event.source !== 'ai') return;
      activityEvents.push(event);
      if (activityEvents.length > 200) activityEvents = activityEvents.slice(-200);
      renderActivityItem(event);
      document.getElementById('cdsTabCount').textContent = activityEvents.length;
      updateTotalCount();
      // Track AI occupation per branch
      if (event.source === 'ai' && event.branchId) {
        const prev = aiOccupation.get(event.branchId);
        aiOccupation.set(event.branchId, { agent: event.agent || 'AI', lastSeen: Date.now() });
        trackAiBranchEvent(event);
        if (!prev) {
          // Newly occupied — full re-render to show badge + feed
          renderBranches();
        } else {
          // Already occupied — roller-update the inline feed (no full re-render)
          updateBranchFeedRoller(event);
        }
      }
    } catch {}
  };
  activityEventSource.onerror = () => {
    // Reconnect after 3s
    setTimeout(() => {
      if (activityEventSource) activityEventSource.close();
      initActivityMonitor();
    }, 3000);
  };
}

function updateTotalCount() {
  document.getElementById('activityCount').textContent = activityEvents.length + webActivityEvents.length;
}

function toUTC8Time(isoStr) {
  // Convert ISO string to UTC+8, show MM:SS if same hour, else HH:MM:SS
  const d = new Date(isoStr);
  const utc8 = new Date(d.getTime() + 8 * 60 * 60 * 1000);
  const full = utc8.toISOString().slice(11, 19);
  const nowUtc8 = new Date(Date.now() + 8 * 60 * 60 * 1000);
  if (utc8.getUTCHours() === nowUtc8.getUTCHours() && utc8.toISOString().slice(0, 10) === nowUtc8.toISOString().slice(0, 10)) {
    return full.slice(3); // MM:SS
  }
  return full;
}

function renderActivityItem(event) {
  const body = document.getElementById('activityBody');
  if (!body) return;

  const isAi = event.source === 'ai';
  const el = document.createElement('div');
  el.className = 'activity-item' + (isAi ? ' activity-item-ai' : '');
  el.style.cursor = 'pointer';
  el.onclick = () => showActivityDetail(event);

  const statusClass = event.status < 400 ? 'ok' : 'err';
  const dur = event.duration < 1000 ? `${event.duration}ms` : `${(event.duration / 1000).toFixed(1)}s`;
  const ts = toUTC8Time(event.ts);

  // Chinese label from server, or fallback to shortened path
  const label = event.label || '';
  const shortPath = event.path.replace(/^\/api\//, '').replace(/branches\/([^/]+)/, (_, id) => {
    return id.length > 16 ? id.slice(0, 12) + '…' : id;
  });

  let html = '';
  // Branch ID first (last segment after '-') to identify which preview is making requests
  if (event.branchId) {
    const lastDash = event.branchId.lastIndexOf('-');
    const branchTail = lastDash >= 0 ? event.branchId.slice(lastDash + 1) : event.branchId;
    const branchShort = branchTail.length > 16 ? branchTail.slice(0, 13) + '…' : branchTail;
    html += `<span class="activity-source" style="background:var(--accent-bg);color:var(--accent);font-size:9px;font-weight:600;padding:1px 4px;border-radius:3px" title="${escapeHtml(event.branchId)}">${escapeHtml(branchShort)}</span>`;
  }
  // AI badge if applicable
  if (isAi) {
    const agentShort = (event.agent || 'AI').replace(/\s*\(static key\)/, '');
    html += `<span class="activity-source ai" title="${escapeHtml(event.agent || 'AI')}">${escapeHtml(agentShort)}</span>`;
  }
  html += `<span class="activity-method ${event.method}">${event.method}</span>`;
  // Show Chinese label (golden glow) if available, path as tooltip
  if (label) {
    html += `<span class="activity-label" title="${escapeHtml(event.path)}">${escapeHtml(label)}</span>`;
    html += `<span class="activity-path-suffix" title="${escapeHtml(event.path)}">${escapeHtml(shortPath)}</span>`;
  } else {
    html += `<span class="activity-path" title="${escapeHtml(event.path)}">${shortPath}</span>`;
  }
  html += `<span class="activity-status ${statusClass}">${event.status}</span>`;
  html += `<span class="activity-dur">${dur}</span>`;
  // Time at the end
  html += `<span class="activity-ts">${ts}</span>`;

  el.innerHTML = html;
  body.appendChild(el);

  // Auto-scroll to bottom
  requestAnimationFrame(() => { body.scrollTop = body.scrollHeight; });

  // Update roller (collapsed header ticker)
  updateActivityRoller(event);
}

function renderWebActivityItem(event) {
  const body = document.getElementById('webActivityBody');
  if (!body) return;

  const el = document.createElement('div');
  el.className = 'activity-item';
  el.style.cursor = 'pointer';
  el.onclick = () => showActivityDetail(event);

  const statusClass = event.status < 400 ? 'ok' : 'err';
  const dur = event.duration < 1000 ? `${event.duration}ms` : `${(event.duration / 1000).toFixed(1)}s`;
  const ts = toUTC8Time(event.ts);
  const shortPath = event.path;

  // Determine container type from profileId
  const profileId = event.profileId || '';
  const isApi = profileId.includes('api') || profileId.includes('backend') || event.path.startsWith('/api/');
  const containerLabel = isApi ? 'api' : 'admin';
  const containerColor = isApi ? 'var(--blue)' : 'var(--green)';
  const containerBg = isApi ? 'rgba(56,139,253,0.12)' : 'rgba(63,185,80,0.12)';

  let html = '';
  // Branch first, then container badge
  if (event.branchId) {
    const lastDash = event.branchId.lastIndexOf('-');
    const branchTail = lastDash >= 0 ? event.branchId.slice(lastDash + 1) : event.branchId;
    const branchShort = branchTail.length > 16 ? branchTail.slice(0, 13) + '…' : branchTail;
    html += `<span class="activity-source" style="background:var(--accent-bg);color:var(--accent);font-size:9px;font-weight:600;padding:1px 4px;border-radius:3px" title="${escapeHtml(event.branchId)}">${escapeHtml(branchShort)}</span>`;
  }
  html += `<span class="web-container-badge" style="background:${containerBg};color:${containerColor}">${containerLabel}</span>`;
  html += `<span class="activity-path" title="${escapeHtml(event.path)}">${escapeHtml(shortPath)}</span>`;
  html += `<span class="activity-status ${statusClass}">${event.status}</span>`;
  html += `<span class="activity-dur">${dur}</span>`;
  html += `<span class="activity-ts">${ts}</span>`;

  el.innerHTML = html;
  body.appendChild(el);

  requestAnimationFrame(() => { body.scrollTop = body.scrollHeight; });
}

// ── Activity Roller (flip-clock style single-line ticker) ──
function updateActivityRoller(event) {
  const roller = document.getElementById('activityRoller');
  if (!roller) return;

  const isAi = event.source === 'ai';
  const statusCls = event.status < 400 ? 'ok' : 'err';
  const label = event.label || event.path.replace(/^\/api\//, '');
  const dur = event.duration < 1000 ? `${event.duration}ms` : `${(event.duration / 1000).toFixed(1)}s`;

  const isWeb = event.type === 'web';
  const html = `${isAi ? '<span class="roller-ai">AI</span>' : ''}${isWeb ? '<span class="roller-web">Web</span>' : ''}<span class="activity-method ${event.method}">${event.method}</span><span class="roller-label">${escapeHtml(label)}</span><span class="activity-status ${statusCls}">${event.status}</span><span class="roller-dur">${dur}</span>`;

  // Single element replace — no overlap possible
  roller.innerHTML = `<div class="roller-line roller-flip">${html}</div>`;
}

// ── Activity Detail Modal ──
function showActivityDetail(event) {
  const d = new Date(event.ts);
  const utc8 = new Date(d.getTime() + 8 * 60 * 60 * 1000);
  const ts = utc8.toISOString().replace('T', ' ').slice(0, 19) + ' (UTC+8)';
  const statusClass = event.status < 400 ? 'color:var(--green)' : 'color:var(--red)';
  const isAi = event.source === 'ai';

  let html = '<div class="activity-detail">';

  // Header: label + AI badge
  html += '<div class="activity-detail-header">';
  if (event.label) {
    html += `<span class="activity-detail-label">${escapeHtml(event.label)}</span>`;
  }
  if (isAi) {
    html += `<span class="activity-source ai" style="font-size:11px">${escapeHtml(event.agent || 'AI')}</span>`;
  }
  html += '</div>';

  // Info grid
  html += '<div class="activity-detail-grid">';
  html += `<div class="activity-detail-row"><span class="activity-detail-key">时间</span><span>${escapeHtml(ts)}</span></div>`;
  html += `<div class="activity-detail-row"><span class="activity-detail-key">方法</span><span class="activity-method ${event.method}" style="font-size:11px">${event.method}</span></div>`;
  html += `<div class="activity-detail-row"><span class="activity-detail-key">路径</span><span style="font-family:var(--font-mono);font-size:12px;word-break:break-all">${escapeHtml(event.path)}</span></div>`;
  if (event.query) {
    html += `<div class="activity-detail-row"><span class="activity-detail-key">参数</span><span style="font-family:var(--font-mono);font-size:11px;word-break:break-all">${escapeHtml(event.query)}</span></div>`;
  }
  html += `<div class="activity-detail-row"><span class="activity-detail-key">状态码</span><span style="${statusClass};font-weight:600">${event.status}</span></div>`;
  html += `<div class="activity-detail-row"><span class="activity-detail-key">耗时</span><span>${event.duration < 1000 ? event.duration + 'ms' : (event.duration / 1000).toFixed(1) + 's'}</span></div>`;
  html += `<div class="activity-detail-row"><span class="activity-detail-key">来源</span><span>${isAi ? '🤖 AI (' + escapeHtml(event.agent || '未知') + ')' : '👤 用户'}</span></div>`;
  if (event.remoteAddr) {
    html += `<div class="activity-detail-row"><span class="activity-detail-key">IP</span><span style="font-family:var(--font-mono);font-size:12px">${escapeHtml(event.remoteAddr)}</span></div>`;
  }
  if (event.userAgent) {
    html += `<div class="activity-detail-row"><span class="activity-detail-key">UA</span><span style="font-size:11px;word-break:break-all">${escapeHtml(event.userAgent)}</span></div>`;
  }
  if (event.referer) {
    html += `<div class="activity-detail-row"><span class="activity-detail-key">Referer</span><span style="font-family:var(--font-mono);font-size:11px;word-break:break-all">${escapeHtml(event.referer)}</span></div>`;
  }
  html += '</div>';

  // Request body
  if (event.body) {
    html += '<div class="activity-detail-section">';
    html += '<div class="activity-detail-key" style="margin-bottom:6px">请求体</div>';
    html += `<pre class="activity-detail-code">${escapeHtml(formatJsonSafe(event.body))}</pre>`;
    html += '</div>';
  }

  html += '</div>';

  // Reuse the log modal for detail display
  document.getElementById('logModalTitle').textContent = event.label || `${event.method} ${event.path}`;
  document.getElementById('logModalBody').innerHTML = html;
  document.getElementById('logModalTabs').classList.add('hidden');
  document.getElementById('terminalBody').classList.add('hidden');
  document.getElementById('logModalBody').classList.remove('hidden');
  document.getElementById('copyErrorBtn').classList.add('hidden');
  document.getElementById('logModal').classList.remove('hidden');
  // Mark as activity-detail mode so checkLogErrors won't re-show the button
  document.getElementById('logModal').dataset.mode = 'activity-detail';
}

function formatJsonSafe(str) {
  try {
    return JSON.stringify(JSON.parse(str), null, 2);
  } catch {
    return str;
  }
}

function toggleActivityMonitor() {
  const monitor = document.getElementById('activityMonitor');
  monitor.classList.toggle('collapsed');
  activityExpanded = !monitor.classList.contains('collapsed');
  if (activityExpanded) {
    const body = document.getElementById('activityBody');
    requestAnimationFrame(() => { body.scrollTop = body.scrollHeight; });
  }
}

function clearActivityLog() {
  activityEvents = [];
  webActivityEvents = [];
  document.getElementById('activityBody').innerHTML = '';
  document.getElementById('webActivityBody').innerHTML = '';
  document.getElementById('activityCount').textContent = '0';
  document.getElementById('cdsTabCount').textContent = '0';
  document.getElementById('webTabCount').textContent = '0';
}

// ════════════════ AI Pairing System ════════════════

let aiPairingRequests = [];
let aiPairingEventSource = null;

function initAiPairing() {
  aiPairingEventSource = new EventSource(`${API}/ai/pairing-stream`);

  aiPairingEventSource.addEventListener('new-request', (e) => {
    try {
      const req = JSON.parse(e.data);
      // Avoid duplicates
      if (!aiPairingRequests.find(r => r.id === req.id)) {
        aiPairingRequests.push(req);
      }
      updateAiIndicator();
      showToast(`AI "${req.agentName}" 请求连接`, 'info', 5000);
    } catch {}
  });

  aiPairingEventSource.addEventListener('request-approved', (e) => {
    try {
      const { id } = JSON.parse(e.data);
      aiPairingRequests = aiPairingRequests.filter(r => r.id !== id);
      updateAiIndicator();
    } catch {}
  });

  aiPairingEventSource.addEventListener('request-rejected', (e) => {
    try {
      const { id } = JSON.parse(e.data);
      aiPairingRequests = aiPairingRequests.filter(r => r.id !== id);
      updateAiIndicator();
    } catch {}
  });

  aiPairingEventSource.addEventListener('request-expired', (e) => {
    try {
      const { id } = JSON.parse(e.data);
      aiPairingRequests = aiPairingRequests.filter(r => r.id !== id);
      updateAiIndicator();
    } catch {}
  });

  aiPairingEventSource.onerror = () => {
    setTimeout(() => {
      if (aiPairingEventSource) aiPairingEventSource.close();
      initAiPairing();
    }, 3000);
  };
}

function updateAiIndicator() {
  const indicator = document.getElementById('aiPairingIndicator');
  if (aiPairingRequests.length > 0) {
    indicator.classList.remove('hidden');
  } else {
    indicator.classList.add('hidden');
  }
}

function showAiPairingPanel() {
  document.getElementById('aiPairingPanel').classList.remove('hidden');
  renderAiPairingBody();
}

function closeAiPairingPanel() {
  document.getElementById('aiPairingPanel').classList.add('hidden');
}

function renderAiPairingBody() {
  const body = document.getElementById('aiPairingBody');
  if (aiPairingRequests.length === 0) {
    body.innerHTML = '<div style="color:var(--text-muted);font-size:13px;text-align:center;padding:20px 0">暂无待处理的 AI 连接请求</div>';
    return;
  }

  body.innerHTML = aiPairingRequests.map(req => {
    const ago = relativeTime(req.createdAt);
    return `
      <div class="ai-request-card" id="ai-req-${req.id}">
        <div class="ai-agent-name">${escapeHtml(req.agentName)}</div>
        ${req.purpose ? `<div class="ai-purpose">${escapeHtml(req.purpose)}</div>` : ''}
        <div class="ai-meta">来自 ${escapeHtml(req.ip)} · ${ago || '刚刚'}</div>
        <div class="ai-actions">
          <button class="ai-approve-btn" onclick="approveAiRequest('${req.id}')">批准连接</button>
          <button class="ai-reject-btn" onclick="rejectAiRequest('${req.id}')">拒绝</button>
        </div>
      </div>
    `;
  }).join('');
}

async function approveAiRequest(id) {
  try {
    await api('POST', `/ai/approve/${id}`);
    aiPairingRequests = aiPairingRequests.filter(r => r.id !== id);
    updateAiIndicator();
    renderAiPairingBody();
    showToast('已批准 AI 连接', 'success');
    if (aiPairingRequests.length === 0) closeAiPairingPanel();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function rejectAiRequest(id) {
  try {
    await api('POST', `/ai/reject/${id}`);
    aiPairingRequests = aiPairingRequests.filter(r => r.id !== id);
    updateAiIndicator();
    renderAiPairingBody();
    showToast('已拒绝', 'info');
    if (aiPairingRequests.length === 0) closeAiPairingPanel();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

function escapeHtml(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

// ── Init activity monitor & AI pairing ──
initActivityMonitor();
initAiPairing();

// ── Start ──
init();
