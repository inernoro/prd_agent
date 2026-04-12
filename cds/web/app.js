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
  preview: '<svg class="inline-icon" width="18" height="18" viewBox="0 0 16 16" fill="currentColor"><path d="M0 8s3-5.5 8-5.5S16 8 16 8s-3 5.5-8 5.5S0 8 0 8zm8 3.5a3.5 3.5 0 100-7 3.5 3.5 0 000 7zm0-1.5a2 2 0 110-4 2 2 0 010 4z"/></svg>',
  deploy: '<svg class="inline-icon deploy-hammer-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m15 12-8.373 8.373a1 1 0 1 1-3-3L12 9"/><path d="m18 15 4-4"/><path d="m21.5 11.5c.7-1 .5-2.4-.3-3.2L17 4.2c-.8-.8-2.2-1-3.2-.3L12 5.5l6.5 6.5z"/></svg>',
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

// ── Preview mode: 'simple' (set default + open main) | 'port' (dynamic port) | 'multi' (subdomain per branch) ──
// Server-authoritative: loaded from GET /config, persisted via PUT /preview-mode.
// Default 'multi' matches server; overridden by loadConfig() on init.
let previewMode = 'multi';

// ── Mirror acceleration (npm/docker registry mirrors) ──
let mirrorEnabled = false;

// ── Tab title override (update browser tab title with tag/branch name) ──
let tabTitleEnabled = true;

// ── Theme (light/dark) ──
// Theme is applied in <head> inline script to prevent FOUC (flash of unstyled content).
let cdsTheme = localStorage.getItem('cds_theme') || 'dark';

// ── Executor/Scheduler state ──
let cdsMode = 'standalone';
let executors = [];
// Effective cluster role as reported by /api/cluster/status. Distinct from
// `cdsMode` because a `standalone` node that hot-joins a master becomes
// `hybrid` (dashboard still alive, but also posting heartbeats upstream)
// until the next restart. Used by the settings menu to show a top-level
// "退出集群" action only when relevant.
let clusterEffectiveRole = 'standalone';

// ── Container capacity ──
let containerCapacity = { maxContainers: 999, runningContainers: 0, totalMemGB: 0 };
// Cluster-wide aggregate capacity (from /api/cluster/status + state-stream).
// null = not yet loaded; when populated it drives the header badge's cluster
// display so "总容量 X" reflects A+B+... instead of just the local master.
let clusterCapacity = null;
let clusterStrategy = 'least-load';
// Scheduler (warm-pool) enabled flag — pushed from /api/config and the
// state-stream SSE so the header toggle stays in sync with the backend.
let schedulerEnabled = false;

// ── First-load guard ──
//
// The HTML ships with a `cdsInitLoader` animation inside #branchList so the
// very first paint already has motion. Without a flag, the first successful
// `loadBranches()` call would wipe the loader and — if branches are empty —
// immediately replace it with "暂无分支"，producing two transitional states
// in a row (loader → empty text). We set this to `true` only after the FIRST
// successful response, so the empty state is only rendered once it's the
// genuinely-stable state. On first empty load we instead show a deliberate,
// designed empty state (see `renderEmptyBranchesState`).
let _branchesFirstLoadDone = false;

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
  const map = { running: '运行中', starting: '启动中', building: '构建中', stopping: '正在停止', deleting: '删除中', idle: '空闲', stopped: '已停止', error: '错误' };
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

// Kick off host stats polling (5s cadence). See pollHostStats / renderHostStats.
if (typeof window !== 'undefined') {
  // Initial fetch ASAP so widget appears quickly
  setTimeout(() => { try { pollHostStats(); } catch { /* not yet loaded */ } }, 500);
  setInterval(() => { try { pollHostStats(); } catch { /* ignore */ } }, 5000);
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
  await Promise.all([loadBranches(), loadProfiles(), loadRoutingRules(), loadConfig(), loadEnvVars(), loadInfraServices(), loadMirrorState(), loadTabTitleState(), loadClusterStatus()]);
  refreshRemoteCandidates();
  updatePreviewModeUI();
  initStateStream(); // Server-authority: listen for state changes via SSE (replaces polling)
}

/**
 * Probe /api/cluster/status once at startup so the settings menu can decide
 * whether to show the "退出集群" shortcut. The data is also refreshed whenever
 * the cluster modal is opened or after a join/leave action. Failure is
 * silent — non-cluster installs return `effectiveRole === 'standalone'`
 * which is the sensible default.
 */
async function loadClusterStatus() {
  try {
    const res = await fetch('/api/cluster/status', { credentials: 'include' });
    if (!res.ok) return;
    const body = await res.json();
    clusterEffectiveRole = body.effectiveRole || 'standalone';
    if (body.strategy) clusterStrategy = body.strategy;
  } catch { /* quiet */ }
}

// ── State stream: server pushes branch state changes (no polling needed) ──
let stateEventSource = null;

function initStateStream() {
  stateEventSource = new EventSource(`${API}/state-stream`);
  stateEventSource.onmessage = (e) => {
    // Any successful SSE frame means the backend is alive. If the restart
    // overlay is showing (stale from a previous onerror), hide it — the
    // separate `pollHealthForRestart` path would also trigger a full
    // reload, but if the SSE reconnects cleanly without a full page
    // restart (e.g. transient network hiccup) there's no need to reload.
    if (_restartOverlayEl) hideRestartOverlay();
    try {
      const data = JSON.parse(e.data);
      if (data.branches) {
        // Merge commit info: state-stream has no git data, so preserve existing subject/commitSha
        // Only update status and service states from server push
        const branchMap = new Map(branches.map(b => [b.id, b]));
        for (const pushed of data.branches) {
          const existing = branchMap.get(pushed.id);
          if (existing) {
            // Preserve git info, update status/services/executorId
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
      // ── Cluster state updates (P0 #9, P1 #10) ──
      //
      // The server now ships executors + mode + aggregated capacity in the
      // same SSE payload so we can update the header badge + cluster modal
      // without a separate /api/config round trip. When mode flips from
      // standalone → scheduler during a hot-join, this is what makes the
      // dashboard react live.
      if (Array.isArray(data.executors)) {
        executors = data.executors;
      }
      if (typeof data.mode === 'string') {
        cdsMode = data.mode;
      }
      if (data.capacity) {
        clusterCapacity = data.capacity;
      }
      if (typeof data.schedulerEnabled === 'boolean') {
        schedulerEnabled = data.schedulerEnabled;
      }
      // Re-render cluster-aware surfaces. `renderCapacityBadge` now reads
      // clusterCapacity when available, `renderExecutorPanel` picks up new
      // status/load, and the cluster modal (if open) calls its own refresh.
      renderExecutorPanel();
      renderCapacityBadge();
      if (document.querySelector('.cluster-modal')) {
        refreshClusterModalIfOpen();
      }
    } catch {}
  };
  stateEventSource.onerror = () => {
    // Server might be restarting. Flip on the restart-detect overlay so
    // the user sees "正在重启" instead of a raw Cloudflare 502 banner,
    // and start polling /healthz to auto-reload the moment CDS is back.
    showRestartOverlay();
    setTimeout(() => {
      if (stateEventSource) stateEventSource.close();
      initStateStream();
    }, 3000);
  };
}

// ── Restart detection overlay ──
//
// When the state-stream SSE drops (backend restart, network blip,
// Cloudflare 502 window), this overlay covers the page with a friendly
// "正在重启" card and polls /healthz once per second. As soon as the
// endpoint returns 200 we reload the page so stale JS doesn't keep
// trying stale API shapes. Public /healthz is intentionally cookie-free
// (see server.ts:254) so the poll works even if cookies are lost.
//
// Also protects against manual `./exec_cds.sh restart` from a SSH shell:
// the operator no longer has to tell the user "just refresh the page",
// the page refreshes itself the instant the backend is alive.
let _restartOverlayEl = null;
let _restartHealthTimer = null;
let _restartHealthStartedAt = 0;
let _restartRetryAttempt = 0;

function showRestartOverlay() {
  if (_restartOverlayEl) return; // already shown
  const el = document.createElement('div');
  el.className = 'cds-restart-overlay';
  el.innerHTML = `
    <div class="cds-restart-card">
      <div class="cds-restart-spinner" aria-hidden="true">
        <svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M21 12a9 9 0 1 1-6.219-8.56"/>
          <polyline points="21 3 21 9 15 9"/>
        </svg>
      </div>
      <div class="cds-restart-title">CDS 正在重启</div>
      <div class="cds-restart-hint" id="cdsRestartHint">后台服务暂时不可用，恢复后页面会自动刷新…</div>
      <button class="cds-restart-reload" onclick="location.reload()">立即刷新</button>
    </div>
  `;
  document.body.appendChild(el);
  _restartOverlayEl = el;
  _restartHealthStartedAt = Date.now();
  _restartRetryAttempt = 0;
  pollHealthForRestart();
}

function hideRestartOverlay() {
  if (_restartHealthTimer) { clearTimeout(_restartHealthTimer); _restartHealthTimer = null; }
  if (_restartOverlayEl) {
    _restartOverlayEl.classList.add('fade-out');
    setTimeout(() => {
      if (_restartOverlayEl) _restartOverlayEl.remove();
      _restartOverlayEl = null;
    }, 200);
  }
}

async function pollHealthForRestart() {
  _restartRetryAttempt++;
  const hint = document.getElementById('cdsRestartHint');
  const elapsed = Math.round((Date.now() - _restartHealthStartedAt) / 1000);
  if (hint) {
    hint.textContent = `后台服务暂时不可用，已等待 ${elapsed}s，恢复后页面会自动刷新…`;
  }
  try {
    // `cache: 'no-store'` + cache-buster query so Cloudflare/browsers don't
    // serve a cached 502 from the initial failure window.
    const res = await fetch(`/healthz?_=${Date.now()}`, {
      cache: 'no-store',
      credentials: 'omit',
    });
    if (res.ok) {
      // Backend is alive again. Give nginx + proxies a brief settle window
      // then hard-reload so we pick up any new JS/HTML shipped in the
      // restart. `location.reload(true)` is deprecated but a plain
      // location.reload() plus no-cache headers we set in index.html
      // is sufficient.
      if (hint) hint.textContent = '后台已恢复，正在刷新页面…';
      setTimeout(() => location.reload(), 400);
      return;
    }
  } catch { /* still down */ }

  // Exponential-ish backoff: 1s, 1s, 1s, 2s, 2s, 3s... capped at 3s.
  // Keeps the first few retries snappy (catch fast restarts) without
  // spamming requests during a long outage.
  const delay = _restartRetryAttempt < 4 ? 1000 : _restartRetryAttempt < 8 ? 2000 : 3000;
  _restartHealthTimer = setTimeout(pollHealthForRestart, delay);
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
    // Server-authoritative preview mode (shared across all users)
    if (data.previewMode === 'simple' || data.previewMode === 'port' || data.previewMode === 'multi') {
      previewMode = data.previewMode;
    }
    renderExecutorPanel();
    // Show CDS commit hash in header
    if (data.cdsCommitHash) {
      const el = document.getElementById('cdsCommitHash');
      if (el) el.textContent = data.cdsCommitHash;
    }
  } catch (e) { console.error('loadConfig:', e); }
}

// ── Executor Panel (scheduler mode) ──

function renderExecutorPanel() {
  const panel = document.getElementById('executorPanel');
  if (!panel) return;

  // Only show when there's actually a cluster (at least one REMOTE executor).
  // A single-node scheduler (only the embedded master) doesn't need this
  // panel — the header capacity badge already covers it and the redundant
  // "执行器集群 1/1 在线" banner was reported as noise.
  const remoteCount = (executors || []).filter(e => (e.role || 'remote') !== 'embedded').length;
  if (remoteCount === 0) {
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

/** 合并刷新：同时刷新远程候选列表 + 检查所有分支更新 */
async function refreshAll() {
  const btn = document.getElementById('refreshRemoteBtn');
  if (btn) btn.classList.add('spinning');
  try {
    await Promise.all([checkAllUpdates(), refreshRemoteCandidates()]);
  } finally {
    if (btn) btn.classList.remove('spinning');
  }
}

async function checkAllUpdates() {
  if (isCheckingUpdates) return;
  isCheckingUpdates = true;
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
}

function confirmOpenGithub(event) {
  if (!confirm('即将跳转到 GitHub.dev 在线编辑器浏览代码，是否继续？')) {
    event.preventDefault();
    return false;
  }
  return true;
}

function copyBranchName(name) {
  navigator.clipboard.writeText(name).then(() => {
    showToast('已复制: ' + name, 'success');
  }).catch(() => {
    showToast('复制失败', 'error');
  });
}

async function cyclePreviewMode() {
  // Cycle: simple → port → multi → simple
  const modes = ['simple', 'port', 'multi'];
  const idx = modes.indexOf(previewMode);
  const nextMode = modes[(idx + 1) % modes.length];
  // Persist to server (shared across all users). Revert UI on failure.
  const prev = previewMode;
  previewMode = nextMode;
  updatePreviewModeUI();
  renderBranches();
  try {
    await api('PUT', '/preview-mode', { mode: nextMode });
  } catch (e) {
    previewMode = prev;
    updatePreviewModeUI();
    renderBranches();
    showToast('切换预览模式失败: ' + e.message, 'error');
    return;
  }
  const labels = { simple: '简洁模式（cookie 切换）', port: '端口直连模式（无缓存问题）', multi: '子域名模式（需 PREVIEW_DOMAIN）' };
  if (nextMode === 'multi' && !previewDomain) {
    showToast('已开启子域名预览模式，但 PREVIEW_DOMAIN 未配置，预览将回退到简洁模式。请在「变量」中设置 PREVIEW_DOMAIN。', 'error');
  } else {
    showToast(`预览：${labels[nextMode]}`, 'info');
  }
}


function updatePreviewModeUI() {
  // Update the label in settings menu if open
  const label = document.querySelector('.preview-mode-label');
  const labels = { simple: '简洁', port: '端口直连', multi: '子域名' };
  if (label) label.textContent = labels[previewMode] || previewMode;
  // Update title brand color based on preview mode
  const titleEl = document.querySelector('.title-static');
  if (titleEl) {
    const gradients = {
      simple: 'linear-gradient(120deg, var(--accent) 0%, var(--blue) 50%, var(--accent) 100%)',
      port: 'linear-gradient(120deg, var(--orange, #f59e0b) 0%, var(--yellow, #eab308) 50%, var(--orange, #f59e0b) 100%)',
      multi: 'linear-gradient(120deg, var(--green, #10b981) 0%, var(--cyan, #06b6d4) 50%, var(--green, #10b981) 100%)',
    };
    titleEl.style.backgroundImage = gradients[previewMode] || gradients.simple;
  }
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

// ── Tab title override ──

async function loadTabTitleState() {
  try {
    const data = await api('GET', '/tab-title');
    tabTitleEnabled = data.enabled;
  } catch { /* ignore */ }
}

async function toggleTabTitle() {
  const newVal = !tabTitleEnabled;
  try {
    await api('PUT', '/tab-title', { enabled: newVal });
    tabTitleEnabled = newVal;
    updateTabTitleUI();
    showToast(newVal ? '标签页标题已开启' : '标签页标题已关闭', 'info');
  } catch (e) {
    showToast(e.message, 'error');
  }
}

function updateTabTitleUI() {
  const sw = document.querySelector('.settings-switch-tabtitle');
  if (sw) sw.classList.toggle('on', tabTitleEnabled);
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
    // Mark that we've completed at least one successful fetch. Until this
    // flips true, renderBranches() renders the CDS loader instead of the
    // "暂无分支" empty state, eliminating the two-step loader→empty flicker.
    _branchesFirstLoadDone = true;
    renderBranches();
    renderCapacityBadge();
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

// ── Container capacity badge (header indicator) ──
//
// Visual "fuel gauge" next to the CDS title. Battery-style fill shows
// REMAINING capacity (not used) — a full battery means plenty of room
// left for new containers, matching how people read real-world batteries.
//
//   green  (>= 40% free) — comfortable, plenty of room
//   blue   (20-40% free) — busy but fine
//   orange (0-20% free)  — low, consider stopping old branches
//   red    (0% / over)   — exhausted / over-subscribed, OOM risk, pulses
//
// Label shows "free / total" so the number next to the battery matches
// the visual fill. Clicking opens a detail popover with scheduler state.
// Sourced from `containerCapacity`, updated by loadBranches() every 10s.
// See doc/design.cds-resilience.md §八.

function renderCapacityBadge() {
  const el = document.getElementById('capacityBadge');
  if (!el) return;

  // ── Cluster-aware display ──
  //
  // We only switch to the "cluster" UI when there is ACTUALLY more than
  // one node. A `cdsMode === 'scheduler'` with only the embedded master
  // (remoteCount === 0) used to render as a cluster, which made the badge
  // show the generic "集群 ..." placeholder instead of the familiar
  // container-slot battery. That confused users in single-node scheduler
  // mode ("我是一个人怎么就成集群了"). We now require at least one
  // remote node to enter cluster mode — single-node always uses the
  // well-established single-node battery.
  const remoteCount = (executors || []).filter(e => (e.role || 'remote') !== 'embedded').length;
  const isCluster = remoteCount > 0;

  if (isCluster) {
    // Wait for the first SSE tick to deliver real cluster data before we
    // render anything — otherwise we'd briefly show 0/0 at page load.
    if (!clusterCapacity) {
      // Show a neutral placeholder so the header doesn't flicker
      el.classList.remove('hidden');
      el.dataset.tier = 'blue';
      el.dataset.cluster = '1';
      el.setAttribute('title', '集群模式加载中...');
      el.innerHTML = `
        <span class="cap-battery">
          <span class="cap-battery-fill" style="width:100%"></span>
        </span>
        <span class="cap-label">集群 ...</span>
      `;
      return;
    }

    const cap = clusterCapacity;
    const maxBranches = cap?.total?.maxBranches || 0;
    const usedBranches = cap?.used?.branches || 0;
    const free = Math.max(0, maxBranches - usedBranches);
    const freeRatio = maxBranches > 0 ? free / maxBranches : 1;
    const fillPct = Math.round(freeRatio * 100);
    const freePercent = cap?.freePercent || 0;

    let tier;
    if (freeRatio >= 0.4) tier = 'green';
    else if (freeRatio >= 0.2) tier = 'blue';
    else if (freeRatio > 0)   tier = 'orange';
    else                      tier = 'red';

    const nodesTotal = (cap?.nodes?.length) || 0;
    const nodesOnline = (cap?.online || 0);
    // Label: "2 节点 · 47/49" — unit is now "容器槽" (container slots)
    // following the user's feedback "单位分支是有问题的，有些分支可能有10个容器".
    // We count container slots = (memGB - 1) * 2, matching the existing
    // local dashboard formula so A's 94 GB ≈ 186 slots, B's 3.6 GB ≈ 4 slots,
    // cluster total ≈ 190 slots.
    const label = `${nodesOnline} 节点 · ${free}/${maxBranches}`;

    el.dataset.tier = tier;
    el.dataset.over = '0';
    el.dataset.cluster = '1';
    el.classList.remove('hidden');
    el.setAttribute('title',
      `集群模式 (${cdsMode})\n` +
      `在线节点: ${nodesOnline}/${nodesTotal}\n` +
      `容器槽: ${free}/${maxBranches} 空闲 (公式 (memGB-1)×2)\n` +
      `总内存: ${Math.round((cap?.total?.memoryMB || 0) / 1024)} GB\n` +
      `总 CPU: ${cap?.total?.cpuCores || 0} 核\n` +
      `空闲率: ${freePercent}%\n` +
      `点击查看每台节点的详情`,
    );

    el.innerHTML = `
      <span class="cap-battery">
        <span class="cap-battery-fill" style="width:${fillPct}%"></span>
      </span>
      <span class="cap-label">${label}</span>
    `;
    return;
  }

  // ── Single-node display (pre-existing behavior) ──
  el.dataset.cluster = '0';
  const max = containerCapacity.maxContainers || 0;
  const current = containerCapacity.runningContainers || 0;
  const mem = containerCapacity.totalMemGB || 0;

  // maxContainers === 999 means "not yet loaded" — keep hidden
  if (!max || max >= 999) {
    el.classList.add('hidden');
    return;
  }
  el.classList.remove('hidden');

  const free = Math.max(0, max - current);
  const freeRatio = max > 0 ? free / max : 0;
  const fillPct = Math.round(freeRatio * 100);
  const usedPct = max > 0 ? Math.min(Math.round((current / max) * 100), 999) : 0;

  let tier;
  if (freeRatio >= 0.4) tier = 'green';
  else if (freeRatio >= 0.2) tier = 'blue';
  else if (freeRatio > 0)   tier = 'orange';
  else                      tier = 'red';

  const over = current > max;
  const label = over ? `0/${max} ⚠` : `${free}/${max}`;

  el.dataset.tier = tier;
  el.dataset.over = over ? '1' : '0';
  el.setAttribute('title',
    `宿主机剩余容量: ${free}/${max} 空闲 (运行中 ${current}, ${mem}GB RAM, 已用 ${usedPct}%)${over ? '\n⚠ 已超售，OOM 风险' : ''}\n点击查看调度器详情`,
  );

  el.innerHTML = `
    <span class="cap-battery">
      <span class="cap-battery-fill" style="width:${fillPct}%"></span>
    </span>
    <span class="cap-label">${label}</span>
  `;
}

/**
 * Render a compact on/off switch for the warm-pool scheduler inside the
 * capacity popover. Clicking the switch calls `toggleSchedulerEnabled`,
 * which hits `PUT /api/scheduler/enabled` and re-renders the popover
 * with the new state. Centralized here so the off/on branches in the
 * popover markup both use the same styled button.
 */
function renderSchedulerToggleHtml(enabled) {
  return `
    <button class="scheduler-toggle ${enabled ? 'on' : 'off'}"
            onclick="toggleSchedulerEnabled(event)"
            title="${enabled ? '点击停用 warm-pool 调度器' : '点击启用 warm-pool 调度器'}">
      <span class="scheduler-toggle-track">
        <span class="scheduler-toggle-thumb"></span>
      </span>
      <span class="scheduler-toggle-label">${enabled ? '已启用' : '已停用'}</span>
    </button>
  `;
}

async function toggleSchedulerEnabled(event) {
  if (event) event.stopPropagation();
  const next = !schedulerEnabled;
  const btn = event?.currentTarget;
  if (btn) btn.disabled = true;
  try {
    const res = await fetch('/api/scheduler/enabled', {
      method: 'PUT',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: next }),
    });
    const body = await res.json();
    if (!res.ok) {
      showToast(body.error || '切换失败', 'error');
      return;
    }
    schedulerEnabled = !!body.enabled;
    showToast(schedulerEnabled ? 'Scheduler 已启用' : 'Scheduler 已停用', 'success');
    // Re-fetch and re-render the popover section so HOT/COLD lists update.
    try {
      const snap = await api('GET', '/scheduler/state');
      const target = document.getElementById('capPopScheduler');
      if (target) {
        const toggleHtml = renderSchedulerToggleHtml(snap.enabled);
        if (snap.enabled === false) {
          target.innerHTML = `
            <div class="cap-pop-row cap-pop-scheduler-off">
              <div class="cap-pop-scheduler-head">
                <strong>Scheduler: <span style="color:#8b949e">未启用</span></strong>
                ${toggleHtml}
              </div>
              <div class="cap-pop-help" style="margin-top:6px">
                启用后 CDS 会维护一个热池，按 LRU 自动休眠最久未访问的分支，避免宿主机容器超载。
              </div>
            </div>
          `;
        } else {
          const cu = snap.capacityUsage || { current: 0, max: 0 };
          const hotList = (snap.hot || []).map(h =>
            `<li>${escapeHtml(h.slug)}${h.pinned ? ' <span style="color:#3fb950">📌</span>' : ''}</li>`
          ).join('');
          const coldList = (snap.cold || []).map(c =>
            `<li style="opacity:0.6">${escapeHtml(c.slug)}</li>`
          ).join('');
          target.innerHTML = `
            <div class="cap-pop-scheduler">
              <div class="cap-pop-scheduler-head">
                <strong>Scheduler: <span style="color:#3fb950">已启用</span> (${cu.current}/${cu.max} hot)</strong>
                ${toggleHtml}
              </div>
              ${hotList ? `<div class="cap-pop-help">HOT 分支:</div><ul class="cap-pop-list">${hotList}</ul>` : ''}
              ${coldList ? `<div class="cap-pop-help">COLD 分支:</div><ul class="cap-pop-list">${coldList}</ul>` : ''}
            </div>
          `;
        }
      }
    } catch { /* keep old UI on refresh failure */ }
  } catch (err) {
    showToast('网络错误: ' + err.message, 'error');
  } finally {
    if (btn) btn.disabled = false;
  }
}

/**
 * Popover with detailed capacity + scheduler state.
 *
 * Renders two very different layouts depending on mode:
 *   - Cluster mode: per-node cards showing each executor's capacity and
 *     load, plus cluster totals at the top. Uses the same data source as
 *     the cluster settings modal (clusterCapacity from state-stream SSE).
 *   - Single-node mode: the original local container count + scheduler
 *     warm-pool state, fetched from /api/scheduler/state.
 */
async function showCapacityDetails(event) {
  event.stopPropagation();

  const remoteCount = (executors || []).filter(e => (e.role || 'remote') !== 'embedded').length;
  const isCluster = remoteCount > 0;

  if (isCluster && clusterCapacity) {
    renderClusterCapacityPopover();
    return;
  }

  // ── Single-node (pre-existing) view ──
  const max = containerCapacity.maxContainers || 0;
  const current = containerCapacity.runningContainers || 0;
  const mem = containerCapacity.totalMemGB || 0;
  const pct = max > 0 ? Math.round((current / max) * 100) : 0;
  const over = current > max;
  const free = Math.max(0, max - current);

  const schedulerHtml = '<div class="cap-pop-row"><em>Scheduler: 查询中...</em></div>';
  openConfigModal('宿主机容量', `
    <div class="cap-pop">
      <div class="cap-pop-stats">
        <div class="cap-pop-stat">
          <div class="cap-pop-stat-label">剩余容量</div>
          <div class="cap-pop-stat-value">${free} / ${max}${over ? ' ⚠' : ''}</div>
        </div>
        <div class="cap-pop-stat">
          <div class="cap-pop-stat-label">运行中</div>
          <div class="cap-pop-stat-value">${current} (${pct}%)</div>
        </div>
        <div class="cap-pop-stat">
          <div class="cap-pop-stat-label">宿主机内存</div>
          <div class="cap-pop-stat-value">${mem} GB</div>
        </div>
      </div>
      ${over ? `<div class="cap-pop-warn">⚠ 超售 ${current - max} 个容器，建议启用 scheduler 或手动停止老分支以避免 OOM。</div>` : ''}
      <div id="capPopScheduler">${schedulerHtml}</div>
      <div class="cap-pop-help">
        容量公式: <code>max = (totalMemGB - 1) × 2</code>（容器槽，按 Docker 容器计数）<br>
        scheduler 启用后会按 LRU 自动驱逐最久未访问的分支。
      </div>
    </div>
  `);

  // Fetch scheduler state asynchronously
  try {
    const snap = await api('GET', '/scheduler/state');
    const target = document.getElementById('capPopScheduler');
    if (!target) return;
    schedulerEnabled = !!snap.enabled;
    const toggleHtml = renderSchedulerToggleHtml(snap.enabled);
    if (snap.enabled === false) {
      target.innerHTML = `
        <div class="cap-pop-row cap-pop-scheduler-off">
          <div class="cap-pop-scheduler-head">
            <strong>Scheduler: <span style="color:#8b949e">未启用</span></strong>
            ${toggleHtml}
          </div>
          <div class="cap-pop-help" style="margin-top:6px">
            启用后 CDS 会维护一个热池，按 LRU 自动休眠最久未访问的分支，避免宿主机容器超载。
          </div>
        </div>
      `;
    } else {
      const cu = snap.capacityUsage || { current: 0, max: 0 };
      const hotList = (snap.hot || []).map(h =>
        `<li>${escapeHtml(h.slug)}${h.pinned ? ' <span style="color:#3fb950">📌</span>' : ''}</li>`
      ).join('');
      const coldList = (snap.cold || []).map(c =>
        `<li style="opacity:0.6">${escapeHtml(c.slug)}</li>`
      ).join('');
      target.innerHTML = `
        <div class="cap-pop-scheduler">
          <div class="cap-pop-scheduler-head">
            <strong>Scheduler: <span style="color:#3fb950">已启用</span> (${cu.current}/${cu.max} hot)</strong>
            ${toggleHtml}
          </div>
          ${hotList ? `<div class="cap-pop-help">HOT 分支:</div><ul class="cap-pop-list">${hotList}</ul>` : ''}
          ${coldList ? `<div class="cap-pop-help">COLD 分支:</div><ul class="cap-pop-list">${coldList}</ul>` : ''}
        </div>
      `;
    }
  } catch (err) {
    const target = document.getElementById('capPopScheduler');
    if (target) {
      target.innerHTML = `<div class="cap-pop-row"><em style="color:#f85149">Scheduler 查询失败: ${escapeHtml(err.message || String(err))}</em></div>`;
    }
  }
}

/**
 * Cluster-wide capacity popover. Rendered when the user clicks the header
 * badge while the dashboard is in cluster mode. Shows aggregate numbers
 * at the top and each node as a card with its own memory/CPU/branch bars.
 */
function renderClusterCapacityPopover() {
  const cap = clusterCapacity;
  const nodes = cap?.nodes || [];
  const totalMem = cap?.total?.memoryMB || 0;
  const totalMemGB = Math.round(totalMem / 1024);
  const totalCpu = cap?.total?.cpuCores || 0;
  const totalBranches = cap?.total?.maxBranches || 0;
  const usedBranches = cap?.used?.branches || 0;
  const freeBranches = Math.max(0, totalBranches - usedBranches);
  const freePercent = cap?.freePercent || 0;
  const onlineCount = cap?.online || 0;
  const offlineCount = cap?.offline || 0;

  const nodeCards = nodes.map(n => {
    const role = n.role || 'remote';
    const status = n.status || 'unknown';
    const nCap = n.capacity || { maxBranches: 0, memoryMB: 0, cpuCores: 0 };
    const nLoad = n.load || { memoryUsedMB: 0, cpuPercent: 0 };
    const memPct = nCap.memoryMB > 0 ? Math.round(nLoad.memoryUsedMB / nCap.memoryMB * 100) : 0;
    const branchPct = nCap.maxBranches > 0 ? Math.round((n.branchCount || 0) / nCap.maxBranches * 100) : 0;
    const memGB = (nLoad.memoryUsedMB / 1024).toFixed(1);
    const totalGB = (nCap.memoryMB / 1024).toFixed(1);
    const statusLabel = { online: '在线', offline: '离线', draining: '排空中' }[status] || status;
    const roleIcon = role === 'embedded'
      ? '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M8 .25a.75.75 0 01.673.418l1.882 3.815 4.21.612a.75.75 0 01.416 1.279l-3.046 2.97.719 4.192a.75.75 0 01-1.088.791L8 12.347l-3.766 1.98a.75.75 0 01-1.088-.79l.72-4.194L.818 6.374a.75.75 0 01.416-1.28l4.21-.611L7.327.668A.75.75 0 018 .25z"/></svg>'
      : '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M2 2.75A2.75 2.75 0 014.75 0h6.5A2.75 2.75 0 0114 2.75v10.5A2.75 2.75 0 0111.25 16h-6.5A2.75 2.75 0 012 13.25V2.75zm2.75-1.25a1.25 1.25 0 00-1.25 1.25v10.5c0 .69.56 1.25 1.25 1.25h6.5c.69 0 1.25-.56 1.25-1.25V2.75c0-.69-.56-1.25-1.25-1.25h-6.5zM6 4.75A.75.75 0 016.75 4h2.5a.75.75 0 010 1.5h-2.5A.75.75 0 016 4.75zm0 3A.75.75 0 016.75 7h2.5a.75.75 0 010 1.5h-2.5A.75.75 0 016 7.75zm0 3a.75.75 0 01.75-.75h2.5a.75.75 0 010 1.5h-2.5a.75.75 0 01-.75-.75z"/></svg>';

    return `
      <div class="cluster-pop-node cluster-pop-node-${status}">
        <div class="cluster-pop-node-head">
          <span class="cluster-pop-node-icon">${roleIcon}</span>
          <span class="cluster-pop-node-name">${esc(n.id)}</span>
          <span class="cluster-pop-node-pill cluster-pop-status-${status}">${statusLabel}</span>
        </div>
        <div class="cluster-pop-node-sub">${esc(n.host || '?')} · ${nCap.cpuCores} CPU · ${totalGB} GB RAM · ${role === 'embedded' ? '本机' : '远程'}</div>
        <div class="cluster-pop-node-bars">
          <div class="cluster-pop-bar">
            <div class="cluster-pop-bar-label">内存</div>
            <div class="cluster-pop-bar-track"><div class="cluster-pop-bar-fill ${memPct > 85 ? 'danger' : memPct > 65 ? 'warn' : ''}" style="width:${Math.min(memPct, 100)}%"></div></div>
            <div class="cluster-pop-bar-value">${memGB} / ${totalGB} GB</div>
          </div>
          <div class="cluster-pop-bar">
            <div class="cluster-pop-bar-label">CPU</div>
            <div class="cluster-pop-bar-track"><div class="cluster-pop-bar-fill ${nLoad.cpuPercent > 85 ? 'danger' : nLoad.cpuPercent > 65 ? 'warn' : ''}" style="width:${Math.min(nLoad.cpuPercent, 100)}%"></div></div>
            <div class="cluster-pop-bar-value">${nLoad.cpuPercent}%</div>
          </div>
          <div class="cluster-pop-bar">
            <div class="cluster-pop-bar-label">分支</div>
            <div class="cluster-pop-bar-track"><div class="cluster-pop-bar-fill" style="width:${Math.min(branchPct, 100)}%"></div></div>
            <div class="cluster-pop-bar-value">${n.branchCount || 0} / ${nCap.maxBranches}</div>
          </div>
        </div>
      </div>
    `;
  }).join('');

  openConfigModal('集群容量', `
    <div class="cluster-pop">
      <div class="cluster-pop-summary">
        <div class="cluster-pop-stat">
          <div class="cluster-pop-stat-label">节点</div>
          <div class="cluster-pop-stat-value">
            ${onlineCount}
            <span class="cluster-pop-stat-hint">/ ${onlineCount + offlineCount} 在线</span>
          </div>
        </div>
        <div class="cluster-pop-stat">
          <div class="cluster-pop-stat-label">容器槽</div>
          <div class="cluster-pop-stat-value">
            ${freeBranches}
            <span class="cluster-pop-stat-hint">/ ${totalBranches} 空闲</span>
          </div>
        </div>
        <div class="cluster-pop-stat">
          <div class="cluster-pop-stat-label">总内存</div>
          <div class="cluster-pop-stat-value">${totalMemGB}<span class="cluster-pop-stat-hint"> GB</span></div>
        </div>
        <div class="cluster-pop-stat">
          <div class="cluster-pop-stat-label">总 CPU</div>
          <div class="cluster-pop-stat-value">${totalCpu}<span class="cluster-pop-stat-hint"> 核</span></div>
        </div>
        <div class="cluster-pop-stat">
          <div class="cluster-pop-stat-label">空闲率</div>
          <div class="cluster-pop-stat-value">${freePercent}<span class="cluster-pop-stat-hint">%</span></div>
        </div>
      </div>

      <div class="cluster-pop-section-title">节点详情</div>
      <div class="cluster-pop-nodes">
        ${nodeCards}
      </div>

      <div class="cluster-pop-help">
        单节点容器槽公式: <code>(memGB - 1) × 2</code>（每容器约 500 MB RAM，减去 1 GB 系统开销）<br>
        一个分支可能跑 1-10 个容器（API + admin + DB + ...），所以我们按容器计数而不是按分支。<br>
        调度策略: <code>${esc(clusterStrategy)}</code>（在集群设置里切换）
      </div>
    </div>
  `);
}

// (escapeHtml is defined later in the file and hoisted — reused by the popover above)

// ── Host stats pulse (bottom-right MEM + CPU widget) ──
//
// Poll /api/host-stats every 5s and render compact MEM + CPU bars in the
// bottom-right, above the Activity Monitor. Complements the header's
// container capacity badge:
//   - Header badge: "how many containers" (business/capacity view)
//   - This widget: "how stressed is the host" (raw resource view)
//
// Hidden until the first successful fetch to avoid rendering "--".
// Disabled entirely if CDS is unreachable (fetch silently fails, widget
// fades out via CSS transition).

let _hostStatsLastData = null;
let _hostStatsFailCount = 0;

async function pollHostStats() {
  try {
    const data = await api('GET', '/host-stats', null, { poll: true });
    _hostStatsLastData = data;
    _hostStatsFailCount = 0;
    renderHostStats(data);
  } catch (err) {
    _hostStatsFailCount++;
    // Hide widget after 3 consecutive failures (probably CDS restart in progress)
    if (_hostStatsFailCount >= 3) {
      const el = document.getElementById('hostStatsWidget');
      if (el) el.classList.add('hidden');
    }
  }
}

function renderHostStats(data) {
  const el = document.getElementById('hostStatsWidget');
  if (!el) return;
  el.classList.remove('hidden');

  const memPct = data.mem?.usedPercent ?? 0;
  const cpuPct = data.cpu?.loadPercent ?? 0;

  // Memory bar
  const memFill = document.getElementById('hsMemFill');
  const memValue = document.getElementById('hsMemValue');
  if (memFill) {
    memFill.style.width = `${Math.min(memPct, 100)}%`;
    memFill.dataset.tier = tierForPercent(memPct);
  }
  if (memValue) memValue.textContent = `${memPct}%`;

  // CPU bar — loadPercent can exceed 100 on oversubscribed hosts, cap the fill
  const cpuFill = document.getElementById('hsCpuFill');
  const cpuValue = document.getElementById('hsCpuValue');
  if (cpuFill) {
    cpuFill.style.width = `${Math.min(cpuPct, 100)}%`;
    cpuFill.dataset.tier = tierForPercent(cpuPct);
  }
  if (cpuValue) cpuValue.textContent = `${cpuPct}%`;

  // Whole-widget warning if either metric is critical (>= 90%)
  el.dataset.stress = (memPct >= 90 || cpuPct >= 90) ? '1' : '0';
}

function tierForPercent(pct) {
  if (pct >= 90) return 'red';
  if (pct >= 75) return 'orange';
  if (pct >= 50) return 'blue';
  return 'green';
}

async function showHostStatsDetails(event) {
  event.stopPropagation();
  const d = _hostStatsLastData;
  if (!d) return;
  const uptimeDays = Math.floor(d.uptimeSeconds / 86400);
  const uptimeHours = Math.floor((d.uptimeSeconds % 86400) / 3600);
  const uptimeMinutes = Math.floor((d.uptimeSeconds % 3600) / 60);
  const uptimeStr = uptimeDays > 0
    ? `${uptimeDays}d ${uptimeHours}h`
    : uptimeHours > 0
    ? `${uptimeHours}h ${uptimeMinutes}m`
    : `${uptimeMinutes}m`;

  openConfigModal('宿主机实时负载', `
    <div class="cap-pop">
      <div class="cap-pop-stats">
        <div class="cap-pop-stat">
          <div class="cap-pop-stat-label">内存使用</div>
          <div class="cap-pop-stat-value">${d.mem.usedPercent}%</div>
          <div class="cap-pop-help">${Math.round((d.mem.totalMB - d.mem.freeMB) / 1024 * 10) / 10} / ${Math.round(d.mem.totalMB / 1024 * 10) / 10} GB</div>
        </div>
        <div class="cap-pop-stat">
          <div class="cap-pop-stat-label">CPU 负载</div>
          <div class="cap-pop-stat-value">${d.cpu.loadPercent}%</div>
          <div class="cap-pop-help">${d.cpu.loadAvg1} / ${d.cpu.cores} 核</div>
        </div>
        <div class="cap-pop-stat">
          <div class="cap-pop-stat-label">系统运行</div>
          <div class="cap-pop-stat-value">${uptimeStr}</div>
          <div class="cap-pop-help">uptime</div>
        </div>
      </div>
      <div class="cap-pop-scheduler">
        <strong>负载历史 (loadavg)</strong>
        <div class="cap-pop-help" style="margin-top:6px">
          1 分钟: <strong>${d.cpu.loadAvg1}</strong> &nbsp;·&nbsp;
          5 分钟: <strong>${d.cpu.loadAvg5}</strong> &nbsp;·&nbsp;
          15 分钟: <strong>${d.cpu.loadAvg15}</strong>
        </div>
        <div class="cap-pop-help" style="margin-top:6px">
          宿主机共 ${d.cpu.cores} 个逻辑核,loadavg > ${d.cpu.cores} 时 CPU 过载。
        </div>
      </div>
      <div class="cap-pop-help">
        这是 Node.js <code>os.totalmem()</code> + <code>os.loadavg()</code> 的实时快照,
        每 5 秒通过 <code>/api/host-stats</code> 轮询。
        <br>和 header 上的"容器容量"互为补充:一个看业务维度(容器数),一个看资源维度(内存/CPU)。
      </div>
    </div>
  `);
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

function checkCapacityAndDeploy(id, profileId, targetExecutorId) {
  // If we're dispatching to a specific remote executor OR the cluster has
  // remote executors available, skip the local capacity warning entirely.
  // Capacity is checked on the target executor side, not here.
  const remoteOnline = (executors || []).filter(e => (e.role || 'remote') !== 'embedded' && e.status === 'online').length;
  if (targetExecutorId || remoteOnline > 0) {
    if (profileId) deploySingleServiceDirect(id, profileId);
    else deployBranchDirect(id, targetExecutorId);
    return;
  }

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

/**
 * Cluster-aware deploy entry point (P0 #3).
 *
 * `targetExecutorId` semantics:
 *   - null / undefined → let the backend dispatcher pick by strategy
 *   - '<executor-id>'  → force deploy to that specific node (also used to
 *     "pin" a branch back to the embedded master when migrating away from
 *     a remote executor)
 *
 * The backend's POST /api/branches/:id/deploy reads the targetExecutorId
 * from the request body and proxies to the chosen executor's /exec/deploy.
 */
async function deployToTarget(id, targetExecutorId) {
  // Remember the target for this session so the next "quick deploy" click
  // (the main button) doesn't lose the pinning. We stash it on the branch
  // object in memory — the backend will echo it back via state-stream.
  const br = branches.find(b => b.id === id);
  if (br && targetExecutorId) br.executorId = targetExecutorId;
  checkCapacityAndDeploy(id, null, targetExecutorId);
}

async function deployBranchDirect(id, targetExecutorId) {
  if (busyBranches.has(id)) return;
  markTouched(id);
  busyBranches.add(id);
  // Clear previous error message immediately on new deploy
  const br = branches.find(b => b.id === id);
  if (br) { br.errorMessage = undefined; br.status = 'building'; }
  inlineDeployLogs.set(id, { lines: [], status: 'building', expanded: false });
  renderBranches();

  try {
    const body = targetExecutorId ? { targetExecutorId } : {};
    const res = await fetch(`${API}/branches/${id}/deploy`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
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

  // ── Mode: port (dynamic preview port with path-prefix routing) ──
  if (previewMode === 'port') {
    const branch = branches.find(b => b.id === slug);
    if (!branch || branch.status !== 'running') {
      showToast('分支未运行，无法预览', 'error');
      return;
    }
    try {
      const result = await api('POST', `/branches/${slug}/preview-port`);
      const url = `${location.protocol}//${location.hostname}:${result.port}`;
      window.open(url, '_blank');
    } catch (e) {
      showToast('创建预览端口失败: ' + e.message, 'error');
    }
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
  // Immediately set deleting state for visual feedback (borrowing stopping-pulse style)
  const br = branches.find(b => b.id === id);
  if (br) {
    br.status = 'deleting';
    for (const svc of Object.values(br.services || {})) {
      svc.status = 'stopping';
    }
  }
  renderBranches();
  try {
    const res = await fetch(`${API}/branches/${id}`, { method: 'DELETE' });
    // SSE stream — just consume it
    const reader = res.body.getReader();
    while (!(await reader.read()).done) {}
    // Collapse animation before removing from DOM
    const card = document.querySelector(`.branch-card[data-branch-id="${CSS.escape(id)}"]`);
    if (card) {
      card.classList.add('deleting-collapse');
      await new Promise(r => card.addEventListener('animationend', r, { once: true }));
    }
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

  // Update data model immediately
  branch.isColorMarked = newVal;
  // Toggle button state immediately for visual feedback
  btn.classList.toggle('active', newVal);

  // Card-scoped ripple transition: delay class toggle until ripple completes
  if (card) {
    const cardRect = card.getBoundingClientRect();
    const btnRect = btn.getBoundingClientRect();
    const x = btnRect.left + btnRect.width / 2 - cardRect.left;
    const y = btnRect.top + btnRect.height / 2 - cardRect.top;
    // +4px 余量确保圆弧完全覆盖 border-box 角落（含 2px border + 圆角）
    const maxRadius = Math.ceil(Math.sqrt(
      Math.max(x, cardRect.width - x) ** 2 +
      Math.max(y, cardRect.height - y) ** 2
    )) + 4;

    // Tint overlay (content area)
    const overlay = document.createElement('div');
    overlay.className = 'color-mark-ripple';
    overlay.style.setProperty('--cm-ripple-x', `${x}px`);
    overlay.style.setProperty('--cm-ripple-y', `${y}px`);
    overlay.style.setProperty('--cm-ripple-radius', `${maxRadius}px`);
    overlay.classList.add(newVal ? 'ripple-marked' : 'ripple-normal');
    card.appendChild(overlay);

    // Border overlay: gold background with inner circle cutout → animated ring
    const borderEl = document.createElement('div');
    borderEl.className = 'cm-border-ring';
    borderEl.style.setProperty('--cm-ripple-x', `${x}px`);
    borderEl.style.setProperty('--cm-ripple-y', `${y}px`);
    borderEl.style.setProperty('--cm-ripple-radius', `${maxRadius}px`);
    borderEl.classList.add(newVal ? 'ring-marked' : 'ring-normal');
    card.appendChild(borderEl);

    // Arc ring: gold circle that expands from click point (visible shockwave)
    const arcRing = document.createElement('div');
    arcRing.className = 'cm-arc-ring';
    const diameter = maxRadius * 2;
    arcRing.style.width = `${diameter}px`;
    arcRing.style.height = `${diameter}px`;
    arcRing.style.left = `${x - maxRadius}px`;
    arcRing.style.top = `${y - maxRadius}px`;
    if (!newVal) {
      arcRing.style.borderColor = 'rgba(180,180,180,0.4)';
      arcRing.style.boxShadow = '0 0 8px 1px rgba(180,180,180,0.15)';
    }
    card.appendChild(arcRing);

    overlay.offsetHeight;
    overlay.classList.add('animate');
    borderEl.classList.add('animate');
    arcRing.classList.add('animate');

    borderEl.addEventListener('animationend', () => {
      card.classList.toggle('is-color-marked', newVal);
      overlay.remove();
      borderEl.remove();
      arcRing.remove();
    }, { once: true });
  } else {
    // No card element — apply immediately
    card?.classList.toggle('is-color-marked', newVal);
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

async function editBranchTags(id, event) {
  event.stopPropagation();
  const branch = branches.find(b => b.id === id);
  if (!branch) return;
  const currentTags = (branch.tags || []).join(', ');
  const input = prompt('编辑标签（逗号分隔）:', currentTags);
  if (input === null) return; // cancelled
  const newTags = input.split(/[,，]/).map(t => t.trim()).filter(Boolean);
  const oldTags = [...(branch.tags || [])];
  // Optimistic update
  branch.tags = newTags;
  renderBranches();
  renderTagFilterBar();
  try {
    await api('PATCH', `/branches/${id}`, { tags: newTags });
    showToast('标签已保存', 'success');
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
      <pre id="pruneLog" style="text-align:left;font-size:11px;color:var(--text-secondary);background:var(--bg-code-block, rgba(8,12,28,0.6));border:1px solid var(--border);border-radius:var(--radius-sm);padding:10px 12px;margin:12px 0;max-height:200px;overflow-y:auto;white-space:pre-wrap;font-family:var(--font-mono)">正在扫描本地分支...</pre>
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
      <pre id="orphanCleanupLog" style="text-align:left;font-size:11px;color:var(--text-secondary);background:var(--bg-code-block, rgba(8,12,28,0.6));border:1px solid var(--border);border-radius:var(--radius-sm);padding:10px 12px;margin:12px 0;max-height:200px;overflow-y:auto;white-space:pre-wrap;font-family:var(--font-mono)">正在获取远程分支信息...</pre>
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
  // Measure after appending (display must not be 'none')
  const w = el.offsetWidth || 140;
  const h = el.offsetHeight || 0;

  // ── Vertical placement (P2 #12 fix) ──
  //
  // Previously this always placed the dropdown BELOW the anchor, which
  // caused the menu to run off-screen when the branch card was near the
  // window bottom (user saw "api: 开发模式..." truncated by the viewport).
  // Now we flip to ABOVE when the menu wouldn't fit below; if neither fits
  // we clamp to whichever side has more room and set max-height so the
  // menu scrolls internally.
  const margin = 8;
  const spaceBelow = window.innerHeight - r.bottom - margin;
  const spaceAbove = r.top - margin;
  if (h + 4 <= spaceBelow) {
    el.style.top = `${r.bottom + 4}px`;
    el.style.maxHeight = '';
  } else if (h + 4 <= spaceAbove) {
    // Flip up — place the bottom of the menu just above the anchor.
    el.style.top = `${r.top - h - 4}px`;
    el.style.maxHeight = '';
  } else {
    // Neither side fits the full menu. Pick whichever has more room and
    // constrain the menu height so it scrolls internally instead of
    // overflowing the viewport.
    if (spaceBelow >= spaceAbove) {
      el.style.top = `${r.bottom + 4}px`;
      el.style.maxHeight = `${Math.max(spaceBelow, 120)}px`;
    } else {
      el.style.maxHeight = `${Math.max(spaceAbove, 120)}px`;
      el.style.top = `${margin}px`;
    }
    el.style.overflowY = 'auto';
  }

  // ── Horizontal placement (unchanged) ──
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
    <div class="settings-menu-item" onclick="closeSettingsMenu(); openMigrationModal()">
      <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M5.22 14.78a.75.75 0 001.06-1.06L4.56 12h8.69a.75.75 0 000-1.5H4.56l1.72-1.72a.75.75 0 00-1.06-1.06l-3 3a.75.75 0 000 1.06l3 3zm5.56-6.5a.75.75 0 11-1.06-1.06L11.44 5.5H2.75a.75.75 0 010-1.5h8.69L9.72 2.28a.75.75 0 011.06-1.06l3 3a.75.75 0 010 1.06l-3 3z"/></svg>
      数据迁移
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
    <div class="settings-menu-item" onclick="closeSettingsMenu(); openClusterModal()">
      <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M3 2.5a.5.5 0 01.5-.5h9a.5.5 0 01.5.5v2a.5.5 0 01-.5.5h-9a.5.5 0 01-.5-.5v-2zM3.5 1A1.5 1.5 0 002 2.5v2A1.5 1.5 0 003.5 6h9A1.5 1.5 0 0014 4.5v-2A1.5 1.5 0 0012.5 1h-9zM3 7.5a.5.5 0 01.5-.5h9a.5.5 0 01.5.5v2a.5.5 0 01-.5.5h-9a.5.5 0 01-.5-.5v-2zM3.5 6A1.5 1.5 0 002 7.5v2A1.5 1.5 0 003.5 11h9A1.5 1.5 0 0014 9.5v-2A1.5 1.5 0 0012.5 6h-9zm0 6A1.5 1.5 0 002 13.5v1A1.5 1.5 0 003.5 16h9a1.5 1.5 0 001.5-1.5v-1a1.5 1.5 0 00-1.5-1.5h-9zm0 1h9a.5.5 0 01.5.5v1a.5.5 0 01-.5.5h-9a.5.5 0 01-.5-.5v-1a.5.5 0 01.5-.5z"/></svg>
      集群
      <span id="clusterStatusBadge" style="margin-left:auto;font-size:11px;color:#8b949e"></span>
    </div>
    ${(clusterEffectiveRole === 'executor' || clusterEffectiveRole === 'hybrid') ? `
    <div class="settings-menu-item danger" onclick="closeSettingsMenu(); doLeaveCluster()">
      <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M2 2.75C2 1.784 2.784 1 3.75 1h2.5a.75.75 0 010 1.5h-2.5a.25.25 0 00-.25.25v10.5c0 .138.112.25.25.25h2.5a.75.75 0 010 1.5h-2.5A1.75 1.75 0 012 13.25V2.75zm10.44 4.5H6.75a.75.75 0 000 1.5h5.69l-1.97 1.97a.749.749 0 101.06 1.06l3.25-3.25a.749.749 0 000-1.06l-3.25-3.25a.749.749 0 10-1.06 1.06l1.97 1.97z"/></svg>
      退出集群
      <span style="margin-left:auto;font-size:11px;color:#8b949e">${clusterEffectiveRole === 'hybrid' ? '混合模式' : '执行器'}</span>
    </div>
    ` : ''}
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
    <div class="settings-menu-item settings-menu-switch" onclick="toggleTabTitle()">
      <span class="settings-menu-switch-label">标签页标题</span>
      <span class="settings-switch settings-switch-tabtitle ${tabTitleEnabled ? 'on' : ''}">
        <span class="settings-switch-track">
          <span class="settings-switch-thumb"></span>
        </span>
      </span>
    </div>
    <div class="settings-menu-item" onclick="closeSettingsMenu(); openSelfUpdate()">
      <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M8 2.5a5.487 5.487 0 00-4.131 1.869l1.204 1.204A.25.25 0 014.896 6H1.25A.25.25 0 011 5.75V2.104a.25.25 0 01.427-.177l1.38 1.38A7.002 7.002 0 0114.95 7.16a.75.75 0 01-1.49.178A5.5 5.5 0 008 2.5zm6.294 5.505a.75.75 0 01.834.656 5.5 5.5 0 01-9.592 2.97l1.204-1.204a.25.25 0 00-.177-.427H3.354a.25.25 0 01-.354-.354l1.38-1.38A7.002 7.002 0 0014.95 7.16z"/><circle cx="8" cy="8" r="2"/></svg>
      自动更新
    </div>
    <div class="settings-menu-divider"></div>
    <div class="settings-menu-item danger" onclick="closeSettingsMenu(); openCleanupModal()">
      <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M6.5 1.75a.25.25 0 01.25-.25h2.5a.25.25 0 01.25.25V3h-3V1.75zM11 3V1.75A1.75 1.75 0 009.25 0h-2.5A1.75 1.75 0 005 1.75V3H2.75a.75.75 0 000 1.5h.3l.8 8.2A1.75 1.75 0 005.6 14.5h4.8a1.75 1.75 0 001.75-1.8l.8-8.2h.3a.75.75 0 000-1.5H11z"/></svg>
      清理分支
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

// ── Export modal (merged 导出配置 + 导出部署技能) ──

function openExportModal() {
  const html = `
    <div style="display:flex;flex-direction:column;gap:10px">
      <button class="btn-export-option" onclick="closeConfigModal(); exportConfig()">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M3.5 13a.5.5 0 01-.5-.5V3a.5.5 0 01.5-.5h5.586a.5.5 0 01.354.146l3.414 3.414a.5.5 0 01.146.354V12.5a.5.5 0 01-.5.5h-9z"/></svg>
        <div>
          <div style="font-weight:600;font-size:14px">导出配置</div>
          <div style="font-size:12px;color:var(--text-muted);margin-top:2px">导出 CDS Compose YAML（构建配置 + 环境变量）</div>
        </div>
      </button>
      <button class="btn-export-option" onclick="closeConfigModal(); exportSkill()">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M3.5 1.75a.25.25 0 01.25-.25h3.5a.75.75 0 000-1.5h-3.5A1.75 1.75 0 002 1.75v11.5c0 .966.784 1.75 1.75 1.75h8.5A1.75 1.75 0 0014 13.25v-6a.75.75 0 00-1.5 0v6a.25.25 0 01-.25.25h-8.5a.25.25 0 01-.25-.25V1.75z"/><path d="M11.78.22a.75.75 0 00-1.06 0L6.22 4.72a.75.75 0 000 1.06l.53.53-2.97 2.97a.75.75 0 101.06 1.06l2.97-2.97.53.53a.75.75 0 001.06 0l4.5-4.5a.75.75 0 000-1.06L11.78.22z"/></svg>
        <div>
          <div style="font-weight:600;font-size:14px">导出部署技能</div>
          <div style="font-size:12px;color:var(--text-muted);margin-top:2px">生成 AI Agent 可用的 CDS 部署技能文件</div>
        </div>
      </button>
    </div>
  `;
  openConfigModal('导出', html);
}

// ── Cleanup modal (merged 3 cleanup actions) ──

function openCleanupModal() {
  const html = `
    <div style="display:flex;flex-direction:column;gap:10px">
      <button class="btn-export-option btn-danger-option" onclick="closeConfigModal(); pruneStaleBranches()">
        <span style="font-size:20px">🧹</span>
        <div>
          <div style="font-weight:600;font-size:14px">清理非列表分支</div>
          <div style="font-size:12px;color:var(--text-muted);margin-top:2px">删除本地 git 中不在 CDS 部署列表上的分支</div>
        </div>
      </button>
      <button class="btn-export-option btn-danger-option" onclick="closeConfigModal(); cleanupOrphans()">
        <span style="font-size:20px">🔍</span>
        <div>
          <div style="font-weight:600;font-size:14px">清理孤儿分支</div>
          <div style="font-size:12px;color:var(--text-muted);margin-top:2px">清理本地存在但远程已删除的分支</div>
        </div>
      </button>
      <button class="btn-export-option btn-danger-option" onclick="closeConfigModal(); cleanupAll()">
        <span style="font-size:20px">🗑️</span>
        <div>
          <div style="font-weight:600;font-size:14px">清理全部分支</div>
          <div style="font-size:12px;color:var(--text-muted);margin-top:2px">停止并删除所有非默认分支的容器和 worktree</div>
        </div>
      </button>
    </div>
  `;
  openConfigModal('清理分支', html);
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

/**
 * Designed empty state for the branch list.
 *
 * Replaces the old single-line `<div class="empty-state">暂无分支...</div>`
 * italic text. Rendered only AFTER the first successful /api/branches fetch
 * (see `_branchesFirstLoadDone`) so it never flashes as a transitional state
 * during the initial loader animation. Follows the `guided-exploration.md`
 * rule: empty state must have说明 + 主操作 CTA + 可选插图.
 */
function renderEmptyBranchesState() {
  const onFocusSearch = "document.getElementById('branchSearch')?.focus()";
  return `
    <div class="branches-empty">
      <div class="branches-empty-illustration" aria-hidden="true">
        <svg width="88" height="88" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="6" cy="3" r="2"/>
          <circle cx="6" cy="21" r="2"/>
          <circle cx="18" cy="12" r="2"/>
          <path d="M6 5v14"/>
          <path d="M6 12h12"/>
        </svg>
      </div>
      <div class="branches-empty-title">还没有部署任何分支</div>
      <div class="branches-empty-hint">
        在顶部搜索框输入 Git 分支名（支持前缀/后缀匹配），选中后 CDS 会为它创建工作树并自动构建。
      </div>
      <button class="branches-empty-cta" onclick="${onFocusSearch}">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M11.5 7a4.499 4.499 0 11-8.998 0A4.499 4.499 0 0111.5 7zm-.82 4.74a6 6 0 111.06-1.06l3.04 3.04a.75.75 0 11-1.06 1.06l-3.04-3.04z"/></svg>
        搜索并添加分支
      </button>
    </div>
  `;
}

function renderBranches() {
  // Save scroll position before re-render
  const scrollY = window.scrollY;
  const el = document.getElementById('branchList');
  // 分支数量已从 header 移除，标题区仅显示 "Cloud Dev Suite"

  if (branches.length === 0) {
    // ── First-paint protection ──
    //
    // Before the first successful /api/branches fetch, we keep whatever
    // is already in #branchList (normally the CDS loader shipped in the
    // HTML). This prevents the jarring two-step "loader → 暂无分支 → data"
    // flicker on page open.
    if (!_branchesFirstLoadDone) {
      if (!el.querySelector('.cds-loading-state')) {
        // Stale content somehow — re-inject the loader so the first
        // paint still has motion.
        el.innerHTML = `
          <div class="cds-loading-state">
            <div class="cds-loading-glow"></div>
            <div class="cds-loading-letters">
              <span class="cds-letter" style="--delay:0ms;--color:var(--accent,#e8e8ec)">C</span>
              <span class="cds-letter" style="--delay:120ms;--color:var(--text-secondary,#a0a0b0)">D</span>
              <span class="cds-letter" style="--delay:240ms;--color:var(--text-muted,#78788a)">S</span>
            </div>
            <div class="cds-loading-bar"></div>
            <div class="cds-loading-hint">加载中</div>
          </div>
        `;
      }
      window.scrollTo(0, scrollY);
      return;
    }
    el.innerHTML = renderEmptyBranchesState();
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
    const deployMenuItems = buildProfiles.map(p => {
      const modeTag = p.activeDeployMode && p.deployModes?.[p.activeDeployMode]
        ? ` <span style="font-size:10px;opacity:0.6">(${esc(p.deployModes[p.activeDeployMode].label)})</span>`
        : '';
      return `<div class="deploy-menu-item" onclick="deploySingleService('${esc(b.id)}', '${esc(p.id)}')">${esc(p.name)}${modeTag}</div>`;
    }).join('');

    // Build deploy mode menu items for the left deploy button
    const allModes = [];
    for (const p of buildProfiles) {
      if (p.deployModes && Object.keys(p.deployModes).length > 0) {
        for (const [modeId, mode] of Object.entries(p.deployModes)) {
          allModes.push({ profileId: p.id, profileName: p.name, modeId, label: mode.label || modeId, active: p.activeDeployMode === modeId });
        }
      }
    }
    const hasDeployModes = allModes.length > 0;
    const deployModeMenuItems = hasDeployModes
      ? allModes.map(m => {
          const check = m.active ? '✓ ' : '';
          return `<div class="deploy-menu-item" onclick="event.stopPropagation(); closeDeployMenu(); switchModeAndDeploy('${esc(b.id)}', '${esc(m.profileId)}', '${esc(m.modeId)}')">${check}${esc(m.profileName)}: ${esc(m.label)}</div>`;
        }).join('')
      : '';

    // Build stop menu item for deploy dropdown
    const stopMenuItem = isRunning ? `<div class="deploy-menu-divider"></div><div class="deploy-menu-item deploy-menu-item-danger" onclick="event.stopPropagation(); closeDeployMenu('${esc(b.id)}'); stopBranch('${esc(b.id)}')">停止所有服务</div>` : '';

    // Executor tag — rendered as the first chip in the port-badges row when
    // the branch is dispatched to a remote executor. We deliberately put it
    // at the START of that row (same visual group as "where things run")
    // instead of next to the branch name, because:
    //   1. The branch name + executor-id together overflowed on long names
    //   2. The port badges row is semantically "placement info" already —
    //      ⚡ <node> fits right in as "placed on <node>"
    //   3. Distinct styling (gold ⚡ icon + different bg) keeps it from
    //      being confused with a regular port badge
    // Hidden entirely when the branch runs on the embedded master (local)
    // or single-node mode, to avoid clutter.
    const remoteExecForThisBranch =
      b.executorId && !b.executorId.startsWith('master-')
        ? (executors || []).find(e => e.id === b.executorId)
        : null;
    const executorTagHtml = remoteExecForThisBranch
      ? `<span class="executor-tag port-row-exec ${remoteExecForThisBranch.status === 'offline' ? 'offline' : ''}"
              title="部署在执行器 ${esc(b.executorId)} (${esc(remoteExecForThisBranch.host)})${remoteExecForThisBranch.status === 'offline' ? ' — 已离线' : ''}">
          ⚡ ${esc(b.executorId.replace(/^executor-/, '').slice(0, 24))}
        </span>`
      : '';

    // Port badges — icon + name:port, icon from profile config
    const portBadgesInner = services.length > 0 ? services.map(([pid, svc]) => {
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
    const portBadgesHtml = (executorTagHtml || portBadgesInner)
      ? `${executorTagHtml}${portBadgesInner}`
      : '';

    // Tags — shown below header (dimmed when not deployed)
    const branchTags = b.tags || [];
    const tagDimClass = isRunning ? '' : ' branch-tag-dim';
    const tagsHtml = `
      <div class="branch-tags-line">
        ${branchTags.map(t => `
          <span class="branch-tag${tagDimClass}" onclick="event.stopPropagation(); filterByTag('${esc(t)}')" title="筛选标签: ${esc(t)}">
            ${ICON.tag} ${esc(t)}
            <span class="branch-tag-remove" onclick="event.stopPropagation(); removeTagFromBranch('${esc(b.id)}', '${esc(t)}', event)" title="删除标签">&times;</span>
          </span>
        `).join('')}
        <span class="branch-tag-add" onclick="addTagToBranch('${esc(b.id)}', event)" title="添加标签">+ 标签</span>
        <span class="branch-tag-edit" onclick="editBranchTags('${esc(b.id)}', event)" title="编辑标签">${ICON.edit}</span>
      </div>
    `;

    // Actions row: left = safe actions, right = dangerous actions
    // When container not running (stopped/idle): only show deploy button
    let actionsLeftHtml = '';
    let actionsRightHtml = '';

    // Cluster dispatch submenu — only shown when there's a cluster to
    // dispatch to. Lets the user force a specific target executor for this
    // deploy. "auto" falls through to the dispatcher's strategy.
    const remoteExecs = (executors || []).filter(e => (e.role || 'remote') !== 'embedded' && e.status === 'online');
    const hasCluster = remoteExecs.length > 0;
    const currentTarget = b.executorId;
    const targetMenuItems = hasCluster ? `
      <div class="deploy-menu-divider"></div>
      <div class="deploy-menu-header">派发到 (${remoteExecs.length + 1} 节点)</div>
      <div class="deploy-menu-item" onclick="event.stopPropagation(); closeDeployMenu('${esc(b.id)}'); deployToTarget('${esc(b.id)}', null)">
        ${!currentTarget || currentTarget.startsWith('master-') ? '✓ ' : ''}自动 (按策略 ${esc(clusterStrategy)})
      </div>
      ${(executors || []).map(ex => {
        if (ex.status !== 'online') return '';
        const checked = currentTarget === ex.id ? '✓ ' : '';
        const shortId = ex.id.replace(/^executor-/, '').replace(/^master-/, '').slice(0, 20);
        const roleTag = ex.role === 'embedded' ? ' (本机)' : '';
        return `<div class="deploy-menu-item" onclick="event.stopPropagation(); closeDeployMenu('${esc(b.id)}'); deployToTarget('${esc(b.id)}', '${esc(ex.id)}')">${checked}${esc(shortId)}${roleTag}</div>`;
      }).join('')}
    ` : '';

    // Unified deploy menu template (shared across states)
    const deployMenuTpl = `
      <template id="deploy-menu-tpl-${esc(b.id)}">
        ${hasMultipleProfiles ? `<div class="deploy-menu-header">选择服务</div>${deployMenuItems}` : ''}
        ${hasDeployModes ? `${hasMultipleProfiles ? '<div class="deploy-menu-divider"></div>' : ''}<div class="deploy-menu-header">部署模式</div>${deployModeMenuItems}` : ''}
        ${targetMenuItems}
        ${isRunning ? `<div class="deploy-menu-divider"></div>
        <div class="deploy-menu-item" onclick="event.stopPropagation(); closeDeployMenu('${esc(b.id)}'); viewBranchLogs('${esc(b.id)}')"><svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" style="vertical-align:-1px;margin-right:4px"><path d="M1 2.75C1 1.784 1.784 1 2.75 1h10.5c.966 0 1.75.784 1.75 1.75v7.5A1.75 1.75 0 0113.25 12H9.06l-2.573 2.573A1.458 1.458 0 014 13.543V12H2.75A1.75 1.75 0 011 10.25v-7.5zm1.5 0a.25.25 0 01.25-.25h10.5a.25.25 0 01.25.25v7.5a.25.25 0 01-.25.25h-4.5a.75.75 0 00-.75.75v2.19l-2.72-2.72a.75.75 0 00-.53-.22H2.75a.25.25 0 01-.25-.25v-7.5z"/></svg>部署日志</div>
        ${stopMenuItem}` : ''}
        <div class="deploy-menu-divider"></div>
        <div class="deploy-menu-item" onclick="event.stopPropagation(); closeDeployMenu('${esc(b.id)}'); openOverrideModal('${esc(b.id)}')"><svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" style="vertical-align:-1px;margin-right:4px"><path d="M8 0a8 8 0 100 16A8 8 0 008 0zM1.5 8a6.5 6.5 0 1113 0 6.5 6.5 0 01-13 0zM8 4a.75.75 0 01.75.75v2.5h2.5a.75.75 0 010 1.5h-2.5v2.5a.75.75 0 01-1.5 0v-2.5h-2.5a.75.75 0 010-1.5h2.5v-2.5A.75.75 0 018 4z"/></svg>容器配置 (继承/覆盖)</div>
        <div class="deploy-menu-divider"></div>
        <div class="deploy-menu-item deploy-menu-item-danger" onclick="event.stopPropagation(); closeDeployMenu('${esc(b.id)}'); removeBranch('${esc(b.id)}')">${ICON.trash} 删除分支</div>
      </template>
    `;

    // Dropdown is always shown now — the menu always contains at least
    // "容器配置" + "删除分支", so the toggle is always useful. This replaces
    // the previous logic that only showed the toggle for multi-profile /
    // deploy-mode / running branches.
    const hasDropdown = true;
    const deployBtnLabel = isRunning ? '更新' : '部署';

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
          <button class="sm split-btn-main deploy-glow-btn" onclick="deployBranch('${esc(b.id)}')" ${isBusy ? 'disabled' : ''} title="拉取最新代码并重新部署">${ICON.deploy} ${deployBtnLabel}</button>
          ${hasDropdown ? `<button class="sm split-btn-toggle" onclick="toggleDeployMenu('${esc(b.id)}', event)" ${isBusy ? 'disabled' : ''}>
            <svg width="10" height="6" viewBox="0 0 10 6" fill="currentColor"><path d="M1 1l4 4 4-4"/></svg>
          </button>` : ''}
          ${deployMenuTpl}
        </div>
      `;
    } else {
      // Stopped / idle / error — single deploy button with optional dropdown
      actionsLeftHtml = `
        <div class="split-btn">
          <button class="sm split-btn-main deploy-glow-btn" onclick="deployBranch('${esc(b.id)}')" ${isBusy ? 'disabled' : ''} title="${deployBtnLabel}">${ICON.deploy} ${deployBtnLabel}</button>
          ${hasDropdown ? `<button class="sm split-btn-toggle" onclick="toggleDeployMenu('${esc(b.id)}', event)" ${isBusy ? 'disabled' : ''}>
            <svg width="10" height="6" viewBox="0 0 10 6" fill="currentColor"><path d="M1 1l4 4 4-4"/></svg>
          </button>` : ''}
          ${deployMenuTpl}
        </div>
      `;
      actionsRightHtml = `
        ${hasError ? `<button class="sm" onclick="resetBranch('${esc(b.id)}')" ${btnDisabled('reset')}>${btnLabel('reset', ICON.reset + ' 重置')}</button>` : ''}
        ${!hasDropdown ? `<button class="sm danger" onclick="removeBranch('${esc(b.id)}')" ${isBusy ? 'disabled' : ''}>${ICON.trash}</button>` : ''}
      `;
    }

    const deployLog = inlineDeployLogs.get(b.id);
    const localDeploying = !!deployLog && deployLog.status === 'building';
    // Server-authority: also treat server-pushed 'building'/'starting' as deploying
    const serverDeploying = !localDeploying && (b.status === 'building' || b.status === 'starting');
    const isDeploying = localDeploying || serverDeploying;
    const deployFailed = !!deployLog && deployLog.status === 'error';
    const isJustDeployed = justDeployed.has(b.id);

    // Commit area in actions row — shows commit info or deploy log during deployment
    let commitAreaHtml = '';
    if (localDeploying && deployLog) {
      // Local deploy — show live log lines
      const compactLines = deployLog.lines.filter(l => l.trim()).slice(-2);
      commitAreaHtml = `
        <div class="branch-actions-deploy-status" title="部署中，点击查看完整日志" onclick="event.stopPropagation(); openFullDeployLog('${esc(b.id)}', event)">
          <span class="live-dot"></span>
          <pre class="deploy-status-log">${esc(compactLines.join('\n')) || '正在启动...'}</pre>
        </div>
      `;
    } else if (serverDeploying) {
      // Server-driven deploy (triggered externally) — simplified indicator
      const statusLabel = b.status === 'building' ? '构建中...' : '启动中...';
      commitAreaHtml = `
        <div class="branch-actions-deploy-status">
          <span class="live-dot"></span>
          <pre class="deploy-status-log">${statusLabel}</pre>
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
      <div class="branch-card status-${b.status || 'idle'} ${isDefault ? 'active' : ''} ${isBusy ? 'is-busy' : ''} ${hasError ? 'has-error' : ''} expanded ${b.isFavorite ? 'is-favorite' : ''} ${hasUpdates ? 'has-updates' : ''} ${recentlyTouched.has(b.id) ? 'recently-touched' : ''} ${isDeploying ? 'is-deploying' : ''} ${b.isColorMarked ? 'is-color-marked' : ''} ${getAiOccupant(b.id) ? 'is-ai-occupied' : ''} ${b.pinnedCommit ? 'is-pinned' : ''}" data-branch-id="${esc(b.id)}">
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
            <span class="branch-quick-actions">
              <button class="branch-quick-btn" onclick="event.stopPropagation(); copyBranchName('${esc(b.branch)}')" title="复制分支名">
                <svg class="inline-icon" width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M0 6.75C0 5.784.784 5 1.75 5h1.5a.75.75 0 010 1.5h-1.5a.25.25 0 00-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 00.25-.25v-1.5a.75.75 0 011.5 0v1.5A1.75 1.75 0 019.25 16h-7.5A1.75 1.75 0 010 14.25v-7.5z"/><path d="M5 1.75C5 .784 5.784 0 6.75 0h7.5C15.216 0 16 .784 16 1.75v7.5A1.75 1.75 0 0114.25 11h-7.5A1.75 1.75 0 015 9.25v-7.5zm1.75-.25a.25.25 0 00-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 00.25-.25v-7.5a.25.25 0 00-.25-.25h-7.5z"/></svg>
              </button>
              <button class="branch-quick-btn" onclick="event.stopPropagation(); previewBranch('${esc(b.id)}')" title="打开预览">
                <svg class="inline-icon" width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M3.75 2h3.5a.75.75 0 010 1.5h-3.5a.25.25 0 00-.25.25v8.5c0 .138.112.25.25.25h8.5a.25.25 0 00.25-.25v-3.5a.75.75 0 011.5 0v3.5A1.75 1.75 0 0112.25 14h-8.5A1.75 1.75 0 012 12.25v-8.5C2 2.784 2.784 2 3.75 2zm6.854-.22a.75.75 0 01.22.53v2.5a.75.75 0 01-1.5 0V3.56L6.22 6.72a.75.75 0 01-1.06-1.06l3.1-3.1H6.81a.75.75 0 010-1.5h3.5a.75.75 0 01.293.06z"/></svg>
              </button>
            </span>
          </div>
          ${b.pinnedCommit ? `<div class="branch-card-row2">
            <span class="pinned-commit-badge" onclick="event.stopPropagation(); checkoutCommit('${esc(b.id)}', '', true, '')" title="已固定到历史提交 ${esc(b.pinnedCommit)}，点击恢复最新">📌 ${esc(b.pinnedCommit)}</span>
          </div>` : ''}
          ${portBadgesHtml ? `<div class="branch-card-ports">${portBadgesHtml}</div>` : ''}
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

  // Dashboard title stays constant — tag-based titles are for proxied preview pages only (widget-script.ts)
  document.title = 'Cloud Dev Suite';
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
      <span style="flex:1"></span>
      <button class="sm" onclick="closeConfigModal(); exportConfig()" title="导出 CDS Compose YAML"><svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" style="vertical-align:-2px;margin-right:3px"><path d="M2.75 14A1.75 1.75 0 011 12.25v-2.5a.75.75 0 011.5 0v2.5c0 .138.112.25.25.25h10.5a.25.25 0 00.25-.25v-2.5a.75.75 0 011.5 0v2.5A1.75 1.75 0 0113.25 14H2.75zm3.22-7.53a.75.75 0 001.06 1.06L8 6.56V1.75a.75.75 0 00-1.5 0v4.81L5.53 5.59a.75.75 0 00-1.06 1.06l2.5 2.5a.75.75 0 001.06 0l2.5-2.5z"/></svg>导出配置</button>
      <button class="sm" onclick="closeConfigModal(); exportSkill()" title="生成 AI Agent 部署技能文件"><svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" style="vertical-align:-2px;margin-right:3px"><path d="M3.5 1.75a.25.25 0 01.25-.25h3.5a.75.75 0 000-1.5h-3.5A1.75 1.75 0 002 1.75v11.5c0 .966.784 1.75 1.75 1.75h8.5A1.75 1.75 0 0014 13.25v-6a.75.75 0 00-1.5 0v6a.25.25 0 01-.25.25h-8.5a.25.25 0 01-.25-.25V1.75z"/><path d="M11.78.22a.75.75 0 00-1.06 0L6.22 4.72a.75.75 0 000 1.06l.53.53-2.97 2.97a.75.75 0 101.06 1.06l2.97-2.97.53.53a.75.75 0 001.06 0l4.5-4.5a.75.75 0 000-1.06L11.78.22z"/></svg>导出技能</button>
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

  const { current, commitHash, branches } = data;
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
      当前分支：<code style="word-break:break-all">${esc(current)}</code>${commitHash ? `<span style="white-space:nowrap"> @ <code style="color:var(--blue)">${esc(commitHash)}</code></span>` : ''}
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
    : buildProfiles.map(p => {
        const modeHtml = p.deployModes && Object.keys(p.deployModes).length > 0
          ? `<div style="margin-top:4px;display:flex;align-items:center;gap:6px">
              <span style="font-size:11px;color:var(--text-muted)">部署模式:</span>
              <select style="font-size:11px;padding:2px 6px;border-radius:4px;border:1px solid var(--border);background:var(--bg-secondary);color:var(--text-primary);cursor:pointer" onchange="switchDeployMode('${esc(p.id)}', this.value)">
                ${Object.entries(p.deployModes).map(([k, m]) =>
                  `<option value="${esc(k)}"${p.activeDeployMode === k ? ' selected' : ''}>${esc(m.label || k)}</option>`
                ).join('')}
              </select>
            </div>`
          : '';
        return `
        <div class="config-item">
          <div class="config-item-main">
            <span style="opacity:0.7">${getPortIcon(p.id, p)}</span>
            <strong>${esc(p.name)}</strong>
            <code class="config-item-match">${esc(p.dockerImage)}</code>
            <span class="config-item-detail">${esc(p.workDir || '.')} :${p.containerPort}${p.pathPrefixes?.length ? ' → ' + p.pathPrefixes.join(', ') : ''}</span>
            <code class="config-item-cmd" title="${esc(p.runCommand)}">${esc(p.runCommand)}</code>
            ${modeHtml}
          </div>
          <div class="config-item-actions">
            <button class="icon-btn xs danger-icon" onclick="deleteProfileAndRefresh('${esc(p.id)}')" title="删除">&times;</button>
          </div>
        </div>
      `;}).join('');

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

async function switchDeployMode(profileId, mode) {
  try {
    await api('PUT', `/build-profiles/${profileId}/deploy-mode`, { mode });
    showToast(`已切换部署模式`, 'success');
    await loadProfiles();
  } catch (e) { showToast(e.message, 'error'); }
}

async function switchModeAndDeploy(branchId, profileId, modeId) {
  try {
    await api('PUT', `/build-profiles/${profileId}/deploy-mode`, { mode: modeId });
    await loadProfiles();
    deployBranch(branchId);
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
    const branch = branches.find(br => br.id === id);
    const isPinned = branch?.pinnedCommit;
    el.innerHTML = commits.map((c, i) => {
      const isCurrent = isPinned ? c.hash === isPinned : i === 0;
      const isLatest = i === 0;
      return `
      <div class="commit-log-item ${isLatest ? 'latest' : ''} ${isCurrent ? 'current' : ''}" onclick="event.stopPropagation(); checkoutCommit('${esc(id)}', '${esc(c.hash)}', ${isLatest}, ${JSON.stringify(esc(c.subject))})" title="点击切换到此提交进行构建">
        ${isCurrent ? '<span class="commit-current-dot"></span>' : ''}${commitIcon(c.subject)}<code class="commit-hash">${esc(c.hash)}</code>
        <span class="commit-subject">${esc(c.subject)}</span>
        <span class="commit-meta">${esc(c.author)} · ${esc(c.date)}</span>
      </div>
    `;
    }).join('');
  } catch (e) {
    el.innerHTML = `<div class="commit-log-empty" style="color:var(--red)">${esc(e.message)}</div>`;
  }
}

async function checkoutCommit(branchId, hash, isLatest, subject) {
  closeCommitLog();
  const branch = branches.find(b => b.id === branchId);
  if (!branch) return;

  // If clicking on the latest commit and currently pinned, unpin
  if (isLatest && branch.pinnedCommit) {
    if (!confirm(`恢复到分支最新提交？\n\n当前固定在: ${branch.pinnedCommit}`)) return;
    try {
      await api('POST', `/branches/${encodeURIComponent(branchId)}/unpin`);
      branch.pinnedCommit = undefined;
      showToast('已恢复到分支最新提交', 'success');
      renderBranches();
    } catch (e) {
      showToast(`恢复失败: ${e.message}`, 'error');
    }
    return;
  }

  // If clicking on the latest commit and not pinned, nothing to do
  if (isLatest && !branch.pinnedCommit) return;

  // Confirm checkout to historical commit
  const msg = `切换到历史提交进行构建？\n\n${hash}  ${subject}\n\n⚠️ 切换后卡片将显示警示状态\n点击「部署」会自动恢复到分支最新`;
  if (!confirm(msg)) return;

  try {
    const data = await api('POST', `/branches/${encodeURIComponent(branchId)}/checkout/${encodeURIComponent(hash)}`);
    branch.pinnedCommit = data.pinnedCommit || hash;
    showToast(`已切换到提交 ${hash}`, 'success');
    renderBranches();
  } catch (e) {
    showToast(`切换失败: ${e.message}`, 'error');
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

// Get display label for branch: prefer tags from event, then branches array, fallback to last segment of ID
function getBranchDisplayLabel(branchId, eventTags) {
  // 1. Server-side resolved tags (reliable, no timing issues)
  if (eventTags?.length) return eventTags.join(' · ');
  // 2. Fallback: lookup from branches array (may be empty on early events)
  const branch = branches.find(b => b.id === branchId);
  if (branch?.tags?.length) return branch.tags.join(' · ');
  // 3. Last resort: tail of branch ID
  const lastDash = branchId.lastIndexOf('-');
  const tail = lastDash >= 0 ? branchId.slice(lastDash + 1) : branchId;
  return tail.length > 16 ? tail.slice(0, 13) + '…' : tail;
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
  // AI badge first — always at the front for visibility
  if (isAi) {
    const agentShort = (event.agent || 'AI').replace(/\s*\(static key\)/, '');
    html += `<span class="activity-source ai" title="${escapeHtml(event.agent || 'AI')}">${escapeHtml(agentShort)}</span>`;
  }
  // Branch label: prefer tags, fallback to last ID segment
  if (event.branchId) {
    const branchLabel = getBranchDisplayLabel(event.branchId, event.branchTags);
    html += `<span class="activity-source" style="background:var(--accent-bg);color:var(--accent);font-size:9px;font-weight:600;padding:1px 4px;border-radius:3px" title="${escapeHtml(event.branchId)}">${escapeHtml(branchLabel)}</span>`;
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
  // Branch label: prefer tags, fallback to last ID segment
  if (event.branchId) {
    const branchLabel = getBranchDisplayLabel(event.branchId, event.branchTags);
    html += `<span class="activity-source" style="background:var(--accent-bg);color:var(--accent);font-size:9px;font-weight:600;padding:1px 4px;border-radius:3px" title="${escapeHtml(event.branchId)}">${escapeHtml(branchLabel)}</span>`;
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

// ── Activity Panel Resize ──
(function initActivityResize() {
  const panel = document.getElementById('activityMonitor');
  if (!panel) return;
  const handles = panel.querySelectorAll('.activity-resize-handle');
  let isResizing = false;
  let startX, startY, startW, startH, startLeft, startTop, direction;

  handles.forEach(h => {
    h.addEventListener('mousedown', (e) => {
      if (panel.classList.contains('collapsed')) return;
      e.preventDefault();
      e.stopPropagation();
      isResizing = true;
      direction = h.dataset.direction;
      startX = e.clientX;
      startY = e.clientY;
      const rect = panel.getBoundingClientRect();
      startW = rect.width;
      startH = rect.height;
      startLeft = rect.left;
      startTop = rect.top;
      panel.style.transition = 'none';
      document.body.style.cursor = h.style.cursor || getComputedStyle(h).cursor;
      document.body.style.userSelect = 'none';
    });
  });

  document.addEventListener('mousemove', (e) => {
    if (!isResizing) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    const minW = 320, minH = 200;
    const maxW = window.innerWidth * 0.9;
    const maxH = window.innerHeight * 0.9;

    if (direction === 'w' || direction === 'nw') {
      const newW = Math.min(maxW, Math.max(minW, startW - dx));
      panel.style.width = newW + 'px';
    }
    if (direction === 'n' || direction === 'nw') {
      const newH = Math.min(maxH, Math.max(minH, startH - dy));
      panel.style.height = newH + 'px';
    }
  });

  document.addEventListener('mouseup', () => {
    if (!isResizing) return;
    isResizing = false;
    panel.style.transition = '';
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  });
})();

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

// ── Data Migration ──

let migrationTasks = [];
let migrationToolInstalled = null;
let loadedCollections = [];
let cdsPeers = [];
/** true when the new-migration modal is in edit mode; stores the id being edited */
let migrationEditingId = null;

async function loadMigrations() {
  try { migrationTasks = await api('GET', '/data-migrations'); } catch { migrationTasks = []; }
}

async function loadCdsPeers() {
  try { cdsPeers = await api('GET', '/data-migrations/peers'); } catch { cdsPeers = []; }
}

function migStatusColor(s) { return { pending: 'var(--fg-muted)', running: 'var(--blue)', completed: 'var(--green)', failed: 'var(--red)' }[s] || 'var(--fg-muted)'; }
function migStatusLabel(s) { return { pending: '待执行', running: '运行中', completed: '已完成', failed: '失败' }[s] || s; }
function migStatusIcon(s) { return { pending: '○', running: '◉', completed: '●', failed: '✗' }[s] || '○'; }

function formatConnSummary(conn) {
  if (!conn) return '—';
  const db = conn.database ? `/${conn.database}` : '';
  if (conn.type === 'local') return `本机 MongoDB${db}`;
  if (conn.type === 'cds') {
    const peer = cdsPeers.find(p => p.id === conn.cdsPeerId);
    return `🔑 ${peer?.name || conn.cdsPeerId || '未知 CDS'}${db}`;
  }
  return `${conn.host || '?'}:${conn.port || 27017}${db}`;
}

function formatDuration(startIso, endIso) {
  if (!startIso || !endIso) return '—';
  const ms = new Date(endIso) - new Date(startIso);
  if (ms < 1000) return `${ms}ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}秒`;
  return `${Math.floor(s / 60)}分${s % 60}秒`;
}

function formatSize(bytes) {
  if (!bytes || bytes < 1024) return '';
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

function renderMigrationCard(m) {
  const borderColor = migStatusColor(m.status);
  const srcLabel = formatConnSummary(m.source);
  const tgtLabel = formatConnSummary(m.target);
  const colsLabel = m.collections?.length ? `${m.collections.length} 个集合` : '全部集合';
  const colsDetail = m.collections?.length
    ? (m.collections.length <= 4 ? m.collections.join(', ') : m.collections.slice(0, 3).join(', ') + ` +${m.collections.length - 3}`)
    : '';
  const duration = formatDuration(m.startedAt, m.finishedAt);
  const canRun = m.status !== 'running';

  return `
    <div class="mig-card" style="border-left-color:${borderColor}">
      <div class="mig-card-header">
        <span class="mig-status-badge" style="color:${borderColor}">${migStatusIcon(m.status)} ${migStatusLabel(m.status)}</span>
        <strong class="mig-card-name">${esc(m.name)}</strong>
        <span class="mig-card-time">${relativeTime(m.createdAt)}</span>
      </div>
      <div class="mig-card-flow">
        <span class="mig-conn-label">${esc(srcLabel)}</span>
        <span class="mig-flow-arrow">→</span>
        <span class="mig-conn-label">${esc(tgtLabel)}</span>
      </div>
      <div class="mig-card-meta">
        <span title="${esc(colsDetail)}">📦 ${colsLabel}</span>
        ${m.startedAt ? `<span>⏱ ${duration}</span>` : ''}
        ${m.source.sshTunnel?.enabled || m.target.sshTunnel?.enabled ? '<span>🔒 SSH</span>' : ''}
      </div>
      ${m.errorMessage ? `<div class="mig-card-error">⚠ ${esc(m.errorMessage)}</div>` : ''}
      ${m.status === 'running' ? `
        <div class="mig-progress-bar"><div class="mig-progress-fill" style="width:${m.progress || 0}%"></div></div>
        <div class="mig-progress-text">${esc(m.progressMessage || '准备中...')} · ${m.progress || 0}%</div>
      ` : ''}
      <div class="mig-card-actions">
        ${canRun ? `<button class="sm" onclick="executeMigration('${m.id}')">▶ 执行</button>` : ''}
        ${m.status !== 'running' ? `<button class="sm" onclick="editMigration('${m.id}')">✎ 编辑</button>` : ''}
        <button class="sm" onclick="cloneMigration('${m.id}')">⧉ 克隆</button>
        ${m.log ? `<button class="sm" onclick="showMigrationLog('${m.id}')">📋 日志</button>` : ''}
        ${m.status !== 'running' ? `<button class="sm danger-text" onclick="deleteMigration('${m.id}')">删除</button>` : ''}
      </div>
    </div>
  `;
}

async function openMigrationModal() {
  await Promise.all([loadMigrations(), loadCdsPeers()]);
  const listHtml = migrationTasks.length === 0
    ? '<div class="config-empty">暂无迁移任务。点击"新建迁移"开始配置。</div>'
    : migrationTasks.slice().reverse().map(renderMigrationCard).join('');
  const peerCount = cdsPeers.length;
  openConfigModal('数据迁移', `
    <p class="config-panel-desc">MongoDB 数据迁移。支持本机 / 远程 / CDS 密钥（跨 CDS 一键直连）。管道流式传输，无临时文件。</p>
    <div class="config-panel-actions" style="margin-bottom:10px;display:flex;gap:6px;flex-wrap:wrap">
      <button class="sm primary" onclick="openNewMigrationModal()">+ 新建迁移</button>
      <button class="sm" onclick="openPeersModal()">🔑 CDS 密钥管理${peerCount ? ` (${peerCount})` : ''}</button>
      <button class="sm" onclick="checkMigrationTools()">🔧 工具状态</button>
    </div>
    <div id="migrationToolStatus" style="font-size:12px;margin-bottom:8px;display:none"></div>
    <div id="migrationListInModal">${listHtml}</div>
  `);
}

async function checkMigrationTools() {
  const el = document.getElementById('migrationToolStatus');
  if (!el) return;
  el.style.display = 'block';
  el.innerHTML = '<span class="btn-spinner"></span> 检查中...';
  try {
    const d = await api('POST', '/data-migrations/check-tools');
    el.innerHTML = d.installed
      ? `<span style="color:var(--green)">✓ ${esc(d.version)}</span>`
      : `<span style="color:var(--yellow)">⚠ 未安装</span> <button class="sm" onclick="installMigrationTools()" style="margin-left:8px">安装</button>`;
    migrationToolInstalled = d.installed;
  } catch (e) { el.innerHTML = `<span style="color:var(--red)">✗ ${esc(e.message)}</span>`; }
}

async function installMigrationTools() {
  const el = document.getElementById('migrationToolStatus');
  if (!el) return;
  el.innerHTML = '<span class="btn-spinner"></span> 安装中...';
  try {
    const res = await fetch(`${API}/data-migrations/install-tools`, { method: 'POST', headers: { 'Content-Type': 'application/json' } });
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      for (const line of buffer.split('\n')) {
        if (line.startsWith('data: ')) {
          try {
            const d = JSON.parse(line.substring(6));
            if (d.message) el.innerHTML = `<span class="btn-spinner"></span> ${esc(d.message)}`;
            if (d.installed) { el.innerHTML = `<span style="color:var(--green)">✓ ${esc(d.version)}</span>`; migrationToolInstalled = true; }
          } catch {}
        }
      }
      buffer = '';
    }
  } catch (e) { el.innerHTML = `<span style="color:var(--red)">✗ ${esc(e.message)}</span>`; }
}

// ── Connection form builder ──

function buildConnectionForm(prefix, defaultType, isSource) {
  const mongoSvc = infraServices.find(s => s.id === 'mongodb');
  const hasLocalMongo = !!mongoSvc;
  const peerOptions = cdsPeers.map(p =>
    `<option value="${esc(p.id)}">${esc(p.name)} · ${esc((p.baseUrl || '').replace(/^https?:\/\//, ''))}</option>`
  ).join('');
  return `
    <div class="migration-conn-panel">
      <div class="form-row mc-row" style="margin-bottom:6px">
        <select id="${prefix}Type" class="form-input mc-input" onchange="onConnTypeChange('${prefix}', ${isSource})">
          ${hasLocalMongo ? `<option value="local" ${defaultType === 'local' ? 'selected' : ''}>本机 MongoDB${mongoSvc?.status === 'running' ? ' ●' : ''}</option>` : ''}
          <option value="cds" ${defaultType === 'cds' ? 'selected' : ''}>🔑 CDS 密钥 (跨 CDS 直连)</option>
          <option value="remote" ${defaultType === 'remote' || !hasLocalMongo ? 'selected' : ''}>远程 MongoDB</option>
        </select>
      </div>

      <div id="${prefix}CdsFields" style="${defaultType === 'cds' ? '' : 'display:none'}">
        <div class="form-row mc-row">
          <select id="${prefix}CdsPeer" class="form-input mc-input" onchange="onCdsPeerChange('${prefix}', ${isSource})">
            <option value="">${cdsPeers.length ? '(请选择 CDS 密钥)' : '(未添加，请点击「管理密钥」)'}</option>
            ${peerOptions}
          </select>
          <button type="button" class="sm mc-btn" onclick="openPeersModal()" title="管理 CDS 密钥">🔑</button>
        </div>
      </div>

      <div id="${prefix}RemoteFields" style="${(defaultType === 'local' && hasLocalMongo) || defaultType === 'cds' ? 'display:none' : ''}">
        <div class="form-row mc-row">
          <input id="${prefix}Host" class="form-input mc-input mc-host" placeholder="主机地址" value="127.0.0.1">
          <input id="${prefix}Port" class="form-input mc-input mc-port" placeholder="端口" value="27017" type="number">
        </div>
        <div class="form-row mc-row">
          <input id="${prefix}Username" class="form-input mc-input" placeholder="用户名 (可选)">
          <input id="${prefix}Password" class="form-input mc-input" placeholder="密码 (可选)" type="password">
        </div>
        <div class="form-row mc-row">
          <input id="${prefix}AuthDb" class="form-input mc-input" placeholder="认证库 (默认 admin)">
        </div>
      </div>

      <div id="${prefix}DbArea">
        <div class="form-row mc-row">
          <select id="${prefix}Database" class="form-input mc-input" onchange="onDbChange('${prefix}', ${isSource})">
            <option value="">加载中...</option>
          </select>
        </div>
      </div>
      ${isSource ? `<div id="srcCollectionPicker" style="margin-top:4px"></div>` : ''}

      <div id="${prefix}SshArea" style="margin-top:6px;${defaultType === 'cds' ? 'display:none' : ''}">
        <label style="font-size:11px;display:flex;align-items:center;gap:6px;cursor:pointer;color:var(--fg-muted)">
          <input type="checkbox" id="${prefix}SshEnabled" onchange="toggleSshTunnel('${prefix}')">
          SSH 隧道
        </label>
        <div id="${prefix}SshFields" style="display:none;margin-top:6px">
          <div class="form-row mc-row">
            <input id="${prefix}SshHost" class="form-input mc-input mc-host" placeholder="SSH 主机">
            <input id="${prefix}SshPort" class="form-input mc-input mc-port" placeholder="端口" value="22" type="number">
          </div>
          <div class="form-row mc-row">
            <input id="${prefix}SshUser" class="form-input mc-input" placeholder="SSH 用户名">
            <input id="${prefix}SshKey" class="form-input mc-input" placeholder="私钥路径 (可选)">
          </div>
          <div class="form-row mc-row">
            <input id="${prefix}SshContainer" class="form-input mc-input" placeholder="docker 容器名 (可选, 走 docker exec)">
          </div>
          <div class="form-row mc-row" style="gap:6px">
            <button type="button" class="sm" onclick="testSshTunnel('${prefix}')" style="flex:0 0 auto">🔧 测试隧道</button>
            <div id="${prefix}SshTestStatus" style="font-size:11px;flex:1;align-self:center;color:var(--fg-muted);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"></div>
          </div>
        </div>
      </div>
      <div id="${prefix}ConnStatus" style="font-size:11px;margin-top:6px;color:var(--fg-muted);word-break:break-all"></div>
    </div>
  `;
}

function toggleSshTunnel(prefix) {
  const el = document.getElementById(`${prefix}SshFields`);
  if (el) el.style.display = document.getElementById(`${prefix}SshEnabled`)?.checked ? '' : 'none';
}

function onConnTypeChange(prefix, isSource) {
  const type = document.getElementById(`${prefix}Type`)?.value;
  const remoteFields = document.getElementById(`${prefix}RemoteFields`);
  const cdsFields = document.getElementById(`${prefix}CdsFields`);
  const sshArea = document.getElementById(`${prefix}SshArea`);
  if (remoteFields) remoteFields.style.display = type === 'remote' ? '' : 'none';
  if (cdsFields) cdsFields.style.display = type === 'cds' ? '' : 'none';
  // SSH is irrelevant for CDS-peer connections (peer handles transport via HTTPS)
  if (sshArea) sshArea.style.display = type === 'cds' ? 'none' : '';
  // Auto-load databases for this connection
  loadDatabases(prefix, isSource);
}

function onCdsPeerChange(prefix, isSource) {
  // When the peer changes, refresh the database list
  loadDatabases(prefix, isSource);
}

async function testSshTunnel(prefix) {
  const statusEl = document.getElementById(`${prefix}SshTestStatus`);
  if (!statusEl) return;
  statusEl.innerHTML = '<span class="btn-spinner"></span> 正在测试 SSH 隧道...';
  const conn = readConnectionConfig(prefix);
  if (!conn.sshTunnel || !conn.sshTunnel.host) {
    statusEl.innerHTML = '<span style="color:var(--red)">✗ 请先填写 SSH 信息</span>';
    return;
  }
  try {
    const d = await api('POST', '/data-migrations/test-tunnel', { sshTunnel: conn.sshTunnel });
    if (d.success) statusEl.innerHTML = `<span style="color:var(--green)" title="${esc(d.message || '')}">✓ ${esc(d.message || '连接成功')}</span>`;
    else statusEl.innerHTML = `<span style="color:var(--red)" title="${esc(d.error || '')}">✗ ${esc(d.error || '连接失败')}</span>`;
  } catch (e) {
    statusEl.innerHTML = `<span style="color:var(--red)">✗ ${esc(e.message)}</span>`;
  }
}

async function loadDatabases(prefix, isSource) {
  const dbSelect = document.getElementById(`${prefix}Database`);
  const statusEl = document.getElementById(`${prefix}ConnStatus`);
  if (!dbSelect) return;
  dbSelect.innerHTML = '<option value="">加载中...</option>';
  dbSelect.disabled = true;
  if (statusEl) statusEl.innerHTML = '<span class="btn-spinner"></span> 连接中...';

  try {
    const conn = readConnectionConfig(prefix);
    let d;
    if (conn.type === 'cds') {
      if (!conn.cdsPeerId) {
        if (statusEl) statusEl.innerHTML = '<span style="color:var(--fg-muted)">请先选择 CDS 密钥</span>';
        dbSelect.innerHTML = '<option value="">(请先选择 CDS 密钥)</option>';
        dbSelect.disabled = false;
        return;
      }
      d = await api('POST', `/data-migrations/peers/${conn.cdsPeerId}/list-databases`);
    } else {
      d = await api('POST', '/data-migrations/list-databases', { connection: conn });
    }
    const dbs = d.databases || [];
    if (d.error) throw new Error(d.error);
    if (dbs.length === 0) throw new Error('无法获取数据库列表');

    dbSelect.innerHTML = '<option value="">(全部数据库)</option>' + dbs.map(db =>
      `<option value="${esc(db.name)}">${esc(db.name)} ${formatSize(db.sizeOnDisk) ? '(' + formatSize(db.sizeOnDisk) + ')' : ''}</option>`
    ).join('');
    dbSelect.disabled = false;
    if (statusEl) statusEl.innerHTML = `<span style="color:var(--green)">✓ 已连接 · ${dbs.length} 个数据库</span>`;
  } catch (e) {
    dbSelect.innerHTML = '<option value="">(连接失败)</option>';
    dbSelect.disabled = false;
    if (statusEl) statusEl.innerHTML = `<span style="color:var(--red)">✗ ${esc(e.message)}</span>`;
    // Fallback: allow manual input
    const dbArea = document.getElementById(`${prefix}DbArea`);
    if (dbArea) {
      dbArea.innerHTML = `<div class="form-row mc-row"><input id="${prefix}Database" class="form-input mc-input" placeholder="手动输入数据库名" oninput="onDbChange('${prefix}', ${isSource})"></div>`;
    }
  }
}

function onDbChange(prefix, isSource) {
  if (!isSource) return;
  const srcDb = document.getElementById('srcDatabase')?.value;
  // Auto-sync target database name
  const tgtDb = document.getElementById('tgtDatabase');
  if (tgtDb && srcDb) {
    // Only auto-fill if target is empty or was auto-filled before
    if (!tgtDb.value || tgtDb.dataset.autoFilled === 'true') {
      tgtDb.value = srcDb;
      tgtDb.dataset.autoFilled = 'true';
      // If it's a select, check if option exists
      if (tgtDb.tagName === 'SELECT') {
        const exists = Array.from(tgtDb.options).some(o => o.value === srcDb);
        if (!exists) {
          tgtDb.insertAdjacentHTML('beforeend', `<option value="${esc(srcDb)}">${esc(srcDb)} (同源)</option>`);
          tgtDb.value = srcDb;
        }
      }
    }
  }
  // Auto-load collections for source
  if (srcDb) loadCollections();
  // Auto-generate task name
  autoGenerateName();
}

function autoGenerateName() {
  const nameEl = document.getElementById('migName');
  if (!nameEl || (nameEl.value && !nameEl.dataset.autoGenerated)) return;
  const labelFor = (prefix) => {
    const type = document.getElementById(`${prefix}Type`)?.value;
    if (type === 'local') return '本机';
    if (type === 'cds') {
      const peerId = document.getElementById(`${prefix}CdsPeer`)?.value;
      const peer = cdsPeers.find(p => p.id === peerId);
      return peer ? `🔑 ${peer.name}` : '🔑 CDS';
    }
    return document.getElementById(`${prefix}Host`)?.value || '远程';
  };
  const srcDb = document.getElementById('srcDatabase')?.value || '';
  const db = srcDb ? `/${srcDb}` : '';
  nameEl.value = `${labelFor('src')}${db} → ${labelFor('tgt')}`;
  nameEl.dataset.autoGenerated = 'true';
}

function readConnectionConfig(prefix) {
  const type = document.getElementById(`${prefix}Type`)?.value || 'remote';
  const dbEl = document.getElementById(`${prefix}Database`);
  const dbVal = dbEl?.value?.trim() || '';
  const conn = {
    type,
    host: document.getElementById(`${prefix}Host`)?.value?.trim() || '127.0.0.1',
    port: parseInt(document.getElementById(`${prefix}Port`)?.value) || 27017,
    database: dbVal || undefined,
    username: document.getElementById(`${prefix}Username`)?.value?.trim() || undefined,
    password: document.getElementById(`${prefix}Password`)?.value?.trim() || undefined,
    authDatabase: document.getElementById(`${prefix}AuthDb`)?.value?.trim() || undefined,
  };
  if (type === 'cds') {
    conn.cdsPeerId = document.getElementById(`${prefix}CdsPeer`)?.value || undefined;
  }
  // SSH is only meaningful for 'remote' connections, but we still read the form values so
  // the test-tunnel button can work before the user commits the type choice.
  const sshEnabled = document.getElementById(`${prefix}SshEnabled`)?.checked;
  if (sshEnabled && type !== 'cds') {
    conn.sshTunnel = {
      enabled: true,
      host: document.getElementById(`${prefix}SshHost`)?.value?.trim() || '',
      port: parseInt(document.getElementById(`${prefix}SshPort`)?.value) || 22,
      username: document.getElementById(`${prefix}SshUser`)?.value?.trim() || '',
      privateKeyPath: document.getElementById(`${prefix}SshKey`)?.value?.trim() || undefined,
      dockerContainer: document.getElementById(`${prefix}SshContainer`)?.value?.trim() || undefined,
    };
  }
  return conn;
}

function readSelectedCollections() {
  return Array.from(document.querySelectorAll('input[name="migCollection"]:checked')).map(c => c.value);
}

async function loadCollections() {
  const picker = document.getElementById('srcCollectionPicker');
  if (!picker) return;
  const conn = readConnectionConfig('src');
  if (!conn.database) { picker.innerHTML = ''; loadedCollections = []; return; }
  picker.innerHTML = '<div style="font-size:11px"><span class="btn-spinner"></span> 加载集合...</div>';
  try {
    let d;
    if (conn.type === 'cds' && conn.cdsPeerId) {
      d = await api('POST', `/data-migrations/peers/${conn.cdsPeerId}/list-collections`, { database: conn.database });
    } else {
      d = await api('POST', '/data-migrations/list-collections', { connection: conn });
    }
    loadedCollections = d.collections || [];
    if (loadedCollections.length === 0) {
      picker.innerHTML = '<div style="font-size:11px;color:var(--fg-muted)">该库暂无集合</div>';
      return;
    }
    picker.innerHTML = `
      <div class="coll-picker">
        <div class="coll-picker-header">
          <span>选择集合 <span style="color:var(--fg-muted)">(不选=全部迁移)</span></span>
          <span style="margin-left:auto">
            <a href="#" onclick="toggleAllCollections(true);return false">全选</a> ·
            <a href="#" onclick="toggleAllCollections(false);return false">清空</a>
          </span>
        </div>
        <div class="coll-picker-list">
          ${loadedCollections.map(c => `
            <label class="coll-picker-item">
              <input type="checkbox" name="migCollection" value="${esc(c.name)}">
              <span class="coll-name">${esc(c.name)}</span>
              <span class="coll-count">${c.count.toLocaleString()}</span>
            </label>
          `).join('')}
        </div>
      </div>
    `;
  } catch (e) {
    picker.innerHTML = `<div style="font-size:11px;color:var(--red)">✗ ${esc(e.message)}</div>`;
  }
}

function toggleAllCollections(sel) {
  document.querySelectorAll('input[name="migCollection"]').forEach(c => { c.checked = sel; });
}

// ── New Migration Modal ──

async function openNewMigrationModal(prefill, opts) {
  const editMode = !!(opts && opts.editMode);
  migrationEditingId = editMode && prefill ? prefill.id : null;
  // Ensure peers list is available for the peer picker
  if (cdsPeers.length === 0) { await loadCdsPeers(); }
  const title = editMode ? '编辑数据迁移' : '新建数据迁移';
  const primaryLabel = editMode ? '💾 保存修改' : '▶ 创建并执行';
  const primaryHandler = editMode ? 'saveMigrationEdits()' : 'createAndExecuteMigration()';
  const html = `
    <div class="form-row" style="margin-bottom:10px">
      <input id="migName" class="form-input" placeholder="任务名称 (自动生成)" style="flex:1;min-width:0" oninput="this.dataset.autoGenerated=''">
    </div>
    <div class="migration-dual-panel">
      <div class="migration-side">
        <div class="migration-side-title">📤 源数据库</div>
        ${buildConnectionForm('src', prefill?.source?.type || 'local', true)}
      </div>
      <div class="migration-arrow">
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 12h14M12 5l7 7-7 7"/></svg>
      </div>
      <div class="migration-side">
        <div class="migration-side-title">📥 目标数据库</div>
        ${buildConnectionForm('tgt', prefill?.target?.type || 'remote', false)}
      </div>
    </div>
    <div class="form-row" style="margin-top:12px;gap:6px;flex-wrap:wrap">
      <button class="primary sm" onclick="${primaryHandler}">${primaryLabel}</button>
      ${editMode ? '' : '<button class="sm" onclick="saveMigrationOnly()">💾 仅保存</button>'}
      <button class="sm" onclick="openMigrationModal()">取消</button>
    </div>
  `;
  openConfigModal(title, html);

  // Auto-load databases on open (or prefill)
  setTimeout(() => {
    if (prefill) {
      fillConnectionFields('src', prefill.source);
      fillConnectionFields('tgt', prefill.target);
      const nameEl = document.getElementById('migName');
      if (nameEl) {
        nameEl.value = editMode ? prefill.name : (prefill.name + ' (副本)');
        nameEl.dataset.autoGenerated = '';
      }
      // Restore selected collections after loading
      if (editMode && prefill.collections?.length) {
        const targetCols = new Set(prefill.collections);
        setTimeout(() => {
          document.querySelectorAll('input[name="migCollection"]').forEach(cb => {
            if (targetCols.has(cb.value)) cb.checked = true;
          });
        }, 400);
      }
    } else {
      // Auto-load for default connection types
      loadDatabases('src', true);
      loadDatabases('tgt', false);
    }
  }, 50);
}

async function editMigration(id) {
  if (cdsPeers.length === 0) await loadCdsPeers();
  const m = migrationTasks.find(t => t.id === id);
  if (!m) { showToast('迁移任务不存在', 'error'); return; }
  openNewMigrationModal(m, { editMode: true });
}

async function saveMigrationEdits() {
  if (!migrationEditingId) { showToast('非编辑模式', 'error'); return; }
  const body = collectMigrationBody();
  try {
    await api('PUT', `/data-migrations/${migrationEditingId}`, body);
    showToast('已保存', 'success');
    migrationEditingId = null;
    openMigrationModal();
  } catch (e) { showToast(e.message, 'error'); }
}

function fillConnectionFields(prefix, conn) {
  if (!conn) return;
  const typeEl = document.getElementById(`${prefix}Type`);
  if (typeEl) {
    typeEl.value = conn.type || 'remote';
    const remoteFields = document.getElementById(`${prefix}RemoteFields`);
    const cdsFields = document.getElementById(`${prefix}CdsFields`);
    const sshArea = document.getElementById(`${prefix}SshArea`);
    if (remoteFields) remoteFields.style.display = conn.type === 'remote' ? '' : 'none';
    if (cdsFields) cdsFields.style.display = conn.type === 'cds' ? '' : 'none';
    if (sshArea) sshArea.style.display = conn.type === 'cds' ? 'none' : '';
  }
  const set = (id, val) => { const el = document.getElementById(id); if (el && val != null) el.value = val; };
  set(`${prefix}Host`, conn.host);
  set(`${prefix}Port`, conn.port);
  set(`${prefix}Username`, conn.username);
  set(`${prefix}Password`, conn.password);
  set(`${prefix}AuthDb`, conn.authDatabase);
  if (conn.type === 'cds') {
    set(`${prefix}CdsPeer`, conn.cdsPeerId);
  }
  if (conn.sshTunnel?.enabled) {
    const sshCb = document.getElementById(`${prefix}SshEnabled`);
    if (sshCb) { sshCb.checked = true; toggleSshTunnel(prefix); }
    set(`${prefix}SshHost`, conn.sshTunnel.host);
    set(`${prefix}SshPort`, conn.sshTunnel.port);
    set(`${prefix}SshUser`, conn.sshTunnel.username);
    set(`${prefix}SshKey`, conn.sshTunnel.privateKeyPath);
    set(`${prefix}SshContainer`, conn.sshTunnel.dockerContainer);
  }
  // Load databases then select the right one
  loadDatabases(prefix, prefix === 'src').then(() => {
    if (conn.database) {
      const dbEl = document.getElementById(`${prefix}Database`);
      if (dbEl) {
        if (dbEl.tagName === 'SELECT') {
          const exists = Array.from(dbEl.options).some(o => o.value === conn.database);
          if (!exists) dbEl.insertAdjacentHTML('beforeend', `<option value="${esc(conn.database)}">${esc(conn.database)}</option>`);
        }
        dbEl.value = conn.database;
      }
    }
    if (prefix === 'src' && conn.database) loadCollections();
  });
}

function cloneMigration(id) {
  const m = migrationTasks.find(t => t.id === id);
  if (!m) return;
  openNewMigrationModal(m);
}

function collectMigrationBody() {
  const name = document.getElementById('migName')?.value?.trim();
  const source = readConnectionConfig('src');
  const target = readConnectionConfig('tgt');
  // Auto-generate name if empty
  const finalName = name || `${formatConnSummary(source)} → ${formatConnSummary(target)}`;
  const collections = readSelectedCollections();
  return { name: finalName, dbType: 'mongodb', source, target, collections: collections.length ? collections : undefined };
}

async function saveMigrationOnly() {
  const body = collectMigrationBody();
  try {
    await api('POST', '/data-migrations', body);
    showToast('迁移任务已保存', 'success');
    openMigrationModal();
  } catch (e) { showToast(e.message, 'error'); }
}

async function createAndExecuteMigration() {
  const body = collectMigrationBody();
  try {
    const mig = await api('POST', '/data-migrations', body);
    showToast('开始执行迁移...', 'info');
    await loadMigrations(); // refresh list for executeMigration to find it
    executeMigration(mig.id);
  } catch (e) { showToast(e.message, 'error'); }
}

async function executeMigration(id) {
  const mig = migrationTasks.find(t => t.id === id);
  const title = mig ? esc(mig.name) : '执行迁移';
  openConfigModal(title, `
    <div style="padding:12px 0">
      ${mig ? `
        <div class="mig-card-flow" style="justify-content:center;margin-bottom:10px">
          <span class="mig-conn-label">${esc(formatConnSummary(mig.source))}</span>
          <span class="mig-flow-arrow">→</span>
          <span class="mig-conn-label">${esc(formatConnSummary(mig.target))}</span>
        </div>
        ${mig.collections?.length ? `<div style="text-align:center;font-size:11px;color:var(--fg-muted);margin-bottom:8px">📦 ${mig.collections.join(', ')}</div>` : ''}
      ` : ''}
      <div class="mig-progress-bar" style="height:8px;margin-bottom:10px"><div id="migProgressFill" class="mig-progress-fill" style="width:0%"></div></div>
      <div id="migProgressText" style="font-size:13px;text-align:center;margin-bottom:4px">准备中...</div>
      <div id="migProgressPct" style="font-size:28px;font-weight:bold;color:var(--blue);text-align:center">0%</div>
      <div style="margin-top:14px;text-align:center">
        <button class="sm" onclick="openMigrationModal()" style="display:none" id="migBackBtn">← 返回列表</button>
      </div>
    </div>
  `);

  try {
    const res = await fetch(`${API}/data-migrations/${id}/execute`, { method: 'POST', headers: { 'Content-Type': 'application/json' } });
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        if (line.startsWith('data: ')) {
          try {
            const d = JSON.parse(line.substring(6));
            const fill = document.getElementById('migProgressFill');
            const text = document.getElementById('migProgressText');
            const pct = document.getElementById('migProgressPct');
            if (d.progress !== undefined && fill) { fill.style.width = d.progress + '%'; if (pct) pct.textContent = d.progress + '%'; }
            if (d.message && text) text.textContent = d.message;
          } catch {}
        }
        if (line.startsWith('event: done')) {
          const fill = document.getElementById('migProgressFill'), text = document.getElementById('migProgressText'), pct = document.getElementById('migProgressPct'), btn = document.getElementById('migBackBtn');
          if (fill) { fill.style.width = '100%'; fill.style.background = 'var(--green)'; }
          if (pct) { pct.textContent = '✓'; pct.style.color = 'var(--green)'; }
          if (text) text.textContent = '迁移完成！';
          if (btn) btn.style.display = '';
          showToast('数据迁移完成！', 'success');
        }
        if (line.startsWith('event: error')) {
          const fill = document.getElementById('migProgressFill'), pct = document.getElementById('migProgressPct'), btn = document.getElementById('migBackBtn');
          if (fill) fill.style.background = 'var(--red)';
          if (pct) pct.style.color = 'var(--red)';
          if (btn) btn.style.display = '';
        }
      }
    }
  } catch (e) {
    const text = document.getElementById('migProgressText'), btn = document.getElementById('migBackBtn');
    if (text) text.innerHTML = `<span style="color:var(--red)">✗ ${esc(e.message)}</span>`;
    if (btn) btn.style.display = '';
    showToast('迁移失败: ' + e.message, 'error');
  }
}

async function showMigrationLog(id) {
  openConfigModal('迁移日志', '<div class="config-empty"><span class="btn-spinner"></span> 加载中...</div>');
  try {
    const d = await api('GET', `/data-migrations/${id}/log`);
    openConfigModal('迁移日志', `
      <pre style="max-height:400px;overflow:auto;background:var(--bg-tertiary);padding:12px;border-radius:6px;font-size:11px;line-height:1.5;white-space:pre-wrap;word-break:break-all">${esc(d.log || '(空)')}</pre>
      <div class="form-row" style="margin-top:8px"><button class="sm" onclick="openMigrationModal()">返回</button></div>
    `);
  } catch (e) { openConfigModal('迁移日志', `<div class="config-empty" style="color:var(--red)">${esc(e.message)}</div>`); }
}

async function deleteMigration(id) {
  if (!confirm('确定删除此迁移任务？')) return;
  try { await api('DELETE', `/data-migrations/${id}`); showToast('已删除', 'success'); openMigrationModal(); }
  catch (e) { showToast(e.message, 'error'); }
}

// ── CDS Peers (cross-CDS migration via access keys) ──

async function openPeersModal() {
  await loadCdsPeers();
  // Also fetch own key so the user can copy it
  let myKey = null;
  try { myKey = await api('GET', '/data-migrations/my-key'); } catch { /* */ }

  const myKeySection = myKey && myKey.accessKey ? `
    <div class="peer-mykey-box">
      <div class="peer-mykey-title">🔑 本机 CDS 密钥 <span class="peer-mykey-hint">（复制后在对方 CDS 中添加，即可实现双向数据迁移）</span></div>
      <div class="form-row mc-row" style="margin-bottom:4px">
        <input class="form-input mc-input" value="${esc(myKey.baseUrl || '')}" readonly onfocus="this.select()" title="本机 CDS 地址">
        <button type="button" class="sm" onclick="copyToClipboard('${esc(myKey.baseUrl || '').replace(/'/g, "\\'")}')">复制地址</button>
      </div>
      <div class="form-row mc-row">
        <input class="form-input mc-input" value="${esc(myKey.accessKey)}" readonly onfocus="this.select()" title="本机 AI 访问密钥" style="font-family:monospace">
        <button type="button" class="sm" onclick="copyToClipboard('${esc(myKey.accessKey).replace(/'/g, "\\'")}')">复制密钥</button>
      </div>
    </div>
  ` : `
    <div class="peer-mykey-box" style="border-color:var(--yellow)">
      <div class="peer-mykey-title">⚠ 本机 CDS 未配置 AI_ACCESS_KEY</div>
      <div class="peer-mykey-hint" style="font-size:12px;margin-top:4px">${esc(myKey?.hint || '请在「设置 → 环境变量」中配置 AI_ACCESS_KEY 后再试。')}</div>
    </div>
  `;

  const peersList = cdsPeers.length === 0
    ? '<div class="config-empty" style="padding:16px">尚未添加任何 CDS 密钥。点击下方「+ 添加」即可注册第一个远程 CDS。</div>'
    : cdsPeers.map(p => `
      <div class="peer-card">
        <div class="peer-card-main">
          <div class="peer-card-name">${esc(p.name)}</div>
          <div class="peer-card-url">${esc(p.baseUrl)}</div>
          <div class="peer-card-meta">
            <span title="访问密钥（已遮蔽）">${esc(p.accessKey)}</span>
            ${p.lastVerifiedAt ? `<span title="上次验证时间" style="color:var(--green)">✓ ${relativeTime(p.lastVerifiedAt)}</span>` : '<span style="color:var(--yellow)">未验证</span>'}
          </div>
        </div>
        <div class="peer-card-actions">
          <button type="button" class="sm" onclick="testCdsPeer('${p.id}')" title="重新验证连接">🔧 测试</button>
          <button type="button" class="sm" onclick="editCdsPeer('${p.id}')">✎ 编辑</button>
          <button type="button" class="sm danger-text" onclick="deleteCdsPeer('${p.id}')">删除</button>
        </div>
      </div>
    `).join('');

  openConfigModal('CDS 密钥管理', `
    <p class="config-panel-desc">注册远程 CDS 的访问密钥，即可在数据迁移中一键选择源/目标，跨 CDS 直连，无需 SSH 或复杂配置。</p>
    ${myKeySection}
    <div style="margin:12px 0 6px;font-size:12px;color:var(--fg-muted);font-weight:600">远程 CDS 密钥</div>
    <div id="peersList">${peersList}</div>
    <div class="form-row" style="margin-top:10px;gap:6px;flex-wrap:wrap">
      <button class="sm primary" onclick="openAddPeerForm()">+ 添加 CDS 密钥</button>
      <button class="sm" onclick="openMigrationModal()">← 返回迁移列表</button>
    </div>
    <div id="addPeerFormArea"></div>
  `);
}

function openAddPeerForm(prefill) {
  const area = document.getElementById('addPeerFormArea');
  if (!area) return;
  const editingId = prefill?.id || '';
  area.innerHTML = `
    <div class="peer-form">
      <div class="peer-form-title">${editingId ? '编辑 CDS 密钥' : '添加 CDS 密钥'}</div>
      <div class="form-row mc-row">
        <input id="peerName" class="form-input mc-input" placeholder="名称 (如: 生产 CDS)" value="${esc(prefill?.name || '')}">
      </div>
      <div class="form-row mc-row">
        <input id="peerBaseUrl" class="form-input mc-input" placeholder="https://main.miduo.org" value="${esc(prefill?.baseUrl || '')}">
      </div>
      <div class="form-row mc-row">
        <input id="peerAccessKey" class="form-input mc-input" placeholder="${editingId ? '留空则保留现有密钥' : 'AI 访问密钥 (remote AI_ACCESS_KEY)'}" style="font-family:monospace">
      </div>
      <div class="form-row mc-row" style="gap:6px">
        <button class="sm primary" onclick="submitPeerForm('${editingId}')">${editingId ? '保存' : '添加并验证'}</button>
        <button class="sm" onclick="document.getElementById('addPeerFormArea').innerHTML=''">取消</button>
        <div id="peerFormStatus" style="font-size:11px;align-self:center;min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"></div>
      </div>
    </div>
  `;
}

async function submitPeerForm(editingId) {
  const name = document.getElementById('peerName')?.value?.trim();
  const baseUrl = document.getElementById('peerBaseUrl')?.value?.trim();
  const accessKey = document.getElementById('peerAccessKey')?.value?.trim();
  const status = document.getElementById('peerFormStatus');
  if (!name || !baseUrl) {
    if (status) status.innerHTML = '<span style="color:var(--red)">✗ 请填写名称和地址</span>';
    return;
  }
  if (!editingId && !accessKey) {
    if (status) status.innerHTML = '<span style="color:var(--red)">✗ 请填写访问密钥</span>';
    return;
  }
  if (status) status.innerHTML = '<span class="btn-spinner"></span> 验证中...';
  try {
    if (editingId) {
      const body = { name, baseUrl };
      if (accessKey) body.accessKey = accessKey;
      await api('PUT', `/data-migrations/peers/${editingId}`, body);
    } else {
      await api('POST', '/data-migrations/peers', { name, baseUrl, accessKey });
    }
    showToast(editingId ? 'CDS 密钥已更新' : 'CDS 密钥已添加并验证', 'success');
    openPeersModal();
  } catch (e) {
    if (status) status.innerHTML = `<span style="color:var(--red)" title="${esc(e.message)}">✗ ${esc(e.message)}</span>`;
  }
}

function editCdsPeer(id) {
  const peer = cdsPeers.find(p => p.id === id);
  if (!peer) return;
  openAddPeerForm(peer);
}

async function testCdsPeer(id) {
  try {
    const d = await api('POST', `/data-migrations/peers/${id}/test`);
    if (d.success) { showToast(`连接成功: ${d.remoteLabel || ''}`, 'success'); openPeersModal(); }
    else showToast(`连接失败: ${d.error || '未知错误'}`, 'error');
  } catch (e) { showToast(e.message, 'error'); }
}

async function deleteCdsPeer(id) {
  const peer = cdsPeers.find(p => p.id === id);
  if (!confirm(`确定删除 CDS 密钥「${peer?.name || id}」？`)) return;
  try {
    await api('DELETE', `/data-migrations/peers/${id}`);
    showToast('已删除', 'success');
    openPeersModal();
  } catch (e) { showToast(e.message, 'error'); }
}

function copyToClipboard(text) {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(() => showToast('已复制', 'success')).catch(() => fallbackCopy(text));
    } else {
      fallbackCopy(text);
    }
  } catch { fallbackCopy(text); }
}

function fallbackCopy(text) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.left = '-9999px';
  document.body.appendChild(ta);
  ta.select();
  try { document.execCommand('copy'); showToast('已复制', 'success'); }
  catch { showToast('复制失败', 'error'); }
  document.body.removeChild(ta);
}

// ── Cluster node list (inside cluster settings modal) ──
//
// Big-company-style node cards inspired by Vercel / Grafana / K8s
// Dashboard:
//   - Avatar-style role icon (star for master, rack for remote)
//   - Large primary name + muted meta row
//   - Ring-style progress indicators for memory / CPU / branch utilization
//   - Status pill with colored background (not just a dot)
//   - Hover lift + action buttons appear on hover
//   - Offline cards visually recede with reduced opacity + subtle stripes
function renderClusterNodeListHtml() {
  if (!executors || executors.length === 0) {
    return '<div class="cluster-node-empty">暂无节点（主节点尚未自注册 embedded master）</div>';
  }
  return executors.map(node => {
    const role = node.role || 'remote';
    const status = node.status || 'unknown';
    const cap = node.capacity || { maxBranches: 0, memoryMB: 0, cpuCores: 0 };
    const load = node.load || { memoryUsedMB: 0, cpuPercent: 0 };
    const memPct = cap.memoryMB > 0 ? Math.round(load.memoryUsedMB / cap.memoryMB * 100) : 0;
    const memGB = (load.memoryUsedMB / 1024).toFixed(1);
    const totalGB = (cap.memoryMB / 1024).toFixed(1);
    // Prefer explicit runningContainers from heartbeat; fall back to branch
    // count (for old heartbeats) or 0. A single branch can have N services
    // (containers), so the accurate count comes from the executor's heartbeat.
    const branchCount = node.runningContainers ?? (node.branches?.length || node.branchCount || 0);
    const branchPct = cap.maxBranches > 0 ? Math.round(branchCount / cap.maxBranches * 100) : 0;
    const cpuPct = Math.min(load.cpuPercent, 100);
    const isEmbedded = role === 'embedded';

    // Short display name — strip the prefix so users see "vmi3221419" and
    // "VM-0-17-ubuntu-9901" instead of the redundant "master-"/"executor-".
    const displayName = node.id.replace(/^master-/, '').replace(/^executor-/, '');

    // Actions: hidden embedded master, visible on hover for remote nodes
    const actions = isEmbedded
      ? ''
      : `
        ${status === 'online' ? `
          <button class="node-action-btn" onclick="drainExecutor('${esc(node.id)}')" title="排空: 调度器不再派新分支到这里">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M3 5h10M3 11h10"/><path d="M5 5v6M11 5v6"/></svg>
            排空
          </button>` : ''}
        <button class="node-action-btn danger" onclick="removeExecutor('${esc(node.id)}')" title="踢出: 从集群移除此节点">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M3 5h10M6 5V3h4v2M5 5l1 8h4l1-8"/></svg>
          踢出
        </button>
      `;

    const statusLabel = { online: '在线', offline: '离线', draining: '排空中' }[status] || status;

    // Compact role icon. Star = master, rack = remote executor.
    const roleIcon = isEmbedded
      ? '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l2.5 7h7.5l-6 5 2.5 8-6.5-5-6.5 5 2.5-8-6-5h7.5z"/></svg>'
      : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><rect x="4" y="4" width="16" height="4" rx="1"/><rect x="4" y="11" width="16" height="4" rx="1"/><rect x="4" y="18" width="16" height="3" rx="1"/><circle cx="7" cy="6" r="0.5" fill="currentColor"/><circle cx="7" cy="13" r="0.5" fill="currentColor"/></svg>';

    // Inline SVG ring meter — cleaner than a horizontal bar, works in
    // small cards, stacked 3 across for the 3 key metrics.
    const ringMeter = (label, pct, value, danger) => {
      const safePct = Math.min(Math.max(pct || 0, 0), 100);
      // Ring geometry: radius 16, circumference ~100.5
      const circumference = 2 * Math.PI * 16;
      const offset = circumference * (1 - safePct / 100);
      const color = danger && safePct > 85 ? '#f85149' : safePct > 65 ? '#d29922' : '#3fb950';
      return `
        <div class="node-ring">
          <svg width="48" height="48" viewBox="0 0 40 40">
            <circle cx="20" cy="20" r="16" fill="none" stroke="rgba(139,148,158,0.15)" stroke-width="3"/>
            <circle cx="20" cy="20" r="16" fill="none" stroke="${color}" stroke-width="3"
                    stroke-linecap="round"
                    stroke-dasharray="${circumference}"
                    stroke-dashoffset="${offset}"
                    transform="rotate(-90 20 20)"
                    style="transition: stroke-dashoffset 0.6s ease"/>
            <text x="20" y="22" text-anchor="middle" fill="currentColor"
                  font-size="10" font-weight="600">${safePct}%</text>
          </svg>
          <div class="node-ring-label">${label}</div>
          <div class="node-ring-value">${value}</div>
        </div>
      `;
    };

    // Last heartbeat age for offline hint
    let offlineHint = '';
    if (status === 'offline' && node.lastHeartbeat) {
      const agoMs = Date.now() - new Date(node.lastHeartbeat).getTime();
      const agoMin = Math.floor(agoMs / 60000);
      const agoStr = agoMin < 1 ? '不到 1 分钟前' : agoMin < 60 ? `${agoMin} 分钟前` : `${Math.floor(agoMin / 60)} 小时前`;
      offlineHint = `
        <div class="node-offline-banner">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M8 1.5a.75.75 0 01.75.75v6a.75.75 0 01-1.5 0v-6A.75.75 0 018 1.5zm0 9.75a1 1 0 100 2 1 1 0 000-2z"/></svg>
          <span>最后心跳 ${agoStr}</span>
          <span class="node-offline-advice">可能节点关机或网络不通</span>
        </div>
      `;
    }

    return `
      <div class="node-card node-card-${status} node-card-role-${role}">
        <div class="node-card-header">
          <div class="node-card-avatar node-card-avatar-${role}">
            ${roleIcon}
          </div>
          <div class="node-card-title">
            <div class="node-card-name">
              ${esc(displayName)}
              ${isEmbedded ? '<span class="node-card-self-tag">本机</span>' : ''}
            </div>
            <div class="node-card-meta">
              <span class="node-card-meta-item">${esc(node.host || '?')}:${node.port || '?'}</span>
              <span class="node-card-meta-dot">·</span>
              <span class="node-card-meta-item">${cap.cpuCores} CPU</span>
              <span class="node-card-meta-dot">·</span>
              <span class="node-card-meta-item">${totalGB} GB</span>
            </div>
          </div>
          <div class="node-card-status node-card-status-${status}">
            <span class="node-card-status-dot"></span>
            ${statusLabel}
          </div>
          ${actions ? `<div class="node-card-actions">${actions}</div>` : ''}
        </div>
        ${offlineHint}
        <div class="node-card-rings">
          ${ringMeter('内存', memPct, `${memGB}/${totalGB} GB`, true)}
          ${ringMeter('CPU', cpuPct, `${cpuPct}%`, true)}
          ${ringMeter('容器', branchPct, `${branchCount}/${cap.maxBranches}`, false)}
        </div>
      </div>
    `;
  }).join('');
}

async function changeClusterStrategy(newStrategy) {
  try {
    const res = await fetch('/api/cluster/strategy', {
      method: 'PUT',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ strategy: newStrategy }),
    });
    const body = await res.json();
    if (!res.ok) {
      showToast(body.error || '切换策略失败', 'error');
      return;
    }
    clusterStrategy = newStrategy;
    showToast(`调度策略已切换为 ${newStrategy}`, 'success');
  } catch (err) {
    showToast('网络错误: ' + err.message, 'error');
  }
}

// ── Cluster modal live refresh (SSE-driven) ──
//
// When the state-stream SSE pushes an executor change while the cluster
// settings modal is open (e.g. a node goes offline, someone else joins),
// we re-render the node list inside the modal without closing it. The
// function is a no-op when the modal isn't open.
function refreshClusterModalIfOpen() {
  const listEl = document.getElementById('clusterNodeList');
  if (!listEl) return;
  listEl.innerHTML = renderClusterNodeListHtml();
  const statusBar = document.querySelector('.cluster-status-bar');
  if (statusBar && clusterCapacity) {
    const meta = statusBar.querySelector('.cluster-status-meta');
    if (meta) {
      meta.textContent =
        `在线节点 ${clusterCapacity.online || 0} / ` +
        `总内存 ${clusterCapacity.total?.memoryMB || 0} MB / ` +
        `总 CPU ${clusterCapacity.total?.cpuCores || 0} 核`;
    }
  }
}

// ── Cluster bootstrap (one-click UI) ──
//
// Dashboard-facing counterpart to exec_cds.sh issue-token / connect.
// See cds/src/routes/cluster.ts for the backend contract.

let clusterCountdownTimer = null;

async function openClusterModal() {
  // 1. Probe current cluster role so the modal lands on the right tab.
  let statusBody = null;
  try {
    const res = await fetch('/api/cluster/status', { credentials: 'include' });
    statusBody = await res.json();
  } catch (err) {
    showToast('无法查询集群状态', 'error');
    return;
  }

  const role = statusBody.effectiveRole;
  const capacity = statusBody.capacity || { online: 0, total: {} };
  // Sync the module-level cluster state from this probe so other UI bits
  // (header badge, branch cards, etc.) have fresh data even before the
  // next SSE tick arrives.
  clusterCapacity = capacity;
  clusterStrategy = statusBody.strategy || 'least-load';
  clusterEffectiveRole = role || 'standalone';
  if (Array.isArray(capacity.nodes)) {
    executors = capacity.nodes;
  }

  // Role-aware title gives context without forcing the user to read the body
  const roleLabel = {
    standalone: '独立模式',
    scheduler: '主节点 (scheduler)',
    executor: '执行器 (executor)',
    hybrid: '混合模式 (standalone + 热加入)',
  }[role] || role;

  // Default to master tab when we ARE the master, slave tab when we're
  // an executor, and master tab with both options visible for a plain
  // standalone (most common "I am about to bring in a second machine").
  const defaultTab = role === 'executor' || role === 'hybrid' ? 'slave' : 'master';

  const html = `
    <div class="cluster-modal">
      <div class="cluster-status-bar">
        <div class="cluster-status-left">
          <span class="cluster-status-dot" data-role="${role}"></span>
          <div>
            <div class="cluster-status-role">当前角色：${esc(roleLabel)}</div>
            <div class="cluster-status-meta">
              在线节点 ${capacity.online || 0} /
              总内存 ${capacity.total?.memoryMB || 0} MB /
              总 CPU ${capacity.total?.cpuCores || 0} 核
            </div>
          </div>
        </div>
        ${statusBody.masterUrl ? `
          <a class="cluster-master-link" href="${esc(statusBody.masterUrl)}" target="_blank" rel="noopener">
            主节点 ↗
          </a>
        ` : ''}
      </div>

      <div class="cluster-tabs">
        <button class="cluster-tab ${defaultTab === 'master' ? 'active' : ''}"
                onclick="switchClusterTab('master')">我是主节点</button>
        <button class="cluster-tab ${defaultTab === 'slave' ? 'active' : ''}"
                onclick="switchClusterTab('slave')">我是从节点</button>
      </div>

      <div id="clusterTabMaster" class="cluster-tab-body ${defaultTab === 'master' ? '' : 'hidden'}">
        <p class="cluster-tab-desc">
          点击"生成连接码"，把出现的字符串复制到另一台机器的"我是从节点"里粘贴，
          对方就会自动以 executor 身份加入集群。连接码 <strong>15 分钟过期</strong>。
        </p>
        <button class="btn-primary cluster-action-btn" onclick="doIssueToken()">
          🔐 生成连接码
        </button>
        <div id="clusterTokenBox" class="cluster-token-box hidden">
          <label>连接码（复制下面的字符串粘贴到另一台机器）</label>
          <textarea id="clusterTokenArea" readonly rows="4" onclick="this.select()"></textarea>
          <div class="cluster-token-actions">
            <button class="btn-secondary" onclick="copyClusterToken()">📋 复制</button>
            <span id="clusterTokenCountdown" class="cluster-countdown"></span>
          </div>
          <div class="cluster-token-hint">
            主节点地址：<code id="clusterMasterDisplay"></code>
          </div>
        </div>
      </div>

      <div id="clusterTabSlave" class="cluster-tab-body ${defaultTab === 'slave' ? '' : 'hidden'}">
        ${role === 'executor' || role === 'hybrid' ? `
          <p class="cluster-tab-desc">
            本节点已作为 executor 加入集群：
            <code>${esc(statusBody.masterUrl || '未知')}</code><br>
            Executor ID：<code>${esc(statusBody.executorId || '未知')}</code>
          </p>
          <button class="btn-danger cluster-action-btn" onclick="doLeaveCluster()">
            🚪 退出集群
          </button>
        ` : `
          <p class="cluster-tab-desc">
            在主节点上点"生成连接码"后，把得到的字符串粘贴到下面，点"加入集群"。
            中间会验证、写入配置、立刻注册到主节点，<strong>无需重启</strong>。
          </p>
          <textarea id="clusterJoinInput" class="cluster-paste-input" rows="4"
                    placeholder="把主节点生成的连接码粘贴到这里..."></textarea>
          <button class="btn-primary cluster-action-btn" onclick="doJoinCluster()">
            🔌 加入集群
          </button>
          <div id="clusterJoinResult"></div>
        `}
      </div>

      <!-- ── Cluster management (visible in scheduler / hybrid roles) ── -->
      ${role === 'scheduler' || role === 'hybrid' || (capacity.nodes && capacity.nodes.length > 1) ? `
        <div class="cluster-mgmt-section">
          <div class="cluster-mgmt-header">
            <h3 class="cluster-mgmt-title">节点管理</h3>
            <span class="cluster-mgmt-hint">SSE 实时更新 · 主节点不可移除</span>
          </div>
          <div id="clusterNodeList" class="cluster-node-list">
            ${renderClusterNodeListHtml()}
          </div>

          <div class="cluster-strategy">
            <label class="cluster-strategy-label">调度策略 <span class="cluster-strategy-hint">决定新部署派发到哪台节点</span></label>
            <div class="cluster-strategy-options">
              <label class="cluster-strategy-radio">
                <input type="radio" name="clusterStrategy" value="least-load"
                       ${clusterStrategy === 'least-load' ? 'checked' : ''}
                       onchange="changeClusterStrategy(this.value)">
                <span><strong>least-load</strong>（推荐）— 按 60% 内存 + 40% CPU 加权选最空闲</span>
              </label>
              <label class="cluster-strategy-radio">
                <input type="radio" name="clusterStrategy" value="least-branches"
                       ${clusterStrategy === 'least-branches' ? 'checked' : ''}
                       onchange="changeClusterStrategy(this.value)">
                <span><strong>least-branches</strong> — 选运行分支最少的节点</span>
              </label>
              <label class="cluster-strategy-radio">
                <input type="radio" name="clusterStrategy" value="round-robin"
                       ${clusterStrategy === 'round-robin' ? 'checked' : ''}
                       onchange="changeClusterStrategy(this.value)">
                <span><strong>round-robin</strong> — 按心跳时间轮询</span>
              </label>
            </div>
          </div>
        </div>
      ` : ''}
    </div>
  `;

  openConfigModal('集群设置', html);

  // Fire and forget — refresh the header badge based on the latest role.
  updateClusterStatusBadge(role, capacity.online || 0);
}

function switchClusterTab(which) {
  document.querySelectorAll('.cluster-tab').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.cluster-tab-body').forEach(b => b.classList.add('hidden'));
  const btns = document.querySelectorAll('.cluster-tab');
  if (which === 'master') {
    if (btns[0]) btns[0].classList.add('active');
    const body = document.getElementById('clusterTabMaster');
    if (body) body.classList.remove('hidden');
  } else {
    if (btns[1]) btns[1].classList.add('active');
    const body = document.getElementById('clusterTabSlave');
    if (body) body.classList.remove('hidden');
  }
}

async function doIssueToken() {
  const btn = event?.currentTarget;
  if (btn) { btn.disabled = true; btn.textContent = '⏳ 生成中...'; }

  try {
    const res = await fetch('/api/cluster/issue-token', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
    });
    const body = await res.json();
    if (!res.ok) {
      showToast(body.error || '生成失败', 'error');
      return;
    }

    // Display the code, the master URL, and start the countdown
    const box = document.getElementById('clusterTokenBox');
    const area = document.getElementById('clusterTokenArea');
    const masterDisplay = document.getElementById('clusterMasterDisplay');
    if (box) box.classList.remove('hidden');
    if (area) area.value = body.connectionCode;
    if (masterDisplay) masterDisplay.textContent = body.masterUrl;

    startClusterCountdown(body.expiresAt);
    showToast('连接码已生成', 'success');
  } catch (err) {
    showToast('网络错误: ' + err.message, 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '🔐 重新生成连接码'; }
  }
}

function startClusterCountdown(expiresAtIso) {
  if (clusterCountdownTimer) clearInterval(clusterCountdownTimer);
  const label = document.getElementById('clusterTokenCountdown');
  const endMs = new Date(expiresAtIso).getTime();

  function tick() {
    if (!label) return;
    const remainMs = endMs - Date.now();
    if (remainMs <= 0) {
      label.textContent = '⚠ 已过期，请重新生成';
      label.className = 'cluster-countdown expired';
      if (clusterCountdownTimer) { clearInterval(clusterCountdownTimer); clusterCountdownTimer = null; }
      return;
    }
    const mins = Math.floor(remainMs / 60000);
    const secs = Math.floor((remainMs % 60000) / 1000);
    label.textContent = `⏱ ${mins}:${String(secs).padStart(2, '0')} 后过期`;
    label.className = 'cluster-countdown' + (remainMs < 60000 ? ' urgent' : '');
  }
  tick();
  clusterCountdownTimer = setInterval(tick, 1000);
}

function copyClusterToken() {
  const area = document.getElementById('clusterTokenArea');
  if (!area || !area.value) return;
  copyToClipboard(area.value);
}

async function doJoinCluster() {
  const input = document.getElementById('clusterJoinInput');
  const result = document.getElementById('clusterJoinResult');
  const btn = event?.currentTarget;
  if (!input || !input.value.trim()) {
    showToast('请先粘贴连接码', 'error');
    return;
  }

  if (btn) { btn.disabled = true; btn.textContent = '⏳ 正在加入...'; }
  if (result) result.innerHTML = '<div class="cluster-progress">🔄 解析连接码 → 写入配置 → 注册到主节点 → 启动心跳...</div>';

  try {
    const res = await fetch('/api/cluster/join', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ connectionCode: input.value.trim() }),
    });
    const body = await res.json();

    if (!res.ok) {
      if (result) result.innerHTML = `<div class="cluster-error">❌ ${esc(body.error || '加入失败')}</div>`;
      showToast(body.error || '加入失败', 'error');
      return;
    }

    // Success — show the restart warning prominently
    if (result) {
      result.innerHTML = `
        <div class="cluster-success">
          ✅ 已加入集群
          <div class="cluster-success-meta">
            Executor ID: <code>${esc(body.executorId)}</code><br>
            主节点: <a href="${esc(body.masterUrl)}" target="_blank" rel="noopener">${esc(body.masterUrl)}</a>
          </div>
          <div class="cluster-warning">
            ⚠ ${esc(body.restartWarning || '下次重启后 Dashboard 将停止，请把书签换成主节点 URL')}
          </div>
        </div>
      `;
    }
    showToast('已加入集群', 'success');
    clusterEffectiveRole = 'hybrid';
    updateClusterStatusBadge('hybrid', 2);
  } catch (err) {
    if (result) result.innerHTML = `<div class="cluster-error">❌ 网络错误: ${esc(err.message)}</div>`;
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '🔌 加入集群'; }
  }
}

async function doLeaveCluster() {
  if (!confirm('确认退出集群？本机上运行中的容器不会被停止，但心跳会停止，主节点下一次健康检查会把本节点标记为 offline。')) {
    return;
  }
  const btn = event?.currentTarget;
  if (btn) { btn.disabled = true; btn.textContent = '⏳ 正在退出...'; }

  try {
    const res = await fetch('/api/cluster/leave', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
    });
    const body = await res.json();
    if (!res.ok) {
      showToast(body.error || '退出失败', 'error');
      return;
    }
    showToast('已退出集群', 'success');
    // Local state update so the settings menu's "退出集群" item disappears
    // without needing a page reload.
    clusterEffectiveRole = 'standalone';
    updateClusterStatusBadge('standalone', 1);
    // Only close the config modal if it's open (settings-menu path doesn't
    // open the modal at all).
    if (document.querySelector('.cluster-modal')) {
      closeConfigModal();
    }
  } catch (err) {
    showToast('网络错误: ' + err.message, 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '🚪 退出集群'; }
  }
}

/** Update the small badge next to the "集群" menu item based on role. */
function updateClusterStatusBadge(role, onlineCount) {
  const badge = document.getElementById('clusterStatusBadge');
  if (!badge) return;
  if (role === 'scheduler' && onlineCount > 1) {
    badge.textContent = `● ${onlineCount} 节点`;
    badge.style.color = '#3fb950';
  } else if (role === 'executor' || role === 'hybrid') {
    badge.textContent = '● 已加入';
    badge.style.color = '#58a6ff';
  } else {
    badge.textContent = '';
  }
}

// ════════════════════════════════════════════════════════════════════
// Branch profile override modal — per-branch container customization
//
// Lets a user extend the shared public BuildProfile for a specific branch
// without touching other branches. Fields left empty inherit from the
// public baseline. "重置为公共" clears the override entirely.
//
// Backend: GET/PUT/DELETE /api/branches/:id/profile-overrides[/:profileId]
// Merge happens server-side in `resolveEffectiveProfile()`.
// ════════════════════════════════════════════════════════════════════

let _overrideModalState = null; // { branchId, profiles, activeProfileId, dirty }

function _ensureOverrideModal() {
  if (document.getElementById('overrideModal')) return;
  const modal = document.createElement('div');
  modal.id = 'overrideModal';
  modal.className = 'modal hidden';
  modal.innerHTML = `
    <div class="modal-backdrop" onclick="closeOverrideModal()"></div>
    <div class="modal-dialog config-modal-dialog" style="max-width: 860px;">
      <div class="modal-header">
        <h2 id="overrideModalTitle">容器配置</h2>
        <button class="modal-close" onclick="closeOverrideModal()" aria-label="关闭">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M3.72 3.72a.75.75 0 011.06 0L8 6.94l3.22-3.22a.75.75 0 111.06 1.06L9.06 8l3.22 3.22a.75.75 0 11-1.06 1.06L8 9.06l-3.22 3.22a.75.75 0 01-1.06-1.06L6.94 8 3.72 4.78a.75.75 0 010-1.06z"/></svg>
        </button>
      </div>
      <div id="overrideProfileTabs" style="display:flex;gap:4px;padding:8px 18px 0;flex-wrap:wrap;"></div>
      <div class="modal-body" id="overrideModalBody"></div>
    </div>
  `;
  document.body.appendChild(modal);
}

async function openOverrideModal(branchId) {
  _ensureOverrideModal();
  try {
    const data = await api('GET', `/branches/${encodeURIComponent(branchId)}/profile-overrides`);
    if (!data.profiles || data.profiles.length === 0) {
      showToast('该分支暂无可配置的构建服务', 'info');
      return;
    }
    _overrideModalState = {
      branchId,
      profiles: data.profiles,
      activeProfileId: data.profiles[0].profileId,
      dirty: false,
    };
    document.getElementById('overrideModalTitle').textContent = `容器配置 — ${branchId}`;
    document.getElementById('overrideModal').classList.remove('hidden');
    _renderOverrideTabs();
    _renderOverrideForm();
  } catch (e) {
    showToast('加载配置失败: ' + e.message, 'error');
  }
}

function closeOverrideModal() {
  if (_overrideModalState?.dirty) {
    if (!confirm('你有未保存的修改，确定关闭吗？')) return;
  }
  document.getElementById('overrideModal')?.classList.add('hidden');
  _overrideModalState = null;
}

function _renderOverrideTabs() {
  const s = _overrideModalState;
  if (!s) return;
  const tabsEl = document.getElementById('overrideProfileTabs');
  tabsEl.innerHTML = s.profiles.map(p => {
    const active = p.profileId === s.activeProfileId;
    const dot = p.hasOverride ? '<span style="display:inline-block;width:6px;height:6px;border-radius:50%;background:var(--accent,#4a9eff);margin-left:6px;vertical-align:2px" title="已有分支自定义"></span>' : '';
    return `<button class="log-tab ${active ? 'active' : ''}" style="padding:6px 12px;border-radius:8px 8px 0 0;border:1px solid var(--border);border-bottom:none;background:${active ? 'var(--bg-elevated)' : 'transparent'};color:${active ? 'var(--text-primary)' : 'var(--text-secondary)'};cursor:pointer;font-size:12px;" onclick="_switchOverrideProfile('${esc(p.profileId)}')">${esc(p.profileName || p.profileId)}${dot}</button>`;
  }).join('');
}

function _switchOverrideProfile(profileId) {
  if (!_overrideModalState) return;
  if (_overrideModalState.dirty) {
    if (!confirm('切换前放弃当前修改？')) return;
    _overrideModalState.dirty = false;
  }
  _overrideModalState.activeProfileId = profileId;
  _renderOverrideTabs();
  _renderOverrideForm();
}

function _renderOverrideForm() {
  const s = _overrideModalState;
  if (!s) return;
  const p = s.profiles.find(x => x.profileId === s.activeProfileId);
  if (!p) return;

  const baseline = p.baseline || {};
  const override = p.override || {};
  const effective = p.effective || baseline;

  // Helper: render a single field with baseline hint + optional override input
  const field = (label, key, type, baselineVal, overrideVal, placeholder) => {
    const inheriting = overrideVal === undefined || overrideVal === null || overrideVal === '';
    const hint = baselineVal !== undefined && baselineVal !== null && baselineVal !== ''
      ? `<div style="font-size:11px;color:var(--text-muted);margin-top:3px">公共默认: <code style="font-family:var(--font-mono,monospace);color:var(--text-secondary)">${esc(String(baselineVal))}</code></div>`
      : `<div style="font-size:11px;color:var(--text-muted);margin-top:3px">公共默认: <em>无</em></div>`;
    const inputEl = type === 'textarea'
      ? `<textarea data-override-key="${key}" rows="4" placeholder="${esc(placeholder || '')}" style="width:100%;padding:8px 10px;background:var(--bg-primary);border:1px solid var(--border);border-radius:6px;color:var(--text-primary);font-family:var(--font-mono,monospace);font-size:12px;resize:vertical" oninput="_overrideFieldChanged()">${esc(overrideVal || '')}</textarea>`
      : `<input type="${type}" data-override-key="${key}" value="${esc(overrideVal !== undefined && overrideVal !== null ? String(overrideVal) : '')}" placeholder="${esc(placeholder || '继承公共默认')}" style="width:100%;padding:8px 10px;background:var(--bg-primary);border:1px solid var(--border);border-radius:6px;color:var(--text-primary);font-family:${type === 'number' ? 'inherit' : 'var(--font-mono,monospace)'};font-size:12px" oninput="_overrideFieldChanged()" />`;
    const inheritBadge = inheriting
      ? '<span style="display:inline-block;padding:1px 6px;font-size:10px;background:var(--bg-elevated);color:var(--text-muted);border-radius:4px;margin-left:8px;border:1px solid var(--border)">继承</span>'
      : '<span style="display:inline-block;padding:1px 6px;font-size:10px;background:var(--accent-bg,rgba(74,158,255,0.15));color:var(--accent,#4a9eff);border-radius:4px;margin-left:8px;border:1px solid var(--accent,#4a9eff)">自定义</span>';
    return `
      <div style="margin-bottom:14px">
        <label style="display:block;font-size:12px;font-weight:600;color:var(--text-primary);margin-bottom:4px">${esc(label)}${inheritBadge}</label>
        ${inputEl}
        ${hint}
      </div>
    `;
  };

  // env: baseline is Record<string,string>, override is Record<string,string>
  // For UX we render the MERGED env as KEY=VAL lines, where override keys are editable
  const envToText = (envObj) => Object.entries(envObj || {}).map(([k, v]) => `${k}=${v}`).join('\n');
  const baselineEnvText = envToText(baseline.env);
  const overrideEnvText = envToText(override.env);

  // Deploy mode selector — baseline.deployModes is Record<string, DeployModeOverride>
  const modeOptions = baseline.deployModes
    ? Object.entries(baseline.deployModes).map(([key, m]) => `<option value="${esc(key)}" ${override.activeDeployMode === key ? 'selected' : ''}>${esc(m.label || key)}</option>`).join('')
    : '';

  const body = document.getElementById('overrideModalBody');
  body.innerHTML = `
    <div style="display:flex;gap:8px;align-items:center;margin-bottom:12px;padding:10px 12px;background:var(--bg-elevated);border-radius:8px;border:1px solid var(--border);font-size:12px">
      <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" style="flex-shrink:0;color:var(--accent,#4a9eff)"><path d="M8 0a8 8 0 100 16A8 8 0 008 0zM7.25 4a.75.75 0 011.5 0v4a.75.75 0 01-1.5 0V4zM8 10a1 1 0 100 2 1 1 0 000-2z"/></svg>
      <span style="color:var(--text-secondary);line-height:1.5">留空的字段将<strong style="color:var(--text-primary)">继承公共默认</strong>。保存后需要<strong style="color:var(--text-primary)">重新部署</strong>该分支才能生效。</span>
    </div>

    ${field('Docker 镜像', 'dockerImage', 'text', baseline.dockerImage, override.dockerImage, '例: node:20-alpine')}
    ${field('启动命令', 'command', 'textarea', baseline.command, override.command, '例: pnpm install && pnpm dev')}
    ${field('容器工作目录', 'containerWorkDir', 'text', baseline.containerWorkDir || '/app', override.containerWorkDir, '例: /workspace')}
    ${field('容器内端口', 'containerPort', 'number', baseline.containerPort, override.containerPort, '例: 5000')}

    <div style="margin-bottom:14px">
      <label style="display:block;font-size:12px;font-weight:600;color:var(--text-primary);margin-bottom:4px">环境变量覆盖
        ${override.env && Object.keys(override.env).length > 0
          ? '<span style="display:inline-block;padding:1px 6px;font-size:10px;background:var(--accent-bg,rgba(74,158,255,0.15));color:var(--accent,#4a9eff);border-radius:4px;margin-left:8px;border:1px solid var(--accent,#4a9eff)">自定义 ' + Object.keys(override.env).length + ' 项</span>'
          : '<span style="display:inline-block;padding:1px 6px;font-size:10px;background:var(--bg-elevated);color:var(--text-muted);border-radius:4px;margin-left:8px;border:1px solid var(--border)">继承</span>'}
      </label>
      <textarea data-override-key="env" rows="6" placeholder="每行一个 KEY=VALUE，将覆盖同名的公共默认" style="width:100%;padding:8px 10px;background:var(--bg-primary);border:1px solid var(--border);border-radius:6px;color:var(--text-primary);font-family:var(--font-mono,monospace);font-size:12px;resize:vertical" oninput="_overrideFieldChanged()">${esc(overrideEnvText)}</textarea>
      <div style="font-size:11px;color:var(--text-muted);margin-top:3px">
        公共默认 (${Object.keys(baseline.env || {}).length} 项):
        ${baselineEnvText ? `<details style="display:inline"><summary style="cursor:pointer;color:var(--accent,#4a9eff)">展开</summary><pre style="margin-top:4px;padding:6px 8px;background:var(--bg-primary);border-radius:4px;font-size:11px;max-height:120px;overflow:auto">${esc(baselineEnvText)}</pre></details>` : '<em>无</em>'}
      </div>
    </div>

    ${modeOptions ? `
      <div style="margin-bottom:14px">
        <label style="display:block;font-size:12px;font-weight:600;color:var(--text-primary);margin-bottom:4px">部署模式</label>
        <select data-override-key="activeDeployMode" style="width:100%;padding:8px 10px;background:var(--bg-primary);border:1px solid var(--border);border-radius:6px;color:var(--text-primary);font-size:12px" onchange="_overrideFieldChanged()">
          <option value="">继承 (${esc(baseline.activeDeployMode || '默认')})</option>
          ${modeOptions}
        </select>
      </div>
    ` : ''}

    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:14px">
      <div>
        <label style="display:block;font-size:12px;font-weight:600;color:var(--text-primary);margin-bottom:4px">内存上限 (MB)</label>
        <input type="number" data-override-key="resources.memoryMB" value="${override.resources?.memoryMB || ''}" placeholder="${baseline.resources?.memoryMB || '无限制'}" style="width:100%;padding:8px 10px;background:var(--bg-primary);border:1px solid var(--border);border-radius:6px;color:var(--text-primary);font-size:12px" oninput="_overrideFieldChanged()" />
        <div style="font-size:11px;color:var(--text-muted);margin-top:3px">公共默认: <code>${baseline.resources?.memoryMB || '无限制'}</code></div>
      </div>
      <div>
        <label style="display:block;font-size:12px;font-weight:600;color:var(--text-primary);margin-bottom:4px">CPU 上限 (核)</label>
        <input type="number" step="0.1" data-override-key="resources.cpus" value="${override.resources?.cpus || ''}" placeholder="${baseline.resources?.cpus || '无限制'}" style="width:100%;padding:8px 10px;background:var(--bg-primary);border:1px solid var(--border);border-radius:6px;color:var(--text-primary);font-size:12px" oninput="_overrideFieldChanged()" />
        <div style="font-size:11px;color:var(--text-muted);margin-top:3px">公共默认: <code>${baseline.resources?.cpus || '无限制'}</code></div>
      </div>
    </div>

    <div style="margin-bottom:14px">
      <label style="display:block;font-size:12px;font-weight:600;color:var(--text-primary);margin-bottom:4px">备注 (为什么这个分支需要自定义)</label>
      <input type="text" data-override-key="notes" value="${esc(override.notes || '')}" placeholder="例: 本分支压测需要更多内存" style="width:100%;padding:8px 10px;background:var(--bg-primary);border:1px solid var(--border);border-radius:6px;color:var(--text-primary);font-size:12px" oninput="_overrideFieldChanged()" />
    </div>

    <div style="display:flex;gap:8px;justify-content:space-between;padding-top:12px;border-top:1px solid var(--border)">
      <button class="sm" onclick="_resetOverride()" style="background:var(--bg-elevated);color:var(--text-secondary);border:1px solid var(--border)">重置为公共</button>
      <div style="display:flex;gap:8px">
        <button class="sm" onclick="closeOverrideModal()" style="background:var(--bg-elevated);color:var(--text-secondary);border:1px solid var(--border)">取消</button>
        <button class="sm deploy-glow-btn" onclick="_saveOverride()">保存 (需重新部署生效)</button>
      </div>
    </div>
  `;
}

function _overrideFieldChanged() {
  if (_overrideModalState) _overrideModalState.dirty = true;
}

function _collectOverrideFromForm() {
  const body = document.getElementById('overrideModalBody');
  const override = {};
  body.querySelectorAll('[data-override-key]').forEach(el => {
    const key = el.dataset.overrideKey;
    const raw = el.value;
    if (raw === '' || raw === null || raw === undefined) return; // inherit
    if (key === 'env') {
      const envObj = {};
      raw.split('\n').forEach(line => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) return;
        const eq = trimmed.indexOf('=');
        if (eq <= 0) return;
        envObj[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1);
      });
      if (Object.keys(envObj).length > 0) override.env = envObj;
    } else if (key === 'containerPort') {
      const n = parseInt(raw, 10);
      if (!isNaN(n)) override.containerPort = n;
    } else if (key === 'resources.memoryMB') {
      const n = parseInt(raw, 10);
      if (!isNaN(n) && n > 0) {
        override.resources = override.resources || {};
        override.resources.memoryMB = n;
      }
    } else if (key === 'resources.cpus') {
      const n = parseFloat(raw);
      if (!isNaN(n) && n > 0) {
        override.resources = override.resources || {};
        override.resources.cpus = n;
      }
    } else {
      override[key] = raw;
    }
  });
  return override;
}

async function _saveOverride() {
  const s = _overrideModalState;
  if (!s) return;
  const override = _collectOverrideFromForm();
  try {
    const res = await api('PUT', `/branches/${encodeURIComponent(s.branchId)}/profile-overrides/${encodeURIComponent(s.activeProfileId)}`, override);
    showToast('已保存，重新部署该分支后生效', 'success');
    s.dirty = false;
    // Refresh current profile data
    const refreshed = await api('GET', `/branches/${encodeURIComponent(s.branchId)}/profile-overrides`);
    s.profiles = refreshed.profiles;
    _renderOverrideTabs();
    _renderOverrideForm();
  } catch (e) {
    showToast('保存失败: ' + e.message, 'error');
  }
}

async function _resetOverride() {
  const s = _overrideModalState;
  if (!s) return;
  if (!confirm('确定清空该分支的容器覆盖，完全继承公共配置？')) return;
  try {
    await api('DELETE', `/branches/${encodeURIComponent(s.branchId)}/profile-overrides/${encodeURIComponent(s.activeProfileId)}`);
    showToast('已恢复公共配置', 'success');
    s.dirty = false;
    const refreshed = await api('GET', `/branches/${encodeURIComponent(s.branchId)}/profile-overrides`);
    s.profiles = refreshed.profiles;
    _renderOverrideTabs();
    _renderOverrideForm();
  } catch (e) {
    showToast('重置失败: ' + e.message, 'error');
  }
}

// Expose handlers to inline event attributes (non-module script)
window.openOverrideModal = openOverrideModal;
window.closeOverrideModal = closeOverrideModal;
window._switchOverrideProfile = _switchOverrideProfile;
window._overrideFieldChanged = _overrideFieldChanged;
window._saveOverride = _saveOverride;
window._resetOverride = _resetOverride;

// ── Init activity monitor & AI pairing ──
initActivityMonitor();
initAiPairing();

// ── Start ──
init();
