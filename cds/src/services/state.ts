import fs from 'node:fs';
import path from 'node:path';
import type { CdsState, BranchEntry, BuildProfile, BuildProfileOverride, RoutingRule, OperationLog, InfraService, ExecutorNode, DataMigration, CdsPeer } from '../types.js';

const MAX_LOGS_PER_BRANCH = 10;
/** Max rolling backups of state.json kept on disk. See design.cds-resilience.md §5. */
const MAX_STATE_BACKUPS = 10;

function emptyState(): CdsState {
  return {
    routingRules: [],
    buildProfiles: [],
    branches: {},
    nextPortIndex: 0,
    logs: {},
    defaultBranch: null,
    customEnv: {},
    infraServices: [],
    previewMode: 'multi',
  };
}

export class StateService {
  private state: CdsState = emptyState();
  private readonly filePath: string;
  /** Project slug derived from repoRoot directory name, used for cache isolation */
  readonly projectSlug: string;

  constructor(filePath: string, repoRoot?: string) {
    this.filePath = filePath;
    // Derive project slug from repoRoot (e.g. /root/inernoro/prd_agent → prd-agent)
    const dirName = path.basename(repoRoot || path.dirname(path.dirname(filePath)));
    this.projectSlug = dirName.replace(/[^a-zA-Z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').toLowerCase() || 'default';
  }

  static slugify(branch: string): string {
    return branch
      .replace(/[^a-zA-Z0-9-]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .toLowerCase();
  }

  /**
   * Try to parse a state file. On JSON error, attempt to recover from the most
   * recent .bak.* file. Returns the loaded state, or null if nothing is readable.
   */
  private tryLoadStateFile(): CdsState | null {
    if (fs.existsSync(this.filePath)) {
      try {
        const raw = fs.readFileSync(this.filePath, 'utf-8');
        return JSON.parse(raw) as CdsState;
      } catch (err) {
        console.error(`[state] primary state.json unreadable: ${(err as Error).message}`);
        console.error('[state] attempting to recover from rolling backups...');
      }
    }
    // Fallback: scan .bak.* files, newest first
    const dir = path.dirname(this.filePath);
    const base = path.basename(this.filePath);
    if (!fs.existsSync(dir)) return null;
    const backups = fs.readdirSync(dir)
      .filter(f => f.startsWith(`${base}.bak.`))
      .sort()
      .reverse();
    for (const bak of backups) {
      try {
        const raw = fs.readFileSync(path.join(dir, bak), 'utf-8');
        const parsed = JSON.parse(raw) as CdsState;
        console.warn(`[state] RECOVERED state from backup ${bak}`);
        return parsed;
      } catch {
        // try next backup
      }
    }
    return null;
  }

  load(): void {
    const loaded = this.tryLoadStateFile();
    if (loaded) {
      this.state = loaded;
      // Migrate older state files
      if (!this.state.logs) this.state.logs = {};
      if (!this.state.routingRules) this.state.routingRules = [];
      if (!this.state.buildProfiles) this.state.buildProfiles = [];
      if (this.state.defaultBranch === undefined) this.state.defaultBranch = null;
      if (!this.state.customEnv) this.state.customEnv = {};
      if (!this.state.infraServices) this.state.infraServices = [];
      if (this.state.mirrorEnabled === undefined) this.state.mirrorEnabled = false;
      if (this.state.tabTitleEnabled === undefined) this.state.tabTitleEnabled = true;
      if (this.state.previewMode === undefined) this.state.previewMode = 'multi';
      if (!this.state.executors) this.state.executors = {};
      if (!this.state.dataMigrations) this.state.dataMigrations = [];
      if (!this.state.cdsPeers) this.state.cdsPeers = [];
      // Migrate: backfill cacheMounts for existing build profiles
      this.migrateCacheMounts();
      // Migrate: ensure deployModes field exists on profiles (no-op if already present)
      this.migrateDeployModes();
    } else {
      this.state = emptyState();
    }
  }

  /**
   * Backfill cacheMounts for profiles that were created before cache support.
   * Uses dockerImage to detect the correct cache type.
   */
  private migrateCacheMounts(): void {
    const CACHE_BASE = `/data/cds/${this.projectSlug}/cache`;
    const IMAGE_CACHE_MAP: Record<string, Array<{ hostPath: string; containerPath: string }>> = {
      'dotnet': [{ hostPath: `${CACHE_BASE}/nuget`, containerPath: '/root/.nuget/packages' }],
      'node': [{ hostPath: `${CACHE_BASE}/pnpm`, containerPath: '/pnpm/store' }],
    };

    let changed = false;
    for (const profile of this.state.buildProfiles) {
      // Migrate old paths (hostPath slug + containerPath for pnpm)
      if (profile.cacheMounts) {
        for (const cm of profile.cacheMounts) {
          const updated = cm.hostPath.replace(/\/data\/cds\/[^/]+\/cache/, `${CACHE_BASE}`);
          if (updated !== cm.hostPath) {
            cm.hostPath = updated;
            changed = true;
          }
          // Fix pnpm containerPath: CDS injects npm_config_store_dir=/pnpm/store,
          // so the cache must mount there, not /root/.local/share/pnpm/store
          if (cm.containerPath === '/root/.local/share/pnpm/store') {
            cm.containerPath = '/pnpm/store';
            changed = true;
          }
        }
        if (profile.cacheMounts.length > 0) continue;
      }
      const image = profile.dockerImage || '';
      for (const [key, mounts] of Object.entries(IMAGE_CACHE_MAP)) {
        if (image.includes(key)) {
          profile.cacheMounts = mounts;
          changed = true;
          break;
        }
      }
    }
    if (changed) this.save();
  }

  /**
   * Ensure deployModes/activeDeployMode fields exist on profiles loaded from older state files.
   * No data change needed — just ensures the fields are recognized as valid.
   */
  private migrateDeployModes(): void {
    // No-op: TypeScript's optional fields handle missing deployModes gracefully.
    // This method exists as a migration hook in case future versions need to
    // transform deploy mode data (e.g., rename keys, merge formats).
  }

  /** Listeners notified after every save() */
  private onSaveListeners: Array<() => void> = [];

  /** Register a callback that fires after each save() */
  onSave(fn: () => void): void {
    this.onSaveListeners.push(fn);
  }

  /**
   * Atomic state write with rolling backup.
   *
   * Flow (crash-safe):
   *   1. Serialize state to JSON
   *   2. Write to `state.json.tmp`
   *   3. fsync the temp file (persist bytes to disk, not just page cache)
   *   4. Rename tmp → state.json (POSIX atomic)
   *   5. Copy previous state.json → state.json.bak.<timestamp>
   *   6. Prune backups to keep only the most recent MAX_STATE_BACKUPS
   *
   * On failure of step 2/3/4, state.json is untouched. Step 5/6 failures
   * are logged but do not propagate — the main write already succeeded.
   *
   * See doc/design.cds-resilience.md §5.
   */
  save(): void {
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const serialized = JSON.stringify(this.state, null, 2);
    // Unique tmp path per write — two concurrent saves (e.g. `tsx watch`
    // reloading while a heartbeat triggers a background save) must not race
    // on the same tmp file, otherwise one process's rename will fail with
    // ENOENT because the other already renamed it. Seen in production on
    // B's CDS after a hot-reload while executor heartbeats were firing.
    const tmpPath = `${this.filePath}.tmp.${process.pid}.${Date.now()}`;

    // Atomic write: tmp → fsync → rename
    const fd = fs.openSync(tmpPath, 'w');
    try {
      fs.writeSync(fd, serialized);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmpPath, this.filePath);

    // Rolling backup (best-effort; failures don't fail the save)
    try {
      this.rollBackups(serialized);
    } catch (err) {
      console.warn(`[state] backup rotation failed: ${(err as Error).message}`);
    }

    // Notify listeners
    for (const fn of this.onSaveListeners) {
      try { fn(); } catch { /* ignore */ }
    }
  }

  /**
   * Write a .bak.<timestamp> snapshot and prune old backups.
   * We use the already-serialized string to avoid double serialization.
   */
  private rollBackups(serialized: string): void {
    const dir = path.dirname(this.filePath);
    const base = path.basename(this.filePath);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = path.join(dir, `${base}.bak.${stamp}`);
    fs.writeFileSync(backupPath, serialized);

    // Prune: keep MAX_STATE_BACKUPS newest, delete the rest
    const backups = fs.readdirSync(dir)
      .filter(f => f.startsWith(`${base}.bak.`))
      .sort()  // ISO timestamps sort chronologically
      .reverse();
    for (let i = MAX_STATE_BACKUPS; i < backups.length; i++) {
      try {
        fs.unlinkSync(path.join(dir, backups[i]));
      } catch {
        // ignore individual deletion failures
      }
    }
  }

  getState(): Readonly<CdsState> {
    return this.state;
  }

  // ── Branch management ──

  getBranch(id: string): BranchEntry | undefined {
    return this.state.branches[id];
  }

  getAllBranches(): BranchEntry[] {
    return Object.values(this.state.branches);
  }

  addBranch(entry: BranchEntry): void {
    if (this.state.branches[entry.id]) {
      throw new Error(`分支 "${entry.id}" 已存在`);
    }
    this.state.branches[entry.id] = entry;
  }

  updateBranchMeta(id: string, updates: { isFavorite?: boolean; notes?: string; tags?: string[]; isColorMarked?: boolean }): void {
    const branch = this.state.branches[id];
    if (!branch) throw new Error(`分支 "${id}" 不存在`);
    if (updates.isFavorite !== undefined) branch.isFavorite = updates.isFavorite;
    if (updates.notes !== undefined) branch.notes = updates.notes;
    if (updates.tags !== undefined) branch.tags = updates.tags;
    if (updates.isColorMarked !== undefined) branch.isColorMarked = updates.isColorMarked;
  }

  // ── Per-branch BuildProfile overrides ──
  //
  // These let a branch extend (rather than replace) the shared public
  // BuildProfile. Empty override = pure inheritance (legacy behavior).
  // Applied by `resolveEffectiveProfile()` at container start time.

  getBranchProfileOverrides(branchId: string): Record<string, BuildProfileOverride> {
    return this.state.branches[branchId]?.profileOverrides || {};
  }

  getBranchProfileOverride(branchId: string, profileId: string): BuildProfileOverride | undefined {
    return this.state.branches[branchId]?.profileOverrides?.[profileId];
  }

  /**
   * Replace the override for one profile on one branch. Passing an empty
   * object clears all fields but keeps the entry (equivalent to inheriting
   * everything from the baseline). Use `clearBranchProfileOverride` to
   * remove the entry entirely.
   */
  setBranchProfileOverride(branchId: string, profileId: string, override: BuildProfileOverride): void {
    const branch = this.state.branches[branchId];
    if (!branch) throw new Error(`分支 "${branchId}" 不存在`);
    if (!branch.profileOverrides) branch.profileOverrides = {};
    branch.profileOverrides[profileId] = {
      ...override,
      updatedAt: new Date().toISOString(),
    };
  }

  /** Remove the override entry for one profile, restoring full inheritance. */
  clearBranchProfileOverride(branchId: string, profileId: string): void {
    const branch = this.state.branches[branchId];
    if (!branch?.profileOverrides) return;
    delete branch.profileOverrides[profileId];
    if (Object.keys(branch.profileOverrides).length === 0) {
      delete branch.profileOverrides;
    }
  }

  // ── Per-branch subdomain aliases ──
  //
  // Aliases are DNS labels that route to a branch via `<alias>.<rootDomain>`
  // in addition to the default `<slug>.<rootDomain>`. Used by ProxyService's
  // `extractPreviewBranch()` before falling back to the slug lookup.

  getBranchSubdomainAliases(branchId: string): string[] {
    return this.state.branches[branchId]?.subdomainAliases || [];
  }

  /**
   * Replace the alias list for a branch. Validates that the branch exists
   * but does NOT validate DNS format or cross-branch collisions — those
   * checks live in the API layer so the caller can return 400 with a
   * specific reason. Pass an empty array to clear.
   */
  setBranchSubdomainAliases(branchId: string, aliases: string[]): void {
    const branch = this.state.branches[branchId];
    if (!branch) throw new Error(`分支 "${branchId}" 不存在`);
    if (!aliases || aliases.length === 0) {
      delete branch.subdomainAliases;
      return;
    }
    branch.subdomainAliases = [...aliases];
  }

  /**
   * Find which branch owns a given subdomain label. Checks both:
   *   1) any branch.subdomainAliases (exact, case-insensitive match)
   *   2) branch slug itself (fallback — default route)
   *
   * Used by ProxyService to route `<label>.<rootDomain>` traffic.
   * Returns the branch id (slug key) or null.
   */
  findBranchByAlias(label: string): string | null {
    if (!label) return null;
    const normalized = label.toLowerCase();
    for (const branch of Object.values(this.state.branches)) {
      if (branch.subdomainAliases?.some(a => a.toLowerCase() === normalized)) {
        return branch.id;
      }
    }
    return null;
  }

  /**
   * Find alias collisions across branches. Given a candidate list of aliases
   * for `branchId`, return any that are already owned by a different branch
   * (either as that branch's slug or as another branch's alias). Case-insensitive.
   * Used by the PUT handler to return 409 with a clear reason.
   */
  findAliasCollisions(branchId: string, candidateAliases: string[]): Array<{ alias: string; conflictWith: string; reason: 'slug' | 'alias' }> {
    const conflicts: Array<{ alias: string; conflictWith: string; reason: 'slug' | 'alias' }> = [];
    for (const candidate of candidateAliases) {
      const normalized = candidate.toLowerCase();
      for (const other of Object.values(this.state.branches)) {
        if (other.id === branchId) continue;
        // Collision: candidate equals another branch's slug
        if (other.id.toLowerCase() === normalized) {
          conflicts.push({ alias: candidate, conflictWith: other.id, reason: 'slug' });
          continue;
        }
        // Collision: candidate equals another branch's alias
        if (other.subdomainAliases?.some(a => a.toLowerCase() === normalized)) {
          conflicts.push({ alias: candidate, conflictWith: other.id, reason: 'alias' });
        }
      }
    }
    return conflicts;
  }

  removeBranch(id: string): void {
    if (!this.state.branches[id]) {
      throw new Error(`分支 "${id}" 不存在`);
    }
    delete this.state.branches[id];
    if (this.state.defaultBranch === id) {
      this.state.defaultBranch = null;
    }
  }

  setDefaultBranch(id: string | null): void {
    this.state.defaultBranch = id;
  }

  // ── Port allocation ──

  allocatePort(portStart: number): number {
    const usedPorts = new Set<number>();
    for (const b of Object.values(this.state.branches)) {
      for (const svc of Object.values(b.services)) {
        if (svc.hostPort) usedPorts.add(svc.hostPort);
      }
    }
    let port = portStart + this.state.nextPortIndex;
    while (usedPorts.has(port)) port++;
    this.state.nextPortIndex++;
    return port;
  }

  // ── Routing rules ──

  getRoutingRules(): RoutingRule[] {
    return this.state.routingRules;
  }

  addRoutingRule(rule: RoutingRule): void {
    this.state.routingRules.push(rule);
    this.state.routingRules.sort((a, b) => a.priority - b.priority);
  }

  updateRoutingRule(id: string, updates: Partial<RoutingRule>): void {
    const idx = this.state.routingRules.findIndex(r => r.id === id);
    if (idx === -1) throw new Error(`路由规则 "${id}" 不存在`);
    Object.assign(this.state.routingRules[idx], updates);
    this.state.routingRules.sort((a, b) => a.priority - b.priority);
  }

  removeRoutingRule(id: string): void {
    this.state.routingRules = this.state.routingRules.filter(r => r.id !== id);
  }

  // ── Build profiles ──

  getBuildProfiles(): BuildProfile[] {
    return this.state.buildProfiles;
  }

  getBuildProfile(id: string): BuildProfile | undefined {
    return this.state.buildProfiles.find(p => p.id === id);
  }

  addBuildProfile(profile: BuildProfile): void {
    if (this.state.buildProfiles.some(p => p.id === profile.id)) {
      throw new Error(`构建配置 "${profile.id}" 已存在`);
    }
    this.state.buildProfiles.push(profile);
  }

  updateBuildProfile(id: string, updates: Partial<BuildProfile>): void {
    const idx = this.state.buildProfiles.findIndex(p => p.id === id);
    if (idx === -1) throw new Error(`构建配置 "${id}" 不存在`);
    Object.assign(this.state.buildProfiles[idx], updates);
  }

  removeBuildProfile(id: string): void {
    this.state.buildProfiles = this.state.buildProfiles.filter(p => p.id !== id);
  }

  // ── Operation logs ──

  appendLog(branchId: string, log: OperationLog): void {
    if (!this.state.logs[branchId]) {
      this.state.logs[branchId] = [];
    }
    this.state.logs[branchId].push(log);
    if (this.state.logs[branchId].length > MAX_LOGS_PER_BRANCH) {
      this.state.logs[branchId] = this.state.logs[branchId].slice(-MAX_LOGS_PER_BRANCH);
    }
  }

  getLogs(branchId: string): OperationLog[] {
    return this.state.logs[branchId] || [];
  }

  removeLogs(branchId: string): void {
    delete this.state.logs[branchId];
  }

  // ── Scheduler (warm-pool) runtime override ──
  //
  // Mirror of the `schedulerEnabledOverride` field in CdsState. Returns
  // undefined when the user has never toggled the UI switch (the backend
  // then falls back to config.scheduler.enabled from cds.config.json).
  getSchedulerEnabledOverride(): boolean | undefined {
    return this.state.schedulerEnabledOverride;
  }

  setSchedulerEnabledOverride(value: boolean | undefined): void {
    if (value === undefined) {
      delete this.state.schedulerEnabledOverride;
    } else {
      this.state.schedulerEnabledOverride = value;
    }
  }

  // ── Custom environment variables ──

  getCustomEnv(): Record<string, string> {
    return this.state.customEnv;
  }

  setCustomEnv(env: Record<string, string>): void {
    this.state.customEnv = env;
  }

  setCustomEnvVar(key: string, value: string): void {
    this.state.customEnv[key] = value;
  }

  removeCustomEnvVar(key: string): void {
    delete this.state.customEnv[key];
  }

  // ── Infrastructure services ──

  getInfraServices(): InfraService[] {
    return this.state.infraServices;
  }

  getInfraService(id: string): InfraService | undefined {
    return this.state.infraServices.find(s => s.id === id);
  }

  addInfraService(service: InfraService): void {
    if (this.state.infraServices.some(s => s.id === service.id)) {
      throw new Error(`基础设施服务 "${service.id}" 已存在`);
    }
    this.state.infraServices.push(service);
  }

  updateInfraService(id: string, updates: Partial<InfraService>): void {
    const idx = this.state.infraServices.findIndex(s => s.id === id);
    if (idx === -1) throw new Error(`基础设施服务 "${id}" 不存在`);
    Object.assign(this.state.infraServices[idx], updates);
  }

  removeInfraService(id: string): void {
    this.state.infraServices = this.state.infraServices.filter(s => s.id !== id);
  }

  // ── Mirror acceleration ──

  isMirrorEnabled(): boolean {
    return this.state.mirrorEnabled === true;
  }

  setMirrorEnabled(enabled: boolean): void {
    this.state.mirrorEnabled = enabled;
  }

  /**
   * Get mirror env vars to inject into Node.js containers.
   * Accelerates: corepack download, pnpm/npm/yarn install.
   */
  getMirrorEnvVars(): Record<string, string> {
    if (!this.state.mirrorEnabled) return {};
    return {
      // npm/pnpm/yarn registry mirror
      NPM_CONFIG_REGISTRY: 'https://registry.npmmirror.com',
      // Corepack uses this to download package manager tarballs
      COREPACK_NPM_REGISTRY: 'https://registry.npmmirror.com',
      // Yarn specific
      YARN_NPM_REGISTRY_SERVER: 'https://registry.npmmirror.com',
    };
  }

  // ── Tab title override ──

  isTabTitleEnabled(): boolean {
    return this.state.tabTitleEnabled !== false;
  }

  setTabTitleEnabled(enabled: boolean): void {
    this.state.tabTitleEnabled = enabled;
  }

  // ── Preview mode ──

  getPreviewMode(): 'simple' | 'port' | 'multi' {
    return this.state.previewMode || 'multi';
  }

  setPreviewMode(mode: 'simple' | 'port' | 'multi'): void {
    this.state.previewMode = mode;
  }

  // ── Executor management ──

  getExecutors(): Record<string, ExecutorNode> {
    return this.state.executors || {};
  }

  getExecutor(id: string): ExecutorNode | undefined {
    return this.state.executors?.[id];
  }

  setExecutor(node: ExecutorNode): void {
    if (!this.state.executors) this.state.executors = {};
    this.state.executors[node.id] = node;
  }

  removeExecutor(id: string): void {
    if (this.state.executors) {
      delete this.state.executors[id];
    }
  }

  // ── Data migrations ──

  getDataMigrations(): DataMigration[] {
    return this.state.dataMigrations || [];
  }

  getDataMigration(id: string): DataMigration | undefined {
    return (this.state.dataMigrations || []).find(m => m.id === id);
  }

  addDataMigration(migration: DataMigration): void {
    if (!this.state.dataMigrations) this.state.dataMigrations = [];
    this.state.dataMigrations.push(migration);
  }

  updateDataMigration(id: string, updates: Partial<DataMigration>): void {
    const list = this.state.dataMigrations || [];
    const idx = list.findIndex(m => m.id === id);
    if (idx === -1) throw new Error(`迁移任务 "${id}" 不存在`);
    Object.assign(list[idx], updates);
  }

  removeDataMigration(id: string): void {
    this.state.dataMigrations = (this.state.dataMigrations || []).filter(m => m.id !== id);
  }

  // ── CDS peers (remote CDS instances trusted for data migration) ──

  getCdsPeers(): CdsPeer[] {
    return this.state.cdsPeers || [];
  }

  getCdsPeer(id: string): CdsPeer | undefined {
    return (this.state.cdsPeers || []).find(p => p.id === id);
  }

  addCdsPeer(peer: CdsPeer): void {
    if (!this.state.cdsPeers) this.state.cdsPeers = [];
    this.state.cdsPeers.push(peer);
  }

  updateCdsPeer(id: string, updates: Partial<CdsPeer>): void {
    const list = this.state.cdsPeers || [];
    const idx = list.findIndex(p => p.id === id);
    if (idx === -1) throw new Error(`CDS 密钥 "${id}" 不存在`);
    Object.assign(list[idx], updates);
  }

  removeCdsPeer(id: string): void {
    this.state.cdsPeers = (this.state.cdsPeers || []).filter(p => p.id !== id);
  }

  /**
   * Resolve the Docker host IP for infra services.
   * Priority: customEnv.CDS_DOCKER_HOST > process.env.CDS_DOCKER_HOST > default 172.17.0.1
   */
  private resolveDockerHost(): string {
    return this.state.customEnv['CDS_DOCKER_HOST']
      || process.env.CDS_DOCKER_HOST
      || '172.17.0.1';
  }

  /**
   * Build CDS_* env vars from all running infra services.
   * Auto-generates predictable env var names based on service ID:
   *   CDS_HOST               — Docker host IP
   *   CDS_<SERVICE>_PORT     — Allocated host port (e.g., CDS_MONGODB_PORT=37821)
   *   CDS_<SERVICE>_HOST     — Per-service host (currently same as CDS_HOST)
   *
   * These can be referenced in app service environments as ${CDS_MONGODB_PORT} etc.
   */
  getCdsEnvVars(): Record<string, string> {
    const dockerHost = this.resolveDockerHost();
    const result: Record<string, string> = {
      CDS_HOST: dockerHost,
    };
    for (const svc of this.state.infraServices) {
      if (svc.status !== 'running') continue;
      const envKey = `CDS_${svc.id.toUpperCase().replace(/-/g, '_')}_PORT`;
      result[envKey] = String(svc.hostPort);
      // Per-service host (allows future per-service host override)
      const hostKey = `CDS_${svc.id.toUpperCase().replace(/-/g, '_')}_HOST`;
      result[hostKey] = dockerHost;
    }
    return result;
  }
}
