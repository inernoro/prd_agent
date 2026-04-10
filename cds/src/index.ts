import http from 'node:http';
import express from 'express';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { loadConfig } from './config.js';
import { discoverComposeFiles, parseCdsCompose } from './services/compose-parser.js';
import fs from 'node:fs';
import { createServer, broadcastActivity, nextActivitySeq } from './server.js';
import type { ActivityEvent } from './server.js';
import { ShellExecutor } from './services/shell-executor.js';
import { StateService } from './services/state.js';
import { WorktreeService } from './services/worktree.js';
import { ContainerService } from './services/container.js';
import { ProxyService } from './services/proxy.js';
import { SchedulerService } from './services/scheduler.js';
import { JanitorService } from './services/janitor.js';
import { BridgeService } from './services/bridge.js';
import { BranchDispatcher, HttpSnapshotFetcher } from './scheduler/dispatcher.js';
import { ExecutorAgent } from './executor/agent.js';
import { createExecutorRouter } from './executor/routes.js';
import { ExecutorRegistry } from './scheduler/executor-registry.js';
import { createSchedulerRouter } from './scheduler/routes.js';

function parseCsv(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  const items = value.split(',').map(v => v.trim()).filter(Boolean);
  return items.length > 0 ? items : undefined;
}

const configPath = process.argv[2] || undefined;
const config = loadConfig(configPath);

const shell = new ShellExecutor();

// ── State ──
const stateFile = path.join(config.repoRoot, '.cds', 'state.json');
const stateService = new StateService(stateFile, config.repoRoot);
stateService.load();

// ── Sync deploy modes from compose file into existing profiles ──
{
  const composeFiles = discoverComposeFiles(config.repoRoot);
  for (const file of composeFiles) {
    try {
      const yaml = fs.readFileSync(file, 'utf-8');
      const cds = parseCdsCompose(yaml);
      if (!cds) continue;
      for (const bp of cds.buildProfiles) {
        if (!bp.deployModes || Object.keys(bp.deployModes).length === 0) continue;
        const existing = stateService.getBuildProfile(bp.id);
        if (existing) {
          stateService.updateBuildProfile(bp.id, { deployModes: bp.deployModes });
        }
      }
      stateService.save();
      break; // Only process first matching compose file
    } catch { /* skip */ }
  }
}

// ── Apply custom env overrides to config ──
// Users set these in CDS custom env vars (UI),
// but config.ts only reads process.env at startup. Merge them here.
const customEnv = stateService.getCustomEnv();
if (customEnv.ROOT_DOMAINS && !config.rootDomains?.length) config.rootDomains = parseCsv(customEnv.ROOT_DOMAINS);
if (customEnv.SWITCH_DOMAIN && !config.switchDomain) config.switchDomain = customEnv.SWITCH_DOMAIN;
if (customEnv.MAIN_DOMAIN && !config.mainDomain) config.mainDomain = customEnv.MAIN_DOMAIN;
if (customEnv.DASHBOARD_DOMAIN && !config.dashboardDomain) config.dashboardDomain = customEnv.DASHBOARD_DOMAIN;
if (customEnv.PREVIEW_DOMAIN && !config.previewDomain) config.previewDomain = customEnv.PREVIEW_DOMAIN;
if (config.rootDomains?.length) {
  if (!config.dashboardDomain) config.dashboardDomain = config.rootDomains[0];
  if (!config.previewDomain) config.previewDomain = config.rootDomains[0];
  if (!config.mainDomain) config.mainDomain = config.rootDomains[0];
}
// Directory isolation: allow UI to override repo root and worktree base
if (customEnv.CDS_REPO_ROOT) config.repoRoot = customEnv.CDS_REPO_ROOT;
if (customEnv.CDS_WORKTREE_BASE) config.worktreeBase = customEnv.CDS_WORKTREE_BASE;

// ── Services ──
const worktreeService = new WorktreeService(shell, config.repoRoot);
const containerService = new ContainerService(shell, config);
const proxyService = new ProxyService(stateService, config);
proxyService.setWorktreeService(worktreeService);
const bridgeService = new BridgeService();

// ── Warm-pool scheduler (v3.1) ──
// Disabled unless cds.config.json { "scheduler": { "enabled": true, ... } }.
// See doc/design.cds-resilience.md and doc/plan.cds-resilience-rollout.md.
const schedulerService = new SchedulerService(
  stateService,
  config.scheduler || {
    enabled: false,
    maxHotBranches: 3,
    idleTTLSeconds: 900,
    tickIntervalSeconds: 60,
    pinnedBranches: [],
  },
);
// coolFn: stop all containers of a branch but keep the branch entry in state.
// The next request to this branch will trigger the existing auto-build path,
// which re-runs docker run and brings the services back to HOT.
schedulerService.setCoolFn(async (slug: string) => {
  const branch = stateService.getBranch(slug);
  if (!branch) return;
  branch.status = 'stopping';
  stateService.save();
  for (const svc of Object.values(branch.services)) {
    if (svc.status === 'running' || svc.status === 'starting') {
      try {
        await containerService.stop(svc.containerName);
      } catch (err) {
        console.warn(`[scheduler] stop(${svc.containerName}) failed: ${(err as Error).message}`);
      }
      svc.status = 'stopped';
    }
  }
  branch.status = 'idle';
  stateService.save();
});
// wakeFn intentionally left unset at boot: the proxy's existing onAutoBuild
// handler already covers the "branch is not running" case and runs the full
// SSE build flow. A dedicated wakeFn would duplicate that logic. Future
// work (Phase 2) may introduce a lighter-weight restart path.
proxyService.setScheduler(schedulerService);

// ── Janitor (Phase 2 resilience) ──
// Disabled by default. Opt-in via cds.config.json { "janitor": { "enabled": true, ... } }.
// Sweeps stale worktrees (> worktreeTTLDays idle) and warns on disk usage.
// See doc/design.cds-resilience.md Phase 2.
const janitorService = new JanitorService(
  stateService,
  config.janitor || {
    enabled: false,
    worktreeTTLDays: 30,
    diskWarnPercent: 80,
    sweepIntervalSeconds: 3600,
  },
  config.worktreeBase,
);
janitorService.setRemoveFn(async (slug: string) => {
  // Reuse the existing removal path: stop containers → git worktree remove → drop state.
  const branch = stateService.getBranch(slug);
  if (!branch) return;
  for (const svc of Object.values(branch.services)) {
    try { await containerService.stop(svc.containerName); } catch { /* best effort */ }
  }
  try { await worktreeService.remove(branch.worktreePath); } catch { /* best effort */ }
  stateService.removeBranch(slug);
  stateService.save();
});

// The BranchDispatcher (Phase 3) is instantiated later, inside the scheduler-mode
// block where ExecutorRegistry becomes available. See the `if (mode === 'scheduler')`
// branch near the bottom of this file.

// ── Discover and reconcile infrastructure containers ──
(async () => {
  try {
    const discovered = await containerService.discoverInfraContainers();
    const stateServices = stateService.getInfraServices();

    for (const svc of stateServices) {
      const found = discovered.get(svc.id);
      if (found) {
        // Container exists in Docker — sync status
        svc.status = found.running ? 'running' : 'stopped';
        discovered.delete(svc.id);
      } else if (svc.status === 'running') {
        // State says running but container is gone — try to recreate
        console.log(`  [infra] Recreating missing container for ${svc.id}...`);
        try {
          await containerService.startInfraService(svc);
          svc.status = 'running';
          console.log(`  [infra] ${svc.id} recreated successfully`);
        } catch (err) {
          svc.status = 'error';
          svc.errorMessage = (err as Error).message;
          console.error(`  [infra] Failed to recreate ${svc.id}:`, (err as Error).message);
        }
      }
    }

    // Log orphan containers (in Docker but not in state)
    for (const [id, info] of discovered) {
      console.warn(`  [infra] Orphan container detected: ${info.containerName} (service.id=${id}). Not managed by current state.`);
    }

    stateService.save();
    if (stateServices.length > 0) {
      const running = stateServices.filter(s => s.status === 'running').length;
      console.log(`  [infra] ${stateServices.length} service(s) configured, ${running} running`);
    }

    // ── Discover and reconcile app containers ──
    const appContainers = await containerService.discoverAppContainers();
    const branches = stateService.getAllBranches();
    let appReconciled = 0;

    for (const branch of branches) {
      for (const [profileId, svc] of Object.entries(branch.services)) {
        const key = `${branch.id}/${profileId}`;
        const found = appContainers.get(key);
        if (found) {
          // Container exists in Docker — sync status
          const wasStatus = svc.status;
          svc.status = found.running ? 'running' : 'error';
          if (wasStatus !== svc.status) appReconciled++;
          appContainers.delete(key);
        } else if (svc.status === 'running') {
          // State says running but container is gone
          svc.status = 'error';
          svc.errorMessage = '容器已丢失，需重新部署';
          appReconciled++;
        }
      }
    }

    // Log orphan app containers
    for (const [key, info] of appContainers) {
      console.warn(`  [app] Orphan container detected: ${info.containerName} (${key}). Not managed by current state.`);
    }

    if (appReconciled > 0) {
      console.log(`  [app] Reconciled ${appReconciled} app container(s)`);
      stateService.save();
    }
  } catch (err) {
    console.error('  [infra] Discovery failed:', (err as Error).message);
  }

  // Start warm-pool scheduler after reconciliation so initial heat states
  // reflect real container state. No-op when scheduler is disabled.
  // On startup, branches with status='running' and no heatState get marked hot.
  if (schedulerService.isEnabled()) {
    for (const b of stateService.getAllBranches()) {
      if (b.heatState === undefined && b.status === 'running') {
        b.heatState = 'hot';
      }
    }
    stateService.save();
    schedulerService.start();
  }

  // Start janitor (Phase 2) — safe to call even when disabled (internal no-op).
  janitorService.start();
})();

// Shut the scheduler/janitor down cleanly on process exit so background timers
// don't keep running orphaned.
process.on('SIGTERM', () => { schedulerService.stop(); janitorService.stop(); });
process.on('SIGINT', () => { schedulerService.stop(); janitorService.stop(); });

// Configure proxy: resolve branch slug → upstream URL
proxyService.setResolveUpstream((branchId, profileId) => {
  const branch = stateService.getBranch(branchId);
  if (!branch) return null;

  if (profileId && branch.services[profileId]) {
    const svc = branch.services[profileId];
    if (svc.status === 'running') return `http://127.0.0.1:${svc.hostPort}`;
  }

  // Fallback: find first running service
  for (const svc of Object.values(branch.services)) {
    if (svc.status === 'running') return `http://127.0.0.1:${svc.hostPort}`;
  }
  return null;
});

// ── Web access tracking (throttled: max 1 event per branch per 2s) ──
const webAccessThrottle = new Map<string, number>();
proxyService.setOnAccess((branchId, method, reqPath, status, duration, profileId) => {
  const now = Date.now();
  const lastSent = webAccessThrottle.get(branchId) || 0;
  if (now - lastSent < 2000) return; // throttle: 1 event per 2 seconds per branch
  webAccessThrottle.set(branchId, now);

  const branchTags = stateService.getBranch(branchId)?.tags ?? [];
  const event: ActivityEvent = {
    id: nextActivitySeq(),
    ts: new Date().toISOString(),
    method,
    path: reqPath,
    status,
    duration,
    type: 'web',
    source: 'user',
    branchId,
    branchTags: branchTags.length ? branchTags : undefined,
    profileId,
  };
  broadcastActivity(event);
});

// ── Build lock for race conditions ──
// Concurrent requests for the same branch wait for the first build to finish.
const buildLocks = new Map<string, { promise: Promise<void>; listeners: http.ServerResponse[] }>();

// ── Auto-build transit page HTML ──
function buildTransitPageHtml(branchName: string): string {
  return `<!DOCTYPE html>
<html lang="zh"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>正在构建 — ${branchName}</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#0d1117;color:#c9d1d9;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:20px}
.card{max-width:560px;width:100%;padding:32px;background:#161b22;border:1px solid #30363d;border-radius:12px}
.header{display:flex;align-items:center;gap:12px;margin-bottom:24px}
.spinner{width:20px;height:20px;border:2px solid #30363d;border-top-color:#58a6ff;border-radius:50%;animation:spin .8s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
.done-icon{width:20px;height:20px;display:none;color:#3fb950}
.error-icon{width:20px;height:20px;display:none;color:#f85149}
h2{font-size:16px;font-weight:600;color:#f0f6fc}
.branch{font-family:ui-monospace,SFMono-Regular,monospace;font-size:13px;color:#58a6ff;background:#21262d;padding:4px 8px;border-radius:4px;margin-bottom:20px;word-break:break-all}
.steps{display:flex;flex-direction:column;gap:8px;margin-bottom:16px}
.step{display:flex;align-items:center;gap:8px;padding:8px 12px;background:#0d1117;border:1px solid #21262d;border-radius:6px;font-size:13px;transition:border-color .2s}
.step.running{border-color:#58a6ff}
.step.done{border-color:#3fb950}
.step.error{border-color:#f85149}
.step-icon{width:14px;height:14px;flex-shrink:0}
.step.running .step-icon{border:2px solid #30363d;border-top-color:#58a6ff;border-radius:50%;animation:spin .8s linear infinite}
.step.done .step-icon{color:#3fb950}
.step.done .step-icon::after{content:"✓"}
.step.error .step-icon{color:#f85149}
.step.error .step-icon::after{content:"✗"}
.log-box{max-height:200px;overflow-y:auto;background:#010409;border:1px solid #21262d;border-radius:6px;padding:8px 12px;font-family:ui-monospace,monospace;font-size:11px;line-height:1.5;color:#8b949e;white-space:pre-wrap;word-break:break-all;display:none}
.log-box::-webkit-scrollbar{width:4px}
.log-box::-webkit-scrollbar-thumb{background:#30363d;border-radius:2px}
.status-msg{text-align:center;font-size:13px;color:#8b949e;margin-top:16px}
.status-msg.success{color:#3fb950}
.status-msg.error{color:#f85149}
.countdown{font-size:12px;color:#8b949e;text-align:center;margin-top:8px;display:none}
</style>
</head><body>
<div class="card">
  <div class="header">
    <div class="spinner" id="hdrSpinner"></div>
    <svg class="done-icon" id="hdrDone" viewBox="0 0 16 16" fill="currentColor"><path d="M8 0a8 8 0 110 16A8 8 0 018 0zm3.78 4.97a.75.75 0 00-1.06 0L7 8.69 5.28 6.97a.75.75 0 00-1.06 1.06l2.25 2.25a.75.75 0 001.06 0l4.25-4.25a.75.75 0 000-1.06z"/></svg>
    <svg class="error-icon" id="hdrErr" viewBox="0 0 16 16" fill="currentColor"><path d="M2.343 13.657A8 8 0 1113.657 2.343 8 8 0 012.343 13.657zM6.03 4.97a.75.75 0 00-1.06 1.06L6.94 8 4.97 9.97a.75.75 0 101.06 1.06L8 9.06l1.97 1.97a.75.75 0 101.06-1.06L9.06 8l1.97-1.97a.75.75 0 10-1.06-1.06L8 6.94 6.03 4.97z"/></svg>
    <h2 id="hdrTitle">正在构建分支...</h2>
  </div>
  <div class="branch">${branchName}</div>
  <div class="steps" id="steps"></div>
  <div class="log-box" id="logBox"></div>
  <div class="status-msg" id="statusMsg"></div>
  <div class="countdown" id="countdown"></div>
</div>
<script>
(function(){
  var steps=document.getElementById('steps');
  var logBox=document.getElementById('logBox');
  var statusMsg=document.getElementById('statusMsg');
  var countdown=document.getElementById('countdown');
  var hdrSpinner=document.getElementById('hdrSpinner');
  var hdrDone=document.getElementById('hdrDone');
  var hdrErr=document.getElementById('hdrErr');
  var hdrTitle=document.getElementById('hdrTitle');
  var stepMap={};

  function addOrUpdateStep(id,status,title){
    var el=stepMap[id];
    if(!el){
      el=document.createElement('div');
      el.className='step '+status;
      el.innerHTML='<div class="step-icon"></div><span></span>';
      steps.appendChild(el);
      stepMap[id]=el;
    }
    el.className='step '+status;
    el.querySelector('span').textContent=title;
  }

  function appendLog(text){
    logBox.style.display='block';
    logBox.textContent+=text;
    logBox.scrollTop=logBox.scrollHeight;
  }

  function finish(ok,msg){
    hdrSpinner.style.display='none';
    if(ok){
      hdrDone.style.display='block';
      hdrTitle.textContent='构建完成';
      statusMsg.className='status-msg success';
      statusMsg.textContent=msg||'分支已就绪，即将跳转...';
      countdown.style.display='block';
      var sec=3;
      countdown.textContent=sec+'秒后自动刷新...';
      var t=setInterval(function(){
        sec--;
        if(sec<=0){clearInterval(t);location.reload();}
        else countdown.textContent=sec+'秒后自动刷新...';
      },1000);
    }else{
      hdrErr.style.display='block';
      hdrTitle.textContent='构建失败';
      statusMsg.className='status-msg error';
      statusMsg.textContent=msg||'构建过程中发生错误';
    }
  }

  var url=location.href+(location.href.indexOf('?')>=0?'&':'?')+'sse=1';
  var es=new EventSource(url);
  es.addEventListener('step',function(e){
    var d=JSON.parse(e.data);
    addOrUpdateStep(d.step,d.status,d.title);
  });
  es.addEventListener('log',function(e){
    var d=JSON.parse(e.data);
    appendLog(d.chunk);
  });
  es.addEventListener('complete',function(e){
    es.close();
    var d=JSON.parse(e.data);
    finish(true,d.message);
  });
  es.addEventListener('error',function(e){
    if(e.data){
      try{var d=JSON.parse(e.data);finish(false,d.message);}catch(ex){finish(false,'连接中断');}
    }else{
      finish(false,'连接中断，请刷新重试');
    }
    es.close();
  });
})();
</script>
</body></html>`;
}

// Auto-build: when a request hits an unbuilt branch
proxyService.setOnAutoBuild(async (branchSlug, _req, res) => {
  const url = new URL(_req.url || '/', `http://${_req.headers.host || 'localhost'}`);
  const isSSE = url.searchParams.get('sse') === '1';

  // Browser request (no ?sse=1): serve the transit HTML page
  if (!isSSE) {
    const displayName = branchSlug;
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
    res.end(buildTransitPageHtml(displayName));
    return;
  }

  // ── SSE mode: stream build events ──
  const branch = stateService.getBranch(branchSlug);

  // Race condition: if a build is already in progress for this slug,
  // add this response as a listener and wait for the first build to finish
  const existingLock = buildLocks.get(branchSlug);
  if (existingLock || branch?.status === 'building') {
    if (existingLock) {
      // Subscribe this response to receive SSE events from the ongoing build
      existingLock.listeners.push(res);
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      try { res.write(`event: step\ndata: ${JSON.stringify({ step: 'wait', status: 'running', title: `分支 "${branchSlug}" 正在构建中，等待完成...` })}\n\n`); } catch { /* */ }
      // The build promise will resolve/reject and the finally block will end this response
      existingLock.promise.then(() => {
        try {
          res.write(`event: complete\ndata: ${JSON.stringify({ message: `分支 "${branchSlug}" 已就绪` })}\n\n`);
        } catch { /* */ }
        res.end();
      }).catch((err) => {
        try {
          res.write(`event: error\ndata: ${JSON.stringify({ message: (err as Error).message })}\n\n`);
        } catch { /* */ }
        res.end();
      });
      return;
    }

    // Building but no lock (stale state) — send SSE error so transit page shows status
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(`event: step\ndata: ${JSON.stringify({ step: 'wait', status: 'running', title: `分支 "${branchSlug}" 正在构建中...` })}\n\n`);
    // Poll until building finishes
    const poll = setInterval(() => {
      const b = stateService.getBranch(branchSlug);
      if (!b || b.status !== 'building') {
        clearInterval(poll);
        if (b?.status === 'running') {
          try { res.write(`event: complete\ndata: ${JSON.stringify({ message: `分支 "${branchSlug}" 已就绪` })}\n\n`); } catch { /* */ }
        } else {
          try { res.write(`event: error\ndata: ${JSON.stringify({ message: b?.errorMessage || '构建状态异常' })}\n\n`); } catch { /* */ }
        }
        res.end();
      }
    }, 2000);
    return;
  }

  // Check if remote branch exists
  const exists = await worktreeService.branchExists(branchSlug);
  // Also try suffix matching and common patterns
  const candidates = [branchSlug, `feature/${branchSlug}`, `fix/${branchSlug}`];
  let resolvedBranch: string | null = null;

  if (exists) {
    resolvedBranch = branchSlug;
  } else {
    for (const candidate of candidates) {
      if (await worktreeService.branchExists(candidate)) {
        resolvedBranch = candidate;
        break;
      }
    }
  }

  // If still not found, try suffix matching against all remote branches
  if (!resolvedBranch) {
    resolvedBranch = await worktreeService.findBranchBySuffix(branchSlug);
  }

  // If still not found, try slug matching (e.g. slug "claude-fix-xxx" → branch "claude/fix-xxx")
  if (!resolvedBranch) {
    resolvedBranch = await worktreeService.findBranchBySlug(branchSlug);
  }

  if (!resolvedBranch) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(`event: error\ndata: ${JSON.stringify({ message: `远程仓库中未找到分支 "${branchSlug}"` })}\n\n`);
    res.end();
    return;
  }

  // Recompute slug from the actual resolved branch name
  const finalSlug = StateService.slugify(resolvedBranch);

  // SSE: stream build progress
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  const listeners: http.ServerResponse[] = [];

  const sendEvent = (event: string, data: unknown) => {
    const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    try { res.write(msg); } catch { /* */ }
    // Also broadcast to waiting listeners
    for (const listener of listeners) {
      try { listener.write(msg); } catch { /* */ }
    }
  };

  // Register build lock
  let resolveLock: () => void;
  let rejectLock: (err: Error) => void;
  const lockPromise = new Promise<void>((resolve, reject) => {
    resolveLock = resolve;
    rejectLock = reject;
  });
  buildLocks.set(finalSlug, { promise: lockPromise, listeners });
  // Also register under the original slug if different
  if (finalSlug !== branchSlug) {
    buildLocks.set(branchSlug, { promise: lockPromise, listeners });
  }

  try {
    // Create worktree if branch doesn't exist locally
    let entry = stateService.getBranch(finalSlug);
    if (!entry) {
      sendEvent('step', { step: 'worktree', status: 'running', title: `正在为 ${resolvedBranch} 创建工作树...` });
      await shell.exec(`mkdir -p "${config.worktreeBase}"`);
      const worktreePath = `${config.worktreeBase}/${finalSlug}`;
      await worktreeService.create(resolvedBranch, worktreePath);

      entry = {
        id: finalSlug,
        branch: resolvedBranch,
        worktreePath,
        services: {},
        status: 'building',
        createdAt: new Date().toISOString(),
      };
      stateService.addBranch(entry);
      stateService.save();
      sendEvent('step', { step: 'worktree', status: 'done', title: '工作树已创建' });
    }

    entry.status = 'building';
    stateService.save();

    // Build all profiles
    const profiles = stateService.getBuildProfiles();
    for (const profile of profiles) {
      sendEvent('step', { step: `build-${profile.id}`, status: 'running', title: `正在构建 ${profile.name}...` });

      if (!entry.services[profile.id]) {
        const hostPort = stateService.allocatePort(config.portStart);
        entry.services[profile.id] = {
          profileId: profile.id,
          containerName: `cds-${finalSlug}-${profile.id}`,
          hostPort,
          status: 'building',
        };
        stateService.save();
      }

      const svc = entry.services[profile.id];
      svc.status = 'building';

      // Merge CDS_* auto-generated vars (CDS_HOST, CDS_*_PORT) with user custom env
      const cdsEnv = stateService.getCdsEnvVars();
      const customEnv = stateService.getCustomEnv();
      const mergedEnv = { ...cdsEnv, ...customEnv };
      await containerService.runService(entry, profile, svc, (chunk) => {
        sendEvent('log', { profileId: profile.id, chunk });
      }, mergedEnv);

      svc.status = 'running';
      sendEvent('step', { step: `build-${profile.id}`, status: 'done', title: `${profile.name} 就绪 :${svc.hostPort}` });
    }

    entry.status = 'running';
    entry.lastAccessedAt = new Date().toISOString();
    stateService.save();

    sendEvent('complete', {
      message: `分支 "${finalSlug}" 已就绪`,
      hint: '即将自动刷新...',
    });
    resolveLock!();
  } catch (err) {
    const entry = stateService.getBranch(finalSlug);
    if (entry) {
      entry.status = 'error';
      entry.errorMessage = (err as Error).message;
      stateService.save();
    }
    sendEvent('error', { message: (err as Error).message });
    rejectLock!(err as Error);
  } finally {
    buildLocks.delete(finalSlug);
    if (finalSlug !== branchSlug) buildLocks.delete(branchSlug);
    res.end();
  }
});

// ── Master server (dashboard + API on masterPort) ──
const app = createServer({
  stateService,
  worktreeService,
  containerService,
  proxyService,
  bridgeService,
  shell,
  config,
  schedulerService,
});

// ── Helper: kill process on port so CDS can bind ──
// force=true → kill any process (used for masterPort which belongs exclusively to CDS)
// force=false → kill only CDS node processes (safe default)
function tryKillOnPort(port: number, force: boolean): boolean {
  try {
    const pids = execSync(`lsof -ti :${port} 2>/dev/null || true`, { encoding: 'utf-8' }).trim();
    if (!pids) return false;
    let killed = false;
    for (const pid of pids.split('\n').filter(Boolean)) {
      const cmd = execSync(`ps -p ${pid} -o comm= 2>/dev/null || true`, { encoding: 'utf-8' }).trim();
      if (force || ['node', 'tsx', 'ts-node', 'npx'].includes(cmd)) {
        console.log(`  Stopping process on port ${port} (PID: ${pid}, cmd: ${cmd})`);
        // Kill the entire process group to prevent tsx watch from respawning
        try {
          const pgid = execSync(`ps -p ${pid} -o pgid= 2>/dev/null || true`, { encoding: 'utf-8' }).trim();
          if (pgid && pgid !== String(process.pid)) {
            execSync(`kill -9 -- -${pgid} 2>/dev/null || true`);
          } else {
            execSync(`kill -9 ${pid} 2>/dev/null || true`);
          }
        } catch {
          execSync(`kill -9 ${pid} 2>/dev/null || true`);
        }
        killed = true;
      } else {
        console.log(`  [WARN] Port ${port} held by non-CDS process (PID: ${pid}, cmd: ${cmd}) — not killing`);
      }
    }
    if (killed) {
      // Wait briefly for kernel to release the socket
      execSync('sleep 0.5');
    }
    return killed;
  } catch {
    return false;
  }
}

// force: force-kill any process on the port (for masterPort)
// optional: if true, port conflict is non-fatal (for workerPort shared with other services)
function listenWithRetry(
  server: http.Server | ReturnType<typeof createServer>,
  port: number,
  label: string,
  onSuccess: () => void,
  opts: { force?: boolean; optional?: boolean } = {},
) {
  const MAX_ATTEMPTS = 5;
  const doListen = (attempt: number) => {
    const s = server.listen(port, onSuccess);
    s.on('error', (err: Error & { code?: string }) => {
      if (err.code === 'EADDRINUSE' && attempt < MAX_ATTEMPTS) {
        console.log(`  [WARN] Port ${port} in use, attempting to reclaim (${label}, attempt ${attempt + 1}/${MAX_ATTEMPTS})...`);
        const killed = tryKillOnPort(port, !!opts.force);
        if (killed) {
          // Exponential backoff: 1.5s, 2s, 3s, 4s, 5s
          const delay = 1500 + attempt * 500;
          setTimeout(() => doListen(attempt + 1), delay);
        } else if (opts.optional) {
          console.log(`  [INFO] Port ${port} occupied by another service — ${label} skipped (non-essential)`);
        } else {
          console.error(`  [ERROR] Port ${port} is occupied by a non-CDS process. Please free it manually.`);
          process.exit(1);
        }
      } else if (opts.optional) {
        console.log(`  [INFO] ${label} on port ${port} unavailable — skipped`);
      } else {
        console.error(`  [ERROR] Cannot bind ${label} to port ${port}: ${err.message}`);
        process.exit(1);
      }
    });
  };
  doListen(0);
}

// ── Mode-based startup ──
const mode = config.mode;
console.log(`\n  Cloud Development Suite (mode: ${mode})`);
console.log(`  ──────────────────────`);

if (mode === 'executor') {
  // ── Executor mode: only start executor API, no dashboard/proxy ──
  const executorApp = express();
  executorApp.use(express.json());
  executorApp.use('/exec', createExecutorRouter({
    stateService, worktreeService, containerService, shell, config,
  }));

  const agent = new ExecutorAgent(config, stateService);

  listenWithRetry(executorApp, config.executorPort, 'Executor', async () => {
    console.log(`  Executor API:  http://localhost:${config.executorPort}`);
    console.log(`  Scheduler:     ${config.schedulerUrl || '(not set)'}`);
    console.log(`  State file:    ${stateFile}`);
    console.log(`  Repo root:     ${config.repoRoot}`);
    console.log('');

    // Register with scheduler and start heartbeat
    await agent.register();
    agent.startHeartbeat();
  }, { force: true });
} else {
  // ── Standalone or Scheduler mode: start dashboard + proxy ──
  listenWithRetry(app, config.masterPort, 'Dashboard', () => {
    console.log(`  Dashboard:  http://localhost:${config.masterPort}`);
    console.log(`  Worker:     http://localhost:${config.workerPort}`);
    console.log(`  Bridge:     http://localhost:${config.masterPort}/api/bridge/ (HTTP polling)`);
    if (config.rootDomains?.length) console.log(`  Domains:    ${config.rootDomains.join(', ')}`);
    if (config.dashboardDomain) console.log(`  Routing:    exact root domain -> Dashboard (${config.dashboardDomain})`);
    if (config.rootDomains?.length) console.log(`  Preview:    any subdomain under configured root domains`);
    console.log(`  State file: ${stateFile}`);
    console.log(`  Repo root:  ${config.repoRoot}`);
    console.log('');
  }, { force: true });

  // ── Bridge activity tracking ──
  bridgeService.onActivity((branchId, action) => {
    const branchTags = stateService.getBranch(branchId)?.tags ?? [];
    broadcastActivity({
      id: nextActivitySeq(),
      ts: new Date().toISOString(),
      method: 'BRIDGE',
      path: action,
      status: 200,
      duration: 0,
      type: 'cds',
      source: 'ai',
      branchId,
      branchTags: branchTags.length ? branchTags : undefined,
    });
  });

  // ── Worker server (reverse proxy on workerPort) ──
  const workerServer = http.createServer((req, res) => {
    proxyService.handleRequest(req, res);
  });

  workerServer.on('upgrade', (req, socket, head) => {
    proxyService.handleUpgrade(req, socket, head);
  });

  listenWithRetry(workerServer, config.workerPort, 'Worker', () => {
    console.log(`  Worker proxy listening on :${config.workerPort}`);
    console.log(`  Route via X-Branch header or configure routing rules in dashboard.`);
    console.log('');
  }, { optional: true });

  // ── Scheduler mode: also start executor registry + dispatcher ──
  if (mode === 'scheduler') {
    const registry = new ExecutorRegistry(stateService);
    registry.startHealthChecks();

    // Phase 3: BranchDispatcher combines registry with Phase 1 scheduler
    // snapshots for capacity-aware executor selection.
    const dispatcher = new BranchDispatcher(
      registry,
      new HttpSnapshotFetcher(process.env.AI_ACCESS_KEY || undefined),
    );

    // Mount scheduler API routes on the dashboard server
    app.use('/api/executors', createSchedulerRouter({ registry, config, dispatcher }));
    console.log(`  Scheduler: executor management API mounted at /api/executors (dispatcher enabled)`);
  }

  // ── Standalone mode: register a local executor implicitly ──
  if (mode === 'standalone') {
    // No extra setup needed — current behavior is preserved
  }
}
