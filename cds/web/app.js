const API = '/api';

/**
 * P4 Part 3b: the current project id derived from the URL query string.
 *
 * `/index.html` is the legacy Dashboard. When reached via a project card
 * on `/projects.html` the card navigates to `index.html?project=<id>`.
 * Without that param we fall back to 'default' — the legacy project
 * created by StateService.migrateProjects(). Every list-GET request
 * injects this id as `?project=<id>` so the server-side filter
 * (routes/branches.ts) scopes branches/profiles/infra/rules to just
 * this project.
 *
 * Write requests (create branch, etc.) inline the same id in the body
 * where the endpoint expects it.
 */
const CURRENT_PROJECT_ID = (function () {
  try {
    var params = new URLSearchParams(location.search);
    var v = params.get('project');
    if (v && v.length > 0) return v;
    // FU-04 follow-up (2026-04-24): no ?project= query.
    //
    // Old behaviour returned the literal string 'default' and relied on
    // a project with that id existing — historically true because P4
    // Part 1 migration auto-created `id: 'default', legacyFlag: true`.
    // After legacy-cleanup/rename-default flips the project to a real
    // id (e.g. 'prd-agent'), every subsequent call would 404 ("加载项
    // 目失败 HTTP 404") because no project with id 'default' exists.
    //
    // Send the user to /project-list to pick (or implicitly land on
    // the only project) instead of guessing wrong.
    location.replace('/project-list');
    return null;
  } catch (e) {
    return null;
  }
})();
// If we redirected above, stop the rest of the page from initializing.
if (CURRENT_PROJECT_ID === null) {
  // The redirect is in flight; throwing keeps subsequent module-level
  // code from running against a null id during the brief navigation.
  throw new Error('redirecting to /project-list (no ?project= in URL)');
}

// Probe the project's existence asynchronously. If `?project=X` points
// at a missing project (common after `legacy-cleanup/rename-default`
// for stale `?project=default` bookmarks), bounce to the project
// picker rather than letting the rest of the page render against a
// 404'd id. This is fire-and-forget — the rest of the page begins
// initializing in parallel; if the project does exist we never see it.
fetch('/api/projects/' + encodeURIComponent(CURRENT_PROJECT_ID), { credentials: 'same-origin' })
  .then(function (r) {
    if (r.status === 404) {
      // Stash the bad id so the project list page can show a hint.
      try { sessionStorage.setItem('cds.lastMissingProject', CURRENT_PROJECT_ID); } catch (_) {}
      location.replace('/project-list?missing=' + encodeURIComponent(CURRENT_PROJECT_ID));
    }
  })
  .catch(function () { /* network blip — let the page render its own error */ });
const busyBranches = new Set();
// Per-button loading state: Map<string, Set<string>> e.g. { "main": Set(["stop", "pull"]) }
const loadingActions = new Map();
let globalBusy = false;

// ── Tag filter state ──
let activeTagFilter = null; // null = show all, string = filter by tag

// ── Inline deploy log state ──
// { branchId: { lines: string[], status: 'building'|'done'|'error', expanded: bool, errorMsg?: string } }
const inlineDeployLogs = new Map();

// P4 Part 15 — Initializing timer tracker.
//
// Tracks per-branch timestamp when a branch first enters a 'building'
// or 'starting' state. The render path calls _branchDeployStartedAt()
// which lazily sets the entry if missing, returns the ISO ms. A
// background ticker (set up below) updates the .branch-deploy-timer
// span values once per second so users see Initializing 00:04 / 00:05
// counting up like Railway does in image 3.
const _deployStartedAt = new Map();
function _branchDeployStartedAt(branchId) {
  if (!_deployStartedAt.has(branchId)) {
    _deployStartedAt.set(branchId, Date.now());
  }
  return _deployStartedAt.get(branchId);
}
function _clearBranchDeployStartedAt(branchId) {
  _deployStartedAt.delete(branchId);
}
// Tick all visible deploy-timer spans every second. Idempotent: the
// interval is started once at script load and never cleaned up
// (lifetime = page lifetime).
setInterval(function () {
  var spans = document.querySelectorAll('.branch-deploy-timer[data-since]');
  for (var i = 0; i < spans.length; i++) {
    var since = parseInt(spans[i].dataset.since, 10);
    if (!since) continue;
    var elapsed = Math.max(0, Math.floor((Date.now() - since) / 1000));
    var mm = String(Math.floor(elapsed / 60)).padStart(2, '0');
    var ss = String(elapsed % 60).padStart(2, '0');
    var valueEl = spans[i].querySelector('.branch-deploy-timer-value');
    if (valueEl) valueEl.textContent = mm + ':' + ss;
  }
}, 1000);
// Track branches that just finished deploy (for slide-in animation)
const justDeployed = new Set();

// ── Icons (Octicons 16px) ──
const ICON = {
  branch: '<svg class="inline-icon" width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M9.5 3.25a2.25 2.25 0 113 2.122V6A2.5 2.5 0 0110 8.5H6a1 1 0 00-1 1v1.128a2.251 2.251 0 11-1.5 0V5.372a2.25 2.25 0 111.5 0v1.836A2.493 2.493 0 016 7h4a1 1 0 001-1v-.628A2.25 2.25 0 019.5 3.25z"/></svg>',
  // GitHub Octocat — 16x16 mark used at the branch-card title when the
  // branch was auto-created by a webhook push. Same visual footprint as
  // `branch` so the title row layout stays stable. `.gh-branch-mark`
  // class on the <svg> lets CSS tint it (GitHub purple-ish) to signal
  // "this is GitHub-sourced" at a glance.
  githubMark: '<svg class="inline-icon gh-branch-mark" width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>',
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
  // Port beacon icons by language/framework. Rendered inside `.port-badge`
  // chips on the branch list. Each shape is a trimmed stylised mark of
  // the stack's logo — we don't claim licensed logos but shoot for
  // instantly-recognisable silhouettes (hex for node, vertical bars for
  // .NET, diamond for python, cog for rust, etc.).
  portApi: '<svg class="inline-icon" width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M1.5 1.75a.75.75 0 00-1.5 0v12.5c0 .414.336.75.75.75h14.5a.75.75 0 000-1.5H1.5V1.75zm14.28 2.53a.75.75 0 00-1.06-1.06L10 7.94 7.53 5.47a.75.75 0 00-1.06 0L2.22 9.72a.75.75 0 001.06 1.06L7 7.06l2.47 2.47a.75.75 0 001.06 0l5.25-5.25z"/></svg>',
  portWeb: '<svg class="inline-icon" width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M0 8a8 8 0 1116 0A8 8 0 010 8zm7.5-6.923c-.67.204-1.335.82-1.887 1.855A7.97 7.97 0 005.145 4H7.5V1.077zM4.09 4a9.27 9.27 0 01.64-1.539 6.7 6.7 0 01.597-.933A6.536 6.536 0 002.535 4H4.09zm-.582 3.5c.03-.877.138-1.718.312-2.5H1.674a6.958 6.958 0 00-.656 2.5H3.508zM7.5 11H5.145a7.97 7.97 0 00.468 1.068c.552 1.035 1.218 1.65 1.887 1.855V11zm1 2.923c.67-.204 1.335-.82 1.887-1.855A7.97 7.97 0 0010.855 11H8.5v2.923zM11.91 11a9.27 9.27 0 00.64 1.539 6.7 6.7 0 00.597.933A6.536 6.536 0 0015.465 11H11.91zm.582-1.5c.03-.877.138-1.718.312-2.5h2.49a6.958 6.958 0 01.656 2.5h-3.458z"/></svg>',
  // ── Stack icons use `currentColor` so CSS can drive their tint from
  //    the parent `.port-badge` state: running → theme accent (green),
  //    idle/stopped/error → muted gray. Hardcoded brand colors (Node
  //    green, dotnet purple, python blue, go cyan, react cyan) were
  //    dropped — they fought the theme and the blue in particular was
  //    illegible on our dark surface. GitHub's mark stays tinted (see
  //    `githubMark` above) because the brand association is the signal.
  portNode: '<svg class="inline-icon" width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M12 1.85c-.27 0-.55.07-.78.2l-7.44 4.3c-.48.28-.78.8-.78 1.36v8.58c0 .56.3 1.08.78 1.36l1.95 1.12c.95.46 1.29.47 1.71.47 1.41 0 2.22-.85 2.22-2.33V8.44c0-.12-.1-.22-.22-.22H9.31c-.13 0-.23.1-.23.22v8.47c0 .66-.68 1.31-1.77.76l-2.02-1.17c-.07-.04-.11-.12-.11-.2V7.7c0-.08.04-.16.11-.2l7.44-4.29c.07-.04.15-.04.22 0l7.44 4.29c.07.04.11.12.11.2v8.58c0 .08-.04.16-.11.2l-7.44 4.29c-.06.04-.15.04-.22 0L13 19.88c-.09-.05-.13-.12-.07-.16.71-.45.86-.53 1.49-.77.09-.03.16-.02.24.03l1.48.88c.07.04.15.04.22 0l7.44-4.29c.48-.28.78-.8.78-1.36V7.71c0-.56-.3-1.08-.78-1.36l-7.44-4.3c-.24-.13-.51-.2-.78-.2h-3.59z"/></svg>',
  // .NET — three vertical bars
  portDotnet: '<svg class="inline-icon" width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M4 4h3v16H4zM10.5 4h2.5l4.5 10V4H20v16h-2.5l-4.5-10v10h-2.5z"/></svg>',
  // Python — stylised two-tone S (diamond ribbon)
  portPython: '<svg class="inline-icon" width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M11.9 2C6.2 2 6.5 4.5 6.5 4.5V7h5.5v.7H4.5C4.5 7.7 2 7.4 2 13.3s2 5.5 2 5.5H6v-3.2c0-2.2 1.8-4 4-4h5c1.4 0 2.5-1.1 2.5-2.5V4.5S17.7 2 11.9 2zM9 3.7c.6 0 1 .4 1 1s-.4 1-1 1-1-.4-1-1 .4-1 1-1z"/><path d="M12.1 22c5.7 0 5.4-2.5 5.4-2.5V17h-5.5v-.7h7.5s2.5.3 2.5-5.5-2-5.5-2-5.5H18v3.2c0 2.2-1.8 4-4 4H9c-1.4 0-2.5 1.1-2.5 2.5v4.5S6.3 22 12.1 22zm3-1.7c-.6 0-1-.4-1-1s.4-1 1-1 1 .4 1 1-.4 1-1 1z"/></svg>',
  // Rust — gear cog
  portRust: '<svg class="inline-icon" width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l1.5 2.5L16 3.5l.5 3L19 7l-.5 2.5 2 1.5-2 1.5.5 2.5-2.5.5-.5 3-2.5-1L12 22l-1.5-2.5L8 20.5l-.5-3L5 17l.5-2.5-2-1.5 2-1.5L5 9l2.5-.5L8 5.5l2.5 1zm0 4a6 6 0 100 12 6 6 0 000-12z"/></svg>',
  // Go — pocket gopher mouth arcs (simplified)
  portGo: '<svg class="inline-icon" width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M2.9 10.5c-.1 0-.1-.1-.1-.1l.3-.4c.1-.1.2-.1.3-.1h4c.1 0 .1.1.1.1l-.3.4c-.1.1-.2.1-.3.1zM12 3a9 9 0 100 18 9 9 0 000-18zm0 16.5a7.5 7.5 0 110-15 7.5 7.5 0 010 15zm-2-9a1.5 1.5 0 100 3 1.5 1.5 0 000-3zm4 0a1.5 1.5 0 100 3 1.5 1.5 0 000-3z"/></svg>',
  // React — atom orbitals
  portReact: '<svg class="inline-icon" width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="12" r="2"/><g fill="none" stroke="currentColor" stroke-width="1.5"><ellipse cx="12" cy="12" rx="10" ry="4"/><ellipse cx="12" cy="12" rx="10" ry="4" transform="rotate(60 12 12)"/><ellipse cx="12" cy="12" rx="10" ry="4" transform="rotate(120 12 12)"/></g></svg>',
  // Vue — chevron-down triangle
  portVue: '<svg class="inline-icon" width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M2 3h5l5 8 5-8h5L12 21z"/></svg>',
  // Generic database (used when we can only tell it's data-tier)
  portDb: '<svg class="inline-icon" width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><ellipse cx="8" cy="3" rx="6" ry="2"/><path d="M2 5.5c1.5 1 4 1.5 6 1.5s4.5-.5 6-1.5V7c0 1.1-2.7 2-6 2S2 8.1 2 7V5.5zM2 9.5c1.5 1 4 1.5 6 1.5s4.5-.5 6-1.5V11c0 1.1-2.7 2-6 2s-6-.9-6-2V9.5z"/></svg>',
  portDefault: '<svg class="inline-icon" width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M4.75 7.25a.75.75 0 000 1.5h6.5a.75.75 0 000-1.5h-6.5z"/><path d="M0 8a8 8 0 1116 0A8 8 0 010 8zm8-6.5a6.5 6.5 0 100 13 6.5 6.5 0 000-13z"/></svg>',
};

// Port beacon icon mapping: profileId → icon key. This is the second-
// tier fallback when the dockerImage/command doesn't reveal the stack.
const PORT_ICON_MAP = {
  api: 'portApi',
  web: 'portWeb',
  admin: 'portWeb',
  frontend: 'portWeb',
  ui: 'portWeb',
  dashboard: 'portWeb',
};

/**
 * Infer the dominant language/framework icon key for a build profile
 * from its dockerImage first, falling back to its command, then its id.
 * Keeps logic synchronous (no DOM) so callers can use it inline from
 * render templates.
 *
 * Precedence (first truthy wins):
 *   1. Explicit `profile.icon` — user chose one in build-profile edit
 *   2. dockerImage substring (e.g. "node:22-alpine" → portNode)
 *   3. command substring (e.g. "dotnet run" → portDotnet)
 *   4. PORT_ICON_MAP lookup by profile.id
 *   5. portDefault
 *
 * Returns ICON[key] SVG string (ready to `${} inline` into templates).
 */
function detectPortIconKey(profile) {
  if (!profile) return null;
  const hay = [profile.dockerImage, profile.command, profile.id, profile.name]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  if (!hay) return null;
  // Ordering matters: `react` must beat `node` (react images ARE node),
  // `dotnet` must beat `net`, `mongo` must beat `go`, etc.
  if (/(mongo|redis|postgres|mysql|mariadb|elasticsearch|clickhouse|cassandra)/.test(hay)) return 'portDb';
  if (/(react|vite|next|remix|gatsby)/.test(hay)) return 'portReact';
  if (/(vue|nuxt)/.test(hay)) return 'portVue';
  if (/(dotnet|aspnet|mcr\.microsoft\.com\/dotnet)/.test(hay)) return 'portDotnet';
  if (/\b(rust|cargo)\b/.test(hay)) return 'portRust';
  if (/\bpython\b|django|flask|fastapi|uvicorn|gunicorn/.test(hay)) return 'portPython';
  if (/\bgolang\b|\bgo:\d/.test(hay)) return 'portGo';
  if (/\b(node|npm|pnpm|yarn|nestjs|express)\b/.test(hay)) return 'portNode';
  return null;
}

/** Pick commit/PR icon based on subject text */
function commitIcon(subject) {
  return /^Merge pull request/.test(subject) ? ICON.pr : ICON.commit;
}

// ── Update tracking ──
let branchUpdates = JSON.parse(localStorage.getItem('cds_branch_updates') || '{}'); // { branchId: { behind: number, latestRemoteSubject?: string } }
const recentlyTouched = new Map(); // { branchId: timestamp } — branches user just operated on
// 2026-04-19: GitHub webhook 自动创建或 API 手工添加的分支首次到达时
// 进入这个集合,触发 .fresh-arrival CSS 动画(向下滑入 + 紫色脉冲),
// 5 秒后自动清掉。用户打开 Dashboard 期间 git push 就能亲眼看到分支
// 出现,不用刷新。
const freshlyArrived = new Set();
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

/**
 * Paths that are intentionally NOT scoped to a project. These are
 * global CDS APIs (scheduler, cluster, bridge, self-update, etc.)
 * that operate across all projects and therefore must NOT receive a
 * ?project= filter. Any new endpoint added to CDS should be reviewed
 * against this list before assuming it's project-scoped.
 */
const PROJECT_UNSCOPED_PREFIXES = [
  '/cluster',
  '/scheduler',
  '/executors',
  '/bridge',
  '/self-',
  '/ai/',
  '/healthz',
  '/projects', // The projects list itself is never filtered by project id
];

function isProjectScopedPath(path) {
  // Strip any existing query string before matching
  var base = path.split('?')[0];
  for (var i = 0; i < PROJECT_UNSCOPED_PREFIXES.length; i++) {
    if (base.indexOf(PROJECT_UNSCOPED_PREFIXES[i]) === 0) return false;
  }
  return true;
}

async function api(method, path, body, { poll } = {}) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (poll) opts.headers['X-CDS-Poll'] = 'true';
  if (body) opts.body = JSON.stringify(body);

  // P4 Part 3b: inject ?project=<id> on GET requests to scoped endpoints
  // so the backend filter picks them up. POST/PUT/PATCH/DELETE carry
  // the project context in the URL path itself (e.g. /branches/:id)
  // so we don't append — the target entry already knows its project.
  let finalPath = path;
  if (method === 'GET' && isProjectScopedPath(path)) {
    var sep = path.indexOf('?') === -1 ? '?' : '&';
    finalPath = path + sep + 'project=' + encodeURIComponent(CURRENT_PROJECT_ID);
  }

  const res = await fetch(`${API}${finalPath}`, opts);
  if (res.status === 401) { location.href = '/login.html'; return; }

  // UF-14: robust body parsing. Previously this was `await res.json()`
  // which throws SyntaxError("Unexpected end of JSON input") on empty
  // bodies (204 No Content, or — more commonly — intermittent proxy
  // hiccups / server restart windows). That error kept surfacing in
  // the user's console because loadBranches polls every 5s; every
  // hiccup lit up DevTools even though the very next poll succeeded.
  //
  // The fix: read as text first, classify the response, and produce
  // a useful error message the caller (or global onerror) can act on.
  if (res.status === 204 || res.status === 205 || res.status === 304) {
    // No-content responses — return an empty object rather than parse
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return {};
  }
  const rawText = await res.text();
  if (!rawText || rawText.trim() === '') {
    // Empty body. Common causes:
    //   1. Proxy returned 502/503 with no body during a server restart
    //   2. The server closed the connection before writing (extremely
    //      rare but happens under load)
    //   3. HTTP 400 with no body — can happen when the server is
    //      still booting and middleware rejects the query params.
    //   4. Response truncated by nginx before flush finished.
    // UF-18: classify 4xx/5xx empty bodies as transient so that
    // post-deploy loadBranches() refreshes don't spam the console
    // when the server is briefly unavailable between SSE-end and
    // steady-state. Only 2xx empty (unusual) is NOT marked transient.
    const err = new Error(`HTTP ${res.status} 空响应 (服务器可能正在重启,下次轮询会恢复)`);
    err.code = 'empty_body';
    err.isTransient = res.status >= 400 || res.status === 0;
    throw err;
  }
  let data;
  try {
    data = JSON.parse(rawText);
  } catch (parseErr) {
    // Non-JSON response — usually an HTML error page from the reverse
    // proxy. Show the first 120 chars so operators can tell if it's
    // an nginx 502 vs. a Cloudflare interstitial etc.
    const snippet = rawText.slice(0, 120).replace(/\s+/g, ' ');
    const err = new Error(`服务器返回非 JSON (HTTP ${res.status}): ${snippet}`);
    err.code = 'non_json';
    err.isTransient = !res.ok;
    throw err;
  }
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
  // Fire off the auth widget probe in parallel — in disabled/basic mode
  // /api/me returns 401 and the widget stays hidden; in github mode it
  // returns 200 with user info and the widget flips visible.
  bootstrapAuthWidget().catch(() => { /* quiet: 401 is expected in non-github mode */ });
  // P4 Part 3b: fetch the current project metadata so the header "项目"
  // label can show the project name rather than a generic word. Failures
  // are quiet — the fallback is the existing "项目" placeholder.
  bootstrapCurrentProjectLabel().catch(() => { /* quiet */ });
  await Promise.all([loadBranches(), loadProfiles(), loadRoutingRules(), loadConfig(), loadEnvVars(), loadInfraServices(), loadMirrorState(), loadTabTitleState(), loadClusterStatus()]);
  refreshRemoteCandidates();
  updatePreviewModeUI();
  initStateStream(); // Server-authority: listen for state changes via SSE (replaces polling)
}

// P4 Part 3b: display the current project's name in the header link so
// users can tell which project they're in without going back to the
// projects list. When the URL has no ?project= we're on the legacy
// default and the label stays as "项目" (a generic "back to projects").
async function bootstrapCurrentProjectLabel() {
  var label = document.getElementById('cdsCurrentProjectLabel');
  if (!label) return;
  if (CURRENT_PROJECT_ID === 'default') return; // legacy case, no rename

  // Fetch directly (bypass api() since /projects is unscoped and api()
  // would inject a filter for scoped paths).
  var res;
  try {
    res = await fetch('/api/projects/' + encodeURIComponent(CURRENT_PROJECT_ID), {
      credentials: 'same-origin',
    });
  } catch {
    return;
  }
  if (!res.ok) return;
  var body = await res.json();
  if (body && body.name) {
    label.textContent = body.name;
    label.title = '项目：' + body.name + '（点击返回列表）';
    // Cache for other UI elements (e.g. quickstart banner hint).
    window._currentProjectName = body.name;
    // Re-render profiles now that we have the name, so the banner hint
    // shows the actual project name instead of the ID.
    renderProfiles();
  }
}

// ── P2.5: GitHub auth widget ──
//
// When CDS runs with CDS_AUTH_MODE=github the backend exposes /api/me
// returning { user: {...}, session: {...} }. We probe it once at boot
// and reveal the header avatar + logout widget only on 200.
//
// In disabled/basic modes /api/me returns 401 and the widget stays
// hidden, matching the visual language of the pre-P2.5 Dashboard.
async function bootstrapAuthWidget() {
  const widget = document.getElementById('cdsAuthWidget');
  const avatarEl = document.getElementById('cdsAuthAvatar');
  const loginEl = document.getElementById('cdsAuthLogin');
  if (!widget || !avatarEl || !loginEl) return;

  let res;
  try {
    res = await fetch('/api/me', { credentials: 'include', cache: 'no-store' });
  } catch {
    return; // Network failure — treat as "not logged in", leave hidden.
  }
  if (!res.ok) return;

  let body;
  try {
    body = await res.json();
  } catch {
    return;
  }
  const user = body && body.user;
  if (!user || !user.githubLogin) return;

  loginEl.textContent = user.githubLogin;
  if (user.avatarUrl) {
    avatarEl.src = user.avatarUrl;
    avatarEl.alt = user.githubLogin;
    avatarEl.style.display = 'block';
  }
  widget.classList.remove('hidden');
  widget.style.display = 'inline-flex';
}

// Logout button handler — posts to /api/auth/logout, then redirects to
// the GitHub login page so the user can sign in again.
async function cdsLogout() {
  try {
    await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' });
  } catch { /* ignore — we redirect regardless */ }
  location.href = '/login-gh.html';
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
        // broadcastState() sends ALL branches across all projects. Scope to the
        // current project here so a dashboard opened on project B doesn't absorb
        // project A's branches. This mirrors the ?project= filter on GET /branches.
        const projectBranches = data.branches.filter(
          b => (b.projectId || 'default') === CURRENT_PROJECT_ID
        );
        // Merge commit info: state-stream has no git data, so preserve existing subject/commitSha
        // Only update status and service states from server push
        const branchMap = new Map(branches.map(b => [b.id, b]));
        for (const pushed of projectBranches) {
          const existing = branchMap.get(pushed.id);
          if (existing) {
            // Preserve git info, update status/services/executorId
            Object.assign(existing, pushed, {
              subject: existing.subject,
              commitSha: existing.commitSha,
            });
          } else {
            // 2026-04-19: 新分支通过 state-stream 首次到达(最常见情况:
            // GitHub webhook 创建 + dispatcher addBranch + save 触发
            // broadcastState)。标记为 fresh 让 renderBranches 添加
            // card-in 动画 class;5 秒后清掉,下次重绘就回到普通卡片。
            // 这比在后端单独推 branch.created 事件简单:state-stream
            // 已经是权威源,不引入第二条管道。
            if (_branchesFirstLoadDone) {
              freshlyArrived.add(pushed.id);
              setTimeout(() => { freshlyArrived.delete(pushed.id); }, 5000);
            }
            branches.push(pushed);
          }
        }
        // Remove branches that no longer exist in this project's scope
        const pushedIds = new Set(projectBranches.map(b => b.id));
        const removedIds = branches.filter(b => !pushedIds.has(b.id)).map(b => b.id);
        branches = branches.filter(b => pushedIds.has(b.id));
        for (const rid of removedIds) freshlyArrived.delete(rid);
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
      // In single-node mode data.capacity is null, but data.branches carries
      // ALL branches across ALL projects. Recompute global runningContainers
      // so the capacity badge stays accurate without waiting for the next
      // loadBranches() poll (5 s). maxContainers / totalMemGB are unchanged.
      if (!data.capacity && Array.isArray(data.branches)) {
        var globalRunning = 0;
        for (var _gb of data.branches) {
          if (_gb.services) {
            for (var _svc of Object.values(_gb.services)) {
              if (_svc.status === 'running' || _svc.status === 'building' || _svc.status === 'starting') {
                globalRunning++;
              }
            }
          }
        }
        containerCapacity = Object.assign({}, containerCapacity, { runningContainers: globalRunning });
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
    // PR_A 之后 preview-mode 改为 per-project；带上当前项目 id，
    // 后端没识别到时回退到 legacy state.previewMode（兼容老 CDS 实例）。
    await api('PUT', '/preview-mode', { mode: nextMode, projectId: CURRENT_PROJECT_ID || undefined });
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
  } catch (e) {
    // UF-14/18: suppress transient errors during polling AND during
    // post-action refreshes. The post-deploy loadBranches() call
    // commonly lands DURING the server restart window (SSE finishes
    // → server re-reads state → brief 400/502/503 window → back up).
    // Logging these as "errors" in the console is misleading — they
    // are expected and self-healing on the next poll.
    if (e && e.isTransient) {
      // expected during server restart / proxy hiccup — stay quiet,
      // even for non-silent callers. Schedule one retry so the UI
      // doesn't sit on stale data.
      if (!silent) {
        setTimeout(() => { loadBranches({ silent: true }).catch(() => {}); }, 1500);
      }
    } else {
      console.error('loadBranches:', e);
    }
  }
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
// UF-04: Enter submits the typed name as a new branch (useful when the
// user pastes a name that doesn't exist in git refs yet, e.g. a branch
// they're about to create). Only triggers when there's text AND the
// name isn't already a tracked local branch (to avoid accidental
// double-add when the user meant to pick from the dropdown).
searchInput.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  const raw = searchInput.value.trim();
  if (!raw) return;
  e.preventDefault();
  const slug = StateService_slugify(raw);
  const alreadyTracked = branches.find(b => b.id === slug || b.branch === raw);
  if (alreadyTracked) {
    // Name already exists — jump to the card instead of adding.
    scrollToAndHighlight(alreadyTracked.id);
    return;
  }
  addBranch(raw);
});
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

  // UF-04: "manual add" entry shown whenever the user typed something
  // that isn't an exact match of an already-tracked local branch. Lets
  // users paste a branch name and click/Enter to add it without relying
  // on the git-refs dropdown (which fails for brand-new branches that
  // haven't been pushed yet, or repos without remote listing).
  const rawTyped = searchInput.value.trim();
  const typedSlug = rawTyped ? StateService_slugify(rawTyped) : '';
  const typedAlreadyTracked = !!rawTyped &&
    branches.some(b => b.id === typedSlug || b.branch === rawTyped);
  const manualAddHtml = (rawTyped && !typedAlreadyTracked)
    ? `
      <div class="branch-dropdown-section-label">手动添加</div>
      <div class="branch-dropdown-item branch-dropdown-manual-add" onclick="addBranch(${JSON.stringify(rawTyped).replace(/"/g, '&quot;')})">
        <svg class="branch-dropdown-icon" width="16" height="16" viewBox="0 0 16 16" fill="currentColor" style="color: var(--accent)"><path d="M8 2a.75.75 0 01.75.75v4.5h4.5a.75.75 0 010 1.5h-4.5v4.5a.75.75 0 01-1.5 0v-4.5h-4.5a.75.75 0 010-1.5h4.5v-4.5A.75.75 0 018 2z"/></svg>
        <div class="branch-dropdown-item-info">
          <div class="branch-dropdown-item-row1">
            <span class="branch-dropdown-item-name">添加 "${esc(rawTyped)}" 为新分支</span>
            <span class="branch-dropdown-item-time">按 Enter</span>
          </div>
          <div class="branch-dropdown-item-row2">粘贴或输入任意分支名直接创建,无需出现在 git refs 列表中</div>
        </div>
      </div>`
    : '';

  if (matchedLocal.length === 0 && matchedRemote.length === 0) {
    if (q && _lastRemoteRefreshQuery !== q) {
      // Show "searching online" then auto-refresh remote branches,
      // but keep the manual-add escape hatch visible so the user can
      // still create the branch if the refresh comes back empty.
      dropdown.innerHTML =
        '<div class="branch-dropdown-empty"><span class="branch-search-spinner"></span>正在在线搜索…</div>' +
        manualAddHtml;
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
    dropdown.innerHTML =
      '<div class="branch-dropdown-empty">没有匹配的分支</div>' +
      manualAddHtml;
  } else {
    _lastRemoteRefreshQuery = ''; // Reset so future searches can trigger refresh
    let html = '';

    // ── Already added section ──
    if (matchedLocal.length > 0) {
      html += '<div class="branch-dropdown-section-label">已添加</div>';
      html += matchedLocal.map(b => {
        const isRunning = b.status === 'running';
        const statusText = statusLabel(b.status);
        // Same defensive filter as the main branch list render — drop
        // services whose profile isn't in the current project's list.
        const knownIds = new Set(buildProfiles.map(p => p.id));
        const services = Object.entries(b.services || {}).filter(([pid]) => knownIds.has(pid));
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

    // UF-04: always offer manual-add as the last option when the typed
    // text isn't already a tracked branch — even if the dropdown has
    // matches — so pasting "feature/new-thing" can still be added
    // directly without navigating the list.
    dropdown.innerHTML = html + manualAddHtml;
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
    // P4 Part 3b: stamp the new branch with the current project so it
    // shows up in scoped list queries.
    await api('POST', '/branches', { branch: name, projectId: CURRENT_PROJECT_ID });
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
  // 2026-04-22：合并胶囊的外层容器显示逻辑
  const combinedEl = document.getElementById('hostCombinedBadge');
  if (combinedEl) combinedEl.classList.remove('hidden');

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
            `<li>${escapeHtml(h.slug)}${h.pinned ? ' <svg width="10" height="10" viewBox="0 0 16 16" fill="#3fb950" style="vertical-align:-1px"><path d="M4.456.734a1.75 1.75 0 012.826.504l.613 1.327a3.081 3.081 0 002.084 1.707l2.454.584c1.332.317 1.8 1.972.832 2.94L11.06 9.695a.75.75 0 01-.19.436l-4.552 4.552a.75.75 0 01-1.06-1.06l4.305-4.305L7.307 7.13A4.581 4.581 0 005.03 4.929L4.416 3.6A.25.25 0 004.01 3.49L2.606 4.893a.25.25 0 00.104.407l1.328.613a4.581 4.581 0 012.204 2.277l.248.538a.75.75 0 01-1.36.628l-.248-.538a3.081 3.081 0 00-1.483-1.532L2.07 6.773C.783 6.19.381 4.602 1.3 3.682L2.703 2.28A1.75 1.75 0 014.456.734z"/></svg>' : ''}</li>`
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
        `<li>${escapeHtml(h.slug)}${h.pinned ? ' <svg width="10" height="10" viewBox="0 0 16 16" fill="#3fb950" style="vertical-align:-1px"><path d="M4.456.734a1.75 1.75 0 012.826.504l.613 1.327a3.081 3.081 0 002.084 1.707l2.454.584c1.332.317 1.8 1.972.832 2.94L11.06 9.695a.75.75 0 01-.19.436l-4.552 4.552a.75.75 0 01-1.06-1.06l4.305-4.305L7.307 7.13A4.581 4.581 0 005.03 4.929L4.416 3.6A.25.25 0 004.01 3.49L2.606 4.893a.25.25 0 00.104.407l1.328.613a4.581 4.581 0 012.204 2.277l.248.538a.75.75 0 01-1.36.628l-.248-.538a3.081 3.081 0 00-1.483-1.532L2.07 6.773C.783 6.19.381 4.602 1.3 3.682L2.703 2.28A1.75 1.75 0 014.456.734z"/></svg>' : ''}</li>`
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
      const headerEl = document.getElementById('hostPulseBadge');
      if (headerEl) headerEl.classList.add('hidden');
    }
  }
}

function renderHostStats(data) {
  const memPct = data.mem?.usedPercent ?? 0;
  const cpuPct = data.cpu?.loadPercent ?? 0;
  const memTier = tierForPercent(memPct);
  const cpuTier = tierForPercent(cpuPct);

  // 2026-04-22：原右下角浮窗已合并到 header 的 .host-pulse-badge。
  // .host-stats 元素还在 DOM 里（display:none 兜底），但不再更新。
  const headerEl = document.getElementById('hostPulseBadge');
  // 2026-04-22：合并胶囊的外层容器显示逻辑
  const combinedEl = document.getElementById('hostCombinedBadge');
  if (combinedEl) combinedEl.classList.remove('hidden');
  if (headerEl) {
    headerEl.classList.remove('hidden');
    // 2026-04-22 fix(Bugbot): 不要每 5 秒 innerHTML 重建 —— 6 个节点的 DOM churn + screen reader 重读。
    // 首次建结构，后续只更新动态字段（data-tier + textContent + title）。
    let memMetric = headerEl.querySelector('.host-pulse-metric[data-role="mem"]');
    let cpuMetric = headerEl.querySelector('.host-pulse-metric[data-role="cpu"]');
    if (!memMetric || !cpuMetric) {
      headerEl.innerHTML = `
        <span class="host-pulse-metric" data-role="mem">
          <span class="host-pulse-dot"></span>
          <span class="host-pulse-label">MEM</span>
          <span class="host-pulse-value"></span>
        </span>
        <span class="host-pulse-sep">·</span>
        <span class="host-pulse-metric" data-role="cpu">
          <span class="host-pulse-dot"></span>
          <span class="host-pulse-label">CPU</span>
          <span class="host-pulse-value"></span>
        </span>
      `;
      memMetric = headerEl.querySelector('.host-pulse-metric[data-role="mem"]');
      cpuMetric = headerEl.querySelector('.host-pulse-metric[data-role="cpu"]');
    }
    const memDot = memMetric.querySelector('.host-pulse-dot');
    const memVal = memMetric.querySelector('.host-pulse-value');
    const cpuDot = cpuMetric.querySelector('.host-pulse-dot');
    const cpuVal = cpuMetric.querySelector('.host-pulse-value');
    if (memDot.dataset.tier !== memTier) memDot.dataset.tier = memTier;
    if (cpuDot.dataset.tier !== cpuTier) cpuDot.dataset.tier = cpuTier;
    const memText = `${memPct}%`;
    const cpuText = `${cpuPct}%`;
    if (memVal.textContent !== memText) memVal.textContent = memText;
    if (cpuVal.textContent !== cpuText) cpuVal.textContent = cpuText;
    memMetric.title = `内存 ${memPct}%`;
    cpuMetric.title = `CPU 负载 ${cpuPct}%`;
    headerEl.dataset.stress = (memPct >= 90 || cpuPct >= 90) ? '1' : '0';
  }

  // Inline topbar pill (FS mode) — same data, different elements
  const fsEl = document.getElementById('topologyFsHostStats');
  if (fsEl) {
    fsEl.style.display = '';
    const tfhsMemFill = document.getElementById('tfhsMemFill');
    const tfhsMemValue = document.getElementById('tfhsMemValue');
    if (tfhsMemFill) { tfhsMemFill.style.width = `${Math.min(memPct, 100)}%`; tfhsMemFill.dataset.tier = memTier; }
    if (tfhsMemValue) tfhsMemValue.textContent = `${memPct}%`;
    const tfhsCpuFill = document.getElementById('tfhsCpuFill');
    const tfhsCpuValue = document.getElementById('tfhsCpuValue');
    if (tfhsCpuFill) { tfhsCpuFill.style.width = `${Math.min(cpuPct, 100)}%`; tfhsCpuFill.dataset.tier = cpuTier; }
    if (tfhsCpuValue) tfhsCpuValue.textContent = `${cpuPct}%`;
  }
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
      <div class="capacity-warning-icon"><svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg></div>
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
  _topologyRefreshIfVisible(id); // UF-16: immediate spinner in topology

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
    // Track the most recent `event:` line so we can route smoke-* events
    // (Phase 4 auto-smoke) into the log with a 🍳 prefix distinct from
    // deploy steps.
    let currentEvent = 'message';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split('\n');
      buffer = lines.pop();

      for (const line of lines) {
        if (line.startsWith('event: ')) {
          currentEvent = line.slice(7).trim();
          continue;
        }
        if (!line.startsWith('data: ')) {
          // Blank line = end of SSE block — reset event scope so the
          // next data: without a preceding event: defaults to message.
          if (line === '') currentEvent = 'message';
          continue;
        }
        const data = JSON.parse(line.slice(6));
        const log = inlineDeployLogs.get(id);
        if (!log) { currentEvent = 'message'; continue; }

        if (currentEvent === 'smoke-start') {
          log.lines.push(`🍳 自动冒烟测试启动 → ${data.host || ''}`);
        } else if (currentEvent === 'smoke-skip') {
          const reasons = {
            preview_host_missing: '未配置 previewDomain',
            access_key_missing: '_global.AI_ACCESS_KEY 未设置',
            smoke_script_missing: '找不到 smoke-all.sh',
          };
          log.lines.push(`🍳 跳过自动冒烟: ${reasons[data.reason] || data.reason}`);
        } else if (currentEvent === 'smoke-line') {
          log.lines.push(`  │ ${data.text}`);
        } else if (currentEvent === 'smoke-complete') {
          const ok = data.exitCode === 0 && data.failedCount === 0;
          log.lines.push(`🍳 冒烟 ${ok ? '✅' : '❌'} pass=${data.passedCount} fail=${data.failedCount} (${data.elapsedSec}s, exit=${data.exitCode})`);
        } else if (data.chunk) {
          data.chunk.split('\n').filter(l => l.trim()).forEach(l => log.lines.push(l));
        } else if (data.step) {
          log.lines.push(`[${data.status}] ${data.title || data.step}`);
        } else if (data.message) {
          data.message.split('\n').filter(l => l.trim()).forEach(l => log.lines.push(l));
        }
        updateInlineLog(id);
        currentEvent = 'message';
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
  _topologyRefreshIfVisible(id); // UF-16: banner flips back + log preview clears
}

function updateInlineLog(id) {
  const log = inlineDeployLogs.get(id);
  if (!log) return;
  const filtered = log.lines.filter(l => l.trim());

  // List view inline log
  const el = document.getElementById(`inline-log-${CSS.escape(id)}`);
  if (el) {
    const maxLines = log.expanded ? filtered.length : 20;
    const visibleLines = filtered.slice(-maxLines);
    el.textContent = visibleLines.join('\n');
    el.scrollTop = el.scrollHeight;
  }

  // UF-16: topology Details panel inline log preview. We keep this
  // shorter (last 8 lines) because the topology panel is narrower.
  // When the panel is open on this branch and actively deploying,
  // this is what the user sees scrolling in real time.
  const topoEl = document.getElementById(`tfp-deploy-log-${id}`);
  if (topoEl) {
    const body = topoEl.querySelector('.tfp-deploy-log-body');
    if (body) {
      body.textContent = filtered.slice(-8).join('\n') || '正在启动…';
    }
  }

  // UF-16: if the topology panel is showing THIS branch but the log
  // preview element doesn't exist yet (first chunk after click), poke
  // a re-render — but ONLY if the user is already on the details tab.
  // Do NOT force-switch when the user is on deployLogs/buildLogs etc.
  if (typeof _topologyPanelCurrentKind !== 'undefined'
      && _topologyPanelCurrentKind === 'app'
      && _topologySelectedBranchId === id
      && !topoEl) {
    var activeTabNow = document.querySelector('.topology-fs-panel-tab.active');
    if (activeTabNow && activeTabNow.dataset.tab === 'details') {
      if (typeof _topologySwitchPanelTab === 'function') {
        _topologySwitchPanelTab('details');
      }
    }
  }
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
  _topologyRefreshIfVisible(id); // UF-16: immediate spinner in topology
  try {
    await api('POST', `/branches/${id}/stop`);
    showToast('服务已停止', 'success');
  } catch (e) { showToast(e.message, 'error'); }
  busyBranches.delete(id);
  clearLoading(id, 'stop');
  await loadBranches();
  _topologyRefreshIfVisible(id); // UF-16: button returns to idle
}

// UF-16: helper called by deploy/stop/remove flows to refresh the
// sliding topology Details panel when it's showing a branch that's
// transitioning state. Without this, the button stays stuck in its
// previous state until the next poll (up to 5s of visual lag).
function _topologyRefreshIfVisible(branchId) {
  if (typeof _topologySwitchPanelTab !== 'function') return;
  if (typeof _topologyPanelCurrentKind === 'undefined') return;
  if (_topologyPanelCurrentKind !== 'app') return;
  // Refresh when: the currently-selected branch in topology matches
  // the branch that just changed state. For shared view (no branch
  // selected) we skip — nothing branch-scoped is showing anyway.
  if (_topologySelectedBranchId !== branchId) return;
  const activeTabEl = document.querySelector('.topology-fs-panel-tab.active');
  const activeTab = activeTabEl ? activeTabEl.dataset.tab : 'details';
  _topologySwitchPanelTab(activeTab);
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
    // 走后端返回的 v3 previewSlug（cds/src/services/preview-slug.ts 唯一公式）。
    // 后端没回 previewSlug 时回落到 entry.id，等价旧行为，不破坏任何既有流程。
    const branch = (branches || []).find(b => b.id === slug);
    const previewSlug = (branch && branch.previewSlug) || slug;
    const url = `${location.protocol}//${previewSlug}.${previewDomain}`;
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
  _topologyRefreshIfVisible(id); // UF-16: "删除中…" shows in topology too
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
    // UF-16: close the topology panel if it was showing this branch
    if (typeof _topologyClosePanel === 'function'
        && typeof _topologyPanelCurrentKind !== 'undefined'
        && _topologySelectedBranchId === id) {
      _topologyClosePanel();
    }
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
  // 1. Explicit user-chosen icon wins
  if (profile && profile.icon && ICON['port' + profile.icon.charAt(0).toUpperCase() + profile.icon.slice(1)]) {
    return ICON['port' + profile.icon.charAt(0).toUpperCase() + profile.icon.slice(1)];
  }
  // 2. Inferred from dockerImage / command / id (node / dotnet / …)
  const inferred = detectPortIconKey(profile || { id: profileId });
  if (inferred && ICON[inferred]) return ICON[inferred];
  // 3. Hardcoded profile-id map (api / admin / frontend)
  const key = PORT_ICON_MAP[(profileId || '').toLowerCase()];
  return key ? ICON[key] : ICON.portDefault;
}

// Scope-aware factory reset. On a per-project page (CURRENT_PROJECT_ID
// !== 'default'), default to resetting THIS project only. The user can
// still opt into the global reset by cancelling and running it from
// the project list page where no project context is active.
async function factoryReset() {
  var scoped = typeof CURRENT_PROJECT_ID !== 'undefined'
    && CURRENT_PROJECT_ID
    && CURRENT_PROJECT_ID !== 'default';
  var url = scoped
    ? `${API}/factory-reset?project=${encodeURIComponent(CURRENT_PROJECT_ID)}`
    : `${API}/factory-reset`;
  var msg = scoped
    ? `[警告] 重置当前项目\n\n将清除本项目的所有：分支、构建配置、基础设施服务、路由规则、项目级环境变量。\n全局环境变量和其他项目不受影响。\nDocker 数据卷（数据库文件等）会保留。\n\n确定继续？`
    : '[警告] 恢复出厂设置\n\n将清除所有项目的所有：分支、构建配置、环境变量、基础设施服务、路由规则。\nDocker 数据卷（数据库文件等）会保留。\n\n确定继续？';
  if (!confirm(msg)) return;
  if (!confirm('二次确认：所有配置将被清空，此操作不可撤销。')) return;
  globalBusy = true;
  renderBranches();
  try {
    const res = await fetch(url, { method: 'POST' });
    const reader = res.body.getReader();
    while (!(await reader.read()).done) {}
    showToast(scoped ? '已重置本项目' : '已恢复出厂设置', 'success');
  } catch (e) { showToast(e.message, 'error'); }
  globalBusy = false;
  await loadBranches();
}

async function cleanupAll() {
  // Same scope rule as factoryReset: on a project page, clean only
  // that project's non-default branches.
  var scoped = typeof CURRENT_PROJECT_ID !== 'undefined'
    && CURRENT_PROJECT_ID
    && CURRENT_PROJECT_ID !== 'default';
  var url = scoped
    ? `${API}/cleanup?project=${encodeURIComponent(CURRENT_PROJECT_ID)}`
    : `${API}/cleanup`;
  var prompt = scoped
    ? '确定清理本项目的所有非默认分支？'
    : '确定清理所有项目的所有非默认分支？';
  if (!confirm(prompt)) return;
  globalBusy = true;
  renderBranches();
  try {
    const res = await fetch(url, { method: 'POST' });
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
      <div class="capacity-warning-icon"><svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/></svg></div>
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
      <div class="capacity-warning-icon"><svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg></div>
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

// ── Phase 3 冒烟测试: 从分支卡触发 smoke-all.sh ──
//
// Flow:
//   1. 弹窗提示输入 AI_ACCESS_KEY (或从 _global.customEnv 读取 —— 后端
//      优先后者)
//   2. POST /api/branches/:id/smoke + SSE 流式接收 stdout/stderr
//   3. 每行 event:line 追加到模态框
//   4. event:complete 关闭流、更新头部"通过 X / 失败 Y"
//
// 不做的: 不存 AI_ACCESS_KEY 到 localStorage (安全); 不做自动重跑
// (失败就失败, 要重来点一次就行)。
async function runBranchSmoke(branchId) {
  // Prompt for AI access key (leave blank to use server-side _global.customEnv)
  const accessKey = window.prompt(
    '输入 AI_ACCESS_KEY\n\n留空 = 使用 CDS 环境变量 _global.AI_ACCESS_KEY\n(首次冒烟建议先在「环境变量」面板把它存到 _global)',
    ''
  );
  if (accessKey === null) return; // user cancelled

  const modalHtml = `
    <div class="smoke-modal-wrap" id="smokeModalWrap" style="display:flex;flex-direction:column;gap:10px;min-height:0;height:60vh">
      <div class="smoke-modal-header" style="display:flex;justify-content:space-between;align-items:center;flex-shrink:0">
        <div style="font-size:12px;color:var(--text-muted)">
          分支 <code>${esc(branchId)}</code> 冒烟测试
          <span id="smokeSummary" style="margin-left:12px;color:var(--text-secondary)">准备中…</span>
        </div>
        <button class="sm" id="smokeAbortBtn" onclick="_abortSmokeStream()" title="中止并关闭">关闭</button>
      </div>
      <pre id="smokeOutput" style="flex:1;min-height:0;overflow:auto;background:var(--bg-code-block,rgba(8,12,28,0.6));border:1px solid var(--border);border-radius:6px;padding:10px 14px;font-size:12px;font-family:var(--font-mono);color:var(--text-primary);white-space:pre-wrap;margin:0"></pre>
    </div>
  `;
  openConfigModal(`冒烟测试: ${branchId}`, modalHtml);

  const outEl = document.getElementById('smokeOutput');
  const sumEl = document.getElementById('smokeSummary');
  if (!outEl || !sumEl) return;
  const append = (txt, color) => {
    const span = document.createElement('span');
    if (color) span.style.color = color;
    span.textContent = txt + '\n';
    outEl.appendChild(span);
    outEl.scrollTop = outEl.scrollHeight;
  };

  // SSE over POST requires fetch + ReadableStream; built-in EventSource only does GET
  const controller = new AbortController();
  _smokeStreamController = controller;
  try {
    const res = await fetch(`/api/branches/${encodeURIComponent(branchId)}/smoke`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        accessKey: accessKey || undefined,
        impersonateUser: 'admin',
        failFast: false,
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      let errBody = ''; try { errBody = JSON.stringify(await res.json()); } catch {}
      append(`[HTTP ${res.status}] ${errBody}`, 'var(--red)');
      sumEl.textContent = '启动失败';
      return;
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      // SSE events are split by \n\n
      let idx;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const rawEvent = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const event = _parseSseEvent(rawEvent);
        if (!event) continue;
        if (event.event === 'start') {
          sumEl.textContent = `目标 ${event.data.host}`;
          append(`>>> smoke starting on ${event.data.host}`, 'var(--text-muted)');
        } else if (event.event === 'line') {
          const isErr = event.data.stream === 'stderr';
          append(event.data.text, isErr ? 'var(--red)' : undefined);
        } else if (event.event === 'complete') {
          const d = event.data;
          const ok = d.exitCode === 0 && d.failedCount === 0;
          sumEl.textContent = ok
            ? `✅ 通过 ${d.passedCount} 项 · ${d.elapsedSec}s`
            : `❌ 失败 ${d.failedCount} / 通过 ${d.passedCount} · 退出码 ${d.exitCode}`;
          sumEl.style.color = ok ? 'var(--green)' : 'var(--red)';
          append(`>>> smoke ${ok ? 'PASSED' : 'FAILED'} (exit=${d.exitCode}, ${d.elapsedSec}s)`, ok ? 'var(--green)' : 'var(--red)');
        } else if (event.event === 'error') {
          sumEl.textContent = `❌ ${event.data.message}`;
          sumEl.style.color = 'var(--red)';
          append(`[error] ${event.data.message}`, 'var(--red)');
        }
      }
    }
  } catch (err) {
    if (err.name === 'AbortError') {
      append('>>> 已中止 (用户关闭)', 'var(--text-muted)');
    } else {
      append(`[network] ${err.message}`, 'var(--red)');
    }
  } finally {
    _smokeStreamController = null;
  }
}

let _smokeStreamController = null;
function _abortSmokeStream() {
  if (_smokeStreamController) _smokeStreamController.abort();
  closeConfigModal();
}

function _parseSseEvent(raw) {
  // Parse a single SSE event block: "event: xxx\ndata: yyy"
  const lines = raw.split('\n');
  let ev = 'message';
  let data = '';
  for (const line of lines) {
    if (line.startsWith(':')) continue; // keepalive comment
    if (line.startsWith('event:')) ev = line.slice(6).trim();
    else if (line.startsWith('data:')) data += line.slice(5).trim();
  }
  if (!data) return null;
  try { return { event: ev, data: JSON.parse(data) }; }
  catch { return { event: ev, data: { raw: data } }; }
}

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
  // Lookup label for the cycling preview-mode switch so the current
  // choice is visible at a glance without opening a modal.
  const previewModeLabels = { simple: '简洁', port: '端口直连', multi: '子域名' };
  const previewModeLabel = previewModeLabels[previewMode] || previewMode || '简洁';
  // Show "初始化配置" quick action when no build profiles exist yet.
  const needsQuickstart = !buildProfiles || buildProfiles.length === 0;

  menu.innerHTML = `
    <!-- 2026-04-22：合并一键导入/导出入口 —— 导入弹窗底部本就有「导出配置」
         「导出技能」两个按钮，保留一个入口更干净。 -->
    <div class="settings-menu-item" onclick="closeSettingsMenu(); openImportModal()" style="color:#58a6ff">
      <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M8 2.004a.75.75 0 01.75.75v5.689l1.97-1.97a.749.749 0 111.06 1.06l-3.25 3.25a.749.749 0 01-1.06 0L4.22 7.533a.749.749 0 111.06-1.06l1.97 1.97V2.754a.75.75 0 01.75-.75zM2.75 12.5h10.5a.75.75 0 010 1.5H2.75a.75.75 0 010-1.5z"/></svg>
      一键导入 / 导出配置
    </div>
    ${needsQuickstart ? `
      <div class="settings-menu-item" onclick="closeSettingsMenu(); runQuickstart()" style="color:#3fb950">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M8 0a8 8 0 110 16A8 8 0 018 0zm3.78 5.22a.75.75 0 00-1.06 0L6.75 9.19 5.28 7.72a.751.751 0 00-1.042.018.751.751 0 00-.018 1.042l2 2a.75.75 0 001.06 0l4.5-4.5a.75.75 0 000-1.06z"/></svg>
        初始化配置（快速开始）
        <span style="margin-left:auto;font-size:11px;color:#3fb950">未就绪</span>
      </div>
    ` : ''}
    <div class="settings-menu-divider"></div>
    <div class="settings-menu-item" onclick="closeSettingsMenu(); openProfileModal()">
      <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M7.22 1.547a2.403 2.403 0 011.56 0l4.03 1.384a.48.48 0 01.33.457v1.224a.48.48 0 01-.33.457L8.78 6.453a2.403 2.403 0 01-1.56 0L3.19 5.069a.48.48 0 01-.33-.457V3.388a.48.48 0 01.33-.457l4.03-1.384zM3.19 6.903l4.03 1.384a2.403 2.403 0 001.56 0l4.03-1.384a.48.48 0 01.33.457v1.224a.48.48 0 01-.33.457L8.78 10.425a2.403 2.403 0 01-1.56 0L3.19 9.041a.48.48 0 01-.33-.457V7.36a.48.48 0 01.33-.457zm0 3.972l4.03 1.384a2.403 2.403 0 001.56 0l4.03-1.384a.48.48 0 01.33.457v1.224a.48.48 0 01-.33.457l-4.03 1.384a2.403 2.403 0 01-1.56 0l-4.03-1.384a.48.48 0 01-.33-.457v-1.224a.48.48 0 01.33-.457z"/></svg>
      构建配置
    </div>
    <div class="settings-menu-item" onclick="closeSettingsMenu(); openEnvModal()">
      <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M2.5 2a.5.5 0 00-.5.5v11a.5.5 0 00.5.5h11a.5.5 0 00.5-.5v-11a.5.5 0 00-.5-.5h-11zM1 2.5A1.5 1.5 0 012.5 1h11A1.5 1.5 0 0115 2.5v11a1.5 1.5 0 01-1.5 1.5h-11A1.5 1.5 0 011 13.5v-11zM4 5h2v1H4V5zm3 0h5v1H7V5zM4 8h2v1H4V8zm3 0h5v1H7V8zM4 11h2v1H4v-1zm3 0h5v1H7v-1z"/></svg>
      环境变量
    </div>
    <!-- 2026-04-22：批量编辑入口已从 ⚙ 菜单移除 —— 环境变量弹窗里本就有该入口
         (openEnvModal → 批量编辑 按钮)，避免两处入口混淆。 -->
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
    <div class="settings-menu-divider"></div>
    <div class="settings-menu-group-label">快捷 · CDS 全局开关</div>
    <div class="settings-menu-item settings-menu-switch" onclick="cyclePreviewMode()">
      <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M1.679 7.932c.412-.621 1.242-1.75 2.366-2.717C5.175 4.242 6.527 3.5 8 3.5c1.473 0 2.824.742 3.955 1.715 1.124.967 1.954 2.096 2.366 2.717a.119.119 0 010 .136c-.412.621-1.242 1.75-2.366 2.717C10.825 11.758 9.473 12.5 8 12.5c-1.473 0-2.824-.742-3.955-1.715C2.92 9.818 2.09 8.689 1.679 8.068a.119.119 0 010-.136zM8 2c-1.981 0-3.67.992-4.933 2.078C1.797 5.169.88 6.423.43 7.1a1.619 1.619 0 000 1.798c.45.678 1.367 1.932 2.637 3.024C4.329 13.008 6.019 14 8 14c1.981 0 3.67-.992 4.933-2.078 1.27-1.091 2.187-2.345 2.637-3.023a1.619 1.619 0 000-1.798c-.45-.678-1.367-1.932-2.637-3.024C11.671 2.992 9.981 2 8 2z"/><path d="M8 10a2 2 0 100-4 2 2 0 000 4z"/></svg>
      <span class="settings-menu-switch-label">预览模式</span>
      <span class="preview-mode-label" style="margin-left:auto;font-size:11px;color:#58a6ff;font-weight:500">${previewModeLabel}</span>
    </div>
    <div class="settings-menu-item settings-menu-switch" onclick="toggleMirror()">
      <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M13 2.5a.5.5 0 01.5.5v8a.5.5 0 01-.5.5h-2.086a1 1 0 00-.707.293l-1.5 1.5a.5.5 0 01-.707 0l-1.5-1.5A1 1 0 005.793 11.5H3.5a.5.5 0 01-.5-.5V3a.5.5 0 01.5-.5h9.5zM3.5 1A1.5 1.5 0 002 2.5v9A1.5 1.5 0 003.5 13h2.293l1.5 1.5a1.5 1.5 0 002.121 0l1.5-1.5h2.086A1.5 1.5 0 0014.5 11.5v-9A1.5 1.5 0 0013 1H3.5z"/></svg>
      <span class="settings-menu-switch-label">镜像加速</span>
      <span class="settings-switch settings-switch-mirror ${mirrorEnabled ? 'on' : ''}">
        <span class="settings-switch-track"><span class="settings-switch-thumb"></span></span>
      </span>
    </div>
    <div class="settings-menu-item settings-menu-switch" onclick="toggleTabTitle()">
      <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M0 4.75C0 3.784.784 3 1.75 3h12.5c.966 0 1.75.784 1.75 1.75v6.5A1.75 1.75 0 0114.25 13H1.75A1.75 1.75 0 010 11.25v-6.5zm1.75-.25a.25.25 0 00-.25.25v6.5c0 .138.112.25.25.25h12.5a.25.25 0 00.25-.25v-6.5a.25.25 0 00-.25-.25H1.75z"/></svg>
      <span class="settings-menu-switch-label">浏览器标签名</span>
      <span class="settings-switch settings-switch-tabtitle ${tabTitleEnabled ? 'on' : ''}">
        <span class="settings-switch-track"><span class="settings-switch-thumb"></span></span>
      </span>
    </div>
    <div class="settings-menu-item" onclick="closeSettingsMenu(); openSelfUpdate()">
      <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M8 2.5a5.487 5.487 0 00-4.131 1.869l1.204 1.204A.25.25 0 014.896 6H1.25A.25.25 0 011 5.75V2.104a.25.25 0 01.427-.177l1.38 1.38A7.002 7.002 0 0115 8a.75.75 0 01-1.5 0A5.5 5.5 0 008 2.5zM2.5 8a.75.75 0 00-1.5 0 7.002 7.002 0 0012.023 4.87l1.38 1.38a.25.25 0 00.427-.177V10.5a.25.25 0 00-.25-.25h-3.646a.25.25 0 00-.177.427l1.204 1.204A5.5 5.5 0 012.5 8z"/></svg>
      CDS 自动更新
    </div>
    <!-- 2026-04-22: 视图切换从 header segmented toggle 迁移到 ⚙ 菜单 -->
    <div class="settings-menu-item settings-menu-switch" onclick="closeSettingsMenu(); setViewMode(_viewMode === 'topology' ? 'list' : 'topology')">
      <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M5 2.75a2.25 2.25 0 114.5 0 2.25 2.25 0 01-4.5 0zM7.25 0a2.75 2.75 0 00-.75 5.397V7H2.75A1.75 1.75 0 001 8.75v1.603a2.75 2.75 0 101.5 0V8.75a.25.25 0 01.25-.25H6.5v1.397a2.75 2.75 0 101.5 0V8.5h3.75a.25.25 0 01.25.25v1.603a2.75 2.75 0 101.5 0V8.75A1.75 1.75 0 0011.75 7H8V5.397A2.75 2.75 0 007.25 0zM2.5 13a1.25 1.25 0 112.5 0 1.25 1.25 0 01-2.5 0zM8.5 13a1.25 1.25 0 112.5 0 1.25 1.25 0 01-2.5 0zm4.75-1.25a1.25 1.25 0 100 2.5 1.25 1.25 0 000-2.5z"/></svg>
      <span class="settings-menu-switch-label">视图模式</span>
      <span style="margin-left:auto;font-size:11px;color:var(--text-muted);font-weight:500">${_viewMode === 'topology' ? '拓扑' : '列表'}</span>
    </div>
    <div class="settings-menu-divider"></div>
    <div class="settings-menu-item danger" onclick="closeSettingsMenu(); openCleanupModal()">
      <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M6.5 1.75a.25.25 0 01.25-.25h2.5a.25.25 0 01.25.25V3h-3V1.75zM11 3V1.75A1.75 1.75 0 009.25 0h-2.5A1.75 1.75 0 005 1.75V3H2.75a.75.75 0 000 1.5h.3l.8 8.2A1.75 1.75 0 005.6 14.5h4.8a1.75 1.75 0 001.75-1.8l.8-8.2h.3a.75.75 0 000-1.5H11z"/></svg>
      清理分支
    </div>
    <div class="settings-menu-divider"></div>
    <div class="settings-menu-item" onclick="closeSettingsMenu(); location.href='/project-list'">
      <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M7.429 1.525a3.5 3.5 0 011.142 0 .75.75 0 01.57.63l.185 1.29a.25.25 0 00.35.193l1.178-.592a.75.75 0 01.808.098 3.5 3.5 0 01.571.571.75.75 0 01.098.808l-.592 1.178a.25.25 0 00.193.35l1.29.185a.75.75 0 01.63.57 3.5 3.5 0 010 1.142.75.75 0 01-.63.57l-1.29.185a.25.25 0 00-.193.35l.592 1.178a.75.75 0 01-.098.808 3.5 3.5 0 01-.571.571.75.75 0 01-.808.098l-1.178-.592a.25.25 0 00-.35.193l-.185 1.29a.75.75 0 01-.57.63 3.5 3.5 0 01-1.142 0 .75.75 0 01-.57-.63l-.185-1.29a.25.25 0 00-.35-.193l-1.178.592a.75.75 0 01-.808-.098 3.5 3.5 0 01-.571-.571.75.75 0 01-.098-.808l.592-1.178a.25.25 0 00-.193-.35l-1.29-.185a.75.75 0 01-.63-.57 3.5 3.5 0 010-1.142.75.75 0 01.63-.57l1.29-.185a.25.25 0 00.193-.35l-.592-1.178a.75.75 0 01.098-.808 3.5 3.5 0 01.571-.571.75.75 0 01.808-.098l1.178.592a.25.25 0 00.35-.193l.185-1.29a.75.75 0 01.57-.63zM8 6a2 2 0 100 4 2 2 0 000-4z"/></svg>
      全局设置 → 项目列表
      <span style="margin-left:auto;font-size:11px;color:#8b949e">↗</span>
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
        <span style="display:flex;align-items:center;justify-content:center;width:28px;height:28px;color:var(--text-muted)"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/></svg></span>
        <div>
          <div style="font-weight:600;font-size:14px">清理非列表分支</div>
          <div style="font-size:12px;color:var(--text-muted);margin-top:2px">删除本地 git 中不在 CDS 部署列表上的分支</div>
        </div>
      </button>
      <button class="btn-export-option btn-danger-option" onclick="closeConfigModal(); cleanupOrphans()">
        <span style="display:flex;align-items:center;justify-content:center;width:28px;height:28px;color:var(--text-muted)"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg></span>
        <div>
          <div style="font-weight:600;font-size:14px">清理孤儿分支</div>
          <div style="font-size:12px;color:var(--text-muted);margin-top:2px">清理本地存在但远程已删除的分支</div>
        </div>
      </button>
      <button class="btn-export-option btn-danger-option" onclick="closeConfigModal(); cleanupAll()">
        <span style="display:flex;align-items:center;justify-content:center;width:28px;height:28px;color:var(--text-muted)"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4h6v2"/></svg></span>
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
  // P4 Part 8 (MECE A5): differentiate between two empty states:
  //
  //   1. Fresh project with NO services yet → user needs to add services
  //      before branches make sense. Show 3-step setup guide.
  //   2. Project has services but no branches → user just needs to
  //      pick a branch from git. Show the original branch-search CTA.
  //
  // The first case is the painful "I created a new project and nothing
  // explains what to do" situation that P4 Part 2 unintentionally
  // created when + New Project lands users in an empty Dashboard.
  const onFocusSearch = "document.getElementById('branchSearch')?.focus()";
  const noServices = (buildProfiles || []).length === 0 && (infraServices || []).length === 0;

  if (noServices) {
    // P4 Part 15 (MECE A5 redo): match Railway's pattern more closely.
    //
    // Previously this returned a 3-step CTA. Railway actually doesn't
    // do that — when you create a new project it auto-pops the same
    // "What would you like to create?" dropdown that the + Add button
    // shows. We mirror that pattern here:
    //   1. Show a tiny welcome card with one big primary CTA
    //   2. The CTA enters topology mode
    //   3. _ensureTopologyFsChrome's setViewMode handler detects
    //      the empty-project state and auto-opens the + Add menu
    //
    // The user lands directly on a familiar dropdown that's the
    // SAME UI used elsewhere — no special "first run" flow.
    return `
      <div class="branches-empty">
        <div class="branches-empty-illustration" aria-hidden="true">
          <svg width="84" height="84" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">
            <rect x="3" y="3" width="7" height="7" rx="1.5"/>
            <rect x="14" y="3" width="7" height="7" rx="1.5"/>
            <rect x="3" y="14" width="7" height="7" rx="1.5"/>
            <rect x="14" y="14" width="7" height="7" rx="1.5"/>
          </svg>
        </div>
        <div class="branches-empty-title">这是一个全新项目</div>
        <div class="branches-empty-hint">
          点击下面进入拓扑画布，CDS 会自动弹出"添加服务"菜单 — 选 GitHub 仓库 / 数据库 / 空服务任意一种就能开始
        </div>
        <div class="branches-empty-actions">
          <button class="branches-empty-cta primary" onclick="setViewMode('topology')" title="进入拓扑画布并自动弹出 Add 菜单">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M7.75 2a.75.75 0 01.75.75V7h4.25a.75.75 0 010 1.5H8.5v4.25a.75.75 0 01-1.5 0V8.5H2.75a.75.75 0 010-1.5H7V2.75A.75.75 0 017.75 2z"/></svg>
            添加第一个服务
          </button>
        </div>
      </div>
    `;
  }

  // Has services but no branches yet — original CTA, slightly polished.
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
      <button class="branches-empty-cta primary" onclick="${onFocusSearch}">
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
            <div class="cds-loading-aura"></div>
            <div class="cds-loading-core">
              <div class="cds-loading-ring"></div>
              <div class="cds-loading-axis"></div>
              <div class="cds-loading-wordmark">
                <span class="cds-letter" style="--delay:0ms">C</span>
                <span class="cds-letter" style="--delay:120ms">D</span>
                <span class="cds-letter" style="--delay:240ms">S</span>
              </div>
            </div>
            <div class="cds-loading-rail"><span></span></div>
            <div class="cds-loading-hint">正在同步分支视图</div>
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

  // 2026-04-22 分支排序规则（用户反馈）：
  //   1) 收藏（isFavorite）优先，作为独立序列置顶
  //   2) 两个序列内部都按"最近使用"倒序（lastAccessedAt 降序，缺失则 createdAt）
  // 默认分支（defaultBranch）单独 pin 到整组最前 —— 用户打开 CDS 第一个看到
  // 的永远是 production 环境分支，不会被其他最近部署的分支淹没。
  const _sortKey = (b) => {
    const t = b.lastAccessedAt || b.createdAt || 0;
    return typeof t === 'string' ? new Date(t).getTime() : t;
  };
  const sortedBranches = [...filteredBranches].sort((a, b) => {
    // 默认分支永远最前
    const aDef = a.id === defaultBranch ? 0 : 1;
    const bDef = b.id === defaultBranch ? 0 : 1;
    if (aDef !== bDef) return aDef - bDef;
    // 收藏序列优先
    const aFav = a.isFavorite ? 0 : 1;
    const bFav = b.isFavorite ? 0 : 1;
    if (aFav !== bFav) return aFav - bFav;
    // 同序列内按时间倒序（新的靠前）
    return _sortKey(b) - _sortKey(a);
  });

  el.innerHTML = sortedBranches.map(b => {
    const isBusy = busyBranches.has(b.id) || globalBusy;
    const isDefault = b.id === defaultBranch;
    // Defensive filter against orphan/cross-project service entries.
    // `buildProfiles` is fetched with ?project=<current>, so any service
    // whose profile isn't in that list is either deleted or belongs to
    // another project (historical pollution). Skipping such entries
    // here prevents ghost chips with wrong ports/icons even if the
    // state.json still carries leftovers. The server-side
    // `/cleanup-cross-project-services` endpoint handles the state
    // cleanup; this is the UI safety net.
    const knownProfileIds = new Set(buildProfiles.map(p => p.id));
    const services = Object.entries(b.services || {})
      .filter(([pid]) => knownProfileIds.has(pid));
    const hasError = b.status === 'error';
    const isRunning = b.status === 'running';
    const isStopping = b.status === 'stopping';
    const isStopped = !isRunning && !isStopping && services.length > 0 && !hasError && b.status !== 'building';
    const hasMultipleProfiles = buildProfiles.length > 1;
    const hasUpdates = !!branchUpdates[b.id];

    // Loading state helpers for this branch
    const btnDisabled = (action) => (isBusy || isLoading(b.id, action)) ? 'disabled' : '';
    const btnLabel = (action, label) => isLoading(b.id, action) ? `<span class="btn-spinner"></span>${label}` : label;

    // 2026-04-22 —— 二级菜单结构：
    //   一级：按服务分组（每个 profile 一个 hover 触发的子菜单条目）+ 分支级动作
    //   二级：每个服务的 deployModes（快/慢/用户自定义）+ 🧹 清理 + 🔍 核验
    //
    // 若 profile.deployModes 为空（用户没配任何模式），fallback 到"默认部署"单项，
    // 同时底部提示用户可在 ⚙ 构建命令面板自定义。这样比以前扁平的"选择服务 + 部署模式"
    // 平行两组清爽得多：一级每服务一行，鼠标 hover 出二级，单击直接下发命令。
    function buildProfileSubmenu(p) {
      const modes = p.deployModes && Object.keys(p.deployModes).length > 0
        ? Object.entries(p.deployModes).map(([modeId, mode]) => ({
            modeId,
            label: mode.label || modeId,
            active: p.activeDeployMode === modeId,
          }))
        : null;
      const modeRows = modes
        ? modes.map(m => `
            <div class="deploy-submenu-item" onclick="event.stopPropagation(); closeDeployMenu('${esc(b.id)}'); switchModeAndDeploy('${esc(b.id)}', '${esc(p.id)}', '${esc(m.modeId)}')">
              <span style="display:inline-block;width:14px">${m.active ? '✓' : ''}</span>${esc(m.label)}
            </div>`).join('')
        : `<div class="deploy-submenu-item" onclick="event.stopPropagation(); closeDeployMenu('${esc(b.id)}'); deploySingleService('${esc(b.id)}', '${esc(p.id)}')">
             <span style="display:inline-block;width:14px">▶</span>部署 (使用当前命令)
           </div>`;
      return `
        <div class="deploy-menu-item deploy-submenu-anchor">
          <span>${esc(p.name)}</span>
          <span style="margin-left:auto;color:var(--text-muted)">▸</span>
          <div class="deploy-submenu">
            <div class="deploy-submenu-header">${esc(p.name)} — 部署命令</div>
            ${modeRows}
            <div class="deploy-submenu-divider"></div>
            <div class="deploy-submenu-item" onclick="event.stopPropagation(); closeDeployMenu('${esc(b.id)}'); _askBranchAndRunForBranch('${esc(b.id)}', '${esc(p.id)}', 'rebuild')" title="停容器 + 物理删 bin/obj + 等待重新部署（破 MSBuild 撒谎用）">
              <span style="display:inline-block;width:14px">🧹</span>清理 bin/obj 并重建
            </div>
            <div class="deploy-submenu-item" onclick="event.stopPropagation(); closeDeployMenu('${esc(b.id)}'); _askBranchAndRunForBranch('${esc(b.id)}', '${esc(p.id)}', 'verify')" title="比对源码/DLL/进程启动时间诊断是否跑老字节码">
              <span style="display:inline-block;width:14px">🔍</span>核验字节码
            </div>
            <div class="deploy-submenu-divider"></div>
            <div class="deploy-submenu-item" onclick="event.stopPropagation(); closeDeployMenu('${esc(b.id)}'); openBuildCommandPanel('${esc(p.id)}')" title="编辑这个服务的所有命令模式（热/冷/自定义）">
              <span style="display:inline-block;width:14px">⚙</span>编辑命令…
            </div>
          </div>
        </div>`;
    }
    const deployMenuItems = buildProfiles.map(buildProfileSubmenu).join('');

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
          <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor" style="vertical-align:-1px;margin-right:3px"><path d="M9.504.43a1.516 1.516 0 012.437 1.713L10.415 5.5h2.123a1.5 1.5 0 011.116 2.511l-6.5 7.5a1.5 1.5 0 01-2.37-1.836L6.311 10.5H4.187a1.5 1.5 0 01-1.116-2.511l6.5-7.5-.067.441z"/></svg>${esc(b.executorId.replace(/^executor-/, '').slice(0, 24))}
        </span>`
      : '';

    // Port badges — language icon + port number only. Profile name
    // moves into the tooltip so the chip stays compact and the icon
    // does the identifying (node → Node.js, dotnet → .NET, react →
    // React/Vite, etc.). See getPortIcon() → detectPortIconKey() for
    // the inference order. User feedback #450 part 5 "要托管软件的
    // icon,例如node程序就显示node的icon,而非随意的两个icon,并且不
    // 用显示名字"
    const portBadgesInner = services.length > 0 ? services.map(([pid, svc]) => {
      const profile = buildProfiles.find(p => p.id === pid);
      const icon = getPortIcon(pid, profile);
      const badgeClass = svc.status === 'running' ? 'run-port' : svc.status === 'starting' ? 'port-starting' : svc.status === 'stopping' ? 'port-stopping' : svc.status === 'building' ? 'port-building' : svc.status === 'error' ? 'port-error' : 'port-idle';
      const displayName = (profile && profile.name) || pid;
      const portTitle = `${esc(displayName)} (${esc(pid)}): ${statusLabel(svc.status)}${b.lastAccessedAt ? '\n运行时间: ' + relativeTime(b.lastAccessedAt) : ''}`;
      return `<span class="port-badge ${badgeClass}"
                    onclick="event.stopPropagation(); viewContainerLogs('${esc(b.id)}', '${esc(pid)}')"
                    title="${portTitle}">
                ${icon}${svc.hostPort}
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
        <div class="deploy-menu-header">服务</div>${deployMenuItems}
        ${targetMenuItems}
        ${isRunning ? `<div class="deploy-menu-divider"></div>
        <div class="deploy-menu-item" onclick="event.stopPropagation(); closeDeployMenu('${esc(b.id)}'); viewBranchLogs('${esc(b.id)}')"><svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" style="vertical-align:-1px;margin-right:4px"><path d="M1 2.75C1 1.784 1.784 1 2.75 1h10.5c.966 0 1.75.784 1.75 1.75v7.5A1.75 1.75 0 0113.25 12H9.06l-2.573 2.573A1.458 1.458 0 014 13.543V12H2.75A1.75 1.75 0 011 10.25v-7.5zm1.5 0a.25.25 0 01.25-.25h10.5a.25.25 0 01.25.25v7.5a.25.25 0 01-.25.25h-4.5a.75.75 0 00-.75.75v2.19l-2.72-2.72a.75.75 0 00-.53-.22H2.75a.25.25 0 01-.25-.25v-7.5z"/></svg>部署日志</div>
        <div class="deploy-menu-item" onclick="event.stopPropagation(); closeDeployMenu('${esc(b.id)}'); runBranchSmoke('${esc(b.id)}')" title="运行 scripts/smoke-all.sh 针对本分支预览域名"><svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" style="vertical-align:-1px;margin-right:4px"><path d="M8 16A3.5 3.5 0 004.5 12.5c0-1.81 1.63-3.04 1.63-3.04C5.48 10.89 6.5 12 8 12c1.5 0 2.52-1.11 1.87-2.54 0 0 1.63 1.23 1.63 3.04A3.5 3.5 0 018 16zM11 1s-1.5 1.5-2 3.5C6 3 4.5 5 4.5 7.5c0 1 .5 2 1 2.5C4 9 2.5 7 2.5 5 2.5 2 5.5 0 8 0c1.8 0 3 1 3 1z"/></svg>冒烟测试</div>
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
    // P4 Part 15: clear the per-branch deploy start timestamp when
    // we leave the deploying state so the next deploy starts fresh.
    if (!isDeploying && _deployStartedAt.has(b.id)) {
      _clearBranchDeployStartedAt(b.id);
    }

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
      <div class="branch-card status-${b.status || 'idle'} ${isDefault ? 'active' : ''} ${isBusy ? 'is-busy' : ''} ${hasError ? 'has-error' : ''} expanded ${b.isFavorite ? 'is-favorite' : ''} ${hasUpdates ? 'has-updates' : ''} ${recentlyTouched.has(b.id) ? 'recently-touched' : ''} ${isDeploying ? 'is-deploying' : ''} ${b.isColorMarked ? 'is-color-marked' : ''} ${getAiOccupant(b.id) ? 'is-ai-occupied' : ''} ${b.pinnedCommit ? 'is-pinned' : ''} ${freshlyArrived.has(b.id) ? 'fresh-arrival' : ''} ${freshlyArrived.has(b.id) && b.githubRepoFullName ? 'fresh-gh' : ''}" data-branch-id="${esc(b.id)}">
        ${isDeploying ? `<div class="deploy-progress-bar"><div class="deploy-progress-bar-fill"></div></div>
          <div class="branch-deploy-timer" data-since="${_branchDeployStartedAt(b.id)}"><span class="branch-deploy-timer-label">${b.status === 'building' ? 'Building' : 'Initializing'}</span><span class="branch-deploy-timer-value">00:00</span></div>` : ''}
        <div class="branch-card-toolbar">
          <button class="branch-quick-btn" onclick="event.stopPropagation(); copyBranchName('${esc(b.branch)}')" title="复制分支名">
            <svg class="inline-icon" width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M0 6.75C0 5.784.784 5 1.75 5h1.5a.75.75 0 010 1.5h-1.5a.25.25 0 00-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 00.25-.25v-1.5a.75.75 0 011.5 0v1.5A1.75 1.75 0 019.25 16h-7.5A1.75 1.75 0 010 14.25v-7.5z"/><path d="M5 1.75C5 .784 5.784 0 6.75 0h7.5C15.216 0 16 .784 16 1.75v7.5A1.75 1.75 0 0114.25 11h-7.5A1.75 1.75 0 015 9.25v-7.5zm1.75-.25a.25.25 0 00-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 00.25-.25v-7.5a.25.25 0 00-.25-.25h-7.5z"/></svg>
          </button>
          <button class="branch-quick-btn" onclick="event.stopPropagation(); previewBranch('${esc(b.id)}')" title="打开预览">
            <svg class="inline-icon" width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M3.75 2h3.5a.75.75 0 010 1.5h-3.5a.25.25 0 00-.25.25v8.5c0 .138.112.25.25.25h8.5a.25.25 0 00.25-.25v-3.5a.75.75 0 011.5 0v3.5A1.75 1.75 0 0112.25 14h-8.5A1.75 1.75 0 012 12.25v-8.5C2 2.784 2.784 2 3.75 2zm6.854-.22a.75.75 0 01.22.53v2.5a.75.75 0 01-1.5 0V3.56L6.22 6.72a.75.75 0 01-1.06-1.06l3.1-3.1H6.81a.75.75 0 010-1.5h3.5a.75.75 0 01.293.06z"/></svg>
          </button>
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
          <span class="fav-toggle ${b.isFavorite ? 'active' : ''}" onclick="event.stopPropagation(); toggleFavorite('${esc(b.id)}')" title="${b.isFavorite ? '取消收藏' : '收藏'}">
            ${b.isFavorite ? ICON.star : ICON.starOutline}
          </span>
        </div>
        <div class="branch-card-header">
          <div class="branch-card-row1">
            <span class="status-dot status-dot-${b.status || 'idle'}" title="${statusLabel(b.status || 'idle')}"></span>
            <a class="branch-name" href="${githubRepoUrl ? githubRepoUrl.replace('github.com', 'github.dev') + '/tree/' + encodeURIComponent(b.branch) : '#'}" target="_blank" onclick="event.stopPropagation(); return confirmOpenGithub(event)" title="${b.githubRepoFullName ? 'GitHub 自动触发的分支 (来自 ' + esc(b.githubRepoFullName) + ') · 点击在 GitHub.dev 浏览代码' : '在 GitHub.dev 中浏览代码'}">${b.githubRepoFullName ? ICON.githubMark : ICON.branch} ${esc(b.branch)}</a>
          </div>
          ${(() => {
            // Unified chip row — combines port badges + pinned-commit badge +
            // last-updated timestamp into ONE wrappable flex row. Keeps the
            // card compact and visually consistent between branches that
            // have/don't have a GitHub source.
            //
            // 2026-04-19 user feedback: 原 GitHub commit SHA 胶囊 (蓝色
            // `658aa87` 之类)已删 —— 标题前的 GitHub icon 已经说明"这是
            // 从 GitHub 来的",commit hash 对运维体验没增加信息,反而挤占
            // chips row 宝贵的视觉空间。需要具体 SHA 可以在分支详情页或
            // PR Checks 面板里看。
            const pinChip = b.pinnedCommit
              ? `<span class="pinned-commit-badge" onclick="event.stopPropagation(); checkoutCommit('${esc(b.id)}', '', true, '')" title="已固定到历史提交 ${esc(b.pinnedCommit)}，点击恢复最新"><svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor" style="vertical-align:-1px"><path d="M4.456.734a1.75 1.75 0 012.826.504l.613 1.327a3.081 3.081 0 002.084 1.707l2.454.584c1.332.317 1.8 1.972.832 2.94L11.06 9.695a.75.75 0 01-.19.436l-4.552 4.552a.75.75 0 01-1.06-1.06l4.305-4.305L7.307 7.13A4.581 4.581 0 005.03 4.929L4.416 3.6A.25.25 0 004.01 3.49L2.606 4.893a.25.25 0 00.104.407l1.328.613a4.581 4.581 0 012.204 2.277l.248.538a.75.75 0 01-1.36.628l-.248-.538a3.081 3.081 0 00-1.483-1.532L2.07 6.773C.783 6.19.381 4.602 1.3 3.682L2.703 2.28A1.75 1.75 0 014.456.734z"/></svg> ${esc(b.pinnedCommit)}</span>`
              : '';
            // 2026-04-19 用户反馈: 卡片需要"最近更新时间"。找合适位置,
            // 左下角/右下角都被按钮占了,右上角和 toolbar 按钮挨着,
            // 最干净的办法是放在 chips row 的最右端(margin-left:auto
            // 自动推到右): 和 SHA/port 胶囊同一行、同样样式级别、
            // 无需额外占用垂直空间。
            // 优先显示 lastAccessedAt(最近一次部署时间,信号最强),
            // 没有则 fallback 到 createdAt。`<1 分钟` 时显示"刚刚"。
            const __lastSeen = b.lastAccessedAt || b.createdAt;
            const updatedChip = __lastSeen
              ? `<span class="branch-updated-at" title="${b.lastAccessedAt ? '最近部署' : '创建'}于 ${esc(new Date(__lastSeen).toLocaleString())}"><svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" style="vertical-align:-1px;margin-right:3px;opacity:0.7"><path d="M8 0a8 8 0 100 16A8 8 0 008 0zM1.5 8a6.5 6.5 0 1113 0 6.5 6.5 0 01-13 0zM8 3.75a.75.75 0 01.75.75v3.25h2.25a.75.75 0 010 1.5h-3a.75.75 0 01-.75-.75v-4a.75.75 0 01.75-.75z"/></svg>${esc(relativeTime(__lastSeen))}${b.lastAccessedAt ? '' : ' 创建'}</span>`
              : '';
            const hasAnyChip = pinChip || portBadgesHtml || updatedChip;
            return hasAnyChip
              ? `<div class="branch-card-chips">${portBadgesHtml || ''}${pinChip}${updatedChip}</div>`
              : '';
          })()}
        </div>
        ${b.errorMessage && !deployLog ? (() => {
          // P4 Part 8 (MECE R4): rich inline failure preview.
          //
          // Old behavior was a one-liner that hid the actual error
          // behind a tooltip. Novice users had to discover the logs
          // button to figure out what broke. New behavior:
          //   - Red-tinted card with ⚠ icon
          //   - Multi-line errorMessage rendered in <pre> (max 6 lines)
          //   - "查看完整日志" button right inline → opens log modal
          //   - "重置" button → clears the error so the user can retry
          //
          // The same b.errorMessage data is used; no new API needed.
          const lines = String(b.errorMessage).split(/\r?\n/).map(l => l.trim()).filter(Boolean);
          const visible = lines.slice(-6);
          const more = lines.length - visible.length;
          return `<div class="branch-error-card">
            <div class="branch-error-head">
              <svg class="branch-error-icon" width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M8.982 1.566a1.13 1.13 0 00-1.96 0L.165 13.233c-.457.778.091 1.767.98 1.767h13.713c.889 0 1.438-.99.98-1.767L8.982 1.566zM8 5c.535 0 .954.462.9.995l-.35 3.507a.552.552 0 01-1.1 0L7.1 5.995A.905.905 0 018 5zm.002 6a1 1 0 110 2 1 1 0 010-2z"/></svg>
              <span class="branch-error-title">部署失败</span>
              <button class="branch-error-btn" onclick="event.stopPropagation(); openLogModal('${esc(b.id)}')" title="查看完整日志">
                <svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor"><path d="M1 2.75C1 1.784 1.784 1 2.75 1h10.5c.966 0 1.75.784 1.75 1.75v7.5A1.75 1.75 0 0113.25 12H9.06l-2.573 2.573A1.458 1.458 0 014 13.543V12H2.75A1.75 1.75 0 011 10.25v-7.5z"/></svg>
                查看日志
              </button>
              <button class="branch-error-btn" onclick="event.stopPropagation(); resetBranch('${esc(b.id)}')" title="重置错误状态">
                <svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor"><path d="M8 2.5a5.487 5.487 0 00-4.131 1.869l1.204 1.204A.25.25 0 014.896 6H1.25A.25.25 0 011 5.75V2.104a.25.25 0 01.427-.177l1.38 1.38A7.002 7.002 0 0115 8a.75.75 0 01-1.5 0A5.5 5.5 0 008 2.5z"/></svg>
                重置
              </button>
            </div>
            <pre class="branch-error-body">${visible.map(l => esc(l)).join('\n')}${more > 0 ? `\n… 还有 ${more} 行 …` : ''}</pre>
          </div>`;
        })() : ''}
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

  // Topology view shares the same data sources — re-render it on every branch refresh.
  if (_viewMode === 'topology') renderTopologyView();
}

// ── Build profiles (data only) ──

function renderProfiles() {
  // Profiles are now rendered inside modal, this just controls the quickstart banner
  const banner = document.getElementById('quickstartBanner');
  if (buildProfiles.length === 0) {
    // Dynamically update the hint text to show the actual project name
    const hint = document.getElementById('quickstartBannerHint');
    if (hint) {
        const projName = window._currentProjectName || CURRENT_PROJECT_ID || '当前项目';
      hint.innerHTML = `优先读取 <strong>${esc(projName)}</strong> 项目仓库下的 <code>cds-compose.yaml</code>；否则使用内置 api/admin 模板`;
    }
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
    // Carry the project context explicitly. The api() helper only
    // injects ?project= on GETs, so POST /quickstart needs the body
    // to scope the seeded build profiles to the current project.
    const data = await api('POST', '/quickstart', { projectId: CURRENT_PROJECT_ID });
    showToast(data.message, 'success');
    await loadProfiles();
    // When compose file was found and some vars still have TODO placeholders,
    // automatically open the env editor so the user can fill them in before
    // starting branches.
    if (data.source === 'cds-compose' && data.pendingEnvVars && data.pendingEnvVars.length > 0) {
      await loadEnvVars(CURRENT_PROJECT_ID);
      envScope = CURRENT_PROJECT_ID;
      showToast(`已导入配置，请填写 ${data.pendingEnvVars.length} 个待填写的环境变量`, 'info');
      openEnvModal();
    }
  } catch (e) { showToast(e.message, 'error'); }
}

// ── Environment variables (data only) ──

// Which bucket the env modal is currently editing.
// '_global' — baseline shared by every project (pre-feature behaviour)
// '<projectId>' — project-scoped overrides injected at deploy time
// Defaults to global so the menu-bar shortcut opens in back-compat mode.
let envScope = '_global';

async function loadEnvVars(scope) {
  const s = scope || envScope || '_global';
  try {
    // Skip isProjectScopedPath() by passing explicit scope query; the
    // /env endpoint has its own scope parameter so we don't want the
    // auto-injected ?project= that applies to branch/profile/infra.
    const res = await fetch(API + '/env?scope=' + encodeURIComponent(s));
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    customEnvVars = data.env || {};
    envScope = s;
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
    ? (envScope === '_global'
        ? '<div class="config-empty">暂无自定义环境变量。默认使用自动检测的主机变量 (MONGODB_HOST 等)。</div>'
        : '<div class="config-empty">本项目还没有独立的环境变量。父级全局变量仍然生效；在此添加的变量会覆盖全局值，且不会泄漏到其他项目。</div>')
    : entries.map(([k, v]) => envItemHtml(k, v)).join('');

  // Scope selector: 全局 vs. 当前项目. Switches the modal between
  // _global and CURRENT_PROJECT_ID without leaving the dialog. Legacy
  // "default" project keeps the single-bucket experience (global only).
  const scopeSelector = (typeof CURRENT_PROJECT_ID !== 'undefined' && CURRENT_PROJECT_ID && CURRENT_PROJECT_ID !== 'default')
    ? `
    <div class="env-scope-toggle" style="display:inline-flex;gap:0;padding:3px;background:var(--bg-elevated,rgba(255,255,255,0.04));border:1px solid var(--card-border);border-radius:7px;margin-bottom:10px;font-size:12px">
      <button type="button" onclick="switchEnvScope('_global')" class="${envScope === '_global' ? 'active' : ''}" style="padding:5px 12px;border:none;background:${envScope === '_global' ? 'var(--accent,#10b981)' : 'transparent'};color:${envScope === '_global' ? '#fff' : 'var(--text-secondary)'};border-radius:5px;cursor:pointer;font-weight:${envScope === '_global' ? '600' : '500'}">🌐 全局</button>
      <button type="button" onclick="switchEnvScope('${esc(CURRENT_PROJECT_ID)}')" class="${envScope === CURRENT_PROJECT_ID ? 'active' : ''}" style="padding:5px 12px;border:none;background:${envScope === CURRENT_PROJECT_ID ? 'var(--accent,#10b981)' : 'transparent'};color:${envScope === CURRENT_PROJECT_ID ? '#fff' : 'var(--text-secondary)'};border-radius:5px;cursor:pointer;font-weight:${envScope === CURRENT_PROJECT_ID ? '600' : '500'}">📦 此项目</button>
    </div>
    ` : '';
  const scopeDesc = envScope === '_global'
    ? '自定义全局环境变量（所有项目共享）。项目级变量可以在此基础上覆盖特定键。'
    : '本项目专属环境变量。部署时会覆盖同名的全局变量，禁止跨项目访问。';

  const html = `
    ${scopeSelector}
    <p class="config-panel-desc">${scopeDesc}</p>
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

// ── Env modal helpers (scope-aware) ─────────────────────────────

// Every /env mutation carries ?scope=<bucket>. The scope is tracked in
// the module-level `envScope` variable and flipped via switchEnvScope().
function _envScopeQs() {
  return '?scope=' + encodeURIComponent(envScope || '_global');
}

async function switchEnvScope(scope) {
  await loadEnvVars(scope);
  openEnvModal();
}

async function saveInlineEnvVar(key) {
  const input = document.getElementById(`env-edit-val-${encodeURIComponent(key)}`);
  if (!input) return;
  const value = input.value;
  try {
    await api('PUT', `/env/${encodeURIComponent(key)}${_envScopeQs()}`, { value });
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
    await api('PUT', `/env/${encodeURIComponent(key)}${_envScopeQs()}`, { value });
    showToast(`已设置 ${key}`, 'success');
    await loadEnvVars();
    openEnvModal();
  } catch (e) { showToast(e.message, 'error'); }
}

async function deleteEnvVarAndRefresh(key) {
  try {
    await api('DELETE', `/env/${encodeURIComponent(key)}${_envScopeQs()}`);
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
    await api('PUT', '/env' + _envScopeQs(), newVars);
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

// Poll /healthz until the CDS backend has fully come back after a restart.
//
// Strategy:
//   1. Start polling /healthz every second
//   2. Wait until we observe at least one failure (proves the old process
//      is gone and the restart actually happened)
//   3. Then wait until we observe a success (proves the new process is up)
//   4. Only then resolve true so the caller can reload()
//
// Edge case: if the restart completes so fast we never catch the "down"
// window, give up waiting for `down` after ~8 attempts and reload anyway.
//
// Returns true if the server is healthy, false if the timeout was reached.
// Fixes the 502 that showed up when we location.reload() before CDS was
// actually listening again (Cloudflare saw the host down mid-restart).
async function waitForCdsHealthy(statusEl, timeoutMs) {
  const deadline = Date.now() + (timeoutMs || 120000);
  let attempt = 0;
  let sawDown = false;

  function setLabel(txt) {
    if (!statusEl) return;
    const tail = statusEl.querySelector('span:last-child');
    if (tail) tail.textContent = txt;
    else statusEl.innerHTML = '<span style="color:var(--fg-muted)">' + esc(txt) + '</span>';
  }

  while (Date.now() < deadline) {
    attempt++;
    let ok = false;
    try {
      const res = await fetch('/healthz', { method: 'GET', cache: 'no-store' });
      ok = res.ok;
    } catch (e) {
      ok = false;
    }

    if (!ok) {
      sawDown = true;
      setLabel('CDS 重启中（已等待 ' + attempt + 's，仍未恢复）...');
    } else if (sawDown) {
      setLabel('CDS 已恢复，正在刷新页面...');
      return true;
    } else if (attempt >= 8) {
      // Never caught the down window — the restart was a no-op or too fast
      // to observe. Proceed to reload to avoid hanging forever.
      setLabel('CDS 状态稳定，正在刷新页面...');
      return true;
    } else {
      setLabel('等待重启开始（' + attempt + 's）...');
    }

    await new Promise((r) => setTimeout(r, 1000));
  }

  setLabel('等待 CDS 重启超时（' + Math.round((timeoutMs || 120000) / 1000) + 's），请手动刷新');
  return false;
}

// CDS 系统更新 — 收敛到 web/self-update.js 的统一实现,避免两套 UI
// 分叉(旧版 openConfigModal + 分支页 combobox、projects.js 的原生
// select 弹窗,UX 不一致,维护成本双倍)。
//
// 保留函数名兼容所有既有调用点(齿轮菜单、topology 工具栏、cmd-k
// 命令面板、移动端工具栏等),只是都路由到 window.openSelfUpdateModal。
function openSelfUpdate() {
  if (typeof window.openSelfUpdateModal === 'function') {
    return window.openSelfUpdateModal();
  }
  // 理论上 self-update.js 由 index.html 在 app.js 之前加载,走不到此 fallback。
  if (typeof showToast === 'function') showToast('self-update.js 未加载', 'error');
}

// Legacy combobox helpers — 所有 selfUpdate* ID 随旧弹窗一起退休,
// 这些函数保留做空壳防 cmd-k 里遗留的 onclick 报 ReferenceError。
function _comboOutsideClick() { /* retired */ }
function openComboDropdown() { /* retired */ }
function closeComboDropdown() { /* retired */ }
function toggleComboDropdown() { /* retired */ }
function filterComboItems() { /* retired */ }
function selectComboItem() { /* retired */ }

// executeSelfUpdate — retired when the old openConfigModal-based self-
// update UI was collapsed into the shared self-update.js module.
// Kept as a no-op stub because cmd-k / legacy onclick references may
// still exist in cached client bundles; future cleanup can remove.
function executeSelfUpdate() { /* retired — see self-update.js */ }

// ── Infrastructure services ──

async function loadInfraServices() {
  try {
    const data = await api('GET', '/infra');
    infraServices = data.services || [];
    _updateInfraShortcutBadge();
  } catch (e) { console.error('loadInfraServices:', e); }
}

function _updateInfraShortcutBadge() {
  // Kept as a no-op after 2026-04-18 UI cleanup removed the 4 header
  // shortcut buttons (they duplicated the settings menu items). The
  // loadInfraServices flow still calls this; leaving the function
  // defined avoids a TypeError on every refresh.
  return;
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
              <button class="icon-btn xs" onclick="infraShowLogs('${esc(svc.id)}')" title="日志"><svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M2 1.75C2 .784 2.784 0 3.75 0h6.586c.464 0 .909.184 1.237.513l2.914 2.914c.329.328.513.773.513 1.237v9.586A1.75 1.75 0 0112.25 16h-8.5A1.75 1.75 0 012 14.25V1.75zm1.75-.25a.25.25 0 00-.25.25v12.5c0 .138.112.25.25.25h8.5a.25.25 0 00.25-.25V6h-2.75A1.75 1.75 0 018 4.25V1.5H3.75zm6.75.062V4.25c0 .138.112.25.25.25h2.688a.252.252 0 00-.011-.013l-2.914-2.914a.272.272 0 00-.013-.011z"/></svg></button>
              ${svc.status === 'running' ? `<button class="icon-btn xs" onclick="infraBackup('${esc(svc.id)}')" title="下载数据库备份">⇩</button>` : ''}
              ${svc.status === 'running' ? `<button class="icon-btn xs" onclick="infraRestoreDialog('${esc(svc.id)}')" title="上传恢复数据库">⇧</button>` : ''}
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
      <button class="sm primary" onclick="infraDiscover()" style="display:inline-flex;align-items:center;gap:4px"><svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M8 0L1.5 4v8L8 16l6.5-4V4L8 0zm0 1.5l5 3.1v6.8L8 14.5l-5-3.1V4.6L8 1.5z"/></svg> 从 Compose 导入</button>
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

// ── 数据库备份/恢复（2026-04-22 新增）──
// infraBackup: 直接触发浏览器下载，走 /api/infra/:id/backup（mongodump 流）
// infraRestoreDialog: 弹文件选择器 → 上传 → /api/infra/:id/restore
window.infraBackup = function (id) {
  showToast(`准备下载 ${id} 备份…`, 'info');
  window.location.href = `/api/infra/${encodeURIComponent(id)}/backup`;
};

window.infraRestoreDialog = function (id) {
  if (!confirm(`恢复 ${id} 数据库？\n\n⚠ 这会用你上传的备份覆盖当前数据。\n恢复前 CDS 会自动保存当前状态到 /data/cds/<slug>/backups/，便于撤销。`)) return;
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.gz,.archive,.rdb,application/octet-stream,application/gzip';
  input.onchange = async function () {
    const file = input.files && input.files[0];
    if (!file) return;
    showToast(`正在上传 ${Math.round(file.size / 1024 / 1024)} MB 到 ${id}…`, 'info');
    try {
      const resp = await fetch(`/api/infra/${encodeURIComponent(id)}/restore`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: file,
      });
      const body = await resp.json();
      if (!resp.ok) throw new Error(body.error || '恢复失败');
      showToast(body.message || '已恢复', 'success');
    } catch (err) {
      showToast(`恢复失败：${err.message}`, 'error');
    }
  };
  input.click();
};

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
        const hr = p.hotReload || {};
        const hrOn = !!hr.enabled;
        // 2026-04-22：.NET 默认 dotnet-run（快）；疑难撒谎场景才切 dotnet-restart
        const isDotnetImg = /dotnet|mcr\.microsoft\.com\/dotnet/i.test(p.dockerImage || '');
        const hrMode = hr.mode || (isDotnetImg ? 'dotnet-run' : 'pnpm-dev');
        const hrModeOptions = [
          ['dotnet-run', 'dotnet-run ★ 增量(快)'],
          ['dotnet-restart', 'dotnet-restart — 清理+no-incremental(慢·疑难用)'],
          ['dotnet-watch', 'dotnet-watch ⚠ 有 hot-reload 坑'],
          ['pnpm-dev', 'pnpm-dev'],
          ['vite', 'vite'],
          ['next-dev', 'next-dev'],
          ['custom', 'custom'],
        ].map(([m, label]) => `<option value="${m}"${hrMode === m ? ' selected' : ''}>${label}</option>`).join('');
        const hotReloadHtml = `
          <div style="margin-top:4px;display:flex;align-items:center;gap:6px;padding:4px 6px;background:${hrOn ? 'rgba(239,68,68,0.08)' : 'transparent'};border-radius:4px">
            <label style="display:inline-flex;align-items:center;gap:4px;font-size:11px;cursor:pointer;color:${hrOn ? '#ef4444' : 'var(--text-muted)'}">
              <input type="checkbox" ${hrOn ? 'checked' : ''} onchange="toggleHotReload('${esc(p.id)}', this.checked)" style="margin:0">
              <span>🔥 热更新</span>
            </label>
            ${hrOn ? `
              <select style="font-size:11px;padding:1px 4px;border-radius:3px;border:1px solid var(--border);background:var(--bg-secondary);color:var(--text-primary)" onchange="setHotReloadMode('${esc(p.id)}', this.value)">
                ${hrModeOptions}
              </select>
              <span style="font-size:10px;color:var(--text-muted)">容器跑 watcher，改代码自动重编译，不重启</span>
            ` : `<span style="font-size:10px;color:var(--text-muted)">开发时启用，无需重建镜像</span>`}
          </div>`;
        return `
        <div class="config-item">
          <div class="config-item-main">
            <span style="opacity:0.7">${getPortIcon(p.id, p)}</span>
            <strong>${esc(p.name)}</strong>${hrOn ? ' <span title="热更新已启用" style="color:#ef4444">🔥</span>' : ''}
            <code class="config-item-match">${esc(p.dockerImage)}</code>
            <span class="config-item-detail">${esc(p.workDir || '.')} :${p.containerPort}${p.pathPrefixes?.length ? ' → ' + p.pathPrefixes.join(', ') : ''}</span>
            <code class="config-item-cmd" title="${esc(p.runCommand)}">${esc(p.runCommand)}</code>
            ${modeHtml}
            ${hotReloadHtml}
          </div>
          <div class="config-item-actions">
            <button class="icon-btn xs" onclick="_askBranchAndRun('${esc(p.id)}', 'verify')" title="核验运行时字节码是否是最新代码">🔍</button>
            <button class="icon-btn xs" onclick="_askBranchAndRun('${esc(p.id)}', 'rebuild')" title="强制清 bin/obj + 重建（对付 MSBuild 增量撒谎）">💥</button>
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
      <!-- P4 Part 9 (MECE B4) — Quick start templates.
           One click pre-fills the entire form with sensible defaults
           for a common stack. Reduces 7+ fields to 1 click + tweak. -->
      <div class="profile-quick-templates">
        <span class="profile-quick-templates-label">快速开始：</span>
        <button type="button" class="profile-template-btn" onclick="_applyProfileTemplate('node')" title="Node.js + npm">⬡ Node.js</button>
        <button type="button" class="profile-template-btn" onclick="_applyProfileTemplate('dotnet')" title=".NET 8 SDK">⬢ .NET</button>
        <button type="button" class="profile-template-btn" onclick="_applyProfileTemplate('python')" title="Python 3.12 + pip">Python</button>
        <button type="button" class="profile-template-btn" onclick="_applyProfileTemplate('go')" title="Go 1.22">Go</button>
        <button type="button" class="profile-template-btn" onclick="_applyProfileTemplate('static')" title="静态站点 nginx">Static</button>
        <!-- P4 Part 18 (G10): auto-detect stack from the current project / branch's files -->
        <button type="button" class="profile-template-btn" onclick="_autoDetectStack()" title="扫描代码仓库识别技术栈并自动填入字段" style="margin-left:8px;border-color:rgba(96,165,250,0.5);color:#60a5fa;display:inline-flex;align-items:center;gap:4px"><svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor"><path d="M11.5 7a4.499 4.499 0 11-8.998 0A4.499 4.499 0 0111.5 7zm-.82 4.74a6 6 0 111.06-1.06l3.04 3.04a.75.75 0 11-1.06 1.06L10.68 11.74z"/></svg> Auto-detect</button>
      </div>
      <div class="form-row">
        <input id="profileId" placeholder="配置 ID（如 api、web）" class="form-input sm">
        <input id="profileName" placeholder="显示名称（留空与 ID 相同）" class="form-input sm">
        <select id="profileIcon" class="form-input xs" title="端口图标">
          <option value="">图标</option>
          <option value="api">API</option>
          <option value="web">Web</option>
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

// P4 Part 9 (MECE B4) — Stack template presets.
//
// Pre-fills the build profile add form with sensible defaults for a
// common runtime so a novice can hit Save with one click and a couple
// of tweaks (vs filling 7+ fields manually). Each template is a
// minimal correct setup that runs on the default `npm start` / `dotnet
// run` etc convention; the user can still edit any field afterward.
const PROFILE_TEMPLATES = {
  node: {
    id: 'api',
    name: 'API (Node.js)',
    icon: 'api',
    dockerImage: 'node:22-slim',
    workDir: '.',
    containerPort: 3000,
    installCommand: 'npm ci',
    buildCommand: '',
    runCommand: 'npm start',
  },
  dotnet: {
    id: 'api',
    name: 'API (.NET)',
    icon: 'api',
    dockerImage: 'mcr.microsoft.com/dotnet/sdk:8.0',
    workDir: '.',
    containerPort: 5000,
    installCommand: 'dotnet restore',
    buildCommand: 'dotnet build -c Release',
    runCommand: 'dotnet run --urls http://0.0.0.0:5000',
  },
  python: {
    id: 'api',
    name: 'API (Python)',
    icon: 'api',
    dockerImage: 'python:3.12-slim',
    workDir: '.',
    containerPort: 8000,
    installCommand: 'pip install -r requirements.txt',
    buildCommand: '',
    runCommand: 'python -m uvicorn main:app --host 0.0.0.0 --port 8000',
  },
  go: {
    id: 'api',
    name: 'API (Go)',
    icon: 'api',
    dockerImage: 'golang:1.22-alpine',
    workDir: '.',
    containerPort: 8080,
    installCommand: 'go mod download',
    buildCommand: 'go build -o /tmp/app .',
    runCommand: '/tmp/app',
  },
  static: {
    id: 'web',
    name: 'Static Site',
    icon: 'web',
    dockerImage: 'nginx:alpine',
    workDir: '.',
    containerPort: 80,
    installCommand: '',
    buildCommand: '',
    runCommand: 'nginx -g "daemon off;"',
  },
};

function _applyProfileTemplate(key) {
  const tpl = PROFILE_TEMPLATES[key];
  if (!tpl) return;

  function setVal(id, v) {
    const el = document.getElementById(id);
    if (el) el.value = v == null ? '' : v;
  }

  setVal('profileId', tpl.id);
  setVal('profileName', tpl.name);
  setVal('profileIcon', tpl.icon || '');

  // Image: try to select an existing <option>; if not present, switch
  // to the custom path so the value is preserved.
  const imageSel = document.getElementById('profileImage');
  if (imageSel) {
    const hasMatch = Array.from(imageSel.options).some(o => o.value === tpl.dockerImage);
    if (hasMatch) {
      imageSel.value = tpl.dockerImage;
      const customEl = document.getElementById('profileImageCustom');
      if (customEl) customEl.classList.add('hidden');
    } else {
      imageSel.value = '__custom__';
      const customEl = document.getElementById('profileImageCustom');
      if (customEl) {
        customEl.classList.remove('hidden');
        customEl.value = tpl.dockerImage;
      }
    }
  }

  setVal('profileWorkDir', tpl.workDir || '.');
  setVal('profilePort', tpl.containerPort || 8080);
  setVal('profileRun', tpl.runCommand || '');
  setVal('profileInstall', tpl.installCommand || '');
  setVal('profileBuild', tpl.buildCommand || '');

  // If install or build commands are present, expand the advanced section
  // so the user can see what was filled in.
  if ((tpl.installCommand || tpl.buildCommand) && typeof toggleAdvanced === 'function') {
    const adv = document.getElementById('advancedFields');
    if (adv && adv.classList.contains('hidden')) toggleAdvanced();
  }

  showToast('已应用 ' + tpl.name + ' 模板，可继续修改', 'info');

  // Highlight the active template button
  document.querySelectorAll('.profile-template-btn').forEach(btn => btn.classList.remove('active'));
  const activeBtn = document.querySelector('.profile-template-btn[onclick*="' + key + '"]');
  if (activeBtn) activeBtn.classList.add('active');
}

// Expose for the inline onclick handlers
window._applyProfileTemplate = _applyProfileTemplate;

// P4 Part 18 (G10): auto-detect the stack from the current project's
// cloned repo and pre-fill the BuildProfile form. Delegates to the
// new POST /api/detect-stack endpoint which scans the filesystem.
// Uses the currently-selected topology project if set, else falls
// back to the legacy config.repoRoot (what the server would scan
// anyway if projectId is omitted).
async function _autoDetectStack() {
  const btn = document.querySelector('.profile-template-btn[onclick*="_autoDetectStack"]');
  if (btn) {
    btn.innerHTML = '<svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor"><path d="M11.5 7a4.499 4.499 0 11-8.998 0A4.499 4.499 0 0111.5 7zm-.82 4.74a6 6 0 111.06-1.06l3.04 3.04a.75.75 0 11-1.06 1.06L10.68 11.74z"/></svg> 扫描中…';
    btn.disabled = true;
  }

  // Pick a project id if we can — the topology view stashes one
  // globally during renderCard(). Otherwise omit and let the server
  // use its default.
  const projectId = (typeof currentProjectId === 'string' && currentProjectId)
    || (new URLSearchParams(location.search)).get('project')
    || undefined;

  try {
    const res = await fetch(`${API}/detect-stack`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(projectId ? { projectId } : {}),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `HTTP ${res.status}`);
    }
    const d = await res.json();

    if (d.stack === 'unknown') {
      showToast('未识别出栈类型：' + (d.summary || '无签名文件'), 'warning');
      return;
    }
    if (d.stack === 'dockerfile') {
      showToast('检测到 Dockerfile — CDS 当前不支持自动构建，请改用预构建镜像', 'warning');
      return;
    }

    // Same fill logic as _applyProfileTemplate, but sourced from
    // the server response instead of a hardcoded PROFILE_TEMPLATES
    // entry.
    function setVal(id, v) {
      const el = document.getElementById(id);
      if (el) el.value = v == null ? '' : v;
    }

    const imageSel = document.getElementById('profileImage');
    if (imageSel) {
      const hasMatch = Array.from(imageSel.options).some(o => o.value === d.dockerImage);
      if (hasMatch) {
        imageSel.value = d.dockerImage;
        const customEl = document.getElementById('profileImageCustom');
        if (customEl) customEl.classList.add('hidden');
      } else {
        imageSel.value = '__custom__';
        const customEl = document.getElementById('profileImageCustom');
        if (customEl) {
          customEl.classList.remove('hidden');
          customEl.value = d.dockerImage;
        }
      }
    }

    setVal('profileWorkDir', d.workDir || '.');
    if (d.containerPort) setVal('profilePort', d.containerPort);
    setVal('profileRun', d.runCommand || '');
    setVal('profileInstall', d.installCommand || '');
    setVal('profileBuild', d.buildCommand || '');

    // Auto-expand advanced fields when any install/build was set
    if ((d.installCommand || d.buildCommand) && typeof toggleAdvanced === 'function') {
      const adv = document.getElementById('advancedFields');
      if (adv && adv.classList.contains('hidden')) toggleAdvanced();
    }

    showToast(
      '已识别: ' + (d.summary || d.stack) +
      '（扫描路径 ' + (d.scanPath || '-') + '）',
      'info',
    );
  } catch (err) {
    showToast('检测失败: ' + (err && err.message ? err.message : err), 'error');
  } finally {
    if (btn) {
      btn.innerHTML = '<svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor"><path d="M11.5 7a4.499 4.499 0 11-8.998 0A4.499 4.499 0 0111.5 7zm-.82 4.74a6 6 0 111.06-1.06l3.04 3.04a.75.75 0 11-1.06 1.06L10.68 11.74z"/></svg> Auto-detect';
      btn.disabled = false;
    }
  }
}
window._autoDetectStack = _autoDetectStack;

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
  // P4 Part 16 (B1 fix): tag the profile with the current project so it
  // lands in the correct project, not silently in the legacy default.
  profile.projectId = CURRENT_PROJECT_ID;
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

// 热更新开关（2026-04-22）
// 启用后容器会跑 `dotnet watch` / `pnpm dev` 之类监听源码的命令，
// 源码是 rw 绑挂的，改代码自动重编译，不用重建镜像也不用重启容器。
async function toggleHotReload(profileId, enabled) {
  try {
    const resp = await api('POST', `/build-profiles/${encodeURIComponent(profileId)}/hot-reload`, { enabled });
    showToast(resp.message || (enabled ? '已启用热更新' : '已关闭热更新'), 'success');
    await loadProfiles();
    openProfileModal();
  } catch (e) { showToast(e.message, 'error'); }
}
window.toggleHotReload = toggleHotReload;

async function setHotReloadMode(profileId, mode) {
  try {
    const resp = await api('POST', `/build-profiles/${encodeURIComponent(profileId)}/hot-reload`, { enabled: true, mode });
    showToast(resp.message || `热更新模式切换为 ${mode}`, 'success');
    await loadProfiles();
    openProfileModal();
  } catch (e) { showToast(e.message, 'error'); }
}
window.setHotReloadMode = setHotReloadMode;

// 💥 强制干净重建（对付 MSBuild 增量编译撒谎）
// 场景：改了 .cs 但运行时死活不生效，DLL 里 grep 得到新字符串、日志里看不到。
// 本操作：停容器 → rm -rf bin/obj → 提示重新部署。
async function forceRebuild(branchId, profileId) {
  if (!confirm(
    `强制干净重建 ${branchId} / ${profileId}？\n\n` +
    `会执行：\n` +
    `  1. 停止该服务容器\n` +
    `  2. 物理删除 worktree 下的 bin/ 和 obj/ 目录\n` +
    `  3. 提示手动点"部署"重新构建（下次构建会从源码完整重编译）\n\n` +
    `用途：当 MSBuild 增量编译撒谎 / dotnet watch 卡住时破除缓存。数据库和代码不受影响。`
  )) return;
  try {
    const resp = await api('POST', `/branches/${encodeURIComponent(branchId)}/force-rebuild/${encodeURIComponent(profileId)}`);
    const details = (resp.steps || []).map(s => `${s.ok ? '✓' : '✗'} ${s.step}${s.detail ? ' — ' + s.detail : ''}`).join('\n');
    alert((resp.message || '已清理') + '\n\n执行步骤：\n' + details);
  } catch (e) { showToast(`强制重建失败：${e.message}`, 'error'); }
}
window.forceRebuild = forceRebuild;

// 🔍 运行时字节码核验 —— 比对源码/DLL/进程启动时间
// 用于回答："我改的 .cs 到底生效了没有"
async function verifyRuntime(branchId, profileId) {
  try {
    const resp = await api('POST', `/branches/${encodeURIComponent(branchId)}/verify-runtime/${encodeURIComponent(profileId)}`);
    const msg = [
      `容器：${resp.container}`,
      `进程启动：${resp.processStart}`,
      `最新 DLL：${resp.latestDll?.path || '无'} (ts=${resp.latestDll?.ts || 'n/a'})`,
      `最新源码：${resp.latestSource?.path || '无'} (ts=${resp.latestSource?.ts || 'n/a'})`,
      '',
      '诊断：',
      ...(resp.warnings || []),
      '',
      '最近日志（末尾 30 行，复制贴到别处检查）：',
      '```',
      resp.recentLogs || '(空)',
      '```',
    ].join('\n');
    alert(msg);
  } catch (e) { showToast(`核验失败：${e.message}`, 'error'); }
}
window.verifyRuntime = verifyRuntime;

// Profile 卡片按钮的 branch 选择器 —— 提示用户选哪个分支执行诊断/重建
window._askBranchAndRun = function (profileId, action) {
  // 全局 branches（line 388 的 module 变量）—— 已经按本项目过滤
  const candidates = (typeof branches !== 'undefined' && Array.isArray(branches))
    ? branches.filter(b => b && b.services && b.services[profileId])
    : [];
  if (candidates.length === 0) {
    showToast(`没有找到正在运行 profile "${profileId}" 的分支`, 'info');
    return;
  }
  let branchId;
  if (candidates.length === 1) {
    branchId = candidates[0].id;
  } else {
    const list = candidates.map((b, i) => `${i + 1}) ${b.id}`).join('\n');
    const input = prompt(`选择分支（输入编号）：\n${list}`, '1');
    if (!input) return;
    const idx = parseInt(input, 10) - 1;
    if (!(idx >= 0 && idx < candidates.length)) { showToast('编号无效', 'error'); return; }
    branchId = candidates[idx].id;
  }
  if (action === 'verify') verifyRuntime(branchId, profileId);
  else if (action === 'rebuild') forceRebuild(branchId, profileId);
};

// 分支上下文已知时的快捷变体（二级菜单调用）
window._askBranchAndRunForBranch = function (branchId, profileId, action) {
  if (action === 'verify') verifyRuntime(branchId, profileId);
  else if (action === 'rebuild') forceRebuild(branchId, profileId);
};

// ⚙ 构建命令编辑面板（用户自定义每个 profile 的 deployModes 命令）
// 背景：用户想要"点某个菜单项跑自己定义的命令"。已有 profile.deployModes 支持这个
// 数据模型（每个 mode 一个 command），但一直没 UI。本面板集中编辑。
window.openBuildCommandPanel = async function (profileId) {
  const profile = buildProfiles.find(p => p.id === profileId);
  if (!profile) { showToast(`未找到构建配置 ${profileId}`, 'error'); return; }

  const modes = profile.deployModes || {};
  const modeEntries = Object.entries(modes);

  const rowsHtml = modeEntries.length > 0
    ? modeEntries.map(([modeId, m]) => `
        <div data-mode-id="${esc(modeId)}" style="border:1px solid var(--border);border-radius:6px;padding:10px;margin-bottom:8px">
          <div style="display:flex;gap:8px;align-items:center;margin-bottom:6px">
            <input class="bc-label" type="text" value="${esc(m.label || modeId)}" placeholder="显示名（如 开发模式 / 冷部署）" style="flex:1;padding:4px 6px;border:1px solid var(--border);border-radius:4px;background:var(--bg-input);color:var(--text-primary);font-size:12px">
            <code style="font-size:10px;color:var(--text-muted)">${esc(modeId)}</code>
            <button class="icon-btn xs danger-icon" onclick="event.target.closest('[data-mode-id]').remove()" title="删除此模式">×</button>
          </div>
          <textarea class="bc-cmd" rows="2" placeholder="完整 shell 命令，如: dotnet run --urls http://0.0.0.0:8080" style="width:100%;padding:6px 8px;border:1px solid var(--border);border-radius:4px;background:var(--bg-input);color:var(--text-primary);font-size:11px;font-family:var(--font-mono,monospace);resize:vertical">${esc(m.command || '')}</textarea>
        </div>
      `).join('')
    : '<div style="padding:12px;background:var(--bg-card);border:1px dashed var(--border);border-radius:6px;color:var(--text-muted);font-size:12px;margin-bottom:8px">当前没有任何模式。下面加一个即可。</div>';

  const html = `
    <div style="font-size:12px;color:var(--text-muted);margin-bottom:10px">
      为 <strong>${esc(profile.name)}</strong> (${esc(profile.id)}) 定义多个"一键跑的命令"。
      二级菜单会把它们列出来，点一下就用对应命令部署。
      <br>典型建议：「开发（热加载）」= <code>dotnet run</code>，「冷部署」= <code>dotnet publish -c Release && dotnet bin/Release/net8.0/publish/App.dll</code>。
    </div>
    <div id="bcRows">${rowsHtml}</div>
    <div style="display:flex;gap:6px;margin-bottom:14px">
      <button class="sm" onclick="_bcAddMode()">+ 新增模式</button>
      <button class="sm" onclick="_bcInsertTemplate('dev')">预设: 开发(dotnet run)</button>
      <button class="sm" onclick="_bcInsertTemplate('cold')">预设: 冷部署(publish)</button>
      <button class="sm" onclick="_bcInsertTemplate('dev-node')">预设: pnpm dev</button>
    </div>
    <div style="display:flex;gap:8px;justify-content:flex-end;border-top:1px solid var(--border);padding-top:10px">
      <button class="sm" onclick="closeConfigModal()">取消</button>
      <button class="sm primary" onclick="_bcSave('${esc(profileId)}')">保存</button>
    </div>
  `;
  openConfigModal(`构建命令 — ${profile.name}`, html);
};

window._bcAddMode = function () {
  const id = 'mode-' + Math.random().toString(36).slice(2, 7);
  const row = document.createElement('div');
  row.setAttribute('data-mode-id', id);
  row.style.cssText = 'border:1px solid var(--border);border-radius:6px;padding:10px;margin-bottom:8px';
  row.innerHTML = `
    <div style="display:flex;gap:8px;align-items:center;margin-bottom:6px">
      <input class="bc-label" type="text" placeholder="显示名" style="flex:1;padding:4px 6px;border:1px solid var(--border);border-radius:4px;background:var(--bg-input);color:var(--text-primary);font-size:12px">
      <code style="font-size:10px;color:var(--text-muted)">${id}</code>
      <button class="icon-btn xs danger-icon" onclick="this.closest('[data-mode-id]').remove()">×</button>
    </div>
    <textarea class="bc-cmd" rows="2" placeholder="完整 shell 命令" style="width:100%;padding:6px 8px;border:1px solid var(--border);border-radius:4px;background:var(--bg-input);color:var(--text-primary);font-size:11px;font-family:var(--font-mono,monospace);resize:vertical"></textarea>
  `;
  document.getElementById('bcRows').appendChild(row);
};

window._bcInsertTemplate = function (kind) {
  const templates = {
    'dev': { label: '开发（热加载）', command: 'dotnet run --urls http://0.0.0.0:$PORT' },
    'cold': { label: '冷部署（publish）', command: 'dotnet publish -c Release -o /tmp/publish && cd /tmp/publish && exec dotnet *.dll --urls http://0.0.0.0:$PORT' },
    'dev-node': { label: '开发（Vite HMR）', command: 'pnpm install --prefer-frozen-lockfile && pnpm dev --host 0.0.0.0 --port $PORT' },
  };
  const tpl = templates[kind];
  const id = 'mode-' + Math.random().toString(36).slice(2, 7);
  const row = document.createElement('div');
  row.setAttribute('data-mode-id', id);
  row.style.cssText = 'border:1px solid var(--border);border-radius:6px;padding:10px;margin-bottom:8px';
  row.innerHTML = `
    <div style="display:flex;gap:8px;align-items:center;margin-bottom:6px">
      <input class="bc-label" type="text" value="${tpl.label}" style="flex:1;padding:4px 6px;border:1px solid var(--border);border-radius:4px;background:var(--bg-input);color:var(--text-primary);font-size:12px">
      <code style="font-size:10px;color:var(--text-muted)">${id}</code>
      <button class="icon-btn xs danger-icon" onclick="this.closest('[data-mode-id]').remove()">×</button>
    </div>
    <textarea class="bc-cmd" rows="2" style="width:100%;padding:6px 8px;border:1px solid var(--border);border-radius:4px;background:var(--bg-input);color:var(--text-primary);font-size:11px;font-family:var(--font-mono,monospace);resize:vertical">${tpl.command}</textarea>
  `;
  document.getElementById('bcRows').appendChild(row);
};

window._bcSave = async function (profileId) {
  const profile = buildProfiles.find(p => p.id === profileId);
  if (!profile) return;
  const rows = document.querySelectorAll('#bcRows [data-mode-id]');
  const newModes = {};
  rows.forEach(row => {
    const modeId = row.getAttribute('data-mode-id');
    const label = row.querySelector('.bc-label').value.trim();
    const command = row.querySelector('.bc-cmd').value.trim();
    if (!label || !command) return;
    newModes[modeId] = { label, command };
  });
  try {
    await api('PUT', `/build-profiles/${encodeURIComponent(profileId)}`, {
      ...profile,
      deployModes: newModes,
    });
    showToast('已保存构建命令', 'success');
    closeConfigModal();
    await loadProfiles();
  } catch (e) { showToast(`保存失败：${e.message}`, 'error'); }
};

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
      <div class="commit-log-item ${isLatest ? 'latest' : ''} ${isCurrent ? 'current' : ''}" onclick="event.stopPropagation(); checkoutCommit('${esc(id)}', '${esc(c.hash)}', ${isLatest}, ${JSON.stringify(esc(c.subject)).replace(/"/g, '&quot;')})" title="点击切换到此提交进行构建">
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
  const msg = `切换到历史提交进行构建？\n\n${hash}  ${subject}\n\n[警告] 切换后卡片将显示警示状态\n点击「部署」会自动恢复到分支最新`;
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

  // If topology activity panel is open, prepend this item there too
  _topologyActivityPanelPush('cds', el.outerHTML, activityEvents.length);
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

  // Update topology panel activity tab if open
  _topologyActivityPanelPush('web', el.outerHTML, webActivityEvents.length);
}

// Push a new activity item into the topology panel's activity tab if visible.
function _topologyActivityPanelPush(subtab, itemHtml, count) {
  if (typeof _topologyPanelCurrentKind === 'undefined' || _topologyPanelCurrentKind !== 'activity') return;
  var activeTabEl = document.querySelector('.topology-fs-panel-tab.active');
  if (!activeTabEl || activeTabEl.dataset.tab !== 'activity') return;
  var bodyEl = document.getElementById(subtab === 'cds' ? 'tfpActivityCds' : 'tfpActivityWeb');
  if (!bodyEl) return;
  var emptyEl = bodyEl.querySelector('.tfp-activity-empty');
  if (emptyEl) emptyEl.remove();
  // Prepend (newest first)
  bodyEl.insertAdjacentHTML('afterbegin', itemHtml);
  var countEl = document.getElementById(subtab === 'cds' ? 'tfpActCdsCount' : 'tfpActWebCount');
  if (countEl) countEl.textContent = count;
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
  html += `<div class="activity-detail-row"><span class="activity-detail-key">来源</span><span style="display:inline-flex;align-items:center;gap:4px">${isAi ? '<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M8 0C3.58 0 0 3.58 0 8c0 4.42 3.58 8 8 8s8-3.58 8-8c0-4.42-3.58-8-8-8zm1 11H7v-2h2v2zm0-4H7V5h2v2z"/></svg> AI (' + escapeHtml(event.agent || '未知') + ')' : '<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M10.561 8.073a6.005 6.005 0 011.06 3.678c0 .673-.111 1.32-.315 1.922a.75.75 0 101.42.477A7.5 7.5 0 0013 11.75a7.5 7.5 0 00-1.316-4.282.75.75 0 00-1.123.605zM8 8a3.5 3.5 0 100-7 3.5 3.5 0 000 7zm-1.5 0a2 2 0 110-4 2 2 0 010 4zm-6 8a6 6 0 0112 0 .75.75 0 01-1.5 0 4.5 4.5 0 00-9 0 .75.75 0 01-1.5 0z"/></svg> 用户'}</span></div>`;
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
    return `<svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor" style="vertical-align:-1px"><path d="M10.5 0a5.499 5.499 0 100 11 5.499 5.499 0 000-11zM7 5.5a3.5 3.5 0 117 0 3.5 3.5 0 01-7 0zm-.405 8.34l-2.96-2.96a.25.25 0 01.177-.426l2.783.077L8.217 8.1a3.5 3.5 0 10-.99-.99L5.75 8.737l-2.783-.077a1.75 1.75 0 00-1.238 2.98l2.96 2.96a1.75 1.75 0 002.48 0l.342-.342a.75.75 0 00-1.061-1.061l-.342.342a.25.25 0 01-.354 0z"/></svg> ${peer?.name || conn.cdsPeerId || '未知 CDS'}${db}`;
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
        <span title="${esc(colsDetail)}"><svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor" style="vertical-align:-1px"><path d="M8 0L1.5 4v8L8 16l6.5-4V4L8 0zm0 1.5l5 3.1v6.8L8 14.5l-5-3.1V4.6L8 1.5z"/></svg> ${colsLabel}</span>
        ${m.startedAt ? `<span>⏱ ${duration}</span>` : ''}
        ${m.source.sshTunnel?.enabled || m.target.sshTunnel?.enabled ? '<span><svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor" style="vertical-align:-1px"><path d="M4 5a4 4 0 017.87 1.37A3 3 0 0115 9a3 3 0 01-3 3H5a4 4 0 01-1-7.87V5zm5 5.5a1.5 1.5 0 100-3 1.5 1.5 0 000 3zm0-5A1.5 1.5 0 109 7a1.5 1.5 0 000 3z"/></svg> SSH</span>' : ''}
      </div>
      ${m.errorMessage ? `<div class="mig-card-error">⚠ ${esc(m.errorMessage)}</div>` : ''}
      ${m.status === 'running' ? `
        <div class="mig-progress-bar"><div class="mig-progress-fill" style="width:${m.progress || 0}%"></div></div>
        <div class="mig-progress-text">${esc(m.progressMessage || '准备中...')} · ${m.progress || 0}%</div>
      ` : ''}
      <div class="mig-card-actions">
        ${canRun ? `<button class="sm" onclick="executeMigration('${m.id}')">▶ 执行</button>` : ''}
        ${m.status !== 'running' ? `<button class="sm" onclick="editMigration('${m.id}')"><svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor"><path d="M11.013 1.427a1.75 1.75 0 012.474 0l1.086 1.086a1.75 1.75 0 010 2.474l-8.61 8.61c-.21.21-.47.364-.756.445l-3.251.93a.75.75 0 01-.927-.928l.929-3.25c.081-.286.235-.547.445-.758l8.61-8.61zm.176 4.823L9.75 4.81l-6.286 6.287a.25.25 0 00-.064.108l-.558 1.953 1.953-.558a.249.249 0 00.108-.064l6.286-6.286z"/></svg> 编辑</button>` : ''}
        <button class="sm" onclick="cloneMigration('${m.id}')"><svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor"><path d="M5.75 1a.75.75 0 00-.75.75v3c0 .414.336.75.75.75h4.5a.75.75 0 00.75-.75v-3a.75.75 0 00-.75-.75h-4.5zm.75 3V2.5h3V4h-3zm-2.874-.467a.75.75 0 00-.752-1.298A1.75 1.75 0 002 4.75v7.5c0 .966.784 1.75 1.75 1.75h8.5A1.75 1.75 0 0014 12.25v-7.5a1.75 1.75 0 00-.874-1.515.75.75 0 10-.752 1.298.25.25 0 01.126.217v7.5a.25.25 0 01-.25.25h-8.5a.25.25 0 01-.25-.25v-7.5a.25.25 0 01.126-.217z"/></svg> 克隆</button>
        ${m.log ? `<button class="sm" onclick="showMigrationLog('${m.id}')"><svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor"><path d="M2 1.75C2 .784 2.784 0 3.75 0h6.586c.464 0 .909.184 1.237.513l2.914 2.914c.329.328.513.773.513 1.237v9.586A1.75 1.75 0 0112.25 16h-8.5A1.75 1.75 0 012 14.25V1.75zm1.75-.25a.25.25 0 00-.25.25v12.5c0 .138.112.25.25.25h8.5a.25.25 0 00.25-.25V6h-2.75A1.75 1.75 0 018 4.25V1.5H3.75zm6.75.062V4.25c0 .138.112.25.25.25h2.688a.252.252 0 00-.011-.013l-2.914-2.914a.272.272 0 00-.013-.011z"/></svg> 日志</button>` : ''}
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
      <button class="sm" onclick="openPeersModal()" style="display:inline-flex;align-items:center;gap:4px"><svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor"><path d="M10.5 0a5.499 5.499 0 100 11 5.499 5.499 0 000-11zM7 5.5a3.5 3.5 0 117 0 3.5 3.5 0 01-7 0zm-.405 8.34l-2.96-2.96a.25.25 0 01.177-.426l2.783.077L8.217 8.1a3.5 3.5 0 10-.99-.99L5.75 8.737l-2.783-.077a1.75 1.75 0 00-1.238 2.98l2.96 2.96a1.75 1.75 0 002.48 0l.342-.342a.75.75 0 00-1.061-1.061l-.342.342a.25.25 0 01-.354 0z"/></svg> CDS 密钥管理${peerCount ? ` (${peerCount})` : ''}</button>
      <button class="sm" onclick="checkMigrationTools()" style="display:inline-flex;align-items:center;gap:4px"><svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor"><path d="M5.433.753a.75.75 0 01.673-.752A7.5 7.5 0 0115 7.5a.75.75 0 01-1.5 0 6 6 0 00-5.49-5.983.75.75 0 01-.577-.764zM1.5 7.5a.75.75 0 01.75-.75h2.752a.75.75 0 01.53 1.28L2.78 10.28a.25.25 0 00.35.357l5.5-4.498a.75.75 0 01.87 1.229l-5.5 4.497a1.75 1.75 0 01-2.45-2.5L3.296 7.5H2.25A.75.75 0 011.5 7.5z"/></svg> 工具状态</button>
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
          <option value="cds" ${defaultType === 'cds' ? 'selected' : ''}>CDS 密钥 (跨 CDS 直连)</option>
          <option value="remote" ${defaultType === 'remote' || !hasLocalMongo ? 'selected' : ''}>远程 MongoDB</option>
        </select>
      </div>

      <div id="${prefix}CdsFields" style="${defaultType === 'cds' ? '' : 'display:none'}">
        <div class="form-row mc-row">
          <select id="${prefix}CdsPeer" class="form-input mc-input" onchange="onCdsPeerChange('${prefix}', ${isSource})">
            <option value="">${cdsPeers.length ? '(请选择 CDS 密钥)' : '(未添加，请点击「管理密钥」)'}</option>
            ${peerOptions}
          </select>
          <button type="button" class="sm mc-btn" onclick="openPeersModal()" title="管理 CDS 密钥"><svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor"><path d="M10.5 0a5.499 5.499 0 100 11 5.499 5.499 0 000-11zM7 5.5a3.5 3.5 0 117 0 3.5 3.5 0 01-7 0zm-.405 8.34l-2.96-2.96a.25.25 0 01.177-.426l2.783.077L8.217 8.1a3.5 3.5 0 10-.99-.99L5.75 8.737l-2.783-.077a1.75 1.75 0 00-1.238 2.98l2.96 2.96a1.75 1.75 0 002.48 0l.342-.342a.75.75 0 00-1.061-1.061l-.342.342a.25.25 0 01-.354 0z"/></svg></button>
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
            <button type="button" class="sm" onclick="testSshTunnel('${prefix}')" style="flex:0 0 auto;display:inline-flex;align-items:center;gap:4px"><svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor"><path d="M5.433.753a.75.75 0 01.673-.752A7.5 7.5 0 0115 7.5a.75.75 0 01-1.5 0 6 6 0 00-5.49-5.983.75.75 0 01-.577-.764zM1.5 7.5a.75.75 0 01.75-.75h2.752a.75.75 0 01.53 1.28L2.78 10.28a.25.25 0 00.35.357l5.5-4.498a.75.75 0 01.87 1.229l-5.5 4.497a1.75 1.75 0 01-2.45-2.5L3.296 7.5H2.25A.75.75 0 011.5 7.5z"/></svg> 测试隧道</button>
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
      return peer ? `<svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor"><path d="M10.5 0a5.499 5.499 0 100 11 5.499 5.499 0 000-11zM7 5.5a3.5 3.5 0 117 0 3.5 3.5 0 01-7 0zm-.405 8.34l-2.96-2.96a.25.25 0 01.177-.426l2.783.077L8.217 8.1a3.5 3.5 0 10-.99-.99L5.75 8.737l-2.783-.077a1.75 1.75 0 00-1.238 2.98l2.96 2.96a1.75 1.75 0 002.48 0l.342-.342a.75.75 0 00-1.061-1.061l-.342.342a.25.25 0 01-.354 0z"/></svg> ${peer.name}` : 'CDS';
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
  const primaryLabel = editMode ? '保存修改' : '创建并执行';
  const primaryHandler = editMode ? 'saveMigrationEdits()' : 'createAndExecuteMigration()';
  const html = `
    <div class="form-row" style="margin-bottom:10px">
      <input id="migName" class="form-input" placeholder="任务名称 (自动生成)" style="flex:1;min-width:0" oninput="this.dataset.autoGenerated=''">
    </div>
    <div class="migration-dual-panel">
      <div class="migration-side">
        <div class="migration-side-title"><svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" style="vertical-align:-1px"><path d="M8.75 0a.75.75 0 01.75.75v13.5a.75.75 0 01-1.5 0V.75A.75.75 0 018.75 0zM.22 7.47a.75.75 0 001.06 1.06L3.5 6.31v5.44a.75.75 0 001.5 0V6.31l2.22 2.22a.75.75 0 001.06-1.06L4.75 3.94 1.22 7.47z"/></svg> 源数据库</div>
        ${buildConnectionForm('src', prefill?.source?.type || 'local', true)}
      </div>
      <div class="migration-arrow">
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 12h14M12 5l7 7-7 7"/></svg>
      </div>
      <div class="migration-side">
        <div class="migration-side-title"><svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" style="vertical-align:-1px"><path d="M8.75 0a.75.75 0 01.75.75v5.44l2.22-2.22a.75.75 0 011.06 1.06L9.28 8.53a.747.747 0 01-1.06 0L4.78 5.03a.75.75 0 011.06-1.06L8.06 6.19V.75A.75.75 0 018.75 0zm-5 8.75A.75.75 0 013 9.5v4.75c0 .138.112.25.25.25h11.5a.25.25 0 00.25-.25V9.5a.75.75 0 011.5 0v4.75A1.75 1.75 0 0115 16H3.25A1.75 1.75 0 011.5 14.25V9.5a.75.75 0 011-1z"/></svg> 目标数据库</div>
        ${buildConnectionForm('tgt', prefill?.target?.type || 'remote', false)}
      </div>
    </div>
    <div class="form-row" style="margin-top:12px;gap:6px;flex-wrap:wrap">
      <button class="primary sm" onclick="${primaryHandler}">${primaryLabel}</button>
      ${editMode ? '' : '<button class="sm" onclick="saveMigrationOnly()">仅保存</button>'}
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
        ${mig.collections?.length ? `<div style="text-align:center;font-size:11px;color:var(--fg-muted);margin-bottom:8px"><svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor" style="vertical-align:-1px"><path d="M8 0L1.5 4v8L8 16l6.5-4V4L8 0zm0 1.5l5 3.1v6.8L8 14.5l-5-3.1V4.6L8 1.5z"/></svg> ${mig.collections.join(', ')}</div>` : ''}
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
      <div class="peer-mykey-title"><svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" style="vertical-align:-1px"><path d="M10.5 0a5.499 5.499 0 100 11 5.499 5.499 0 000-11zM7 5.5a3.5 3.5 0 117 0 3.5 3.5 0 01-7 0zm-.405 8.34l-2.96-2.96a.25.25 0 01.177-.426l2.783.077L8.217 8.1a3.5 3.5 0 10-.99-.99L5.75 8.737l-2.783-.077a1.75 1.75 0 00-1.238 2.98l2.96 2.96a1.75 1.75 0 002.48 0l.342-.342a.75.75 0 00-1.061-1.061l-.342.342a.25.25 0 01-.354 0z"/></svg> 本机 CDS 密钥 <span class="peer-mykey-hint">（复制后在对方 CDS 中添加，即可实现双向数据迁移）</span></div>
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
          <button type="button" class="sm" onclick="testCdsPeer('${p.id}')" title="重新验证连接" style="display:inline-flex;align-items:center;gap:3px"><svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor"><path d="M5.433.753a.75.75 0 01.673-.752A7.5 7.5 0 0115 7.5a.75.75 0 01-1.5 0 6 6 0 00-5.49-5.983.75.75 0 01-.577-.764zM1.5 7.5a.75.75 0 01.75-.75h2.752a.75.75 0 01.53 1.28L2.78 10.28a.25.25 0 00.35.357l5.5-4.498a.75.75 0 01.87 1.229l-5.5 4.497a1.75 1.75 0 01-2.45-2.5L3.296 7.5H2.25A.75.75 0 011.5 7.5z"/></svg> 测试</button>
          <button type="button" class="sm" onclick="editCdsPeer('${p.id}')" style="display:inline-flex;align-items:center;gap:3px"><svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor"><path d="M11.013 1.427a1.75 1.75 0 012.474 0l1.086 1.086a1.75 1.75 0 010 2.474l-8.61 8.61c-.21.21-.47.364-.756.445l-3.251.93a.75.75 0 01-.927-.928l.929-3.25c.081-.286.235-.547.445-.758l8.61-8.61zm.176 4.823L9.75 4.81l-6.286 6.287a.25.25 0 00-.064.108l-.558 1.953 1.953-.558a.249.249 0 00.108-.064l6.286-6.286z"/></svg> 编辑</button>
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
        <button class="btn-primary cluster-action-btn" onclick="doIssueToken()" style="display:inline-flex;align-items:center;gap:6px;justify-content:center">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M10.5 0a5.499 5.499 0 100 11 5.499 5.499 0 000-11zM7 5.5a3.5 3.5 0 117 0 3.5 3.5 0 01-7 0zm-.405 8.34l-2.96-2.96a.25.25 0 01.177-.426l2.783.077L8.217 8.1a3.5 3.5 0 10-.99-.99L5.75 8.737l-2.783-.077a1.75 1.75 0 00-1.238 2.98l2.96 2.96a1.75 1.75 0 002.48 0l.342-.342a.75.75 0 00-1.061-1.061l-.342.342a.25.25 0 01-.354 0z"/></svg> 生成连接码
        </button>
        <div id="clusterTokenBox" class="cluster-token-box hidden">
          <label>连接码（复制下面的字符串粘贴到另一台机器）</label>
          <textarea id="clusterTokenArea" readonly rows="4" onclick="this.select()"></textarea>
          <div class="cluster-token-actions">
            <button class="btn-secondary" onclick="copyClusterToken()" style="display:inline-flex;align-items:center;gap:4px"><svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M0 6.75C0 5.784.784 5 1.75 5h1.5a.75.75 0 010 1.5h-1.5a.25.25 0 00-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 00.25-.25v-1.5a.75.75 0 011.5 0v1.5A1.75 1.75 0 019.25 16h-7.5A1.75 1.75 0 010 14.25v-7.5z"/><path d="M5 1.75C5 .784 5.784 0 6.75 0h7.5C15.216 0 16 .784 16 1.75v7.5A1.75 1.75 0 0114.25 11h-7.5A1.75 1.75 0 015 9.25v-7.5zm1.75-.25a.25.25 0 00-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 00.25-.25v-7.5a.25.25 0 00-.25-.25h-7.5z"/></svg> 复制</button>
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
          <button class="btn-danger cluster-action-btn" onclick="doLeaveCluster()" style="display:inline-flex;align-items:center;gap:6px;justify-content:center">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M2 2.75C2 1.784 2.784 1 3.75 1h2.5a.75.75 0 010 1.5h-2.5a.25.25 0 00-.25.25v10.5c0 .138.112.25.25.25h2.5a.75.75 0 010 1.5h-2.5A1.75 1.75 0 012 13.25V2.75zm10.44 4.5l-1.97-1.97a.75.75 0 111.06-1.06l3.25 3.25a.75.75 0 010 1.06l-3.25 3.25a.75.75 0 11-1.06-1.06l1.97-1.97H6.75a.75.75 0 010-1.5h5.69z"/></svg> 退出集群
          </button>
        ` : `
          <p class="cluster-tab-desc">
            在主节点上点"生成连接码"后，把得到的字符串粘贴到下面，点"加入集群"。
            中间会验证、写入配置、立刻注册到主节点，<strong>无需重启</strong>。
          </p>
          <textarea id="clusterJoinInput" class="cluster-paste-input" rows="4"
                    placeholder="把主节点生成的连接码粘贴到这里..."></textarea>
          <button class="btn-primary cluster-action-btn" onclick="doJoinCluster()" style="display:inline-flex;align-items:center;gap:6px;justify-content:center">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M14.25 1h-3.5a.75.75 0 000 1.5h1.94l-3.72 3.72a.75.75 0 001.06 1.06L13.75 3.56v1.94a.75.75 0 001.5 0V1.75a.75.75 0 00-.75-.75zM1.75 15h3.5a.75.75 0 000-1.5H3.31l3.72-3.72a.75.75 0 10-1.06-1.06L2.25 12.44v-1.94a.75.75 0 00-1.5 0v3.75c0 .414.336.75.75.75z"/></svg> 加入集群
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
    if (btn) { btn.disabled = false; btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M10.5 0a5.499 5.499 0 100 11 5.499 5.499 0 000-11zM7 5.5a3.5 3.5 0 117 0 3.5 3.5 0 01-7 0zm-.405 8.34l-2.96-2.96a.25.25 0 01.177-.426l2.783.077L8.217 8.1a3.5 3.5 0 10-.99-.99L5.75 8.737l-2.783-.077a1.75 1.75 0 00-1.238 2.98l2.96 2.96a1.75 1.75 0 002.48 0l.342-.342a.75.75 0 00-1.061-1.061l-.342.342a.25.25 0 01-.354 0z"/></svg> 重新生成连接码'; }
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

  if (btn) { btn.disabled = true; btn.textContent = '正在加入...'; }
  if (result) result.innerHTML = '<div class="cluster-progress">解析连接码 → 写入配置 → 注册到主节点 → 启动心跳...</div>';

  try {
    const res = await fetch('/api/cluster/join', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ connectionCode: input.value.trim() }),
    });
    const body = await res.json();

    if (!res.ok) {
      if (result) result.innerHTML = `<div class="cluster-error"><svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M3.72 3.72a.75.75 0 011.06 0L8 6.94l3.22-3.22a.75.75 0 111.06 1.06L9.06 8l3.22 3.22a.75.75 0 11-1.06 1.06L8 9.06l-3.22 3.22a.75.75 0 01-1.06-1.06L6.94 8 3.72 4.78a.75.75 0 010-1.06z"/></svg> ${esc(body.error || '加入失败')}</div>`;
      showToast(body.error || '加入失败', 'error');
      return;
    }

    // Success — show the restart warning prominently
    if (result) {
      result.innerHTML = `
        <div class="cluster-success">
          ✓ 已加入集群
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
    if (result) result.innerHTML = `<div class="cluster-error"><svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M3.72 3.72a.75.75 0 011.06 0L8 6.94l3.22-3.22a.75.75 0 111.06 1.06L9.06 8l3.22 3.22a.75.75 0 11-1.06 1.06L8 9.06l-3.22 3.22a.75.75 0 01-1.06-1.06L6.94 8 3.72 4.78a.75.75 0 010-1.06z"/></svg> 网络错误: ${esc(err.message)}</div>`;
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M14.25 1h-3.5a.75.75 0 000 1.5h1.94l-3.72 3.72a.75.75 0 001.06 1.06L13.75 3.56v1.94a.75.75 0 001.5 0V1.75a.75.75 0 00-.75-.75zM1.75 15h3.5a.75.75 0 000-1.5H3.31l3.72-3.72a.75.75 0 10-1.06-1.06L2.25 12.44v-1.94a.75.75 0 00-1.5 0v3.75c0 .414.336.75.75.75z"/></svg> 加入集群'; }
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
    if (btn) { btn.disabled = false; btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M2 2.75C2 1.784 2.784 1 3.75 1h2.5a.75.75 0 010 1.5h-2.5a.25.25 0 00-.25.25v10.5c0 .138.112.25.25.25h2.5a.75.75 0 010 1.5h-2.5A1.75 1.75 0 012 13.25V2.75zm10.44 4.5l-1.97-1.97a.75.75 0 111.06-1.06l3.25 3.25a.75.75 0 010 1.06l-3.25 3.25a.75.75 0 11-1.06-1.06l1.97-1.97H6.75a.75.75 0 010-1.5h5.69z"/></svg> 退出集群'; }
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

async function openOverrideModal(branchId, preferredProfileId) {
  _ensureOverrideModal();
  try {
    const data = await api('GET', `/branches/${encodeURIComponent(branchId)}/profile-overrides`);
    if (!data.profiles || data.profiles.length === 0) {
      showToast('该分支暂无可配置的构建服务', 'info');
      return;
    }
    // Topology view passes `preferredProfileId` to land directly on the
    // clicked service's tab. Fall back to the first profile if the hint
    // is missing or references a profile the branch doesn't know about.
    const hintedProfile = preferredProfileId
      ? data.profiles.find(p => p.profileId === preferredProfileId)
      : null;
    _overrideModalState = {
      branchId,
      profiles: data.profiles,
      activeProfileId: (hintedProfile && hintedProfile.profileId) || data.profiles[0].profileId,
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

// Sentinel tab id for the branch-level subdomain aliases editor.
// Lives next to the real profile tabs but renders a different form.
const OVERRIDE_TAB_SUBDOMAIN = '__subdomain__';

function _renderOverrideTabs() {
  const s = _overrideModalState;
  if (!s) return;
  const tabsEl = document.getElementById('overrideProfileTabs');

  // Build the profile tabs first
  const profileTabs = s.profiles.map(p => {
    const active = p.profileId === s.activeProfileId;
    const dot = p.hasOverride ? '<span style="display:inline-block;width:6px;height:6px;border-radius:50%;background:var(--accent,#4a9eff);margin-left:6px;vertical-align:2px" title="已有分支自定义"></span>' : '';
    return `<button class="log-tab ${active ? 'active' : ''}" style="padding:6px 12px;border-radius:8px 8px 0 0;border:1px solid var(--border);border-bottom:none;background:${active ? 'var(--bg-elevated)' : 'transparent'};color:${active ? 'var(--text-primary)' : 'var(--text-secondary)'};cursor:pointer;font-size:12px;" onclick="_switchOverrideProfile('${esc(p.profileId)}')">${esc(p.profileName || p.profileId)}${dot}</button>`;
  }).join('');

  // Prepend the branch-level "子域名" tab. It's visually distinct (different
  // border color) so users can tell it's not a per-profile setting.
  const subActive = s.activeProfileId === OVERRIDE_TAB_SUBDOMAIN;
  const aliasCount = s.subdomainData?.aliases?.length || 0;
  const aliasCountBadge = aliasCount > 0
    ? `<span style="display:inline-block;padding:1px 6px;font-size:10px;background:var(--accent-bg,rgba(74,158,255,0.15));color:var(--accent,#4a9eff);border-radius:8px;margin-left:6px;">${aliasCount}</span>`
    : '';
  const subTab = `<button class="log-tab ${subActive ? 'active' : ''}" style="padding:6px 12px;border-radius:8px 8px 0 0;border:1px solid var(--border);border-bottom:none;background:${subActive ? 'var(--bg-elevated)' : 'transparent'};color:${subActive ? 'var(--text-primary)' : 'var(--text-secondary)'};cursor:pointer;font-size:12px;margin-right:8px;" onclick="_switchOverrideProfile('${OVERRIDE_TAB_SUBDOMAIN}')" title="分支级子域名别名（所有服务共享）"><svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" style="vertical-align:-1px;margin-right:4px"><path d="M8 0a8 8 0 100 16A8 8 0 008 0zM1.01 8.75h2.49c.07.94.21 1.85.43 2.68A6.02 6.02 0 011.01 8.75zm0-1.5A6.02 6.02 0 013.93 4.57c-.22.83-.36 1.74-.43 2.68H1.01zm7.24 7.7c-.63-.64-1.14-1.63-1.46-2.97H9.2c-.32 1.34-.83 2.33-1.46 2.97A6.47 6.47 0 017.49.8a6.47 6.47 0 01-.72 0zm-.97-4.47H9.2c.08-.78.12-1.6.12-2.43s-.04-1.65-.12-2.43H7.24c-.08.78-.12 1.6-.12 2.43s.04 1.65.12 2.43zm3.33 2.97c.22-.83.36-1.74.43-2.68h2.49a6.02 6.02 0 01-2.92 2.68zm.43-4.18c-.07-.94-.21-1.85-.43-2.68A6.02 6.02 0 0114.99 7H12.5c-.07.83-.12 1.64-.12 2.47z"/></svg>子域名${aliasCountBadge}</button>`;

  tabsEl.innerHTML = subTab + profileTabs;
}

function _switchOverrideProfile(profileId) {
  if (!_overrideModalState) return;
  if (_overrideModalState.dirty) {
    if (!confirm('切换前放弃当前修改？')) return;
    _overrideModalState.dirty = false;
  }
  _overrideModalState.activeProfileId = profileId;
  _renderOverrideTabs();
  if (profileId === OVERRIDE_TAB_SUBDOMAIN) {
    _renderSubdomainForm();
  } else {
    _renderOverrideForm();
  }
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
    const numMinAttr = type === 'number' ? ' min="1"' : '';
    const inputEl = type === 'textarea'
      ? `<textarea data-override-key="${key}" rows="4" placeholder="${esc(placeholder || '')}" style="width:100%;padding:8px 10px;background:var(--bg-primary);border:1px solid var(--border);border-radius:6px;color:var(--text-primary);font-family:var(--font-mono,monospace);font-size:12px;resize:vertical" oninput="_overrideFieldChanged()">${esc(overrideVal || '')}</textarea>`
      : `<input type="${type}"${numMinAttr} data-override-key="${key}" value="${esc(overrideVal !== undefined && overrideVal !== null ? String(overrideVal) : '')}" placeholder="${esc(placeholder || '继承公共默认')}" style="width:100%;padding:8px 10px;background:var(--bg-primary);border:1px solid var(--border);border-radius:6px;color:var(--text-primary);font-family:${type === 'number' ? 'inherit' : 'var(--font-mono,monospace)'};font-size:12px" oninput="_overrideFieldChanged()" />`;
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
  const overrideEnvText = envToText(override.env);
  // Effective env (includes CDS_* infra vars from backend) — used for baseline
  // preview so the user sees EVERYTHING that will actually be injected, not
  // just profile.env. cdsEnvKeys lets us mark the risky infra keys in orange.
  const effectiveEnvEntries = Object.entries(effective.env || {});
  const cdsEnvKeys = new Set(p.cdsEnvKeys || []);
  const baselineHasEntries = effectiveEnvEntries.length > 0;

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
      <textarea id="overrideEnvTextarea" data-override-key="env" rows="6" placeholder="每行一个 KEY=VALUE，将覆盖同名的公共默认" style="width:100%;padding:8px 10px;background:var(--bg-primary);border:1px solid var(--border);border-radius:6px;color:var(--text-primary);font-family:var(--font-mono,monospace);font-size:12px;resize:vertical" oninput="_overrideFieldChanged()">${esc(overrideEnvText)}</textarea>
      <div style="font-size:11px;color:var(--text-muted);margin-top:3px">
        公共默认 (${effectiveEnvEntries.length} 项，含 ${cdsEnvKeys.size} 个 CDS 基础设施变量):
        ${baselineHasEntries ? `<details style="display:block"><summary style="cursor:pointer;color:var(--accent,#4a9eff);display:inline-block">展开（点击 → 复制到上方）</summary>
          <div style="margin-top:4px;padding:6px 8px;background:var(--bg-primary);border-radius:4px;font-size:11px;max-height:160px;overflow:auto">
            ${effectiveEnvEntries.map(([k, v]) => {
              const isCds = cdsEnvKeys.has(k);
              const keyStyle = isCds ? 'color:#ff9f43' : 'color:var(--text-secondary)';
              const titleAttr = isCds ? 'title="来自 CDS infra services，覆盖有风险"' : '';
              const cdsTag = isCds ? '<span style="display:inline-block;padding:0 4px;margin-right:4px;font-size:9px;background:rgba(255,159,67,0.15);color:#ff9f43;border:1px solid #ff9f43;border-radius:3px;vertical-align:1px">CDS</span>' : '';
              // HTML-encode for the onclick attribute. Outer onclick="" is double-quoted,
              // so we build a single-quoted JS string literal (escape backslashes and
              // single quotes), then HTML-escape the whole thing so `&` / `<` don't
              // break the attribute either.
              const encArg = (raw) => {
                const jsLiteral = "'" + String(raw).replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'";
                return esc(jsLiteral);
              };
              return `<div style="display:flex;align-items:center;gap:6px;padding:2px 0;font-family:var(--font-mono,monospace)" ${titleAttr}>
                <button class="sm" style="flex-shrink:0;padding:1px 6px;font-size:10px;background:var(--bg-elevated);color:var(--accent,#4a9eff);border:1px solid var(--border);border-radius:3px;cursor:pointer" onclick="_appendEnvToOverride(${encArg(k)}, ${encArg(v)})">→ 编辑</button>
                <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${cdsTag}<span style="${keyStyle};font-weight:600">${esc(k)}</span><span style="color:var(--text-muted)">=</span><span style="color:var(--text-secondary)">${esc(v)}</span></span>
              </div>`;
            }).join('')}
          </div>
        </details>` : '<em>无</em>'}
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
      <button class="sm" id="overrideResetBtn" onclick="_resetOverride()" style="background:var(--bg-elevated);color:var(--text-secondary);border:1px solid var(--border)">重置为公共</button>
      <div style="display:flex;gap:8px">
        <button class="sm" id="overrideCancelBtn" onclick="closeOverrideModal()" style="background:var(--bg-elevated);color:var(--text-secondary);border:1px solid var(--border)">取消</button>
        <button class="sm" id="overrideSaveBtn" onclick="_saveOverride()" style="background:var(--bg-elevated);color:var(--text-primary);border:1px solid var(--border)">保存 (稍后手动部署)</button>
        <button class="sm deploy-glow-btn" id="overrideSaveDeployBtn" onclick="_saveAndDeployOverride()">保存并立即部署</button>
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
  // Track env-line stats so _saveOverride can surface parse issues as a toast (M4).
  let envParsed = 0;
  let envSkipped = 0;
  body.querySelectorAll('[data-override-key]').forEach(el => {
    const key = el.dataset.overrideKey;
    const raw = el.value;
    if (key !== 'env' && (raw === '' || raw === null || raw === undefined)) return; // inherit
    if (key === 'env') {
      const envObj = {};
      // H4: distinguish "empty LINE" (whitespace-only) from "empty VALUE"
      // (KEY=). Empty value is a valid assignment that sets the var to "".
      raw.split('\n').forEach(line => {
        if (line.trim().length === 0) return; // pure blank line — skip silently
        const trimmed = line.trim();
        if (trimmed.startsWith('#')) return; // comment — skip silently
        const eq = trimmed.indexOf('=');
        if (eq <= 0) {
          // Not a KEY=VALUE line (no '=' or starts with '=') — count as error.
          envSkipped++;
          return;
        }
        const k = trimmed.slice(0, eq).trim();
        if (!k) { envSkipped++; return; }
        // Keep value UN-trimmed so trailing spaces in user intent are preserved;
        // but we use the original line from after the '=' minus leading whitespace,
        // so a line like "KEY=" parses to ''. A line like "KEY= value " keeps the
        // leading space intact because the user explicitly typed it.
        const v = trimmed.slice(eq + 1);
        envObj[k] = v;
        envParsed++;
      });
      // Note: empty envObj now means "override.env = {}" not "inherit". The
      // backend handler treats this as "remove all baseline env keys" — that
      // is NOT what users want, so we fall back to "inherit" on empty.
      if (Object.keys(envObj).length > 0) override.env = envObj;
    } else if (key === 'containerPort') {
      const n = parseInt(raw, 10);
      // M6 (frontend guard): match backend — only accept positive integers.
      if (!isNaN(n) && n > 0) override.containerPort = n;
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
  return { override, envParsed, envSkipped };
}

// Append a baseline env KEY=VALUE pair to the override textarea, unless the
// same KEY is already present on any line. Called from the baseline env
// preview list's "→ 编辑" buttons (H2 / one-click copy-to-override).
function _appendEnvToOverride(key, value) {
  const textarea = document.getElementById('overrideEnvTextarea');
  if (!textarea) return;
  const current = textarea.value;
  const lines = current.split('\n');
  // "Already present" check: match lines whose KEY portion equals `key`,
  // regardless of whitespace around the KEY. Comments and blank lines skipped.
  const alreadyPresent = lines.some(line => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return false;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) return false;
    return trimmed.slice(0, eq).trim() === key;
  });
  if (alreadyPresent) {
    showToast(`${key} 已在覆盖中，未重复追加`, 'info');
    return;
  }
  const newLine = `${key}=${value}`;
  const needsNewline = current.length > 0 && !current.endsWith('\n');
  textarea.value = current + (needsNewline ? '\n' : '') + newLine + '\n';
  if (_overrideModalState) _overrideModalState.dirty = true;
  // Show the user we did something + scroll to the new line.
  textarea.focus();
  textarea.scrollTop = textarea.scrollHeight;
}

// Toggle save/cancel/reset buttons disabled state during in-flight requests (M7).
function _setOverrideButtonsDisabled(disabled) {
  const ids = ['overrideSaveBtn', 'overrideSaveDeployBtn', 'overrideResetBtn', 'overrideCancelBtn'];
  ids.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.disabled = disabled;
  });
}

// Shared save pipeline used by both "保存" and "保存并立即部署" (H3 / H5 / M4 / M7).
// Returns true on success, false if the user aborted or the request failed.
async function _doSaveOverride() {
  const s = _overrideModalState;
  if (!s) return false;
  const { override, envParsed, envSkipped } = _collectOverrideFromForm();

  // H5: warn loudly when the user is about to override CDS_* infra vars.
  // These come from `stateService.getCdsEnvVars()` and are the ONLY way the
  // container reaches Mongo/Redis/etc. Silent overrides would break the
  // branch without any error on deploy.
  if (override.env) {
    const cdsKeys = Object.keys(override.env).filter(k => k.startsWith('CDS_'));
    if (cdsKeys.length > 0) {
      const ok = confirm(
        `你正在覆盖 CDS 基础设施变量 [${cdsKeys.join(', ')}]，这可能导致容器连不上 MongoDB/Redis 等基础服务。确定继续？`
      );
      if (!ok) return false;
    }
  }

  _setOverrideButtonsDisabled(true);
  try {
    await api('PUT', `/branches/${encodeURIComponent(s.branchId)}/profile-overrides/${encodeURIComponent(s.activeProfileId)}`, override);
    s.dirty = false;
    // M4: tell the user how many env lines parsed vs. were dropped.
    if (envSkipped > 0) {
      showToast(`已识别 ${envParsed} 条环境变量，跳过 ${envSkipped} 条格式错误行`, 'info', 5000);
    } else {
      showToast('已保存，重新部署该分支后生效', 'success');
    }
    return true;
  } catch (e) {
    showToast('保存失败: ' + e.message, 'error');
    return false;
  } finally {
    _setOverrideButtonsDisabled(false);
  }
}

async function _saveOverride() {
  const s = _overrideModalState;
  if (!s) return;
  const ok = await _doSaveOverride();
  if (!ok) return;
  // Refresh current profile data in-place so badges/preview reflect the new state.
  try {
    const refreshed = await api('GET', `/branches/${encodeURIComponent(s.branchId)}/profile-overrides`);
    s.profiles = refreshed.profiles;
    _renderOverrideTabs();
    _renderOverrideForm();
  } catch (e) {
    showToast('刷新失败: ' + e.message, 'error');
  }
}

// H3: one-click save + redeploy. Saves via the shared pipeline, closes the
// modal, then hands off to the existing deployBranch() helper.
async function _saveAndDeployOverride() {
  const s = _overrideModalState;
  if (!s) return;
  const branchId = s.branchId;
  const ok = await _doSaveOverride();
  if (!ok) return;
  // Close without the "unsaved changes" prompt — we just saved successfully.
  _overrideModalState = null;
  document.getElementById('overrideModal')?.classList.add('hidden');
  showToast('正在重新部署...', 'info');
  try {
    await deployBranch(branchId);
  } catch (e) {
    showToast('部署失败: ' + e.message, 'error');
  }
}

async function _resetOverride() {
  const s = _overrideModalState;
  if (!s) return;
  if (!confirm('确定清空该分支的容器覆盖，完全继承公共配置？')) return;
  _setOverrideButtonsDisabled(true);
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
  } finally {
    _setOverrideButtonsDisabled(false);
  }
}

// ── Subdomain aliases editor ──
//
// Renders inside the same override modal under a dedicated "🌐 子域名" tab.
// Data is loaded lazily on first open of that tab, then cached on
// `_overrideModalState.subdomainData`. Save + reset use the dedicated
// `/api/branches/:id/subdomain-aliases` endpoint (not profile-overrides).

async function _loadSubdomainAliases() {
  const s = _overrideModalState;
  if (!s) return;
  try {
    const data = await api('GET', `/branches/${encodeURIComponent(s.branchId)}/subdomain-aliases`);
    s.subdomainData = {
      aliases: data.aliases || [],
      defaultUrl: data.defaultUrl || '',
      rootDomain: data.rootDomain || '',
    };
  } catch (e) {
    showToast('加载子域名失败: ' + e.message, 'error');
    s.subdomainData = { aliases: [], defaultUrl: '', rootDomain: '' };
  }
}

async function _renderSubdomainForm() {
  const s = _overrideModalState;
  if (!s) return;
  const body = document.getElementById('overrideModalBody');

  // Lazy load
  if (!s.subdomainData) {
    body.innerHTML = '<div style="padding:40px;text-align:center;color:var(--text-muted);font-size:13px">正在加载子域名配置…</div>';
    await _loadSubdomainAliases();
    _renderOverrideTabs(); // refresh count badge after load
  }

  const data = s.subdomainData || { aliases: [], defaultUrl: '', rootDomain: '' };
  const aliases = data.aliases;

  const chips = aliases.length === 0
    ? '<div style="padding:16px;color:var(--text-muted);font-size:12px;font-style:italic">还没有别名。默认通过分支 slug 访问。</div>'
    : aliases.map((a, idx) => `
      <div style="display:flex;align-items:center;gap:10px;padding:10px 12px;margin-bottom:6px;background:var(--bg-primary);border:1px solid var(--border);border-radius:6px">
        <div style="flex:1;min-width:0">
          <div style="font-family:var(--font-mono,monospace);font-size:12px;color:var(--text-primary);font-weight:600">${esc(a)}</div>
          <a href="http://${esc(a)}.${esc(data.rootDomain)}" target="_blank" rel="noopener" style="font-size:11px;color:var(--accent,#4a9eff);text-decoration:none;font-family:var(--font-mono,monospace)">http://${esc(a)}.${esc(data.rootDomain)} ↗</a>
        </div>
        <button class="sm" onclick="_removeSubdomainAlias(${idx})" style="background:transparent;color:var(--text-muted);border:1px solid var(--border);padding:4px 10px;font-size:11px" title="删除这个别名">✕</button>
      </div>
    `).join('');

  body.innerHTML = `
    <div style="display:flex;gap:8px;align-items:center;margin-bottom:12px;padding:10px 12px;background:var(--bg-elevated);border-radius:8px;border:1px solid var(--border);font-size:12px">
      <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" style="flex-shrink:0;color:var(--accent,#4a9eff)"><path d="M8 0a8 8 0 100 16A8 8 0 008 0zM7.25 4a.75.75 0 011.5 0v4a.75.75 0 01-1.5 0V4zM8 10a1 1 0 100 2 1 1 0 000-2z"/></svg>
      <span style="color:var(--text-secondary);line-height:1.5">
        子域名别名让这个分支可以通过<strong style="color:var(--text-primary)">稳定 URL</strong> 访问，适合 webhook 接收、demo 分享、前端硬编码 API 域名等场景。
        保存后<strong style="color:var(--text-primary)">立即生效，无需重新部署</strong>。
      </span>
    </div>

    <div style="margin-bottom:10px">
      <div style="font-size:12px;font-weight:600;color:var(--text-primary);margin-bottom:4px">默认访问地址</div>
      <a href="${esc(data.defaultUrl)}" target="_blank" rel="noopener" style="font-size:11px;font-family:var(--font-mono,monospace);color:var(--text-muted);text-decoration:none">${esc(data.defaultUrl)} ↗</a>
    </div>

    <div style="margin-bottom:12px">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px">
        <span style="font-size:12px;font-weight:600;color:var(--text-primary)">子域名别名 (${aliases.length})</span>
        <span style="font-size:11px;color:var(--text-muted)">每行一个 DNS 标签（小写字母、数字、连字符）</span>
      </div>
      ${chips}
    </div>

    <div style="display:flex;gap:8px;margin-bottom:14px">
      <input type="text" id="subdomainNewAlias" placeholder="例: paypal-webhook, demo, api-staging" pattern="[a-z0-9][a-z0-9-]*[a-z0-9]|[a-z0-9]" maxlength="63" style="flex:1;padding:8px 10px;background:var(--bg-primary);border:1px solid var(--border);border-radius:6px;color:var(--text-primary);font-family:var(--font-mono,monospace);font-size:12px" onkeydown="if(event.key==='Enter'){event.preventDefault();_addSubdomainAlias();}" />
      <button class="sm" onclick="_addSubdomainAlias()" style="padding:8px 16px;font-size:12px">+ 添加</button>
    </div>

    <div style="display:flex;gap:8px;justify-content:space-between;padding-top:12px;border-top:1px solid var(--border)">
      <button class="sm" id="overrideResetBtn" onclick="_resetSubdomainAliases()" style="background:var(--bg-elevated);color:var(--text-secondary);border:1px solid var(--border)" title="清空所有别名，仅保留默认 slug 路径">清空全部别名</button>
      <div style="display:flex;gap:8px">
        <button class="sm" id="overrideCancelBtn" onclick="closeOverrideModal()" style="background:var(--bg-elevated);color:var(--text-secondary);border:1px solid var(--border)">关闭</button>
        <button class="sm deploy-glow-btn" id="overrideSaveBtn" onclick="_saveSubdomainAliases()">保存别名</button>
      </div>
    </div>
  `;
}

function _addSubdomainAlias() {
  const s = _overrideModalState;
  if (!s || !s.subdomainData) return;
  const input = document.getElementById('subdomainNewAlias');
  const raw = (input?.value || '').trim().toLowerCase();
  if (!raw) return;
  // Client-side DNS label validation
  if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(raw)) {
    showToast('无效的 DNS 标签：只允许小写字母、数字、连字符，首尾必须是字母或数字', 'error');
    return;
  }
  if (s.subdomainData.aliases.includes(raw)) {
    showToast(`"${raw}" 已经在列表里`, 'info');
    return;
  }
  s.subdomainData.aliases.push(raw);
  s.dirty = true;
  _renderSubdomainForm();
  // Restore focus to the input for fast entry of multiple aliases
  setTimeout(() => document.getElementById('subdomainNewAlias')?.focus(), 0);
}

function _removeSubdomainAlias(idx) {
  const s = _overrideModalState;
  if (!s || !s.subdomainData) return;
  s.subdomainData.aliases.splice(idx, 1);
  s.dirty = true;
  _renderSubdomainForm();
}

async function _saveSubdomainAliases() {
  const s = _overrideModalState;
  if (!s || !s.subdomainData) return;
  _setOverrideButtonsDisabled(true);
  try {
    const res = await api('PUT', `/branches/${encodeURIComponent(s.branchId)}/subdomain-aliases`, {
      aliases: s.subdomainData.aliases,
    });
    showToast(`已保存 ${res.aliases?.length || 0} 个别名，立即生效`, 'success');
    s.subdomainData.aliases = res.aliases || [];
    s.dirty = false;
    _renderOverrideTabs(); // refresh badge count
    _renderSubdomainForm();
  } catch (e) {
    // Collision errors come back as structured 409 — surface the server reason
    showToast('保存失败: ' + e.message, 'error');
  } finally {
    _setOverrideButtonsDisabled(false);
  }
}

async function _resetSubdomainAliases() {
  const s = _overrideModalState;
  if (!s || !s.subdomainData) return;
  if (!confirm('确定清空该分支的全部子域名别名？')) return;
  _setOverrideButtonsDisabled(true);
  try {
    await api('PUT', `/branches/${encodeURIComponent(s.branchId)}/subdomain-aliases`, { aliases: [] });
    s.subdomainData.aliases = [];
    s.dirty = false;
    showToast('已清空所有别名', 'success');
    _renderOverrideTabs();
    _renderSubdomainForm();
  } catch (e) {
    showToast('清空失败: ' + e.message, 'error');
  } finally {
    _setOverrideButtonsDisabled(false);
  }
}

// Expose handlers to inline event attributes (non-module script)
window.openOverrideModal = openOverrideModal;
window.closeOverrideModal = closeOverrideModal;
window._switchOverrideProfile = _switchOverrideProfile;
window._overrideFieldChanged = _overrideFieldChanged;
window._saveOverride = _saveOverride;
window._saveAndDeployOverride = _saveAndDeployOverride;
window._resetOverride = _resetOverride;
window._appendEnvToOverride = _appendEnvToOverride;
window._addSubdomainAlias = _addSubdomainAlias;
window._removeSubdomainAlias = _removeSubdomainAlias;
window._saveSubdomainAliases = _saveSubdomainAliases;
window._resetSubdomainAliases = _resetSubdomainAliases;

// ════════════════════════════════════════════════════════════════════
// Topology view — layered DAG of services + infra, with per-branch
// override badges. Hook: renderBranches() calls renderTopologyView()
// when _viewMode === 'topology'. Data sources are the already-polled
// `buildProfiles` / `infraServices` / `branches` globals.
// ════════════════════════════════════════════════════════════════════

let _viewMode = (function () {
  // 2026-04-22：默认改为拓扑视图（用户反馈"显示拓扑即可"），不再默认 list
  if (location.pathname === '/branch-panel') return 'topology';
  if (location.pathname === '/branch-list') return 'list';
  // 其他情况：honour session storage，未设置时默认拓扑
  var saved = sessionStorage.getItem('cds_view_mode');
  if (saved === 'list') return 'list';
  return 'topology';
})();
let _topologySelectedBranchId = null; // currently highlighted branch for override overlay
let _topologyKeepSharedView = false;   // true = stay in aggregated canvas even with a branchId set (panel context only)
let _topologyOverrideCache = new Map(); // branchId → Set<profileId> with hasOverride=true
let _topologyOverrideDetails = new Map(); // branchId → Map<profileId, string[]> list of overridden fields

function setViewMode(mode) {
  if (mode !== 'list' && mode !== 'topology') mode = 'list';
  _viewMode = mode;
  sessionStorage.setItem('cds_view_mode', mode);
  // Sync URL path so each view has a distinct, bookmarkable address
  var _urlPath = mode === 'topology' ? '/branch-panel' : '/branch-list';
  history.replaceState(null, '', _urlPath + location.search);
  document.title = (mode === 'topology' ? '分支面板' : '分支列表') + ' · CDS';

  const listEl = document.getElementById('branchList');
  const topoEl = document.getElementById('topologyView');
  // Flip the active class on any view-mode toggle in the DOM — there's
  // the list-view header toggle (.view-mode-btn) and UF-08's new
  // topology-fs pill (.topology-fs-view-toggle-btn). Both use the same
  // data-view-mode attribute so one querySelectorAll handles both.
  const buttons = document.querySelectorAll('.view-mode-btn, .topology-fs-view-toggle-btn');
  buttons.forEach(btn => {
    const active = btn.dataset.viewMode === mode;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-selected', active ? 'true' : 'false');
  });

  if (mode === 'topology') {
    if (listEl) listEl.classList.add('hidden');
    if (topoEl) topoEl.classList.remove('hidden');
    // P4 Part 5: promote topology to full-viewport. CSS rules in
    // style.css under `body.cds-topology-fs` hide the dashboard chrome
    // (header, search, branch picker, tag bar) and stretch the canvas
    // to fill the screen.
    document.body.classList.add('cds-topology-fs');
    _ensureTopologyFsChrome();
    // P4 Part 6: refresh the breadcrumb branch dropdown so it reflects
    // the latest branches list (which may have changed since the last
    // entry into topology mode).
    if (typeof _topologyRefreshBranchDropdown === 'function') {
      _topologyRefreshBranchDropdown();
    }
    renderTopologyView();
    // P4 Part 15 (MECE A5 redo): when the project is fully empty
    // (no profiles, no infra) AND we haven't already auto-opened in
    // this session, pop the + Add menu so the user lands directly
    // on the "What would you like to create?" dropdown — matches
    // Railway's first-time create flow.
    var noServices = (buildProfiles || []).length === 0 && (infraServices || []).length === 0;
    if (noServices && !sessionStorage.getItem('cds_topology_autoadd_done')) {
      sessionStorage.setItem('cds_topology_autoadd_done', '1');
      setTimeout(function () {
        var menu = document.getElementById('topologyFsAddMenu');
        if (menu && !menu.classList.contains('open')) {
          if (typeof _topologyToggleAddMenu === 'function') _topologyToggleAddMenu();
        }
      }, 220);
    }
  } else {
    if (topoEl) topoEl.classList.add('hidden');
    if (listEl) listEl.classList.remove('hidden');
    document.body.classList.remove('cds-topology-fs');
    // Close the right panel when leaving topology mode
    if (typeof _topologyClosePanel === 'function') _topologyClosePanel();
  }
}

/**
 * P4 Part 5: inject the floating top bar + edit hint that appear in
 * full-screen topology mode. Idempotent — safe to call many times;
 * only creates the elements once.
 *
 * The bar lives outside .container so the body-level fullscreen rule
 * doesn't accidentally hide it. We mount it on document.body.
 */
function _ensureTopologyFsChrome() {
  if (document.getElementById('topologyFsTopbar')) return;

  // P4 Part 6: Railway-style topology shell. Builds five DOM regions
  // attached to <body> (so they survive the body-level container hide
  // rule):
  //
  //   1. Left 44px icon sub-nav  (topology / metrics / logs / settings)
  //   2. Top breadcrumb pill     (← Projects · project › env)
  //   3. Branch dropdown         (right side of top pill)
  //   4. Floating "+ Add" button + popover menu
  //   5. Right slide-in service detail panel (4 tabs)
  //   6. Bottom edit hint pill
  //
  // All elements are idempotent — the function returns early if the
  // top bar already exists. Subsequent calls to setViewMode('topology')
  // just re-show them via CSS.
  const projectId = (function () {
    try { return new URLSearchParams(location.search).get('project') || 'default'; }
    catch (e) { return 'default'; }
  })();

  // ── 1. Left icon sub-nav — two sections: project-level + system-level ──
  const leftnav = document.createElement('aside');
  leftnav.id = 'topologyFsLeftnav';
  leftnav.className = 'topology-fs-leftnav';
  leftnav.innerHTML = `
    <!-- ① Navigation views -->
    <button type="button" class="topology-fs-leftnav-icon active" id="topoNavTopology" title="服务拓扑" onclick="setViewMode('topology')">
      <svg viewBox="0 0 16 16" fill="currentColor"><path d="M5 2.75a2.25 2.25 0 114.5 0 2.25 2.25 0 01-4.5 0zM7.25 0a2.75 2.75 0 00-.75 5.397V7H2.75A1.75 1.75 0 001 8.75v1.603a2.75 2.75 0 101.5 0V8.75a.25.25 0 01.25-.25H6.5v1.397a2.75 2.75 0 101.5 0V8.5h3.75a.25.25 0 01.25.25v1.603a2.75 2.75 0 101.5 0V8.75A1.75 1.75 0 0011.75 7H8V5.397A2.75 2.75 0 007.25 0z"/></svg>
      <span class="topology-fs-leftnav-label">拓扑</span>
    </button>
    <button type="button" class="topology-fs-leftnav-icon" id="topoNavList" title="切换到列表视图" onclick="setViewMode('list')">
      <svg viewBox="0 0 16 16" fill="currentColor"><path d="M2 4h12v2H2V4zm0 3.5h12v1H2v-1zm0 2.5h12v1H2v-1zm0 2.5h12v1H2v-1z"/></svg>
      <span class="topology-fs-leftnav-label">列表</span>
    </button>

    <!-- ② Project-level tools -->
    <div class="topology-fs-leftnav-divider"></div>

    <button type="button" class="topology-fs-leftnav-icon" title="构建配置" onclick="openProfileModal()">
      <svg viewBox="0 0 16 16" fill="currentColor"><path d="M7.22 1.547a2.403 2.403 0 011.56 0l4.03 1.384a.48.48 0 01.33.457v1.224a.48.48 0 01-.33.457L8.78 6.453a2.403 2.403 0 01-1.56 0L3.19 5.069a.48.48 0 01-.33-.457V3.388a.48.48 0 01.33-.457l4.03-1.384zM3.19 6.903l4.03 1.384a2.403 2.403 0 001.56 0l4.03-1.384a.48.48 0 01.33.457v1.224a.48.48 0 01-.33.457L8.78 10.425a2.403 2.403 0 01-1.56 0L3.19 9.041a.48.48 0 01-.33-.457V7.36a.48.48 0 01.33-.457zm0 3.972l4.03 1.384a2.403 2.403 0 001.56 0l4.03-1.384a.48.48 0 01.33.457v1.224a.48.48 0 01-.33.457l-4.03 1.384a2.403 2.403 0 01-1.56 0l-4.03-1.384a.48.48 0 01-.33-.457v-1.224a.48.48 0 01.33-.457z"/></svg>
      <span class="topology-fs-leftnav-label">构建</span>
    </button>
    <button type="button" class="topology-fs-leftnav-icon" title="环境变量" onclick="openEnvModal()">
      <svg viewBox="0 0 16 16" fill="currentColor"><path d="M2.5 2a.5.5 0 00-.5.5v11a.5.5 0 00.5.5h11a.5.5 0 00.5-.5v-11a.5.5 0 00-.5-.5h-11zM1 2.5A1.5 1.5 0 012.5 1h11A1.5 1.5 0 0115 2.5v11a1.5 1.5 0 01-1.5 1.5h-11A1.5 1.5 0 011 13.5v-11zM4 5h2v1H4V5zm3 0h5v1H7V5zM4 8h2v1H4V8zm3 0h5v1H7V8zM4 11h2v1H4v-1zm3 0h5v1H7v-1z"/></svg>
      <span class="topology-fs-leftnav-label">环境</span>
    </button>
    <button type="button" class="topology-fs-leftnav-icon" title="基础设施" onclick="openInfraModal()">
      <svg viewBox="0 0 16 16" fill="currentColor"><path d="M2 2a2 2 0 012-2h8a2 2 0 012 2v2a2 2 0 01-2 2H4a2 2 0 01-2-2V2zm2-.5a.5.5 0 00-.5.5v2a.5.5 0 00.5.5h8a.5.5 0 00.5-.5V2a.5.5 0 00-.5-.5H4zM2 9.5A1.5 1.5 0 013.5 8h9A1.5 1.5 0 0114 9.5v3a1.5 1.5 0 01-1.5 1.5h-9A1.5 1.5 0 012 12.5v-3zm1.5 0v3h9v-3h-9zM4 10.5a.5.5 0 01.5-.5h1a.5.5 0 010 1h-1a.5.5 0 01-.5-.5z"/></svg>
      <span class="topology-fs-leftnav-label">基础设施</span>
    </button>
    <button type="button" class="topology-fs-leftnav-icon" title="路由规则" onclick="openRoutingModal()">
      <svg viewBox="0 0 16 16" fill="currentColor"><path d="M8 0a8 8 0 100 16A8 8 0 008 0zM1.5 8a6.5 6.5 0 0113 0h-2.1a8.3 8.3 0 00-.4-2.2 9 9 0 00-1-1.9A4.5 4.5 0 017 7.5H4.5A8.3 8.3 0 001.5 8zm5.5 5.5a6.5 6.5 0 01-5.4-3h2.3c.3 1.2.8 2.2 1.5 3H7zm1-5.5a7.8 7.8 0 014-3.8c.5.6.9 1.2 1.2 1.8H8zm0 1h5.4a8.3 8.3 0 01-.3 2H8.9 8V9zm0 3h3.8c-.6 1.3-1.5 2.4-2.8 3A6.5 6.5 0 018 9z"/></svg>
      <span class="topology-fs-leftnav-label">路由</span>
    </button>
    <button type="button" class="topology-fs-leftnav-icon" id="topoNavActivity" title="系统活动日志" onclick="_topologyOpenActivityPanel()">
      <svg viewBox="0 0 16 16" fill="currentColor"><path d="M1.5 1.75a.75.75 0 00-1.5 0v12.5c0 .414.336.75.75.75h14.5a.75.75 0 000-1.5H1.5V1.75zm14.28 2.53a.75.75 0 00-1.06-1.06L10 7.94 7.53 5.47a.75.75 0 00-1.06 0L2.22 9.72a.75.75 0 001.06 1.06L7 7.06l2.47 2.47a.75.75 0 001.06 0l5.25-5.25z"/></svg>
      <span class="topology-fs-leftnav-label">活动</span>
    </button>
    <!-- 刷新: project-level, used most frequently — moved from topbar to here -->
    <button type="button" class="topology-fs-leftnav-icon" id="topoNavRefresh" title="手动刷新远端分支 / 更新检查" onclick="_topologyManualRefresh(event)">
      <svg viewBox="0 0 16 16" fill="currentColor"><path d="M8 2.5a5.487 5.487 0 00-4.131 1.869l1.204 1.204A.25.25 0 014.896 6H1.25A.25.25 0 011 5.75V2.104a.25.25 0 01.427-.177l1.38 1.38A7.002 7.002 0 0115 8a.75.75 0 01-1.5 0A5.5 5.5 0 008 2.5zM2.5 8a.75.75 0 00-1.5 0 7.002 7.002 0 0012.023 4.87l1.38 1.38a.25.25 0 00.427-.177V10.5a.25.25 0 00-.25-.25h-3.646a.25.25 0 00-.177.427l1.204 1.204A5.5 5.5 0 012.5 8z"/></svg>
      <span class="topology-fs-leftnav-label">刷新</span>
    </button>

    <!-- ③ System section (collapsed into ⚙ popover) -->
    <div class="topology-fs-leftnav-spacer"></div>
    <div class="topology-fs-leftnav-divider"></div>

    <!-- System settings trigger — all system ops fold in here -->
    <div style="position:relative">
      <button type="button" class="topology-fs-leftnav-icon" id="topoSysBtn"
              title="系统设置（导入 / 更新 / 清理 / 项目列表）"
              onclick="_topoSysPopoverToggle()">
        <svg viewBox="0 0 16 16" fill="currentColor"><path d="M8 0a.75.75 0 01.75.75 5.75 5.75 0 000 14.5A.75.75 0 018 16C3.582 16 0 12.418 0 8S3.582 0 8 0zm5.5 8a5.5 5.5 0 11-11 0 5.5 5.5 0 0111 0zM6.75 7.25h2.5a.75.75 0 010 1.5h-2.5a.75.75 0 010-1.5z"/></svg>
        <svg viewBox="0 0 16 16" fill="currentColor" style="display:none"><path d="M9.585.52a2.678 2.678 0 00-3.17 0l-.928.68a1.178 1.178 0 01-.518.215L3.83 1.59a2.678 2.678 0 00-2.24 2.24l-.175 1.14a1.178 1.178 0 01-.215.518l-.68.928a2.678 2.678 0 000 3.17l.68.928c.113.153.183.33.215.518l.175 1.14a2.678 2.678 0 002.24 2.24l1.14.175c.187.032.365.102.518.215l.928.68a2.678 2.678 0 003.17 0l.928-.68a1.178 1.178 0 01.518-.215l1.14-.175a2.678 2.678 0 002.24-2.24l.175-1.14c.032-.187.102-.365.215-.518l.68-.928a2.678 2.678 0 000-3.17l-.68-.928a1.178 1.178 0 01-.215-.518L14.41 3.83a2.678 2.678 0 00-2.24-2.24l-1.14-.175a1.178 1.178 0 01-.518-.215L9.585.52zM8 10.5a2.5 2.5 0 110-5 2.5 2.5 0 010 5z"/></svg>
        <span class="topology-fs-leftnav-label">设置</span>
      </button>
      <!-- System popover -->
      <div class="topo-sys-popover" id="topoSysPopover">
        <button type="button" class="topo-sys-popover-item" onclick="_topoSysPopoverClose();openImportModal()">
          <svg viewBox="0 0 16 16" fill="currentColor"><path d="M8 2.004a.75.75 0 01.75.75v5.689l1.97-1.97a.749.749 0 111.06 1.06l-3.25 3.25a.749.749 0 01-1.06 0L4.22 7.533a.749.749 0 111.06-1.06l1.97 1.97V2.754a.75.75 0 01.75-.75zM2.75 12.5h10.5a.75.75 0 010 1.5H2.75a.75.75 0 010-1.5z"/></svg>
          导入配置
        </button>
        <button type="button" class="topo-sys-popover-item" onclick="_topoSysPopoverClose();openSelfUpdate()">
          <svg viewBox="0 0 16 16" fill="currentColor"><path d="M8 2.5a5.487 5.487 0 00-4.131 1.869l1.204 1.204A.25.25 0 014.896 6H1.25A.25.25 0 011 5.75V2.104a.25.25 0 01.427-.177l1.38 1.38A7.002 7.002 0 0115 8a.75.75 0 01-1.5 0A5.5 5.5 0 008 2.5zM2.5 8a.75.75 0 00-1.5 0 7.002 7.002 0 0012.023 4.87l1.38 1.38a.25.25 0 00.427-.177V10.5a.25.25 0 00-.25-.25h-3.646a.25.25 0 00-.177.427l1.204 1.204A5.5 5.5 0 012.5 8z"/></svg>
          CDS 系统更新
        </button>
        <div class="topo-sys-popover-divider"></div>
        <button type="button" class="topo-sys-popover-item danger" onclick="_topoSysPopoverClose();openCleanupModal()">
          <svg viewBox="0 0 16 16" fill="currentColor"><path d="M6.5 1.75a.25.25 0 01.25-.25h2.5a.25.25 0 01.25.25V3h-3V1.75zM11 3V1.75A1.75 1.75 0 009.25 0h-2.5A1.75 1.75 0 005 1.75V3H2.75a.75.75 0 000 1.5h.3l.8 8.2A1.75 1.75 0 005.6 14.5h4.8a1.75 1.75 0 001.75-1.8l.8-8.2h.3a.75.75 0 000-1.5H11z"/></svg>
          清理分支
        </button>
        <div class="topo-sys-popover-divider"></div>
        <a href="/project-list" class="topo-sys-popover-item">
          <svg viewBox="0 0 16 16" fill="currentColor"><path d="M1.75 1h12.5c.966 0 1.75.784 1.75 1.75v10.5A1.75 1.75 0 0114.25 15H1.75A1.75 1.75 0 010 13.25V2.75C0 1.784.784 1 1.75 1zM1.5 2.75v10.5c0 .138.112.25.25.25h12.5a.25.25 0 00.25-.25V2.75a.25.25 0 00-.25-.25H1.75a.25.25 0 00-.25.25z"/></svg>
          项目列表
        </a>
      </div>
    </div>
  `;
  document.body.appendChild(leftnav);

  // ── 2 + 3. Top breadcrumb pill with branch dropdown ──
  //
  // UF-07: the old native `<select id="topologyFsBranchSelect">` only
  // let users switch between already-tracked branches. We replace it
  // with a custom combobox that:
  //   - shows existing tracked branches (same as before)
  //   - shows a search input inside the popover
  //   - offers a "+ 手动添加" entry when the typed text isn't yet a
  //     tracked branch — calls the same addBranch() that list view's
  //     branchSearch uses, so behaviour is 1:1 with UF-04
  //
  // UF-08: the old exit path to list view was an ambiguous "日志" icon
  // hidden in the left sub-nav. We add a proper "列表 | 拓扑" toggle
  // pill next to the branch dropdown so the active mode is obvious and
  // switching back is one click.
  const topbar = document.createElement('div');
  topbar.id = 'topologyFsTopbar';
  topbar.className = 'topology-fs-topbar';
  topbar.innerHTML = `
    <div class="topology-fs-topbar-pill">
      <a href="/project-list" class="topology-fs-breadcrumb-item link" title="返回项目列表">
        <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor"><path d="M1.75 1h12.5c.966 0 1.75.784 1.75 1.75v10.5A1.75 1.75 0 0114.25 15H1.75A1.75 1.75 0 010 13.25V2.75C0 1.784.784 1 1.75 1zM1.5 2.75v10.5c0 .138.112.25.25.25h12.5a.25.25 0 00.25-.25V2.75a.25.25 0 00-.25-.25H1.75a.25.25 0 00-.25.25z"/></svg>
        <span id="topologyFsProjectName">${esc(projectId)}</span>
      </a>
      <span class="topology-fs-breadcrumb-sep">/</span>
      <span class="topology-fs-breadcrumb-item">production</span>
      <span class="topology-fs-breadcrumb-sep">/</span>
      <!-- UF-07: custom branch combobox (replaces native <select>) -->
      <div class="topology-fs-branch-combo" id="topologyFsBranchCombo">
        <button type="button" class="topology-fs-branch-combo-btn" id="topologyFsBranchComboBtn" onclick="event.stopPropagation();_topologyBranchComboToggle()">
          <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path fill-rule="evenodd" d="M11.75 2.5a.75.75 0 100 1.5.75.75 0 000-1.5zm-2.25.75a2.25 2.25 0 113 2.122V6A2.5 2.5 0 0110 8.5H6a1 1 0 00-1 1v1.128a2.251 2.251 0 11-1.5 0V5.372a2.25 2.25 0 111.5 0v1.836A2.492 2.492 0 016 7h4a1 1 0 001-1v-.628A2.25 2.25 0 019.5 3.25zM4.25 12a.75.75 0 100 1.5.75.75 0 000-1.5zM3.5 3.25a.75.75 0 111.5 0 .75.75 0 01-1.5 0z"/></svg>
          <span id="topologyFsBranchComboLabel">（共享视图）</span>
          <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor"><path d="M4.427 7.427l3.396 3.396a.25.25 0 00.354 0l3.396-3.396A.25.25 0 0011.396 7H4.604a.25.25 0 00-.177.427z"/></svg>
        </button>
        <div class="topology-fs-branch-combo-popover" id="topologyFsBranchComboPopover">
          <input type="text" class="topology-fs-branch-combo-search" id="topologyFsBranchComboSearch" placeholder="搜索或粘贴分支名,按 Enter 添加" autocomplete="off">
          <div class="topology-fs-branch-combo-list" id="topologyFsBranchComboList"></div>
        </div>
      </div>
    </div>
    <!-- Inline host-stats pill (replaces the bottom-right floating widget in FS mode) -->
    <div class="topology-fs-hoststats" id="topologyFsHostStats" onclick="showHostStatsDetails(event)" title="宿主机实时负载 — 点击查看详情" style="display:none">
      <div class="topology-fs-hoststats-row">
        <span class="topology-fs-hoststats-label">MEM</span>
        <span class="topology-fs-hoststats-bar"><span class="topology-fs-hoststats-fill" id="tfhsMemFill"></span></span>
        <span class="topology-fs-hoststats-value" id="tfhsMemValue">--</span>
      </div>
      <span class="topology-fs-hoststats-sep"></span>
      <div class="topology-fs-hoststats-row">
        <span class="topology-fs-hoststats-label">CPU</span>
        <span class="topology-fs-hoststats-bar"><span class="topology-fs-hoststats-fill" id="tfhsCpuFill"></span></span>
        <span class="topology-fs-hoststats-value" id="tfhsCpuValue">--</span>
      </div>
    </div>
    <!-- UF-08: view toggle moved to left sidebar (topoNavList / topoNavTopology). -->
  `;
  document.body.appendChild(topbar);

  // ── 5. Right slide-in service detail panel (must come BEFORE addBtn in DOM
  //    so the CSS sibling selector `.topology-fs-panel.open ~ .topology-fs-add-btn`
  //    can hide the Add button when the panel is open). ──
  const panel = document.createElement('div');
  panel.id = 'topologyFsPanel';
  panel.className = 'topology-fs-panel';
  panel.innerHTML = `
    <div class="topology-fs-panel-header">
      <div class="topology-fs-panel-icon" id="topologyFsPanelIcon">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M0 2.75C0 1.784.784 1 1.75 1h12.5c.966 0 1.75.784 1.75 1.75v10.5A1.75 1.75 0 0114.25 15H1.75A1.75 1.75 0 010 13.25V2.75z"/></svg>
      </div>
      <div class="topology-fs-panel-title" id="topologyFsPanelTitle">服务详情</div>
      <button type="button" class="topology-fs-panel-close" onclick="_topologyClosePanel()" title="关闭">✕</button>
    </div>
    <div class="topology-fs-panel-tabs">
      <button type="button" class="topology-fs-panel-tab active" data-tab="details" onclick="_topologySwitchPanelTab('details')">详情</button>
      <button type="button" class="topology-fs-panel-tab" data-tab="buildLogs" onclick="_topologySwitchPanelTab('buildLogs')">构建日志</button>
      <button type="button" class="topology-fs-panel-tab" data-tab="deployLogs" onclick="_topologySwitchPanelTab('deployLogs')">部署日志</button>
      <button type="button" class="topology-fs-panel-tab" data-tab="httpLogs" onclick="_topologySwitchPanelTab('httpLogs')">HTTP 日志</button>
      <button type="button" class="topology-fs-panel-tab" data-tab="variables" onclick="_topologySwitchPanelTab('variables')">环境变量</button>
      <button type="button" class="topology-fs-panel-tab" data-tab="routing" onclick="_topologySwitchPanelTab('routing')">路由</button>
      <button type="button" class="topology-fs-panel-tab" data-tab="tags" onclick="_topologySwitchPanelTab('tags')">备注</button>
      <button type="button" class="topology-fs-panel-tab" data-tab="settings" onclick="_topologySwitchPanelTab('settings')">设置</button>
      <button type="button" class="topology-fs-panel-tab" data-tab="activity" onclick="_topologySwitchPanelTab('activity')">活动</button>
    </div>
    <div class="topology-fs-panel-body" id="topologyFsPanelBody">
      <div class="tfp-empty">点击拓扑节点查看服务详情</div>
    </div>
  `;
  document.body.appendChild(panel);

  // ── 4. Floating "+ Add" button + popover menu ──
  const addBtn = document.createElement('button');
  addBtn.id = 'topologyFsAddBtn';
  addBtn.type = 'button';
  addBtn.className = 'topology-fs-add-btn';
  addBtn.title = '新增服务 / 数据库 / 路由';
  addBtn.onclick = function (e) { e.stopPropagation(); _topologyToggleAddMenu(); };
  addBtn.innerHTML = `
    <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor"><path d="M7.75 2a.75.75 0 01.75.75V7h4.25a.75.75 0 010 1.5H8.5v4.25a.75.75 0 01-1.5 0V8.5H2.75a.75.75 0 010-1.5H7V2.75A.75.75 0 017.75 2z"/></svg>
    Add
  `;
  document.body.appendChild(addBtn);

  const addMenu = document.createElement('div');
  addMenu.id = 'topologyFsAddMenu';
  addMenu.className = 'topology-fs-add-menu';
  addMenu.innerHTML = `
    <input class="topology-fs-add-menu-search" placeholder="你想创建什么?" id="topologyFsAddSearch">
    <button type="button" class="topology-fs-add-menu-item" onclick="_topologyChooseAddItem('git')">
      <span class="icon"><svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg></span>
      <span class="label">GitHub 仓库</span>
      <span class="chevron">›</span>
    </button>
    <button type="button" class="topology-fs-add-menu-item" onclick="_topologyChooseAddItem('database')">
      <span class="icon"><svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M8 1c4 0 7 1 7 2.5v9c0 1.5-3 2.5-7 2.5s-7-1-7-2.5v-9C1 2 4 1 8 1zm0 1.5C5 2.5 2.5 3.4 2.5 4S5 5.5 8 5.5s5.5-.9 5.5-1.5S11 2.5 8 2.5zM2.5 6.7v2.1C2.5 9.3 5 10.2 8 10.2s5.5-.9 5.5-1.4V6.7C12.4 7.4 10.4 8 8 8s-4.4-.6-5.5-1.3zm0 4v1.8c0 .5 2.5 1.5 5.5 1.5s5.5-1 5.5-1.5v-1.8c-1.1.7-3.1 1.3-5.5 1.3s-4.4-.6-5.5-1.3z"/></svg></span>
      <span class="label">数据库 (MongoDB / Redis / Postgres)</span>
      <span class="chevron">›</span>
    </button>
    <button type="button" class="topology-fs-add-menu-item" onclick="_topologyChooseAddItem('docker')">
      <span class="icon"><svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M14 7h-2V5h2v2zm0-3h-2V2h2v2zm-3 3H9V5h2v2zm0-3H9V2h2v2zM8 7H6V5h2v2zm-3 3H3V8h2v2zm3 0H6V8h2v2zm3 0H9V8h2v2zm3 0h-2V8h2v2zm1.6 1c-.4-1-1.4-1.6-2.5-1.6h-1c-.2-2.3-2-3.4-2.1-3.4l-.4-.2-.3.4c-.4.5-.6 1.2-.6 1.9-.1.5 0 .9.2 1.3-.6.3-1.5.4-2.4.4H.4l-.1.7c-.2 1.4.1 2.7.7 3.7.6 1.1 1.7 1.9 3 2.3.9.2 1.8.4 2.7.4 1.4 0 2.7-.3 3.9-.7 1.5-.6 2.7-1.7 3.5-3.2 1.1-.1 2-.7 2.4-1.6l.2-.3-.5-.5z"/></svg></span>
      <span class="label">Docker 镜像</span>
      <span class="chevron">›</span>
    </button>
    <button type="button" class="topology-fs-add-menu-item" onclick="_topologyChooseAddItem('routing')">
      <span class="icon"><svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M8 0a8 8 0 100 16A8 8 0 008 0zM1.5 8a6.5 6.5 0 1113 0 6.5 6.5 0 01-13 0zm6.75 3.25v-2.5a.75.75 0 011.5 0v2.5a.75.75 0 01-1.5 0z"/></svg></span>
      <span class="label">路由规则</span>
      <span class="chevron">›</span>
    </button>
    <button type="button" class="topology-fs-add-menu-item" onclick="_topologyChooseAddItem('volume')">
      <span class="icon"><svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M2 3.75C2 2.784 4.686 2 8 2s6 .784 6 1.75v8.5C14 13.216 11.314 14 8 14s-6-.784-6-1.75v-8.5zm1.5.25c0 .414 2.015.75 4.5.75s4.5-.336 4.5-.75-2.015-.75-4.5-.75-4.5.336-4.5.75zm0 3c0 .414 2.015.75 4.5.75s4.5-.336 4.5-.75V5.5c-.9.4-2.65.625-4.5.625S4.4 5.9 3.5 5.5V7zm0 3c0 .414 2.015.75 4.5.75s4.5-.336 4.5-.75V8.5c-.9.4-2.65.625-4.5.625S4.4 8.9 3.5 8.5V10z"/></svg></span>
      <span class="label">Volume / 持久化卷</span>
      <span class="chevron">›</span>
    </button>
    <button type="button" class="topology-fs-add-menu-item" onclick="_topologyChooseAddItem('empty')">
      <span class="icon"><svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M0 2.75C0 1.784.784 1 1.75 1h12.5c.966 0 1.75.784 1.75 1.75v10.5A1.75 1.75 0 0114.25 15H1.75A1.75 1.75 0 010 13.25V2.75zm1.75-.25a.25.25 0 00-.25.25v10.5c0 .138.112.25.25.25h12.5a.25.25 0 00.25-.25V2.75a.25.25 0 00-.25-.25H1.75z"/></svg></span>
      <span class="label">空服务</span>
      <span class="chevron">›</span>
    </button>
  `;
  document.body.appendChild(addMenu);

  // ── 6. Bottom edit hint ──
  const hint = document.createElement('div');
  hint.id = 'topologyEditHint';
  hint.className = 'topology-edit-hint';
  // UF-06: updated hint to reflect the new Mac trackpad gesture contract.
  hint.textContent = '点击节点查看详情 · 两指滑动平移 · 捏合 / Ctrl+滚轮缩放';
  document.body.appendChild(hint);

  // Click outside add menu → close
  document.addEventListener('click', function (e) {
    var menu = document.getElementById('topologyFsAddMenu');
    var btn = document.getElementById('topologyFsAddBtn');
    if (!menu || !btn) return;
    if (menu.classList.contains('open') && !menu.contains(e.target) && !btn.contains(e.target)) {
      menu.classList.remove('open');
    }
  });

  // UF-07: wire up the branch combobox search input. Using addEventListener
  // (not inline oninput) so we can capture both 'input' and 'keydown' on
  // the same element without attribute bloat in the HTML template.
  var comboSearch = document.getElementById('topologyFsBranchComboSearch');
  if (comboSearch) {
    comboSearch.addEventListener('input', function (e) {
      _topologyBranchComboOnInput(e.target.value);
    });
    comboSearch.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') {
        e.preventDefault();
        _topologyBranchComboOnEnter();
      } else if (e.key === 'Escape') {
        _topologyBranchComboClose();
      }
    });
  }
  // UF-07: click outside the combobox → close popover
  document.addEventListener('click', function (e) {
    var combo = document.getElementById('topologyFsBranchCombo');
    if (!combo || !combo.classList.contains('open')) return;
    if (!combo.contains(e.target)) _topologyBranchComboClose();
  });

  // UF-19: ESC key closes the Details panel. Before this fix the panel
  // could only be dismissed by hitting the (partially hidden) close X
  // button in the panel header. ESC is the universal "get me out of
  // this modal-ish thing" key and users tried it unsuccessfully.
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    var panel = document.getElementById('topologyFsPanel');
    if (panel && panel.classList.contains('open')) {
      e.preventDefault();
      _topologyClosePanel();
    }
  });

  // UF-19: clicking on empty canvas space (not on a node, not on the
  // panel) closes the Details panel too. Mirrors the Figma / Miro
  // pattern where clicking background deselects. We hook into the
  // existing `mousedown` on the canvas wrap and close the panel if
  // the click isn't on a node or on the panel itself.
  var canvasWrap = document.querySelector('.topology-canvas-wrap');
  if (canvasWrap) {
    canvasWrap.addEventListener('click', function (e) {
      // Only close if: click is on the wrap itself (empty space), not
      // a node, and the panel is open.
      if (e.target.closest('.topology-node')) return;
      var panel = document.getElementById('topologyFsPanel');
      if (panel && panel.classList.contains('open')
          && !panel.contains(e.target)) {
        _topologyClosePanel();
      }
    });
  }

  // Best-effort populate the project name + branch dropdown.
  if (projectId && projectId !== 'default') {
    fetch('/api/projects/' + encodeURIComponent(projectId), { credentials: 'same-origin' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (body) {
        if (body && body.name) {
          var el = document.getElementById('topologyFsProjectName');
          if (el) el.textContent = body.name;
        }
      })
      .catch(function () { /* quiet */ });
  } else {
    fetch('/api/projects', { credentials: 'same-origin' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (body) {
        if (body && body.projects && body.projects.length) {
          var legacy = body.projects.find(function (p) { return p.legacyFlag; });
          if (legacy) {
            var el = document.getElementById('topologyFsProjectName');
            if (el) el.textContent = legacy.name;
          }
        }
      })
      .catch(function () { /* quiet */ });
  }

  // Populate the branch dropdown from the global `branches` array if it's
  // already loaded, otherwise leave it for the next render cycle.
  if (typeof _topologyRefreshBranchDropdown === 'function') {
    _topologyRefreshBranchDropdown();
  }
}

/**
 * Kahn's algorithm over buildProfiles + infraServices.
 * Returns { layers: NodeDef[][], edges: {from, to}[] }
 * Infra services without dependencies all sit at layer 0 (bottom).
 * App profiles are layered by depends_on depth.
 */
function _layoutTopologyDag(profiles, infraList) {
  const nodes = new Map();
  const appNodes = [];
  const infraNodes = [];

  for (const p of profiles) {
    const node = { id: p.id, kind: 'app', raw: p };
    nodes.set(p.id, node);
    appNodes.push(node);
  }
  for (const s of infraList) {
    if (!nodes.has(s.id)) {
      const node = { id: s.id, kind: 'infra', raw: s };
      nodes.set(s.id, node);
      infraNodes.push(node);
    }
  }

  // Stable alphabetical sort within each tier
  appNodes.sort((a, b) => a.id.localeCompare(b.id));
  infraNodes.sort((a, b) => a.id.localeCompare(b.id));

  // Edges from dependsOn declarations
  const edges = [];
  for (const p of profiles) {
    for (const depId of p.dependsOn || []) {
      if (nodes.has(depId)) edges.push({ from: depId, to: p.id });
    }
  }

  // Forced 2-tier layout: infra always bottom (layers[0]),
  // apps always top (layers[1]).  _renderTopologySvg reverses
  // layer index so layers[0] → displayRow=bottom, layers[1] → top.
  // This guarantees admin (app with no deps) stays in the top row
  // alongside api, not mixed into the infra row.
  const layers = [];
  if (infraNodes.length > 0) layers.push(infraNodes);
  if (appNodes.length > 0) layers.push(appNodes);
  if (layers.length === 0) layers.push([]);

  return { layers, edges, nodes };
}

// ── Aggregated layout (shared view B) ─────────────────────────────────
//
// When no branch is selected (共享视图) and the project has tracked
// branches, we expand each BuildProfile into N cards — one per branch.
// All branch-instance cards remain connected to the same shared infra
// services below, giving the user a cross-branch operational overview.
//
// Layout:
//   - Rows (app tiers) = one per BuildProfile, sorted alphabetically
//   - Within each row, one card per branch (columns, sorted by branchId)
//   - Bottom row = shared infra services
//
// Returned shape is identical to _layoutTopologyDag so _renderTopologySvg
// can render it without modification (node.aggregated flag carries extra
// meta for the branch sub-label).
// Max branches shown per visual column-group. Beyond this, rows wrap
// into a second group below — keeps canvas width at ≤4×(280+110)px.
const MAX_AGG_COLS = 4;

function _layoutTopologyAggregated(profiles, infraList, allBranches) {
  if (!allBranches || allBranches.length === 0) {
    return _layoutTopologyDag(profiles, infraList);
  }

  const nodes = new Map();
  const infraNodes = [];
  const sortedProfiles = [...profiles].sort((a, b) => (a.id || '').localeCompare(b.id || ''));
  const sortedBranches = [...allBranches].sort((a, b) => (a.id || '').localeCompare(b.id || ''));

  // Infra nodes (shared — single set at the bottom)
  for (const s of infraList) {
    if (!nodes.has(s.id)) {
      const node = { id: s.id, kind: 'infra', raw: s };
      nodes.set(s.id, node);
      infraNodes.push(node);
    }
  }
  infraNodes.sort((a, b) => a.id.localeCompare(b.id));

  // App nodes: each (profile × branch) pair
  for (const p of sortedProfiles) {
    for (const b of sortedBranches) {
      const syntheticId = p.id + '@' + b.id;
      nodes.set(syntheticId, {
        id: syntheticId,
        kind: 'app',
        aggregated: true,
        profileId: p.id,
        branchId: b.id,
        raw: Object.assign({}, p, {
          id: syntheticId,
          status: b.status || 'unknown',
          _branchLabel: b.branch || b.id,
          _profileId: p.id,
        }),
      });
    }
  }

  // Edges: infra → each branch instance of a profile that depends on it
  const edges = [];
  for (const p of sortedProfiles) {
    for (const depId of p.dependsOn || []) {
      if (nodes.has(depId)) {
        for (const b of sortedBranches) {
          edges.push({ from: depId, to: p.id + '@' + b.id });
        }
      }
    }
  }

  // ── Grid layout: wrap branches into groups of MAX_AGG_COLS ──────────
  // Groups are stacked vertically; within each group, profiles form rows.
  // This keeps canvas width at ≤4 cards wide regardless of branch count.
  const numBranches = sortedBranches.length;
  const numProfiles = sortedProfiles.length;
  const numCols = Math.min(numBranches, MAX_AGG_COLS);
  const numGroups = Math.ceil(numBranches / MAX_AGG_COLS);

  // Width of the widest column-group (may be narrower for the last group)
  const sectionW = numCols * TOPO_NODE_W + Math.max(0, numCols - 1) * TOPO_GAP_X;
  // Height of one profile-group block (all profiles stacked)
  const groupBlockH = numProfiles * TOPO_NODE_H + Math.max(0, numProfiles - 1) * TOPO_GAP_Y;

  const positions = new Map();

  for (let g = 0; g < numGroups; g++) {
    const groupTopY = TOPO_PAD + g * (groupBlockH + TOPO_SECTION_GAP_Y);
    const colsInGroup = Math.min(MAX_AGG_COLS, numBranches - g * MAX_AGG_COLS);
    const groupW = colsInGroup * TOPO_NODE_W + Math.max(0, colsInGroup - 1) * TOPO_GAP_X;
    const groupOffsetX = (sectionW - groupW) / 2; // center partial last group

    for (let pi = 0; pi < numProfiles; pi++) {
      const p = sortedProfiles[pi];
      const rowY = groupTopY + pi * (TOPO_NODE_H + TOPO_GAP_Y);
      for (let ci = 0; ci < colsInGroup; ci++) {
        const branchIdx = g * MAX_AGG_COLS + ci;
        const b = sortedBranches[branchIdx];
        const syntheticId = p.id + '@' + b.id;
        positions.set(syntheticId, {
          x: TOPO_PAD + groupOffsetX + ci * (TOPO_NODE_W + TOPO_GAP_X),
          y: rowY,
          node: nodes.get(syntheticId),
        });
      }
    }
  }

  // Infra row at bottom, centered under the section width
  const infraY = TOPO_PAD + numGroups * (groupBlockH + TOPO_SECTION_GAP_Y);
  const infraRowW = infraNodes.length > 0
    ? infraNodes.length * TOPO_NODE_W + Math.max(0, infraNodes.length - 1) * TOPO_GAP_X
    : 0;
  const infraOffX = (sectionW - infraRowW) / 2;
  for (let ii = 0; ii < infraNodes.length; ii++) {
    const node = infraNodes[ii];
    positions.set(node.id, {
      x: TOPO_PAD + infraOffX + ii * (TOPO_NODE_W + TOPO_GAP_X),
      y: infraY,
      node,
    });
  }

  const svgW = TOPO_PAD * 2 + sectionW;
  const svgH = infraY + (infraNodes.length > 0 ? TOPO_NODE_H : 0) + TOPO_PAD;

  return { nodes, edges, positions, aggregated: true, svgW, svgH };
}

// ── Rich card renderer ────────────────────────────────────────────────
//
// UF-05 (2026-04-15): card style redesigned to match Railway's topology
// view (the reference image the user called "图1"). Changes vs the first
// draft:
//
//   - Card geometry bumped from 236×110 → 280×150 so the content
//     breathes instead of colliding with the border
//   - Dropped the 3rd/4th text rows (image + port) from the main body —
//     they now live in the details panel that opens on click. Cards now
//     show ONLY name + status, matching figure 1's airy look.
//   - Infra services with named volumes get a dedicated bottom "volume
//     slot": a subtle inner divider + disk icon + volume name, occupying
//     the lower third of the card. App services skip the slot.
//   - Border radius unified at 18px (was 12/26 split). Both apps and
//     infra now use rounded rects — figure 1 uses the same shape for
//     Redis and MongoDB.
//   - Edges switched from bezier curves to orthogonal (manhattan)
//     routing with dashed stroke. Matches figure 1's HVH routing.

// Card geometry — tuned to match figure 1's proportions
const TOPO_NODE_W = 280;
const TOPO_NODE_H = 150;
const TOPO_VOLUME_SLOT_H = 38;  // bottom volume slot for infra with volumes
const TOPO_GAP_X = 110;
const TOPO_SECTION_GAP_Y = 84; // extra vertical gap between branch column-groups (leaves room for labels)
const TOPO_GAP_Y = 48;
const TOPO_PAD = 48;
const TOPO_NODE_RADIUS = 18;

/**
 * Pick a 1-char emoji icon for a service based on its image / id.
 * Falls back to 📦 for unknown app services and 💾 for unknown infra.
 */
// UF-21: SVG icon library for topology node cards. Previously this
// returned raw emoji glyphs (🍃 🔺 🐘 🟢 …) which looked "廉价" per
// the user's feedback — emojis render inconsistently across fonts and
// don't match Railway's clean brand-neutral vector style.
//
// Each entry returns an <svg> string that:
//   - Uses 22×22 viewBox (fits the 22px-sized `.topology-node-icon` CSS)
//   - Uses currentColor for fill so CSS can tint it per-state
//   - Uses a per-service brand hue as default fill
//
// For APP services (node.kind === 'app'): we show the GitHub mark
// unconditionally. Every app in CDS comes from a git repo — the
// stack (Node / .NET / Python / Rust) is already visible from the
// image tag row and doesn't need its own icon on the header. This
// matches the Railway reference screenshot the user pasted.
//
// For INFRA services: we fall back to service-specific logos.
const _TOPO_ICON_GITHUB =
  '<svg width="22" height="22" viewBox="0 0 22 22" aria-hidden="true">' +
    '<path fill="#c9d1d9" d="M11 0C4.924 0 0 4.924 0 11c0 4.862 3.152 8.986 7.525 10.444.55.1.75-.238.75-.53 0-.262-.01-1.128-.015-2.045-3.063.666-3.708-1.296-3.708-1.296-.5-1.271-1.22-1.61-1.22-1.61-1-.682.076-.668.076-.668 1.104.078 1.686 1.134 1.686 1.134.982 1.683 2.576 1.197 3.203.915.1-.712.385-1.198.7-1.473-2.444-.278-5.014-1.222-5.014-5.44 0-1.202.43-2.184 1.134-2.954-.114-.278-.492-1.398.108-2.914 0 0 .924-.296 3.026 1.128A10.49 10.49 0 0111 5.317c.934.004 1.876.126 2.754.37 2.1-1.424 3.023-1.128 3.023-1.128.602 1.516.223 2.636.109 2.914.706.77 1.133 1.752 1.133 2.954 0 4.228-2.574 5.16-5.026 5.432.395.341.747 1.01.747 2.037 0 1.471-.013 2.656-.013 3.018 0 .294.198.636.755.529C18.85 19.98 22 15.858 22 11 22 4.924 17.076 0 11 0z"/>' +
  '</svg>';
const _TOPO_ICON_MONGO =
  '<svg width="22" height="22" viewBox="0 0 22 22" aria-hidden="true">' +
    '<path fill="#13aa52" d="M11 1c-.8 2.5-2.3 4.3-3.7 5.6C5.7 8 4.5 9.9 4.5 13c0 2.8 1.3 5.3 3.3 6.9.6.5 1.3.9 2 1.3l.5-.5c0-.1-.1-.2-.1-.3-.7-.9-1.2-2.1-1.2-3.4V9.3c0-1 .1-1.8.3-2.4.2-.7.5-1.3.9-2C10.6 3.9 11 2.9 11 2v-1z"/>' +
    '<path fill="#1e6f3d" d="M11 1v1c0 .9.4 1.9.8 2.9.4.7.7 1.3.9 2 .2.6.3 1.4.3 2.4v7.7c0 1.3-.4 2.5-1.2 3.4-.1.1-.2.2-.1.3l.5.5c.7-.4 1.4-.8 2-1.3 2-1.6 3.3-4.1 3.3-6.9 0-3.1-1.2-5-2.8-6.4C13.3 5.3 11.8 3.5 11 1z"/>' +
    '<rect x="10.5" y="19" width="1" height="2" fill="#13aa52"/>' +
  '</svg>';
const _TOPO_ICON_REDIS =
  '<svg width="22" height="22" viewBox="0 0 22 22" aria-hidden="true">' +
    '<path fill="#d82c20" d="M11 2.5L2 7l9 4.5L20 7l-9-4.5z"/>' +
    '<path fill="#a41e1e" d="M2 10l9 4.5L20 10v1.5L11 16l-9-4.5V10z"/>' +
    '<path fill="#d82c20" d="M2 13.5l9 4.5 9-4.5V15l-9 4.5-9-4.5v-1.5z"/>' +
  '</svg>';
const _TOPO_ICON_POSTGRES =
  '<svg width="22" height="22" viewBox="0 0 22 22" aria-hidden="true">' +
    '<ellipse cx="11" cy="4" rx="8" ry="2.5" fill="#336791"/>' +
    '<path fill="#336791" d="M3 4v14c0 1.4 3.6 2.5 8 2.5s8-1.1 8-2.5V4c0 1.4-3.6 2.5-8 2.5S3 5.4 3 4z"/>' +
    '<path fill="#1d4770" fill-opacity="0.4" d="M3 10v1c0 1.4 3.6 2.5 8 2.5s8-1.1 8-2.5v-1c0 1.4-3.6 2.5-8 2.5S3 11.4 3 10z"/>' +
  '</svg>';
const _TOPO_ICON_MYSQL =
  '<svg width="22" height="22" viewBox="0 0 22 22" aria-hidden="true">' +
    '<ellipse cx="11" cy="4" rx="8" ry="2.5" fill="#4479a1"/>' +
    '<path fill="#4479a1" d="M3 4v14c0 1.4 3.6 2.5 8 2.5s8-1.1 8-2.5V4c0 1.4-3.6 2.5-8 2.5S3 5.4 3 4z"/>' +
    '<path fill="#f29111" fill-opacity="0.8" d="M15 14l-2-2 2-2 2 2-2 2z"/>' +
  '</svg>';
const _TOPO_ICON_NGINX =
  '<svg width="22" height="22" viewBox="0 0 22 22" aria-hidden="true">' +
    '<path fill="#009639" d="M11 2L3 6.5v9L11 20l8-4.5v-9L11 2zm4.5 12L11 16.5 6.5 14V8L11 5.5 15.5 8v6z"/>' +
    '<path fill="#fff" d="M9 8v6h1.3V10l2.4 4H14V8h-1.3v4l-2.4-4H9z"/>' +
  '</svg>';
const _TOPO_ICON_KAFKA =
  '<svg width="22" height="22" viewBox="0 0 22 22" aria-hidden="true">' +
    '<circle cx="5" cy="11" r="2" fill="#231f20"/>' +
    '<circle cx="11" cy="5" r="2" fill="#231f20"/>' +
    '<circle cx="11" cy="17" r="2" fill="#231f20"/>' +
    '<circle cx="17" cy="11" r="2" fill="#231f20"/>' +
    '<line x1="5" y1="11" x2="11" y2="5" stroke="#666" stroke-width="1"/>' +
    '<line x1="5" y1="11" x2="11" y2="17" stroke="#666" stroke-width="1"/>' +
    '<line x1="17" y1="11" x2="11" y2="5" stroke="#666" stroke-width="1"/>' +
    '<line x1="17" y1="11" x2="11" y2="17" stroke="#666" stroke-width="1"/>' +
  '</svg>';
const _TOPO_ICON_GENERIC_DB =
  '<svg width="22" height="22" viewBox="0 0 22 22" aria-hidden="true">' +
    '<ellipse cx="11" cy="5" rx="7" ry="2.2" fill="#6366f1"/>' +
    '<path fill="#6366f1" d="M4 5v12c0 1.2 3.1 2.2 7 2.2s7-1 7-2.2V5c0 1.2-3.1 2.2-7 2.2S4 6.2 4 5z"/>' +
  '</svg>';

function _topologyNodeIcon(node) {
  const raw = node.raw;
  const image = (raw.dockerImage || '').toLowerCase();
  const id = (raw.id || '').toLowerCase();
  if (node.kind === 'infra') {
    if (image.includes('mongo') || id.includes('mongo')) return _TOPO_ICON_MONGO;
    if (image.includes('redis') || id.includes('redis')) return _TOPO_ICON_REDIS;
    if (image.includes('postgres')) return _TOPO_ICON_POSTGRES;
    if (image.includes('mysql') || image.includes('mariadb')) return _TOPO_ICON_MYSQL;
    if (image.includes('nginx') || image.includes('caddy')) return _TOPO_ICON_NGINX;
    if (image.includes('kafka') || image.includes('rabbit')) return _TOPO_ICON_KAFKA;
    return _TOPO_ICON_GENERIC_DB;
  }
  // App services: always GitHub — matches Railway's reference screenshot.
  // Stack detection (Node/.NET/Python/etc) lives in the image tag row
  // below the title, so a per-stack icon on the header is redundant.
  return _TOPO_ICON_GITHUB;
}

/**
 * Shorten a docker image name for display. "mcr.microsoft.com/dotnet/sdk:8.0"
 * becomes "dotnet/sdk:8.0". "node:20-alpine" stays as-is.
 */
function _shortenImage(img) {
  if (!img) return '(no image)';
  // Strip common registry prefixes
  const stripped = img
    .replace(/^mcr\.microsoft\.com\//, '')
    .replace(/^docker\.io\//, '')
    .replace(/^registry-1\.docker\.io\//, '');
  // If still too long, keep the last 2 segments + tag
  if (stripped.length <= 28) return stripped;
  const [imageName, tag] = stripped.split(':');
  const parts = imageName.split('/');
  const short = parts.slice(-2).join('/');
  return tag ? `${short}:${tag}` : short;
}

/**
 * Resolve the runtime status of a node for the currently-selected branch.
 * Returns one of: 'running' | 'building' | 'error' | 'stopped' | 'idle' | 'unknown'.
 */
function _topologyNodeStatus(node, selectedBranchId) {
  if (node.kind === 'infra') {
    return node.raw.status || 'unknown'; // running/stopped/error
  }
  // Aggregated shared-view nodes carry status from the branch object
  // directly (set during layout: raw.status = branch.status).
  if (node.aggregated) {
    return node.raw.status || 'unknown';
  }
  // App service: look up the selected branch's services map
  if (!selectedBranchId) return 'unknown';
  const branch = branches.find(b => b.id === selectedBranchId);
  if (!branch) return 'unknown';
  // UF-22: surface "building" state even before the per-service map
  // has entries. During a fresh deploy the branch-level status flips
  // to 'building' first, then services populate. Without this check
  // the node card shows "unknown/--" for the first chunk of the
  // deploy, which is exactly the "没有明显的部署效果" complaint.
  if (busyBranches.has(selectedBranchId) || branch.status === 'building' || branch.status === 'starting') {
    return 'building';
  }
  if (branch.status === 'stopping') return 'stopped';
  const svc = branch.services?.[node.raw.id];
  if (!svc) return 'unknown';
  return svc.status || 'idle';
}

function _renderTopologySvg(layout, ctx) {
  const { overrideSet, overrideDetails, selectedBranchId, selectedNodeId } = ctx;

  let positions, totalW, totalH;

  if (layout.positions) {
    // Pre-computed grid positions (aggregated multi-row layout).
    // Apply per-node drag offsets on top of the static base positions.
    positions = new Map();
    layout.positions.forEach((pos, id) => {
      const drag = _topologyNodeDragOffsets[id] || { dx: 0, dy: 0 };
      positions.set(id, { x: pos.x + drag.dx, y: pos.y + drag.dy, node: pos.node });
    });
    totalW = layout.svgW;
    totalH = layout.svgH;
  } else {
    // Layer-based layout (regular per-branch DAG view).
    positions = new Map();
    let maxLayerLen = 0;
    layout.layers.forEach(layer => {
      if (layer.length > maxLayerLen) maxLayerLen = layer.length;
    });
    const numLayers = layout.layers.length;
    layout.layers.forEach((layer, layerIdx) => {
      const displayRow = numLayers - 1 - layerIdx;
      const layerWidth = layer.length * (TOPO_NODE_W + TOPO_GAP_X) - TOPO_GAP_X;
      const maxWidth = maxLayerLen * (TOPO_NODE_W + TOPO_GAP_X) - TOPO_GAP_X;
      const offsetX = (maxWidth - layerWidth) / 2;
      layer.forEach((node, idxInLayer) => {
        const baseX = TOPO_PAD + offsetX + idxInLayer * (TOPO_NODE_W + TOPO_GAP_X);
        const baseY = TOPO_PAD + displayRow * (TOPO_NODE_H + TOPO_GAP_Y);
        const drag = _topologyNodeDragOffsets[node.id] || { dx: 0, dy: 0 };
        positions.set(node.id, { x: baseX + drag.dx, y: baseY + drag.dy, node });
      });
    });
    totalW = TOPO_PAD * 2 + maxLayerLen * TOPO_NODE_W + Math.max(0, maxLayerLen - 1) * TOPO_GAP_X;
    totalH = TOPO_PAD * 2 + numLayers * TOPO_NODE_H + Math.max(0, numLayers - 1) * TOPO_GAP_Y;
  }

  // Compute which edges are connected to the currently-selected node
  // (both directions) for highlight/dim.
  const connectedEdgeIdx = new Set();
  const connectedNodeIds = new Set();
  if (selectedNodeId) {
    connectedNodeIds.add(selectedNodeId);
    layout.edges.forEach((e, idx) => {
      if (e.from === selectedNodeId || e.to === selectedNodeId) {
        connectedEdgeIdx.add(idx);
        connectedNodeIds.add(e.from);
        connectedNodeIds.add(e.to);
      }
    });
  }

  // Top-to-bottom orthogonal edge routing (VHV):
  //
  //        app (top)
  //          ↑
  //     ─────┘
  //     │
  //   infra (bottom)
  //
  // Edges exit from the TOP of the source (infra) card and enter at the
  // BOTTOM of the destination (app) card. Rounded corners at each bend.
  const edgePaths = layout.edges.map((edge, idx) => {
    const from = positions.get(edge.from);
    const to = positions.get(edge.to);
    if (!from || !to) return '';
    // Vertical exit: center-top of source; vertical entry: center-bottom of dest
    const cx1 = from.x + TOPO_NODE_W / 2;
    const y1 = from.y;                    // top edge of source (infra)
    const cx2 = to.x + TOPO_NODE_W / 2;
    const y2 = to.y + TOPO_NODE_H;       // bottom edge of dest (app)
    const midY = (y1 + y2) / 2;
    const r = 8; // corner radius
    // VHV orthogonal path: vertical up → horizontal → vertical up
    let d;
    if (Math.abs(cx1 - cx2) < 1) {
      // Straight vertical — no bends needed
      d = `M ${cx1} ${y1} L ${cx2} ${y2}`;
    } else {
      const goingLeft = cx2 < cx1;
      const bendX1 = goingLeft ? cx1 - r : cx1 + r;
      const bendX2 = goingLeft ? cx2 + r : cx2 - r;
      d = `M ${cx1} ${y1}
           L ${cx1} ${midY + r}
           Q ${cx1} ${midY}, ${bendX1} ${midY}
           L ${bendX2} ${midY}
           Q ${cx2} ${midY}, ${cx2} ${midY - r}
           L ${cx2} ${y2}`;
    }
    let cls = 'topology-edge';
    if (selectedNodeId) {
      if (connectedEdgeIdx.has(idx)) cls += ' highlighted';
      else cls += ' dimmed';
    }
    return `<path class="${cls}" d="${d}" />`;
  }).join('');

  // UF-05: Card layout matches figure 1 — airy top region with icon +
  // name + status, optional bottom "volume slot" for infra services
  // that declare named volumes. Image/port/deps are intentionally
  // dropped from the main card to reduce visual clutter; they're
  // still available in the click-to-inspect details panel.
  const nodeEls = Array.from(positions.values()).map(({ x, y, node }) => {
    const isApp = node.kind === 'app';
    const raw = node.raw;
    // In aggregated shared-view nodes, show the profile name (not the synthetic
    // "profileId@branchId" id) as the card title.
    const displayName = node.aggregated ? (raw.name || node.profileId || raw._profileId || raw.id) : (raw.name || raw.id);
    const title = esc(displayName);
    const icon = _topologyNodeIcon(node);
    const status = _topologyNodeStatus(node, selectedBranchId);
    const statusLabel = {
      running: '运行中', building: '构建中', error: '错误',
      stopped: '已停止', idle: '待命', starting: '启动中', unknown: '--',
    }[status] || '--';

    // Pick the first named volume (if any) for the bottom slot.
    // Infra services use `raw.volumes: InfraVolume[]`; apps don't
    // carry declared volumes here, so they always skip the slot.
    const firstVolume = (!isApp && Array.isArray(raw.volumes) && raw.volumes.length > 0)
      ? raw.volumes[0]
      : null;
    // firstVolume.name holds either a Docker named-volume name
    // (e.g. "cds-mongodb-data") for type='volume' or a host path
    // for type='bind'. Fall back to containerPath if name is empty.
    const volumeName = firstVolume
      ? esc(firstVolume.name || firstVolume.containerPath || '')
      : '';
    const hasVolumeSlot = !!volumeName;

    const hasOverride = isApp && overrideSet && overrideSet.has(raw.id);
    const overriddenFields = hasOverride && overrideDetails
      ? (overrideDetails.get(raw.id) || [])
      : [];
    const tooltip = hasOverride
      ? `${raw.name} — 本分支自定义: ${overriddenFields.join(', ') || '(未知字段)'}`
      : `${raw.name || raw.id}（${isApp ? '应用服务' : '基础设施'}）`;

    // Unified shape: both apps and infra use a rounded rect with the
    // same radius. Matches figure 1's uniform card silhouette.
    const shapeClass = 'topology-node-box';

    // Override pill in top-right corner
    const overridePill = hasOverride
      ? `<g>
          <rect x="${x + TOPO_NODE_W - 82}" y="${y + 18}" width="66" height="22" rx="11" fill="var(--accent-bg,rgba(16,185,129,0.12))" stroke="var(--accent,#10b981)" stroke-width="1" />
          <text x="${x + TOPO_NODE_W - 49}" y="${y + 33}" text-anchor="middle" fill="var(--accent,#10b981)" font-size="11" font-weight="600">自定义</text>
        </g>`
      : '';

    // Dim nodes not connected to the selection
    let nodeClass = 'topology-node';
    if (hasOverride) nodeClass += ' has-override';
    if (selectedNodeId === raw.id) nodeClass += ' selected';
    else if (selectedNodeId && !connectedNodeIds.has(raw.id)) nodeClass += ' dimmed';
    // UF-22: card-level deploy animation. Highlights the border +
    // adds a scanning beam when the node's branch is currently
    // deploying or starting. Mirrors the list-view's per-card glow.
    if (status === 'building' || status === 'starting') nodeClass += ' is-building';
    if (status === 'error') nodeClass += ' is-error';

    const clickHandler = isApp
      ? `onclick="event.stopPropagation();_topologyNodeClick('${esc(raw.id)}')"`
      : `onclick="event.stopPropagation();_topologyInfraClick('${esc(raw.id)}')"`;

    // Branch pill removed in aggregated view — the group-box label now shows
    // the branch name prominently above each column, eliminating the need for
    // a per-card tag that clutters every card in the grid.
    const branchPill = '';

    // Layout coordinates inside the card:
    //   top content area  = y .. y + (NODE_H - VOLUME_SLOT_H)
    //   bottom slot area  = y + (NODE_H - VOLUME_SLOT_H) .. y + NODE_H
    // When there's no volume slot the top area fills the whole card.
    const topAreaH = hasVolumeSlot ? (TOPO_NODE_H - TOPO_VOLUME_SLOT_H) : TOPO_NODE_H;
    // UF-21: icon is now a 22×22 SVG (not a text glyph), so we wrap it
    // in an <svg> sub-element positioned via x/y attributes and a
    // transform. The icon itself already uses currentColor for fills
    // where possible so CSS can tint it.
    const iconX = x + 20;                   // left inset for 22px icon
    const iconY = y + 32;                   // vertical placement in header row
    const titleX = x + 56;                  // shifted right to clear the icon
    const titleY = y + 50;
    const statusDotX = x + 32;
    const statusDotY = y + topAreaH - 34;  // ~34px above the bottom of the top area
    const statusLabelX = x + 46;
    const statusLabelY = y + topAreaH - 29;
    // Volume slot divider + content
    const slotTopY = y + topAreaH;
    const slotLineY = slotTopY;            // y of the inner divider line
    const slotTextY = slotTopY + 24;
    const slotIconX = x + 30;
    const slotTextX = x + 54;

    // UF-21: proper disk glyph for the bottom volume slot — matches the
    // clean disk-drawer icon Railway uses. SVG sits left-of the volume
    // name. The y-offset centers it against the text baseline.
    const volumeSlotSvg = hasVolumeSlot
      ? `
        <line class="topology-node-divider" x1="${x + 20}" y1="${slotLineY}" x2="${x + TOPO_NODE_W - 20}" y2="${slotLineY}" />
        <g class="topology-node-slot-icon-wrap" transform="translate(${x + 20} ${slotTextY - 10})">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
            <rect x="2" y="4" width="12" height="8" rx="1.2" ry="1.2" stroke="currentColor" stroke-width="1.2" fill="none" opacity="0.9"/>
            <line x1="2" y1="8" x2="14" y2="8" stroke="currentColor" stroke-width="1" opacity="0.5"/>
            <circle cx="4.2" cy="10" r="0.7" fill="currentColor"/>
            <circle cx="6.2" cy="10" r="0.7" fill="currentColor"/>
          </svg>
        </g>
        <text class="topology-node-slot-label" x="${x + 40}" y="${slotTextY}">${volumeName}</text>
      `
      : '';

    // GAP-08: clickable port badge on the card, mirroring Railway's
    // top-right "endpoint" pill. Click → copy `host:port` to clipboard.
    // Double-click → open preview (delegates to previewBranch when a
    // branch is selected, else opens the raw `host:port` URL).
    //
    // GAP-09: also doubles as the Quick Action "preview" affordance,
    // matching list view's quick action row. We intentionally keep it
    // minimal on the SVG card so the layout stays clean — richer
    // actions (stop/delete/redeploy) live in the Details panel (GAP-01/02).
    const hostPort = isApp ? raw.containerPort : raw.hostPort;
    const hostPortLabel = hostPort ? ':' + hostPort : '';
    const portBadgeSvg = hostPortLabel
      ? `<g class="topology-node-port-badge"
             onclick="event.stopPropagation();_topologyNodePortClick('${esc(raw.id)}')"
             ondblclick="event.stopPropagation();_topologyNodePortDblClick('${esc(raw.id)}')">
          <rect x="${x + TOPO_NODE_W - 92}" y="${y + TOPO_NODE_H - 42}" width="72" height="22" rx="11"
                fill="var(--bg-elevated,#24272f)" stroke="var(--card-border,rgba(255,255,255,0.1))" stroke-width="1" />
          <text x="${x + TOPO_NODE_W - 56}" y="${y + TOPO_NODE_H - 26}"
                text-anchor="middle" fill="var(--text-secondary,#c0c0d0)"
                font-size="11" font-family="var(--font-mono,monospace)"
                style="pointer-events:none">${esc(hostPortLabel)}</text>
        </g>`
      : '';

    const effectiveNodeH = hasVolumeSlot ? (TOPO_NODE_H + TOPO_VOLUME_SLOT_H) : TOPO_NODE_H;
    return `
      <g class="${nodeClass}" data-node-id="${esc(raw.id)}" ${clickHandler}>
        <title>${esc(tooltip)}</title>
        <rect class="${shapeClass}" x="${x}" y="${y}" width="${TOPO_NODE_W}" height="${effectiveNodeH}" rx="${TOPO_NODE_RADIUS}" ry="${TOPO_NODE_RADIUS}" />

        <!-- UF-21: Icon + Name header. Icon is now a 22×22 SVG embedded
             via a <g> with transform instead of a <text> glyph. -->
        <g class="topology-node-icon-wrap" transform="translate(${iconX} ${iconY})">${icon}</g>
        <text class="topology-node-label" x="${titleX}" y="${titleY}">${title}</text>

        <!-- Status dot + label -->
        <circle class="topology-node-status-dot ${status}" cx="${statusDotX}" cy="${statusDotY}" r="6" />
        <text class="topology-node-status-label" x="${statusLabelX}" y="${statusLabelY}">${esc(statusLabel)}</text>

        ${volumeSlotSvg}
        ${portBadgeSvg}
        ${overridePill}
        ${branchPill}
      </g>
    `;
  }).join('');

  // Group box(es) behind all nodes.
  // • Aggregated view: one dashed box per branch-column, labelled with the branch name.
  // • Single-branch view: one "Apps" box around all app nodes.
  let appGroupRect = '';
  const appPositions = Array.from(positions.values()).filter(p => p.node.kind === 'app');

  if (layout.aggregated && appPositions.length > 0) {
    // Build per-branch column boxes.
    const branchMap = new Map(); // branchId → {xs[], ys[], label}
    appPositions.forEach(({x, y, node}) => {
      const bid = node.branchId;
      if (!branchMap.has(bid)) {
        const rawLabel = (node.raw && node.raw._branchLabel) ? node.raw._branchLabel : bid;
        branchMap.set(bid, { xs: [], ys: [], label: rawLabel });
      }
      const e = branchMap.get(bid);
      e.xs.push(x, x + TOPO_NODE_W);
      e.ys.push(y, y + TOPO_NODE_H);
    });

    const BGP = 14;        // box padding around node bounding box
    const LH  = 20;        // label pill height
    const LR  = 10;        // label pill border-radius
    const LPX = 10;        // label pill horizontal inner padding

    branchMap.forEach(({xs, ys, label}) => {
      const bx  = Math.min(...xs) - BGP;
      const by  = Math.min(...ys) - BGP;
      const bx2 = Math.max(...xs) + BGP;
      const by2 = Math.max(...ys) + BGP;
      const bw  = bx2 - bx;
      const bh  = by2 - by;

      // Truncate long names: keep prefix up to 18 chars, then ellipsis + last 6
      const MAX_L = 22;
      const dispLabel = '@' + (label.length > MAX_L ? label.slice(0, 10) + '…' + label.slice(-10) : label);
      // Approximate label pill width (JetBrains Mono ~6.5px/char at 10px)
      const labelW = Math.min(bw - 4, dispLabel.length * 6.5 + LPX * 2);
      const labelX = bx + 4;
      const labelY = by - LH + 2; // pill sits just above the box top edge

      appGroupRect += `
        <rect class="topology-branch-group" x="${bx}" y="${by}" width="${bw}" height="${bh}" rx="16"/>
        <rect class="topology-branch-group-pill" x="${labelX}" y="${labelY}" width="${labelW}" height="${LH}" rx="${LR}"/>
        <text class="topology-branch-group-label" x="${labelX + LPX}" y="${labelY + LH - 5}">${esc(dispLabel)}</text>
      `;
    });

  } else if (!layout.aggregated && appPositions.length > 0) {
    // Single-branch DAG view: group box showing the selected branch name.
    const GP = 24;
    const gMinX = Math.min(...appPositions.map(p => p.x)) - GP;
    const gMinY = Math.min(...appPositions.map(p => p.y)) - GP;
    const gMaxX = Math.max(...appPositions.map(p => p.x + TOPO_NODE_W)) + GP;
    const gMaxY = Math.max(...appPositions.map(p => p.y + TOPO_NODE_H)) + GP;
    const dagBranchLabel = selectedBranchId ? ('@' + selectedBranchId) : 'Apps';
    const MAX_DL = 22;
    const dispDagLabel = dagBranchLabel.length > MAX_DL + 1
      ? '@' + selectedBranchId.slice(0, 10) + '…' + selectedBranchId.slice(-9) : dagBranchLabel;
    const LH2 = 20; const LPX2 = 10; const LR2 = 10;
    const labelW2 = Math.min(gMaxX - gMinX - 4, dispDagLabel.length * 6.5 + LPX2 * 2);
    const labelX2 = gMinX + 4;
    const labelY2 = gMinY - LH2 + 2;
    appGroupRect = `
      <rect class="topology-branch-group" x="${gMinX}" y="${gMinY}" width="${gMaxX - gMinX}" height="${gMaxY - gMinY}" rx="20"/>
      <rect class="topology-branch-group-pill" x="${labelX2}" y="${labelY2}" width="${labelW2}" height="${LH2}" rx="${LR2}"/>
      <text class="topology-branch-group-label" x="${labelX2 + LPX2}" y="${labelY2 + LH2 - 5}">${esc(dispDagLabel)}</text>
    `;
  }

  return `
    <svg class="topology-canvas" width="${totalW}" height="${totalH}" viewBox="0 0 ${totalW} ${totalH}" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <marker id="topologyArrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
          <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--text-muted)" opacity="0.7" />
        </marker>
      </defs>
      ${appGroupRect}
      ${edgePaths}
      ${nodeEls}
    </svg>
  `;
}

// Pan/zoom state — persists across re-renders via _topologyViewport
let _topologyViewport = { scale: 1, tx: 0, ty: 0 };
let _topologyDragState = null;
// Per-node user-dragged position offsets: { nodeId: {dx, dy} }
const _topologyNodeDragOffsets = {};
// UF-03: track whether the user has manually panned/zoomed. While this
// is false, each renderTopologyView() auto-fits so the graph stays
// centered in the canvas (fixes "nodes stuck in the top-left" bug).
// Any user wheel/drag/manual zoom flips this flag and we stop auto-
// centering so we don't yank the viewport under the user.
let _topologyUserAdjusted = false;

function _applyTopologyTransform() {
  const svg = document.querySelector('.topology-canvas');
  const indicator = document.querySelector('.topology-zoom-indicator');
  if (!svg) return;
  svg.style.transform = `translate(${_topologyViewport.tx}px, ${_topologyViewport.ty}px) scale(${_topologyViewport.scale})`;
  if (indicator) indicator.textContent = `${Math.round(_topologyViewport.scale * 100)}%`;
}

// RAF-throttled transform scheduler — mousemove can fire at 500Hz on
// high-DPI trackpads, writing `transform` synchronously on every event
// stalls the compositor and produces the "sticky / jumps 5cm" feel the
// user complained about. Coalescing into one transform per frame keeps
// the canvas at 60fps, matching AdvancedVisualAgentTab's pattern
// (prd-admin/src/pages/ai-chat/AdvancedVisualAgentTab.tsx:1592).
let _topologyRafId = null;
function _scheduleTopologyTransform() {
  if (_topologyRafId) return;
  _topologyRafId = requestAnimationFrame(() => {
    _topologyRafId = null;
    _applyTopologyTransform();
  });
}

function _topologyZoom(delta, centerX, centerY) {
  // Clamp scale to [0.3, 2.5]
  const oldScale = _topologyViewport.scale;
  const newScale = Math.max(0.3, Math.min(2.5, oldScale + delta));
  if (newScale === oldScale) return;
  // Zoom around the mouse position (if provided) so the point under the cursor stays fixed
  if (centerX !== undefined && centerY !== undefined) {
    const wrap = document.querySelector('.topology-canvas-wrap');
    if (wrap) {
      const rect = wrap.getBoundingClientRect();
      const px = centerX - rect.left - _topologyViewport.tx;
      const py = centerY - rect.top - _topologyViewport.ty;
      const ratio = newScale / oldScale;
      _topologyViewport.tx -= px * (ratio - 1);
      _topologyViewport.ty -= py * (ratio - 1);
    }
  }
  _topologyViewport.scale = newScale;
  _applyTopologyTransform();
}

function _topologyZoomIn() { _topologyUserAdjusted = true; _topologyZoom(0.15); }
function _topologyZoomOut() { _topologyUserAdjusted = true; _topologyZoom(-0.15); }

function _topologyReset() {
  // "1:1 复位" = explicit user ask to return to identity. Flip back to
  // "not adjusted" so the next render recenters, and re-fit now to
  // avoid leaving content in the top-left corner (which was the UF-03
  // complaint in the first place). Also clear any per-node drag offsets.
  _topologyUserAdjusted = false;
  Object.keys(_topologyNodeDragOffsets).forEach(k => delete _topologyNodeDragOffsets[k]);
  renderTopologyView();
  _topologyFit();
}

function _topologyFit() {
  const svg = document.querySelector('.topology-canvas');
  const wrap = document.querySelector('.topology-canvas-wrap');
  if (!svg || !wrap) return;
  const wrapRect = wrap.getBoundingClientRect();
  const svgW = parseFloat(svg.getAttribute('width')) || 1;
  const svgH = parseFloat(svg.getAttribute('height')) || 1;
  // Fit with 100px margin, cap at 0.75 so initial view is comfortably zoomed-out
  const scaleX = (wrapRect.width - 100) / svgW;
  const scaleY = (wrapRect.height - 100) / svgH;
  const scale = Math.min(scaleX, scaleY, 0.75);
  _topologyViewport.scale = Math.max(0.3, scale);
  // Center the content
  _topologyViewport.tx = (wrapRect.width - svgW * _topologyViewport.scale) / 2;
  _topologyViewport.ty = (wrapRect.height - svgH * _topologyViewport.scale) / 2;
  _applyTopologyTransform();
}

function _topologyNodeDragStart(e, nodeId, groupEl) {
  e.stopPropagation();
  const startX = e.clientX;
  const startY = e.clientY;
  const baseOffset = _topologyNodeDragOffsets[nodeId] || { dx: 0, dy: 0 };
  let hasDragged = false;
  let pendingTransform = null;
  let rafId = null;

  const flush = () => {
    rafId = null;
    if (pendingTransform) {
      groupEl.setAttribute('transform', pendingTransform);
      pendingTransform = null;
    }
  };

  const onMove = (me) => {
    const ddx = (me.clientX - startX) / _topologyViewport.scale;
    const ddy = (me.clientY - startY) / _topologyViewport.scale;
    if (!hasDragged && Math.abs(ddx) + Math.abs(ddy) < 4) return;
    hasDragged = true;
    // The node's children are already positioned at (baseX + baseOffset),
    // so the group transform only needs the CURRENT delta — not baseOffset again.
    pendingTransform = `translate(${ddx},${ddy})`;
    if (!rafId) rafId = requestAnimationFrame(flush);
  };

  const onUp = (me) => {
    if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onUp);
    if (!hasDragged) return; // was a click — let onclick fire
    const ddx = (me.clientX - startX) / _topologyViewport.scale;
    const ddy = (me.clientY - startY) / _topologyViewport.scale;
    _topologyNodeDragOffsets[nodeId] = { dx: baseOffset.dx + ddx, dy: baseOffset.dy + ddy };
    renderTopologyView(); // re-render so edges follow the node
  };

  window.addEventListener('pointermove', onMove, { passive: true });
  window.addEventListener('pointerup', onUp, { passive: true });
  window.addEventListener('pointercancel', onUp, { passive: true });
}

// Global window-level pointer listeners are bound exactly once. The
// wrap element itself is replaced on every render, but `_topologyDragState`
// lives at module scope so these listeners keep working across renders
// and we don't leak N copies after N renders.
let _topologyWindowListenersBound = false;
function _bindTopologyPanZoom() {
  const wrap = document.querySelector('.topology-canvas-wrap');
  if (!wrap) return;

  // Mouse wheel → zoom toward cursor
  // UF-06: Mac trackpad gesture contract (ported from
  // prd-admin/src/pages/ai-chat/AdvancedVisualAgentTab.tsx:3267-3281
  // so CDS topology feels the same as VisualAgent):
  //
  //   wheel + ctrlKey/metaKey → zoom toward cursor (macOS converts
  //     trackpad pinch into wheel events with ctrlKey=true, and
  //     Windows Ctrl+wheel is the desktop convention for zoom).
  //   wheel alone (no modifiers) → pan the canvas. On macOS this is
  //     a two-finger trackpad swipe, which previously was mis-routed
  //     to zoom (the "鸡肋" behaviour the user complained about).
  //
  // We still flip `_topologyUserAdjusted` on either gesture so
  // subsequent renders don't auto-center under the user.
  wrap.addEventListener('wheel', (e) => {
    e.preventDefault();
    _topologyUserAdjusted = true;
    if (e.ctrlKey || e.metaKey) {
      // Pinch (trackpad) or Ctrl+wheel (desktop) → zoom toward cursor.
      // Use an exponential factor so the zoom rate feels consistent
      // regardless of the trackpad's `deltaY` magnitude.
      const factor = Math.exp(-e.deltaY * 0.01);
      const newScale = Math.max(0.3, Math.min(2.5, _topologyViewport.scale * factor));
      if (newScale !== _topologyViewport.scale) {
        const rect = wrap.getBoundingClientRect();
        const px = e.clientX - rect.left - _topologyViewport.tx;
        const py = e.clientY - rect.top - _topologyViewport.ty;
        const ratio = newScale / _topologyViewport.scale;
        _topologyViewport.tx -= px * (ratio - 1);
        _topologyViewport.ty -= py * (ratio - 1);
        _topologyViewport.scale = newScale;
        _scheduleTopologyTransform();
      }
      return;
    }
    // Two-finger pan on trackpad (or wheel on a physical mouse with
    // a shift-wheel → horizontal convention). `deltaX`/`deltaY` are
    // already in CSS pixels, so we just subtract them from the
    // viewport offset. RAF-throttle like the drag path so bursts of
    // high-frequency wheel events don't stall the compositor.
    _topologyViewport.tx -= e.deltaX;
    _topologyViewport.ty -= e.deltaY;
    _scheduleTopologyTransform();
  }, { passive: false });

  // Pointerdown: either start node drag or canvas pan.
  // Using PointerEvents instead of MouseEvents so we get
  // setPointerCapture (bulletproof against the "pointer leaves
  // window" drift the user reported), plus unified handling of
  // trackpad / pen / touch without extra listeners.
  wrap.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    const nodeEl = e.target.closest('g.topology-node');
    if (nodeEl) {
      const nodeId = nodeEl.getAttribute('data-node-id');
      if (nodeId) _topologyNodeDragStart(e, nodeId, nodeEl);
      return;
    }
    try { wrap.setPointerCapture(e.pointerId); } catch (_) {}
    _topologyDragState = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      baseTx: _topologyViewport.tx,
      baseTy: _topologyViewport.ty,
      moved: false,
    };
    wrap.classList.add('dragging');
  });

  // Passive pointermove — we never preventDefault, so marking passive
  // lets the browser ship the event without blocking the compositor.
  // Bound once per page-life; handlers re-query .topology-canvas-wrap
  // because the DOM element is replaced on every render.
  if (!_topologyWindowListenersBound) {
    window.addEventListener('pointermove', (e) => {
      if (!_topologyDragState) return;
      if (e.pointerId !== undefined && e.pointerId !== _topologyDragState.pointerId) return;
      const dx = e.clientX - _topologyDragState.startX;
      const dy = e.clientY - _topologyDragState.startY;
      if (Math.abs(dx) + Math.abs(dy) > 3) {
        _topologyDragState.moved = true;
        _topologyUserAdjusted = true; // UF-03: stop auto-centering
      }
      _topologyViewport.tx = _topologyDragState.baseTx + dx;
      _topologyViewport.ty = _topologyDragState.baseTy + dy;
      _scheduleTopologyTransform();
    }, { passive: true });
    const endDrag = (e) => {
      if (!_topologyDragState) return;
      if (e && e.pointerId !== undefined && e.pointerId !== _topologyDragState.pointerId) return;
      const wasClick = !_topologyDragState.moved;
      const currentWrap = document.querySelector('.topology-canvas-wrap');
      try { currentWrap && currentWrap.releasePointerCapture(_topologyDragState.pointerId); } catch (_) {}
      _topologyDragState = null;
      if (currentWrap) currentWrap.classList.remove('dragging');
      if (wasClick && _topologyFocusedNodeId) {
        _topologyFocusedNodeId = null;
        renderTopologyView();
      }
    };
    window.addEventListener('pointerup', endDrag, { passive: true });
    window.addEventListener('pointercancel', endDrag, { passive: true });
    _topologyWindowListenersBound = true;
  }
}

// Selected node for edge highlighting (distinct from _topologySelectedBranchId)
let _topologyFocusedNodeId = null;

function renderTopologyView() {
  const host = document.getElementById('topologyView');
  if (!host) return;

  if (!buildProfiles.length && !infraServices.length) {
    host.innerHTML = `
      <div class="topology-card">
        <div class="topology-empty">
          <strong>还没有发现任何服务</strong>
          <span>导入 docker-compose.yml 后这里会显示应用和基础设施的依赖图</span>
        </div>
      </div>
    `;
    return;
  }

  // Shared view (no branch selected) with tracked branches → show all
  // branch instances aggregated into one canvas (shared view B).
  const layout = ((!_topologySelectedBranchId || _topologyKeepSharedView) && branches.length > 0)
    ? _layoutTopologyAggregated(buildProfiles, infraServices, branches)
    : _layoutTopologyDag(buildProfiles, infraServices);

  const chipHtml = branches.length === 0
    ? '<span class="topology-branch-picker-label">暂无分支 —— 先在列表视图创建一个</span>'
    : `
      <span class="topology-branch-picker-label">查看分支:</span>
      <button class="topology-branch-chip ${(!_topologySelectedBranchId || _topologyKeepSharedView) ? 'active' : ''}" onclick="_topologySelectBranch(null)">（共享视图）</button>
      ${branches.map(b => `
        <button class="topology-branch-chip ${_topologySelectedBranchId === b.id && !_topologyKeepSharedView ? 'active' : ''}" onclick="_topologySelectBranch('${esc(b.id)}')" title="${esc(b.branch || b.id)}">${esc(b.id)}</button>
      `).join('')}
    `;

  const overrideSet = _topologySelectedBranchId
    ? _topologyOverrideCache.get(_topologySelectedBranchId)
    : null;
  const overrideDetails = _topologySelectedBranchId
    ? _topologyOverrideDetails.get(_topologySelectedBranchId)
    : null;

  host.innerHTML = `
    <div class="topology-card">
      <div class="topology-header">
        <div class="topology-title">
          服务拓扑
          <span class="topology-title-hint">${layout.aggregated ? `${branches.length} 个分支 × ${buildProfiles.length} 个服务 · 共享基础设施` : `${layout.nodes.size} 个服务 · ${layout.edges.length} 条依赖 · ${layout.layers.length} 层`} · 滚轮缩放 · 拖拽平移</span>
        </div>
        <div class="topology-branch-picker">${chipHtml}</div>
      </div>
      <div class="topology-legend">
        <span class="topology-legend-item"><span class="topology-legend-swatch app"></span>应用服务</span>
        <span class="topology-legend-item"><span class="topology-legend-swatch infra"></span>基础设施</span>
        <span class="topology-legend-item"><span class="topology-legend-swatch override"></span>本分支自定义</span>
        <span class="topology-legend-item" style="color:var(--text-secondary);margin-left:auto">${_topologySelectedBranchId ? '点击节点直接编辑该分支配置' : (layout.aggregated ? '点击节点切换至该分支' : '先选择上方分支，再点击节点编辑')}</span>
      </div>
      <div class="topology-canvas-wrap">
        ${_renderTopologySvg(layout, {
          overrideSet,
          overrideDetails,
          selectedBranchId: _topologySelectedBranchId,
          selectedNodeId: _topologyFocusedNodeId,
        })}
        <div class="topology-zoom-indicator">100%</div>
        <div class="topology-toolbar">
          <button type="button" onclick="_topologyZoomIn()" title="放大">+</button>
          <button type="button" onclick="_topologyZoomOut()" title="缩小">−</button>
          <div class="separator"></div>
          <button type="button" onclick="_topologyFit()" title="自适应">⊡</button>
          <button type="button" onclick="_topologyReset()" title="1:1 复位">◉</button>
        </div>
      </div>
    </div>
  `;

  // Restore transform from persisted viewport + bind pan/zoom handlers
  _applyTopologyTransform();
  _bindTopologyPanZoom();

  // UF-03: auto-center/fit on first render (before user has panned/zoomed).
  // getBoundingClientRect() needs the SVG to be laid out, so we defer to
  // the next animation frame. Once the user has interacted the flag
  // `_topologyUserAdjusted` stays true and we no longer auto-adjust.
  if (!_topologyUserAdjusted) {
    requestAnimationFrame(() => {
      // Render may have been replaced before rAF fires (e.g. user
      // switched views); guard on the SVG still being in the DOM.
      const svg = document.querySelector('.topology-canvas');
      if (!svg) return;
      _topologyFit();
    });
  }
}

async function _topologySelectBranch(branchId) {
  _topologySelectedBranchId = branchId;
  _topologyKeepSharedView = false; // explicit branch select always exits shared-view mode
  _topologyFocusedNodeId = null; // clear focus when branch changes
  if (!branchId) {
    renderTopologyView();
    return;
  }
  try {
    const data = await api('GET', `/branches/${encodeURIComponent(branchId)}/profile-overrides`);
    const overrideSet = new Set();
    const detailMap = new Map();
    for (const p of data.profiles || []) {
      if (p.hasOverride) {
        overrideSet.add(p.profileId);
        const fields = p.override
          ? Object.keys(p.override).filter(k => k !== 'updatedAt' && k !== 'notes')
          : [];
        detailMap.set(p.profileId, fields);
      }
    }
    _topologyOverrideCache.set(branchId, overrideSet);
    _topologyOverrideDetails.set(branchId, detailMap);
  } catch (e) {
    // 404 = new branch with no overrides yet — expected, not an error
    if (!e.message || !e.message.includes('404')) {
      console.warn('topology: load overrides failed', e);
      showToast('加载分支覆盖失败: ' + e.message, 'error');
    }
  }
  renderTopologyView();
  // If the right panel is open for an app/infra node, re-render it so its
  // branch-specific data (public URL, commit, status) reflects the new branch.
  var _fsPanel = document.getElementById('topologyFsPanel');
  if (_fsPanel && _fsPanel.classList.contains('open') && _topologyPanelCurrentId) {
    var _activeTab = (_fsPanel.querySelector('.topology-fs-panel-tab.active') || {}).dataset;
    var _panelTab = (_activeTab && _activeTab.tab) || 'details';
    var _panelEntity = (_topologyPanelCurrentKind === 'app')
      ? (buildProfiles || []).find(function (p) { return p.id === _topologyPanelCurrentId; })
      : (infraServices || []).find(function (s) { return s.id === _topologyPanelCurrentId; });
    if (_panelEntity) _topologyRenderPanelTab(_panelTab, _panelEntity);
  }
}

// Node click logic: first click focuses the node (highlight edges); second
// click on the same node opens the override modal. Matches Railway's "click
// to select, click again to configure" pattern.
let _topologyLastClickId = null;
let _topologyLastClickAt = 0;
function _topologyNodeClick(nodeId) {
  // Handle aggregated shared-view nodes (format: "profileId@branchId"):
  // Open the service panel with the branch as context but keep the
  // canvas in shared/aggregated view — user must explicitly pick a
  // branch from the dropdown to switch to single-branch mode.
  if (nodeId.includes('@')) {
    var atIdx = nodeId.indexOf('@');
    var realProfileId = nodeId.slice(0, atIdx);
    var realBranchId = nodeId.slice(atIdx + 1);
    _topologySelectedBranchId = realBranchId;
    _topologyKeepSharedView = true;
    // Preload override data for the panel without re-rendering canvas
    if (!_topologyOverrideCache.has(realBranchId)) {
      api('GET', '/branches/' + encodeURIComponent(realBranchId) + '/profile-overrides')
        .then(function (data) {
          var overrideSet = new Set();
          var detailMap = new Map();
          for (var p of (data.profiles || [])) {
            if (p.hasOverride) {
              overrideSet.add(p.profileId);
              var fields = p.override ? Object.keys(p.override).filter(function (k) { return k !== 'updatedAt' && k !== 'notes'; }) : [];
              detailMap.set(p.profileId, fields);
            }
          }
          _topologyOverrideCache.set(realBranchId, overrideSet);
          _topologyOverrideDetails.set(realBranchId, detailMap);
        })
        .catch(function () {});
    }
    _topologyOpenServicePanel(realProfileId, 'app');
    return;
  }

  // Holding shift bypasses the right panel and forces edge highlight.
  if (window.event?.shiftKey) {
    _topologyFocusedNodeId = _topologyFocusedNodeId === nodeId ? null : nodeId;
    renderTopologyView();
    return;
  }
  _topologyOpenServicePanel(nodeId, 'app');
}

function _topologyInfraClick(serviceId) {
  // P4 Part 6: infra nodes also open the slide-in panel. The Settings
  // tab inside the panel routes to the legacy infra edit modal until
  // a true in-canvas infra editor lands.
  if (window.event?.shiftKey) {
    _topologyFocusedNodeId = _topologyFocusedNodeId === serviceId ? null : serviceId;
    renderTopologyView();
    return;
  }
  _topologyOpenServicePanel(serviceId, 'infra');
}

// ─────────────────────────────────────────────────────────────────
// P4 Part 6 — Topology shell helpers
//
// All functions below are appended new code, no coupling with existing
// branches.ts/state.ts logic. They drive:
//
//   - the floating "+ Add" button menu
//   - the right slide-in service detail panel + 4 tabs
//   - the branch dropdown in the top breadcrumb pill
//
// Each function is independent so future commits can replace any one
// of them without touching its neighbors.
// ─────────────────────────────────────────────────────────────────

// T3: + Add menu open/close toggle
function _topologyToggleAddMenu() {
  var menu = document.getElementById('topologyFsAddMenu');
  if (!menu) return;
  menu.classList.toggle('open');
  if (menu.classList.contains('open')) {
    var search = document.getElementById('topologyFsAddSearch');
    if (search) setTimeout(function () { search.focus(); }, 60);
  }
}

// T4: handle a + Add menu item click. Each kind routes to the most
// appropriate existing CDS create flow, with novice-friendly defaults.
// All menu items land on working flows after the P4 Part 18 cleanup —
// no more "coming in P5/P6" stub toasts.
// P4 Part 10 — Infra service templates for the Database submenu.
//
// Maps a template key to a fully-formed InfraService payload that
// `POST /api/infra` accepts. Each template encodes the right docker
// image / port / volumes / env that gets the database running on
// the convention default. Image versions stay on stable major lines.
const INFRA_TEMPLATES = {
  postgres: {
    id: 'postgres',
    name: 'PostgreSQL',
    dockerImage: 'postgres:16-alpine',
    containerPort: 5432,
    volumes: [{ name: 'postgres-data', containerPath: '/var/lib/postgresql/data' }],
    env: {
      POSTGRES_USER: 'postgres',
      POSTGRES_PASSWORD: 'change-me-please',
      POSTGRES_DB: 'app',
    },
  },
  redis: {
    id: 'redis',
    name: 'Redis',
    dockerImage: 'redis:7-alpine',
    containerPort: 6379,
    volumes: [{ name: 'redis-data', containerPath: '/data' }],
    env: {},
  },
  mongodb: {
    id: 'mongodb',
    name: 'MongoDB',
    dockerImage: 'mongo:8.0',
    containerPort: 27017,
    volumes: [{ name: 'mongodb-data', containerPath: '/data/db' }],
    env: {
      MONGO_INITDB_ROOT_USERNAME: 'admin',
      MONGO_INITDB_ROOT_PASSWORD: 'change-me-please',
    },
  },
  mysql: {
    id: 'mysql',
    name: 'MySQL',
    dockerImage: 'mysql:8.4',
    containerPort: 3306,
    volumes: [{ name: 'mysql-data', containerPath: '/var/lib/mysql' }],
    env: {
      MYSQL_ROOT_PASSWORD: 'change-me-please',
      MYSQL_DATABASE: 'app',
    },
  },
};

// Show the Database submenu. Replaces the menu's inner HTML with a
// list of database templates + a back button. Modeled after Railway's
// "+ Add → Database" two-level dropdown.
function _topologyShowDatabaseSubmenu() {
  var menu = document.getElementById('topologyFsAddMenu');
  if (!menu) return;
  var taken = new Set((infraServices || []).map(function (s) { return s.id; }));

  var items = [
    { key: 'postgres', label: 'PostgreSQL', icon: '<svg width="16" height="16" viewBox="0 0 16 16"><ellipse cx="8" cy="4" rx="5.5" ry="2" fill="#6366f1"/><path d="M2.5 4v8c0 1.1 2.46 2 5.5 2s5.5-.9 5.5-2V4" fill="#6366f1" opacity="0.7"/><ellipse cx="8" cy="12" rx="5.5" ry="2" fill="#6366f1"/></svg>', tag: 'postgres:16-alpine · :5432' },
    { key: 'redis', label: 'Redis', icon: '<svg width="16" height="16" viewBox="0 0 16 16"><ellipse cx="8" cy="4" rx="5.5" ry="2" fill="#ef4444"/><path d="M2.5 4v8c0 1.1 2.46 2 5.5 2s5.5-.9 5.5-2V4" fill="#ef4444" opacity="0.7"/><ellipse cx="8" cy="12" rx="5.5" ry="2" fill="#ef4444"/></svg>', tag: 'redis:7-alpine · :6379' },
    { key: 'mongodb', label: 'MongoDB', icon: '<svg width="16" height="16" viewBox="0 0 16 16"><ellipse cx="8" cy="4" rx="5.5" ry="2" fill="#22c55e"/><path d="M2.5 4v8c0 1.1 2.46 2 5.5 2s5.5-.9 5.5-2V4" fill="#22c55e" opacity="0.7"/><ellipse cx="8" cy="12" rx="5.5" ry="2" fill="#22c55e"/></svg>', tag: 'mongo:8.0 · :27017' },
    { key: 'mysql', label: 'MySQL', icon: '<svg width="16" height="16" viewBox="0 0 16 16"><ellipse cx="8" cy="4" rx="5.5" ry="2" fill="#0ea5e9"/><path d="M2.5 4v8c0 1.1 2.46 2 5.5 2s5.5-.9 5.5-2V4" fill="#0ea5e9" opacity="0.7"/><ellipse cx="8" cy="12" rx="5.5" ry="2" fill="#0ea5e9"/></svg>', tag: 'mysql:8.4 · :3306' },
  ];

  menu.innerHTML =
    '<div class="topology-fs-add-menu-back" onclick="_topologyShowAddMenuRoot()">' +
      '<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M7.78 12.53a.75.75 0 01-1.06 0L2.47 8.28a.75.75 0 010-1.06l4.25-4.25a.751.751 0 011.154.114.75.75 0 01-.094.946L4.81 7h7.44a.75.75 0 010 1.5H4.81l2.97 2.97a.75.75 0 010 1.06z"/></svg>' +
      '<span>Database</span>' +
    '</div>' +
    '<input class="topology-fs-add-menu-search" placeholder="你想创建什么?" id="topologyFsAddSearch">' +
    items.map(function (it) {
      var disabled = taken.has(it.key);
      return '<button type="button" class="topology-fs-add-menu-item' + (disabled ? ' disabled' : '') + '"' +
        ' onclick="' + (disabled
          ? "showToast('已存在 " + it.label + "，无需重复创建','info')"
          : "_topologyCreateInfraFromTemplate('" + it.key + "')") + '">' +
        '<span class="icon" style="font-size:16px">' + it.icon + '</span>' +
        '<span class="label">' + esc(it.label) + (disabled ? ' <span style="color:var(--text-muted);font-size:10px">(已存在)</span>' : '') + '</span>' +
        '<span style="font-size:10px;color:var(--text-muted);font-family:var(--font-mono,monospace)">' + esc(it.tag) + '</span>' +
      '</button>';
    }).join('');
}

// Reset the menu back to the root level (the original 6-item list).
function _topologyShowAddMenuRoot() {
  // Tear down the current menu by closing then re-opening — the root
  // markup is built fresh by _ensureTopologyFsChrome's idempotent
  // append. Easier to re-call it than maintain a separate root template.
  var menu = document.getElementById('topologyFsAddMenu');
  if (!menu) return;
  // Restore root markup
  menu.innerHTML =
    '<input class="topology-fs-add-menu-search" placeholder="你想创建什么?" id="topologyFsAddSearch">' +
    '<button type="button" class="topology-fs-add-menu-item" onclick="_topologyChooseAddItem(\'git\')">' +
      '<span class="icon"><svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg></span>' +
      '<span class="label">GitHub Repository</span><span class="chevron">›</span></button>' +
    '<button type="button" class="topology-fs-add-menu-item" onclick="_topologyChooseAddItem(\'database\')">' +
      '<span class="icon"><svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M8 1c4 0 7 1 7 2.5v9c0 1.5-3 2.5-7 2.5s-7-1-7-2.5v-9C1 2 4 1 8 1z"/></svg></span>' +
      '<span class="label">Database (PostgreSQL / Redis / MongoDB / MySQL)</span><span class="chevron">›</span></button>' +
    '<button type="button" class="topology-fs-add-menu-item" onclick="_topologyChooseAddItem(\'docker\')">' +
      '<span class="icon"><svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M14 7h-2V5h2v2zm-3 0H9V5h2v2zM8 7H6V5h2v2zm6.6 4c-.4-1-1.4-1.6-2.5-1.6h-1c-.2-2.3-2-3.4-2.1-3.4l-.4-.2-.3.4c-.4.5-.6 1.2-.6 1.9C7.6 9.5 8 10 8 10c-.6.3-1.5.4-2.4.4H.4l-.1.7c-.2 1.4.1 2.7.7 3.7.6 1.1 1.7 1.9 3 2.3 4 1 8.5-.5 10.6-4.4 1.1-.1 2-.7 2.4-1.6l.2-.3-.5-.5z"/></svg></span>' +
      '<span class="label">Docker 镜像</span><span class="chevron">›</span></button>' +
    '<button type="button" class="topology-fs-add-menu-item" onclick="_topologyChooseAddItem(\'routing\')">' +
      '<span class="icon"><svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M8 0a8 8 0 100 16A8 8 0 008 0z"/></svg></span>' +
      '<span class="label">路由规则</span><span class="chevron">›</span></button>' +
    '<button type="button" class="topology-fs-add-menu-item" onclick="_topologyChooseAddItem(\'volume\')">' +
      '<span class="icon"><svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M2 3h12c.6 0 1 .4 1 1v8c0 .6-.4 1-1 1H2c-.6 0-1-.4-1-1V4c0-.6.4-1 1-1z"/></svg></span>' +
      '<span class="label">Volume / 持久化卷</span><span class="chevron">›</span></button>' +
    '<button type="button" class="topology-fs-add-menu-item" onclick="_topologyChooseAddItem(\'empty\')">' +
      '<span class="icon"><svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M0 2.75C0 1.784.784 1 1.75 1h12.5c.966 0 1.75.784 1.75 1.75v10.5A1.75 1.75 0 0114.25 15H1.75A1.75 1.75 0 010 13.25V2.75z"/></svg></span>' +
      '<span class="label">空服务</span><span class="chevron">›</span></button>';
}

// Create an infra service from a template. Calls POST /api/infra with
// the template payload. On success: refresh infra list, close menu,
// open the right service detail panel for the new entry.
async function _topologyCreateInfraFromTemplate(key) {
  var tpl = INFRA_TEMPLATES[key];
  if (!tpl) return;

  // Close the menu immediately so the user feels progress
  var menu = document.getElementById('topologyFsAddMenu');
  if (menu) menu.classList.remove('open');

  showToast('正在创建 ' + tpl.name + '...', 'info');

  // P4 Part 16 (B1 fix): tag the template with the current project so
  // it lands in the right project, not the legacy default.
  var payload = Object.assign({}, tpl, { projectId: CURRENT_PROJECT_ID });

  try {
    var res = await fetch('/api/infra', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      var body = await res.json().catch(function () { return null; });
      throw new Error((body && body.error) || ('HTTP ' + res.status));
    }
    var data = await res.json();
    showToast(tpl.name + ' 已创建（hostPort: ' + data.service.hostPort + '），点击节点启动', 'success');

    // Refresh state + topology
    await loadInfraServices();
    if (typeof renderTopologyView === 'function') renderTopologyView();

    // Open the new infra in the right panel for immediate inspection
    if (typeof _topologyOpenServicePanel === 'function') {
      _topologyOpenServicePanel(tpl.id, 'infra');
    }
  } catch (err) {
    showToast('创建失败：' + (err && err.message ? err.message : err), 'error');
  }
}

window._topologyShowDatabaseSubmenu = _topologyShowDatabaseSubmenu;
window._topologyShowAddMenuRoot = _topologyShowAddMenuRoot;
window._topologyCreateInfraFromTemplate = _topologyCreateInfraFromTemplate;

// P4 Part 18 (UX rework): the old _showGitRepoExplainer stub was
// buggy (CSS class mismatch — close button silently did nothing)
// AND obsolete (Phase B G1 now ships real multi-repo clone). It
// used to live here. "+ Add → GitHub Repository" in the topology
// view now redirects to projects.html?new=git which auto-opens
// the real create modal on the project landing page.

// ─────────────────────────────────────────────────────────────────
// P4 Part 11 — Cmd+K command palette
//
// Modeled after Railway's "What can we help with?" command palette.
// Pressing Cmd+K (Mac) or Ctrl+K (Win/Linux) anywhere in the
// Dashboard pops a centered overlay with a search box + filtered
// command list. Commands cover the most common navigation targets:
//
//   - Branches (jump to a specific branch in list view)
//   - Build profiles (open the editor)
//   - Infra services (open the editor)
//   - View modes (list / topology)
//   - Self-update
//   - Configuration sections (env vars / routing / etc)
//
// Keyboard navigation: ↑↓ to move, ↵ to activate, ESC to close.
// All commands use the existing routing functions (setViewMode /
// openConfigModal / openLogModal / openOverrideModal etc), so this
// is purely an alternative entry point — no new business logic.
// ─────────────────────────────────────────────────────────────────

let _cmdkCommands = [];
let _cmdkFiltered = [];
let _cmdkActiveIndex = 0;

function buildCmdkCommands() {
  // Rebuilds the command list from current state. Cheap enough to
  // run on every open since the lists are bounded (< 200 entries
  // total even on big projects).
  var cmds = [];

  // ── View modes ──
  cmds.push({
    group: 'navigation',
    icon: '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M2 3.75a.75.75 0 01.75-.75h10.5a.75.75 0 010 1.5H2.75A.75.75 0 012 3.75zm0 4a.75.75 0 01.75-.75h10.5a.75.75 0 010 1.5H2.75A.75.75 0 012 7.75zM2.75 11a.75.75 0 000 1.5h10.5a.75.75 0 000-1.5H2.75z"/></svg>',
    label: '切换到列表视图',
    meta: 'list',
    keywords: ['list', '列表', 'view'],
    action: function () { setViewMode('list'); },
  });
  cmds.push({
    group: 'navigation',
    icon: '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M5 2.75a2.25 2.25 0 114.5 0 2.25 2.25 0 01-4.5 0zM7.25 0a2.75 2.75 0 00-.75 5.397V7H2.75A1.75 1.75 0 001 8.75v1.603a2.75 2.75 0 101.5 0V8.75a.25.25 0 01.25-.25H6.5v1.397a2.75 2.75 0 101.5 0V8.5h3.75a.25.25 0 01.25.25v1.603a2.75 2.75 0 101.5 0V8.75A1.75 1.75 0 0011.75 7H8V5.397A2.75 2.75 0 007.25 0z"/></svg>',
    label: '切换到拓扑视图',
    meta: 'topology',
    keywords: ['topology', '拓扑', 'graph', 'view'],
    action: function () { setViewMode('topology'); },
  });
  cmds.push({
    group: 'navigation',
    icon: '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M1.75 1h12.5c.966 0 1.75.784 1.75 1.75v10.5A1.75 1.75 0 0114.25 15H1.75A1.75 1.75 0 010 13.25V2.75C0 1.784.784 1 1.75 1z"/></svg>',
    label: '返回项目列表',
    meta: 'projects',
    keywords: ['projects', '项目', 'home'],
    action: function () { location.href = '/project-list'; },
  });

  // ── Branches ──
  (branches || []).forEach(function (b) {
    cmds.push({
      group: 'branches',
      icon: '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M9.5 3.25a2.25 2.25 0 113 2.122V6A2.5 2.5 0 0110 8.5H6a1 1 0 00-1 1v1.128a2.251 2.251 0 11-1.5 0V5.372a2.25 2.25 0 111.5 0v1.836A2.492 2.492 0 016 7h4a1 1 0 001-1v-.628A2.25 2.25 0 019.5 3.25zM4.25 12a.75.75 0 100 1.5.75.75 0 000-1.5zM3.5 3.25a.75.75 0 111.5 0 .75.75 0 01-1.5 0zm8.25-.75a.75.75 0 100 1.5.75.75 0 000-1.5z"/></svg>',
      label: b.id + (b.branch && b.branch !== b.id ? '  (' + b.branch + ')' : ''),
      meta: b.status || 'idle',
      keywords: ['branch', '分支', b.id, b.branch || '', b.subject || ''],
      action: function () {
        setViewMode('list');
        setTimeout(function () {
          var card = document.querySelector('[data-branch-id="' + b.id + '"]');
          if (card) card.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }, 80);
      },
    });
  });

  // ── Build profiles ──
  (buildProfiles || []).forEach(function (p) {
    cmds.push({
      group: 'profiles',
      icon: '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M0 2.75C0 1.784.784 1 1.75 1h12.5c.966 0 1.75.784 1.75 1.75v10.5A1.75 1.75 0 0114.25 15H1.75A1.75 1.75 0 010 13.25V2.75z"/></svg>',
      label: p.name || p.id,
      meta: p.dockerImage,
      keywords: ['profile', 'service', '构建配置', p.id, p.name || '', p.dockerImage || ''],
      action: function () {
        if (typeof openProfileModal === 'function') openProfileModal();
      },
    });
  });

  // ── Infra services ──
  (infraServices || []).forEach(function (s) {
    cmds.push({
      group: 'infra',
      icon: '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M8 1c4 0 7 1 7 2.5v9c0 1.5-3 2.5-7 2.5s-7-1-7-2.5v-9C1 2 4 1 8 1z"/></svg>',
      label: s.name || s.id,
      meta: s.dockerImage + ' :' + s.containerPort,
      keywords: ['infra', 'database', s.id, s.name || '', s.dockerImage || ''],
      action: function () {
        if (typeof openInfraModal === 'function') openInfraModal();
      },
    });
  });

  // ── Actions ──
  cmds.push({
    group: 'actions',
    icon: '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M8 0a8 8 0 100 16A8 8 0 008 0zM4.78 4.97a.75.75 0 010 1.06L3.81 7H8a.75.75 0 010 1.5H3.81l.97.97a.75.75 0 11-1.06 1.06L1.47 8.28a.75.75 0 010-1.06l2.25-2.25a.75.75 0 011.06 0z"/></svg>',
    label: '自动更新（拉取并重启）',
    meta: 'self-update',
    keywords: ['update', '更新', 'pull', 'restart', 'self'],
    action: function () { if (typeof openSelfUpdate === 'function') openSelfUpdate(); },
  });
  cmds.push({
    group: 'actions',
    icon: '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M7.429 1.525a3.5 3.5 0 011.142 0 .75.75 0 01.57.63l.185 1.29a.25.25 0 00.35.193l1.178-.592a.75.75 0 01.808.098 3.5 3.5 0 01.571.571.75.75 0 01.098.808l-.592 1.178a.25.25 0 00.193.35l1.29.185a.75.75 0 01.63.57 3.5 3.5 0 010 1.142.75.75 0 01-.63.57l-1.29.185a.25.25 0 00-.193.35l.592 1.178a.75.75 0 01-.098.808 3.5 3.5 0 01-.571.571.75.75 0 01-.808.098l-1.178-.592a.25.25 0 00-.35.193l-.185 1.29a.75.75 0 01-.57.63 3.5 3.5 0 01-1.142 0 .75.75 0 01-.57-.63l-.185-1.29a.25.25 0 00-.35-.193l-1.178.592a.75.75 0 01-.808-.098 3.5 3.5 0 01-.571-.571.75.75 0 01-.098-.808l.592-1.178a.25.25 0 00-.193-.35l-1.29-.185a.75.75 0 01-.63-.57 3.5 3.5 0 010-1.142.75.75 0 01.63-.57l1.29-.185a.25.25 0 00.193-.35l-.592-1.178a.75.75 0 01.098-.808 3.5 3.5 0 01.571-.571.75.75 0 01.808-.098l1.178.592a.25.25 0 00.35-.193l.185-1.29a.75.75 0 01.57-.63zM8 6a2 2 0 100 4 2 2 0 000-4z"/></svg>',
    label: '设置 / 配置面板',
    meta: 'config',
    keywords: ['settings', 'config', '设置', '配置'],
    action: function () { if (typeof toggleSettingsMenu === 'function') toggleSettingsMenu({ stopPropagation: function () {} }); },
  });

  return cmds;
}

function openCmdkPalette() {
  var overlay = document.getElementById('cmdkPalette');
  var input = document.getElementById('cmdkSearch');
  if (!overlay || !input) return;

  _cmdkCommands = buildCmdkCommands();
  _cmdkFiltered = _cmdkCommands.slice();
  _cmdkActiveIndex = 0;
  input.value = '';
  overlay.classList.remove('hidden');
  setTimeout(function () { input.focus(); }, 30);
  renderCmdkResults();
}

function closeCmdkPalette(event) {
  var overlay = document.getElementById('cmdkPalette');
  if (!overlay) return;
  if (event && event.currentTarget !== event.target) return;
  overlay.classList.add('hidden');
}

function filterCmdkPalette(query) {
  var q = (query || '').toLowerCase().trim();
  if (!q) {
    _cmdkFiltered = _cmdkCommands.slice();
  } else {
    _cmdkFiltered = _cmdkCommands.filter(function (c) {
      var hay = (c.label + ' ' + (c.meta || '') + ' ' + (c.keywords || []).join(' ')).toLowerCase();
      return hay.indexOf(q) >= 0;
    });
  }
  _cmdkActiveIndex = 0;
  renderCmdkResults();
}

function renderCmdkResults() {
  var container = document.getElementById('cmdkResults');
  if (!container) return;

  if (_cmdkFiltered.length === 0) {
    container.innerHTML = '<div class="cmdk-empty">没有匹配项</div>';
    return;
  }

  // Group by .group
  var groups = { navigation: [], branches: [], profiles: [], infra: [], actions: [] };
  _cmdkFiltered.forEach(function (c) {
    if (!groups[c.group]) groups[c.group] = [];
    groups[c.group].push(c);
  });

  var groupLabels = {
    navigation: '导航',
    branches: '分支',
    profiles: '构建配置',
    infra: '基础设施',
    actions: '操作',
  };

  var html = '';
  var idx = 0;
  Object.keys(groupLabels).forEach(function (g) {
    if (!groups[g] || groups[g].length === 0) return;
    html += '<div class="cmdk-group-label">' + groupLabels[g] + '</div>';
    groups[g].forEach(function (c) {
      var active = idx === _cmdkActiveIndex ? ' active' : '';
      html += '<div class="cmdk-item' + active + '" data-cmdk-idx="' + idx + '" onclick="cmdkActivate(' + idx + ')">' +
        '<span class="cmdk-item-icon">' + c.icon + '</span>' +
        '<span class="cmdk-item-label">' + esc(c.label) + '</span>' +
        (c.meta ? '<span class="cmdk-item-meta">' + esc(c.meta) + '</span>' : '') +
      '</div>';
      idx++;
    });
  });
  container.innerHTML = html;

  // Scroll active into view
  var activeEl = container.querySelector('.cmdk-item.active');
  if (activeEl) activeEl.scrollIntoView({ block: 'nearest' });
}

function cmdkActivate(idx) {
  var c = _cmdkFiltered[idx];
  if (!c) return;
  closeCmdkPalette({ currentTarget: document.getElementById('cmdkPalette'), target: document.getElementById('cmdkPalette') });
  try { c.action(); } catch (e) { console.error('cmdk action failed', e); }
}

function cmdkOnKey(e) {
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    _cmdkActiveIndex = Math.min(_cmdkFiltered.length - 1, _cmdkActiveIndex + 1);
    renderCmdkResults();
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    _cmdkActiveIndex = Math.max(0, _cmdkActiveIndex - 1);
    renderCmdkResults();
  } else if (e.key === 'Enter') {
    e.preventDefault();
    cmdkActivate(_cmdkActiveIndex);
  } else if (e.key === 'Escape') {
    e.preventDefault();
    closeCmdkPalette({ currentTarget: document.getElementById('cmdkPalette'), target: document.getElementById('cmdkPalette') });
  }
}

// Global keyboard binding: Cmd+K (Mac) / Ctrl+K (Win/Linux)
document.addEventListener('keydown', function (e) {
  if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
    e.preventDefault();
    var overlay = document.getElementById('cmdkPalette');
    if (overlay && overlay.classList.contains('hidden')) {
      openCmdkPalette();
    } else {
      closeCmdkPalette({ currentTarget: overlay, target: overlay });
    }
  }
});

window.openCmdkPalette = openCmdkPalette;
window.closeCmdkPalette = closeCmdkPalette;
window.filterCmdkPalette = filterCmdkPalette;
window.cmdkOnKey = cmdkOnKey;
window.cmdkActivate = cmdkActivate;

function _topologyChooseAddItem(kind) {
  var menu = document.getElementById('topologyFsAddMenu');
  // Database stays in the menu and pivots to a submenu — every other
  // option closes the menu and routes elsewhere.
  if (menu && kind !== 'database') menu.classList.remove('open');

  switch (kind) {
    case 'git':
      // P4 Part 18 (UX rework): Phase B G1 landed real multi-repo
      // clone, so "+ Add → GitHub Repository" from the topology view
      // now routes to the SAME create-project-with-clone flow that
      // projects.html exposes. The prior "explainer modal" stub was
      // buggy (close button silently no-oped because its CSS class
      // didn't exist) and is removed entirely — we ship the real
      // thing instead.
      //
      // Redirect to projects.html with ?new=git so the landing page
      // auto-opens the create modal focused on the git URL field.
      // No death loop: the create modal is modal, user fills URL,
      // hits create, watches the SSE clone modal, done.
      location.href = '/project-list?new=git';
      break;
    case 'database':
      // P4 Part 10: show the Database submenu (PostgreSQL / Redis /
      // MongoDB / MySQL) instead of routing to the legacy modal.
      // The menu stays open — user picks one and we POST /api/infra.
      _topologyShowDatabaseSubmenu();
      var m = document.getElementById('topologyFsAddMenu');
      if (m) m.classList.add('open');
      return;
    case 'docker':
      // UF-10: openInfraModal() writes into the global #configModal
      // overlay, which lives outside both #branchList and #topologyView
      // DOM roots. No need to flip viewMode — calling it directly
      // opens the modal ON TOP of whatever view is active.
      if (typeof openInfraModal === 'function') openInfraModal();
      break;
    case 'routing':
      // UF-10: same story — openRoutingModal() is a self-contained
      // modal. The previous code was calling a non-existent
      // renderRoutingRules() symbol AND switching views as a pointless
      // prelude. Both were bugs.
      if (typeof openRoutingModal === 'function') {
        openRoutingModal();
      } else {
        showToast('路由规则模块未加载', 'info');
      }
      break;
    case 'empty':
      // UF-10: "Empty Service" opens the build-profiles modal in place.
      // The legacy renderBuildProfiles() symbol never existed; the
      // real entry point is openProfileModal().
      if (typeof openProfileModal === 'function') {
        openProfileModal();
      } else {
        showToast('构建配置模块未加载', 'info');
      }
      break;
    case 'volume':
      // LIM-07: restore Volume UI entry. Opens the infra add modal which
      // already exposes the "卷名 / 挂载路径" fields (infraVolName /
      // infraVolPath). The user fills in a Docker image that mounts the
      // volume (e.g. postgres:16 / redis:7) and the volume is wired in.
      if (typeof openInfraAddModal === 'function') {
        openInfraAddModal();
      } else {
        showToast('基础设施模块未加载', 'info');
      }
      break;
    default:
      showToast('未知项类型: ' + kind, 'error');
  }
}

// T5: open the right slide-in service detail panel. `kind` is 'app'
// (BuildProfile) or 'infra' (InfraService); the function looks up the
// underlying entity and renders the Deployments tab content.
let _topologyPanelCurrentId = null;
let _topologyPanelCurrentKind = null;
function _topologyOpenServicePanel(id, kind) {
  var panel = document.getElementById('topologyFsPanel');
  var titleEl = document.getElementById('topologyFsPanelTitle');
  var iconEl = document.getElementById('topologyFsPanelIcon');
  if (!panel || !titleEl || !iconEl) return;

  _topologyPanelCurrentId = id;
  _topologyPanelCurrentKind = kind;

  // Find the entity. buildProfiles + infraServices are the two globals
  // already populated by loadProfiles() / loadInfraServices().
  var entity = null;
  if (kind === 'app') {
    entity = (buildProfiles || []).find(function (p) { return p.id === id; });
  } else if (kind === 'infra') {
    entity = (infraServices || []).find(function (s) { return s.id === id; });
  }

  titleEl.textContent = entity ? (entity.name || entity.id) : id;
  iconEl.innerHTML = kind === 'app'
    ? '<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>'
    : '<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M8 1c4 0 7 1 7 2.5v9c0 1.5-3 2.5-7 2.5s-7-1-7-2.5v-9C1 2 4 1 8 1z"/></svg>';

  // Reset to Details tab + render its content
  var tabs = panel.querySelectorAll('.topology-fs-panel-tab');
  tabs.forEach(function (t) { t.classList.toggle('active', t.dataset.tab === 'details'); });
  _topologyRenderPanelTab('details', entity);

  panel.classList.add('open');
}

// Switch active tab in the open panel
function _topologySwitchPanelTab(tab) {
  var panel = document.getElementById('topologyFsPanel');
  if (!panel) return;
  var tabs = panel.querySelectorAll('.topology-fs-panel-tab');
  tabs.forEach(function (t) { t.classList.toggle('active', t.dataset.tab === tab); });

  var entity = null;
  var id = _topologyPanelCurrentId;
  var kind = _topologyPanelCurrentKind;
  if (kind === 'app') {
    entity = (buildProfiles || []).find(function (p) { return p.id === id; });
  } else if (kind === 'infra') {
    entity = (infraServices || []).find(function (s) { return s.id === id; });
  }
  _topologyRenderPanelTab(tab, entity);
}

// Open the right panel on the Activity tab (no service node required).
function _topologyOpenActivityPanel() {
  var panel = document.getElementById('topologyFsPanel');
  var titleEl = document.getElementById('topologyFsPanelTitle');
  var iconEl = document.getElementById('topologyFsPanelIcon');
  if (!panel || !titleEl || !iconEl) return;

  _topologyPanelCurrentId = null;
  _topologyPanelCurrentKind = 'activity';
  titleEl.textContent = '系统活动';
  iconEl.innerHTML = '<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M1.5 1.75a.75.75 0 00-1.5 0v12.5c0 .414.336.75.75.75h14.5a.75.75 0 000-1.5H1.5V1.75zm14.28 2.53a.75.75 0 00-1.06-1.06L10 7.94 7.53 5.47a.75.75 0 00-1.06 0L2.22 9.72a.75.75 0 001.06 1.06L7 7.06l2.47 2.47a.75.75 0 001.06 0l5.25-5.25z"/></svg>';

  var tabs = panel.querySelectorAll('.topology-fs-panel-tab');
  tabs.forEach(function (t) { t.classList.toggle('active', t.dataset.tab === 'activity'); });

  var body = document.getElementById('topologyFsPanelBody');
  if (body) _topologyRenderActivityContent(body);
  panel.classList.add('open');
}

// Render the activity log content into the panel body.
function _topologyRenderActivityContent(body) {
  var cdsEvents = (typeof activityEvents !== 'undefined' ? activityEvents : []).slice(-100).reverse();
  var webEvents = (typeof webActivityEvents !== 'undefined' ? webActivityEvents : []).slice(-100).reverse();

  function _makeItems(events, isWeb) {
    if (!events.length) return '<div class="tfp-activity-empty">暂无记录</div>';
    return events.map(function (ev) {
      var isAi = ev.source === 'ai';
      var statusCls = (ev.status || 0) < 400 ? 'ok' : 'err';
      var dur = ev.duration < 1000 ? ev.duration + 'ms' : (ev.duration / 1000).toFixed(1) + 's';
      var ts = typeof toUTC8Time === 'function' ? toUTC8Time(ev.ts) : '';
      var label = ev.label || '';
      var shortPath = (ev.path || '').replace(/^\/api\//, '').replace(/branches\/([^/]{13,})/, function (_, id) { return id.slice(0, 10) + '…'; });
      var html = '';
      if (isAi) {
        var agentShort = (ev.agent || 'AI').replace(/\s*\(static key\)/, '');
        html += '<span class="activity-source ai">' + escapeHtml(agentShort) + '</span>';
      }
      if (!isWeb && ev.branchId) {
        var bl = typeof getBranchDisplayLabel === 'function' ? getBranchDisplayLabel(ev.branchId, ev.branchTags) : ev.branchId;
        html += '<span class="activity-source" style="background:var(--accent-bg);color:var(--accent);font-size:9px;font-weight:600;padding:1px 4px;border-radius:3px">' + escapeHtml(bl) + '</span>';
      }
      if (isWeb) {
        var profileId = ev.profileId || '';
        var isApi = profileId.includes('api') || profileId.includes('backend') || (ev.path || '').startsWith('/api/');
        var containerLabel = isApi ? 'api' : 'admin';
        var containerColor = isApi ? 'var(--blue)' : 'var(--green)';
        var containerBg = isApi ? 'rgba(56,139,253,0.12)' : 'rgba(63,185,80,0.12)';
        html += '<span class="web-container-badge" style="background:' + containerBg + ';color:' + containerColor + '">' + containerLabel + '</span>';
      } else {
        html += '<span class="activity-method ' + (ev.method || '') + '">' + (ev.method || '') + '</span>';
      }
      html += label
        ? '<span class="activity-label" title="' + escapeHtml(ev.path || '') + '">' + escapeHtml(label) + '</span>'
        : '<span class="activity-path">' + escapeHtml(shortPath) + '</span>';
      html += '<span class="activity-status ' + statusCls + '">' + (ev.status || '-') + '</span>';
      html += '<span class="activity-dur">' + dur + '</span>';
      html += '<span class="activity-ts">' + ts + '</span>';
      return '<div class="activity-item' + (isAi ? ' activity-item-ai' : '') + '" style="cursor:pointer">' + html + '</div>';
    }).join('');
  }

  body.innerHTML =
    '<div class="tfp-activity">' +
      '<div class="tfp-activity-subtabs">' +
        '<button type="button" class="tfp-activity-subtab active" data-subtab="cds" onclick="_topologyActivitySubTab(\'cds\')">' +
          'CDS <span class="tfp-activity-subtab-count" id="tfpActCdsCount">' + cdsEvents.length + '</span>' +
        '</button>' +
        '<button type="button" class="tfp-activity-subtab" data-subtab="web" onclick="_topologyActivitySubTab(\'web\')">' +
          'Web <span class="tfp-activity-subtab-count" id="tfpActWebCount">' + webEvents.length + '</span>' +
        '</button>' +
      '</div>' +
      '<div class="tfp-activity-body" id="tfpActivityCds">' + _makeItems(cdsEvents, false) + '</div>' +
      '<div class="tfp-activity-body" id="tfpActivityWeb" style="display:none">' + _makeItems(webEvents, true) + '</div>' +
    '</div>';
}

function _topologyActivitySubTab(subtab) {
  var el = document.querySelector('.tfp-activity');
  if (!el) return;
  el.querySelectorAll('.tfp-activity-subtab').forEach(function (t) {
    t.classList.toggle('active', t.dataset.subtab === subtab);
  });
  var cdsBody = document.getElementById('tfpActivityCds');
  var webBody = document.getElementById('tfpActivityWeb');
  if (cdsBody) cdsBody.style.display = subtab === 'cds' ? '' : 'none';
  if (webBody) webBody.style.display = subtab === 'web' ? '' : 'none';
}

// Render the body of one tab. Each branch is small + isolated so
// individual tabs can be replaced incrementally in later commits.
function _topologyRenderPanelTab(tab, entity) {
  var body = document.getElementById('topologyFsPanelBody');
  // Activity tab doesn't require an entity — it shows global system logs.
  if (tab === 'activity') {
    if (body) _topologyRenderActivityContent(body);
    return;
  }
  if (!body || !entity) {
    if (body) body.innerHTML = '<div class="tfp-empty">未找到服务数据</div>';
    return;
  }
  var kind = _topologyPanelCurrentKind;

  // P4 Part 14: Railway-style 5-tab layout (Details / Build Logs /
  // Deploy Logs / HTTP Logs / + extra Variables / Settings).
  //
  // Each tab pulls from its own data source:
  //   details     → entity metadata + commit + Build/Deploy config cards
  //   buildLogs   → /api/branches/:id/logs (operation log)
  //   deployLogs  → /api/branches/:id/container-logs?profileId=…
  //   httpLogs    → /api/activity-stream SSE (type:'web' events)
  //   variables   → entity.env (already implemented)
  //   settings    → service info + open-in-editor button (already)

  if (tab === 'details') {
    var image = entity.dockerImage || '-';
    var status = (entity.status || (entity.containerName ? 'running' : 'idle'));
    var deps = (entity.dependsOn || []);

    // Find a representative branch — prefer the topology-selected branch so
    // the panel reflects the branch the user explicitly picked or just added,
    // even when it is idle and a different branch is running.
    var displayBranch = null;
    if (kind === 'app' && (branches || []).length) {
      displayBranch = (_topologySelectedBranchId && branches.find(function (b) { return b.id === _topologySelectedBranchId; }))
        || branches.find(function (b) { return b.status === 'running'; })
        || branches[0];
    }
    var commitHash = displayBranch && displayBranch.commitSha ? displayBranch.commitSha.slice(0, 8) : '-';
    var commitSubject = displayBranch && displayBranch.subject ? displayBranch.subject : '';
    var branchName = displayBranch ? displayBranch.id : '-';

    var startCmd = entity.runCommand || entity.command || '-';
    var installCmd = entity.installCommand || '';
    var buildCmd = entity.buildCommand || '';
    var workDir = entity.workDir || '.';
    var port = entity.containerPort || '-';
    var hostPort = entity.hostPort ? ' → host :' + entity.hostPort : '';

    // P4 Part 18 (G5): Deploy / Redeploy button inline in the status banner.
    //
    // Previously topology view forced users to switch to list mode just to
    // hit "deploy". This is a P0 workflow regression — Railway has deploy
    // right on the service card. We mirror that: pick the topology-selected
    // branch (chip click) if any, else the currently displayed branch, and
    // delegate to the existing deployBranch() call. No new backend API.
    var deployTargetBranchId = _topologySelectedBranchId
      || (displayBranch && displayBranch.id)
      || null;
    // UF-16: real-time feedback for the Deploy button. Previously the
    // button fired deployBranch(id) and showed no visual change — user
    // didn't know if it started. Now we reflect three states from the
    // list-view's busyBranches / inlineDeployLogs / branches[] arrays:
    //   1. Idle → "Deploy" / "Redeploy"
    //   2. In flight → disabled + spinner + "部署中…"
    //   3. Post-deploy (server state = building/starting) → "重建中…"
    var isDeploying = !!deployTargetBranchId && (
      busyBranches.has(deployTargetBranchId)
      || (branches || []).some(function (b) {
        return b.id === deployTargetBranchId && (b.status === 'building' || b.status === 'starting');
      })
    );
    var deployBtnLabel = isDeploying
      ? '部署中…'
      : (status === 'running' ? '重新部署' : '部署');
    var deployBtnHtml = '';
    // GAP-01/02: Stop + Delete branch buttons for the topology Details
    // action bar. Previously, users had to switch to list view to hit
    // Stop or Delete. Both actions delegate to the same stopBranch() /
    // removeBranch() helpers that list view uses, so behaviour is 1:1.
    // Only enabled when we know which branch we'd act on; the branch
    // picker dropdown or auto-select must have picked one.
    var stopBtnHtml = '';
    var deleteBtnHtml = '';
    if (kind === 'app') {
      if (deployTargetBranchId) {
        // UF-16: busy-aware Deploy button with spinner
        var deployDisabled = isDeploying ? 'disabled' : '';
        var deployExtraClass = isDeploying ? ' busy' : '';
        var deploySpinner = isDeploying
          ? '<span class="btn-spinner" style="margin-right:6px"></span>'
          : '<svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor" style="margin-right:4px">' +
              '<path d="M1.5 8a.5.5 0 01.5-.5h10.793L9.146 3.854a.5.5 0 11.708-.708l4.5 4.5a.5.5 0 010 .708l-4.5 4.5a.5.5 0 01-.708-.708L12.793 8.5H2a.5.5 0 01-.5-.5z"/>' +
            '</svg>';
        // GAP-11: when the branch has multiple build profiles visible,
        // render Deploy as a split-button — main part deploys the whole
        // branch (same as before), while the ▾ chevron opens a dropdown
        // listing each profile so users can redeploy just one service.
        // Single-profile branches keep the plain Deploy button.
        var visibleProfiles = (buildProfiles || []).filter(function (p) { return !p.hidden; });
        var hasMultipleProfiles = visibleProfiles.length > 1;
        if (hasMultipleProfiles && !isDeploying) {
          deployBtnHtml =
            '<span class="tfp-deploy-split" data-branch-id="' + esc(deployTargetBranchId) + '">' +
              '<button type="button" class="tfp-deploy-btn tfp-deploy-btn-main' + deployExtraClass + '" ' +
              deployDisabled + ' ' +
              'onclick="event.stopPropagation();deployBranch(\'' + esc(deployTargetBranchId) + '\')" ' +
              'title="' + deployBtnLabel + ' ' + esc(deployTargetBranchId) + '">' +
                deploySpinner +
                deployBtnLabel +
              '</button>' +
              '<button type="button" class="tfp-deploy-btn tfp-deploy-btn-chevron" ' +
              'onclick="event.stopPropagation();_topologyToggleDeploySplitMenu(\'' + esc(deployTargetBranchId) + '\',event)" ' +
              'title="选择要重新部署的单个服务">' +
                '<svg width="9" height="9" viewBox="0 0 16 16" fill="currentColor">' +
                  '<path d="M4.427 7.427l3.396 3.396a.25.25 0 00.354 0l3.396-3.396A.25.25 0 0011.396 7H4.604a.25.25 0 00-.177.427z"/>' +
                '</svg>' +
              '</button>' +
            '</span>';
        } else {
          deployBtnHtml =
            '<button type="button" class="tfp-deploy-btn' + deployExtraClass + '" ' +
            deployDisabled + ' ' +
            (isDeploying ? '' : 'onclick="event.stopPropagation();deployBranch(\'' + esc(deployTargetBranchId) + '\')" ') +
            'title="' + deployBtnLabel + ' ' + esc(deployTargetBranchId) + '">' +
              deploySpinner +
              deployBtnLabel +
            '</button>';
        }
        // GAP-01: Stop button — only meaningful when the branch is
        // actually running. We let the user click it regardless and
        // let the backend return a no-op if there's nothing to stop.
        // UF-16: disabled + spinner when the branch is transitioning
        // (status=stopping|deleting or busy).
        var branchForState = (branches || []).find(function (b) { return b.id === deployTargetBranchId; });
        var isStopping = branchForState && branchForState.status === 'stopping';
        var isDeleting = branchForState && branchForState.status === 'deleting';
        var isErrored = branchForState && branchForState.status === 'error';
        var stopSpinner = isStopping
          ? '<span class="btn-spinner" style="margin-right:4px"></span>'
          : '<svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor" style="margin-right:4px"><path d="M4 4h8v8H4V4z"/></svg>';
        stopBtnHtml =
          '<button type="button" class="tfp-stop-btn' + (isStopping ? ' busy' : '') + '" ' +
          (isStopping || isDeploying ? 'disabled ' : '') +
          (isStopping || isDeploying ? '' : 'onclick="event.stopPropagation();stopBranch(\'' + esc(deployTargetBranchId) + '\')" ') +
          'title="' + (isStopping ? '正在停止…' : '停止该分支的所有容器') + '">' +
            stopSpinner +
            (isStopping ? '停止中' : '停止') +
          '</button>';
        // GAP-12: Reset button — only visible when the branch is in
        // `error` state. Delegates to resetBranch() (same call as list
        // view). Amber tint to match Stop, but distinct icon (refresh
        // arrow) so users can tell them apart at a glance.
        var resetBtnHtml = '';
        if (isErrored) {
          resetBtnHtml =
            '<button type="button" class="tfp-reset-btn" ' +
            'onclick="event.stopPropagation();resetBranch(\'' + esc(deployTargetBranchId) + '\')" ' +
            'title="清除 error 标记,允许重新部署">' +
              '<svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor" style="margin-right:4px">' +
                '<path d="M8 2.5a5.487 5.487 0 00-4.131 1.869l1.204 1.204A.25.25 0 014.896 6H1.25A.25.25 0 011 5.75V2.104a.25.25 0 01.427-.177l1.38 1.38A7.002 7.002 0 0115 8a.75.75 0 01-1.5 0A5.5 5.5 0 008 2.5zM2.5 8a.75.75 0 00-1.5 0 7.002 7.002 0 0012.023 4.87l1.38 1.38a.25.25 0 00.427-.177V10.5a.25.25 0 00-.25-.25h-3.646a.25.25 0 00-.177.427l1.204 1.204A5.5 5.5 0 012.5 8z"/>' +
              '</svg>' +
              '重置' +
            '</button>';
        }
        // GAP-02: Delete branch button — delegates to removeBranch,
        // which already has its own confirm dialog and cascade cleanup.
        var delSpinner = isDeleting
          ? '<span class="btn-spinner" style="margin-right:4px"></span>'
          : '<svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor" style="margin-right:4px"><path d="M11 1.75V3h2.25a.75.75 0 010 1.5H2.75a.75.75 0 010-1.5H5V1.75C5 .784 5.784 0 6.75 0h2.5C10.216 0 11 .784 11 1.75zM4.496 6.675a.75.75 0 10-1.492.15l.66 6.6A1.75 1.75 0 005.405 15h5.19c.9 0 1.652-.681 1.741-1.576l.66-6.6a.75.75 0 00-1.492-.149l-.66 6.6a.25.25 0 01-.249.225h-5.19a.25.25 0 01-.249-.225l-.66-6.6z"/></svg>';
        deleteBtnHtml =
          '<button type="button" class="tfp-delete-btn' + (isDeleting ? ' busy' : '') + '" ' +
          (isDeleting || isDeploying || isStopping ? 'disabled ' : '') +
          (isDeleting || isDeploying || isStopping ? '' : 'onclick="event.stopPropagation();removeBranch(\'' + esc(deployTargetBranchId) + '\')" ') +
          'title="' + (isDeleting ? '正在删除…' : '删除该分支(会连带清理 worktree 和容器)') + '">' +
            delSpinner +
            (isDeleting ? '删除中' : '删除') +
          '</button>';
      } else {
        deployBtnHtml =
          '<button type="button" class="tfp-deploy-btn disabled" disabled ' +
          'title="尚未选择分支，先在左侧或顶部分支条里选一个">' +
            '无分支' +
          '</button>';
      }
    }

    body.innerHTML =
      // Status banner
      '<div class="tfp-status-banner ' + (status === 'running' ? 'ok' : status === 'error' ? 'err' : 'idle') + (isDeploying ? ' deploying' : '') + '">' +
        (isDeploying
          ? '<span class="live-dot" style="background:#f59e0b"></span>'
          : '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">' +
              (status === 'running'
                ? '<path d="M13.78 4.22a.75.75 0 010 1.06l-7.25 7.25a.75.75 0 01-1.06 0L2.22 9.28a.75.75 0 011.06-1.06L6 10.94l6.72-6.72a.75.75 0 011.06 0z"/>'
                : '<circle cx="8" cy="8" r="5"/>') +
            '</svg>') +
        '<span>' + (isDeploying ? '正在部署…' : (status === 'running' ? '服务运行中' : '状态: ' + status)) + '</span>' +
        '<div style="margin-left:auto;display:flex;align-items:center;gap:8px;min-width:0;flex-wrap:wrap">' +
          deployBtnHtml +
          stopBtnHtml +
          // GAP-12: reset button sits between Stop and Delete, only when branch.status === 'error'
          (typeof resetBtnHtml === 'string' ? resetBtnHtml : '') +
          deleteBtnHtml +
          '<span style="font-size:11px;opacity:0.7;white-space:nowrap">' + esc(image) + '</span>' +
        '</div>' +
      '</div>' +

      // UF-16: inline deploy log preview. Mirrors the list view's
      // per-card log. Reads from the SAME inlineDeployLogs map that
      // deployBranch() writes into, so any ongoing deploy (no matter
      // which view initiated it) surfaces here. Updated live by
      // _topologyUpdateInlineLog() called from the SSE chunk handler.
      (isDeploying && deployTargetBranchId && inlineDeployLogs.get(deployTargetBranchId)
        ? (function () {
            var log = inlineDeployLogs.get(deployTargetBranchId);
            var recent = (log.lines || []).filter(function (l) { return l && l.trim(); }).slice(-8).join('\n');
            return '<div class="tfp-deploy-log-preview" id="tfp-deploy-log-' + esc(deployTargetBranchId) + '" ' +
                   'onclick="event.stopPropagation();openFullDeployLog(\'' + esc(deployTargetBranchId) + '\', event)" ' +
                   'title="点击查看完整部署日志">' +
              '<div class="tfp-deploy-log-header">' +
                '<span class="live-dot" style="background:#f59e0b"></span>' +
                '<span>部署日志 · 点击展开</span>' +
              '</div>' +
              '<pre class="tfp-deploy-log-body">' + esc(recent || '正在启动…') + '</pre>' +
            '</div>';
          })()
        : '') +

      // Variables count (link to Variables tab)
      '<div class="tfp-mini-stat" onclick="_topologySwitchPanelTab(\'variables\')">' +
        '<svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor"><path d="M2 4h12v2H2V4zm0 6h12v2H2v-2z"/></svg>' +
        Object.keys(entity.env || {}).length + ' Variables' +
      '</div>' +

      // P4 Part 18 (G6): Public URL row.
      //
      // Users previously had no visible public URL in the topology panel —
      // they had to guess the subdomain format, or leave the panel and hit
      // the preview icon in list view. Now the URL is front-and-center.
      //
      // The display value depends on previewMode (set once at page load
      // from /api/config):
      //   multi  → {slug}.{previewDomain}           (static, displayable)
      //   port   → "动态端口 (点击分配)"               (requires API call)
      //   simple → mainDomain or hostname:workerPort (cookie-switched)
      //
      // Click delegates to previewBranch() which already handles all three
      // modes end-to-end.
      (kind === 'app' && displayBranch ? (function () {
        var urlDisplay = '';
        var urlHint = '';
        // 同 previewBranch：优先用后端 v3 previewSlug，缺失才回落到 entry.id
        var slug = displayBranch.previewSlug
          || ((typeof StateService_slugify === 'function')
              ? StateService_slugify(displayBranch.id)
              : displayBranch.id);
        if (previewMode === 'multi' && previewDomain) {
          urlDisplay = slug + '.' + previewDomain;
          urlHint = '子域名模式 · 点击在新窗口打开';
        } else if (previewMode === 'port') {
          urlDisplay = location.hostname + ':<动态端口>';
          urlHint = '端口模式 · 点击分配并打开';
        } else if (previewMode === 'simple' && mainDomain) {
          urlDisplay = mainDomain;
          urlHint = '简洁模式 · 点击切换为默认分支并打开';
        } else if (workerPort) {
          urlDisplay = location.hostname + ':' + workerPort;
          urlHint = '本地 Worker 端口';
        } else {
          urlDisplay = '未配置 MAIN_DOMAIN';
          urlHint = '请在设置页配置 previewMode / MAIN_DOMAIN';
        }
        var canOpen = !(urlDisplay === '未配置 MAIN_DOMAIN');
        return '<div class="tfp-section-h">公开地址</div>' +
          '<div class="tfp-public-url-card' + (canOpen ? '' : ' disabled') + '"' +
            (canOpen ? ' onclick="previewBranch(\'' + esc(displayBranch.id) + '\')"' : '') +
            ' title="' + esc(urlHint) + '">' +
            '<svg width="15" height="15" viewBox="0 0 16 16" fill="currentColor" style="flex-shrink:0;opacity:0.85">' +
              '<path d="M0 8a8 8 0 1116 0A8 8 0 010 8zm7.5-6.923c-.67.204-1.335.82-1.887 1.855-.143.268-.276.56-.395.872.705.157 1.472.257 2.282.287V1.077zM4.249 3.539c.142-.384.304-.744.481-1.078a6.7 6.7 0 01.597-.933A7.01 7.01 0 003.051 3.05c.362.184.763.349 1.198.49zM3.509 7.5c.036-1.07.188-2.087.436-3.008a9.124 9.124 0 01-1.565-.667A6.964 6.964 0 001.018 7.5h2.49zm1.4-2.741a12.344 12.344 0 00-.4 2.741H7.5V5.091c-.91-.03-1.783-.145-2.591-.332zM8.5 5.09V7.5h2.99a12.342 12.342 0 00-.399-2.741c-.808.187-1.681.301-2.591.332zM4.51 8.5c.035.987.176 1.914.399 2.741A13.612 13.612 0 017.5 10.91V8.5H4.51zm3.99 0v2.409c.91.03 1.783.145 2.591.332.223-.827.364-1.754.4-2.741H8.5zm-3.282 3.696c.12.312.252.604.395.872.552 1.035 1.218 1.65 1.887 1.855V11.91c-.81.03-1.577.13-2.282.287zm.11 2.276a6.696 6.696 0 01-.598-.933 8.853 8.853 0 01-.481-1.079 8.38 8.38 0 00-1.198.49 7.01 7.01 0 002.276 1.522zm-1.383-2.964A13.36 13.36 0 013.508 8.5h-2.49a6.963 6.963 0 001.362 3.675c.47-.258.995-.482 1.565-.667zm6.728 2.964a7.009 7.009 0 002.275-1.521 8.376 8.376 0 00-1.197-.49 8.853 8.853 0 01-.481 1.078 6.696 6.696 0 01-.597.933zM8.5 11.909v3.014c.67-.204 1.335-.82 1.887-1.855.143-.268.276-.56.395-.872A12.63 12.63 0 008.5 11.91zm3.555-.401c.57.185 1.095.409 1.565.667A6.963 6.963 0 0014.982 8.5h-2.49a13.36 13.36 0 01-.437 3.008zM14.982 7.5a6.963 6.963 0 00-1.362-3.675c-.47.258-.995.482-1.565.667.248.92.4 1.938.437 3.008h2.49zM11.27 2.461c.177.334.339.694.482 1.078a8.368 8.368 0 001.196-.49 7.01 7.01 0 00-2.275-1.521c.218.283.418.597.597.933zm-.488 1.343a7.765 7.765 0 00-.395-.872C9.835 1.897 9.17 1.282 8.5 1.077V4.09c.81-.03 1.577-.13 2.282-.287z"/>' +
            '</svg>' +
            '<div class="tfp-public-url-text">' +
              '<div class="tfp-public-url-value">' + esc(urlDisplay) + '</div>' +
              '<div class="tfp-public-url-hint">' + esc(urlHint) + '</div>' +
            '</div>' +
            (canOpen
              ? '<svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor" style="flex-shrink:0;opacity:0.6"><path d="M8.636 3.5a.5.5 0 00-.5-.5H1.5A1.5 1.5 0 000 4.5v10A1.5 1.5 0 001.5 16h10a1.5 1.5 0 001.5-1.5V7.864a.5.5 0 00-1 0V14.5a.5.5 0 01-.5.5h-10a.5.5 0 01-.5-.5v-10a.5.5 0 01.5-.5h6.636a.5.5 0 00.5-.5z"/><path d="M16 .5a.5.5 0 00-.5-.5h-5a.5.5 0 000 1h3.793L6.146 9.146a.5.5 0 10.708.708L15 1.707V5.5a.5.5 0 001 0v-5z"/></svg>'
              : '') +
          '</div>';
      })() : '') +

      // Deployed via section
      (kind === 'app' && displayBranch ? (
        '<div class="tfp-section-h">DEPLOYED VIA GIT</div>' +
        '<div class="tfp-deploy-card">' +
          '<div class="tfp-deploy-card-head">' +
            '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>' +
            '<div class="tfp-deploy-meta">' + esc(commitSubject || branchName) + '</div>' +
            // GAP-14: open commit history modal. List view has
            // toggleCommitLog() which inline-expands under the card;
            // topology has no anchor to hang that off, so we open a
            // self-contained modal that reuses /git-log and the same
            // click-to-checkout flow.
            '<button type="button" class="tfp-commit-history-btn" ' +
              'onclick="event.stopPropagation();_topologyOpenCommitHistory(\'' + esc(branchName) + '\')" ' +
              'title="查看本分支最近 15 条提交,点击切换 build 基点">' +
              '<svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor" style="margin-right:3px">' +
                '<path d="M1.643 3.143L.427 1.927A.25.25 0 000 2.104V5.75c0 .138.112.25.25.25h3.646a.25.25 0 00.177-.427L2.715 4.215a6.5 6.5 0 11-1.18 4.458.75.75 0 10-1.493.154 8.001 8.001 0 101.6-5.684zM7.75 4a.75.75 0 01.75.75v2.992l2.028.812a.75.75 0 01-.557 1.392l-2.5-1A.75.75 0 017 8.25v-3.5A.75.75 0 017.75 4z"/>' +
              '</svg>' +
              '查看历史' +
            '</button>' +
          '</div>' +
          '<div style="display:flex;align-items:center;gap:10px;font-size:11px;color:var(--text-muted);font-family:var(--font-mono,monospace)">' +
            '<span style="display:inline-flex;align-items:center;gap:3px"><svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor"><path d="M1.75 1A1.75 1.75 0 000 2.75v10.5C0 14.216.784 15 1.75 15h12.5A1.75 1.75 0 0016 13.25v-8.5A1.75 1.75 0 0014.25 3H7.5a.25.25 0 01-.2-.1l-.9-1.2C6.07 1.26 5.55 1 5 1H1.75z"/></svg>' + esc(branchName) + '</span>' +
            '<span>·</span>' +
            '<span>' + esc(commitHash) + '</span>' +
          '</div>' +
        '</div>'
      ) : '') +

      // Configuration: Build + Deploy cards (Railway Image 1 layout)
      '<div class="tfp-section-h">CONFIGURATION</div>' +
      '<div class="tfp-config-grid">' +
        '<div class="tfp-config-card">' +
          '<div class="tfp-config-card-title">' +
            '<svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor"><path d="M2 2h12v3H2V2zm0 5h12v2H2V7zm0 4h12v3H2v-3z"/></svg>' +
            'Build' +
          '</div>' +
          '<div class="tfp-config-field"><div class="tfp-config-label">Image</div><div class="tfp-config-value">' + esc(image) + '</div></div>' +
          (installCmd ? '<div class="tfp-config-field"><div class="tfp-config-label">Install</div><div class="tfp-config-value">' + esc(installCmd) + '</div></div>' : '') +
          (buildCmd ? '<div class="tfp-config-field"><div class="tfp-config-label">Build</div><div class="tfp-config-value">' + esc(buildCmd) + '</div></div>' : '') +
        '</div>' +
        '<div class="tfp-config-card">' +
          '<div class="tfp-config-card-title">' +
            '<svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor"><path d="M0 8a8 8 0 1116 0A8 8 0 010 8zm8-7a7 7 0 00-7 7 7 7 0 0014 0 7 7 0 00-7-7z"/></svg>' +
            'Deploy' +
          '</div>' +
          '<div class="tfp-config-field"><div class="tfp-config-label">Start command</div><div class="tfp-config-value">' + esc(startCmd) + '</div></div>' +
          '<div class="tfp-config-field"><div class="tfp-config-label">Work dir</div><div class="tfp-config-value">' + esc(workDir) + '</div></div>' +
          '<div class="tfp-config-field"><div class="tfp-config-label">Port</div><div class="tfp-config-value">' + esc(String(port)) + esc(hostPort) + '</div></div>' +
        '</div>' +
      '</div>' +

      (deps.length ? '<div class="tfp-section-h">DEPENDENCIES</div>' + deps.map(function (d) { return '<div class="tfp-kv"><span class="tfp-kv-key">' + esc(d) + '</span><span class="tfp-kv-val">→</span></div>'; }).join('') : '');
    return;
  }

  if (tab === 'buildLogs') {
    body.innerHTML =
      '<div class="tfp-logs-toolbar">' +
        '<input class="tfp-logs-search" placeholder="Search build logs" oninput="_topologyFilterLogs(this.value, \'build\')">' +
        '<button type="button" class="tfp-vars-edit-btn" onclick="_topologyPanelLoadBuildLogs()">' +
          '<svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor"><path d="M8 2.5a5.487 5.487 0 00-4.131 1.869l1.204 1.204A.25.25 0 014.896 6H1.25A.25.25 0 011 5.75V2.104a.25.25 0 01.427-.177l1.38 1.38A7.002 7.002 0 0115 8a.75.75 0 01-1.5 0A5.5 5.5 0 008 2.5z"/></svg>' +
          '刷新' +
        '</button>' +
      '</div>' +
      '<div id="tfpBuildLogs" class="tfp-logs-table">' +
        '<div class="tfp-logs-loading">加载构建日志中…</div>' +
      '</div>';
    _topologyPanelLoadBuildLogs();
    return;
  }

  if (tab === 'deployLogs') {
    body.innerHTML =
      '<div class="tfp-logs-toolbar">' +
        '<input class="tfp-logs-search" placeholder="Filter and search logs" oninput="_topologyFilterLogs(this.value, \'deploy\')">' +
        '<button type="button" class="tfp-vars-edit-btn" onclick="_topologyPanelLoadDeployLogs()">' +
          '<svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor"><path d="M8 2.5a5.487 5.487 0 00-4.131 1.869l1.204 1.204A.25.25 0 014.896 6H1.25A.25.25 0 011 5.75V2.104a.25.25 0 01.427-.177l1.38 1.38A7.002 7.002 0 0115 8a.75.75 0 01-1.5 0A5.5 5.5 0 008 2.5z"/></svg>' +
          '刷新' +
        '</button>' +
      '</div>' +
      '<div id="tfpDeployLogs" class="tfp-logs-table">' +
        '<div class="tfp-logs-loading">加载部署日志中…</div>' +
      '</div>';
    _topologyPanelLoadDeployLogs();
    return;
  }

  if (tab === 'httpLogs') {
    body.innerHTML =
      '<div class="tfp-logs-toolbar">' +
        '<input class="tfp-logs-search" placeholder="Search HTTP logs e.g. /api/projects 200" oninput="_topologyFilterLogs(this.value, \'http\')">' +
        '<button type="button" class="tfp-vars-edit-btn" onclick="_topologyPanelLoadHttpLogs()">' +
          '<svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor"><path d="M8 2.5a5.487 5.487 0 00-4.131 1.869l1.204 1.204A.25.25 0 014.896 6H1.25A.25.25 0 011 5.75V2.104a.25.25 0 01.427-.177l1.38 1.38A7.002 7.002 0 0115 8a.75.75 0 01-1.5 0A5.5 5.5 0 008 2.5z"/></svg>' +
          '刷新' +
        '</button>' +
      '</div>' +
      '<div id="tfpHttpLogs" class="tfp-http-logs">' +
        '<div class="tfp-logs-loading">加载 HTTP 日志中…</div>' +
      '</div>';
    _topologyPanelLoadHttpLogs();
    return;
  }

  if (tab === 'networkFlowLogs') {
    // P4 Part 15: Network Flow Logs placeholder.
    //
    // Railway's Network Flow Logs tab shows L4 connection-level data:
    // Source IP:port / Destination / Peer (Internet vs Service) /
    // Traffic bytes / Latency / Status. CDS doesn't have this data
    // source — collecting it would require eBPF tracing or tcpdump
    // packet capture, both of which need root + kernel modules and
    // are out of scope for a single-host development tool.
    //
    // We render a clear placeholder explaining the gap so the tab
    // appears in the strip (visual parity with Railway's 5-tab
    // layout) but doesn't pretend to have data it doesn't.
    body.innerHTML =
      '<div class="tfp-empty" style="padding:40px 24px;text-align:left;background:var(--bg-card);border:1px dashed var(--card-border);border-radius:10px">' +
        '<div style="display:flex;align-items:center;gap:10px;margin-bottom:14px">' +
          '<svg width="22" height="22" viewBox="0 0 16 16" fill="currentColor" style="color:var(--text-muted)"><path d="M8 0a8 8 0 100 16A8 8 0 008 0zm0 1.5a6.5 6.5 0 110 13 6.5 6.5 0 010-13z"/></svg>' +
          '<div style="font-size:13px;font-weight:700;color:var(--text-primary)">Network Flow Logs</div>' +
        '</div>' +
        '<div style="font-size:12px;color:var(--text-secondary);line-height:1.6;margin-bottom:14px">' +
          'L4 连接级流量日志（Source / Destination / Traffic bytes / Latency）需要 <strong>eBPF tracing</strong> 或 <strong>tcpdump 包捕获</strong>，两者都需要 root + 内核模块。' +
        '</div>' +
        '<div style="font-size:12px;color:var(--text-secondary);line-height:1.6;margin-bottom:14px">' +
          'CDS 是单机轻量调试器，不收集这一级的数据。如果你需要查看容器之间的流量：' +
        '</div>' +
        '<ul style="font-size:11px;color:var(--text-muted);line-height:1.8;padding-left:18px;margin-bottom:14px">' +
          '<li><code>docker exec ' + esc(entity.containerName || entity.id) + ' ss -tn4</code> — 当前 TCP 连接快照</li>' +
          '<li><code>docker network inspect ' + esc((typeof config !== "undefined" && config && config.dockerNetwork) || "cds-network") + '</code> — 网络拓扑</li>' +
          '<li>访问已有的 <strong>HTTP Logs</strong> tab → CDS 内置代理捕获的 L7 HTTP 请求</li>' +
        '</ul>' +
        '<button type="button" class="tfp-vars-edit-btn" onclick="_topologySwitchPanelTab(\'httpLogs\')" style="width:100%">' +
          '查看 HTTP Logs（CDS 实际有的数据）→' +
        '</button>' +
      '</div>';
    return;
  }

  if (tab === 'variables') {
    // UF-09: inherit + override aware Variables tab.
    //
    // Two modes depending on whether a branch is selected:
    //   A. No branch (共享视图) → read-only snapshot of the profile
    //      baseline env. This matches the old behaviour.
    //   B. Branch selected + app kind → fetch
    //      `GET /branches/:branchId/profile-overrides`, find the row
    //      for the current profile, and render keys with:
    //        - An "eye" toggle: closed = 继承 (key not in override),
    //          open = 已覆盖 (key present in override)
    //        - KEY column: read-only monospace
    //        - VALUE column: <input> when overriding, plain text when
    //          inheriting. Editing debounces a PUT that writes the
    //          override back to the branch.
    //      The UX mirrors Railway: users see one unified table with
    //      visual indicators for inherited vs overridden, and can
    //      flip any row without leaving the topology view.
    //
    //   CDS infrastructure env keys (CDS_*) are always read-only and
    //   marked with a lock badge — they come from
    //   stateService.getCdsEnvVars() and overriding them would cut
    //   the container off from Mongo/Redis/etc.

    var branchId = (kind === 'app') ? _topologySelectedBranchId : null;

    if (!branchId) {
      // Mode A: no branch — plain read-only profile baseline view.
      var envA = entity.env || {};
      var keysA = Object.keys(envA).sort();
      var rowsA = keysA.length === 0
        ? '<div class="tfp-vars-empty">' +
          '  <div class="tfp-vars-empty-icon">' +
          '    <svg width="22" height="22" viewBox="0 0 16 16" fill="currentColor"><path d="M2.5 1.75v11.5a.25.25 0 00.25.25h10.5a.25.25 0 00.25-.25V6h-2.75A1.75 1.75 0 019 4.25V1.5H2.75a.25.25 0 00-.25.25zM10.5 1.5v2.75c0 .138.112.25.25.25H13.5L10.5 1.5zM1 1.75C1 .784 1.784 0 2.75 0h7.586c.464 0 .909.184 1.237.513l3.913 3.914c.329.328.514.773.514 1.237v7.586A1.75 1.75 0 0114.25 15H2.75A1.75 1.75 0 011 13.25V1.75z"/></svg>' +
          '  </div>' +
          '  <div class="tfp-vars-empty-title">还没有环境变量</div>' +
          '  <div class="tfp-vars-empty-desc">在编辑器里添加 key/value,部署时会注入到容器。选择一个分支后还能针对分支覆盖。</div>' +
          '</div>'
        : keysA.map(function (k) {
            var v = String(envA[k] == null ? '' : envA[k]);
            var isSecret = /(secret|password|token|key|apikey)/i.test(k);
            var displayVal = isSecret && v.length > 0 ? '••••••••' : v.slice(0, 80);
            return '<div class="tfp-var-row">' +
              '<span class="tfp-var-eye inherited" title="共享视图 — 选择分支可切换为可覆盖模式"><svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M1.679 7.932c.412-.621 1.242-1.75 2.366-2.717C5.175 4.242 6.527 3.5 8 3.5c1.473 0 2.824.742 3.955 1.715 1.124.967 1.954 2.096 2.366 2.717a.119.119 0 010 .136c-.412.621-1.242 1.75-2.366 2.717C10.825 11.758 9.473 12.5 8 12.5c-1.473 0-2.824-.742-3.955-1.715C2.92 9.818 2.09 8.69 1.679 8.068a.119.119 0 010-.136zM8 2C5.825 2 4.062 3.09 2.858 4.121c-1.207 1.035-2.083 2.232-2.514 2.884a1.62 1.62 0 000 1.79c.431.652 1.307 1.849 2.514 2.884C4.062 12.91 5.825 14 8 14c2.175 0 3.938-1.09 5.142-2.121 1.207-1.035 2.083-2.233 2.514-2.884a1.62 1.62 0 000-1.79c-.431-.652-1.307-1.849-2.514-2.884C11.938 3.09 10.175 2 8 2zm0 8a2 2 0 100-4 2 2 0 000 4z"/></svg></span>' +
              '<div class="tfp-var-key">' + esc(k) + '</div>' +
              '<div class="tfp-var-val">' + esc(displayVal) + (v.length > 80 ? '…' : '') + '</div>' +
              '<button type="button" class="tfp-var-icon-btn" title="复制" onclick="navigator.clipboard.writeText(' + JSON.stringify(v).replace(/"/g, '&quot;') + ');showToast(\'已复制\',\'info\')">' +
                '<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M0 6.75C0 5.784.784 5 1.75 5h1.5a.75.75 0 010 1.5h-1.5a.25.25 0 00-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 00.25-.25v-1.5a.75.75 0 011.5 0v1.5A1.75 1.75 0 019.25 16h-7.5A1.75 1.75 0 010 14.25v-7.5z"/></svg>' +
              '</button>' +
            '</div>';
          }).join('');

      body.innerHTML =
        '<div class="tfp-vars-toolbar">' +
          '<div class="tfp-vars-section-title">' +
            '<span>环境变量</span>' +
            '<span class="tfp-vars-count">' + keysA.length + '</span>' +
          '</div>' +
          '<button type="button" class="tfp-vars-edit-btn" onclick="_topologyPanelOpenEditor()">' +
            '<svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor"><path d="M11.013 1.427a1.75 1.75 0 012.474 0l1.086 1.086a1.75 1.75 0 010 2.474l-8.61 8.61c-.21.21-.47.364-.756.445l-3.251.93a.75.75 0 01-.927-.928l.929-3.25a1.75 1.75 0 01.445-.758l8.61-8.61z"/></svg>' +
            '编辑全部' +
          '</button>' +
        '</div>' +
        '<div class="tfp-vars-hint">在顶部选择分支可切换为"可覆盖"模式:每一行左侧的眼睛点亮就能编辑覆盖值</div>' +
        '<div class="tfp-vars-list">' + rowsA + '</div>' +
        (keysA.length > 0
          ? '<div class="tfp-vars-hint">敏感字段(含 secret / password / token / key)的值会自动遮罩,点 ⧉ 复制原值</div>'
          : '');
      return;
    }

    // Mode B: branch selected → async fetch overrides and render the
    // inherit+override UI. Show a brief loading state while the fetch
    // is in flight (typically a handful of ms).
    body.innerHTML =
      '<div class="tfp-vars-toolbar">' +
        '<div class="tfp-vars-section-title">' +
          '<span>Service Variables</span>' +
          '<span class="tfp-vars-count">…</span>' +
        '</div>' +
      '</div>' +
      '<div class="tfp-vars-empty"><span class="btn-spinner"></span> 正在加载继承与覆盖…</div>';

    _topologyRenderBranchScopedVariables(branchId, entity);
    return;
  }

  // P4 Part 18 cleanup: removed the `metrics` tab branch. It was
  // dead code — no element in topology-fs-panel-tabs had
  // data-tab="metrics", so users could never reach it. If metrics
  // land in a later phase, add the tab back AND a real data source.

  // GAP-04: routing rules tab inside the topology Details panel.
  // Pulls routing rules scoped to the currently-selected branch (or
  // all rules when no branch) and renders them as a read-only list
  // with a single "open full editor" button. Full CRUD lives in the
  // existing openRoutingModal() which is a global overlay, so no
  // view switch is required (UF-10).
  if (tab === 'routing') {
    var profileId = entity.id;
    // routingRules is a module-local variable declared at the top of
    // app.js; it's populated by loadRoutingRules() at pageload and
    // refreshed whenever the user edits rules via the full modal.
    var allRules = (typeof routingRules !== 'undefined' ? routingRules : []) || [];
    var rulesForProfile = allRules.filter(function (r) {
      return r.profileId === profileId || !r.profileId;
    });
    var rulesHtml = rulesForProfile.length === 0
      ? '<div class="tfp-vars-empty">' +
        '<div class="tfp-vars-empty-title">尚无路由规则</div>' +
        '<div class="tfp-vars-empty-desc">默认按 <code>X-Branch</code> 请求头或默认分支分发。<br>点下方"编辑路由"可添加基于 Host / Path / 匹配头的规则。</div>' +
        '</div>'
      : rulesForProfile.map(function (r) {
          var pieces = [];
          if (r.host) pieces.push('<code>' + esc(r.host) + '</code>');
          if (r.path) pieces.push('<code>' + esc(r.path) + '</code>');
          if (r.headerMatch) pieces.push('header:' + esc(r.headerMatch));
          var desc = pieces.length ? pieces.join(' · ') : '(默认)';
          return '<div class="tfp-var-row">' +
            '<span class="tfp-var-eye ' + (r.enabled ? 'override' : 'inherited') + '" title="' + (r.enabled ? '启用' : '已停用') + '"><svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M8 4a4 4 0 110 8 4 4 0 010-8zm0 2a2 2 0 100 4 2 2 0 000-4z"/></svg></span>' +
            '<div class="tfp-var-key">→ ' + esc(r.targetBranchId || '?') + '</div>' +
            '<div class="tfp-var-val">' + desc + '</div>' +
          '</div>';
        }).join('');
    body.innerHTML =
      '<div class="tfp-vars-toolbar">' +
        '<div class="tfp-vars-section-title">' +
          '<span>路由规则</span>' +
          '<span class="tfp-vars-count">' + rulesForProfile.length + '</span>' +
        '</div>' +
        '<button type="button" class="tfp-vars-edit-btn" onclick="_topologyOpenRoutingInPlace()">' +
          '<svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor"><path d="M11.013 1.427a1.75 1.75 0 012.474 0l1.086 1.086a1.75 1.75 0 010 2.474l-8.61 8.61c-.21.21-.47.364-.756.445l-3.251.93a.75.75 0 01-.927-.928l.929-3.25a1.75 1.75 0 01.445-.758l8.61-8.61z"/></svg>' +
          '编辑路由' +
        '</button>' +
      '</div>' +
      '<div class="tfp-vars-list">' + rulesHtml + '</div>';
    return;
  }

  // GAP-07: tags / notes tab. Shows arbitrary free-form notes stored
  // on the build profile `.notes` field plus structured tags from
  // `.tags`. Both are optional and read-only for now — the "编辑"
  // button routes to the full profile editor modal in place.
  if (tab === 'tags') {
    // GAP-13: wire the same add/remove/edit helpers that list view uses
    // so users can inline-manage tags from topology instead of having to
    // jump back to list view. `_topologySelectedBranchId` is the current
    // target; if none is selected we fall back to read-only with a hint.
    var notes = (entity.notes || '').trim();
    var targetBranchId = _topologySelectedBranchId;
    var targetBranch = targetBranchId
      ? (branches || []).find(function (b) { return b.id === targetBranchId; })
      : null;
    // Source tags: when a branch is selected, show its tags (the list
    // view's L12-L15 semantics are branch-level). When no branch is
    // selected, fall back to entity.tags (legacy behaviour, read-only).
    var tags = targetBranch
      ? (Array.isArray(targetBranch.tags) ? targetBranch.tags : [])
      : (Array.isArray(entity.tags) ? entity.tags : []);
    var notesHtml = notes
      ? '<div class="tfp-section-h">备注</div><div class="tfp-vars-hint" style="white-space:pre-wrap;line-height:1.55;padding:12px;background:var(--bg-elevated);border:1px solid var(--card-border);border-radius:8px">' + esc(notes) + '</div>'
      : '<div class="tfp-section-h">备注</div><div class="tfp-vars-empty"><div class="tfp-vars-empty-title">没有备注</div><div class="tfp-vars-empty-desc">打开完整编辑器可为该服务添加说明、联系人、跑批计划等自由文本</div></div>';

    var tagsHtml = '';
    if (targetBranchId) {
      // Editable branch tags: each chip gets a × remove button, plus a
      // "+ 标签" chip at the end that opens the prompt. We route the
      // clicks through the same addTagToBranch / removeTagFromBranch /
      // editBranchTags helpers the list view uses, so behaviour is 1:1.
      var chips = tags.map(function (t) {
        var safeTag = esc(String(t));
        return '<span class="tfp-tag-chip tfp-tag-chip-editable">' +
          safeTag +
          '<button type="button" class="tfp-tag-chip-remove" ' +
            'onclick="event.stopPropagation();removeTagFromBranch(\'' + esc(targetBranchId) + '\',\'' + safeTag.replace(/'/g, "\\'") + '\',event)" ' +
            'title="移除标签 ' + safeTag + '">' +
            '<svg width="9" height="9" viewBox="0 0 16 16" fill="currentColor"><path d="M3.72 3.72a.75.75 0 011.06 0L8 6.94l3.22-3.22a.75.75 0 111.06 1.06L9.06 8l3.22 3.22a.75.75 0 11-1.06 1.06L8 9.06l-3.22 3.22a.75.75 0 01-1.06-1.06L6.94 8 3.72 4.78a.75.75 0 010-1.06z"/></svg>' +
          '</button>' +
        '</span>';
      }).join('');
      var addChip =
        '<button type="button" class="tfp-tag-add-chip" ' +
          'onclick="event.stopPropagation();addTagToBranch(\'' + esc(targetBranchId) + '\',event)" ' +
          'title="给分支 ' + esc(targetBranchId) + ' 添加一个标签">' +
          '<svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor" style="margin-right:3px"><path d="M7.75 2a.75.75 0 01.75.75V7h4.25a.75.75 0 010 1.5H8.5v4.25a.75.75 0 01-1.5 0V8.5H2.75a.75.75 0 010-1.5H7V2.75A.75.75 0 017.75 2z"/></svg>' +
          '标签' +
        '</button>';
      var editAllBtn =
        '<button type="button" class="tfp-tag-edit-all" ' +
          'onclick="event.stopPropagation();editBranchTags(\'' + esc(targetBranchId) + '\',event)" ' +
          'title="用逗号分隔批量编辑">' +
          '<svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor" style="margin-right:3px"><path d="M11.013 1.427a1.75 1.75 0 012.474 0l1.086 1.086a1.75 1.75 0 010 2.474l-8.61 8.61c-.21.21-.47.364-.756.445l-3.251.93a.75.75 0 01-.927-.928l.929-3.25a1.75 1.75 0 01.445-.758l8.61-8.61z"/></svg>' +
          '批量编辑' +
        '</button>';
      tagsHtml =
        '<div class="tfp-section-h" style="margin-top:14px">标签 · ' + esc(targetBranchId) + '</div>' +
        '<div class="tfp-tags-row">' + chips + addChip + '</div>' +
        '<div style="margin-top:8px">' + editAllBtn + '</div>';
    } else {
      // No branch selected — read-only fallback with hint.
      var roChips = tags.length > 0
        ? tags.map(function (t) { return '<span class="tfp-tag-chip">' + esc(String(t)) + '</span>'; }).join('')
        : '<span class="tfp-vars-hint">(无标签)</span>';
      tagsHtml =
        '<div class="tfp-section-h" style="margin-top:14px">标签</div>' +
        '<div class="tfp-tags-row">' + roChips + '</div>' +
        '<div class="tfp-vars-hint" style="margin-top:8px">选一个分支才能编辑标签</div>';
    }
    body.innerHTML =
      '<div class="tfp-vars-toolbar">' +
        '<div class="tfp-vars-section-title"><span>备注 / 标签</span></div>' +
        '<button type="button" class="tfp-vars-edit-btn" onclick="_topologyPanelOpenEditor()">' +
          '<svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor"><path d="M11.013 1.427a1.75 1.75 0 012.474 0l1.086 1.086a1.75 1.75 0 010 2.474l-8.61 8.61c-.21.21-.47.364-.756.445l-3.251.93a.75.75 0 01-.927-.928l.929-3.25a1.75 1.75 0 01.445-.758l8.61-8.61z"/></svg>' +
          '编辑备注' +
        '</button>' +
      '</div>' +
      notesHtml + tagsHtml;
    return;
  }

  if (tab === 'settings') {
    // P4 Part 18 (G7): connection strings for infra services.
    //
    // Each supported infra type (mongo / redis / postgres / mysql) gets
    // two view rows:
    //   Host view      — from outside the CDS docker network. Uses
    //                    window.location.hostname + hostPort. This is
    //                    what you'd paste into a desktop DB GUI.
    //   Container view — from another container on the same network.
    //                    Uses containerName + containerPort. This is
    //                    what you'd put in an app's env vars to talk
    //                    to the DB service.
    //
    // Credentials are extracted from entity.env when present, else
    // fall back to sensible defaults (admin / change-me-please / postgres).
    // Passwords get masked with the same rule as the Variables tab
    // but the copy button copies the un-masked full string.
    var connBlock = '';
    if (kind === 'infra') {
      var conns = _topologyBuildConnStrings(entity);
      if (conns) {
        connBlock =
          '<div class="tfp-section-h">连接串</div>' +
          '<div class="tfp-conn-list">' +
            _topologyRenderConnRow('宿主机视角', conns.host, conns.hostMasked, conns.type + ' · 从宿主机或外部客户端连接') +
            _topologyRenderConnRow('容器视角', conns.container, conns.containerMasked, conns.type + ' · 从同一 Docker 网络内的其他容器连接') +
          '</div>' +
          '<div class="tfp-vars-hint" style="margin-top:10px">密码从环境变量（' + esc(conns.passwordEnvKey || '默认值') + '）读取，点 ⧉ 复制未遮罩的完整串</div>';
      }
    }

    // GAP-05 + GAP-15: deploy-mode block.
    //
    // GAP-05 shipped a read-only list of modes. GAP-15 makes each row
    // actionable: when a branch is selected (_topologySelectedBranchId),
    // clicking a row calls the same switchModeAndDeploy() helper used
    // by list view (L3). The currently active mode is marked with a ✓.
    // When no branch is selected, rows stay read-only with a hint so
    // users know to pick one first.
    var deployModeBlock = '';
    if (kind === 'app' && entity.deployModes && typeof entity.deployModes === 'object') {
      var modeKeys = Object.keys(entity.deployModes);
      if (modeKeys.length > 0) {
        var selectedBranchId = _topologySelectedBranchId;
        // The "current" mode identifier — prefer entity.defaultMode, fall
        // back to the first key. Matches the intent of L3 where a tick
        // sits next to whichever mode the profile is currently using.
        var activeModeId = entity.defaultMode || entity.activeDeployMode || modeKeys[0];
        var modeRows = modeKeys.map(function (k) {
          var mode = entity.deployModes[k];
          var modeLabel = typeof mode === 'string' ? mode : (mode && mode.mode) || '(未设置)';
          var isActive = k === activeModeId;
          var check = isActive
            ? '<svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor" style="margin-right:4px;color:var(--green,#10b981)"><path d="M13.78 4.22a.75.75 0 010 1.06l-7.25 7.25a.75.75 0 01-1.06 0L2.22 9.28a.75.75 0 011.06-1.06L6 10.94l6.72-6.72a.75.75 0 011.06 0z"/></svg>'
            : '<span style="display:inline-block;width:10px;margin-right:4px"></span>';
          if (selectedBranchId) {
            return '<div class="tfp-kv tfp-deploy-mode-row" ' +
              'onclick="event.stopPropagation();switchModeAndDeploy(\'' + esc(selectedBranchId) + '\',\'' + esc(entity.id) + '\',\'' + esc(k) + '\')" ' +
              'title="切换到「' + esc(modeLabel) + '」并重新部署 ' + esc(selectedBranchId) + '">' +
              '<span class="tfp-kv-key">' + check + esc(k) + '</span>' +
              '<span class="tfp-kv-val">' + esc(modeLabel) + '</span>' +
            '</div>';
          }
          return '<div class="tfp-kv">' +
            '<span class="tfp-kv-key">' + check + esc(k) + '</span>' +
            '<span class="tfp-kv-val">' + esc(modeLabel) + '</span>' +
          '</div>';
        }).join('');
        deployModeBlock =
          '<div class="tfp-section-h">部署模式</div>' +
          modeRows +
          '<div class="tfp-vars-hint" style="margin-top:6px">' +
            (selectedBranchId
              ? '点击任一行可切换模式并立即重新部署 <code>' + esc(selectedBranchId) + '</code>。'
              : '选一个分支后每行即可点击切换模式;当前只读。') +
          '</div>';
      } else {
        deployModeBlock =
          '<div class="tfp-section-h">部署模式</div>' +
          '<div class="tfp-vars-hint">未配置 — 所有分支使用默认"shared"策略。</div>';
      }
    }

    // GAP-06: cluster dispatch block. Shows which executor nodes have
    // this service's image / can run it. For MVP we list the known
    // executors and tag the one currently serving the selected branch.
    // Full scheduler wiring is a P5 concern; this gives the user the
    // info they need without any new backend.
    var clusterBlock = '';
    if (kind === 'app' && typeof executors !== 'undefined' && Array.isArray(executors) && executors.length > 0) {
      var execRows = executors.map(function (e) {
        var tag = e.role === 'master' ? '主节点' : '远端';
        return '<div class="tfp-kv">' +
          '<span class="tfp-kv-key">' + esc(e.id || e.nodeId || '?') + '</span>' +
          '<span class="tfp-kv-val">' + esc(tag) + ' · ' + esc((e.host || '-') + ':' + (e.port || '-')) + '</span>' +
        '</div>';
      }).join('');
      clusterBlock =
        '<div class="tfp-section-h">集群派发</div>' +
        execRows +
        '<div class="tfp-vars-hint" style="margin-top:6px">所有 executor 节点都能运行本服务。指定派发策略需在"集群设置"中配置(设置菜单 → 集群)。</div>';
    }

    body.innerHTML =
      '<div class="tfp-section-h">服务信息</div>' +
      '<div class="tfp-kv"><span class="tfp-kv-key">名称</span><span class="tfp-kv-val">' + esc(entity.name || entity.id) + '</span></div>' +
      '<div class="tfp-kv"><span class="tfp-kv-key">镜像</span><span class="tfp-kv-val">' + esc(entity.dockerImage || '-') + '</span></div>' +
      (entity.containerPort ? '<div class="tfp-kv"><span class="tfp-kv-key">容器端口</span><span class="tfp-kv-val">' + entity.containerPort + '</span></div>' : '') +
      (entity.hostPort ? '<div class="tfp-kv"><span class="tfp-kv-key">宿主端口</span><span class="tfp-kv-val">' + entity.hostPort + '</span></div>' : '') +
      (entity.workDir ? '<div class="tfp-kv"><span class="tfp-kv-key">工作目录</span><span class="tfp-kv-val">' + esc(entity.workDir) + '</span></div>' : '') +
      connBlock +
      deployModeBlock +
      clusterBlock +
      '<div style="margin-top:18px"><button type="button" class="tfp-view-logs-btn" style="width:100%;padding:9px" onclick="_topologyPanelOpenEditor()">打开完整编辑器</button></div>';
    return;
  }
}

// UF-09: branch-scoped variables view. Fetches profile overrides for
// a given branch and renders an inherit/override row table with inline
// editing, an eye toggle, and a "reset branch overrides" action.
//
// State is kept in a module-local var so the debounce write timer can
// reach the latest in-flight edits without re-plumbing every callback.
var _topologyVarsState = null; // { branchId, profileId, baseline, override, dirty, writeTimer }

async function _topologyRenderBranchScopedVariables(branchId, entity) {
  var body = document.getElementById('topologyFsPanelBody');
  if (!body) return;
  try {
    var data = await api('GET', '/branches/' + encodeURIComponent(branchId) + '/profile-overrides');
    var profileRow = (data.profiles || []).find(function (p) { return p.profileId === entity.id; });
    if (!profileRow) {
      body.innerHTML =
        '<div class="tfp-vars-empty">' +
          '<div class="tfp-vars-empty-title">该分支不认识这个服务</div>' +
          '<div class="tfp-vars-empty-desc">可能是该分支在当前项目之外,或服务是刚新增的。回到共享视图即可编辑基线值。</div>' +
        '</div>';
      return;
    }
    var baselineEnv = (profileRow.baseline && profileRow.baseline.env) || {};
    var overrideEnv = (profileRow.override && profileRow.override.env) || {};
    var cdsEnvKeys = profileRow.cdsEnvKeys || [];
    var cdsKeySet = new Set(cdsEnvKeys);

    _topologyVarsState = {
      branchId: branchId,
      profileId: entity.id,
      baselineEnv: baselineEnv,
      overrideEnv: overrideEnv ? Object.assign({}, overrideEnv) : {},
      cdsKeySet: cdsKeySet,
      writeTimer: null,
    };

    _topologyRenderVarsDom();
  } catch (e) {
    body.innerHTML =
      '<div class="tfp-vars-empty" style="color:var(--red)">' +
        '<div class="tfp-vars-empty-title">加载失败</div>' +
        '<div class="tfp-vars-empty-desc">' + esc(e && e.message ? e.message : String(e)) + '</div>' +
      '</div>';
  }
}

// Pure DOM render from _topologyVarsState. Called after the initial
// fetch and after any eye toggle / value edit so row badges and tag
// counts stay in sync.
function _topologyRenderVarsDom() {
  var state = _topologyVarsState;
  if (!state) return;
  var body = document.getElementById('topologyFsPanelBody');
  if (!body) return;

  var mergedKeys = Object.keys(Object.assign({}, state.baselineEnv, state.overrideEnv)).sort();
  var overriddenCount = mergedKeys.filter(function (k) { return k in state.overrideEnv; }).length;

  var rows = mergedKeys.map(function (k) {
    var isCds = state.cdsKeySet.has(k);
    var isOverridden = k in state.overrideEnv;
    var inheritValue = state.baselineEnv[k] == null ? '' : String(state.baselineEnv[k]);
    var overrideValue = state.overrideEnv[k] == null ? '' : String(state.overrideEnv[k]);
    var shownValue = isOverridden ? overrideValue : inheritValue;
    var isSecret = /(secret|password|token|key|apikey)/i.test(k);
    var eyeClass = isCds ? 'locked' : (isOverridden ? 'override' : 'inherited');
    var eyeTitle = isCds
      ? 'CDS 基础设施变量,不能覆盖'
      : (isOverridden ? '已覆盖 — 点击恢复继承' : '继承自构建配置 — 点击开启覆盖');

    // Eye icon: filled/unfilled based on state
    var eyeIcon = isOverridden && !isCds
      ? '<svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor"><path d="M1.679 7.932c.412-.621 1.242-1.75 2.366-2.717C5.175 4.242 6.527 3.5 8 3.5c1.473 0 2.824.742 3.955 1.715 1.124.967 1.954 2.096 2.366 2.717a.119.119 0 010 .136c-.412.621-1.242 1.75-2.366 2.717C10.825 11.758 9.473 12.5 8 12.5c-1.473 0-2.824-.742-3.955-1.715C2.92 9.818 2.09 8.69 1.679 8.068a.119.119 0 010-.136zM8 2C5.825 2 4.062 3.09 2.858 4.121c-1.207 1.035-2.083 2.232-2.514 2.884a1.62 1.62 0 000 1.79c.431.652 1.307 1.849 2.514 2.884C4.062 12.91 5.825 14 8 14c2.175 0 3.938-1.09 5.142-2.121 1.207-1.035 2.083-2.233 2.514-2.884a1.62 1.62 0 000-1.79c-.431-.652-1.307-1.849-2.514-2.884C11.938 3.09 10.175 2 8 2zm0 8a2 2 0 100-4 2 2 0 000 4z"/></svg>'
      : '<svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor"><path d="M.143 2.31a.75.75 0 011.047-.167l14 10a.75.75 0 11-.872 1.22L11.7 11.45a7.27 7.27 0 01-3.7 1.05c-2.175 0-3.938-1.09-5.142-2.121-1.207-1.035-2.083-2.233-2.514-2.884a1.62 1.62 0 010-1.79 12.11 12.11 0 011.989-2.319l-1.9-1.358a.75.75 0 01-.167-1.047zm3.16 3.4c-.418.361-.79.75-1.123 1.126-.332.377-.625.759-.85 1.104a.12.12 0 000 .136c.412.621 1.242 1.75 2.366 2.717C4.825 11.758 6.527 12.5 8 12.5a5.78 5.78 0 002.28-.49L8.85 10.995A2 2 0 016.045 8.19L3.303 5.71zM8 3.5c-.66 0-1.289.16-1.867.41L4.748 2.83A7.274 7.274 0 018 2c2.175 0 3.938 1.09 5.142 2.121 1.207 1.035 2.083 2.232 2.514 2.884.363.55.363 1.244 0 1.794-.307.465-.813 1.14-1.509 1.816l-1.062-.758a11.18 11.18 0 001.467-1.783.12.12 0 000-.136c-.412-.621-1.242-1.75-2.366-2.717C10.825 4.242 9.473 3.5 8 3.5zM6.5 8a1.5 1.5 0 002.122 1.364L5.822 7.365A1.5 1.5 0 006.5 8z"/></svg>';

    var valueCell;
    if (isCds) {
      valueCell = '<div class="tfp-var-val tfp-var-val-locked" title="CDS 基础设施变量,由 state 注入">' + esc(isSecret ? '••••••••' : inheritValue.slice(0, 80)) + '</div>';
    } else if (isOverridden) {
      valueCell = '<input class="tfp-var-val-input" type="text" ' +
        'value="' + esc(overrideValue).replace(/"/g, '&quot;') + '" ' +
        'placeholder="(空串)" ' +
        'oninput="_topologyVarsOnInput(' + JSON.stringify(k).replace(/"/g, '&quot;') + ',this.value)">';
    } else {
      var displayInherit = isSecret && inheritValue ? '••••••••' : inheritValue.slice(0, 80);
      valueCell = '<div class="tfp-var-val tfp-var-val-inherit" title="继承 — 点左侧眼睛覆盖">' + esc(displayInherit) + (inheritValue.length > 80 ? '…' : '') + '</div>';
    }

    var onClick = isCds ? '' : 'onclick="_topologyVarsToggleOverride(' + JSON.stringify(k).replace(/"/g, '&quot;') + ')"';
    void shownValue; // unused for now — used when we wire delete

    return '<div class="tfp-var-row ' + (isOverridden ? 'is-override' : '') + '">' +
      '<button type="button" class="tfp-var-eye ' + eyeClass + '" ' + onClick + ' title="' + esc(eyeTitle) + '">' + eyeIcon + '</button>' +
      '<div class="tfp-var-key">' + esc(k) + '</div>' +
      valueCell +
    '</div>';
  }).join('');

  body.innerHTML =
    '<div class="tfp-vars-toolbar">' +
      '<div class="tfp-vars-section-title">' +
        '<span>Service Variables</span>' +
        '<span class="tfp-vars-count">' + mergedKeys.length + '</span>' +
        (overriddenCount > 0
          ? '<span class="tfp-vars-count" style="background:rgba(16,185,129,0.18);color:var(--accent,#10b981)">已覆盖 ' + overriddenCount + '</span>'
          : '') +
      '</div>' +
      (overriddenCount > 0
        ? '<button type="button" class="tfp-vars-edit-btn" onclick="_topologyVarsResetBranch()" title="清除该分支的所有覆盖,恢复继承">重置本分支</button>'
        : '<button type="button" class="tfp-vars-edit-btn" onclick="_topologyPanelOpenEditor()">编辑全部</button>') +
    '</div>' +
    '<div class="tfp-vars-hint">点每一行左侧的眼睛:<span style="color:var(--text-muted)">闭眼=继承构建配置</span>,<span style="color:var(--accent)">开眼=为本分支覆盖</span>。编辑值会自动保存,下次部署生效。</div>' +
    '<div class="tfp-vars-list">' + rows + '</div>';
}

// Eye toggle handler — flips inherited ↔ overridden for one key.
async function _topologyVarsToggleOverride(key) {
  var state = _topologyVarsState;
  if (!state) return;
  if (state.cdsKeySet.has(key)) {
    showToast('CDS 基础设施变量不能覆盖', 'info');
    return;
  }
  var isOverridden = key in state.overrideEnv;
  if (isOverridden) {
    // Clear the override for this key, inherit from baseline.
    delete state.overrideEnv[key];
  } else {
    // Start overriding — seed with the current inherited value.
    state.overrideEnv[key] = state.baselineEnv[key] == null ? '' : String(state.baselineEnv[key]);
  }
  await _topologyVarsPersistImmediate();
  _topologyRenderVarsDom();
}

// Inline edit handler — debounces writes so rapid typing doesn't
// pound PUT. 400ms debounce matches list-view's override modal.
function _topologyVarsOnInput(key, value) {
  var state = _topologyVarsState;
  if (!state) return;
  state.overrideEnv[key] = value;
  if (state.writeTimer) clearTimeout(state.writeTimer);
  state.writeTimer = setTimeout(function () {
    _topologyVarsPersistImmediate().catch(function () { /* toast already shown */ });
  }, 400);
}

async function _topologyVarsPersistImmediate() {
  var state = _topologyVarsState;
  if (!state) return;
  try {
    // Send the whole override block so the backend can diff properly.
    // We don't include any CDS_* keys (they're filtered out client-side
    // by the cdsKeySet guard in the toggle handler).
    await api('PUT',
      '/branches/' + encodeURIComponent(state.branchId) + '/profile-overrides/' + encodeURIComponent(state.profileId),
      { env: state.overrideEnv });
  } catch (e) {
    showToast('保存失败: ' + (e && e.message ? e.message : e), 'error');
    throw e;
  }
}

// Reset all overrides for this branch+profile — reverts to pure inheritance.
async function _topologyVarsResetBranch() {
  var state = _topologyVarsState;
  if (!state) return;
  if (!confirm('确定清除该分支对本服务的所有覆盖,完全继承构建配置吗?')) return;
  try {
    await api('DELETE',
      '/branches/' + encodeURIComponent(state.branchId) + '/profile-overrides/' + encodeURIComponent(state.profileId));
    state.overrideEnv = {};
    showToast('已恢复继承', 'success');
    _topologyRenderVarsDom();
  } catch (e) {
    showToast('重置失败: ' + (e && e.message ? e.message : e), 'error');
  }
}

// UF-10: open routing rules modal in-place (no view switch).
function _topologyOpenRoutingInPlace() {
  if (typeof openRoutingModal === 'function') {
    openRoutingModal();
  } else {
    showToast('路由规则模块未加载', 'info');
  }
}

// GAP-08: single-click a port badge → copy "host:port" to clipboard.
// Double-click → open preview URL in a new tab.
function _topologyNodePortClick(entityId) {
  var entity = (buildProfiles || []).find(function (p) { return p.id === entityId; })
    || (infraServices || []).find(function (s) { return s.id === entityId; });
  if (!entity) return;
  var isApp = !!(buildProfiles || []).find(function (p) { return p.id === entityId; });
  var port = isApp ? entity.containerPort : entity.hostPort;
  if (!port) {
    showToast('该服务没有公开端口', 'info');
    return;
  }
  var host = (typeof location !== 'undefined' && location.hostname) || 'localhost';
  var str = host + ':' + port;
  if (navigator.clipboard) {
    navigator.clipboard.writeText(str).then(function () {
      showToast('已复制 ' + str, 'success');
    }, function () {
      showToast(str, 'info');
    });
  } else {
    showToast(str, 'info');
  }
}

function _topologyNodePortDblClick(entityId) {
  var entity = (buildProfiles || []).find(function (p) { return p.id === entityId; });
  if (entity && _topologySelectedBranchId && typeof previewBranch === 'function') {
    // Prefer the full previewBranch flow — it handles multi/port/simple
    // modes + subdomain/cookie switching. Match figure 1 UX where
    // clicking the endpoint jumps straight to the preview.
    previewBranch(_topologySelectedBranchId);
    return;
  }
  // Fallback: raw port URL.
  var isApp = !!entity;
  var infra = (infraServices || []).find(function (s) { return s.id === entityId; });
  var port = isApp ? entity.containerPort : (infra && infra.hostPort);
  if (!port) return;
  var host = (typeof location !== 'undefined' && location.hostname) || 'localhost';
  try { window.open('http://' + host + ':' + port, '_blank', 'noopener'); } catch (e) { /* no-op */ }
}

// P4 Part 18 (G7): build connection strings for a known infra type.
// Returns null for unknown images (generic services just don't get the
// conn-string block — they fall back to the SERVICE INFO kv rows).
function _topologyBuildConnStrings(entity) {
  var image = String(entity.dockerImage || '').toLowerCase();
  var hostPort = entity.hostPort;
  var containerPort = entity.containerPort;
  var containerName = entity.containerName || entity.id;
  var env = entity.env || {};
  var host = (typeof location !== 'undefined' && location.hostname) || 'localhost';

  // Helper: percent-encode a password segment so special chars don't
  // break the URI (e.g. a password containing '@' or '/').
  function enc(s) { return encodeURIComponent(String(s || '')); }
  // Helper: mask everything between '://[user]:' and '@' so passwords
  // don't show in plaintext until the user clicks copy.
  function maskPassword(s) {
    return String(s).replace(/:\/\/([^:@]*):([^@]*)@/, function (_m, u, _p) {
      return '://' + u + ':' + '••••••••' + '@';
    });
  }

  var type = null;
  var host4 = host;
  var hostP = hostPort;
  var cHost = containerName;
  var cP = containerPort;
  var hostStr = '';
  var containerStr = '';
  var passwordEnvKey = null;

  if (image.indexOf('mongo') >= 0) {
    type = 'mongodb';
    var mUser = env.MONGO_INITDB_ROOT_USERNAME || 'admin';
    var mPass = env.MONGO_INITDB_ROOT_PASSWORD || 'change-me-please';
    passwordEnvKey = env.MONGO_INITDB_ROOT_PASSWORD ? 'MONGO_INITDB_ROOT_PASSWORD' : null;
    hostStr = 'mongodb://' + mUser + ':' + enc(mPass) + '@' + host4 + ':' + hostP;
    containerStr = 'mongodb://' + mUser + ':' + enc(mPass) + '@' + cHost + ':' + cP;
  } else if (image.indexOf('redis') >= 0) {
    type = 'redis';
    var rPass = env.REDIS_PASSWORD || '';
    passwordEnvKey = env.REDIS_PASSWORD ? 'REDIS_PASSWORD' : null;
    var rPrefix = rPass ? 'redis://:' + enc(rPass) + '@' : 'redis://';
    hostStr = rPrefix + host4 + ':' + hostP;
    containerStr = rPrefix + cHost + ':' + cP;
  } else if (image.indexOf('postgres') >= 0) {
    type = 'postgresql';
    var pUser = env.POSTGRES_USER || 'postgres';
    var pPass = env.POSTGRES_PASSWORD || 'change-me-please';
    var pDb = env.POSTGRES_DB || 'app';
    passwordEnvKey = env.POSTGRES_PASSWORD ? 'POSTGRES_PASSWORD' : null;
    hostStr = 'postgresql://' + pUser + ':' + enc(pPass) + '@' + host4 + ':' + hostP + '/' + pDb;
    containerStr = 'postgresql://' + pUser + ':' + enc(pPass) + '@' + cHost + ':' + cP + '/' + pDb;
  } else if (image.indexOf('mysql') >= 0 || image.indexOf('mariadb') >= 0) {
    type = 'mysql';
    var yPass = env.MYSQL_ROOT_PASSWORD || 'change-me-please';
    var yDb = env.MYSQL_DATABASE || 'app';
    passwordEnvKey = env.MYSQL_ROOT_PASSWORD ? 'MYSQL_ROOT_PASSWORD' : null;
    hostStr = 'mysql://root:' + enc(yPass) + '@' + host4 + ':' + hostP + '/' + yDb;
    containerStr = 'mysql://root:' + enc(yPass) + '@' + cHost + ':' + cP + '/' + yDb;
  } else {
    return null;
  }

  return {
    type: type,
    host: hostStr,
    container: containerStr,
    hostMasked: maskPassword(hostStr),
    containerMasked: maskPassword(containerStr),
    passwordEnvKey: passwordEnvKey,
  };
}

// P4 Part 18 (G7): one row of the connection-strings block.
// Uses inline style so it survives without a new CSS class for every
// sub-element.
function _topologyRenderConnRow(label, fullValue, maskedValue, hint) {
  var safeJson = JSON.stringify(fullValue).replace(/"/g, '&quot;');
  return '<div class="tfp-conn-row">' +
    '<div class="tfp-conn-label">' + esc(label) + '</div>' +
    '<div class="tfp-conn-value" title="' + esc(hint) + '">' + esc(maskedValue) + '</div>' +
    '<button type="button" class="tfp-var-icon-btn" title="复制完整连接串" ' +
      'onclick="navigator.clipboard.writeText(' + safeJson + ');showToast(\'已复制完整连接串\',\'success\')">' +
      '<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M0 6.75C0 5.784.784 5 1.75 5h1.5a.75.75 0 010 1.5h-1.5a.25.25 0 00-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 00.25-.25v-1.5a.75.75 0 011.5 0v1.5A1.75 1.75 0 019.25 16h-7.5A1.75 1.75 0 010 14.25v-7.5z"/><path d="M5 1.75C5 .784 5.784 0 6.75 0h7.5C15.216 0 16 .784 16 1.75v7.5A1.75 1.75 0 0114.25 11h-7.5A1.75 1.75 0 015 9.25v-7.5zm1.75-.25a.25.25 0 00-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 00.25-.25v-7.5a.25.25 0 00-.25-.25h-7.5z"/></svg>' +
    '</button>' +
  '</div>';
}

// UF-10: Open logs for the currently-displayed service WITHOUT
// switching views. openLogModal renders into a global overlay so
// there's no reason to flip viewMode.
function _topologyPanelOpenLogs() {
  var id = _topologyPanelCurrentId;
  if (!id) return;
  if (typeof openLogModal === 'function') {
    openLogModal(id);
  } else {
    showToast('日志面板未加载', 'info');
  }
}

// P4 Part 12 — inline logs preview inside the panel Deployments tab.
//
// Fetches the most recent log lines for the currently displayed
// entity. For 'app' kind we have direct branch logs API; for 'infra'
// we use the dedicated /api/infra/:id/logs endpoint. Both endpoints
// already return formatted text — we just slice the last 12 lines.
async function _topologyPanelRefreshLogs() {
  var id = _topologyPanelCurrentId;
  var kind = _topologyPanelCurrentKind;
  var preview = document.getElementById('tfpLogsPreview');
  if (!id || !preview) return;

  preview.innerHTML = '<div class="tfp-logs-loading">加载日志中…</div>';

  // Build the right URL based on entity kind. For app profiles the
  // logs are tied to a specific branch — pick the currently selected
  // topology branch (or the first branch if none selected).
  var url = null;
  if (kind === 'infra') {
    url = '/api/infra/' + encodeURIComponent(id) + '/logs?tail=50';
  } else if (kind === 'app') {
    var branchId = _topologySelectedBranchId || ((branches || [])[0] && branches[0].id);
    if (!branchId) {
      preview.innerHTML = '<div class="tfp-logs-empty">尚未选择分支或没有任何分支</div>';
      return;
    }
    url = '/api/branches/' + encodeURIComponent(branchId) + '/container-logs?profileId=' + encodeURIComponent(id) + '&tail=50';
  } else {
    preview.innerHTML = '<div class="tfp-logs-empty">未知服务类型</div>';
    return;
  }

  try {
    var res = await fetch(url, { credentials: 'same-origin' });
    if (!res.ok) {
      preview.innerHTML = '<div class="tfp-logs-empty">日志暂不可用 (HTTP ' + res.status + ')</div>';
      return;
    }
    var text = '';
    // Some endpoints return JSON, others plain text — try both.
    var ct = res.headers.get('content-type') || '';
    if (ct.indexOf('application/json') >= 0) {
      var body = await res.json();
      text = (body && (body.logs || body.output || body.text || '')) || '';
      // Some endpoints return an array of lines
      if (Array.isArray(body)) text = body.join('\n');
      if (typeof text !== 'string') text = String(text);
    } else {
      text = await res.text();
    }

    text = (text || '').trim();
    if (!text) {
      preview.innerHTML = '<div class="tfp-logs-empty">还没有日志输出</div>';
      return;
    }

    var lines = text.split(/\r?\n/);
    var visible = lines.slice(-12);
    preview.innerHTML = '<pre class="tfp-logs-pre">' + esc(visible.join('\n')) + '</pre>';
    var pre = preview.querySelector('.tfp-logs-pre');
    if (pre) pre.scrollTop = pre.scrollHeight;
  } catch (err) {
    preview.innerHTML = '<div class="tfp-logs-empty">日志获取失败：' + esc(String(err && err.message || err)) + '</div>';
  }
}

window._topologyPanelRefreshLogs = _topologyPanelRefreshLogs;

// ─────────────────────────────────────────────────────────────────
// P4 Part 14 — Service detail panel logs tabs
//
// Three loaders fetch from three CDS data sources and render into
// dedicated containers inside the panel body. Each loader is
// independent — failures in one don't affect the others.
//
//   buildLogs   → /api/branches/:id/logs (operation log)
//   deployLogs  → /api/branches/:id/container-logs?profileId=…
//   httpLogs    → /api/activity-stream SSE filtered by type:'web'
//
// _topologyFilterLogs(query, kind) is the shared client-side filter
// that dims log rows whose text doesn't match the query. Each loader
// stores the raw rows into a small cache so re-filtering doesn't
// re-fetch.
// ─────────────────────────────────────────────────────────────────

let _topologyLogsCache = { build: [], deploy: [], http: [] };

function _topologyFilterLogs(query, kind) {
  var q = (query || '').toLowerCase().trim();
  var rows = document.querySelectorAll(kind === 'http' ? '#tfpHttpLogs .tfp-http-row' : (kind === 'build' ? '#tfpBuildLogs .tfp-log-row' : '#tfpDeployLogs .tfp-log-row'));
  rows.forEach(function (r) {
    if (!q) { r.style.display = ''; return; }
    var hay = (r.textContent || '').toLowerCase();
    r.style.display = hay.indexOf(q) >= 0 ? '' : 'none';
  });
}
window._topologyFilterLogs = _topologyFilterLogs;

// Helper: pick the branch to use for log queries. Uses topology-
// selected branch first, then 'main', then the first branch.
function _pickPanelBranchId() {
  if (_topologySelectedBranchId) return _topologySelectedBranchId;
  if (!branches || !branches.length) return null;
  var main = branches.find(function (b) { return b.id === 'main' || b.id === 'master'; });
  return main ? main.id : branches[0].id;
}

async function _topologyPanelLoadBuildLogs() {
  var container = document.getElementById('tfpBuildLogs');
  if (!container) return;
  var id = _topologyPanelCurrentId;
  var kind = _topologyPanelCurrentKind;
  if (!id) return;

  container.innerHTML = '<div class="tfp-logs-loading">加载构建日志中…</div>';

  // Build logs for an app come from the branch operation log
  // (deploy/redeploy events have build-stage entries). Infra services
  // don't have build logs since they pull pre-built images.
  if (kind !== 'app') {
    container.innerHTML = '<div class="tfp-logs-empty">基础设施服务直接拉取镜像，没有构建日志</div>';
    return;
  }

  var branchId = _pickPanelBranchId();
  if (!branchId) {
    container.innerHTML = '<div class="tfp-logs-empty">没有可用分支</div>';
    return;
  }

  try {
    var res = await fetch('/api/branches/' + encodeURIComponent(branchId) + '/logs', { credentials: 'same-origin' });
    if (!res.ok) {
      container.innerHTML = '<div class="tfp-logs-empty">日志暂不可用 (HTTP ' + res.status + ')</div>';
      return;
    }
    var body = await res.json();
    var ops = (body && body.logs) || [];
    if (!ops.length) {
      container.innerHTML = '<div class="tfp-logs-empty">还没有构建记录</div>';
      return;
    }
    // Render ops as rows with timestamp + summary + details
    var rows = ops.slice().reverse().map(function (op) {
      var ts = op.startedAt ? new Date(op.startedAt).toLocaleString() : '-';
      var ev = (op.events || []).slice(-12);
      var lines = ev.map(function (e) { return e.text || e.message || JSON.stringify(e); }).join('\n');
      var stage = op.action || op.type || 'op';
      var status = op.status || 'pending';
      var statusClass = status === 'success' ? 'ok' : status === 'error' ? 'err' : 'idle';
      return '<div class="tfp-log-row">' +
        '<div class="tfp-log-row-meta">' +
          '<span class="tfp-log-stage tfp-log-stage-' + statusClass + '">' + esc(stage) + '</span>' +
          '<span class="tfp-log-time">' + esc(ts) + '</span>' +
        '</div>' +
        '<pre class="tfp-log-text">' + esc(lines || '(no log lines)') + '</pre>' +
      '</div>';
    }).join('');
    container.innerHTML = rows;
    _topologyLogsCache.build = ops;
  } catch (err) {
    container.innerHTML = '<div class="tfp-logs-empty">日志获取失败：' + esc(String(err && err.message || err)) + '</div>';
  }
}

async function _topologyPanelLoadDeployLogs() {
  var container = document.getElementById('tfpDeployLogs');
  if (!container) return;
  var id = _topologyPanelCurrentId;
  var kind = _topologyPanelCurrentKind;
  if (!id) return;

  container.innerHTML = '<div class="tfp-logs-loading">加载部署日志中…</div>';

  // UF-20: previously this function issued `GET /container-logs?profileId=...`
  // but the server only exposes `POST /container-logs` (body: {profileId}).
  // GET hit Express's static-file fallback and served index.html —
  // which is why the Deploy Logs tab was showing raw HTML
  // (`<div class="modal-header">...`) as log lines. We now use the
  // correct POST method with profileId in the JSON body for app
  // services, and keep the existing GET /api/infra/:id/logs for infra.
  var fetchOptions = { credentials: 'same-origin' };
  var url = null;
  if (kind === 'infra') {
    url = '/api/infra/' + encodeURIComponent(id) + '/logs?tail=200';
  } else if (kind === 'app') {
    var branchId = _pickPanelBranchId();
    if (!branchId) {
      container.innerHTML = '<div class="tfp-logs-empty">没有可用分支</div>';
      return;
    }
    url = '/api/branches/' + encodeURIComponent(branchId) + '/container-logs';
    fetchOptions = {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profileId: id }),
    };
  } else {
    container.innerHTML = '<div class="tfp-logs-empty">未知服务类型</div>';
    return;
  }

  try {
    var res = await fetch(url, fetchOptions);
    if (!res.ok) {
      container.innerHTML = '<div class="tfp-logs-empty">日志暂不可用 (HTTP ' + res.status + ')</div>';
      return;
    }
    var text = '';
    var ct = res.headers.get('content-type') || '';
    if (ct.indexOf('application/json') >= 0) {
      var b = await res.json();
      text = (b && (b.logs || b.output || b.text || '')) || '';
      if (Array.isArray(b)) text = b.join('\n');
      if (typeof text !== 'string') text = String(text);
    } else if (ct.indexOf('html') >= 0) {
      // UF-20 defensive guard: if despite the POST fix the server ever
      // returns HTML (e.g. reverse-proxy misconfig), don't render the
      // HTML source as "log lines" — surface a clear error instead.
      container.innerHTML = '<div class="tfp-logs-empty" style="color:var(--red)">服务器返回了 HTML 而非日志 — 检查反向代理配置是否正确转发 /api/*</div>';
      return;
    } else {
      text = await res.text();
    }
    text = (text || '').trim();
    if (!text) {
      container.innerHTML = '<div class="tfp-logs-empty">还没有日志输出</div>';
      return;
    }

    // Split lines and try to detect a timestamp prefix on each.
    // Many docker logs lines start with an ISO timestamp.
    var lines = text.split(/\r?\n/);
    var rows = lines.map(function (line) {
      var stripeClass = /error|fail|warn/i.test(line) ? 'err' : 'ok';
      // Try to extract timestamp prefix (ISO or [...] formats)
      var tsMatch = line.match(/^(\d{4}-\d{2}-\d{2}[T ][\d:.+\-Z]+|\[[^\]]+\])/);
      var ts = tsMatch ? tsMatch[1] : '';
      var rest = ts ? line.slice(ts.length).trim() : line;
      return '<div class="tfp-log-row tfp-log-row-' + stripeClass + '">' +
        (ts ? '<span class="tfp-log-time">' + esc(ts) + '</span>' : '') +
        '<pre class="tfp-log-text">' + esc(rest) + '</pre>' +
      '</div>';
    }).join('');
    container.innerHTML = rows;
    _topologyLogsCache.deploy = lines;
    // Auto-scroll to bottom
    container.scrollTop = container.scrollHeight;
  } catch (err) {
    container.innerHTML = '<div class="tfp-logs-empty">日志获取失败：' + esc(String(err && err.message || err)) + '</div>';
  }
}

// HTTP Logs uses the existing CDS activity stream SSE endpoint. We
// subscribe ONCE per panel-open and unsubscribe when leaving the tab
// or closing the panel. Filtered to type:'web' which corresponds to
// proxied requests through a branch container (CDS' built-in proxy
// captures every HTTP request to the user's app and broadcasts it).
let _httpLogsEs = null;
let _httpLogsEvents = [];

function _topologyPanelLoadHttpLogs() {
  var container = document.getElementById('tfpHttpLogs');
  if (!container) return;

  // Tear down any previous stream
  if (_httpLogsEs) { try { _httpLogsEs.close(); } catch (e) {} _httpLogsEs = null; }
  _httpLogsEvents = [];

  container.innerHTML =
    '<div class="tfp-http-row tfp-http-head">' +
      '<span>Time</span><span>Method</span><span>Path</span><span>Status</span><span>Duration</span>' +
    '</div>' +
    '<div id="tfpHttpLogsBody"><div class="tfp-logs-loading">订阅 HTTP 流中…</div></div>';

  try {
    _httpLogsEs = new EventSource('/api/activity-stream', { withCredentials: true });
    _httpLogsEs.addEventListener('activity', function (e) {
      try {
        var data = JSON.parse(e.data);
        // Filter to web (proxied) events only
        if (data && data.type === 'web') {
          _httpLogsEvents.push(data);
          if (_httpLogsEvents.length > 200) _httpLogsEvents = _httpLogsEvents.slice(-200);
          _renderHttpLogsBody();
        }
      } catch (err) { /* skip malformed */ }
    });
    _httpLogsEs.onerror = function () {
      var bodyEl = document.getElementById('tfpHttpLogsBody');
      if (bodyEl && _httpLogsEvents.length === 0) {
        bodyEl.innerHTML = '<div class="tfp-logs-empty">活动流连接断开 — 点刷新重试</div>';
      }
    };
  } catch (err) {
    container.innerHTML = '<div class="tfp-logs-empty">无法订阅活动流：' + esc(String(err && err.message || err)) + '</div>';
    return;
  }

  // Set up auto-cleanup when the panel closes
  if (typeof _topologyClosePanel === 'function' && !_topologyClosePanel.__patchedHttp) {
    var origClose = _topologyClosePanel;
    window._topologyClosePanel = function () {
      if (_httpLogsEs) { try { _httpLogsEs.close(); } catch (e) {} _httpLogsEs = null; }
      _httpLogsEvents = [];
      return origClose.apply(this, arguments);
    };
    window._topologyClosePanel.__patchedHttp = true;
  }
}

function _renderHttpLogsBody() {
  var bodyEl = document.getElementById('tfpHttpLogsBody');
  if (!bodyEl) return;
  if (_httpLogsEvents.length === 0) {
    bodyEl.innerHTML = '<div class="tfp-logs-empty">还没有 HTTP 请求 — 等待容器接收第一个请求</div>';
    return;
  }
  var rows = _httpLogsEvents.slice().reverse().map(function (ev) {
    var time = ev.ts ? new Date(ev.ts).toLocaleTimeString() : '';
    var statusClass = ev.status >= 500 ? 'err' : ev.status >= 400 ? 'warn' : 'ok';
    return '<div class="tfp-http-row">' +
      '<span class="tfp-http-time">' + esc(time) + '</span>' +
      '<span class="tfp-http-method tfp-http-method-' + esc((ev.method || 'GET').toLowerCase()) + '">' + esc(ev.method || 'GET') + '</span>' +
      '<span class="tfp-http-path" title="' + esc(ev.path || '') + '">' + esc(ev.path || '') + '</span>' +
      '<span class="tfp-http-status tfp-http-status-' + statusClass + '">' + (ev.status || '-') + '</span>' +
      '<span class="tfp-http-duration">' + (ev.duration != null ? ev.duration + 'ms' : '-') + '</span>' +
    '</div>';
  }).join('');
  bodyEl.innerHTML = rows;
}

window._topologyPanelLoadBuildLogs = _topologyPanelLoadBuildLogs;
window._topologyPanelLoadDeployLogs = _topologyPanelLoadDeployLogs;
window._topologyPanelLoadHttpLogs = _topologyPanelLoadHttpLogs;

// UF-10: Open the full editor for the currently-displayed service
// WITHOUT switching views. Previously this function called
// setViewMode('list') as a prelude to opening a modal, which made
// topology users yo-yo back to list view every time they hit "Edit
// in full editor". All three targets (openOverrideModal,
// openProfileModal, openInfraModal) render into the global #configModal
// overlay, so they work from either view.
function _topologyPanelOpenEditor() {
  var id = _topologyPanelCurrentId;
  var kind = _topologyPanelCurrentKind;
  if (!id) return;
  if (kind === 'app' && _topologySelectedBranchId) {
    // Branch is selected → per-branch override editor is the most
    // precise target. This path already worked before UF-10.
    openOverrideModal(_topologySelectedBranchId, id);
    return;
  }
  if (kind === 'app') {
    // Shared view (no branch selected) → edit the base BuildProfile.
    // The legacy code here called a non-existent renderBuildProfiles()
    // after switching views, which did nothing and just left the user
    // stranded on list view. Fixed by calling openProfileModal() in
    // place, which is the real entry point.
    if (typeof openProfileModal === 'function') {
      openProfileModal();
    } else {
      showToast('构建配置模块未加载', 'info');
    }
    return;
  }
  // infra: open the infrastructure services modal in place.
  if (typeof openInfraModal === 'function') {
    openInfraModal();
  } else {
    showToast('基础设施模块未加载', 'info');
  }
}

// GAP-11: split-button dropdown for per-service redeploy. Clicking the
// ▾ chevron on the Details tab's Deploy button opens a small menu
// listing each visible build profile; selecting one calls the existing
// deploySingleService(branchId, profileId) used by list view. We reuse
// the `dropdownPortal` + positionPortalDropdown pattern from list view
// so the menu survives CSS overflow / transform boundaries.
var _topologyDeploySplitMenuOpenFor = null;
function _topologyToggleDeploySplitMenu(branchId, event) {
  if (event) event.stopPropagation();
  _topologyCloseDeploySplitMenu();
  if (_topologyDeploySplitMenuOpenFor === branchId) {
    _topologyDeploySplitMenuOpenFor = null;
    return;
  }
  _topologyDeploySplitMenuOpenFor = branchId;

  var visibleProfiles = (buildProfiles || []).filter(function (p) { return !p.hidden; });
  if (visibleProfiles.length === 0) return;

  var menu = document.createElement('div');
  menu.className = 'deploy-menu';
  menu.id = 'topology-deploy-split-menu-portal';
  menu.onclick = function (e) { e.stopPropagation(); };
  var rows = '<div class="deploy-menu-header">重新部署单个服务</div>' +
    visibleProfiles.map(function (p) {
      var name = p.name || p.id;
      return '<div class="deploy-menu-item" onclick="event.stopPropagation();_topologyCloseDeploySplitMenu();deploySingleService(\'' +
        esc(branchId) + '\',\'' + esc(p.id) + '\')">' +
        '<svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor" style="vertical-align:-1px;margin-right:6px">' +
          '<path d="M1.5 8a.5.5 0 01.5-.5h10.793L9.146 3.854a.5.5 0 11.708-.708l4.5 4.5a.5.5 0 010 .708l-4.5 4.5a.5.5 0 01-.708-.708L12.793 8.5H2a.5.5 0 01-.5-.5z"/>' +
        '</svg>' +
        esc(name) +
      '</div>';
    }).join('');
  menu.innerHTML = rows;
  if (portal) portal.appendChild(menu);

  // Anchor to the split-button container so the menu lines up under it.
  var anchor = (event && event.currentTarget && event.currentTarget.closest('.tfp-deploy-split'))
    || (event && event.currentTarget)
    || document.querySelector('.tfp-deploy-split[data-branch-id="' + branchId + '"]');
  if (anchor) positionPortalDropdown(menu, anchor, 'right');
}

function _topologyCloseDeploySplitMenu() {
  var el = document.getElementById('topology-deploy-split-menu-portal');
  if (el) el.remove();
  _topologyDeploySplitMenuOpenFor = null;
}

// Close on outside click — attach once via the existing global handler.
document.addEventListener('click', function () { _topologyCloseDeploySplitMenu(); });

// GAP-14: commit history modal for the topology Details tab. List view
// has toggleCommitLog() that inline-expands a dropdown anchored to the
// card; in topology we don't have an anchor, so we open a small modal
// that reuses the same /branches/:id/git-log endpoint and row layout.
// The modal lives in a portal-appended wrapper so it survives the
// panel's translate transform and overflow rules.
async function _topologyOpenCommitHistory(branchId) {
  // Clean up any stale one
  var existing = document.getElementById('topologyCommitHistoryModal');
  if (existing) existing.remove();

  var overlay = document.createElement('div');
  overlay.id = 'topologyCommitHistoryModal';
  overlay.className = 'topology-commit-history-overlay';
  overlay.onclick = function (e) {
    if (e.target === overlay) overlay.remove();
  };
  overlay.innerHTML =
    '<div class="topology-commit-history-modal" onclick="event.stopPropagation()">' +
      '<div class="topology-commit-history-header">' +
        '<span>' + esc(branchId) + ' · 提交历史</span>' +
        '<button type="button" class="topology-commit-history-close" onclick="document.getElementById(\'topologyCommitHistoryModal\').remove()" title="关闭">' +
          '<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M3.72 3.72a.75.75 0 011.06 0L8 6.94l3.22-3.22a.75.75 0 111.06 1.06L9.06 8l3.22 3.22a.75.75 0 11-1.06 1.06L8 9.06l-3.22 3.22a.75.75 0 01-1.06-1.06L6.94 8 3.72 4.78a.75.75 0 010-1.06z"/></svg>' +
        '</button>' +
      '</div>' +
      '<div class="topology-commit-history-body" id="topologyCommitHistoryBody">' +
        '<div class="commit-log-loading"><span class="btn-spinner"></span> 加载中...</div>' +
      '</div>' +
    '</div>';
  document.body.appendChild(overlay);

  try {
    var data = await api('GET', '/branches/' + encodeURIComponent(branchId) + '/git-log?count=15');
    var commits = data.commits || [];
    var body = document.getElementById('topologyCommitHistoryBody');
    if (!body) return;
    if (commits.length === 0) {
      body.innerHTML = '<div class="commit-log-empty">暂无提交记录</div>';
      return;
    }
    var branch = (branches || []).find(function (br) { return br.id === branchId; });
    var pinned = branch && branch.pinnedCommit;
    body.innerHTML = commits.map(function (c, i) {
      var isCurrent = pinned ? c.hash === pinned : i === 0;
      var isLatest = i === 0;
      var dot = isCurrent ? '<span class="commit-current-dot"></span>' : '';
      var icon = (typeof commitIcon === 'function') ? commitIcon(c.subject) : '';
      return '<div class="commit-log-item ' + (isLatest ? 'latest ' : '') + (isCurrent ? 'current' : '') + '" ' +
        'onclick="event.stopPropagation();document.getElementById(\'topologyCommitHistoryModal\').remove();checkoutCommit(\'' +
          esc(branchId) + '\',\'' + esc(c.hash) + '\',' + isLatest + ',' + JSON.stringify(esc(c.subject)) + ')" ' +
        'title="点击切换到此提交进行构建">' +
        dot + icon +
        '<code class="commit-hash">' + esc(c.hash) + '</code>' +
        '<span class="commit-subject">' + esc(c.subject) + '</span>' +
        '<span class="commit-meta">' + esc(c.author) + ' · ' + esc(c.date) + '</span>' +
      '</div>';
    }).join('');
  } catch (e) {
    var bodyErr = document.getElementById('topologyCommitHistoryBody');
    if (bodyErr) bodyErr.innerHTML = '<div class="commit-log-empty" style="color:var(--red)">' + esc(e && e.message ? e.message : String(e)) + '</div>';
  }
}

// GAP-16: manual refresh entry for the topology topbar. Delegates to
// the same refreshAll() helper used by list view's 🔄 button, plus a
// lightweight spinner on the topology button so users get immediate
// visual feedback (refreshAll itself spins #refreshRemoteBtn which
// isn't visible in fullscreen topology mode).
async function _topologyManualRefresh(event) {
  if (event) event.stopPropagation();
  var btn = document.getElementById('topoNavRefresh');
  if (btn) btn.classList.add('spinning');
  try {
    if (typeof refreshAll === 'function') {
      await refreshAll();
    }
  } finally {
    if (btn) btn.classList.remove('spinning');
  }
}

// Add a remote branch and immediately switch the topology view to it.
// This fixes the "click → nothing happens" regression where JSON.stringify
// produced unescaped double-quotes that broke the onclick HTML attribute.
async function _topoAddAndSelect(branchName) {
  _topologyBranchComboClose();
  await addBranch(branchName);
  // After loadBranches() inside addBranch completes, the slug is now in
  // `branches[]`. Switch the topology view to it so the user immediately
  // sees their new branch's services instead of staying in shared view.
  var slug = typeof StateService_slugify === 'function' ? StateService_slugify(branchName) : branchName;
  // Set the flag synchronously before any async work so renderTopologyView()
  // triggered by loadBranches() (inside addBranch) correctly renders in
  // single-branch mode on the next tick.
  _topologySelectedBranchId = slug;
  _topologyKeepSharedView = false;
  // Await the full select (loads overrides, re-renders) so we can fit after.
  await _topologySelectBranch(slug);
  // Fit the canvas to the newly-selected branch so the user sees a visible
  // transition even if the branch has no running containers yet.
  if (typeof _topologyFit === 'function') _topologyFit();
}

// System-settings popover (left nav)
function _topoSysPopoverToggle() {
  var pop = document.getElementById('topoSysPopover');
  if (!pop) return;
  pop.classList.toggle('open');
}
function _topoSysPopoverClose() {
  var pop = document.getElementById('topoSysPopover');
  if (pop) pop.classList.remove('open');
}
// Close when clicking outside
(function() {
  document.addEventListener('click', function(e) {
    if (!e.target.closest('#topoSysBtn') && !e.target.closest('#topoSysPopover')) {
      _topoSysPopoverClose();
    }
  }, { capture: false });
})();

// T6: close the panel
function _topologyClosePanel() {
  var panel = document.getElementById('topologyFsPanel');
  if (panel) panel.classList.remove('open');
  _topologyPanelCurrentId = null;
  _topologyPanelCurrentKind = null;
}

// T8: branch dropdown change handler
function _topologyOnBranchChange(branchId) {
  // Empty value = shared view. Kept as a public helper so anything
  // that still binds to a native select element continues to work.
  _topologySelectBranch(branchId || null);
  _topologyRefreshBranchDropdown();
  _topologyBranchComboClose();
}

// UF-07: the topology branch picker is now a custom combobox, not a
// native <select>. Opening / closing / filtering / add-branch are all
// driven from these helpers. Kept on window so inline onclick handlers
// in the topbar markup above can reach them.

let _topologyBranchComboOpen = false;
let _topologyBranchComboQuery = '';

function _topologyBranchComboToggle() {
  if (_topologyBranchComboOpen) {
    _topologyBranchComboClose();
  } else {
    _topologyBranchComboOpenUi();
  }
}

function _topologyBranchComboOpenUi() {
  var combo = document.getElementById('topologyFsBranchCombo');
  if (!combo) return;
  _topologyBranchComboOpen = true;
  combo.classList.add('open');
  _topologyRefreshBranchDropdown();
  // Focus the search input after the popover has a chance to render,
  // otherwise the autofocus gets swallowed by the click that opened it.
  setTimeout(function () {
    var search = document.getElementById('topologyFsBranchComboSearch');
    if (search) { search.value = _topologyBranchComboQuery; search.focus(); }
  }, 0);
}

function _topologyBranchComboClose() {
  var combo = document.getElementById('topologyFsBranchCombo');
  if (!combo) return;
  _topologyBranchComboOpen = false;
  combo.classList.remove('open');
  _topologyBranchComboQuery = '';
}

// Called by the search input's 'input' listener (wired up in
// _ensureTopologyFsChrome). We re-render the list on every keystroke.
function _topologyBranchComboOnInput(value) {
  _topologyBranchComboQuery = value || '';
  _topologyRefreshBranchDropdown();
}

// Called by the search input's 'keydown' listener. Enter with a non-
// empty, not-yet-tracked name calls the same addBranch() that the
// list view uses — we share the optimistic-add + slug + toast logic
// verbatim (UF-04 parity).
function _topologyBranchComboOnEnter() {
  var raw = (_topologyBranchComboQuery || '').trim();
  if (!raw) return;
  var slug = StateService_slugify(raw);
  var existing = (branches || []).find(function (b) { return b.id === slug || b.branch === raw; });
  if (existing) {
    _topologySelectBranch(existing.id);
    _topologyBranchComboClose();
    return;
  }
  _topologyBranchComboClose();
  // addBranch is the list-view helper from cds/web/app.js:1165 — we
  // reuse it so list and topology share the exact same add flow,
  // including the optimistic insert, POST /api/branches call, and
  // toast error rollback. Auto-switch to the new branch on success.
  _topoAddAndSelect(raw);
}

// Re-render the combobox label AND the open popover (when open). Keeps
// the button label in sync with _topologySelectedBranchId even when the
// popover isn't visible. Called on topology mount, on branches-list
// refresh, and after every user interaction.
function _topologyRefreshBranchDropdown() {
  var combo = document.getElementById('topologyFsBranchCombo');
  if (!combo) return;
  // Update the button label
  var labelEl = document.getElementById('topologyFsBranchComboLabel');
  if (labelEl) {
    var selected = _topologySelectedBranchId
      ? (branches || []).find(function (b) { return b.id === _topologySelectedBranchId; })
      : null;
    labelEl.textContent = selected ? selected.id : '（共享视图）';
  }

  // Build the list inside the popover — only if it's currently open or
  // being opened. Closed popovers don't need DOM churn.
  var listEl = document.getElementById('topologyFsBranchComboList');
  if (!listEl) return;
  var q = (_topologyBranchComboQuery || '').trim().toLowerCase();

  // Section 1: already-tracked branches (matching the query)
  var tracked = (branches || []).filter(function (b) {
    return !q || b.id.toLowerCase().includes(q) || (b.branch || '').toLowerCase().includes(q);
  });

  // Section 2: "Can be added" from remote git refs (matching the query)
  var trackedIds = new Set((branches || []).map(function (b) { return StateService_slugify(b.branch || b.id); }));
  var remote = ((typeof remoteCandidates !== 'undefined' ? remoteCandidates : null) || []).filter(function (b) {
    return (!q || b.name.toLowerCase().includes(q)) && !trackedIds.has(StateService_slugify(b.name));
  }).slice(0, 15);

  // Manual-add escape hatch — identical rule to list view's filterBranches()
  var typedSlug = q ? StateService_slugify(_topologyBranchComboQuery.trim()) : '';
  var typedAlreadyTracked = !!q && (branches || []).some(function (b) {
    return b.id === typedSlug || b.branch === _topologyBranchComboQuery.trim();
  });
  var showManualAdd = !!q && !typedAlreadyTracked;

  var html = '';
  // Shared view pin at top (always present when query is empty)
  if (!q) {
    var sharedActive = !_topologySelectedBranchId;
    html += '<div class="topology-fs-branch-combo-item ' + (sharedActive ? 'active' : '') + '" onclick="_topologyOnBranchChange(\'\')">' +
            '<svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor" style="opacity:0.7"><path d="M8 0a8 8 0 100 16A8 8 0 008 0zM1.5 8a6.5 6.5 0 1113 0 6.5 6.5 0 01-13 0z"/></svg>' +
            '<span class="topology-fs-branch-combo-item-label">（共享视图）</span>' +
            '</div>';
  }
  if (tracked.length > 0) {
    html += '<div class="topology-fs-branch-combo-section">已添加</div>';
    tracked.forEach(function (b) {
      var active = b.id === _topologySelectedBranchId;
      var status = b.status === 'running' ? 'running' : '';
      html += '<div class="topology-fs-branch-combo-item ' + (active ? 'active' : '') + '" onclick="_topologyOnBranchChange(\'' + esc(b.id) + '\')">' +
              '<svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor" style="opacity:0.7"><path d="M2.5 1.75v11.5c0 .138.112.25.25.25h6.5a.75.75 0 010 1.5h-6.5A1.75 1.75 0 011 13.25V1.75C1 .784 1.784 0 2.75 0h8.5C12.216 0 13 .784 13 1.75v7.5a.75.75 0 01-1.5 0V1.75a.25.25 0 00-.25-.25h-8.5a.25.25 0 00-.25.25z"/></svg>' +
              '<span class="topology-fs-branch-combo-item-label">' + esc(b.id) + '</span>' +
              (status ? '<span class="topology-fs-branch-combo-item-tag running">运行中</span>' : '') +
              '</div>';
    });
  }
  if (remote.length > 0) {
    html += '<div class="topology-fs-branch-combo-section">可添加</div>';
    remote.forEach(function (b) {
      html += '<div class="topology-fs-branch-combo-item" onclick="_topoAddAndSelect(' + JSON.stringify(b.name).replace(/"/g, '&quot;') + ')">' +
              '<svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor" style="opacity:0.5"><path fill-rule="evenodd" d="M11.75 2.5a.75.75 0 100 1.5.75.75 0 000-1.5zm-2.25.75a2.25 2.25 0 113 2.122V6A2.5 2.5 0 0110 8.5H6a1 1 0 00-1 1v1.128a2.251 2.251 0 11-1.5 0V5.372a2.25 2.25 0 111.5 0v1.836A2.492 2.492 0 016 7h4a1 1 0 001-1v-.628A2.25 2.25 0 019.5 3.25zM4.25 12a.75.75 0 100 1.5.75.75 0 000-1.5zM3.5 3.25a.75.75 0 111.5 0 .75.75 0 01-1.5 0z"/></svg>' +
              '<span class="topology-fs-branch-combo-item-label">' + esc(b.name) + '</span>' +
              '</div>';
    });
  }
  if (showManualAdd) {
    html += '<div class="topology-fs-branch-combo-section">手动添加</div>';
    html += '<div class="topology-fs-branch-combo-item manual-add" onclick="_topoAddAndSelect(' + JSON.stringify(_topologyBranchComboQuery.trim()).replace(/"/g, '&quot;') + ')">' +
            '<svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor" style="color:var(--accent,#10b981)"><path d="M8 2a.75.75 0 01.75.75v4.5h4.5a.75.75 0 010 1.5h-4.5v4.5a.75.75 0 01-1.5 0v-4.5h-4.5a.75.75 0 010-1.5h4.5v-4.5A.75.75 0 018 2z"/></svg>' +
            '<span class="topology-fs-branch-combo-item-label">添加 "' + esc(_topologyBranchComboQuery.trim()) + '" 为新分支</span>' +
            '<span class="topology-fs-branch-combo-item-tag">按 Enter</span>' +
            '</div>';
  }
  if (!html) {
    html = '<div class="topology-fs-branch-combo-empty">没有匹配的分支 —— 粘贴一个名字按 Enter 添加</div>';
  }
  listEl.innerHTML = html;
}


// Expose to inline handlers
window.setViewMode = setViewMode;
window.renderTopologyView = renderTopologyView;
window._topologySelectBranch = _topologySelectBranch;
window._topologyNodeClick = _topologyNodeClick;
window._topologyInfraClick = _topologyInfraClick;
window._topologyZoomIn = _topologyZoomIn;
window._topologyZoomOut = _topologyZoomOut;
window._topologyFit = _topologyFit;
window._topologyReset = _topologyReset;
// P4 Part 6: shell helpers (topbar / panel / + Add menu / branch dropdown)
window._topologyToggleAddMenu = _topologyToggleAddMenu;
window._topologyChooseAddItem = _topologyChooseAddItem;
window._topologyOpenServicePanel = _topologyOpenServicePanel;
window._topologySwitchPanelTab = _topologySwitchPanelTab;
window._topologyClosePanel = _topologyClosePanel;
window._topologyOnBranchChange = _topologyOnBranchChange;
window._topologyPanelOpenLogs = _topologyPanelOpenLogs;
window._topologyPanelOpenEditor = _topologyPanelOpenEditor;
// UF-07: custom branch combobox helpers
window._topologyBranchComboToggle = _topologyBranchComboToggle;
window._topologyBranchComboClose = _topologyBranchComboClose;
// UF-09: branch-scoped variables (inherit/override) inline helpers
window._topologyVarsToggleOverride = _topologyVarsToggleOverride;
window._topologyVarsOnInput = _topologyVarsOnInput;
window._topologyVarsResetBranch = _topologyVarsResetBranch;
// UF-10: open routing modal in-place from Details tab
window._topologyOpenRoutingInPlace = _topologyOpenRoutingInPlace;
// GAP-08: node port badge click / dblclick handlers
window._topologyNodePortClick = _topologyNodePortClick;
window._topologyNodePortDblClick = _topologyNodePortDblClick;
// GAP-11: per-service deploy split-button dropdown
window._topologyToggleDeploySplitMenu = _topologyToggleDeploySplitMenu;
window._topologyCloseDeploySplitMenu = _topologyCloseDeploySplitMenu;
// GAP-14: commit history modal opened from topology Details tab
window._topologyOpenCommitHistory = _topologyOpenCommitHistory;
// GAP-16: manual refresh button in the topology left nav
window._topologyManualRefresh = _topologyManualRefresh;
window._topoSysPopoverToggle = _topoSysPopoverToggle;
window._topoSysPopoverClose = _topoSysPopoverClose;
window._topoAddAndSelect = _topoAddAndSelect;

// Apply persisted view mode on load (deferred so DOM elements exist)
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => setViewMode(_viewMode));
} else {
  setTimeout(() => setViewMode(_viewMode), 0);
}

// ── Init activity monitor & AI pairing ──
initActivityMonitor();
initAiPairing();

// ── Start ──
init();
